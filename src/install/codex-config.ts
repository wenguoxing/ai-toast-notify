import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Only a notify key in the root region (before the first table) may be changed.
// The lookahead keeps the line ending out of the match so replacement/removal
// can preserve surrounding formatting and never touch table-level notify keys.
const ROOT_NOTIFY_LINE = /^[ \t]*notify\s*=\s*\[[^\][\r\n]*\][ \t]*(?=\r?\n|$)/m
const MALFORMED_ROOT_NOTIFY = /^[ \t]*notify\s*=/m
const ROOT_TABLE = /^[ \t]*\[/m
// Exact tail anchoring distinguishes this tool's generated command from a
// third-party relay that merely forwards send --codex among other arguments.
const OWN_NOTIFY_TAIL = /"send",\s*"--codex"\s*\]\s*$/

export function buildNotifyValue(nodePath: string, cliJsPath: string): string[] {
  return [nodePath, cliJsPath, 'send', '--codex']
}

/** Minimal TOML double-quote escaping for backslashes and quotes. */
export function toTomlArray(items: string[]): string {
  const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `[${items.map((i) => `"${esc(i)}"`).join(', ')}]`
}

function splitRootRegion(tomlText: string): { root: string; tail: string; tableIdx: number } {
  const tableIdx = tomlText.search(ROOT_TABLE)
  if (tableIdx === -1) return { root: tomlText, tail: '', tableIdx }
  return { root: tomlText.slice(0, tableIdx), tail: tomlText.slice(tableIdx), tableIdx }
}

/** Own notify entries are identified by their exact send --codex tail. */
function isAiNotifyNotifyLine(line: string): boolean {
  return OWN_NOTIFY_TAIL.test(line)
}

function replaceRootNotify(
  tomlText: string, match: RegExpMatchArray, line: string,
): string {
  const indent = match[0].match(/^[ \t]*/)?.[0] ?? ''
  return tomlText.slice(0, match.index)
    + indent + line
    + tomlText.slice((match.index ?? 0) + match[0].length)
}

function removeRootNotify(tomlText: string, match: RegExpMatchArray): string {
  const end = (match.index ?? 0) + match[0].length
  const after = tomlText.slice(end)
  const consumedNewline = after.match(/^\r?\n/)?.[0] ?? ''
  return tomlText.slice(0, match.index) + after.slice(consumedNewline.length)
}

export function mergeCodexNotify(
  tomlText: string, nodePath: string, cliJsPath: string,
): { text: string; skipped: boolean } {
  const line = `notify = ${toTomlArray(buildNotifyValue(nodePath, cliJsPath))}`
  const { root, tail, tableIdx } = splitRootRegion(tomlText)
  const m = root.match(ROOT_NOTIFY_LINE)
  if (m) {
    if (isAiNotifyNotifyLine(m[0])) return { text: replaceRootNotify(tomlText, m, line), skipped: false }
    return { text: tomlText, skipped: true }
  }
  if (MALFORMED_ROOT_NOTIFY.test(root))
    throw new Error('config.toml 已有 notify 键但不是可识别的单行数组形态，请手动处理')

  if (tableIdx === -1) {
    const base = tomlText.replace(/\s*$/, '')
    return { text: base ? `${base}\n${line}\n` : `${line}\n`, skipped: false }
  }
  const head = root.replace(/\s*$/, '')
  return { text: `${head}\n${line}\n\n${tail}`, skipped: false }
}

export function removeCodexNotify(tomlText: string): string {
  const { root } = splitRootRegion(tomlText)
  const m = root.match(ROOT_NOTIFY_LINE)
  if (m && isAiNotifyNotifyLine(m[0])) return removeRootNotify(tomlText, m)
  return tomlText
}

/** 时间戳备份后缀（YYYYMMDD-HHmmss）。 */
function backupSuffix(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function installCodexConfig(
  path: string, nodePath: string, cliJsPath: string,
): { skipped: boolean } {
  const tomlText = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const { text, skipped } = mergeCodexNotify(tomlText, nodePath, cliJsPath)
  if (skipped) return { skipped: true } // 他人 notify：不写、不备份
  if (existsSync(path)) copyFileSync(path, `${path}.bak.${backupSuffix()}`)
  mkdirSync(dirname(path), { recursive: true }) // 全新机器 ~/.codex 可能不存在
  writeFileSync(path, text)
  return { skipped: false }
}

export function uninstallCodexConfig(path: string): void {
  if (!existsSync(path)) return
  const tomlText = readFileSync(path, 'utf8')
  const cleaned = removeCodexNotify(tomlText)
  if (cleaned === tomlText) return // 没有自有 notify（或他人条目）→ 不动文件
  copyFileSync(path, `${path}.bak.${backupSuffix()}`)
  writeFileSync(path, cleaned)
}