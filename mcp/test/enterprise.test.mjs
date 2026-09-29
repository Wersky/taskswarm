/**
 * 企业版能力测试（4.0）：控制台访问令牌 + 审计导出。
 *
 * 令牌是 opt-in：不配置时行为必须与 3.x 完全一致（所有测试照旧通过）；
 * 配置后所有路由（静态页、/api/*、SSE）统一过认证门。
 * 审计导出的承诺：完整事件时间线 = 归档文件（按序在前）+ 库内现存，
 * 附计数与导出摘要 sha256——审计能「查清、追责」的前提是导出完整且可校验。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, rmWorkspace } from './helpers.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'server.mjs');
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'taskswarm.mjs');

/** 拉起控制台并等监听就绪；返回 { child, port }。 */
function startUi(ws, port, { token, envToken } = {}) {
  const argv = [UI, '--workspace', ws, '--port', String(port)];
  if (token) argv.push('--token', token);
  const env = { ...process.env };
  if (envToken) env.TASKSWARM_CONSOLE_TOKEN = envToken;
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('UI server 未监听')), 10000);
    const probe = () => {
      http.get({ host: '127.0.0.1', port, path: '/' }, res => {
        res.resume();
        clearTimeout(t);
        resolve({ child, port });
      }).on('error', () => setTimeout(probe, 200));
    };
    probe();
  });
}

