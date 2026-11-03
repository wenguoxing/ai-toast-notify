import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CLAUDE_HOOK_EVENTS } from './events.js'

export { CLAUDE_HOOK_EVENTS }

interface HookEntry {
  type?: string
  command?: string
  args?: string[]
  [k: string]: unknown
}
interface HookGroup { matcher?: string; hooks: HookEntry[] }
type HooksMap = Record<string, HookGroup[]>

export function buildClaudeHookEntry(nodePath: string, cliJsPath: string): HookEntry {
  return {
    type: 'command',
    command: nodePath,                      // exec form：裸 node.exe 绝对路径，无 shell、无引号问题
    args: [cliJsPath, 'send', '--claude'],  // 逐元素传递，空格路径天然安全
    async: true,                            // Claude 支持 async，不阻塞回合
    timeout: 10,
  }
}

/** 按结构识别自有 hook：args 末尾恰为 ['send','--claude']。
 * 不依赖安装路径含包名（npm link 指向任意目录名也能识别/卸载/幂等，Task 13 真机验收修订）。 */
export function isAiNotifyClaudeHook(h: unknown): boolean {
  if (typeof h !== 'object' || h === null) return false
  const e = h as HookEntry
  if (e.type !== 'command' || !Array.isArray(e.args) || e.args.length < 3) return false
  const a = e.args as unknown[]
  return a[a.length - 2] === 'send' && a[a.length - 1] === '--claude'
}

export function mergeClaudeHooks(
  settings: Record<string, unknown>,
  nodePath: string,
  cliJsPath: string,
): Record<string, unknown> {
  const out = structuredClone(settings)
  const hooks = (out.hooks ?? {}) as HooksMap
  const entry = buildClaudeHookEntry(nodePath, cliJsPath)
  for (const ev of CLAUDE_HOOK_EVENTS) {
    const groups = (hooks[ev] ?? []) as HookGroup[]
    // 先剔除旧的自有条目（升级换路径场景），再追加新组
    for (const g of groups) g.hooks = g.hooks.filter((h) => !isAiNotifyClaudeHook(h))
    const cleaned = groups.filter((g) => g.hooks.length > 0)
    cleaned.push({ matcher: '', hooks: [entry] })
    hooks[ev] = cleaned
  }
  out.hooks = hooks
  return out
}

export function removeClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(settings)
  const hooks = out.hooks as HooksMap | undefined
  if (!hooks) return out
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev] ?? []
    for (const g of groups) g.hooks = g.hooks.filter((h) => !isAiNotifyClaudeHook(h))
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

export function installClaudeConfig(settingsPath: string, nodePath: string, cliJsPath: string): void {
  let settings: Record<string, unknown>
  try {
    settings = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
      : {}
  } catch (err) {
    throw new Error(`settings.json 解析失败，拒绝写入：${settingsPath}（${(err as Error).message}）`)
  }
  const merged = mergeClaudeHooks(settings, nodePath, cliJsPath)
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak.${backupSuffix()}`)
  mkdirSync(dirname(settingsPath), { recursive: true }) // 全新机器 ~/.claude 可能不存在
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n')
}

export function uninstallClaudeConfig(settingsPath: string): void {
  if (!existsSync(settingsPath)) return
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`settings.json 解析失败，拒绝写入：${settingsPath}（${(err as Error).message}）`)
  }
  const cleaned = removeClaudeHooks(settings)
  copyFileSync(settingsPath, `${settingsPath}.bak.${backupSuffix()}`)
  writeFileSync(settingsPath, JSON.stringify(cleaned, null, 2) + '\n')
}