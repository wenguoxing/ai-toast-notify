#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseClaudeEvent, type ClaudeHookInput } from './adapters/claude.js'
import {
  parseCodexHookEvent, parseCodexLegacyNotify,
  type CodexHookInput, type CodexLegacyInput,
} from './adapters/codex.js'
import { detectSource } from './adapters/detect.js'
import { extractArgvJson, readStdin, STDIN_TIMEOUT_MS } from './input.js'
import { appendLog } from './log.js'
import { loadConfig, saveConfig } from './config.js'
import { sendToast } from './notify/toast.js'
import { installClaudeConfig, uninstallClaudeConfig } from './install/claude-config.js'
import {
  installCodexHooksConfig, uninstallCodexHooksConfig, isCodexHooksPathSupported,
} from './install/codex-hooks-config.js'
import { installCodexConfig, uninstallCodexConfig } from './install/codex-config.js'
import { DEFAULT_CONFIG, type NotifyEvent, type UserConfig } from './types.js'

// ---------- 路径常量（调用时求值，测试可注入临时 HOME/USERPROFILE） ----------

function home(): string {
  return process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
}
export function dataDir(): string { return join(home(), '.ai-toast-notify') }
export function configPath(): string { return join(dataDir(), 'config.json') }
export function claudeSettingsPath(): string { return join(home(), '.claude', 'settings.json') }
export function codexHooksPath(): string { return join(home(), '.codex', 'hooks.json') }
export function codexConfigPath(): string { return join(home(), '.codex', 'config.toml') }
export function cliJsPath(): string { return fileURLToPath(new URL('./cli.js', import.meta.url)) }

// ---------- send 流水线 ----------

