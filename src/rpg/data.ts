// 遊戲內容表：技能、怪物、區域、地城、裝備詞綴
//
// 四條技能線刻意做成可以互相補位：近戰高傷高風險、遠程穩定、
// 魔法爆發但吃 MP、信仰負責補血與減傷。沒有職業，所以混搭才是玩法。

import { registerItemPrefixes } from '@/i18n'
import type { AffixKey, Dungeon, Line, Monster, Rarity, Skill, Zone } from './types'

// ── 技能 ───────────────────────────────────────────
export const SKILLS: Skill[] = [
  // 近戰：吃力量，站著硬打
  { id: 'slash', name: '斬擊', line: 'melee', kind: 'attack', scale: 'str', req: 0, maxLv: 10, mpCost: 0, cd: 0, power: 1.0, desc: '基礎揮砍，沒有冷卻也不耗魔。' },
  { id: 'cleave', name: '橫掃', line: 'melee', kind: 'attack', scale: 'str', req: 3, maxLv: 10, mpCost: 6, cd: 3, power: 1.9, desc: '大範圍揮擊，傷害高但要蓄力。' },
  { id: 'berserk', name: '狂化', line: 'melee', kind: 'buff', scale: 'str', req: 8, maxLv: 5, mpCost: 12, cd: 8, power: 0.5, desc: '短時間內大幅提升攻擊力。' },
  { id: 'execute', name: '處決', line: 'melee', kind: 'attack', scale: 'str', req: 14, maxLv: 8, mpCost: 18, cd: 6, power: 3.2, desc: '對殘血目標造成致命一擊。' },

  // 遠程：吃敏捷，穩定輸出與暴擊
  { id: 'shoot', name: '射擊', line: 'ranged', kind: 'attack', scale: 'dex', req: 0, maxLv: 10, mpCost: 0, cd: 0, power: 0.9, desc: '基礎射擊，命中穩定。' },
  { id: 'volley', name: '連射', line: 'ranged', kind: 'attack', scale: 'dex', req: 3, maxLv: 10, mpCost: 5, cd: 2, power: 1.5, desc: '快速連續射擊，冷卻短。' },
  { id: 'aim', name: '瞄準', line: 'ranged', kind: 'buff', scale: 'dex', req: 8, maxLv: 5, mpCost: 10, cd: 7, power: 0.4, desc: '大幅提高暴擊率。' },
  { id: 'snipe', name: '狙擊', line: 'ranged', kind: 'attack', scale: 'dex', req: 14, maxLv: 8, mpCost: 16, cd: 5, power: 2.8, desc: '一發高傷，必定暴擊。' },

  // 魔法：吃智力，爆發但耗魔
  { id: 'bolt', name: '魔彈', line: 'magic', kind: 'attack', scale: 'int', req: 0, maxLv: 10, mpCost: 2, cd: 0, power: 1.1, desc: '基礎法術彈。' },
  { id: 'flame', name: '烈焰', line: 'magic', kind: 'attack', scale: 'int', req: 3, maxLv: 10, mpCost: 8, cd: 3, power: 2.1, desc: '灼燒目標，傷害可觀。' },
  { id: 'focus', name: '凝神', line: 'magic', kind: 'buff', scale: 'int', req: 8, maxLv: 5, mpCost: 0, cd: 6, power: 0.3, desc: '回復大量魔力。' },
  { id: 'meteor', name: '隕星', line: 'magic', kind: 'attack', scale: 'int', req: 14, maxLv: 8, mpCost: 26, cd: 8, power: 4.0, desc: '召喚隕石，全場最高單發傷害。' },

  // 信仰：吃信念，補血與減傷
  { id: 'mend', name: '治癒', line: 'faith', kind: 'heal', scale: 'fai', req: 0, maxLv: 10, mpCost: 6, cd: 2, power: 1.4, desc: '回復自身生命。' },
  { id: 'smite', name: '聖擊', line: 'faith', kind: 'attack', scale: 'fai', req: 3, maxLv: 10, mpCost: 7, cd: 3, power: 1.7, desc: '以信念之力打擊敵人。' },
  { id: 'ward', name: '庇護', line: 'faith', kind: 'buff', scale: 'fai', req: 8, maxLv: 5, mpCost: 10, cd: 7, power: 0.6, desc: '提升防禦，減少受到的傷害。' },
  { id: 'revive', name: '祝福', line: 'faith', kind: 'heal', scale: 'fai', req: 14, maxLv: 8, mpCost: 22, cd: 9, power: 3.0, desc: '大幅回復生命，隊友也一起。' },
]

export const SKILL_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.id, s]))
export const SKILLS_OF_LINE = (line: Line) => SKILLS.filter((s) => s.line === line)

