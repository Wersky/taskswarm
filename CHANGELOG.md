# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **`scripts/check-docs.mjs` 在独立克隆副本中崩溃**：该脚本硬依赖上级目录的
  `../marketplace.json`（本机插件目录布局才有），从 GitHub 直接克隆的人一跑就报
  `ENOENT`。现改为存在时核对、不存在时明确跳过并打印原因。
- **README 工具表漏列 `task_review`**：2.1.0 引入的审核裁决工具一直没进 README 的
  MCP 工具表（表里只有 10 个，实际 11 个）。已补齐，并在 `check-docs.mjs` 里加了
  「README 必须覆盖全部真实工具」的断言，防止再次漏列。
- **文档数字与实际脱节**：README 徽章与正文仍写着 91 个测试 / 行覆盖 86.8%，
  而实际已是 123 个测试 / 行覆盖 90.3%、函数 98.0%；且 `check-docs.mjs` 断言的正是
  那组旧数字，导致「检查自洽通过、对外展示过时」。现改为只断言徽章与正文**互相一致**，
  具体数值交由 `npm test` / `npm run coverage` 产出。

### Changed

- `check-docs.mjs` 的工具名核对不再硬编码工具清单，改为从 server 的真实
  `tools/list` 结果派生，并新增「文档提到不存在的工具」反向检查（78 项检查，全绿）。

## [2.2.0] - 2026-09-13

### Added

- **`task_review` 支持 `proposals` 参数（采纳提案回路）**：reviewer 在裁决时可携带一组
  新计划项（每项 `{id?,title,detail?,dependsOn?,role?,reviewer?,assignee?,parentId?}`，
  `title` 必填），**审核通过时它们被直接加进任务树**，形成「执行中发现阻塞 → 提建议 →
  审核通过 → 自动纳入计划」的闭环。返回值新增 `adopted: {count, ids}`（未采纳时为
  `{count:0, ids:[]}`，调用方无需判空），日志追加「采纳提案」事件（排在「审核通过」之后，
  看板可读出「先过审、后纳入计划」的因果）。
- **`assignee` 字段（建议执行者）**：`plan_create` / `task_add` / `proposals` 均可指定
  `assignee`（身份字符串，如 `"wersky/agent-3"`），在任务视图里显示为 `→ 建议: <身份>`。
  与 `owner`（实际领取者）区分开：它只表示「建议由谁执行」，是提示而非机制。

### 语义（三条硬规则）

- **仅 `verdict === 'approve'` 时才采纳 proposals**；`reject` 分支根本不读取 `proposals`
  ——驳回**完全忽略**提案，杜绝「驳回却夹带新任务」。
- **采纳是原子的**：类型、`role`/`reviewer`/`assignee`、依赖存在性等校验全部发生在真正建
  节点之前，**任一项不合法则整批不加**，任务树保持原样（错误信息带 `proposals[i]` 下标与
  改法）。
- **`assignee` 只是建议，不影响 `task_claim` 的领取权限**：谁实际执行仍由 `task_claim` 的
  `owner` 决定。与 `reviewer` 有本质区别——`reviewer` 触发审核门（机制），`assignee` 只是标签。

### 兼容性

- 不传 `proposals` 时行为与 2.1.0 完全一致；`assignee` 可选，缺省为 `null`。
- 旧状态文件可直接读（缺 `assignee` 字段按「无建议执行者」处理）。

## [2.1.0] - 2026-09-13

### Added

- **PPR 审核门**：任务可指定 `reviewer`，producer 置 done 会被自动改道为 `pending_review`——
  **未过审时下游任务不可派发、不可领取**。这是机制而非约定：`pending_review` 不在"已完成"
  集合里，因此 `task_ready`/`task_claim` 自动拦住下游，无需编排方额外判断。
- **`task_review` 工具**：`approve`（转 done、下游放行）/`reject`（回 in_progress、下游继续
  阻断、理由必填并写入任务笔记）。仅登记的 reviewer 本人可裁决，主代理可 `force:true` 代裁（留审计）。
- **角色字段 `role`**（planner/producer/reviewer）：声明式标签，在任务视图里显示，便于阅读分工。
- 支持**多级审核链**：A 过审 → B 可开始 → B 过审 → C 放行，逐级生效。
- 视图与看板显示审核状态（`⏳ 待 X 审核` / `✔ X 已审` / `✖ X 已驳回`）。

