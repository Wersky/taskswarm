/**
 * taskswarm core —— 存储 + 业务核心，被 mcp/server.mjs（MCP 协议层）与
 * ui/server.mjs（Web 控制台）共享。控制台的审批走同一套函数，不绕状态机。
 *
 * 零 npm 依赖：存储用 Node ≥ 23.4 内置的 node:sqlite（DatabaseSync）。
 *
 * 为什么换 SQLite（2.2.0 用「JSON 文件 + 自实现文件锁 + rename 原子写」）：
 * - JSON 整体覆盖写的并发正确性靠文件锁，锁是自实现的，抢占/陈旧判定/Windows
 *   瞬态重试都是补丁；SIGKILL 打断 rename 序列仍有窗口（2.2.0 用 fsync 缩小但未消除）。
 * - SQLite 单文件即是全部状态，WAL + 事务给出进程级并发安全与崩溃恢复，
 *   BEGIN IMMEDIATE 取代文件锁成为唯一写互斥点；审计事件独立成 append-only
 *   的 events 表，成为不可变审计日志（商业版的合规地基）。
 * - 编程模型刻意保持「state 对象整体读改写」：loadAll() 从表里重建出与 2.2.0
 *   JSON 同构的 state 对象，业务函数照旧改内存对象，persistAll() 在事务内全量
 *   重写。数据规模（单蜂群几十任务 × 每任务 ≤500 笔记）下毫秒级，换来全部业务
 *   逻辑零改动、黑盒测试直接兜底。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';

export const SERVER_VERSION = '3.1.0'; // 必须与 package.json / .zcode-plugin/plugin.json 一致

// ---------------------------------------------------------------------------
// 落盘位置：<工作区>/任务蜂群/swarm-state.db（由调用方传 workspace，默认 cwd）
// ---------------------------------------------------------------------------
export function workspaceOf(args) {
  const ws = args?.workspace;
  if (ws === undefined || ws === null || ws === '') return '';
  if (typeof ws !== 'string') {
    throw new Error(`workspace 必须是字符串（当前类型：${Array.isArray(ws) ? 'array' : typeof ws}）。下一步：传入工作区路径字符串，例如 {"workspace":"/path/to/my-project"}。`);
  }
  return ws.trim();
}
export function baseDir(args) {
  const ws = workspaceOf(args);
  return path.join(ws || process.cwd(), '任务蜂群');
}
export function stateFile(args) { return path.join(baseDir(args), 'swarm-state.db'); }
/** 2.2.0 的旧状态文件（迁移源） */
function legacyJsonFile(args) { return path.join(baseDir(args), 'swarm-state.json'); }

/** 写事务的 busy 等待上限（毫秒）。沿用 2.2.0 的环境变量名与默认值，语义从「抢锁超时」变为「等库解锁超时」。 */
const DEFAULT_BUSY_TIMEOUT_MS = 10000;
const BUSY_TIMEOUT_MAX_MS = 600000;
export function busyTimeoutMs() { return positiveIntEnv('TASKSWARM_LOCK_TIMEOUT_MS', DEFAULT_BUSY_TIMEOUT_MS, BUSY_TIMEOUT_MAX_MS); }

const SCHEMA_VERSION = 1;
/** 内存里保留的最近事件条数（recentEvents 展示用；全量在 events 表，永不截断） */
const LOG_TAIL = 50;

// ---------------------------------------------------------------------------
// 状态机与常量（与 2.2.0 语义一致）
// ---------------------------------------------------------------------------
export const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'blocked', 'pending_review', 'done', 'failed', 'skipped'];
export const DONE_LIKE = new Set(['done', 'failed', 'skipped']);
export const TERMINAL = new Set(['done', 'failed', 'skipped']);

/**
 * PPR 角色（可选）：planner 出计划 / producer 干活 / reviewer 审核。
 * 角色是**声明式标签**，不参与权限校验（MCP 层无法验身份，真正的边界是仓库写权限
 * 或本地调用方自觉）；它的作用是让编排可读、并驱动 reviewer 的审核门。
 */
export const TASK_ROLES = ['planner', 'producer', 'reviewer', 'none'];

/**
 * 审核门状态（仅当任务指定了 reviewer 时才有意义）：
 *   none       —— 未指定 reviewer，走旧行为（producer 置 done 即完成）
 *   pending    —— producer 已置 done，等待 reviewer 裁决（**下游被阻断**）
 *   approved   —— reviewer 通过（等价于 done，可放行下游）
 *   rejected   —— reviewer 驳回（回到 in_progress 重做，下游仍阻断）
 */
export const REVIEW_STAGES = ['none', 'pending', 'approved', 'rejected'];

/**
 * 合法状态转移表（source → 允许到达的目标状态）。
 * 未列出的转移一律拒绝，错误信息里会给出「下一步做什么」。
 * pending_review 是 PPR 审核门：producer 交活后停在这，等 reviewer 裁决。
 */
export const ALLOWED_TRANSITIONS = {
  pending: ['claimed', 'in_progress', 'blocked', 'pending_review', 'done', 'failed', 'skipped'],
  claimed: ['in_progress', 'blocked', 'pending', 'pending_review', 'done', 'failed', 'skipped'],
  in_progress: ['blocked', 'pending', 'pending_review', 'done', 'failed', 'skipped'],
  blocked: ['in_progress', 'pending', 'pending_review', 'done', 'failed', 'skipped'],
  pending_review: ['in_progress', 'pending', 'done', 'failed', 'skipped'], // 裁决：通过→done，驳回→in_progress
  done: ['pending'],
  failed: ['pending'],
  skipped: ['pending'],
};

/** 失败语义：默认挡住下游（block），可选 proceed 延续旧行为（放行但在 ready 里标注 blockedBy） */
export const FAILURE_POLICIES = ['block', 'proceed'];
export const DEFAULT_FAILURE_POLICY = 'block';

export const MAX_SUBTASK_DEPTH = 5;
export const DANGEROUS_IDS = new Set(['__proto__', 'prototype', 'constructor']);
/** id 规则：首位字母或数字，其余字母/数字/点/下划线/短横线，总长 ≤ 64 */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// 笔记治理上限（原因与 2.2.0 相同：无上限会拖垮 board/plan_get 的返回体量）
//   TASKSWARM_MAX_NOTES      每任务保留的最新笔记条数（默认 500，取值 1..100000）
//   TASKSWARM_MAX_NOTE_CHARS 单条笔记最大字符数（默认 4000，取值 1..1000000）
// ---------------------------------------------------------------------------
export const DEFAULT_MAX_NOTES = 500;
export const DEFAULT_MAX_NOTE_CHARS = 4000;
/** 截断标记：同时进入返回体（避免调用方把截断误当成原文） */
export const TRUNCATED_MARK = '…[已截断]';

function positiveIntEnv(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0 || n > max) return fallback; // 环境变量写错时退回默认值，不阻断启动
  return n;
}
/** 每次读取环境变量（而非模块级常量），便于测试在同一进程内切换 */
function maxNotes() { return positiveIntEnv('TASKSWARM_MAX_NOTES', DEFAULT_MAX_NOTES, 100000); }
function maxNoteChars() { return positiveIntEnv('TASKSWARM_MAX_NOTE_CHARS', DEFAULT_MAX_NOTE_CHARS, 1000000); }
/** events 表保留上限（条）。超出部分归档到 JSONL 文件后从库内删除；非法值回退默认 5000。 */
function maxEvents() { return positiveIntEnv('TASKSWARM_MAX_EVENTS', 5000, 100000000); }
/** 心跳超时（分钟）。claimed/in_progress 超过该时长无心跳 → 惰性回收回 pending。0 = 禁用。 */
export function staleMinutes() {
  const raw = process.env.TASKSWARM_STALE_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 30;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > 525600) return 30;
  return n;
}

// ---------------------------------------------------------------------------
// 校验辅助（与 2.2.0 逐字一致）
// ---------------------------------------------------------------------------
/** 类型守卫：必须是字符串（拒绝 array/object/number，避免后续 String() 变化出意外键名） */
function requireString(value, label) {
  if (typeof value !== 'string') {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new Error(`${label} 必须是字符串（当前类型：${kind}）。下一步：改为传字符串。`);
  }
  return value;
}

/**
 * 任务 id 严格校验：`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，并显式拒绝原型污染键名。
 * where 用于错误信息前缀（如 plan_create/task_add）。
 */
export function assertValidId(id, where) {
  const s = String(id);
  if (DANGEROUS_IDS.has(s)) {
    throw new Error(`${where}: 任务 id "${s}" 是保留的危险键名（会造成原型污染），禁止使用。下一步：换一个具体名字，如 "task-${s.replace(/^_+/, '') || 'a'}"。`);
  }
  if (!ID_RE.test(s)) {
    const why = s.trim() === '' ? '不能为空'
      : s.length > 64 ? `长度 ${s.length} 超过上限 64`
      : /^\W/.test(s) ? `首字符 "${s[0]}" 不合法（必须为字母或数字）`
      : '含有非法字符（只允许字母、数字、点、下划线、短横线）';
    throw new Error(`${where}: 任务 id "${s}" 不合法：${why}。下一步：改用符合 [A-Za-z0-9][A-Za-z0-9._-]{0,63} 的 id，例如 "api-auth"。`);
  }
  return s;
}

/** PPR 角色归一化：未指定 → 'none'；非法值 → 明确报错（不静默忽略） */
function normalizeRole(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'none';
  const r = String(value).trim().toLowerCase();
  if (!TASK_ROLES.includes(r)) {
    throw new Error(`role 非法（收到 "${value}"）。下一步：用 ${TASK_ROLES.filter(x => x !== 'none').join(' / ')} 之一，或省略该字段。`);
  }
  return r;
}

/**
 * reviewer 归一化：可以是身份字符串（如 "wersky/agent-3"），也可以省略。
 * 省略 → null（该任务无审核门，producer 置 done 即完成，保持向后兼容）。
 */
function normalizeReviewer(value) {
  if (value === undefined || value === null) return null;
  // ⚠️ 刻意拒绝非字符串而不是 String() 强转：强转会把 {x:1} 变成 "[object Object]"
  // 这种"看着像身份、实际永不可用"的脏值静默写进任务——探测到该任务从此没有
  // 合法裁决者，审核门只能靠 force 绕过，且跨机器场景下极难排查（实测踩过）。
  if (typeof value !== 'string') {
    const kind = Array.isArray(value) ? 'array' : typeof value;
    throw new Error(`reviewer 必须是字符串（当前类型：${kind}）。下一步：传身份字符串，例如 "wersky/agent-3"；不指定则该任务无审核门，省略此字段即可。`);
  }
  const s = value.trim();
  if (s === '') return null;
  if (s.length > 80) throw new Error(`reviewer 身份过长（${s.length} > 80）。下一步：用简短身份，如 "wersky/agent-3"。`);
  return s;
}

/**
 * assignee 归一化：**建议**执行者身份（如 "wersky/agent-3"），可为空。
 * 与 reviewer 的关键区别：reviewer 触发审核门（机制），assignee 只是提示（标签）。
 */
function normalizeAssignee(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    const kind = Array.isArray(value) ? 'array' : typeof value;
    throw new Error(`assignee 必须是字符串（当前类型：${kind}）。下一步：传身份字符串，例如 "wersky/agent-3"；不需要建议执行者时省略该字段。`);
  }
  const s = value.trim();
  if (s === '') return null;
  if (s.length > 80) throw new Error(`assignee 身份过长（${s.length} > 80）。下一步：用简短身份，如 "wersky/agent-3"。`);
  return s;
}

