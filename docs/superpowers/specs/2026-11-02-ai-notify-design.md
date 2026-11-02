# ai-toast-notify 设计文档（v1.2 修订版）

- 日期：2026-11-02（v1.1 修订：2026-11-02；v1.2 修订：2026-11-02）
- 状态：v1.2 已按二次 Review 修订，待用户确认后进入实现
- 类型：新项目（Architectural）
- 修订说明：v1.0 有 5 处事实性错误（包名冲突 / Codex argv / StopFailure 字段 / idle_prompt / TOML 根键），v1.1 新增 Codex 新 hooks 体系接入；v1.2 按二次 Review 修正 Codex 侧 4 处事实问题——**`async:true` 会被 Codex 静默跳过**、Interrupt timeout 上限 3s、hook 信任（hash）机制、事件总数 12 种（无 PreModelRequest/PostModelRequest），并统一嗅探判据与 `messagePreview` 作用域。

## 1. 概述

**ai-toast-notify** 是一个 Windows 优先的 npm CLI 工具：当 **Claude Code、Codex** 的任务**结束、出错、中断、等待用户操作**时，发送 **Windows 桌面 toast 通知**。

一句话架构：无守护进程，`ai-toast-notify send` 作为统一通知程序，被三个入口调用——Claude Code hooks、Codex 新 hooks（`~/.codex/hooks.json`）、Codex 旧 `notify`（回退）——读入事件（stdin 或 argv JSON）→ 归一化 → 发 toast → 退出。

### 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 包名 | **`ai-toast-notify`**（npm 上 `ai-notify` 已被 unoryota/ai-notify v0.14.9 占用且同赛道；`ai-toast-notify` 已验证可用） |
| 通知渠道 | Windows 桌面 toast（不做手机推送/多渠道） |
| 技术栈 | Node.js（TypeScript ESM），npm 全局安装，零运行时依赖 |
| 进程模型 | 无守护进程，每次调用独立发通知；Claude hook 用 `async:true` 不阻塞宿主，**Codex hook 同步执行**（Codex 会静默跳过 `async:true` 的 handler，官方明确 async 尚不支持） |
| Claude Code 入口 | hooks（settings.json），**exec form**（`command` + `args` 数组），挂 Stop / StopFailure / Notification / PostToolUseFailure / SubagentStop |
| Codex 入口（主） | **新 hooks 体系 `~/.codex/hooks.json`**：Stop（完成）/ Interrupt（中断）/ PermissionRequest（等待批准）/ SubagentStop（默认关）。stdin JSON，payload 与 Claude 同构（含 `hook_event_name`） |
| Codex 入口（回退） | 旧 `notify`（config.toml）：仅 `agent-turn-complete`，**payload 走 argv 末参数（stdin 为 null）**。默认不写入；仅 `install --legacy-notify` 显式启用；与 hooks.json 路径互斥，避免双重通知 |
| toast 实现 | spawn PowerShell 调原生 WinRT API（零 npm 依赖），AUMID 用系统 PowerShell 快捷方式；不用 BurntToast/pwsh7/node-notifier/SnoreToast |

## 2. 背景与调研结论（已逐项对照官方文档与源码核实）

### 2.1 官方通知机制（三个入口）

**A. Claude Code hooks**（code.claude.com/docs/en/hooks，已核实）：
- stdin 收 JSON（`session_id`/`transcript_path`/`cwd`/`hook_event_name` 等）
- `Stop`：回合完成。payload 含 `stop_hook_active`、**`last_assistant_message`（官方建议通知类 hook 直接用，勿解析 transcript）**、**`background_tasks`/`session_crons`（非空 = 会话暂停等待后台工作唤醒，不是真结束，应跳过通知）**
- `StopFailure`：API 错误停止。字段为 **`error`**（`rate_limit`/`overloaded`/`authentication_failed`/`server_error`/…）+ 可选 `error_details` + `last_assistant_message`。**没有 `failure_reason` 字段（v1.0 笔误）**
- `Notification`：`notification_type` ∈ `permission_prompt` / **`idle_prompt`（v1.0 误写 idle_ping）** / `agent_needs_input` / `auth_success` / elicitation 系列 / quota 系列 / `agent_completed` / `plugin_notification`。**未知类型一律兜底为 needs-input（宁可多响不可漏报）**
- `PostToolUseFailure`：含 `is_interrupt`。官方明确：**用户取消运行中的工具不会触发此 hook**（取消走 tool result）；`is_interrupt:true` 仅表示"失败以 abort 形式到达"
- `SubagentStop`：含 `agent_id`/`agent_type`/`last_assistant_message`
- 命令 hook 支持 **exec form（`command`+`args`，无 shell、引号天然安全）与 `async: true`**；shell form 在无 Git Bash 的 Windows 走 PowerShell，纯引号串 command 会被打印而不执行（官方 "PowerShell started no program" 一节）。**本工具一律用 exec form**

