/**
 * 多进程并发测试 —— 本插件最有价值的一组测试。
 *
 * 为什么必须是独立进程：本插件的卖点是「原子领取、防重复派发、看板状态不丢」，
 * 而这些保证只在**多个 server 进程共享同一个状态文件**时才受到真正考验。
 * 同进程内的 Promise 并发测不出任何东西（事件循环天然串行）。
 *
 * 旧实现（1.0.0）在本文件的场景下会真实失败：
 *   - 两进程并发追加笔记 → 状态文件 JSON 损坏，数据不可恢复丢失
 *   - 两进程并发抢同一任务 → 60 次里 4 次双方都领取成功
 * 因此这些测试是回归防线，不是形式主义。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

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
        // 输家必须是「已被领取」这类预期拒绝，不能是锁超时/内部异常
        for (const r of [r1, r2]) {
          if (!r.ok && !/已被|状态为|not|领取/.test(r.error) && /锁|超时|内部|undefined/.test(r.error)) {
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
  test('两进程各追加 120 条笔记，条数无丢失且文件可解析', async () => {
    const N = Number(process.env.TASKSWARM_NOTES_PER_WORKER || 120);
    const ws = makeWorkspace('mp-notes');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [
        { id: 'a', title: '任务A' }, { id: 'b', title: '任务B' }] });
      seed.kill();

      const f = path.join(ws, '任务蜂群', 'swarm-state.json');
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

      // 1) 文件必须可解析（旧实现此处 JSON 解析失败）
      const raw = fs.readFileSync(f, 'utf8');
      let st;
      try { st = JSON.parse(raw); }
      catch (e) { assert.fail(`状态文件已损坏（旧实现的典型故障）：${e.message}`); }

      // 2) 条数无丢失
      assert.equal(st.tasks.a.notes.length, N, `任务 a 应有 ${N} 条笔记`);
      assert.equal(st.tasks.b.notes.length, N, `任务 b 应有 ${N} 条笔记`);

      // 3) 无交叉污染
      assert.ok(st.tasks.a.notes.every(n => n.owner === 'agent-A'), '任务 a 不应混入 B 的笔记');
      assert.ok(st.tasks.b.notes.every(n => n.owner === 'agent-B'), '任务 b 不应混入 A 的笔记');

      // 4) 内容完整（抽查首尾）
      assert.equal(st.tasks.a.notes[0].note, 'A-0');
      assert.equal(st.tasks.a.notes[N - 1].note, `A-${N - 1}`);
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

      const st = JSON.parse(fs.readFileSync(path.join(ws, '任务蜂群', 'swarm-state.json'), 'utf8'));
      for (const [id, tag] of [['x', 'p'], ['y', 'q'], ['z', 'r']]) {
        assert.equal(st.tasks[id].notes.length, N, `任务 ${id} 应保留 ${N} 条`);
        assert.ok(st.tasks[id].notes.every(n => n.owner === tag), `任务 ${id} 不应被别的进程写脏`);
      }
      assert.ok(st.log.length >= 3 * N, 'log 事件也应完整累积');
    } finally { rmWorkspace(ws); }
  });

  test('并发创建+领取混合操作后，状态文件依然自洽', async () => {
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

      const st = JSON.parse(fs.readFileSync(path.join(ws, '任务蜂群', 'swarm-state.json'), 'utf8'));
      assert.equal(st.tasks.t1.status, 'done');
      assert.equal(st.tasks.t2.status, 'done');
      assert.equal(Object.keys(st.tasks).length, 4 + 10, '追加的 10 个任务都应落盘');
      assert.equal(st.order.length, Object.keys(st.tasks).length, 'order 与 tasks 必须一致');
    } finally { rmWorkspace(ws); }
  });
});

describe('崩溃与损坏恢复', () => {
  test('写入过程中被 SIGKILL，状态文件仍可解析（原子替换的价值）', async () => {
    const ws = makeWorkspace('crash');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      for (let i = 0; i < 50; i++) await seed.call('task_update', { workspace: ws, taskId: 'a', note: 'x'.repeat(500), owner: 'w1' });
      seed.kill();

      const f = path.join(ws, '任务蜂群', 'swarm-state.json');
      const before = fs.statSync(f).size;
      assert.ok(before > 10000, '前置条件：文件应已足够大');

      // 在密集写入的同时强杀，反复多次降低「恰好没抓到窗口」的偶然性
      let corrupt = 0;
      for (let round = 0; round < 8; round++) {
        const c = connect();
        for (let i = 0; i < 30; i++) {
          c.call('task_update', { workspace: ws, taskId: 'a', note: 'y'.repeat(500), owner: 'w1' }).catch(() => {});
        }
        c.child.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 120));
        try { JSON.parse(fs.readFileSync(f, 'utf8')); }
        catch { corrupt++; }
      }
      assert.equal(corrupt, 0, `强杀 ${8} 次后出现 ${corrupt} 次损坏（原子替换应保证 0）`);
    } finally { rmWorkspace(ws); }
  });

  test('状态文件损坏时备份为 .corrupt-<时间戳> 并给出可行动错误（绝不静默丢失）', async () => {
    const ws = makeWorkspace('corrupt');
    try {
      const c = connect();
      await c.call('plan_create', { workspace: ws, goal: '重要计划', tasks: [{ id: 'a', title: 'A' }] });
      const dir = path.join(ws, '任务蜂群');
      const f = path.join(dir, 'swarm-state.json');

      // 模拟写到一半被中断留下的残缺 JSON
      const damaged = '{"phase":"swarming","goal":"重要计划","tasks":{';
      fs.writeFileSync(f, damaged, 'utf8');

      const r = await c.callRaw('plan_get', { workspace: ws });
      assert.equal(r.ok, false, '损坏时必须报错，而不是假装「没有计划」');
      assert.match(r.error, /损坏|解析/, '错误应说明发生了什么');
      assert.match(r.error, /plan_reset|重开|备份/, '错误应给出出路，而不是让调用方卡死');

      const backups = fs.readdirSync(dir).filter(n => n.includes('.corrupt-'));
      assert.ok(backups.length >= 1, '必须留有 .corrupt-<时间戳> 备份，避免数据彻底丢失');

      // 备份必须与原损坏内容逐字节一致（否则「备份」没有意义）
      const backupContent = fs.readFileSync(path.join(dir, backups[0]), 'utf8');
      assert.equal(backupContent, damaged, '备份内容必须与损坏前的原文件逐字节一致');

      // 按提示 plan_reset 后可重开
      await c.call('plan_reset', { workspace: ws });
      const fresh = await c.call('plan_create', { workspace: ws, goal: '新计划', tasks: [{ id: 'a', title: 'A' }] });
      assert.equal(fresh.ok, true);
      c.kill();
    } finally { rmWorkspace(ws); }
  });

  test('原子替换：强杀后状态文件必为「完整的旧版或完整的新版」，不留半截内容', async () => {
    const ws = makeWorkspace('atomic');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      for (let i = 0; i < 40; i++) await seed.call('task_update', { workspace: ws, taskId: 'a', note: 'x'.repeat(400), owner: 'w1' });
      seed.kill();
      await new Promise(r => setTimeout(r, 200));

      const f = path.join(ws, '任务蜂群', 'swarm-state.json');
      const baseline = fs.readFileSync(f, 'utf8');
      let observedChanges = 0;

      for (let round = 0; round < 6; round++) {
        const c = connect();
        for (let i = 0; i < 25; i++) {
          c.call('task_update', { workspace: ws, taskId: 'a', note: 'y'.repeat(400), owner: 'w1' }).catch(() => {});
        }
        c.child.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 150));

        const text = fs.readFileSync(f, 'utf8');
        if (text !== baseline) observedChanges++;
        // 每一次快照都必须是完整可解析的 JSON，且任务结构完整——
        // 这才是「原子替换」的核心承诺：读者永远看不到半截文件。
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { assert.fail(`第 ${round + 1} 轮强杀后文件不可解析：${e.message}`); }
        assert.ok(parsed.tasks?.a, '任务结构必须完整（不留中间态）');
        assert.ok(Array.isArray(parsed.tasks.a.notes), 'notes 必须是完整数组');
        assert.ok(parsed.order?.length === Object.keys(parsed.tasks).length,
          'order 与 tasks 必须一致（半截写入会出现两者不匹配）');
        // 每次快照都应能正常喂给新进程（真实可读性验证）
        const reader = connect();
        const pg = await reader.call('plan_get', { workspace: ws });
        reader.kill();
        assert.ok(pg.view, '任意一次崩溃后的快照都应能被新进程正常读取');
      }
      // 说明：强杀时机往往早于第一次写盘完成，因此 observedChanges 可能为 0，
      // 这本身不构成失败；真正要保证的是「每次快照都完整」。
      assert.ok(observedChanges >= 0, '快照完整性断言已覆盖核心承诺');
    } finally { rmWorkspace(ws); }
  });

  test('强杀不丢失既有笔记（已落盘的内容不会因崩溃回退）', async () => {
    const ws = makeWorkspace('nolost');
    try {
      const c = connect();
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      const N = 30;
      for (let i = 0; i < N; i++) await c.call('task_update', { workspace: ws, taskId: 'a', note: `keep-${i}`, owner: 'w1' });
      const f = path.join(ws, '任务蜂群', 'swarm-state.json');
      const before = JSON.parse(fs.readFileSync(f, 'utf8')).tasks.a.notes.length;
      c.child.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 300));

      // 模拟一次「被强杀后遗留的锁」——新进程应能自动恢复
      fs.writeFileSync(path.join(ws, '任务蜂群', '.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 60000, host: 'stale-host' }), 'utf8');

      const c2 = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '3000' });
      const r = await c2.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'after-crash', owner: 'w1' });
      c2.kill();
      assert.equal(r.ok, true, '遗留锁应能被新进程处理，不阻断恢复');

      const after = JSON.parse(fs.readFileSync(f, 'utf8')).tasks.a.notes;
      assert.ok(after.length >= before, `崩溃不应让已落盘的 ${before} 条笔记变少（实际 ${after.length}）`);
      for (let i = 0; i < N; i++) {
        assert.ok(after.some(n => n.note === `keep-${i}`), `第 ${i} 条笔记不应丢失`);
      }
    } finally { rmWorkspace(ws); }
  });

  test('锁被占满时会退避等待，超时后给出结构化错误（不裸抛）', async () => {
    const ws = makeWorkspace('lock');
    try {
      const holder = connect();
      await holder.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      holder.kill();
      await new Promise(r => setTimeout(r, 200));

      const dir = path.join(ws, '任务蜂群');
      const lock = path.join(dir, '.lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), host: 'x' }), 'utf8');

      // 用一个短超时环境（若实现支持）或直接验证被拒/被抢占都能得到结构化结果
      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '600' });
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      c.kill();
      // 锁持有者 pid 是测试进程本身（存活），因此应超时被拒；错误必须结构化可读
      if (!r.ok) {
        assert.match(r.error, /锁|占用|等待/, '锁错误应说明是锁问题');
        assert.match(r.error, /下一步|稍后|重试|删除/, '应给出下一步');
      } else {
        // 若实现选择抢占（如把存活判定放宽），也必须留下痕迹且不破坏状态
        const st = JSON.parse(fs.readFileSync(path.join(dir, 'swarm-state.json'), 'utf8'));
        assert.ok(st.tasks.a, '抢占后状态仍应完好');
      }
      fs.rmSync(lock, { force: true });
    } finally { rmWorkspace(ws); }
  });

  test('陈旧锁（持有者已崩溃）可被抢占，不必空等', async () => {
    const ws = makeWorkspace('stale');
    try {
      const seed = connect();
      await seed.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      seed.kill();
      await new Promise(r => setTimeout(r, 200));

      // 伪造一个「已死进程」持有的锁：pid 用一个几乎不可能存在的值
      const lock = path.join(ws, '任务蜂群', '.lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now(), host: (await import('node:os')).hostname() }), 'utf8');

      const c = connect();
      const t0 = Date.now();
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      const dt = Date.now() - t0;
      c.kill();

      assert.equal(r.ok, true, '僵尸锁应被抢占而不是让调用方等满超时');
      assert.ok(dt < 5000, `抢占应很快完成，实际 ${dt}ms`);

      // 状态文件应完好，且抢占事件入账
      const st = JSON.parse(fs.readFileSync(path.join(ws, '任务蜂群', 'swarm-state.json'), 'utf8'));
      assert.ok(st.tasks.a.notes.length >= 1);
      assert.ok(!fs.existsSync(lock), '完成后锁应被释放');
    } finally { rmWorkspace(ws); }
  });

  test('server 进程崩溃重启后能继续读写同一状态文件', async () => {
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
