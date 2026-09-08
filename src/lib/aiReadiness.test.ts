import { describe, expect, it } from 'vitest'
import {
  canDispatch,
  parseDispatchReadiness,
  toolReadinessLabel,
  toolReadinessTone,
  type ReadinessTool,
} from './aiReadiness'

// 常用列樣板：以覆寫方式產生各種契約情境
const row = (over: Partial<ReadinessTool> & { id: string }): ReadinessTool => ({
  label: over.id.toUpperCase(),
  mode: 'headless',
  ready: false,
  limited: false,
  state: 'missing_tool',
  ...over,
})

const cliUnverified = row({
  id: 'codex',
  mode: 'headless',
  ready: true,
  state: 'login_unverified',
  readiness: 'installed_unverified',
  authStatus: 'unknown',
})
const localReady = row({ id: 'local', mode: 'local', ready: true, state: 'ready' })
const localNeedsStart = row({ id: 'local', mode: 'local', ready: true, state: 'needs_start' })
// prepare_on_send 只是 readiness 欄位別名，放在 state 應判為未知
const localPrepareAlias = row({ id: 'local', mode: 'local', ready: true, state: 'prepare_on_send' })
const localNoModel = row({ id: 'local', mode: 'local', ready: false, state: 'needs_model' })
const terminalReady = row({ id: 'term', mode: 'terminal', ready: true, state: 'ready' })

describe('canDispatch 明確指定工具', () => {
  it.each([
    ['本地沒模型 → 不可派', [localNoModel], 'local', false],
    ['本地待啟動可嘗試', [localNeedsStart], 'local', true],
    ['prepare_on_send 不是合法 state', [localPrepareAlias], 'local', false],
    ['本地就緒可派', [localReady], 'local', true],
    ['CLI 登入未確認仍可嘗試', [cliUnverified], 'codex', true],
    ['明確指定終端機可派', [terminalReady], 'term', true],
    ['空清單', [], 'local', false],
    ['找不到對應列', [localReady], 'codex', false],
    ['缺 ready 旗標', [row({ id: 'x', ready: undefined, state: 'ready' })], 'x', false],
    ['ready 是字串', [row({ id: 'x', ready: 'true', state: 'ready' })], 'x', false],
    ['limited 未知', [row({ id: 'x', ready: true, limited: undefined, state: 'ready' })], 'x', false],
    ['limited 為真', [row({ id: 'x', ready: true, limited: true, state: 'ready' })], 'x', false],
    ['state 未知', [row({ id: 'x', ready: true, state: 'wat' })], 'x', false],
    ['缺 state', [row({ id: 'x', ready: true, state: undefined })], 'x', false],
    ['mode 未知', [row({ id: 'x', mode: 'magic', ready: true, state: 'ready' })], 'x', false],
    ['id 重複', [localReady, { ...localReady }], 'local', false],
    ['requested 為空字串', [localReady], '', false],
  ])('%s', (_name, tools, requested, expected) => {
    expect(canDispatch(requested as string, tools as ReadinessTool[], null)).toBe(expected)
  })
})

describe('canDispatch auto 解析', () => {
  it.each([
    ['auto 指到可用列', [cliUnverified], 'codex', true],
    ['auto 為 null 不退回本地', [localReady], null, false],
    ['auto 缺漏不猜', [localReady], undefined, false],
    ['auto 指到不存在的列（過期）', [localReady], 'gone', false],
    ['auto 指到未就緒列', [localNoModel], 'local', false],
    ['auto 指到重複 id', [localReady, { ...localReady }], 'local', false],
    ['auto 不得挑終端機', [terminalReady], 'term', false],
    ['auto 自我指涉', [localReady], 'auto', false],
  ])('%s', (_name, tools, auto, expected) => {
    expect(canDispatch('auto', tools as ReadinessTool[], auto as string | null)).toBe(expected)
  })
})

