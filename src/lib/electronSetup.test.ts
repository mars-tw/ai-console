import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const APP_URL = 'http://127.0.0.1:5177/'
type Frame = { url: string }
type SetupEvent = { sender: object; senderFrame: Frame }
type SetupHandler = (event: SetupEvent) => Promise<string | null>

function setupHarness(url = APP_URL) {
  // Execute the checked-in handler, without importing Electron or starting the app.
  const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
  const wireSetup = source.match(/function wireSetup\(\) \{[\s\S]*?\r?\n\}/)?.[0]
  if (!wireSetup) throw new Error('Cannot locate the production setup IPC handler')
  const mainFrame = { url }
  const webContents = { mainFrame }
  const window = { webContents }
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['fixture-directory'] }))
  let handler: SetupHandler | undefined
  const register = vi.fn((channel: string, callback: SetupHandler) => {
    expect(channel).toBe('setup:choose-directory')
    handler = callback
  })
  runInNewContext(`${wireSetup}\nwireSetup()`, {
    URL, APP_URL, win: window, ipcMain: { handle: register }, dialog: { showOpenDialog },
  }, { timeout: 1000 })
  expect(register).toHaveBeenCalledTimes(1)
  if (!handler) throw new Error('Production setup handler was not registered')
  return { invoke: handler, mainFrame, webContents, window, showOpenDialog }
}

describe('Electron setup directory picker sender boundary', () => {
  it('opens the picker for the desktop window main frame', async () => {
    const fixture = setupHarness()
    await expect(fixture.invoke({ sender: fixture.webContents, senderFrame: fixture.mainFrame })).resolves.toBe('fixture-directory')
    expect(fixture.showOpenDialog).toHaveBeenCalledExactlyOnceWith(fixture.window, {
      title: '選擇 AI 對話或匯出資料夾', properties: ['openDirectory'],
    })
  })

  it('rejects a same-origin subframe even when it shares the WebContents', async () => {
    const fixture = setupHarness()
    await expect(fixture.invoke({ sender: fixture.webContents, senderFrame: { url: `${APP_URL}embedded` } })).resolves.toBeNull()
    expect(fixture.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects the mobile page even when loaded in the main frame', async () => {
    const fixture = setupHarness(`${APP_URL}m/`)
    await expect(fixture.invoke({ sender: fixture.webContents, senderFrame: fixture.mainFrame })).resolves.toBeNull()
    expect(fixture.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects a main frame that navigated to a foreign origin', async () => {
    const fixture = setupHarness('https://example.com/')
    await expect(fixture.invoke({ sender: fixture.webContents, senderFrame: fixture.mainFrame })).resolves.toBeNull()
    expect(fixture.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects a different sender even when given the desktop main frame', async () => {
    const fixture = setupHarness()
    await expect(fixture.invoke({ sender: {}, senderFrame: fixture.mainFrame })).resolves.toBeNull()
    expect(fixture.showOpenDialog).not.toHaveBeenCalled()
  })
})
