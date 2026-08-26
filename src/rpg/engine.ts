// 戰鬥引擎：數值計算、掉落、tick 制戰鬥
//
// 戰鬥是回合 tick 驅動的，所以掛在背景也會自己打（沉浸練功），
// 切到冒險分頁時玩家可以插隊指定技能（手動操作）。

import {
  AFFIX_POOL, AFFIX_SCALE, ARMOR_NAMES, DUNGEON_BY_ID, MONSTER_BY_ID,
  PET_DROP_CHANCE, PET_KINDS, PREFIXES,
  RARITY_SPEC, SKILL_BY_ID, SKILLS, WEAPON_NAMES, ZONE_BY_ID,
} from './data'
import { itemLabel, t } from '@/i18n'
import {
  checkSecretAllies, ensureRoster, growRecruit, syncSecretAllies,
} from './allies'
import { effAtk, effDef, plusMult } from './enhance'
import {
  checkSecrets, hasSecret, makeUnique, missingUniques, recordUnique, syncUniques,
} from './secrets'
import {
  ATTRS, LINES, type Affix, type Attr, type Combatant, type Hero, type HeroLook,
  type Item, type Pet, SLOTS, type FxEvent, type Line, type Loadout, type LogEntry, type Monster,
  type Rarity, type Slot, type Stats,
} from './types'

const rnd = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(a: T[]): T => a[rnd(a.length)]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
let idSeq = 0
const nextId = () => `i${Date.now().toString(36)}${(idSeq++).toString(36)}`

// ── 等級 ───────────────────────────────────────────
/**
 * 升級所需經驗。
 *
 * 原本是 60 × lv^1.55，實測升級太快 —— 掛著自動戰鬥大概一分鐘一級。
 * 指數拉到 1.75 之後，每級要打的怪大約變兩倍（Lv.12 從 34 隻變 69 隻），
 * 但不會變成純耗時間的苦工。
 */
export const xpForLevel = (level: number) => Math.round(75 * Math.pow(level, 1.75))

// ── 套裝 ───────────────────────────────────────────
export function emptyLoadout(name: string): Loadout {
  return {
    name,
    equipped: {},
    skills: {},
    attrs: { str: 0, dex: 0, int: 0, fai: 0, vit: 0 },
  }
}

export function newHero(name = '你', look: HeroLook = 'hero'): Hero {
  const h: Hero = {
    name, look, level: 1, xp: 0, gold: 0,
    bag: [], loadouts: [emptyLoadout('主要'), emptyLoadout('第二套'), emptyLoadout('第三套')],
    active: 0, zone: 'meadow', kills: 0, deaths: 0,
    potions: { hp: 3, mp: 2 },
    pets: [],
    // 一開始就送一張券，讓新玩家第一次打開抽卡分頁就有東西可以按 ——
    // 空的抽卡介面看起來像還沒做完
    tickets: { ally: 1, gear: 1 },
    secrets: [],
    tally: { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 },
    roster: [],
  }
  ensureRoster(h)
  // 給一把起手武器，不然第一場會很難看
  const starter = rollItem(1, 'main', 'common', 'melee')
  starter.name = '練習用短劍'
  h.bag.push(starter)
  h.loadouts[0].equipped.main = starter.id
  return h
}

export const activeLoadout = (h: Hero) => h.loadouts[h.active]

/**
 * 配點預算：每一套各自算，不是共用一個池子。
 *
 * 原本點數池放在 Hero 上（h.attrPoints），配出去的點卻記在各自的套裝裡。
 * 結果第一套配完，池子歸零，切到第二套時屬性全是 0、又沒有點可以配 ——
 * 那兩套等於是壞的，而「整組切換」這個賣點也就不存在了。
 * 改成「等級給的總點數 − 這一套已經配掉的」，三套就各自獨立、隨時可切。
 */
export const attrBudget = (level: number) => 5 + (level - 1) * 3
export const skillBudget = (level: number) => 3 + (level - 1) * 2

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
export const spentAttr = (lo: Loadout) => sum(lo.attrs)
export const spentSkill = (lo: Loadout) => sum(lo.skills)
/** 這一套還剩幾點可以配 */
export const attrLeft = (h: Hero, lo: Loadout = activeLoadout(h)) => attrBudget(h.level) - spentAttr(lo)
export const skillLeft = (h: Hero, lo: Loadout = activeLoadout(h)) => skillBudget(h.level) - spentSkill(lo)
export const itemById = (h: Hero, id?: string) => (id ? h.bag.find((i) => i.id === id) : undefined)

/** 某條線總共投了幾點（決定技能解鎖） */
export function linePoints(lo: Loadout, line: Line): number {
  return SKILLS.filter((s) => s.line === line)
    .reduce((sum, s) => sum + (lo.skills[s.id] ?? 0), 0)
}

/** 技能是否已解鎖（該線點數達門檻） */
export const skillUnlocked = (lo: Loadout, id: string) => {
  const s = SKILL_BY_ID[id]
  return !!s && linePoints(lo, s.line) >= s.req
}

// ── 數值 ───────────────────────────────────────────
export function computeStats(h: Hero): Stats {
  const lo = activeLoadout(h)
  const attrs: Record<Attr, number> = { str: 5, dex: 5, int: 5, fai: 5, vit: 5 }
  for (const a of ATTRS) attrs[a] += lo.attrs[a] ?? 0
  // 等級本身也會長一點基礎屬性
  for (const a of ATTRS) attrs[a] += Math.floor((h.level - 1) * 0.5)

  let atk = 0, def = 0, crit = 0.05, haste = 0, leech = 0
  for (const slot of Object.keys(lo.equipped) as Slot[]) {
    const it = itemById(h, lo.equipped[slot])
    if (!it) continue
    // 強化只加基礎攻防，不放大詞綴 —— 詞綴一起放大的話，
    // 一件 +15 的傳說會直接讓其他所有裝備變成裝飾品。
    const pm = plusMult(it)
    atk += it.atk * pm
    def += it.def * pm
    for (const af of it.affixes) {
      if (af.key === 'atk') atk += af.value
      else if (af.key === 'def') def += af.value
      else if (af.key === 'crit') crit += af.value
      else if (af.key === 'haste') haste += af.value
      else if (af.key === 'leech') leech += af.value
      else attrs[af.key] += af.value
    }
  }

  atk += attrs.str * 0.9 + attrs.dex * 0.8 + attrs.int * 0.85 + attrs.fai * 0.7
  def += attrs.vit * 0.8 + h.level * 1.2
  if (hasSecret(h, 'luckyhand')) crit += 0.05
  return {
    hpMax: Math.round(60 + h.level * 22 + attrs.vit * 9),
    mpMax: Math.round(30 + h.level * 6 + attrs.int * 4 + attrs.fai * 4),
    atk: Math.round(atk),
    def: Math.round(def),
    crit: clamp(crit, 0, 0.75),
    haste: clamp(haste, 0, 0.6),
    leech: clamp(leech, 0, 0.4),
    attrs,
  }
}