**B. Codex 新 hooks（openai/codex 源码 codex-rs/hooks，已核实；本机 `~/.codex/hooks.json` 已在用）**：
- 文件 `~/.codex/hooks.json`，结构 `{ "hooks": { "<Event>": [ { "matcher"?, "hooks": [ { "type":"command", "command":"<单字符串>", "commandWindows"?, "timeout"? } ] } ] } }`
- 12 种事件：PreToolUse / **PermissionRequest** / PostToolUse / PreCompact / PostCompact / SessionStart / SessionEnd / UserPromptSubmit / SubagentStart / SubagentStop / **Stop** / **Interrupt**（v1.1 误列 14 种——PreModelRequest / PostModelRequest 不存在，已核实官方事件表）
- ⚠️ **`async:true` 的 handler 会被 Codex 静默跳过**（官方原文："async command hooks aren't supported yet. Codex skips handlers with async: true"）→ 本工具 Codex 条目**一律不写 async**，同步执行 + 短 timeout；Claude 侧仍用 `async:true`（两家行为不同，安装器分别生成）
- **Interrupt 事件 timeout 上限 3 秒**（官方：限 1–3 秒，含后台执行）→ Interrupt 条目 `timeout:3`，其余事件 `timeout:10`
- **信任机制**：非托管 hook 须经用户在 Codex 内 `/hooks` 审查信任后才执行；信任按 hook 定义 **hash** 记录，定义变化（如升级后 node/cli 路径变化）即失效、**跳过直到重新信任** → install 输出提示，README 排障首条 + 升级须知
- command 为单字符串，Windows 下经 `cmd /C "…"` 执行；**payload 以 JSON 写入 stdin**（command_runner.rs：`stdin(Stdio::piped())` + `write_all(input_json)`）
- payload 与 Claude 同构：`session_id`/`turn_id`/`transcript_path`/`cwd`/`hook_event_name`/`model`/`permission_mode` + 事件字段。`Stop` 含 `last_assistant_message`、`background_tasks`、`session_crons`；`PermissionRequest` 含 `tool_name`/`tool_input`
- **PermissionRequest hook 可返回 allow/deny 决策**；本工具 stdout 恒为空、exit 恒 0 = 不干预审批流
- 注意：Codex hooks **没有 StopFailure 事件**；turn 以 API error 结束时不触发任何 hook（上游 issue #54884）→ 已知限制
- 本机 hooks.json 已有第三方（orca）条目，安装必须**只追加自有组、逐字保留他人条目**

**C. Codex 旧 `notify`（config.toml，回退路径，源码 legacy_notify.rs 已核实）**：
- `notify = ["程序", "参数", ...]`，仅 `agent-turn-complete`
- **payload 追加为 argv 最后一个参数（单个 JSON 字符串），stdin 为 `Stdio::null()`**（v1.0 误以为 stdin，会导致 Codex 全挂）
- payload 键：`type`/`thread-id`/`turn-id`/`cwd`/`client`/`input-messages`（**字符串数组**）/`last-assistant-message`
- TOML 约束：根键必须位于第一个 `[table]` 之前——**追加到文末会被吞进上一个 table**（v1.0 的 bug）
- 已知上游 bug：长会话 `input-messages` 累积超 argv 上限（Windows ~32K / Linux 128K）时 notify **静默不触发**（issue #18309 / #34878）→ 已知限制

### 2.2 参考项目（成熟度已核实）

