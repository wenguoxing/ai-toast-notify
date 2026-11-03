import { describe, it, expect } from 'vitest'
import { detectSource } from '../src/adapters/detect.js'

describe('detectSource', () => {
  it('--claude flag 优先于一切', () => {
    expect(detectSource(['send', '--claude'], { hook_event_name: 'Interrupt' })).toBe('claude-code')
  })

  it('--codex flag 优先于一切', () => {
    expect(detectSource(['send', '--codex'], { hook_event_name: 'StopFailure' })).toBe('codex')
  })

  it('payload type === agent-turn-complete → codex（legacy）', () => {
    expect(detectSource(['send'], { type: 'agent-turn-complete' })).toBe('codex')
  })

  it('hook_event_name === Interrupt 或 PostModelRequest → codex（Codex 独有事件）', () => {
    expect(detectSource(['send'], { hook_event_name: 'Interrupt' })).toBe('codex')
    expect(detectSource(['send'], { hook_event_name: 'PostModelRequest' })).toBe('codex')
  })

  it('hook_event_name ∈ {StopFailure, Notification, PostToolUseFailure} → claude-code（Claude 独有事件）', () => {
    expect(detectSource(['send'], { hook_event_name: 'StopFailure' })).toBe('claude-code')
    expect(detectSource(['send'], { hook_event_name: 'Notification' })).toBe('claude-code')
    expect(detectSource(['send'], { hook_event_name: 'PostToolUseFailure' })).toBe('claude-code')
  })

  it('PermissionRequest 两家都有 → 单靠 payload 返回 null', () => {
    expect(detectSource(['send'], { hook_event_name: 'PermissionRequest' })).toBeNull()
  })

  it('Stop/SubagentStop 两家同名 → null（需 flag，裸调用记日志）', () => {
    expect(detectSource(['send'], { hook_event_name: 'Stop' })).toBeNull()
    expect(detectSource(['send'], { hook_event_name: 'SubagentStop' })).toBeNull()
  })

  it('非 object / 无法识别 → null', () => {
    expect(detectSource(['send'], null)).toBeNull()
    expect(detectSource(['send'], 'str')).toBeNull()
    expect(detectSource(['send'], { foo: 1 })).toBeNull()
  })
})