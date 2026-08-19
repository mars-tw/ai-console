// 小型 MMORPG：資料模型
//
// 設計原則：沒有職業。近戰 / 遠程 / 魔法 / 信仰四條技能線自由混搭，
// 裝備、技能、屬性各存一套（loadout），隨時整組換掉。

export type Line = 'melee' | 'ranged' | 'magic' | 'faith'
export type Attr = 'str' | 'dex' | 'int' | 'fai' | 'vit'
export type Slot = 'main' | 'off' | 'head' | 'body' | 'hands' | 'feet' | 'ring1' | 'ring2'
export type Rarity = 'crude' | 'common' | 'fine' | 'rare' | 'legend'

export const LINES: Line[] = ['melee', 'ranged', 'magic', 'faith']
export const ATTRS: Attr[] = ['str', 'dex', 'int', 'fai', 'vit']
export const SLOTS: Slot[] = ['main', 'off', 'head', 'body', 'hands', 'feet', 'ring1', 'ring2']

export const LINE_NAME: Record<Line, string> = {
  melee: '近戰', ranged: '遠程', magic: '魔法', faith: '信仰',
}
export const ATTR_NAME: Record<Attr, string> = {
  str: '力量', dex: '敏捷', int: '智力', fai: '信念', vit: '體質',
}
export const SLOT_NAME: Record<Slot, string> = {
  main: '主手', off: '副手', head: '頭部', body: '身體',
  hands: '手部', feet: '腳部', ring1: '飾品 I', ring2: '飾品 II',
}
export const RARITY_NAME: Record<Rarity, string> = {
  crude: '粗製', common: '普通', fine: '精良', rare: '稀有', legend: '傳說',
}
export const RARITY_COLOR: Record<Rarity, string> = {
  crude: '#9ca3af', common: '#e5e7eb', fine: '#4ade80', rare: '#60a5fa', legend: '#fbbf24',
}

/** 詞綴可以加在屬性上，也可以加在衍生數值上 */
export type AffixKey = Attr | 'atk' | 'def' | 'crit' | 'haste' | 'leech'
export const AFFIX_NAME: Record<AffixKey, string> = {
  str: '力量', dex: '敏捷', int: '智力', fai: '信念', vit: '體質',
  atk: '攻擊', def: '防禦', crit: '暴擊率', haste: '急速', leech: '吸血',
}
/** 顯示成百分比的詞綴 */
export const AFFIX_PCT: AffixKey[] = ['crit', 'haste', 'leech']

export interface Affix { key: AffixKey; value: number }

export interface Item {
  id: string
  name: string
  slot: Slot
  rarity: Rarity
  ilvl: number
  /** 武器偏向哪條技能線；防具為 undefined */
  line?: Line
  atk: number
  def: number
  affixes: Affix[]
}

/** 一整套配置：裝備 + 技能配點 + 屬性配點，可以一鍵整組換掉 */
export interface Loadout {
  name: string
  equipped: Partial<Record<Slot, string>>   // slot → item.id
  skills: Record<string, number>            // skillId → 等級
  attrs: Record<Attr, number>               // 玩家自己分配的點數
}

export interface Hero {
  name: string
  level: number
  xp: number
  skillPoints: number
  attrPoints: number
  gold: number
  bag: Item[]
  loadouts: Loadout[]
  active: number            // 目前套用第幾組
  /** 目前所在區域 / 地城 */
  zone: string
  /** 累計戰績 */
  kills: number
  deaths: number
}

/** 由等級 + 屬性 + 裝備 + 技能算出來的最終數值 */
export interface Stats {
  hpMax: number
  mpMax: number
  atk: number
  def: number
  crit: number      // 0..1
  haste: number     // 0..1，縮短技能冷卻
  leech: number     // 0..1
  attrs: Record<Attr, number>
}

export type SkillKind = 'attack' | 'heal' | 'buff'

export interface Skill {
  id: string
  name: string
  line: Line
  kind: SkillKind
  desc: string
  maxLv: number
  /** 該線至少要投入幾點才解鎖 */
  req: number
  mpCost: number
  /** 冷卻（回合） */
  cd: number
  /** 威力係數：實際效果 = power × 相關屬性 */
  power: number
  /** 吃哪個屬性 */
  scale: Attr
}

export interface Monster {
  id: string
  name: string
  level: number
  hp: number
  atk: number
  def: number
  xp: number
  gold: number
  /** 掉落品質權重偏移，王會高一點 */
  lootBonus: number
  boss?: boolean
}

export interface Zone {
  id: string
  name: string
  minLevel: number
  desc: string
  monsters: string[]
}

export interface Dungeon {
  id: string
  name: string
  minLevel: number
  desc: string
  rooms: number
  trash: string[]
  boss: string
  /** 需要幾人（含自己）才進得去 */
  partySize: number
}

/** 隊友＝辦公室裡的 AI 龍 */
export interface Ally {
  key: string          // 對應 SKINS 的 key
  name: string
  level: number
  hp: number
  hpMax: number
  atk: number
  line: Line
}

export type CombatSide = 'hero' | 'ally' | 'foe'

export interface Combatant {
  uid: string
  side: CombatSide
  /** 該用哪張圖：怪物是 monster id，隊友是 SKINS 的 key，主角是 'hero' */
  art: string
  name: string
  hp: number
  hpMax: number
  mp: number
  mpMax: number
  atk: number
  def: number
  crit: number
  leech: number
  /** 技能 id → 剩餘冷卻回合 */
  cds: Record<string, number>
  skills: string[]
  color: string
}

/**
 * 給戰鬥畫面做動畫與跳字用的事件
 *
 * die 跟 hurt 分開是必要的：死亡要播完整段倒下＋溶解，
 * 而戰鬥資料一到 0 血就把該單位從有效目標裡拿掉了，
 * 畫面沒有這個事件就只能讓怪憑空消失。
 */
export interface FxEvent {
  uid: string                                  // 誰身上發生的
  kind: 'attack' | 'hurt' | 'heal' | 'crit' | 'die'
  amount?: number
  tick: number
}

export interface LogEntry {
  t: number
  text: string
  kind: 'hit' | 'crit' | 'heal' | 'loot' | 'level' | 'info' | 'death'
}
