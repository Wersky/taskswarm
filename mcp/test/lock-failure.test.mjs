/**
 * 并发安全机制的**边界与故障路径**测试。
 *
 * 前一个文件（concurrency.test.mjs）测的是「正常工作时不丢数据」；
 * 本文件专门测「出问题时机制是否按设计生效」——锁超时、陈旧锁的两种判定方式、
 * 遗留临时文件清理、参数类型校验。这些路径平时不走到，但正是可靠性承诺的兑现处。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

const stateDir = (ws) => path.join(ws, '任务蜂群');
const lockPath = (ws) => path.join(stateDir(ws), '.lock');
const statePath = (ws) => path.join(stateDir(ws), 'swarm-state.json');

/** 建好计划并关闭连接，留下可用于后续操作的干净工作区 */
async function seedWorkspace(ws) {
  const c = connect();
  await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
  c.kill();
  await new Promise(r => setTimeout(r, 250));
}

describe('锁超时：活进程持锁时调用方应退避等待后给出结构化错误', () => {
  test('锁被活进程占用 → 退避等待到超时 → 结构化中文错误（不裸抛 EEXIST）', async () => {
    const ws = makeWorkspace('lk1');
    try {
      await seedWorkspace(ws);

      // 伪造一个「宿主是本机、pid 是当前测试进程」的锁 —— process.kill(pid,0) 会成功，
      // 因此不会被当作陈旧锁抢占，只能等超时。
      fs.writeFileSync(lockPath(ws), JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() }), 'utf8');

      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '700' });
      const t0 = Date.now();
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      const dt = Date.now() - t0;
      c.kill();

      assert.equal(r.ok, false, '活进程持锁时必须拒绝而不是插队写盘');
      assert.match(r.error, /占用|锁/, '错误应说明是锁竞争');
      assert.match(r.error, /下一步|重试|删除/, '错误应给出下一步怎么做');
      assert.ok(dt >= 600, `应至少等待配置的超时时间，实际 ${dt}ms`);
      assert.ok(dt < 5000, `不应远超配置的超时，实际 ${dt}ms（说明 TASKSWARM_LOCK_TIMEOUT_MS 生效）`);
    } finally {
      try { fs.rmSync(lockPath(ws), { force: true }); } catch { /* 忽略 */ }
      rmWorkspace(ws);
    }
  });

  test('活进程持锁期间，另一个进程不会写坏状态文件', async () => {
    const ws = makeWorkspace('lk2');
    try {
      await seedWorkspace(ws);
      const before = fs.readFileSync(statePath(ws), 'utf8');
      fs.writeFileSync(lockPath(ws), JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() }), 'utf8');

      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '400' });
      await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: '不该被写入', owner: 'w1' });
      c.kill();

      assert.equal(fs.readFileSync(statePath(ws), 'utf8'), before, '拿不到锁就不能动状态文件');
    } finally {
      try { fs.rmSync(lockPath(ws), { force: true }); } catch { /* 忽略 */ }
      rmWorkspace(ws);
    }
  });
});