// ── 掉落 ───────────────────────────────────────────
export function rollRarity(bonus = 0): Rarity {
  const r = Math.random() * 100 - bonus * 7
  if (r > 97) return 'legend'
  if (r > 88) return 'rare'
  if (r > 68) return 'fine'
  if (r > 25) return 'common'
  return 'crude'
}

export function rollItem(ilvl: number, slot?: Slot, rarity?: Rarity, line?: Line): Item {
  const s: Slot = slot ?? pick(['main', 'off', 'head', 'body', 'hands', 'feet', 'ring1', 'ring2'] as Slot[])
  const rar: Rarity = rarity ?? rollRarity()
  const spec = RARITY_SPEC[rar]
  const isWeapon = s === 'main'
  const ln: Line | undefined = isWeapon ? (line ?? pick(LINES)) : undefined

  const base = isWeapon
    ? { atk: Math.round((4 + ilvl * 2.2) * spec.mult), def: 0 }
    : { atk: 0, def: Math.round((2 + ilvl * 1.4) * spec.mult) }

  const used = new Set<string>()
  const affixes: Affix[] = []
  for (let i = 0; i < spec.affixes; i++) {
    const key = pick(AFFIX_POOL.filter((k) => !used.has(k)))
    if (!key) break
    used.add(key)
    const raw = AFFIX_SCALE[key] * ilvl * spec.mult * (0.7 + Math.random() * 0.6)
    const value = AFFIX_SCALE[key] < 0.02 ? Number(raw.toFixed(3)) : Math.max(1, Math.round(raw))
    affixes.push({ key, value })
  }

  const noun = isWeapon ? pick(WEAPON_NAMES[ln!]) : pick(ARMOR_NAMES[s] ?? ['護具'])
  const prefix = pick(PREFIXES[rar])
  return {
    id: nextId(), name: `${prefix}${noun}`, slot: s, rarity: rar, ilvl,
    line: ln, atk: base.atk, def: base.def, affixes,
  }
}

/**
 * 擇優裝備：每個部位挑分數最高的一件換上。
 *
 * 分數用 itemScore()，武器另外看技能線 —— 你把點數投在魔法上卻穿著一把
 * 力量向的斧頭，數字再高也不會比較強，所以同分時偏好你主修那條線的武器。
 * 回傳實際換了哪些部位，好在介面上告訴使用者做了什麼。
 */
/** 目前投點最多的那條技能線。主手武器合不合系用它判斷 */
export function mainLineOf(h: Hero): Line {
  const lo = activeLoadout(h)
  return LINES.reduce((best, l) =>
    linePoints(lo, l) > linePoints(lo, best) ? l : best, LINES[0])
}

export function autoEquipBest(h: Hero): { slot: Slot; from?: string; to: string }[] {
  const lo = activeLoadout(h)
  const mainLine = mainLineOf(h)
  const changed: { slot: Slot; from?: string; to: string }[] = []

  for (const slot of SLOTS) {
    const cands = h.bag.filter((it) => it.slot === slot)
    if (!cands.length) continue
    const rank = (it: Item) => equipRank(it, mainLine)
    const best = cands.reduce((a, b) => (rank(b) > rank(a) ? b : a))
    const cur = itemById(h, lo.equipped[slot])
    if (cur?.id === best.id) continue
    if (cur && rank(cur) >= rank(best)) continue
    lo.equipped[slot] = best.id
    changed.push({ slot, from: cur?.name, to: best.name })
  }
  return changed
}

/**
 * 一件裝備實際值多少 —— 主手不是本系武器要打折。
 *
 * 抽成共用函式是因為 isUpgrade 與 autoEquipBest 原本用兩把不同的尺：
 * 前者只比 itemScore，後者對非本系主手乘 0.75。
 * 結果背包裡一把高分的非本系武器被標成「▲ 比目前裝著的好」，
 * 按下「一鍵擇優裝備」卻回你「目前已經是最佳配置」——
 * 標示跟按鈕互相打臉，而且看不出原因。
 */
export function equipRank(it: Item, mainLine: Line | null): number {
  return itemScore(it) * (it.slot === 'main' && it.line && it.line !== mainLine ? 0.75 : 1)
}

/** 這件比目前裝著的好嗎（背包篩選「只看可升級」用） */
export function isUpgrade(h: Hero, it: Item): boolean {
  const lo = activeLoadout(h)
  const cur = itemById(h, lo.equipped[it.slot])
  const line = mainLineOf(h)
  return !cur || equipRank(it, line) > equipRank(cur, line)
}

/**
 * 裝備的粗略分數，用來提示「這件比較好」。
 *
 * **一定要含強化。** 這個分數不只是拿來看的 —— autoEquipBest（⚡ 一鍵擇優裝備）
 * 與背包的 ▲ 標記都靠它排序。不含強化的話，一鍵擇優會把你 +10 的武器
 * 換成一把基礎攻擊多 1 點的白裝，直接毀掉幾十次強化的投入。
 * 那是「幫倒忙」，比沒有這個按鈕更糟。
 */
export function itemScore(it: Item): number {
  let n = effAtk(it) * 2 + effDef(it) * 1.5
  for (const a of it.affixes) n += AFFIX_SCALE[a.key] < 0.02 ? a.value * 400 : a.value * 2
  return Math.round(n)
}

