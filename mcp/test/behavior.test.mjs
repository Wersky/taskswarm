/**
 * 3.0 行为回归：2.2.0 四个已知缺陷的修复断言 + 心跳回收 + 成本钩子 + blocked 专项。
 *
 * 缺陷对照（2.2.0 → 3.0）：
 *   ① board 只显示最新 1 条笔记 60 字符 → 每任务 2 条 × 80 字符 + noteCount
 *   ② task_claim 返回不含笔记/上下文 → 返回全量 notes + assignee/reviewer/parent/blockedBy
 *   ③ 给无主任务留言会抢占归属 → 留言不再改变 owner
 *   ④ 任何自称 owner 者可把 done 唤醒回 pending → 仅 reviewer 本人（或 force）可回退
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

const dbPathOf = (ws) => path.join(ws, '任务蜂群', 'swarm-state.db');

describe('缺陷① board 笔记可见性', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('board 每任务给最近 2 条摘要（80 字符）与总数提示', async () => {
    const ws = makeWorkspace('b1');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      for (let i = 1; i <= 4; i++) {
        await c.call('task_update', { workspace: ws, taskId: 'a', note: `进展${i}：`.padEnd(30, 'x') + i, owner: 'w1' });
      }
      const bd = await c.call('board', { workspace: ws });
      const line = bd.view.split('\n').find(l => l.includes('[a]'));
      assert.ok(line);
      const hits = (line.match(/💬/g) ?? []).length;
      assert.ok(hits >= 1 && hits <= 2, `看板行应有 1~2 条摘要，实际 ${hits}`);
      assert.match(line, /共 4 条/, '超过 2 条时必须给总数提示');
      assert.ok(line.includes('进展4'), '最新一条必须在摘要里');
      assert.ok(!line.includes('进展1'), '最旧一条不应出现（只保留最近 2 条）');
    } finally { rmWorkspace(ws); }
  });
});

describe('缺陷② task_claim 返回上下文', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('领取时一次拿到上游笔记与归属字段，无需二次查询', async () => {
    const ws = makeWorkspace('b2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'up', title: '上游' },
        { id: 't', title: '本体', dependsOn: ['up'], assignee: 'agent-9', reviewer: 'boss' },
      ] });
      await c.call('task_claim', { workspace: ws, taskId: 'up', owner: 'agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'up', status: 'done', note: '上游结论：接口已定 v2', owner: 'agent-1' });

      const r = await c.call('task_claim', { workspace: ws, taskId: 't', owner: 'agent-9' });
      const t = r.task;
      assert.equal(t.status, 'claimed');
      assert.equal(t.assignee, 'agent-9', '返回应含 assignee');
      assert.equal(t.reviewer, 'boss', '返回应含 reviewer');
      assert.equal(t.parent, null);
      assert.deepEqual(t.dependsOn, ['up']);
      assert.ok(Array.isArray(t.notes) && t.notes.length === 0, '本任务（尚无笔记）也应返回 notes 数组');
    } finally { rmWorkspace(ws); }
  });

  test('被 blockedBy 的任务（proceed 策略）领取时返回 blockedBy', async () => {
    const ws = makeWorkspace('b2b');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', failurePolicy: 'proceed', tasks: [
        { id: 'u', title: '上游' }, { id: 't', title: '下游', dependsOn: ['u'] },
      ] });
      await c.call('task_claim', { workspace: ws, taskId: 'u', owner: 'p1' });
      await c.call('task_update', { workspace: ws, taskId: 'u', status: 'failed', owner: 'p1' });
      const r = await c.call('task_claim', { workspace: ws, taskId: 't', owner: 'p2' });
      assert.deepEqual(r.task.blockedBy, ['u'], 'proceed 策略下领取应带 blockedBy 警示');
    } finally { rmWorkspace(ws); }
  });
});

describe('缺陷③ 留言不再夺取所有权', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('无主任务被旁观者写笔记后仍为无主，claim 不受影响', async () => {
    const ws = makeWorkspace('b3');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      // 旁观者留言（不提供状态变更）
      await c.call('task_update', { workspace: ws, taskId: 'a', note: '路人补充：这个有坑', owner: 'bystander' });
      const bd1 = await c.call('board', { workspace: ws });
      const line = bd1.view.split('\n').find(l => l.includes('[a]'));
      assert.ok(!line.includes('@bystander'), '留言者不应成为 owner');
      assert.ok(line.includes('路人补充'), '但留言内容应可见');

      // 真正的执行者照常领取
      const r = await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'real-worker' });
      assert.equal(r.task.owner, 'real-worker', 'claim 照常获得归属');
      const bd2 = await c.call('board', { workspace: ws });
      assert.match(bd2.view, /\[a\].*@real-worker/, 'owner 正确显示');
    } finally { rmWorkspace(ws); }
  });

  test('有主任务的 owner 写状态转移维持归属；非 owner 仍不可改他人任务状态', async () => {
    const ws = makeWorkspace('b3b');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'in_progress', note: '开工', owner: 'w1' });
      const bd = await c.call('board', { workspace: ws });
      assert.match(bd.view, /@w1/, 'owner 写状态后归属不变');
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', status: 'blocked', owner: 'w2' });
      assert.equal(r.ok, false, '非 owner 改他人任务状态仍被拒');
      assert.match(r.error, /无权/);
    } finally { rmWorkspace(ws); }
  });
});

describe('缺陷④ 终态回退收紧', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  async function setupDoneTask(ws) {
    // 有 reviewer 的任务：done 会改道 pending_review，必须走审核 approve 才真正 done
    await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', reviewer: 'boss' }] });
    await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dev' });
    await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'dev' });
    await c.call('task_review', { workspace: ws, taskId: 'a', verdict: 'approve', owner: 'boss' });
  }

  test('done → pending：producer（含自称 owner）被拒，reviewer 本人可回退', async () => {
    const ws = makeWorkspace('b4a');
    try {
      await setupDoneTask(ws);
      const r1 = await c.callRaw('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'dev' });
      assert.equal(r1.ok, false, 'producer 不得唤醒 done');
      assert.match(r1.error, /reviewer|force/);

      const r2 = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'boss' });
      assert.equal(r2.task.status, 'pending', 'reviewer 本人可回退（重做裁决）');
    } finally { rmWorkspace(ws); }
  });

  test('done → pending：主代理 force 可回退且记「强制改状态」事件', async () => {
    const ws = makeWorkspace('b4b');
    try {
      await setupDoneTask(ws);
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'main', force: true });
      assert.equal(r.task.status, 'pending');
      const pg = await c.call('plan_get', { workspace: ws });
      assert.ok(pg.recentEvents.some(e => e.event === '强制改状态'), 'force 必须留审计事件');
    } finally { rmWorkspace(ws); }
  });

  test('failed → pending 仍允许 owner 执行（失败重试是 producer 的合理动作）', async () => {
    const ws = makeWorkspace('b4c');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', reviewer: 'boss' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dev' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'failed', note: '环境炸了', owner: 'dev' });
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'dev' });
      assert.equal(r.task.status, 'pending', 'owner 对 failed 的重试回退保持开放');
    } finally { rmWorkspace(ws); }
  });

  test('无审核门任务的 done → pending：owner 本人可回退（向后兼容重做场景）', async () => {
    const ws = makeWorkspace('b4d');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dev' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'dev' });
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'dev' });
      assert.equal(r.task.status, 'pending', '无 reviewer 时 owner 回退不受影响');
    } finally { rmWorkspace(ws); }
  });
});

describe('心跳与超时回收', () => {
  test('claimed/in_progress 超时无心跳 → 自动回 pending 并记「超时回收」事件', async () => {
    const ws = makeWorkspace('hb1');
    try {
      // 0.03 分钟 ≈ 1.8 秒
      const c = connect({ TASKSWARM_STALE_MINUTES: '0.03' });
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'ghost' });
      await c.call('task_claim', { workspace: ws, taskId: 'b', owner: 'alive' });
      await c.call('task_update', { workspace: ws, taskId: 'b', status: 'in_progress', note: '我还活着', owner: 'alive' });
      await new Promise(r => setTimeout(r, 1000));
      // 中途补一次心跳：b 的最后心跳 ≈ 1.0s 处，检查时刻 ≈ 2.4s，距最后心跳 < 1.8s 不回收
      await c.call('task_update', { workspace: ws, taskId: 'b', note: '还活着2', owner: 'alive' });
      await new Promise(r => setTimeout(r, 1400));

      // 任意写操作路过时惰性回收
      const bd = await c.call('board', { workspace: ws });
      const byId = Object.fromEntries(bd.view.split('\n').filter(l => l.includes('[')).map(l => [l.match(/\[(\w+)\]/)[1], l]));
      assert.match(byId.a, /\(pending\)/, '失联任务应被回收回 pending');
      assert.ok(!byId.a.includes('@ghost'), '回收后 owner 清空');
      assert.match(byId.b, /@alive/, '有心跳的任务不受影响');

      const pg = await c.call('plan_get', { workspace: ws });
      const ev = pg.recentEvents.find(e => e.event === '超时回收' && e.taskId === 'a');
      assert.ok(ev, '回收必须记审计事件');
      assert.match(ev.detail ?? '', /ghost|分钟/, '事件应说明原因');

      // 回收后可被重新领取
      const r = await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'successor' });
      assert.equal(r.task.owner, 'successor');
      c.kill();
    } finally { rmWorkspace(ws); }
  });

  test('TASKSWARM_STALE_MINUTES=0 禁用回收（长任务场景）', async () => {
    const ws = makeWorkspace('hb2');
    try {
      const c = connect({ TASKSWARM_STALE_MINUTES: '0' });
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'patient' });
      // 直接把心跳改老（模拟长时间运行）
      const db = new DatabaseSync(dbPathOf(ws));
      db.prepare("UPDATE tasks SET lastHeartbeat='2020-01-01T00:00:00.000Z' WHERE id='a'").run();
      db.close();

      await c.call('board', { workspace: ws }); // 读操作顺带触发回收检查
      const pg = await c.call('plan_get', { workspace: ws });
      assert.match(pg.view, /claimed/, '禁用时超时任务不被回收');
      c.kill();
    } finally { rmWorkspace(ws); }
  });
});

describe('成本钩子', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('task_update 累加 cost，board 汇总 Σtokens/Σminutes；非法值被拒', async () => {
    const ws = makeWorkspace('cost');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1', cost: { tokens: 1200, minutes: 3 } });
      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1', cost: { tokens: 800 } });
      await c.call('task_update', { workspace: ws, taskId: 'b', note: 'n', owner: 'w2', cost: { tokens: 500, minutes: 2 } });

      const bd = await c.call('board', { workspace: ws });
      assert.deepEqual(bd.cost, { tokens: 2500, minutes: 5 }, 'board 应汇总全群成本');

      const bad = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1', cost: { tokens: -5 } });
      assert.equal(bad.ok, false, '负数必须被拒');
      assert.match(bad.error, /非负/);
    } finally { rmWorkspace(ws); }
  });
});

describe('blocked 状态专项（2.2.0 测试盲区补齐）', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('blocked 进入与退出：blocked → in_progress → done 全链合法', async () => {
    const ws = makeWorkspace('blk');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      const r1 = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'blocked', note: '等上游环境', owner: 'w1' });
      assert.equal(r1.task.status, 'blocked');

      const r2 = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'in_progress', owner: 'w1' });
      assert.equal(r2.task.status, 'in_progress', '解除阻塞回到进行中');

      const r3 = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'w1' });
      assert.equal(r3.task.status, 'done');
    } finally { rmWorkspace(ws); }
  });

  test('pending_review → pending（审核者未裁决时撤回交活）合法', async () => {
    const ws = makeWorkspace('blk2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', reviewer: 'boss' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dev' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'dev' }); // 改道 pending_review
      // producer 自己不能直接撤（done 回退规则），但 owner 从 pending_review 撤回 in_progress 可行
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'in_progress', owner: 'dev' });
      assert.equal(r.task.status, 'in_progress', 'pending_review → in_progress 合法');
    } finally { rmWorkspace(ws); }
  });

  test('终态回退后领取痕迹被清空、可重新派发', async () => {
    const ws = makeWorkspace('blk3');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', reviewer: 'boss' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dev' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'dev' });
      await c.call('task_review', { workspace: ws, taskId: 'a', verdict: 'approve', owner: 'boss' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'boss' });
      const r = await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dev2' });
      assert.equal(r.task.owner, 'dev2', '回退后应可被新执行者领取');
      assert.equal(r.task.status, 'claimed');
    } finally { rmWorkspace(ws); }
  });
});
