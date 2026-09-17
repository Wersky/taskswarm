# TaskSwarm

> A multi-agent orchestration engine: decompose a goal into a task tree, dispatch subagents in dependency waves, and let mutually-invisible subagents coordinate through a shared MCP board. **One zero-dependency MCP server, shared across ZCode / dsh / Codex CLI.**

[中文](README.md) | English

[![tests](https://img.shields.io/badge/tests-123%20passed-brightgreen)](#testing--reliability)
[![coverage](https://img.shields.io/badge/coverage-lines%2090.3%25%20%C2%B7%20functions%2098.0%25-brightgreen)](#testing--reliability)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](#engineering-notes)
[![node](https://img.shields.io/badge/node-%3E%3D18-blue)](https://nodejs.org)

---

## Platform Support

**One `mcp/server.mjs`, three hosts** — the only differences are *who dispatches subagents* and *whether subagents can talk*.

| | ZCode | dsh (DeepSeek Harness) | Codex CLI |
| --- | --- | --- | --- |
| MCP wiring | Bundled plugin (`.zcode-plugin/`) | `@deepseek-ai/dsh-mcp-client` (stdio) | `[mcp_servers.taskswarm]` |
| Tool prefix | `mcp__plugin_taskswarm_taskswarm__*` | `mcp__taskswarm__*` | `mcp__taskswarm__*` |
| Dispatch subagents | `Agent` (`run_in_background`) | `subagent` (`spawn`/`fork`) | `.codex/agents/*.toml` + `multi_agent` |
| Parent → child push | `SendMessage` (running children only) | **`send_message`** (continuable) | ❌ none |
| Child → parent report | ❌ none | **`report`** | ❌ none |
| Observe / intervene | ❌ none | **`list_agents` / `interrupt_agent`** | ❌ none |
| Maturity | **Native** (the plugin was born here) | **MCP link tested** (all 11 tools); orchestration mapped to native tools | Mount confirmed; **subagent MCP inheritance is version-dependent — verify yourself** |

**Bottom line**: the board channel works on every host — that is what makes this portable. dsh additionally offers direct subagent ↔ parent channels, so it is strictly more capable: the board drops from "the only channel" to "a shared blackboard plus the durable source of truth."

> **Verification boundary (no overclaiming)**: of the three hosts, **only ZCode has run a real end-to-end swarm** — the plugin was born there, and all 123 tests exercise that path. dsh is verified up to "MCP link + all 11 tools + dependency guard" (driven step by step the same way `dsh-mcp-client` does it); Codex is verified up to "MCP mount confirmed." **The full model-driven swarm has not yet been run on either** — every usable relay key was out of quota on the day of testing. Codex carries one further version-dependent risk: whether subagents inherit the parent session's MCP tools varies by version and must be verified yourself. See the verification-record tables in each `adapters/` doc.

Configs and per-platform verification records: [`adapters/dsh/`](adapters/dsh/README.md) and [`adapters/codex/`](adapters/codex/README.md).

---

## 30-Second Overview

A single AI subagent is capable but **strictly linear** — it does one thing at a time. Faced with "refactor the auth module + add tests + update the docs," it does them in sequence.

TaskSwarm has the main agent decompose a goal into a **task tree**, dispatch the independent parts **concurrently** to background subagents, and give them a shared board to exchange progress on. The main agent then collects each wave, forwards key results, and summarizes.

```
one goal  →  task tree (with dependencies)  →  dispatch in waves  →  shared board  →  summary
```

## Core Insight: Subagents Can't Talk to Each Other

This is the root constraint the plugin exists to solve, and the biggest difference from "have the main agent casually spawn a few subagents."
(The probes below were run on ZCode; dsh's subagent stack is more complete — see [Platform Support](#platform-support).)

I probed capabilities before writing any code. Measured results:

| Capability | Main agent | Subagent |
| --- | --- | --- |
| Spawn a subagent (`Agent`) | ✅ yes | ❌ **no** |
| Message another agent (`SendMessage`) | ✅ yes | ❌ **no** |
| Call MCP tools | ✅ yes | ✅ **yes** |

In other words: **subagents are mute workers — they can do the job, but they cannot speak, and they cannot spawn their own helpers.**

That constraint dictates the communication design:

1. **Board pull (primary channel)** — Subagents read and write a shared board over MCP: `task_claim` to take work, `task_update` to report progress, `board` for the team's status, `task_notes` for a peer's full conclusions. Because it is a *pull*, a subagent never needs anyone to notify it. **The board is both readable and writable** — any agent can leave a note on any task card (`task_update`'s owner check only guards *status transitions*), which makes it a genuine two-way channel between peers.
2. **Orchestrator push (supplementary channel)** — The main agent is the only role holding `SendMessage`, so it acts as the courier: it writes upstream results into a new subagent's prompt, and forwards key conclusions to running subagents that depend on them. **I verified this channel**: a message carrying a verification code reached a subagent in the middle of a long task — it works, it is not a theoretical design.

![Architecture](docs/architecture.svg)

*(Editable source: [`docs/architecture.drawio`](docs/architecture.drawio))*

## Why Not Just Use an Existing Solution

Research findings (2026-09): **Claude Flow / Ruflo** (61k★), **barkain/claude-code-workflow-orchestration**, and **Agent Teams** are all Claude Code specific. They depend on experimental `TaskCreate` / `TeamCreate` / hooks machinery that ZCode does not have, so they cannot be ported.

On the ZCode side: native subagents **can call MCP tools** (probe-verified), but there is no `SendMessage` — so coordination must be designed as the two-channel "board pull + orchestrator push" above; agent-to-agent direct links are simply not available.

(dsh is better positioned: it natively provides `send_message` / `report` / `list_agents`, so subagents and their parent can connect directly. The board channel works on both hosts, and dsh can layer the direct channels on top.)

The architecture is **"MCP supplies deterministic capability + SKILL.md supplies the orchestration procedure"**:

- **All deterministic work lives in the MCP server**: task-tree storage, dependency resolution, double-claim prevention, concurrent writes, board rendering, note pagination. These have one correct answer and should not be left to an LLM to improvise every run.
- **The orchestration loop stays with the main agent**: what to decompose, how finely, whom to dispatch, when to collect, what to forward. That needs judgment. ZCode exposes no plugin-level scheduling API, so the main agent *is* the scheduler.

## Install

Requires **Node.js ≥ 18** and zero third-party dependencies.

```bash
git clone https://github.com/Wersky/taskswarm.git
```

### ZCode

**Settings → Plugins → Discover → "+" Add local directory marketplace**, point it at the directory containing `marketplace.json`, install `taskswarm`, and restart the session.

The plugin manifest uses `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PROJECT_DIR}` placeholders and **hardcodes no absolute paths** — clone it anywhere and it runs.

### dsh (DeepSeek Harness)

Add the `insert` block from [`adapters/dsh/cordis.patch.yml`](adapters/dsh/cordis.patch.yml) to your profile patch and fix the path in `args`:

```yaml
- insert:
    - id: mcp-taskswarm
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: taskswarm
        transport: stdio
        command: node
        args: ['/your/path/to/taskswarm/mcp/server.mjs']
```

```bash
dsh --profile <name> --dump-config | grep mcp-taskswarm   # confirm it loaded
```

### Codex CLI

```bash
codex mcp add taskswarm -- node /your/path/to/taskswarm/mcp/server.mjs
codex mcp list
```

Note that Codex 0.154+ providers support only `wire_api = "responses"`. See [`adapters/codex/README.md`](adapters/codex/README.md).

## Usage

```bash
/swarm Refactor the auth module and add tests
```

Or just say "task swarm: <task>" / "decompose this and run it in parallel."

The main agent shows the decomposed task tree, dispatches in dependency waves, and you can check the board at any time:

```
[T1] (done)        Extract the auth interface @agent-1 💬 interface frozen in src/auth/types.ts, frontend can reference it
[T2] (in_progress) Rewrite the login flow @agent-2 💬 wired to the new interface, adding error branches
[T3] (pending)     Update the login docs ← depends on: T1
```

### When **not** to use it

- **Fewer than 3 subtasks** — decomposition overhead outweighs the parallelism; just do it directly.
- **Tightly serial dependencies** — you would still wait wave by wave, with no parallelism to gain.
- **Frequent back-and-forth discussion** — use the [roundtable](https://github.com/Wersky/roundtable) plugin instead.
- **Just reading code or searching** — an Explore subagent is cheaper.

### One hard rule: subtasks touching the same files must be serialized

The most common way parallelism fails is two subagents editing the same file at once — the later write clobbers the earlier one, and *both* believe they succeeded. **Any tasks that touch the same files must be chained with `dependsOn`.**

## PPR Review Gate (2.1.0)

Assigning a `reviewer` to a task enables the review gate — **downstream work is undispatchable until it passes**, enforced by mechanism rather than convention:

```
producer sets done ──▶ rerouted to pending_review ──▶ downstream blocked
                                                      │
                        reviewer task_review ─────────┴──▶ approve: → done, downstream released
                                                            reject : → in_progress, downstream stays blocked
```

- `pending_review` is not in the "completed" set, so `task_ready` / `task_claim` block downstream automatically;
- A rejection must carry a reason (written to the task notes; the producer redoes the work and resubmits to review);
- Only the registered reviewer may adjudicate; the main agent can override with `force:true` (which leaves an audit event);
- Multi-level review chains are supported (A passes → B starts → B passes → C released);
- **With no reviewer configured, behavior is completely unchanged** (backward compatible).

Combined with [swarmbridge](https://github.com/Wersky/swarmbridge)'s `plan` message this enables **cross-machine PPR**: the peer sends a plan (with `role`/`reviewer` assignments) → you build a local task tree inheriting the reviewers → the local review gate runs → results are reported back.

### Proposal Loop (2.2.0)

The review gate governs *whether output is acceptable*; the proposal loop governs **whether the plan itself should change** — and the subagents doing the work are the ones who knows what the plan is missing.

- **Propose**: a producer that hits a blocker or finds a better approach sends a [swarmbridge](https://github.com/Wersky/swarmbridge) `proposal` message to the bridge thread (`data = {forTask?, problem?, items?, rationale?}`). On a single machine it can simply write a `task_update` note and let the main agent forward it.
- **Adopt**: if the reviewer finds the suggestion sound, it attaches `proposals` to `task_review` — **the new plan items enter the tree as the review passes** (carrying optional `role`/`reviewer`/`assignee`/`dependsOn`), and the call returns `adopted:{count, ids}`.
- **Dispatch**: the main agent dispatches by the new tasks' `assignee` hint. `assignee` is only a suggestion and **does not affect who can `task_claim`** (fundamentally different from `reviewer`, which arms the gate).
- **Rejection adopts nothing**: `reject` **ignores `proposals` entirely**; a rejection cannot smuggle in new tasks.
- **Adoption is atomic**: if any item is invalid (missing `title`, illegal `role`, nonexistent dependency), the whole batch is dropped and the tree is left untouched.

## MCP Tools

| Tool | Caller | Purpose |
| --- | --- | --- |
| `plan_create` | main agent | Create the task tree (recursive nesting ≤ 5 levels, dependencies, cycle detection, `failurePolicy`) |
| `plan_get` | main agent | Full tree + ready tasks + recent events |
| `task_ready` | main agent | Tasks whose dependencies are satisfied and can be dispatched (with `blockedBy` annotations) |
| `task_claim` | subagent | **Atomic claim** (prevents double dispatch) |
| `task_update` | subagent / main agent | Status transitions + progress notes; the main agent recovers dead tasks with `force:true` |
| `task_notes` | everyone | **Read full notes** (paginated, `limit ≤ 200`) |
| `task_add` | main agent / subagent | Add tasks mid-flight (decomposition continues as work proceeds) |
| `task_review` | **reviewer** | **PPR adjudication**: `approve` releases downstream / `reject` sends it back; may carry `proposals` adopted on pass |
| `board` | everyone | **Shared progress board** (status, owner, latest note excerpt) |
| `plan_reset` / `state` | main agent | Restart / persist and restore state |

> The real tool prefix is `mcp__plugin_taskswarm_taskswarm__` on ZCode, for example `mcp__plugin_taskswarm_taskswarm__task_claim`. On dsh and Codex it is `mcp__taskswarm__`.

**Every call must pass `workspace` explicitly** (the absolute workspace path) — omit it and state lands in the server process's cwd, not where you think. This behavior is locked by a test (the "falls back to process cwd when workspace is omitted" case in `lock-failure.test.mjs`).

## Testing & Reliability

**123 tests, all passing; 90.3% line coverage, 98.0% function coverage.**

```bash
npm test          # 123 tests, 0 fail
npm run coverage  # 90.3% lines (895/991) · 98.0% functions (99/101)
```

Requires Node ≥ 18, with no test-framework dependency (uses built-in `node:test` + `node:assert/strict`).

### Why every test drives a subprocess

This plugin's reliability promises — **concurrent multi-process writes never corrupt data, and a task is never claimed twice** — only hold when **multiple real processes** share one state file. In-process Promise concurrency proves nothing (the event loop is inherently serial). So every test spawns a real MCP server process, exactly as production does.

### Real defects this suite caught

During development and audit, the tests (plus separately written reproduction scripts) located and locked down the following. All now have regression coverage:

| Defect | Symptom | Current state |
| --- | --- | --- |
| Concurrent writes corrupted state | Two processes writing 120 notes each → corrupt JSON, 217 tool errors during the window, plan unrecoverable | Atomic replace + cross-process lock; locked by "two processes append 120 notes each" |
| Concurrent double-claim | 60 concurrent claims of one task: **both sides succeeded 4 times** | Now **0**; locked by "60 concurrent claims of one task" |
| Unbounded notes | State file and responses grew without limit (500 long notes ≈ 100 KB+), rewritten in full on every operation | 500 notes per task / 4000 chars per note, newest kept and drops accounted in `notesDropped` |
| Long text unreadable back | `plan_get`/`board` returned only 60/120-char excerpts; full text was unreachable | Added `task_notes` with pagination |
| Third-level nesting silently lost | `subtasks` expanded only two levels; the third vanished without a trace | Recursive expansion ≤ 5 levels, with an explicit error past the limit |
| `__proto__` as a task id | The task disappeared after persisting (prototype pollution) | Strict id validation + `Object.create(null)` |
| Failed upstream still dispatched downstream | Comments claimed "blocked" but it actually let through | `failurePolicy: block` (default) truly blocks; `proceed` is available and annotates `blockedBy` |
| Unguarded state machine | Anyone could change any task, terminal states could be rolled back, `done` could be re-claimed | Transition table + owner checks; recovery goes through `force:true` (audited) |
| Corruption silently lost data | A corrupt file just reported "no swarm in progress" | Automatic `.corrupt-<timestamp>.json` backup plus an explicit error |
| Wrong tool-name prefix in docs | SKILL.md said `mcp__taskswarm__*`; the real prefix is `mcp__plugin_taskswarm_taskswarm__*` | Corrected and called out in both README and SKILL |

The most instructive one: the original `board` owner-filter test asserted `!A || B` — the second half is always true, so **the test passed even with filtering completely broken**. The new suite uses a two-way assertion (A's view must contain A and must not contain B) and additionally checks that `activeWorkers` is filtered too — that field genuinely was not being filtered, and the new test caught it.

### Reliability mechanisms

- **Atomic replace on write**: write `<file>.tmp-<pid>` → `fsync` → `rename`. Readers never see a partial file (zero corruption across hard-kill-during-write tests).
- **Cross-process file lock**: `openSync(lock, 'wx')` for atomic acquisition, with the holder recorded as `{pid, at, host}`. Stale locks left by crashes are reclaimed automatically via **PID liveness probing** or **lock-age timeout**, leaving a "lock reclaimed" log entry.
- **Self-healing on corruption**: a parse failure backs up the original before erroring — never silently treated as "no plan."
- **Controllable failure semantics**: by default an upstream failure blocks downstream (no building on a broken foundation); `proceed` allows continuing with known defects and marks the offending upstream in `task_ready` via `blockedBy`.
- **`force` is an audit mechanism, not a permission mechanism**: the MCP protocol layer cannot verify "are you the main agent," so any caller can pass `force:true`. Its value is **leaving a traceable audit event** (operator, previous owner, state transition) — not stopping anyone. A dedicated test locks this boundary so nobody later mistakes it for a guard.

## Engineering Notes

- **Zero dependencies**: the MCP server uses only Node built-ins (`fs` / `path` / `readline` / `os`) — no package-lock, no supply-chain surface. The whole server is about 1000 lines.
- **Portable**: the plugin manifest uses placeholders; it starts from a bare `node` (with a test launching it from an unrelated cwd).
- **A coverage trap worth knowing**: `node --experimental-test-coverage` knows nothing about code running in **subprocesses** — run it directly and you get an empty "0 files, 100%" report. So `scripts/coverage.mjs` collects each subprocess's V8 coverage via `NODE_V8_COVERAGE` and merges it, deciding by "innermost range covering the line." That script was validated against a controlled sample with known answers (including a deliberately uncalled function and an unreached branch) before being trusted for real numbers.
- **Tests exit gracefully**: `helpers.mjs`'s `kill()` closes stdin so the server exits `exit(0)` cleanly, force-killing only on timeout — otherwise V8 never gets to write its coverage data. Crash-simulation cases explicitly use `killHard()`.

## Roadmap

- [ ] Subagent heartbeat and automatic reclamation on timeout (currently a lost task needs a manual `force` from the main agent)
- [ ] Task artifact registry (structured record of each task's output paths, for summarization and acceptance)
- [ ] Cross-workspace swarms (state files are currently isolated per workspace)
- [ ] Combined flow with the [`roundtable`](https://github.com/Wersky/roundtable) plugin (discuss to settle a plan → swarm to execute it)

## Known Limitations

- **Parallelism**: ≤ 4 background subagents per wave is recommended; beyond that, context switching and token overhead eat the gains.
- **Push has latency**: inter-subagent information flows via the board (pull) or the main agent's forwarding — neither is real time.
- **`force` is not a security boundary**: see the last item under "Reliability mechanisms."
- **Multiple swarms sharing one workspace share one state file**: use a separate workspace for long-running work.

## Sister Plugins (the Swarm suite)

These three plugins form one "swarm" suite — each works standalone, together they interlock:

| Plugin | Role | Repo |
| --- | --- | --- |
| **TaskSwarm** (this repo) | On-machine task swarms: decomposition, parallel dispatch, shared board, PPR review gate | this repo |
| **SwarmBridge** | Cross-machine message bus over GitHub Issues (`plan` / `proposal` / `discuss` structured messages between agents on different machines) | [Wersky/swarmbridge](https://github.com/Wersky/swarmbridge) |
| **Roundtable** | Multi-agent roundtable: ordered turns, cross-fire, meeting minutes — with remote members joining over SwarmBridge | [Wersky/roundtable](https://github.com/Wersky/roundtable) |

Recommended pairing: roundtable settles the plan → TaskSwarm executes it; use SwarmBridge to distribute plans and report results across machines (see "cross-machine PPR" above).

## License

MIT © 2026 Wersky
