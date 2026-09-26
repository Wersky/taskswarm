/**
 * open-lock（首次建库锁）的竞争与故障路径——3.0 新增机制的专项测试。
 *
 * 业务写互斥由 SQLite 事务承担（由 concurrency/storage-failure 覆盖）；
 * 本文件只测初始化锁本身：陈旧锁的两种抢占方式、活进程持锁时的超时错误。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

const dbPath = (ws) => path.join(ws, '任务蜂群', 'swarm-state.db');
const openLock = (ws) => dbPath(ws) + '.open-lock';

describe('open-lock：陈旧锁抢占（两条路径）', () => {
  test('路径 1：锁记录本机已死 pid → 立即抢占，首次建库照常完成', async () => {
    const ws = makeWorkspace('ol1');
    try {
      fs.mkdirSync(path.join(ws, '任务蜂群'), { recursive: true });
      fs.writeFileSync(openLock(ws), JSON.stringify({ pid: 999999, at: Date.now(), host: os.hostname() }), 'utf8');

      const c = connect();
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();
      assert.ok(fs.existsSync(dbPath(ws)), '抢占后应正常建库');
      assert.ok(!fs.existsSync(openLock(ws)), '完成后锁应释放');
    } finally { rmWorkspace(ws); }
  });

  test('路径 2：无法解析的旧锁 + mtime 老化 → 按 mtime 抢占', async () => {
    const ws = makeWorkspace('ol2');
    try {
      fs.mkdirSync(path.join(ws, '任务蜂群'), { recursive: true });
      fs.writeFileSync(openLock(ws), '不是 JSON 的残留内容', 'utf8');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(openLock(ws), old, old);

      const c = connect();
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();
      assert.ok(fs.existsSync(dbPath(ws)));
    } finally { rmWorkspace(ws); }
  });

  test('新鲜且无法解析的锁：不误抢占，保守等待后给出结构化超时错误', async () => {
    const ws = makeWorkspace('ol3');
    try {
      fs.mkdirSync(path.join(ws, '任务蜂群'), { recursive: true });
      // 内容无法解析、mtime 新鲜：既不算死 pid 也不算超龄 → 不抢占（保守正确，
      // 否则并发初始化会被误判破坏互斥），等到调用方配置的超时为止。
      fs.writeFileSync(openLock(ws), '残留', 'utf8');
      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '600' });
      const r = await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      c.kill();
      assert.equal(r.ok, false, '保守等待后应超时拒绝');
      assert.match(r.error, /初始化锁|超时|占用/, '错误应说明是初始化锁等待超时');
      assert.ok(!fs.existsSync(dbPath(ws)), '未拿到锁不得建库');
    } finally { rmWorkspace(ws); }
  });
});