| 项目 | 星数/活跃 | 借鉴点 | 与本项目差异 |
|---|---|---|---|
| DevinoSolutions/anotifier | 35★，活跃维护，AGPL-3.0 | 整体架构、`async`+timeout、未知通知类型兜底为 needs-input、`background_tasks` 处理、minDuration/静音等产品思路 | 依赖 pwsh7+BurntToast；多渠道；AGPL |
| soulee-dev/claude-code-notify-powershell | 92★，MIT | 零依赖 PS 5.1 原生 WinRT toast + PowerShell AUMID 的可行性验证（本 toast 后端路线） | 仅 Claude、仅完成/通知两类 |
| TianqiZhang/claude-code-toast | 10★，MIT | WinRT + AUMID + XML 转义（System.Security.SecurityElement.Escape）同类实现 | 仅 Claude |
| unoryota/ai-notify（npm 同名包） | npm v0.14.9 | TOML 根键须在 table 前、**检测到他人 notify 时跳过不覆盖**、marker 注释标识自有条目 | 正是占用 `ai-notify` 包名的项目；macOS 声音/朗读为主 |
| BurntToast / node-notifier / SnoreToast | — | 反例：模块依赖 / AV 误报 / 需 pwsh7，v1 不用 | — |
| ntfy / Apprise | — | 未来多渠道扩展的基础设施 | v1 不做 |

### 2.3 定位（修订）

不再是"市场空白不存在成熟工具"——anotifier 与 unoryota/ai-notify 都存在且活跃。本项目的差异化定位：**零运行时依赖（无 BurntToast/pwsh7）、Windows 原生 WinRT toast、简体中文文案、同时接 Claude Code 与 Codex 双 hooks 体系（含 Codex Interrupt/PermissionRequest）、安装器幂等且逐字保留他人 hooks**。若不需要这些差异，直接使用 anotifier 也是合理选择。

## 3. 需求与范围

### 3.1 In scope（v1）

- npm 包 **`ai-toast-notify`**（bin 同名），命令：`install [--legacy-notify]` / `uninstall` / `send` / `test`
- **Claude Code**：任务完成、出错停止、等待批准/等待输入、工具 abort、（默认关）空闲提醒与子代理完成
- **Codex（hooks.json）**：回合完成（含 `last_assistant_message` 摘要与 `background_tasks` 判断）、任务中断（Interrupt）、等待批准（PermissionRequest）、（默认关）子代理完成
- **Codex（config.toml notify 回退，可选）**：仅 `install --legacy-notify` 显式启用；回合完成（argv payload，含回复摘要）
- Windows 10/11 桌面 toast，按事件类型区分文案与 emoji 样式
- 幂等安装/卸载，逐字保留用户与第三方（如 orca）已有 hooks，写前备份
- 用户配置文件（开关个别事件、声音、消息预览）

### 3.2 Out of scope（v1 明确不做）

- 手机推送（ntfy）、Telegram/Discord 等多渠道（Apprise/webhook）
- 常驻守护进程（跨进程去重/合并/静音时段/通知历史/时长统计 minDuration）——方案 B
- macOS/Linux 桌面通知
- 通知点击动作（跳转终端）、终端响铃（terminalSequence）
- Codex API 错误通知（hooks 无 StopFailure 等价事件，上游未出口）
- 修改/干预审批决策（PermissionRequest hook 恒输出空、exit 0）

## 4. 架构设计

### 4.1 总体架构与组件

```
┌─ 安装时 ─────────────────────────────────────────────┐
│ ai-toast-notify install                               │
│  ├─ Claude: ~/.claude/settings.json                   │
│  │   5 事件 × exec form(command+args+async) hook      │
│  ├─ Codex 主路径: ~/.codex/hooks.json（存在即优先）    │
│  │   4 事件 × command-string hook（同步，无 async，   │
│  │   需 /hooks 信任；Interrupt timeout:3）            │
│  ├─ Codex 回退: ~/.codex/config.toml notify（默认    │
│  │   不写入；--legacy-notify 显式启用；他人 notify 跳过）│
│  ├─ 用户配置 ~/.ai-toast-notify/config.json           │
│  └─ await 测试 toast（当场验证链路）                    │
└──────────────────────────────────────────────────────┘
┌─ 运行时（每次事件，无常驻进程）──────────────────────────┐
│ hook 触发 → node cli.js send --claude|--codex          │
│  → 输入获取: argv 末参数 JSON（旧 notify）优先，        │
│     否则读 stdin（Claude/Codex 新 hooks）              │
│  → 识别来源 → 解析归一化 → 过滤 → WinRT toast → 日志    │
│  → exit 0（铁律）                                      │
└──────────────────────────────────────────────────────┘
```

