import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AskAI from './AskAI'
import { describe, expect, it } from 'vitest'
import {
  askEndpoint,
  askMessages,
  askPreflight,
  localModels,
  pickSetupLocal,
  planAskSubmit,
  rollbackAskSession,
  shouldRestoreDraft,
} from './AskAI'
import type { AskPreflightState, AskRollback, AskSession } from './AskAI'

describe('Ask AI request boundary', () => {
  it('does not advertise auto while the local model list is still unknown and preserves the draft', () => {
    const html = renderToStaticMarkup(createElement(AskAI, { session: { model: 'auto', messages: [], input: 'keep this draft' }, onSessionChange: () => {} }))
    expect(html).not.toContain('🤖 自動（建議）')
    expect(html).toContain('正在檢查地端模型…')
    expect(html).toMatch(/<select[^>]*id="ask-model"[^>]*disabled=""/)
    expect(html).toContain('keep this draft')
  })
  it('keeps builtin LM Studio on the guarded chat endpoint and saved AI on its own endpoint', () => {
    expect(askEndpoint()).toBe('/api/chat')
    expect(askEndpoint('')).toBe('/api/chat')
    expect(askEndpoint('custom-ai-1')).toBe('/api/ai-connections/chat')
  })
  it('uses an answer-only system boundary and keeps the current question last', () => {
    const messages = askMessages([{ role: 'assistant', text: '前一題' }], '新問題')
    expect(messages[0].content).toContain('只負責回答問題')
    expect(messages[0].content).toContain('不要呼叫工具')
    expect(messages.at(-1)).toEqual({ role: 'user', content: '新問題' })
  })

  it('uses an English answer-only boundary when the UI is English', () => {
    const messages = askMessages([], 'What does this mean?', 'en')
    expect(messages[0].content).toContain('Only answer the question')
    expect(messages[0].content).toContain('Reply in clear English')
    expect(messages[0].content).not.toContain('繁體中文')
  })

  it('excludes reasoning-only and error placeholders from future question context', () => {
    const messages = askMessages([
      { role: 'user', text: 'previous question' },
      { role: 'assistant', text: 'no answer', reasoning: 'unfinished draft' },
      { role: 'assistant', text: 'transport failed', excludeFromContext: true },
    ], 'new question')
    expect(messages.map(message => message.content)).not.toContain('no answer')
    expect(messages.map(message => message.content)).not.toContain('transport failed')
    expect(messages.at(-1)?.content).toBe('new question')
  })
})

const BASE_LOCAL = { ready: true, state: 'needs_start', models: ['m'] }
const state = (over: Partial<AskPreflightState> = {}): AskPreflightState => ({
  model: 'auto',
  local: BASE_LOCAL,
  localLoading: false,
  connections: [],
  connectionsLoading: false,
  connectionsError: '',
  ...over,
})
const CUSTOM: Partial<AskPreflightState> = {
  connectionId: 'c1',
  model: 'm',
  connections: [{ id: 'c1', credentialStatus: 'memory' }],
}
type Blocked = [string, Partial<AskPreflightState>, string]

