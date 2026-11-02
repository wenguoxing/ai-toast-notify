# ai-notify 设计文档

- 日期：2026-11-02
- 状态：已获用户批准（分节设计逐节确认）
- 类型：新项目（Architectural）

## 1. 概述

**ai-notify** 是一个 Windows 优先的 npm CLI 工具：当 **Claude Code、Codex** 的任务**结束、异常、中断、等待用户操作**时，发送 **Windows 桌面 toast 通知**。

一句话架构：无守护进程，`ai-notify send` 作为统一通知程序，被 Claude Code 的 hooks 和 Codex 的 `notify` 配置调用，读 stdin JSON → 归一化 → 发 toast → 退出。

### 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 通知渠道 | Windows 桌面 toast（不做手机推送/多渠道） |
| 技术栈 | Node.js（TypeScript），npm 全局安装，npx 可尝鲜 |
| 进程模型 | 方案 A：无守护进程，每次调用独立发通知 |
| 事件范围 | Claude Code 全事件；Codex 仅 `agent-turn-complete`（官方唯一出口），不做 PTY 包装器 |
| toast 实现 | spawn PowerShell 调原生 WinRT API（零 npm 依赖），不用 node-notifier/SnoreToast（AV 误报风险） |

## 2. 背景与调研结论

### 2.1 官方通知机制（两个入口）

