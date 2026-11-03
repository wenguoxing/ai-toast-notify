import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildNotifyValue, toTomlArray, mergeCodexNotify, removeCodexNotify,
  installCodexConfig, uninstallCodexConfig,
} from '../src/install/codex-config.js'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const CLI = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ai-toast-notify\\dist\\cli.js'
const CLI_LINK = 'C:\\dev\\ai-notify\\dist\\cli.js' // npm link：路径不含包名，也不能被误判为他人

describe('buildNotifyValue / toTomlArray', () => {
  it('buildNotifyValue 生成数组形态', () => {
    expect(buildNotifyValue(NODE, CLI)).toEqual([NODE, CLI, 'send', '--codex'])
  })

  it('toTomlArray 反斜杠/引号转义', () => {
    expect(toTomlArray([NODE, CLI, 'send', '--codex']))
      .toBe('["C:\\\\Program Files\\\\nodejs\\\\node.exe", "C:\\\\Users\\\\u\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\ai-toast-notify\\\\dist\\\\cli.js", "send", "--codex"]')
  })
})

describe('mergeCodexNotify', () => {
  it('空文本 → 追加根键 notify', () => {
    const { text } = mergeCodexNotify('', NODE, CLI)
    expect(text).toBe(`notify = ${toTomlArray([NODE, CLI, 'send', '--codex'])}\n`)
  })

  it('文末有 table 且无 notify → notify 出现在首个 [ 之前', () => {
    const toml = 'model = "gpt-5"\n\n[projects."F:\\\\work\\\\demo"]\npath = "F:\\\\work\\\\demo"\n'
    const { text } = mergeCodexNotify(toml, NODE, CLI)
    const lines = text.split('\n')
    const notifyIdx = lines.findIndex((l) => l.startsWith('notify ='))
    const tableIdx = lines.findIndex((l) => l.trimStart().startsWith('['))
    expect(notifyIdx).toBeGreaterThanOrEqual(0)
    expect(notifyIdx).toBeLessThan(tableIdx)
  })

  it('已有自有 notify → 替换、幂等、路径升级只 1 行', () => {
    const first = mergeCodexNotify('', NODE, 'C:\\old\\ai-toast-notify\\dist\\cli.js').text
    const second = mergeCodexNotify(first, NODE, CLI)
    expect(second.text.match(/^notify =/gm)).toHaveLength(1)
    const third = mergeCodexNotify(second.text, NODE, CLI)
    expect(third.text).toBe(second.text)
  })

  it('npm link 路径不含包名 → 仍按 send --codex 结构识别为自有条目', () => {
    const first = mergeCodexNotify('', NODE, CLI_LINK).text
    const second = mergeCodexNotify(first, NODE, CLI).text
    expect(second.match(/^\s*notify\s*=/gm)).toHaveLength(1)
    expect(second).toContain(toTomlArray(buildNotifyValue(NODE, CLI)))
    expect(removeCodexNotify(first)).not.toMatch(/^\s*notify\s*=/m)
  })
  it('已有他人 notify（python/x.py）→ 返回原文不变 + skipped', () => {
    const toml = 'notify = ["python", "C:/x/x.py"]\n\n[projects]\n'
    const out = mergeCodexNotify(toml, NODE, CLI)
    expect(out.skipped).toBe(true)
    expect(out.text).toBe(toml)
  })

  it('第三方数组末尾在 send --codex 后还有参数 → 不识别为自有，install/remove 均保持原文', () => {
    const toml = 'notify = ["node", "relay.js", "send", "--codex", "--team=dev"]\n\n[projects]\n'
    expect(mergeCodexNotify(toml, NODE, CLI).skipped).toBe(true)
    expect(mergeCodexNotify(toml, NODE, CLI).text).toBe(toml)
    expect(removeCodexNotify(toml)).toBe(toml)
  })

  it('table 内的他人 notify 不是根键 → 不阻止安装，根 notify 插到 table 前', () => {
    const toml = 'model = "gpt-5"\n\n[tasks]\nnotify = ["python", "C:/x/x.py"]\n'
    const out = mergeCodexNotify(toml, NODE, CLI)
    expect(out.skipped).toBe(false)
    expect(out.text.indexOf('notify = ')).toBeLessThan(out.text.indexOf('[tasks]'))
    expect(out.text).toContain('notify = ["python", "C:/x/x.py"]')
  })

  it('table 内即使出现自有形态 notify → 原样保留，同时在根级别新增 notify', () => {
    const tableNotify = 'notify = ["node", "C:/old/ai-toast-notify/dist/cli.js", "send", "--codex"]'
    const toml = `model = "gpt-5"\n\n[tasks]\n${tableNotify}\n`
    const out = mergeCodexNotify(toml, NODE, CLI)
    expect(out.skipped).toBe(false)
    expect(out.text).toContain(tableNotify)
    expect(out.text.slice(0, out.text.indexOf('[tasks]'))).toMatch(/^\s*notify\s*=/m)
    // uninstall 只清理根级自有条目，table 内第三方/同名形态不动
    const cleaned = removeCodexNotify(out.text)
    expect(cleaned).toContain(tableNotify)
    expect(cleaned.slice(0, cleaned.indexOf('[tasks]'))).not.toMatch(/^\s*notify\s*=/m)
  })
  it('缩进的合法根键 notify → 识别并替换，不追加重复根键', () => {
    const toml = 'model = "gpt-5"\n  notify = ["python", "C:/old/ai-toast-notify/x.py", "send", "--codex"]\n\n[projects]\n'
    const out = mergeCodexNotify(toml, NODE, CLI)
    expect(out.skipped).toBe(false)
    expect(out.text.match(/^\s*notify\s*=/gm)).toHaveLength(1)
    expect(out.text).toContain(toTomlArray(buildNotifyValue(NODE, CLI)))
  })
  it('多行 notify → 抛错', () => {
    const toml = 'notify = [\n  "python",\n  "C:/x/x.py"\n]\n'
    expect(() => mergeCodexNotify(toml, NODE, CLI)).toThrow('手动处理')
  })

  it('remove 删自有保留其他；他人 notify 不动', () => {
    const own = mergeCodexNotify('model = "gpt-5"\n', NODE, CLI).text
    expect(removeCodexNotify(own)).not.toMatch(/^notify =/m)
    expect(removeCodexNotify(own)).toContain('model = "gpt-5"')

    const other = 'notify = ["python", "C:/x/x.py"]\n'
    expect(removeCodexNotify(other)).toBe(other)
  })
})

