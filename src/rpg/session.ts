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
import type { Battle } from './engine'
import { loadArena, loadBattle, loadHero, saveArena, saveBattle, saveHero } from './save'
import type { Hero } from './types'

/** 自動模式一拍推進一整個回合；手動模式的結算間隔在元件那側控制 */
const TICK_MS = 900

/**
 * 打完一場到自動開下一場之間要等幾拍（900ms × 4 ≈ 3.6 秒）。
 *
 * 為什麼不是零：結算那一瞬間會結算獎勵、升級、彩蛋解鎖，
 * 立刻開下一場的話玩家切回來永遠看不到自己剛剛拿到什麼。
 * 元件在場時的倒數是 3 秒，這裡取相近的值，兩邊節奏才不會差太多。
 */
const RESTART_BEATS = 4

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

/**
 * 「怎麼組下一場」由元件提供，因為它算得出這裡算不出的東西。
 *
 * 夥伴的戰力有一段加成來自本機 AI 工具的即時狀態（閒置 +15%、限流 -15%），
 * 那份狀態是 Adventure 的 props，只有元件拿得到。所以這裡不自己組隊，
 * 改成讓元件在掛上時登記一個「給我 Hero，還你一場新戰鬥」的函式。
 *
 * 存在模組層級是刻意的：元件 unmount 之後這個函式還在，
 * 掛機才接得下去 —— 那正是它唯一有用的時候。
 */
type Restart = (h: Hero) => Battle | null
let restartFn: Restart | null = null

/** 還要等幾拍才開下一場。0 = 沒有待開的場次 */
let waitBeats = 0

function notify() {
  for (const fn of listeners) fn()
}

/** 這一場結束了：記下場地，開始倒數下一場 */
function armRestart(b: Battle) {
  saveArena({ kind: b.kind, placeId: b.placeId })
  waitBeats = RESTART_BEATS
}

/**
 * 倒數到了就開下一場。
 *
 * 為什麼這件事非得在這裡做不可：
 *   元件裡也有一份 3 秒倒數，但它是 useEffect + setInterval，
 *   切去別的分頁就整個被清掉 —— 而「切去別的分頁」正是掛機的定義。
 *   只做元件那份的話，人在畫面前才會自動續戰，離開就停在結算畫面，
 *   等於掛機功能只在你盯著它看的時候有效。
 */
function maybeRestart() {
  if (waitBeats <= 0) return
  if (--waitBeats > 0) return
  const a = loadArena()
  if (!a || !restartFn) return
  const nb = restartFn(loadHero())
  if (!nb) return
  saveBattle(nb)
  pending.push('⚔️ 自動開了下一場')
  notify()
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
  // 沒有仗在打 —— 可能是剛打完（saveBattle 在 over 時是刪檔），
  // 也可能本來就沒開。有排定的下一場就繼續倒數，沒有就真的閒著。
  if (!b) { maybeRestart(); return }
  if (b.over) { armRestart(b); return }
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
  // 這一拍剛好把它打完了。armRestart 要在 saveBattle 之後 ——
  // saveBattle 會把結束的戰鬥從 localStorage 刪掉，
  // 所以場地要趁 b 還在手上的時候記起來，晚一拍就沒得問了。
  if (b.over) armRestart(b)
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
  // 畫面回來了就把倒數交還給元件（它有看得見的秒數與取消鈕）。
  // 不清掉的話兩邊各數各的，可能連開兩場。
  if (v) waitBeats = 0
  else startSession()
}

export function setAuto(v: boolean): void {
  autoOn = v
}

/**
 * 登記「怎麼組下一場」。元件掛著的每一次 render 都會重登記，
 * 這樣裡面抓到的工具狀態才是最新的；卸載後就停在最後一次的值。
 */
export function setRestart(fn: Restart | null): void {
  restartFn = fn
}

/** 玩家按了取消／返回：這一場就到此為止，不要再自動開下去 */
export function cancelRestart(): void {
  waitBeats = 0
  saveArena(null)
}

/** 給測試用：現在還要等幾拍才開下一場 */
export function _waitBeats(): number {
  return waitBeats
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
  restartFn = null
  waitBeats = 0
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
