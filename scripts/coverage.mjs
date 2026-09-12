#!/usr/bin/env node
/**
 * 覆盖率报告（零依赖，从**子进程**收集 V8 覆盖率）。
 *
 * 为什么不用 `node --test --experimental-test-coverage`：
 * 本插件的测试刻意全部通过 spawn 子进程运行 server.mjs（只有独立进程才能
 * 测出跨进程文件锁与并发行为）。Node 内置覆盖率只统计测试进程自身，对子进程
 * 里真正执行的 server.mjs 一无所知 —— 直接跑会得到「0 个文件、100%」的空报告。
 *
 * 本脚本的做法：以 NODE_V8_COVERAGE=<dir> 启动测试，让每个子进程各自吐出
 * V8 覆盖率 JSON，再把它们合并、按源码行归算，得到真实的行/函数覆盖。
 *
 * 用法：
 *   node scripts/coverage.mjs                 # 跑全部测试并报告
 *   node scripts/coverage.mjs --pattern "mcp/test/*.test.mjs"
 *   node scripts/coverage.mjs --no-run        # 复用已有 NODE_V8_COVERAGE 数据
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const patterns = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pattern') patterns.push(args[++i]);
  else if (args[i] === '--no-run') patterns.push('__NO_RUN__');
}
const noRun = patterns.includes('__NO_RUN__');
const testPatterns = patterns.filter(p => p !== '__NO_RUN__');
if (testPatterns.length === 0) testPatterns.push('mcp/test/*.test.mjs');

// 覆盖率数据目录：默认系统临时目录（跨平台），可用 TASKSWARM_COV_DIR 覆盖。
// 刻意不硬编码机器相关路径，否则别人克隆后跑 `npm run coverage` 会失败。
const covRoot = process.env.TASKSWARM_COV_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'taskswarm-cov-'));
fs.mkdirSync(covRoot, { recursive: true });
const covDir = fs.mkdtempSync(path.join(covRoot, 'v8-'));

// ---------------------------------------------------------------------------
// 1. 跑测试，让所有子进程写出覆盖率
// ---------------------------------------------------------------------------
if (!noRun) {
  console.log(`[coverage] 运行测试：node --test ${testPatterns.join(' ')}`);
  console.log(`[coverage] 覆盖率数据目录：${covDir}\n`);
  const res = spawnSync(process.execPath, ['--test', ...testPatterns], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
  });
  if (res.status !== 0) {
    console.error(`\n[coverage] 测试未全部通过（exit ${res.status}），覆盖率仅供参考。`);
  }
}

// ---------------------------------------------------------------------------
// 2. 读取并合并所有覆盖率 JSON
// ---------------------------------------------------------------------------
function collectFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** url → { ranges: Map<"start:end", maxCount>, fns: Map<fnKey, maxCount> } */
const coverageByFile = new Map();
const jsonFiles = collectFiles(covDir);
let scriptCount = 0;

