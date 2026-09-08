import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ContinueWorkDialog from './ContinueWorkDialog'
import homeSrc from '../pages/Home.tsx?raw'

const dialogSrc = readFileSync(fileURLToPath(new URL('./ContinueWorkDialog.tsx', import.meta.url)), 'utf8')

const conv = {
  id: 'c1',
  tool: 'claude',
  toolLabel: 'Claude',
  sessionId: 'c1',
  title: '測試對話',
  project: 'other',
  projectDir: 'C:\\work',
  path: 'C:\\work\\c1.jsonl',
  size: 1000,
  mtime: 1,
  lastTs: '',
  msgCount: 3,
  subagent: false,
  resume: 'claude resume c1',
  hasMessages: true,
  inApp: true,
}

describe('ContinueWorkDialog', () => {
  it('SSR 使用原生 dialog，且開啟時不 POST /api/launch', () => {
    const html = renderToStaticMarkup(createElement(ContinueWorkDialog, {
      open: true,
      conversation: conv,
      onClose: () => {},
      onToast: () => {},
      apiOk: true,
      draft: '',
      onDraftChange: () => {},
    }))
    expect(html).toContain('<dialog')
    expect(html).toContain('aria-labelledby=')
    const launchAt = dialogSrc.indexOf("fetch('/api/launch'")
    const fnAt = dialogSrc.indexOf('const launchTerminal')
    expect(launchAt).toBeGreaterThan(fnAt)
    expect(fnAt).toBeGreaterThan(-1)
    expect(dialogSrc).toContain('openRef.current')
    expect(dialogSrc).toContain('focusedOnOpen.current')
    expect(dialogSrc).toContain('showModal')
    expect(dialogSrc).toContain('r.ok && d?.ok === true')
  })

  it('焦點圈含 summary／連結，且關閉時有卸載清理', () => {
    expect(dialogSrc).toContain('summary, a[href]')
    expect(dialogSrc).toContain('collectTrapFocusables')
    expect(dialogSrc).toContain('details:not([open])')
    expect(dialogSrc).toContain('runCloseCleanup')
    expect(dialogSrc).toContain('focusTimeoutRef')
    expect(dialogSrc).toContain('useLayoutEffect(() => () => { runCloseCleanup() }')
    expect(dialogSrc).toContain('restore.isConnected')
  })

  it('對話框全視窗覆蓋，面板可捲動且不撐出橫向捲軸', () => {
    expect(dialogSrc).toContain('h-[100dvh]')
    expect(dialogSrc).toContain('w-screen')
    expect(dialogSrc).toContain('max-w-[100vw]')
    expect(dialogSrc).toContain('max-h-[min(calc(100dvh-1.5rem),720px)]')
    expect(dialogSrc).toContain('min-w-0')
    expect(dialogSrc).toContain('overflow-x-hidden')
  })

  it('Home 三個入口改開對話框，不再直接 launch', () => {
    expect(homeSrc).toContain('openContinueWork')
    expect(homeSrc).toContain('<ContinueWorkDialog')
    expect(homeSrc).not.toContain('fetch(\'/api/launch\'')
    expect(homeSrc).not.toContain('const launch =')
  })
})
