import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type UserConfig } from '../src/types.js'
import type { SendDeps } from '../src/cli.js'
import {
  runSend, runInstall, runUninstall, runTest,
  claudeSettingsPath, codexHooksPath, codexConfigPath, configPath,
} from '../src/cli.js'

const sendToastMock = vi.fn(async () => {})
vi.mock('../src/notify/toast.js', () => ({ sendToast: (...a: unknown[]) => sendToastMock(...a) }))

const makeDeps = (over: Partial<SendDeps> = {}): SendDeps => ({
  logDir: 'Z:\\tmp\\log',
  cwd: 'C:\\work\\demo',
  readStdin: vi.fn(async () => ''),
  loadConfig: vi.fn((): UserConfig => structuredClone(DEFAULT_CONFIG)),
  sendToast: vi.fn(async () => {}),
  appendLog: vi.fn(),
  ...over,
})
const eventOf = (deps: SendDeps) => (deps.sendToast as ReturnType<typeof vi.fn>).mock.calls[0][0]
const fx = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))

describe('runSend 铁律', () => {
  it('argv 末参数 JSON（Codex 旧 notify 形态）优先于 stdin → codex done', async () => {
    const argvJson = '{"type":"agent-turn-complete","cwd":"D:\\\\w\\\\a","last-assistant-message":"搞定"}'
    const deps = makeDeps({ readStdin: vi.fn(async () => '') }) // 真实情况 stdin 为 null
    await runSend(['send', '--codex', argvJson], deps)
    expect(deps.sendToast).toHaveBeenCalledTimes(1)
    expect(eventOf(deps).source).toBe('codex')
    expect(eventOf(deps).kind).toBe('done')
  })

  it('stdin JSON（Claude hooks 形态）正常 → claude done', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('claude-stop.json'))) })
    await runSend(['send', '--claude'], deps)
    expect(deps.sendToast).toHaveBeenCalledTimes(1)
    expect(eventOf(deps).source).toBe('claude-code')
    expect(eventOf(deps).kind).toBe('done')
  })

  it('argv 与 stdin 都空 → 记日志、不发 toast、不抛错', async () => {
    const deps = makeDeps()
    await expect(runSend(['send', '--claude'], deps)).resolves.toBeUndefined()
    expect(deps.appendLog).toHaveBeenCalledTimes(1)
    expect(deps.sendToast).not.toHaveBeenCalled()
  })

  it('坏 JSON → 安静处理', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => 'not json') })
    await expect(runSend(['send', '--claude'], deps)).resolves.toBeUndefined()
    expect(deps.appendLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('invalid json'))
    expect(deps.sendToast).not.toHaveBeenCalled()
  })

  it('来源无法识别（Stop 无 flag）→ 记日志不发', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('claude-stop.json'))) })
    await runSend(['send'], deps)
    expect(deps.appendLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('source not detected'))
    expect(deps.sendToast).not.toHaveBeenCalled()
  })

  it('Claude Stop 含 background_tasks → 过滤不发', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('claude-stop-background.json'))) })
    await runSend(['send', '--claude'], deps)
    expect(deps.sendToast).not.toHaveBeenCalled()
    expect(deps.appendLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('not notifiable'))
  })

  it('idle_ping/idle_prompt 默认配置下过滤，打开后放行', async () => {
    const payload = JSON.stringify(fx('claude-notification-idle.json'))
    const off = makeDeps({ readStdin: vi.fn(async () => payload) })
    await runSend(['send', '--claude'], off)
    expect(off.sendToast).not.toHaveBeenCalled()

    const cfgOn: UserConfig = { ...structuredClone(DEFAULT_CONFIG), events: { ...DEFAULT_CONFIG.events, idlePing: true } }
    const on = makeDeps({ readStdin: vi.fn(async () => payload), loadConfig: vi.fn(() => cfgOn) })
    await runSend(['send', '--claude'], on)
    expect(on.sendToast).toHaveBeenCalledTimes(1)
    expect(eventOf(on).filterKey).toBe('idlePing')
  })

  it('SubagentStop 默认过滤，配置打开后放行', async () => {
    const payload = JSON.stringify(fx('codex-subagent-stop.json'))
    const off = makeDeps({ readStdin: vi.fn(async () => payload) })
    await runSend(['send', '--codex'], off)
    expect(off.sendToast).not.toHaveBeenCalled()

    const cfgOn: UserConfig = { ...structuredClone(DEFAULT_CONFIG), events: { ...DEFAULT_CONFIG.events, subagentStop: true } }
    const on = makeDeps({ readStdin: vi.fn(async () => payload), loadConfig: vi.fn(() => cfgOn) })
    await runSend(['send', '--codex'], on)
    expect(on.sendToast).toHaveBeenCalledTimes(1)
  })

  it('--codex + Interrupt → interrupted', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('codex-interrupt.json'))) })
    await runSend(['send', '--codex'], deps)
    expect(eventOf(deps).kind).toBe('interrupted')
  })

  it('--codex + PermissionRequest → needs-input 且 detail 含 tool_name', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('codex-permission-request.json'))) })
    await runSend(['send', '--codex'], deps)
    expect(eventOf(deps).kind).toBe('needs-input')
    expect(eventOf(deps).detail).toContain('shell')
  })

  it('--codex + Stop 且 messagePreview:false → detail 为固定文案（无摘要）', async () => {
    const cfgOff: UserConfig = { ...structuredClone(DEFAULT_CONFIG), codex: { messagePreview: false } }
    const deps = makeDeps({
      readStdin: vi.fn(async () => JSON.stringify(fx('codex-stop.json'))),
      loadConfig: vi.fn(() => cfgOff),
    })
    await runSend(['send', '--codex'], deps)
    expect(eventOf(deps).detail).toBe('任务完成，等你查看')
  })

  it('--codex + PostModelRequest failed → error 且 detail 含模型错误', async () => {
    const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('codex-post-model-failed.json'))) })
    await runSend(['send', '--codex'], deps)
    expect(eventOf(deps).kind).toBe('error')
    expect(eventOf(deps).detail).toContain('rate limit exceeded')
  })

  it('--codex + PostModelRequest completed/cancelled → null，不发 toast', async () => {
    for (const status of ['completed', 'cancelled']) {
      const payload = JSON.stringify({ ...fx('codex-post-model-failed.json'), status })
      const deps = makeDeps({ readStdin: vi.fn(async () => payload) })
      await runSend(['send', '--codex'], deps)
      expect(deps.sendToast).not.toHaveBeenCalled()
    }
  })

  it('sendToast 抛错 → 吞掉记日志，runSend 正常返回', async () => {
    const deps = makeDeps({
      readStdin: vi.fn(async () => JSON.stringify(fx('claude-stop.json'))),
      sendToast: vi.fn(async () => { throw new Error('toast boom') }),
    })
    await expect(runSend(['send', '--claude'], deps)).resolves.toBeUndefined()
    expect(deps.appendLog).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('toast boom'))
  })

  it('全程不写 stdout：console.log/console.info 零调用（Codex PermissionRequest 会解析 stdout，恒空 = 不干预审批）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const deps = makeDeps({ readStdin: vi.fn(async () => JSON.stringify(fx('claude-stop.json'))) })
      await runSend(['send', '--claude'], deps)
      expect(deps.sendToast).toHaveBeenCalledTimes(1)
      expect(logSpy).not.toHaveBeenCalled()
      expect(infoSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore(); infoSpy.mockRestore()
    }
  })
})

