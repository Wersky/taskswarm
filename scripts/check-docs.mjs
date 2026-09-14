#!/usr/bin/env node
/**
 * 文档一致性核对：README / SKILL.md / commands 里出现的工具名、字段、常量，
 * 必须与 mcp/server.mjs 的真实实现一致。
 *
 * 动机：这次升级中真实出现过「文档写 mcp__taskswarm__ 而实际前缀是
 * mcp__plugin_taskswarm_taskswarm__」和「文档说 plan_get 返回 active 字段」两类错误，
 * 照文档写代码的人会直接踩坑。把它们变成一条可重复执行的检查，而不是靠人眼。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const problems = [];
function check(label, cond, extra = '') {
  if (cond) { pass++; return; }
  fail++;
  problems.push(`${label}${extra ? ' → ' + extra : ''}`);
};

// ---------- 从运行中的 server 取真实工具清单 ----------
const probe = spawnSync(process.execPath, [path.join(root, 'mcp', 'server.mjs')], {
  input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
  encoding: 'utf8',
  timeout: 20000,
});
const toolsReply = JSON.parse(String(probe.stdout).trim().split('\n')[0]);
const realTools = toolsReply.result.tools.map(t => t.name);
const realToolSet = new Set(realTools);

const serverSrc = read('mcp/server.mjs');
const manifest = JSON.parse(read('.zcode-plugin/plugin.json'));
const pkg = JSON.parse(read('package.json'));

// ---------- 1. 工具名核对 ----------
console.log('\n[1] 文档中提到的工具名是否都真实存在');
// 反引号内短名的候选集合从真实工具清单派生，而不是硬编码——
// 硬编码名单会同时漏掉两件事：文档提到不存在的工具、新工具没被文档提到。
const toolAlt = realTools.join('|');
for (const doc of ['README.md', 'skills/taskswarm/SKILL.md', 'commands/swarm.md']) {
  const text = read(doc);
  // 匹配 mcp__plugin_taskswarm_taskswarm__<name> 与反引号内的短名调用
  const fullNames = [...text.matchAll(/mcp__plugin_taskswarm_taskswarm__([a-z_]+)/g)].map(m => m[1]);
  const shortNames = [...text.matchAll(new RegExp('`(' + toolAlt + ')`', 'g'))].map(m => m[1]);
  // 反引号里形如 task_xxx 的短名：若不在真实清单中，说明文档写了不存在的工具
  const suspicious = [...text.matchAll(/`(task_[a-z_]+|plan_[a-z_]+|board|state)`/g)]
    .map(m => m[1]).filter(n => !realToolSet.has(n));
  const mentioned = new Set([...fullNames, ...shortNames]);
  for (const name of mentioned) {
    check(`${doc} 提到的工具 ${name} 存在`, realToolSet.has(name), `实际工具：${realTools.join(', ')}`);
  }
  check(`${doc} 未提到不存在的工具`, suspicious.length === 0, `疑似不存在的工具：${[...new Set(suspicious)].join(', ')}`);
  console.log(`  ${doc}: 提到 ${mentioned.size} 个工具名，全部核对`);
}
// README 作为展示门面，必须覆盖全部真实工具
{
  const readmeText = read('README.md');
  const missing = realTools.filter(t => !readmeText.includes('`' + t + '`'));
  check(`README 覆盖全部 ${realTools.length} 个工具`, missing.length === 0, `README 未提到：${missing.join(', ')}`);
}

// ---------- 2. 旧前缀残留 ----------
console.log('\n[2] 是否残留错误的旧前缀 mcp__taskswarm__（应为 0 处，文档中的「改正说明」除外）');
for (const doc of ['README.md', 'skills/taskswarm/SKILL.md', 'commands/swarm.md']) {
  const text = read(doc);
  // 允许出现在「已改正」的叙述里（形如 `mcp__taskswarm__*` 带星号，或引号包裹的对照说明）
  const bad = [...text.matchAll(/mcp__taskswarm__[a-z_]+/g)].map(m => m[0]);
  check(`${doc} 无旧前缀残留`, bad.length === 0, `发现 ${bad.length} 处：${bad.slice(0, 3).join(', ')}`);
}
// 反向：必须显著标注真实前缀
check('README 标注了真实前缀', read('README.md').includes('mcp__plugin_taskswarm_taskswarm__'));
check('SKILL.md 标注了真实前缀', read('skills/taskswarm/SKILL.md').includes('mcp__plugin_taskswarm_taskswarm__'));

// ---------- 3. 字段与常量核对 ----------
console.log('\n[3] 文档提到的字段/常量是否与实现一致');
const fieldChecks = [
  ['README.md', 'notesDropped'],
  ['README.md', 'blockedBy'],
  ['README.md', 'failurePolicy'],
  ['README.md', 'workSpace'.replace('S', 's') + ''], // workspace
  ['README.md', 'TASKSWARM_MAX_NOTES'],
  ['README.md', 'TASKSWARM_MAX_NOTE_CHARS'],
  ['README.md', 'force'],
  ['skills/taskswarm/SKILL.md', 'failurePolicy'],
  ['skills/taskswarm/SKILL.md', 'blockedBy'],
  ['skills/taskswarm/SKILL.md', 'task_notes'],
  ['skills/taskswarm/SKILL.md', 'TASKSWARM_MAX_NOTES'],
];
for (const [doc, token] of fieldChecks) {
  const inDoc = read(doc).includes(token);
  const inCode = serverSrc.includes(token) || pkg.scripts?.[token] !== undefined;
  check(`${doc} 的 ${token} 在实现中存在`, !inDoc || inCode, '文档提到了但代码里找不到');
}

// 关键字段的真实存在性（直接查实现）
for (const token of ['notesDropped', 'blockedBy', 'failurePolicy', 'force', 'task_notes', 'SERVER_VERSION', 'MAX_SUBTASK_DEPTH', 'DEFAULT_MAX_NOTES']) {
  check(`实现包含 ${token}`, serverSrc.includes(token));
}

// ---------- 4. plan_get 不得被描述为返回 active ----------
console.log('\n[4] 历史文档错误是否已消除');
const skill = read('skills/taskswarm/SKILL.md');
const badActiveClaim = /plan_get[^。\n]*返回[^。\n]*active\s*字段/.test(skill) && !/该字段只在\s*board/.test(skill);
check('SKILL.md 不再声称 plan_get 返回 active 字段', !badActiveClaim);
check('SKILL.md 说明无计划时 plan_get 会报错',
  /plan_get[^。\n]*(报错|报错|抛错)|无计划时[^。\n]*plan_get/.test(skill) || skill.includes('无计划时'));

// ---------- 5. 版本号一致 ----------
console.log('\n[5] 版本号一致性');
const initReply = spawnSync(process.execPath, [path.join(root, 'mcp', 'server.mjs')], {
  input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
  encoding: 'utf8', timeout: 20000,
});
const serverVersion = JSON.parse(String(initReply.stdout).trim().split('\n')[0]).result.serverInfo.version;
check('server 版本 == plugin.json 版本', serverVersion === manifest.version, `${serverVersion} vs ${manifest.version}`);
check('server 版本 == package.json 版本', serverVersion === pkg.version, `${serverVersion} vs ${pkg.version}`);
// marketplace.json 只存在于本机插件目录布局（<marketplace>/taskswarm/）中；
// 从 GitHub 独立克隆的副本没有它，此时跳过该项而不是崩溃。
const marketplacePath = path.join(root, '..', 'marketplace.json');
if (fs.existsSync(marketplacePath)) {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  const mpEntry = marketplace.plugins.find(p => p.name === 'taskswarm');
  check('marketplace 版本与 manifest 一致', mpEntry?.version === manifest.version, `${mpEntry?.version} vs ${manifest.version}`);
} else {
  console.log('  （未找到 ../marketplace.json —— 独立克隆副本，跳过市场清单核对）');
}
check(`CHANGELOG 有 ${manifest.version} 条目`, read('CHANGELOG.md').includes(`## [${manifest.version}]`));

// ---------- 6. 文档引用的文件/路径存在 ----------
console.log('\n[6] 文档引用的路径是否存在');
const pathRefs = [
  ['README.md', 'docs/architecture.svg'],
  ['README.md', 'docs/architecture.drawio'],
  ['README.md', 'scripts/coverage.mjs'],
  ['README.md', 'mcp/test/lock-failure.test.mjs'],
];
for (const [doc, ref] of pathRefs) {
  if (!read(doc).includes(ref)) continue;
  check(`${doc} 引用的 ${ref} 存在`, fs.existsSync(path.join(root, ref)));
}

// ---------- 7. 篇幅与结构 ----------
console.log('\n[7] README 结构完整性');
const readme = read('README.md');
for (const section of ['## 30 秒看懂', '## 核心设计洞察', '## 安装', '## 使用', '## MCP 工具', '## 测试与可靠性', '## 已知限制', '<summary>English</summary>']) {
  check(`README 含章节 ${section}`, readme.includes(section));
}
// 徽章数字必须与 README 正文的自报数字一致（都是人写的，容易改一处漏一处）。
// 断言的只是「同一份文档内部自洽」，不硬编码具体数值——数值本身由 npm test / npm run coverage 产出。
const readmeTests = read('README.md').match(/tests-(\d+)%20passed/);
const readmeBodyTests = read('README.md').match(/\*\*(\d+) 个测试，全部通过/);
check('README 徽章与正文的测试数一致', !!readmeTests && !!readmeBodyTests && readmeTests[1] === readmeBodyTests[1],
  `徽章 ${readmeTests?.[1]} vs 正文 ${readmeBodyTests?.[1]}`);
// 徽章与正文必须自洽：徽章 URL 里的数字解码后应能在正文找到同样的百分比。
// 不硬编码具体数值——数值本身由 npm test / npm run coverage 产出，此处只防止改一处漏一处。
const badgeLine = readme.match(/coverage-([A-Za-z0-9%._-]+?)-brightgreen/);
const badgeCoverage = badgeLine ? decodeURIComponent(badgeLine[1]).match(/[\d.]+/g) || [] : [];
check('README 徽章与正文的覆盖率一致',
  badgeCoverage.length >= 2 && badgeCoverage.every(n => readme.includes(n + '%')),
  `徽章 ${badgeCoverage.join('/')} 与正文不一致`);
check('README 含测试与覆盖率数字', !!readmeTests && !!readmeBodyTests && badgeCoverage.length >= 2);
check('README 未夸大（无 "100% 无缺陷" 类表述）', !/100%\s*(无误|完美|零缺陷)/.test(readme));

// ---------- 8. SKILL.md frontmatter ----------
console.log('\n[8] SKILL.md 元数据');
check('SKILL.md 有 name 字段', /^---[\s\S]*?name:\s*taskswarm/m.test(skill));
check('SKILL.md 有 description 字段', /^---[\s\S]*?description:/m.test(skill));

console.log('\n' + '─'.repeat(70));
console.log(`文档一致性核对：${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\n问题：');
  problems.forEach(p => console.log('  ✗ ' + p));
}
console.log('─'.repeat(70));
process.exit(fail > 0 ? 1 : 0);
