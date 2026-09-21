import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

function fixture(url = 'http://127.0.0.1:5177/') {
  const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
  const handlerSource = source.match(/function wireChatGPT\(\) \{[\s\S]*?\r?\n\}/)?.[0]
  if (!handlerSource) throw new Error('Missing ChatGPT opener')
  const mainFrame = { url }
  const webContents = { mainFrame }
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  let invoke!: (event: {sender: unknown; senderFrame: unknown}) => Promise<{ok: boolean}>
  runInNewContext(`${handlerSource}\nwireChatGPT()`, {
    URL, path, process: { env: {} }, os: { homedir: () => 'C:/fixture' },
    fs: { existsSync: () => true }, spawn, APP_URL: 'http://127.0.0.1:5177/',
    win: { webContents }, ipcMain: { handle: (_: string, fn: typeof invoke) => { invoke = fn } },
  })
  return { invoke, spawn, mainFrame, webContents }
}

describe('ChatGPT desktop opener', () => {
  it('opens only the fixed ChatGPT URL in Chrome from the trusted main frame', async () => {
    const f = fixture()
    expect(await f.invoke({ sender: f.webContents, senderFrame: f.mainFrame })).toEqual({ ok: true })
    expect(f.spawn).toHaveBeenCalledWith(expect.stringContaining('chrome.exe'), ['https://chatgpt.com/'], { windowsHide: true, stdio: 'ignore' })
  })
  it('rejects foreign origins and subframes before launching a process', async () => {
    const f = fixture('https://example.com/')
    expect(await f.invoke({ sender: f.webContents, senderFrame: f.mainFrame })).toEqual({ ok: false })
    const g = fixture()
    expect(await g.invoke({ sender: g.webContents, senderFrame: { url: g.mainFrame.url } })).toEqual({ ok: false })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(g.spawn).not.toHaveBeenCalled()
  })
})