describe('runInstall 铁律', () => {
  let dir: string
  const realHome = process.env['USERPROFILE']

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-home-'))
    process.env['USERPROFILE'] = dir
    sendToastMock.mockClear()
  })
  afterEach(() => { process.env['USERPROFILE'] = realHome })

  it('默认 install 写 hooks.json，不触碰 config.toml；五个 hooks 条目均 async:true、Interrupt timeout:3', async () => {
    const cli = join(dir, 'apps', 'ai-toast-notify', 'dist', 'cli.js')
    await runInstall({ legacyNotify: false, cliJsPath: cli })
    const hooks = JSON.parse(readFileSync(codexHooksPath(), 'utf8')).hooks
    for (const ev of ['Stop', 'Interrupt', 'PermissionRequest', 'PostModelRequest', 'SubagentStop']) {
      const own = hooks[ev].flatMap((g: { hooks: unknown[] }) => g.hooks)
        .find((h: { command?: string }) => h.command?.includes('ai-toast-notify'))
      expect(own.async).toBe(true)
      expect(own.timeout).toBe(ev === 'Interrupt' ? 3 : 10)
      expect(own.command).toMatch(/^node .+ send --codex$/)
    }
    expect(existsSync(codexConfigPath())).toBe(false)
    expect(existsSync(configPath())).toBe(true) // 用户配置已生成
    expect(existsSync(claudeSettingsPath())).toBe(true)
  })

  it('install --legacy-notify 移除自有 hooks、保留 orca、写入 config.toml', async () => {
    const cli = join(dir, 'apps', 'ai-toast-notify', 'dist', 'cli.js')
    await runInstall({ legacyNotify: false, cliJsPath: cli }) // 先默认安装（含自有 hooks）
    const orca = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex-hooks-orca-sample.json'), 'utf8'))
    const current = JSON.parse(readFileSync(codexHooksPath(), 'utf8'))
    current.hooks.SessionStart = orca.hooks.Stop // 模拟第三方条目
    writeFileSync(codexHooksPath(), JSON.stringify(current))

    await runInstall({ legacyNotify: true, cliJsPath: cli })
    const hooksAfter = JSON.parse(readFileSync(codexHooksPath(), 'utf8')).hooks
    for (const ev of ['Stop', 'Interrupt', 'PermissionRequest', 'PostModelRequest', 'SubagentStop']) {
      expect(hooksAfter[ev]).toBeUndefined() // 自有条目已移除
    }
    expect(hooksAfter.SessionStart).toHaveLength(1) // orca 保留
    const toml = readFileSync(codexConfigPath(), 'utf8')
    expect(toml).toMatch(/^notify = /m)
    expect(toml).toContain('ai-toast-notify')
  })
})

