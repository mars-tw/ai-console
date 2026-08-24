// 掛機心跳：戰鬥在你切去別的分頁時繼續打
//
// 為什麼要有這個模組：
//   心跳原本是 Adventure 元件裡的一個 useEffect，清理函式是 clearTimeout。
//   而分頁是條件渲染（`viewMode === 'rpg' ? <Adventure/> : ...`），
//   切去派工或看對話就整個 unmount → 計時器被清掉 → 自動戰鬥停住。
//   但說明檔寫的是「你切去派工、看對話的時候它照打，切回來隨時接手」。
//
//   把心跳搬到模組層級就不會被 unmount 影響 —— 模組只載入一次，
//   它的計時器跟 React 的生命週期無關。
//
// 為什麼不是「把分頁改成 CSS 隱藏」：
//   那樣辦公室的 canvas 與像素引擎也得一直活著算圖，代價比這裡大得多，
//   而且關掉 app 一樣全丟。存檔 + 模組層心跳連重開都接得回來。
//
// 這個模組刻意不碰 React：它讀寫存檔、跑戰鬥邏輯、通知訂閱者。
// 畫面要不要在場，它不在乎。
import { collect, stepBattle, stepTurn } from './engine'
import { loadBattle, loadHero, saveBattle, saveHero } from './save'
import type { Hero } from './types'

/** 自動模式一拍推進一整個回合；手動模式的結算間隔在元件那側控制 */
const TICK_MS = 900

type Listener = () => void

const listeners = new Set<Listener>()
let timer = 0
let running = false

/** 掛機開關。關掉時心跳照跳但不推進戰鬥 —— 元件在場時由它接手節奏 */
let autoOn = true
/** 元件在不在場。在場的話讓元件跑自己的節奏（手動下令要即時），這裡只負責離場後的推進 */
let mounted = false

/** 離場期間累積的事件，等畫面回來一次補報 */
const pending: string[] = []

function notify() {
  for (const fn of listeners) fn()
}

/**
 * 一拍。只在「沒有畫面在場 + 自動模式 + 有仗在打」時推進。
 *
 * 元件在場時不推進的理由：Adventure 有自己的心跳處理手動下令與結算節奏，
 * 兩邊同時推同一場會出現一回合被跑兩次。離場才交給這裡。
 */
function beat() {
  timer = window.setTimeout(beat, TICK_MS)
  if (mounted || !autoOn) return

  const b = loadBattle()
  if (!b || b.over) return
  const h: Hero = loadHero()

  stepBattle(b, h)

  if (b.xp || b.gold || b.loot.length) {
    const gained = collect(h, b)
    if (gained.secrets.length) pending.push(`🔮 解鎖隱藏技能：${gained.secrets.join('、')}`)
    else if (gained.levels > 0) pending.push(`升到 Lv.${h.level}`)
    else if (gained.allyUps.length) pending.push(`${gained.allyUps.join('、')} 升級了`)
    saveHero(h)
  }
  saveBattle(b)
  notify()
}

/** 啟動心跳。重複呼叫是安全的（模組只該有一顆計時器） */
export function startSession(): void {
  if (running) return
  running = true
  timer = window.setTimeout(beat, TICK_MS)
}

export function stopSession(): void {
  running = false
  window.clearTimeout(timer)
}

/** 畫面掛上／卸下。卸下之後這裡才會接手推進 */
export function setMounted(v: boolean): void {
  mounted = v
  if (!v) startSession()
}

export function setAuto(v: boolean): void {
  autoOn = v
}

/** 把離場期間累積的事件取走（取完就清，避免回來時洗版） */
export function drainPending(): string[] {
  if (!pending.length) return []
  const out = pending.slice(-5)     // 掛了一整晚也只報最近幾件
  pending.length = 0
  return out
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 給測試用：把模組狀態歸零 */
export function _reset(): void {
  stopSession()
  listeners.clear()
  pending.length = 0
  mounted = false
  autoOn = true
}

/** 給測試用：不靠計時器手動跑一拍 */
export function _beatOnce(): void {
  const wasRunning = running
  running = true
  const realTimeout = window.setTimeout
  // beat() 第一件事就是排下一拍，測試不需要那個
  ;(window as unknown as { setTimeout: typeof setTimeout }).setTimeout = (() => 0) as unknown as typeof setTimeout
  try { beat() } finally {
    ;(window as unknown as { setTimeout: typeof setTimeout }).setTimeout = realTimeout
    running = wasRunning
  }
}

export { stepTurn }
