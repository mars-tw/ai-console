// 夥伴：圖鑑、養成、上場
//
// 之前的夥伴是每一場臨時捏出來的 —— 等級跟著主角走，打完就丟。
// 那等於沒有養成：你不會記得哪一隻陪你打過什麼，換誰上場也沒差。
//
// 現在夥伴是有身分的：抽到之後存進 roster，各自累積經驗、各自升級，
// 而且分「來源」（內建的 AI 龍 / 抽到的人形）與「定位」（坦/輸出/補/輔助）兩個維度。

import { SKINS } from '@/pixel/sprites'
import { SKILLS } from './data'
import type {
  AllyKind, AllyRole, Combatant, Hero, Line, Recruit,
} from './types'

/** 四隻龍的技能線。龍是內建的，永遠在，不用抽 */
const AI_LINE: Record<string, Line> = {
  kimi: 'faith', claude: 'melee', codex: 'faith',
  grok: 'magic', qwen: 'magic', cursor: 'ranged', gemini: 'ranged',
}
const AI_ROLE: Record<string, AllyRole> = {
  kimi: 'healer', claude: 'tank', codex: 'healer',
  grok: 'dps', qwen: 'support', cursor: 'dps', gemini: 'dps',
}

/** 內建的 AI 龍。rarity 給 fine 只是為了排序好看，牠們不進抽卡池 */
const AI_KINDS: AllyKind[] = Object.keys(SKINS).map((key) => ({
  id: key,
  name: SKINS[key].name,
  cat: 'ai' as const,
  role: AI_ROLE[key] ?? 'dps',
  line: AI_LINE[key] ?? 'melee',
  rarity: 'fine' as const,
  color: SKINS[key].color,
  desc: '辦公室裡的 AI 夥伴，永遠揪得到。',
}))

/**
 * 人形夥伴：抽卡池的內容。
 *
 * 稀有度決定抽中的機率與成長曲線，不是決定「強多少」而已 ——
 * 傳說級的成長率高，但前期不見得贏得過一隻練滿的精良夥伴，
 * 這樣抽不到 SSR 也還有得玩。
 */
const HUMAN_KINDS: AllyKind[] = [
  { id: 'knight', name: '蘭斯', cat: 'human', role: 'tank', line: 'melee', rarity: 'fine', color: '#93c5fd', art: 'ally-knight', desc: '扛得住的重甲騎士，塔盾一立就不動了。' },
  { id: 'ranger', name: '希雅', cat: 'human', role: 'dps', line: 'ranged', rarity: 'fine', color: '#86efac', art: 'ally-ranger', desc: '沉默的遊俠，箭無虛發。' },
  { id: 'mage', name: '梅琳', cat: 'human', role: 'dps', line: 'magic', rarity: 'rare', color: '#c4b5fd', art: 'ally-mage', desc: '愛睡覺的年輕女巫，火力驚人。' },
  { id: 'cleric', name: '伊登', cat: 'human', role: 'healer', line: 'faith', rarity: 'rare', color: '#fde68a', art: 'ally-cleric', desc: '溫和的祭司，總是先看你的血條。' },
  { id: 'rogue', name: '卡爾', cat: 'human', role: 'dps', line: 'melee', rarity: 'rare', color: '#a1a1aa', art: 'ally-rogue', desc: '雙匕首盜賊，專打殘血。' },
  { id: 'bard', name: '諾拉', cat: 'human', role: 'support', line: 'faith', rarity: 'rare', color: '#fca5a5', art: 'ally-bard', desc: '吟遊詩人，一開口全隊都變強。' },
  { id: 'miko', name: '小雪', cat: 'human', role: 'support', line: 'magic', rarity: 'legend', color: '#f9a8d4', art: 'ally-miko', desc: '巫女，符咒一貼傷害就翻倍。' },
  { id: 'dragoon', name: '賽維爾', cat: 'human', role: 'dps', line: 'melee', rarity: 'legend', color: '#818cf8', art: 'ally-dragoon', desc: '龍騎士。躍起再落下的那一槍最痛。' },
  // ── 傳說人物（第二批）──
  // 前兩個傳說都是輸出／輔助，坦與補在傳說階完全空著 ——
  // 於是「抽到傳說」對玩坦或玩補的人來說沒有意義。這批把四個定位補齊。
  { id: 'paladin', name: '格里芬', cat: 'human', role: 'tank', line: 'faith', rarity: 'legend', color: '#fcd34d', art: 'ally-knight', desc: '聖騎士。他站的位置就是隊伍的底線。' },
  { id: 'oracle', name: '緹雅', cat: 'human', role: 'healer', line: 'faith', rarity: 'legend', color: '#a7f3d0', art: 'ally-cleric', desc: '神諭者。她說「還撐得住」的時候，你就真的還撐得住。' },
  { id: 'gunner', name: '雷恩', cat: 'human', role: 'dps', line: 'ranged', rarity: 'legend', color: '#fdba74', art: 'ally-ranger', desc: '火槍手。裝填很慢，但那一發從不落空。' },
]

