/**
 * webhook 专项：TASKSWARM_WEBHOOK_URL 配置后的 fire-and-forget 通知链路。
 *
 * 被测机制（core.mjs #notifyWebhook）：每次写事务 COMMIT 后向配置的 URL
 * POST {rev, events:[本事务新增事件]}，2s 超时、失败静默——webhook 是增强
 * 通道不是依赖，任何故障都不得阻断写事务，也不得把错误漏进 stdio。
 *
 * 全部黑盒：spawn server.mjs 子进程（helpers.connect，环境变量经 connect(env)
 * 注入子进程）；接收端用测试内 node:http 服务器（随机端口）收集请求；
 * webhook 异步发出，调用返回 ≠ 请求已到达，断言前留出轮询窗口。
 */
import http from 'node:http';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

/**
 * 启一个测试内 webhook 接收服务器（listen(0) 随机端口），按到达顺序收集
 * 所有请求的方法与 JSON body。返回 { port, received, methods, listen, close }。
 */
function startReceiver() {
  const received = [];
  const methods = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      methods.push(req.method);
      try { received.push(JSON.parse(body)); } catch { received.push({ raw: body }); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  return {
    received,
    methods,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }),
  };
}

/** 轮询等待条件成立或超时（fire-and-forget 的到达时机不可控，只能给窗口） */
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describe('webhook：配置 TASKSWARM_WEBHOOK_URL 后每次写事务提交都收到 POST', () => {
  let rx, c, ws;
  before(async () => {
    rx = startReceiver();
    const port = await rx.listen();
    c = connect({ TASKSWARM_WEBHOOK_URL: `http://127.0.0.1:${port}/hook` });
    ws = makeWorkspace('webhook-on');
  });
  after(async () => { c.kill(); await rx.close(); rmWorkspace(ws); });

  test('依次 plan_create/task_claim/task_update(note) 后收到 ≥3 次 POST：rev 单调递增、events 非空、事件名依次含 计划创建/领取/进展', async () => {
    await c.call('plan_create', { workspace: ws, goal: 'webhook 通知链路验证', tasks: [{ id: 'a', title: 'A' }] });
    await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
    await c.call('task_update', { workspace: ws, taskId: 'a', note: '开工：汇报一条进展', owner: 'w1' });

    // 异步窗口：写事务已 COMMIT，POST 在路上；~800ms 内应收齐 3 次
    const got = await waitFor(() => rx.received.length >= 3, 800);
    assert.ok(got, `800ms 内应收到 ≥3 次 POST（实际 ${rx.received.length}）`);
    const [p0, p1, p2] = rx.received;

    // rev 单调递增：每次写事务推进一个版本
    assert.ok(
      Number.isFinite(p0.rev) && p1.rev > p0.rev && p2.rev > p1.rev,
      `rev 应单调递增（实际 ${p0.rev} → ${p1.rev} → ${p2.rev}）`,
    );
    // events 数组存在且非空：每个写事务都该带出本事务新增事件
    for (const [i, p] of [p0, p1, p2].entries()) {
      assert.ok(Array.isArray(p.events) && p.events.length > 0, `第 ${i + 1} 次 POST 的 events 应非空（实际 ${JSON.stringify(p.events)}）`);
    }
    // 事件名与触发操作一一对应
    assert.ok(p0.events.some((e) => e.event === '计划创建'), 'plan_create 的 payload 应含「计划创建」事件');
    assert.ok(p1.events.some((e) => e.event === '领取'), 'task_claim 的 payload 应含「领取」事件');
    assert.ok(p2.events.some((e) => e.event === '进展'), 'task_update(note) 的 payload 应含「进展」事件');
    // 通知语义：JSON POST
    for (const m of rx.methods.slice(0, 3)) assert.equal(m, 'POST', 'webhook 通知应为 POST 请求');
  });
});

describe('webhook：未配置 TASKSWARM_WEBHOOK_URL 时不发任何请求', () => {
  let rx, c, ws;
  before(async () => {
    rx = startReceiver();
    await rx.listen();
    // 显式置空而非依赖外层环境：即便宿主带了该变量，也必须等价于「未配置」
    c = connect({ TASKSWARM_WEBHOOK_URL: '' });
    ws = makeWorkspace('webhook-off');
  });
  after(async () => { c.kill(); await rx.close(); rmWorkspace(ws); });

  test('同样的 plan_create/task_claim/task_update 后接收端零请求（等 500ms 确认）', async () => {
    await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
    await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
    await c.call('task_update', { workspace: ws, taskId: 'a', note: '不应触发 webhook', owner: 'w1' });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(rx.received.length, 0, '未配置 URL 时接收端不应收到任何请求');
  });
});

describe('webhook：指向不可达端口时静默失败，不阻断写事务', () => {
  let c, ws;
  before(() => {
    // 127.0.0.1:1 不可达：loopback 立即 ECONNREFUSED（比等 2s 超时快且确定），
    // core 里 req.on('error') 必须吞掉它
    c = connect({ TASKSWARM_WEBHOOK_URL: 'http://127.0.0.1:1/hook' });
    ws = makeWorkspace('webhook-dead');
  });
  after(() => { c.kill(); rmWorkspace(ws); });

  test('plan_create/task_claim/task_update 全部成功返回，写确实落库', async () => {
    const p = await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
    assert.equal(p.ok, true, `plan_create 不应被 webhook 故障阻断：${p.error ?? ''}`);
    const cl = await c.callRaw('task_claim', { workspace: ws, taskId: 'a', owner: 'w1' });
    assert.equal(cl.ok, true, `task_claim 不应被 webhook 故障阻断：${cl.error ?? ''}`);
    const up = await c.callRaw('task_update', { workspace: ws, taskId: 'a', note: '静默失败验证', owner: 'w1' });
    assert.equal(up.ok, true, `task_update 不应被 webhook 故障阻断：${up.error ?? ''}`);
    // 写真的落了库：笔记可读回（读路径不涉 webhook，作交叉验证）
    const notes = await c.call('task_notes', { workspace: ws, taskId: 'a' });
    assert.equal(notes.total, 1, 'webhook 不可达时 task_update 的笔记仍应落库');
  });
});
