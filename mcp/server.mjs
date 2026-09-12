#!/usr/bin/env node
/**
 * taskswarm MCP server — 任务蜂群插件的确定性组件。
 *
 * 零依赖，stdio 传输（newline-delimited JSON-RPC 2.0）。
 *
 * 职责边界：本 server 只管「任务树与看板」的数据与格式（确定性部分），
 * 编排循环（何时拆解、何时派发、何时汇总）由主代理按 SKILL.md 执行。
 *
 * 工具一览：
 * - plan_create   创建一次蜂群任务（含多级拆解的任务树）
 * - plan_get      读取任务树全貌（波次划分就绪视图）
 * - plan_reset    清空/重建任务树
 * - task_ready    查询当前所有依赖已满足的待派发任务
 * - task_claim    子代理领取任务（原子，防重复派发）
 * - task_update   更新任务状态/进展笔记
 * - task_add      执行中途追加子任务（多级拆解可持续发生）
 * - task_notes    读回单任务笔记全文（分页，plan_get/board 只给摘要）
 * - board         全员共享进度看板（子代理拉取式互通的核心）
 * - state         整体状态落盘 save/load/clear（会话恢复）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * serverInfo.version —— 必须与 package.json / .zcode-plugin/plugin.json 一致（当前 2.0.0）。
 * 有意写成常量而非读 package.json：保持零依赖与零启动 I/O（升级时三处一起改）。
 */
const SERVER_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// 落盘位置：<工作区>/任务蜂群/（由调用方传 workspace，默认 cwd）
// ---------------------------------------------------------------------------
function workspaceOf(args) {
  const ws = args?.workspace;
  if (ws === undefined || ws === null || ws === '') return '';
  if (typeof ws !== 'string') {
    throw new Error(`workspace 必须是字符串（当前类型：${Array.isArray(ws) ? 'array' : typeof ws}）。下一步：传入工作区路径字符串，例如 {"workspace":"D:/zcode-work/my-project"}。`);
  }
  return ws.trim();
}
function baseDir(args) {
  const ws = workspaceOf(args);
  return path.join(ws || process.cwd(), '任务蜂群');
}
function stateFile(args) { return path.join(baseDir(args), 'swarm-state.json'); }
function lockFile(args) { return path.join(baseDir(args), '.lock'); }

// ---------------------------------------------------------------------------
// 并发安全核心（所有改状态入口的唯一通道）
//
// 原因：原先 loadState 与 saveState 是两次互不保护的独立操作，写盘用
// fs.writeFileSync 直接覆盖，于是两个 server 进程并发写会把状态文件写坏
// （JSON 尾部残留旧内容），并发抢同一任务会双方都 claim 成功。
//
// 三条保证：
// 1. withStateLock —— 跨进程文件锁（<状态目录>/.lock），所有「读-改-写」互斥；
// 2. writeState    —— 写 <file>.tmp-<pid> → fsync → rename 原子替换，进程被杀不留半截文件；
// 3. readStateStrict —— 解析失败先备份 <file>.corrupt-<时间戳>.json 再抛中文错误，
//                      绝不静默当成「没有计划」。
// ---------------------------------------------------------------------------
const LOCK_RETRY_MS = 25;            // 抢锁失败后的退避间隔
const DEFAULT_LOCK_TIMEOUT_MS = 10000; // 抢锁总超时（约 10s）
const LOCK_TIMEOUT_MAX_MS = 600000;  // 超时上限（10 分钟），防环境变量写成天文数字
const LOCK_STALE_MS = 15000;         // 锁龄超过该值视为持有者已崩溃，锁可被抢占

/**
 * 抢锁超时。可用 TASKSWARM_LOCK_TIMEOUT_MS 覆盖（毫秒，1..600000）。
 * 每次读取而非模块级常量，便于测试与不同部署场景调整。
 */
