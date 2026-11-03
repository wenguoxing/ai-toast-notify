import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PKG_NAME } from '../types.js'

const NOTIFY_LINE = /^notify\s*=\s*\[[^\[\]\n]*\]\s*$/m // [^...] 不含换行：多行数组形态不匹配 → 走下方抛错分支

export function buildNotifyValue(nodePath: string, cliJsPath: string): string[] {
  return [nodePath, cliJsPath, 'send', '--codex']
}

/** 基本字符串转义：TOML 双引号字符串中的反斜杠与双引号 */
export function toTomlArray(items: string[]): string {
  const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `[${items.map((i) => `"${esc(i)}"`).join(', ')}]`
}

export function mergeCodexNotify(
  tomlText: string, nodePath: string, cliJsPath: string,
): { text: string; skipped: boolean } {
  const line = `notify = ${toTomlArray(buildNotifyValue(nodePath, cliJsPath))}`
  const m = tomlText.match(NOTIFY_LINE)
  if (m) {
    if (m[0].includes(PKG_NAME)) return { text: tomlText.replace(NOTIFY_LINE, line), skipped: false } // 自有 → 替换
    return { text: tomlText, skipped: true }                                            // 他人 → 跳过不覆盖
  }
  if (/^notify\s*=/m.test(tomlText))
    throw new Error('config.toml 已有 notify 键但不是可识别的单行数组形态，请手动处理')

  const tableIdx = tomlText.search(/^\s*\[/m) // 首个 [table]：根键必须插在它之前
  if (tableIdx === -1) {
    const base = tomlText.replace(/\s*$/, '')
    return { text: base ? `${base}\n${line}\n` : `${line}\n`, skipped: false }
  }
  const head = tomlText.slice(0, tableIdx).replace(/\s*$/, '')
  const tail = tomlText.slice(tableIdx)
  return { text: `${head}\n${line}\n\n${tail}`, skipped: false }
}

/** 仅当 notify 行含本包名才删除；他人 notify 原样保留 */
export function removeCodexNotify(tomlText: string): string {
  const m = tomlText.match(NOTIFY_LINE)
  if (m && m[0].includes(PKG_NAME)) return tomlText.replace(NOTIFY_LINE, '')
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