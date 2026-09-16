---
name: taskswarm
description: 任务蜂群（多级任务拆解 + 并行子代理编排）。当用户要求"把任务拆解并行处理"、"多 agent 干活"、"任务蜂群"、"swarm 执行"，或明确说用一个任务拆成多份分给子代理并要求互相了解进度、提效时使用。主代理将任务多级拆解为任务树，按依赖波次并行派发后台子代理，子代理通过共享看板（taskswarm MCP）互查进度，主代理转发关键进展并汇总结果。
---

# 任务蜂群（TaskSwarm）

## 概述

一次蜂群 = 一个总目标 → 多级拆解的任务树 → 按依赖波次并行派发后台子代理 → 共享看板互通进度 → 主代理汇总。

**职责分工**：
- **确定性部分走 MCP 工具**（任务树存储、依赖判定、防重复领取、并发写盘、看板渲染）——不要手工记在脑子里或普通文件里。
- **编排循环在主代理手里**（何时拆、派给谁、何时收下一波）——ZCode 没有插件 API 可挂自动调度，主代理就是调度器。

## MCP 工具

> ⚠️ **真实工具名前缀是 `mcp__plugin_taskswarm_taskswarm__`**（插件内 MCP server 的完整命名）。
> 下表为便于阅读只写短名；实际调用必须用完整名，例如
> `mcp__plugin_taskswarm_taskswarm__task_claim`。

| 工具 | 谁调用 | 作用 |
| --- | --- | --- |
| `plan_create` | 主代理 | 创建任务树：`goal` + `tasks=[{id?,title,detail?,dependsOn?,subtasks:[…]}]`，支持递归嵌套（深度 ≤ 5），可选 `failurePolicy` |
| `plan_get` | 主代理 | 任务树全貌 + 当前就绪任务 + 最近事件（含 `failurePolicy`） |
| `task_ready` | 主代理 | 查询依赖已满足、可派发的任务（返回 `{ready:[{id,title,detail,parent,blockedBy?}], failurePolicy}`） |
| `task_claim` | 子代理 | 领任务（原子操作，防重复派发） |
| `task_update` | 子代理/主代理 | 汇报状态 + 进展笔记；主代理恢复死任务用 `force:true` |
| `task_notes` | 所有人 | **读回某任务笔记全文**（分页，`limit ≤ 200`）——`plan_get`/`board` 只给摘要 |
| `task_add` | 主代理/子代理 | 执行中途追加任务（多级拆解持续发生） |
| `task_review` | reviewer | **PPR 审核裁决**：`approve` 通过（下游放行，可带 `proposals` 采纳新计划项）/ `reject` 打回（须给 reason，任务回 in_progress） |
| `board` | 所有人 | **共享进度看板**：状态、负责人、最新笔记摘要 |
| `plan_reset` / `state` | 主代理 | 重开 / 状态落盘与恢复 |

**所有调用必须显式传 `workspace` 参数**（当前工作区绝对路径）。省略时状态会落在 server 进程的 cwd，可能不是你以为的地方。

## PPR 审核门（质量关卡）

给任务配 `reviewer` 就启用了审核门——**这是机制，不是约定**：

```
producer 置 done ──▶ 审核门改道 pending_review ──▶ 下游被阻断
                                                    │
                        reviewer task_review ───────┴──▶ approve: 转 done，下游放行
                                                         reject : 回 in_progress，下游继续阻断
```

**关键点**：

- **未过审 = 下游不可派发**。`pending_review` 不在"已完成"集合里，所以 `task_ready` 不会放出下游、`task_claim` 也领不走——你不需要额外做什么，机制自动生效；
- **驳回必带理由**，理由会写进任务笔记（`task_notes` 可读），producer 据此重做；重做后再交活会重新进入待审核；
- **只有登记的 reviewer 能裁决**，别人调 `task_review` 会被拒并提示正确的 reviewer 是谁；主代理可用 `force:true` 代裁（留审计事件）；
- **支持多级审核链**：A（reviewer=r1）过审 → B 才可开始 → B 过审 → C 放行，逐级生效；
- **不配 reviewer 就是旧行为**（producer 置 done 即完成），完全向后兼容。

