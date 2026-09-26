#!/usr/bin/env node
/**
 * taskswarm MCP server —— 协议薄层（newline-delimited JSON-RPC 2.0 over stdio）。
 *
 * 存储与业务全部在 mcp/core.mjs（SQLite，零 npm 依赖，Node ≥ 23.4 内置 node:sqlite）；
 * 本文件只负责：工具清单声明（给 LLM 宿主看的文档）+ JSON-RPC 分发。
 * Web 控制台（ui/server.mjs）与 MCP server 共享同一个 core 与同一个状态库。
 *
 * 职责边界：本 server 只管「任务树与看板」的数据与格式（确定性部分），
 * 编排循环（何时拆解、何时派发、何时汇总）由主代理按 SKILL.md 执行。
 */
import readline from 'node:readline';
import { Store, SERVER_VERSION, DEFAULT_MAX_NOTES, DEFAULT_MAX_NOTE_CHARS, NOTES_LIMIT_DEFAULT, NOTES_LIMIT_MAX } from './core.mjs';

// ---------------------------------------------------------------------------
// 工具清单（描述即文档：宿主模型按这里理解行为，改动行为必须同步这里）
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'plan_create', description: '创建蜂群任务：一次多级任务拆解（任务树，含依赖）。goal=总目标；tasks=[{id?,title,detail?,dependsOn?,role?,reviewer?,assignee?,subtasks:[...]}]（subtasks 最多 5 层）。PPR：给任务配 reviewer 即启用审核门——producer 置 done 会转入 pending_review，必须由 reviewer 用 task_review 通过后下游才放行（task_review 可带 proposals 在过审时直接采纳新计划项）。assignee=建议执行者（仅提示，不影响领取权限）。failurePolicy 默认 "block"（上游 failed/skipped 时挡住下游）；"proceed" 则照常放行并在 task_ready 里标注 blockedBy。会覆盖已有计划。',
    inputSchema: {
      type: 'object', required: ['goal', 'tasks'],
      properties: {
        goal: { type: 'string', description: '总目标' },
        tasks: { type: 'array', items: { type: 'object' }, description: '顶级任务数组，每项 {id?,title,detail?,dependsOn?,role?,reviewer?,assignee?,subtasks:[{id?,title,detail?,dependsOn?,role?,reviewer?,assignee?}]}，嵌套最多 5 层。role 取值 planner/producer/reviewer（声明式标签）；reviewer 填身份字符串（如 "wersky/agent-3"）即为该任务启用审核门；assignee 填身份字符串表示建议由谁执行（仅提示）' },
        failurePolicy: { type: 'string', enum: ['block', 'proceed'], description: '上游 failed/skipped 时下游的处理策略：block（默认）挡住，proceed 放行并标注 blockedBy' },
      },
    },
  },
  {
    name: 'plan_get', description: '读取任务树全貌与当前就绪任务。view 只含状态/依赖骨架，recentEvents 里的进展笔记为短摘要（前 120 字符）；读某任务笔记全文请用 task_notes。返回含 rev（全局版本号，客户端轮询对比用）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_reset', description: '清空当前蜂群计划（重新开始时用）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'task_ready', description: '查询当前依赖已满足、可派发的任务列表。返回含 rev。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'task_claim', description: '子代理领取任务（原子操作，防重复派发）。taskId + owner（子代理标识，如 agent-1）。返回体包含任务全量笔记（上游结论）与 assignee/reviewer/blockedBy 等上下文，领取后无需再查即可开工。',
    inputSchema: { type: 'object', required: ['taskId', 'owner'], properties: { taskId: { type: 'string' }, owner: { type: 'string' } } },
  },
  {
    name: 'task_update', description: '更新任务状态（pending/claimed/in_progress/blocked/done/failed/skipped）或追加进展笔记。子代理汇报进度走这里；状态转移有守卫，非 owner 改不了他人任务。注意：done/skipped 的回退只有 reviewer 本人（或主代理 force）可执行，failed 的回退由 owner 执行。可选 cost:{tokens,minutes} 累计任务成本（board 汇总）。主代理在会话中断恢复等场景可用 force:true 强制改状态（会记审计事件）。笔记有上限：每任务保留最新 ' + DEFAULT_MAX_NOTES + ' 条（可用环境变量 TASKSWARM_MAX_NOTES 调整），单条超 ' + DEFAULT_MAX_NOTE_CHARS + ' 字符截断并标记；被丢弃的条数记在 task.notesDropped，读全文用 task_notes。claimed/in_progress 的任务超时无心跳会被自动回收回 pending（TASKSWARM_STALE_MINUTES，默认 30，设 0 禁用）。',
    inputSchema: {
      type: 'object', required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
        note: { type: 'string' },
        owner: { type: 'string' },
        cost: { type: 'object', description: '可选成本上报 {tokens?:number, minutes?:number}，累加进任务，board 汇总' },
        force: { type: 'boolean', description: '仅主代理用于会话中断恢复：跳过状态转移/归属守卫强制改状态，并记审计事件' },
      },
    },
  },
  {
    name: 'task_add', description: '执行中途追加任务（支持多级拆解持续发生）。{title,detail?,dependsOn?,parentId?,role?,reviewer?,assignee?}。配 reviewer 即启用 PPR 审核门；assignee 只是建议执行者的提示，不影响领取权限。',
    inputSchema: {
      type: 'object', required: ['title'],
      properties: {
        title: { type: 'string' },
        detail: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'string' } },
        parentId: { type: 'string' },
        role: { type: 'string', enum: ['planner', 'producer', 'reviewer'], description: 'PPR 角色标签（声明式，可选）' },
        reviewer: { type: 'string', description: '指定审核者身份（如 "wersky/agent-3"）；填了即启用审核门' },
        assignee: { type: 'string', description: '建议执行者身份（如 "wersky/agent-3"），仅作提示；实际谁干由 task_claim 决定' },
      },
    },
  },
  {
    name: 'task_notes', description: '读取单个任务的笔记全文（分页，只读）。board 每任务只给最近 2 条 80 字符摘要，本工具返回完整原文。taskId 必填；limit 默认 20、上限 200；offset 默认 0（从最新往回数，0 = 最新一条）。返回 { taskId, total, notesDropped, offset, limit, returned, hasMore, rev, notes:[{at,owner,note}] }；分页拼接：offset=0 取最新一页，再以 offset+limit 取更早一页，直到 hasMore=false。total 只统计当前保留条数，历史因上限丢弃的条数见 notesDropped（总数 = 保留数 + 丢弃数）。',
    inputSchema: {
      type: 'object', required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: '任务 id（可用 plan_get / board 查看）' },
        limit: { type: 'number', description: `每页条数，默认 ${NOTES_LIMIT_DEFAULT}，取值 1..${NOTES_LIMIT_MAX}` },
        offset: { type: 'number', description: '从最新一条往回跳过的条数，默认 0（0 = 最新一条）；超过总数时返回空页' },
      },
    },
  },
  {
    name: 'task_review', description: 'PPR 审核门裁决（reviewer 专用）：对处于「待审核」的任务给出通过（approve）或打回（reject）。approve → 任务转 done、下游放行；reject → 任务回到 in_progress 重做、下游继续阻断（reason 必填）。可选 proposals：审核时提出的新计划项，**仅 approve 时被采纳并直接加进任务树**，reject 时完全忽略；采纳是原子的（任一项不合法则整批不加）。仅任务上登记的 reviewer 本人可裁决（主代理可用 force:true 代裁）。',
    inputSchema: {
      type: 'object', required: ['taskId', 'verdict'],
      properties: {
        taskId: { type: 'string', description: '要裁决的任务 id' },
        verdict: { type: 'string', description: 'approve（通过）或 reject（打回重做）' },
        reason: { type: 'string', description: 'reject 时必填：写明要改什么（会写入任务笔记，producer 据此重做）' },
        proposals: { type: 'array', items: { type: 'object' }, description: '可选：审核通过时要采纳的新计划项，每项 {id?,title,detail?,dependsOn?,role?,reviewer?,assignee?,parentId?}，title 必填；仅 approve 时采纳，任一项不合法则整批不加' },
        owner: { type: 'string', description: '裁决者身份，必须与任务登记的 reviewer 一致' },
        force: { type: 'boolean', description: '主代理代裁用（跳过 reviewer 身份校验，会记审计事件）' },
      },
    },
  },
  {
    name: 'board', description: '共享进度看板：所有任务的实时状态、负责人、最近 2 条进展笔记摘要（各 80 字符，读全文用 task_notes）。子代理用它了解其他代理进度；返回含 rev 与成本汇总（cost）。超时无心跳的任务会被自动回收（触发点：任何写操作）。',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: '可选，只看某 owner 的任务' } } },
  },
  {
    name: 'state', description: '整体状态快照 save/load/clear（会话恢复用）。save 需提供完整 state 对象（与 2.2.0 JSON 格式兼容，log 含全量事件）；load 导出当前完整状态。',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, state: { type: 'object' } } },
  },
];