// ── 戰鬥 ───────────────────────────────────────────
export interface Battle {
  kind: 'field' | 'dungeon'
  placeId: string
  room: number
  rooms: number
  hero: Combatant
  /** 出戰中的寵物（沒帶就是 null）*/
  pet: Combatant | null
  allies: Combatant[]
  foes: Combatant[]
  log: LogEntry[]
  /** 給戰鬥畫面做動作與跳字，只留最近幾回合 */
  fx: FxEvent[]
  /** 主角主手武器屬於哪條技能線 —— 畫面用它決定手上疊哪把武器 */
  heroWeapon: Line | null
  /** 主角外觀（男/女），畫面用它決定取哪組圖 */
  heroLook: HeroLook
  tick: number
  over: boolean
  result?: 'win' | 'lose'
  /** 這一場打出幾次暴擊（解鎖「幸運手」用） */
  critHits: number
  /** 這一場有沒有喝過藥水（解鎖「苦行者」用） */
  potionUsed: boolean
  /** 這一場打倒幾隻超級菁英 */
  superKills: number
  /** 這一場掉了幾張抽卡券 */
  tickets: { ally: number; gear: number }
  /** 手動模式排隊的技能 id */
  queued?: string
  /** 玩家點選的集火目標（foe 的 uid）。目標死了會自動清掉 */
  focus?: string
  /** 主角本回合處於格擋姿態：擋下重擊的大半傷害 */
  guarding?: boolean
  /**
   * 回合制的行動佇列。
   *
   * 一個回合不再「一次跑完」，而是排成一串，由畫面一個一個放出來 ——
   * 這樣每個人出手都看得到、也才有下指令的空檔。
   * 空的代表現在是「等玩家下令」的階段。
   */
  queue: string[]
  /** 本回合玩家指定的行動：技能 id（null 代表普攻）*/
  order?: { skill: string | null; target?: string }
  /** 回合階段：input = 等下令，resolve = 逐個結算中 */
  phase: 'input' | 'resolve'
  loot: Item[]
  /** 這場戰鬥撿到的藥水，結算時才進背包 */
  potionDrops: { hp: number; mp: number }
  /** 這場遇到的寵物（art），結算時收服 */
  petDrop?: string
  xp: number
  gold: number
  kills: number
}

const LOG_MAX = 60
const FX_MAX = 40

function fx(b: Battle, uid: string, kind: FxEvent['kind'], amount?: number, skill?: string) {
  b.fx.push({ uid, kind, amount, tick: b.tick, skill })
  if (b.fx.length > FX_MAX) b.fx.splice(0, b.fx.length - FX_MAX)
}

function say(b: Battle, kind: LogEntry['kind'], text: string) {
  b.log.push({ t: b.tick, kind, text })
  if (b.log.length > LOG_MAX) b.log.splice(0, b.log.length - LOG_MAX)
}

function heroCombatant(h: Hero): Combatant {
  const st = computeStats(h)
  const lo = activeLoadout(h)
  const skills = Object.entries(lo.skills)
    .filter(([id, lv]) => lv > 0 && skillUnlocked(lo, id))
    .map(([id]) => id)
  return {
    uid: 'hero', side: 'hero', art: 'hero', name: h.name,
    hp: st.hpMax, hpMax: st.hpMax, mp: st.mpMax, mpMax: st.mpMax,
    atk: st.atk, def: st.def, crit: st.crit, leech: st.leech,
    cds: {}, skills: skills.length ? skills : ['slash'], color: '#e8eef4',
  }
}

function foeCombatant(m: Monster, n: number): Combatant {
  return {
    uid: `foe${n}`, side: 'foe', art: m.id, name: m.name,
    hp: m.hp, hpMax: m.hp, mp: 0, mpMax: 0,
    atk: m.atk, def: m.def, crit: m.boss ? 0.15 : 0.05, leech: 0,
    cds: {}, skills: [], color: m.boss ? '#f87171' : '#a3a3a3',
  }
}

/**
 * 寵物的戰鬥數值。刻意做得比隊友弱一截 ——
 * 它是「陪你打」不是「幫你打完」，太強會讓玩家的操作變得無所謂。
 */
export function petCombatant(p: Pet): Combatant {
  const hp = 40 + p.level * 12
  return {
    uid: `pet-${p.id}`, side: 'pet', art: p.art, name: p.name,
    hp, hpMax: hp, mp: 0, mpMax: 0,
    atk: Math.round(6 + p.level * 1.6), def: Math.round(2 + p.level * 0.8),
    crit: 0.1, leech: 0, cds: {}, skills: [], color: '#f472b6',
  }
}

/** 寵物升級：跟著主角打，經驗是主角的一半 */
export function growPet(p: Pet, xp: number): boolean {
  p.xp += Math.round(xp * 0.5)
  let up = false
  while (p.xp >= petXpForLevel(p.level)) {
    p.xp -= petXpForLevel(p.level)
    p.level++
    up = true
  }
  return up
}
export const petXpForLevel = (lv: number) => Math.round(50 * Math.pow(lv, 1.6))

export function allyCombatant(key: string, name: string, color: string, level: number, line: Line): Combatant {
  const hp = 50 + level * 18
  return {
    uid: `ally-${key}`, side: 'ally', art: key, name,
    hp, hpMax: hp, mp: 40 + level * 5, mpMax: 40 + level * 5,
    atk: Math.round(8 + level * 2.4), def: Math.round(3 + level * 1.1),
    crit: 0.08, leech: 0, cds: {},
    skills: [SKILLS.find((s) => s.line === line && s.req === 0)!.id,
             SKILLS.find((s) => s.line === line && s.req === 3)!.id],
    color,
  }
}

/**
 * 一波幾隻怪。
 *
 * 回合制的重點是「這回合要打誰」，只有一隻的話根本沒有選擇。
 * 所以基礎就給多隻，並隨等級再多一點 —— 但上限壓在 4，
 * 再多陣型就會塞不下、畫面也讀不了。
 */
export function waveSize(heroLevel: number, kind: 'field' | 'dungeon'): number {
  const base = kind === 'dungeon' ? 2 : 1
  const bonus = heroLevel >= 20 ? 2 : heroLevel >= 8 ? 1 : 0
  return Math.min(4, base + bonus + (Math.random() < 0.35 ? 1 : 0))
}

