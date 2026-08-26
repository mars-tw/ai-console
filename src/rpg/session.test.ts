// 掛機心跳的測試
//
// 要釘住的是交接規則：畫面在場時由元件跑節奏，離場才由這裡接手。
// 兩邊同時推同一場會讓一個回合被跑兩次 —— 那種錯誤在畫面上只表現成
// 「怪怎麼掉血這麼快」，不會有任何錯誤訊息，只能靠測試守住。
import { beforeEach, describe, expect, it } from 'vitest'
import { newHero, startBattle } from './engine'
import { loadArena, loadRestartIntent, saveArena, saveBattle, saveHero } from './save'
import {
  _beatOnce, _reset, _waitBeats, armRestart, cancelRestart, drainPending,
  restartPending, setAuto, setMounted, setRestart, subscribe,
} from './session'
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

/**
 * 一定會死的主角：沒有藥水，也關掉自動喝藥。
 *
 * 這些測試要的是一場**會結束**的戰鬥，但野外戰鬥是刻意無限的
 * （清完一波就生下一波），唯一的結束條件是主角倒下。
 * 主角現在會自動喝藥 —— 於是它撐得過 400 拍，測試就卡在「這場打不完」，
 * 而且單獨跑會過、全套跑會掛（戰鬥結果本來就有隨機性）。
 *
 * 不是為了配合測試去改功能，是這一組測試本來就不該依賴戰鬥平衡 ——
 * 平衡一動它就會無聲地變得不穩定。
 */
function doomedHero() {
  const h = newHero()
  h.potions = { hp: 0, mp: 0 }
  h.autoPotion = false
  return h
}

// 用引擎自己的建構函式造真的戰鬥 —— 手刻假物件會漏欄位，
// stepBattle 一跑就炸，而且炸在跟測試意圖無關的地方。
function mkBattle(): Battle {
  return startBattle(doomedHero(), 'field', 'meadow', [])
}

