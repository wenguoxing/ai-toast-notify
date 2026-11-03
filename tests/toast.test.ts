import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { NotifyEvent } from '../src/types.js'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

import {
  escapeXml, buildToastArgs, sendToast, POWERSHELL_EXE, TOAST_TIMEOUT_MS,
} from '../src/notify/toast.js'

const evt: NotifyEvent = {
  source: 'claude-code', kind: 'done', title: 'Claude Code · demo',
  detail: '完成 & <ok> "引号" ' + String.fromCharCode(39) + '单引' + String.fromCharCode(39) + ' 中文 🎉',
  cwd: 'C:\\work\\demo',
}

beforeEach(() => spawnMock.mockReset())

describe('toast 后端', () => {
  it('TOAST_TIMEOUT_MS === 2500（必须低于 Codex Interrupt 3s 宿主上限）', () => {
    expect(TOAST_TIMEOUT_MS).toBe(2500)
  })

  it('escapeXml 转义 & < > " 且中文/emoji 原样', () => {
    const out = escapeXml('a & b < c > d " e 中文 🎉')
    expect(out).toBe('a &amp; b &lt; c &gt; d &quot; e 中文 🎉')
  })

  it('buildToastArgs 含固定旗标、完整 WinRT XML 与 AUMID 常量', () => {
    const args = buildToastArgs(evt, { sound: true })
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    expect(args).toContain('-ExecutionPolicy')
    expect(args).toContain('Bypass')
    const s = args.join('\n')
    expect(s).toContain('<toast')
    expect(s).toContain('template="ToastGeneric"')
    expect(s).toContain('<text>')
    expect(s).toContain('ToastNotificationManager')
    expect(s).toContain('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('sound=false 时含 <audio silent="true"/>；true 时不含', () => {
    expect(buildToastArgs(evt, { sound: false }).join('\n')).toContain('<audio silent="true"/>')
    expect(buildToastArgs(evt, { sound: true }).join('\n')).not.toContain('<audio')
  })

  it('kind 对应 emoji 前缀', () => {
    expect(buildToastArgs(evt, { sound: true }).join('\n')).toContain('✅')
    const err: NotifyEvent = { ...evt, kind: 'error' }
    expect(buildToastArgs(err, { sound: true }).join('\n')).toContain('❌')
  })

  it('XML 特殊字符全部转义进脚本', () => {
    const s = buildToastArgs(evt, { sound: true }).join('\n')
    expect(s).toContain('&amp;')
    expect(s).toContain('&lt;')
    expect(s).toContain('&gt;')
    expect(s).toContain('&quot;')
    expect(s).toContain('&apos;')
  })

  it('不含 -WindowsStyle（v1.0 拼错；windowsHide 已足够）', () => {
    expect(buildToastArgs(evt, { sound: true }).join('\n')).not.toContain('-WindowsStyle')
  })

  it('sendToast spawn error → reject（send 层吞掉）', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('spawn failed')))
      return child
    })
    await expect(sendToast(evt, { sound: true })).rejects.toThrow('spawn failed')
    expect(spawnMock).toHaveBeenCalledWith(POWERSHELL_EXE, expect.any(Array), expect.anything())
  })

  it('sendToast 非零退出码 → reject', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', 1))
      return child
    })
    await expect(sendToast(evt, { sound: true })).rejects.toThrow('powershell exited with 1')
  })
})