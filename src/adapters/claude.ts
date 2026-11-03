import { basename } from 'node:path'
import type { NotifyEvent } from '../types.js'

export interface ClaudeHookInput {
  hook_event_name?: string
  cwd?: string
  message?: string
  notification_type?: string
  error?: string                    // StopFailure 错误类型（官方字段）
  error_details?: string            // StopFailure 附加详情
  last_assistant_message?: string | null
  stop_hook_active?: boolean
  background_tasks?: unknown[]      // Stop：非空 = 后台工作未结束
  session_crons?: unknown[]         // Stop：非空 = 有定时唤醒
  agent_id?: string                 // SubagentStop 存在
  is_interrupt?: boolean
  [k: string]: unknown
}

const PREVIEW_LEN = 80

function trim(s?: string | null): string | undefined {
  if (typeof s !== 'string' || !s.trim()) return undefined
  return s.trim().length > PREVIEW_LEN ? s.trim().slice(0, PREVIEW_LEN) : s.trim()
}

function backgroundWork(input: ClaudeHookInput): boolean {
  return (Array.isArray(input.background_tasks) && input.background_tasks.length > 0)
    || (Array.isArray(input.session_crons) && input.session_crons.length > 0)
}

export function parseClaudeEvent(input: ClaudeHookInput): NotifyEvent | null {
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  const title = `Claude Code · ${cwd ? basename(cwd) : '未知目录'}`

  switch (input.hook_event_name) {
    case 'Stop':
      if (backgroundWork(input)) return null
      return { source: 'claude-code', kind: 'done', title, cwd,
               detail: trim(input.last_assistant_message) ?? '任务完成，等你查看' }

    case 'SubagentStop':
      return { source: 'claude-code', kind: 'done', title, cwd,
               detail: trim(input.last_assistant_message) ?? '子代理任务完成', filterKey: 'subagentStop' }

    case 'StopFailure':
      return { source: 'claude-code', kind: 'error', title, cwd,
               detail: `出错停止：${input.error ?? '未知原因'}${input.error_details ? `（${input.error_details}）` : ''}` }

    case 'PostToolUseFailure':
      // 官方：用户取消运行中的工具不触发此 hook；is_interrupt=true 仅覆盖 abort 形态
      if (input.is_interrupt !== true) return null
      return { source: 'claude-code', kind: 'interrupted', title, cwd, detail: '工具以中断方式结束' }

    case 'Notification': {
      const type = input.notification_type
      const message = input.message ?? ''
      if (type === 'permission_prompt' || (!type && /permission/i.test(message)))
        return { source: 'claude-code', kind: 'needs-input', title, cwd, detail: '等待你批准工具调用' }
      // Legacy idle text can also contain waiting-for-input; classify idle first
      // so the configurable idlePing filter cannot be bypassed.
      if (type === 'idle_prompt' || type === 'idle_ping' || (!type && /idle/i.test(message)))
        return { source: 'claude-code', kind: 'needs-input', title, cwd, detail: '空闲提醒', filterKey: 'idlePing' }
      if (type === 'agent_needs_input' || (!type && /waiting for your input/i.test(message)))
        return { source: 'claude-code', kind: 'needs-input', title, cwd, detail: '在等你输入' }
      // 未知类型兜底 needs-input：Claude 未来新增权限类事件绝不静默漏报（anotifier 同策略）
      return { source: 'claude-code', kind: 'needs-input', title, cwd,
               detail: trim(message) ?? `Claude 通知（${type ?? '未知类型'}）` }
    }

    default:
      return null
  }
}