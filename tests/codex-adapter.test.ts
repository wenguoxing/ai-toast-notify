import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseCodexHookEvent, parseCodexLegacyNotify,
  type CodexHookInput, type CodexLegacyInput,
} from '../src/adapters/codex.js'

const fx = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
const previewOn = { messagePreview: true }
const previewOff = { messagePreview: false }

describe('parseCodexHookEvent（hooks.json / stdin JSON）', () => {
  it('Stop → done，detail 用 last_assistant_message', () => {
    const e = parseCodexHookEvent(fx<CodexHookInput>('codex-stop.json'), 'D:\\fb', previewOn)
    expect(e!.kind).toBe('done')
    expect(e!.source).toBe('codex')
    expect(e!.detail).toBe('重构完成，共修改 3 个文件，测试通过。')
    expect(e!.title).toBe('Codex · my-app')
    expect(e!.cwd).toBe('C:\\work\\my-app')
  })

  it('Stop 在 messagePreview:false 时 detail 为固定文案', () => {
    const e = parseCodexHookEvent(fx<CodexHookInput>('codex-stop.json'), 'D:\\fb', previewOff)
    expect(e!.detail).toBe('任务完成，等你查看')
  })

  it('Interrupt → interrupted', () => {
    const e = parseCodexHookEvent(fx<CodexHookInput>('codex-interrupt.json'), 'D:\\fb', previewOn)
    expect(e!.kind).toBe('interrupted')
    expect(e!.detail).toBe('任务被中断')
  })

  it('PermissionRequest → needs-input 且 detail 含 tool_name', () => {
    const e = parseCodexHookEvent(fx<CodexHookInput>('codex-permission-request.json'), 'D:\\fb', previewOn)
    expect(e!.kind).toBe('needs-input')
    expect(e!.detail).toContain('shell')
  })

  it('SubagentStop → done 带 filterKey', () => {
    const e = parseCodexHookEvent(fx<CodexHookInput>('codex-subagent-stop.json'), 'D:\\fb', previewOn)
    expect(e!.kind).toBe('done')
    expect(e!.filterKey).toBe('subagentStop')
  })

  it('PostModelRequest failed → error 且 detail 含 error', () => {
    const e = parseCodexHookEvent(fx<CodexHookInput>('codex-post-model-failed.json'), 'D:\\fb', previewOn)
    expect(e!.kind).toBe('error')
    expect(e!.detail).toContain('rate limit exceeded')
  })

  it('PostModelRequest completed → null', () => {
    const input = { ...fx<CodexHookInput>('codex-post-model-failed.json'), status: 'completed' as const }
    expect(parseCodexHookEvent(input, 'D:\\fb', previewOn)).toBeNull()
  })

  it('PostModelRequest cancelled → null', () => {
    const input = { ...fx<CodexHookInput>('codex-post-model-failed.json'), status: 'cancelled' as const }
    expect(parseCodexHookEvent(input, 'D:\\fb', previewOn)).toBeNull()
  })

  it('cwd 缺失用 fallbackCwd', () => {
    const { cwd: _drop, ...rest } = fx<CodexHookInput>('codex-interrupt.json')
    const e = parseCodexHookEvent(rest, 'D:\\fallback', previewOn)
    expect(e!.cwd).toBe('D:\\fallback')
    expect(e!.title).toBe('Codex · fallback')
  })

  it('未知 hook_event_name（UserPromptSubmit）→ null', () => {
    const input = { ...fx<CodexHookInput>('codex-interrupt.json'), hook_event_name: 'UserPromptSubmit' }
    expect(parseCodexHookEvent(input, 'D:\\fb', previewOn)).toBeNull()
  })
})

describe('parseCodexLegacyNotify（config.toml / argv JSON）', () => {
  it('agent-turn-complete → done 且 detail 截 80 字', () => {
    const base = fx<CodexLegacyInput>('codex-legacy-turn-complete.json')
    const e = parseCodexLegacyNotify({ ...base, 'last-assistant-message': 'b'.repeat(100) }, 'D:\\fb', previewOn)
    expect(e!.kind).toBe('done')
    expect(e!.source).toBe('codex')
    expect(e!.detail).toBe('b'.repeat(80))
  })

  it('messagePreview 关 → 无摘要', () => {
    const e = parseCodexLegacyNotify(fx<CodexLegacyInput>('codex-legacy-turn-complete.json'), 'D:\\fb', previewOff)
    expect(e!.detail).toBe('任务完成，等你查看')
  })

  it('type 非 agent-turn-complete → null', () => {
    const base = fx<CodexLegacyInput>('codex-legacy-turn-complete.json')
    expect(parseCodexLegacyNotify({ ...base, type: 'other' }, 'D:\\fb', previewOn)).toBeNull()
  })

  it('cwd 缺失用 fallbackCwd（v1.3 疏漏删除，v1.4 恢复）', () => {
    const { cwd: _drop, ...rest } = fx<CodexLegacyInput>('codex-legacy-turn-complete.json')
    const e = parseCodexLegacyNotify(rest, 'D:\\legacy-fb', previewOn)
    expect(e!.cwd).toBe('D:\\legacy-fb')
    expect(e!.title).toBe('Codex · legacy-fb')
  })
})