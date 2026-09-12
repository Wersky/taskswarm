# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [2.0.0] - 2026-09-12

从「本机能跑的 1.0.0」升级为「可移植、可公开、可展示」的 2.0.0：先修正确性，再补工程化，最后做文档展示。

### Fixed

- **并发写坏状态文件**：多个子代理同时调用 `task_update` / `task_claim` 时，对 `任务蜂群/swarm-state.json` 的读-改-写会互相覆盖，导致任务树丢失或 JSON 解析失败。改为「文件锁串行化 + 临时文件 `write → fsync → rename` 原子替换」，并在读取端做严格校验（坏文件不再被静默吞掉）。（实测缺陷，由 1.0.0 的 `fs.writeFileSync` 直写复现）
- **并发双重领取**：两个子代理几乎同时 `task_claim` 同一个任务时，双方都能领取成功，出现重复派发。改为在锁内完成「读取 → 检查状态 → 写入」的完整判定，保证原子性。（实测缺陷）
- **跨机器不可运行**：`plugin.json` 硬编码本机路径 `D:\nodejs\node.exe` 与 `D:\zcode-data\plugins\taskswarm\mcp\server.mjs`，换台机器或换用户名即启动失败。改为裸 `node` + `${ZCODE_PLUGIN_ROOT}` 占位符与 `cwd: ${ZCODE_PROJECT_DIR}`。

### Added

- `package.json`：零依赖（`dependencies` / `devDependencies` 均为空），`type: module`，`engines.node >= 18`。
- `LICENSE`：MIT 全文（Copyright (c) 2026 Wersky），与 manifest 声明一致。
- `.gitignore`：忽略状态落盘目录 `任务蜂群/`、临时与临时损坏文件、`_swarm-tmp/`、锁文件、`node_modules/`。
- `.editorconfig`：UTF-8 / LF / 2 空格缩进，匹配现有代码风格。
- `CHANGELOG.md`：本文件。
- `scripts/sync-installed.mjs`：把源目录同步到 ZCode 已安装插件缓存，避免源与缓存两份拷贝漂移（排除状态目录与临时文件，打印同步清单）。
- `mcp/test/` 测试目录：由 `node --test` 发现（本次 2.0.0 起引入；`mcp/test.mjs` 保留为整链路冒烟测试）。

### Changed

- `plugin.json` 版本 `1.0.0` → `2.0.0`；`description` / `description_i18n` 措辞更新（补充英文描述与「零依赖」卖点）。
- 测试入口改为 `npm test`（`node --test` 的 glob 写法，Node 18+ 通用），旧的 `node mcp/test.mjs` 保留为整链路冒烟脚本。
- 状态文件的写入路径、锁文件与临时文件命名约定固化，并在 `.gitignore` 中屏蔽。

[Unreleased]: https://github.com/Wersky/taskswarm/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Wersky/taskswarm/releases/tag/v2.0.0
