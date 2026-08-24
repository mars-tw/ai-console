// 戰鬥存檔的測試
//
// 為什麼這件事值得測：分頁是條件渲染，切走就 unmount —— 存檔是「戰鬥不會消失」
// 的唯一依據。它壞掉的話沒有任何錯誤訊息，只會表現成「我打到一半回來就沒了」，
// 而那正是使用者回報的症狀。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Battle } from './engine'
import { loadBattle, saveBattle } from './save'

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
