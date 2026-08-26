import { describe, expect, it } from 'vitest'

import { newHero } from './engine'
import {
  checkSecrets,
  hasSecret,
  makeUnique,
  missingUniques,
  recordUnique,
  rememberUniques,
  SECRET_BY_ID,
  SECRETS,
  UNIQUES,
} from './secrets'
import type { Hero, Rarity } from './types'

// ── 彩蛋達成條件 ──────────────────────────────────────────

describe('SECRETS 各彩蛋解鎖條件判定', () => {
  it('avenger（復仇者）：連續陣亡達到 10 次解鎖', () => {
    const s = SECRET_BY_ID.avenger
    const h = newHero()
    h.tally = { deathStreak: 9, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }
    expect(s.test(h)).toBe(false)

    h.tally.deathStreak = 10
    expect(s.test(h)).toBe(true)

    h.tally.deathStreak = 15
    expect(s.test(h)).toBe(true)
  })

  it('giantslayer（巨人殺手）：擊倒 3 隻超級菁英解鎖', () => {
    const s = SECRET_BY_ID.giantslayer
    const h = newHero()
    h.tally = { deathStreak: 0, crits: 0, superKills: 2, cleanClears: 0, breaks: 0 }
    expect(s.test(h)).toBe(false)

    h.tally.superKills = 3
    expect(s.test(h)).toBe(true)
  })

  it('ironhand（鐵匠之手）：強化碎掉 5 件裝備解鎖', () => {
    const s = SECRET_BY_ID.ironhand
    const h = newHero()
    h.tally = { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 4 }
    expect(s.test(h)).toBe(false)

    h.tally.breaks = 5
    expect(s.test(h)).toBe(true)
  })

  it('luckyhand（幸運手）：暴擊次數累計 300 次解鎖', () => {
    const s = SECRET_BY_ID.luckyhand
    const h = newHero()
    h.tally = { deathStreak: 0, crits: 299, superKills: 0, cleanClears: 0, breaks: 0 }
    expect(s.test(h)).toBe(false)

    h.tally.crits = 300
    expect(s.test(h)).toBe(true)
  })

  it('collector（蒐藏家）：人形夥伴（排除 7 隻 AI 龍）數量達到 6 隻解鎖', () => {
    const s = SECRET_BY_ID.collector
    const h = newHero()
    // 預設有 7 隻 AI 龍，但人形夥伴為 0
    expect(s.test(h)).toBe(false)

    // 加入 5 隻人形夥伴
    h.roster = [
      { id: 'r1', kind: 'knight', level: 1, xp: 0 },
      { id: 'r2', kind: 'ranger', level: 1, xp: 0 },
      { id: 'r3', kind: 'mage', level: 1, xp: 0 },
      { id: 'r4', kind: 'cleric', level: 1, xp: 0 },
      { id: 'r5', kind: 'rogue', level: 1, xp: 0 },
    ]
    expect(s.test(h)).toBe(false)

    // 加入第 6 隻人形夥伴
    h.roster.push({ id: 'r6', kind: 'bard', level: 1, xp: 0 })
    expect(s.test(h)).toBe(true)
  })

  it('ascetic（苦行者）：無喝藥水通關地城 3 次解鎖', () => {
    const s = SECRET_BY_ID.ascetic
    const h = newHero()
    h.tally = { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 2, breaks: 0 }
    expect(s.test(h)).toBe(false)

    h.tally.cleanClears = 3
    expect(s.test(h)).toBe(true)
  })

  it('邊界：舊存檔缺 tally 欄位時，所有條件安全判定為 false 且不拋錯', () => {
    const h = newHero()
    delete (h as Partial<Hero>).tally

    for (const secret of SECRETS) {
      if (secret.id !== 'collector') {
        expect(secret.test(h)).toBe(false)
      }
    }
  })
})

// ── 解鎖狀態管理 ──────────────────────────────────────────

describe('checkSecrets 與 hasSecret 解鎖管理', () => {
  it('達成條件時，新解鎖的彩蛋加入 h.secrets 並由函式回傳', () => {
    const h = newHero()
    h.secrets = []
    h.tally = { deathStreak: 0, crits: 0, superKills: 3, cleanClears: 0, breaks: 0 }

    const unlocked = checkSecrets(h)
    expect(unlocked.map((s) => s.id)).toEqual(['giantslayer'])
    expect(h.secrets).toContain('giantslayer')
    expect(hasSecret(h, 'giantslayer')).toBe(true)
  })

  it('多個條件同時達成時，一次解鎖並回傳所有符合的彩蛋', () => {
    const h = newHero()
    h.secrets = []
    h.tally = { deathStreak: 10, crits: 300, superKills: 3, cleanClears: 3, breaks: 5 }

    const unlocked = checkSecrets(h)
    const ids = unlocked.map((s) => s.id)
    expect(ids).toContain('avenger')
    expect(ids).toContain('giantslayer')
    expect(ids).toContain('ironhand')
    expect(ids).toContain('luckyhand')
    expect(ids).toContain('ascetic')
    expect(unlocked.length).toBe(5)
  })

  it('已解鎖的彩蛋再次檢查時不會重複加入或重複回傳', () => {
    const h = newHero()
    h.secrets = ['ironhand']
    h.tally = { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 10 }

    const unlocked = checkSecrets(h)
    expect(unlocked).toEqual([])
    expect(h.secrets.filter((id) => id === 'ironhand').length).toBe(1)
  })

  it('舊存檔缺 secrets 欄位時自動初始化為空陣列', () => {
    const h = newHero()
    delete (h as Partial<Hero>).secrets
    h.tally = { deathStreak: 0, crits: 0, superKills: 3, cleanClears: 0, breaks: 0 }

    const unlocked = checkSecrets(h)
    expect(h.secrets).toBeDefined()
    expect(h.secrets).toContain('giantslayer')
    expect(unlocked.length).toBe(1)
  })

  it('hasSecret 在 secrets 為 undefined 時安全回傳 false', () => {
    const h = newHero()
    delete (h as Partial<Hero>).secrets
    expect(hasSecret(h, 'ironhand')).toBe(false)
  })
})

