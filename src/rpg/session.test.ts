// 掛機心跳的測試
//
// 要釘住的是交接規則：畫面在場時由元件跑節奏，離場才由這裡接手。
// 兩邊同時推同一場會讓一個回合被跑兩次 —— 那種錯誤在畫面上只表現成
// 「怪怎麼掉血這麼快」，不會有任何錯誤訊息，只能靠測試守住。
import { beforeEach, describe, expect, it } from 'vitest'
import { newHero, startBattle } from './engine'
import { saveBattle, saveHero } from './save'
import { _beatOnce, _reset, drainPending, setAuto, setMounted, subscribe } from './session'
import type { Battle } from './engine'

// node 環境沒有 localStorage / window，補最小替身（見 save.test.ts 的同樣理由）
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
} as Storage
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { window: { setTimeout: unknown; clearTimeout: unknown } }).window.setTimeout = (() => 0)
;(globalThis as unknown as { window: { clearTimeout: unknown } }).window.clearTimeout = (() => {})

// 用引擎自己的建構函式造真的戰鬥 —— 手刻假物件會漏欄位，
// stepBattle 一跑就炸，而且炸在跟測試意圖無關的地方。
function mkBattle(): Battle {
  return startBattle(newHero(), 'field', 'meadow', [])
}

describe('掛機心跳', () => {
  beforeEach(() => {
    mem.clear()
    _reset()
    saveHero(newHero())
  })

  it('畫面在場時不推進 —— 那時候由元件自己跑節奏', () => {
    saveBattle(mkBattle())
    setMounted(true)
    const before = JSON.parse(mem.get('ac_rpg_battle_v1')!)
    _beatOnce()
    const after = JSON.parse(mem.get('ac_rpg_battle_v1')!)
    expect(after.tick).toBe(before.tick)
  })

  it('畫面離場後才接手推進', () => {
    saveBattle(mkBattle())
    setMounted(false)
    const before = JSON.parse(mem.get('ac_rpg_battle_v1')!)
    _beatOnce()
    const after = JSON.parse(mem.get('ac_rpg_battle_v1')!)
    expect(after.tick).toBeGreaterThan(before.tick)
  })

  it('關掉自動就不推進，即使離場', () => {
    saveBattle(mkBattle())
    setMounted(false)
    setAuto(false)
    const before = JSON.parse(mem.get('ac_rpg_battle_v1')!)
    _beatOnce()
    const after = JSON.parse(mem.get('ac_rpg_battle_v1')!)
    expect(after.tick).toBe(before.tick)
  })

  it('沒有仗在打的時候不會炸', () => {
    setMounted(false)
    expect(() => _beatOnce()).not.toThrow()
  })

  it('推進之後會通知訂閱者', () => {
    saveBattle(mkBattle())
    setMounted(false)
    let hits = 0
    const off = subscribe(() => { hits += 1 })
    _beatOnce()
    off()
    expect(hits).toBe(1)
  })

  it('取消訂閱之後就不再收到通知', () => {
    saveBattle(mkBattle())
    setMounted(false)
    let hits = 0
    subscribe(() => { hits += 1 })()   // 訂閱完立刻取消
    _beatOnce()
    expect(hits).toBe(0)
  })

  it('離場期間的事件取走一次就清掉，回來不會被洗版', () => {
    saveBattle(mkBattle())
    setMounted(false)
    for (let i = 0; i < 40; i++) _beatOnce()
    const first = drainPending()
    expect(first.length).toBeLessThanOrEqual(5)   // 掛一整晚也只報最近幾件
    expect(drainPending()).toEqual([])            // 取完就清
  })
})
