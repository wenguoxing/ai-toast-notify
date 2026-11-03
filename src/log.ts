import { appendFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 1024 * 1024

/** 追加一行日志；任何 IO 异常吞掉（日志永远不能影响主流程）。 */
export function appendLog(dir: string, line: string): void {
  const file = join(dir, 'log.txt')
  try {
    mkdirSync(dir, { recursive: true }) // Keep log evidence even before install creates the data directory
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      const old = join(dir, 'log.txt.old')
      if (existsSync(old)) rmSync(old) // Windows 上 renameSync 目标已存在会报错，先删旧 .old
      renameSync(file, old)
    }
    appendFileSync(file, line + '\n')
  } catch {
    /* 日志失败静默 */
  }
}