**什么时候该配 reviewer**：产出需要人工或另一代理把关的任务（对外接口、要交付的文档、关键算法）；纯机械步骤（跑测试、格式化）不必配，否则白白拖长流程。

角色字段 `role`（`planner`/`producer`/`reviewer`）是**声明式标签**，只影响可读性（视图显示 `{producer}`），不参与权限校验。

### 跨机器 PPR（与 swarmbridge 配合）

对方用 `bridge_send {type:"plan", data:{plan:[{id,title,role,reviewer,dependsOn}], reviewer}}` 发来计划时：
把 `data.plan` 逐项转成本地 `plan_create` 的 tasks（`role`/`reviewer` 原样带入）→ 本地跑 PPR → 完成后 `bridge_reply {type:"result"}` 回报 → `bridge_ack` 闭环。
**对方指定的 reviewer 身份**（如 `alice/agent-9`）就是你本地要派去审核的子代理身份。

### 提案与采纳回路（2.2.0）

审核门解决「产出合不合格」，提案回路解决「**计划本身要不要改**」——子代理在干活时最容易发现原计划缺了什么。

```
producer 发现阻塞/更好的方案
        │  swarmbridge: bridge_send {type:"proposal", data:{forTask, problem, items, rationale}}
        ▼  （跨机器）
   reviewer / 主代理审阅
        │  task_review {taskId, verdict:"approve", proposals:[{title, detail?, role?, reviewer?, assignee?, dependsOn?}]}
        ▼
   新任务自动进树 → 主代理按 assignee 提示分派
```

- **生产者怎么提**：遇到阻塞或有更好方案，用 swarmbridge 的 `proposal` 消息发到桥线程
  （`data = {forTask?, problem?, items?:[{title, …}], rationale?}`，`problem` 与 `items` 至少一个）；
  单机场景直接写 `task_update` 进展笔记说明建议，由主代理读取后转发或代提。
- **reviewer 怎么采纳**：判断建议合理后，在 `task_review` 里带上 `proposals` 数组——过审的同时
  这些计划项**直接加进任务树**（可带 `role` / `reviewer` / `assignee` / `dependsOn`），返回值
  `adopted:{count, ids}` 告知新增了哪些任务。
- **主代理怎么派**：按新任务的 `assignee` 提示分派给对应子代理。**`assignee` 只是建议，不强制**——
  实际谁干仍由 `task_claim` 的 `owner` 决定（这与触发审核门的 `reviewer` 有本质区别）。
- **驳回时 proposals 不被采纳**：`verdict:"reject"` 会**完全忽略** `proposals`，驳回不会夹带新任务；
  建议要等下次过审时再提。
- **采纳是原子的**：任一项不合法（缺 `title`、`role` 非法、依赖不存在等）则**整批不加**，
  任务树保持原样，错误信息带 `proposals[i]` 下标——改对后重试即可。

## 子代理互通机制（本插件核心）

> **宿主差异先说清**：本插件的 MCP 服务端三平台共用，但"派发子代理"与"子代理能否互相通信"
> **由宿主决定**。先看这张表，再按你所在宿主的行去读对应小节。
>
> | | ZCode | dsh（DeepSeek Harness） | Codex CLI |
> | --- | --- | --- | --- |
> | 派发子代理 | `Agent`（general-purpose，`run_in_background:true`） | `subagent`（provider 为 `spawn`/`fork`） | `.codex/agents/*.toml` 角色 + `multi_agent` |
> | 父→子推送 | `SendMessage(to: agentId)`，只能送达运行中的 | **`send_message`**（成为子代理下一轮，可续期） | 无 |
> | 子→父回报 | 无（只能等最终回复） | **`report`**（主动回传，不必等收尾） | 无 |
> | 观察/干预 | 无 | **`list_agents`** / **`interrupt_agent`** | 无 |
> | 子代理互通 | 靠共享看板（无直连） | 看板 + 父代理直连通道 | 靠共享看板（无直连） |
>
> 结论：**看板通道在所有宿主都可用**（这就是本插件跨平台的价值）；
> dsh 另有直连通道，把看板从"唯一通道"降级为"公共黑板 + 持久化事实源"。

