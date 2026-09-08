import { describe, expect, it } from 'vitest'
import {
  canOpenContinueWork,
  continueWorkBlockedReason,
  filterHeadlessDispatchTools,
  normalizeContextMessages,
  ownsContinuationContext,
  pickInitialHeadlessTool,
  resolveDispatchRecipientLabel,
  terminalResumeKind,
} from './continuationHelp'

const HEADLESS = { id: 'claude', label: 'Claude', mode: 'headless', ready: true, limited: false, state: 'ready' }
const TERMINAL = { id: 'cursor', label: 'Cursor', mode: 'terminal', ready: true, limited: false, state: 'ready' }
const LOCAL = { id: 'local', label: '地端', mode: 'local', ready: true, limited: false, state: 'ready' }

describe('canOpenContinueWork', () => {
  it('唯讀與 discovered 來源都擋下', () => {
    expect(canOpenContinueWork({ readOnly: true })).toBe(false)
    expect(canOpenContinueWork({ sourceKind: 'discovered' })).toBe(false)
    expect(canOpenContinueWork({})).toBe(true)
    expect(continueWorkBlockedReason({ readOnly: true })).toContain('僅供閱讀')
  })
})

describe('terminalResumeKind', () => {
  it('Claude/Codex/Kimi 走 session resume；Grok/Qwen/Cursor 只開目錄', () => {
    expect(terminalResumeKind('claude')).toBe('session_resume')
    expect(terminalResumeKind('codex')).toBe('session_resume')
    expect(terminalResumeKind('kimi')).toBe('session_resume')
    expect(terminalResumeKind('grok')).toBe('project_only')
    expect(terminalResumeKind('qwen')).toBe('project_only')
    expect(terminalResumeKind('cursor')).toBe('project_only')
    expect(terminalResumeKind('gemini')).toBe('unsupported')
  })
})

describe('headless tool pick', () => {
  it('只保留無頭工具', () => {
    expect(filterHeadlessDispatchTools([HEADLESS, TERMINAL, LOCAL]).map((x) => x.id)).toEqual(['claude'])
  })

  it('優先 initialTool，不可用時不換成別的工具', () => {
    const tools = [HEADLESS, { ...HEADLESS, id: 'codex', label: 'Codex' }]
    expect(pickInitialHeadlessTool('cursor', tools, 'claude')).toBe('cursor')
    expect(pickInitialHeadlessTool('claude', tools, 'claude')).toBe('claude')
    expect(pickInitialHeadlessTool(undefined, tools, 'claude')).toBe('auto')
    expect(pickInitialHeadlessTool('kimi', [HEADLESS, { ...HEADLESS, id: 'qwen' }], 'claude')).toBe('kimi')
  })

  it('確認視窗顯示實際收件人名稱', () => {
    const tools = [HEADLESS, { ...HEADLESS, id: 'qwen', label: 'Qwen' }]
    expect(resolveDispatchRecipientLabel('claude', tools, 'claude')).toBe('Claude')
    expect(resolveDispatchRecipientLabel('auto', tools, 'qwen')).toBe('Qwen')
  })
})

describe('normalizeContextMessages', () => {
  it('最多 6 則、每則 300 字', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `m${i}${'x'.repeat(400)}` }))
    const out = normalizeContextMessages(msgs)
    expect(out).toHaveLength(6)
    expect(out[0].text).toHaveLength(300)
    expect(out[0].text.startsWith('m4')).toBe(true)
  })

  it('畸形 payload 安全略過或空白化', () => {
    expect(normalizeContextMessages([null as unknown as { role: string; text: string }, { role: 'assistant' }])).toEqual([
      { role: 'assistant', text: '' },
    ])
  })
})

describe('ownsContinuationContext', () => {
  it('關閉或換對話後晚到結果作廢', () => {
    expect(ownsContinuationContext({
      requestSeq: 2,
      requestId: 2,
      conversationId: 'a',
      activeId: 'a',
      open: true,
    })).toBe(true)
    expect(ownsContinuationContext({
      requestSeq: 3,
      requestId: 2,
      conversationId: 'a',
      activeId: 'a',
      open: true,
    })).toBe(false)
    expect(ownsContinuationContext({
      requestSeq: 2,
      requestId: 2,
      conversationId: 'a',
      activeId: 'b',
      open: true,
    })).toBe(false)
    expect(ownsContinuationContext({
      requestSeq: 2,
      requestId: 2,
      conversationId: 'a',
      activeId: 'a',
      open: false,
    })).toBe(false)
  })
})