describe('送出前檢查', () => {
  it('地端就緒時才放行，needs_start 與 ready 都算就緒', () => {
    expect(askPreflight(state())).toEqual({ ok: true })
    expect(askPreflight(state({ model: 'm' }))).toEqual({ ok: true })
    expect(askPreflight(state({ local: { ...BASE_LOCAL, state: 'ready' } }))).toEqual({ ok: true })
  })

  it.each<Blocked>([
    ['沒有 local', { local: null }, 'local_unavailable'],
    ['還在讀取', { localLoading: true }, 'loading'],
    ['ready:false', { local: { ...BASE_LOCAL, ready: false } }, 'local_not_ready'],
    ["ready:'true' 字串", { local: { ...BASE_LOCAL, ready: 'true' } }, 'local_not_ready'],
    ['沒有 state', { local: { ready: true, models: ['m'] } }, 'local_not_ready'],
    ['state 認不得', { local: { ...BASE_LOCAL, state: 'unknown' } }, 'local_not_ready'],
    ['state 忙碌中', { local: { ...BASE_LOCAL, state: 'busy' } }, 'local_not_ready'],
    ['模型清單是空的', { local: { ...BASE_LOCAL, models: [] } }, 'local_no_models'],
    ['模型清單不是陣列', { local: { ...BASE_LOCAL, models: 'm' } }, 'local_no_models'],
    ['沒有選模型', { model: '' }, 'local_model_missing'],
    ['選到已消失的模型', { model: 'stale' }, 'local_model_missing'],
  ])('地端 %s 就擋下送出', (_label, patch, reason) => {
    expect(askPreflight(state(patch))).toEqual({ ok: false, reason })
  })

  it('已加入的 AI 選好模型且有金鑰就放行，not_set 是免金鑰不是缺金鑰', () => {
    expect(askPreflight(state(CUSTOM))).toEqual({ ok: true })
    expect(askPreflight(state({ ...CUSTOM, connections: [{ id: 'c1', credentialStatus: 'not_set' }] }))).toEqual({ ok: true })
  })

  it.each<Blocked>([
    ['目錄還在讀', { connectionsLoading: true }, 'loading'],
    ['目錄讀取失敗', { connectionsError: '壞了' }, 'connection_error'],
    ['連線已不存在', { connections: [] }, 'connection_missing'],
    ['金鑰是 missing', { connections: [{ id: 'c1', credentialStatus: 'missing' }] }, 'connection_key'],
    ['模型還是 auto', { model: 'auto' }, 'connection_model'],
    ['模型是空的', { model: '' }, 'connection_model'],
  ])('已加入的 AI %s 就擋下送出', (_label, patch, reason) => {
    expect(askPreflight(state({ ...CUSTOM, ...patch }))).toEqual({ ok: false, reason })
  })
})

describe('setup 回應與模型清單', () => {
  it.each<[string, boolean, unknown]>([
    ['HTTP 失敗', false, { ok: true, local: BASE_LOCAL }],
    ['沒有資料', true, null],
    ['整包是陣列', true, []],
    ['ok:false', true, { ok: false, local: BASE_LOCAL }],
    ["ok:'true' 字串", true, { ok: 'true', local: BASE_LOCAL }],
    ['沒有 ok', true, { local: BASE_LOCAL }],
    ['local 是陣列', true, { ok: true, local: ['m'] }],
    ['local 是 null', true, { ok: true, local: null }],
  ])('%s 一律不採用 local', (_label, ok, data) => {
    expect(pickSetupLocal(ok, data)).toBeNull()
  })

  it('只有 ok:true 且 local 是物件才採用', () => {
    expect(pickSetupLocal(true, { ok: true, local: BASE_LOCAL })).toEqual(BASE_LOCAL)
  })

  it('模型清單只認非空字串', () => {
    expect(localModels({ models: ['a', '', '  ', 1, null, 'b'] })).toEqual(['a', 'b'])
    expect(localModels({ models: 'a' })).toEqual([])
    expect(localModels(null)).toEqual([])
  })
})

describe('送出決策', () => {
  it.each<[string, string, boolean, Partial<AskPreflightState>, unknown]>([
    ['正在回答中', 'hi', true, {}, { action: 'ignore' }],
    ['只打了空白', '   ', false, {}, { action: 'ignore' }],
    ['地端還沒好', 'hi', false, { local: null }, { action: 'blocked', reason: 'local_unavailable' }],
    ['沒有模型', 'hi', false, { local: { ...BASE_LOCAL, models: [] } }, { action: 'blocked', reason: 'local_no_models' }],
    ['可以送出', '  hi  ', false, {}, { action: 'send', text: 'hi' }],
  ])('%s', (_label, text, busy, patch, plan) => {
    expect(planAskSubmit({ text, busy, state: state(patch) })).toEqual(plan)
  })

  it('判斷送不送不會改到輸入或紀錄', () => {
    const frozen = Object.freeze(state({ connections: Object.freeze([]) as AskPreflightState['connections'] }))
    expect(() => planAskSubmit({ text: 'hi', busy: false, state: frozen })).not.toThrow()
    expect(frozen.model).toBe('auto')
  })
})

