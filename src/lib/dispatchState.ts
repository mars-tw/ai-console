// 派工狀態的顯示規則
//
// 主控台與辦公室的中控指揮台各有一份清單，之前兩邊各自用
// `d.alive ? '執行中' : d.result ? '完成' : '已開終端'` 判斷 ——
// 同一件事寫兩次，而且都判錯：無頭跑完但沒輸出的會被說成「已開終端」，
// 早就結束的工單也一直掛在「執行中的派工」底下。
//
// 現在狀態由伺服器導出（那裡才有 pid 與 log 可以查），這裡只負責怎麼顯示。

import { t } from '@/i18n'
import type { DispatchRecord } from '@/types/data'

export type DispatchState = NonNullable<DispatchRecord['state']>

/** 舊資料沒有 state 欄位時的退路，不要讓畫面開天窗 */
export function stateOf(d: DispatchRecord): DispatchState {
  if (d.state) return d.state
  if (d.alive) return 'running'
  return d.result || d.reply ? 'done' : 'waiting'
}

export const isLive = (d: DispatchRecord) => {
  const s = stateOf(d)
  // cancelled 不算 live —— 取消的整個意義就是「不要再把它算成待辦」。
  // 漏掉這裡的話，取消完清單標題還是寫著「3 件進行中」，
  // 而那個數字正是使用者用來判斷「還有沒有事情等我」的東西。
  return s === 'running' || s === 'waiting'
}

interface Look { label: string; dot: string; tone: string }

/** 狀態 → 文字、圓點顏色、文字顏色 */
export function look(s: DispatchState): Look {
  switch (s) {
    case 'running':
      return { label: t('執行中'), dot: 'animate-pulse bg-amber-400', tone: 'text-amber-300' }
    case 'waiting':
      // 這是最容易被誤會成「已經在跑」的狀態：終端開了，但沒人讓它動
      return { label: t('等你執行'), dot: 'bg-sky-500', tone: 'text-sky-300' }
    case 'failed':
      return { label: t('失敗'), dot: 'bg-red-500', tone: 'text-red-300' }
    case 'silent':
      return { label: t('沒有輸出'), dot: 'bg-mute2', tone: 'text-mute2' }
    case 'stopped':
      // 使用者按了停止：行程被砍、工作沒做完。不是失敗、更不是完成。
      return { label: t('已停止'), dot: 'bg-mute3', tone: 'text-mute3' }
    case 'cancelled':
      return { label: t('已取消'), dot: 'bg-mute3', tone: 'text-mute3' }
    default:
      return { label: t('完成'), dot: 'bg-emerald-500', tone: 'text-emerald-400/80' }
  }
}
