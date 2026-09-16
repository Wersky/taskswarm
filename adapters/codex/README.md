# TaskSwarm on Codex CLI

> **状态**：MCP 挂载**已实测确认**（`codex mcp list` 显示 enabled，配置写入 `config.toml`）。
> **端到端的模型驱动蜂群未跑通**——测试机当日所有可用中转 key 余额不足。
> 另外 Codex 的"子代理能否继承父会话的 MCP 工具"**随版本变化**（见 §4），落地前请自行验证。

## 1. 安装

两种方式，任选其一。

### 方式 A：CLI 命令（推荐）

```bash
# 注意语法：分隔符是 `--`，不是 --command
codex mcp add taskswarm -- node /绝对路径/taskswarm/mcp/server.mjs
codex mcp list          # 确认出现 taskswarm 且 enabled
```

### 方式 B：手写 config.toml

把 [`config.toml`](./config.toml) 里的 `[mcp_servers.taskswarm]` 段加进
`~/.codex/config.toml`（Windows 下是 `%CODEX_HOME%\config.toml`）：

```toml
[mcp_servers.taskswarm]
command = "node"
args = ["D:/zcode-data/plugins/taskswarm/mcp/server.mjs"]
```

**不需要改动 `mcp/server.mjs`**——与 ZCode、dsh 共用同一份文件。

## 2. 工具命名

Codex 把 MCP 工具暴露为 `mcp__<serverName>__<toolName>`，所以 11 个工具是：

```
mcp__taskswarm__plan_create   mcp__taskswarm__plan_get      mcp__taskswarm__plan_reset
mcp__taskswarm__task_ready    mcp__taskswarm__task_claim    mcp__taskswarm__task_update
mcp__taskswarm__task_add      mcp__taskswarm__task_notes    mcp__taskswarm__task_review
mcp__taskswarm__board         mcp__taskswarm__state
```

## 3. 编排

Codex 有内置多代理（`multi_agent` 特性默认启用），子代理定义在 `.codex/agents/*.toml`：

```toml
# .codex/agents/swarm-worker.toml
name = "swarm-worker"
description = "蜂群成员：执行单个任务树节点，通过 taskswarm 看板互通"
```

派发时让每个子代理：
1. `task_claim` 领任务（taskId + owner + **workspace**）；
2. 里程碑 `task_update` 写笔记；
3. 收尾置 `done`/`failed` + 最终笔记（产出物路径）。

**与 ZCode 版的关键差异**：

| 能力 | Codex |
| --- | --- |
| 父→子中途推送 | ❌ 无 `send_message` 等价物 |
| 子→父主动回报 | ❌ 无 `report` 等价物 |
| 子代理之间 | ❌ 无直连，只能走共享看板 |

也就是说 **Codex 只能靠"看板拉取"这一条通道**（和 ZCode 一样，但 ZCode 至少还有主代理
`SendMessage` 推送）。因此在 Codex 上要把**看板当唯一事实源**：要求子代理把关键结论
**写全**（产出物路径、对其他任务的影响），主代理收波时用 `task_notes` 逐个读回。

## 4. 已知风险：子代理的 MCP 工具继承随版本变化

Codex 的子代理是否能看到父会话的 MCP 工具，历史上变过：

- 早期（~0.31）：issue [#16475](https://github.com/openai/codex/issues/16475)
  报告"子代理看不到父会话注册的 MCP 工具"；
- 较新版本：issue [#20135](https://github.com/openai/codex/issues/20135)
  显示子代理**会继承**父会话的 MCP 服务器（但每个子代理启动都要等 20–30 秒初始化）。

**本机实测版本 0.154.0**：MCP 服务器挂载成功、`codex mcp list` 正常；
但子代理侧的实际可见性**未验证**（受额度限制无法跑完整会话）。

**落地前请自己验证一次**：起一个子代理，让它列出可用工具，确认能看到 `mcp__taskswarm__*`。
若看不到，蜂群在本平台不可用（子代理无法领取任务、无法写看板）。

## 5. 配置注意

- **`wire_api` 只支持 `responses`**：Codex 0.154 已不再支持 `wire_api = "chat"`。
  第三方中转必须提供 `/v1/responses` 端点，否则启动就报错。
- **`multi_agent` 默认开启**；可用 `codex features list` 查看。
- **`tool_timeout_sec`**：蜂群任务偏长，建议放宽（默认 60s）：
  ```toml
  [mcp_servers.taskswarm]
  tool_timeout_sec = 600
  ```

## 6. 实测记录（2026-09-16）

| 检查项 | 结果 |
| --- | --- |
| Codex CLI 安装 | ✅ v0.154.0（`npm i -g @openai/codex`，装到 D 盘） |
| `codex mcp add taskswarm -- node <path>` | ✅ `Added global MCP server 'taskswarm'` |
| `codex mcp list` | ✅ `taskswarm … enabled` |
| `codex mcp get taskswarm` | ✅ transport=stdio，command/args 正确 |
| 写入 `config.toml` | ✅ `[mcp_servers.taskswarm]` |
| 端到端（模型驱动） | ❌ 未跑——所有可用中转 key 余额不足（HTTP 403 预扣费失败） |
| 子代理继承 MCP 工具 | ⚠️ 未验证（见 §4，随版本变化） |
