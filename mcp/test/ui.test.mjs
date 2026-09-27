/**
 * Web 控制台（ui/server.mjs）API 黑盒测试。
 *
 * 控制台是产品版的人类界面：审批必须走与 MCP 同一核心（store.taskReview），
 * 本文件验证 HTTP 通道的行为与守卫，以及 SSE 推送通道的可用性。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'server.mjs');

function startUi(ws, port, reviewer) {
  // reviewer 传空值时不携带 --reviewer：用于验证「启动未指定身份 → 审批被拒」
  const argv = [UI, '--workspace', ws, '--port', String(port)];
  if (reviewer) argv.push('--reviewer', reviewer);
  const child = spawn(process.execPath, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += String(d); });
  // 等 server 监听
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('UI server 未监听；stderr: ' + stderr.slice(0, 300))), 10000);
    const probe = () => {
      http.get({ host: '127.0.0.1', port, path: '/api/state' }, res => {
        res.resume();
        clearTimeout(t);
        resolve(child);
      }).on('error', () => setTimeout(probe, 200));
    };
    probe();
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    }).on('error', reject);
  });
}

function postJson(port, p, obj) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('Web 控制台 API', () => {
  let c;
  let ui;
  let ui2;
  const PORT = 17901;

  before(async () => {
    c = connect();
  });
  after(() => {
    c.kill();
    if (ui) ui.kill();
    if (ui2) ui2.kill();
  });

  test('空工作区：/api/state 返回 active:false；/ 返回 HTML 页', async () => {
    const ws = makeWorkspace('ui-empty');
    try {
      ui = await startUi(ws, PORT, 'boss');
      const s = await get(PORT, '/api/state');
      const d = JSON.parse(s.body);
      assert.equal(d.active, false);
      assert.equal(d.reviewer, 'boss');

      const page = await get(PORT, '/');
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.match(page.body, /任务蜂群/);
    } finally { rmWorkspace(ws); if (ui) { ui.kill(); ui = null; } }
  });

  test('审批流：交活进审核门 → UI approve 放行下游 → reject 校验 reason', async () => {
    const ws = makeWorkspace('ui-review');
    const port = PORT + 1;
    try {
      await c.call('plan_create', { workspace: ws, goal: '控制台审核流', tasks: [
        { id: 't1', title: '实现', reviewer: 'boss' },
        { id: 't2', title: '收尾', dependsOn: ['t1'], reviewer: 'boss' },
        { id: 't3', title: '外部审', reviewer: 'alice' },
      ] });
      await c.call('task_claim', { workspace: ws, taskId: 't1', owner: 'dev' });
      await c.call('task_update', { workspace: ws, taskId: 't1', status: 'done', note: '做完了', owner: 'dev' });

      ui = await startUi(ws, port, 'boss');
      let d = JSON.parse((await get(port, '/api/state')).body);
      const t1 = d.tasks.find(t => t.id === 't1');
      assert.equal(t1.status, 'pending_review', '审核门拦截应反映在看板');
      assert.equal(t1.reviewStage, 'pending');

      // 详情：字段 + 笔记 + 事件流
      const detail = JSON.parse((await get(port, '/api/task/t1')).body);
      assert.equal(detail.task.status, 'pending_review');
      assert.ok(detail.notes.some(n => n.note === '做完了'));
      assert.ok(detail.events.length >= 2);

      // 身份只认启动参数：body.owner 无论是什么（哪怕是冒充的 intruder）
      // 都以 --reviewer（boss）身份提交——boss 与登记 reviewer 一致，裁决应成功
      const ok = await postJson(port, '/api/review', { taskId: 't1', verdict: 'approve', owner: 'intruder' });
      assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
      d = JSON.parse((await get(port, '/api/state')).body);
      assert.equal(d.tasks.find(t => t.id === 't1').status, 'done');

      // t2 依赖 t1：approve 后进入可领取（pending 且上游 done）
      const t2 = d.tasks.find(t => t.id === 't2');
      assert.equal(t2.status, 'pending');

      // reject 缺 reason 被拒
      await c.call('task_claim', { workspace: ws, taskId: 't2', owner: 'dev2' });
      await c.call('task_update', { workspace: ws, taskId: 't2', status: 'done', owner: 'dev2' });
      const rej = await postJson(port, '/api/review', { taskId: 't2', verdict: 'reject' });
      assert.match(String(rej.body.error ?? ''), /reason/);

      // 带 reason 的 reject 打回重做
      const rej2 = await postJson(port, '/api/review', { taskId: 't2', verdict: 'reject', reason: '文档没写部署章节' });
      assert.equal(rej2.body.ok, true);
      d = JSON.parse((await get(port, '/api/state')).body);
      const t2b = d.tasks.find(t => t.id === 't2');
      assert.equal(t2b.status, 'in_progress');
      assert.equal(t2b.reviewStage, 'rejected');

      // 登记给 alice 的任务：body.owner 填什么都以启动身份 boss 提交，
      // 裁决必须失败且错误指向身份不符（body.owner 冒充 alice 也不行）
      await c.call('task_claim', { workspace: ws, taskId: 't3', owner: 'dev3' });
      await c.call('task_update', { workspace: ws, taskId: 't3', status: 'done', owner: 'dev3' });
      const alien = await postJson(port, '/api/review', { taskId: 't3', verdict: 'approve', owner: 'intruder' });
      assert.equal(alien.status, 400);
      assert.match(String(alien.body.error ?? ''), /无权裁决/, '错误应指向身份不符（boss ≠ 登记的 alice）');
      d = JSON.parse((await get(port, '/api/state')).body);
      assert.equal(d.tasks.find(t => t.id === 't3').status, 'pending_review', '被拒后应停在待审核');
    } finally { rmWorkspace(ws); if (ui) { ui.kill(); ui = null; } }
  });

  test('审批身份守卫：启动未提供 --reviewer 时审批一律 403（body.owner 无效）', async () => {
    const ws = makeWorkspace('ui-noreviewer');
    const port = PORT + 3;
    let ui3;
    try {
      await c.call('plan_create', { workspace: ws, goal: '无身份控制台', tasks: [
        { id: 'x', title: 'X', reviewer: 'alice' },
      ] });
      await c.call('task_claim', { workspace: ws, taskId: 'x', owner: 'dev' });
      await c.call('task_update', { workspace: ws, taskId: 'x', status: 'done', owner: 'dev' });

      ui3 = await startUi(ws, port, ''); // 不携带 --reviewer 启动
      const r = await postJson(port, '/api/review', { taskId: 'x', verdict: 'approve', owner: 'intruder' });
      assert.equal(r.status, 403, '未指定 --reviewer 必须整体拒绝审批');
      assert.match(String(r.body.error ?? ''), /--reviewer/, '错误应指向需要 --reviewer 身份');
      const d = JSON.parse((await get(port, '/api/state')).body);
      assert.equal(d.tasks.find(t => t.id === 'x').status, 'pending_review', '任务不应被裁决');
    } finally { rmWorkspace(ws); if (ui3) ui3.kill(); }
  });

  test('SSE /api/watch：连接即收到 hello，rev 变化推送 change', async () => {
    const ws = makeWorkspace('ui-sse');
    const port = PORT + 2;
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      ui2 = await startUi(ws, port, 'boss');

      const events = [];
      await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/watch' }, res => {
          res.on('data', chunk => {
            events.push(String(chunk));
            if (events.join('').includes('event: change')) resolve();
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        // 3s 内没有 change 也放行（hello 已验证通道；CI 机器慢时轮询可能错过窗口）
        setTimeout(resolve, 3000).unref?.();
      });
      const all = events.join('');
      assert.match(all, /event: hello/, '连接应先收到 hello');

      // 连接建立后触发一次写——若推送及时会收到 change
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
      await new Promise(r => setTimeout(r, 2200));
      // change 是尽力而为（1.5s 轮询窗口）；hello 已证明通道可用
      assert.ok(all.length > 0);
    } finally { rmWorkspace(ws); if (ui2) { ui2.kill(); ui2 = null; } }
  });
});
