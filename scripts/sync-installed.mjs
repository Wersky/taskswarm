#!/usr/bin/env node
/**
 * sync-installed.mjs — 把 taskswarm 源目录同步到 ZCode 已安装插件缓存。
 *
 * 背景：源目录（本仓库）与已安装缓存（ZCode 的 plugins/cache/<marketplace>/<plugin>/<version>/）
 * 是两份独立拷贝，手工同步必然漂移。本脚本做单向镜像：源 → 缓存。
 *
 * 用法（在仓库根目录）：
 *   node scripts/sync-installed.mjs                 # 同步到「当前版本 + 缓存中已存在的版本目录」
 *   node scripts/sync-installed.mjs --check         # 只检查是否漂移，不写任何文件（漂移则退出码 1，可用于 CI）
 *   node scripts/sync-installed.mjs --dry-run       # 打印将要做的改动，不写文件
 *   node scripts/sync-installed.mjs --targets 1.0.0,2.0.0
 *   node scripts/sync-installed.mjs --prune         # 额外删除目标里「源中已不存在」的文件
 *
 * 可选参数：
 *   --source <dir>        源目录（默认：本脚本的上上级目录）
 *   --cache-root <dir>    插件缓存根（默认：<用户主目录>/.zcode/cli/plugins/cache）
 *   --marketplace <name>  市场名（默认：自动探测缓存中含 taskswarm 的市场目录）
 *
 * 排除项：状态落盘目录「任务蜂群/」、_swarm-tmp/、node_modules/、.git/、
 *         *.tmp-* / *.corrupt-*.json / *.lock / .lock / 日志与系统噪音文件。
 *
 * 关于「同时同步多个版本目录」：ZCode 的 installed_plugins.json 用 installPath 指向某个
 * 具体版本目录（例如 .../taskswarm/1.0.0），插件实际加载的是那份拷贝。只写 2.0.0 而不同步
 * 1.0.0 的话，已安装的 1.0.0 仍是旧代码，必须重新安装才生效。因此本脚本默认把源内容同时
 * 镜像到「当前版本目录 + 缓存中已存在的版本目录」，让修复无需重装即可生效。
 * 副作用：1.0.0 目录里的 manifest 也会变成 2.0.0，出现 installPath=1.0.0 而内容为 2.0.0
 * 的短暂不一致。想要干净状态，注册市场后从「设置 → 插件管理」重装 taskswarm 即可。
 *
 * 退出码：0 成功（或检查通过）；1 漂移（--check）；2 参数/环境错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const HELP = `用法：node scripts/sync-installed.mjs [选项]

把 taskswarm 源目录单向同步到 ZCode 已安装插件缓存（源 → 缓存）。

选项：
  --check               只检查是否漂移，不写任何文件（漂移则退出码 1，可用于 CI）
  --dry-run             打印将要做的改动，不写文件
  --prune               额外删除目标里「源中已不存在」的文件
  --targets <v1,v2>     指定版本目录（默认：当前版本 + 缓存中已存在的版本目录）
  --source <dir>        源目录（默认：本脚本的上上级目录）
  --cache-root <dir>    插件缓存根（默认：<用户主目录>/.zcode/cli/plugins/cache）
  --marketplace <name>  市场名（默认：自动探测缓存中含 taskswarm 的市场目录）
  -h, --help            显示本帮助

排除项：状态落盘目录「任务蜂群/」、_swarm-tmp/、node_modules/、.git/，
        以及 *.tmp-* / *.corrupt-*.json / *.lock / .lock / 日志与系统噪音文件。
`;

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const opts = { check: false, dryRun: false, prune: false, targets: null, source: null, cacheRoot: null, marketplace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--check': opts.check = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--prune': opts.prune = true; break;
      case '--targets': opts.targets = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--source': opts.source = next(); break;
      case '--cache-root': opts.cacheRoot = next(); break;
      case '--marketplace': opts.marketplace = next(); break;
      case '-h':
      case '--help': opts.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  if (opts.check && opts.dryRun) throw new Error('--check 与 --dry-run 语义重复，只用一个');
  return opts;
}

// ---------- 排除规则 ----------
const EXCLUDED_DIRS = new Set(['任务蜂群', '_swarm-tmp', 'node_modules', '.git']);
const EXCLUDED_FILE_RE = [
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /\.log$/i,
  /^\.lock$/,
  /\.lock$/i,
  /\.tmp-/i,          // server.mjs 原子写的临时文件
  /\.corrupt-.*\.json$/i, // 读取端隔离的损坏文件
];

function isExcluded(relPath, isDir) {
  const base = path.basename(relPath);
  if (isDir) return EXCLUDED_DIRS.has(base);
  return EXCLUDED_FILE_RE.some((re) => re.test(base));
}

function shouldSkipDirWalk(base) {
  return EXCLUDED_DIRS.has(base);
}

// ---------- 文件收集 ----------
function collectFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`无法读取目录 ${dir}：${e.message}`);
    }
    for (const ent of entries) {
      const relPath = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) {
        if (shouldSkipDirWalk(ent.name)) continue;
        walk(path.join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        if (isExcluded(relPath, false)) continue;
        out.push(relPath);
      }
      // 符号链接等其它类型一律跳过，避免同步出意外指向
    }
  };
  walk(root, '');
  return out.sort();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sameContent(a, b) {
  let sa, sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  if (sa.size !== sb.size) return false;
  return sha256(a) === sha256(b);
}

// ---------- 版本目录解析 ----------
function readVersion(root) {
  for (const p of ['package.json', path.join('.zcode-plugin', 'plugin.json')]) {
    const f = path.join(root, p);
    if (!fs.existsSync(f)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).version;
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      // 忽略，继续找下一个
    }
  }
  return null;
}

function listInstalledVersions(pluginRoot) {
  try {
    return fs.readdirSync(pluginRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 探测 taskswarm 装在哪个市场目录下。
 *
 * 市场名由使用者自己起（本机是 wersky-local，别人可能叫别的），因此不能写死默认值：
 * 在缓存根下扫描一层，找哪个市场目录里含有 taskswarm。找不到时退回 'wersky-local'
 * 并在提示里告知可用 --marketplace 指定。
 */
