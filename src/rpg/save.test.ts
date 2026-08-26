// 戰鬥存檔的測試
//
// 為什麼這件事值得測：分頁是條件渲染，切走就 unmount —— 存檔是「戰鬥不會消失」
// 的唯一依據。它壞掉的話沒有任何錯誤訊息，只會表現成「我打到一半回來就沒了」，
// 而那正是使用者回報的症狀。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Battle } from './engine'
import { loadBattle, loadHero, saveBattle } from './save'

// vitest 跑在 node 環境（見 vite.config.ts：純函式測試不需要 DOM，啟動快很多）。
// 為了這幾個測試引進 jsdom 不划算 —— 這個專案的相依少是刻意的。
// 存檔只用到 getItem/setItem/removeItem/clear，一個記憶體替身就夠。
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
} as Storage

/** 最小可用的 Battle。只放 load 會檢查的欄位，其餘用 as 補齊 */
function mkBattle(over = false): Battle {
  return {
    kind: 'field',
    placeId: 'meadow',
    room: 1,
    rooms: 1,
    hero: { name: '你', hp: 50, maxHp: 100 },
    pet: null,
    allies: [],
    foes: [{ name: '史萊姆', hp: 10, maxHp: 10 }],
    log: [],
    fx: [],
    heroWeapon: null,
    heroLook: 'hero',
    tick: 3,
    over,
  } as unknown as Battle
}

describe('戰鬥存檔', () => {
  beforeEach(() => localStorage.clear())

  it('存了就讀得回來', () => {
    saveBattle(mkBattle())
    const b = loadBattle()
    expect(b).not.toBeNull()
    expect(b?.placeId).toBe('meadow')
    expect(b?.tick).toBe(3)
    expect(b?.hero.hp).toBe(50)
  })

  it('沒有存檔時回 null', () => {
    expect(loadBattle()).toBeNull()
  })

  it('結束的戰鬥不留存檔', () => {
    saveBattle(mkBattle())
    expect(loadBattle()).not.toBeNull()
    saveBattle(mkBattle(true))          // over = true
    expect(loadBattle()).toBeNull()
  })

  it('存 null 等於清掉', () => {
    saveBattle(mkBattle())
    saveBattle(null)
    expect(loadBattle()).toBeNull()
  })

  it('log 只留尾端，不要把幾百筆塞進 localStorage', () => {
    const b = mkBattle()
    b.log = Array.from({ length: 300 }, (_, i) => ({ t: i } as unknown as Battle['log'][number]))
    saveBattle(b)
    const got = loadBattle()
    expect(got!.log.length).toBeLessThanOrEqual(40)
    // 留的要是最後那幾筆，不是最前面
    expect((got!.log.at(-1) as unknown as { t: number }).t).toBe(299)
  })

  it('fx 不存 —— 重新載入時播一段兩天前的打擊特效很怪', () => {
    const b = mkBattle()
    b.fx = [{ kind: 'hit' } as unknown as Battle['fx'][number]]
    saveBattle(b)
    expect(loadBattle()!.fx).toEqual([])
  })

  it('壞掉的存檔當作沒有，不要讓整個分頁炸掉', () => {
    localStorage.setItem('ac_rpg_battle_v1', '{ 這不是合法 JSON')
    expect(loadBattle()).toBeNull()
  })

  it('形狀不對也當作沒有', () => {
    for (const bad of ['null', '123', '"字串"', '{}', '{"hero":{}}']) {
      localStorage.setItem('ac_rpg_battle_v1', bad)
      expect(loadBattle()).toBeNull()
    }
  })
})

// ── 讀檔補課：彩蛋與隊伍上限 ──────────────────────────
//
// 這一組是模擬實驗抓出來的。把程式跑起來、寫一個「上一版存的」存檔進去，
// 畫面顯示「隊伍 5 / 4 人（含你）」—— 上限夾了，名單沒夾，
// 於是設定變成純裝飾，下一場真的帶五個上去。
describe('loadHero 的舊存檔補課', () => {
  const KEY = 'ac_rpg_hero_v1'

  /** 上一版格式的存檔：沒有 partyCap、沒有 uniquesFound、彩蛋裝備是 legend */
  const oldSave = (over: Record<string, unknown> = {}) => JSON.stringify({
    name: '你', look: 'hero', level: 40, xp: 0, gold: 0,
    kills: 500, deaths: 20, zone: 'meadow', active: 0,
    potions: { hp: 3, mp: 2 }, pets: [],
    bag: [{
      id: 'u1', name: '除錯者之刃', slot: 'main', rarity: 'legend',
      ilvl: 8, line: 'melee', atk: 70, def: 0, affixes: [], unique: 'u-debugger', plus: 5,
    }],
    loadouts: [{ name: '主要', equipped: {}, skills: {}, attrs: { str: 0, dex: 0, int: 0, fai: 0, vit: 0 } }],
    party: ['kimi', 'claude', 'codex', 'grok'],
    roster: [], tickets: { ally: 0, gear: 0 },
    secrets: ['avenger', 'giantslayer', 'ironhand', 'luckyhand', 'collector', 'ascetic'],
    tally: { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 15 },
    ...over,
  })

  beforeEach(() => { mem.clear() })

  it('隊伍名單要夾到上限，不能只夾上限本身', () => {
    mem.set(KEY, oldSave())
    const h = loadHero()
    expect(h.partyCap).toBe(4)
    expect(h.party?.length).toBe(3)   // 4 人上限扣掉主角
  })

  it('上限被改小時，名單跟著切', () => {
    mem.set(KEY, oldSave({ partyCap: 3 }))
    expect(loadHero().party?.length).toBe(2)
  })

  it('舊的彩蛋裝備要升到神話並跟上等級', () => {
    // Lv.8 拿到的那把劍，玩到 Lv.40 就是廢鐵 —— 而它永遠拿不到第二把
    mem.set(KEY, oldSave())
    const sword = loadHero().bag.find((i) => i.unique === 'u-debugger')!
    expect(sword.rarity).toBe('mythic')
    expect(sword.ilvl).toBe(40)
    expect(sword.atk).toBeGreaterThan(70)
    expect(sword.plus).toBe(5)        // 玩家自己強化的不能被洗掉
  })

  it('背包裡既有的彩蛋裝備要補進永久紀錄', () => {
    // 少了這一步，改版之後老玩家手上那幾件會被當成「沒拿過」而重複掉
    mem.set(KEY, oldSave())
    expect(loadHero().uniquesFound).toContain('u-debugger')
  })

  it('上一版就達成的彩蛋夥伴條件要補發', () => {
    mem.set(KEY, oldSave())
    const h = loadHero()
    expect(h.secretAllies).toContain('archivist')   // kills >= 500
    expect(h.secretAllies).toContain('revenant')    // deaths >= 20
    expect(h.secretAllies).toContain('smith')       // breaks >= 15
    expect(h.secretAllies).toContain('chorus')      // 六個彩蛋技能全開
  })

  it('補發的彩蛋夥伴等級要對齊主角', () => {
    mem.set(KEY, oldSave())
    const h = loadHero()
    const secret = h.roster?.find((r) => r.kind === 'archivist')
    expect(secret?.level).toBe(40)
  })

  it('條件沒達成的不會憑空出現', () => {
    mem.set(KEY, oldSave({ kills: 0, deaths: 0, secrets: [], tally: { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 } }))
    expect(loadHero().secretAllies ?? []).toEqual([])
  })
})
