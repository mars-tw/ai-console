// 神話階：彩蛋裝備與彩蛋夥伴的三個保證
//
// 這一份守的是三件承諾，每一件壞掉都不會有錯誤訊息，
// 只會讓玩家在幾十小時之後才發現「這東西好像沒用」：
//
//   1. **會自己跟著等級長。** 每種只有一件、且不可重複取得 ——
//      數值鎖在取得那一刻的話，Lv.8 拿到的到 Lv.40 就是廢鐵，
//      而你永遠拿不到第二件。那會教玩家「不要太早開箱」，
//      那不是遊戲該教的事。
//   2. **不可重複取得。** 依據是永久紀錄，不是背包 ——
//      掃背包的話賣掉就變回「沒拿過」，那叫「一次只能有一件」。
//   3. **不能強化。** 碎裂率最高 55%，賭掉的是這個存檔再也拿不到的東西。
import { describe, expect, it, vi } from 'vitest'
import {
  ALLY_BY_ID, SECRET_ALLIES, checkSecretAllies, hasSecretAlly,
  recruitCombatant, syncSecretAllies,
} from './allies'
import { CANNOT_ENHANCE_MSG, canEnhance, enhance } from './enhance'
import { BAG_CAP, junkOf, newHero, trimBag } from './engine'
import { UNIQUES, makeUnique, syncUniques } from './secrets'
import { PARTY_CAP_DEFAULT, PARTY_CAP_MAX, PARTY_CAP_MIN, partyCapOf } from './types'
import type { Hero, Item } from './types'

// node 環境沒有 localStorage，newHero 不碰它，但 saveHero 會 —— 這裡只用 newHero
const mk = (over: Partial<Hero> = {}): Hero => Object.assign(newHero(), over)

describe('彩蛋裝備：跟著等級自動成長', () => {
  it('主角升級之後，數值跟著上去', () => {
    const h = mk({ level: 10 })
    const sword = makeUnique(UNIQUES[0], 10, 'w1')
    h.bag.push(sword)
    const before = sword.atk

    h.level = 40
    const grown = syncUniques(h)

    expect(grown).toContain(UNIQUES[0].name)
    expect(sword.ilvl).toBe(40)
    expect(sword.atk).toBeGreaterThan(before)
  })

  it('等級沒變就不動，也不會回報「變強了」', () => {
    const h = mk({ level: 20 })
    h.bag.push(makeUnique(UNIQUES[0], 20, 'w1'))
    expect(syncUniques(h)).toEqual([])
  })

  it('是冪等的：跑兩次跟跑一次結果一樣', () => {
    // 不冪等的話，每次讀檔都會再長一截 —— 掛機一整晚回來數值會爆掉
    const h = mk({ level: 30 })
    h.bag.push(makeUnique(UNIQUES[0], 5, 'w1'))
    syncUniques(h)
    const once = { ...h.bag[0] }
    syncUniques(h)
    expect(h.bag[0]).toEqual(once)
  })

  it('不會把等級往下砍', () => {
    // 主角重置或降級時去砍裝備等級沒有意義，只會讓人覺得被懲罰
    const h = mk({ level: 5 })
    const sword = makeUnique(UNIQUES[0], 40, 'w1')
    h.bag.push(sword)
    syncUniques(h)
    expect(sword.ilvl).toBe(40)
  })

  it('玩家自己強化上去的 plus 不會被洗掉', () => {
    // 那是另一條線的投入，不該被自動成長吃掉
    const h = mk({ level: 30 })
    const sword = makeUnique(UNIQUES[0], 10, 'w1')
    sword.plus = 7
    h.bag.push(sword)
    syncUniques(h)
    expect(sword.plus).toBe(7)
  })

  it('不碰一般裝備', () => {
    const h = mk({ level: 40 })
    const normal = { ...makeUnique(UNIQUES[0], 5, 'n1'), unique: undefined }
    h.bag.push(normal)
    syncUniques(h)
    expect(normal.ilvl).toBe(5)
  })

  it('比同級的傳說裝備強', () => {
    // 「比傳說還要強」是這個階級存在的理由。
    // 不比較的話，神話就只是一個顏色不同的傳說。
    const spec = UNIQUES[0]
    const mythic = makeUnique(spec, 30, 'm1')
    // 同級傳說武器的基礎值：(4 + ilvl * 2.2) * RARITY_SPEC.legend.mult(2.0)
    const legendAtk = Math.round((4 + 30 * 2.2) * 2.0)
    expect(mythic.atk).toBeGreaterThan(legendAtk)
    expect(mythic.rarity).toBe('mythic')
  })
})

