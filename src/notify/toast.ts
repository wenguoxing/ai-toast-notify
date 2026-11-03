import { spawn } from 'node:child_process'
import type { NotifyEvent } from '../types.js'

export const POWERSHELL_EXE = 'powershell.exe'
export const TOAST_TIMEOUT_MS = 2500 // 低于 Codex Interrupt 3s 宿主上限

/** 系统 PowerShell 开始菜单快捷方式 AUMID（soulee-dev / TianqiZhang 同款，Win10/11 稳定存在） */
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const KIND_EMOJI: Record<NotifyEvent['kind'], string> = {
  done: '✅', error: '❌', interrupted: '⏹', 'needs-input': '💬',
}

export function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export function buildToastArgs(event: NotifyEvent, opts: { sound: boolean }): string[] {
  const title = escapeXml(`${KIND_EMOJI[event.kind]} ${event.title}`)
  const detail = escapeXml(event.detail ?? '')
  const audio = opts.sound ? '' : '<audio silent="true"/>'
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    '  $null=[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '  $null=[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
    `  $xml='<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${detail}</text></binding></visual>${audio}</toast>'`,
    '  $doc=New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $doc.LoadXml($xml)',
    '  $t=New-Object Windows.UI.Notifications.ToastNotification $doc',
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($t)`,
    '} catch { exit 1 }',
  ].join('\n')
  // 注意：不传 -WindowStyle（v1.0 的 -WindowsStyle 是拼写错误；windowsHide 已隐藏控制台）
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
}

export function sendToast(event: NotifyEvent, opts: { sound: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL_EXE, buildToastArgs(event, opts), {
      timeout: TOAST_TIMEOUT_MS, windowsHide: true,
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`powershell exited with ${code}`))))
  })
}