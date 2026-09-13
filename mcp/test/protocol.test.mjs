/**
 * 协议层与入参校验测试。
 *
 * 说明：原 mcp/test.mjs 用自制 check() 且有一条恒真断言
 * （`!bdFiltered.view.includes('实现后端 API') || bdFiltered.view.includes('agent-1')`
 *  ——后半句永远为真，过滤功能整个失效也会通过）。本文件用 assert 重写为真会失败的断言。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

describe('协议层', () => {
  let c, ws;
  before(() => { c = connect(); ws = makeWorkspace('proto'); });
  after(() => { c.kill(); rmWorkspace(ws); });

  test('initialize 返回 serverInfo 与协议版本', async () => {
    const res = await c.rpc('initialize', {});
    assert.equal(res.result.serverInfo.name, 'taskswarm');
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.ok(res.result.capabilities.tools);
  });

  test('serverInfo.version 与 manifest 一致（防止版本漂移）', async () => {
    const res = await c.rpc('initialize', {});
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(path.resolve(here, '..', '..', '.zcode-plugin', 'plugin.json'), 'utf8'));
    assert.equal(res.result.serverInfo.version, manifest.version,
      'server.mjs 里的版本号必须与 plugin.json 一致，否则升级时会漏改');
  });

  test('tools/list 返回 11 个工具，且都带 inputSchema', async () => {
    const res = await c.rpc('tools/list', {});
    const names = res.result.tools.map(t => t.name).sort();
    assert.equal(res.result.tools.length, 11);
    assert.deepEqual(names, [
      'board', 'plan_create', 'plan_get', 'plan_reset', 'state',
      'task_add', 'task_claim', 'task_notes', 'task_ready', 'task_review', 'task_update',
    ]);
    for (const t of res.result.tools) {
      assert.equal(t.inputSchema.type, 'object', `${t.name} 缺少 inputSchema`);
    }
  });

  test('ping 有响应', async () => {
    const res = await c.rpc('ping', {});
    assert.ok(res.result !== undefined);
  });

  test('未知方法返回错误而非崩溃', async () => {
    const res = await c.rpc('不存在的/方法', {});
    assert.ok(res.error, '应返回 JSON-RPC error');
    assert.match(res.error.message, /未知方法/);
  });

  test('未知工具返回工具级错误而非崩溃', async () => {
    const r = await c.callRaw('不存在的工具', {});
    assert.equal(r.ok, false);
    assert.match(r.error, /未知工具/);
  });

  test('收到非法 JSON 行后仍能继续服务（不崩）', async () => {
    c.raw('这不是 JSON\n');
    c.raw('{"jsonrpc":"2.0"\n');   // 截断的 JSON
    const res = await c.rpc('ping', {});
    assert.ok(res.result !== undefined, '非法输入后 server 应仍然存活');
  });

  test('无进行中计划时，plan_get/task_ready 给出可行动的中文错误', async () => {
    const empty = makeWorkspace('no-plan');
    try {
      const g = await c.callRaw('plan_get', { workspace: empty });
      assert.equal(g.ok, false);
      assert.match(g.error, /plan_create/, '错误应告诉调用方下一步做什么');
    } finally { rmWorkspace(empty); }
  });
});

describe('plan_create 校验路径', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  const newWs = () => makeWorkspace('plan');

  test('正常创建：任务树、依赖、视图', async () => {
    const ws = newWs();
    try {
      const plan = await c.call('plan_create', {
        workspace: ws, goal: '搭建博客',
        tasks: [
          { id: 'design', title: '设计', subtasks: [{ id: 'palette', title: '配色' }] },
          { id: 'api', title: '后端', dependsOn: ['design'] },
          { id: 'deploy', title: '部署', dependsOn: ['api', 'design'] },
        ],
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.taskCount, 4);
      assert.match(plan.plan, /依赖: api, design/);
    } finally { rmWorkspace(ws); }
  });

  test('goal 为空被拒', async () => {
    const ws = newWs();
    try {
      const r = await c.callRaw('plan_create', { workspace: ws, goal: '   ', tasks: [{ title: 'a' }] });
      assert.equal(r.ok, false);
      assert.match(r.error, /goal/);
    } finally { rmWorkspace(ws); }
  });

  test('tasks 为空或非数组被拒', async () => {
    const ws = newWs();
    try {
      assert.equal((await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [] })).ok, false);
      assert.equal((await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: 'x' })).ok, false);
    } finally { rmWorkspace(ws); }
  });

  test('任务缺 title 被拒', async () => {
    const ws = newWs();
    try {
      const r = await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a' }] });
      assert.equal(r.ok, false);
      assert.match(r.error, /title/);
    } finally { rmWorkspace(ws); }
  });

  test('依赖成环被拒', async () => {
    const ws = newWs();
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }],
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /环/);
    } finally { rmWorkspace(ws); }
  });

  test('依赖不存在的任务被拒', async () => {
    const ws = newWs();
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'a', title: 'A', dependsOn: ['幽灵'] }],
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /不存在/);
    } finally { rmWorkspace(ws); }
  });

  test('自依赖被拒', async () => {
    const ws = newWs();
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', dependsOn: ['a'] }],
      });
      assert.equal(r.ok, false);
    } finally { rmWorkspace(ws); }
  });

  test('重复 id 被拒（错误信息说明是自动编号冲突并给出改法）', async () => {
    const ws = newWs();
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g', tasks: [{ id: 'dup', title: 'A' }, { id: 'dup', title: 'B' }],
      });
      assert.equal(r.ok, false);
      // 实现比「重复」更具体：说明是显式 id 与前序任务冲突，并给出改名建议
      assert.match(r.error, /冲突|重复|已存在/);
      assert.match(r.error, /下一步|改写|指定/, '错误应给出可行动的改法');
    } finally { rmWorkspace(ws); }
  });
});

describe('任务 id 安全校验', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  // 这些 id 曾导致真实缺陷：__proto__ 会让任务在落盘后凭空消失
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    test(`危险 id "${bad}" 被显式拒绝（原型污染防护）`, async () => {
      const ws = makeWorkspace('id');
      try {
        const r = await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: bad, title: 'x' }] });
        assert.equal(r.ok, false, `${bad} 必须被拒绝`);
        assert.match(r.error, /危险|保留|原型/, '错误信息应说明原因');
      } finally { rmWorkspace(ws); }
    });
  }

  for (const [label, bad] of [['含空格', 'a b'], ['含中文', '设计'], ['以短横线开头', '-abc'], ['含斜杠', 'a/b'], ['超长(65)', 'a'.repeat(65)]]) {
    test(`非法 id（${label}）被拒绝且错误可读`, async () => {
      const ws = makeWorkspace('id2');
      try {
        const r = await c.callRaw('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: bad, title: 'x' }] });
        assert.equal(r.ok, false, `${label} 应被拒绝`);
        assert.ok(String(r.error).length > 10, '错误信息应可读并给出下一步');
      } finally { rmWorkspace(ws); }
    });
  }

  test('空 id 走自动编号（语义：未指定 id），并产生合法 id', async () => {
    const ws = makeWorkspace('id4');
    try {
      const r = await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: '', title: '空 id 当作未指定' }, { title: '本来就没写 id' }],
      });
      assert.equal(r.ok, true, '空串 id 应被当作未指定并自动编号，而不是报错');
      assert.equal(r.taskCount, 2);
      // 自动编号产生的 id 必须符合 id 规则
      assert.match(r.plan, /\[T\d+\]/);
    } finally { rmWorkspace(ws); }
  });

  test('合法 id 字符集被接受', async () => {
    const ws = makeWorkspace('id3');
    try {
      const ok = await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'T1', title: 'A' }, { id: 'b_c-2.x', title: 'B' }, { id: '9', title: 'C' }],
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.taskCount, 3);
    } finally { rmWorkspace(ws); }
  });
});

describe('subtasks 多级展开与深度上限', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('三级嵌套不再被静默丢弃（旧实现只展开两层）', async () => {
    const ws = makeWorkspace('deep');
    try {
      const r = await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'a', title: '一级', subtasks: [{ id: 'b', title: '二级', subtasks: [{ id: 'c', title: '三级' }] }] }],
      });
      assert.equal(r.taskCount, 3, '三级子任务必须被创建');
      assert.match(r.plan, /\[c\]/);
    } finally { rmWorkspace(ws); }
  });

  test('五层是允许的上限', async () => {
    const ws = makeWorkspace('deep5');
    try {
      const r = await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'a', title: '1', subtasks: [{ id: 'b', title: '2', subtasks: [{ id: 'c', title: '3', subtasks: [{ id: 'd', title: '4', subtasks: [{ id: 'e', title: '5' }] }] }] }] }],
      });
      assert.equal(r.taskCount, 5);
    } finally { rmWorkspace(ws); }
  });

  test('第六层被拒绝且错误说明如何规避', async () => {
    const ws = makeWorkspace('deep6');
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'a', title: '1', subtasks: [{ id: 'b', title: '2', subtasks: [{ id: 'c', title: '3', subtasks: [{ id: 'd', title: '4', subtasks: [{ id: 'e', title: '5', subtasks: [{ id: 'f', title: '6' }] }] }] }] }] }],
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /深度|上限|5/);
    } finally { rmWorkspace(ws); }
  });

  test('显式 id 与自动编号不冲突时共存（自动编号跳过已占用槽位）', async () => {
    const ws = makeWorkspace('autoid');
    try {
      const r = await c.call('plan_create', {
        workspace: ws, goal: 'g', tasks: [{ id: 'T1', title: '手写 T1' }, { title: '不写 id' }],
      });
      // 实现语义：自动编号会跳过被显式占用的 T1，因此两个任务都能创建且 id 唯一
      assert.equal(r.ok, true, '显式 id 与自动编号应能共存，不该整个计划失败');
      assert.equal(r.taskCount, 2);
      const mirrored = r.plan.match(/\[T(\d+)\]/g) ?? [];
      assert.equal(new Set(mirrored).size, mirrored.length, 'id 必须唯一');
    } finally { rmWorkspace(ws); }
  });

  test('两个任务显式用同一个 id 时，错误说明冲突并可行动', async () => {
    const ws = makeWorkspace('autoid2');
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g', tasks: [{ id: 'T1', title: 'A' }, { id: 'T1', title: 'B' }],
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /冲突|已存在|重复/);
    } finally { rmWorkspace(ws); }
  });
});

describe('state 工具', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  test('save/load/clear 生命周期', async () => {
    const ws = makeWorkspace('state');
    try {
      await c.call('plan_create', { workspace: ws, goal: '目标X', tasks: [{ id: 'a', title: 'A' }] });
      const loaded = await c.call('state', { workspace: ws, op: 'load' });
      assert.equal(loaded.exists, true);
      assert.equal(loaded.state.goal, '目标X');

      const cleared = await c.call('state', { workspace: ws, op: 'clear' });
      assert.equal(cleared.ok, true);

      const board = await c.call('board', { workspace: ws });
      assert.equal(board.active, false);
    } finally { rmWorkspace(ws); }
  });

  test('结构不完整的 state 被拒绝（避免污染后续读取）', async () => {
    const ws = makeWorkspace('state2');
    try {
      const r = await c.callRaw('state', { workspace: ws, op: 'save', state: { phase: 'swarming' } });
      assert.equal(r.ok, false, '缺 tasks/order/log 的 state 不应被接受');
    } finally { rmWorkspace(ws); }
  });
});