### 通道一：看板拉取（所有宿主可用，默认通道）

子代理 prompt 中**强制要求**：开工前 `task_claim` 领任务、每完成一个里程碑 `task_update`
写进展笔记、需要了解别人进度时调 `board`。进展笔记要写「做了什么 + 对其他任务有什么影响」
（如「接口 schema 已定稿在 src/api/types.ts，前端任务可直接引用」）。
重要结论要让同伴能用 `task_notes` 读到全文。

**看板可读也可写**：`task_update` 的 owner 校验只管**状态变更**，不管写笔记——
任何代理都能给**任意**任务卡追加笔记（跨代理留言）。这是子代理之间真正的双向通道：
把结论写进同伴的任务卡，也去自己的任务卡上读同伴留给你的话。

### 通道二：主代理推送（ZCode）

主代理在派发新任务时，把**已完成相邻任务的产出摘要**写进新子代理的 prompt；
发现某后台子代理的工作与另一子代理的产出相关时，用 `SendMessage`（to: agentId）
把对方的关键进展推给它。实测能送达**运行中**的后台子代理（长任务中途也能收到）。

### 通道三：父代理直连（dsh 专属，能力最强）

dsh 原生提供子代理 ↔ 父代理双向通道，**优先用它们而不是模仿 ZCode 的两通道**：

- **`report`（子→父）**：子代理遇到阻塞、发现更好方案、或关键产出落盘时**立刻上报**，
  不必等任务收尾。这是 ZCode 版做不到的——那边只能等子代理结束。
- **`send_message`（父→子）**：中途追加工作或纠偏。注意它是 **FIFO 的下一轮**，
  **不会打断正在跑的那一轮**；要立即停用 `interrupt_agent`（只停当前轮、保留队列）。
- **`list_agents`**：查看在跑的子代理（`children` / `descendants` 两种范围）与状态。

派发模板与完整说明见 [`adapters/dsh/README.md`](../../adapters/dsh/README.md)。


## 流程

### 1. 拆解（plan_create）

分析用户任务，拆成任务树：
- 每个任务 `title` 一句话、`detail` 写清验收标准（子代理只看得到自己任务 + 你 prompt 里给的内容，detail 要自洽）；
- 有先后依赖的用 `dependsOn` 引用任务 id；无依赖的同波任务尽量多，**并行度就是提效来源**；
- 两级不够就继续嵌套 `subtasks`（深度 ≤ 5），或在派发过程中用 `task_add` 续挂子任务；
- **id 规则**：`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`——不要用中文、空格、`__proto__` 等；不写 id 会自动编号 `T1`、`T2`…；
- **冲突处理**：若多个任务都要改同一个文件，必须用 `dependsOn` 串起来（否则子代理会互相覆盖，这是"并行"最常见的翻车方式）；无冲突的才放同波；
- 拆解粒度：单任务 = 一个子代理一次会话能完成的工作量。3 个任务以下不值得开蜂群，直接主代理自己做。

创建后向用户展示 `plan_get` 的任务树视图。

### 2. 派发（波次循环）