/**
 * 彩蛋夥伴：解鎖條件達成才會出現在名冊裡。
 *
 * 跟人形夥伴的三個差別，都是使用者明確要求的：
 *   1. **不在抽卡池**，也不能重複取得 —— 解鎖一次就永遠在
 *   2. **等級跟著主角走**（syncSecretAllies），不用另外練
 *   3. 神話階，成長率高於傳說
 *
 * 條件沿用彩蛋技能那一套原則：做得到，但不會不小心達成。
 *
 * 美術上目前沿用既有的人形立繪 —— 這是**已知的妥協**，不是疏忽。
 * 新立繪要走 tools/gen_sheets_grok.py 那條產圖線（另外的額度與時間），
 * 在那之前寧可借圖，也不要讓它在戰場上變成一塊純色矩形
 * （drawAlly 找不到圖時就是那樣）。
 */
const SECRET_KINDS: AllyKind[] = [
  {
    id: 'archivist', name: '零號檔案員', cat: 'human', role: 'support', line: 'magic',
    rarity: 'mythic', color: '#f472b6', art: 'ally-mage',
    desc: '她記得每一場你打過的仗，包括你以為沒人看見的那些。',
    secret: {
      hint: '打滿五百場戰鬥之後，會有人替你把紀錄整理好。',
      test: (h) => (h.kills ?? 0) >= 500,
    },
  },
  {
    id: 'revenant', name: '不歸者', cat: 'human', role: 'tank', line: 'melee',
    rarity: 'mythic', color: '#c084fc', art: 'ally-rogue',
    desc: '倒下太多次的人，最後連死亡都懶得再理他。',
    secret: {
      hint: '倒下二十次還沒有關掉遊戲的人，會遇見他。',
      test: (h) => (h.deaths ?? 0) >= 20,
    },
  },
  {
    id: 'smith', name: '爐心', cat: 'human', role: 'dps', line: 'melee',
    rarity: 'mythic', color: '#fb7185', art: 'ally-dragoon',
    desc: '在強化台前碎過的每一件裝備，都燒成了她手上那把鎚子。',
    secret: {
      hint: '碎掉十五件裝備之後，爐子裡會有東西站起來。',
      test: (h) => (h.tally?.breaks ?? 0) >= 15,
    },
  },
  {
    id: 'chorus', name: '眾聲', cat: 'human', role: 'healer', line: 'faith',
    rarity: 'mythic', color: '#67e8f9', art: 'ally-bard',
    desc: '所有你收集過的彩蛋，最後都變成了同一個聲音。',
    secret: {
      hint: '把六個藏起來的技能全部解開。',
      test: (h) => (h.secrets ?? []).length >= 6,
    },
  },
]

export const ALLY_KINDS: AllyKind[] = [...AI_KINDS, ...HUMAN_KINDS, ...SECRET_KINDS]
export const ALLY_BY_ID = Object.fromEntries(ALLY_KINDS.map((k) => [k.id, k]))
/**
 * 抽卡池：只有人形夥伴。
 * 龍本來就送你了；彩蛋夥伴要解鎖條件，抽得到的話「彩蛋」就沒有意義了。
 */
export const GACHA_POOL = HUMAN_KINDS
/** 彩蛋夥伴圖鑑。介面要用它列出「還沒解鎖的那些長什麼樣」 */
export const SECRET_ALLIES = SECRET_KINDS

/** 稀有度 → 成長率。傳說長得快，但要練；神話更高，而且不用練 */
const GROWTH: Record<string, number> = {
  crude: 0.85, common: 0.95, fine: 1, rare: 1.12, legend: 1.28, mythic: 1.45,
}
/** 定位 → 數值配比。坦血厚傷害低，輸出反過來 */
const ROLE_MULT: Record<AllyRole, { hp: number; atk: number; def: number }> = {
  tank: { hp: 1.55, atk: 0.75, def: 1.6 },
  dps: { hp: 0.85, atk: 1.35, def: 0.85 },
  healer: { hp: 0.95, atk: 0.8, def: 1 },
  support: { hp: 0.9, atk: 1.0, def: 0.95 },
}

export const recruitXpForLevel = (lv: number) => Math.round(60 * Math.pow(lv, 1.6))

/** 新招募一隻。等級從 1 開始，要自己練 */
export function newRecruit(kindId: string, id?: string): Recruit {
  return { id: id ?? `${kindId}-${Math.random().toString(36).slice(2, 7)}`, kind: kindId, level: 1, xp: 0 }
}

/** 餵經驗，回傳有沒有升級 */
export function growRecruit(r: Recruit, xp: number): boolean {
  r.xp += xp
  let up = false
  while (r.xp >= recruitXpForLevel(r.level)) {
    r.xp -= recruitXpForLevel(r.level)
    r.level++
    up = true
  }
  return up
}