// ── 怪物 ───────────────────────────────────────────
const mob = (id: string, name: string, level: number, mult = 1): Monster => ({
  id, name, level,
  hp: Math.round((28 + level * 14) * mult),
  atk: Math.round((6 + level * 2.6) * mult),
  def: Math.round((2 + level * 1.2) * mult),
  xp: Math.round((12 + level * 8) * mult),
  gold: Math.round((5 + level * 4) * mult),
  lootBonus: 0,
})
// 王：血量拉高當肉盾，攻擊只微幅提升。
// 之前是攻防血一起 ×4.2，結果第一個地城的王攻擊力 113，
// 三拳就把滿裝的 Lv.10 四人隊伍團滅 —— 王要耐打，不是要秒人。
const boss = (id: string, name: string, level: number): Monster => {
  const b = mob(id, name, level)
  return {
    ...b,
    hp: Math.round(b.hp * 5.5),
    atk: Math.round(b.atk * 1.9),
    def: Math.round(b.def * 1.5),
    xp: Math.round(b.xp * 4.2),
    gold: Math.round(b.gold * 4.2),
    lootBonus: 3,
    boss: true,
  }
}

export const MONSTERS: Monster[] = [
  mob('slime', '史萊姆', 1),
  mob('rat', '巨鼠', 2),
  mob('wolf', '野狼', 4),
  mob('goblin', '哥布林', 6),
  mob('bandit', '山賊', 9),
  mob('golem', '石魔像', 13),
  mob('wraith', '怨靈', 17),
  mob('drake', '幼龍', 22),
  mob('revenant', '亡魂騎士', 28),
  mob('scarab', '鐵殼聖甲蟲', 11),
  mob('sandworm', '沙蟲', 19),
  mob('icewisp', '冰靈', 24),
  mob('yeti', '雪怪', 31),
  mob('voidling', '虛影', 35),
  mob('starseer', '觀星者', 40),
  boss('boss-ogre', '食人魔頭目', 8),
  boss('boss-lich', '巫妖', 16),
  boss('boss-sandking', '沙蠍王', 21),
  boss('boss-wyrm', '古龍', 26),
  boss('boss-frostjarl', '霜霸', 33),
]
export const MONSTER_BY_ID = Object.fromEntries(MONSTERS.map((m) => [m.id, m]))

// ── 區域與地城 ─────────────────────────────────────
export const ZONES: Zone[] = [
  { id: 'meadow', name: '新手草原', minLevel: 1, desc: '公司樓下的草地，適合剛開始練功。', monsters: ['slime', 'rat'] },
  { id: 'forest', name: '幽暗森林', minLevel: 4, desc: '狼群出沒，注意血量。', monsters: ['wolf', 'goblin'] },
  { id: 'ridge', name: '斷崖山道', minLevel: 8, desc: '山賊盤據的險路。', monsters: ['bandit', 'golem'] },
  { id: 'ruins', name: '遺跡迴廊', minLevel: 14, desc: '怨靈在此徘徊不去。', monsters: ['wraith', 'drake'] },
  { id: 'abyss', name: '深淵裂隙', minLevel: 22, desc: '最深處，只有亡魂與龍。', monsters: ['drake', 'revenant'] },
  { id: 'dunes', name: '燙金沙丘', minLevel: 11, desc: '烈日下的沙海，蟲群在腳底鑽動。', monsters: ['scarab', 'sandworm'] },
  { id: 'glacier', name: '冰河谷', minLevel: 24, desc: '藍冰之間，寒氣本身就會傷人。', monsters: ['icewisp', 'yeti'] },
  { id: 'void', name: '星墟', minLevel: 35, desc: '碎裂的浮島與看得見星星的天空。', monsters: ['voidling', 'starseer'] },
]
export const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]))

export const DUNGEONS: Dungeon[] = [
  { id: 'cave', name: '哥布林洞窟', minLevel: 6, desc: '第一個地城，帶一個隊友就夠。', rooms: 3, trash: ['goblin', 'wolf'], boss: 'boss-ogre', partySize: 2 },
  { id: 'crypt', name: '冰封地穴', minLevel: 14, desc: '巫妖的巢穴，建議三人以上。', rooms: 4, trash: ['wraith', 'golem'], boss: 'boss-lich', partySize: 3 },
  { id: 'tomb', name: '流沙陵墓', minLevel: 20, desc: '沙下的王陵，蠍王守著它。', rooms: 4, trash: ['scarab', 'sandworm'], boss: 'boss-sandking', partySize: 3 },
  { id: 'lair', name: '古龍巢穴', minLevel: 24, desc: '最終試煉。', rooms: 5, trash: ['drake', 'revenant'], boss: 'boss-wyrm', partySize: 4 },
  { id: 'rift', name: '凍裂之谷', minLevel: 32, desc: '冰河深處的裂縫，霜霸在最底下。', rooms: 5, trash: ['icewisp', 'yeti'], boss: 'boss-frostjarl', partySize: 4 },
]
export const DUNGEON_BY_ID = Object.fromEntries(DUNGEONS.map((d) => [d.id, d]))