function lockTimeoutMs() { return positiveIntEnv('TASKSWARM_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS, LOCK_TIMEOUT_MAX_MS); }

/** 锁的持有者信息 */
function lockPayload() {
  return { pid: process.pid, at: Date.now(), host: os.hostname() };
}

/**
 * 判断现有锁是否陈旧（持有者已消失）并抢占。
 * 陈旧判定：锁龄 > LOCK_STALE_MS，或锁记录的是本机进程且该进程已不存在。
 * 返回 true 表示已删除陈旧锁（调用方应重新尝试加锁）。
 */
function stealStaleLock(lockPath) {
  let raw = '';
  try { raw = fs.readFileSync(lockPath, 'utf8'); } catch { return false; }
  let info = null;
  try { info = JSON.parse(raw); } catch { info = null; }

  let age = Number.isFinite(Number(info?.at)) ? Date.now() - Number(info.at) : NaN;
  if (!Number.isFinite(age)) {
    try { age = Date.now() - fs.statSync(lockPath).mtimeMs; }
    catch { return false; } // 锁刚被释放，交给下一轮重试
  }

  let holderGone = false;
  const pid = Number(info?.pid);
  if (Number.isFinite(pid) && pid > 0 && String(info?.host ?? '') === os.hostname() && pid !== process.pid) {
    try { process.kill(pid, 0); }              // 存活探测
    catch (err) { holderGone = err?.code === 'ESRCH'; } // ESRCH=进程已死；EPERM=无权探测，视为存活
  }

  if (!(age > LOCK_STALE_MS || holderGone)) return false;
  try { fs.rmSync(lockPath, { force: true }); }
  catch { return false; }
  return true;
}

/**
 * 抢跨进程锁；拿不到则每 LOCK_RETRY_MS 退避重试，总超时 lockTimeoutMs()。
 * 成功返回 {stolen}（stolen 为 true 表示本次是抢占陈旧锁）。
 * 超时抛结构化中文错误（绝不裸异常导致 JSON-RPC 层只看到 "ELOCKED"）。
 */
function acquireLock(args) {
  const dir = baseDir(args);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = lockFile(args);
  const timeoutMs = lockTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  let stolen = false;

  for (;;) {
    let fd = -1;
    try {
      fd = fs.openSync(lockPath, 'wx'); // 已存在即 EEXIST —— 原子加锁
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw new Error(`获取状态文件锁失败：${lockPath}（${err?.code ?? err?.message ?? err}）`);
      }
      if (stealStaleLock(lockPath)) { stolen = true; continue; }
      if (Date.now() >= deadline) {
        let holder = '';
        try { holder = fs.readFileSync(lockPath, 'utf8').trim(); } catch { /* 锁刚被释放 */ }
        throw new Error(
          `状态文件正被其他进程占用，等待 ${timeoutMs}ms 仍未获得锁。锁文件：${lockPath}` +
          (holder ? `；持有者：${holder}` : '') +
          '。请稍后重试；若确认没有进程在写状态（如进程被强杀后的残留锁），可删除该锁文件后重试。'
        );
      }
      const wait = Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now()));
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); }
      catch { const end = Date.now() + wait; while (Date.now() < end) { /* 忙等兜底 */ } }
      continue;
    }
    try {
      if (fd >= 0) {
        fs.writeSync(fd, JSON.stringify(lockPayload()));
        try { fs.fsyncSync(fd); } catch { /* fsync 失败不阻断加锁 */ }
        fs.closeSync(fd);
        fd = -1;
      }
    } catch (err) {
      try { if (fd >= 0) fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`写入锁文件失败：${lockPath}（${err?.message ?? err}）`);
    }
    return { lockPath, stolen };
  }
}

/** 释放锁（放在 finally 里执行，保证任何异常路径都能解锁） */
function releaseLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
}

/** 写盘时顺手清掉上次被强杀遗留的临时文件（此刻持有锁，无人会再写它们） */
function pruneStaleTmp(f) {
  const dir = path.dirname(f);
  const prefix = path.basename(f) + '.tmp-';
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const p = path.join(dir, name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) fs.rmSync(p, { force: true }); }
      catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 抢锁 → 执行 fn → finally 释放锁。fn 内部才允许 load+save，锁外绝不落盘。 */
