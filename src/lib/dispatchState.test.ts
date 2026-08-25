import { describe, expect, it } from 'vitest'

import {
  COMPLETION_TERMINAL_HISTORY_LIMIT,
  completionTransitions,
  ensureStepIds,
  mapStepsById,
  stepIdsForDispatch,
} from './dispatchLifecycle'
import { isLive, look, stateOf } from './dispatchState'
import type { DispatchRecord } from '@/types/data'

function mkRecord(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id: 'disp-1',
    tool: 'codex',
    task: '測試派工任務',
    started: '2026-08-21 08:00:00',
    log: '/path/to/log.txt',
    mode: 'headless',
    ...over,
  }
}

// ── 狀態判定 ──────────────────────────────────────────

describe('stateOf 派工狀態判定與舊資料相容', () => {
  it('伺服器已指定 state 欄位時，以 state 優先回傳', () => {
    expect(stateOf(mkRecord({ state: 'running', alive: false }))).toBe('running')
    expect(stateOf(mkRecord({ state: 'waiting', alive: true }))).toBe('waiting')
    expect(stateOf(mkRecord({ state: 'done', alive: true }))).toBe('done')
    expect(stateOf(mkRecord({ state: 'failed', result: 'ok' }))).toBe('failed')
    expect(stateOf(mkRecord({ state: 'silent', reply: 'ok' }))).toBe('silent')
  })

  it('舊資料缺 state 且 alive 為 true 時判定為 running', () => {
    const r = mkRecord({ alive: true, result: undefined, reply: undefined })
    expect(stateOf(r)).toBe('running')

    // 即使帶有 result，只要 alive 為 true 依然視為 running
    const rWithResult = mkRecord({ alive: true, result: '部分結果' })
    expect(stateOf(rWithResult)).toBe('running')
  })

  it('舊資料缺 state 且 alive 為 false/undefined：有 result 或 reply 時判定為 done', () => {
    expect(stateOf(mkRecord({ alive: false, result: '執行成功' }))).toBe('done')
    expect(stateOf(mkRecord({ alive: false, reply: '收到回覆' }))).toBe('done')
    expect(stateOf(mkRecord({ alive: undefined, result: '執行完畢' }))).toBe('done')
  })

  it('舊資料缺 state 且 alive 為 false/undefined：無輸出時判定為 waiting', () => {
    expect(stateOf(mkRecord({ alive: false, result: undefined, reply: undefined }))).toBe('waiting')
    expect(stateOf(mkRecord({ alive: false, result: '', reply: '' }))).toBe('waiting')
    expect(stateOf(mkRecord({ alive: undefined }))).toBe('waiting')
  })
})

// ── 活躍狀態 ──────────────────────────────────────────

describe('isLive 活躍狀態檢驗', () => {
  it('狀態為 running 或 waiting 時回傳 true', () => {
    expect(isLive(mkRecord({ state: 'running' }))).toBe(true)
    expect(isLive(mkRecord({ state: 'waiting' }))).toBe(true)
    expect(isLive(mkRecord({ alive: true }))).toBe(true)
    expect(isLive(mkRecord({ alive: false, result: '' }))).toBe(true) // waiting
  })

  it('狀態為 done、failed、silent 時回傳 false', () => {
    expect(isLive(mkRecord({ state: 'done' }))).toBe(false)
    expect(isLive(mkRecord({ state: 'failed' }))).toBe(false)
    expect(isLive(mkRecord({ state: 'silent' }))).toBe(false)
    expect(isLive(mkRecord({ alive: false, result: '完成' }))).toBe(false)
  })
})

// ── Console 步驟身分與選擇 ─────────────────────────────

describe('Console 步驟以穩定 id 派工', () => {
  it('保留已有的唯一 id，並為缺少或重複 id 的舊資料補新值', () => {
    const steps = ensureStepIds([
      { id: 'keep-me', state: 'idle' as const },
      { state: 'idle' as const },
      { id: 'keep-me', state: 'failed' as const },
    ])

    expect(steps[0].id).toBe('keep-me')
    expect(new Set(steps.map((step) => step.id)).size).toBe(3)
    expect(steps[1].id).not.toBe('')
    expect(steps[2].id).not.toBe('keep-me')
  })

  it('全部派出只選 idle/未設狀態，重派只選 failed', () => {
    const steps = [
      { id: 'idle', state: 'idle' as const },
      { id: 'legacy' },
      { id: 'sending', state: 'sending' as const },
      { id: 'sent', state: 'sent' as const },
      { id: 'failed', state: 'failed' as const },
    ]

    expect(stepIdsForDispatch(steps)).toEqual(['idle', 'legacy'])
    expect(stepIdsForDispatch(steps, 'failed')).toEqual(['failed'])
  })

  it('兩步 task 相同時，單步狀態更新不會連動另一步', () => {
    const original: { id: string; task: string; state: 'idle' | 'sending' | 'sent' | 'failed' }[] = [
      { id: 'first', task: '相同任務', state: 'idle' as const },
      { id: 'second', task: '相同任務', state: 'idle' as const },
      { id: 'done', task: '其他任務', state: 'sent' as const },
    ]
    const updated = mapStepsById(original, new Set(['second']), (step) => ({ ...step, state: 'sending' as const }))

    expect(updated.map((step) => step.state)).toEqual(['idle', 'sending', 'sent'])
    expect(updated[0]).toBe(original[0])
    expect(updated[2]).toBe(original[2])
  })
})

