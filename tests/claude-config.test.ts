import { describe, it, expect } from 'vitest'
import {
  buildClaudeHookEntry, isAiNotifyClaudeHook, mergeClaudeHooks, removeClaudeHooks,
  uninstallClaudeConfig,
} from '../src/install/claude-config.js'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'   // 故意带空格：exec form 天然安全
const CLI = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ai-toast-notify\\dist\\cli.js'

describe('buildClaudeHookEntry / isAiNotifyClaudeHook', () => {
  it('生成 exec form 条目：command 为裸 node.exe（无引号），args 逐元素，async:true，timeout:10', () => {
    expect(buildClaudeHookEntry(NODE, CLI)).toEqual({
      type: 'command', command: NODE, args: [CLI, 'send', '--claude'], async: true, timeout: 10,
    })
  })
  it('结构识别自有条目；他人条目（shell form / 其他工具）不误判', () => {
    expect(isAiNotifyClaudeHook(buildClaudeHookEntry(NODE, CLI))).toBe(true)
    expect(isAiNotifyClaudeHook({ type: 'command', command: 'npx other-tool x' })).toBe(false)
    expect(isAiNotifyClaudeHook({ type: 'command', command: `\"${NODE}\" \"${CLI}\" send --claude` })).toBe(false)
  })
})

describe('mergeClaudeHooks', () => {
  it('空 settings → 5 事件各 1 组，组内 1 条 exec-form hook', () => {
    const out = mergeClaudeHooks({}, NODE, CLI)
    const hooks = out.hooks as Record<string, Array<{ hooks: unknown[] }>>
    for (const ev of ['Stop', 'StopFailure', 'Notification', 'PostToolUseFailure', 'SubagentStop']) {
      expect(hooks[ev]).toHaveLength(1)
      expect(hooks[ev][0].hooks[0]).toEqual(buildClaudeHookEntry(NODE, CLI))
    }
  })

  it('保留用户已有 hooks（他人条目与 matcher 不动，Stop 组追加不覆盖）', () => {
    const settings = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'npx other-tool x' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo y' }] }],
      },
    }
    const out = mergeClaudeHooks(settings, NODE, CLI)
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(hooks.Stop).toHaveLength(2) // 用户 1 条 + 我们 1 条
    expect(hooks.Stop[0].hooks[0].command).toBe('npx other-tool x')
    expect(hooks.PreToolUse).toHaveLength(1)
  })

  it('幂等：merge 两遍结果相同（不产生重复组）', () => {
    const once = mergeClaudeHooks({}, NODE, CLI)
    expect(mergeClaudeHooks(JSON.parse(JSON.stringify(once)), NODE, CLI)).toEqual(once)
  })

  it('路径变化（升级）→ 替换自有条目不追加', () => {
    const old = mergeClaudeHooks({}, NODE, 'C:\\old\\ai-toast-notify\\dist\\cli.js')
    const out = mergeClaudeHooks(old, NODE, CLI)
    const hooks = out.hooks as Record<string, Array<{ hooks: unknown[] }>>
    expect(hooks.Stop).toHaveLength(1)
    expect(hooks.Stop[0].hooks[0]).toEqual(buildClaudeHookEntry(NODE, CLI))
  })
})

describe('removeClaudeHooks / uninstallClaudeConfig', () => {
  it('remove 移除自有条目、保留他人、清理空组与空 hooks 键', () => {
    const settings = mergeClaudeHooks(
      { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'npx other x' }] }] } },
      NODE, CLI,
    )
    const out = removeClaudeHooks(settings)
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(hooks.Stop).toHaveLength(1)
    expect(hooks.Stop[0].hooks[0].command).toBe('npx other x')
    expect(hooks.StopFailure).toBeUndefined()
  })

  it('全部为自有条目时连 hooks 键一起清掉', () => {
    expect(removeClaudeHooks(mergeClaudeHooks({}, NODE, CLI)).hooks).toBeUndefined()
  })

  it('uninstall 文件不存在 → no-op 不抛错', () => {
    expect(() => uninstallClaudeConfig('Z:\\no\\such\\settings.json')).not.toThrow()
  })
})