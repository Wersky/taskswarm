/**
 * 多进程并发测试 —— 本插件最有价值的一组测试。
 *
 * 为什么必须是独立进程：本插件的卖点是「原子领取、防重复派发、看板状态不丢」，
 * 而这些保证只在**多个 server 进程共享同一个状态库**时才受到真正考验。
 * 同进程内的 Promise 并发测不出任何东西（事件循环天然串行）。
 *
 * 旧实现（1.0.0）在本文件的场景下会真实失败：
 *   - 两进程并发追加笔记 → 状态文件 JSON 损坏，数据不可恢复丢失
 *   - 两进程并发抢同一任务 → 60 次里 4 次双方都领取成功
 * 3.0 起存储换成 SQLite（WAL + BEGIN IMMEDIATE），断言从「文件可解析」
 * 改为「库可读 + 行数/内容正确」；SIGKILL 与 WAL 恢复场景保留。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace, openDb } from './helpers.mjs';

const dbPath = (ws) => path.join(ws, '任务蜂群', 'swarm-state.db');

/** 起一个独立 server 进程，返回该进程专属的连接（模拟不同子代理会话）。 */
function worker(ws) {
  const c = connect();
  return {
    ws, c,
    close() { c.kill(); },
  };
}

describe('多进程并发：原子领取', () => {
  test('60 次并发抢同一任务，双重领取次数必须为 0', async () => {
    const TRIALS = Number(process.env.TASKSWARM_TRIALS || 60);
    const ws = makeWorkspace('mp-claim');
    let doubleClaimed = 0;
    let unexpectedError = 0;
    try {
      for (let i = 0; i < TRIALS; i++) {
        // 每轮重建计划，保证是从 pending 出发的干净竞态
        const a = worker(ws), b = worker(ws);
        await a.c.rpc('ping', {});
        await a.c.call('plan_reset', { workspace: ws });
        await a.c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 't', title: '唯一任务' }] });

        const [r1, r2] = await Promise.all([
          a.c.callRaw('task_claim', { workspace: ws, taskId: 't', owner: 'worker-A' }),
          b.c.callRaw('task_claim', { workspace: ws, taskId: 't', owner: 'worker-B' }),
        ]);
        if (r1.ok && r2.ok) doubleClaimed++;
        // 输家必须是「已被领取」这类预期拒绝，不能是 busy 超时/内部异常/库损坏
        for (const r of [r1, r2]) {
          if (!r.ok && !/已被|状态为|not|领取/.test(r.error) && /锁|超时|内部|undefined|损坏/.test(r.error)) {
            unexpectedError++;
          }
        }
        a.close(); b.close();
      }
      assert.equal(doubleClaimed, 0,
        `${TRIALS} 次并发抢任务出现 ${doubleClaimed} 次双重领取（旧实现为 4 次）`);
      assert.equal(unexpectedError, 0, '不应出现锁超时或内部异常');
    } finally { rmWorkspace(ws); }
  });

  test('10 个进程同时抢一个任务，恰好 1 个成功', async () => {
    const ws = makeWorkspace('mp-claim10');
    try {
      const c0 = connect();
      await c0.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 't', title: '任务' }] });
      c0.kill();

      const workers = Array.from({ length: 10 }, () => worker(ws));
      const results = await Promise.all(workers.map((w, i) =>
        w.c.callRaw('task_claim', { workspace: ws, taskId: 't', owner: `w${i}` })));
      workers.forEach(w => w.close());

      const winners = results.filter(r => r.ok);
      assert.equal(winners.length, 1, `应恰好 1 个成功，实际 ${winners.length} 个`);
    } finally { rmWorkspace(ws); }
  });
});