describe('陈旧锁的两个判定路径都能抢占', () => {
  test('路径 1：锁记录的 pid 已不存在（存活探测 ESRCH）→ 立即抢占', async () => {
    const ws = makeWorkspace('st1');
    try {
      await seedWorkspace(ws);
      // 一个几乎不可能存在的 pid；host 必须是本机才会走存活探测分支
      fs.writeFileSync(lockPath(ws), JSON.stringify({ pid: 999999, at: Date.now(), host: os.hostname() }), 'utf8');

      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '10000' });
      const t0 = Date.now();
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      const dt = Date.now() - t0;
      c.kill();

      assert.equal(r.task.status, 'pending', '僵尸锁应被抢占并完成任务');
      assert.ok(dt < 3000, `抢占应远快于超时，实际 ${dt}ms`);

      const st = JSON.parse(fs.readFileSync(statePath(ws), 'utf8'));
      assert.ok(st.log.some(e => String(e.event).includes('锁抢占')), '抢占事件必须入账，便于事后排查');
      assert.ok(!fs.existsSync(lockPath(ws)), '完成后锁应释放');
    } finally { rmWorkspace(ws); }
  });

  test('路径 2：锁龄超过阈值（无 pid 信息，按 mtime 判定）→ 抢占', async () => {
    const ws = makeWorkspace('st2');
    try {
      await seedWorkspace(ws);
      // 不含 pid/at 的锁文件：实现会退回用 mtime 判断锁龄
      fs.writeFileSync(lockPath(ws), '不是一个 JSON 锁内容', 'utf8');
      // 把 mtime 改到 30 秒前（> LOCK_STALE_MS=15s）
      const old = new Date(Date.now() - 30000);
      fs.utimesSync(lockPath(ws), old, old);

      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '10000' });
      const t0 = Date.now();
      const r = await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      const dt = Date.now() - t0;
      c.kill();

      assert.ok(!r.__isError, `按 mtime 判定的陈旧锁应被抢占，实际错误：${r.error ?? ''}`);
      assert.ok(dt < 3000, `应快速抢占而非等满超时，实际 ${dt}ms`);
    } finally { rmWorkspace(ws); }
  });

  test('未过期的坏锁（mtime 很新、无法解析）不会被误抢占，而是等超时', async () => {
    const ws = makeWorkspace('st3');
    try {
      await seedWorkspace(ws);
      fs.writeFileSync(lockPath(ws), '不是 JSON', 'utf8'); // mtime 是「现在」

      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '500' });
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      c.kill();

      assert.equal(r.ok, false, '新锁不能被误判为僵尸锁（否则会破坏互斥）');
    } finally {
      try { fs.rmSync(lockPath(ws), { force: true }); } catch { /* 忽略 */ }
      rmWorkspace(ws);
    }
  });
});

describe('遗留临时文件清理', () => {
  test('上次被强杀留下的 .tmp-* 会在下次写盘时清掉，且不影响正常写入', async () => {
    const ws = makeWorkspace('tmpc');
    try {
      await seedWorkspace(ws);
      // 模拟被强杀留下的临时文件（mtime 足够旧）
      const staleTmp = statePath(ws) + '.tmp-999999';
      fs.writeFileSync(staleTmp, '{"half":', 'utf8');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(staleTmp, old, old);

      const c = connect();
      await c.call('task_update', { workspace: ws, taskId: 'a', note: '新笔记', owner: 'w1' });
      c.kill();
      await new Promise(r => setTimeout(r, 300));

      assert.ok(!fs.existsSync(staleTmp), '过期临时文件应被清理，避免目录越积越多');
      const st = JSON.parse(fs.readFileSync(statePath(ws), 'utf8'));
      assert.equal(st.tasks.a.notes.length, 1, '正常写入不受影响');
    } finally { rmWorkspace(ws); }
  });

  test('新鲜的临时文件不会被误删（可能是并发写盘中的文件）', async () => {
    const ws = makeWorkspace('tmpc2');
    try {
      await seedWorkspace(ws);
      const freshTmp = statePath(ws) + '.tmp-888888';
      fs.writeFileSync(freshTmp, '{"in":"progress"}', 'utf8'); // mtime 是现在

      const c = connect();
      await c.call('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      c.kill();
      await new Promise(r => setTimeout(r, 300));

      assert.ok(fs.existsSync(freshTmp), '未过期的临时文件不应被删除');
    } finally { rmWorkspace(ws); }
  });
});

describe('workspace 参数校验与默认行为', () => {
  test('workspace 类型错误时给出可读错误（不抛内部异常）', async () => {
    const c = connect();
    try {
      for (const bad of [123, { a: 1 }, ['x'], true]) {
        const r = await c.callRaw('plan_create', { workspace: bad, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
        assert.equal(r.ok, false, `workspace=${JSON.stringify(bad)} 应被拒绝`);
        assert.match(r.error, /workspace/, '错误应点名 workspace 参数');
        assert.ok(!/undefined|is not iterable|Cannot read/.test(r.error), '不应泄漏内部异常');
      }
    } finally { c.kill(); }
  });

  test('省略 workspace 时回退到进程 cwd（文档据此要求显式传参）', async () => {
    const ws = makeWorkspace('nows');
    try {
      // 以 ws 作为 cwd 启动，省略 workspace 时应落在 <cwd>/任务蜂群
      const c = connect({}, { cwd: ws });
      const r = await c.call('plan_create', { goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();
      assert.ok(r.ok);
      assert.ok(fs.existsSync(path.join(ws, '任务蜂群', 'swarm-state.json')),
        '省略 workspace 时状态应落在进程 cwd 下（这正是必须显式传参的原因）');
    } finally { rmWorkspace(ws); }
  });
});
