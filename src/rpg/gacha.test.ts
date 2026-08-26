import { afterEach, describe, expect, it, vi } from 'vitest'

import { GACHA_POOL } from './allies'
import {
  ALLY_PULL_GOLD,
  floorAt,
  GEAR_PULL_GOLD,
  pullAlly,
  pullGear,
  tenCost,
} from './gacha'
import { UNIQUES } from './secrets'
import type { Hero, Rarity } from './types'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fixedRandom(value: number): void {
  vi.restoreAllMocks()
  vi.spyOn(Math, 'random').mockImplementation(() => value)
}

function seededRandom(seed: number): void {
  vi.restoreAllMocks()
  vi.spyOn(Math, 'random').mockImplementation(mulberry32(seed))
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

afterEach(() => {
  vi.restoreAllMocks()
})

// ── 費用與保底位置 ──────────────────────────────────────

describe('tenCost 十連抽費用規則', () => {
  it('十連抽費用為單抽費用的 9 倍（付九抽的價格）', () => {
    expect(tenCost(ALLY_PULL_GOLD)).toBe(ALLY_PULL_GOLD * 9)
    expect(tenCost(GEAR_PULL_GOLD)).toBe(GEAR_PULL_GOLD * 9)
    expect(tenCost(100)).toBe(900)
  })

  it('邊界：單抽 0 金幣時十連費用為 0，負數費用計算一致', () => {
    expect(tenCost(0)).toBe(0)
    expect(tenCost(-50)).toBe(-450)
  })
})

describe('floorAt 十連保底位置判定', () => {
  it('十抽 (n=10) 只有最後一抽 (i=9) 提供 rare 保底', () => {
    for (let i = 0; i < 9; i++) {
      expect(floorAt(i, 10)).toBeUndefined()
    }
    expect(floorAt(9, 10)).toBe('rare')
  })

  it('邊界：單抽 (n=1) 時第 0 抽即為保底位', () => {
    expect(floorAt(0, 1)).toBe('rare')
    expect(floorAt(1, 1)).toBeUndefined()
  })

  it('邊界：n 為 0 時任何索引皆不提供保底', () => {
    expect(floorAt(0, 0)).toBeUndefined()
    expect(floorAt(-1, 0)).toBe('rare') // -1 === 0 - 1
  })
})

// ── 夥伴抽取 ──────────────────────────────────────────

describe('pullAlly 夥伴抽取與養成機制', () => {
  it('抽取未持有的夥伴：加入 roster，初始等級 1 且 dupeXp 為 0', () => {
    const h = mkHero({ roster: [] })
    fixedRandom(0.1)

    const result = pullAlly(h)
    expect(result.kind).toBeDefined()
    expect(result.dupeXp).toBe(0)
    expect(result.recruit).toBeDefined()
    expect(result.recruit?.level).toBe(1)
    expect(result.recruit?.xp).toBe(0)
    expect(h.roster?.length).toBe(1)
    expect(h.roster?.[0].kind).toBe(result.kind.id)
  })

  it('重複抽中夥伴：不新增成員，依稀有度轉換為經驗並餵給已有夥伴', () => {
    const h = mkHero({ roster: [] })

    // 首次抽取
    fixedRandom(0.1)
    const first = pullAlly(h)
    const initialRosterLen = h.roster?.length
    expect(initialRosterLen).toBe(1)
    expect(first.recruit?.level).toBe(1)
    expect(first.recruit?.xp).toBe(0)

    // 再次抽取同一隻（fine 等級夥伴提供 90 經驗，Lv.1 升 Lv.2 消耗 60 經驗，剩餘 30 經驗）
    fixedRandom(0.1)
    const second = pullAlly(h)
    expect(second.kind.id).toBe(first.kind.id)
    expect(second.dupeXp).toBe(90)
    expect(h.roster?.length).toBe(initialRosterLen) // roster 數量不變
    expect(second.recruit?.level).toBe(2)
    expect(second.recruit?.xp).toBe(30)
  })

  it('重複經驗值依稀有度遞增：fine=90, rare=180, legend=400', () => {
    const knight = GACHA_POOL.find((k) => k.rarity === 'fine')!
    const mage = GACHA_POOL.find((k) => k.rarity === 'rare')!
    const dragoon = GACHA_POOL.find((k) => k.rarity === 'legend')!

    const h = mkHero({
      roster: [
        { id: 'r1', kind: knight.id, level: 1, xp: 0 },
        { id: 'r2', kind: mage.id, level: 1, xp: 0 },
        { id: 'r3', kind: dragoon.id, level: 1, xp: 0 },
      ],
    })

    // 測試重複抽中 fine
    vi.spyOn(Math, 'random').mockReturnValue(0.0) // pick fine
    const pFine = pullAlly(h)
    if (pFine.kind.rarity === 'fine') {
      expect(pFine.dupeXp).toBe(90)
    }

    // 測試重複抽中 rare (傳入 floor='rare')
    sequenceRandom([0.1, 0.0])
    const pRare = pullAlly(h, 'rare')
    if (pRare.kind.rarity === 'rare') {
      expect(pRare.dupeXp).toBe(180)
    }

    // 測試重複抽中 legend (傳入 floor='legend')
    sequenceRandom([0.99, 0.0])
    const pLegend = pullAlly(h, 'legend')
    if (pLegend.kind.rarity === 'legend') {
      expect(pLegend.dupeXp).toBe(400)
    }
  })

  it('重複抽取夥伴給予足夠經驗時會觸發夥伴升級', () => {
    const h = mkHero({ roster: [] })

    fixedRandom(0.1)
    const first = pullAlly(h)
    expect(first.recruit?.level).toBe(1)

    // 連續抽中多次累積經驗使等級提升
    for (let i = 0; i < 5; i++) {
      fixedRandom(0.1)
      pullAlly(h)
    }
    expect(first.recruit?.level).toBeGreaterThan(1)
  })

  it('舊存檔缺 roster 欄位時自動建立空陣列並正常寫入', () => {
    const h = mkHero()
    delete (h as Partial<Hero>).roster

    fixedRandom(0.1)
    const res = pullAlly(h)
    expect(h.roster).toBeDefined()
    expect(Array.isArray(h.roster)).toBe(true)
    expect(h.roster?.length).toBe(1)
    expect(res.recruit).toBeDefined()
  })

  it('指定保底 floor=rare 時，抽出的夥伴必為 rare 或 legend，絕不出現 fine', () => {
    seededRandom(1001)
    const h = mkHero({ roster: [] })

    for (let i = 0; i < 100; i++) {
      const res = pullAlly(h, 'rare')
      expect(['rare', 'legend']).toContain(res.kind.rarity)
    }
  })

  it('千抽統計：夥伴稀有度分佈符合 fine > rare > legend', () => {
    seededRandom(2026)
    const h = mkHero({ roster: [] })

    const counts: Record<Rarity, number> = { crude: 0, common: 0, fine: 0, rare: 0, legend: 0, mythic: 0 }
    for (let i = 0; i < 1000; i++) {
      const res = pullAlly(h)
      counts[res.kind.rarity]++
    }

    expect(counts.fine).toBeGreaterThan(counts.rare)
    expect(counts.rare).toBeGreaterThan(counts.legend)
    expect(counts.legend).toBeGreaterThan(0)
  })
})

// ── 裝備抽取 ──────────────────────────────────────────

describe('pullGear 裝備抽取與彩蛋掉落', () => {
  let idCounter = 0
  const nextId = () => `gear-${idCounter++}`

  it('一般裝備抽取：產出裝備之 ilvl 符合角色等級，且 unique 為 false', () => {
    const h = mkHero({ level: 25 })
    fixedRandom(0.5) // > 0.02 不觸發彩蛋

    const res = pullGear(h, nextId)
    expect(res.unique).toBe(false)
    expect(res.item.ilvl).toBe(25)
    expect(res.item.name).toBeDefined()
    expect(res.item.id).toBeDefined()
  })

  it('指定保底 floor=rare 時，抽出的裝備稀有度至少為 rare 或 legend', () => {
    seededRandom(4321)
    const h = mkHero({ level: 15 })

    for (let i = 0; i < 100; i++) {
      const res = pullGear(h, nextId, 'rare')
      if (!res.unique) {
        expect(['rare', 'legend']).toContain(res.item.rarity)
      }
    }
  })

  it('彩蛋裝備掉落：骰中 UNIQUE_CHANCE 且尚有缺漏時產出 unique: true 裝備', () => {
    const h = mkHero({ bag: [] })

    // 第一次骰彩蛋機率（0.001 < 0.02 觸發彩蛋），第二次選哪一件彩蛋
    sequenceRandom([0.001, 0.0])
    const res = pullGear(h, nextId)
    expect(res.unique).toBe(true)
    expect(res.item.unique).toBeDefined()
    expect(res.item.rarity).toBe('mythic')
    expect(UNIQUES.some((u) => u.id === res.item.unique)).toBe(true)
  })

  it('彩蛋全拿過時：不再產出彩蛋裝而退回一般裝備', () => {
    // 依據是永久紀錄，不是背包 —— 賣掉之後也不該再掉
    const h = mkHero({ bag: [], uniquesFound: UNIQUES.map((u) => u.id) })

    fixedRandom(0.001) // 極小隨機數
    const res = pullGear(h, nextId)
    expect(res.unique).toBe(false) // 由於 missingUniques 為空，退回一般裝備
  })

  it('抽到彩蛋裝時要記進永久紀錄，否則賣掉又會再抽到', () => {
    const h = mkHero({ bag: [], uniquesFound: [] })
    fixedRandom(0.001)
    const res = pullGear(h, nextId)
    expect(res.unique).toBe(true)
    expect(h.uniquesFound).toContain(res.item.unique)
  })

  it('千抽統計：裝備稀有度分佈符合 common/fine > rare > legend', () => {
    seededRandom(9876)
    const h = mkHero({
      level: 10,
      bag: UNIQUES.map((u, idx) => ({
        id: `u-${idx}`,
        name: u.name,
        slot: u.slot,
        rarity: 'legend' as Rarity,
        ilvl: 10,
        atk: 10,
        def: 0,
        affixes: [],
        unique: u.id,
      })),
    })

    const counts: Record<Rarity, number> = { crude: 0, common: 0, fine: 0, rare: 0, legend: 0, mythic: 0 }
    for (let i = 0; i < 1000; i++) {
      const res = pullGear(h, nextId)
      counts[res.item.rarity]++
    }

    expect(counts.common + counts.fine).toBeGreaterThan(counts.rare)
    expect(counts.rare).toBeGreaterThan(counts.legend)
    expect(counts.legend).toBeGreaterThan(0)
  })
})
