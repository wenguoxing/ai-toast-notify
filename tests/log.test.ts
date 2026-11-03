import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLog } from '../src/log.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-log-'))
})

describe('appendLog', () => {
  it('追加一行并带换行', () => {
    appendLog(dir, '2026-11-02T10:00:00Z claude-code done ok')
    const text = readFileSync(join(dir, 'log.txt'), 'utf8')
    expect(text).toBe('2026-11-02T10:00:00Z claude-code done ok\n')
  })

  it('文件超过 1MB 时轮转为 log.txt.old', () => {
    const big = 'x'.repeat(1024 * 1024 + 10)
    writeFileSync(join(dir, 'log.txt'), big)
    appendLog(dir, 'new line')
    expect(existsSync(join(dir, 'log.txt.old'))).toBe(true)
    expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toBe('new line\n')
    expect(statSync(join(dir, 'log.txt.old')).size).toBeGreaterThan(1024 * 1024)
  })

  it('目录不存在等 IO 异常被吞掉不抛错', () => {
    expect(() => appendLog(join(dir, 'no', 'such', 'dir'), 'line')).not.toThrow()
  })
})