export interface SendDeps {
  logDir: string
  cwd?: string
  readStdin(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string>
  loadConfig(path: string): UserConfig
  sendToast(event: NotifyEvent, opts: { sound: boolean }): Promise<void>
  appendLog(dir: string, line: string): void
}

function defaultSendDeps(): SendDeps {
  return {
    logDir: dataDir(),
    cwd: process.cwd(),
    readStdin,
    loadConfig,
    sendToast,
    appendLog,
  }
}

export async function runSend(argv: string[], deps: SendDeps): Promise<void> {
  const log = (msg: string) => deps.appendLog(deps.logDir, `${new Date().toISOString()} ${msg}`)
  try {
    const rawArgv = extractArgvJson(argv)
    const raw = rawArgv ?? await deps.readStdin(process.stdin, STDIN_TIMEOUT_MS)
    if (!raw.trim()) { log('send: empty input, ignore'); return }
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { log('send: invalid json, ignore'); return }

    const cfg = deps.loadConfig(configPath())
    const source = detectSource(argv, payload)
    if (!source) { log('send: source not detected, ignore'); return }

    let event: NotifyEvent | null = null
    if (source === 'claude-code') {
      event = parseClaudeEvent(payload as ClaudeHookInput)
    } else if (payload && (payload as CodexLegacyInput).type === 'agent-turn-complete') {
      event = parseCodexLegacyNotify(payload as CodexLegacyInput, deps.cwd ?? process.cwd(),
        { messagePreview: cfg.codex.messagePreview })
    } else {
      event = parseCodexHookEvent(payload as CodexHookInput, deps.cwd ?? process.cwd(),
        { messagePreview: cfg.codex.messagePreview })
    }
    if (!event) { log(`send: ${source} event not notifiable, ignore`); return }
    if (event.filterKey && !cfg.events[event.filterKey]) { log(`send: ${event.filterKey} off, drop`); return }

    await deps.sendToast(event, { sound: cfg.toast.sound })
    log(`send: ${event.source} ${event.kind} toast ok`)
  } catch (err) {
    log(`send: FAILED ${(err as Error).message}`)
  }
}

// ---------- install / uninstall / test ----------

export async function runInstall(options: { legacyNotify?: boolean; cliJsPath?: string } = {}): Promise<void> {
  const requestedLegacyNotify = options.legacyNotify === true
  const node = process.execPath
  const cli = options.cliJsPath ?? cliJsPath()
  const legacyNotify = requestedLegacyNotify || !isCodexHooksPathSupported(cli)
  if (!requestedLegacyNotify && legacyNotify) {
    console.warn('\u26a0 cli.js \u8def\u5f84\u5305\u542b\u7a7a\u767d\u5b57\u7b26\uff0cCodex hooks command \u4f1a\u5931\u8d25\uff1b\u5df2\u964d\u7ea7\u5199\u5165 config.toml legacy notify\uff1a' + cli)
  }
  installClaudeConfig(claudeSettingsPath(), node, cli)
  console.log(`✓ Claude Code hooks 已写入 ${claudeSettingsPath()}（exec form + async）`)

  if (legacyNotify) {
    // 先移除自有 hooks，避免与 config.toml notify 双通知；卸载逻辑保留 orca 等第三方条目，文件不存在 no-op
    uninstallCodexHooksConfig(codexHooksPath())
    const { skipped } = installCodexConfig(codexConfigPath(), node, cli)
    console.log(skipped ? '⚠ Codex config.toml 已有他人 notify，已跳过，未覆盖' : `✓ Codex legacy notify 已写入 ${codexConfigPath()}`)
  } else {
    installCodexHooksConfig(codexHooksPath(), cli)
    console.log(`✓ Codex hooks 已写入 ${codexHooksPath()}（Stop/Interrupt/PermissionRequest/PostModelRequest/SubagentStop，async）`)
    console.log('⚠ Codex 需信任：请在 Codex 内运行 /hooks 审查并信任 ai-toast-notify 条目（未信任的 hook 会被静默跳过；async/timeout/命令或升级后路径变化都会改变定义，需重新信任）')
  }

  if (!existsSync(configPath())) saveConfig(configPath(), DEFAULT_CONFIG)
  console.log(`✓ 用户配置 ${configPath()}`)

  try {
    await sendToast({ source: 'claude-code', kind: 'done', title: 'ai-toast-notify',
      detail: '安装成功！这条通知就是它发的 🎉', cwd: process.cwd() }, { sound: true })
    console.log('✓ 测试通知已发送，请看屏幕右下角')
  } catch (err) {
    console.error(`✗ 测试通知失败：${(err as Error).message}（检查 Windows 通知设置，尤其是 Windows PowerShell）`)
  }
}

export async function runUninstall(): Promise<void> {
  // 三个 uninstall 均为"解析失败抛错不写"，由 main() 顶层 try/catch 统一捕获打印
  uninstallClaudeConfig(claudeSettingsPath())
  console.log(`✓ Claude Code hooks 已清理（${claudeSettingsPath()}）`)
  uninstallCodexHooksConfig(codexHooksPath())
  console.log(`✓ Codex hooks 已清理（${codexHooksPath()}，第三方条目保留）`)
  uninstallCodexConfig(codexConfigPath())
  console.log(`✓ Codex config.toml notify 已清理（${codexConfigPath()}）`)
  console.log(`ℹ 数据目录 ${dataDir()}（配置/日志）保留，可手动删除`)
}

export async function runTest(): Promise<void> {
  try {
    await sendToast({ source: 'claude-code', kind: 'done', title: 'ai-toast-notify',
      detail: '测试通知：链路正常 ✅', cwd: process.cwd() }, { sound: true })
    console.log('✓ 测试通知已发送，请看屏幕右下角')
  } catch (err) {
    console.error(`✗ 测试通知失败：${(err as Error).message}（检查 Windows 通知设置，尤其是 Windows PowerShell）`)
    process.exitCode = 1
  }
}

// ---------- 入口 ----------

function printUsage(): void {
  console.log('用法：ai-toast-notify install [--legacy-notify] | uninstall | test | send [--claude|--codex]')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  try {
    switch (cmd) {
      case 'install':
        await runInstall({ legacyNotify: argv.includes('--legacy-notify') })
        return
      case 'uninstall':
        await runUninstall()
        return
      case 'test':
        await runTest()
        return
      case 'send':
        // send 铁律：任何情况 exit 0（runSend 自身永不抛错）
        await runSend(argv, defaultSendDeps())
        process.exit(0)
        return
      default:
        printUsage()
        process.exitCode = 1
    }
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`)
    process.exitCode = 1
  }
}

// 直接执行守卫（npm bin / node dist/cli.js 时运行 main；被 import 时不运行）。
// npm link 下 argv[1] 是符号链接路径，而 Node 模块解析会 realpath import.meta.url，必须两侧都 realpath 再比对。
function isDirectRun(): boolean {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isDirectRun()) void main()