describe('草稿與回滾', () => {
  it.each<[string, string, string, number, number, boolean]>([
    ['沒動過輸入框而且是空的', 'q', '', 2, 2, true],
    ['已經打了新問題', 'q', 'new', 2, 2, false],
    ['打過又自己清空', 'q', '', 2, 5, false],
    ['草稿本來就是空白', '   ', '', 2, 2, false],
  ])('%s', (_label, draft, currentInput, editSeqAtSend, editSeq, expected) => {
    expect(shouldRestoreDraft({ draft, currentInput, editSeqAtSend, editSeq })).toBe(expected)
  })

  const prior: AskSession['messages'] = [{ role: 'user', text: '舊問題' }]
  const echoed: AskSession['messages'] = [...prior, { role: 'user', text: 'q' }]
  const session = (over: Partial<AskSession> = {}): AskSession => ({ model: 'm', messages: echoed, input: '', ...over })
  const owned: AskRollback = { consumed: { draft: 'q', editSeq: 3 }, priorHistory: prior, echoed }

  it('同一個訊息陣列才算自己的：還草稿也還紀錄', () => {
    const back = rollbackAskSession(session(), owned, 3)
    expect(back.input).toBe('q')
    expect(back.messages).toBe(prior)
  })

  it.each<[string, string, number]>([
    ['使用者打了新問題', 'new', 4],
    ['打過又自己清空', '', 9],
  ])('%s 就只回滾自己的紀錄、不動輸入框', (_label, input, editSeq) => {
    const back = rollbackAskSession(session({ input }), owned, editSeq)
    expect(back.input).toBe(input)
    expect(back.messages).toBe(prior)
  })

  it('訊息陣列已被換掉（內容相同）就整份不動，包含空輸入框', () => {
    const replaced = echoed.map(message => ({ ...message }))
    const current = session({ messages: replaced })
    expect(rollbackAskSession(current, owned, 3)).toBe(current)
  })

  it('重送沒有借草稿時只回滾紀錄', () => {
    const back = rollbackAskSession(session({ input: '打到一半' }), { priorHistory: prior, echoed }, 3)
    expect(back.input).toBe('打到一半')
    expect(back.messages).toBe(prior)
  })

  it('還沒寫進訊息就被擋下時只還草稿', () => {
    const current = session()
    const back = rollbackAskSession(current, { consumed: { draft: 'q', editSeq: 2 }, priorHistory: prior }, 2)
    expect(back.input).toBe('q')
    expect(back.messages).toBe(current.messages)
  })
})

describe('元件接線', () => {
  const source = readFileSync(new URL('./AskAI.tsx', import.meta.url), 'utf8')

  it('送出鈕與送出流程都走同一份判斷', () => {
    expect(source).toMatch(/disabled=\{[\s\S]{0,160}?!preflight\.ok/)
    expect(source).toContain('planAskSubmit(')
    expect(source).toContain('askPreflight(')
  })

  it('掛載旗標與卸載回滾的順序：先還東西再清掉、取消', () => {
    expect(source).toContain('mountedRef.current = true')
    const cleanup = source.slice(source.indexOf('mountedRef.current = false'))
    expect(cleanup).toMatch(/rollback\(\)[\s\S]{0,200}abort\(\)/)
  })

  it('沒有留下已移除的舊識別字', () => {
    expect(source).not.toMatch(/\babortRef\b/)
    expect(source).not.toMatch(/\brestoreDraft\b/)
  })
})