describe('installCodexConfig / uninstallCodexConfig', () => {
  let dir: string
  const path = () => join(dir, 'config.toml')

  it('install 文件不存在 → 创建仅含 notify 的文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-toml-'))
    const { skipped } = installCodexConfig(path(), NODE, CLI)
    expect(skipped).toBe(false)
    expect(readFileSync(path(), 'utf8')).toBe(`notify = ${toTomlArray([NODE, CLI, 'send', '--codex'])}\n`)
  })

  it('install 他人 notify → skipped 且不写不改文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-toml-'))
    const toml = 'notify = ["python", "C:/x/x.py"]\n'
    writeFileSync(path(), toml)
    const { skipped } = installCodexConfig(path(), NODE, CLI)
    expect(skipped).toBe(true)
    expect(readFileSync(path(), 'utf8')).toBe(toml)
  })

  it('多行 notify（不可识别形态）→ 抛错且文件保持原文（不写坏文件）', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-toml-'))
    const toml = 'notify = [\n  "python",\n  "C:/x/x.py"\n]\n'
    writeFileSync(path(), toml)
    expect(() => installCodexConfig(path(), NODE, CLI)).toThrow()
    expect(readFileSync(path(), 'utf8')).toBe(toml)
  })

  it('uninstall 文件不存在 → no-op；卸载后自有 notify 消失', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-toml-'))
    expect(() => uninstallCodexConfig(path())).not.toThrow()
    installCodexConfig(path(), NODE, CLI)
    uninstallCodexConfig(path())
    expect(readFileSync(path(), 'utf8')).not.toMatch(/^notify =/m)
  })
})