/** 每隻小怪有機會變成精英：血厚攻高，但掉落也好，值得優先集火 */
const ELITE_CHANCE = 0.18
const ELITE_MULT = { hp: 1.9, atk: 1.35, def: 1.2 }

/**
 * 超級菁英：每 20 等開一個新階級。
 *
 * 設計目標是「打不過也是正常的」—— 這是遊戲裡少數會逼你回去整理裝備的東西。
 * 數值刻意做成同級精英的好幾倍，全身高階裝備再加上等級略高才有勝算；
 * 相對地一隻抵一整波的獎勵，還會掉抽卡券與彩蛋裝備。
 *
 * 階級從 Lv.20 起算，上限四階（Lv.80+）。再往上加階級只是數字膨脹，
 * 沒有新的玩法。
 */
export const superTier = (heroLevel: number) => Math.min(4, Math.floor(heroLevel / 20))
const SUPER_CHANCE = 0.07

/**
 * 一個「當前等級、身上是像樣裝備」的主角大概長什麼樣。
 *
 * 超級菁英的數值必須對著這個算，不能像一般精英那樣去乘小怪的基礎值 ——
 * 小怪的防禦是 2 + 等級×1.2（Lv.20 約 26），主角的防禦是裝備堆出來的（實測 264），
 * 兩者差一個數量級。乘小怪的結果就是：血條看起來很嚇人（×9.5），
 * 但減免只有 0.63，主角一招處決打掉三分之一，三回合就結束。
 *
 * 這三條是拿 Lv.20 全身普通裝的實測值回歸出來的：攻 187 / 防 264 / 血 842。
 */
const refAtk = (lv: number) => 40 + lv * 7.5
const refDef = (lv: number) => 30 + lv * 11
const refHp = (lv: number) => 60 + lv * 34

function makeSuper(c: Combatant, tier: number, heroLevel: number) {
  const lv = Math.max(heroLevel, 1)
  c.super = tier
  c.elite = true
  // 血：撐得住十幾回合，但不是拖時間。太厚只會變成一邊倒的按鍵練習
  c.hpMax = Math.round(refHp(lv) * (5.5 + tier * 2.5))
  c.hp = c.hpMax
  // 攻：打在滿裝主角身上要有「再挨兩下就沒了」的實感
  c.atk = Math.round(refAtk(lv) * (2.9 + tier * 0.55))
  // 防：把主角的技能爆發壓下來。這是「要穿高階裝」的主要理由 ——
  // 攻擊力不夠的話減免會把你的傷害吃到只剩零頭
  c.def = Math.round(refDef(lv) * (2.5 + tier * 0.9))
  c.crit = Math.min(0.5, 0.12 + 0.06 * tier)
  c.name = t('超級菁英·{name}', { name: t(c.name) })
}

function spawnWave(b: Battle, ids: string[], count: number, heroLevel = 1) {
  b.foes = []
  b.focus = undefined                     // 換一波敵人，舊的集火目標作廢
  for (let i = 0; i < count; i++) {
    const m = MONSTER_BY_ID[pick(ids)]
    if (!m) continue
    const c = foeCombatant(m, b.tick * 10 + i)
    // 一波最多一隻超級菁英。兩隻同時出現不是難，是直接沒得打
    const tier = superTier(heroLevel)
    if (tier > 0 && !b.foes.some((f) => f.super) && Math.random() < SUPER_CHANCE) {
      makeSuper(c, tier, heroLevel)
      b.foes.push(c)
      continue
    }
    if (Math.random() < ELITE_CHANCE) {
      c.elite = true
      c.hpMax = Math.round(c.hpMax * ELITE_MULT.hp)
      c.hp = c.hpMax
      c.atk = Math.round(c.atk * ELITE_MULT.atk)
      c.def = Math.round(c.def * ELITE_MULT.def)
      c.name = t('精英{name}', { name: t(c.name) })
    }
    b.foes.push(c)
  }
}

/** 目前出戰的寵物，沒帶回 null */
export function activePet(h: Hero): Combatant | null {
  const p = h.pets?.find((x) => x.id === h.activePet)
  return p ? petCombatant(p) : null
}

/** 主手裝的是哪一類武器；沒裝或不是武器就回 null */
export function equippedWeaponLine(h: Hero): Line | null {
  const lo = activeLoadout(h)
  const id = lo.equipped.main
  if (!id) return null
  return h.bag.find((it) => it.id === id)?.line ?? null
}

export function startBattle(h: Hero, kind: 'field' | 'dungeon', placeId: string, allies: Combatant[]): Battle {
  const b: Battle = {
    kind, placeId, room: 1,
    rooms: kind === 'dungeon' ? (DUNGEON_BY_ID[placeId]?.rooms ?? 3) : 0,
    hero: heroCombatant(h), pet: activePet(h), allies, foes: [], log: [], fx: [], tick: 0,
    heroWeapon: equippedWeaponLine(h),
    heroLook: h.look ?? 'hero',
    queue: [], phase: 'input',
    over: false, loot: [], potionDrops: { hp: 0, mp: 0 }, xp: 0, gold: 0, kills: 0,
    critHits: 0, potionUsed: false, superKills: 0, tickets: { ally: 0, gear: 0 },
  }
  const place = kind === 'field' ? ZONE_BY_ID[placeId] : DUNGEON_BY_ID[placeId]
  const placeName = t(place?.name ?? placeId)
  say(b, 'info', kind === 'field'
    ? t('進入 {place}', { place: placeName })
    : t('踏入 {place}（第 1 / {rooms} 間）', { place: placeName, rooms: b.rooms }))
  const ids = kind === 'field' ? (ZONE_BY_ID[placeId]?.monsters ?? ['slime'])
    : (DUNGEON_BY_ID[placeId]?.trash ?? ['goblin'])
  spawnWave(b, ids, waveSize(h.level, kind), h.level)
  return b
}

/**
 * 防禦走遞減減傷，不是從傷害裡直接扣掉。
 * 直接扣的話，高防怪對攻擊力低的角色會近乎免疫 ——
 * 實測隊友打食人魔頭目一次只有 5 點，等於整隊只有主角在輸出。
 */
const DEF_K = 110
const mitigation = (def: number) => DEF_K / (DEF_K + Math.max(0, def))

