import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexCommand, buildCodexHookEntry, isAiNotifyCodexHook, isCodexHooksPathSupported,
  mergeCodexHooks, removeCodexHooks, installCodexHooksConfig, uninstallCodexHooksConfig,
} from '../src/install/codex-hooks-config.js'

const CLI = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ai-toast-notify\\dist\\cli.js'
const orca = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex-hooks-orca-sample.json'), 'utf8'))

const EVENT_KEYS = ['Stop', 'Interrupt', 'PermissionRequest', 'PostModelRequest', 'SubagentStop'] as const

describe('mergeCodexHooks', () => {
  it('空 {} → 生成 5 事件结构', () => {
    const out = mergeCodexHooks({}, CLI)
    const hooks = (out.hooks as Record<string, unknown[]>)
    for (const ev of EVENT_KEYS) expect(hooks[ev]).toHaveLength(1)
  })

  it('orca 样本输入 → 5 事件各追加 1 组，orca 条目原样保留（deep equal），matcher 保留', () => {
    const sample = orca()
    const out = mergeCodexHooks(sample, CLI)
    const hooks = out.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>
    for (const ev of ['Stop', 'Interrupt', 'PermissionRequest'] as const) {
      expect(hooks[ev]).toHaveLength(2)
      expect(hooks[ev][0]).toEqual((sample.hooks as Record<string, unknown[]>)[ev][0]) // orca 原样
    }
    expect(hooks.PermissionRequest[0].matcher).toBe('shell')
  })

  it('五个自有条目均 async === true；Interrupt timeout 3，其余 10', () => {
    const out = mergeCodexHooks({}, CLI)
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ async?: boolean; timeout?: number }> }>>
    for (const ev of EVENT_KEYS) {
      const h = hooks[ev][0].hooks[0]
      expect(h.async).toBe(true)
      expect(h.timeout).toBe(ev === 'Interrupt' ? 3 : 10)
    }
  })

  it('command 为 node <cli.js> send --codex（裸名，路径无引号无空格）', () => {
    expect(buildCodexCommand(CLI)).toBe(`node ${CLI} send --codex`)
    const out = mergeCodexHooks({}, CLI)
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(hooks.Stop[0].hooks[0].command).toBe(`node ${CLI} send --codex`)
  })

  it('幂等：merge 两遍一致，无重复组', () => {
    const once = mergeCodexHooks({}, CLI)
    expect(mergeCodexHooks(structuredClone(once), CLI)).toEqual(once)
  })

  it('路径变化 → 自有条目替换不追加；定义从 sync 改 async 也会替换旧自有条目', () => {
    const old = mergeCodexHooks({}, 'C:\\old\\ai-toast-notify\\dist\\cli.js')
    const out = mergeCodexHooks(old, CLI)
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(hooks.Stop).toHaveLength(1)
    expect(hooks.Stop[0].hooks[0].command).toBe(`node ${CLI} send --codex`)

    // v1.3 旧定义（带引号、无 async）也应被识别并替换
    const legacyDef = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `\"C:\\node.exe\" \"${CLI}\" send --codex`, timeout: 10 }] }] },
    }
    const out2 = mergeCodexHooks(legacyDef, CLI)
    const hooks2 = out2.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    expect(hooks2.Stop).toHaveLength(1)
    expect(hooks2.Stop[0].hooks[0].command).toBe(`node ${CLI} send --codex`)
  })

  it('结构识别：自有 command 认出；orca 的 codex-hook.cmd 不误判', () => {
    expect(isAiNotifyCodexHook(buildCodexHookEntry(CLI, 'Stop'))).toBe(true)
    expect(isAiNotifyCodexHook({ type: 'command', command: 'C:/Users/Administrator/.orca/agent-hooks/codex-hook.cmd' })).toBe(false)
  })

  it('第三方组缺 hooks 数组 → 不抛 TypeError，原组保留且追加自有组', () => {
    const file = { hooks: { Stop: [{ matcher: 'third-party' }] } }
    const out = mergeCodexHooks(file, CLI)
    const hooks = out.hooks as Record<string, Array<{ matcher?: string; hooks?: unknown[] }>>
    expect(hooks.Stop).toHaveLength(2)
    expect(hooks.Stop[0]).toEqual({ matcher: 'third-party' })
    expect(hooks.Stop[1].hooks).toHaveLength(1)
  })
  it('remove：自有组移除、orca 组保留、空事件键与顶层 hooks 键清理', () => {
    const merged = mergeCodexHooks(orca(), CLI)
    const out = removeCodexHooks(merged)
    const hooks = out.hooks as Record<string, Array<{ hooks: unknown[] }>>
    for (const ev of ['Stop', 'Interrupt', 'PermissionRequest'] as const) {
      expect(hooks[ev]).toHaveLength(1) // 只剩 orca
    }
    expect(hooks.PostModelRequest).toBeUndefined()
    expect(hooks.SubagentStop).toBeUndefined()

    expect(removeCodexHooks(mergeCodexHooks({}, CLI)).hooks).toBeUndefined()
  })
})

describe('installCodexHooksConfig / uninstallCodexHooksConfig', () => {
  let dir: string
  const path = () => join(dir, 'hooks.json')

  it('uninstall 文件不存在 → no-op 不抛错', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-hooks-'))
    expect(() => uninstallCodexHooksConfig(path())).not.toThrow()
    expect(existsSync(path())).toBe(false)
  })

  it('remove 遇第三方组缺 hooks 数组 → 不抛 TypeError 且原组保留', () => {
    const file = { hooks: { Stop: [{ matcher: 'third-party' }] } }
    const out = removeCodexHooks(file)
    expect((out.hooks as Record<string, unknown[]>).Stop).toEqual([{ matcher: 'third-party' }])
  })
  it('解析失败（坏 JSON）→ 抛错且不写', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-hooks-'))
    writeFileSync(path(), '{bad json')
    const before = readFileSync(path(), 'utf8')
    expect(() => installCodexHooksConfig(path(), CLI)).toThrow()
    expect(readFileSync(path(), 'utf8')).toBe(before) // 原文未动
  })

  it('cli.js 路径含空白 → install 前置拒绝且原文件保持不变', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-hooks-'))
    const before = '{ "description": "kept" }\n'
    writeFileSync(path(), before)
    expect(isCodexHooksPathSupported('C:\\Users\\John Doe\\ai-toast-notify\\dist\\cli.js')).toBe(false)
    expect(() => installCodexHooksConfig(path(), 'C:\\Users\\John Doe\\ai-toast-notify\\dist\\cli.js'))
      .toThrow('cli.js 路径包含空白字符')
    expect(readFileSync(path(), 'utf8')).toBe(before)
  })
  it('install 写入后与 orca 共存且保留未知顶层键（description）', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-hooks-'))
    writeFileSync(path(), JSON.stringify({ ...orca(), description: 'kept' }))
    installCodexHooksConfig(path(), CLI)
    const out = JSON.parse(readFileSync(path(), 'utf8'))
    expect(out.description).toBe('kept')
    expect(out.hooks.Stop).toHaveLength(2)
  })
})