每波循环做：
1. `task_ready` 拿就绪任务列表；
2. 为每个就绪任务启动一个**后台子代理**——按宿主选工具：
   - **ZCode**：`Agent`（general-purpose，**`run_in_background: true`**）
   - **dsh**：`subagent`（`run_in_background: true`，provider 用 `spawn` 或 `fork`）
   - **Codex**：用 `.codex/agents/` 里定义的角色，或用 `multi_agent` 并行的代理

   prompt 必须包含：
   - **身份**：「你是蜂群成员 `<owner>`（如 agent-1），负责任务 `[T3] 标题`」；
   - **开工三步**：先 `task_claim`（taskId + owner + workspace）领取 → 过程中每完成一个节点 `task_update` 写状态和进展笔记 → 收尾时置 done/failed 并写最终笔记（产出物路径/结论）；
   - **互通义务**：「开工前和需要别人产出时，调 `board` 查看全队进度；你的进展笔记会影响其他代理的决策，务必具体；重要结论写明产出物路径，同伴会用 `task_notes` 读全文」；
   - **上报义务（dsh 专属）**：「遇到阻塞、发现更好方案、或关键产出落盘时，**立刻调 `report` 上报**，不要攒到收尾」——dsh 之外的宿主没有这个通道，子代理只能靠最终回复与看板笔记；
   - **上下文注入**：总目标一句话 + 本任务 detail + 已完成的依赖任务的产出摘要（用 `task_notes` 取全文，别只用摘要）+ 工作区路径约束（下载/缓存走 D 盘等用户规则适用的要带上）；
   - **隔离要求**：若任务涉及自测，要求它用独立临时目录，**不要污染真实工作区**；
   - **完成信号**：「全部做完后，最终回复只需一段简短总结（≤200 字）：做了什么、产出在哪、对其他任务的影响」。
3. 全部派出后告知用户：本波派了哪几个任务给谁。

**并行度控制**：同一波后台子代理 ≤ 4 个（多了上下文切换与 token 开销反噬提效）。
dsh 的 `maxDepth` 默认 3，蜂群嵌套不要超过两层。

**并发安全**：插件的写盘有跨进程文件锁保护（同一工作区多进程并发写不会损坏状态），但**业务层面的冲突仍需你用 `dependsOn` 避免**——锁只保证数据不坏，不保证两个子代理不会做重复工作。

### 3. 收波与转发

- 后台子代理完成会通知主代理（ZCode 的 TaskOutput / dsh 的结算通知 / Codex 的 job 结果）。收到后：核对看板上该任务状态已是 done、用 `task_notes` 提取该任务的关键结论（不只是摘要）；
- 若其他在跑子代理的任务依赖这个产出，立刻**推送给它**（一两句话 + 产出物路径）：
  **ZCode** 用 `SendMessage(to: agentId)`；**dsh** 用 `send_message(subagent_id, message)`——更可靠，且支持给已 `idle` 的子代理续期新工作；
- 全波收齐 → 回到第 2 步派下一波。

**子代理失败处理**：状态为 failed 时看笔记判断——
- 可修复的（环境问题、路径错）：带错误信息让它重试（ZCode 用 `SendMessage`；dsh 用 `send_message`）；
- 方案性失败（思路不通）或子代理被中断（如额度耗尽）：`task_add` 新任务替代，或把原任务置回 pending 重派；
- **被中断的子代理**（未汇报就消失，任务卡在 `claimed`/`in_progress`）：用 `task_update` 以 `force:true` + 原 owner 置回 `pending`（会记「强制改状态」日志），然后重新派发。dsh 上可先用 `list_agents` 确认它是真的不在了。

**失败语义**：默认 `failurePolicy: "block"` —— 上游 `failed`/`skipped` 会**挡住**下游，不让它进入就绪列表。若业务上允许带着已知缺陷继续，建计划时传 `failurePolicy: "proceed"`，此时下游仍可派发，`task_ready` 会用 `blockedBy` 标注是哪个上游出了问题。

**用户插话**：蜂群进行中用户发来的任何消息，若是新需求/约束变更 → 评估后 `task_add` 或 `task_update` 调整任务树并转发给受影响的在跑子代理；若是进度询问 → `plan_get` 直接答。

### 4. 汇总