**Claude Code hooks**（[官方文档](https://code.claude.com/docs/en/hooks)）：
- hook 通过 stdin 收 JSON（含 `session_id`、`transcript_path`、`cwd`、`hook_event_name`、消息体等）
- 关键事件：`Stop`（回合完成）、`StopFailure`（API 错误，含 `failure_reason`：`rate_limit`/`server_error` 等）、`Notification`（`permission_prompt`/`agent_needs_input`/`idle_ping`）、`PostToolUseFailure`（含 `is_interrupt`）、`SubagentStop`
- Windows 原生支持，hook command 默认在 cmd 下执行

**Codex notify**（`~/.codex/config.toml`）：
- `notify = ["程序", "参数", ...]`，目前仅 `agent-turn-complete` 事件
- JSON payload 通过 stdin + argv 传入，含 `last-assistant-message`

### 2.2 参考项目

| 项目 | 借鉴点 |
|---|---|
| [DevinoSolutions/ai-agent-notifier](https://github.com/DevinoSolutions/anotifier-for-claude-codex-cursor) | 最接近的成熟方案：统一通知程序 + 多 CLI 配置指向它 + npx 分发。本设计的整体架构参考 |
| [soulee-dev/claude-code-notify-powershell](https://github.com/soulee-dev/claude-code-notify-powershell) | 零依赖 PowerShell 原生 WinRT toast 的可行性验证（本设计的 toast 后端路线） |
| [ntfy.sh](https://ntfy.sh) / [Apprise](https://github.com/caronc/apprise) | 未来扩展手机推送/多渠道时的基础设施，v1 不做 |
| many-ai-cli | PTY 包装器思路，用于 Codex 中断/异常检测——已明确**不采用**（复杂度不值） |

### 2.3 市场空白（本项目定位）

Windows 原生 + 同时支持 Claude Code 与 Codex + 覆盖结束/异常/中断/等待输入的成熟工具**不存在**；且多数现成工具只做"完成通知"，异常与等待权限场景少有人覆盖。

## 3. 需求与范围

### 3.1 In scope（v1）

- npm 包 `ai-notify`，全局安装，命令：`install` / `uninstall` / `send` / `test`
- Claude Code 事件：任务完成、出错停止、等待权限、等待输入、工具中断
- Codex 事件：回合完成（含最后回复摘要）
- Windows 10/11 桌面 toast，按事件类型区分文案与样式
- 幂等安装/卸载，保留用户已有配置，写前备份
- 用户配置文件（开关个别事件、声音等）

### 3.2 Out of scope（v1 明确不做）

- 手机推送（ntfy）、Telegram/Discord 等多渠道（Apprise）
- 常驻守护进程（去重/合并/静音时段/通知历史）——方案 B，留待演进
- Codex 中断/异常检测（PTY 包装器）
- macOS/Linux 桌面通知
- 通知点击动作（跳转终端等）

## 4. 架构设计

### 4.1 总体架构与组件

```
┌─ 安装时 ──────────────────────────────────────┐
│ ai-notify install                              │
│   ├─ 写 Claude Code hooks (~/.claude/settings.json) │
│   ├─ 写 Codex notify (~/.codex/config.toml)    │
│   ├─ 写用户配置 (~/.ai-notify/config.json)      │
│   └─ 发一条测试 toast 验证链路                   │
└───────────────────────────────────────────────┘
┌─ 运行时（每次事件，无常驻进程）──────────────────────┐
│ hook/notify 触发 → node cli.js send [--codex]   │
│   → 读 stdin JSON → 识别来源 → 解析归一化          │
│   → 发 toast → 记日志 → exit 0                   │
└───────────────────────────────────────────────┘
```

npm 包内模块（单包，TypeScript）：

| 模块 | 职责 |
|---|---|
| `src/cli.ts` | 命令入口与参数解析：`install` / `uninstall` / `send` / `test` |
| `src/adapters/claude.ts` | 解析 Claude Code hook JSON → `NotifyEvent` |
| `src/adapters/codex.ts` | 解析 Codex notify JSON → `NotifyEvent` |
| `src/notify/toast.ts` | toast 后端：spawn PowerShell 调 WinRT API；AppId 显示为 "ai-notify" |
| `src/install/claude-config.ts` | 合并写入 `~/.claude/settings.json` 的 hooks |
| `src/install/codex-config.ts` | 增量修改 `~/.codex/config.toml` 的 `notify` 键 |
| `src/config.ts` | 用户配置 `~/.ai-notify/config.json` 读写，损坏时回退默认值 |
| `src/log.ts` | 追加式日志，1MB 轮转 |

### 4.2 归一化事件模型

```ts
type NotifyEvent = {
  source: 'claude-code' | 'codex'
  kind: 'done' | 'error' | 'interrupted' | 'needs-input'
  title: string   // "Claude Code · <目录名>" / "Codex · <目录名>"
  detail?: string // 错误原因 / 最后回复摘要
  cwd: string
}
```

### 4.3 事件映射（数据流）

**Claude Code**：

| Hook 事件 | → kind | 默认 | toast 文案 |
|---|---|---|---|
| `Stop` | `done` | 开 | 任务完成，等你查看 |
| `StopFailure` | `error` | 开 | 出错停止：`<failure_reason>` |
| `Notification`(permission_prompt) | `needs-input` | 开 | 等待你批准工具调用 |
| `Notification`(agent_needs_input) | `needs-input` | 开 | 在等你输入 |
| `Notification`(idle_ping) | — | **关** | （可配置打开） |
| `PostToolUseFailure`(is_interrupt) | `interrupted` | 开 | 任务被中断 |
| `SubagentStop` | — | **关** | （可配置打开） |

**Codex**：

| 事件 | → kind | 说明 |
|---|---|---|
| `agent-turn-complete` | `done` | `last-assistant-message` 截取前 80 字符做 detail |

**文案规则**：标题 = 工具名 + `cwd` 的 basename（多项目并行可区分）；`error` 红色系样式，`done` 默认色。

**来源识别**：优先 `--codex` flag；无 flag 时按 payload 特征嗅探（`type === "agent-turn-complete"` → codex；有 `hook_event_name` → claude）。保证裸调用 `ai-notify send` 手动调试可用。

### 4.4 安装与配置

**前置**：`npm install -g ai-notify`（npx `npx ai-notify@latest install` 仅尝鲜，install 会检查全局安装）。

**`install` 行为**：
1. 定位自身绝对路径，hook command 写 `node "<绝对路径>\cli.js" send`（直接调 node，绕开 cmd shim 引号/PATH 问题）；Codex 写 `notify = ["node", "<路径>", "send", "--codex"]`
2. `settings.json`：读 → 解析 → 合并 hooks（只追加自有条目）→ 备份 → 写回；**幂等**
3. `config.toml`：TOML 库读 → 只改 `notify` 键 → 备份 → 写回（用户模型配置等原样保留）
4. 生成默认用户配置 `~/.ai-notify/config.json`
5. 立即发测试 toast，当场验证链路

**用户配置格式**：

```json
{
  "events": { "idlePing": false, "subagentStop": false },
  "toast": { "sound": true },
  "codex": { "messagePreview": true }
}
```

**`uninstall`**：按 command 字符串特征精确移除自有条目，保留用户其他配置；删除 `~/.ai-notify/`。

**升级**：`npm update -g ai-notify`，配置不动。

### 4.5 错误处理

核心原则：**通知工具永远不能干扰用户的工作流**。

- `send`：stdin 读取 3s 超时；PowerShell 调用 5s 超时；任何异常吞掉 + 记日志 + `exit 0`
- 配置读不到/损坏 → 内置默认值，不丢通知
- 写配置前备份（`.bak.<时间戳>`）；解析失败中止不写
- 日志 `~/.ai-notify/log.txt`：每次事件一行（时间/来源/kind/结果），1MB 轮转
- PowerShell 极端失败（精简系统）→ 记日志，无二级 fallback

## 5. 测试策略

| 层 | 内容 |
|---|---|
| 单测（vitest） | adapters：真实样本 JSON fixture（完成/限流错误/权限提示/中断/codex 回合）断言归一化结果 |
| 单测（vitest） | install 合并逻辑：样本 settings.json / config.toml 读改写快照；断言**幂等**（跑两遍相同）且**不碰用户已有条目** |
| mock 测试 | mock `child_process.spawn`，断言 PowerShell 参数与模板构造正确 |
| 手动验收 | 真机：`ai-notify test` → `install` → 跑 30 秒小任务 → 确认 toast；README 验收清单 |
| 流程 | TDD，先写测试再实现 |

## 6. 已知限制（写入 README，如实告知）

1. **纯 Esc 中断检测不到**：Claude Code 对"用户按 Esc 且无工具运行"不触发任何 hook；仅工具运行中被中断（`PostToolUseFailure.is_interrupt`）可捕获。官方机制天花板，非软件 bug。
2. **VSCode 扩展中权限提示可能不触发 Notification hook**（上游 issues [#56936](https://github.com/anthropics/claude-code/issues/56936)、[#55875](https://github.com/anthropics/claude-code/issues/55875)）；终端使用不受影响。
3. **Codex 仅回合完成**：其中断/异常无官方出口，v1 不覆盖。
4. **仅 Windows 10/11**。

## 7. 未来演进（不在 v1）

- 方案 B 守护进程（去重/静音时段/通知历史）：`send` 入口可平滑变为其事件提交端，无需推翻
- ntfy 手机推送 / Apprise 多渠道：在 toast 后端旁加通道即可
- Codex 事件扩展：等官方支持更多 notify 事件
