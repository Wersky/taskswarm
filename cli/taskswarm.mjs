#!/usr/bin/env node
/**
 * taskswarm CLI —— 非 MCP 客户端的命令行入口（3.1 新增）。
 *
 * 与 MCP server（mcp/server.mjs）完全同层：同一个 core.mjs、同一个状态库、
 * 同一套状态机守卫。给三类人用：
 *   1. 不支持 MCP 的宿主/脚本（cron、CI、shell 管道）
 *   2. 人类在终端快速查板/审批/追加任务
 *   3. npx 场景（package.json bin.taskswarm）
 *
 * 输出约定：成功 → stdout 打 JSON（result 与 rev 合并，规则同 MCP 层）；失败 →
 * stderr 打 {"error":...}，退出码 1。所有命令都支持 --workspace <目录>（缺省 = 当前目录），
 * 状态库位置与 MCP/控制台一致：<workspace>/任务蜂群/swarm-state.db。
 *
 * 写操作前统一 reclaimStale()（失联任务惰性回收），与 MCP server 行为逐字对齐。
 *
 * 环境：Node ≥ 23.4（node:sqlite）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Store, SERVER_VERSION, TASK_STATUSES,
} from '../mcp/core.mjs';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 参数解析（手工解析，保持零依赖；支持 --flag value 与 --flag=value）
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      let name = a;
      let value;
      const eq = a.indexOf('=');
      if (eq > 0) { name = a.slice(0, eq); value = a.slice(eq + 1); }
      else {
        const next = argv[i + 1];
        // 「-h」「--help」这类无值布尔：下一个参数存在且不像旗标时才当作值
        // 例外：`-` 本身是合法值（stdin 约定，--tasks-file - / --file -）
        if (next !== undefined && (!next.startsWith('-') || next === '-') && !BOOL_FLAGS.has(name)) value = next;
        if (value !== undefined) i++;
      }
      flags[name] = value === undefined ? true : value;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}
const BOOL_FLAGS = new Set(['--force', '--help', '-h', '--version', '-v']);

function usage() {
  return `taskswarm ${SERVER_VERSION} —— 多宿主任务蜂群协调层（CLI）

用法：taskswarm <命令> [参数] [--workspace <目录>]

查（只读）：
  plan                                任务树全貌 + 就绪任务（= plan_get）
  ready                               当前可派发任务列表（= task_ready）
  board [--owner <身份>]              共享进度看板 + 成本汇总
  notes <taskId> [--limit N] [--offset N]   任务笔记全文（分页）
  state load                          导出完整状态快照

写（蜂群操作）：
  plan-create --goal <总目标> --tasks-file <tasks.json|->   一次多级任务拆解（会覆盖已有计划）
  plan-reset                          清空当前计划
  add --title <标题> [--detail D] [--depends-on a,b] [--parent-id P]
      [--role planner|producer|reviewer] [--reviewer <身份>] [--assignee <身份>]
  claim <taskId> --owner <身份>       原子领取（返回体含上游全量笔记）
  update <taskId> [--status S] [--note N] [--owner <身份>]
      [--cost-tokens N] [--cost-minutes N] [--force]
  review <taskId> --verdict approve|reject [--reason R] [--owner <身份>]
      [--force] [--proposals-file <proposals.json>]
  state save --file <state.json>      导入完整状态快照（会话恢复）
  state clear                         清空（= plan-reset）
  audit [--format jsonl|json] [--file <导出路径>]
                                      审计导出：归档 + 库内全部事件的完整时间线
                                      （默认 jsonl 到 stdout；json 含计数与 sha256）

其他：
  serve [--port 7788] [--reviewer <身份>] [--workspace <目录>] [--token <访问令牌>]
                                      启动 Web 控制台（与 MCP 共享同一状态库）
  --version | help                    版本 / 本帮助

环境变量：TASKSWARM_STALE_MINUTES、TASKSWARM_MAX_NOTES、TASKSWARM_LOCK_TIMEOUT_MS 等与 MCP 一致。
状态库：<workspace>/任务蜂群/swarm-state.db（SQLite）。`;
}

function fail(message) {
  process.stderr.write(JSON.stringify({ error: message }, null, 2) + '\n');
  process.exit(1);
}

function need(flags, name, label) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') fail(`缺少参数 ${name}${label ? `（${label}）` : ''}`);
  return String(v);
}

function optString(flags, name) {
  const v = flags[name];
  return v === undefined || v === true ? undefined : String(v);
}

function optInt(flags, name, label) {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${name} 必须是数字（当前：${v}）${label ? `（${label}）` : ''}`);
  return n;
}

/** 读 JSON 文件（- 表示 stdin）；plan_create 的 tasks、task_review 的 proposals 用 */
function readJsonFile(file, what) {
  let raw;
  try {
    raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  } catch (err) {
    return fail(`无法读取${what}文件 ${file}：${err.message}`);
  }
  try { return JSON.parse(raw); } catch (err) {
    return fail(`${what}不是合法 JSON：${err.message}`);
  }
}

