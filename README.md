# ai-toast-notify

Windows 桌面 toast 通知 CLI：**Claude Code / Codex 任务结束、出错、中断、等待你操作时**，右下角弹 Windows 原生 toast。零运行时 npm 依赖，无需守护进程。

## 安装

> 前置：Windows 10/11、Node.js ≥ 18。Codex 侧以 **codex-cli 0.166.0** 为基线，请先运行 `codex --version` 确认。

```powershell
npm install -g ai-toast-notify
ai-toast-notify install
```

install 会：

1. 写入 Claude Code hooks（`~/.claude/settings.json`，exec form + `async:true`）
2. 写入 Codex hooks（`~/.codex/hooks.json`，`async:true` 主路径；**不触碰** config.toml）
3. 生成用户配置 `~/.ai-toast-notify/config.json`
4. 当场发一条测试 toast

写入前自动创建 `*.bak.<时间戳>` 备份；幂等可重复执行；**逐字保留**已有第三方条目（如 orca）。

### ⚠️ Codex 必须信任一次

install 后请在 **Codex 内运行 `/hooks`**，审查并信任 ai-toast-notify 条目——未信任的 hook 会被静默跳过。信任按 hook 定义 hash 记录：`async`/`timeout`/命令或升级后路径任一变化都需重新信任。

### 旧 notify 回退（可选）

老版本 Codex 无 hooks.json 时可用：

```powershell
ai-toast-notify install --legacy-notify
```

会先从 hooks.json 移除自有条目（避免双通知），再写 `~/.codex/config.toml` 的 `notify` 根键。两条路径互斥；发现他人 notify 则跳过不覆盖。

## 卸载

```powershell
ai-toast-notify uninstall
```

只移除自有条目（按结构识别），他人配置原样保留；`~/.ai-toast-notify/`（配置/日志）保留，可手动删除。

## 事件表

| 来源 | 事件 | 通知 | 默认 |
|---|---|---|---|
| Claude Code | `Stop`（无后台任务） | ✅ 任务完成 + 回复摘要 | 开 |
| Claude Code | `StopFailure` | ❌ 出错停止（`error`/`error_details`） | 开 |
| Claude Code | `Notification` permission_prompt / agent_needs_input | 💬 等待批准 / 等待输入 | 开 |
| Claude Code | `Notification` idle_prompt | 💬 空闲提醒 | **关** |
| Claude Code | `PostToolUseFailure`（`is_interrupt:true`） | ⏹ 工具以中断方式结束 | 开 |
| Claude Code | `SubagentStop` | ✅ 子代理完成 | **关** |
| Codex | `Stop` | ✅ 回合完成 + 回复摘要 | 开 |
| Codex | `Interrupt` | ⏹ 任务被中断 | 开 |
| Codex | `PermissionRequest` | 💬 等待批准（恒不干预审批决策） | 开 |
| Codex | `PostModelRequest` **仅 `status:"failed"`** | ❌ 模型请求失败 | 开 |
| Codex | `PostModelRequest` completed / cancelled | 不通知（防刷屏） | — |
| Codex | `SubagentStop` | ✅ 子代理完成 | **关** |
| Codex（旧 notify） | `agent-turn-complete` | ✅ 回合完成 + 回复摘要 | 可选启用 |

未知 `notification_type` 一律兜底为 💬 needs-input（宁可多响，绝不漏报权限类事件）。

样式：kind 使用 emoji 前缀（✅ done / ❌ error / ⏹ interrupted / 💬 needs-input）；ToastGeneric 着色兼容性差，emoji 是低风险等效。

## 用户配置

`~/.ai-toast-notify/config.json`：

```json
{
  "events": { "idlePing": false, "subagentStop": false },
  "toast": { "sound": true },
  "codex": { "messagePreview": true }
}
```

`codex.messagePreview` 同时作用于 hooks 与旧 notify 两条路径；关闭后完成通知只显示固定文案。

