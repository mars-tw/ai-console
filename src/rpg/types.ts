// 小型 MMORPG：資料模型
//
// 設計原則：沒有職業。近戰 / 遠程 / 魔法 / 信仰四條技能線自由混搭，
// 裝備、技能、屬性各存一套（loadout），隨時整組換掉。

export type Line = 'melee' | 'ranged' | 'magic' | 'faith'
export type Attr = 'str' | 'dex' | 'int' | 'fai' | 'vit'
export type Slot = 'main' | 'off' | 'head' | 'body' | 'hands' | 'feet' | 'ring1' | 'ring2'
export type Rarity = 'crude' | 'common' | 'fine' | 'rare' | 'legend' | 'mythic'

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
  crude: '粗製', common: '普通', fine: '精良', rare: '稀有', legend: '傳說', mythic: '神話',
}
export const RARITY_COLOR: Record<Rarity, string> = {
  crude: '#9ca3af', common: '#e5e7eb', fine: '#4ade80', rare: '#60a5fa', legend: '#fbbf24',
  // 神話刻意選一個跟傳說的金色差很遠的顏色。
  // 兩者只差一階，配色再相近的話清單掃過去會分不出來 ——
  // 而「這件是不是那件永遠只有一件的」正是玩家最需要一眼看出來的事。
  mythic: '#f472b6',
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
  /** 強化等級 +0 ~ +15。每一級加成，但高等級會爆 */
  plus?: number
  /** 彩蛋裝備的圖鑑 id。有值代表這件是獨一無二的特殊裝備 */
  unique?: string
}

/** 一整套配置：裝備 + 技能配點 + 屬性配點，可以一鍵整組換掉 */
export interface Loadout {
  name: string
  equipped: Partial<Record<Slot, string>>   // slot → item.id
  skills: Record<string, number>            // skillId → 等級
  attrs: Record<Attr, number>               // 玩家自己分配的點數
}

/** 消耗品：戰鬥中即時使用，是玩家少數能主動改變戰況的手段 */
export interface Potions {
  hp: number
  mp: number
}

/** 主角外觀：只影響用哪一組圖，不影響任何數值 */
export type HeroLook = 'hero' | 'heroine'

/**
 * 寵物：跟著出戰的小夥伴。
 * 刻意做得單純 —— 只有一個等級與一種攻擊，沒有裝備也沒有技能樹。
 * 它的價值在陪伴與穩定輸出，不是再開一棵養成樹讓人分心。
 */
export interface Pet {
  id: string
  name: string
  /** 圖檔名（public/office/rpg/pets/<art>.png）*/
  art: string
  desc: string
  /** 專長：跟主角一樣吃四條線之一，決定它的攻擊風味 */
  line: Line
  level: number
  xp: number
}

export interface Hero {
  name: string
  /** 男 / 女，影響戰鬥畫面用哪組圖 */
  look: HeroLook
  level: number
  xp: number
  gold: number
  bag: Item[]
  loadouts: Loadout[]
  active: number            // 目前套用第幾組
  /** 目前所在區域 / 地城 */
  zone: string
  /** 累計戰績 */
  kills: number
  deaths: number
  /** 消耗品存量 */
  potions: Potions
  /** 已收服的寵物 */
  pets: Pet[]
  /** 出戰中的寵物 id；沒有就不帶 */
  activePet?: string
  /** 隊伍成員（Recruit 的 id）。存檔裡才記得住，不然每次重開都要重新揪人 */
  party?: string[]
  /** 擁有的夥伴。內建七隻 AI 龍在讀檔時補上，所以舊存檔不會少人 */
  roster?: Recruit[]
  /** 抽卡票券與強化保護符：打王、清地城會掉，也可以用金幣換 */
  tickets?: { ally: number; gear: number; protect?: number }
  /** 已解鎖的彩蛋技能 id */
  secrets?: string[]
  /**
   * 已經拿過的彩蛋裝備 id。**永久紀錄，賣掉也不會消失。**
   *
   * 原本「有沒有拿過」是掃背包判斷的。那有一個洞：賣掉或清雜物之後
   * 它就從背包消失，於是又會再掉一次 —— 「獨一無二」變成
   * 「一次只能有一件」，完全是兩回事。
   */
  uniquesFound?: string[]
  /**
   * 已經解鎖的彩蛋夥伴 id。跟 uniquesFound 同理，是永久紀錄。
   * 解鎖之後就一直在名冊裡，不會因為任何操作消失。
   */
  secretAllies?: string[]
  /**
   * 出戰隊伍人數上限（含主角）。3～5，預設 4。
   *
   * 做成可設定而不是寫死，是因為這件事沒有唯一正解：
   * 人少一點每個夥伴的存在感強、回合跑得快；人多一點容錯高、看起來熱鬧。
   * 那是口味不是平衡問題，交給玩家。
   */
  partyCap?: number
  /** 解鎖條件用的累計數字 */
  tally?: Tally
}

