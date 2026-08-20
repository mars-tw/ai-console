// 戰鬥引擎的回歸測試。
//
// 這裡守的是「已經被改壞過」的那幾塊：等級曲線、強化與詞綴的界線、
// 三套配點的獨立性、掉落、回合推進、獎勵結算的等級差衰減。
// 全部是純資料進出，不碰 DOM 也不碰網路。
//
// 有隨機性的地方一律先把 Math.random 換掉再測，兩種換法各有用途：
//   fixedRandom(v)  — 固定常數。每個分支的判定都可以事先算出來走哪邊，
//                     所以能直接比對精確值（例如「這一波一定是精英史萊姆」）。
//   seededRandom(s) — mulberry32 固定種子。序列有變化但每次都一樣，
//                     用來做統計性質（分佈、平均值）而不會偶爾變紅燈。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AFFIX_SCALE, MONSTER_BY_ID, RARITY_SPEC } from './data'
import { PLUS_STEP } from './enhance'
import {
  type Battle, attrBudget, attrLeft, collect, commitOrder, computeStats,
  newHero, rollItem, skillBudget, skillLeft, startBattle, stepBattle, stepTurn,
  superTier, waveSize, xpForLevel,
} from './engine'
import type { Affix, Hero, Item, Rarity } from './types'

// ── 亂數控制 ───────────────────────────────────────

/** mulberry32：夠小、夠快、序列固定。有種子就不會有「偶爾會紅」的測試 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 每次都先還原，才不會在同一個 Math.random 上疊第二層 spy */
function fixedRandom(value: number): void {
  vi.restoreAllMocks()
  vi.spyOn(Math, 'random').mockImplementation(() => value)
}

