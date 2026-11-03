import { basename } from 'node:path'
import type { NotifyEvent } from '../types.js'

export interface CodexHookInput {
  hook_event_name?: string
  cwd?: string
  last_assistant_message?: string | null
  tool_name?: string
  status?: 'completed' | 'failed' | 'cancelled'
  error?: string | null
  agent_id?: string
  [k: string]: unknown
}

export interface CodexLegacyInput {
  type?: string
  cwd?: string
  'last-assistant-message'?: string
  [k: string]: unknown
}

const PREVIEW_LEN = 80

function trim(s?: string | null): string | undefined {
  if (typeof s !== 'string' || !s.trim()) return undefined
  return s.trim().length > PREVIEW_LEN ? s.trim().slice(0, PREVIEW_LEN) : s.trim()
}

/** Codex 新 hooks（~/.codex/hooks.json）：stdin JSON；字段按 0.166.0 schema，防御式容忍未知字段 */
export function parseCodexHookEvent(
  input: CodexHookInput, fallbackCwd: string, opts: { messagePreview: boolean },
): NotifyEvent | null {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : fallbackCwd
  const title = `Codex · ${cwd ? basename(cwd) : '未知目录'}`
  const preview = (s: string | null | undefined, fallback: string) =>
    opts.messagePreview ? (trim(s) ?? fallback) : fallback

  switch (input.hook_event_name) {
    case 'Stop':
      return { source: 'codex', kind: 'done', title, cwd,
               detail: preview(input.last_assistant_message, '任务完成，等你查看') }
    case 'Interrupt':
      return { source: 'codex', kind: 'interrupted', title, cwd, detail: '任务被中断' }
    case 'PermissionRequest':
      return { source: 'codex', kind: 'needs-input', title, cwd,
               detail: `等待你批准：${input.tool_name ?? '工具调用'}` }
    case 'PostModelRequest':
      if (input.status !== 'failed') return null
      return { source: 'codex', kind: 'error', title, cwd,
               detail: `模型请求失败：${trim(input.error) ?? '未知错误'}` }
    case 'SubagentStop':
      return { source: 'codex', kind: 'done', title, cwd,
               detail: preview(input.last_assistant_message, '子代理任务完成'), filterKey: 'subagentStop' }
    default:
      return null
  }
}

/** Codex 旧 notify（config.toml）：payload 在 argv 末参数，stdin 为 null */
export function parseCodexLegacyNotify(
  input: CodexLegacyInput, fallbackCwd: string, opts: { messagePreview: boolean },
): NotifyEvent | null {
  if (input.type !== 'agent-turn-complete') return null
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : fallbackCwd
  const title = `Codex · ${cwd ? basename(cwd) : '未知目录'}`
  let detail = '任务完成，等你查看'
  if (opts.messagePreview) detail = trim(input['last-assistant-message']) ?? detail
  return { source: 'codex', kind: 'done', title, detail, cwd }
}