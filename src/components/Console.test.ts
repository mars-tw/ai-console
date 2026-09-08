// 主控台的無 DOM 聚焦測試：派工資格、後端回覆判讀，以及送出路徑的接線。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { canDispatchAll, isLocalAnswerRecord, planReplyMessage } from './Console'
import { ensureStepIds, stepIdsForDispatch } from '@/lib/dispatchLifecycle'
import type { ReadinessSnapshot, ReadinessTool } from '@/lib/aiReadiness'

// xterm 只有瀏覽器跑得起來；這裡驗的是純邏輯與接線，不需要真的終端機。
vi.mock('@/components/LiveTerminal', () => ({ default: () => null }))

const tool = (id: string, over: Partial<ReadinessTool> = {}): ReadinessTool =>
  ({ id, label: `${id}-stub`, mode: 'headless', ready: true, limited: false, state: 'ready', ...over })
const snap = (tools: ReadinessTool[], auto: string | null = null): ReadinessSnapshot =>
  ({ ok: true, tools, auto, ready: auto !== null, reason: '' })
const broken: ReadinessSnapshot = { ok: false, tools: [], auto: null, ready: false, reason: '工具狀態讀不到' }

describe('canDispatchAll', () => {
  const cases: [string, string[], ReadinessSnapshot | null | undefined, boolean][] = [
    ['沒有快照就不可派工', ['claude'], undefined, false],
    ['null 快照不可派工', ['claude'], null, false],
    ['讀取失敗的快照不可派工', ['claude'], broken, false],
    ['沒有目標不算可派工', [], snap([tool('claude')]), false],
    ['ready 是 false', ['claude'], snap([tool('claude', { ready: false })]), false],
    ['缺 limited 旗標', ['claude'], snap([{ id: 'claude', label: 'claude-stub', mode: 'headless', ready: true, state: 'ready' }]), false],
    ['額度用完', ['claude'], snap([tool('claude', { limited: true })]), false],
    ['auto 指向快照裡沒有的工具', ['auto'], snap([tool('claude')], 'gemini'), false],
    ['指名的工具不在快照裡', ['gemini'], snap([tool('claude')]), false],
    ['整批只要有一個不合格就整批擋下', ['claude', 'codex'], snap([tool('claude'), tool('codex', { limited: true })]), false],
    ['重複 id 無法辨識', ['claude'], snap([tool('claude'), tool('claude')]), false],
    ['auto 不會選終端機模式', ['auto'], snap([tool('kimi', { mode: 'terminal' })], 'kimi'), false],
    ['無頭且明確就緒', ['claude'], snap([tool('claude')]), true],
    ['地端「送出時準備」可嘗試', ['local'], snap([tool('local', { mode: 'local', state: 'needs_start' })]), true],
    ['auto 釘到無頭工具', ['auto'], snap([tool('claude')], 'claude'), true],
    ['指名終端機模式可派工', ['kimi'], snap([tool('kimi', { mode: 'terminal' })]), true],
    ['同一個可派工工具重複多件', ['claude', 'claude', 'claude'], snap([tool('claude')]), true],
  ]
  it.each(cases)('%s', (_name, targets, snapshot, expected) => {
    expect(canDispatchAll(targets, snapshot)).toBe(expected)
  })
})

describe('planReplyMessage', () => {
  const cases: [string, unknown, string][] = [
    ['保留非 2xx body 的 error', { ok: false, error: '地端模型沒有啟動' }, '地端模型沒有啟動'],
    ['error／note／nextAction 依序串起來', { error: 'A', note: 'B', nextAction: 'C' }, 'A・B・C'],
    ['去掉空白與空字串', { error: '  A  ', note: '   ' }, 'A'],
    ['忽略物件、陣列與數字', { error: { code: 500 }, note: ['x'], nextAction: 7 }, ''],
    ['沒有 body', null, ''],
    ['body 不是物件', 'boom', ''],
    ['空物件', {}, ''],
  ]
  it.each(cases)('%s', (_name, body, expected) => {
    expect(planReplyMessage(body)).toBe(expected)
  })
  it('不渲染物件，也不因為 HTTP 失敗而丟例外（它只是 body 格式化）', () => {
    expect(planReplyMessage({ error: { code: 500 } })).not.toContain('[object Object]')
    expect(() => planReplyMessage({ ok: false, status: 500 })).not.toThrow()
  })
})

