/** 我们挂接的 Claude Code hook 事件（spec 4.3）。SubagentStop 也挂上，
 * 事件默认在 send 层按用户配置丢弃（filterKey: subagentStop），配置打开即生效。 */
export const CLAUDE_HOOK_EVENTS = ['Stop', 'StopFailure', 'Notification', 'PostToolUseFailure', 'SubagentStop'] as const