describe('parseDispatchReadiness 形狀防護', () => {
  it.each([
    ['null', null],
    ['字串', 'nope'],
    ['陣列', [{ id: 'local' }]],
    ['ok 非 true', { ok: 'true', tools: [] }],
    ['ok=false', { ok: false, tools: [localReady] }],
    ['tools 非陣列', { ok: true, tools: { local: localReady } }],
    ['列非物件', { ok: true, tools: ['local'] }],
    ['缺 id', { ok: true, tools: [{ label: 'L' }] }],
    ['缺 label', { ok: true, tools: [{ id: 'local' }] }],
    ['重複 id', { ok: true, tools: [localReady, { ...localReady }] }],
  ])('%s → 整份作廢', (_name, raw) => {
    const snap = parseDispatchReadiness(raw)
    expect(snap).toMatchObject({ ok: false, tools: [], auto: null, ready: false })
    expect(snap.reason.length).toBeGreaterThan(0)
  })

  it('保留舊列但視為未就緒，auto 只在真的可派時留下', () => {
    const snap = parseDispatchReadiness({
      ok: true,
      auto: 'codex',
      tools: [{ id: 'legacy', label: '舊工具' }, cliUnverified, localNoModel],
    })
    expect(snap.ok).toBe(true)
    expect(snap.tools.map((tt) => tt.id)).toEqual(['legacy', 'codex', 'local'])
    expect(snap.tools[0]?.ready).toBeUndefined()
    expect(canDispatch('legacy', snap.tools, null)).toBe(false)
    expect(snap.auto).toBe('codex')
    expect(snap.ready).toBe(true)
  })

  it('矛盾快照不會被升級：ready=true + 過期 auto → auto null、ready false，列仍可見', () => {
    const snap = parseDispatchReadiness({
      ok: true,
      ready: true,
      auto: 'local',
      tools: [localNoModel, cliUnverified],
    })
    expect(snap.auto).toBeNull()
    expect(snap.ready).toBe(false)
    expect(snap.tools).toHaveLength(2)
    expect(snap.reason.length).toBeGreaterThan(0)
  })

  it('頂層 ready=false 即使 auto 指向可用列也不升級，列仍可見', () => {
    const snap = parseDispatchReadiness({
      ok: true,
      ready: false,
      auto: 'codex',
      tools: [cliUnverified],
    })
    expect(snap.auto).toBeNull()
    expect(snap.ready).toBe(false)
    expect(snap.tools).toHaveLength(1)
  })

  it('頂層 ready 非布林（字串 true）視為不可信，auto 一樣清空', () => {
    const snap = parseDispatchReadiness({
      ok: true,
      ready: 'true',
      auto: 'codex',
      tools: [cliUnverified],
    })
    expect(snap.auto).toBeNull()
    expect(snap.ready).toBe(false)
  })

  it('頂層 ready=true 且列真的可派時正常採用', () => {
    const snap = parseDispatchReadiness({ ok: true, ready: true, auto: 'codex', tools: [cliUnverified] })
    expect(snap.auto).toBe('codex')
    expect(snap.ready).toBe(true)
  })

  it('頂層 ready=true 但本地沒模型仍被拒（列事實優先）', () => {
    const snap = parseDispatchReadiness({ ok: true, ready: true, auto: 'local', tools: [localNoModel] })
    expect(snap.auto).toBeNull()
    expect(snap.ready).toBe(false)
  })

  it('伺服器沒給 auto 就是 null，且不做靜態 fallback', () => {
    const snap = parseDispatchReadiness({ ok: true, tools: [localReady] })
    expect(snap.auto).toBeNull()
    expect(snap.ready).toBe(false)
  })

  it('只吸收公開字串欄位，不強制轉型', () => {
    const snap = parseDispatchReadiness({
      ok: true,
      auto: 42,
      tools: [{ id: 'x', label: 'X', mode: 'local', ready: 'true', limited: 0, state: { a: 1 }, reason: 'hi' }],
    })
    expect(snap.tools[0]).toEqual({ id: 'x', label: 'X', mode: 'local', reason: 'hi' })
    expect(snap.auto).toBeNull()
  })
})

describe('toolReadinessLabel / toolReadinessTone', () => {
  it.each([
    ['額度用完', 'blocked', row({ id: 'a', ready: true, limited: true, state: 'ready' })],
    ['狀態未確認', 'unknown', row({ id: 'a', ready: undefined, state: 'ready' })],
    ['狀態未確認', 'unknown', row({ id: 'a', ready: 'true' as unknown, state: 'ready' })],
    ['狀態未確認', 'unknown', row({ id: 'a', ready: true, state: 'wat' })],
    ['尚未設定', 'blocked', localNoModel],
    ['尚未設定', 'blocked', row({ id: 'a', state: 'missing_tool' })],
    ['目前無法使用', 'blocked', row({ id: 'a', ready: false, state: 'error' })],
    ['狀態未確認', 'unknown', localPrepareAlias],
    ['送出時準備', 'neutral', row({ id: 'a', ready: true, state: 'needs_start' })],
    ['已就緒', 'ready', row({ id: 'a', mode: 'local', ready: true, state: 'ready', readiness: 'prepare_on_send' })],
    ['已找到工具，登入待確認', 'neutral', cliUnverified],
    ['已就緒', 'ready', localReady],
    ['可嘗試執行', 'neutral', terminalReady],
    ['可嘗試執行', 'neutral', row({ id: 'a', mode: 'headless', ready: true, state: 'ready' })],
  ])('%s / %s', (label, tone, tool) => {
    expect(toolReadinessLabel(tool as ReadinessTool)).toBe(label)
    expect(toolReadinessTone(tool as ReadinessTool)).toBe(tone)
  })

  it('沒額度不等於就緒，登入未驗證也不給綠燈', () => {
    expect(toolReadinessTone(cliUnverified)).not.toBe('ready')
    expect(toolReadinessTone(row({ id: 'a', mode: 'local', ready: true, limited: true, state: 'ready' }))).toBe('blocked')
  })
})