function seededRandom(seed: number): void {
  vi.restoreAllMocks()
  const next = mulberry32(seed)
  vi.spyOn(Math, 'random').mockImplementation(next)
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── 共用小工具 ─────────────────────────────────────

function mkItem(over: Partial<Item> & { id: string }): Item {
  return {
    name: '測試裝備', slot: 'main', rarity: 'common', ilvl: 1,
    atk: 0, def: 0, affixes: [],
    ...over,
  }
}

/** 身上只有指定裝備的主角，用來把數值算式隔離出來看 */
function heroWith(level: number, items: Item[]): Hero {
  const h = newHero()
  h.level = level
  h.bag = [...items]
  h.loadouts[0].equipped = {}
  for (const it of items) h.loadouts[0].equipped[it.slot] = it.id
  return h
}

/**
 * 累計經驗。
 * h.xp 在升級時會被扣掉一級的量再進位，所以「只增不減」不能直接看 h.xp，
 * 要看「這條命總共吃過多少經驗」。
 */
function totalXp(h: Hero): number {
  let total = h.xp
  for (let lv = 1; lv < h.level; lv++) total += xpForLevel(lv)
  return total
}

const STEP_CAP = 20000

/** 一路 tick 到戰鬥結束，回傳跑了幾步。跑滿 STEP_CAP 就代表沒收斂 */
function runToEnd(b: Battle, h: Hero): number {
  let steps = 0
  while (!b.over && steps < STEP_CAP) {
    stepBattle(b, h)
    steps++
  }
  return steps
}

// ── 等級曲線 ───────────────────────────────────────

describe('xpForLevel / attrBudget / skillBudget', () => {
  it('xpForLevel 全程嚴格遞增，而且是正整數', () => {
    expect(xpForLevel(1)).toBe(75)
    for (let lv = 1; lv <= 200; lv++) {
      const need = xpForLevel(lv)
      expect(Number.isInteger(need)).toBe(true)
      expect(need).toBeGreaterThan(0)
      expect(xpForLevel(lv + 1)).toBeGreaterThan(need)
    }
  })

  it('指數是 1.75 不是 1.55 —— 等級翻倍時需求要超過三倍', () => {
    // 1.55 的話 2^1.55 = 2.93，這條會紅；1.75 是 2^1.75 = 3.36
    expect(xpForLevel(12) / xpForLevel(6)).toBeGreaterThan(3.2)
    expect(xpForLevel(24) / xpForLevel(12)).toBeGreaterThan(3.2)
  })

  it('兩種配點預算的起手值與每級增量都固定', () => {
    expect(attrBudget(1)).toBe(5)
    expect(skillBudget(1)).toBe(3)
    for (let lv = 1; lv <= 200; lv++) {
      expect(attrBudget(lv + 1) - attrBudget(lv)).toBe(3)
      expect(skillBudget(lv + 1) - skillBudget(lv)).toBe(2)
      expect(attrBudget(lv)).toBeGreaterThanOrEqual(5)
      expect(skillBudget(lv)).toBeGreaterThanOrEqual(3)
    }
  })

  it('邊界：Lv.0 這種不該出現的輸入也不會給出負預算', () => {
    expect(attrBudget(0)).toBeGreaterThanOrEqual(0)
    expect(skillBudget(0)).toBeGreaterThanOrEqual(0)
    expect(attrBudget(1)).toBeGreaterThan(skillBudget(1))
  })
})

// ── 數值計算 ───────────────────────────────────────

describe('computeStats：強化只放大基礎攻防，不放大詞綴', () => {
  const weapon = (plus: number, affixAtk: number): Item => mkItem({
    id: `w-${plus}-${affixAtk}`, slot: 'main', atk: 100, plus,
    affixes: [{ key: 'atk', value: affixAtk }],
  })

  it('+10 帶來的攻擊增幅與詞綴大小無關', () => {
    const gainSmallAffix = computeStats(heroWith(1, [weapon(10, 50)])).atk
      - computeStats(heroWith(1, [weapon(0, 50)])).atk
    const gainHugeAffix = computeStats(heroWith(1, [weapon(10, 500)])).atk
      - computeStats(heroWith(1, [weapon(0, 500)])).atk

    // 詞綴要是也被 plusMult 乘下去，500 那組的增幅會多出 450
    expect(gainSmallAffix).toBe(gainHugeAffix)
    expect(gainSmallAffix).toBeCloseTo(100 * 10 * PLUS_STEP, 0)
  })

  it('基礎防禦照樣吃強化', () => {
    const armor = (plus: number) => mkItem({ id: `a-${plus}`, slot: 'body', def: 200, plus })
    const gain = computeStats(heroWith(1, [armor(15)])).def
      - computeStats(heroWith(1, [armor(0)])).def
    expect(gain).toBeCloseTo(200 * 15 * PLUS_STEP, 0)
  })

  it('百分比詞綴（暴擊）完全不吃強化', () => {
    const ring = (plus: number) => mkItem({
      id: `r-${plus}`, slot: 'ring1', def: 10, plus,
      affixes: [{ key: 'crit', value: 0.1 }],
    })
    // 基礎 5% + 詞綴 10%，+0 與 +15 要一模一樣
    expect(computeStats(heroWith(1, [ring(0)])).crit).toBeCloseTo(0.15, 6)
    expect(computeStats(heroWith(1, [ring(15)])).crit).toBeCloseTo(0.15, 6)
  })

  it('屬性詞綴進得了 attrs，也會回頭影響攻防', () => {
    const plain = mkItem({ id: 'plain', slot: 'ring1' })
    const buffed = mkItem({ id: 'buffed', slot: 'ring1', affixes: [{ key: 'str', value: 100 }] })
    const a = computeStats(heroWith(1, [plain]))
    const b = computeStats(heroWith(1, [buffed]))
    expect(b.attrs.str - a.attrs.str).toBe(100)
    expect(b.atk).toBeGreaterThan(a.atk)
  })

  it('暴擊 / 急速 / 吸血 有上限，不會被詞綴堆到破表', () => {
    const godRing = mkItem({
      id: 'god', slot: 'ring1',
      affixes: [
        { key: 'crit', value: 9 }, { key: 'haste', value: 9 }, { key: 'leech', value: 9 },
      ],
    })
    const st = computeStats(heroWith(1, [godRing]))
    expect(st.crit).toBe(0.75)
    expect(st.haste).toBe(0.6)
    expect(st.leech).toBe(0.4)
  })

  it('升級本身會長血、長防，不用靠裝備', () => {
    const bare = (lv: number) => computeStats(heroWith(lv, []))
    expect(bare(10).hpMax).toBeGreaterThan(bare(1).hpMax)
    expect(bare(10).def).toBeGreaterThan(bare(1).def)
    expect(bare(10).mpMax).toBeGreaterThan(bare(1).mpMax)
    expect(bare(1).crit).toBeCloseTo(0.05, 6)
  })
})

// ── 配點獨立性 ─────────────────────────────────────

describe('attrLeft / skillLeft：三套配點各自獨立', () => {
  const lv = 10

  it('第一套配滿，不會吃掉第二、三套的額度', () => {
    const h = newHero()
    h.level = lv
    h.loadouts[0].attrs.str = attrBudget(lv)

    expect(attrLeft(h, h.loadouts[0])).toBe(0)
    expect(attrLeft(h, h.loadouts[1])).toBe(attrBudget(lv))
    expect(attrLeft(h, h.loadouts[2])).toBe(attrBudget(lv))
  })

  it('切換 active 之後，預設看的是切過去那一套', () => {
    const h = newHero()
    h.level = lv
    h.loadouts[0].attrs.str = attrBudget(lv)

    expect(attrLeft(h)).toBe(0)
    h.active = 1
    expect(attrLeft(h)).toBe(attrBudget(lv))
    h.active = 2
    expect(attrLeft(h)).toBe(attrBudget(lv))
  })

  it('屬性池與技能池互不相干，配滿一邊不影響另一邊', () => {
    const h = newHero()
    h.level = lv
    const lo = h.loadouts[0]

    lo.attrs.vit = attrBudget(lv)
    expect(attrLeft(h, lo)).toBe(0)
    expect(skillLeft(h, lo)).toBe(skillBudget(lv))

    lo.skills.slash = skillBudget(lv)
    expect(skillLeft(h, lo)).toBe(0)
    expect(attrLeft(h, lo)).toBe(0)
    expect(skillLeft(h, h.loadouts[1])).toBe(skillBudget(lv))
  })

  it('技能點分散在多個技能上也算得對', () => {
    const h = newHero()
    h.level = lv
    const lo = h.loadouts[0]
    lo.skills.slash = 3
    lo.skills.cleave = 4
    lo.skills.bolt = 2
    expect(skillLeft(h, lo)).toBe(skillBudget(lv) - 9)
  })

  it('升級會讓每一套同時多出點數', () => {
    const h = newHero()
    h.level = lv
    h.loadouts[0].attrs.str = attrBudget(lv)

    h.level = lv + 1
    expect(attrLeft(h, h.loadouts[0])).toBe(3)
    expect(attrLeft(h, h.loadouts[1])).toBe(attrBudget(lv + 1))
    expect(skillLeft(h, h.loadouts[0])).toBe(skillBudget(lv + 1))
  })
})

// ── 掉落 ───────────────────────────────────────────

describe('rollItem：稀有度越高，詞綴越多、數值越大', () => {
  const ORDER: Rarity[] = ['crude', 'common', 'fine', 'rare', 'legend']
  /** 把詞綴換算回「ilvl × 倍率」的單位，不同 key 才比得起來 */
  const weight = (a: Affix) => a.value / AFFIX_SCALE[a.key]

  it('詞綴數量隨稀有度嚴格變多，且與 RARITY_SPEC 一致', () => {
    fixedRandom(0.5)
    const counts = ORDER.map((r) => rollItem(30, 'main', r, 'melee').affixes.length)
    ORDER.forEach((r, i) => expect(counts[i]).toBe(RARITY_SPEC[r].affixes))
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1])
    }
  })

  it('同 ilvl 下基礎攻擊與基礎防禦隨稀有度嚴格變大', () => {
    fixedRandom(0.5)
    const atks = ORDER.map((r) => rollItem(50, 'main', r, 'melee').atk)
    const defs = ORDER.map((r) => rollItem(50, 'body', r).def)
    for (let i = 1; i < ORDER.length; i++) {
      expect(atks[i]).toBeGreaterThan(atks[i - 1])
      expect(defs[i]).toBeGreaterThan(defs[i - 1])
    }
  })

  it('固定亂數下，同一個詞綴的數值隨稀有度變大', () => {
    fixedRandom(0.5)
    // 亂數固定 → 各稀有度抽到的第一個詞綴 key 相同，可以直接比大小
    const first = ORDER.slice(1).map((r) => rollItem(50, 'main', r, 'melee').affixes[0])
    expect(new Set(first.map((a) => a.key)).size).toBe(1)
    for (let i = 1; i < first.length; i++) {
      expect(first[i].value).toBeGreaterThan(first[i - 1].value)
    }
  })

  it('跑一千件統計：詞綴總量 legend > rare > fine', () => {
    const meanWeight = (rar: Rarity) => {
      let total = 0
      for (let i = 0; i < 1000; i++) {
        total += rollItem(40, 'main', rar, 'melee').affixes
          .reduce((s, a) => s + weight(a), 0)
      }
      return total / 1000
    }
    seededRandom(20260820)
    const fine = meanWeight('fine')
    const rare = meanWeight('rare')
    const legend = meanWeight('legend')
    expect(rare).toBeGreaterThan(fine)
    expect(legend).toBeGreaterThan(rare)
  })

  it('ilvl 越高，基礎值與詞綴值都越大', () => {
    fixedRandom(0.5)
    const low = rollItem(10, 'main', 'rare', 'melee')
    const high = rollItem(50, 'main', 'rare', 'melee')
    expect(high.atk).toBeGreaterThan(low.atk)
    expect(high.affixes[0].value).toBeGreaterThan(low.affixes[0].value)
  })

  it('武器只有攻擊、防具只有防禦，武器才有技能線', () => {
    fixedRandom(0.5)
    const w = rollItem(20, 'main', 'rare', 'magic')
    expect(w.atk).toBeGreaterThan(0)
    expect(w.def).toBe(0)
    expect(w.line).toBe('magic')

    const a = rollItem(20, 'head', 'rare')
    expect(a.def).toBeGreaterThan(0)
    expect(a.atk).toBe(0)
    expect(a.line).toBeUndefined()
  })

  it('同一件不會出現重複詞綴', () => {
    seededRandom(7)
    for (let i = 0; i < 300; i++) {
      const it = rollItem(30, undefined, 'legend')
      expect(new Set(it.affixes.map((a) => a.key)).size).toBe(it.affixes.length)
    }
  })
})