npm 包内模块（单包，TypeScript ESM，零运行时依赖）：

| 模块 | 职责 |
|---|---|
| `src/cli.ts` | 命令入口：`install`/`uninstall`/`send`/`test`；send 流水线；永远 exit 0 |
| `src/input.ts` | stdin 读取（3s 超时）；argv 末参数 JSON 提取 |
| `src/adapters/claude.ts` | Claude hook payload → NotifyEvent（字段名按官方文档修正） |
| `src/adapters/codex.ts` | Codex hooks payload + 旧 notify payload → NotifyEvent |
| `src/adapters/detect.ts` | 来源识别（--claude/--codex 优先，payload 特征嗅探兜底） |
| `src/notify/toast.ts` | spawn PowerShell 调 WinRT；XML 转义；5s 超时 |
| `src/install/claude-config.ts` | settings.json 幂等合并（exec form，只增删自有条目） |
| `src/install/codex-hooks-config.ts` | hooks.json 幂等合并（保留 orca 等第三方条目） |
| `src/install/codex-config.ts` | config.toml 旧 notify 增量修改（根键插到首个 table 前；他人 notify 跳过） |
| `src/config.ts` | 用户配置读写，损坏回退默认 |
| `src/log.ts` | 追加日志，1MB 轮转，永不抛错 |

### 4.2 归一化事件模型

```ts
type EventSource = 'claude-code' | 'codex'
type EventKind = 'done' | 'error' | 'interrupted' | 'needs-input'

interface NotifyEvent {
  source: EventSource
  kind: EventKind
  title: string   // "Claude Code · <目录名>" / "Codex · <目录名>"
  detail?: string // 摘要/错误原因/等待内容
  cwd: string
  filterKey?: 'idlePing' | 'subagentStop'  // send 层按用户配置过滤
}
```

### 4.3 事件映射（数据流）

**Claude Code**（payload 字段以官方文档为准）：

| Hook 事件 | 条件 | → kind | 默认 | 文案/detail |
|---|---|---|---|---|
| `Stop` | `background_tasks`/`session_crons` 均空 | `done` | 开 | `last_assistant_message` 截 80 字，无则"任务完成，等你查看" |
| `Stop` | 后台数组非空 | — | 不发 | 会话未结束，后台任务会唤醒，发"完成"是误报 |
| `StopFailure` | — | `error` | 开 | `出错停止：<error>`，有 `error_details` 则括号附加 |
| `Notification` | `permission_prompt` | `needs-input` | 开 | 等待你批准工具调用 |
| `Notification` | `agent_needs_input` | `needs-input` | 开 | 在等你输入 |
| `Notification` | `idle_prompt`（兼容 idle_ping） | `needs-input` | **关** | 空闲提醒（filterKey=idlePing） |
| `Notification` | **未知类型**（未来新增） | `needs-input` | 开 | 兜底展示 message / 原始 type——权限类事件绝不静默漏报 |
| `PostToolUseFailure` | `is_interrupt===true` | `interrupted` | 开 | 工具以中断方式结束（注意：用户 Esc 取消运行中工具不触发此 hook，README 如实说明） |
| `PostToolUseFailure` | 非中断 | — | 不发 | 普通工具失败由 Claude 自行处理，通知会刷屏 |
| `SubagentStop` | — | `done` | **关** | 子代理完成（filterKey=subagentStop） |

**Codex 新 hooks（~/.codex/hooks.json）**：

