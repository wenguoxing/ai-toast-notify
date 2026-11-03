import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, PKG_NAME, type NotifyEvent } from '../src/types.js'

describe('shared types', () => {
  it('DEFAULT_CONFIG 默认关闭噪音事件、开启声音与消息预览', () => {
    expect(DEFAULT_CONFIG.events.idlePing).toBe(false)
    expect(DEFAULT_CONFIG.events.subagentStop).toBe(false)
    expect(DEFAULT_CONFIG.toast.sound).toBe(true)
    expect(DEFAULT_CONFIG.codex.messagePreview).toBe(true)
  })

  it('NotifyEvent 可表达四类 kind', () => {
    const base = { source: 'claude-code' as const, title: 't', cwd: 'c' }
    const kinds: NotifyEvent['kind'][] = ['done', 'error', 'interrupted', 'needs-input']
    for (const kind of kinds) {
      const e: NotifyEvent = { ...base, kind }
      expect(e.kind).toBe(kind)
    }
  })

  it('包名标识正确', () => {
    expect(PKG_NAME).toBe('ai-toast-notify')
  })
})