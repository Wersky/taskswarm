/**
 * 采纳提案（task_review 的 proposals 参数）专项测试。
 *
 * 闭环语义：审核者发现问题时，可以在裁决的同时提出新计划项；
 * approve 时这些项被直接加进任务树（「发现问题 → 提建议 → 审核通过 → 自动纳入计划」）。
 *
 * 这里刻意覆盖两件最容易做错的事：
 *   1. reject 绝不能也把 proposals 加进树（驳回夹带新任务 = 静默篡改计划）；
 *   2. 采纳是原子的（任一项不合法 → 整批不加，不留半批）。
 * 以及 assignee 的定位：**建议**执行者，只作提示，不得影响 task_claim 的领取权限。
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

describe('task_review 采纳提案（proposals）', () => {
  let c;
  before(() => { c = connect(); });
  after(() => c.kill());

  /**
   * 建一个「待审核」现场：producer 交了活、停在 pending_review，等 reviewer 裁决。
   * 返回 workspace，调用方负责在 finally 里 rmWorkspace。
   */
  async function pendingReviewScene(label, tasks) {
    const ws = makeWorkspace(label);
    await c.call('plan_create', {
      workspace: ws, goal: 'g',
      tasks: tasks ?? [{ id: 'a', title: '生产者任务', role: 'producer', reviewer: 'wersky/agent-3' }],
    });
    await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'agent-1' });
    const done = await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'agent-1' });
    assert.equal(done.task.status, 'pending_review', '前置条件：置 done 应被改道为待审核');
    return ws;
  }

  /** 直接读状态文件里的任务表（绕过视图，验证「到底进没进树」） */
  async function stateOf(ws) {
    const s = await c.call('state', { workspace: ws, op: 'load' });
    return s.state;
  }

  test('a) approve + proposals：任务进树，role/reviewer/assignee/dependsOn 正确落地', async () => {
    const ws = await pendingReviewScene('adopt-a');
    try {
      const r = await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [
          {
            id: 'fix-race', title: '补并发回归测试', detail: '覆盖双进程抢同一任务',
            dependsOn: ['a'], parentId: 'a',
            role: 'producer', reviewer: 'wersky/agent-9', assignee: 'wersky/agent-4',
          },
        ],
      });

      // 返回值：adopted 明确报出纳入了什么
      assert.equal(r.adopted.count, 1, '应采纳 1 条');
      assert.deepEqual(r.adopted.ids, ['fix-race'], 'adopted.ids 应为显式 id');
      assert.match(r.hint, /采纳 1 条提案/, 'hint 应告知已采纳');
      assert.match(r.hint, /fix-race/);

      // 状态文件：字段逐个落地
      const st = await stateOf(ws);
      const t = st.tasks['fix-race'];
      assert.ok(t, '提案任务应真的进树');
      assert.equal(t.title, '补并发回归测试');
      assert.equal(t.detail, '覆盖双进程抢同一任务');
      assert.equal(t.role, 'producer');
      assert.equal(t.reviewer, 'wersky/agent-9');
      assert.equal(t.assignee, 'wersky/agent-4');
      assert.deepEqual(t.dependsOn, ['a']);
      assert.equal(t.parent, 'a', 'parentId 应生效');
      assert.equal(t.status, 'pending');
      assert.ok(st.order.includes('fix-race'), 'order 应含新任务');
      assert.ok(st.tasks['a'].children.includes('fix-race'), '父子关系应建立');

      // 审核日志：采纳事件带上新增 id
      const adoptLog = st.log.filter(e => e.event === '采纳提案');
      assert.equal(adoptLog.length, 1, '应写一条「采纳提案」log');
      assert.match(adoptLog[0].detail, /fix-race/);
      assert.equal(adoptLog[0].taskId, 'a', 'log 应归属被审核的任务');
    } finally { rmWorkspace(ws); }
  });

  test('b) reject + proposals：任务绝不进树（驳回不得夹带新任务）', async () => {
    const ws = await pendingReviewScene('adopt-b');
    try {
      const before = await stateOf(ws);
      const orderBefore = before.order.slice();

      const r = await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'reject', owner: 'wersky/agent-3',
        reason: '并发用例没覆盖 Windows 的 EPERM 重试',
        proposals: [{ id: 'sneaky', title: '驳回时夹带的任务', role: 'producer' }],
      });

      assert.deepEqual(r.adopted, { count: 0, ids: [] }, '驳回时 adopted 必须为空');

      const after = await stateOf(ws);
      assert.equal(after.tasks['sneaky'], undefined, '驳回时提案绝不能进树');
      assert.deepEqual(after.order, orderBefore, '任务顺序不应有任何变化');
      assert.equal(after.log.filter(e => e.event === '采纳提案').length, 0, '不应写采纳日志');
      // 驳回本身仍然生效
      assert.equal(after.tasks['a'].reviewStage, 'rejected');
      assert.equal(after.tasks['a'].status, 'in_progress');
    } finally { rmWorkspace(ws); }
  });

  test('b2) reject 时连「格式错误的 proposals」也一并忽略（不是只忽略合法项）', async () => {
    const ws = await pendingReviewScene('adopt-b2');
    try {
      // 这些值在 approve 分支下会直接报错；reject 分支根本不读 proposals，因此仍应裁决成功。
      // 语义上必须如此：「完全忽略」意味着驳回路径不受 proposals 影响。
      for (const bad of ['不是数组', [{ detail: '缺 title' }], [{ title: 'x', role: 'boss' }], null]) {
        // 上一轮 reject 会把任务打回 in_progress；此时需重新交活才能再次裁决
        // （已是 pending_review 时再置 done 属无效转移，故先看状态）
        const cur = await stateOf(ws);
        if (cur.tasks['a'].status !== 'pending_review') {
          await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'agent-1' });
        }
        const r = await c.call('task_review', {
          workspace: ws, taskId: 'a', verdict: 'reject', owner: 'wersky/agent-3',
          reason: '重做', proposals: bad,
        });
        assert.deepEqual(r.adopted, { count: 0, ids: [] }, `proposals=${JSON.stringify(bad)} 时不应采纳`);
        assert.equal(r.task.status, 'in_progress');
      }
      const st = await stateOf(ws);
      assert.deepEqual(st.order, ['a'], '任何情况下都不应留下新任务');
      assert.equal(st.log.filter(e => e.event === '采纳提案').length, 0);
    } finally { rmWorkspace(ws); }
  });

  test('c) proposals 依赖不存在的任务 → 报错且整批都不加（原子性）', async () => {
    const ws = await pendingReviewScene('adopt-c');
    try {
      const before = await stateOf(ws);
      const orderBefore = before.order.slice();

      const r = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [
          { id: 'p1', title: '合法的一条', role: 'producer' },
          { id: 'p2', title: '依赖不存在的一条', dependsOn: ['没这个任务'] },
          { id: 'p3', title: '也合法的一条' },
        ],
      });
      assert.equal(r.ok, false, '应报错');
      assert.match(r.error, /proposals\[1\]/, '错误应指出是第 2 项（下标 1）');
      assert.match(r.error, /不存在/, '错误应说明依赖不存在');

      // 关键：整批不加 —— p1 也不能进树
      const after = await stateOf(ws);
      assert.equal(after.tasks['p1'], undefined, '原子性：前面合法的项也不能留下');
      assert.equal(after.tasks['p2'], undefined);
      assert.equal(after.tasks['p3'], undefined);
      assert.deepEqual(after.order, orderBefore, '任务树应完全未被改动');
      assert.equal(after.log.filter(e => e.event === '采纳提案').length, 0);
      // 裁决本身也应回滚（同一临界区内抛错 → 不落盘）
      assert.equal(after.tasks['a'].status, 'pending_review', '报错时审核状态不应被改动');
    } finally { rmWorkspace(ws); }
  });

  test('d) proposals 缺 title / role 非法 → 错误指出第几项与怎么改', async () => {
    const ws = await pendingReviewScene('adopt-d');
    try {
      const noTitle = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ id: 'ok1', title: '好的' }, { id: 'bad', detail: '忘了写标题' }],
      });
      assert.equal(noTitle.ok, false);
      assert.match(noTitle.error, /proposals\[1\]/, '应指出第 2 项（下标 1）');
      assert.match(noTitle.error, /title/, '应指出缺 title');
      assert.match(noTitle.error, /下一步/, '应给出怎么改');

      const badRole = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ title: '位置对了但角色写错了', role: 'boss' }],
      });
      assert.equal(badRole.ok, false);
      assert.match(badRole.error, /proposals\[0\]/, '应指出第 1 项');
      assert.match(badRole.error, /role 非法/, '应指出 role 非法');
      assert.match(badRole.error, /planner|producer|reviewer/, '应列出合法取值');

      // 两项都没进树，且审核仍未通过
      const after = await stateOf(ws);
      assert.equal(after.order.filter(id => id !== 'a').length, 0, '两次尝试都不应留下任务');
      assert.equal(after.tasks['a'].status, 'pending_review');
    } finally { rmWorkspace(ws); }
  });

  test('d2) proposals 元素不是对象 → 报错指出下标；错误前缀不重复堆叠', async () => {
    const ws = await pendingReviewScene('adopt-d2');
    try {
      const notObj = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ title: '好的' }, '我不是对象'],
      });
      assert.equal(notObj.ok, false);
      assert.match(notObj.error, /proposals\[1\]/, '应指出第 2 项');
      assert.match(notObj.error, /必须是对象/, '应说明类型问题');

      // dependsOn 元素的报错自带 proposals[i]，不应再被包一层前缀
      const depType = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ title: '依赖类型错', dependsOn: [123] }],
      });
      assert.equal(depType.ok, false);
      assert.match(depType.error, /proposals\[0\]/);
      assert.ok(!/proposals\[0\].*proposals\[0\]/s.test(depType.error), `错误前缀不应重复堆叠：${depType.error}`);
    } finally { rmWorkspace(ws); }
  });

  test('e) 采纳的任务作为上游参与依赖计算：未完成不就绪，完成后就绪', async () => {
    const ws = await pendingReviewScene('adopt-e');
    try {
      await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ id: 'new-up', title: '新上游', role: 'producer' }],
      });

      // 原有的下游任务 b 尚未存在，用 task_add 造一个依赖 new-up 的
      await c.call('task_add', { workspace: ws, id: 'down', title: '下游', dependsOn: ['new-up'] });

      let ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === 'down'), '新上游未完成时下游不应就绪');
      assert.ok(ready.ready.some(t => t.id === 'new-up'), '新上游自身应就绪');

      // 走完新上游
      await c.call('task_claim', { workspace: ws, taskId: 'new-up', owner: 'agent-7' });
      await c.call('task_update', { workspace: ws, taskId: 'new-up', status: 'done', owner: 'agent-7' });

      ready = await c.call('task_ready', { workspace: ws });
      assert.ok(ready.ready.some(t => t.id === 'down'), '新上游完成后下游应就绪');
    } finally { rmWorkspace(ws); }
  });

  test('f) 采纳的任务带 reviewer → 审核门生效（置 done 被改道 pending_review）', async () => {
    const ws = await pendingReviewScene('adopt-f');
    try {
      await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{
          id: 'gated', title: '需要复审的提案', role: 'producer',
          reviewer: 'wersky/agent-8',
        }],
      });

      await c.call('task_claim', { workspace: ws, taskId: 'gated', owner: 'agent-2' });
      const r = await c.call('task_update', { workspace: ws, taskId: 'gated', status: 'done', owner: 'agent-2' });
      assert.equal(r.task.status, 'pending_review', '采纳任务的审核门应同样生效');

      const st = await stateOf(ws);
      assert.equal(st.tasks['gated'].reviewStage, 'pending');
      assert.equal(st.tasks['gated'].reviewer, 'wersky/agent-8');

      // 且该审核门能正常放行：由登记的 reviewer 裁决
      const ok = await c.call('task_review', { workspace: ws, taskId: 'gated', verdict: 'approve', owner: 'wersky/agent-8' });
      assert.equal(ok.task.status, 'done');
      assert.deepEqual(ok.adopted, { count: 0, ids: [] }, '不传 proposals 时 adopted 恒为空');
    } finally { rmWorkspace(ws); }
  });

  test('g) assignee 出现在 task_ready 与 plan_get 视图', async () => {
    const ws = makeWorkspace('adopt-g');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [
          { id: 'a', title: '直建带建议', assignee: 'wersky/agent-5' },
          { id: 'b', title: 'task_add 带建议' },
        ],
      });
      await c.call('task_add', { workspace: ws, id: 'c', title: '追加带建议', assignee: 'wersky/agent-6', dependsOn: ['a'] });

      // task_ready 结构化字段
      const ready = await c.call('task_ready', { workspace: ws });
      const ra = ready.ready.find(t => t.id === 'a');
      assert.equal(ra.assignee, 'wersky/agent-5', 'task_ready 应带 assignee');
      const rb = ready.ready.find(t => t.id === 'b');
      assert.equal(rb.assignee, undefined, '未指定 assignee 的任务不应带该字段');

      // plan_get 文本视图
      const plan = await c.call('plan_get', { workspace: ws });
      assert.match(plan.view, /→ 建议: wersky\/agent-5/, 'plan_get 视图应显示建议执行者');

      // 赋值不影响领取权限：建议给 agent-5，实际 agent-7 也能领
      const claimed = await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'agent-7' });
      assert.equal(claimed.task.id, 'a', 'assignee 只是提示，不锁领取权');
      const st = await stateOf(ws);
      assert.equal(st.tasks['a'].owner, 'agent-7', 'owner 应由 claim 决定，而非 assignee');
    } finally { rmWorkspace(ws); }
  });

  test('向后兼容：不传 proposals 时行为与以前一致（无 adopted 副作用、无新任务）', async () => {
    const ws = await pendingReviewScene('adopt-compat');
    try {
      const before = await stateOf(ws);
      const r = await c.call('task_review', { workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3' });
      assert.equal(r.task.status, 'done');
      assert.deepEqual(r.adopted, { count: 0, ids: [] }, 'adopted 恒定存在且为空');

      const after = await stateOf(ws);
      assert.equal(after.order.length, before.order.length, '不传 proposals 不应产生任何新任务');
      assert.equal(after.log.filter(e => e.event === '采纳提案').length, 0);
      // 旧任务缺 assignee 字段时按 null 语义读：不应凭空出现字符串
      assert.equal(after.tasks['a'].assignee, null, '未指定 assignee 应落为 null');
    } finally { rmWorkspace(ws); }
  });

  test('proposals 非数组 / 空数组 / assignee 超长 的错误可行动且不落盘', async () => {
    const ws = await pendingReviewScene('adopt-bad');
    try {
      const notArray = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3', proposals: '加个任务',
      });
      assert.equal(notArray.ok, false);
      assert.match(notArray.error, /proposals 必须是数组/);

      const tooLong = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ title: '身份超长', assignee: 'x'.repeat(81) }],
      });
      assert.equal(tooLong.ok, false);
      assert.match(tooLong.error, /assignee 身份过长/);
      assert.match(tooLong.error, /下一步/);

      // 空数组等价于不传：正常通过、不建任务
      const empty = await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3', proposals: [],
      });
      assert.deepEqual(empty.adopted, { count: 0, ids: [] });

      const st = await stateOf(ws);
      assert.equal(st.order.length, 1, '只有最初那一个任务');
    } finally { rmWorkspace(ws); }
  });

  test('多级采纳：proposals 之间、与现有任务之间可互相依赖', async () => {
    const ws = await pendingReviewScene('adopt-multi');
    try {
      const r = await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [
          { id: 'm1', title: '第一项', dependsOn: ['a'], assignee: 'wersky/agent-1' },
          { id: 'm2', title: '第二项', dependsOn: ['m1'], assignee: 'wersky/agent-2' },
        ],
      });
      assert.deepEqual(r.adopted.ids, ['m1', 'm2']);

      const st = await stateOf(ws);
      assert.deepEqual(st.tasks['m2'].dependsOn, ['m1'], '提案之间可互相依赖');
      assert.equal(st.tasks['m2'].assignee, 'wersky/agent-2');

      // 波次链条：m1 就绪 → 完成后 m2 就绪（m2 不在首批 ready 里）
      let ready = await c.call('task_ready', { workspace: ws });
      assert.deepEqual(ready.ready.map(t => t.id).sort(), ['m1']);
      await c.call('task_claim', { workspace: ws, taskId: 'm1', owner: 'agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'm1', status: 'done', owner: 'agent-1' });
      ready = await c.call('task_ready', { workspace: ws });
      assert.deepEqual(ready.ready.map(t => t.id).sort(), ['m2']);
    } finally { rmWorkspace(ws); }
  });

  test('采纳 + 与 task_add 共用校验：id 冲突、父不存在、依赖自身都被拦住且整批不加', async () => {
    const ws = await pendingReviewScene('adopt-shared');
    try {
      // id 与现有任务冲突
      const dup = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ id: 'dup1', title: '合法' }, { id: 'a', title: '撞现有 id' }],
      });
      assert.equal(dup.ok, false);
      assert.match(dup.error, /proposals\[1\]/);
      assert.match(dup.error, /已存在/);

      // 父任务不存在
      const noParent = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ title: '父不存在', parentId: '幽灵父任务' }],
      });
      assert.equal(noParent.ok, false);
      assert.match(noParent.error, /父任务不存在/);

      // 整批校验后仍无任何新任务
      const st = await stateOf(ws);
      assert.deepEqual(st.order, ['a'], '三次尝试都不应留下任务');
    } finally { rmWorkspace(ws); }
  });

  test('采纳的提案不计入审核门误伤：新任务 owner 为空、状态 pending', async () => {
    const ws = await pendingReviewScene('adopt-fresh');
    try {
      await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'wersky/agent-3',
        proposals: [{ title: '自动编号的提案', assignee: 'wersky/agent-2' }],
      });
      const st = await stateOf(ws);
      const newId = st.order.find(id => id !== 'a');
      assert.ok(newId, '应自动编号产生新任务');
      const t = st.tasks[newId];
      assert.equal(t.status, 'pending', '新任务应是可派发的 pending');
      assert.equal(t.owner, null, '新任务不应凭空有 owner');
      assert.equal(t.reviewStage, 'none', '无 reviewer 的提案不应有审核门');
      assert.equal(t.assignee, 'wersky/agent-2', '自动编号的提案同样落 assignee');

      // 并能被正常领取（证明它真的是一等公民任务）
      const claimed = await c.call('task_claim', { workspace: ws, taskId: newId, owner: 'agent-2' });
      assert.equal(claimed.task.id, newId);
    } finally { rmWorkspace(ws); }
  });

  test('向后兼容：把 2.1.0 时代（无 assignee 字段）的状态文件直接喂给新版可正常读写', async () => {
    const ws = makeWorkspace('adopt-legacy');
    try {
      // 手工构造旧版状态：任务对象里完全没有 assignee 字段（2.1.0 的落盘格式）
      const legacy = {
        phase: 'swarming', goal: '旧计划', failurePolicy: 'block',
        createdAt: '2026-01-01T00:00:00.000Z', nextId: 3,
        tasks: {
          T1: {
            id: 'T1', title: '旧任务', detail: '', dependsOn: [], parent: null, depth: 0, children: ['T2'],
            status: 'done', owner: 'agent-1', role: 'producer', reviewer: null, reviewStage: 'none',
            notes: [], createdAt: '2026-01-01T00:00:00.000Z',
          },
          T2: {
            id: 'T2', title: '旧任务2', detail: '', dependsOn: ['T1'], parent: 'T1', depth: 1, children: [],
            status: 'pending', owner: null, role: 'none', reviewer: null, reviewStage: 'none',
            notes: [], createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
        order: ['T1', 'T2'],
        log: [],
      };
      fs.mkdirSync(path.join(ws, '任务蜂群'), { recursive: true });
      fs.writeFileSync(path.join(ws, '任务蜂群', 'swarm-state.json'), JSON.stringify(legacy, null, 2), 'utf8');

      // 读路径不炸，且视图里不显示「建议:」（不存在的字段不应凭空出现）
      const plan = await c.call('plan_get', { workspace: ws });
      assert.equal(plan.goal, '旧计划');
      assert.ok(!/→ 建议:/.test(plan.view), '旧任务无 assignee，视图不应显示建议行');
      const ready = await c.call('task_ready', { workspace: ws });
      const t2 = ready.ready.find(t => t.id === 'T2');
      assert.ok(t2, '旧任务应正常就绪');
      assert.equal(t2.assignee, undefined, '缺字段按未指定处理');

      // 写路径：老任务照常推进，新加的任务带新字段
      await c.call('task_claim', { workspace: ws, taskId: 'T2', owner: 'agent-2' });
      await c.call('task_update', { workspace: ws, taskId: 'T2', status: 'done', owner: 'agent-2' });
      const added = await c.call('task_add', { workspace: ws, title: '新任务', assignee: 'wersky/agent-3' });
      const st = await stateOf(ws);
      assert.equal(st.tasks.T2.status, 'done', '旧任务可正常推进');
      assert.equal(st.tasks[added.taskId].assignee, 'wersky/agent-3');
      assert.equal(st.tasks.T1.assignee, undefined, '旧任务不应被回填 assignee（避免无谓改写）');
    } finally { rmWorkspace(ws); }
  });

  test('reviewer/assignee 传非字符串：拒绝而非静默强转（真机验证暴露的缺口）', async () => {
    // 背景：原先用 String(value) 强转，{x:1} 会变成 "[object Object]" 写进任务——
    // 任务照进树、审核门却永远没有合法裁决者（只能 force 绕过），跨机器场景极难排查。
    const ws = makeWorkspace('typeguard');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', reviewer: 'r1' }] });
      await c.call('task_claim', { workspace: ws, taskId: 'a', owner: 'p1' });
      await c.call('task_update', { workspace: ws, taskId: 'a', status: 'done', owner: 'p1' });

      for (const [label, bad] of [['对象', { x: 1 }], ['数组', ['x']], ['数字', 42], ['布尔', true]]) {
        const r = await c.callRaw('task_review', {
          workspace: ws, taskId: 'a', verdict: 'approve', owner: 'r1',
          proposals: [{ title: `坏 reviewer-${label}`, reviewer: bad }],
        });
        assert.equal(r.ok, false, `reviewer 传${label}必须被拒绝（不能静默强转）`);
        assert.match(r.error, /reviewer 必须是字符串/, '错误应说明类型要求');
        assert.match(r.error, /proposals\[0\]/, '错误应定位到具体提案项');
      }

      // 同样守护 assignee
      const r2 = await c.callRaw('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'r1',
        proposals: [{ title: '坏 assignee', assignee: { a: 1 } }],
      });
      assert.equal(r2.ok, false);
      assert.match(r2.error, /assignee 必须是字符串/);

      // plan_create 路径同样守护
      const ws3 = makeWorkspace('tg3');
      try {
        const r3 = await c.callRaw('plan_create', {
          workspace: ws3, goal: 'g', tasks: [{ id: 'z', title: 'Z', reviewer: {} }],
        });
        assert.equal(r3.ok, false, 'plan_create 的 reviewer 也应是类型拒绝');
      } finally { rmWorkspace(ws3); }

      // 关键：所有拒绝都不留半成品——任务树保持原样，任务仍停在待审核
      const st = await stateOf(ws);
      assert.equal(Object.keys(st.tasks).length, 1, '被拒的提案不得进树（原子性）');
      assert.equal(st.tasks.a.status, 'pending_review', '任务应仍在待审核，未被误改');

      // 对照：合法字符串照常采纳
      const ok = await c.call('task_review', {
        workspace: ws, taskId: 'a', verdict: 'approve', owner: 'r1',
        proposals: [{ title: '合法提案', reviewer: 'r9', assignee: 'p9' }],
      });
      assert.equal(ok.adopted.count, 1);
      const st2 = await stateOf(ws);
      const adopted = Object.values(st2.tasks).find(t => t.title === '合法提案');
      assert.equal(adopted.reviewer, 'r9');
      assert.equal(adopted.assignee, 'p9');
    } finally { rmWorkspace(ws); }
  });
});
