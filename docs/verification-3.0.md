# taskswarm 3.0 端到端验收记录（改进轮）

- **日期**：2026-09-26
- **环境**：Windows 10 · Node v24.19.0 · 验收执行：主代理（main），经蜂群任务 T6（taskswarm 自身编排，SQLite 状态库）
- **范围**：v3.0.0 发布后改进轮的全部改动（T1 审批身份守卫 / T2 webhook 测试+回归修复 / T3 events 归档治理 / T4 控制台层级展示 / T5 覆盖率口径结论）

## ① 全量测试

`npm test`：**156 个测试全部通过**（含本轮新增 events-gc.test.mjs 3 例、webhook.test.mjs 3 例；既有 149 例零回归）。

## ② 端到端验收（脚本驱动：spawn 3.0 server.mjs + ui/server.mjs，临时工作区）

| # | 验收项 | 结果 |
| --- | --- | --- |
| E2E-1 | plan_create 含审核门与依赖链 | PASS |
| E2E-2 | 下游未完成不可领取（依赖+审核门机械阻断） | PASS |
| E2E-3 | 控制台可见 pending_review（done 自动改道） | PASS |
| E2E-4 | 控制台含层级缩进与「└ 属于」标记 | PASS |
| E2E-5 | 伪造 body.owner 无法越权（启动身份强制，alice 的任务被拒） | PASS |
| E2E-6 | 控制台 approve 放行下游 | PASS |
| E2E-7 | 下游任务进入就绪队列 | PASS |
| E2E-8 | reject 缺 reason 被拒（400） | PASS |
| E2E-9 | 带理由驳回 → 打回 in_progress | PASS |
| E2E-10 | 驳回理由写入任务笔记（【审核驳回】前缀） | PASS |
| E2E-11 | 重做后再过审 | PASS |
| E2E-12 | webhook 收到 POST、rev 单调、含「计划创建/审核通过」事件 | PASS（14 次） |
| E2E-13 | events 超限自动归档（events-archive-1.jsonl 生成） | PASS |
| E2E-14 | 心跳超时自动回收（失联 ghost → pending） | PASS |

**结果：14/14 通过。** 验收脚本：系统临时目录 `ts-e2e-verify.mjs`（不随仓库分发）。

## ③ 覆盖率（T5 结论）

- 行覆盖 **88.0%**（1369/1556）、函数覆盖 **96.6%**（142/147）。
- 早前报告的「unit.test 直连分支未覆盖」为行号错位误读：隔离实验证明 `node --test` worker 的 V8 数据被 coverage.mjs 正常收集合并（单跑 unit.test 时 core.mjs 直连分支 39.0% 入账）。**coverage.mjs 无需修改**。
- 未覆盖行经核对全部为防御分支（锁竞争极端路径、#open 打开失败分支）。

## ④ 使用约定（本轮发现）

1. **控制台是独立进程**：审批走 UI 进程的 Store 实例——需要 webhook 推送审批事件时，启动 ui/server.mjs 时同样配置 `TASKSWARM_WEBHOOK_URL`。
2. 控制台审批身份**只认启动参数** `--reviewer`（T1 修复）；未提供时审批一律 403。

## ⑤ 改动清单（本轮）

| 任务 | 改动 | 验证 |
| --- | --- | --- |
| T1 | ui/server.mjs：/api/review 强制启动身份；ui.test.mjs 4 例 | 亲跑 4/4 |
| T2 | 新增 webhook.test.mjs；修复 core.mjs「计划创建」事件丢失回归（3 行） | 亲跑 3/3 + 既有回归 |
| T3 | core.mjs events 归档治理（TASKSWARM_MAX_EVENTS、追加式 JSONL、eventsDroppedTotal）；events-gc.test.mjs 3 例 | 亲跑 3/3 |
| T4 | 控制台层级缩进 + 「└ 属于」标记 | 冒烟 + ui.test 4/4 |
| T5 | 覆盖率口径调查（结论见③），零代码改动 | 实验记录于任务笔记 |
| T6 | 本验收 + 本文档 | 14/14 |