### Changed

- 工具数 10 → 11；`plan_create` / `task_add` 接受 `role` 与 `reviewer`；
  状态机新增 `pending_review` 状态与相应转移。
- 非法 `role` 会被明确拒绝（不静默忽略）。

### 兼容性

- **不配 `reviewer` 的任务行为完全不变**（producer 置 done 即完成），向后兼容。
- 旧状态文件可直接读（缺 `role`/`reviewer`/`reviewStage` 字段按"无审核门"处理）。


## [2.0.0] - 2026-09-12

从「本机能跑的 1.0.0」升级为「可移植、可公开、可展示」的 2.0.0：先修正确性，再补工程化，最后做文档展示。

### Fixed

- **并发写坏状态文件**：多个子代理同时调用 `task_update` / `task_claim` 时，对 `任务蜂群/swarm-state.json` 的读-改-写会互相覆盖，导致任务树丢失或 JSON 解析失败。改为「跨进程文件锁串行化 + 临时文件 `write → fsync → rename` 原子替换」。（实测：两进程各写 120 条笔记会使文件损坏、期间 217 次工具报错；修复后 120/120 无丢失、0 次报错）
- **并发双重领取**：两个子代理几乎同时 `task_claim` 同一个任务时，双方都能领取成功，出现重复派发。改为在锁内完成「读取 → 检查状态 → 写入」的完整判定。（实测：60 次并发抢占曾出现 4 次双重领取；修复后为 0 次）
- **状态文件损坏被静默吞掉**：解析失败时只报「没有进行中的蜂群任务」，原计划静默丢失且无备份。现在先把坏文件备份为 `<file>.corrupt-<时间戳>.json`，再抛出含备份位置与 `plan_reset` 出路的明确错误。
- **写入中途被杀留下半截文件**：`fs.writeFileSync` 直接覆盖目标文件，进程在写入窗口被杀即损坏。改为原子替换后，8 次写入中强杀测试零损坏。
- **笔记无上限**：`notes` 数组无限增长，每次操作全量重写整个状态文件，README/看板返回体量随之失控。现每任务保留最新 500 条、单条上限 4000 字符（可经 `TASKSWARM_MAX_NOTES` / `TASKSWARM_MAX_NOTE_CHARS` 调整），被丢弃条数记账到 `notesDropped`，日志留痕，绝不静默丢弃。
- **长笔记读不回**：`plan_get` 与 `board` 只提供 60/120 字符截断摘要，写下的完整结论没有任何读取通道。新增只读工具 `task_notes` 分页读回全文。
- **三级以上嵌套被静默丢弃**：`subtasks` 只展开两层，第三层任务无声消失。现递归展开（深度上限 5），超限给出可行动的报错。
- **`__proto__` 等危险 id 导致任务消失**：任务表使用普通对象，`id: "__proto__"` 会命中原型、任务在落盘后凭空消失。现对 id 做字符集与保留名校验，任务表改用 `Object.create(null)`，内部判定统一 `Object.hasOwn`。
- **上游失败仍派发下游**：代码注释声称「其依赖它的任务永久就绪阻断」，实测行为相反——上游 `failed` 后下游照常进入就绪列表。现默认 `failurePolicy: "block"` 真正阻断（`task_claim` 也会拦住并说明原因），可选 `"proceed"` 放行并在 `task_ready` 中标注 `blockedBy`。
- **状态机无守卫**：任何人可修改任意任务、终态可被任意回退、`done` 任务可被重新领取。现引入转移表与 owner 校验；恢复失联子代理的任务需显式 `force:true`（会在 log 留下「强制改状态」审计事件，记录操作者与原 owner）。
- **入参校验缺失导致内部异常外泄**：非法 `dependsOn`、错误类型的 `workspace`、非法的 `limit` / `offset` 会抛出 `Cannot read properties of ...` / `is not iterable` 等内部异常。现所有入口先做类型检查，错误信息统一为「发生了什么 + 下一步怎么做」。
- **`board` 的 `activeWorkers` 未按 owner 过滤**：指定 `owner` 时 `view` 被过滤但 `activeWorkers` 仍包含他人任务，过滤形同虚设。已修正为一致过滤。
- **`serverInfo.version` 与 manifest 不一致**：`initialize` 响应里硬编码 `1.0.0`，而 manifest 已是 `2.0.0`。现提取为 `SERVER_VERSION` 常量，并由测试断言两者一致以防再次漂移。