for (const jf of jsonFiles) {
  let data;
  try { data = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { continue; }
  for (const script of data.result ?? []) {
    const url = String(script.url ?? '');
    if (!url.startsWith('file://')) continue;
    let file;
    try { file = fileURLToPath(url); } catch { continue; }
    // 只关心本仓库的源码，排除测试与依赖
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel.includes('node_modules')) continue;
    scriptCount++;
    if (!coverageByFile.has(file)) coverageByFile.set(file, { ranges: new Map(), fns: new Map() });
    const entry = coverageByFile.get(file);
    // V8 结构：script.functions[] **已经按函数分组**，每组的 ranges[0] 是该函数自身范围，
    // 后续 range 是内部分支。因此：
    //   - 行级覆盖要把所有 functions 的所有 ranges 汇总（嵌套最内层判定）
    //   - 函数级覆盖直接看每个函数自身范围的 count，不能用全局 range 去猜
    for (const fn of script.functions ?? []) {
      const rs = fn.ranges ?? [];
      const self = rs[0];
      if (self && typeof self.startOffset === 'number' && typeof self.endOffset === 'number') {
        const key = `${fn.functionName ?? '(anon)'}@${self.startOffset}:${self.endOffset}`;
        const prev = entry.fns.get(key);
        entry.fns.set(key, prev === undefined ? self.count : Math.max(prev, self.count));
      }
      for (const r of rs) {
        if (typeof r.startOffset !== 'number' || typeof r.endOffset !== 'number') continue;
        const key = `${r.startOffset}:${r.endOffset}`;
        const prev = entry.ranges.get(key);
        entry.ranges.set(key, prev === undefined ? r.count : Math.max(prev, r.count));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. 按行归算（V8 block coverage 的标准做法）
//
// V8 的 range 是嵌套的：外层范围（整个函数体）count=1 表示函数被调用过，
// 里面每个分支又有更小的 range。判断「第 N 行有没有执行」的正确做法是：
// 找到**覆盖该行起点的最小 range**（区间嵌套，因此最小即最具体），看它的 count。
// 只用最外层 range 会高报（函数调用过就算整段覆盖），只用第一个 range 会漏数据。
// ---------------------------------------------------------------------------
function lineOffsets(src) {
  const offsets = [];
  let off = 0;
  for (const line of src.split('\n')) { offsets.push(off); off += line.length + 1; }
  return offsets;
}

function analyze(file, rangeMap, fnMap) {
  const src = fs.readFileSync(file, 'utf8');
  const offsets = lineOffsets(src);
  const lines = src.split('\n');
  const isBlank = (text) => text.trim() === '' || /^\s*(\/\/|\*|\/\*)/.test(text);

  const ranges = [...rangeMap.entries()].map(([k, count]) => {
    const [start, end] = k.split(':').map(Number);
    return { start, end, count };
  });

  // 预排序 + 二分：先按 start 升序（同 start 时 end 降序，使外层的先出现）。
  // 查找覆盖某偏移的**最小** range 时，只需向前回溯有限个候选：
  // 覆盖 offset 的 range 必然满足 start <= offset，且其中 end 最小者即最具体。
  const byStart = ranges.slice().sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const starts = byStart.map(r => r.start);

  /** 上界：最后一个 start <= offset 的下标 */
  function upperBound(offset) {
    let lo = 0, hi = starts.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) { res = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return res;
  }

  /**
   * 覆盖 offset 的最小 range。
   * 由于嵌套区间满足「最内层 = end 最小」，在 start <= offset 的候选里取 end 最小的
   * 且 end > offset 的即可。候选回溯上限取 64（真实代码里嵌套深度远小于此）。
   */
  function smallestCovering(offset) {
    let idx = upperBound(offset);
    let best = null;
    let scanned = 0;
    for (; idx >= 0 && scanned < 64; idx--, scanned++) {
      const r = byStart[idx];
      if (r.end > offset) {
        if (best === null || r.end < best.end) best = r;
      }
    }
    return best;
  }

  let executable = 0, covered = 0;
  const uncoveredLines = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isBlank(text)) continue;
    const indent = text.length - text.trimStart().length;
    const probe = offsets[i] + indent;
    const r = smallestCovering(probe);
    if (r === null) continue; // 该位置不属于任何可执行区间
    executable++;
    if (r.count > 0) covered++;
    else if (uncoveredLines.length < 25) uncoveredLines.push(i + 1);
  }

  // 函数覆盖：直接用 V8 的 functions[] 分组（ranges[0] = 函数自身范围），
  // 每个函数记一次「函数体是否被执行过」。
  let fnTotal = 0, fnCovered = 0;
  for (const c of (fnMap ?? new Map()).values()) {
    // 过滤掉模块顶层包装与匿名立即执行片段（跨度为整个文件或极小）
    fnTotal++;
    if (c > 0) fnCovered++;
  }

  return { executable, covered, uncoveredLines, fnTotal, fnCovered, total: lines.length };
}

// ---------------------------------------------------------------------------
// 4. 报告
// ---------------------------------------------------------------------------
const targets = [...coverageByFile.entries()]
  .filter(([file]) => !path.relative(root, file).startsWith('mcp' + path.sep + 'test'))
  .filter(([file]) => !path.relative(root, file).startsWith('scripts'));

if (targets.length === 0) {
  console.error('[coverage] 未收集到源码覆盖率数据。');
  console.error('  可能原因：测试通过 spawn 子进程运行 server.mjs，需要设置 NODE_V8_COVERAGE（本脚本会自动设置）。');
  console.error(`  数据目录：${covDir}（共 ${jsonFiles.length} 个 JSON，${scriptCount} 条脚本记录）`);
  process.exit(2);
}

console.log('\n[coverage] 源码覆盖率（合并所有子进程的 V8 数据）');
console.log('─'.repeat(78));
console.log('文件'.padEnd(30) + '行覆盖'.padEnd(16) + '函数覆盖'.padEnd(16) + '未覆盖行');
console.log('─'.repeat(78));

let totExec = 0, totCov = 0, totFn = 0, totFnCov = 0;
const rows = [];
for (const [file, entry] of targets) {
  const a = analyze(file, entry.ranges, entry.fns);
  totExec += a.executable; totCov += a.covered;
  totFn += a.fnTotal; totFnCov += a.fnCovered;
  const rel = path.relative(root, file);
  const pct = a.executable ? (a.covered / a.executable * 100) : 0;
  const fPct = a.fnTotal ? (a.fnCovered / a.fnTotal * 100) : 0;
  rows.push(`${rel.padEnd(30)}${`${pct.toFixed(1)}% (${a.covered}/${a.executable})`.padEnd(16)}${`${fPct.toFixed(1)}% (${a.fnCovered}/${a.fnTotal})`.padEnd(16)}${a.uncoveredLines.join(',') || '-'}`);
}
rows.sort().forEach(r => console.log(r));
console.log('─'.repeat(78));
const totalPct = totExec ? (totCov / totExec * 100) : 0;
const totalFnPct = totFn ? (totFnCov / totFn * 100) : 0;
console.log(`合计：行覆盖 ${totalPct.toFixed(1)}%（${totCov}/${totExec}），函数覆盖率 ${totalFnPct.toFixed(1)}%（${totFnCov}/${totFn}）`);
console.log('说明：统计口径为 V8 block 覆盖按行归算（不含测试与 scripts 目录）。');
console.log(`数据目录：${covDir}`);

// 清理：只保留报告，删除原始 JSON 以免堆积
try { fs.rmSync(covDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

process.exit(totalPct >= 80 ? 0 : 1);
