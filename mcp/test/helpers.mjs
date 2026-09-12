/**
 * 测试辅助：以真实子进程方式拉起 MCP server，走完整的 stdio JSON-RPC 链路。
 *
 * 为什么不直接 import server.mjs：本插件的正确性核心（文件锁、原子写、并发行为）
 * 只有在**独立进程**下才成立——同进程内共享模块状态，测不出跨进程竞态。
 * 所以全部测试都通过 spawn 子进程进行，与真实运行方式一致。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

/**
 * 活跃子进程登记表。
 *
 * 存在的意义：测试若中途抛错或进程被强杀，`after()` 钩子可能来不及执行，
 * spawn 出来的 server 子进程就会变成孤儿进程一直挂着（实测遇到过 4 个孤儿）。
 * 这里做两道兜底：
 *   1. `process.on('exit')` 同步强杀所有登记的子进程；
 *   2. 未捕获异常/信号时同样清理，避免污染使用者的环境。
 * 每个 connect() 成功退出时会自行注销，正常路径不受影响。
 */
const liveChildren = new Set();

function registerChild(child) {
  liveChildren.add(child);
  const drop = () => liveChildren.delete(child);
  child.once('exit', drop);
  child.once('close', drop);
  return child;
}

function reapAll() {
  for (const c of liveChildren) {
    try { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  liveChildren.clear();
}

process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { reapAll(); process.exit(130); });
}

/**
 * 测试用临时根目录。
 *
 * 默认使用系统临时目录（跨平台），可用环境变量 TASKSWARM_TEST_TMP 覆盖。
 * 注意：这里刻意**不硬编码任何机器相关路径**——否则别人克隆后跑 `npm test`
 * 会因目录不存在或权限不足而失败（或把文件写到意料之外的位置）。
 */
export function tempRoot() {
  const override = process.env.TASKSWARM_TEST_TMP;
  if (override) {
    try {
      fs.mkdirSync(override, { recursive: true });
      return override;
    } catch {
      // 覆盖值不可用（路径非法/无权限）时退回系统临时目录，不阻断测试
    }
  }
  if (!cachedTempRoot) {
    cachedTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskswarm-test-'));
  }
  return cachedTempRoot;
}
let cachedTempRoot = null;

/** 创建一个隔离的工作区目录（每个测试用例一个，互不干扰）。 */
export function makeWorkspace(label = 'ws') {
  return fs.mkdtempSync(path.join(tempRoot(), `${label}-`));
}

export function rmWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
}

/**
 * 连接一个 MCP server 子进程。
 * 返回 { call, rpc, raw, kill, exited }。
 *  - call(name, args)  调工具；工具级错误抛出带 error 文本的异常
 *  - callRaw(name,args) 调工具；不抛异常，返回 {ok:true,data} 或 {ok:false,error}
 */
export function connect(env = {}, options = {}) {
  const child = registerChild(spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: { ...process.env, ...env },
  }));
  let nextId = 1;
  const pending = new Map();
  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.on('data', (buf) => {
    stdoutBuf += buf.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on('data', (b) => { stderrBuf += b.toString(); });

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`JSON-RPC 超时（${method}）；stderr: ${stderrBuf.slice(0, 300)}`));
      }, 30000);
      const wrapped = (v) => { clearTimeout(timer); resolve(v); };
      pending.set(id, wrapped);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async function callRaw(name, args) {
    const res = await rpc('tools/call', { name, arguments: args ?? {} });
    if (res.error) return { ok: false, error: `rpc: ${res.error.message}` };
    const text = res.result?.content?.[0]?.text ?? '';
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: `返回不是 JSON: ${text.slice(0, 200)}` }; }
    if (res.result.isError) return { ok: false, error: String(data.error ?? text) };
    return { ok: true, data };
  }

  async function call(name, args) {
    const r = await callRaw(name, args);
    if (!r.ok) throw new Error(`[${name}] ${r.error}`);
    return r.data;
  }

  /** 写入原始文本（用于测「非法 JSON 不崩」） */
  function raw(text) { child.stdin.write(text); }

  return {
    child,
    call,
    callRaw,
    rpc,
    raw,
    stderr: () => stderrBuf,
    /**
     * 关闭连接。
     * 默认走**优雅退出**：server 监听 readline 的 close 事件，stdin 结束即 exit(0)。
     * 这一点对覆盖率统计是必需的——V8 只在进程正常退出时才写出
     * NODE_V8_COVERAGE 数据；强杀会让该进程的覆盖率凭空消失。
     * 需要模拟崩溃的场景请显式用 killHard()。
     */
    kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // 先关 stdin：server 的 readline 'close' 处理器会让它 exit(0)，
      // 这样 V8 才有机会把 NODE_V8_COVERAGE 数据落盘。
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      // 兜底：给 1.5s 优雅退出；超时再强杀，避免测试挂住。
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 1500);
      if (typeof t.unref === 'function') t.unref();
      child.once('exit', () => clearTimeout(t));
    },
    killHard() { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } },
    exited: () => child.exitCode !== null,
  };
}

/** 便捷：连接 + 建计划 + 自动清理 */
export async function withServer(fn, { env = {}, label = 'ws' } = {}) {
  const c = connect(env);
  const ws = makeWorkspace(label);
  try {
    return await fn({ ...c, workspace: ws });
  } finally {
    c.kill();
    rmWorkspace(ws);
  }
}

/** 简易断言计数器，用于在 node:test 之外做汇总（如并发脚本） */
export function tally() {
  const state = { passed: 0, failed: 0, failures: [] };
  return {
    state,
    check(label, cond, extra = '') {
      if (cond) { state.passed++; return true; }
      state.failed++;
      state.failures.push(`${label}${extra ? ' → ' + extra : ''}`);
      return false;
    },
    report() {
      return `${state.passed} passed, ${state.failed} failed`;
    },
  };
}
