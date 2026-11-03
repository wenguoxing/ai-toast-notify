export type EventSource = 'claude-code' | 'codex'
export type EventKind = 'done' | 'error' | 'interrupted' | 'needs-input'

export interface NotifyEvent {
  source: EventSource
  kind: EventKind
  title: string
  detail?: string
  cwd: string
  filterKey?: 'idlePing' | 'subagentStop'
}

export interface UserConfig {
  events: { idlePing: boolean; subagentStop: boolean }
  toast: { sound: boolean }
  codex: { messagePreview: boolean }
}

export const DEFAULT_CONFIG: UserConfig = {
  events: { idlePing: false, subagentStop: false },
  toast: { sound: true },
  codex: { messagePreview: true },
}

/** 包名标识，用于 hook 条目识别（改名只改这一处） */
export const PKG_NAME = 'ai-toast-notify'