function mkCompletedBattle(): Battle {
  const b = mkBattle()
  b.over = true
  b.result = 'win'
  return b
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

// 這一組守的是「掛機」這個承諾本身。
//
// 元件裡也有一份 3 秒倒數，但它是 useEffect + setInterval，切分頁就被清掉 ——
// 而「切去別的分頁」正是掛機的定義。只做元件那份的話，
// 人在畫面前才會自動續戰，一離開就停在結算畫面，
// 畫面上看起來完全正常（就是一行「🏆 通關！」），沒有任何錯誤，
// 只有放著幾小時回來發現等級沒動才會發現 —— 只能靠測試守住。
describe('打完自動開下一場', () => {
  beforeEach(() => {
    mem.clear()
    _reset()
    saveHero(doomedHero())
  })

  /** 把戰鬥打到結束為止。回傳跑了幾拍，跑太多拍就是引擎那邊出問題了 */
  function fightToEnd(limit = 400): number {
    for (let i = 0; i < limit; i++) {
      _beatOnce()
      if (!mem.get('ac_rpg_battle_v1')) return i + 1
    }
    throw new Error('這場打不完，引擎可能卡住了')
  }

  it('打完之後會記下場地 —— saveBattle 是刪檔，晚一拍就問不到了', () => {
    saveBattle(startBattle(doomedHero(), 'field', 'meadow', []))
    setMounted(false)
    fightToEnd()
    expect(loadArena()).toEqual({ kind: 'field', placeId: 'meadow' })
  })

  it('倒數走完會用登記的組隊函式開下一場', () => {
    saveBattle(startBattle(doomedHero(), 'field', 'meadow', []))
    setMounted(false)
    let asked = 0
    setRestart((h) => { asked += 1; return startBattle(h, 'field', 'meadow', []) })
    fightToEnd()
    expect(asked).toBe(0)                    // 結算當下不會立刻開，要讓人看得到獎勵
    for (let i = 0; i < 5; i++) _beatOnce()
    expect(asked).toBe(1)
    expect(mem.get('ac_rpg_battle_v1')).toBeTruthy()
  })

  it('沒有登記組隊函式就不硬開 —— 寧可停著，也不要組出一支空隊伍去送死', () => {
    saveArena({ kind: 'field', placeId: 'meadow' })
    setMounted(false)
    setRestart(null)
    for (let i = 0; i < 10; i++) _beatOnce()
    expect(mem.get('ac_rpg_battle_v1')).toBeFalsy()
  })

  it('玩家按取消之後就不再自動開', () => {
    saveBattle(startBattle(doomedHero(), 'field', 'meadow', []))
    setMounted(false)
    let asked = 0
    setRestart((h) => { asked += 1; return startBattle(h, 'field', 'meadow', []) })
    fightToEnd()
    cancelRestart()
    expect(loadRestartIntent()).toBeNull()
    for (let i = 0; i < 10; i++) _beatOnce()
    expect(asked).toBe(0)
    expect(loadArena()).toBeNull()
  })

  it('看得見的倒數中離場，掛機心跳會接手同一筆意圖', () => {
    const done = mkCompletedBattle()
    saveBattle(done)                         // 完成戰鬥照既有規則已從存檔移除
    expect(mem.get('ac_rpg_battle_v1')).toBeFalsy()
    setMounted(true)
    let asked = 0
    setRestart((h) => { asked += 1; return startBattle(h, 'field', 'meadow', []) })
    armRestart(done)                         // Adventure 的可見 3 秒倒數
    expect(loadRestartIntent()).not.toBeNull()

    setMounted(false)                        // interval 被 unmount 清掉，模組接手
    for (let i = 0; i < 5; i++) _beatOnce()
    expect(asked).toBe(1)
    expect(mem.get('ac_rpg_battle_v1')).toBeTruthy()
    expect(loadRestartIntent()).toBeNull()
  })

  it('離場倒數中回到畫面，不會清掉待開意圖，且只能領取一次', () => {
    const done = mkCompletedBattle()
    setMounted(false)
    let asked = 0
    setRestart((h) => { asked += 1; return startBattle(h, 'field', 'meadow', []) })
    armRestart(done)
    _beatOnce()
    const left = _waitBeats()
    expect(left).toBeGreaterThan(0)

    setMounted(true)
    expect(_waitBeats()).toBe(left)
    expect(loadRestartIntent()).not.toBeNull()
    expect(restartPending()).not.toBeNull()  // Adventure 接回可見倒數後到點
    expect(restartPending()).toBeNull()      // 心跳同時到點也不能再開一場
    expect(asked).toBe(1)
  })

  it('重新載入會從 localStorage 恢復待開意圖與倒數', () => {
    const done = mkCompletedBattle()
    setMounted(true)
    armRestart(done)
    expect(loadRestartIntent()).not.toBeNull()

    _reset()                                 // 模擬模組重新載入：只清記憶、不清存檔
    let asked = 0
    setRestart((h) => { asked += 1; return startBattle(h, 'field', 'meadow', []) })
    setMounted(false)
    expect(_waitBeats()).toBeGreaterThan(0)
    for (let i = 0; i < 10 && asked === 0; i++) _beatOnce()
    expect(asked).toBe(1)
    expect(loadRestartIntent()).toBeNull()
  })

  it('關掉自動就不會自動開下一場', () => {
    saveBattle(startBattle(doomedHero(), 'field', 'meadow', []))
    setMounted(false)
    let asked = 0
    setRestart((h) => { asked += 1; return startBattle(h, 'field', 'meadow', []) })
    fightToEnd()
    setAuto(false)
    expect(loadRestartIntent()).toBeNull()
    expect(loadArena()).toBeNull()
    for (let i = 0; i < 10; i++) _beatOnce()
    expect(asked).toBe(0)
  })
})