// ── 寵物 ───────────────────────────────────────────
/** 可收服的寵物。每種對應一條技能線，決定它的攻擊風味 */
export const PET_KINDS: { art: string; name: string; desc: string; line: Line }[] = [
  { art: 'pet-slimecat', name: '果凍貓', desc: '黏黏軟軟，撞上去意外地痛。', line: 'melee' },
  { art: 'pet-fluffbird', name: '毛球鳥', desc: '飛得快，會從高處俯衝。', line: 'ranged' },
  { art: 'pet-emberfox', name: '燼尾狐', desc: '尾巴帶火，吐得出小火球。', line: 'magic' },
  { art: 'pet-mossturtle', name: '苔背龜', desc: '背上長蘑菇，會分你一點治癒。', line: 'faith' },
  { art: 'pet-starmoth', name: '星塵蛾', desc: '鱗粉會發光，據說能帶來好運。', line: 'magic' },
]
export const PET_BY_ART = Object.fromEntries(PET_KINDS.map((p) => [p.art, p]))

/** 寵物掉落：打完王有機會遇到一隻願意跟你走的 */
export const PET_DROP_CHANCE = { boss: 0.35, elite: 0.04 }

// ── 裝備產生 ───────────────────────────────────────
export const RARITY_ORDER: Rarity[] = ['crude', 'common', 'fine', 'rare', 'legend', 'mythic']
/** 各品質的詞綴數量與數值倍率 */
export const RARITY_SPEC: Record<Rarity, { affixes: number; mult: number }> = {
  crude: { affixes: 0, mult: 0.7 },
  common: { affixes: 1, mult: 1.0 },
  fine: { affixes: 2, mult: 1.25 },
  rare: { affixes: 3, mult: 1.55 },
  legend: { affixes: 4, mult: 2.0 },
  // 神話只給彩蛋裝備用，隨機掉落表**不會**產出它 ——
  // 隨機也掉得到的話它就只是「更好的傳說」，而不是「那一件」。
  // 倍率拉到 2.6 是因為它同時受兩個限制：每種只有一件、而且不能強化。
  mythic: { affixes: 5, mult: 2.6 },
}

export const WEAPON_NAMES: Record<Line, string[]> = {
  melee: ['短劍', '闊斧', '長槍', '巨劍', '戰鎚'],
  ranged: ['短弓', '十字弓', '長弓', '飛刀', '獵槍'],
  magic: ['木杖', '法杖', '魔導書', '水晶球', '權杖'],
  faith: ['聖徽', '祈禱書', '聖錘', '聖印', '神諭杖'],
}
export const ARMOR_NAMES: Record<string, string[]> = {
  head: ['皮帽', '鐵盔', '兜帽', '冠冕'],
  body: ['皮甲', '鎖子甲', '長袍', '胸甲'],
  hands: ['皮手套', '護腕', '指套', '重手甲'],
  feet: ['皮靴', '戰靴', '軟鞋', '脛甲'],
  off: ['圓盾', '塔盾', '護符', '副刃'],
  ring1: ['素戒', '寶石戒', '護符', '徽章'],
  ring2: ['素戒', '寶石戒', '護符', '徽章'],
}
export const PREFIXES: Record<Rarity, string[]> = {
  crude: ['破損的', '生鏽的'],
  common: ['', '普通的'],
  fine: ['精工', '銳利的', '堅固的'],
  rare: ['秘銀', '符文', '風行'],
  legend: ['龍紋', '曙光', '終末'],
  // 神話裝備的名字是彩蛋自己指定的，不走前綴組字。
  // 這裡留一組只是為了讓型別完整；真的用到代表某處把神話當成隨機掉落了。
  mythic: ['原初'],
}

// 裝備名是「前綴 + 基礎名」組出來的，i18n 要知道前綴有哪些才拆得開
registerItemPrefixes(Object.values(PREFIXES).flat())

export const AFFIX_POOL: AffixKey[] = ['str', 'dex', 'int', 'fai', 'vit', 'atk', 'def', 'crit', 'haste', 'leech']
/** 每點 ilvl 給的詞綴數值，百分比類要小很多 */
export const AFFIX_SCALE: Record<AffixKey, number> = {
  str: 0.55, dex: 0.55, int: 0.55, fai: 0.55, vit: 0.7,
  atk: 0.8, def: 0.6, crit: 0.004, haste: 0.004, leech: 0.003,
}