// ── 一波幾隻 ───────────────────────────────────────

describe('waveSize：1..4 隻，等級越高平均越多', () => {
  const sample = (lv: number, kind: 'field' | 'dungeon', n: number) => {
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push(waveSize(lv, kind))
    return out
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

  it('任何等級與場地，回傳值都是 1..4 的整數', () => {
    seededRandom(1234)
    for (const lv of [1, 5, 7, 8, 19, 20, 50, 99]) {
      for (const kind of ['field', 'dungeon'] as const) {
        for (const n of sample(lv, kind, 200)) {
          expect(Number.isInteger(n)).toBe(true)
          expect(n).toBeGreaterThanOrEqual(1)
          expect(n).toBeLessThanOrEqual(4)
        }
      }
    }
  })

  it('跨過等級門檻，平均隻數就往上一階', () => {
    seededRandom(99)
    const f1 = mean(sample(1, 'field', 4000))
    const f8 = mean(sample(8, 'field', 4000))
    const f20 = mean(sample(20, 'field', 4000))
    expect(f8).toBeGreaterThan(f1)
    expect(f20).toBeGreaterThan(f8)
  })

  it('同等級下，地城的平均比野外多', () => {
    seededRandom(100)
    expect(mean(sample(1, 'dungeon', 4000))).toBeGreaterThan(mean(sample(1, 'field', 4000)))
  })

  it('野外低等級只會是 1 或 2 隻', () => {
    seededRandom(6)
    expect(new Set(sample(1, 'field', 400))).toEqual(new Set([1, 2]))
  })

  it('地城 Lv.20 之後每一波都塞滿，但被上限壓在 4', () => {
    seededRandom(5)
    expect(new Set(sample(20, 'dungeon', 400))).toEqual(new Set([4]))
  })
})

// ── 超級菁英階級 ───────────────────────────────────

describe('superTier：每 20 等一階，上限四階', () => {
  it('Lv.19 是 0、Lv.20 是 1', () => {
    expect(superTier(19)).toBe(0)
    expect(superTier(20)).toBe(1)
  })

  it('Lv.99 卡在 4，再高也不會繼續長', () => {
    expect(superTier(80)).toBe(4)
    expect(superTier(99)).toBe(4)
    expect(superTier(500)).toBe(4)
  })

  it('每一階的門檻正好落在 20 的倍數上', () => {
    for (const lv of [20, 40, 60, 80]) {
      expect(superTier(lv)).toBe(superTier(lv - 1) + 1)
    }
  })

  it('全程單調不減，低等級一律是 0', () => {
    expect(superTier(1)).toBe(0)
    let prev = superTier(1)
    for (let lv = 1; lv <= 200; lv++) {
      const cur = superTier(lv)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })
})

// ── 戰鬥推進 ───────────────────────────────────────

describe('startBattle → stepBattle：跑得完，不會無限迴圈', () => {
  it('newHero 起手就是可以打的狀態', () => {
    seededRandom(3)
    const h = newHero()
    expect(h.level).toBe(1)
    expect(h.loadouts).toHaveLength(3)
    expect(h.active).toBe(0)
    expect(h.bag).toHaveLength(1)
    expect(h.loadouts[0].equipped.main).toBe(h.bag[0].id)
  })

  it('地城一定會結束，b.over 會變 true', () => {
    for (const seed of [1, 2, 3, 42, 20260820]) {
      seededRandom(seed)
      const h = newHero()
      const b = startBattle(h, 'dungeon', 'cave', [])
      expect(b.over).toBe(false)

      const steps = runToEnd(b, h)
      expect(b.over).toBe(true)
      expect(steps).toBeLessThan(STEP_CAP)
      expect(b.result === 'win' || b.result === 'lose').toBe(true)
    }
  })

  it('打得贏的時候會一路推到最後一間並且 win', () => {
    seededRandom(31)
    // 停在 Lv.19：superTier 還是 0，不會冒出把測試變成擲骰子的超級菁英
    const h = newHero()
    h.level = 19
    const sword = mkItem({ id: 'big-sword', slot: 'main', atk: 4000, line: 'melee' })
    const plate = mkItem({ id: 'big-plate', slot: 'body', def: 4000 })
    h.bag.push(sword, plate)
    h.loadouts[0].equipped = { main: sword.id, body: plate.id }

    const b = startBattle(h, 'dungeon', 'cave', [])
    runToEnd(b, h)
    expect(b.over).toBe(true)
    expect(b.result).toBe('win')
    expect(b.room).toBe(b.rooms)
  })

  it('打不贏的時候也會結束，不會卡在原地互毆', () => {
    seededRandom(9)
    const h = newHero()          // Lv.1 起手裝進哥布林洞窟
    const b = startBattle(h, 'dungeon', 'cave', [])
    runToEnd(b, h)
    expect(b.over).toBe(true)
    expect(b.result).toBe('lose')
    expect(b.hero.hp).toBe(0)
  })

  it('打完之後 b.over 會擋掉後續的 tick', () => {
    seededRandom(4)
    const h = newHero()
    const b = startBattle(h, 'dungeon', 'cave', [])
    runToEnd(b, h)
    const snapshot = { tick: b.tick, xp: b.xp, gold: b.gold, kills: b.kills }
    stepBattle(b, h)
    expect(b.tick).toBe(snapshot.tick)
    expect(b.xp).toBe(snapshot.xp)
    expect(b.gold).toBe(snapshot.gold)
    expect(b.kills).toBe(snapshot.kills)
  })
})

// ── 結算 ───────────────────────────────────────────

describe('collect：只會往上加，不會變負', () => {
  it('單場結算：金幣不減、經驗非負、累計經驗不倒退', () => {
    for (const seed of [11, 22, 33, 44, 55]) {
      seededRandom(seed)
      const h = newHero()
      h.level = 5
      const goldBefore = h.gold
      const totalBefore = totalXp(h)

      const b = startBattle(h, 'dungeon', 'cave', [])
      runToEnd(b, h)
      const got = collect(h, b)

      expect(h.gold).toBeGreaterThanOrEqual(goldBefore)
      expect(h.xp).toBeGreaterThanOrEqual(0)
      expect(totalXp(h)).toBeGreaterThanOrEqual(totalBefore)
      expect(got.levels).toBeGreaterThanOrEqual(0)
      expect(h.level).toBeGreaterThanOrEqual(5)
    }
  })

  it('結算完戰鬥端要歸零，不然下一場會重複入帳', () => {
    seededRandom(66)
    const h = newHero()
    h.level = 5
    const b = startBattle(h, 'dungeon', 'cave', [])
    runToEnd(b, h)
    const bagBefore = h.bag.length
    const got = collect(h, b)

    expect(b.xp).toBe(0)
    expect(b.gold).toBe(0)
    expect(b.kills).toBe(0)
    expect(b.loot).toHaveLength(0)
    expect(b.tickets).toEqual({ ally: 0, gear: 0 })
    expect(h.bag.length).toBe(bagBefore + got.loot.length)
  })

  it('連打十場，金幣與等級單調不減，h.xp 全程非負', () => {
    seededRandom(2468)
    const h = newHero()
    h.level = 10
    let gold = h.gold
    let level = h.level
    let total = totalXp(h)

    for (let i = 0; i < 10; i++) {
      const b = startBattle(h, 'dungeon', 'cave', [])
      runToEnd(b, h)
      collect(h, b)

      expect(h.gold).toBeGreaterThanOrEqual(gold)
      expect(h.level).toBeGreaterThanOrEqual(level)
      expect(totalXp(h)).toBeGreaterThanOrEqual(total)
      expect(h.xp).toBeGreaterThanOrEqual(0)
      // 升級之後剩下的經驗一定小於下一級的需求，不然是進位沒跑完
      expect(h.xp).toBeLessThan(xpForLevel(h.level))

      gold = h.gold
      level = h.level
      total = totalXp(h)
    }
  })
})

// ── 獎勵結算：等級差與精英加成 ─────────────────────

describe('settle 的獎勵：等級差衰減與精英加成', () => {
  /** 把整波打倒再推一個 tick，讓 settle() 對著固定的一群怪算獎勵 */
  const wipeWave = (b: Battle, h: Hero) => {
    for (const f of b.foes) f.hp = 0
    stepBattle(b, h)
  }

  /**
   * 亂數固定成 v 之後，草原這一波的組成是完全確定的：
   *   0.3 → 一般史萊姆（0.3 > ELITE_CHANCE 0.18）
   *   0.1 → 精英史萊姆（0.1 < 0.18，但 0.1 > SUPER_CHANCE 0.07，不會變超級）
   * 兩者挑到的怪都是 monsters[0]，所以獎勵可以直接互相比。
   */
  const meadowWave = (level: number, v: number) => {
    fixedRandom(v)
    const h = newHero()
    h.level = level
    const b = startBattle(h, 'field', 'meadow', [])
    expect(b.foes.length).toBeGreaterThan(0)
    expect(b.foes.every((f) => f.art === 'slime' && !f.super)).toBe(true)
    wipeWave(b, h)
    expect(b.kills).toBeGreaterThan(0)
    return { battle: b, xpPerKill: b.xp / b.kills, goldPerKill: b.gold / b.kills }
  }

  const slime = MONSTER_BY_ID.slime

  it('等級差 3 以內不衰減', () => {
    expect(meadowWave(4, 0.3).xpPerKill).toBe(slime.xp)
  })

  it('主角越高，經驗衰減越多，但不會歸零也不會變負', () => {
    const lv4 = meadowWave(4, 0.3).xpPerKill
    const lv10 = meadowWave(10, 0.3).xpPerKill
    const lv20 = meadowWave(20, 0.3).xpPerKill
    const lv99 = meadowWave(99, 0.3).xpPerKill

    expect(lv10).toBeLessThan(lv4)
    expect(lv20).toBeLessThan(lv10)
    expect(lv99).toBe(lv20)              // 已經吃到 0.15 下限，不會再往下
    expect(lv99).toBeGreaterThan(0)
  })

  it('金幣的衰減下限比經驗高 —— 打低級怪還是有錢賺', () => {
    const lv4 = meadowWave(4, 0.3)
    const lv99 = meadowWave(99, 0.3)
    expect(lv4.goldPerKill).toBe(slime.gold)
    expect(lv99.goldPerKill / slime.gold).toBeGreaterThan(lv99.xpPerKill / slime.xp)
    expect(lv99.goldPerKill).toBeGreaterThan(0)
  })

  it('精英怪的獎勵用怪物 id 查表，名字被改掉也查得到', () => {
    const plain = meadowWave(4, 0.3)
    const elite = meadowWave(4, 0.1)

    expect(elite.battle.foes.length).toBeGreaterThan(0)
    // 名字已經被加上前綴；查表若改用名字，倍率會落在保底值上而不是史萊姆的 20 點
    expect(elite.battle.log.length).toBeGreaterThan(0)
    expect(elite.xpPerKill).toBe(Math.round(slime.xp * 2.2))
    expect(elite.xpPerKill / plain.xpPerKill).toBeCloseTo(2.2, 6)
    expect(elite.goldPerKill).toBe(Math.round(slime.gold * 2.2))
  })

  it('精英怪本身比一般怪耐打、也比較痛', () => {
    fixedRandom(0.1)
    const h = newHero()
    h.level = 4
    const b = startBattle(h, 'field', 'meadow', [])
    const foe = b.foes[0]
    expect(foe.elite).toBe(true)
    expect(foe.super).toBeUndefined()
    expect(foe.name).not.toBe(slime.name)
    expect(foe.hpMax).toBeGreaterThan(slime.hp)
    expect(foe.atk).toBeGreaterThan(slime.atk)
  })
})

// ── 回合階段 ───────────────────────────────────────

describe('commitOrder / stepTurn：回合階段不會卡死', () => {
  it('一路下令到戰鬥結束，每個回合都回得到 input 階段', () => {
    seededRandom(777)
    const h = newHero()
    h.level = 8
    const b = startBattle(h, 'dungeon', 'cave', [])
    expect(b.phase).toBe('input')

    let rounds = 0
    while (!b.over && rounds < 5000) {
      expect(b.phase).toBe('input')
      expect(commitOrder(b, null)).toBe(true)
      expect(b.phase).toBe('resolve')

      let actions = 0
      while (stepTurn(b, h)) {
        actions++
        // 佇列最多就是我方加敵方那幾個單位，爆掉代表有東西沒被消化
        expect(actions).toBeLessThan(64)
      }
      rounds++
      if (!b.over) expect(b.phase).toBe('input')
    }

    expect(b.over).toBe(true)
    expect(rounds).toBeLessThan(5000)
    expect(rounds).toBeGreaterThan(0)
  })

  it('階段不對的呼叫一律回 false，不會偷偷改狀態', () => {
    seededRandom(778)
    const h = newHero()
    const b = startBattle(h, 'dungeon', 'cave', [])

    expect(stepTurn(b, h)).toBe(false)        // 還沒下令就想結算
    expect(b.phase).toBe('input')
    expect(commitOrder(b, null)).toBe(true)
    expect(commitOrder(b, null)).toBe(false)  // 同一回合下第二次
    expect(b.phase).toBe('resolve')
  })

  it('戰鬥結束之後，下令與結算都不再有作用', () => {
    seededRandom(779)
    const h = newHero()
    const b = startBattle(h, 'dungeon', 'cave', [])
    runToEnd(b, h)

    expect(b.over).toBe(true)
    expect(commitOrder(b, null)).toBe(false)
    expect(stepTurn(b, h)).toBe(false)
  })
})