// ── 全局完成通知轉移 ────────────────────────────────

describe('派工完成轉移追蹤', () => {
  it('第一次快照只建基線，不通知舊的已結束紀錄', () => {
    const baseline = completionTransitions(null, [
      mkRecord({ id: 'old-done', state: 'done' }),
      mkRecord({ id: 'running', state: 'running' }),
    ])

    expect(baseline.finished).toEqual([])
    expect(baseline.seen.get('old-done')).toBe(false)
    expect(baseline.seen.get('running')).toBe(true)
  })

  it('找到 running 轉 done 與兩次輪詢間直接完成的新派工', () => {
    const previous = new Map<string, boolean>([
      ['running', true],
      ['already-done', false],
    ])
    const transition = completionTransitions(previous, [
      mkRecord({ id: 'running', state: 'done' }),
      mkRecord({ id: 'fast-job', state: 'done' }),
      mkRecord({ id: 'already-done', state: 'done' }),
    ])

    expect(transition.finished.map((record) => record.id)).toEqual(['running', 'fast-job'])
    expect(transition.seen.get('running')).toBe(false)
    expect(transition.seen.get('fast-job')).toBe(false)
  })

  it('已通知的 terminal id 之後再出現不會重複通知', () => {
    const first = completionTransitions(new Map([['job', true]]), [mkRecord({ id: 'job', state: 'done' })])
    const again = completionTransitions(first.seen, [mkRecord({ id: 'job', state: 'done' })])

    expect(first.finished).toHaveLength(1)
    expect(again.finished).toEqual([])
  })

  it('只保留有上限的舊 terminal id，但不剪當前或 live id，且近期 id 仍可去重', () => {
    const previous = new Map<string, boolean>()
    for (let index = 0; index < COMPLETION_TERMINAL_HISTORY_LIMIT + 12; index += 1) {
      previous.set(`old-${index}`, false)
    }
    previous.set('hidden-live', true)

    const transition = completionTransitions(previous, [
      mkRecord({ id: 'current-live', state: 'running' }),
      mkRecord({ id: 'current-done', state: 'done' }),
    ])
    const staleTerminals = [...transition.seen].filter(
      ([id, live]) => !live && id !== 'current-done',
    )

    expect(staleTerminals).toHaveLength(COMPLETION_TERMINAL_HISTORY_LIMIT)
    expect(transition.seen.size).toBeLessThanOrEqual(COMPLETION_TERMINAL_HISTORY_LIMIT + 3)
    expect(transition.seen.has('hidden-live')).toBe(true)
    expect(transition.seen.has('current-live')).toBe(true)
    expect(transition.seen.has('current-done')).toBe(true)
    expect(transition.seen.has('old-0')).toBe(false)

    const recentId = `old-${COMPLETION_TERMINAL_HISTORY_LIMIT + 11}`
    expect(transition.seen.has(recentId)).toBe(true)
    const repeated = completionTransitions(transition.seen, [mkRecord({ id: recentId, state: 'done' })])
    expect(repeated.finished).toEqual([])
  })
})

// ── 視覺呈現 ──────────────────────────────────────────

describe('look 狀態外觀與色彩對應', () => {
  it('running：顯示「執行中」且圓點具脈衝動畫與琥珀黃', () => {
    const l = look('running')
    expect(l.label).toBe('執行中')
    expect(l.dot).toContain('animate-pulse')
    expect(l.dot).toContain('bg-amber-400')
    expect(l.tone).toContain('text-amber-300')
  })

  it('waiting：顯示「等你執行」且使用天藍色', () => {
    const l = look('waiting')
    expect(l.label).toBe('等你執行')
    expect(l.dot).toContain('bg-sky-500')
    expect(l.tone).toContain('text-sky-300')
  })

  it('failed：顯示「失敗」且使用紅色', () => {
    const l = look('failed')
    expect(l.label).toBe('失敗')
    expect(l.dot).toContain('bg-red-500')
    expect(l.tone).toContain('text-red-300')
  })

  it('silent：顯示「沒有輸出」且用語意色票的次要灰', () => {
    // 原本這裡釘的是 bg-zinc-500 / text-zinc-500。
    // 那個寫死的灰在深色底只有 4.12:1、亮色底 4.40:1，兩邊都低於 WCAG AA，
    // 已經整批換成語意色票（色票有深淺兩組值，各自量過對比）。
    // 測試改成釘「用的是色票」而不是釘某一個 Tailwind 色階 ——
    // 釘色階等於把「這個灰有多灰」寫死成規格，下次調對比又會假性失敗。
    const l = look('silent')
    expect(l.label).toBe('沒有輸出')
    expect(l.dot).toContain('bg-mute')
    expect(l.tone).toContain('text-mute')
    expect(l.tone).not.toContain('zinc')
  })

  it('done：顯示「完成」且使用翡翠綠色', () => {
    const l = look('done')
    expect(l.label).toBe('完成')
    expect(l.dot).toContain('bg-emerald-500')
    expect(l.tone).toContain('text-emerald-400/80')
  })
})
