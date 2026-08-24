// 前端派工生命週期的純邏輯：Console 步驟身分，以及 App 層完成轉移。
// 不依賴 DOM，可在現有的 Node/Vitest 環境直接驗證。

import { isLive } from '@/lib/dispatchState'
import type { DispatchRecord } from '@/types/data'

/** Console 計畫步驟會用到的最小身分與狀態形狀。 */
export interface DispatchableStep {
  id?: string
  state?: 'idle' | 'sending' | 'sent' | 'failed'
}

let stepSequence = 0

/**
 * 產生一個不依賴 task 內容的步驟 id。
 *
 * 不用任務文字當身分：同一個計畫完全可能有兩步同名工作，
 * 而且使用者送出前還會編輯 task。時間戳加模組序號讓同一毫秒內也不會撞 id，
 * 同時能在 Vitest/Node 環境運作，不依賴 browser crypto。
 */
export function createStepId(): string {
  stepSequence += 1
  return `step-${Date.now().toString(36)}-${stepSequence.toString(36)}`
}

/**
 * 補齊舊 localStorage 資料的 id，並修復重複 id。
 * 已有且未重複的 id 會原樣保留，所以重新渲染不會改變身分。
 */
export function ensureStepIds<T extends DispatchableStep>(steps: T[]): (T & { id: string })[] {
  const used = new Set<string>()
  return steps.map((step) => {
    const candidate = typeof step.id === 'string' ? step.id.trim() : ''
    let id = candidate && !used.has(candidate) ? candidate : createStepId()
    while (used.has(id)) id = createStepId()
    used.add(id)
    return step.id === id ? step as T & { id: string } : { ...step, id }
  })
}

export type StepDispatchMode = 'pending' | 'failed'

/**
 * 只選出本次真的應該送的 id。
 * pending 僅含尚未送出的 idle/舊資料未設狀態；failed 僅含失敗步驟。
 */
export function stepIdsForDispatch<T extends DispatchableStep & { id: string }>(
  steps: T[],
  mode: StepDispatchMode = 'pending',
): string[] {
  return steps
    .filter((step) => mode === 'failed' ? step.state === 'failed' : step.state == null || step.state === 'idle')
    .map((step) => step.id)
}

/** 只修改指定 id；task 完全一樣的其他步驟不會被連動。 */
export function mapStepsById<T extends { id: string }>(
  steps: T[],
  ids: ReadonlySet<string>,
  update: (step: T) => T,
): T[] {
  return steps.map((step) => ids.has(step.id) ? update(step) : step)
}

export interface CompletionTransition<T extends DispatchRecord> {
  finished: T[]
  seen: Map<string, boolean>
}

/** 只保留最近這些「已結束且不在當前 API 快照」的 id。 */
export const COMPLETION_TERMINAL_HISTORY_LIMIT = 256

function rememberCompletion(seen: Map<string, boolean>, id: string, live: boolean): void {
  // Map 的插入順序就是我們的近期順序；先刪再寫才會把當前 id 移到尾端。
  seen.delete(id)
  seen.set(id, live)
}

function pruneCompletionHistory(seen: Map<string, boolean>, currentIds: ReadonlySet<string>): void {
  const staleTerminalIds: string[] = []
  for (const [id, live] of seen) {
    // 當前快照與尚未結束的 id 一律保留；只剪掉舊 terminal 歷史。
    if (!live && !currentIds.has(id)) staleTerminalIds.push(id)
  }
  const excess = staleTerminalIds.length - COMPLETION_TERMINAL_HISTORY_LIMIT
  for (let index = 0; index < excess; index += 1) seen.delete(staleTerminalIds[index])
}

/**
 * 比對兩次 /api/dispatches 快照，找出剛結束的派工。
 *
 * - previous=null 是第一次快照，只建立基線，不把舊紀錄全通知一遍。
 * - 之前是 live、現在結束：正常完成轉移。
 * - 基線後第一次看到就已結束：數秒內完成、兩次輪詢間跑完的快任務。
 *
 * seen 保留已看過的 terminal id，即使它暫時掉出 API 清單又出現，
 * 也不會重複通知。
 */
export function completionTransitions<T extends DispatchRecord>(
  previous: ReadonlyMap<string, boolean> | null,
  current: T[],
): CompletionTransition<T> {
  const seen = new Map(previous ?? [])
  const currentIds = new Set(current.map((record) => record.id))
  const finished: T[] = []
  for (const record of current) {
    const live = isLive(record)
    const before = previous?.get(record.id)
    if (previous !== null && !live && (before === true || before === undefined)) finished.push(record)
    rememberCompletion(seen, record.id, live)
  }
  pruneCompletionHistory(seen, currentIds)
  return { finished, seen }
}