| Hook 事件 | 条件 | → kind | 默认 | 文案 |
|---|---|---|---|---|
| `Stop` | `background_tasks`/`session_crons` 均空 | `done` | 开 | `last_assistant_message` 截 80 字（受 `codex.messagePreview` 控制，关闭则固定文案） |
| `Stop` | 后台数组非空 | — | 不发 | 同 Claude 理由 |
| `Interrupt` | — | `interrupted` | 开 | 任务被中断 |
| `PermissionRequest` | — | `needs-input` | 开 | 等待你批准：`<tool_name>`（stdout 恒空、exit 0，不干预审批） |
| `SubagentStop` | — | `done` | **关** | 子代理完成（filterKey=subagentStop） |
| 其他 8 种事件 | — | — | 不挂 | v1 不订阅，防噪音 |

**Codex 旧 notify（回退）**：

| 事件 | → kind | 说明 |
|---|---|---|
| `agent-turn-complete`（argv JSON） | `done` | `last-assistant-message` 截 80 字；`input-messages` 为字符串数组（v1.0 fixture 形态有误，已修正） |

**文案规则**：标题 = 工具名 + ` · ` + cwd basename（多项目并行可区分）；kind 前缀 emoji：✅ done / ❌ error / ⏹ interrupted / 💬 needs-input（ToastGeneric 着色兼容性差，emoji 是低风险等效，README 注明）。

**来源识别**：`--claude` / `--codex` flag 优先（两条安装路径各自写入）；无 flag 嗅探兜底：`type==="agent-turn-complete"` → codex 旧 notify；`hook_event_name === "Interrupt"` → codex（**唯一确认的 Codex 独有事件**；PermissionRequest 两家都有，不作判据，否则 Claude 的 PermissionRequest 会被误标 Codex）；`hook_event_name ∈ {StopFailure, Notification, PostToolUseFailure}` → claude；`Stop`/`SubagentStop`/`PermissionRequest` 两家同名单靠 payload 无法区分 → 需 flag，裸调用记日志静默退出。

### 4.4 安装与配置

**命令格式（关键修正）**：

- Claude（settings.json，exec form——无 shell、无引号地狱、空格路径天然安全、async 不阻塞回合）：
  `{ "type": "command", "command": "<node.exe 绝对路径>", "args": ["<cli.js 绝对路径>", "send", "--claude"], "async": true, "timeout": 10 }`
- Codex hooks.json（单字符串 command，经 cmd /C；**无 async 字段**——`async:true` 会被 Codex 静默跳过）：
  `"<node.exe>" "<cli.js>" send --codex`，handler `{ "type":"command", "command":…, "timeout":10 }`；Interrupt 事件用 `"timeout":3`（官方上限 3s）
- Codex config.toml（回退）：
  `notify = ["<node>", "<cli.js>", "send", "--codex"]`（根键，插在首个 `[table]` 之前）

**`install` 行为**：
1. 定位 `process.execPath` 与自身 cli.js 绝对路径
2. Claude settings.json：读 → 解析（失败中止不写）→ 合并（只追加/替换自有 exec-form 条目）→ 备份 → 写回；幂等
3. Codex 默认路径：**hooks.json 存在 → 合并 4 事件**（保留 orca 等全部第三方条目与 matcher）；**hooks.json 不存在 → 创建仅含自有条目的文件**；默认不触碰 config.toml。仅当 hooks.json 解析失败时提示手动处理，**绝不覆盖他人 notify**
4. Codex legacy 路径：`install --legacy-notify` 先从 hooks.json 移除自有条目（保留第三方、文件不存在则 no-op），再写入 config.toml `notify`；发现他人 notify 则跳过并提示。两条 Codex 路径互斥，避免双重通知
5. 生成默认用户配置（已存在则不动）
6. **await** 测试 toast，当场验证链路
7. 输出提醒：**Codex hook 须在 Codex 内运行 `/hooks` 审查并信任后才会执行**（hash 信任机制；升级后 node/cli 路径变化同样需要重新信任），未信任前 Codex 通知静默不生效

**用户配置** `~/.ai-toast-notify/config.json`：
```json
{
  "events": { "idlePing": false, "subagentStop": false },
  "toast": { "sound": true },
  "codex": { "messagePreview": true }
}
```

`codex.messagePreview` 作用于**两条 Codex 路径**（hooks 与旧 notify）：关闭后完成通知不带回复摘要，只显示固定文案。