describe('多进程并发：状态不丢', () => {
  test('两进程各追加 120 条笔记，条数无丢失且库可读', async () => {
    const N = Number(process.env.TASKSWARM_NOTES_PER_WORKER || 120);
    const ws = makeWorkspace('mp-notes');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: '任务A' }, { id: 'b', title: '任务B' }] });
      seed.kill();

      // 关掉笔记上限，确保测的是「并发不丢」而不是「被上限丢掉」
      const env = { TASKSWARM_MAX_NOTES: '100000' };
      const A = connect(env), B = connect(env);

      const job = (c, taskId, tag) => (async () => {
        for (let i = 0; i < N; i++) {
          await c.call('task_update', { workspace: ws, taskId, note: `${tag}-${i}`, owner: `agent-${tag}` });
        }
      })();
      await Promise.all([job(A, 'a', 'A'), job(B, 'b', 'B')]);
      A.kill(); B.kill();

      // 1) 库必须可读（旧实现的故障是 JSON 文件损坏；现在对应库损坏/无法打开）
      const { db, close } = openDb(ws);
      try {
        const notes = (id) => db.prepare('SELECT at,owner,note FROM notes WHERE taskId=? ORDER BY id ASC').all(id);

        // 2) 条数无丢失
        assert.equal(notes('a').length, N, `任务 a 应有 ${N} 条笔记`);
        assert.equal(notes('b').length, N, `任务 b 应有 ${N} 条笔记`);

        // 3) 无交叉污染
        assert.ok(notes('a').every(n => n.owner === 'agent-A'), '任务 a 不应混入 B 的笔记');
        assert.ok(notes('b').every(n => n.owner === 'agent-B'), '任务 b 不应混入 A 的笔记');

        // 4) 内容完整（抽查首尾）
        assert.equal(notes('a')[0].note, 'A-0');
        assert.equal(notes('a')[N - 1].note, `A-${N - 1}`);
      } finally { close(); }
    } finally { rmWorkspace(ws); }
  });

  test('三进程并发写不同任务，最终状态自洽', async () => {
    const N = 40;
    const ws = makeWorkspace('mp-notes3');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'x', title: 'X' }, { id: 'y', title: 'Y' }, { id: 'z', title: 'Z' }] });
      seed.kill();

      const env = { TASKSWARM_MAX_NOTES: '100000' };
      const workers = [['x', 'p'], ['y', 'q'], ['z', 'r']].map(([taskId, tag]) => ({ taskId, tag, c: connect(env) }));
      await Promise.all(workers.map(({ taskId, tag, c }) => (async () => {
        for (let i = 0; i < N; i++) {
          await c.call('task_update', { workspace: ws, taskId, note: `${tag}${i}`, owner: tag });
        }
      })()));
      workers.forEach(w => w.c.kill());

      const { db, close } = openDb(ws);
      try {
        for (const [id, tag] of [['x', 'p'], ['y', 'q'], ['z', 'r']]) {
          const notes = db.prepare('SELECT owner FROM notes WHERE taskId=? ORDER BY id ASC').all(id);
          assert.equal(notes.length, N, `任务 ${id} 应保留 ${N} 条`);
          assert.ok(notes.every(n => n.owner === tag), `任务 ${id} 不应被别的进程写脏`);
        }
        // 事件表 append-only：3×N 条进展 + 计划创建，永不截断
        const evCount = db.prepare('SELECT COUNT(*) c FROM events').get().c;
        assert.ok(evCount >= 3 * N, `事件应完整累积（${evCount} >= ${3 * N}）`);
      } finally { close(); }
    } finally { rmWorkspace(ws); }
  });

  test('并发创建+领取混合操作后，状态库依然自洽', async () => {
    const ws = makeWorkspace('mp-mixed');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 't1', title: 'T1' }, { id: 't2', title: 'T2' }, { id: 't3', title: 'T3' }, { id: 't4', title: 'T4' }] });
      seed.kill();

      const env = { TASKSWARM_MAX_NOTES: '100000' };
      const c1 = connect(env), c2 = connect(env), c3 = connect(env);
      await Promise.all([
        // 一边领取并汇报
        (async () => {
          for (const id of ['t1', 't2']) {
            await c1.call('task_claim', { workspace: ws, taskId: id, owner: 'c1' });
            await c1.call('task_update', { workspace: ws, taskId: id, status: 'done', note: `done-${id}`, owner: 'c1' });
          }
        })(),
        // 一边追加任务
        (async () => {
          for (let i = 0; i < 10; i++) {
            await c2.call('task_add', { workspace: ws, title: `追加${i}` });
          }
        })(),
        // 一边读看板（读路径不该破坏写）
        (async () => {
          for (let i = 0; i < 15; i++) await c3.call('board', { workspace: ws });
        })(),
      ]);
      c1.kill(); c2.kill(); c3.kill();

      const { db, close } = openDb(ws);
      try {
        const status = (id) => db.prepare('SELECT status FROM tasks WHERE id=?').get(id)?.status;
        assert.equal(status('t1'), 'done');
        assert.equal(status('t2'), 'done');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, 4 + 10, '追加的 10 个任务都应落盘');
      } finally { close(); }
      const pg = await (async () => { const c = connect(); try { return await c.call('plan_get', { workspace: ws }); } finally { c.kill(); } })();
      assert.equal(pg.view.split('\n').length, 14, 'order 与 tasks 必须一致（视图行数）');
    } finally { rmWorkspace(ws); }
  });
});