describe('彩蛋裝備：不能強化', () => {
  it('canEnhance 對彩蛋裝備回 false', () => {
    expect(canEnhance(makeUnique(UNIQUES[0], 10, 'w1'))).toBe(false)
  })

  it('一般裝備照常可以強化', () => {
    const normal = { ...makeUnique(UNIQUES[0], 10, 'n1'), unique: undefined }
    expect(canEnhance(normal)).toBe(true)
  })

  it('擋在 enhance() 裡，不是只靠介面藏按鈕', () => {
    // 介面會改；規則不該靠介面守
    const h = mk({ level: 20 })
    const sword = makeUnique(UNIQUES[0], 20, 'w1')
    const before = sword.plus ?? 0
    const res = enhance(h, sword, false)
    expect(res.outcome).toBe('stay')
    expect(res.msg).toBe(CANNOT_ENHANCE_MSG)
    expect(sword.plus ?? 0).toBe(before)
  })

  it('就算骰到必碎也碎不掉', () => {
    // 這是最重要的一項：碎了就永遠沒了
    const h = mk({ level: 20 })
    const sword = makeUnique(UNIQUES[0], 20, 'w1')
    sword.plus = 14                        // 最高風險段
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    try {
      expect(enhance(h, sword, false).outcome).toBe('stay')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('彩蛋夥伴', () => {
  it('條件沒達成就不在名冊裡', () => {
    const h = mk({ kills: 0, deaths: 0 })
    checkSecretAllies(h)
    for (const k of SECRET_ALLIES) expect(hasSecretAlly(h, k.id)).toBe(false)
  })

  it('條件達成就自動加入，而且是神話階', () => {
    const h = mk({ kills: 500 })
    const got = checkSecretAllies(h)
    expect(got.some((k) => k.id === 'archivist')).toBe(true)
    expect(hasSecretAlly(h, 'archivist')).toBe(true)
    expect(h.roster?.some((r) => r.kind === 'archivist')).toBe(true)
    expect(ALLY_BY_ID.archivist.rarity).toBe('mythic')
  })

  it('不可重複取得：再檢查幾次也只會有一隻', () => {
    const h = mk({ kills: 500 })
    checkSecretAllies(h)
    checkSecretAllies(h)
    checkSecretAllies(h)
    expect(h.roster?.filter((r) => r.kind === 'archivist').length).toBe(1)
    expect(h.secretAllies?.filter((x) => x === 'archivist').length).toBe(1)
  })

  it('等級跟著主角走，不用另外練', () => {
    // 它們是解鎖來的不是抽來的：Lv.40 的玩家拿到一隻 Lv.1 神話夥伴，
    // 那隻會在板凳上坐到天荒地老 —— 而且不能重抽，連餵經驗的路都沒有
    const h = mk({ level: 40, kills: 500 })
    checkSecretAllies(h)
    const r = h.roster!.find((x) => x.kind === 'archivist')!
    r.level = 3
    syncSecretAllies(h)
    expect(r.level).toBe(40)
  })

  it('只往上不往下', () => {
    const h = mk({ level: 5, kills: 500 })
    checkSecretAllies(h)
    const r = h.roster!.find((x) => x.kind === 'archivist')!
    r.level = 30
    syncSecretAllies(h)
    expect(r.level).toBe(30)
  })

  it('不碰一般夥伴的等級', () => {
    const h = mk({ level: 40 })
    const dragon = h.roster!.find((r) => r.kind === 'kimi')!
    dragon.level = 2
    syncSecretAllies(h)
    expect(dragon.level).toBe(2)
  })

  it('上場時真的比傳說夥伴強', () => {
    const h = mk({ level: 30, kills: 500 })
    checkSecretAllies(h)
    const secret = h.roster!.find((x) => x.kind === 'archivist')!
    secret.level = 30
    const mythic = recruitCombatant(secret)
    const legend = recruitCombatant({ id: 'x', kind: 'miko', level: 30, xp: 0 })
    // 同定位（都是 support）同等級，成長率 1.45 vs 1.28
    expect(mythic.hpMax).toBeGreaterThan(legend.hpMax)
  })

  it('不在抽卡池裡 —— 抽得到的話「彩蛋」就沒有意義了', async () => {
    const { GACHA_POOL } = await import('./allies')
    for (const k of SECRET_ALLIES) {
      expect(GACHA_POOL.some((p) => p.id === k.id)).toBe(false)
    }
  })

  it('每一隻都有線索。沒有線索的彩蛋是永遠不會被發現的彩蛋', () => {
    for (const k of SECRET_ALLIES) {
      expect(k.secret?.hint?.length ?? 0).toBeGreaterThan(4)
    }
  })
})

describe('隊伍人數上限', () => {
  it('預設 4 人（含主角）', () => {
    expect(partyCapOf(mk())).toBe(PARTY_CAP_DEFAULT)
  })

  it('夾在 3～5 之間', () => {
    expect(partyCapOf({ partyCap: 1 })).toBe(PARTY_CAP_MIN)
    expect(partyCapOf({ partyCap: 99 })).toBe(PARTY_CAP_MAX)
    expect(partyCapOf({ partyCap: 3 })).toBe(3)
    expect(partyCapOf({ partyCap: 5 })).toBe(5)
  })

  it('存檔被改壞也不會炸', () => {
    // 這個值會被拿去 slice 陣列，NaN 進去的話隊伍會整個消失
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      const got = partyCapOf({ partyCap: bad as number })
      expect(got).toBeGreaterThanOrEqual(PARTY_CAP_MIN)
      expect(got).toBeLessThanOrEqual(PARTY_CAP_MAX)
    }
  })

  it('小數會取整', () => {
    expect(partyCapOf({ partyCap: 4.6 })).toBe(5)
  })
})

describe('傳說人物：四個定位都要有', () => {
  it('傳說階不能只有輸出與輔助', async () => {
    // 原本傳說只有 support 與 dps 兩個定位 ——
    // 於是「抽到傳說」對玩坦或玩補的人來說沒有意義
    const { GACHA_POOL } = await import('./allies')
    const legendRoles = new Set(
      GACHA_POOL.filter((k) => k.rarity === 'legend').map((k) => k.role),
    )
    for (const role of ['tank', 'dps', 'healer', 'support']) {
      expect(legendRoles.has(role as never), `傳說階缺 ${role}`).toBe(true)
    }
  })
})

describe('背包上限：掛機一整晚不會爆', () => {
  const mkJunk = (i: number): Item => ({
    id: `j${i}`, name: '雜物', slot: 'head', rarity: 'crude', ilvl: 1,
    atk: 0, def: 1, affixes: [],
  })

  it('沒超過上限就什麼都不做', () => {
    const h = mk()
    h.bag = Array.from({ length: BAG_CAP }, (_, i) => mkJunk(i))
    expect(trimBag(h)).toEqual({ count: 0, gold: 0 })
    expect(h.bag.length).toBe(BAG_CAP)
  })

  it('超過就賣到剛好回到上限，不會一次清光', () => {
    // 一次清光是玩家自己按「清雜物」時的行為 —— 他知道自己在做什麼。
    // 自動的那一份要盡量少動。
    const h = mk()
    h.bag = Array.from({ length: BAG_CAP + 30 }, (_, i) => mkJunk(i))
    const r = trimBag(h)
    expect(r.count).toBe(30)
    expect(h.bag.length).toBe(BAG_CAP)
    expect(h.gold).toBeGreaterThan(0)
  })

  it('★ 彩蛋裝備一件都不會被自動賣掉', () => {
    // 它們是永遠只有一件、賣掉就再也拿不回來的東西
    const h = mk()
    h.bag = [
      ...UNIQUES.map((u, i) => makeUnique(u, 10, `u${i}`)),
      ...Array.from({ length: BAG_CAP + 50 }, (_, i) => mkJunk(i)),
    ]
    trimBag(h)
    for (const u of UNIQUES) {
      expect(h.bag.some((it) => it.unique === u.id), `${u.name} 被賣掉了`).toBe(true)
    }
  })

  it('身上穿著的不會被賣掉', () => {
    const h = mk()
    const worn = mkJunk(9999)
    h.bag = [worn, ...Array.from({ length: BAG_CAP + 20 }, (_, i) => mkJunk(i))]
    h.loadouts[0].equipped.head = worn.id
    trimBag(h)
    expect(h.bag.some((it) => it.id === worn.id)).toBe(true)
  })

  it('從最不值錢的開始賣', () => {
    const h = mk()
    const good = { ...mkJunk(1), id: 'good', def: 500 }
    h.bag = [good, ...Array.from({ length: BAG_CAP + 5 }, (_, i) => mkJunk(i + 100))]
    trimBag(h)
    expect(h.bag.some((it) => it.id === 'good')).toBe(true)
  })

  it('手動清雜物與自動清理用同一份規則', () => {
    // 兩邊各寫一份的話，遲早會出現「手動留著的東西自動卻賣掉了」
    const h = mk()
    h.bag = [makeUnique(UNIQUES[0], 10, 'u1'), mkJunk(1)]
    expect(junkOf(h).sold.some((i) => i.unique)).toBe(false)
  })
})
