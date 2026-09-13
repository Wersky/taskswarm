/**
 * PPR（Planner / Producer / Reviewer）审核门测试。
 *
 * 核心承诺：**任务指定了 reviewer 后，"未过审"必须真正卡住流程**——
 * producer 置 done 不算完成，下游任务不得进入就绪列表，直到 reviewer 通过。
 * 这是审核机制存在的意义；如果只是"记录一下"而拦不住流程，等于没有。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { connect, makeWorkspace, rmWorkspace } from './helpers.mjs';

describe('PPR 审核门', () => {
  let c;
  test('初始化', () => { c = connect(); assert.ok(c); });

  test('角色与 reviewer 字段可创建，plan_view 显示审核状态', async () => {
    const ws = makeWorkspace('ppr1');
    try {
      const p = await c.call('plan_create', {
        workspace: ws, goal: 'PPR 流程验证',
        tasks: [
          { id: 'plan', title: '出计划', role: 'planner' },
          { id: 'impl', title: '实现功能', role: 'producer', dependsOn: ['plan'], reviewer: 'wersky/agent-3' },
        ],
      });
      assert.equal(p.ok, true);
      assert.equal(p.taskCount, 2);
      assert.match(p.plan, /\{planner\}/, '计划任务应显示 planner 角色');
      assert.match(p.plan, /\{producer\}/, '实现任务应显示 producer 角色');
      assert.match(p.plan, /审核:wersky\/agent-3/, '应显示登记的 reviewer');
    } finally { rmWorkspace(ws); }
  });

  test('坏 role 被明确拒绝（不静默忽略）', async () => {
    const ws = makeWorkspace('ppr2');
    try {
      const r = await c.callRaw('plan_create', {
        workspace: ws, goal: 'g', tasks: [{ id: 'a', title: 'A', role: '乱写' }],
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /role 非法/);
      assert.match(r.error, /planner|producer|reviewer/, '错误应列出可用值');
    } finally { rmWorkspace(ws); }
  });

  test('★ 核心：producer 置 done 不进 done，转 pending_review，且下游被阻断', async () => {
    const ws = makeWorkspace('ppr3');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [
          { id: 'impl', title: '实现', role: 'producer', reviewer: 'wersky/agent-3' },
          { id: 'ship', title: '发布', dependsOn: ['impl'] },
        ],
      });

      // producer 干活并交活（请求 done）
      await c.call('task_claim', { workspace: ws, taskId: 'impl', owner: 'wersky/agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'in_progress', owner: 'wersky/agent-1' });
      const submitted = await c.call('task_update', {
        workspace: ws, taskId: 'impl', status: 'done', note: '功能已完成', owner: 'wersky/agent-1',
      });

      // 关键断言：状态不是 done，而是 pending_review
      assert.equal(submitted.task.status, 'pending_review',
        '指定了 reviewer 的任务，producer 置 done 应被审核门改道为 pending_review');

      // 下游必须被阻断
      const ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === 'ship'),
        '上游未过审时，下游不得进入就绪列表（这是审核门的核心价值）');

      const claim = await c.callRaw('task_claim', { workspace: ws, taskId: 'ship', owner: 'wersky/agent-2' });
      assert.equal(claim.ok, false, '未过审时下游也不能被领取');

      // 看板/视图能看到"卡在等审核"
      const pg = await c.call('plan_get', { workspace: ws });
      assert.match(pg.view, /待 wersky\/agent-3 审核/, '视图应显示等待谁审核');
    } finally { rmWorkspace(ws); }
  });

  test('★ reviewer 通过后下游立即放行', async () => {
    const ws = makeWorkspace('ppr4');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [
          { id: 'impl', title: '实现', role: 'producer', reviewer: 'wersky/agent-3' },
          { id: 'ship', title: '发布', dependsOn: ['impl'] },
        ],
      });
      await c.call('task_claim', { workspace: ws, taskId: 'impl', owner: 'wersky/agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'done', owner: 'wersky/agent-1' });

      const review = await c.call('task_review', { workspace: ws, taskId: 'impl', verdict: 'approve', owner: 'wersky/agent-3' });
      assert.equal(review.ok, true);
      assert.equal(review.task.status, 'done');
      assert.equal(review.task.reviewStage, 'approved');

      const ready = await c.call('task_ready', { workspace: ws });
      assert.ok(ready.ready.some(t => t.id === 'ship'), '过审后下游应立即可派发');
    } finally { rmWorkspace(ws); }
  });

  test('★ reviewer 驳回：任务回到 in_progress、下游继续阻断、理由进笔记', async () => {
    const ws = makeWorkspace('ppr5');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [
          { id: 'impl', title: '实现', role: 'producer', reviewer: 'wersky/agent-3' },
          { id: 'ship', title: '发布', dependsOn: ['impl'] },
        ],
      });
      await c.call('task_claim', { workspace: ws, taskId: 'impl', owner: 'wersky/agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'done', owner: 'wersky/agent-1' });

      const rejected = await c.call('task_review', {
        workspace: ws, taskId: 'impl', verdict: 'reject',
        reason: '缺少边界条件处理', owner: 'wersky/agent-3',
      });
      assert.equal(rejected.task.status, 'in_progress', '打回后应回到进行中');
      assert.equal(rejected.task.reviewStage, 'rejected');

      // 下游仍阻断
      const ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === 'ship'), '被打回时下游必须保持阻断');

      // 驳回理由必须进笔记（producer 靠它知道改什么）
      const notes = await c.call('task_notes', { workspace: ws, taskId: 'impl' });
      assert.ok(notes.notes.some(n => n.note.includes('审核驳回') && n.note.includes('缺少边界条件处理')),
        '驳回理由应写入任务笔记');

      // 重做后可再次交活并过审
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'done', owner: 'wersky/agent-1' });
      const approved = await c.call('task_review', { workspace: ws, taskId: 'impl', verdict: 'approve', owner: 'wersky/agent-3' });
      assert.equal(approved.task.status, 'done');
      const ready2 = await c.call('task_ready', { workspace: ws });
      assert.ok(ready2.ready.some(t => t.id === 'ship'), '重做并过审后下游放行');
    } finally { rmWorkspace(ws); }
  });

  test('非登记的 reviewer 不能裁决（身份校验）', async () => {
    const ws = makeWorkspace('ppr6');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'impl', title: '实现', role: 'producer', reviewer: 'wersky/agent-3' }],
      });
      await c.call('task_claim', { workspace: ws, taskId: 'impl', owner: 'wersky/agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'done', owner: 'wersky/agent-1' });

      const wrong = await c.callRaw('task_review', { workspace: ws, taskId: 'impl', verdict: 'approve', owner: 'wersky/agent-9' });
      assert.equal(wrong.ok, false);
      assert.match(wrong.error, /wersky\/agent-3/, '错误应点名正确的 reviewer');

      const noOwner = await c.callRaw('task_review', { workspace: ws, taskId: 'impl', verdict: 'approve' });
      assert.equal(noOwner.ok, false, '不提供 owner 不能裁决');
    } finally { rmWorkspace(ws); }
  });

  test('主代理可 force 代裁（并留审计）', async () => {
    const ws = makeWorkspace('ppr7');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'impl', title: '实现', role: 'producer', reviewer: 'wersky/agent-3' }],
      });
      await c.call('task_claim', { workspace: ws, taskId: 'impl', owner: 'wersky/agent-1' });
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'done', owner: 'wersky/agent-1' });

      const r = await c.call('task_review', { workspace: ws, taskId: 'impl', verdict: 'approve', owner: 'main', force: true });
      assert.equal(r.task.status, 'done');
      const bd = await c.call('board', { workspace: ws });
      assert.ok((bd.recentEvents ?? []).some(e => String(e.event).includes('强制裁决')),
        'force 代裁应留审计事件');
    } finally { rmWorkspace(ws); }
  });

  test('未指定 reviewer 的任务保持旧行为（置 done 即完成，无审核门）', async () => {
    const ws = makeWorkspace('ppr8');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'plain', title: '普通任务' }, { id: 'next', title: '下游', dependsOn: ['plain'] }],
      });
      await c.call('task_claim', { workspace: ws, taskId: 'plain', owner: 'w1' });
      const done = await c.call('task_update', { workspace: ws, taskId: 'plain', status: 'done', owner: 'w1' });
      assert.equal(done.task.status, 'done', '没配 reviewer 就该直接完成（向后兼容）');
      const ready = await c.call('task_ready', { workspace: ws });
      assert.ok(ready.ready.some(t => t.id === 'next'), '下游正常放行');
    } finally { rmWorkspace(ws); }
  });

  test('对没有审核门的任务调用 task_review 给出可行动错误', async () => {
    const ws = makeWorkspace('ppr9');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'plain', title: '普通' }] });
      const r = await c.callRaw('task_review', { workspace: ws, taskId: 'plain', verdict: 'approve', owner: 'w1' });
      assert.equal(r.ok, false);
      assert.match(r.error, /没有指定 reviewer|不存在审核门/);
    } finally { rmWorkspace(ws); }
  });

  test('任务未交活时不能裁决（状态守卫）', async () => {
    const ws = makeWorkspace('ppr10');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'impl', title: '实现', role: 'producer', reviewer: 'wersky/agent-3' }],
      });
      const r = await c.callRaw('task_review', { workspace: ws, taskId: 'impl', verdict: 'approve', owner: 'wersky/agent-3' });
      assert.equal(r.ok, false);
      assert.match(r.error, /pending_review|待审核/);
    } finally { rmWorkspace(ws); }
  });

  test('非法 verdict 被拒绝', async () => {
    const ws = makeWorkspace('ppr11');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'impl', title: '实现', reviewer: 'wersky/agent-3' }],
      });
      const r = await c.callRaw('task_review', { workspace: ws, taskId: 'impl', verdict: '随便', owner: 'wersky/agent-3' });
      assert.equal(r.ok, false);
      assert.match(r.error, /approve|reject/);
    } finally { rmWorkspace(ws); }
  });

  test('reject 必须给 reason', async () => {
    const ws = makeWorkspace('ppr12');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [{ id: 'impl', title: '实现', reviewer: 'wersky/agent-3' }],
      });
      await c.call('task_claim', { workspace: ws, taskId: 'impl', owner: 'w1' });
      await c.call('task_update', { workspace: ws, taskId: 'impl', status: 'done', owner: 'w1' });
      const r = await c.callRaw('task_review', { workspace: ws, taskId: 'impl', verdict: 'reject', owner: 'wersky/agent-3' });
      assert.equal(r.ok, false);
      assert.match(r.error, /reason/);
    } finally { rmWorkspace(ws); }
  });

  test('task_add 也能配 reviewer（执行中途加审核门）', async () => {
    const ws = makeWorkspace('ppr13');
    try {
      await c.call('plan_create', { workspace: ws, goal: 'g', tasks: [{ id: 'seed', title: '种子' }] });
      const added = await c.call('task_add', {
        workspace: ws, title: '追加带审核的任务', role: 'producer', reviewer: 'wersky/agent-3',
      });
      assert.ok(added.taskId);
      await c.call('task_claim', { workspace: ws, taskId: added.taskId, owner: 'w1' });
      const done = await c.call('task_update', { workspace: ws, taskId: added.taskId, status: 'done', owner: 'w1' });
      assert.equal(done.task.status, 'pending_review', 'task_add 建的审核门同样生效');
    } finally { rmWorkspace(ws); }
  });

  test('多级审核链：A 过审后 B 才可开始，B 也需过审', async () => {
    const ws = makeWorkspace('ppr14');
    try {
      await c.call('plan_create', {
        workspace: ws, goal: 'g',
        tasks: [
          { id: 'A', title: '第一段', reviewer: 'r1' },
          { id: 'B', title: '第二段', dependsOn: ['A'], reviewer: 'r2' },
          { id: 'C', title: '发布', dependsOn: ['B'] },
        ],
      });
      // A 做完待审
      await c.call('task_claim', { workspace: ws, taskId: 'A', owner: 'p1' });
      await c.call('task_update', { workspace: ws, taskId: 'A', status: 'done', owner: 'p1' });
      let ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === 'B'), 'A 未过审 → B 不可开始');

      // A 过审 → B 可开始
      await c.call('task_review', { workspace: ws, taskId: 'A', verdict: 'approve', owner: 'r1' });
      ready = await c.call('task_ready', { workspace: ws });
      assert.ok(ready.ready.some(t => t.id === 'B'), 'A 过审 → B 可开始');
      assert.ok(!ready.ready.some(t => t.id === 'C'), 'B 未做 → C 不可开始');

      // B 做完待审 → C 仍不可
      await c.call('task_claim', { workspace: ws, taskId: 'B', owner: 'p2' });
      await c.call('task_update', { workspace: ws, taskId: 'B', status: 'done', owner: 'p2' });
      ready = await c.call('task_ready', { workspace: ws });
      assert.ok(!ready.ready.some(t => t.id === 'C'), 'B 未过审 → C 不可开始（审核链逐级生效）');

      // B 过审 → C 放行
      await c.call('task_review', { workspace: ws, taskId: 'B', verdict: 'approve', owner: 'r2' });
      ready = await c.call('task_ready', { workspace: ws });
      assert.ok(ready.ready.some(t => t.id === 'C'), '全链过审 → 最终任务放行');
    } finally { rmWorkspace(ws); }
  });

  test('清理', () => { c.kill(); });
});