## 接入方式（原理）

- **Claude Code**：exec form（`command` + `args` 数组，无 shell），空格路径天然安全，`async:true` 不阻塞回合。
- **Codex hooks.json**：单字符串 command `node <cli.js> send --codex`——**裸 `node` 名靠 PATH 解析**（codex-cli 0.166.0 Windows 实测：exe 带路径或加引号一律 `hook: Failed`）；cli.js 路径不能含空白，install 检测到空白路径会警告并自动降级到旧 notify。
- **Codex 旧 notify**：payload 追加为 argv 末参数（stdin 为 null），本项目 `send` 自动识别。

## 已知限制（如实告知）

1. **Claude Esc 中断不可靠捕获**：用户按 Esc 取消运行中工具不触发 `PostToolUseFailure`（官方机制，取消走 tool result）；仅 `is_interrupt:true` 的 abort 形态可捕获。Codex `Interrupt` 事件会受到第 8 条硬时限约束。
2. **Codex 模型请求失败以 PostModelRequest 为准**：仅 `status:"failed"` 发通知；completed/cancelled 忽略。同回合多次失败可能多次提醒；该事件每次模型请求都会启动 helper，非 failed 状态在 toast 前直接返回。
3. **Codex 旧 notify 大 payload 静默失效**：长会话 `input-messages` 超 argv 上限时上游不调用 notify（issue #18309/#34878）；hooks.json 路径走 stdin 不受影响。
4. **VSCode 扩展内权限提示可能不触发 Claude Notification hook**（上游 issues #56936/#55875）；终端不受影响。
5. **仅 Windows 10/11**；toast 归属"Windows PowerShell"应用名，系统设置关闭 PS 通知会全部静默。
6. **无跨进程去重**：多窗口同 cwd 短时多次事件各弹各的。
7. **Codex hook 信任机制**：定义变化（含升级后路径变化）后未重新信任会被静默跳过。
8. **Interrupt 通知在本机当前环境必现不可用**：Interrupt async hook 的宿主 timeout 是 1–3 秒硬上限，且 async 不豁免硬杀；本机 PowerShell+WinRT 实测完整耗时 2.6–4.1 秒，interrupted 2500ms 路径 5/5 超时，done 8000ms 路径 3/3 成功。因此该工具不能在这类机器上承诺 Interrupt toast。其余事件宿主上限 10 秒，内部上限 8 秒。
9. **Codex 版本基线**：以 codex-cli 0.166.0 实测为准，旧版行为可能不同。
10. **Codex Windows command 形态限制**：command 首个 token 必须是裸可执行名（靠 PATH）——依赖 `node` 在 PATH；cli.js 路径含空白时 install 会自动降级 legacy notify。卸载按 `send --codex` 调用结构识别，理论上会删除采用完全相同调用约定的第三方工具。
11. **Codex 短会话可能不执行 async hook**：真机复验发现约少于 1000 tokens 的秒回会话中 PostModelRequest async hook 完全未启动，长会话正常；短会话模型失败通知可能丢失。该实验只直接覆盖 PostModelRequest，不应外推为所有事件的完整调度结论。

## 排障

**Codex 装了没通知？按顺序检查：**

1. `codex --version` → 0.166.0 或更新
2. Codex 内运行 `/hooks` → ai-toast-notify 条目是否已**信任**
3. `where node` → 确认 node 在 PATH（command 用裸 `node` 名，缺失则全部 hook Failed）
4. 看 `~/.ai-toast-notify/log.txt`（事件是否到达 send）
5. `ai-toast-notify test` → 直接弹 toast 验证 WinRT 链路
6. 系统设置 → 通知 → **Windows PowerShell** 开启
7. 配置文件旁的 `.bak.*` 备份可随时手动恢复

## 开发

```powershell
npm install
npm test        # 111 个用例
npm run build   # dist/
```

License: MIT