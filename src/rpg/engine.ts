// 戰鬥引擎：數值計算、掉落、tick 制戰鬥
//
// 戰鬥是回合 tick 驅動的，所以掛在背景也會自己打（沉浸練功），
// 切到冒險分頁時玩家可以插隊指定技能（手動操作）。

import {
  AFFIX_POOL, AFFIX_SCALE, ARMOR_NAMES, DUNGEON_BY_ID, MONSTER_BY_ID, PREFIXES,
  RARITY_SPEC, SKILL_BY_ID, SKILLS, WEAPON_NAMES, ZONE_BY_ID,
} from './data'
import { itemLabel, t } from '@/i18n'
import {
  ATTRS, LINES, type Affix, type Attr, type Combatant, type Hero, type Item,
  SLOTS, type FxEvent, type Line, type Loadout, type LogEntry, type Monster,
  type Rarity, type Slot, type Stats,
} from './types'

const rnd = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(a: T[]): T => a[rnd(a.length)]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
let idSeq = 0
const nextId = () => `i${Date.now().toString(36)}${(idSeq++).toString(36)}`

// ── 等級 ───────────────────────────────────────────
export const xpForLevel = (level: number) => Math.round(60 * Math.pow(level, 1.55))

// ── 套裝 ───────────────────────────────────────────
export function emptyLoadout(name: string): Loadout {
  return {
    name,
    equipped: {},
    skills: {},
    attrs: { str: 0, dex: 0, int: 0, fai: 0, vit: 0 },
  }
}

export function newHero(name = '你'): Hero {
  const h: Hero = {
    name, level: 1, xp: 0, skillPoints: 3, attrPoints: 5, gold: 0,
    bag: [], loadouts: [emptyLoadout('主要'), emptyLoadout('第二套'), emptyLoadout('第三套')],
    active: 0, zone: 'meadow', kills: 0, deaths: 0,
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
  allies: Combatant[]
  foes: Combatant[]
  log: LogEntry[]
  /** 給戰鬥畫面做動作與跳字，只留最近幾回合 */
  fx: FxEvent[]
  /** 主角主手武器屬於哪條技能線 —— 畫面用它決定手上疊哪把武器 */
  heroWeapon: Line | null
  tick: number
  over: boolean
  result?: 'win' | 'lose'
  /** 手動模式排隊的技能 id */
  queued?: string
  loot: Item[]
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

function spawnWave(b: Battle, ids: string[], count: number) {
  b.foes = []
  for (let i = 0; i < count; i++) {
    const m = MONSTER_BY_ID[pick(ids)]
    if (m) b.foes.push(foeCombatant(m, b.tick * 10 + i))
  }
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
    hero: heroCombatant(h), allies, foes: [], log: [], fx: [], tick: 0,
    heroWeapon: equippedWeaponLine(h),
    over: false, loot: [], xp: 0, gold: 0, kills: 0,
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

function act(b: Battle, c: Combatant, h: Hero | null, haste: number) {
  if (c.hp <= 0) return
  for (const k of Object.keys(c.cds)) if (c.cds[k] > 0) c.cds[k]--

  const targets = c.side === 'foe' ? [b.hero, ...b.allies].filter((x) => x.hp > 0) : b.foes.filter((x) => x.hp > 0)
  if (!targets.length) return

  // 玩家排隊的技能優先
  let skillId: string | null = null
  if (c.side === 'hero' && b.queued) {
    const sk = SKILL_BY_ID[b.queued]
    if (sk && (c.cds[b.queued] ?? 0) <= 0 && sk.mpCost <= c.mp) skillId = b.queued
    b.queued = undefined
  }
  if (!skillId) skillId = chooseSkill(c, h)

  if (!skillId) {
    // 沒技能可用就普攻
    const tgt = pick(targets)
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
    : pick(targets)
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
export function stepBattle(b: Battle, h: Hero): void {
  if (b.over) return
  b.tick++
  const st = computeStats(h)

  act(b, b.hero, h, st.haste)
  for (const a of b.allies) act(b, a, null, 0.1)
  for (const f of b.foes) act(b, f, null, 0)

  // 清掉倒下的敵人，結算獎勵
  const dead = b.foes.filter((f) => f.hp <= 0)
  if (dead.length) {
    const place = b.kind === 'field' ? ZONE_BY_ID[b.placeId] : DUNGEON_BY_ID[b.placeId]
    const lvl = place?.minLevel ?? 1
    for (const d of dead) {
      const m = MONSTERS_BY_NAME[d.name]
      b.kills++
      b.xp += m?.xp ?? 10
      b.gold += m?.gold ?? 5
      if (Math.random() < (m?.boss ? 1 : 0.35)) {
        const it = rollItem(Math.max(1, (m?.level ?? lvl) + rnd(3)), undefined,
          m?.boss ? rollRarity(3) : undefined)
        b.loot.push(it)
        say(b, 'loot', t('拾獲 {item}', { item: itemLabel(it.name) }))
      }
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

const MONSTERS_BY_NAME: Record<string, Monster> = Object.fromEntries(
  Object.values(MONSTER_BY_ID).map((m) => [m.name, m]),
)

/** 把戰鬥結算進角色；回傳升了幾級 */
export function collect(h: Hero, b: Battle): { levels: number; loot: Item[] } {
  h.gold += b.gold
  h.kills += b.kills
  h.bag.push(...b.loot)
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
  return { levels, loot }
}