/**
 * 上場。
 *
 * 技能從該線挑兩個（入門的與 req 3 的）。治療系另外硬塞一個補血技能 ——
 * 沒有補血的「治療」只是名字好聽，實際打起來完全感覺不到定位差異。
 */
export function recruitCombatant(r: Recruit): Combatant {
  const k = ALLY_BY_ID[r.kind]
  if (!k) return fallback(r)
  const g = GROWTH[k.rarity] ?? 1
  const m = ROLE_MULT[k.role]
  const lv = r.level
  const hp = Math.round((50 + lv * 18) * m.hp * g)
  const mp = Math.round((40 + lv * 5) * g)
  const base = SKILLS.filter((s) => s.line === k.line)
  const skills = [base.find((s) => s.req === 0)?.id, base.find((s) => s.req === 3)?.id]
    .filter((x): x is string => !!x)
  if (k.role === 'healer' && !skills.includes('mend')) skills.push('mend')
  return {
    uid: `ally-${r.id}`, side: 'ally', art: k.art ?? k.id, name: k.name,
    hp, hpMax: hp, mp, mpMax: mp,
    atk: Math.round((8 + lv * 2.4) * m.atk * g),
    def: Math.round((3 + lv * 1.1) * m.def * g),
    crit: k.role === 'dps' ? 0.14 : 0.08,
    leech: 0, cds: {}, skills, color: k.color,
  }
}

/** 圖鑑裡查不到（存檔壞了或圖鑑改過）時的保底，不要讓整場戰鬥崩掉 */
function fallback(r: Recruit): Combatant {
  const hp = 50 + r.level * 18
  return {
    uid: `ally-${r.id}`, side: 'ally', art: r.kind, name: r.kind,
    hp, hpMax: hp, mp: 40, mpMax: 40,
    atk: Math.round(8 + r.level * 2.4), def: Math.round(3 + r.level * 1.1),
    crit: 0.08, leech: 0, cds: {}, skills: ['slash'], color: '#888',
  }
}

/**
 * 舊存檔補上內建的七隻龍。
 *
 * 沒有這一步，改版之後老玩家打開來會發現隊伍全空、一個夥伴都沒有 ——
 * 明明什麼都沒做卻像被沒收了。龍的 Recruit id 直接用 SKINS 的 key，
 * 舊存檔裡 party 存的就是那些 key，所以隊伍也不會散掉。
 */
export function ensureRoster(h: Hero): void {
  h.roster ??= []
  for (const k of AI_KINDS) {
    if (!h.roster.some((r) => r.id === k.id)) {
      h.roster.push({ id: k.id, kind: k.id, level: Math.max(1, h.level - 1), xp: 0 })
    }
  }
}

export const recruitById = (h: Hero, id: string) => h.roster?.find((r) => r.id === id)

// ── 彩蛋夥伴 ────────────────────────────────────────

/** 這個彩蛋夥伴解鎖了沒 */
export const hasSecretAlly = (h: Hero, id: string) => !!h.secretAllies?.includes(id)

/**
 * 檢查有沒有新解鎖的彩蛋夥伴，回傳這次新開的那些。
 * 跟彩蛋技能一樣，每次戰鬥結算後呼叫一次就夠 —— 條件都是累計值。
 */
export function checkSecretAllies(h: Hero): AllyKind[] {
  h.secretAllies ??= []
  h.roster ??= []
  const got: AllyKind[] = []
  for (const k of SECRET_KINDS) {
    if (!k.secret || h.secretAllies.includes(k.id)) continue
    if (!k.secret.test(h)) continue
    h.secretAllies.push(k.id)
    // id 直接用 kind id：每種只有一個，不需要區分實例，
    // 而且這樣「不可重複取得」是資料結構本身保證的，不是靠檢查。
    if (!h.roster.some((r) => r.id === k.id)) {
      h.roster.push({ id: k.id, kind: k.id, level: Math.max(1, h.level), xp: 0 })
    }
    got.push(k)
  }
  return got
}

/**
 * 彩蛋夥伴的等級跟著主角走。
 *
 * 為什麼不用經驗值：它們是「解鎖」來的，不是「抽」來的。
 * 一個 Lv.40 的玩家解開條件之後拿到一隻 Lv.1 的神話夥伴，
 * 那隻夥伴會在板凳上坐到天荒地老 —— 而且它不能重複取得，
 * 所以連「多抽幾張餵經驗」這條路都沒有。
 *
 * 只往上不往下：主角重置或降級時不去砍夥伴的等級，
 * 那沒有意義，只會讓人覺得被懲罰。冪等，讀檔與升級後各叫一次就好。
 */
export function syncSecretAllies(h: Hero): void {
  if (!h.roster) return
  for (const r of h.roster) {
    const k = ALLY_BY_ID[r.kind]
    if (!k?.secret) continue
    if (r.level < h.level) { r.level = h.level; r.xp = 0 }
  }
}
