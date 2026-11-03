import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { readStdin, extractArgvJson, STDIN_TIMEOUT_MS } from '../src/input.js'

describe('readStdin', () => {
  it('stdin 正常读完', async () => {
    const s = new PassThrough()
    s.write('{"hook_event_name":"Stop"}')
    s.end()
    await expect(readStdin(s, 1000)).resolves.toBe('{"hook_event_name":"Stop"}')
    expect(s.listenerCount('data')).toBe(0) // 移除全部监听器
  })

  it('空 stdin → 空串', async () => {
    const s = new PassThrough()
    s.end()
    await expect(readStdin(s, 1000)).resolves.toBe('')
  })

  it('超时永不关闭（50ms 返回已读部分）', async () => {
    const s = new PassThrough()
    s.write('partial-data')
    const start = Date.now()
    await expect(readStdin(s, 50)).resolves.toBe('partial-data')
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
  })

  it('STDIN_TIMEOUT_MS 为 3000', () => {
    expect(STDIN_TIMEOUT_MS).toBe(3000)
  })
})

describe('extractArgvJson', () => {
  it('Codex 旧 notify 形态：末参数 JSON → 返回该串', () => {
    const argv = ['node', 'cli.js', 'send', '--codex', '{"type":"agent-turn-complete"}']
    expect(extractArgvJson(argv)).toBe('{"type":"agent-turn-complete"}')
  })

  it('无 JSON 参数 → null；坏 JSON 参数 → 跳过继续向前找', () => {
    expect(extractArgvJson(['node', 'cli.js', 'send', '--codex'])).toBeNull()
    expect(extractArgvJson(['node', 'cli.js', 'send', '--codex', 'not json'])).toBeNull()
    expect(extractArgvJson(['node', 'cli.js', 'send', '--codex', 'bad', '{"ok":1}'])).toBe('{"ok":1}')
  })

  it('尾参数是 send（非 JSON）→ null；--flag 参数被跳过', () => {
    expect(extractArgvJson(['node', 'cli.js', 'send'])).toBeNull()
    expect(extractArgvJson(['send', '--codex', '--claude'])).toBeNull()
  })
})