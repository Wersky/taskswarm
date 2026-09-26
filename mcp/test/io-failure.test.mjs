/**
 * IO 故障注入测试：当文件系统不配合时，插件的降级行为是否可接受。
 *
 * 这些路径平时不可见，但决定了「出问题时是给出可读错误，还是抛一个
 * Cannot read properties of undefined 把调用方带偏」。
 * 注入手段都限制在测试自己的临时目录内，不触碰系统路径。
 * 3.0 起状态在 SQLite（swarm-state.db），注入对象随之从 JSON 文件换为库文件。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace, openDb } from './helpers.mjs';

describe('IO 故障注入', () => {
  test('状态目录位置被一个同名文件占用时，给出可读错误而非内部异常', async () => {
    const ws = makeWorkspace('io1');
    try {
      // 让 <ws>/任务蜂群 成为一个**文件**：mkdirSync(recursive) 与建库都会失败
      fs.writeFileSync(path.join(ws, '任务蜂群'), 'not a directory', 'utf8');

      const c = connect();
      const r = await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();

      assert.equal(r.ok, false, '无法建目录时应失败');
      assert.ok(!/Cannot read|undefined|is not iterable|ENOTDIR\b.*at /.test(r.error) || /任务蜂群|目录|库|锁/.test(r.error),
        `错误应说明是路径/目录问题，便于排查。实际：${r.error}`);

      const c2 = connect();
      const board = await c2.callRaw('board', { workspace: ws });
      c2.kill();
      // 读路径遇到这种工作区应优雅返回「无计划」或可读错误，不能崩
      assert.ok(board.ok || /任务蜂群|目录|库|损坏/.test(board.error),
        `读路径应优雅降级，实际：${board.error ?? JSON.stringify(board.data)}`);
    } finally {
      try { fs.rmSync(path.join(ws, '任务蜂群'), { force: true }); } catch { /* 忽略 */ }
      rmWorkspace(ws);
    }
  });

  test('状态库是目录（而非文件）时，读写都给出可读错误', async () => {
    const ws = makeWorkspace('io2');
    try {
      const dir = path.join(ws, '任务蜂群');
      fs.mkdirSync(dir, { recursive: true });
      // 把 swarm-state.db 做成一个目录
      fs.mkdirSync(path.join(dir, 'swarm-state.db'), { recursive: true });

      const c = connect();
      const r = await c.callRaw('plan_get', { workspace: ws });
      const w = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'x', owner: 'w1' });
      c.kill();

      assert.equal(r.ok, false, '状态库不可读时应报错');
      assert.equal(w.ok, false, '状态库不可写时应报错');
      for (const msg of [r.error, w.error]) {
        assert.ok(!/Cannot read properties/.test(msg), `不应泄漏内部异常：${msg}`);
      }
    } finally { rmWorkspace(ws); }
  });

  test('状态库只读（权限不足）时，写入失败但不损坏原文件', async () => {
    const ws = makeWorkspace('io4');
    let c;
    try {
      c = connect();
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();
      const f = path.join(ws, '任务蜂群', 'swarm-state.db');
      const before = fs.readFileSync(f);

      // 只读属性（Windows 下 fs.chmod 效果有限，用只读标志更可靠）
      try { fs.chmodSync(f, 0o444); } catch { /* 忽略 */ }

      const c2 = connect();
      const r = await c2.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      c2.kill();
      if (!r.ok) {
        assert.ok(!/Cannot read properties/.test(r.error), '失败也要给出可读原因');
        // 原文件不应被破坏
        const after = fs.readFileSync(f);
        assert.ok(after.equals(before), '写失败不应改动原文件');
      }
      // 若平台允许写入（chmod 无效），则至少验证内容仍然可读
      const { db, close } = openDb(ws);
      const integrity = db.prepare('PRAGMA integrity_check').get();
      close();
      assert.equal(integrity.integrity_check, 'ok', '状态库不应被破坏');
    } finally {
      const f = path.join(ws, '任务蜂群', 'swarm-state.db');
      try { fs.chmodSync(f, 0o666); } catch { /* 忽略 */ }
      if (c) c.kill();
      rmWorkspace(ws);
    }
  });

  test('大量并发读不干扰写（WAL 读写并行的基本承诺）', async () => {
    const ws = makeWorkspace('io5');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      seed.kill();

      const readers = Array.from({ length: 3 }, () => connect());
      const writer = connect();
      await Promise.all([
        ...readers.map(r => (async () => {
          for (let i = 0; i < 25; i++) {
            await r.callRaw('board', { workspace: ws });
            await r.callRaw('plan_get', { workspace: ws });
          }
        })()),
        (async () => {
          for (let i = 0; i < 25; i++) {
            await writer.call('task_update', { workspace: ws, taskId: 'a', note: `w${i}`, owner: 'w1' });
          }
        })(),
      ]);
      readers.forEach(r => r.kill());
      writer.kill();
      await new Promise(r => setTimeout(r, 200));

      const { db, close } = openDb(ws);
      const cnt = db.prepare("SELECT COUNT(*) c FROM notes WHERE taskId='a'").get().c;
      close();
      assert.equal(cnt, 25, '并发读不应导致写入丢失');
    } finally { rmWorkspace(ws); }
  });
});
