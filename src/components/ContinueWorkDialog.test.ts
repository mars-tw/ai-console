import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ContinueWorkDialog from './ContinueWorkDialog'

const dialogSrc = readFileSync(new URL('./ContinueWorkDialog.tsx', import.meta.url), 'utf8')
const homeSrc = readFileSync(new URL('../pages/Home.tsx', import.meta.url), 'utf8')

const conv = {
  id: 'c1', tool: 'claude', toolLabel: 'Claude', sessionId: 'c1', title: '測試對話',
  project: 'other', projectDir: 'C:\\work', path: 'C:\\work\\c1.jsonl', size: 1000,
  mtime: 1, lastTs: '', msgCount: 3, subagent: false, resume: 'claude resume c1',
  hasMessages: true, inApp: true,
}

describe('ContinueWorkDialog unified conversation route', () => {
  it('renders a modal that prepares DevSpace context and has no CLI launch/resume path', () => {
    const html = renderToStaticMarkup(createElement(ContinueWorkDialog, {
      open: true,
      conversation: conv,
      onClose: () => undefined,
      onToast: () => undefined,
      onPrepareConversation: () => undefined,
      apiOk: true,
      draft: '接著修正',
      onDraftChange: () => undefined,
      detailMessages: [{ role: 'user', text: '前情' }],
      detailForId: 'c1',
    }))
    expect(html).toContain('<dialog')
    expect(html).toContain('在 ChatGPT 對話續作')
    expect(html).toContain('接著修正')
    expect(html).toContain('原紀錄工具')
    expect(html).toContain('Claude')
    expect(html).not.toContain('另開終端')
    expect(html).not.toContain('複製原工具指令')
    expect(dialogSrc).not.toContain("fetch('/api/launch'")
    expect(dialogSrc).not.toContain('build_launch')
    expect(dialogSrc).not.toContain('resumeCommand')
    expect(dialogSrc).toContain("source: 'continuation'")
    expect(dialogSrc).toContain('onPrepareConversation')
  })

  it('allows read-only imported records as bounded context for a new ChatGPT conversation', () => {
    const html = renderToStaticMarkup(createElement(ContinueWorkDialog, {
      open: true,
      conversation: { ...conv, readOnly: true, sourceKind: 'discovered', resume: '' },
      onClose: () => undefined,
      onToast: () => undefined,
      onPrepareConversation: () => undefined,
      apiOk: true,
      draft: '用這份紀錄建立新工作',
      onDraftChange: () => undefined,
      detailMessages: [{ role: 'assistant', text: '唯讀背景' }],
      detailForId: 'c1',
    }))
    expect(html).toContain('用這份紀錄建立新工作')
    expect(html).toContain('準備 ChatGPT 對話')
    expect(html).not.toContain('匯入的對話僅供閱讀')
  })

  it('keeps bounded context loading and accessible focus cleanup', () => {
    expect(dialogSrc).toContain('/api/conv/tail?id=')
    expect(dialogSrc).toContain('normalizeContextMessages')
    expect(dialogSrc).toContain('summary, a[href]')
    expect(dialogSrc).toContain('collectTrapFocusables')
    expect(dialogSrc).toContain('details:not([open])')
    expect(dialogSrc).toContain('runCloseCleanup')
    expect(dialogSrc).toContain('focusTimeoutRef')
    expect(dialogSrc).toContain('useLayoutEffect(() => () => { runCloseCleanup() }')
    expect(dialogSrc).toContain('restore.isConnected')
  })

  it('remains usable on narrow screens', () => {
    expect(dialogSrc).toContain('h-[100dvh]')
    expect(dialogSrc).toContain('w-screen')
    expect(dialogSrc).toContain('max-w-[100vw]')
    expect(dialogSrc).toContain('max-h-[min(calc(100dvh-1.5rem),720px)]')
    expect(dialogSrc).toContain('min-w-0')
    expect(dialogSrc).toContain('overflow-x-hidden')
  })

  it('Home routes continuation through the shared DevSpace draft callback', () => {
    expect(homeSrc).toContain('openContinueWork')
    expect(homeSrc).toContain('<ContinueWorkDialog')
    expect(homeSrc).toContain('onPrepareConversation={prepareChatGPTConversation}')
    expect(homeSrc).not.toContain("fetch('/api/launch'")
    expect(homeSrc).not.toContain('複製原 AI 開啟指令')
  })
})
