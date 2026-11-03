import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseClaudeEvent, type ClaudeHookInput } from '../src/adapters/claude.js'

const fx = (name: string): ClaudeHookInput =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))

describe('parseClaudeEvent', () => {
  it('Stop 无后台任务 → done，detail 用 last_assistant_message', () => {
    const e = parseClaudeEvent(fx('claude-stop.json'))
    expect(e).not.toBeNull()
    expect(e!.kind).toBe('done')
    expect(e!.source).toBe('claude-code')
    expect(e!.detail).toBe('重构完成，3 个文件已更新，测试全部通过。')
    expect(e!.cwd).toBe('C:\\Users\\u\\proj')
    expect(e!.title).toBe('Claude Code · proj')
  })

  it('Stop detail 超 80 字截断', () => {
    const e = parseClaudeEvent({ ...fx('claude-stop.json'), last_assistant_message: 'a'.repeat(100) })
    expect(e!.detail).toBe('a'.repeat(80))
  })

  it('Stop background_tasks 非空 → null（后台任务会唤醒，发完成是误报）', () => {
    expect(parseClaudeEvent(fx('claude-stop-background.json'))).toBeNull()
  })

  it('Stop session_crons 非空 → null', () => {
    const input: ClaudeHookInput = {
      ...fx('claude-stop.json'),
      background_tasks: [],
      session_crons: [{ id: 'cron-1', schedule: '*/5 * * * *' }],
    }
    expect(parseClaudeEvent(input)).toBeNull()
  })

  it('StopFailure → error，detail 含 error 与 error_details（官方字段，非 failure_reason）', () => {
    const e = parseClaudeEvent(fx('claude-stop-failure.json'))
    expect(e!.kind).toBe('error')
    expect(e!.detail).toContain('rate_limit')
    expect(e!.detail).toContain('429')
  })

  it('Notification permission_prompt → needs-input', () => {
    const e = parseClaudeEvent(fx('claude-notification-permission.json'))
    expect(e!.kind).toBe('needs-input')
    expect(e!.detail).toBe('等待你批准工具调用')
  })

  it('Notification 无 type 按 message 嗅探 waiting for your input → needs-input', () => {
    const { notification_type: _drop, ...rest } = fx('claude-notification-input.json')
    const e = parseClaudeEvent(rest)
    expect(e!.kind).toBe('needs-input')
    expect(e!.detail).toBe('在等你输入')
  })

  it('Notification idle_prompt → filterKey=idlePing（由 send 层按配置丢弃）', () => {
    const e = parseClaudeEvent(fx('claude-notification-idle.json'))
    expect(e!.kind).toBe('needs-input')
    expect(e!.filterKey).toBe('idlePing')
    expect(e!.detail).toBe('空闲提醒')
  })

  it('Notification 未知类型 some_future_type → 兜底 needs-input（不静默漏报）', () => {
    const e = parseClaudeEvent(fx('claude-notification-unknown.json'))
    expect(e!.kind).toBe('needs-input')
    expect(e!.detail).toContain('Claude needs something new')
  })

  it('PostToolUseFailure is_interrupt=true → interrupted', () => {
    const e = parseClaudeEvent(fx('claude-post-tool-failure-interrupt.json'))
    expect(e!.kind).toBe('interrupted')
    expect(e!.detail).toBe('工具以中断方式结束')
  })

  it('PostToolUseFailure 非中断 → null（普通工具失败不刷屏）', () => {
    const input: ClaudeHookInput = { ...fx('claude-post-tool-failure-interrupt.json'), is_interrupt: false }
    expect(parseClaudeEvent(input)).toBeNull()
  })

  it('SubagentStop → done 带 filterKey=subagentStop；未知事件（PreCompact）→ null', () => {
    const stop = parseClaudeEvent({
      ...fx('claude-stop.json'), hook_event_name: 'SubagentStop', agent_id: 'sub-1',
    })
    expect(stop!.kind).toBe('done')
    expect(stop!.filterKey).toBe('subagentStop')
    expect(parseClaudeEvent({ ...fx('claude-stop.json'), hook_event_name: 'PreCompact' })).toBeNull()
  })
})