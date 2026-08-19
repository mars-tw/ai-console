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
    name, look, level: 1, xp: 0, skillPoints: 3, attrPoints: 5, gold: 0,
    bag: [], loadouts: [emptyLoadout('主要'), emptyLoadout('第二套'), emptyLoadout('第三套')],
    active: 0, zone: 'meadow', kills: 0, deaths: 0,
    potions: { hp: 3, mp: 2 },
    pets: [],
  }
  // 給一把起手武器，不然第一場會很難看
  const starter = rollItem(1, 'main', 'common', 'melee')
  starter.name = '練習用短劍'
  h.bag.push(starter)
  h.loadouts[0].equipped.main = starter.id
  return h
}

export const activeLoadout = (h: Hero) => h.loadouts[h.active]
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
    atk += it.atk
    def += it.def
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
export function autoEquipBest(h: Hero): { slot: Slot; from?: string; to: string }[] {
  const lo = activeLoadout(h)
  const mainLine = LINES.reduce((best, l) =>
    linePoints(lo, l) > linePoints(lo, best) ? l : best, LINES[0])
  const changed: { slot: Slot; from?: string; to: string }[] = []

  for (const slot of SLOTS) {
    const cands = h.bag.filter((it) => it.slot === slot)
    if (!cands.length) continue
    const rank = (it: Item) =>
      itemScore(it) * (it.slot === 'main' && it.line && it.line !== mainLine ? 0.75 : 1)
    const best = cands.reduce((a, b) => (rank(b) > rank(a) ? b : a))
    const cur = itemById(h, lo.equipped[slot])
    if (cur?.id === best.id) continue
    if (cur && rank(cur) >= rank(best)) continue
    lo.equipped[slot] = best.id
    changed.push({ slot, from: cur?.name, to: best.name })
  }
  return changed
}

/** 這件比目前裝著的好嗎（背包篩選「只看可升級」用） */
export function isUpgrade(h: Hero, it: Item): boolean {
  const cur = itemById(h, activeLoadout(h).equipped[it.slot])
  return !cur || itemScore(it) > itemScore(cur)
}