describe('runUninstall / runTest', () => {
  let dir: string
  const realHome = process.env['USERPROFILE']

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-toast-notify-home-'))
    process.env['USERPROFILE'] = dir
    sendToastMock.mockClear()
  })
  afterEach(() => { process.env['USERPROFILE'] = realHome })

  it('runUninstall 依次清理 Claude settings、Codex hooks、Codex config 三处自有条目（orca 与他人配置保留）', async () => {
    const cli = join(dir, 'apps', 'ai-toast-notify', 'dist', 'cli.js')
    await runInstall({ legacyNotify: false, cliJsPath: cli })
    // 注入第三方条目
    const hooks = JSON.parse(readFileSync(codexHooksPath(), 'utf8'))
    hooks.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'C:/x/orca.cmd' }] }]
    writeFileSync(codexHooksPath(), JSON.stringify(hooks))
    const settings = JSON.parse(readFileSync(claudeSettingsPath(), 'utf8'))
    settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'other-tool' })
    writeFileSync(claudeSettingsPath(), JSON.stringify(settings))

    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => logs.push(m))
    try { await runUninstall() } finally { spy.mockRestore() }

    const s = JSON.parse(readFileSync(claudeSettingsPath(), 'utf8'))
    expect(s.hooks.Stop[0].hooks).toHaveLength(1) // 他人保留
    expect(s.hooks.StopFailure).toBeUndefined()   // 自有清掉

    const h = JSON.parse(readFileSync(codexHooksPath(), 'utf8')).hooks
    expect(h.Stop).toBeUndefined()
    expect(h.SessionStart).toHaveLength(1)        // orca 保留
  })

  it('runTest 发送一条固定 toast，title 含 ai-toast-notify（sendToast mock 断言，不发 stdin）', async () => {
    await runTest()
    expect(sendToastMock).toHaveBeenCalledTimes(1)
    const event = sendToastMock.mock.calls[0][0]
    expect(event.title).toContain('ai-toast-notify')
  })
})