function damage(src: Combatant, dst: Combatant, power: number, scaleBonus = 0,
                slayer = false): { dmg: number; crit: boolean } {
  const crit = Math.random() < src.crit
  // 彩蛋技能「巨人殺手」：打倒三隻超級菁英之後才拿得到，正好用在下一隻身上
  const bonus = slayer && dst.super ? 1.3 : 1
  const raw = src.atk * power * (1 + scaleBonus) * mitigation(dst.def) * bonus
  const dmg = Math.max(1, Math.round(raw * (crit ? 1.8 : 1) * (0.9 + Math.random() * 0.2)))
  return { dmg, crit }
}

/** 挑一個現在可以用、威力最高的技能 */
function chooseSkill(c: Combatant, h: Hero | null): string | null {
  const lo = h ? activeLoadout(h) : null
  let best: string | null = null
  let bestPower = -1
  for (const id of c.skills) {
    const sk = SKILL_BY_ID[id]
    if (!sk) continue
    if ((c.cds[id] ?? 0) > 0) continue
    if (sk.mpCost > c.mp) continue
    const lv = lo ? (lo.skills[id] ?? 1) : 1
    // 血少的時候優先補
    const p = sk.kind === 'heal' && c.hp < c.hpMax * 0.45 ? 99 : sk.power * (1 + lv * 0.1)
    if (p > bestPower) { bestPower = p; best = id }
  }
  return best
}

function act(b: Battle, c: Combatant, h: Hero | null, haste: number, skipCd = false) {
  if (c.hp <= 0) return
  // 玩家即時施放時不要再扣一次冷卻 —— 那一回合的冷卻已經在 tick 裡扣過了
  if (!skipCd) for (const k of Object.keys(c.cds)) if (c.cds[k] > 0) c.cds[k]--

  const ourSide = [b.hero, ...(b.pet ? [b.pet] : []), ...b.allies]
  const targets = c.side === 'foe' ? ourSide.filter((x) => x.hp > 0) : b.foes.filter((x) => x.hp > 0)
  if (!targets.length) return
  // 玩家點了集火目標，我方就全部打它 —— 這是「指揮隊伍」最直接的手段
  const focused = c.side !== 'foe' && b.focus
    ? targets.find((x) => x.uid === b.focus)
    : undefined

  // 玩家排隊的技能優先
  let skillId: string | null = null
  if (c.side === 'hero' && b.queued) {
    const sk = SKILL_BY_ID[b.queued]
    if (sk && (c.cds[b.queued] ?? 0) <= 0 && sk.mpCost <= c.mp) skillId = b.queued
    b.queued = undefined
  }
  if (!skillId) skillId = chooseSkill(c, h)

  // 王的重擊：先蓄力一回合預告，落下時傷害兩倍。
  // 這是整場戰鬥唯一需要玩家「反應」的節點 —— 看到預告就按格擋。
  if (c.side === 'foe' && MONSTER_BY_ID[c.art]?.boss) {
    if ((c.charge ?? 0) > 0) {
      c.charge = 0
      const tgt = focused ?? pick(targets)
      let { dmg } = damage(c, tgt, 2.0)
      const blocked = tgt.uid === b.hero.uid && b.guarding
      if (blocked) {
        dmg = Math.round(dmg * 0.3)
        fx(b, tgt.uid, 'guard')
      }
      tgt.hp = Math.max(0, tgt.hp - dmg)
      fx(b, c.uid, 'attack')
      fx(b, tgt.uid, 'crit', dmg)
      say(b, 'crit', blocked
        ? t('你擋下了 {who} 的重擊！只受到 {dmg} 傷害', { who: t(c.name), dmg })
        : t('{who} 的重擊命中 {target}，造成 {dmg} 傷害！', { who: t(c.name), target: t(tgt.name), dmg }))
      b.guarding = false
      if (tgt.hp === 0) { fx(b, tgt.uid, 'die'); say(b, 'death', t('{name} 倒下了', { name: t(tgt.name) })) }
      return
    }
    if (Math.random() < 0.3) {
      c.charge = 1
      fx(b, c.uid, 'charge')
      say(b, 'info', t('{who} 開始蓄力…下一擊會很痛', { who: t(c.name) }))
      return
    }
  }

  if (!skillId) {
    // 沒技能可用就普攻
    const tgt = focused ?? pick(targets)
    const { dmg, crit } = damage(c, tgt, 1, 0, !!h && hasSecret(h, 'giantslayer'))
    tgt.hp = Math.max(0, tgt.hp - dmg)
    fx(b, c.uid, 'attack')
    fx(b, tgt.uid, crit ? 'crit' : 'hurt', dmg)
    if (crit && c.side !== 'foe') b.critHits++
    say(b, crit ? 'crit' : 'hit', t('{who} 攻擊 {target}，造成 {dmg} 傷害{crit}', {
      who: t(c.name), target: t(tgt.name), dmg, crit: crit ? t('（暴擊！）') : '',
    }))
    if (tgt.hp === 0) { fx(b, tgt.uid, 'die'); say(b, 'death', t('{name} 倒下了', { name: t(tgt.name) })) }
    return
  }

  const sk = SKILL_BY_ID[skillId]
  const lo = h ? activeLoadout(h) : null
  const lv = lo ? (lo.skills[skillId] ?? 1) : 1
  const scaleBonus = h ? computeStats(h).attrs[sk.scale] / 60 : lv * 0.05
  // 彩蛋技能「苦行者」：不喝藥水通關三次地城才拿得到，回報是魔力更耐用
  const mpCost = h && hasSecret(h, 'ascetic') ? Math.round(sk.mpCost * 0.8) : sk.mpCost
  c.mp = Math.max(0, c.mp - mpCost)
  c.cds[skillId] = Math.max(0, Math.round(sk.cd * (1 - haste)))

  if (sk.kind === 'heal') {
    const amount = Math.round(sk.power * (12 + lv * 6) * (1 + scaleBonus))
    const pool = skillId === 'revive' ? [c, ...b.allies].filter((x) => x.hp > 0) : [c]
    for (const t of pool) {
      t.hp = Math.min(t.hpMax, t.hp + amount)
      fx(b, t.uid, 'skill', undefined, skillId)
      fx(b, t.uid, 'heal', amount)
    }
    say(b, 'heal', t('{who} 施放「{skill}」，回復 {amount} 生命', {
      who: t(c.name), skill: t(sk.name), amount,
    }))
    return
  }
  if (sk.kind === 'buff') {
    if (skillId === 'focus') {
      const amount = Math.round(c.mpMax * (0.3 + lv * 0.06))
      c.mp = Math.min(c.mpMax, c.mp + amount)
      say(b, 'heal', t('{who} 施放「{skill}」，回復 {amount} 魔力', {
        who: t(c.name), skill: t(sk.name), amount,
      }))
    } else if (skillId === 'ward') {
      c.def = Math.round(c.def * (1 + sk.power * 0.2))
      say(b, 'info', t('{who} 施放「{skill}」，防禦提升', { who: t(c.name), skill: t(sk.name) }))
    } else {
      c.atk = Math.round(c.atk * (1 + sk.power * 0.25))
      say(b, 'info', t('{who} 施放「{skill}」，攻擊提升', { who: t(c.name), skill: t(sk.name) }))
    }
    return
  }

  const tgt = skillId === 'execute'
    ? targets.reduce((a, x) => (x.hp / x.hpMax < a.hp / a.hpMax ? x : a), targets[0])
    : (focused ?? pick(targets))
  let { dmg, crit } = damage(c, tgt, sk.power * (1 + lv * 0.08), scaleBonus, !!h && hasSecret(h, 'giantslayer'))
  if (skillId === 'snipe') { crit = true; dmg = Math.round(dmg * 1.4) }
  if (skillId === 'execute' && tgt.hp < tgt.hpMax * 0.3) dmg = Math.round(dmg * 1.6)
  tgt.hp = Math.max(0, tgt.hp - dmg)
  fx(b, c.uid, 'attack')
  fx(b, tgt.uid, 'skill', undefined, skillId)   // 技能專屬特效，疊在目標身上
  fx(b, tgt.uid, crit ? 'crit' : 'hurt', dmg)
  if (c.leech > 0) c.hp = Math.min(c.hpMax, c.hp + Math.round(dmg * c.leech))
  say(b, crit ? 'crit' : 'hit', t('{who} 使用「{skill}」對 {target} 造成 {dmg} 傷害{crit}', {
    who: t(c.name), skill: t(sk.name), target: t(tgt.name), dmg, crit: crit ? t('（暴擊！）') : '',
  }))
  if (tgt.hp === 0) { fx(b, tgt.uid, 'die'); say(b, 'death', t('{name} 倒下了', { name: t(tgt.name) })) }
}

