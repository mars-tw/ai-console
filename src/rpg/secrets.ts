// 彩蛋：藏起來的技能與獨一無二的裝備
//
// 設計原則是「做得到，但不會不小心達成」。
// 條件如果太容易，第一天就全開，就沒有「原來還有這個」的一刻；
// 太難或太隱晦（例如要在特定時間點做特定順序），就變成看攻略才玩得到。
//
// 所以每一個都給線索：沒解鎖時介面上會顯示「怎麼樣才會拿到」的提示，
// 但不說死。玩家看得到目標，也還留著發現的餘地。

import type { Hero, Item, Rarity, Slot } from './types'

export interface Secret {
  id: string
  name: string
  desc: string
  /** 沒解鎖時給的線索 */
  hint: string
  /** 達成沒有 */
  test: (h: Hero) => boolean
}

const tally = (h: Hero) => h.tally ?? { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }

export const SECRETS: Secret[] = [
  {
    id: 'avenger',
    name: '復仇者',
    desc: '常駐：每回合回復自身 10% 最大生命。',
    hint: '倒下十次都還沒放棄的人，會得到一點回報。',
    test: (h) => tally(h).deathStreak >= 10,
  },
  {
    id: 'giantslayer',
    name: '巨人殺手',
    desc: '常駐：對超級菁英的傷害 +30%。',
    hint: '打倒三隻遠比你強的東西。',
    test: (h) => tally(h).superKills >= 3,
  },
  {
    id: 'ironhand',
    name: '鐵匠之手',
    desc: '常駐：強化成功率 +8%。',
    hint: '在強化台前碎掉五件裝備之後，手會變穩。',
    test: (h) => tally(h).breaks >= 5,
  },
  {
    id: 'luckyhand',
    name: '幸運手',
    desc: '常駐：暴擊率 +5%。',
    hint: '暴擊三百次，運氣就不只是運氣了。',
    test: (h) => tally(h).crits >= 300,
  },
  {
    id: 'collector',
    name: '蒐藏家',
    desc: '常駐：金幣獲得 +15%。',
    hint: '湊齊六個人形夥伴（總共有八個，任選六個就行）。',
    test: (h) => (h.roster ?? []).filter((r) => !['kimi', 'claude', 'codex', 'grok', 'qwen', 'cursor', 'gemini'].includes(r.kind)).length >= 6,
  },
  {
    id: 'ascetic',
    name: '苦行者',
    desc: '常駐：技能魔力消耗 −20%。',
    hint: '一口藥水都不喝，通關三次地城。',
    test: (h) => tally(h).cleanClears >= 3,
  },
]

export const SECRET_BY_ID = Object.fromEntries(SECRETS.map((s) => [s.id, s]))
export const hasSecret = (h: Hero, id: string) => !!h.secrets?.includes(id)

/**
 * 檢查有沒有新解鎖的，回傳這次新開的那些。
 * 每次戰鬥結算後呼叫一次就好 —— 條件都是累計值，不會在回合中途達成。
 */
export function checkSecrets(h: Hero): Secret[] {
  h.secrets ??= []
  const got: Secret[] = []
  for (const s of SECRETS) {
    if (!h.secrets.includes(s.id) && s.test(h)) {
      h.secrets.push(s.id)
      got.push(s)
    }
  }
  return got
}

// ── 彩蛋裝備 ───────────────────────────────────────
/**
 * 獨一無二的特殊裝備。只從超級菁英與裝備抽卡的低機率位掉。
 *
 * 詞綴刻意做得比同級隨機裝備極端：不是「好一點」，是「換一種打法」。
 * 一件能改變你怎麼配點的裝備，比一件數值高 8% 的裝備有趣得多。
 */
export interface UniqueSpec {
  id: string
  name: string
  slot: Slot
  line?: 'melee' | 'ranged' | 'magic' | 'faith'
  desc: string
  /** 相對同級隨機裝的基礎值倍率 */
  mult: number
  affixes: { key: Item['affixes'][number]['key']; value: number }[]
}

export const UNIQUES: UniqueSpec[] = [
  {
    id: 'u-debugger', name: '除錯者之刃', slot: 'main', line: 'melee', mult: 1.55,
    desc: '刃上刻著一行沒有人看得懂的堆疊追蹤。', affixes: [{ key: 'crit', value: 0.18 }, { key: 'str', value: 22 }],
  },
  {
    id: 'u-zeroday', name: '零日之弓', slot: 'main', line: 'ranged', mult: 1.5,
    desc: '拉滿之前，沒有人知道它會射出什麼。', affixes: [{ key: 'haste', value: 0.22 }, { key: 'dex', value: 20 }],
  },
  {
    id: 'u-loop', name: '無限迴圈之戒', slot: 'ring1', mult: 1.2,
    desc: '戴上之後時間好像過得比較快。', affixes: [{ key: 'haste', value: 0.28 }],
  },
  {
    id: 'u-memleak', name: '記憶體洩漏斗篷', slot: 'body', mult: 1.35,
    desc: '它會慢慢把敵人的東西漏到你身上。', affixes: [{ key: 'leech', value: 0.2 }, { key: 'vit', value: 18 }],
  },
  {
    id: 'u-seed', name: '亂數種子', slot: 'ring2', mult: 1.15,
    desc: '每一次都不一樣，但總是有點用。', affixes: [{ key: 'crit', value: 0.12 }, { key: 'int', value: 18 }],
  },
  {
    id: 'u-mug', name: '熬夜者的馬克杯', slot: 'off', mult: 1.1,
    desc: '裡面永遠還有一口。凌晨三點特別有效。', affixes: [{ key: 'fai', value: 24 }, { key: 'haste', value: 0.1 }],
  },
]

export const UNIQUE_BY_ID = Object.fromEntries(UNIQUES.map((u) => [u.id, u]))

/** 還沒拿過的彩蛋裝備。同一件不重複掉，不然「獨一無二」就沒有意義 */
export function missingUniques(h: Hero): UniqueSpec[] {
  const owned = new Set(h.bag.map((i) => i.unique).filter(Boolean))
  return UNIQUES.filter((u) => !owned.has(u.id))
}

/** 造一件彩蛋裝備。ilvl 跟著主角走，所以什麼時候拿到都不會馬上退休 */
export function makeUnique(spec: UniqueSpec, ilvl: number, id: string): Item {
  const isWeapon = spec.slot === 'main'
  return {
    id,
    name: spec.name,
    slot: spec.slot,
    rarity: 'legend' as Rarity,
    ilvl,
    line: spec.line,
    atk: isWeapon ? Math.round((4 + ilvl * 2.2) * 2 * spec.mult) : 0,
    def: isWeapon ? 0 : Math.round((2 + ilvl * 1.4) * 2 * spec.mult),
    affixes: spec.affixes.map((a) => ({ ...a })),
    unique: spec.id,
  }
}
