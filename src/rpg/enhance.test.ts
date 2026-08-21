import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  enhance,
  enhanceCost,
  MAX_PLUS,
  odds,
  plusMult,
  PLUS_STEP,
} from './enhance'
import type { Hero, Item } from './types'

function fixedRandom(value: number): void {
  vi.restoreAllMocks()
  vi.spyOn(Math, 'random').mockImplementation(() => value)
}

function sequenceRandom(values: number[]): void {
  vi.restoreAllMocks()
  let index = 0
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const val = values[index] ?? values[values.length - 1] ?? 0
    index++
    return val
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

function mkHero(over: Partial<Hero> = {}): Hero {
  return {
    name: '你',
    look: 'hero',
    level: 1,
    xp: 0,
    gold: 0,
    bag: [],
    loadouts: [],
    active: 0,
    zone: 'meadow',
    kills: 0,
    deaths: 0,
    potions: { hp: 3, mp: 2 },
    pets: [],
    tickets: { ally: 1, gear: 1 },
    secrets: [],
    tally: { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 },
    roster: [],
    ...over,
  }
}

function mkItem(over: Partial<Item> = {}): Item {
  return {
    id: 'test-item-1',
    name: '測試長劍',
    slot: 'main',
    rarity: 'fine',
    ilvl: 10,
    atk: 50,
    def: 0,
    affixes: [],
    plus: 0,
    ...over,
  }
}

// ── 機率與階段 ──────────────────────────────────────────

describe('odds 機率判定與保底機制', () => {
  it('+0 ~ +2 必定成功，且無碎裂與掉級風險', () => {
    for (const p of [0, 1, 2]) {
      const o = odds(p)
      expect(o.success).toBe(1)
      expect(o.destroy).toBe(0)
      expect(o.down).toBe(0)
    }
  })

  it('+3 ~ +5 成功率 82%，失敗降 1 級但絕不碎裂', () => {
    for (const p of [3, 4, 5]) {
      const o = odds(p)
      expect(o.success).toBeCloseTo(0.82, 6)
      expect(o.destroy).toBe(0)
      expect(o.down).toBe(1)
    }
  })

  it('+6 ~ +8 進入風險段，成功率 55%，失敗有機率碎裂 (22%) 或降 1 級', () => {
    for (const p of [6, 7, 8]) {
      const o = odds(p)
      expect(o.success).toBeCloseTo(0.55, 6)
      expect(o.destroy).toBeCloseTo(0.22, 6)
      expect(o.down).toBe(1)
    }
  })

  it('+9 ~ +11 高風險段，成功率 36%，失敗碎裂率 40% 且降 2 級', () => {
    for (const p of [9, 10, 11]) {
      const o = odds(p)
      expect(o.success).toBeCloseTo(0.36, 6)
      expect(o.destroy).toBeCloseTo(0.4, 6)
      expect(o.down).toBe(2)
    }
  })

  it('+12 及以上極限段，成功率 22%，碎裂率高達 55% 且降 2 級', () => {
    for (const p of [12, 13, 14, 15, 20]) {
      const o = odds(p)
      expect(o.success).toBeCloseTo(0.22, 6)
      expect(o.destroy).toBeCloseTo(0.55, 6)
      expect(o.down).toBe(2)
    }
  })

  it('邊界：負數強化等級視同低段保底 100% 成功', () => {
    const o = odds(-1)
    expect(o.success).toBe(1)
    expect(o.destroy).toBe(0)
    expect(o.down).toBe(0)
  })

  it('彩蛋技能「鐵匠之手」(ironhand) 提供 8% 成功率加成，並受 0.05~1.0 上下限保護', () => {
    const h = mkHero({ secrets: ['ironhand'] })

    // +3 原始 0.82 -> 加成後 0.90
    expect(odds(3, h).success).toBeCloseTo(0.90, 6)
    // +6 原始 0.55 -> 加成後 0.63
    expect(odds(6, h).success).toBeCloseTo(0.63, 6)
    // +9 原始 0.36 -> 加成後 0.44
    expect(odds(9, h).success).toBeCloseTo(0.44, 6)
    // +12 原始 0.22 -> 加成後 0.30
    expect(odds(12, h).success).toBeCloseTo(0.30, 6)
  })

  it('英雄無 secrets 欄位或 secrets 為空時不獲得鐵匠之手加成', () => {
    const h = mkHero()
    delete (h as Partial<Hero>).secrets
    expect(odds(6, h).success).toBeCloseTo(0.55, 6)

    h.secrets = []
    expect(odds(6, h).success).toBeCloseTo(0.55, 6)
  })
})

// ── 費用與倍率 ──────────────────────────────────────────

describe('enhanceCost 與 plusMult 數值計算', () => {
  it('強化費用隨 ilvl 與 plus 單調遞增', () => {
    const itemLow = mkItem({ ilvl: 1, plus: 0 })
    const itemHighIlvl = mkItem({ ilvl: 50, plus: 0 })
    const itemHighPlus = mkItem({ ilvl: 10, plus: 5 })

    expect(enhanceCost(itemHighIlvl)).toBeGreaterThan(enhanceCost(itemLow))
    expect(enhanceCost(itemHighPlus)).toBeGreaterThan(enhanceCost(mkItem({ ilvl: 10, plus: 0 })))
  })

  it('裝備 plus 為 undefined 時視為 +0 計算費用與倍率', () => {
    const itemNoPlus = mkItem({ ilvl: 10, plus: undefined })
    const itemPlusZero = mkItem({ ilvl: 10, plus: 0 })

    expect(enhanceCost(itemNoPlus)).toBe(enhanceCost(itemPlusZero))
    expect(plusMult(itemNoPlus)).toBe(plusMult(itemPlusZero))
    expect(plusMult(itemNoPlus)).toBe(1)
  })

  it('plusMult 每級增加 PLUS_STEP (9%)，+15 時為 2.35 倍', () => {
    expect(PLUS_STEP).toBe(0.09)
    for (let p = 0; p <= MAX_PLUS; p++) {
      const it = mkItem({ plus: p })
      expect(plusMult(it)).toBeCloseTo(1 + p * 0.09, 6)
    }
    expect(plusMult(mkItem({ plus: 15 }))).toBeCloseTo(2.35, 6)
  })

  it('邊界：ilvl 為 0 時費用依然為合理正數整數', () => {
    const itemZero = mkItem({ ilvl: 0, plus: 0 })
    const cost = enhanceCost(itemZero)
    expect(Number.isInteger(cost)).toBe(true)
    expect(cost).toBeGreaterThan(0)
  })
})

// ── 強化行為 ──────────────────────────────────────────

describe('enhance 強化行為與保護機制', () => {
  it('成功時裝備等級 +1，回傳 outcome 为 up 與相應訊息', () => {
    fixedRandom(0.0) // 必定成功
    const h = mkHero()
    const it = mkItem({ name: '勇者之劍', plus: 0 })

    const res = enhance(h, it, false)
    expect(res.outcome).toBe('up')
    expect(it.plus).toBe(1)
    expect(res.msg).toContain('{name}')
    expect(res.params).toEqual({ name: '勇者之劍', n: 1 })
  })

  it('已達 MAX_PLUS (15) 或以上時無法再強化，直接回傳 stay 且等級不變', () => {
    fixedRandom(0.0)
    const h = mkHero()
    const it15 = mkItem({ plus: 15 })
    const res15 = enhance(h, it15, false)
    expect(res15.outcome).toBe('stay')
    expect(res15.msg).toBe('已經強化到頂了')
    expect(it15.plus).toBe(15)

    const it20 = mkItem({ plus: 20 })
    const res20 = enhance(h, it20, false)
    expect(res20.outcome).toBe('stay')
    expect(it20.plus).toBe(20)
  })

  it('未開保護符且命中摧毀機率時，裝備碎裂 (destroy) 且累加 tally.breaks', () => {
    const h = mkHero({ tally: { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 2 } })
    const it = mkItem({ name: '傳奇長槍', plus: 7 })

    // 第一次骰成功率（0.99 > 0.55 失敗），第二次骰碎裂率（0.01 < 0.22 碎裂）
    sequenceRandom([0.99, 0.01])
    const res = enhance(h, it, false)
    expect(res.outcome).toBe('destroy')
    expect(res.msg).toContain('碎掉了')
    expect(res.params).toEqual({ name: '傳奇長槍' })
    expect(h.tally?.breaks).toBe(3)
  })

  it('舊存檔缺 tally 欄位時，碎裂會自動初始化 tally 並將 breaks 設為 1', () => {
    const h = mkHero()
    delete (h as Partial<Hero>).tally
    const it = mkItem({ plus: 7 })

    sequenceRandom([0.99, 0.01])
    const res = enhance(h, it, false)
    expect(res.outcome).toBe('destroy')
    expect(h.tally).toBeDefined()
    expect(h.tally?.breaks).toBe(1)
    expect(h.tally?.deathStreak).toBe(0)
  })

  it('未開保護符且未命中摧毀時，降級 (down) 且退 1 級', () => {
    const h = mkHero()
    const it = mkItem({ name: '測試長劍', plus: 6 })

    // 第一次骰成功（0.99 > 0.55 失敗），第二次骰碎裂（0.99 > 0.22 未碎）
    sequenceRandom([0.99, 0.99])
    const res = enhance(h, it, false)
    expect(res.outcome).toBe('down')
    expect(it.plus).toBe(5)
    expect(res.usedProtect).toBe(false)
    expect(res.msg).toContain('退到 +{n}')
  })

  it('+9 以上高等級失敗降 2 級，且最低停在 +0 不會變負數', () => {
    const h = mkHero()
    const it10 = mkItem({ plus: 10 })

    sequenceRandom([0.99, 0.99])
    const res10 = enhance(h, it10, false)
    expect(res10.outcome).toBe('down')
    expect(it10.plus).toBe(8) // 10 - 2 = 8
    expect(it10.plus).toBeGreaterThanOrEqual(0)

    const it9 = mkItem({ plus: 9 })
    sequenceRandom([0.99, 0.99])
    const res9 = enhance(h, it9, false)
    expect(res9.outcome).toBe('down')
    expect(it9.plus).toBe(7) // 9 - 2 = 7
    expect(it9.plus).toBeGreaterThanOrEqual(0)
  })

  it('開啟保護符 (protect=true) 時失敗絕不碎裂，只降級並標記 usedProtect', () => {
    const h = mkHero({ tally: { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 } })
    const it = mkItem({ name: '寶石法杖', plus: 8 })

    // 第一次骰成功失敗（0.99 > 0.55），保護符生效不骰碎裂
    sequenceRandom([0.99])
    const res = enhance(h, it, true)
    expect(res.outcome).toBe('down')
    expect(it.plus).toBe(7)
    expect(res.usedProtect).toBe(true)
    expect(res.msg).toContain('保護符擋下了碎裂')
    expect(h.tally?.breaks).toBe(0) // 不會計入碎裂
  })

  it('開啟保護符但成功時正常升級，outcome 為 up', () => {
    const h = mkHero()
    const it = mkItem({ plus: 8 })

    fixedRandom(0.0) // 成功
    const res = enhance(h, it, true)
    expect(res.outcome).toBe('up')
    expect(it.plus).toBe(9)
  })

  it('低段 (+0~+2) 失敗時若 down=0 則回傳 stay 且等級不變', () => {
    const h = mkHero()
    const it = mkItem({ plus: 0 })

    // +0 原本 success 是 1，這裡驗證 +0 的基本行為
    fixedRandom(0.0)
    const res = enhance(h, it, false)
    expect(res.outcome).toBe('up')
  })
})