function get(port, reqPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: reqPath, headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function runCli(ws, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--workspace', ws], { encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

describe('企业版：控制台访问令牌（opt-in）', () => {
  // 端口频段互不相交：ui.test 硬编码 17901-17902，cli serve 用 19100+，本文件令牌组 18100+、导出组 18500+
  const port = 18100 + (process.pid % 50);
  let portSeq = 0;
  const nextPort = () => port + (portSeq++);

  test('未配置令牌：无令牌请求照常 200（3.x 行为不变）', async () => {
    const ws = makeWorkspace('ent-open');
    try {
      const { child, port: p } = await startUi(ws, nextPort());
      try {
        const r = await get(p, '/api/state');
        assert.equal(r.status, 200);
        assert.equal(JSON.parse(r.body).active, false);
      } finally { child.kill(); }
    } finally { rmWorkspace(ws); }
  });

  test('配置令牌：缺令牌 401、错令牌 401、Bearer 与 ?token= 均可、静态页与 SSE 同样过门', async () => {
    const ws = makeWorkspace('ent-token');
    try {
      const { child, port: p } = await startUi(ws, nextPort(), { token: 's3cret' });
      try {
        assert.equal((await get(p, '/api/state')).status, 401, '缺令牌必须 401');
        assert.equal((await get(p, '/api/state?token=wrong')).status, 401, '错令牌必须 401');
        assert.equal((await get(p, '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
        assert.equal((await get(p, '/api/state?token=s3cret')).status, 200, '?token= 应放行');
        assert.equal((await get(p, '/api/state', { headers: { Authorization: 'Bearer s3cret' } })).status, 200, 'Bearer 应放行');
        assert.equal((await get(p, '/')).status, 401, '静态页也要令牌');
        assert.equal((await get(p, '/?token=s3cret')).status, 200, '带令牌的静态页 200');

        // SSE：EventSource 只能走 query 参数
        const sse = await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: p, path: '/api/watch?token=s3cret' }, res => {
            res.resume();
            resolve({ status: res.statusCode, type: res.headers['content-type'] });
          }).on('error', reject);
        });
        assert.equal(sse.status, 200);
        assert.match(sse.type, /text\/event-stream/);
        const sseDenied = await get(p, '/api/watch');
        assert.equal(sseDenied.status, 401, 'SSE 缺令牌必须 401');
      } finally { child.kill(); }
    } finally { rmWorkspace(ws); }
  });

  test('环境变量 TASKSWARM_CONSOLE_TOKEN 与 --token 等效', async () => {
    const ws = makeWorkspace('ent-env');
    try {
      const { child, port: p } = await startUi(ws, nextPort(), { envToken: 'env-secret' });
      try {
        assert.equal((await get(p, '/api/state')).status, 401);
        assert.equal((await get(p, '/api/state?token=env-secret')).status, 200);
      } finally { child.kill(); }
    } finally { rmWorkspace(ws); }
  });
});

describe('企业版：审计导出', () => {
  test('/api/export：返回完整导出（计数 + sha256 + 事件数组）', async () => {
    const ws = makeWorkspace('ent-export');
    try {
      // 先用 CLI 造一个「计划创建」事件
      const tasksFile = path.join(ws, 'tasks.json');
      fs.writeFileSync(tasksFile, JSON.stringify([{ id: 'a', title: '甲' }]));
      const made = await runCli(ws, ['plan-create', '--goal', '导出验证', '--tasks-file', tasksFile]);
      assert.equal(made.code, 0);
      const { child, port: p } = await startUi(ws, 18500 + (process.pid % 50));
      try {
        const r = await get(p, '/api/export');
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.ok(j.exported >= 1, '至少含「计划创建」事件');
        assert.equal(j.exported, j.events.length);
        assert.match(j.sha256, /^[0-9a-f]{64}$/);
        assert.ok(j.archives.length === 0 && j.archivedCount === 0, '新工作区应无归档');
      } finally { child.kill(); }
    } finally { rmWorkspace(ws); }
  });

  test('CLI audit：归档在前、库内在后；json 模式含计数与 sha256；--file 写文件并给 stderr 摘要', async () => {
    const ws = makeWorkspace('ent-audit');
    try {
      const tasksFile = path.join(ws, 'tasks.json');
      fs.writeFileSync(tasksFile, JSON.stringify([{ id: 'a', title: '甲' }]));
      const made = await runCli(ws, ['plan-create', '--goal', 'g', '--tasks-file', tasksFile]);
      assert.equal(made.code, 0);
      await runCli(ws, ['update', 'a', '--status', 'done', '--owner', 'o1', '--note', '审计线索']);

      // 手工伪造一份归档（模拟 TASKSWARM_MAX_EVENTS 溢出后的历史事件）
      const archiveDir = path.join(ws, '任务蜂群');
      fs.writeFileSync(path.join(archiveDir, 'events-archive-1.jsonl'),
        JSON.stringify({ at: '2026-09-01T00:00:00.000Z', event: '旧事件(归档)' }) + '\n');

      const jsonl = await runCli(ws, ['audit']);
      assert.equal(jsonl.code, 0);
      const lines = jsonl.stdout.trim().split('\n').map(l => JSON.parse(l));
      assert.equal(lines[0].event, '旧事件(归档)', '归档事件必须排最前');
      assert.ok(lines.some(l => l.event === '计划创建'), '库内事件在后');
      assert.ok(lines.some(l => l.event === '进展' || l.event === '完成'), '笔记/状态事件在内');

      const json = await runCli(ws, ['audit', '--format', 'json']);
      const j = JSON.parse(json.stdout);
      assert.equal(j.exported, lines.length, 'json 计数与 jsonl 行数一致');
      assert.ok(j.archivedCount === 1 && j.archives.includes('events-archive-1.jsonl'));
      assert.match(j.sha256, /^[0-9a-f]{64}$/);

      const outFile = path.join(ws, 'audit-out.jsonl');
      const toFile = await runCli(ws, ['audit', '--format', 'jsonl', '--file', outFile]);
      assert.equal(toFile.code, 0);
      const summary = JSON.parse(toFile.stderr);
      assert.equal(summary.exported, j.exported);
      assert.equal(summary.sha256, j.sha256, 'stderr 摘要的 sha256 与 json 模式一致');
      assert.equal(fs.readFileSync(outFile, 'utf8').trim().split('\n').length, j.exported);
    } finally { rmWorkspace(ws); }
  });

  test('audit 参数校验：坏 --format 退出 1；空工作区导出 0 条不报错', async () => {
    const ws = makeWorkspace('ent-bad');
    try {
      const bad = await runCli(ws, ['audit', '--format', 'csv']);
      assert.equal(bad.code, 1);
      assert.match(JSON.parse(bad.stderr).error, /jsonl 或 json/);

      const empty = await runCli(ws, ['audit', '--format', 'json']);
      assert.equal(empty.code, 0);
      const j = JSON.parse(empty.stdout);
      assert.equal(j.exported, 0);
      assert.deepEqual(j.events, []);
    } finally { rmWorkspace(ws); }
  });
});