describe('崩溃与损坏恢复', () => {
  test('写入过程中被 SIGKILL，状态库仍可读（WAL 恢复的价值）', async () => {
    const ws = makeWorkspace('crash');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      for (let i = 0; i < 50; i++) await seed.call('task_update', { workspace: ws, taskId: 'a', note: 'x'.repeat(500), owner: 'w1' });
      seed.kill();

      let baseline;
      {
        const { db, close } = openDb(ws);
        baseline = db.prepare('SELECT COUNT(*) c FROM notes').get().c;
        close();
      }
      assert.ok(baseline >= 50, '前置条件：库中应已有足量笔记');

      // 在密集写入的同时强杀，反复多次降低「恰好没抓到窗口」的偶然性
      let corrupt = 0;
      for (let round = 0; round < 8; round++) {
        const c = connect();
        for (let i = 0; i < 30; i++) {
          c.call('task_update', { workspace: ws, taskId: 'a', note: 'y'.repeat(500), owner: 'w1' }).catch(() => {});
        }
        c.child.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 120));
        try {
          const { db, close } = openDb(ws);
          const integrity = db.prepare('PRAGMA integrity_check').get();
          close();
          if (integrity.integrity_check !== 'ok') corrupt++;
        } catch { corrupt++; }
      }
      assert.equal(corrupt, 0, `强杀 8 次后出现 ${corrupt} 次损坏（WAL 应保证 0）`);
    } finally { rmWorkspace(ws); }
  });

  test('状态库损坏时备份为 .corrupt-<时间戳> 并给出可行动错误（绝不静默丢失）', async () => {
    const ws = makeWorkspace('corrupt');
    let c;
    try {
      c = connect();
      await c.call('plan_create', { workspace: ws, goal: '重要计划', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();
      const dir = path.join(ws, '任务蜂群');
      const f = path.join(dir, 'swarm-state.db');

      // 模拟写到一半被中断留下的残缺库（SQLite 文件头被截断）。
      // 必须连 -wal/-shm 一起替换：若留下旧 WAL，新进程会用 WAL 里的完整页
      // 「救回」数据，损坏不可复现。seed 进程退出有延迟，先等它释放文件锁，
      // Windows 上 rm 可能瞬态 EPERM，带重试。
      await new Promise(r => setTimeout(r, 1800));
      const damaged = Buffer.from('SQLite format 3' + '\0'.repeat(40) + 'truncated', 'utf8');
      for (const suffix of ['', '-wal', '-shm']) {
        let lastErr = null;
        for (let i = 0; i < 5; i++) {
          try { fs.rmSync(f + suffix, { force: true }); lastErr = null; break; }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 300)); }
        }
        if (lastErr) throw new Error(`无法清理 ${suffix || 'db'}（${lastErr.message}）`);
      }
      for (const suffix of ['', '-wal']) fs.writeFileSync(f + suffix, damaged);

      // 必须用**新进程**验证：同进程的 Store 句柄已打开旧库，感知不到文件被换掉
      const c2 = connect();
      const r = await c2.callRaw('plan_get', { workspace: ws });
      assert.equal(r.ok, false, '损坏时必须报错，而不是假装「没有计划」');
      assert.match(r.error, /损坏|备份/, '错误应说明发生了什么');
      assert.match(r.error, /plan_reset|重开|备份/, '错误应给出出路，而不是让调用方卡死');

      const backups = fs.readdirSync(dir).filter(n => n.includes('.corrupt-'));
      assert.ok(backups.length >= 1, '必须留有 .corrupt-<时间戳> 备份，避免数据彻底丢失');

      // 备份必须与损坏内容逐字节一致（否则「备份」没有意义）
      const backupContent = fs.readFileSync(path.join(dir, backups[0]));
      assert.ok(backupContent.equals(damaged), '备份内容必须与损坏前的原文件逐字节一致');

      // 按提示 plan_reset 后可重开
      await c2.call('plan_reset', { workspace: ws });
      const fresh = await c2.call('plan_create', { workspace: ws, goal: '新计划', tasks: [{ id: 'a', title: 'A' }] });
      assert.equal(fresh.ok, true);
      c2.kill();
    } finally { if (c) c.kill(); rmWorkspace(ws); }
  });

  test('强杀后状态库必为「完整的旧版或完整的新版」，任意时刻可被新进程读取', async () => {
    const ws = makeWorkspace('atomic');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      for (let i = 0; i < 40; i++) await seed.call('task_update', { workspace: ws, taskId: 'a', note: 'x'.repeat(400), owner: 'w1' });
      seed.kill();
      await new Promise(r => setTimeout(r, 200));

      for (let round = 0; round < 6; round++) {
        const c = connect();
        for (let i = 0; i < 25; i++) {
          c.call('task_update', { workspace: ws, taskId: 'a', note: 'y'.repeat(400), owner: 'w1' }).catch(() => {});
        }
        c.child.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 150));

        // 每一次快照都必须结构完整——读者永远看不到半截状态
        const { db, close } = openDb(ws);
        try {
          const t = db.prepare("SELECT status FROM tasks WHERE id='a'").get();
          assert.ok(t, `第 ${round + 1} 轮强杀后任务结构必须完整（不留中间态）`);
          const cnt = db.prepare("SELECT COUNT(*) c FROM notes WHERE taskId='a'").get().c;
          assert.ok(cnt >= 0, '笔记计数必须可读');
        } finally { close(); }
        // 每次快照都应能正常喂给新进程（真实可读性验证）
        const reader = connect();
        const pg = await reader.call('plan_get', { workspace: ws });
        reader.kill();
        assert.ok(pg.view, '任意一次崩溃后的快照都应能被新进程正常读取');
      }
    } finally { rmWorkspace(ws); }
  });

  test('强杀不丢失既有笔记（已落盘的内容不会因崩溃回退）', async () => {
    const ws = makeWorkspace('nolost');
    try {
      const c = connect();
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const N = 30;
      for (let i = 0; i < N; i++) await c.call('task_update', { workspace: ws, taskId: 'a', note: `keep-${i}`, owner: 'w1' });
      let before;
      {
        const { db, close } = openDb(ws);
        before = db.prepare("SELECT COUNT(*) c FROM notes WHERE taskId='a'").get().c;
        close();
      }
      c.child.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 300));

      const c2 = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '3000' });
      const r = await c2.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'after-crash', owner: 'w1' });
      c2.kill();
      assert.equal(r.ok, true, '崩溃后的库应能被新进程直接接管，不阻断恢复');

      let notes;
      {
        const { db, close } = openDb(ws);
        notes = db.prepare("SELECT note FROM notes WHERE taskId='a' ORDER BY id ASC").all();
        close();
      }
      assert.ok(notes.length >= before, `崩溃不应让已落盘的 ${before} 条笔记变少（实际 ${notes.length}）`);
      for (let i = 0; i < N; i++) {
        assert.ok(notes.some(n => n.note === `keep-${i}`), `第 ${i} 条笔记不应丢失`);
      }
    } finally { rmWorkspace(ws); }
  });

  test('server 进程崩溃重启后能继续读写同一状态库', async () => {
    const ws = makeWorkspace('restart');
    try {
      const c1 = connect();
      await c1.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      await c1.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      c1.child.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 300));

      // 新进程（模拟会话恢复）接管
      const c2 = connect();
      const pg = await c2.call('plan_get', { workspace: ws });
      assert.equal(pg.goal, 'g');
      assert.match(pg.view, /claimed|w1/, '恢复后应看到原状态');

      // 并用 force 恢复死任务
      const back = await c2.call('task_update', { workspace: ws, taskId: 'a', status: 'pending', owner: 'w1', force: true });
      assert.equal(back.task.status, 'pending');
      const re = await c2.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w2' });
      assert.equal(re.task.id, 'a');
      c2.kill();
    } finally { rmWorkspace(ws); }
  });
});

describe('server.mjs 可独立启动（可移植性冒烟）', () => {
  test('从任意工作目录用 node 直接启动即可服务（不依赖仓库内相对路径）', async () => {
    // 用一个与 server.mjs 无关的 cwd 启动，验证不依赖 process.cwd()
    const tmpCwd = makeWorkspace('cwd');
    try {
      const c = connect({}, { cwd: tmpCwd });
      const res = await c.rpc('initialize', {});
      assert.equal(res.result.serverInfo.name, 'taskswarm');
      c.kill();
    } finally { rmWorkspace(tmpCwd); }
  });
});