### Added

- **`task_notes` 工具**：只读、分页（`limit` 默认 20、上限 200，`offset` 从最新往回数），返回笔记全文与 `total` / `notesDropped` / `hasMore` 等字段。
- **`failurePolicy` 计划级选项**：`"block"`（默认）| `"proceed"`，决定上游失败时下游是否放行。
- **`task_update` 的 `force` 参数**：供主代理在会话中断恢复场景下接管任务；必须同时提供 `owner`，且写入审计日志。
- **测试套件 `mcp/test/`（91 个测试，全绿）**：协议层、入参校验、状态机与归属守卫、失败语义、笔记治理与分页、多进程并发（原子领取 / 状态不丢 / 崩溃恢复）、锁的故障路径、IO 故障注入。全部通过 `spawn` 真实子进程运行——并发承诺只在独立进程间才成立。
- **`scripts/coverage.mjs`**：基于 `NODE_V8_COVERAGE` 的子进程覆盖率统计（Node 内置的 `--experimental-test-coverage` 看不到子进程里执行的代码，直接跑会得到空报告）。当前：行覆盖 86.8%、函数覆盖 96.4%。
- `package.json`：零依赖（`dependencies` / `devDependencies` 均为空），`type: module`，`engines.node >= 18`，`scripts.test` / `scripts.coverage` / `scripts.sync`。
- `LICENSE`：MIT 全文（Copyright (c) 2026 Wersky），与 manifest 声明一致。
- `.gitignore`：忽略状态落盘目录 `任务蜂群/`、临时与损坏文件、`_swarm-tmp/`、锁文件、`node_modules/`。
- `.editorconfig`：UTF-8 / LF / 2 空格缩进，匹配现有代码风格。
- `docs/architecture.svg` + `docs/architecture.drawio`：架构图（职责分工与双通道互通机制），SVG 供 README 内嵌，drawio 供再编辑。
- `scripts/sync-installed.mjs`：把源目录同步到 ZCode 已安装插件缓存，避免源与缓存两份拷贝漂移（排除状态目录与临时文件，支持 `--check` / `--dry-run`）。

### Changed

- `plugin.json` 版本 `1.0.0` → `2.0.0`；`description` / `description_i18n` 更新（补充英文描述与「零依赖」卖点）。
- **可移植性**：`plugin.json` 去掉硬编码的 `D:\nodejs\node.exe` 与源目录绝对路径，改为裸 `node` + `${ZCODE_PLUGIN_ROOT}` 占位符 + `cwd: ${ZCODE_PROJECT_DIR}`。
- **测试入口**：`npm test` 使用 `node --test` 的引号 glob 写法（Node 24 把位置参数当 glob 解析，直接传目录会 `MODULE_NOT_FOUND`）。旧的自制断言脚本 `mcp/test.mjs` 与 `mcp/test-concurrency.mjs` 已删除——断言全部迁入 `mcp/test/`，其中原版 `board 按 owner 过滤` 的恒真断言（`!A || B`）已重写为真会失败的断言。
- **文档纠错**：`SKILL.md` 与 `commands/swarm.md` 中的工具名前缀 `mcp__taskswarm__*` 改为真实前缀 `mcp__plugin_taskswarm_taskswarm__*`；修正「`plan_get` 返回 `active` 字段」的错误描述（该字段只在 `board` 上，且无计划时 `plan_get` 会报错）；补充失败语义、`force` 恢复流程、`task_notes` 用法、`force` 的权限边界说明。
- 状态文件的写入路径、锁文件（`.lock`）与临时文件（`*.tmp-<pid>`）命名约定固化，并在 `.gitignore` 中屏蔽。
- 锁超时改为可配置（`TASKSWARM_LOCK_TIMEOUT_MS`，默认 10000ms），便于测试与部署调整。

[Unreleased]: https://github.com/Wersky/taskswarm/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Wersky/taskswarm/releases/tag/v2.0.0
