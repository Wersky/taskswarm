/**
 * 3.0 存储层专项：2.2.0 JSON 自动迁移、rev 版本号单调性、快照往返、schema 守卫。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

const dbPath = (ws) => path.join(ws, '任务蜂群', 'swarm-state.db');

describe('2.2.0 JSON 自动迁移', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('旧 swarm-state.json 首次读取时无损导入，原文件改名为 .migrated-backup.json', async () => {
    const ws = makeWorkspace('migrate');
    try {
      const dir = path.join(ws, '任务蜂群');
      fs.mkdirSync(dir, { recursive: true });
      // 手工构造 2.2.0 落盘格式：任务、笔记、事件流俱全
      const legacy = {
        phase: 'swarming', goal: '旧计划', failurePolicy: 'proceed',
        createdAt: '2026-01-01T00:00:00.000Z', nextId: 5,
        tasks: {
          T1: {
            id: 'T1', title: '旧任务一', detail: '有点旧', dependsOn: [], parent: null, depth: 0,
            children: ['T2'], status: 'in_progress', owner: 'old-agent', role: 'producer',
            reviewer: 'old-reviewer', reviewStage: 'rejected', notes: [
              { at: '2026-01-02T00:00:00.000Z', owner: 'old-agent', note: '第一条结论' },
              { at: '2026-01-03T00:00:00.000Z', owner: 'old-reviewer', note: '【审核驳回】重做' },
            ], claimedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
          },
          T2: {
            id: 'T2', title: '旧任务二', detail: '', dependsOn: ['T1'], parent: 'T1', depth: 1,
            children: [], status: 'pending', owner: null, role: 'none', reviewer: null,
            reviewStage: 'none', notes: [], createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
        order: ['T1', 'T2'],
        log: [
          { at: '2026-01-01T00:00:00.000Z', event: '计划创建', detail: '2 个任务，目标：旧计划' },
          { at: '2026-01-02T00:00:00.000Z', event: '领取', taskId: 'T1', owner: 'old-agent' },
        ],
      };
      fs.writeFileSync(path.join(dir, 'swarm-state.json'), JSON.stringify(legacy, null, 2), 'utf8');

      // 首次读取：迁移发生，数据无损
      const pg = await c.call('plan_get', { workspace: ws });
      assert.equal(pg.goal, '旧计划');
      assert.equal(pg.failurePolicy, 'proceed');
      assert.match(pg.view, /旧任务一/);
      assert.match(pg.view, /✖ old-reviewer 已驳回/);

      const notes = await c.call('task_notes', { workspace: ws, taskId: 'T1', limit: 200 });
      assert.equal(notes.total, 2, '笔记应无损迁移');
      assert.equal(notes.notes[0].note, '第一条结论');

      // 原文件已归档
      assert.ok(!fs.existsSync(path.join(dir, 'swarm-state.json')), '旧 JSON 应改名');
      assert.ok(fs.existsSync(path.join(dir, 'swarm-state.json.migrated-backup.json')), '应有迁移备份');

      // 事件流迁移：task_notes/task_notes 之外，state load 能看到全量 log
      const st = await c.call('state', { workspace: ws, op: 'load' });
      assert.equal(st.state.log.filter(e => e.event === '领取').length, 1, '旧 log 应进 events 表并随快照导出');

      // 写路径继续可用：T1（reviewStage=rejected）需走审核门 approve 才真正完成
      await c.call('task_update', { workspace: ws, taskId: 'T1', status: 'done', note: '迁移后照常推进', owner: 'old-agent' });
      await c.call('task_review', { workspace: ws, taskId: 'T1', verdict: 'approve', owner: 'old-reviewer' });
      await c.call('task_claim', { workspace: ws, taskId: 'T2', owner: 'new-agent' });
      const bd = await c.call('board', { workspace: ws });
      assert.match(bd.view, /new-agent/);
    } finally { rmWorkspace(ws); }
  });

  test('空/损坏的旧 JSON：空文件归档不报错；坏文件备份后明确报错', async () => {
    const ws = makeWorkspace('migrate-empty');
    try {
      const dir = path.join(ws, '任务蜂群');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'swarm-state.json'), '   ', 'utf8');
      const bd = await c.call('board', { workspace: ws });
      assert.equal(bd.active, false, '空旧文件按「无计划」处理');
      assert.ok(fs.existsSync(path.join(dir, 'swarm-state.json.migrated-backup.json')));
    } finally { rmWorkspace(ws); }

    const ws2 = makeWorkspace('migrate-bad');
    try {
      const dir = path.join(ws2, '任务蜂群');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'swarm-state.json'), '{"phase":"swarming","goal":', 'utf8');
      const r = await c.callRaw('plan_get', { workspace: ws2 });
      assert.equal(r.ok, false, '损坏旧文件必须报错');
      assert.match(r.error, /迁移失败|损坏/, '错误应说明是迁移遇到的损坏');
      assert.ok(fs.readdirSync(dir).some(n => n.includes('.corrupt-')), '坏文件应有 .corrupt 备份');
    } finally { rmWorkspace(ws2); }
  });
});

describe('rev 版本号（增量拉取的基础）', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('每次写操作 rev 严格 +1，读操作不动 rev', async () => {
    const ws = makeWorkspace('rev');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const pg1 = await c.call('plan_get', { workspace: ws });
      const rev0 = pg1.rev;
      assert.ok(Number.isInteger(rev0) && rev0 >= 1, 'rev 必须是正整数');

      const bd1 = await c.call('board', { workspace: ws });
      assert.equal(bd1.rev, rev0, '读操作不推进 rev');

      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      const pg2 = await c.call('plan_get', { workspace: ws });
      assert.equal(pg2.rev, rev0 + 1, '一次写恰好 +1');

      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n1', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n2', owner: 'w1' });
      const pg3 = await c.call('plan_get', { workspace: ws });
      assert.equal(pg3.rev, rev0 + 3, '两次写再 +2');
    } finally { rmWorkspace(ws); }
  });
});

describe('state 快照 save/load 往返（会话恢复语义）', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('save 后 load 还原任务/笔记/事件；clear 后归零', async () => {
    const ws = makeWorkspace('snap');
    try {
      await c.call('plan_create', { workspace: ws, goal: '快照计划', tasks: [{ id: 'a', title: 'A' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', note: '关键结论', owner: 'w1' });

      const snap = await c.call('state', { workspace: ws, op: 'load' });
      assert.equal(snap.exists, true);
      assert.ok(snap.state.tasks.a, '快照含任务');

      // 清空后把快照灌回去
      await c.call('state', { workspace: ws, op: 'clear' });
      const empty = await c.call('state', { workspace: ws, op: 'load' });
      assert.equal(empty.exists, false, 'clear 后无计划');

      await c.call('state', { workspace: ws, op: 'save', state: snap.state });
      const restored = await c.call('state', { workspace: ws, op: 'load' });
      assert.equal(restored.exists, true);
      assert.equal(restored.state.goal, '快照计划');
      assert.equal(restored.state.tasks.a.status, 'claimed');
      const notes = await c.call('task_notes', { workspace: ws, taskId: 'a' });
      assert.equal(notes.notes[0]?.note, '关键结论', '笔记随快照还原');
      const pg = await c.call('plan_get', { workspace: ws });
      assert.match(pg.view, /claimed/, '恢复后视图正常（planView 不含 owner，看状态即可）');
    } finally { rmWorkspace(ws); }
  });

  test('未来 schema 版本的库被拒绝（防旧插件写坏新库）', async () => {
    const ws = makeWorkspace('schema');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const db = new DatabaseSync(dbPath(ws));
      db.prepare("UPDATE meta SET value='999' WHERE key='schemaVersion'").run();
      db.close();

      const c2 = connect();
      const r = await c2.callRaw('plan_get', { workspace: ws });
      c2.kill();
      assert.equal(r.ok, false, '未来 schema 必须拒绝');
      assert.match(r.error, /schema|升级/, '错误应说明要升级插件');
    } finally { rmWorkspace(ws); }
  });
});
