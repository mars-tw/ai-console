// 存檔：純 localStorage，跟這個專案「資料不出本機」的原則一致
import { ensureRoster } from './allies'
import { newHero } from './engine'
import type { Battle } from './engine'
import type { Hero } from './types'

const KEY = 'ac_rpg_hero_v1'

export function loadHero(): Hero {
  try {
    const raw = localStorage.getItem(KEY)
    // 新角色立刻寫檔，不要等到玩家第一次操作才存
    if (!raw) { const h = newHero(); saveHero(h); return h }
    const h = JSON.parse(raw) as Hero
    // 舊存檔補齊欄位，避免改版後炸掉
    if (!Array.isArray(h.loadouts) || !h.loadouts.length) { const fresh = newHero(); saveHero(fresh); return fresh }
    h.bag ??= []
    h.kills ??= 0
    h.deaths ??= 0
    h.zone ??= 'meadow'
    // 藥水是後來加的，舊存檔沒有；補一組起始量而不是 0，
    // 否則老玩家一打開就少了一個剛做出來的操作手段
    h.potions ??= { hp: 3, mp: 2 }
    // 外觀與寵物都是後來加的，舊存檔要補
    h.look ??= 'hero'
    h.pets ??= []
    h.party ??= []
    // 夥伴、抽卡券、彩蛋都是後來加的。舊存檔要補齊，
    // 尤其 roster —— 少了它老玩家一打開會發現隊伍全空，像被沒收了一樣。
    ensureRoster(h)
    h.tickets ??= { ally: 1, gear: 1 }
    h.tickets.ally ??= 0
    h.tickets.gear ??= 0
    h.secrets ??= []
    h.tally ??= { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }
    h.potions.hp ??= 0
    h.potions.mp ??= 0
    h.active = Math.min(h.active ?? 0, h.loadouts.length - 1)
    for (const lo of h.loadouts) {
      lo.equipped ??= {}
      lo.skills ??= {}
      lo.attrs ??= { str: 0, dex: 0, int: 0, fai: 0, vit: 0 }
    }
    return h
  } catch {
    return newHero()
  }
}

export function saveHero(h: Hero) {
  try {
    localStorage.setItem(KEY, JSON.stringify(h))
  } catch {
    /* 存檔失敗不該讓遊戲中斷 */
  }
}

export function resetHero(): Hero {
  const h = newHero()
  saveHero(h)
  localStorage.removeItem(BATTLE_KEY)   // 重來就不要留著上一輪的戰鬥
  // 場地紀錄也要清。留著的話：重置完角色切去別的分頁，掛機心跳會照著
  // 上一輪的地城把新角色丟進去 —— 一隻 Lv.1 直接被高階地城秒殺。
  localStorage.removeItem(ARENA_KEY)
  return h
}

// ── 戰鬥存檔 ────────────────────────────────────────────
//
// 為什麼需要：戰鬥狀態原本只活在 Adventure 元件的 useState 裡，而分頁是
// 條件渲染（`viewMode === 'rpg' ? <Adventure/> : ...`）—— 切去派工或看對話
// 就整個 unmount，回來時戰鬥不是「暫停」是「消失」，直接退回地圖。
// 說明檔卻寫著「切去派工、看對話的時候它照打，切回來隨時接手」。
//
// 打到一半的獎勵不會丟（心跳每回合都會 collect + saveHero），丟的是那一場本身。
const BATTLE_KEY = 'ac_rpg_battle_v1'

/** log 只留尾端。一場久戰的紀錄可以長到幾百筆，整份塞進 localStorage 太浪費 */
const KEEP_LOG = 40

export function saveBattle(b: Battle | null): void {
  try {
    if (!b || b.over) { localStorage.removeItem(BATTLE_KEY); return }
    const slim: Battle = {
      ...b,
      log: b.log.slice(-KEEP_LOG),
      // fx 是給畫面做動作與跳字用的短暫特效，存下來沒有意義，
      // 而且重新載入時播一段兩天前的打擊特效很怪
      fx: [],
    }
    localStorage.setItem(BATTLE_KEY, JSON.stringify(slim))
  } catch {
    /* 存檔失敗不該讓戰鬥中斷 */
  }
}

// ── 上一場在哪裡打 ──────────────────────────────────────
//
// 為什麼要另外存一筆：
//   saveBattle() 在 b.over 時是「刪檔」，不是「存一份結束了的戰鬥」。
//   所以戰鬥一結束，kind 與 placeId 就跟著消失了。
//   掛機心跳（session.ts）醒來想自動開下一場時，手上什麼都沒有，
//   連「剛剛在哪個地圖」都不知道 —— 只能停住，掛機就等於只打一場。
//
// 這筆紀錄很小（兩個欄位），跟戰鬥本身分開存，
// 所以重新載入頁面之後也還接得回去。
const ARENA_KEY = 'ac_rpg_arena_v1'

export interface Arena {
  kind: 'field' | 'dungeon'
  placeId: string
}

export function saveArena(a: Arena | null): void {
  try {
    if (!a) { localStorage.removeItem(ARENA_KEY); return }
    localStorage.setItem(ARENA_KEY, JSON.stringify(a))
  } catch {
    /* 跟 saveBattle 一樣：存檔失敗不該讓戰鬥中斷 */
  }
}

export function loadArena(): Arena | null {
  try {
    const raw = localStorage.getItem(ARENA_KEY)
    if (!raw) return null
    const a = JSON.parse(raw) as Arena
    if (!a || (a.kind !== 'field' && a.kind !== 'dungeon')) return null
    if (typeof a.placeId !== 'string' || !a.placeId) return null
    return a
  } catch {
    return null
  }
}

export function loadBattle(): Battle | null {
  try {
    const raw = localStorage.getItem(BATTLE_KEY)
    if (!raw) return null
    const b = JSON.parse(raw) as Battle
    // 形狀不對就當作沒有。壞掉的存檔不該讓整個分頁炸掉 ——
    // 大不了少一場戰鬥，玩家重新進地圖就好。
    if (!b || typeof b !== 'object') return null
    if (!b.hero || !Array.isArray(b.foes) || !Array.isArray(b.allies)) return null
    if (b.over) { localStorage.removeItem(BATTLE_KEY); return null }
    b.log ??= []
    b.fx = []
    return b
  } catch {
    return null
  }
}
