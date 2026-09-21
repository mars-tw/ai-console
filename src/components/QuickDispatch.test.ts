import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import QuickDispatch, { buildQuickConversationPreparation } from './QuickDispatch'

const src = readFileSync(new URL('./QuickDispatch.tsx', import.meta.url), 'utf8')
const homeSrc = readFileSync(new URL('../pages/Home.tsx', import.meta.url), 'utf8')

describe('QuickDispatch unified ChatGPT route', () => {
  it('builds a DevSpace preparation request without selecting or dispatching a CLI tool', () => {
    const request = buildQuickConversationPreparation({
      task: '修正型別錯誤並跑測試',
      conv: { title: '原對話', projectDir: 'C:\\工作\\有 空格' },
      recent: [{ role: 'user', text: '前情' }, { role: 'assistant', text: '舊回答' }],
      originalTool: 'Claude',
      source: 'continuation',
    })
    expect(request).toMatchObject({
      task: '修正型別錯誤並跑測試',
      workspace: 'C:\\工作\\有 空格',
      title: '原對話',
      originalTool: 'Claude',
      source: 'continuation',
    })
    expect(request.context).toHaveLength(2)
    expect(request).not.toHaveProperty('tool')
    expect(request).not.toHaveProperty('expectedMode')
  })

  it('can omit old conversation context without altering the task or workspace', () => {
    const request = buildQuickConversationPreparation({
      task: '  更新文件  ',
      conv: { title: '原對話', projectDir: 'C:\\work' },
      recent: [{ role: 'user', text: '不要帶入' }],
      withContext: false,
    })
    expect(request.task).toBe('更新文件')
    expect(request.workspace).toBe('C:\\work')
    expect(request.context).toEqual([])
  })

  it('contains no legacy execution request, readiness fetch, auto route or confirmation claim', () => {
    for (const forbidden of [
      "fetch('/api/dispatch'",
      '/api/dispatch/tools',
      'window.confirm(',
      'expectedMode',
      'filterHeadlessDispatchTools',
      'pickInitialHeadlessTool',
    ]) expect(src).not.toContain(forbidden)
    expect(src).toContain('onPrepareConversation(')
    expect(src).toContain('尚未貼上、送出或執行任何工作')
    expect(src).toContain('ChatGPT「對話」')
    expect(src).toContain('DevSpace MCP')
  })
})

describe('QuickDispatch SSR and controlled draft', () => {
  const base = { conv: null, recent: [], onToast: vi.fn() }

  it('renders the controlled draft and a preparation button, not an execution button', () => {
    const html = renderToStaticMarkup(createElement(QuickDispatch, {
      ...base,
      draft: '保留這份草稿',
      onDraftChange: () => undefined,
      onPrepareConversation: () => undefined,
    }))
    expect(html).toContain('保留這份草稿')
    expect(html).toContain('準備 ChatGPT 對話')
    expect(html).not.toContain('開始執行')
    expect(html).not.toContain('派出去')
  })

  it('without a preparation callback it gives an honest manual route and disables the button', () => {
    const html = renderToStaticMarkup(createElement(QuickDispatch, base))
    expect(html).toContain('請從 AI 控制台的 DevSpace 分頁準備執行對話')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>準備 ChatGPT 對話/)
  })

  it('keeps project and conversation drafts in Home memory wiring', () => {
    expect(homeSrc).toContain('onPrepareConversation={prepareChatGPTConversation}')
    expect(homeSrc).toContain("draft={quickDrafts[selected?.id ?? ''] ?? ''}")
    expect(homeSrc).toContain('prepareDevSpaceConversationDraft(current, request)')
    expect(homeSrc).toContain("setViewMode('devspace')")
    expect(homeSrc).not.toMatch(/localStorage[^\n]*[Qq]uick/)
  })
})
