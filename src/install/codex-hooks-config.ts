import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PKG_NAME } from '../types.js'

/** 我们挂接的 Codex hook 事件（spec 4.3；SessionEnd 不订阅） */
export const CODEX_HOOK_EVENTS = ['Stop', 'Interrupt', 'PermissionRequest', 'PostModelRequest', 'SubagentStop'] as const

interface HookEntry {
  type?: string
  command?: string
  [k: string]: unknown
}
interface HookGroup { matcher?: string; hooks: HookEntry[] }
type HooksMap = Record<string, HookGroup[]>

/** 0.166.0 Windows 实测：首个 token 必须是裸可执行名（node 靠 PATH），路径不加引号、须无空格 */
export function buildCodexCommand(cliJsPath: string): string {
  return `node ${cliJsPath} send --codex`
}

export function buildCodexHookEntry(cliJsPath: string, event: string): HookEntry {
  return {
    type: 'command',
    command: buildCodexCommand(cliJsPath),
    async: true, // 0.166.0 支持 async command hooks（SessionEnd 例外，本项目不订阅）
    timeout: event === 'Interrupt' ? 3 : 10, // Interrupt 官方上限 1–3 秒
  }
}

/** 按结构识别自有 hook：command 含包名与 'send --codex'（路径升级 / sync→async 定义变化也能识别） */
export function isAiNotifyCodexHook(h: unknown): boolean {
  if (typeof h !== 'object' || h === null) return false
  const e = h as HookEntry
  return e.type === 'command'
    && typeof e.command === 'string'
    && e.command.includes(PKG_NAME)
    && e.command.includes('send --codex')
}

export function mergeCodexHooks(
  file: Record<string, unknown>,
  cliJsPath: string,
): Record<string, unknown> {
  const out = structuredClone(file)
  const hooks = (out.hooks ?? {}) as HooksMap
  for (const ev of CODEX_HOOK_EVENTS) {
    const groups = (hooks[ev] ?? []) as HookGroup[]
    // 先剔除旧的自有条目（升级换路径 / sync→async 定义变化），再追加新组
    for (const g of groups) g.hooks = g.hooks.filter((h) => !isAiNotifyCodexHook(h))
    const cleaned = groups.filter((g) => g.hooks.length > 0)
    cleaned.push({ hooks: [buildCodexHookEntry(cliJsPath, ev)] })
    hooks[ev] = cleaned
  }
  out.hooks = hooks
  return out
}

export function removeCodexHooks(file: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(file)
  const hooks = out.hooks as HooksMap | undefined
  if (!hooks) return out
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev] ?? []
    for (const g of groups) g.hooks = g.hooks.filter((h) => !isAiNotifyCodexHook(h))
    const cleaned = groups.filter((g) => g.hooks.length > 0)
    if (cleaned.length > 0) hooks[ev] = cleaned
    else delete hooks[ev]
  }
  if (Object.keys(hooks).length === 0) delete out.hooks
  return out
}

/** 时间戳备份后缀（YYYYMMDD-HHmmss）。 */
function backupSuffix(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function installCodexHooksConfig(path: string, cliJsPath: string): void {
  let file: Record<string, unknown>
  try {
    file = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {}
  } catch (err) {
    throw new Error(`hooks.json 解析失败，拒绝写入：${path}（${(err as Error).message}）`)
  }
  const merged = mergeCodexHooks(file, cliJsPath)
  if (existsSync(path)) copyFileSync(path, `${path}.bak.${backupSuffix()}`)
  mkdirSync(dirname(path), { recursive: true }) // 全新机器 ~/.codex 可能不存在
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n')
}

export function uninstallCodexHooksConfig(path: string): void {
  if (!existsSync(path)) return
  let file: Record<string, unknown>
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`hooks.json 解析失败，拒绝写入：${path}（${(err as Error).message}）`)
  }
  const cleaned = removeCodexHooks(file)
  copyFileSync(path, `${path}.bak.${backupSuffix()}`)
  writeFileSync(path, JSON.stringify(cleaned, null, 2) + '\n')
}