/** 隊伍人數上限的合法範圍（含主角） */
export const PARTY_CAP_MIN = 3
export const PARTY_CAP_MAX = 5
export const PARTY_CAP_DEFAULT = 4

/** 讀出隊伍上限並夾在合法範圍內。存檔被改壞也不會炸 */
export function partyCapOf(h: Pick<Hero, 'partyCap'>): number {
  const v = Math.round(Number(h.partyCap ?? PARTY_CAP_DEFAULT))
  if (!Number.isFinite(v)) return PARTY_CAP_DEFAULT
  return Math.min(PARTY_CAP_MAX, Math.max(PARTY_CAP_MIN, v))
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

// ── 夥伴 ───────────────────────────────────────────
/**
 * 夥伴分兩個維度：**來源**與**定位**。
 *
 * 來源（cat）：`ai` 是辦公室裡那七隻龍，永遠在，不用抽；
 *              `human` 是人形夥伴，要抽卡才會有。
 * 定位（role）：坦克／輸出／治療／輔助。這決定數值配比與 AI 出手偏好 ——
 *              治療會優先補血最低的人，坦克血厚但傷害低。
 * 兩個維度分開，是因為「哪來的」跟「派上場做什麼」本來就是兩件事，
 * 混成一個欄位之後想加「抽得到的龍」或「人形坦」就會卡住。
 */
export type AllyCat = 'ai' | 'human'
export type AllyRole = 'tank' | 'dps' | 'healer' | 'support'

export const ALLY_ROLE_NAME: Record<AllyRole, string> = {
  tank: '坦克', dps: '輸出', healer: '治療', support: '輔助',
}
export const ALLY_ROLE_COLOR: Record<AllyRole, string> = {
  tank: '#60a5fa', dps: '#f87171', healer: '#4ade80', support: '#fbbf24',
}
export const ALLY_CAT_NAME: Record<AllyCat, string> = { ai: 'AI 龍', human: '人形' }

/** 圖鑑：一種夥伴長什麼樣、什麼定位。不含等級，等級在 Recruit 上 */
export interface AllyKind {
  id: string
  name: string
  cat: AllyCat
  role: AllyRole
  line: Line
  rarity: Rarity
  color: string
  desc: string
  /** 人形夥伴的圖檔（public/office/rpg/recruits/<art>.png）。AI 龍用辦公室的動作總表 */
  art?: string
  /**
   * 彩蛋夥伴：達成這個條件才會出現在名冊裡。
   *
   * 有值代表它**不在抽卡池**、不能重複取得，而且等級跟著主角走
   * （不用另外練，見 allies.syncSecretAllies）。
   */
  secret?: {
    /** 沒解鎖時給的線索。跟彩蛋技能一樣：看得到目標，但不說死怎麼做 */
    hint: string
    test: (h: Hero) => boolean
  }
}

/** 已經擁有的夥伴。會跟著打怪長等級，不再是每場臨時捏出來的 */
export interface Recruit {
  id: string
  kind: string
  level: number
  xp: number
}

/** 解鎖彩蛋用的累計數字。條件要「做得到但不會不小心達成」才有樂趣 */
export interface Tally {
  /** 連續陣亡幾次（贏一場歸零）—— 復仇者的解鎖條件 */
  deathStreak: number
  crits: number
  /** 打倒超級菁英的次數 */
  superKills: number
  /** 全程沒喝藥水通關地城的次數 */
  cleanClears: number
  /** 強化爆掉幾件 */
  breaks: number
}

export type CombatSide = 'hero' | 'ally' | 'foe' | 'pet'

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
  /** 精英怪：數值加成、掉落更好，畫面上會標記 */
  elite?: boolean
  /**
   * 超級菁英的階級（1 起）。每 20 等一階，數值是同級怪的好幾倍。
   * 存階級而不是 boolean，是因為傷害加成、獎勵、外框顏色都要跟著階級走。
   */
  super?: number
  /**
   * 重擊蓄力：>0 表示正在蓄力，數字是還剩幾回合落下。
   * 這是玩家唯一需要「反應」的時刻 —— 落下前按格擋可以擋掉大半傷害。
   */
  charge?: number
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
  kind: 'attack' | 'hurt' | 'heal' | 'crit' | 'die' | 'guard' | 'charge' | 'skill'
  /** kind='skill' 時帶技能 id，畫面用它決定播哪張特效 */
  skill?: string
  amount?: number
  tick: number
}

export interface LogEntry {
  t: number
  text: string
  kind: 'hit' | 'crit' | 'heal' | 'loot' | 'level' | 'info' | 'death'
}