describe('只重派失敗的：不碰已送出的步驟', () => {
  it('failed 模式只挑 failed', () => {
    const steps = ensureStepIds([
      { state: 'sent' as const }, { state: 'failed' as const }, { state: 'idle' as const },
    ])
    expect(stepIdsForDispatch(steps, 'failed')).toEqual([steps[1].id])
    expect(stepIdsForDispatch(steps)).toEqual([steps[2].id])
  })
})

const src = readFileSync(new URL('./Console.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../pages/Home.tsx', import.meta.url), 'utf8')
const section = (from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start + 1)
  return start >= 0 && end > start ? src.slice(start, end) : ''
}
const inOrder = (text: string, marks: string[]): boolean => {
  let at = 0
  for (const mark of marks) {
    const found = text.indexOf(mark, at)
    if (found < 0) return false
    at = found + mark.length
  }
  return true
}
const plan = section('const makePlan = async', 'const givePlanUp')
const runAll = section('const runAll = async', 'const sendFollowup')
const followup = section('const sendFollowup = async', 'const saveJob')
const retry = section('const retry = async', 'const cancelDispatch')
const runJobNow = section('const runJobNow = async', 'const pullSched')
const cancel = section('const cancelDispatch = async', 'const stopDispatch')
const stop = section('const stopDispatch = async', 'const toggleDiff')

