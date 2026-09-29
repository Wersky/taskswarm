/**
 * CLI（cli/taskswarm.mjs）测试。
 *
 * 与 helpers.mjs 的 MCP 子进程测试同一哲学：CLI 是 core 的另一个薄层入口，
 * 必须以真实子进程方式跑完整链路（参数解析 → Store → 退出码），而不是同进程
 * import 后直接调函数——那样测不出 argv 解析、stdout/stderr 分流与退出码。
 *
 * CLI 与 MCP 的行为契约：同一命令走同一 Store 方法、同一状态机守卫；
 * 本文件只断言 CLI 层自己的职责（映射、错误分流、退出码），核心语义由
 * 其他测试文件覆盖，避免重复。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, rmWorkspace } from './helpers.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'taskswarm.mjs');

/**
 * 跑一次 CLI 子进程。
 * 返回 { code, stdout, stderr, json }：json 是 stdout 的 JSON 解析结果（仅 exit 0 时断言用）。
 */
function run(ws, cliArgs, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...cliArgs, '--workspace', ws], {
      encoding: 'utf8',
      ...(input !== undefined ? { input } : {}),
    }, (err, stdout, stderr) => {
      // err = 非 0 退出时由 execFile 给出，退出码在 err.code
      resolve({ code: err ? err.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function runOk(ws, cliArgs, opts) {
  const r = await run(ws, cliArgs, opts);
  assert.equal(r.code, 0, `应成功退出：${cliArgs.join(' ')}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function runFail(ws, cliArgs, match) {
  const r = await run(ws, cliArgs);
  assert.equal(r.code, 1, `应退出 1：${cliArgs.join(' ')}\nstdout: ${r.stdout}`);
  const parsed = JSON.parse(r.stderr);
  assert.match(parsed.error, match, 'stderr 应是 {"error":...} 且信息可定位');
  return parsed;
}

function writeJson(ws, name, obj) {
  const file = path.join(ws, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('CLI', () => {
  test('--version 与 package.json 一致', async () => {
    const ws = makeWorkspace('cli-ver');
    try {
      const r = await run(ws, ['--version']);
      assert.equal(r.code, 0);
      const pkg = JSON.parse(fs.readFileSync(path.join(CLI, '..', '..', 'package.json'), 'utf8'));
      assert.equal(r.stdout.trim(), pkg.version);
    } finally { rmWorkspace(ws); }
  });

  test('无命令/help 打印用法；未知命令退出 1 且 error 落在 stderr', async () => {
    const ws = makeWorkspace('cli-help');
    try {
      const none = await run(ws, []);
      assert.equal(none.code, 1);
      assert.match(none.stdout, /用法：taskswarm/);
      const help = await run(ws, ['help']);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /plan-create/);
      const bad = await run(ws, ['不存在的命令']);
      assert.equal(bad.code, 1);
      assert.match(JSON.parse(bad.stderr).error, /未知命令/);
    } finally { rmWorkspace(ws); }
  });

  test('空工作区 board：active=false 且带 rev', async () => {
    const ws = makeWorkspace('cli-empty');
    try {
      const b = await runOk(ws, ['board']);
      assert.equal(b.active, false);
      assert.equal(typeof b.rev, 'number');
    } finally { rmWorkspace(ws); }
  });

  test('全链路：plan-create（宽容解析 {goal,tasks} 对象）→ ready → claim → update → board → notes', async () => {
    const ws = makeWorkspace('cli-e2e');
    try {
      const file = writeJson(ws, 'tasks.json', {
        goal: 'CLI 端到端',
        tasks: [
          { id: 'a', title: '甲' },
          { id: 'b', title: '乙', dependsOn: ['a'] },
        ],
      });
      const created = await runOk(ws, ['plan-create', '--goal', 'CLI 端到端', '--tasks-file', file]);
      assert.equal(created.taskCount, 2);

      const ready = await runOk(ws, ['ready']);
      assert.deepEqual(ready.ready.map(t => t.id), ['a'], '依赖未满足的 b 不应就绪');

      const claimed = await runOk(ws, ['claim', 'a', '--owner', 'agent-1']);
      assert.equal(claimed.task.id, 'a');

      await runOk(ws, ['update', 'a', '--status', 'in_progress', '--owner', 'agent-1']);
      const done = await runOk(ws, ['update', 'a', '--status', 'done', '--owner', 'agent-1', '--note', '收工', '--cost-tokens', '1200']);
      assert.equal(done.task.status, 'done');

      const board = await runOk(ws, ['board']);
      assert.equal(board.active, true);
      assert.match(board.view, /\[a\] \(done\)/);

      const notes = await runOk(ws, ['notes', 'a']);
      assert.equal(notes.total, 1);
      assert.match(notes.notes[0].note, /收工/);
      const paged = await runOk(ws, ['notes', 'a', '--limit', '5']);
      assert.equal(paged.limit, 5);

      const cost = board.cost?.total?.tokens ?? board.cost?.tokens;
      assert.ok(cost === undefined || cost >= 1200, '成本汇总出现时不得丢失上报值');
    } finally { rmWorkspace(ws); }
  });

  test('PPR 审核门经 CLI 同样生效：错身分拒绝、真 reviewer 放行、下游解堵', async () => {
    const ws = makeWorkspace('cli-ppr');
    try {
      const file = writeJson(ws, 'tasks.json', [
        { id: 'impl', title: '实现', reviewer: 'wersky/agent-3' },
        { id: 'ship', title: '发布', dependsOn: ['impl'] },
      ]);
      await runOk(ws, ['plan-create', '--goal', 'g', '--tasks-file', file]);
      await runOk(ws, ['claim', 'impl', '--owner', 'wersky/agent-1']);
      await runOk(ws, ['update', 'impl', '--status', 'done', '--owner', 'wersky/agent-1']);

      const gated = await runOk(ws, ['plan']);
      assert.match(gated.view, /\[impl\] \(pending_review\)/, '有 reviewer 时 done 必须转 pending_review');

      await runFail(ws, ['review', 'impl', '--verdict', 'approve', '--owner', '冒充者'], /reviewer/);
      await runFail(ws, ['review', 'impl', '--verdict', 'approve'], /reviewer|身份/);

      const ok = await runOk(ws, ['review', 'impl', '--verdict', 'approve', '--owner', 'wersky/agent-3']);
      assert.equal(ok.task.status, 'done');

      const ready = await runOk(ws, ['ready']);
      assert.deepEqual(ready.ready.map(t => t.id), ['ship'], '过审后下游才放行');
    } finally { rmWorkspace(ws); }
  });

  test('add / --depends-on 逗号列表 / --parent-id 挂树', async () => {
    const ws = makeWorkspace('cli-add');
    try {
      const file = writeJson(ws, 'tasks.json', [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }]);
      await runOk(ws, ['plan-create', '--goal', 'g', '--tasks-file', file]);
      const added = await runOk(ws, ['add', '--title', '丙', '--depends-on', 'a,b', '--parent-id', 'a', '--reviewer', 'r1']);
      assert.ok(added.rev !== undefined);
      const snap = await runOk(ws, ['state', 'load']);
      const c = Object.values(snap.state.tasks).find(t => t.title === '丙');
      assert.ok(c, '追加的任务应在状态里');
      assert.deepEqual(c.dependsOn, ['a', 'b']);
      assert.equal(c.parent, 'a');
      assert.equal(c.reviewer, 'r1');
    } finally { rmWorkspace(ws); }
  });

  test('state load / plan-reset / state save --file：快照恢复闭环', async () => {
    const ws = makeWorkspace('cli-state');
    try {
      const file = writeJson(ws, 'tasks.json', [{ id: 'a', title: '甲' }]);
      await runOk(ws, ['plan-create', '--goal', 'g', '--tasks-file', file]);

      const loaded = await runOk(ws, ['state', 'load']);
      assert.equal(loaded.exists, true);
      const snapshot = writeJson(ws, 'snapshot.json', loaded.state);

      await runOk(ws, ['plan-reset']);
      const empty = await runOk(ws, ['board']);
      assert.equal(empty.active, false);

      await runOk(ws, ['state', 'save', '--file', snapshot]);
      const restored = await runOk(ws, ['state', 'load']);
      assert.equal(restored.exists, true);
      assert.ok(Object.keys(restored.state.tasks).length >= 1, '快照恢复后任务应回来');
    } finally { rmWorkspace(ws); }
  });

  test('stdin 传任务数组（--tasks-file -）', async () => {
    const ws = makeWorkspace('cli-stdin');
    try {
      const r = await runOk(ws, ['plan-create', '--goal', 'stdin', '--tasks-file', '-'], {
        input: JSON.stringify([{ id: 's1', title: '流式' }]),
      });
      assert.equal(r.taskCount, 1);
    } finally { rmWorkspace(ws); }
  });

  test('参数校验：坏 status / 缺 owner / 不存在的任务 / 坏 JSON 文件', async () => {
    const ws = makeWorkspace('cli-bad');
    try {
      await runFail(ws, ['update', 'a', '--status', '乱写'], /pending/);
      await runFail(ws, ['claim', 'a'], /--owner/);
      await runFail(ws, ['plan-create', '--goal', 'g', '--tasks-file', '不存在的文件.json'], /无法读取/);
      const bad = path.join(ws, 'bad.json');
      fs.writeFileSync(bad, '{oops'); // 原样写坏文本，不能 JSON.stringify（会变成合法字符串字面量）
      await runFail(ws, ['plan-create', '--goal', 'g', '--tasks-file', bad], /合法 JSON/);
      const file = writeJson(ws, 'tasks.json', [{ id: 'a', title: '甲' }]);
      await runOk(ws, ['plan-create', '--goal', 'g', '--tasks-file', file]);
      await runFail(ws, ['update', '不存在的id', '--status', 'in_progress', '--owner', 'x'], /不存在|找不到|未知/);
      await runFail(ws, ['state', '乱写'], /save \/ load \/ clear/);
    } finally { rmWorkspace(ws); }
  });

  test('serve 把控制台拉起来：/api/state 经 HTTP 可访问（无 reviewer 可启动、审批才受限）', async () => {
    const ws = makeWorkspace('cli-serve');
    // 端口选互不相交频段（ui.test 硬编码 17901-17902，enterprise 用 18100+/18500+）
    const port = 19100 + (process.pid % 400);
    try {
      const child = execFile(process.execPath, [CLI, 'serve', '--workspace', ws, '--port', String(port)]);
      const t0 = Date.now();
      let body = null;
      while (Date.now() - t0 < 10000) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/state`);
          body = await res.json();
          break;
        } catch { await new Promise(r => setTimeout(r, 200)); }
      }
      assert.ok(body && typeof body.rev === 'number', '控制台应在 10s 内就绪并返回 {rev,...}');
      // 3.0 安全约定：无 --reviewer 启动时审批端点必须 403，不能借 body.owner 冒充
      const res = await fetch(`http://127.0.0.1:${port}/api/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: '冒充者', taskId: 'x', verdict: 'approve' }),
      });
      assert.equal(res.status, 403);
      child.kill();
    } finally { rmWorkspace(ws); }
  });
});
