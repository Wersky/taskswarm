/**
 * 存储层故障路径测试（3.0 SQLite 语义）。
 *
 * 2.2.0 时代本文件测「文件锁超时/陈旧锁抢占/临时文件清理」；3.0 起业务写互斥
 * 由 SQLite 事务（BEGIN IMMEDIATE + busy_timeout）承担，文件锁只剩「首次建库」
 * 一段。本文件改为验证：写事务 busy 超时的结构化错误、持库期间状态不被写坏、
 * 并发首开不踩踏、workspace 参数校验。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

const stateDir = (ws) => path.join(ws, '任务蜂群');
const dbPath = (ws) => path.join(stateDir(ws), 'swarm-state.db');

/** 只读打开库并返回 { db, close }（断言用） */
function readDb(ws) {
  const db = new DatabaseSync(dbPath(ws));
  return { db, close: () => { try { db.close(); } catch { /* ignore */ } } };
}

/** 建好计划并关闭连接，留下可用于后续操作的干净工作区 */
async function seedWorkspace(ws) {
  const c = connect();
  await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
  c.kill();
  await new Promise(r => setTimeout(r, 250));
}

/**
 * 起一个「持库者」子进程：对状态库 BEGIN IMMEDIATE 并持有一段时间。
 * 返回 Promise，resolve 于写事务已建立（此时 taskswarm 的写入必须排队或失败）。
 */
function holdWriteTransaction(f, holdMs) {
  const NL = String.fromCharCode(10);
  const holderPath = f + '.holder.mjs';
  fs.writeFileSync(holderPath, [
    "import { DatabaseSync } from 'node:sqlite';",
    `const db = new DatabaseSync(${JSON.stringify(f)});`,
    "db.exec('PRAGMA busy_timeout=3000');",
    "db.exec('BEGIN IMMEDIATE');",
    "db.prepare('UPDATE meta SET value=value').run();",
    `process.stdout.write('${'h'}eld');`,
    `setTimeout(() => { try { db.exec('COMMIT'); } catch { } }, ${holdMs});`,
  ].join(NL));
  const child = spawn(process.execPath, [holderPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += String(d); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('holder 未建立写事务；stderr: ' + stderr.slice(0, 200))), 8000);
    child.stdout.on('data', d => { if (String(d).includes('held')) { clearTimeout(t); resolve(child); } });
  });
}

describe('写事务 busy 超时（对应 2.2.0 的锁超时）', () => {
  test('其他进程持有写事务 → 调用方等待到超时 → 结构化中文错误', async () => {
    const ws = makeWorkspace('lk1');
    let holder;
    try {
      await seedWorkspace(ws);

      // 持库 3s：测试方超时设 700ms，必须先于提交拿到失败
      holder = await holdWriteTransaction(dbPath(ws), 3000);

      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '700' });
      const t0 = Date.now();
      const r = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: 'n', owner: 'w1' });
      const dt = Date.now() - t0;
      c.kill();

      assert.equal(r.ok, false, '写事务被占用时必须失败而不是等待提交后插队');
      assert.match(r.error, /写入|占用|锁/, '错误应说明是状态库竞争');
      assert.match(r.error, /下一步|重试/, '错误应给出下一步怎么做');
      assert.ok(dt >= 600, `应至少等待配置的超时时间，实际 ${dt}ms`);
      assert.ok(dt < 5000, `不应远超配置的超时，实际 ${dt}ms`);
    } finally {
      if (holder) { try { holder.kill('SIGKILL'); } catch { /* ignore */ } }
      rmWorkspace(ws);
    }
  });

  test('持库期间失败的写入不会改动状态（rev 与数据都不变）', async () => {
    const ws = makeWorkspace('lk2');
    let holder;
    try {
      await seedWorkspace(ws);
      let h = readDb(ws);
      const revBefore = h.db.prepare("SELECT value FROM meta WHERE key='rev'").get().value;
      const notesBefore = h.db.prepare('SELECT COUNT(*) c FROM notes').get().c;
      h.close();

      holder = await holdWriteTransaction(dbPath(ws), 2500);
      const c = connect({ TASKSWARM_LOCK_TIMEOUT_MS: '500' });
      await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: '不该被写入', owner: 'w1' });
      c.kill();

      h = readDb(ws);
      const revAfter = h.db.prepare("SELECT value FROM meta WHERE key='rev'").get().value;
      const notesAfter = h.db.prepare('SELECT COUNT(*) c FROM notes').get().c;
      h.close();
      assert.equal(revAfter, revBefore, '失败的写不得推进 rev');
      assert.equal(notesAfter, notesBefore, '失败的写不得落任何笔记');
    } finally {
      if (holder) { try { holder.kill('SIGKILL'); } catch { /* ignore */ } }
      rmWorkspace(ws);
    }
  });
});

describe('并发首次打开（open-lock 保护）', () => {
  test('N 个进程同时首次打开同一工作区：不损坏、库完整性 ok', async () => {
    const ws = makeWorkspace('openlock');
    try {
      const clients = Array.from({ length: 6 }, () => connect());
      const results = await Promise.all(clients.map((c, i) =>
        c.callRaw('plan_create', { workspace: ws, goal: `g${i}`, tasks: [{ id: 'a', title: 'A' }] })
          .finally(() => c.kill())));
      // plan_create 是覆盖语义：并发时最后提交者赢，但不允许出现「库损坏」类硬错误
      for (const r of results) {
        if (!r.ok) {
          assert.ok(!/损坏|corrupt|malformed/i.test(r.error), `并发首开不应损坏库：${r.error}`);
        }
      }
      await new Promise(r => setTimeout(r, 300));
      const h = readDb(ws);
      const integrity = h.db.prepare('PRAGMA integrity_check').get();
      h.close();
      assert.equal(integrity.integrity_check, 'ok', '库完整性必须为 ok');
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
      assert.ok(fs.existsSync(dbPath(ws)),
        '省略 workspace 时状态应落在进程 cwd 下（这正是必须显式传参的原因）');
    } finally { rmWorkspace(ws); }
  });
});