/** 跑一個回合。回傳是否有狀態變化值得重繪 */
// ── 玩家的即時操作 ────────────────────────────────
// 這幾個函式是「可玩性」的核心：戰鬥每 tick 自己跑，但玩家隨時可以插手。
// 全部都是即時生效，不排到下一回合 —— 排隊的操作感覺不到回饋。

/** 喝藥水：立刻回復，不佔回合 */
export function drinkPotion(b: Battle, h: Hero, kind: 'hp' | 'mp'): boolean {
  // potionUsed 一定要等「真的喝下去」才標記。
  //
  // 原本它是第一行、無條件執行 —— 滿血時誤按 H 會走進下面的 return false，
  // 沒扣藥水、沒回血，但整場已經被標記成喝過藥水，
  // 「苦行者」彩蛋（不喝藥水通關三次地城）就這樣被一個誤觸廢掉。
  // 玩家看到藥水數量沒少，根本不會知道發生了什麼。
  if (b.over || h.potions[kind] <= 0) return false
  const c = b.hero
  if (kind === 'hp' && c.hp >= c.hpMax) return false
  if (kind === 'mp' && c.mp >= c.mpMax) return false
  b.potionUsed = true
  h.potions[kind]--
  const amount = Math.round((kind === 'hp' ? c.hpMax : c.mpMax) * 0.4)
  if (kind === 'hp') {
    c.hp = Math.min(c.hpMax, c.hp + amount)
    fx(b, c.uid, 'heal', amount)
    say(b, 'heal', t('你喝下藥水，回復 {n} 生命', { n: amount }))
  } else {
    c.mp = Math.min(c.mpMax, c.mp + amount)
    fx(b, c.uid, 'heal', amount)
    say(b, 'heal', t('你喝下藥水，回復 {n} 魔力', { n: amount }))
  }
  return true
}

/** 進入格擋姿態，撐到下一次被打為止 */
export function guard(b: Battle): boolean {
  if (b.over || b.guarding) return false
  b.guarding = true
  fx(b, b.hero.uid, 'guard')
  say(b, 'info', t('你舉起武器格擋'))
  return true
}

/** 點選集火目標；再點一次同一個就取消 */
export function setFocus(b: Battle, uid: string | null) {
  b.focus = b.focus === uid || !uid ? undefined : uid
}

/**
 * 立刻施放技能，不等下一個 tick。
 *
 * 排隊式的施放（設 queued、等下一回合）在手感上是致命的：按下去沒有任何反應，
 * 玩家會以為壞掉了。這裡直接重用 act() 跑一次主角的行動，
 * 所有目標選擇、傷害、記錄、特效都跟自動戰鬥走同一條路徑。
 */
export function castNow(b: Battle, h: Hero, skillId: string): boolean {
  if (b.over) return false
  const c = b.hero
  const sk = SKILL_BY_ID[skillId]
  if (!sk || c.hp <= 0 || (c.cds[skillId] ?? 0) > 0 || sk.mpCost > c.mp) return false
  b.queued = skillId
  act(b, c, h, computeStats(h).haste, true)
  b.queued = undefined
  return true
}

/** 這回合的出手順序：我方由前而後，最後才輪到敵方 */
function turnOrder(b: Battle): string[] {
  return [
    b.hero.uid,
    ...(b.pet ? [b.pet.uid] : []),
    ...b.allies.map((a) => a.uid),
    ...b.foes.map((f) => f.uid),
  ]
}

function findUnit(b: Battle, uid: string): Combatant | undefined {
  if (b.hero.uid === uid) return b.hero
  if (b.pet?.uid === uid) return b.pet
  return b.allies.find((a) => a.uid === uid) ?? b.foes.find((f) => f.uid === uid)
}

