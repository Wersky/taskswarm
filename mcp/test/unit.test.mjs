/**
 * 存储层校验分支的单元级测试（直连 core.mjs，不开子进程）。
 *
 * 为什么存在：黑盒测试（spawn server）覆盖「并发/恢复」这类只有跨进程才成立的保证；
 * 而纯校验分支（参数类型、形状校验、归一化错误路径）没有并发语义，直接调用
 * 既有价值函数就能精确打中分支，比黑盒便宜得多。Store 的打开/关闭在单进程内
 * 用临时工作区完成，互不影响。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, workspaceOf, staleMinutes } from '../core.mjs';
import { makeWorkspace, rmWorkspace } from './helpers.mjs';

describe('参数校验分支（直连 core）', () => {
  const origEnv = { ...process.env };

  after(() => { process.env = origEnv; });

  test('workspaceOf：非字符串拒绝、空串归一为 cwd 兜底', () => {
    for (const bad of [123, { a: 1 }, ['x'], true, 42]) {
      assert.throws(() => workspaceOf({ workspace: bad }), /workspace 必须是字符串/);
    }
    assert.equal(workspaceOf(undefined), '');
    assert.equal(workspaceOf({}), '');
    assert.equal(workspaceOf({ workspace: '' }), '');
    assert.equal(workspaceOf({ workspace: '  /tmp/x  ' }), '/tmp/x');
  });

  test('staleMinutes：非法值回退 30，0 表示禁用，小数与上限可用', () => {
    process.env.TASKSWARM_STALE_MINUTES = 'abc';
    assert.equal(staleMinutes(), 30);
    process.env.TASKSWARM_STALE_MINUTES = '-1';
    assert.equal(staleMinutes(), 30);
    process.env.TASKSWARM_STALE_MINUTES = '99999999';
    assert.equal(staleMinutes(), 30);
    process.env.TASKSWARM_STALE_MINUTES = '0';
    assert.equal(staleMinutes(), 0);
    process.env.TASKSWARM_STALE_MINUTES = '0.05';
    assert.equal(staleMinutes(), 0.05);
    process.env.TASKSWARM_STALE_MINUTES = '';
    assert.equal(staleMinutes(), 30);
  });

  test('task_claim / task_notes 对非字符串 taskId 拒绝而非内部异常', () => {
    const ws = makeWorkspace('unit-str');
    let store;
    try {
      store = Store.for({ workspace: ws });
      store.planCreate({ goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      assert.throws(() => store.taskClaim({ taskId: 42, owner: 'w1' }), /taskId 必须是字符串/);
      assert.throws(() => store.taskNotes({ taskId: ['a'] }), /taskId 必须是字符串/);
      assert.throws(() => store.taskClaim({ taskId: 'a', owner: { x: 1 } }), /owner 必须是字符串/);
    } finally { rmWorkspace(ws); }
  });

  test('state save：形状校验的三类坏输入都被点名拒绝', () => {
    const ws = makeWorkspace('unit-shape');
    let store;
    try {
      store = Store.for({ workspace: ws });
      assert.throws(() => store.stateTool({ op: 'save', state: null }), /需要提供 state 对象/);
      assert.throws(() => store.stateTool({ op: 'save', state: [] }), /需要提供 state 对象/);
      assert.throws(() => store.stateTool({ op: 'save', state: { phase: 'swarming' } }), /order（任务顺序数组）/);
      assert.throws(() => store.stateTool({ op: 'save', state: { phase: 'swarming', order: [], tasks: [] } }), /tasks（任务表对象）/);
      assert.throws(() => store.stateTool({ op: 'save', state: { phase: 'swarming', order: [], tasks: {}, log: 'x' } }), /log（事件数组）/);
    } finally { rmWorkspace(ws); }
  });

  test('dependsOn：非数组、危险键名、自依赖都在建节点时被拒', () => {
    const ws = makeWorkspace('unit-deps');
    let store;
    try {
      store = Store.for({ workspace: ws });
      store.planCreate({ goal: 'g', tasks: [{ id: 'a', title: 'A' }] });
      assert.throws(() => store.taskAdd({ title: 'x', dependsOn: 'a' }), /dependsOn 必须是字符串数组/);
      assert.throws(() => store.taskAdd({ title: 'x', dependsOn: [42] }), /元素必须是字符串/);
      assert.throws(() => store.taskAdd({ title: 'x', dependsOn: ['__proto__'] }), /保留的危险键名/);
      assert.throws(() => store.taskAdd({ id: 'b', title: 'x', dependsOn: ['b'] }), /依赖自身/);
      assert.throws(() => store.taskAdd({ title: 'x', dependsOn: ['不存在'] }), /依赖了不存在的任务/);
    } finally { rmWorkspace(ws); }
  });

  test('Store.for：同一 workspace 复用实例，不同 workspace 各自独立', () => {
    const ws1 = makeWorkspace('unit-for1');
    const ws2 = makeWorkspace('unit-for2');
    try {
      const s1a = Store.for({ workspace: ws1 });
      const s1b = Store.for({ workspace: path.join(ws1) });
      assert.equal(s1a, s1b, '同工作区（路径归一后）必须复用同一实例');
      const s2 = Store.for({ workspace: ws2 });
      assert.notEqual(s1a, s2, '不同工作区不能共享实例');
      s1a.planCreate({ goal: 'g1', tasks: [{ id: 'a', title: 'A' }] });
      assert.equal(s2.load(), null, '另一个工作区不受影响');
    } finally { rmWorkspace(ws1); rmWorkspace(ws2); }
  });

  test('跨 workspace 的库文件互相隔离（文件路径不同）', () => {
    const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-iso1-'));
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-iso2-'));
    try {
      const s1 = Store.for({ workspace: ws1 });
      const s2 = Store.for({ workspace: ws2 });
      s1.planCreate({ goal: 'g1', tasks: [{ id: 'a', title: 'A' }] });
      s2.planCreate({ goal: 'g2', tasks: [{ id: 'b', title: 'B' }] });
      assert.equal(s1.load().goal, 'g1');
      assert.equal(s2.load().goal, 'g2');
      s1.close();
      s2.close();
    } finally { rmWorkspace(ws1); rmWorkspace(ws2); }
  });
});
