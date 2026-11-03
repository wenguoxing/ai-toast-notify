import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../src/config.js'
import { DEFAULT_CONFIG } from '../src/types.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-cfg-'))
})

describe('loadConfig', () => {
  it('文件不存在 → 返回默认值', () => {
    expect(loadConfig(join(dir, 'none.json'))).toEqual(DEFAULT_CONFIG)
  })

  it('文件是坏 JSON → 返回默认值不抛错', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{oops')
    expect(loadConfig(p)).toEqual(DEFAULT_CONFIG)
  })

  it('部分字段缺失 → 缺的用默认值，存在的保留', () => {
    const p = join(dir, 'partial.json')
    writeFileSync(p, JSON.stringify({ events: { idlePing: true } }))
    const cfg = loadConfig(p)
    expect(cfg.events.idlePing).toBe(true)        // 用户值保留
    expect(cfg.events.subagentStop).toBe(false)   // 缺失回退默认
    expect(cfg.toast.sound).toBe(true)
  })
})

describe('saveConfig', () => {
  it('写入后可完整读回', () => {
    const p = join(dir, 'sub', 'config.json') // 嵌套目录也要能建
    const cfg = { ...DEFAULT_CONFIG, events: { ...DEFAULT_CONFIG.events, subagentStop: true } }
    saveConfig(p, cfg)
    expect(loadConfig(p)).toEqual(cfg)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(cfg)
  })
})