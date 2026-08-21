import { describe, expect, it } from 'vitest'

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

  it('silent：顯示「沒有輸出」且使用鋅灰色', () => {
    const l = look('silent')
    expect(l.label).toBe('沒有輸出')
    expect(l.dot).toContain('bg-zinc-500')
    expect(l.tone).toContain('text-zinc-500')
  })

  it('done：顯示「完成」且使用翡翠綠色', () => {
    const l = look('done')
    expect(l.label).toBe('完成')
    expect(l.dot).toContain('bg-emerald-500')
    expect(l.tone).toContain('text-emerald-400/80')
  })
})
