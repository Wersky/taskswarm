# TaskSwarm on dsh（DeepSeek Harness）

> **状态**：MCP 链路**已实测通过**（11 个工具全部可用，读写/看板/依赖守卫正常）。
> 编排队列用的是 dsh 原生子代理工具，见下文映射表。

## 1. 安装

把 [`cordis.patch.yml`](./cordis.patch.yml) 里那段 `insert` 加进你的 dsh profile patch
（`~/.dsh/profiles/<name>/cordis.patch.yml`），改掉 `args` 里的路径指向你自己的 clone，
然后 `dsh --profile <name> --dump-config` 确认加载成功。

**不需要改动 `mcp/server.mjs`**——ZCode 与 dsh 共用同一份文件。

## 2. 与 ZCode 版的差异

dsh 的子代理体系比 ZCode 完整，因此本插件的**编排通道升级了**：

| 能力 | ZCode | dsh |
| --- | --- | --- |
| 派发子代理 | `Agent`（general-purpose，后台） | `subagent`（provider=`spawn`/`fork`） |
| 父 → 子推送 | `SendMessage`（只能送达运行中的子代理） | **`send_message`**（成为子代理的下一轮，可续期） |
| 子 → 父回报 | 无（只能靠子代理的最终回复） | **`report`**（子代理主动回传，`next-step`/`quiet` 两种投递） |
| 列出在跑子代理 | 无 | **`list_agents`**（`children`/`descendants` 两种范围） |
| 中断子代理 | 无（只能等或杀会话） | **`interrupt_agent`**（只停当前轮，保留队列） |
| 子代理工具继承 | 子代理能调 MCP 工具 | 子代理经 `applyChildComposition` 继承父级预设，可调 MCP 工具 |

**因此 dsh 版的实际能力比 ZCode 版强**：ZCode 要靠"看板拉取 + 主代理转发"双通道，
dsh 多了**子代理 ↔ 父代理直连**，看板从"唯一通道"退化为"公共黑板 + 持久化事实源"。

## 3. 编排：三通道

```
                    ┌──────────── 看板（共享黑板，持久化）────────────┐
                    │  board / task_notes / task_update              │
   主代理 ◀────────▶│  ← 所有人可读；任何人可往任意任务卡留言（实测）  │────────▶ 子代理们
      │             └────────────────────────────────────────────────┘
      │
      ├── send_message ──▶ 子代理的下一轮（可续期，能追加新工作）
      ◀── report ─────────  子代理主动回传（不必等它结束）
      │
      └── subagent(run_in_background:true) ─▶ 起一个后台子代理
          list_agents / interrupt_agent     ─▶ 观察与干预
```

**分工原则**：

- **看板** = 状态与结论的事实源（谁领了什么、做到哪、产出在哪）。跨会话、跨中断仍在。
- **`report`** = 子代理的"重要发现即刻上报"。遇到阻塞或发现更好方案时**立刻**报告，
  不必等任务做完（ZCode 版做不到这点，只能等它收尾）。
- **`send_message`** = 中途追加工作或纠偏。注意它是 FIFO 下一轮，**不能打断正在跑的那一轮**；
  要打断用 `interrupt_agent`（保留队列）。

## 4. 派发模板（dsh 版）

主代理拆完任务树后，对每个就绪任务：

```
subagent(
  description: "蜂群成员 agent-1｜[T3] 标题",     # 会作为子代理的 label
  prompt: "<完整 prompt，见下>",
  run_in_background: true
)
```

prompt 必须包含（与 ZCode 版一致的部分略）：

1. **身份**：「你是蜂群成员 `agent-1`，负责任务 `[T3] 标题`」；
2. **开工三步**：`task_claim`（taskId + owner + workspace）→ 里程碑 `task_update` 写笔记 →
   收尾置 `done`/`failed` + 最终笔记（产出物路径/结论）；
3. **上报义务（dsh 专属）**：**里程碑或阻塞时立刻调 `report`**，不要攒到最后；
   最终结论同时写进任务笔记（让看板成为跨会话的事实源）；
4. **互通义务**：需要别人产出时调 `board` / `task_notes`；重要结论写明产出物路径；
5. **上下文注入**：总目标 + 本任务 detail + 已完成依赖的产出摘要 + 工作区路径约束；
6. **完成信号**：最终回复一段 ≤200 字总结（做了什么、产出在哪、对其他任务的影响）。

## 5. 子代理的 `report` 契约

dsh 的 `report` 是**子代理 → 启动它的那个 agent** 的专用回传，无收件人参数：

- 在**关键节点**报告（发现阻塞、方案要改、产出已落盘），不是流水账；
- 报告**不会**结束它自己的轮次，也不影响后续 `send_message`；
- 主代理侧看到的是 `Background subagent <child-id> reported:` 开头的消息；
- 交付策略由部署配置（`reportDelivery`）决定，调用方不能按次覆盖。

**建议的蜂群用法**：producer 发现计划有问题时，先用 `report` 告诉主代理，
再用 swarmbridge 的 `proposal` 走跨机提案回路（如果对方在另一台机器上）。

## 6. 已知边界

- **`workspace` 仍要显式传**：dsh 的 MCP 客户端不会替你注入工作区路径。
  配置里给了 `cwd` 作为兜底，但多工作区并行时**必须显式传**，否则状态会串。
- **子代理能否继承 MCP 工具取决于 dsh 的应用组合**：`applyChildComposition` 会把父级的
  agent-preset 组合并入子代理；如果你的部署把 MCP 行放在 host 组合（而非预设）里，
  子代理通过工具注册表的全局层同样能解析到。本机实测的是 MCP 链路本身可用；
  子代理侧的调用建议在自己的 dsh 部署里用一次真实蜂群确认。
- **深度上限**：`maxDepth` 默认 3，蜂群不要嵌套超过两层子代理。

## 7. 实测记录（2026-09-16）

| 检查项 | 结果 |
| --- | --- |
| `dsh --profile headless --dump-config` 含 `mcp-taskswarm` | ✅ |
| `initialize` 握手 | ✅ `serverInfo={name:taskswarm, version:2.2.0}` |
| `tools/list` | ✅ 11 个工具全部注册为 `mcp__taskswarm__*` |
| `plan_create` / `plan_get` 读写 | ✅ |
| `task_claim` / `task_update` / `board` | ✅ |
| 依赖守卫（D1 未完成时 D2 拒绝领取） | ✅ |
| 状态落盘到 `<workspace>/任务蜂群/swarm-state.json` | ✅ |

> 端到端的"模型驱动蜂群"未跑：测试当日所有可用中转 key 余额不足（HTTP 403 预扣费失败）。
> MCP 链路本身已用与 `dsh-mcp-client` 相同的方式（stdio + JSON-RPC）逐步驱动验证。