**`uninstall`**：按结构特征（args/command 含包名 + send）精确移除自有条目，逐字保留他人配置；清理 hooks.json 与 config.toml 两处；`~/.ai-toast-notify/` 目录保留（含日志）供手动删除。

### 4.5 错误处理

核心原则：**通知工具永远不能干扰宿主工作流**。

- `send`：输入获取（argv → stdin 3s）→ 解析 → toast（5s）全程 try/catch，任何异常记日志 + exit 0；stdout 恒空（Codex PermissionRequest 不会误读为决策）
- 配置损坏 → 内置默认值，不丢通知
- 写配置前备份（`.bak.<时间戳>`）；解析失败中止不写
- 日志 `~/.ai-toast-notify/log.txt` 一行/事件（时间/来源/kind/结果），1MB 轮转，永不抛错
- PowerShell 极端失败 → 记日志，无二级 fallback
- AUMID 归属"Windows PowerShell"：README 排障第一条写明检查系统通知设置中 PowerShell 是否开启

## 5. 测试策略

| 层 | 内容 |
|---|---|
| 单测（vitest） | Claude adapter：真实形态 fixture（Stop 含/不含后台任务、StopFailure `error` 字段、permission/idle_prompt/agent_needs_input/未知类型兜底、is_interrupt、SubagentStop） |
| 单测 | Codex adapter：hooks payload（Stop/Interrupt/PermissionRequest/SubagentStop/后台任务跳过）+ 旧 notify argv payload（`input-messages` 为字符串数组） |
| 单测 | 三个 installer：幂等（跑两遍不变）、空格路径、**保留第三方条目（用本机 orca hooks.json 样本）**、TOML 根键插到首个 table 前、他人 notify 跳过 |
| 单测 | 输入层：stdin 超时/坏 JSON/空、argv 末参数 JSON 提取 |
| mock | `child_process.spawn` 断言 PowerShell 参数与 XML 转义（`& < > " '`、中文、emoji） |
| 手动验收 | 真机 Windows：test → install → 幂等重装 → Claude/Codex 各跑小任务 → 中断/权限场景 → 卸载（详见计划 Task 13） |

## 6. 已知限制（如实写入 README）

1. **Claude Esc 中断不可靠捕获**：用户按 Esc 取消运行中工具不触发 PostToolUseFailure（官方机制，取消走 tool result）；仅 `is_interrupt:true` 的 abort 形态可捕获。Codex 侧 `Interrupt` 事件可正常捕获
2. **Codex API 错误无通知**：Codex hooks 无 StopFailure 等价事件，turn 以 API error 结束不触发 hook（上游 issue #54884）
3. **Codex 旧 notify 大 payload 静默失效**：长会话 `input-messages` 累积超 argv 上限时上游不调用 notify（issue #18309/#34878）；hooks.json 路径不受此影响（stdin）
4. **VSCode 扩展内权限提示可能不触发 Claude Notification hook**（上游 issues #56936/#55875）；终端不受影响
5. **仅 Windows 10/11**；toast 显示在"Windows PowerShell"应用名下，系统设置关闭 PS 通知会全部静默
6. **无跨进程去重**：多窗口同 cwd 短时多次事件会各弹各的（方案 B 演进项）
7. **Codex hook 信任机制**：新增/变更（含升级后路径变化）的 hook 在用户于 Codex 内 `/hooks` 信任前被静默跳过——install 会提示；"Codex 装了没通知"首先查这里
8. **Codex Interrupt 通知可能被 3s 上限截断**：Interrupt hook timeout 上限 3 秒，慢机器上 toast（spawn PowerShell，自身上限 5s）可能未完成即被 Codex 终止——偶发丢中断通知，日志可查

## 7. 未来演进（不在 v1）

- 方案 B 守护进程/状态文件：跨进程去重、合并、静音时段、minDurationSeconds（短任务不打扰，anotifier 已验证价值）
- ntfy / Apprise 多渠道；终端响铃（Claude `terminalSequence`）
- Codex hooks 更多事件（PostToolUse 失败、SessionEnd 等）与 Claude `PermissionRequest`
- macOS/Linux 后端
