// 存檔：純 localStorage，跟這個專案「資料不出本機」的原則一致
import { checkSecretAllies, ensureRoster, syncSecretAllies } from './allies'
import { newHero } from './engine'
import type { Battle } from './engine'
import { rememberUniques, syncUniques } from './secrets'
import { partyCapOf, type Hero } from './types'

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
    // 舊存檔沒有這個欄位。預設開 —— 抱著一整包藥水戰到死不是任何人要的
    h.autoPotion ??= true
    h.tally ??= { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }
    h.potions.hp ??= 0
    h.potions.mp ??= 0
    h.active = Math.min(h.active ?? 0, h.loadouts.length - 1)
    for (const lo of h.loadouts) {
      lo.equipped ??= {}
      lo.skills ??= {}
      lo.attrs ??= { str: 0, dex: 0, int: 0, fai: 0, vit: 0 }
    }

    // ── 彩蛋裝備／彩蛋夥伴／隊伍上限：讀檔時補課 ──
    //
    // 這四行的順序有意義：
    //   1. rememberUniques 先把背包裡既有的彩蛋裝備補進永久紀錄，
    //      不然改版之後老玩家手上那幾件會被當成「沒拿過」而重複掉。
    //   2. syncUniques 把它們拉到現在的等級。舊存檔的彩蛋裝備是
    //      「取得那一刻的數值」，Lv.8 拿到的到 Lv.40 已經是廢鐵，
    //      而它永遠拿不到第二件。
    //   3./4. 彩蛋夥伴同理：解鎖條件可能在上一版就達成了，補發並對齊等級。
    rememberUniques(h)
    syncUniques(h)
    checkSecretAllies(h)
    syncSecretAllies(h)
    // 存檔被改壞也不能讓隊伍上限跑到範圍外 —— partyCapOf 會夾住
    h.partyCap = partyCapOf(h)
    // 隊伍本身也要夾。只夾上限不夾名單的話，舊存檔（或手改過的存檔）
    // 會出現「隊伍 5 / 4 人」這種畫面，而且下一場真的帶五個上去 ——
    // 那個設定就變成純裝飾。實測就是這樣露餡的。
    h.party = (h.party ?? []).slice(0, Math.max(0, h.partyCap - 1))
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
  localStorage.removeItem(RESTART_KEY)
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

// ── 下一場倒數 ──────────────────────────────────────────
//
// 結束的戰鬥不會留在 BATTLE_KEY；只存 ARENA_KEY 又分不出「正在打一場」和
// 「這場打完、正等著重開」。因此倒數意圖要有自己的存檔。用絕對時間而不是
// 元件內的秒數，切分頁或重新載入後才能接著剩餘時間走，而不是每次都重數三秒。
const RESTART_KEY = 'ac_rpg_restart_v1'

export interface RestartIntent {
  dueAt: number
}

export function saveRestartIntent(intent: RestartIntent | null): void {
  try {
    if (!intent) { localStorage.removeItem(RESTART_KEY); return }
    localStorage.setItem(RESTART_KEY, JSON.stringify(intent))
  } catch {
    /* 跟其他存檔一樣：儲存失敗不能讓遊戲中斷 */
  }
}

export function loadRestartIntent(): RestartIntent | null {
  try {
    const raw = localStorage.getItem(RESTART_KEY)
    if (!raw) return null
    const intent = JSON.parse(raw) as RestartIntent
    if (!intent || !Number.isFinite(intent.dueAt) || intent.dueAt <= 0) {
      localStorage.removeItem(RESTART_KEY)
      return null
    }
    return intent
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