/** 裝備的粗略分數，用來提示「這件比較好」 */
export function itemScore(it: Item): number {
  let n = it.atk * 2 + it.def * 1.5
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
  /** 手動模式排隊的技能 id */
  queued?: string
  /** 玩家點選的集火目標（foe 的 uid）。目標死了會自動清掉 */
  focus?: string
  /** 主角本回合處於格擋姿態：擋下重擊的大半傷害 */
  guarding?: boolean
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

function fx(b: Battle, uid: string, kind: FxEvent['kind'], amount?: number) {
  b.fx.push({ uid, kind, amount, tick: b.tick })
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

/** 每隻小怪有機會變成精英：血厚攻高，但掉落也好，值得優先集火 */
const ELITE_CHANCE = 0.18
const ELITE_MULT = { hp: 1.9, atk: 1.35, def: 1.2 }

function spawnWave(b: Battle, ids: string[], count: number) {
  b.foes = []
  b.focus = undefined                     // 換一波敵人，舊的集火目標作廢
  for (let i = 0; i < count; i++) {
    const m = MONSTER_BY_ID[pick(ids)]
    if (!m) continue
    const c = foeCombatant(m, b.tick * 10 + i)
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
    over: false, loot: [], potionDrops: { hp: 0, mp: 0 }, xp: 0, gold: 0, kills: 0,
  }
  const place = kind === 'field' ? ZONE_BY_ID[placeId] : DUNGEON_BY_ID[placeId]
  const placeName = t(place?.name ?? placeId)
  say(b, 'info', kind === 'field'
    ? t('進入 {place}', { place: placeName })
    : t('踏入 {place}（第 1 / {rooms} 間）', { place: placeName, rooms: b.rooms }))
  const ids = kind === 'field' ? (ZONE_BY_ID[placeId]?.monsters ?? ['slime'])
    : (DUNGEON_BY_ID[placeId]?.trash ?? ['goblin'])
  spawnWave(b, ids, kind === 'field' ? 1 : 2)
  return b
}

/**
 * 防禦走遞減減傷，不是從傷害裡直接扣掉。
 * 直接扣的話，高防怪對攻擊力低的角色會近乎免疫 ——
 * 實測隊友打食人魔頭目一次只有 5 點，等於整隊只有主角在輸出。
 */
const DEF_K = 110
const mitigation = (def: number) => DEF_K / (DEF_K + Math.max(0, def))

function damage(src: Combatant, dst: Combatant, power: number, scaleBonus = 0): { dmg: number; crit: boolean } {
  const crit = Math.random() < src.crit
  const raw = src.atk * power * (1 + scaleBonus) * mitigation(dst.def)
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
    const { dmg, crit } = damage(c, tgt, 1)
    tgt.hp = Math.max(0, tgt.hp - dmg)
    fx(b, c.uid, 'attack')
    fx(b, tgt.uid, crit ? 'crit' : 'hurt', dmg)
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
  c.mp = Math.max(0, c.mp - sk.mpCost)
  c.cds[skillId] = Math.max(0, Math.round(sk.cd * (1 - haste)))

  if (sk.kind === 'heal') {
    const amount = Math.round(sk.power * (12 + lv * 6) * (1 + scaleBonus))
    const pool = skillId === 'revive' ? [c, ...b.allies].filter((x) => x.hp > 0) : [c]
    for (const t of pool) {
      t.hp = Math.min(t.hpMax, t.hp + amount)
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
  let { dmg, crit } = damage(c, tgt, sk.power * (1 + lv * 0.08), scaleBonus)
  if (skillId === 'snipe') { crit = true; dmg = Math.round(dmg * 1.4) }
  if (skillId === 'execute' && tgt.hp < tgt.hpMax * 0.3) dmg = Math.round(dmg * 1.6)
  tgt.hp = Math.max(0, tgt.hp - dmg)
  fx(b, c.uid, 'attack')
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
  if (b.over || h.potions[kind] <= 0) return false
  const c = b.hero
  if (kind === 'hp' && c.hp >= c.hpMax) return false
  if (kind === 'mp' && c.mp >= c.mpMax) return false
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

export function stepBattle(b: Battle, h: Hero): void {
  if (b.over) return
  b.tick++
  // 集火目標死了就清掉，不然畫面上會一直標著一個空位
  if (b.focus && !b.foes.some((f) => f.uid === b.focus && f.hp > 0)) b.focus = undefined
  const st = computeStats(h)

  act(b, b.hero, h, st.haste)
  if (b.pet) act(b, b.pet, null, 0)
  for (const a of b.allies) act(b, a, null, 0.1)
  for (const f of b.foes) act(b, f, null, 0)

  // 清掉倒下的敵人，結算獎勵
  const dead = b.foes.filter((f) => f.hp <= 0)
  if (dead.length) {
    const place = b.kind === 'field' ? ZONE_BY_ID[b.placeId] : DUNGEON_BY_ID[b.placeId]
    const lvl = place?.minLevel ?? 1
    for (const d of dead) {
      // 用 art（怪物 id）查，不要用名字 —— 精英怪的名字被改過，查名字會落空
      const m = MONSTER_BY_ID[d.art]
      const bonus = d.elite ? 2.2 : 1
      // 等級差懲罰：主角遠高於怪物時經驗大幅衰減。
      // 沒有這個的話，最有效率的玩法是一直刷新手草原 —— 那不是遊戲，是掛機。
      const gap = h.level - (m?.level ?? 1)
      const fade = gap <= 3 ? 1 : Math.max(0.15, 1 - (gap - 3) * 0.12)
      b.kills++
      b.xp += Math.round((m?.xp ?? 10) * bonus * fade)
      b.gold += Math.round((m?.gold ?? 5) * bonus * Math.max(0.4, fade))
      const dropChance = m?.boss ? 1 : d.elite ? 0.75 : 0.35
      if (Math.random() < dropChance) {
        const it = rollItem(Math.max(1, (m?.level ?? lvl) + rnd(3)), undefined,
          m?.boss ? rollRarity(3) : d.elite ? rollRarity(2) : undefined)
        b.loot.push(it)
        say(b, 'loot', t('拾獲 {item}', { item: itemLabel(it.name) }))
      }
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
      spawnWave(b, ZONE_BY_ID[b.placeId]?.monsters ?? ['slime'], 1)
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
      spawnWave(b, dg.trash, 2)
    }
  }
}

/** 把戰鬥結算進角色；回傳升了幾級 */
export function collect(h: Hero, b: Battle): { levels: number; loot: Item[]; newPet?: Pet } {
  h.gold += b.gold
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
  if (b.result === 'lose') h.deaths++

  let levels = 0
  h.xp += b.xp
  while (h.xp >= xpForLevel(h.level)) {
    h.xp -= xpForLevel(h.level)
    h.level++
    h.skillPoints += 2
    h.attrPoints += 3
    levels++
  }
  const loot = b.loot
  b.xp = 0; b.gold = 0; b.kills = 0; b.loot = []
  b.potionDrops = { hp: 0, mp: 0 }
  return { levels, loot, newPet: newPet ?? undefined }
}
