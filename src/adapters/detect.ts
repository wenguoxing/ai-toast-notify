export type DetectedSource = 'claude-code' | 'codex'

const CODEX_ONLY_EVENTS = new Set(['Interrupt', 'PostModelRequest'])
const CLAUDE_ONLY_EVENTS = new Set(['StopFailure', 'Notification', 'PostToolUseFailure'])
// PermissionRequest / Stop / SubagentStop 两家同名，单靠 payload 无法区分 → null

/** 来源识别：--claude/--codex flag 优先，payload 特征嗅探兜底；歧义返回 null。 */
export function detectSource(argv: string[], payload: unknown): DetectedSource | null {
  if (argv.includes('--claude')) return 'claude-code'
  if (argv.includes('--codex')) return 'codex'

  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>

  if (p['type'] === 'agent-turn-complete') return 'codex'

  const ev = typeof p['hook_event_name'] === 'string' ? p['hook_event_name'] : ''
  if (CODEX_ONLY_EVENTS.has(ev)) return 'codex'
  if (CLAUDE_ONLY_EVENTS.has(ev)) return 'claude-code'

  return null
}