function withStateLock(args, fn) {
  const { lockPath, stolen } = acquireLock(args);
  try {
    if (stolen) {
      // 抢占陈旧锁（上一个持有者多半已崩溃）：留一条事件便于事后排查
      try {
        const cur = readStateStrict(args);
        if (cur && Array.isArray(cur.log)) {
          cur.log.push({ at: new Date().toISOString(), event: '锁抢占', detail: `检测到陈旧状态锁并抢占（pid=${process.pid}）` });
          writeState(args, cur);
        }
      } catch { /* 状态本身不可读时忽略，不阻断本次操作 */ }
    }
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * 原子写盘：tmp 文件 → fsync → rename 覆盖（同目录 rename 在 Windows/POSIX 均为原子）。
 * 调用方必须已持有跨进程锁（经 withStateLock）。
 */
function writeState(args, state) {
  const f = stateFile(args);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  pruneStaleTmp(f);
  const tmp = `${f}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2), null, 'utf8');
    fs.fsyncSync(fd); // 落盘后才 rename，断电/强杀都不会留下半截目标文件
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  try {
    fs.renameSync(tmp, f);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`状态文件写入失败（重命名未生效）：${f}（${err?.message ?? err}）`);
  }
  return { file: f };
}

/** 兼容旧名：整体覆盖写盘（带锁，不读盘）。改状态请用 mutateState。 */
function saveState(args, state) {
  return withStateLock(args, () => writeState(args, state));
}

/**
 * 读盘（读路径无锁：rename 原子替换保证读到的必是完整文件）。
 * JSON 解析失败 → 先把坏文件备份为 <file>.corrupt-<时间戳>.json，再抛明确中文错误。
 * 文件不存在 → null（新计划，属于正常情况）。
 */
function readStateStrict(args) {
  const f = stateFile(args);
  if (!fs.existsSync(f)) return null;
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (err) { throw new Error(`状态文件读取失败：${f}（${err?.message ?? err}）`); }
  if (raw.trim() === '') throw corruptionError(f, '文件为空');
  try { return JSON.parse(raw); }
  catch (err) { throw corruptionError(f, err.message, raw); }
}

function corruptionError(f, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${f}.corrupt-${stamp}.json`;
  let saved = '';
  try { fs.copyFileSync(f, backup); saved = backup; }
  catch (err) { saved = `（备份失败：${err?.message ?? err}）`; }
  return new Error(
    `状态文件已损坏，无法解析：${f}\n解析错误：${reason}\n坏文件已备份为：${saved}\n` +
    '可以用 plan_reset 清空后重新 plan_create；备份文件已保留，便于事后排查，请勿删除。'
  );
}

/** 唯一的「读-改-写」临界区入口：所有改状态的操作都必须走这里。 */
function mutateState(args, fn) {
  return withStateLock(args, () => {
    const state = readStateStrict(args);
    const out = fn(state);
    if (out?.__save !== undefined) writeState(args, out.__save);
    return out?.__result;
  });
}

/** 读路径统一入口（plan_get / task_ready / board / state load） */
function loadState(args) { return readStateStrict(args); }

const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'blocked', 'done', 'failed', 'skipped'];
const DONE_LIKE = new Set(['done', 'failed', 'skipped']);
const TERMINAL = new Set(['done', 'failed', 'skipped']);

/**
 * 合法状态转移表（source → 允许到达的目标状态）。
 * 未列出的转移一律拒绝，错误信息里会给出「下一步做什么」。
 */
const ALLOWED_TRANSITIONS = {
  pending: ['claimed', 'in_progress', 'blocked', 'done', 'failed', 'skipped'],
  claimed: ['in_progress', 'blocked', 'pending', 'done', 'failed', 'skipped'],
  in_progress: ['blocked', 'pending', 'done', 'failed', 'skipped'],
  blocked: ['in_progress', 'pending', 'done', 'failed', 'skipped'],
  done: ['pending'],
  failed: ['pending'],
  skipped: ['pending'],
};

/** 失败语义：默认挡住下游（block），可选 proceed 延续旧行为（放行但在 ready 里标注 blockedBy） */
const FAILURE_POLICIES = ['block', 'proceed'];
const DEFAULT_FAILURE_POLICY = 'block';

const MAX_SUBTASK_DEPTH = 5;
const DANGEROUS_IDS = new Set(['__proto__', 'prototype', 'constructor']);
/** id 规则：首位字母或数字，其余字母/数字/点/下划线/短横线，总长 ≤ 64 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// 笔记治理上限（原因：state 每次操作全量重写，notes 无限增长会让状态文件与
// plan_get/board 的返回体量失控——审计实测 500 条长笔记即 100+ KB）
//
// 两个上限都可调，优先级：环境变量 > 默认值
//   TASKSWARM_MAX_NOTES      每任务保留的最新笔记条数（默认 500，取值 1..100000）
//   TASKSWARM_MAX_NOTE_CHARS 单条笔记最大字符数（默认 4000，取值 1..1000000）
// 超限策略：单条截断并加 [已截断] 标记；条数上限按「保留最新」丢弃，丢弃笔数
// 累计到 task.notesDropped，绝不静默丢弃（task_notes 会返回该计数）。
// ---------------------------------------------------------------------------
const DEFAULT_MAX_NOTES = 500;
const DEFAULT_MAX_NOTE_CHARS = 4000;
/** 截断标记：同时进入返回体（避免调用方把截断误当成原文） */
const TRUNCATED_MARK = '…[已截断]';

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

// ---------------------------------------------------------------------------
// 校验辅助
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
function assertValidId(id, where) {
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

/** 校验 dependsOn 入参类型；返回去重后的 id 数组（元素合法性由调用方结合存在性一起报错） */
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
 * 状态结构校验（读路径）：手工编辑或 state save 传进来的 state 可能缺字段，
 * 这里统一挡在逻辑之前，避免 "Cannot read properties of undefined" 这类内部异常。
 */
function assertStateShape(state) {
  const bad = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('状态文件内容不是对象。下一步：用 plan_reset 清空后重新 plan_create（备份文件保留便于排查）。');
  }
  if (!Array.isArray(state.order)) bad.push('order（任务顺序数组）');
  if (!state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) bad.push('tasks（任务表对象）');
  if (state.log !== undefined && !Array.isArray(state.log)) bad.push('log（事件数组）');
  if (bad.length > 0) {
    throw new Error(
      `状态文件格式异常：缺少或类型不对的字段 ${bad.join('、')}。` +
      '下一步：用 plan_reset 清空后重新 plan_create；若怀疑被外部工具改坏，查看同目录 .corrupt-*.json 备份。'
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
function hasTask(state, taskId) {
  return Object.hasOwn(state.tasks ?? {}, taskId);
}
function findTask(state, taskId) {
  if (!hasTask(state, taskId)) {
    const id = taskId === '' || taskId === undefined ? '(空)' : taskId;
    throw new Error(`任务不存在: ${id}。下一步：用 plan_get 或 board 查看现有任务 id，确认后再调用。`);
  }
  return state.tasks[taskId];
}
/** 读取任务的依赖列表：容忍手工编辑过的状态文件（dependsOn 缺失/非数组都不炸） */
function depsOf(task) {
  const d = task?.dependsOn;
  return Array.isArray(d) ? d : [];
}

/** 笔记数组视图：容忍手工编辑过的状态文件（notes 缺失/非数组都不炸） */
function notesOf(task) {
  return Array.isArray(task?.notes) ? task.notes : [];
}
/** 已丢弃的笔记条数（历史遗留状态文件无此字段 → 0；非法值归零，避免 NaN 进入输出） */
function notesDroppedOf(task) {
  const n = Number(task?.notesDropped);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 追加一条笔记并执行上限治理（条数上限 + 单条长度上限）。
 *
 * 调用方必须已持有跨进程锁（只在 mutateState 临界区内调用）。
 * 返回 { text, truncated, dropped }：text 为实际入库内容（可能带截断标记），
 * dropped 为本次因条数上限被丢弃的最旧条数（调用方用于累计 notesDropped 与写日志）。
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
  if (!Array.isArray(task.notes)) task.notes = []; // 兼容被手工改过的状态文件
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
/** 失败策略取值（未指定 → 默认 block；旧状态文件缺字段也走 block，语义与本次修复一致） */
function failurePolicyOf(state) {
  const p = state?.failurePolicy;
  return FAILURE_POLICIES.includes(p) ? p : DEFAULT_FAILURE_POLICY;
}
/** 波次 = 最长依赖链深度（就绪视图用） */
function waveOf(state, task, memo = new Map()) {
  if (memo.has(task.id)) return memo.get(task.id);
  memo.set(task.id, 0); // 防环
  const w = depsOf(task).reduce((max, id) => {
    const d = hasTask(state, id) ? state.tasks[id] : null;
    return d ? Math.max(max, waveOf(state, d, memo)) : max;
  }, 0) + 1;
  memo.set(task.id, w);
  return w;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
function planCreate(args) {
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

  // 先在锁外把纯计算部分（建树/校验）做完，再在临界区内落盘，尽量缩短持锁时间
  const state = {
    phase: 'swarming',
    goal,
    failurePolicy,    // 上游 failed/skipped 时下游的处理策略：block（默认）挡住 / proceed 放行
    createdAt: new Date().toISOString(),
    tasks: Object.create(null), // 无原型，防 __proto__ 等键污染（JSON 序列化后仍是普通对象）
    order: [],        // 展示顺序
    nextId: 1,
    log: [],          // 事件流（看板时间线）
  };

  // 自动编号：只跳过已被显式 id 占用的槽位，避免 T1/T2 撞名
  function nextAutoId() {
    let id;
    do { id = `T${state.nextId++}`; } while (hasTask(state, id));
    return id;
  }

  const idMap = new Map();   // 入参对象 → 生成的 id
  const depMap = new Map();  // 生成的 id → 原始 dependsOn 入参
  const autoIds = new Set(); // 自动编号产生的 id（用于给出可行动的冲突提示）

  /**
   * 递归建节点：支持任意层级 subtasks，深度上限 MAX_SUBTASK_DEPTH。
   * 显式 id 与自动编号冲突时给出可行动的错误，而不是笼统的「id 重复」。
   */
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
      dependsOn: [],      // 填充在第二遍
      parent: parent ?? null,
      depth,
      children: [],
      status: 'pending',
      owner: null,
      notes: [],
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
  // 第一遍：递归建节点（父子关系 + 深度）
  for (const t of tasksIn) addTask(t, null, 0);

  // 第二遍：解析 dependsOn（引用 id），逐条校验 id 格式
  for (const id of state.order) {
    state.tasks[id].dependsOn = normalizeDeps(depMap.get(id), `plan_create: 任务 ${id}`);
  }
  // 校验依赖引用存在且无环
  for (const id of state.order) {
    assertDepsResolvable(state, id, state.tasks[id].dependsOn, 'plan_create');
  }
  detectCycle(state);

  state.log.push({ at: state.createdAt, event: '计划创建', detail: `${state.order.length} 个任务，目标：${goal}` });
  // 计划创建是「整体覆盖」语义：持锁后直接替换，避免与并发的其他计划互相追加
  saveState(args, state);
  return { ok: true, file: stateFile(args), taskCount: state.order.length, failurePolicy, plan: planView(state) };
}

function detectCycle(state) {
  const visiting = new Set(), visited = new Set();
  function dfs(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`plan_create: 依赖关系存在环，涉及 ${id}`);
    visiting.add(id);
    for (const dep of depsOf(state.tasks[id])) dfs(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of state.order) dfs(id);
}

function planView(state) {
  const lines = [];
  for (const id of state.order) {
    const t = state.tasks[id];
    const depth = t.parent ? (t.depth ?? 1) : 0;
    const indent = depth > 0 ? '  '.repeat(depth) + '└ ' : '';
    const deps = depsOf(t).length > 0 ? ` ← 依赖: ${depsOf(t).join(', ')}` : '';
    const blocked = blockingDeps(state, t);
    const block = blocked.length > 0 ? ` ⛔ 上游失败/跳过: ${blocked.join(', ')}` : '';
    lines.push(`${indent}[${t.id}] (${t.status}) ${t.title}${deps}${block}`);
  }
  return lines.join('\n');
}

function planGet(args) {
  const state = ensureState(loadState(args));
  const withNotes = state.order.map(id => (hasTask(state, id) ? state.tasks[id] : null))
    .filter(t => t && notesOf(t).length + notesDroppedOf(t) > 0);
  return {
    phase: state.phase,
    goal: state.goal,
    failurePolicy: failurePolicyOf(state),
    ready: readyList(state).map(t => t.id),
    view: planView(state),
    // recentEvents 里的进展笔记只保留前 120 字符（有意为之：全量返回会灌爆上下文）
    recentEvents: state.log.slice(-15),
    ...(withNotes.length > 0 ? { notesHint: `以上 recentEvents 的备注只截前 120 字符；读笔记全文请用 task_notes(taskId, limit≤200, offset)，例如 {"taskId":"${withNotes[0].id}"}。` } : {}),
  };
}

function planReset(args) {
  const f = stateFile(args);
  // 与并发写盘互斥：清空必须整个落在一个临界区里（否则可能删掉别的进程刚写好的文件）
  return withStateLock(args, () => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true, cleared: f };
  });
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

function taskReady(args) {
  const state = ensureState(loadState(args));
  const policy = failurePolicyOf(state);
  return {
    ready: readyList(state).map(t => {
      const blockedBy = blockingDeps(state, t); // proceed 策略下才有值；block 策略下不会被列进 ready
      return {
        id: t.id, title: t.title, detail: t.detail, parent: t.parent,
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
      };
    }),
    failurePolicy: policy,
  };
}

function taskClaim(args) {
  // 「读-改-写」整体在一个跨进程临界区里完成：两进程并发抢同一任务只可能有一个成功
  return mutateState(args, (raw) => {
    const state = ensureState(raw);
    if (args?.taskId === undefined || args?.taskId === null) {
      throw new Error('task_claim: 缺少 taskId。下一步：传入要领取的任务 id，例如 {"taskId":"T1","owner":"agent-1"}。');
    }
    if (args?.owner === undefined || args?.owner === null) {
      throw new Error('task_claim: 缺少 owner（子代理标识）。下一步：传入你的标识，例如 {"taskId":"T1","owner":"agent-1"}。');
    }
    const taskId = requireString(args.taskId, 'task_claim: taskId').trim();
    const owner = requireString(args.owner, 'task_claim: owner').trim();
    if (owner === '') throw new Error('task_claim: owner（子代理标识）不能为空。下一步：传入如 "agent-1" 的标识。');
    const t = findTask(state, taskId);
    if (!depsSatisfied(state, t)) {
      const pendingDeps = depsOf(t).filter(id => !(hasTask(state, id) && DONE_LIKE.has(state.tasks[id].status)));
      throw new Error(`task_claim: ${taskId} 依赖未完成，不能领取（未完成：${pendingDeps.join(', ')}）。下一步：先等上游任务置 done，或由主代理调整依赖。`);
    }
    const blocked = blockingDeps(state, t);
    if (failurePolicyOf(state) === 'block' && blocked.length > 0) {
      throw new Error(`task_claim: ${taskId} 的上游 ${blocked.join(', ')} 已失败/跳过，按 failurePolicy=block 已阻断，不能领取。下一步：由主代理用 task_update(force:true) 把该任务置回 pending 并调整依赖，或重建计划时用 failurePolicy:"proceed"。`);
    }
    if (t.status === 'claimed' || t.status === 'in_progress') throw new Error(`task_claim: ${taskId} 已被 ${t.owner ?? '(未知)'} 领取（状态 ${t.status}）。下一步：换一个任务；若确认该 owner 已失联，由主代理 task_update(force:true) 置回 pending（会记 log）。`);
    if (t.status !== 'pending') throw new Error(`task_claim: ${taskId} 状态为 ${t.status}，只有 pending 可领取。下一步：用 board 查看该任务当前状态。`);
    t.status = 'claimed';
    t.owner = owner;
    t.claimedAt = new Date().toISOString();
    state.log.push({ at: t.claimedAt, event: '领取', taskId, owner });
    return { __save: state, __result: { ok: true, task: { id: t.id, title: t.title, detail: t.detail, dependsOn: depsOf(t) } } };
  });
}

function taskUpdate(args) {
  return mutateState(args, (raw) => {
    const state = ensureState(raw);
    if (args?.taskId === undefined || args?.taskId === null) {
      throw new Error('task_update: 缺少 taskId。下一步：传入任务 id，例如 {"taskId":"T1","status":"done","owner":"agent-1"}。');
    }
    const taskId = requireString(args.taskId, 'task_update: taskId').trim();
    const t = findTask(state, taskId);
    const actor = args?.owner === undefined || args?.owner === null ? '' : requireString(args.owner, 'task_update: owner').trim();
    const force = args?.force === true;
    let released = false; // 本次是否把任务回退成 pending（无主状态）
    let mutated = false;  // 本次是否真的改了状态或写了笔记（决定无主任务能否被「认领」）

    if (args?.status !== undefined && args?.status !== null) {
      const s = requireString(args.status, 'task_update: status').trim();
      if (!TASK_STATUSES.includes(s)) {
        throw new Error(`task_update: 非法状态 "${s}"，可用: ${TASK_STATUSES.join('/')}。下一步：改用其中一个合法状态。`);
      }
      const from = t.status;
      if (s !== from) {
        const prevOwner = t.owner;            // 回退到 pending 会清空 owner，日志需要旧值
        const allowed = ALLOWED_TRANSITIONS[from] ?? [];
        // 归属校验：未派发（owner 为空）的任务谁都可推进，便于主代理编排；一旦有 owner，就必须是本人
        // （不提供 owner 视为「无法证明是本人」，不能借省略参数绕过校验——恢复场景走 force）
        const ownerKnown = t.owner !== null && t.owner !== undefined;
        const isOwner = ownerKnown && actor !== '' && t.owner === actor;
        const ownerOk = !ownerKnown || isOwner;
        const terminalRollback = TERMINAL.has(from) && !TERMINAL.has(s);

        if (!force) {
          if (!ownerOk) {
            throw new Error(`task_update: 任务 ${taskId} 当前 owner 是 ${t.owner}，你以 ${actor || '(未提供 owner)'} 身份无权改状态。下一步：由 owner 本人汇报，或主代理用 task_update(force:true) 接管（会记 log）。`);
          }
          if (TERMINAL.has(from) && !TERMINAL.has(s) && !isOwner) {
            throw new Error(`task_update: 任务 ${taskId} 已处于终态 ${from}，只有 owner 能回退（当前 owner：${t.owner ?? '(无)'}，你：${actor || '(未提供 owner)'}）。下一步：由当前 owner 回退，或主代理用 task_update(force:true) 强制回退（会记 log）。`);
          }
          if (!allowed.includes(s)) {
            throw new Error(`task_update: 不允许的状态转移 ${from} → ${s}（任务 ${taskId}）。合法后继: ${allowed.join('/') || '(无，终态)'}。下一步：改用合法状态；会话中断恢复等特殊场景由主代理用 force:true。`);
          }
        } else if (actor === '') {
          throw new Error(`task_update: force 必须由主代理显式操作，需同时提供 owner。下一步：写成 {"taskId":"${taskId}","status":"${s}","owner":"main","force":true}。`);
        }

        t.status = s;
        mutated = true;
        if (s === 'in_progress' && !t.startedAt) t.startedAt = new Date().toISOString();
        if (s === 'pending') { // 回退到 pending：清掉领取痕迹，允许重新派发
          t.owner = null;
          t.claimedAt = null;
          t.startedAt = null;
          t.finishedAt = null;
          released = true;
        }
        if (DONE_LIKE.has(s)) {
          t.finishedAt = new Date().toISOString();
          // 失败/跳过的任务，其对下游的影响由 failurePolicy 决定：block（默认）永久挡住下游，
          // proceed 则照常放行（task_ready 会用 blockedBy 标注是哪个上游出了问题）。此处仅记录。
          state.log.push({ at: t.finishedAt, event: s === 'failed' ? '失败' : s === 'skipped' ? '跳过' : '完成', taskId, owner: prevOwner ?? t.owner });
        }
        if (force) {
          state.log.push({
            at: new Date().toISOString(), event: '强制改状态', taskId, owner: actor,
            detail: `${from} → ${s}；原 owner=${prevOwner ?? '(无)'}${terminalRollback ? '；终态回退' : ''}`,
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
        state.log.push({ at: new Date().toISOString(), event: '进展', taskId, owner: actor || t.owner, detail: appended.text.slice(0, 120) });
        if (appended.dropped > 0) {
          // 丢弃可观测：一条 log 事件 + task.notesDropped 累计计数（task_notes 会返回）
          state.log.push({
            at: new Date().toISOString(), event: '笔记超限丢弃', taskId, owner: actor || t.owner,
            detail: `笔记数超过上限 ${maxNotes()}，丢弃最旧 ${appended.dropped} 条（累计丢弃 ${notesDroppedOf(t)} 条）；全文走 task_notes 读取`,
          });
        }
        mutated = true;
      }
    }
    // owner 字段：仅在任务尚无归属、或主代理 force 接管时写入，避免非 owner 篡改归属。
    // 无主任务的「认领式」写入要求本次确有实质动作（改状态或写笔记），避免空调用凭空占坑。
    // 回退到 pending 的任务保持无主（上面已清空），这样新子代理才能重新 claim。
    if (actor !== '' && !released && mutated && (t.owner === null || t.owner === undefined || force)) t.owner = actor;
    return {
      __save: state,
      __result: {
        ok: true,
        task: {
          id: t.id, status: t.status, owner: t.owner,
          notesCount: notesOf(t).length,          // 当前保留条数
          notesDropped: notesDroppedOf(t),        // 历史累计被丢弃条数（0 = 从未丢弃）
          ...(notesDroppedOf(t) > 0 ? { notesHint: `该任务历史上有 ${notesDroppedOf(t)} 条笔记因超过 ${maxNotes()} 条上限被丢弃（保留最新）；当前 ${notesOf(t).length} 条全文可用 task_notes 分页读回。` } : {}),
        },
      },
    };
  });
}

function taskAdd(args) {
  return mutateState(args, (raw) => {
    const state = ensureState(raw);
    const title = String(args?.title ?? '').trim();
    if (title === '') throw new Error('task_add: title 不能为空。下一步：传入任务标题，例如 {"title":"补一个回归测试","parentId":"T1"}。');
    let parent = null;
    if (args?.parentId !== undefined && args?.parentId !== null && String(args.parentId).trim() !== '') {
      parent = requireString(args.parentId, 'task_add: parentId').trim();
      if (!hasTask(state, parent)) {
        throw new Error(`task_add: 父任务不存在 ${parent}。下一步：用 board 查看现有任务 id，或省略 parentId 建为顶级任务。`);
      }
    }
    let id;
    if (args?.id === undefined || args?.id === null || String(args.id).trim() === '') {
      do { id = `T${state.nextId++}`; } while (hasTask(state, id)); // 跳过被显式 id 占用的槽位
    } else {
      id = assertValidId(String(args.id).trim(), 'task_add');
      if (hasTask(state, id)) {
        throw new Error(`task_add: 任务 id ${id} 已存在（显式 id 与现有任务或自动编号冲突）。下一步：换一个唯一 id，例如 "${id}-2"；省略 id 则由系统自动编号。`);
      }
    }
    const deps = normalizeDeps(args, 'task_add');
    // 自身依赖：先建节点还是先查会互相影响，故显式先查这一条（存在性检查排除自身）
    if (deps.includes(id)) throw new Error(`task_add: 任务 ${id} 依赖自身。下一步：删掉这条 dependsOn。`);
    assertDepsResolvable(state, id, deps, 'task_add');
    state.tasks[id] = {
      id, title,
      detail: String(args?.detail ?? '').trim(),
      dependsOn: deps,
      parent,
      depth: parent ? (state.tasks[parent].depth ?? 0) + 1 : 0,
      children: [],
      status: 'pending',
      owner: null,
      notes: [],
      createdAt: new Date().toISOString(),
    };
    if (parent) state.tasks[parent].children.push(id);
    state.order.push(id);
    detectCycle(state);
    state.log.push({ at: new Date().toISOString(), event: '追加任务', taskId: id, detail: title });
    return { __save: state, __result: { ok: true, taskId: id } };
  });
}

const NOTES_LIMIT_DEFAULT = 20;
const NOTES_LIMIT_MAX = 200;

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

/**
 * task_notes —— 只读工具：读回单个任务的笔记全文并分页。
 *
 * 存在意义：plan_get / board 只给摘要（board 截 60 字符、plan_get 走 log 截 120 字符、
 * 状态 JSON 又太大），子代理「看同伴写下的完整结论」需要一条体量可控的通道。
 * 本工具返回的 note 字段是完整原文（受单条长度上限治理，可能带 [已截断] 标记）。
 *
 * 分页语义：offset 从「最新」往回数（0 = 最新一条），返回的 notes 按时间升序排列，
 * 便于调用方按批次拼接出与写入顺序一致的完整序列：
 *   offset=0 取最新一页 → offset=limit 取更早一页 …… 直到 offset >= total。
 * 返回体量等于 limit × 单条上限（limit 上限 200），不会一次灌爆上下文。
 */
function taskNotes(args) {
  const state = ensureState(loadState(args));
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
  // offset 从最新往回数：最新一条是 offset=0；超过 total 时返回空页（不报错，便于循环到底）
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - limit);
  const page = all.slice(start, end).map(n => ({ at: n?.at ?? null, owner: n?.owner ?? null, note: String(n?.note ?? '') }));

  return {
    taskId: t.id,
    total,                 // 当前保留的笔记总数
    notesDropped: dropped, // 历史累计被丢弃条数（总数 = 保留数 + 丢弃数）
    offset,
    limit,
    returned: page.length,
    hasMore: start > 0,    // true 表示还有更早的笔记，可用 offset+limit 继续翻
    ...(dropped > 0 ? { hint: `该任务历史上有 ${dropped} 条最旧笔记因超过上限 ${maxNotes()} 条被丢弃（未静默丢失，计数见 notesDropped）。` } : {}),
    ...(page.some(n => n.note.includes(TRUNCATED_MARK)) ? { truncatedHint: `部分笔记单条超过 ${maxNoteChars()} 字符，已截断并标记 "${TRUNCATED_MARK}"。` } : {}),
    ...(start > 0 ? { pageHint: `还有更早的 ${start} 条（本页是最新的第 ${offset + 1}..${offset + page.length} 条）。下一步：以 offset=${offset + limit} 再读一页。` } : {}),
    notes: page,           // 全文，不截断
  };
}

function board(args) {
  const state = loadState(args);
  if (!state) return { active: false };
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
    const notes = Array.isArray(t.notes) ? t.notes : [];
    const latestNote = notes.length > 0 ? ` 💬${String(notes[notes.length - 1].note ?? '').slice(0, 60)}` : '';
    const blocked = blockingDeps(state, t);
    const block = blocked.length > 0 ? ` ⛔ 上游失败: ${blocked.join(', ')}` : '';
    lines.push(`${indent}[${t.id}] (${t.status}) ${t.title}${owner}${block}${latestNote}`);
  }
  const active = state.order.map(id => (hasTask(state, id) ? state.tasks[id] : null))
    .filter(t => t && t.owner && !DONE_LIKE.has(t.status))
    // 与 view 保持一致：指定 owner 时只回报该 owner 的在跑任务，
    // 否则子代理会从 activeWorkers 里看到别人的任务，filter 形同虚设。
    .filter(t => !filterOwner || t.owner === filterOwner);
  const withNotes = state.order.map(id => (hasTask(state, id) ? state.tasks[id] : null))
    .filter(t => t && notesOf(t).length + notesDroppedOf(t) > 0);
  const notesHint = withNotes.length > 0
    ? `看板每条只给最新一条笔记的前 60 字符摘要。读某任务笔记全文：task_notes(taskId, limit≤200, offset)，例如 {"taskId":"${withNotes[0].id}"}${withNotes.some(t => notesDroppedOf(t) > 0) ? '（部分任务有 notesDropped > 0，说明超上限丢弃了最旧的笔记）' : ''}。`
    : undefined;
  return {
    active: true,
    goal: state.goal,
    failurePolicy: failurePolicyOf(state),
    view: lines.join('\n'),
    activeWorkers: active.map(t => ({ taskId: t.id, owner: t.owner, status: t.status, title: t.title })),
    recentEvents: (Array.isArray(state.log) ? state.log : []).slice(-10),
    ...(notesHint ? { notesHint } : {}),
  };
}

function stateTool(args) {
  const op = String(args?.op ?? 'load');
  if (op === 'save') {
    const s = args?.state;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error('state save: 需要提供 state 对象（当前缺失或类型不是对象）。下一步：传入完整 state，例如 {"op":"save","state":{...}}；一般不需要手写，改用 plan_create / task_update 即可。');
    }
    // 结构不完整会直接污染后续所有读取，故这里先校验形状（宁可拒写，也不写坏）
    assertStateShape(s);
    // 整体覆盖 save：调用方提供完整 state，不需要读盘；只要求与并发写互斥、且写盘原子
    return withStateLock(args, () => ({ ok: true, ...writeState(args, s) }));
  }
  if (op === 'clear') return planReset(args);
  const s = loadState(args);
  return { exists: !!s, state: s };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'plan_create', description: '创建蜂群任务：一次多级任务拆解（任务树，含依赖）。goal=总目标；tasks=[{id?,title,detail?,dependsOn?,subtasks:[...]}]（subtasks 最多 5 层）。failurePolicy 默认 "block"（上游 failed/skipped 时挡住下游）；"proceed" 则照常放行并在 task_ready 里标注 blockedBy。',
    inputSchema: {
      type: 'object', required: ['goal', 'tasks'],
      properties: {
        goal: { type: 'string', description: '总目标' },
        tasks: { type: 'array', items: { type: 'object' }, description: '顶级任务数组，每项 {id?,title,detail?,dependsOn?,subtasks:[{id?,title,detail?,dependsOn?,subtasks:[...]}]}，嵌套最多 5 层' },
        failurePolicy: { type: 'string', enum: ['block', 'proceed'], description: '上游 failed/skipped 时下游的处理策略：block（默认）挡住，proceed 放行并标注 blockedBy' },
      },
    },
  },
  {
    name: 'plan_get', description: '读取任务树全貌与当前就绪任务。view 只含状态/依赖骨架，recentEvents 里的进展笔记为短摘要（前 120 字符）；读某任务笔记全文请用 task_notes。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_reset', description: '清空当前蜂群计划（重新开始时用）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'task_ready', description: '查询当前依赖已满足、可派发的任务列表。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'task_claim', description: '子代理领取任务（原子操作，防重复派发）。taskId + owner（子代理标识，如 agent-1）。',
    inputSchema: { type: 'object', required: ['taskId', 'owner'], properties: { taskId: { type: 'string' }, owner: { type: 'string' } } },
  },
  {
    name: 'task_update', description: '更新任务状态（pending/claimed/in_progress/blocked/done/failed/skipped）或追加进展笔记。子代理汇报进度走这里；状态转移有守卫，非 owner 改不了他人任务。主代理在会话中断恢复等场景可用 force:true 强制改状态（会在 log 留「强制改状态」事件）。笔记有上限：每任务保留最新 ' + DEFAULT_MAX_NOTES + ' 条（可用环境变量 TASKSWARM_MAX_NOTES 调整），单条超 ' + DEFAULT_MAX_NOTE_CHARS + ' 字符截断并标记；被丢弃的条数记在 task.notesDropped，读全文用 task_notes。',
    inputSchema: {
      type: 'object', required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
        note: { type: 'string' },
        owner: { type: 'string' },
        force: { type: 'boolean', description: '仅主代理用于会话中断恢复：跳过状态转移/归属守卫强制改状态，并记 log' },
      },
    },
  },
  {
    name: 'task_add', description: '执行中途追加任务（支持多级拆解持续发生）。{title,detail?,dependsOn?,parentId?}。',
    inputSchema: {
      type: 'object', required: ['title'],
      properties: { title: { type: 'string' }, detail: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' } },
    },
  },
  {
    name: 'task_notes', description: '读取单个任务的笔记全文（分页，只读）。plan_get/board 只给 60~120 字符摘要，本工具返回完整原文。taskId 必填；limit 默认 20、上限 200；offset 默认 0（从最新往回数，0 = 最新一条）。返回 { taskId, total, notesDropped, offset, limit, returned, hasMore, notes:[{at,owner,note}] }；分页拼接：offset=0 取最新一页，再以 offset+limit 取更早一页，直到 hasMore=false。total 只统计当前保留条数，历史因上限丢弃的条数见 notesDropped（总数 = 保留数 + 丢弃数）。',
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
    name: 'board', description: '共享进度看板：所有任务的实时状态、负责人、最新进展笔记（每条只给前 60 字符摘要，读全文用 task_notes）。子代理用它了解其他代理进度。',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: '可选，只看某 owner 的任务' } } },
  },
  {
    name: 'state', description: '整体状态落盘 save/load/clear（会话恢复用）。save 需提供完整 state 对象。',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, state: { type: 'object' } } },
  },
];

const HANDLERS = {
  plan_create: planCreate,
  plan_get: planGet,
  plan_reset: planReset,
  task_ready: taskReady,
  task_claim: taskClaim,
  task_update: taskUpdate,
  task_add: taskAdd,
  task_notes: taskNotes,
  board: board,
  state: stateTool,
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
      const result = handler(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(err.message ?? err) }) }], isError: true });
    }
  }
  return reply(id, null, new Error(`未知方法: ${method}`));
});
rl.on('close', () => process.exit(0));