任务树全部 done/failed/skipped 后：
- `plan_get` 拉全貌；关键任务用 `task_notes` 读结论全文；
- 向用户输出总结：各任务结果、产出物路径、失败/跳过项及原因、跨任务协作中看板互通起作用的关键节点；
- **自行验证关键结论**（尤其子代理声称的"测试通过/已完成"）——不要只转述子代理的自述；
- 询问是否需要收尾动作（提交代码、跑验收、清理蜂群状态文件）。

## 状态与恢复

- 状态文件：`<工作区>/任务蜂群/swarm-state.json`。写入是**原子替换**（临时文件 → fsync → rename），跨进程有文件锁互斥；文件损坏时会自动备份为 `.corrupt-<时间戳>.json` 并报明确错误，不会静默丢数据。
- 多个蜂群共用工作区时它们共享同一个状态文件——**长期任务请用独立工作区**，避免互相覆盖计划。
- 会话中断后重开：`plan_get` 返回计划内容即说明有未完成的蜂群（无计划时它会报错，这是正常的），向用户确认「检测到未完成的蜂群《目标》，继续派发剩余任务吗？」；在跑子代理已随会话丢失，其 `claimed`/`in_progress` 任务需用 `task_update(force:true)` 置回 pending 后重新派发。

## 长文本与上下文控制

- `board` 每条只给最新笔记的前 60 字符、`plan_get` 的事件摘要截断 120 字符——**这是刻意的**，避免把整份笔记灌进上下文；
- 需要完整结论时用 `task_notes(taskId, limit, offset)` 分页读回，`offset` 从最新往回数（0 = 最新一条）；
- 笔记有上限（默认每任务 500 条、单条 4000 字符，可用环境变量 `TASKSWARM_MAX_NOTES` / `TASKSWARM_MAX_NOTE_CHARS` 调整）；超限会保留最新并记账到 `notesDropped`，绝不静默丢弃。

## 平台适配

MCP 服务端（`mcp/server.mjs`）三平台共用，**一份文件不改**；差异只在"谁派发子代理"。

| | ZCode | dsh（DeepSeek Harness） | Codex CLI |
| --- | --- | --- | --- |
| 安装方式 | 插件（`.zcode-plugin/`） | `adapters/dsh/cordis.patch.yml` | `adapters/codex/config.toml` |
| MCP 工具前缀 | `mcp__plugin_taskswarm_taskswarm__*` | `mcp__taskswarm__*` | `mcp__taskswarm__*` |
| 子代理直连 | 无 | **有**（`report`/`send_message`/`list_agents`） | 无 |
| 适配成熟度 | 原生（本插件诞生于此） | **MCP 链路已实测**；编排通道按原生工具映射 | MCP 已确认可挂载；子代理继承 MCP 工具随版本变化，**建议自行验证** |

详见 [`adapters/dsh/README.md`](../../adapters/dsh/README.md) 与 [`adapters/codex/README.md`](../../adapters/codex/README.md)。

## 已知限制

- **`force` 是审计机制而非权限机制**：MCP 协议层无法验证"你是不是主代理"，任何调用方都可传 `force:true`。它只用于恢复流程，并会在 log 留下「强制改状态」事件（含原 owner），**不要把它当作安全边界**。
- 同波并行度受上下文与 token 成本限制，实测单波 4 个以内收益最稳。
- **子代理之间没有直接消息通道**（除 dsh 的父直连外）：跨代理信息走共享看板，是**拉取**语义——
  有延迟（取决于对方何时轮询），也无法唤醒一个正在埋头干活的同伴。
- **`workspace` 由调用方负责传递**：MCP 服务端各宿主的客户端都不会自动注入工作区路径。
  漏传时会退到 server 进程的 cwd（可用宿主配置里的 `cwd` 兜底），多工作区并行时**必须显式传**，
  否则多个蜂群的状态会串到同一个 `swarm-state.json`。

## 何时不用蜂群

- 任务 < 3 个子项、强串行依赖（拆了也是一波一波等）→ 主代理直接做；
- 任务需要频繁来回讨论 → 用圆桌讨论（roundtable 插件）；
- 单纯查资料/读代码 → Explore 子代理更省。
