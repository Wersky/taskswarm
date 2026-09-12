/**
 * 状态机、失败语义、笔记治理测试。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

describe('状态机与归属守卫', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('正常流转 pending → claimed → in_progress → done', async () => {
    const ws = makeWorkspace('sm');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      assert.equal((await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' })).task.id, 'a');
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'in_progress', owner: 'w1' });
      const done = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'w1' });
      assert.equal(done.task.status, 'done');
    } finally { rmWorkspace(ws); }
  });

  test('并发抢占：同一任务不能被两个 owner 领取', async () => {
    const ws = makeWorkspace('sm2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      const r = await c.callRaw('task_claim', { workspace: ws, taskId: 'a', owner: 'w2' });
      assert.equal(r.ok, false);
      assert.match(r.error, /w1/, '错误应点名当前 owner，方便排查');
    } finally { rmWorkspace(ws); }
  });

  test('done 任务不能被重新领取', async () => {
    const ws = makeWorkspace('sm3');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'w1' });
      const r = await c.callRaw('task_claim', { workspace: ws, taskId: 'a', owner: 'w2' });
      assert.equal(r.ok, false);
      assert.match(r.error, /done|pending/);
    } finally { rmWorkspace(ws); }
  });

  test('非 owner 不能改状态，错误点名当前 owner', async () => {
    const ws = makeWorkspace('sm4');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'owner-A' });
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'owner-B' });
      assert.equal(r.ok, false);
      assert.match(r.error, /owner-A/);
    } finally { rmWorkspace(ws); }
  });

  test('省略 owner 不能绕过守卫（旧缺陷：任何人都能改）', async () => {
    const ws = makeWorkspace('sm5');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'owner-A' });
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', status: 'done' });
      assert.equal(r.ok, false, '不传 owner 不应被当作可以随意改');
    } finally { rmWorkspace(ws); }
  });

  test('owner 本人可把终态回退（重做场景）', async () => {
    const ws = makeWorkspace('sm6');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'w1' });
      const back = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'w1' });
      assert.equal(back.task.status, 'pending');
    } finally { rmWorkspace(ws); }
  });

  test('非法状态值被拒绝', async () => {
    const ws = makeWorkspace('sm7');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', status: '乱七八糟', owner: 'w1' });
      assert.equal(r.ok, false);
      assert.match(r.error, /pending|状态/);
    } finally { rmWorkspace(ws); }
  });

  test('force 逃生通道：主代理可恢复失联子代理的任务，并留下审计事件', async () => {
    const ws = makeWorkspace('sm8');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'dead-agent' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'in_progress', owner: 'dead-agent' });

      // force 必须显式给 owner（不能空手调用），否则无法追溯是谁强制的
      const noOwner = await c.callRaw('task_update', { workspace: ws, taskId: 'a', status: 'pending', force: true });
      assert.equal(noOwner.ok, false, 'force 必须同时提供 owner，否则审计日志无法追溯操作者');
      assert.match(noOwner.error, /owner|主代理/, '错误应说明 force 的用法');

      const ok = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'dead-agent', force: true });
      assert.equal(ok.task.status, 'pending');

      const board = await c.call('board', { workspace: ws });
      assert.ok((board.recentEvents ?? []).some(e => String(e.event).includes('强制')),
        'force 必须留下「强制改状态」审计事件');

      // 审计事件要能还原：原 owner 是谁、从什么状态到什么状态
      const evt = (board.recentEvents ?? []).find(e => String(e.event).includes('强制'));
      assert.match(String(evt.detail ?? ''), /dead-agent/, '审计事件应记录原 owner');

      // 恢复后新子代理可重新领取（owner 已清空）
      const reclaimed = await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'fresh-agent' });
      assert.equal(reclaimed.task.id, 'a');
    } finally { rmWorkspace(ws); }
  });

  test('force 的边界：它是审计机制而非权限机制（协议层无法识别主代理身份）', async () => {
    const ws = makeWorkspace('sm9');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'owner-A' });

      // MCP 调用方都可以自称主代理，因此 force 不能提供真正的权限隔离。
      // 这里锁定「已知限制」的真实行为，防止后人误以为它有防护能力。
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: '自称主代理', force: true });
      assert.equal(r.ok, true, '当前实现下任何调用方都可用 force（协议层无身份认证）');

      // 但必须留下可追溯的审计痕迹：这是 force 的真实价值所在
      const board = await c.call('board', { workspace: ws });
      const evt = (board.recentEvents ?? []).find(e => String(e.event).includes('强制'));
      assert.ok(evt, '必须留审计事件');
      assert.match(String(evt.owner ?? '') + String(evt.detail ?? ''), /自称主代理/, '审计事件应记录实际操作者');
    } finally { rmWorkspace(ws); }
  });
});

describe('失败语义（failurePolicy）', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('默认 block：上游失败后下游不就绪、不可领取', async () => {
    const ws = makeWorkspace('fp1');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'failed', note: '挂了', owner: 'w1' });

      const ready = await c.call('task_ready', { workspace: ws });
      assert.equal(ready.failurePolicy, 'block');
      assert.ok(!ready.ready.some(t => t.id === 'b'), '上游失败后下游不应就绪');

      const claim = await c.callRaw('task_claim', { workspace: ws, taskId: 'b', owner: 'w2' });
      assert.equal(claim.ok, false, '被阻断的下游不能领取');
      assert.match(claim.error, /失败|阻断|block/);
    } finally { rmWorkspace(ws); }
  });

  test('skipped 上游同样阻断下游', async () => {
    const ws = makeWorkspace('fp2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }] });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'skipped', owner: 'w1' });
      const ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === 'b'));
    } finally { rmWorkspace(ws); }
  });

  test('proceed：下游仍就绪并标注 blockedBy', async () => {
    const ws = makeWorkspace('fp3');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', failurePolicy: 'proceed', tasks: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'failed', note: '挂了', owner: 'w1' });

      const ready = await c.call('task_ready', { workspace: ws });
      assert.equal(ready.failurePolicy, 'proceed');
      const b = ready.ready.find(t => t.id === 'b');
      assert.ok(b, 'proceed 策略下下游应仍就绪');
      assert.deepEqual(b.blockedBy, ['a'], '必须标注被谁阻断');
    } finally { rmWorkspace(ws); }
  });

  test('非法 failurePolicy 被拒绝', async () => {
    const ws = makeWorkspace('fp4');
    try {
      const r = await c.callRaw('plan_create', { workspace: ws, goal: 'g', failurePolicy: '随便', tasks: [{ id: 'a', title: 'A' }] });
      assert.equal(r.ok, false);
    } finally { rmWorkspace(ws); }
  });
});

describe('依赖与就绪计算', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('task_ready 只返回依赖已满足的任务', async () => {
    const ws = makeWorkspace('ready');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }] });
      let ready = await c.call('task_ready', { workspace: ws });
      assert.deepEqual(ready.ready.map(t => t.id), ['a']);

      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'w1' });
      ready = await c.call('task_ready', { workspace: ws });
      assert.deepEqual(ready.ready.map(t => t.id), ['b']);
    } finally { rmWorkspace(ws); }
  });

  test('task_add 追加任务并正确参与依赖计算', async () => {
    const ws = makeWorkspace('add');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
      const added = await c.call('task_add', { workspace: ws, title: '追加的', dependsOn: ['a'], parentId: 'b' });
      assert.ok(added.taskId);
      let ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === added.taskId), '依赖未满足不应就绪');

      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'w1' });
      ready = await c.call('task_ready', { workspace: ws });
      assert.ok(ready.ready.some(t => t.id === added.taskId), '依赖满足后应就绪');
    } finally { rmWorkspace(ws); }
  });

  test('task_add 的父任务不存在时报错', async () => {
    const ws = makeWorkspace('add2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const r = await c.callRaw('task_add', { workspace: ws, title: 'x', parentId: '不存在' });
      assert.equal(r.ok, false);
      assert.match(r.error, /不存在/);
    } finally { rmWorkspace(ws); }
  });
});

describe('board 与进度互通', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('board 展示状态、owner、最新笔记摘要', async () => {
    const ws = makeWorkspace('board');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: '设计页面' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'in_progress', note: '选定方案B', owner: 'agent-1' });

      const bd = await c.call('board', { workspace: ws });
      assert.equal(bd.active, true);
      assert.match(bd.view, /@agent-1/);
      assert.match(bd.view, /选定方案B/);
      assert.ok(bd.activeWorkers.some(w => w.owner === 'agent-1'));
    } finally { rmWorkspace(ws); }
  });

  test('board 按 owner 过滤是真实生效的（修掉原版恒真断言）', async () => {
    const ws = makeWorkspace('board2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: '属于甲的任务' }, { id: 'b', title: '属于乙的任务' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'jia' });
      await c.call('task_claim', { workspace: ws, taskId: 'b', owner: 'yi' });

      const filtered = await c.call('board', { workspace: ws, owner: 'jia' });
      // 原版断言写的是 `!includes(A) || includes(B)`，后半句恒真 → 过滤完全坏掉也通过。
      // 这里改为双向断言：甲的视图必须含自己、必须不含乙。
      assert.match(filtered.view, /属于甲的任务/, '过滤后应保留甲的任务');
      assert.ok(!filtered.view.includes('属于乙的任务'), '过滤后不应出现乙的任务');
      assert.ok(filtered.activeWorkers.every(w => w.owner === 'jia'), 'activeWorkers 也必须被过滤');
    } finally { rmWorkspace(ws); }
  });

  test('无计划时 board 返回 active:false', async () => {
    const ws = makeWorkspace('board3');
    try {
      const bd = await c.call('board', { workspace: ws });
      assert.equal(bd.active, false);
    } finally { rmWorkspace(ws); }
  });
});

describe('笔记治理与 task_notes 分页', () => {
  let c;
  before(() => { c = connect({ TASKSWARM_MAX_NOTES: '50', TASKSWARM_MAX_NOTE_CHARS: '200' }); });
  after(() => c.kill());

  test('超长笔记被截断且有标记（真落盘）', async () => {
    const ws = makeWorkspace('notes');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const long = 'x'.repeat(1000);
      await c.call('task_update', { workspace: ws, taskId: 'a', note: long, owner: 'w1' });

      const n = await c.call('task_notes', { workspace: ws, taskId: 'a' });
      assert.ok(n.notes[0].note.length < long.length);
      assert.match(n.notes[0].note, /已截断/);

      const disk = JSON.parse(fs.readFileSync(path.join(ws, '任务蜂群', 'swarm-state.json'), 'utf8'));
      assert.ok(disk.tasks.a.notes[0].note.length < long.length, '磁盘上必须是截断后的');
    } finally { rmWorkspace(ws); }
  });

  test('笔记条数上限：保留最新、丢弃有记账（总数 = 保留 + 丢弃）', async () => {
    const ws = makeWorkspace('notes2');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const N = 70, LIMIT = 50;
      for (let i = 0; i < N; i++) await c.call('task_update', { workspace: ws, taskId: 'a', note: `n${i}`, owner: 'w1' });

      const n = await c.call('task_notes', { workspace: ws, taskId: 'a', limit: 200 });
      assert.equal(n.total, LIMIT, `保留数应为上限 ${LIMIT}`);
      assert.equal(n.notesDropped, N - LIMIT, '丢弃数必须记账');
      assert.equal(n.total + n.notesDropped, N, '保留 + 丢弃 == 写入总数');
      assert.equal(n.notes.at(-1).note, `n${N - 1}`, '应保留最新的');

      const disk = JSON.parse(fs.readFileSync(path.join(ws, '任务蜂群', 'swarm-state.json'), 'utf8'));
      assert.equal(disk.tasks.a.notes.length, LIMIT, '磁盘上也必须受限');
      assert.equal(disk.tasks.a.notesDropped, N - LIMIT);
    } finally { rmWorkspace(ws); }
  });

  test('task_notes 分页拼接可还原全部笔记（按写入顺序无重复）', async () => {
    const ws = makeWorkspace('notes3');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const N = 45;
      for (let i = 0; i < N; i++) await c.call('task_update', { workspace: ws, taskId: 'a', note: `note-${i}`, owner: 'w1' });

      const collected = [];
      let offset = 0, guard = 0;
      while (guard++ < 20) {
        const page = await c.call('task_notes', { workspace: ws, taskId: 'a', limit: 10, offset });
        collected.unshift(...page.notes.map(x => x.note));
        if (!page.hasMore) break;
        offset += 10;
      }
      assert.equal(collected.length, N);
      assert.deepEqual(collected, Array.from({ length: N }, (_, i) => `note-${i}`), '分页拼接应还原写入顺序');
      assert.equal(new Set(collected).size, N, '不应有重复');
    } finally { rmWorkspace(ws); }
  });

  test('offset 超过总数返回空页而非报错', async () => {
    const ws = makeWorkspace('notes4');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'only', owner: 'w1' });
      const page = await c.call('task_notes', { workspace: ws, taskId: 'a', offset: 999 });
      assert.equal(page.notes.length, 0);
      assert.equal(page.hasMore, false);
    } finally { rmWorkspace(ws); }
  });

  test('plan_get / board 仍只给摘要，并提示去 task_notes 读全文', async () => {
    const ws = makeWorkspace('notes5');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const full = 'FULLTEXT-' + 'y'.repeat(150) + '-END';
      await c.call('task_update', { workspace: ws, taskId: 'a', note: full, owner: 'w1' });

      const pg = await c.call('plan_get', { workspace: ws });
      const bd = await c.call('board', { workspace: ws });
      assert.ok(!JSON.stringify(pg.recentEvents).includes('-END'), 'plan_get 不应带全文');
      assert.ok(!bd.view.includes('-END'), 'board 不应带全文');
      assert.match(JSON.stringify(pg.notesHint ?? ''), /task_notes/, '应提示全文通道');

      const n = await c.call('task_notes', { workspace: ws, taskId: 'a' });
      assert.ok(n.notes[0].note.includes('-END'), 'task_notes 应能读回全文');
    } finally { rmWorkspace(ws); }
  });

  for (const [label, args] of [
    ['负数 limit', { limit: -1 }],
    ['非数字 limit', { limit: 'abc' }],
    ['超上限 limit', { limit: 9999 }],
    ['小数 limit', { limit: 1.5 }],
    ['负数 offset', { offset: -5 }],
  ]) {
    test(`非法分页参数（${label}）被拒且信息可读`, async () => {
      const ws = makeWorkspace('notes6');
      try {
        await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
        const r = await c.callRaw('task_notes', { workspace: ws, taskId: 'a', ...args });
        assert.equal(r.ok, false);
        assert.match(r.error, /下一步/, '错误应给出下一步');
      } finally { rmWorkspace(ws); }
    });
  }

  test('task_notes 缺 taskId 或任务不存在时给出明确错误', async () => {
    const ws = makeWorkspace('notes7');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      assert.equal((await c.callRaw('task_notes', { workspace: ws })).ok, false);
      assert.equal((await c.callRaw('task_notes', { workspace: ws, taskId: '幽灵' })).ok, false);
    } finally { rmWorkspace(ws); }
  });

  test('task_notes 是只读的（不改变笔记数量）', async () => {
    const ws = makeWorkspace('notes8');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n1', owner: 'w1' });
      const before = await c.call('task_notes', { workspace: ws, taskId: 'a' });
      await c.call('task_notes', { workspace: ws, taskId: 'a' });
      const after = await c.call('task_notes', { workspace: ws, taskId: 'a' });
      assert.equal(before.total, after.total);
    } finally { rmWorkspace(ws); }
  });
});