describe('送出路徑的接線', () => {
  const orderCases: [string, string, string[]][] = [
    ['拆解前先擋沒有執行者，才動計畫與 API', plan, ['if (!hasExecutor)', 'setSteps([])', "'/api/plan'"]],
    ['派工複查在確認視窗、狀態變更與 POST 之前', runAll,
      ['if (dispatchLock.current) return', 'await ensureDispatchable(', 'window.confirm(', "state: 'sending'", "'/api/dispatch/batch'"]],
    ['auto 用複查後的新快照釘死，才進 payload', runAll,
      ['await ensureDispatchable(', 'fresh.auto', 'canDispatchAll(pinned.map', 'steps: pinned.map']],
    ['整批只有地端才講「只回答」，否則講讀寫檔案', runAll,
      ['isAnswerOnlyTool(x.tool, fresh.tools)', 'window.confirm(answerOnly', '只回答，不改檔', '可能讀寫專案檔案']],
  ]
  it.each(orderCases)('%s', (_name, text, marks) => {
    expect(text).not.toBe('')
    expect(inOrder(text, marks)).toBe(true)
  })

  const gateCases: [string, string, boolean][] = [
    ['重派要複查原本那個工具', retry, true],
    ['定時工作「立刻跑」要複查指名的工具', runJobNow, true],
    ['已結束的補一句要複查，進行中的直接排隊', followup, true],
    ['取消不受可派工狀態影響', cancel, false],
    ['停止不受可派工狀態影響', stop, false],
  ]
  it.each(gateCases)('%s', (_name, text, gated) => {
    expect(text).not.toBe('')
    expect(text.includes('ensureDispatchable(')).toBe(gated)
    expect(text.includes('hasExecutor')).toBe(false)
  })

  it('進行中的補一句不用等新的可派工工具', () => {
    expect(followup).toContain('if (!isLive(target) && !(await ensureDispatchable([target.tool]))) return')
  })

  it('四個送出入口共用 runAll', () => {
    for (const call of ['void runAll(got)', 'runAll(steps)', 'void runAll([s])', "runAll(steps, 'failed')"]) {
      expect(src).toContain(call)
    }
  })

  it('Ctrl / Cmd + Enter 走同一個 makePlan', () => {
    expect(src).toMatch(/onKeyDown=\{[\s\S]{0,200}?e\.ctrlKey \|\| e\.metaKey[\s\S]{0,120}?makePlan\(\)/)
  })

  it('沒有寫死的工具清單當 fallback', () => {
    expect(src).not.toMatch(/const\s+TOOLS\b/)
    expect(src).toContain("{ ok: false, tools: [], auto: null, ready: false, reason: '' }")
    expect(src).toContain('readiness.ok')
  })

  const disabledCases: [string, string][] = [
    ['分析並排程', 'disabled={!input.trim() || planning || !hasExecutor}'],
    ['全部派出', 'disabled={!pending || running || dispatchBusy || !canDispatchAll(pendingTools, readiness)}'],
    ['只重派失敗的', 'disabled={dispatchBusy || !canDispatchAll(failedTools, readiness)}'],
    ['只派這件', 'disabled={dispatchBusy || !canDispatchAll([s.tool], readiness)}'],
    ['工具選單', 'disabled: !canDispatch(row.id, readiness.tools, readiness.auto),'],
    ['自動選擇選項', 'disabled: !readiness.auto,'],
  ]
  it.each(disabledCases)('%s 由共用判讀決定停用', (_name, mark) => {
    expect(src).toContain(mark)
  })
})

describe('本機問答紀錄：不能補話，也沒有檔案改動可看', () => {
  const cases: [string, { tool?: string; mode?: string } | null | undefined, boolean][] = [
    ['tool 是 local', { tool: 'local', mode: 'headless' }, true],
    ['mode 是 sync', { tool: 'claude', mode: 'sync' }, true],
    ['一般無頭派工', { tool: 'claude', mode: 'headless' }, false],
    ['終端派工', { tool: 'kimi', mode: 'terminal' }, false],
    ['沒有紀錄', null, false],
    ['undefined', undefined, false],
    ['空物件', {}, false],
  ]
  it.each(cases)('%s', (_name, record, expected) => {
    expect(isLocalAnswerRecord(record)).toBe(expected)
  })

  it('補話在動任何狀態、送出 POST 之前就先擋下本機問答', () => {
    expect(inOrder(followup, [
      'if (isLocalAnswerRecord(target))',
      'LOCAL_FOLLOWUP_NOTE()',
      'return',
      'dispatchLock.current = true',
      "'/api/dispatch/followup'",
    ])).toBe(true)
  })

  it('被擋下時不清掉使用者打的字（只有成功才清）', () => {
    const guard = followup.slice(0, followup.indexOf('dispatchLock.current = true'))
    expect(guard).toContain('isLocalAnswerRecord(target)')
    expect(guard).not.toContain('setReplyText(')
    expect(inOrder(followup, ['const ok = response.ok && r.ok === true', 'if (ok) {', "setReplyText('')"])).toBe(true)
  })

  it('本機問答不給「看改了什麼」', () => {
    expect(src).toContain('!isLive(d) && d.canDiff && !isLocalAnswerRecord(d)')
  })

  it('本機問答把補一句換成說明，送出鈕也停用', () => {
    expect(src).toContain('本機問答請回原對話接續')
    expect(src).toContain('isLocalAnswerRecord(d) ? (')
    expect(src).toContain("disabled={replyBusy || !replyText.trim() || isLocalAnswerRecord(d)")
  })
})

describe('Home 的受控草稿', () => {
  it('兩處 Console 都受控，而且保留快速派工的草稿表', () => {
    const tags = home.match(/<Console[\s\S]*?\/>/g) ?? []
    expect(tags).toHaveLength(2)
    for (const tag of tags) {
      expect(tag).toContain('draft={consoleDraft}')
      expect(tag).toContain('onDraftChange={setConsoleDraft}')
      expect(tag).toContain('onSetup=')
    }
    expect(home).toContain("draft={quickDrafts[selected?.id ?? ''] ?? ''}")
    expect(home).toContain('setQuickDrafts((m) => ({ ...m, [selected?.id ?? \'\']: v }))')
  })
})
