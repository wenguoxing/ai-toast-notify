import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG, type UserConfig } from './types.js'

/** 读取用户配置；任何问题（缺文件/坏 JSON/字段缺失）逐层回退默认值，永不抛错。 */
export function loadConfig(path: string): UserConfig {
  try {
    if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserConfig>
    return {
      events: { ...DEFAULT_CONFIG.events, ...raw.events },
      toast: { ...DEFAULT_CONFIG.toast, ...raw.toast },
      codex: { ...DEFAULT_CONFIG.codex, ...raw.codex },
    }
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

/** 保存用户配置（自动建目录）。 */
export function saveConfig(path: string, cfg: UserConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
}