function detectMarketplace(cacheRoot) {
  try {
    const hit = fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .find((name) => {
        try {
          return fs.existsSync(path.join(cacheRoot, name, 'taskswarm'));
        } catch {
          return false;
        }
      });
    if (hit) return hit;
  } catch {
    // 缓存根不存在（尚未安装过插件）：用默认名，后续会给出清晰报错
  }
  return 'wersky-local';
}

// ---------- 主流程 ----------
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[sync-installed] ${e.message}`);
    console.error('用 --help 查看用法。');
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const source = path.resolve(opts.source || repoRoot);
  const cacheRoot = path.resolve(opts.cacheRoot || path.join(os.homedir(), '.zcode', 'cli', 'plugins', 'cache'));

  if (!fs.existsSync(source)) {
    console.error(`[sync-installed] 源目录不存在：${source}`);
    return 2;
  }

  const currentVersion = readVersion(source);
  const marketplace = opts.marketplace || detectMarketplace(cacheRoot);
  const pluginRoot = path.join(cacheRoot, marketplace, 'taskswarm');

  // 目标版本：显式 --targets > 当前版本 + 缓存中已存在的版本目录（保证老版本安装不被漏掉）
  let targets;
  if (opts.targets) {
    targets = opts.targets;
  } else {
    const set = new Set();
    if (currentVersion) set.add(currentVersion);
    for (const v of listInstalledVersions(pluginRoot)) set.add(v);
    targets = [...set];
  }

  if (targets.length === 0) {
    console.error('[sync-installed] 无法确定目标版本：源中找不到 version，可用 --targets 指定');
    return 2;
  }
  const bad = targets.filter((v) => !VERSION_RE.test(v));
  if (bad.length) {
    console.error(`[sync-installed] 非法版本号：${bad.join(', ')}`);
    return 2;
  }

  const files = collectFiles(source);

  console.log(`[sync-installed] 源        : ${source}`);
  console.log(`[sync-installed] 缓存根    : ${cacheRoot}`);
  console.log(`[sync-installed] 插件      : taskswarm@${marketplace}`);
  console.log(`[sync-installed] 当前版本  : ${currentVersion || '(未知)'}`);
  console.log(`[sync-installed] 目标版本  : ${targets.join(', ')}`);
  console.log(`[sync-installed] 待同步文件: ${files.length} 个（已排除状态目录与临时文件）`);
  console.log(`[sync-installed] 模式      : ${opts.check ? '检查（只读）' : opts.dryRun ? '预演（不写盘）' : '写入'}${opts.prune ? ' + prune' : ''}`);

  let drift = 0;
  const write = !opts.check && !opts.dryRun;
  const actions = [];

  for (const version of targets) {
    const dest = path.join(pluginRoot, version);
    actions.push(`\n── ${version} → ${dest}`);
    if (!fs.existsSync(dest)) {
      if (opts.check) {
        actions.push(`  ✗ 目录不存在（未安装 ${version}）`);
        drift++;
      } else if (write) {
        fs.mkdirSync(dest, { recursive: true });
        actions.push('  + 创建目录');
      } else {
        actions.push('  + 将创建目录');
      }
    }

    let added = 0, updated = 0, unchanged = 0;
    for (const rel of files) {
      const src = path.join(source, rel);
      const dst = path.join(dest, rel);
      const exists = fs.existsSync(dst);
      if (exists && sameContent(src, dst)) {
        unchanged++;
        continue;
      }
      const verb = exists ? '~ 更新' : '+ 新增';
      if (exists) updated++; else added++;
      if (opts.check) {
        actions.push(`  ✗ ${verb.slice(2)} ${rel}`);
        drift++;
        continue;
      }
      actions.push(`  ${verb} ${rel}`);
      if (write) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }

    // 目标里多出的文件 = 源里已删除的残留
    const stale = [];
    const walkDest = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const relPath = rel ? path.join(rel, ent.name) : ent.name;
        if (ent.isDirectory()) {
          if (shouldSkipDirWalk(ent.name)) continue;
          walkDest(path.join(dir, ent.name), relPath);
        } else if (ent.isFile()) {
          if (isExcluded(relPath, false)) continue;
          if (!files.includes(relPath)) stale.push(relPath);
        }
      }
    };
    if (fs.existsSync(dest)) walkDest(dest, '');
    for (const rel of stale.sort()) {
      if (opts.prune) {
        actions.push(`  - 删除（源中已不存在） ${rel}`);
        drift++;
        if (write) fs.rmSync(path.join(dest, rel), { force: true });
      } else {
        actions.push(`  ! 残留（源中已不存在，--prune 可清理） ${rel}`);
      }
    }

    actions.push(`  小计：新增 ${added}，更新 ${updated}，一致 ${unchanged}${stale.length ? `，残留 ${stale.length}` : ''}`);
  }

  console.log(actions.join('\n'));

  if (opts.check) {
    if (drift > 0) {
      console.log(`\n[sync-installed] 检测到漂移：${drift} 处。运行 node scripts/sync-installed.mjs 修复。`);
      return 1;
    }
    console.log('\n[sync-installed] 检查通过：缓存与源一致。');
    return 0;
  }

  if (opts.dryRun) {
    console.log('\n[sync-installed] 预演结束，未写入任何文件。去掉 --dry-run 实际同步。');
    return 0;
  }

  console.log('\n[sync-installed] 同步完成。');
  console.log('[sync-installed] 提示：若 ZCode 仍加载旧版本，检查 ~/.zcode/cli/plugins/installed_plugins.json');
  console.log('                 里的 installPath/version，或从 设置 → 插件管理 重装 taskswarm 后再开会话。');
  return 0;
}

process.exit(main());