/**
 * 玩家下令，開始結算這一回合。
 * skill 傳 null 代表普攻；target 沒傳就用目前的集火目標。
 */
export function commitOrder(b: Battle, skill: string | null, target?: string): boolean {
  if (b.over || b.phase !== 'input') return false
  b.order = { skill, target: target ?? b.focus }
  if (target) b.focus = target
  b.queue = turnOrder(b)
  b.phase = 'resolve'
  b.tick++
  return true
}

/**
 * 放出佇列裡的下一個行動。回傳 false 代表這回合已經結算完。
 *
 * 拆成一次一個是回合制的關鍵：畫面可以在每個行動之間留時間播動畫，
 * 而不是一瞬間跳完整個回合、只留下一堆看不懂的傷害數字。
 */
export function stepTurn(b: Battle, h: Hero): boolean {
  if (b.over || b.phase !== 'resolve') return false
  const st = computeStats(h)

  while (b.queue.length) {
    const uid = b.queue.shift()!
    const c = findUnit(b, uid)
    if (!c || c.hp <= 0) continue
    if (c.uid === b.hero.uid) {
      b.queued = b.order?.skill ?? undefined
      act(b, c, h, st.haste)
      b.queued = undefined
    } else {
      act(b, c, null, c.side === 'ally' ? 0.1 : 0)
    }
    settle(b, h)
    if (b.queue.length === 0) endRound(b, h)
    return true
  }
  endRound(b, h)
  return false
}

function endRound(b: Battle, h: Hero) {
  // 彩蛋技能「復仇者」：倒下十次才拿得到的常駐再生。
  // 放在回合結束而不是每次行動 —— 掛在行動上的話，隊友越多回得越快，
  // 那不是「常駐再生」是「隊伍規模獎勵」。
  if (hasSecret(h, 'avenger') && b.hero.hp > 0) {
    b.hero.hp = Math.min(b.hero.hpMax, b.hero.hp + Math.round(b.hero.hpMax * 0.1))
  }
  b.phase = 'input'
  b.order = undefined
  b.guarding = false
  // 集火目標死了就清掉，不然畫面上會一直標著一個空位
  if (b.focus && !b.foes.some((f) => f.uid === b.focus && f.hp > 0)) b.focus = undefined
  settle(b, h)
}

/**
 * 一次行動之後的收尾：清屍體、發獎勵、判定勝負、換下一波。
 *
 * 即時模式與回合制都會呼叫它。放在同一個函式裡才不會出現
 * 「其中一種模式忘了換波」這種只在某個模式下才復現的 bug。
 */
function settle(b: Battle, h: Hero): void {
  if (b.over) return
  // 清掉倒下的敵人，結算獎勵
  const dead = b.foes.filter((f) => f.hp <= 0)
  if (dead.length) {
    const place = b.kind === 'field' ? ZONE_BY_ID[b.placeId] : DUNGEON_BY_ID[b.placeId]
    const lvl = place?.minLevel ?? 1
    for (const d of dead) {
      // 用 art（怪物 id）查，不要用名字 —— 精英怪的名字被改過，查名字會落空
      const m = MONSTER_BY_ID[d.art]
      // 超級菁英一隻抵一整波。倍率隨階級走，不然到後期又變成不值得打
      const bonus = d.super ? 9 + d.super * 4 : d.elite ? 2.2 : 1
      // 等級差懲罰：主角遠高於怪物時經驗大幅衰減。
      // 沒有這個的話，最有效率的玩法是一直刷新手草原 —— 那不是遊戲，是掛機。
      const gap = h.level - (m?.level ?? 1)
      const fade = gap <= 3 ? 1 : Math.max(0.15, 1 - (gap - 3) * 0.12)
      b.kills++
      b.xp += Math.round((m?.xp ?? 10) * bonus * fade)
      b.gold += Math.round((m?.gold ?? 5) * bonus * Math.max(0.4, fade))
      if (d.super) {
        // 打贏這種東西一定要有實感：保底傳說、抽卡券，還有機會直接掉彩蛋裝
        b.superKills++
        b.tickets.ally += 1
        b.tickets.gear += 2
        const gear = rollItem(Math.max(1, h.level + 2), undefined, 'legend')
        b.loot.push(gear)
        say(b, 'loot', t('拾獲 {item}', { item: itemLabel(gear.name) }))
        const left = missingUniques(h)
        if (left.length && Math.random() < 0.34) {
          const spec = left[rnd(left.length)]
          const u = makeUnique(spec, h.level, nextId())
          // 記進永久紀錄。少了這一行，賣掉之後它又會再掉一次 ——
          // 那叫「一次只能有一件」，不是「獨一無二」。
          recordUnique(h, spec.id)
          b.loot.push(u)
          say(b, 'loot', t('★ 掉落彩蛋裝備：{item}', { item: itemLabel(u.name) }))
        }
      }
      const dropChance = m?.boss ? 1 : d.elite ? 0.75 : 0.35
      if (!d.super && Math.random() < dropChance) {
        const it = rollItem(Math.max(1, (m?.level ?? lvl) + rnd(3)), undefined,
          m?.boss ? rollRarity(3) : d.elite ? rollRarity(2) : undefined)
        b.loot.push(it)
        say(b, 'loot', t('拾獲 {item}', { item: itemLabel(it.name) }))
      }
      // 王也會掉抽卡券，這是券的主要來源 —— 不然抽卡只能靠金幣換，等於沒有第二條路
      if (m?.boss) { b.tickets.ally += 1; b.tickets.gear += 1 }
      // 寵物：打王有機會遇到一隻願意跟你走的
      const petChance = m?.boss ? PET_DROP_CHANCE.boss : d.elite ? PET_DROP_CHANCE.elite : 0
      if (petChance && Math.random() < petChance) {
        const kind = pick(PET_KINDS.filter((k) => !h.pets.some((own) => own.art === k.art)))
        if (kind) b.petDrop = kind.art
      }
      // 藥水掉落：是玩家撐過硬仗的資源，所以掉率給得比裝備高
      if (Math.random() < (m?.boss ? 1 : 0.22)) b.potionDrops.hp++
      if (Math.random() < (m?.boss ? 0.8 : 0.12)) b.potionDrops.mp++
    }
    b.foes = b.foes.filter((f) => f.hp > 0)
  }

  // 我方全滅
  if (b.hero.hp <= 0) {
    b.over = true
    b.result = 'lose'
    say(b, 'death', t('你倒下了…被同事拖回辦公室休息'))
    return
  }

  // 這一波清完 → 下一波 / 下一間 / 王
  if (!b.foes.length) {
    if (b.kind === 'field') {
      spawnWave(b, ZONE_BY_ID[b.placeId]?.monsters ?? ['slime'], waveSize(h.level, 'field'), h.level)
      return
    }
    const dg = DUNGEON_BY_ID[b.placeId]
    if (!dg) { b.over = true; b.result = 'win'; return }
    if (b.room >= b.rooms) {
      b.over = true
      b.result = 'win'
      say(b, 'info', t('{name} 通關！', { name: t(dg.name) }))
      return
    }
    b.room++
    if (b.room === b.rooms) {
      say(b, 'info', t('最深處……{boss} 出現了！', {
        boss: t(MONSTER_BY_ID[dg.boss]?.name ?? '王'),
      }))
      b.foes = [foeCombatant(MONSTER_BY_ID[dg.boss], 999)]
    } else {
      say(b, 'info', t('前進到第 {room} / {rooms} 間', { room: b.room, rooms: b.rooms }))
      spawnWave(b, dg.trash, waveSize(h.level, 'dungeon'), h.level)
    }
  }
}