function normalizeDeps(args, where) {
  const raw = args?.dependsOn;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    const kind = typeof raw === 'object' ? 'object' : typeof raw;
    throw new Error(`${where}: dependsOn 必须是字符串数组（当前类型：${kind}）。下一步：改为 {"dependsOn":["任务id"]} 或省略该字段。`);
  }
  const out = [];
  for (const d of raw) {
    if (typeof d !== 'string') {
      const kind = d === null ? 'null' : Array.isArray(d) ? 'array' : typeof d;
      throw new Error(`${where}: dependsOn 的元素必须是字符串（发现类型：${kind}）。下一步：写成任务 id 字符串，如 {"dependsOn":["T1"]}。`);
    }
    const s = d.trim();
    if (s === '') continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * proposals 归一化（task_review 采纳提案用）：先全量类型检查再建节点，保证采纳的原子性。
 * 错误信息一律带 `proposals[i]` 与「怎么改」，让 reviewer 一次就能改对。
 */
function normalizeProposals(value, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    const kind = value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value;
    throw new Error(`${where}: proposals 必须是数组（当前类型：${kind}）。下一步：改为 [{"title":"..."}] 形式，或省略该字段。`);
  }
  return value.map((p, i) => {
    const at = `${where}: proposals[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      const kind = p === null ? 'null' : Array.isArray(p) ? 'array' : typeof p;
      throw new Error(`${at} 必须是对象（当前类型：${kind}）。下一步：写成 {"title":"提案标题","detail":"..."}。`);
    }
    const title = String(p.title ?? '').trim();
    if (title === '') {
      throw new Error(`${at} 缺少 title（或 title 为空）。下一步：补上任务标题，例如 {"title":"补一个并发回归测试","detail":"覆盖 …","assignee":"wersky/agent-3"}。`);
    }
    // 坑：normalizeRole/normalizeReviewer/normalizeAssignee 的错误文案不带 proposals 下标，
    // 批量采纳时必须补上「第几项」。normalizeDeps/assertValidId/requireString 已带 where。
    const withIndex = (fn) => {
      try { return fn(); }
      catch (err) { throw new Error(`${at}: ${err?.message ?? err}`); }
    };
    const id = p.id === undefined || p.id === null || String(p.id).trim() === '' ? '' : assertValidId(String(p.id).trim(), at);
    const parentId = p.parentId === undefined || p.parentId === null || String(p.parentId).trim() === ''
      ? '' : requireString(p.parentId, `${at}: parentId`).trim();
    return {
      id,
      title,
      detail: p.detail === undefined || p.detail === null ? '' : String(p.detail).trim(),
      dependsOn: normalizeDeps(p, at),
      parentId,
      role: withIndex(() => normalizeRole(p.role)),
      reviewer: withIndex(() => normalizeReviewer(p.reviewer)),
      assignee: withIndex(() => normalizeAssignee(p.assignee)),
    };
  });
}

/**
 * 状态结构校验：手工编辑或 state save 传进来的 state 可能缺字段，
 * 统一挡在逻辑之前，避免 "Cannot read properties of undefined" 这类内部异常。
 */
export function assertStateShape(state) {
  const bad = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('状态内容不是对象。下一步：用 plan_reset 清空后重新 plan_create（备份文件保留便于排查）。');
  }
  if (!Array.isArray(state.order)) bad.push('order（任务顺序数组）');
  if (!state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) bad.push('tasks（任务表对象）');
  if (state.log !== undefined && !Array.isArray(state.log)) bad.push('log（事件数组）');
  if (bad.length > 0) {
    throw new Error(
      `状态格式异常：缺少或类型不对的字段 ${bad.join('、')}。` +
      '下一步：用 plan_reset 清空后重新 plan_create。'
    );
  }
  return state;
}
function ensureState(state) {
  if (!state || state.phase !== 'swarming') throw new Error('没有进行中的蜂群任务。下一步：先调用 plan_create 建立任务树，或用 state(load) 检查状态、plan_reset 清空后重建。');
  return assertStateShape(state);
}

/**
 * 校验依赖：危险键名 → 存在性 → id 格式 → 自依赖。
 * 顺序有意如此 —— 危险键名必须点名说清（否则会被误当成「不存在」而掩盖问题）；
 * 中文等不合法 id 报「不存在」比报格式错更可行动（调用方本想引用一个真实任务）。
 */
function assertDepsResolvable(state, ownerId, deps, where) {
  for (const dep of deps) {
    if (DANGEROUS_IDS.has(dep)) {
      throw new Error(`${where}: 任务 ${ownerId} 的 dependsOn 含保留的危险键名 "${dep}"（会造成原型污染），禁止使用。下一步：改成真实任务的 id（用 plan_get/board 查看现有 id）。`);
    }
    if (!hasTask(state, dep)) {
      throw new Error(`${where}: 任务 ${ownerId} 依赖了不存在的任务 ${dep}。下一步：改成已存在任务的 id，或先创建该任务（也可以用 plan_get/board 查看现有 id）。`);
    }
    assertValidId(dep, where);
    if (dep === ownerId) throw new Error(`${where}: 任务 ${ownerId} 依赖自身。下一步：删掉这条 dependsOn。`);
  }
}
export function hasTask(state, taskId) {
  return Object.hasOwn(state.tasks ?? {}, taskId);
}
export function findTask(state, taskId) {
  if (!hasTask(state, taskId)) {
    const id = taskId === '' || taskId === undefined ? '(空)' : taskId;
    throw new Error(`任务不存在: ${id}。下一步：用 plan_get 或 board 查看现有任务 id，确认后再调用。`);
  }
  return state.tasks[taskId];
}
/** 读取任务的依赖列表：容忍手工编辑过的状态（dependsOn 缺失/非数组都不炸） */
function depsOf(task) {
  const d = task?.dependsOn;
  return Array.isArray(d) ? d : [];
}

/** 笔记数组视图：容忍手工编辑过的状态（notes 缺失/非数组都不炸） */
function notesOf(task) {
  return Array.isArray(task?.notes) ? task.notes : [];
}
/** 已丢弃的笔记条数（历史遗留状态无此字段 → 0；非法值归零，避免 NaN 进入输出） */
function notesDroppedOf(task) {
  const n = Number(task?.notesDropped);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 追加一条笔记并执行上限治理（条数上限 + 单条长度上限）。
 * 调用方必须在事务内（mutateState 临界区）。
 * 返回 { text, truncated, dropped }。
 */
function appendNote(task, note, owner) {
  const limit = maxNoteChars();
  let text = note;
  let truncated = false;
  if (text.length > limit) {
    // 先截断再补标记：保证入库长度仍受 limit 约束（标记自身占几个字符不影响上限语义）
    text = text.slice(0, limit) + TRUNCATED_MARK;
    truncated = true;
  }
  if (!Array.isArray(task.notes)) task.notes = []; // 兼容被手工改过的状态
  task.notes.push({ at: new Date().toISOString(), owner, note: text });

  const cap = maxNotes();
  let dropped = 0;
  if (task.notes.length > cap) {
    dropped = task.notes.length - cap;
    task.notes.splice(0, dropped); // 保留最新：丢掉最旧的
    task.notesDropped = notesDroppedOf(task) + dropped; // 记账，绝不静默丢弃
  }
  return { text, truncated, dropped };
}
function depsSatisfied(state, task) {
  return depsOf(task).every(id => {
    const d = hasTask(state, id) ? state.tasks[id] : null;
    return d && DONE_LIKE.has(d.status);
  });
}

/**
 * 失败语义：找出把该任务挡住的上游（failed/skipped 的依赖）。
 * block 策略下这些任务不进就绪列表；proceed 策略下进，但用 blockedBy 标注。
 */
function blockingDeps(state, task) {
  return depsOf(task).filter(id => {
    const d = hasTask(state, id) ? state.tasks[id] : null;
    return d && (d.status === 'failed' || d.status === 'skipped');
  });
}
/** 失败策略取值（未指定 → 默认 block；旧状态缺字段也走 block） */
function failurePolicyOf(state) {
  const p = state?.failurePolicy;
  return FAILURE_POLICIES.includes(p) ? p : DEFAULT_FAILURE_POLICY;
}

// ---------------------------------------------------------------------------
// 任务对象 ↔ 数据库行 的字段映射（内存模型与 2.2.0 JSON 完全同构）
// ---------------------------------------------------------------------------
const TASK_TEXT_FIELDS = [
  'title', 'detail', 'parent', 'status', 'owner', 'role', 'assignee',
  'reviewer', 'reviewStage', 'claimedAt', 'startedAt', 'submittedAt',
  'finishedAt', 'reviewedAt', 'reviewedBy', 'lastHeartbeat', 'createdAt',
];
const TASK_INT_FIELDS = ['depth', 'costTokens', 'costMinutes', 'notesDropped'];
const TASK_JSON_FIELDS = ['dependsOn', 'children'];

function taskRowOf(t, sortOrder) {
  const row = { id: t.id, sortOrder };
  for (const k of TASK_TEXT_FIELDS) row[k] = t[k] ?? null;
  for (const k of TASK_INT_FIELDS) row[k] = Number.isFinite(Number(t[k])) ? Math.floor(Number(t[k])) : (k === 'depth' ? 0 : null);
  for (const k of TASK_JSON_FIELDS) row[k] = JSON.stringify(Array.isArray(t[k]) ? t[k] : []);
  return row;
}
function taskOfRow(row) {
  const t = { id: row.id };
  for (const k of TASK_TEXT_FIELDS) t[k] = row[k] ?? null;
  for (const k of TASK_INT_FIELDS) t[k] = row[k] ?? (k === 'depth' ? 0 : 0);
  for (const k of TASK_JSON_FIELDS) {
    try { t[k] = JSON.parse(row[k] ?? '[]'); } catch { t[k] = []; }
  }
  t.notes = []; // 由 notes 表填充
  return t;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT, detail TEXT, dependsOn TEXT NOT NULL DEFAULT '[]',
  parent TEXT, depth INTEGER NOT NULL DEFAULT 0, children TEXT NOT NULL DEFAULT '[]',
  status TEXT, owner TEXT, role TEXT, assignee TEXT, reviewer TEXT, reviewStage TEXT,
  claimedAt TEXT, startedAt TEXT, submittedAt TEXT, finishedAt TEXT,
  reviewedAt TEXT, reviewedBy TEXT, lastHeartbeat TEXT,
  costTokens INTEGER, costMinutes INTEGER, notesDropped INTEGER,
  createdAt TEXT, sortOrder INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT NOT NULL, at TEXT NOT NULL, owner TEXT NOT NULL, note TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(taskId, id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, event TEXT NOT NULL, taskId TEXT, owner TEXT, detail TEXT
);
`;

/** 数据库文件损坏时：先备份为 <file>.corrupt-<时间戳>.db 再抛中文错误（绝不静默重建）。 */
function corruptionError(f, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${f}.corrupt-${stamp}`;
  let saved = '';
  try { fs.copyFileSync(f, backup); saved = backup; }
  catch (err) { saved = `（备份失败：${err?.message ?? err}）`; }
  return new Error(
    `状态库已损坏，无法打开：${f}\n原因：${reason}\n坏文件已备份为：${saved}\n` +
    '可以用 plan_reset 清空后重新 plan_create；备份文件已保留，便于事后排查，请勿删除。'
  );
}

// ---------------------------------------------------------------------------
// 首次建库专用文件锁。
// 业务写互斥已由 SQLite 事务（BEGIN IMMEDIATE）承担；但「建库 + 建表 + 迁移」
// 这段多个进程同时第一次打开同一个不存在/不完整的库时会互相踩（实测 10 进程
// 并发首开出现建表竞争），因此用一把短生命周期文件锁把这段串行化。
// 锁很快（毫秒级，只有首个进程真正建库），不影响稳态性能。
// ---------------------------------------------------------------------------
const OPEN_LOCK_RETRY_MS = 25;
const OPEN_LOCK_STALE_MS = 30000;

function acquireOpenLock(dir, dbPath) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = dbPath + '.open-lock';
  const deadline = Date.now() + busyTimeoutMs();
  for (;;) {
    let fd = -1;
    try {
      fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() })); } catch { /* ignore */ }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      return lockPath;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw new Error(`获取状态库初始化锁失败：${lockPath}（${err?.code ?? err?.message ?? err}）`);
      }
      // 陈旧锁判定（两条路径，沿袭 2.2.0 的锁语义）：
      //   1. 持锁进程存活探测：锁记录本机 pid 且进程已死（ESRCH）→ 立即抢占
      //      （SIGKILL 测试与崩溃恢复都依赖这条，等 mtime 超时太久）
      //   2. 锁龄超限：建库段是毫秒级操作，超 30s 必为残留
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const pid = Number(info?.pid);
        const sameHost = String(info?.host ?? '') === os.hostname();
        if (Number.isFinite(pid) && pid > 0 && sameHost && pid !== process.pid) {
          try { process.kill(pid, 0); } catch (e) { stale = e?.code === 'ESRCH'; }
        }
      } catch { /* 解析失败交给 mtime 判定 */ }
      if (!stale) {
        try { if (Date.now() - fs.statSync(lockPath).mtimeMs > OPEN_LOCK_STALE_MS) stale = true; }
        catch { /* 锁刚被释放，重试 */ }
      }
      if (stale) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`状态库初始化锁等待超时：${lockPath}。下一步：确认没有其他进程正在首次创建该工作区的状态库；若残留锁文件，可手动删除后重试。`);
      }
      const wait = Math.min(OPEN_LOCK_RETRY_MS, Math.max(0, deadline - Date.now()));
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); }
      catch { const end = Date.now() + wait; while (Date.now() < end) { /* 忙等兜底 */ } }
    }
  }
}

function releaseOpenLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Store —— 一个工作区一个实例；MCP server 与 UI server 各自持有（WAL 允许多进程）
// ---------------------------------------------------------------------------
export class Store {
  /** @type {Map<string, Store>} 同进程内按 workspace 根路径复用句柄 */
  static #cache = new Map();

  /**
   * 按调用参数取得（或创建）该工作区的 Store。
   * 与 2.2.0「每次调用按 args 现算路径」不同，SQLite 句柄必须复用，
   * 缓存键 = 工作区根（含 cwd 兜底），避免句柄泄漏。
   */
  static for(args) {
    const root = path.resolve(workspaceOf(args) || process.cwd());
    let s = Store.#cache.get(root);
    if (!s) { s = new Store(root); Store.#cache.set(root, s); }
    return s;
  }

  #db = null;
  #root = '';
  #dbPath = '';
  #insertTask = null;
  #insertNote = null;
  #insertEvent = null;
  /** 打开失败时记录错误（构造不抛——否则 plan_reset 这条「出路」永远走不到） */
  #broken = null;

  constructor(root) {
    this.#root = root;
    this.#dbPath = path.join(root, '任务蜂群', 'swarm-state.db');
    const dir = path.dirname(this.#dbPath);
    // 首次建库/迁移段串行化（毫秒级，仅首个进程真正建库）；业务写互斥不经过此锁
    const lockPath = acquireOpenLock(dir, this.#dbPath);
    try {
      this.#migrateLegacyJsonIfNeeded();
      this.#open();
    } finally {
      releaseOpenLock(lockPath);
    }
  }

  get dbPath() { return this.#dbPath; }
  get root() { return this.#root; }

  #open() {
    let db;
    this.#broken = null;
    try {
      db = new DatabaseSync(this.#dbPath);
    } catch (err) {
      // 典型场景：路径被文件占用 / 权限不足 / 文件不是合法 SQLite（前任工具写过）
      this.#broken = new Error(`状态库打开失败：${this.#dbPath}（${err?.message ?? err}）。下一步：确认目录可写、且该文件未被以独占方式占用；若文件已损坏，查看同目录 .corrupt-*.db 备份。`);
      return;
    }
    try {
      db.exec('PRAGMA journal_mode=WAL'); // 多进程并发读 + 崩溃恢复
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs()}`);
      db.exec('PRAGMA foreign_keys=ON');
      db.exec(SCHEMA_SQL);
      const v = db.prepare('SELECT value FROM meta WHERE key=?').get('schemaVersion')?.value;
      if (v === undefined) db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schemaVersion', String(SCHEMA_VERSION));
      else if (Number(v) > SCHEMA_VERSION) {
        throw new Error(`状态库 schema 版本（${v}）比当前插件（${SCHEMA_VERSION}）更新。下一步：升级 taskswarm 插件，不要用旧版本写新库。`);
      }
    } catch (err) {
      try { db.close(); } catch { /* ignore */ }
      const msg = String(err?.message ?? err);
      // 区分「真损坏」与「暂时性占用」（后者由 open-lock + busy_timeout 化解，重试即可）
      if (/BUSY|locked/i.test(msg) && !/corrupt|not a database|malformed/i.test(msg)) {
        this.#broken = new Error(`状态库暂时无法打开（可能正被其他进程初始化或扫描）：${this.#dbPath}（${msg}）。下一步：稍后重试；若反复出现，检查杀毒软件实时扫描是否锁住了该目录。`);
        return;
      }
      this.#broken = corruptionError(this.#dbPath, msg);
      return;
    }
    this.#db = db;
    this.#prepare();
  }

  /** 打开失败后的一切读写都给出同一个可行动错误（plan_reset 除外——它是出路） */
  #assertAlive() {
    if (this.#broken) throw this.#broken;
  }

  #prepare() {
    const cols = ['id', ...TASK_TEXT_FIELDS, ...TASK_INT_FIELDS.filter(k => k !== 'notesDropped'), 'notesDropped', ...TASK_JSON_FIELDS, 'sortOrder'];
    this.#insertTask = this.#db.prepare(
      `INSERT OR REPLACE INTO tasks(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`
    );
    this.#insertNote = this.#db.prepare('INSERT INTO notes(taskId,at,owner,note) VALUES(?,?,?,?)');
    this.#insertEvent = this.#db.prepare('INSERT INTO events(at,event,taskId,owner,detail) VALUES(?,?,?,?,?)');
  }

  /**
   * 2.2.0 迁移：首次在新库上操作时，若同目录存在旧 swarm-state.json，
   * 把它整体导入 SQLite 后改名为 .migrated-backup.json（保留现场，绝不删除）。
   */
  #migrateLegacyJsonIfNeeded() {
    const jsonFile = legacyJsonFile({ workspace: this.#root });
    if (!fs.existsSync(jsonFile)) return;
    if (fs.existsSync(this.#dbPath)) {
      // 库已存在还留着 JSON：说明上次迁移后 JSON 未清理，直接改名归档即可
      try { fs.renameSync(jsonFile, `${jsonFile}.migrated-backup.json`); } catch { /* ignore */ }
      return;
    }
    let raw;
    try { raw = fs.readFileSync(jsonFile, 'utf8'); }
    catch (err) { throw new Error(`迁移失败：旧状态文件读取失败 ${jsonFile}（${err?.message ?? err}）`); }
    if (raw.trim() === '') {
      try { fs.renameSync(jsonFile, `${jsonFile}.migrated-backup.json`); } catch { /* ignore */ }
      return;
    }
    let legacy;
    try { legacy = JSON.parse(raw); }
    catch (err) {
      // 旧文件已损坏：按 2.2.0 惯例备份后明确报错，不静默当「没有计划」
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${jsonFile}.corrupt-${stamp}.json`;
      try { fs.copyFileSync(jsonFile, backup); } catch { /* ignore */ }
      throw new Error(`迁移失败：旧状态文件已损坏，无法解析：${jsonFile}\n解析错误：${err.message}\n坏文件已备份为：${backup}\n可以用 plan_reset 清空后重新 plan_create。`);
    }
    // 先建空库再导入，导入与改名都成功才算迁移完成
    const db = new DatabaseSync(this.#dbPath);
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec(SCHEMA_SQL);
      db.exec('BEGIN IMMEDIATE');
      this.#persistSnapshot(db, legacy, { skipShapeCheck: false });
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schemaVersion', String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      try { fs.rmSync(this.#dbPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`迁移失败：旧状态导入 SQLite 时出错（${err?.message ?? err}）。旧文件未动，可修复后重试。`);
    }
    db.close();
    try { fs.renameSync(jsonFile, `${jsonFile}.migrated-backup.json`); } catch { /* ignore */ }
  }

  /** 把「2.2.0 同构的 state 对象」写进指定 db 连接（迁移与 state save 共用的导入原语） */
  #persistSnapshot(db, state, { skipShapeCheck = false } = {}) {
    if (!skipShapeCheck) assertStateShape(state);
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM events');
    db.exec("DELETE FROM meta WHERE key NOT IN ('schemaVersion')");
    const metaSet = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
    metaSet.run('phase', String(state.phase ?? 'swarming'));
    metaSet.run('goal', String(state.goal ?? ''));
    metaSet.run('failurePolicy', String(state.failurePolicy ?? DEFAULT_FAILURE_POLICY));
    metaSet.run('nextId', String(Number(state.nextId ?? 1) || 1));
    metaSet.run('rev', '1');
    if (state.createdAt) metaSet.run('createdAt', String(state.createdAt));
    const order = Array.isArray(state.order) ? state.order : [];
    let sort = 0;
    for (const id of order) {
      const t = state.tasks?.[id];
      if (!t || typeof t !== 'object') continue;
      // 2.2.0 旧数据没有 lastHeartbeat：迁移时以 claimedAt（其次 startedAt）为心跳基准，
      // 否则超时回收对「迁移后从未汇报」的在途任务永远不生效
      if (t.lastHeartbeat == null && (t.status === 'claimed' || t.status === 'in_progress')) {
        t.lastHeartbeat = t.claimedAt ?? t.startedAt ?? null;
      }
      const row = taskRowOf(t, sort++);
      this.#insertTaskWith(db, row);
      const notes = Array.isArray(t.notes) ? t.notes : [];
      for (const n of notes) {
        db.prepare('INSERT INTO notes(taskId,at,owner,note) VALUES(?,?,?,?)')
          .run(id, String(n?.at ?? new Date().toISOString()), String(n?.owner ?? '?'), String(n?.note ?? ''));
      }
    }
    const log = Array.isArray(state.log) ? state.log : [];
    for (const ev of log) {
      db.prepare('INSERT INTO events(at,event,taskId,owner,detail) VALUES(?,?,?,?,?)')
        .run(String(ev?.at ?? ''), String(ev?.event ?? ''), ev?.taskId ?? null, ev?.owner ?? null, ev?.detail ?? null);
    }
  }

  /** 在指定连接上写任务行（#insertTask 绑定在主连接上，迁移/恢复用的是临时连接） */
  #insertTaskWith(db, row) {
    const cols = ['id', ...TASK_TEXT_FIELDS, ...TASK_INT_FIELDS, ...TASK_JSON_FIELDS, 'sortOrder'];
    db.prepare(`INSERT OR REPLACE INTO tasks(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
      .run(...cols.map(c => row[c] ?? null));
  }

  /** 从表里重建与 2.2.0 JSON 同构的 state 对象；库为空（无 plan）返回 null */
  #loadAll() {
    const meta = {};
    for (const row of this.#db.prepare('SELECT key,value FROM meta').all()) meta[row.key] = row.value;
    if (meta.phase !== 'swarming') return null;
    const tasks = Object.create(null);
    const order = [];
    const rows = this.#db.prepare('SELECT * FROM tasks ORDER BY sortOrder ASC').all();
    const notesStmt = this.#db.prepare('SELECT at,owner,note FROM notes WHERE taskId=? ORDER BY id ASC');
    for (const row of rows) {
      tasks[row.id] = taskOfRow(row);
      tasks[row.id].notes = notesStmt.all(row.id).map(n => ({ at: n.at, owner: n.owner, note: n.note }));
      order.push(row.id);
    }
    // 内存只留最近 LOG_TAIL 条事件（recentEvents 展示够用）；全量在 events 表
    const logRows = this.#db.prepare('SELECT at,event,taskId,owner,detail FROM events ORDER BY id DESC LIMIT ?').all(LOG_TAIL);
    const log = logRows.reverse().map(r => ({ at: r.at, event: r.event, ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.owner ? { owner: r.owner } : {}), ...(r.detail ? { detail: r.detail } : {}) }));
    return {
      phase: 'swarming',
      goal: meta.goal ?? '',
      failurePolicy: meta.failurePolicy ?? DEFAULT_FAILURE_POLICY,
      nextId: Number(meta.nextId ?? 1) || 1,
      rev: Number(meta.rev ?? 1) || 1,
      ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
      tasks, order,
      log,
    };
  }

  /** 追加一条事件：内存 log（展示）+ events 表（审计，永不截断）。必须在事务内调用。 */
  #appendEvent(state, ev) {
    state.log.push(ev);
    this.#insertEvent.run(ev.at ?? new Date().toISOString(), String(ev.event ?? ''), ev.taskId ?? null, ev.owner ?? null, ev.detail ?? null);
  }

  /** 当前全局版本号（每次写事务自增；客户端轮询对比用） */
  rev() {
    this.#assertAlive();
    const r = this.#db.prepare("SELECT value FROM meta WHERE key='rev'").get()?.value;
    return Number(r ?? 1) || 1;
  }

  /**
   * 读-改-写临界区（对应 2.2.0 的 mutateState）：BEGIN IMMEDIATE 拿写锁 →
   * loadAll → fn(state) → persistMutated → COMMIT。fn 返回 {__save,__result} 约定不变。
   * 事件在 fn 期间经 #appendEvent 实时入库（增量，不随任务全量重写）。
   * busy（其他进程正在写）时由 busy_timeout 等待，超时抛可行动的中文错误。
   */
  mutate(args, fn) {
    this.#assertAlive();
    const db = this.#db;
    // BEGIN 阶段的瞬态错误重试：多进程同时开启写事务时，除 SQLITE_BUSY 外，
    // Windows 上偶发 disk I/O error（-shm 建立竞争/杀毒扫描窗口）——这些错误
    // 都发生在读到任何数据之前，短退避重试完全安全。
    let beginErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { db.exec('BEGIN IMMEDIATE'); beginErr = null; break; }
      catch (err) {
        const msg = String(err?.message ?? err);
        beginErr = err;
        if (!/BUSY|locked|disk I\/O/i.test(msg)) break; // 非瞬态错误重试无意义
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (attempt + 1)); } catch { /* 忙等兜底 */ }
      }
    }
    if (beginErr) {
      throw new Error(`状态库正被其他进程写入，重试后仍拿不到写锁（${beginErr?.message ?? beginErr}）。下一步：稍后重试；若频繁发生请检查是否有失控进程在频繁写状态。`);
    }
    let baseEventId = 0;
    try {
      baseEventId = this.lastEventId();
      const state = this.#loadAll();
      const out = fn(state);
      if (out?.__save !== undefined) this.#persistMutated(out.__save);
      const rev = this.rev();
      db.exec('COMMIT');
      this.#notifyWebhook(rev, baseEventId);
      this.#archiveEventsIfNeeded();
      return { result: out?.__result, rev };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * 常规写：任务/笔记全量重写（单蜂群数据规模下毫秒级），事件**增量**——
   * fn 期间经 #appendEvent 已实时入库，这里只重写任务与笔记并推进 meta/rev。
   */
  #persistMutated(state) {
    this.#db.exec('DELETE FROM tasks');
    this.#db.exec('DELETE FROM notes');
    const order = Array.isArray(state.order) ? state.order : [];
    const cols = ['id', ...TASK_TEXT_FIELDS, ...TASK_INT_FIELDS, ...TASK_JSON_FIELDS, 'sortOrder'];
    const ins = this.#db.prepare(`INSERT OR REPLACE INTO tasks(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`);
    let sort = 0;
    for (const id of order) {
      const t = state.tasks?.[id];
      if (!t) continue;
      const row = taskRowOf(t, sort++);
      ins.run(...cols.map(c => row[c] ?? null));
      for (const n of (Array.isArray(t.notes) ? t.notes : [])) {
        this.#insertNote.run(id, String(n?.at ?? ''), String(n?.owner ?? '?'), String(n?.note ?? ''));
      }
    }
    const metaSet = this.#db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
    metaSet.run('phase', 'swarming');
    metaSet.run('goal', String(state.goal ?? ''));
    metaSet.run('failurePolicy', String(state.failurePolicy ?? DEFAULT_FAILURE_POLICY));
    metaSet.run('nextId', String(Number(state.nextId ?? 1) || 1));
    metaSet.run('rev', String(this.rev() + 1));
  }

  /**
   * webhook 通知（可选）：TASKSWARM_WEBHOOK_URL 配置后，每次写事务提交
   * fire-and-forget POST {rev, events:[本事务新增事件]}（2s 超时，失败静默——
   * webhook 是增强通道不是依赖，失败不得影响主流程，也不允许把错误漏进 stdio）。
   * Web 控制台与外部集成以此实现近实时感知，弥补 MCP 拉取语义的延迟。
   */
  #notifyWebhook(rev, baseEventId) {
    const url = process.env.TASKSWARM_WEBHOOK_URL;
    if (!url || String(url).trim() === '') return;
    let events = [];
    try { events = this.eventsSince(baseEventId, 50); } catch { /* ignore */ }
    try {
      const body = JSON.stringify({ rev, events });
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
      });
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end(body);
    } catch { /* 静默：webhook 失败不影响主流程 */ }
  }

  /**
   * events 表归档治理（3.0.1）：append-only 是审计承诺，但长期运行的库会无限膨胀。
   * 超过 TASKSWARM_MAX_EVENTS（默认 5000）时，把最旧的溢出部分导出为
   * events-archive-<序号>.jsonl（每份最多 maxEvents 行封顶，剩余留下轮渐进收敛），
   * 再从库内删除；meta.eventsDroppedTotal 记账（总数 = 库内现存 + 累计归档）。
   *
   * 原子性与并发：
   *   - 先写文件成功再 DELETE——文件写失败则静默跳过本轮（绝不阻断主写、绝不丢事件）；
   *   - events-archive.lock 轻量锁防两进程同时归档产生重复行（含 pid 存活探测），
   *     等不到锁就跳过本轮——归档是治理不是依赖，下一笔写操作会再触发。
   * 触发点：mutate() 与 planCreate() 的事务提交之后（事务外执行，不占用写锁）。
   */
  #archiveEventsIfNeeded() {
    if (this.#broken) return;
    try {
      const cap = maxEvents();
      const total = Number(this.#db.prepare('SELECT COUNT(*) c FROM events').get()?.c ?? 0);
      if (!(total > cap)) return;
      const lockPath = this.#dbPath + '.archive-lock';
      if (!this.#tryArchiveLock(lockPath)) return; // 等不到锁：跳过本轮，下次写再治理
      try {
        // 锁内复查（另一进程可能刚归档完）
        const inLib = Number(this.#db.prepare('SELECT COUNT(*) c FROM events').get()?.c ?? 0);
        const overflow = inLib - cap;
        if (overflow <= 0) return;
        const exportLimit = Math.min(overflow, cap); // 单份文件容量 = maxEvents 行
        const rows = this.#db.prepare(
          'SELECT id,at,event,taskId,owner,detail FROM events ORDER BY id ASC LIMIT ?'
        ).all(exportLimit);
        if (rows.length === 0) return;

        // 归档文件采用追加语义：写到「当前最大序号」文件里，装满 cap 行才开新序号——
        // 否则每笔写事务溢出一条就建一个新文件，序号会爆炸。
        const dir = path.dirname(this.#dbPath);
        let maxSeq = 0;
        try {
          for (const name of fs.readdirSync(dir)) {
            const m = /^events-archive-(\d+)\.jsonl$/.exec(name);
            if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
          }
        } catch { /* 目录读取失败按无归档处理 */ }
        let targetFile = null;
        let append = false;
        if (maxSeq > 0) {
          const candidate = path.join(dir, `events-archive-${maxSeq}.jsonl`);
          try {
            const lineCount = fs.readFileSync(candidate, 'utf8').split('\n').filter(l => l.trim() !== '').length;
            if (lineCount < cap) { targetFile = candidate; append = true; }
          } catch { /* 文件不可读则开新序号 */ }
        }
        if (!targetFile) targetFile = path.join(dir, `events-archive-${maxSeq + 1}.jsonl`);
        const body = rows.map(r => JSON.stringify({
          id: r.id, at: r.at, event: r.event,
          taskId: r.taskId ?? null, owner: r.owner ?? null, detail: r.detail ?? null,
        })).join('\n') + '\n';
        if (append) fs.appendFileSync(targetFile, body, 'utf8');
        else fs.writeFileSync(targetFile, body, 'utf8');

        const lastId = rows[rows.length - 1].id;
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          this.#db.prepare('DELETE FROM events WHERE id <= ?').run(lastId);
          const prev = Number(this.#db.prepare("SELECT value FROM meta WHERE key='eventsDroppedTotal'").get()?.value ?? 0);
          this.#db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
            .run('eventsDroppedTotal', String(prev + rows.length));
          this.#db.exec('COMMIT');
        } catch (err) {
          try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
          throw err;
        }
      } finally {
        try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 静默：归档是治理不是依赖，任何失败都不阻断主写（事件仍安全在库内） */ }
  }

  /**
   * 归档专用轻量锁：wx 原子创建 + 持锁进程存活探测（ESRCH 立即抢占）+ mtime 超龄抢占。
   * 与 acquireOpenLock 的区别：等不到就放弃（返回 false）而不是长等——归档可推迟。
   */
  #tryArchiveLock(lockPath) {
    const deadline = Date.now() + 1500;
    for (;;) {
      let fd = -1;
      try {
        fd = fs.openSync(lockPath, 'wx');
        try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() })); } catch { /* ignore */ }
        try { fs.closeSync(fd); } catch { /* ignore */ }
        return true;
      } catch (err) {
        if (err?.code !== 'EEXIST') return false; // 创建失败（权限等）：放弃本轮
        let stale = false;
        try {
          const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          const pid = Number(info?.pid);
          const sameHost = String(info?.host ?? '') === os.hostname();
          if (Number.isFinite(pid) && pid > 0 && sameHost && pid !== process.pid) {
            try { process.kill(pid, 0); } catch (e) { stale = e?.code === 'ESRCH'; }
          }
        } catch { /* 解析失败交给 mtime */ }
        if (!stale) {
          try { if (Date.now() - fs.statSync(lockPath).mtimeMs > 30000) stale = true; }
          catch { /* 锁刚被释放，重试 */ }
        }
        if (stale) {
          try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
          continue;
        }
        if (Date.now() >= deadline) return false;
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
        catch { const end = Date.now() + 50; while (Date.now() < end) { /* 忙等兜底 */ } }
      }
    }
  }

  /**
   * 惰性超时回收：claimed/in_progress 且 lastHeartbeat 早于 cutoff 的任务，
   * 自动回 pending（清 owner/claimedAt/startedAt/finishedAt/lastHeartbeat）并记
   * 「超时回收」审计事件。无推送架构下的失联自愈：不新增工具，任何写操作路过时
   * 顺手回收（server.mjs 在每次 tools/call 前调用）。
   * TASKSWARM_STALE_MINUTES=0 禁用。迁移来的旧数据以 claimedAt 作为心跳基准。
   */
  reclaimStale() {
    if (this.#broken) return 0; // 库不可用时无事可收，让真正读写的入口去抛可行动错误
    const minutes = staleMinutes();
    if (!(minutes > 0)) return 0;
    const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
    const due = this.#db.prepare(
      "SELECT id, owner, status FROM tasks WHERE status IN ('claimed','in_progress') AND lastHeartbeat IS NOT NULL AND lastHeartbeat < ?"
    ).all(cutoff);
    if (due.length === 0) return 0;
    const { result } = this.mutate({}, (state) => {
      if (!state) return { __result: null };
      const now = new Date().toISOString();
      for (const d of due) {
        const t = hasTask(state, d.id) ? state.tasks[d.id] : null;
        if (!t) continue;
        if (t.status !== 'claimed' && t.status !== 'in_progress') continue; // 事务内复查（可能刚被并发改掉）
        if (t.lastHeartbeat && t.lastHeartbeat >= cutoff) continue;
        t.status = 'pending';
        t.owner = null;
        t.claimedAt = null;
        t.startedAt = null;
        t.finishedAt = null;
        t.lastHeartbeat = null;
        this.#appendEvent(state, {
          at: now, event: '超时回收', taskId: d.id, owner: d.owner ?? null,
          detail: `状态 ${d.status} 超过 ${minutes} 分钟无心跳（TASKSWARM_STALE_MINUTES），自动置回 pending 允许重新领取`,
        });
      }
      return { __save: state, __result: due.length };
    });
    return result ?? 0;
  }

  /** 只读加载（board/plan_get/task_ready/task_notes/state load） */
  load() { this.#assertAlive(); return this.#loadAll(); }

  // ------------------------------------------------------------------
  // 业务工具（与 2.2.0 行为一致；差异见各方法注释）
  // ------------------------------------------------------------------

  planCreate(args) {
    this.#assertAlive();
    const goal = String(args?.goal ?? '').trim();
    if (goal === '') throw new Error('plan_create: goal 不能为空。下一步：在入参里补上总目标字符串，例如 {"goal":"交付登录模块","tasks":[...]}。');
    const tasksIn = args?.tasks;
    if (tasksIn === undefined || tasksIn === null) throw new Error('plan_create: tasks 不能为空。下一步：传入顶级任务数组，例如 {"tasks":[{"title":"接口设计"}]}。');
    if (!Array.isArray(tasksIn)) {
      throw new Error(`plan_create: tasks 必须是数组（当前类型：${typeof tasksIn}）。下一步：改为 [{"title":"..."}] 形式。`);
    }
    if (tasksIn.length === 0) throw new Error('plan_create: tasks 不能为空数组。下一步：至少提供一个顶级任务 {"title":"..."}。');
    const failurePolicy = args?.failurePolicy === undefined ? DEFAULT_FAILURE_POLICY : String(args.failurePolicy);
    if (!FAILURE_POLICIES.includes(failurePolicy)) {
      throw new Error(`plan_create: failurePolicy 只能是 "block" 或 "proceed"（收到 "${failurePolicy}"）。下一步：block=上游失败则挡住下游（默认），proceed=照常放行并在 task_ready 里用 blockedBy 标注。`);
    }

    // 纯计算（建树/校验）放在事务外，缩短写锁持有时间——与 2.2.0 的锁外建树同理
    const state = {
      phase: 'swarming',
      goal,
      failurePolicy,
      createdAt: new Date().toISOString(),
      tasks: Object.create(null),
      order: [],
      nextId: 1,
      log: [],
      rev: 1,
    };
    function nextAutoId() {
      let id;
      do { id = `T${state.nextId++}`; } while (hasTask(state, id));
      return id;
    }
    const idMap = new Map();
    const depMap = new Map();
    const autoIds = new Set();

    function addTask(t, parent, depth) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        const kind = t === null ? 'null' : Array.isArray(t) ? 'array' : typeof t;
        throw new Error(`plan_create: 任务项必须是对象（当前类型：${kind}）。下一步：写成 {"title":"任务名"} 形式。`);
      }
      if (depth >= MAX_SUBTASK_DEPTH) {
        throw new Error(
          `plan_create: 任务树深度超过上限 ${MAX_SUBTASK_DEPTH} 层（第 ${depth + 1} 层还有任务${parent ? `，位于 ${parent} 之下` : ''}）。` +
          '下一步：把更深的拆解写进该任务的 detail/note，或让子代理执行中途用 task_add 追加。'
        );
      }
      const title = String(t.title ?? '').trim();
      if (title === '') throw new Error('plan_create: 每个任务都必须有 title。下一步：为该任务补上 title 字段。');
      let id;
      if (t.id === undefined || t.id === null || String(t.id).trim() === '') {
        id = nextAutoId();
        autoIds.add(id);
      } else {
        id = assertValidId(String(t.id).trim(), 'plan_create');
        if (hasTask(state, id)) {
          throw new Error(
            `plan_create: 显式 id ${id} 与自动编号冲突，请改写 id 或为所有任务显式指定 id` +
            `（${autoIds.has(id) ? `该 id 已由前面的无 id 任务自动编号占用` : `该 id 已被前序任务占用`}）。` +
            `下一步：把此任务改成如 "${id}-2"，或给全部任务都写上唯一 id。`
          );
        }
      }
      state.tasks[id] = {
        id, title,
        detail: String(t.detail ?? '').trim(),
        dependsOn: [],
        parent: parent ?? null,
        depth,
        children: [],
        status: 'pending',
        owner: null,
        role: normalizeRole(t.role),
        reviewer: normalizeReviewer(t.reviewer),
        assignee: normalizeAssignee(t.assignee),
        reviewStage: 'none',
        notes: [],
        lastHeartbeat: null,
        costTokens: 0,
        costMinutes: 0,
        createdAt: new Date().toISOString(),
      };
      state.order.push(id);
      depMap.set(id, t);
      if (parent !== null) state.tasks[parent].children.push(id);

      const subs = t.subtasks;
      if (subs !== undefined && subs !== null) {
        if (!Array.isArray(subs)) {
          throw new Error(`plan_create: 任务 ${id} 的 subtasks 必须是数组（当前类型：${typeof subs}）。下一步：改为 [{"title":"子任务"}] 或删掉该字段。`);
        }
        if (subs.length > 0 && depth + 1 >= MAX_SUBTASK_DEPTH) {
          throw new Error(
            `plan_create: 任务树深度超过上限 ${MAX_SUBTASK_DEPTH} 层（任务 ${id} 已处于第 ${depth + 1} 层，其下还有 ${subs.length} 个子任务）。` +
            '下一步：把更深的拆解写进该任务的 detail/note，或让子代理执行中途用 task_add 追加。'
          );
        }
        for (const sub of subs) addTask(sub, id, depth + 1);
      }
      return id;
    }
    for (const t of tasksIn) addTask(t, null, 0);
    for (const id of state.order) {
      state.tasks[id].dependsOn = normalizeDeps(depMap.get(id), `plan_create: 任务 ${id}`);
    }
    for (const id of state.order) {
      assertDepsResolvable(state, id, state.tasks[id].dependsOn, 'plan_create');
    }
    detectCycle(state);
    // 审计起点：计划创建必须落「计划创建」事件（2.2.0 即有，3.0 重写时遗漏）——
    // webhook 的 events:[本事务新增事件] 依赖它非空，事件流/看板也需要计划起点
    state.log.push({ at: state.createdAt ?? new Date().toISOString(), event: '计划创建', detail: `${state.order.length} 个任务，目标：${goal}` });
    // 计划创建是「整体覆盖」语义：清库重建（取代 2.2.0 的整文件替换）
    const db = this.#db;
    try {
      db.exec('BEGIN IMMEDIATE');
      this.#persistSnapshot(db, state, { skipShapeCheck: true });
      db.exec('COMMIT');
      this.#notifyWebhook(this.rev(), 0);
      this.#archiveEventsIfNeeded();
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return { result: { ok: true, file: this.dbPath, taskCount: state.order.length, failurePolicy, plan: planView(state) }, rev: this.rev() };
  }

  planGet(args) {
    const state = ensureState(this.load());
    const withNotes = state.order.map(id => (hasTask(state, id) ? state.tasks[id] : null))
      .filter(t => t && notesOf(t).length + notesDroppedOf(t) > 0);
    return { result: {
      phase: state.phase,
      goal: state.goal,
      failurePolicy: failurePolicyOf(state),
      ready: readyList(state).map(t => t.id),
      view: planView(state),
      // recentEvents 里的进展笔记只保留前 120 字符（有意为之：全量返回会灌爆上下文）
      recentEvents: state.log.slice(-15),
      ...(withNotes.length > 0 ? { notesHint: `以上 recentEvents 的备注只截前 120 字符；读笔记全文请用 task_notes(taskId, limit≤200, offset)，例如 {"taskId":"${withNotes[0].id}"}。` } : {}),
    }, rev: state.rev };
  }

  planReset() {
    // 清空 = 锁内删库文件重建（而非在现有连接上清表）。
    // 原因：plan_reset 是「损坏恢复的出路」（corruptionError 的指引），而损坏库
    // 可能连打开都失败——清表路径会先于清空动作报同样的错，出路就走不通了。
    // 删除后立即重建空库，语义与 2.2.0 的 unlink 等价。
    const dir = path.dirname(this.#dbPath);
    const lockPath = acquireOpenLock(dir, this.#dbPath);
    try {
      this.close();
      for (const suffix of ['', '-wal', '-shm']) {
        let lastErr = null;
        for (let i = 0; i < 4; i++) {
          try { fs.rmSync(this.#dbPath + suffix, { force: true }); lastErr = null; break; }
          catch (e) { lastErr = e; try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch { /* 忙等兜底 */ } }
        }
        if (lastErr) {
          throw new Error(`plan_reset: 无法删除旧状态库 ${this.#dbPath}${suffix}（${lastErr.message}）。下一步：确认没有其他进程正占用该文件后重试。`);
        }
      }
      this.#open();
    } finally {
      releaseOpenLock(lockPath);
    }
    return { result: { ok: true, cleared: this.dbPath }, rev: this.rev() };
  }

  taskReady(args) {
    const state = ensureState(this.load());
    const policy = failurePolicyOf(state);
    return { result: {
      ready: readyList(state).map(t => {
        const blockedBy = blockingDeps(state, t); // proceed 策略下才有值
        return {
          id: t.id, title: t.title, detail: t.detail, parent: t.parent,
          ...(t.assignee ? { assignee: t.assignee } : {}),
          ...(blockedBy.length > 0 ? { blockedBy } : {}),
        };
      }),
      failurePolicy: policy,
    }, rev: state.rev };
  }

  taskClaim(args) {
    return this.mutate(args, (state) => {
      const s = ensureState(state);
      if (args?.taskId === undefined || args?.taskId === null) {
        throw new Error('task_claim: 缺少 taskId。下一步：传入要领取的任务 id，例如 {"taskId":"T1","owner":"agent-1"}。');
      }
      if (args?.owner === undefined || args?.owner === null) {
        throw new Error('task_claim: 缺少 owner（子代理标识）。下一步：传入你的标识，例如 {"taskId":"T1","owner":"agent-1"}。');
      }
      const taskId = requireString(args.taskId, 'task_claim: taskId').trim();
      const owner = requireString(args.owner, 'task_claim: owner').trim();
      if (owner === '') throw new Error('task_claim: owner（子代理标识）不能为空。下一步：传入如 "agent-1" 的标识。');
      const t = findTask(s, taskId);
      if (!depsSatisfied(s, t)) {
        const pendingDeps = depsOf(t).filter(id => !(hasTask(s, id) && DONE_LIKE.has(s.tasks[id].status)));
        throw new Error(`task_claim: ${taskId} 依赖未完成，不能领取（未完成：${pendingDeps.join(', ')}）。下一步：先等上游任务置 done，或由主代理调整依赖。`);
      }
      const blocked = blockingDeps(s, t);
      if (failurePolicyOf(s) === 'block' && blocked.length > 0) {
        throw new Error(`task_claim: ${taskId} 的上游 ${blocked.join(', ')} 已失败/跳过，按 failurePolicy=block 已阻断，不能领取。下一步：由主代理用 task_update(force:true) 把该任务置回 pending 并调整依赖，或重建计划时用 failurePolicy:"proceed"。`);
      }
      if (t.status === 'claimed' || t.status === 'in_progress') throw new Error(`task_claim: ${taskId} 已被 ${t.owner ?? '(未知)'} 领取（状态 ${t.status}）。下一步：换一个任务；若确认该 owner 已失联，由主代理 task_update(force:true) 置回 pending（会记 log）。`);
      if (t.status !== 'pending') throw new Error(`task_claim: ${taskId} 状态为 ${t.status}，只有 pending 可领取。下一步：用 board 查看该任务当前状态。`);
      t.status = 'claimed';
      t.owner = owner;
      t.claimedAt = new Date().toISOString();
      t.lastHeartbeat = t.claimedAt; // 领取即第一次心跳（超时回收的计时起点）
      this.#appendEvent(s, { at: t.claimedAt, event: '领取', taskId, owner });
      // 返回体带全量笔记与归属上下文：子代理领取即拿到上游结论，不必二次查询（2.2.0 缺陷②修复）
      const blockedBy = blockingDeps(s, t);
      return { __save: s, __result: {
        ok: true,
        task: {
          id: t.id, title: t.title, detail: t.detail, dependsOn: depsOf(t),
          status: t.status, owner: t.owner, parent: t.parent, role: t.role,
          ...(t.assignee ? { assignee: t.assignee } : {}),
          ...(t.reviewer ? { reviewer: t.reviewer } : {}),
          ...(blockedBy.length > 0 ? { blockedBy } : {}),
          notes: notesOf(t).map(n => ({ at: n.at, owner: n.owner, note: n.note })),
        },
      } };
    });
  }

  taskUpdate(args) {
    return this.mutate(args, (state) => {
      const s = ensureState(state);
      if (args?.taskId === undefined || args?.taskId === null) {
        throw new Error('task_update: 缺少 taskId。下一步：传入任务 id，例如 {"taskId":"T1","status":"done","owner":"agent-1"}。');
      }
      const taskId = requireString(args.taskId, 'task_update: taskId').trim();
      const t = findTask(s, taskId);
      const actor = args?.owner === undefined || args?.owner === null ? '' : requireString(args.owner, 'task_update: owner').trim();
      const force = args?.force === true;
      let released = false;
      let mutated = false;

      if (args?.status !== undefined && args?.status !== null) {
        const stat = requireString(args.status, 'task_update: status').trim();
        if (!TASK_STATUSES.includes(stat)) {
          throw new Error(`task_update: 非法状态 "${stat}"，可用: ${TASK_STATUSES.join('/')}。下一步：改用其中一个合法状态。`);
        }
        const from = t.status;
        if (stat !== from) {
          const prevOwner = t.owner;
          const effective = (stat === 'done' && t.reviewer && t.reviewStage !== 'approved') ? 'pending_review' : stat;
          const allowed = ALLOWED_TRANSITIONS[from] ?? [];
          const ownerKnown = t.owner !== null && t.owner !== undefined;
          const isOwner = ownerKnown && actor !== '' && t.owner === actor;
          const terminalRollback = TERMINAL.has(from) && !TERMINAL.has(effective);
          // reviewer 本人对 done/skipped 的回退是审核裁决，等同 owner 权限（且 owner 校验必须放行它）
          const reviewerRollback = terminalRollback && (from === 'done' || from === 'skipped')
            && t.reviewer && actor !== '' && t.reviewer === actor;
          const ownerOk = !ownerKnown || isOwner || reviewerRollback;

          if (!force) {
            if (!ownerOk) {
              throw new Error(`task_update: 任务 ${taskId} 当前 owner 是 ${t.owner}，你以 ${actor || '(未提供 owner)'} 身份无权改状态。下一步：由 owner 本人汇报，或主代理用 task_update(force:true) 接管（会记 log）。`);
            }
            // 终态回退的权限（3.0 收紧，修复 2.2.0 缺陷④「任何自称 owner 者可唤醒 done」）：
            //   done/skipped → pending 仅 reviewer 本人可执行（重做/复活的裁决权在审核方），
            //   failed → pending 仍允许 owner（失败重试是 producer 的合理动作）。
            if (terminalRollback && !isOwner && !reviewerRollback) {
              throw new Error(`task_update: 任务 ${taskId} 已处于终态 ${from}，只有 owner 能回退（当前 owner：${t.owner ?? '(无)'}，你：${actor || '(未提供 owner)'}）。下一步：由当前 owner 回退，或主代理用 task_update(force:true) 强制回退（会记 log）。`);
            }
            if (terminalRollback && (from === 'done' || from === 'skipped') && t.reviewer && !reviewerRollback) {
              throw new Error(`task_update: 任务 ${taskId} 曾经过审核门（reviewer=${t.reviewer}），${from} → pending 的回退只能由 reviewer 本人执行或由主代理 force。下一步：由 ${t.reviewer} 回退，或主代理用 task_update(force:true)（会记 log）。`);
            }
            if (!allowed.includes(effective)) {
              throw new Error(`task_update: 不允许的状态转移 ${from} → ${effective}（任务 ${taskId}）。合法后继: ${allowed.join('/') || '(无，终态)'}。下一步：改用合法状态；会话中断恢复等特殊场景由主代理用 force:true。`);
            }
          } else if (actor === '') {
            throw new Error(`task_update: force 必须由主代理显式操作，需同时提供 owner。下一步：写成 {"taskId":"${taskId}","status":"${stat}","owner":"main","force":true}。`);
          }

          t.status = effective;
          mutated = true;
          t.lastHeartbeat = new Date().toISOString(); // 状态转移即心跳
          if (effective === 'in_progress' && !t.startedAt) t.startedAt = new Date().toISOString();
          if (effective === 'pending') { // 回退到 pending：清掉领取痕迹，允许重新派发
            t.owner = null;
            t.claimedAt = null;
            t.startedAt = null;
            t.finishedAt = null;
            t.lastHeartbeat = null;
            released = true;
          }
          if (effective === 'claimed') t.claimedAt = t.lastHeartbeat;

          if (effective === 'pending_review') {
            t.reviewStage = 'pending';
            t.submittedAt = new Date().toISOString();
            this.#appendEvent(s, {
              at: t.submittedAt, event: '待审核', taskId, owner: t.owner,
              detail: `producer 已交活，等待 reviewer=${t.reviewer} 裁决（下游保持阻断直到通过）`,
            });
          }
          if (DONE_LIKE.has(effective)) {
            t.finishedAt = new Date().toISOString();
            if (effective === 'done' && t.reviewer) t.reviewStage = 'approved';
            this.#appendEvent(s, { at: t.finishedAt, event: effective === 'failed' ? '失败' : effective === 'skipped' ? '跳过' : '完成', taskId, owner: prevOwner ?? t.owner });
          }
          if (stat !== effective) {
            this.#appendEvent(s, {
              at: new Date().toISOString(), event: '审核门拦截', taskId, owner: actor,
              detail: `请求 done 但该任务指定了 reviewer=${t.reviewer}，改道 pending_review`,
            });
          }
          if (force) {
            this.#appendEvent(s, {
              at: new Date().toISOString(), event: '强制改状态', taskId, owner: actor,
              detail: `${from} → ${stat}；原 owner=${prevOwner ?? '(无)'}${terminalRollback ? '；终态回退' : ''}`,
            });
          }
        }
      } else if (args?.status !== undefined) {
        throw new Error('task_update: status 不能为 null。下一步：省略该字段只写 note，或传合法状态字符串。');
      }

      if (args?.note !== undefined && args?.note !== null) {
        const note = requireString(args.note, 'task_update: note').trim();
        if (note !== '') {
          const appended = appendNote(t, note, actor || String(t.owner ?? '?'));
          // 写笔记也是心跳（子代理埋头干活时的唯一周期性动作就是汇报进展）
          if (!t.lastHeartbeat || t.status === 'claimed' || t.status === 'in_progress') {
            t.lastHeartbeat = new Date().toISOString();
          }
          this.#appendEvent(s, { at: new Date().toISOString(), event: '进展', taskId, owner: actor || t.owner, detail: appended.text.slice(0, 120) });
          if (appended.dropped > 0) {
            this.#appendEvent(s, {
              at: new Date().toISOString(), event: '笔记超限丢弃', taskId, owner: actor || t.owner,
              detail: `笔记数超过上限 ${maxNotes()}，丢弃最旧 ${appended.dropped} 条（累计丢弃 ${notesDroppedOf(t)} 条）；全文走 task_notes 读取`,
            });
          }
          mutated = true;
        }
      }
      // 成本钩子（3.0 新增，可选）：宿主愿报就累加，board 做汇总。非法值直接拒绝，不静默归零。
      if (args?.cost !== undefined && args?.cost !== null) {
        const c = args.cost;
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
          throw new Error(`task_update: cost 必须是对象（当前类型：${Array.isArray(c) ? 'array' : typeof c}）。下一步：写成 {"cost":{"tokens":1234,"minutes":5}} 或省略该字段。`);
        }
        const addNum = (v, label, acc) => {
          if (v === undefined || v === null || v === '') return;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error(`task_update: cost.${label} 必须是非负数字（收到 "${String(v)}"）。下一步：传累计量（如本次消耗的 token 数），或省略该字段。`);
          }
          t[acc] = (t[acc] ?? 0) + Math.round(n);
        };
        addNum(c.tokens, 'tokens', 'costTokens');
        addNum(c.minutes, 'minutes', 'costMinutes');
        mutated = true;
      }

      // owner 归属（3.0 修正 2.2.0 缺陷③）：归属只来自 claim 与**状态转移**；
      // 写笔记/报成本这类「留言式」动作不再夺取无主任务的所有权（留言者如实记入事件流）。
      if (actor !== '' && !released && mutated && args?.status !== undefined && args?.status !== null
        && (t.owner === null || t.owner === undefined || force)) {
        t.owner = actor;
      }
      return {
        __save: s,
        __result: {
          ok: true,
          task: {
            id: t.id, status: t.status, owner: t.owner,
            notesCount: notesOf(t).length,
            notesDropped: notesDroppedOf(t),
            ...(t.costTokens > 0 || t.costMinutes > 0 ? { cost: { tokens: t.costTokens, minutes: t.costMinutes } } : {}),
            ...(notesDroppedOf(t) > 0 ? { notesHint: `该任务历史上有 ${notesDroppedOf(t)} 条笔记因超过 ${maxNotes()} 条上限被丢弃（保留最新）；当前 ${notesOf(t).length} 条全文可用 task_notes 分页读回。` } : {}),
          },
        },
      };
    });
  }

  taskAdd(args) {
    return this.mutate(args, (state) => {
      const s = ensureState(state);
      const id = this.#addTaskNode(s, args, 'task_add');
      return { __save: s, __result: { ok: true, taskId: id } };
    });
  }

  taskNotes(args) {
    const state = ensureState(this.load());
    const rawId = args?.taskId;
    if (rawId === undefined || rawId === null) {
      throw new Error('task_notes: 缺少 taskId。下一步：传入要读笔记的任务 id，例如 {"taskId":"T1","limit":20,"offset":0}（id 可用 plan_get / board 查看）。');
    }
    const taskId = requireString(rawId, 'task_notes: taskId').trim();
    const t = findTask(state, taskId);

    const limit = requirePageInt(args?.limit, 'limit', { fallback: NOTES_LIMIT_DEFAULT, max: NOTES_LIMIT_MAX });
    if (limit < 1) {
      throw new Error('task_notes: limit 必须 ≥ 1（收到 0）。下一步：改为 1..200 之间的整数，或省略该字段用默认值 20；只想看有没有笔记可先看 total。');
    }
    const offset = requirePageInt(args?.offset, 'offset', { fallback: 0 });

    const all = notesOf(t);
    const total = all.length;
    const dropped = notesDroppedOf(t);
    const end = Math.max(0, total - offset);
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end).map(n => ({ at: n?.at ?? null, owner: n?.owner ?? null, note: String(n?.note ?? '') }));

    return { result: {
      taskId: t.id,
      total,
      notesDropped: dropped,
      offset,
      limit,
      returned: page.length,
      hasMore: start > 0,
      ...(dropped > 0 ? { hint: `该任务历史上有 ${dropped} 条最旧笔记因超过上限 ${maxNotes()} 条被丢弃（未静默丢失，计数见 notesDropped）。` } : {}),
      ...(page.some(n => n.note.includes(TRUNCATED_MARK)) ? { truncatedHint: `部分笔记单条超过 ${maxNoteChars()} 字符，已截断并标记 "${TRUNCATED_MARK}"。` } : {}),
      ...(start > 0 ? { pageHint: `还有更早的 ${start} 条（本页是最新的第 ${offset + 1}..${offset + page.length} 条）。下一步：以 offset=${offset + limit} 再读一页。` } : {}),
      notes: page,
    }, rev: state.rev };
  }

  taskReview(args) {
    return this.mutate(args, (state) => {
      const s = ensureState(state);
      if (args?.taskId === undefined || args?.taskId === null) {
        throw new Error('task_review: 缺少 taskId。下一步：传入要裁决的任务 id，例如 {"taskId":"T1","verdict":"approve","owner":"wersky/agent-3"}。');
      }
      const taskId = requireString(args.taskId, 'task_review: taskId').trim();
      const t = findTask(s, taskId);
      const actor = args?.owner === undefined || args?.owner === null ? '' : requireString(args.owner, 'task_review: owner').trim();
      const verdict = requireString(args?.verdict, 'task_review: verdict').trim().toLowerCase();
      const force = args?.force === true;

      if (!['approve', 'reject'].includes(verdict)) {
        throw new Error(`task_review: verdict 必须是 approve 或 reject（收到 "${args?.verdict}"）。下一步：approve=通过，reject=打回重做。`);
      }
      if (!t.reviewer) {
        throw new Error(`task_review: 任务 ${taskId} 没有指定 reviewer，不存在审核门。下一步：任务直接由 owner 用 task_update 置 done 即可；若确需审核，请重建该任务并在 plan_create/task_add 时指定 reviewer 字段。`);
      }
      if (!force && actor === '') {
        throw new Error(`task_review: 缺少 owner。下一步：传入裁决者身份，必须与任务上登记的 reviewer（${t.reviewer}）一致。`);
      }
      if (!force && actor !== t.reviewer) {
        throw new Error(`task_review: 任务 ${taskId} 登记的 reviewer 是 ${t.reviewer}，你以 ${actor || '(未提供 owner)'} 身份无权裁决。下一步：由 ${t.reviewer} 裁决，或主代理用 force:true 代裁（会记 log）。`);
      }
      if (t.status !== 'pending_review') {
        throw new Error(`task_review: 任务 ${taskId} 当前状态是 ${t.status}，不在待审核（pending_review）。下一步：${t.status === 'in_progress' || t.status === 'pending' || t.status === 'claimed' ? '等 producer 交活（置 done）后系统会自动转入待审核' : '用 plan_get / board 查看当前状态'}。`);
      }

      const now = new Date().toISOString();
      const proposals = verdict === 'approve' ? normalizeProposals(args?.proposals, 'task_review') : [];
      if (verdict === 'approve') {
        t.status = 'done';
        t.reviewStage = 'approved';
        t.finishedAt = now;
        t.reviewedAt = now;
        t.reviewedBy = actor || t.reviewer;
        this.#appendEvent(s, { at: now, event: '审核通过', taskId, owner: actor || t.reviewer, detail: `下游随之放行（reviewer=${t.reviewer}）` });
      } else {
        const reason = String(args?.reason ?? '').trim();
        if (reason === '') {
          throw new Error(`task_review: reject 必须给 reason（写明要改什么）。下一步：{"taskId":"${taskId}","verdict":"reject","reason":"具体问题","owner":"${t.reviewer}"}。`);
        }
        t.status = 'in_progress';
        t.reviewStage = 'rejected';
        t.reviewedAt = now;
        t.reviewedBy = actor || t.reviewer;
        t.finishedAt = null;
        // 只写内存：驳回笔记随 #persistMutated 统一落库（此处直接 INSERT 会与全量重写重复）
        t.notes.push({ at: now, owner: actor || t.reviewer, note: `【审核驳回】${reason}` });
        this.#appendEvent(s, { at: now, event: '审核驳回', taskId, owner: actor || t.reviewer, detail: `打回重做，下游保持阻断：${reason.slice(0, 120)}` });
      }
      if (force && actor !== t.reviewer) {
        this.#appendEvent(s, { at: now, event: '强制裁决', taskId, owner: actor, detail: `原 reviewer=${t.reviewer}，verdict=${verdict}` });
      }

      const adoptedIds = [];
      if (proposals.length > 0) {
        for (const spec of proposals) {
          adoptedIds.push(this.#addTaskNode(s, spec, `task_review: proposals[${adoptedIds.length}]`));
        }
        const at = new Date().toISOString();
        this.#appendEvent(s, { at, event: '采纳提案', taskId, owner: actor || t.reviewer, detail: `新增 ${adoptedIds.join(', ')}（由 ${taskId} 的审核通过带出）` });
      }

      return {
        __save: s,
        __result: {
          ok: true,
          task: { id: t.id, status: t.status, reviewStage: t.reviewStage, reviewer: t.reviewer, reviewedBy: actor || t.reviewer },
          adopted: { count: adoptedIds.length, ids: adoptedIds },
          hint: verdict === 'approve'
            ? (adoptedIds.length > 0
              ? `已通过，下游依赖该任务的任务现在可以派发；并已采纳 ${adoptedIds.length} 条提案（${adoptedIds.join(', ')}），它们已进入任务树等待派发。`
              : '已通过，下游依赖该任务的任务现在可以派发。')
            : '已打回，任务回到 in_progress；producer 看到驳回理由后重做，再次交活会重新进入待审核。',
        },
      };
    });
  }

  board(args) {
    const state = this.load();
    if (!state) return { result: { active: false }, rev: this.rev() };
    assertStateShape(state);
    const filterOwner = String(args?.owner ?? '').trim();
    const lines = [];
    for (const id of state.order) {
      const t = hasTask(state, id) ? state.tasks[id] : null;
      if (!t) continue;
      if (filterOwner && t.owner !== filterOwner) continue;
      const depth = t.parent ? (t.depth ?? 1) : 0;
      const indent = depth > 0 ? '  '.repeat(depth) + '└ ' : '';
      const owner = t.owner ? ` @${t.owner}` : '';
      // 3.0（修复 2.2.0 缺陷①）：每任务给 noteCount + 最近 2 条摘要（80 字符），
      // 子代理扫一眼看板即可了解同伴近期进展，不必逐任务调 task_notes。
      const notes = notesOf(t);
      const recent = notes.slice(-2).map(n => `💬${String(n?.note ?? '').slice(0, 80)}`);
      const notesPart = recent.length > 0
        ? ` ${recent.join(' / ')}${notes.length > 2 ? `（共 ${notes.length} 条）` : ''}`
        : '';
      const blocked = blockingDeps(state, t);
      const block = blocked.length > 0 ? ` ⛔ 上游失败: ${blocked.join(', ')}` : '';
      lines.push(`${indent}[${t.id}] (${t.status}) ${t.title}${owner}${block}${notesPart}`);
    }
    const active = state.order.map(id => (hasTask(state, id) ? state.tasks[id] : null))
      .filter(t => t && t.owner && !DONE_LIKE.has(t.status))
      .filter(t => !filterOwner || t.owner === filterOwner);
    const withNotes = state.order.map(id => (hasTask(state, id) ? state.tasks[id] : null))
      .filter(t => t && notesOf(t).length + notesDroppedOf(t) > 0);
    const notesHint = withNotes.length > 0
      ? `看板每任务给最近 2 条笔记摘要（各 80 字符）。读某任务笔记全文：task_notes(taskId, limit≤200, offset)，例如 {"taskId":"${withNotes[0].id}"}${withNotes.some(t => notesDroppedOf(t) > 0) ? '（部分任务有 notesDropped > 0，说明超上限丢弃了最旧的笔记）' : ''}。`
      : undefined;
    const costTotal = state.order.reduce((acc, id) => {
      const t = hasTask(state, id) ? state.tasks[id] : null;
      if (!t) return acc;
      acc.tokens += Number(t.costTokens ?? 0);
      acc.minutes += Number(t.costMinutes ?? 0);
      return acc;
    }, { tokens: 0, minutes: 0 });
    return { result: {
      active: true,
      goal: state.goal,
      failurePolicy: failurePolicyOf(state),
      view: lines.join('\n'),
      activeWorkers: active.map(t => ({ taskId: t.id, owner: t.owner, status: t.status, title: t.title })),
      recentEvents: state.log.slice(-10),
      ...(costTotal.tokens > 0 || costTotal.minutes > 0 ? { cost: costTotal } : {}),
      ...(notesHint ? { notesHint } : {}),
    }, rev: state.rev };
  }

  /**
   * state 快照 save/load/clear（会话恢复用，语义与 2.2.0 兼容）：
   * save = 事务内清库导入快照（事件一并还原，供审计连续）；
   * load = 导出与 2.2.0 同构的 JSON 快照（log 为 events 表全量——快照带全历史）；
   * clear = plan_reset。
   */
  stateTool(args) {
    const op = String(args?.op ?? 'load');
    if (op === 'save') {
      this.#assertAlive();
      const s = args?.state;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new Error('state save: 需要提供 state 对象（当前缺失或类型不是对象）。下一步：传入完整 state，例如 {"op":"save","state":{...}}；一般不需要手写，改用 plan_create / task_update 即可。');
      }
      assertStateShape(s);
      try {
        this.#db.exec('BEGIN IMMEDIATE');
        this.#persistSnapshot(this.#db, s, { skipShapeCheck: true });
        this.#db.exec('COMMIT');
      } catch (err) {
        try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      return { result: { ok: true, file: this.dbPath }, rev: this.rev() };
    }
    if (op === 'clear') return { result: this.planReset().result, rev: this.rev() };
    const s = this.load();
    if (!s) return { result: { exists: false, state: null }, rev: this.rev() };
    // 导出全量事件（快照的用途是「完整现场」，与 2.2.0 的 log 全量在文件里一致）
    const allEvents = this.#db.prepare('SELECT at,event,taskId,owner,detail FROM events ORDER BY id ASC').all()
      .map(r => ({ at: r.at, event: r.event, ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.owner ? { owner: r.owner } : {}), ...(r.detail ? { detail: r.detail } : {}) }));
    const snapshot = { ...s, log: allEvents };
    delete snapshot.rev; // rev 是库内实现细节，不进快照
    return { result: { exists: true, state: snapshot }, rev: s.rev };
  }

  /**
   * addTaskNode —— 「建一个任务节点」的纯逻辑，供 task_add 与 task_review 采纳提案共用。
   * 只改传入的 state（校验 + 落字段 + 维护 order/parent.children/nextId + 查环）+ 追加事件；
   * 不开事务：调用方必须已在 mutate 临界区内。返回新任务 id。
   */
  #addTaskNode(state, spec, where) {
    const title = String(spec?.title ?? '').trim();
    if (title === '') throw new Error(`${where}: title 不能为空。下一步：传入任务标题，例如 {"title":"补一个回归测试","parentId":"T1"}。`);
    let parent = null;
    if (spec?.parentId !== undefined && spec?.parentId !== null && String(spec.parentId).trim() !== '') {
      parent = requireString(spec.parentId, `${where}: parentId`).trim();
      if (!hasTask(state, parent)) {
        throw new Error(`${where}: 父任务不存在 ${parent}。下一步：用 board 查看现有任务 id，或省略 parentId 建为顶级任务。`);
      }
    }
    let id;
    if (spec?.id === undefined || spec?.id === null || String(spec.id).trim() === '') {
      do { id = `T${state.nextId++}`; } while (hasTask(state, id));
    } else {
      id = assertValidId(String(spec.id).trim(), where);
      if (hasTask(state, id)) {
        throw new Error(`${where}: 任务 id ${id} 已存在（显式 id 与现有任务或自动编号冲突）。下一步：换一个唯一 id，例如 "${id}-2"；省略 id 则由系统自动编号。`);
      }
    }
    const deps = normalizeDeps(spec, where);
    if (deps.includes(id)) throw new Error(`${where}: 任务 ${id} 依赖自身。下一步：删掉这条 dependsOn。`);
    assertDepsResolvable(state, id, deps, where);
    const withWhere = (fn) => {
      try { return fn(); } catch (err) { throw new Error(`${where}: ${err?.message ?? err}`); }
    };
    state.tasks[id] = {
      id, title,
      detail: String(spec?.detail ?? '').trim(),
      dependsOn: deps,
      parent,
      depth: parent ? (state.tasks[parent].depth ?? 0) + 1 : 0,
      children: [],
      status: 'pending',
      owner: null,
      role: withWhere(() => normalizeRole(spec?.role)),
      reviewer: withWhere(() => normalizeReviewer(spec?.reviewer)),
      assignee: withWhere(() => normalizeAssignee(spec?.assignee)),
      reviewStage: 'none',
      notes: [],
      lastHeartbeat: null,
      costTokens: 0,
      costMinutes: 0,
      createdAt: new Date().toISOString(),
    };
    if (parent) state.tasks[parent].children.push(id);
    state.order.push(id);
    detectCycle(state);
    this.#appendEvent(state, { at: new Date().toISOString(), event: '追加任务', taskId: id, detail: title });
    return id;
  }

  /** 事件流读取（Web 控制台用）：since 之后的增量，升序 */
  eventsSince(sinceId, limit = 100) {
    this.#assertAlive();
    return this.#db.prepare('SELECT id,at,event,taskId,owner,detail FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(sinceId, limit);
  }
  /** 最新事件 id（SSE watch 的游标起点） */
  lastEventId() {
    this.#assertAlive();
    return Number(this.#db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM events').get()?.m ?? 0);
  }

  /**
   * 结构化看板数据（Web 控制台用）：任务按 order 排列，每任务带笔记计数与最近 2 条摘要。
   * 与 board() 的文本视图互补——人类界面需要结构化字段而非 ASCII 缩进行。
   */
  boardTasks() {
    this.#assertAlive();
    const state = this.load();
    if (!state) return null;
    const tasks = state.order.map(id => {
      const t = hasTask(state, id) ? state.tasks[id] : null;
      if (!t) return null;
      const notes = notesOf(t);
      return {
        id: t.id, title: t.title, status: t.status, owner: t.owner ?? null,
        parent: t.parent ?? null, depth: t.depth ?? 0,
        role: t.role ?? 'none', assignee: t.assignee ?? null,
        reviewer: t.reviewer ?? null, reviewStage: t.reviewStage ?? 'none',
        lastHeartbeat: t.lastHeartbeat ?? null,
        costTokens: Number(t.costTokens ?? 0), costMinutes: Number(t.costMinutes ?? 0),
        noteCount: notes.length, notesDropped: notesDroppedOf(t),
        latestNotes: notes.slice(-2).map(n => ({ at: n.at, owner: n.owner, note: String(n.note ?? '').slice(0, 80) })),
      };
    }).filter(Boolean);
    const cost = tasks.reduce((acc, t) => ({ tokens: acc.tokens + t.costTokens, minutes: acc.minutes + t.costMinutes }), { tokens: 0, minutes: 0 });
    return { goal: state.goal, failurePolicy: failurePolicyOf(state), tasks, ...(cost.tokens > 0 || cost.minutes > 0 ? { cost } : {}) };
  }

  /** 单任务详情（Web 控制台用）：全字段 + 笔记全量 + 该任务的事件流（最新在前） */
  taskDetail(taskId) {
    this.#assertAlive();
    const state = ensureState(this.load());
    const t = findTask(state, taskId);
    const notes = notesOf(t).map(n => ({ at: n.at, owner: n.owner, note: n.note })).reverse();
    const events = this.#db.prepare('SELECT id,at,event,owner,detail FROM events WHERE taskId=? ORDER BY id DESC LIMIT 50')
      .all(taskId);
    const { notes: _n, notesDropped: _d, ...fields } = t;
    return {
      task: { ...fields, noteCount: notesOf(t).length, notesDropped: notesDroppedOf(t) },
      notes,
      events,
    };
  }

  close() {
    try { this.#db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 展示视图（plan_get / board 共用）
// ---------------------------------------------------------------------------
function planView(state) {
  const lines = [];
  for (const id of state.order) {
    const t = state.tasks[id];
    const depth = t.parent ? (t.depth ?? 1) : 0;
    const indent = depth > 0 ? '  '.repeat(depth) + '└ ' : '';
    const deps = depsOf(t).length > 0 ? ` ← 依赖: ${depsOf(t).join(', ')}` : '';
    const blocked = blockingDeps(state, t);
    const block = blocked.length > 0 ? ` ⛔ 上游失败/跳过: ${blocked.join(', ')}` : '';
    const role = t.role && t.role !== 'none' ? ` {${t.role}}` : '';
    const assigned = t.assignee ? ` → 建议: ${t.assignee}` : '';
    const review = t.reviewer
      ? (t.reviewStage === 'pending' ? ` ⏳ 待 ${t.reviewer} 审核`
        : t.reviewStage === 'approved' ? ` ✔ ${t.reviewer} 已审`
          : t.reviewStage === 'rejected' ? ` ✖ ${t.reviewer} 已驳回（待重做）`
            : ` 审核:${t.reviewer}`)
      : '';
    lines.push(`${indent}[${t.id}] (${t.status}) ${t.title}${role}${assigned}${deps}${review}${block}`);
  }
  return lines.join('\n');
}

function detectCycle(state) {
  const visiting = new Set(), visited = new Set();
  function dfs(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`检测到依赖关系存在环，涉及 ${id}。下一步：检查这些任务的 dependsOn，去掉构成环的那条依赖。`);
    visiting.add(id);
    for (const dep of depsOf(state.tasks[id])) dfs(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of state.order) dfs(id);
}

/** 就绪判定：依赖全部 DONE_LIKE。block 策略下，上游 failed/skipped 会让下游彻底不就绪 */
function isReady(state, task) {
  if (task.status !== 'pending') return false;
  if (!depsSatisfied(state, task)) return false;
  if (failurePolicyOf(state) === 'block' && blockingDeps(state, task).length > 0) return false;
  return true;
}

function readyList(state) {
  return state.order
    .map(id => (hasTask(state, id) ? state.tasks[id] : null))
    .filter(t => t && isReady(state, t));
}

export const NOTES_LIMIT_DEFAULT = 20;
export const NOTES_LIMIT_MAX = 200;

/**
 * 校验分页整数参数（limit/offset）：非数字、负数、非整数、超上限都给出
 * 「谁看 + 下一步做什么」的中文错误，绝不把内部 TypeError 抛给调用方。
 */
function requirePageInt(value, label, { fallback, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`task_notes: ${label} 必须是整数（当前类型：${kind}）。下一步：传数字，例如 {"taskId":"T1","${label}":${fallback}}，或省略该字段用默认值。`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`task_notes: ${label} 必须是数字（收到 "${String(value)}"）。下一步：传一个从 0 开始的整数，例如 {"taskId":"T1","${label}":${fallback}}。`);
  }
  if (!Number.isInteger(n)) {
    throw new Error(`task_notes: ${label} 必须是整数（收到 ${n}）。下一步：改为最接近的整数，例如 ${Math.trunc(n)} 或 ${Math.ceil(n)}。`);
  }
  if (n < 0) {
    throw new Error(`task_notes: ${label} 不能为负数（收到 ${n}）。下一步：${label === 'offset' ? 'offset 从 0 开始（0 = 最新一条），传 0 或省略该字段' : '改为 ≥ 1 的正整数，或省略该字段用默认值 ' + fallback}。`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`task_notes: ${label} 超过上限 ${max}（收到 ${n}）。下一步：改为 ≤ ${max} 的值，或省略该字段用默认值 ${fallback}${label === 'limit' ? '；笔记很多时分批读（配合 offset）' : ''}。`);
  }
  return n;
}