function commaList(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') return undefined;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 命令 → Store 方法（与 mcp/server.mjs HANDLERS 一一对应）
// ---------------------------------------------------------------------------
const { flags, positional } = parseArgv(process.argv.slice(2));
const command = positional[0];

if (flags['--version'] || flags['-v']) {
  console.log(SERVER_VERSION);
  process.exit(0);
}
if (!command || command === 'help' || flags['--help'] || flags['-h']) {
  console.log(usage());
  process.exit(command ? 0 : 1);
}

const workspace = optString(flags, '--workspace') ?? optString(flags, '-w') ?? '';
const args = { workspace };

/** 各命令构造 store 入参；返回 null 表示已识别但无需触库（不会发生，防御用） */
const COMMANDS = {
  plan: () => ({ method: 'planGet', args }),
  ready: () => ({ method: 'taskReady', args }),
  board: () => {
    const owner = optString(flags, '--owner');
    return { method: 'board', args: owner ? { ...args, owner } : args };
  },
  notes: () => {
    const taskId = positional[1];
    if (!taskId) fail('缺少任务 id：taskswarm notes <taskId>');
    const limit = optInt(flags, '--limit');
    const offset = optInt(flags, '--offset');
    return { method: 'taskNotes', args: { ...args, taskId, ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) } };
  },
  'plan-create': () => {
    const goal = need(flags, '--goal', '总目标');
    const file = need(flags, '--tasks-file', '任务数组 JSON 文件路径，- 表示 stdin');
    const tasks = readJsonFile(file, '任务数组');
    // 宽容解析：纯数组 [{...}]，或整个计划对象 {goal?, tasks:[...]}（取其 tasks）
    const list = Array.isArray(tasks) ? tasks
      : (tasks && typeof tasks === 'object' && Array.isArray(tasks.tasks)) ? tasks.tasks
      : null;
    if (!list) fail('--tasks-file 的内容必须是任务数组（[{id?,title,...}]）');
    const failurePolicy = optString(flags, '--failure-policy');
    return { method: 'planCreate', args: { ...args, goal, tasks: list, ...(failurePolicy ? { failurePolicy } : {}) } };
  },
  'plan-reset': () => ({ method: 'planReset', args }),
  add: () => {
    const title = need(flags, '--title', '任务标题');
    const entry = { title };
    const detail = optString(flags, '--detail');
    const dependsOn = commaList(flags, '--depends-on');
    const parentId = optString(flags, '--parent-id');
    const role = optString(flags, '--role');
    const reviewer = optString(flags, '--reviewer');
    const assignee = optString(flags, '--assignee');
    if (detail !== undefined) entry.detail = detail;
    if (dependsOn) entry.dependsOn = dependsOn;
    if (parentId !== undefined) entry.parentId = parentId;
    if (role !== undefined) entry.role = role;
    if (reviewer !== undefined) entry.reviewer = reviewer;
    if (assignee !== undefined) entry.assignee = assignee;
    return { method: 'taskAdd', args: { ...args, ...entry } };
  },
  claim: () => {
    const taskId = positional[1];
    if (!taskId) fail('缺少任务 id：taskswarm claim <taskId> --owner <身份>');
    const owner = need(flags, '--owner', '领取者身份，如 agent-1');
    return { method: 'taskClaim', args: { ...args, taskId, owner } };
  },
  update: () => {
    const taskId = positional[1];
    if (!taskId) fail('缺少任务 id：taskswarm update <taskId> [--status S] [--note N] ...');
    const status = optString(flags, '--status');
    if (status !== undefined && !TASK_STATUSES.includes(status)) {
      fail(`--status 必须是 ${TASK_STATUSES.join('/')} 之一（当前：${status}）`);
    }
    const patch = { taskId };
    if (status !== undefined) patch.status = status;
    const note = optString(flags, '--note');
    if (note !== undefined) patch.note = note;
    const owner = optString(flags, '--owner');
    if (owner !== undefined) patch.owner = owner;
    const costTokens = optInt(flags, '--cost-tokens');
    const costMinutes = optInt(flags, '--cost-minutes');
    if (costTokens !== undefined || costMinutes !== undefined) {
      patch.cost = { ...(costTokens !== undefined ? { tokens: costTokens } : {}), ...(costMinutes !== undefined ? { minutes: costMinutes } : {}) };
    }
    if (flags['--force']) patch.force = true;
    return { method: 'taskUpdate', args: { ...args, ...patch } };
  },
  review: () => {
    const taskId = positional[1];
    if (!taskId) fail('缺少任务 id：taskswarm review <taskId> --verdict approve|reject');
    const verdict = need(flags, '--verdict', 'approve 或 reject');
    if (verdict !== 'approve' && verdict !== 'reject') fail('--verdict 必须是 approve 或 reject');
    const patch = { taskId, verdict };
    const reason = optString(flags, '--reason');
    if (reason !== undefined) patch.reason = reason;
    const owner = optString(flags, '--owner');
    if (owner !== undefined) patch.owner = owner;
    if (flags['--force']) patch.force = true;
    const proposalsFile = optString(flags, '--proposals-file');
    if (proposalsFile !== undefined) {
      const proposals = readJsonFile(proposalsFile, '提案数组');
      if (!Array.isArray(proposals)) fail('--proposals-file 的内容必须是提案数组（[{title,...}]）');
      patch.proposals = proposals;
    }
    return { method: 'taskReview', args: { ...args, ...patch } };
  },
  state: () => {
    const op = positional[1];
    if (op === 'load') return { method: 'stateTool', args: { ...args, op: 'load' } };
    if (op === 'clear') return { method: 'stateTool', args: { ...args, op: 'clear' } };
    if (op === 'save') {
      const file = need(flags, '--file', '状态快照 JSON 文件路径');
      const state = readJsonFile(file, '状态快照');
      return { method: 'stateTool', args: { ...args, op: 'save', state } };
    }
    fail('state 子命令必须是 save / load / clear 之一');
    return null;
  },
  audit: () => {
    const format = optString(flags, '--format') ?? 'jsonl';
    if (format !== 'jsonl' && format !== 'json') fail('--format 必须是 jsonl 或 json');
    const file = optString(flags, '--file');
    return { method: 'auditExport', args, format, file };
  },
  serve: () => {
    // 控制台独立进程：与 MCP/CLI 共享同一状态库；审批身份必须显式给
    const uiPath = path.join(CLI_ROOT, 'ui', 'server.mjs');
    const pass = ['--workspace', workspace || process.cwd()];
    const port = optInt(flags, '--port');
    if (port !== undefined) pass.push('--port', String(port));
    const reviewer = optString(flags, '--reviewer');
    if (reviewer !== undefined) pass.push('--reviewer', reviewer);
    const token = optString(flags, '--token');
    if (token !== undefined) pass.push('--token', token);
    const child = execFile(process.execPath, [uiPath, ...pass], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return null;
  },
};

const runner = COMMANDS[command];
if (!runner) fail(`未知命令：${command}（taskswarm help 查看用法）`);

const invocation = runner();
if (invocation) {
  try {
    const store = Store.for(invocation.args);
    store.reclaimStale(); // 与 MCP server 相同的惰性回收触发点
    // audit：auditExport 返回裸导出对象（无 rev 包装），jsonl 模式输出纯事件流不混 meta
    if (command === 'audit') {
      const export_ = store.auditExport();
      if (invocation.format === 'jsonl') {
        const body = export_.events.map(e => JSON.stringify(e)).join('\n') + (export_.events.length ? '\n' : '');
        if (invocation.file) {
          fs.writeFileSync(invocation.file, body);
          process.stderr.write(JSON.stringify({ ok: true, file: invocation.file, exported: export_.exported, sha256: export_.sha256 }, null, 2) + '\n');
        } else {
          process.stdout.write(body);
        }
      } else {
        process.stdout.write(JSON.stringify(export_, null, 2) + '\n');
      }
      process.exit(0);
    }
    const { result, rev } = store[invocation.method](invocation.args) ?? {};
    const payload = (result && typeof result === 'object' && !Array.isArray(result))
      ? { rev, ...result }
      : result;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } catch (err) {
    fail(String(err.message ?? err));
  }
}