const HANDLERS = {
  plan_create: (store, args) => store.planCreate(args),
  plan_get: (store, args) => store.planGet(args),
  plan_reset: (store, args) => store.planReset(args),
  task_ready: (store, args) => store.taskReady(args),
  task_claim: (store, args) => store.taskClaim(args),
  task_update: (store, args) => store.taskUpdate(args),
  task_add: (store, args) => store.taskAdd(args),
  task_notes: (store, args) => store.taskNotes(args),
  task_review: (store, args) => store.taskReview(args),
  board: (store, args) => store.board(args),
  state: (store, args) => store.stateTool(args),
};

function reply(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = { code: -32603, message: String(error.message ?? error) };
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let req;
  try { req = JSON.parse(trimmed); } catch { return; }
  const { id, method, params } = req;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'taskswarm', version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (!handler) return reply(id, null, new Error(`未知工具: ${name}`));
    try {
      // 惰性超时回收：任何写操作前先回收失联任务（见 core.mjs Store.reclaimStale）
      const store = Store.for(args);
      store.reclaimStale();
      const { result, rev } = handler(store, args) ?? {};
      const payload = (result && typeof result === 'object' && !Array.isArray(result))
        ? { rev, ...result }
        : result;
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(payload) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(err.message ?? err) }) }], isError: true });
    }
  }
  return reply(id, null, new Error(`未知方法: ${method}`));
});
rl.on('close', () => process.exit(0));
