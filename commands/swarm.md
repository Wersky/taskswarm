---
description: 蜂群执行：把任务多级拆解后按依赖波次并行派发给后台子代理，共享看板互通进度
argument-hint: <要执行的任务描述>
---

按 taskswarm 技能的流程执行蜂群任务：$ARGUMENTS

要求：
1. 先分析任务并多级拆解，用 `mcp__plugin_taskswarm_taskswarm__plan_create` 建任务树（含 `dependsOn`；**要改同一批文件的任务必须串行**），展示给用户；
2. 按依赖波次用 `Agent` 工具（general-purpose，`run_in_background=true`）并行派发，单波 ≤ 4 个；
3. 子代理 prompt 按技能模板写全：身份、开工三步（`task_claim` → `task_update` → 收尾 done + 最终笔记）、互通义务（`board` 互查、`task_notes` 读全文）、上下文注入、隔离要求（自测用独立临时目录，勿污染真实工作区）；
4. 所有 MCP 调用都要显式传 `workspace`（当前工作区绝对路径）；
5. 收波后用 `task_notes` 取关键结论并转发给相关在跑子代理；全部完成后**自行验证关键结论**再汇总（不要只转述子代理自述），输出各任务结果与产出物路径。