// ── 彩蛋裝備去重 ──────────────────────────────────────────

describe('missingUniques 彩蛋裝備去重', () => {
  it('背包為空時，回傳全部 6 件彩蛋裝備規格', () => {
    const h = newHero()
    h.bag = []
    const missing = missingUniques(h)
    expect(missing.length).toBe(UNIQUES.length)
    expect(missing.length).toBe(6)
  })

  it('拿過的就排除掉 —— 依據是永久紀錄，不是背包', () => {
    const h = newHero()
    h.uniquesFound = ['u-debugger']

    const missing = missingUniques(h)
    expect(missing.length).toBe(5)
    expect(missing.some((u) => u.id === 'u-debugger')).toBe(false)
    expect(missing.some((u) => u.id === 'u-zeroday')).toBe(true)
  })

  it('背包擁有一般裝備（unique 為 undefined）時不影響彩蛋判定', () => {
    const h = newHero()
    h.bag = [
      {
        id: 'normal-1',
        name: '一般鐵劍',
        slot: 'main',
        rarity: 'common' as Rarity,
        ilvl: 5,
        atk: 10,
        def: 0,
        affixes: [],
      },
    ]

    const missing = missingUniques(h)
    expect(missing.length).toBe(6)
  })

  it('全部拿過就回空陣列', () => {
    const h = newHero()
    h.uniquesFound = UNIQUES.map((u) => u.id)
    expect(missingUniques(h)).toEqual([])
  })

  it('★ 賣掉之後也不會再掉一次', () => {
    // 這一項是整個「獨一無二」的重點。
    // 舊版是掃背包判斷「拿過沒有」，於是賣掉、清雜物、或任何讓它離開背包的
    // 操作之後它就變回「沒拿過」——那叫「一次只能有一件」，不是獨一無二。
    const h = newHero()
    recordUnique(h, 'u-debugger')
    h.bag = []                     // 賣掉了
    expect(missingUniques(h).some((u) => u.id === 'u-debugger')).toBe(false)
  })

  it('recordUnique 重複呼叫不會累積重複的 id', () => {
    const h = newHero()
    recordUnique(h, 'u-loop')
    recordUnique(h, 'u-loop')
    expect(h.uniquesFound).toEqual(['u-loop'])
  })

  it('舊存檔補課：背包裡既有的彩蛋裝備要補進永久紀錄', () => {
    // 沒有這一步，改版之後老玩家手上那幾件會被當成「沒拿過」而重複掉
    const h = newHero()
    h.uniquesFound = undefined
    h.bag = [makeUnique(UNIQUES[0], 10, 'x1'), makeUnique(UNIQUES[1], 10, 'x2')]
    rememberUniques(h)
    expect(h.uniquesFound).toEqual([UNIQUES[0].id, UNIQUES[1].id])
    expect(missingUniques(h).length).toBe(UNIQUES.length - 2)
  })
})

// ── 彩蛋裝備建立 ──────────────────────────────────────────

describe('makeUnique 彩蛋裝備建立', () => {
  it('武器（slot=main）：具有攻擊力與技能線，防禦為 0，稀有度必為 mythic', () => {
    const swordSpec = UNIQUES.find((u) => u.id === 'u-debugger')!
    const item = makeUnique(swordSpec, 20, 'weapon-test-1')

    expect(item.id).toBe('weapon-test-1')
    expect(item.name).toBe(swordSpec.name)
    expect(item.slot).toBe('main')
    expect(item.rarity).toBe('mythic')
    expect(item.ilvl).toBe(20)
    expect(item.line).toBe(swordSpec.line)
    expect(item.atk).toBeGreaterThan(0)
    expect(item.def).toBe(0)
    expect(item.unique).toBe('u-debugger')
  })

  it('防具/飾品（slot!=main）：具有防禦力，攻擊力為 0', () => {
    const capeSpec = UNIQUES.find((u) => u.id === 'u-memleak')!
    const item = makeUnique(capeSpec, 20, 'cape-test-1')

    expect(item.slot).toBe('body')
    expect(item.def).toBeGreaterThan(0)
    expect(item.atk).toBe(0)
    expect(item.line).toBeUndefined()
  })

  it('裝備數值隨 ilvl 等級放大', () => {
    const swordSpec = UNIQUES.find((u) => u.id === 'u-debugger')!
    const low = makeUnique(swordSpec, 10, 'w-low')
    const high = makeUnique(swordSpec, 50, 'w-high')

    expect(high.atk).toBeGreaterThan(low.atk)
  })

  it('詞綴進行深拷貝，修改產出裝備不污染原始 spec', () => {
    const ringSpec = UNIQUES.find((u) => u.id === 'u-loop')!
    const item = makeUnique(ringSpec, 10, 'ring-test')

    expect(item.affixes).toEqual(ringSpec.affixes)
    expect(item.affixes).not.toBe(ringSpec.affixes) // 陣列物件參考不同

    // 修改產出物品詞綴數值
    item.affixes[0].value = 999
    expect(ringSpec.affixes[0].value).not.toBe(999)
  })
})
