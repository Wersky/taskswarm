#!/usr/bin/env node
/**
 * taskswarm Web 控制台 —— 产品版的人类界面（3.0 新增）。
 *
 * 零 npm 依赖：node:http + 内嵌单页前端（原生 JS，零构建）。
 * 数据通道与 MCP server 完全共享：同一个 core.mjs、同一个状态库（WAL 多进程并发），
 * 审批走 store.taskReview() 同一核心函数——控制台不绕状态机、不直改数据库。
 *
 * 安全边界：默认只监听 127.0.0.1（本机工具，勿用 --host 0.0.0.0 暴露到网络）；
 * 控制台只有「只读 + 审批」两个动作，不提供任意写状态的能力。
 *
 * 启动：node ui/server.mjs --workspace <项目目录> --reviewer <审核者身份> [--port 7788]
 * 环境：Node ≥ 23.4（node:sqlite）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../mcp/core.mjs';

// ---------------------------------------------------------------------------
// 参数解析（手工解析，保持零依赖）
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { port: 7788, host: '127.0.0.1', workspace: '', reviewer: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = String(argv[++i]);
    else if (a === '--workspace') out.workspace = String(argv[++i]);
    else if (a === '--reviewer') out.reviewer = String(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.workspace) {
  console.log('用法：node ui/server.mjs --workspace <项目目录> --reviewer <审核者身份>（审批必需） [--port 7788] [--host 127.0.0.1]');
  process.exit(args.help ? 0 : 1);
}
if (!args.reviewer) {
  console.log('提示：未提供 --reviewer，审批接口将拒绝所有审批请求（403）。需要审批时请以 --reviewer <审核者身份> 重启控制台。');
}

let store;
try {
  store = Store.for({ workspace: args.workspace });
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/state') {
    const data = store.boardTasks();
    const rev = store.rev();
    if (!data) return json(res, 200, { active: false, rev, reviewer: args.reviewer });
    return json(res, 200, { active: true, rev, reviewer: args.reviewer, workspace: store.dbPath, ...data });
  }
  if (req.method === 'GET' && p.startsWith('/api/task/')) {
    const taskId = decodeURIComponent(p.slice('/api/task/'.length));
    try {
      const { result, rev } = { result: store.taskDetail(taskId), rev: store.rev() };
      return json(res, 200, { rev, ...result });
    } catch (err) {
      return json(res, 404, { error: String(err.message ?? err) });
    }
  }
  if (req.method === 'GET' && p === '/api/events') {
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    return json(res, 200, { rev: store.rev(), lastEventId: store.lastEventId(), events: store.eventsSince(since, 200) });
  }
  if (req.method === 'POST' && p === '/api/review') {
    let body = '';
    for await (const chunk of req) body += chunk;
    // 审批身份只认启动参数：body.owner 一律忽略。若信任请求体，本机任意进程
    // 都能填个 reviewer 身份冒充审批人，审核门等于形同虚设。
    if (!args.reviewer) {
      return json(res, 403, { error: '/api/review: 控制台启动时未提供 --reviewer，无法确定审批身份，审批被拒绝。下一步：以 --reviewer <审核者身份> 重启控制台（身份须与任务登记的 reviewer 一致）。' });
    }
    let input;
    try { input = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: '请求体不是合法 JSON' }); }
    const verdict = String(input.verdict ?? '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(verdict)) {
      return json(res, 400, { error: 'verdict 必须是 approve 或 reject' });
    }
    if (verdict === 'reject' && String(input.reason ?? '').trim() === '') {
      return json(res, 400, { error: '驳回必须填写 reason（写明要改什么）' });
    }
    try {
      const r = store.taskReview({
        taskId: String(input.taskId ?? ''),
        verdict,
        ...(verdict === 'reject' ? { reason: String(input.reason ?? '').trim() } : {}),
        // 身份取启动参数 args.reviewer；body.owner 一律忽略（防止请求体冒充审批人）
        owner: args.reviewer,
      });
      return json(res, 200, { rev: r.rev, ...r.result });
    } catch (err) {
      return json(res, 400, { error: String(err.message ?? err) });
    }
  }
  return json(res, 404, { error: `未知 API：${p}` });
}

// ---------------------------------------------------------------------------
// SSE 实时推送：轮询库内 rev（15 次每秒内的轻量 SELECT），变化即推
// ---------------------------------------------------------------------------
const sseClients = new Set();
setInterval(() => {
  let rev;
  try { rev = store.rev(); } catch { return; }
  for (const res of sseClients) {
    if (res.lastRev !== rev) {
      res.lastRev = rev;
      try { res.write(`event: change\ndata: {"rev":${rev}}\n\n`); } catch { sseClients.delete(res); }
    }
  }
}, 1500).unref();

// ---------------------------------------------------------------------------
// 前端单页（内嵌；原生 JS 零构建。中文界面）
// ---------------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务蜂群 · 控制台</title>
<style>
:root { --bg:#0f1419; --panel:#161d26; --card:#1d2633; --line:#2a3646; --text:#dce4ee; --dim:#8496ab;
  --accent:#4fc3f7; --ok:#81c784; --warn:#ffb74d; --err:#e57373; --review:#ba68c8; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--text); font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; }
header { display:flex; align-items:center; gap:16px; padding:10px 20px; background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
header h1 { font-size:16px; color:var(--accent); white-space:nowrap; }
#goal { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.pill { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:2px 12px; font-size:12px; white-space:nowrap; }
.pill b { color:var(--accent); }
#lanes { display:flex; gap:12px; padding:14px 20px; align-items:flex-start; overflow-x:auto; }
.lane { flex:1 1 0; min-width:220px; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
.lane h2 { font-size:13px; padding:8px 12px; border-bottom:1px solid var(--line); color:var(--dim); }
.lane h2 .n { float:right; color:var(--text); }
.card { margin:8px; padding:8px 10px; background:var(--card); border:1px solid var(--line); border-left:3px solid var(--dim); border-radius:8px; cursor:pointer; }
.card:hover { border-color:var(--accent); }
.card .id { color:var(--dim); font-size:12px; margin-right:6px; }
.card .t { font-weight:600; }
.card .meta { font-size:12px; color:var(--dim); margin-top:2px; }
.card .parent-tag { color:var(--dim); opacity:.85; }
.card { transition:margin-left .15s; }
.card .note { font-size:12px; color:var(--dim); margin-top:4px; border-top:1px dashed var(--line); padding-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.st-pending { border-left-color:#90a4ae; } .st-claimed,.st-in_progress { border-left-color:var(--accent); }
.st-pending_review { border-left-color:var(--review); } .st-done { border-left-color:var(--ok); opacity:.75; }
.st-failed { border-left-color:var(--err); } .st-skipped { border-left-color:#a1887f; opacity:.75; }
.st-blocked { border-left-color:var(--warn); }
#drawer { position:fixed; top:0; right:-560px; width:560px; max-width:95vw; height:100vh; background:var(--panel);
  border-left:1px solid var(--line); transition:right .2s; overflow-y:auto; padding:20px; z-index:10; }
#drawer.open { right:0; }
#drawer h3 { color:var(--accent); margin-bottom:8px; }
#drawer .kv { display:grid; grid-template-columns:110px 1fr; gap:2px 10px; font-size:13px; margin:10px 0; }
#drawer .kv span:nth-child(odd) { color:var(--dim); }
.sec { margin:14px 0 4px; color:var(--dim); font-size:12px; border-bottom:1px solid var(--line); padding-bottom:4px; }
.note-item, .ev-item { padding:6px 8px; border-left:2px solid var(--line); margin:6px 0; font-size:13px; }
.note-item .who, .ev-item .who { color:var(--accent); font-size:12px; margin-right:8px; }
.ev-item .at, .note-item .at { color:var(--dim); font-size:11px; }
.reject-tag { color:var(--err); font-weight:700; }
#reviewBox { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; margin-top:12px; }
#reviewBox textarea { width:100%; min-height:60px; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px; font:inherit; margin:8px 0; }
button { border:0; border-radius:6px; padding:8px 18px; cursor:pointer; font:inherit; color:#102027; font-weight:700; }
#btnApprove { background:var(--ok); } #btnReject { background:var(--err); margin-left:10px; }
#msg { margin-top:8px; font-size:13px; }
#mask { position:fixed; inset:0; background:rgba(0,0,0,.4); display:none; z-index:9; }
#mask.show { display:block; }
.empty { color:var(--dim); text-align:center; padding:20px 0; font-size:12px; }
#conn { width:9px; height:9px; border-radius:50%; background:var(--err); display:inline-block; }
#conn.live { background:var(--ok); }
</style>
</head>
<body>
<header>
  <h1>🐝 任务蜂群</h1>
  <span id="goal">加载中…</span>
  <span class="pill">rev <b id="rev">-</b></span>
  <span class="pill">审核人 <b id="reviewer">-</b></span>
  <span class="pill" id="costPill" style="display:none">成本 <b id="cost"></b></span>
  <span class="pill"><span id="conn"></span> <span id="connText">连接中</span></span>
</header>
<div id="lanes"></div>
<div id="mask" onclick="closeDrawer()"></div>
<div id="drawer"></div>
<script>
var LANES = [
  { key:'todo',  name:'待办',      match:function(s){ return s==='pending'||s==='blocked'; } },
  { key:'wip',   name:'进行中',    match:function(s){ return s==='claimed'||s==='in_progress'; } },
  { key:'rev',   name:'待审核',    match:function(s){ return s==='pending_review'; } },
  { key:'done',  name:'已完成',    match:function(s){ return s==='done'; } },
  { key:'dead',  name:'失败 / 跳过', match:function(s){ return s==='failed'||s==='skipped'; } },
];
var CURRENT = null;

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function render(d){
  document.getElementById('goal').textContent = d.goal || (d.active? '':'（无进行中的蜂群）');
  document.getElementById('rev').textContent = d.rev;
  document.getElementById('reviewer').textContent = d.reviewer || '-';
  var cp = document.getElementById('costPill');
  if (d.cost) { cp.style.display=''; document.getElementById('cost').textContent = d.cost.tokens + ' tok / ' + d.cost.minutes + ' min'; }
  var lanes = document.getElementById('lanes');
  lanes.innerHTML = '';
  if (!d.active) { lanes.innerHTML = '<div class="empty" style="flex:1">当前工作区没有进行中的蜂群 —— 用 plan_create 建立计划后刷新</div>'; return; }
  LANES.forEach(function(lane){
    var tasks = d.tasks.filter(function(t){ return lane.match(t.status); });
    var el = document.createElement('div'); el.className='lane';
    var h = '<h2>' + esc(lane.name) + ' <span class="n">' + tasks.length + '</span></h2>';
    tasks.forEach(function(t){
      // 任务树层级：按 depth 缩进 + 「└ 属于」标记——泳道内父子关系一眼可见。
      // depth 数据来自 /api/state 的 tasks[].depth（boardTasks 已返回），纯 CSS 缩进不引入库。
      var indent = Math.min(t.depth || 0, 6) * 14;
      h += '<div class="card st-' + esc(t.status) + '" style="margin-left:' + indent + 'px"'
        + ' onclick="openTask(\\'' + esc(t.id) + '\\')">'
        + '<span class="id">[' + esc(t.id) + ']</span><span class="t">' + esc(t.title) + '</span>'
        + '<div class="meta">'
        + (t.parent ? '<span class="parent-tag">└ 属于 ' + esc(t.parent) + '</span> ' : '')
        + (t.owner ? '@' + esc(t.owner) : '')
        + (t.assignee ? ' → 建议:' + esc(t.assignee) : '')
        + (t.reviewer && t.reviewStage==='pending' ? ' ⏳ 待 ' + esc(t.reviewer) + ' 审核' : '')
        + (t.reviewer && t.reviewStage==='rejected' ? ' <span class="reject-tag">✖ 已驳回</span>' : '')
        + (t.status==='blocked' ? ' ⛔' : '')
        + (t.costTokens||t.costMinutes ? ' · ' + t.costTokens + 'tok/' + t.costMinutes + 'min' : '')
        + '</div>';
      t.latestNotes.forEach(function(n){
        h += '<div class="note">💬' + esc(n.owner) + ':' + esc(n.note) + '</div>';
      });
      if (t.noteCount > t.latestNotes.length) h += '<div class="note">（共 ' + t.noteCount + ' 条）</div>';
      h += '</div>';
    });
    if (!tasks.length) h += '<div class="empty">空</div>';
    el.innerHTML = h;
    lanes.appendChild(el);
  });
}

function refresh(){ fetch('/api/state').then(function(r){ return r.json(); }).then(render).catch(function(){ connState(false); }); }

function openTask(id){
  fetch('/api/task/' + encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { alert(d.error); return; }
    CURRENT = id;
    var el = document.getElementById('drawer');
    var t = d.task;
    var h = '<h3>[' + esc(t.id) + '] ' + esc(t.title) + '</h3>'
      + '<div class="kv">'
      + '<span>状态</span><span>' + esc(t.status) + (t.reviewStage && t.reviewStage!=='none' ? '（审核:' + esc(t.reviewStage) + '）' : '') + '</span>'
      + '<span>负责人</span><span>' + esc(t.owner ?? '-') + '</span>'
      + '<span>角色/建议</span><span>' + esc(t.role==='none'?'-':t.role) + ' / ' + esc(t.assignee ?? '-') + '</span>'
      + '<span>审核者</span><span>' + esc(t.reviewer ?? '-') + '</span>'
      + '<span>依赖</span><span>' + esc((t.dependsOn||[]).join(', ') || '-') + '</span>'
      + '<span>时间</span><span>领 ' + esc(t.claimedAt ?? '-') + ' · 完 ' + esc(t.finishedAt ?? '-') + '</span>'
      + '<span>成本</span><span>' + (t.costTokens||t.costMinutes ? t.costTokens + ' tok / ' + t.costMinutes + ' min' : '-') + '</span>'
      + '</div>';
    if (t.detail) h += '<div class="sec">说明</div><div>' + esc(t.detail) + '</div>';
    h += '<div class="sec">笔记全文（' + d.notes.length + ' 条' + (t.notesDropped? '，历史丢弃 ' + t.notesDropped : '') + '）</div>';
    d.notes.forEach(function(n){ h += '<div class="note-item"><span class="who">' + esc(n.owner) + '</span><span class="at">' + esc(n.at) + '</span><div>' + esc(n.note) + '</div></div>'; });
    if (!d.notes.length) h += '<div class="empty">无笔记</div>';
    h += '<div class="sec">事件流（最近 ' + d.events.length + ' 条）</div>';
    d.events.forEach(function(e){ h += '<div class="ev-item"><span class="who">' + esc(e.event) + '</span><span class="at">' + esc(e.at) + (e.owner? ' · ' + esc(e.owner):'') + '</span>' + (e.detail? '<div>' + esc(e.detail) + '</div>':'') + '</div>'; });
    if (t.status==='pending_review' && t.reviewer) {
      h += '<div id="reviewBox"><b>审核裁决</b>（以 ' + esc(d.reviewerName ?? REVIEWER) + ' 身份提交，需与登记的 reviewer 一致）'
        + '<textarea id="reason" placeholder="驳回时必填：写明要改什么"></textarea>'
        + '<button id="btnApprove" onclick="review(\\'approve\\')">✔ 通过（下游放行）</button>'
        + '<button id="btnReject" onclick="review(\\'reject\\')">✖ 打回重做</button>'
        + '<div id="msg"></div></div>';
    }
    el.innerHTML = h;
    el.classList.add('open');
    document.getElementById('mask').classList.add('show');
  });
}
function closeDrawer(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('mask').classList.remove('show');
}
function review(verdict){
  var reason = (document.getElementById('reason')||{}).value || '';
  var btns = document.querySelectorAll('#reviewBox button');
  btns.forEach(function(b){ b.disabled = true; });
  fetch('/api/review', { method:'POST', headers:{'Content-Type':'application/json'},
    // 身份由服务端按启动参数 --reviewer 决定；body 里传 owner 也不会被采纳
    body: JSON.stringify({ taskId: CURRENT, verdict: verdict, reason: reason }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var m = document.getElementById('msg');
      if (d.error) { m.textContent = '❌ ' + d.error; m.style.color='var(--err)'; btns.forEach(function(b){ b.disabled=false; }); }
      else { m.textContent = '✅ ' + (d.hint || '已裁决'); m.style.color='var(--ok)'; setTimeout(closeDrawer, 900); refresh(); }
    });
}
var REVIEWER = '';
function connState(ok){
  var c = document.getElementById('conn');
  c.className = ok ? 'live' : '';
  document.getElementById('connText').textContent = ok ? '实时' : '断开';
}
var es = new EventSource('/api/watch');
es.addEventListener('open', function(){ connState(true); });
es.addEventListener('change', function(){ refresh(); });
es.addEventListener('error', function(){ connState(false); });
fetch('/api/state').then(function(r){ return r.json(); }).then(function(d){
  REVIEWER = d.reviewer || '（未指定 --reviewer）';
  render(d);
});
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  // SSE 必须在 /api/ 前缀分支之前判断（否则被 404 掉）
  if (url.pathname === '/api/watch') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.lastRev = store.rev();
    res.write(`event: hello\ndata: {"rev":${res.lastRev}}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(args.port, args.host, () => {
  console.log(`任务蜂群控制台已启动：http://${args.host}:${args.port}`);
  console.log(`  工作区：${store.dbPath}`);
  console.log(`  审批身份：${args.reviewer || '未指定（审批请求将被拒绝，重启时加 --reviewer）'}`);
  if (args.host !== '127.0.0.1') console.log('  ⚠️ 正在监听非回环地址——控制台无鉴权，请勿暴露到不受信任的网络。');
});

// 优雅退出：Ctrl+C / kill 时关闭监听与 SQLite 句柄再退出。
// 除产品体验外还有个实际原因：强杀（SIGKILL）会让 V8 覆盖率数据丢失，
// 导致 ui/server.mjs 永远进不了 coverage 报告。
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref(); // 兜底：有连接挂住时也退出
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
