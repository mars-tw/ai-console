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
]

export const ALLY_KINDS: AllyKind[] = [...AI_KINDS, ...HUMAN_KINDS]
export const ALLY_BY_ID = Object.fromEntries(ALLY_KINDS.map((k) => [k.id, k]))
/** 抽卡池：只有人形夥伴。龍本來就送你了 */
export const GACHA_POOL = HUMAN_KINDS

/** 稀有度 → 成長率。傳說長得快，但要練 */
const GROWTH: Record<string, number> = { crude: 0.85, common: 0.95, fine: 1, rare: 1.12, legend: 1.28 }
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