/** 舊的即時模式：整個回合一次跑完（自動掛機用） */
export function stepBattle(b: Battle, h: Hero): void {
  if (b.over) return
  b.tick++
  b.phase = 'input'
  if (b.focus && !b.foes.some((f) => f.uid === b.focus && f.hp > 0)) b.focus = undefined
  const st = computeStats(h)

  act(b, b.hero, h, st.haste)
  if (b.pet) act(b, b.pet, null, 0)
  for (const a of b.allies) act(b, a, null, 0.1)
  for (const f of b.foes) act(b, f, null, 0)
  settle(b, h)
}

/** 把戰鬥結算進角色；回傳升了幾級 */
export function collect(h: Hero, b: Battle): {
  levels: number; loot: Item[]; newPet?: Pet; secrets: string[]; allyUps: string[]
  /** 這一場新解鎖的彩蛋夥伴名稱 */
  secretAllies: string[]
  /** 這一場跟著升級的彩蛋裝備名稱 */
  uniquesGrown: string[]
} {
  h.tally ??= { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }
  h.tickets ??= { ally: 0, gear: 0 }
  // 「蒐藏家」：把人形夥伴收齊之後金幣多拿一成五
  h.gold += Math.round(b.gold * (hasSecret(h, 'collector') ? 1.15 : 1))
  h.kills += b.kills
  h.bag.push(...b.loot)
  h.potions.hp += b.potionDrops.hp
  h.potions.mp += b.potionDrops.mp

  // 收服這場遇到的寵物
  let newPet: Pet | null = null
  if (b.petDrop && !h.pets.some((p) => p.art === b.petDrop)) {
    const kind = PET_KINDS.find((k) => k.art === b.petDrop)
    if (kind) {
      newPet = { id: nextId(), name: kind.name, art: kind.art, desc: kind.desc,
                 line: kind.line, level: 1, xp: 0 }
      h.pets.push(newPet)
      if (!h.activePet) h.activePet = newPet.id     // 第一隻自動帶上
    }
  }
  b.petDrop = undefined

  // 出戰的寵物跟著長經驗
  const active = h.pets.find((p) => p.id === h.activePet)
  if (active) growPet(active, b.xp)

  // 上場的夥伴也各自長經驗。
  // 給主角的七成 —— 一樣的量會讓夥伴永遠比主角高一階（他們不用分經驗給寵物），
  // 太少又等於沒有養成。uid 是 `ally-<recruit.id>`，切掉前綴就對得回去。
  const allyUps: string[] = []
  for (const a of b.allies) {
    const r = h.roster?.find((x) => `ally-${x.id}` === a.uid)
    if (r && growRecruit(r, Math.round(b.xp * 0.7))) allyUps.push(a.name)
  }

  h.tickets.ally += b.tickets.ally
  h.tickets.gear += b.tickets.gear
  h.tally.crits += b.critHits
  h.tally.superKills += b.superKills
  if (b.result === 'lose') { h.deaths++; h.tally.deathStreak++ }
  // 贏了就把連敗歸零。「連續」十次才算，不是「總共」十次 ——
  // 總數的話玩久了一定會達成，就沒有「撐過低潮」的意思了
  if (b.result === 'win') {
    h.tally.deathStreak = 0
    if (b.kind === 'dungeon' && !b.potionUsed) h.tally.cleanClears++
  }

  let levels = 0
  h.xp += b.xp
  while (h.xp >= xpForLevel(h.level)) {
    h.xp -= xpForLevel(h.level)
    h.level++
    levels++
  }
  const loot = b.loot
  b.xp = 0; b.gold = 0; b.kills = 0; b.loot = []
  b.potionDrops = { hp: 0, mp: 0 }
  b.critHits = 0; b.superKills = 0
  b.tickets = { ally: 0, gear: 0 }
  // 彩蛋條件都是累計值，戰鬥中途不可能達成，所以一場結算檢查一次就夠
  const got = checkSecrets(h).map((x) => x.name)
  // 彩蛋夥伴同理，而且要在 checkSecrets 之後 ——
  // 其中一隻的解鎖條件就是「把六個彩蛋技能全開」，順序反了會晚一場才拿到。
  const allies = checkSecretAllies(h).map((k) => k.name)
  // 等級變了就把「跟著等級走」的東西同步上來。
  // 兩個都是冪等的，所以放在這裡一次做完最省事：
  // 彩蛋裝備每種只有一件、彩蛋夥伴不能重抽，它們的數值鎖在取得那一刻的話，
  // 早期拿到的等於注定要丟 —— 而你永遠拿不到第二件。
  const grown = levels > 0 ? syncUniques(h) : []
  if (levels > 0) syncSecretAllies(h)
  return {
    levels, loot, newPet: newPet ?? undefined,
    secrets: got, allyUps, secretAllies: allies, uniquesGrown: grown,
  }
}
