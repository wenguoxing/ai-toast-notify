export const STDIN_TIMEOUT_MS = 3000

/** 读 stdin，超时按已读内容 resolve（stdin 永不关闭也不挂死）；结束后移除全部监听器。 */
export function readStdin(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let result = ''
    let settled = false
    const onData = (chunk: Buffer | string) => {
      result += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    }
    const onEnd = () => finish(result)
    const onError = () => finish(result) // 出错也按已读内容返回（send 铁律：不抛错）
    const timer = setTimeout(() => finish(result), timeoutMs)

    function finish(value: string): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      resolve(value)
    }

    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}

/** 从 argv 尾部向前找第一个非 `--` 开头且可 JSON.parse 的参数（Codex 旧 notify payload 在末参数）。 */
export function extractArgvJson(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i]
    if (a.startsWith('--')) continue
    try { JSON.parse(a); return a } catch { /* 继续 */ }
  }
  return null
}