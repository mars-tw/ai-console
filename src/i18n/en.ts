// 中文 → English 對照表
//
// key 就是程式裡寫的中文原文（見 src/i18n/index.ts 的說明）。
// 查不到的字串會原樣顯示中文，所以漏翻不會壞畫面，只是那一句還是中文。
//
// 帶變數的句子用 {name} 佔位，兩邊的佔位符必須一致。

export const EN: Record<string, string> = {
  // ── 通用 ─────────────────────────────────────────
  '無': 'None',
  '你': 'You',
  '自動': 'Auto',
  '重置': 'Reset',
  '關閉': 'Close',
  '全部': 'All',
  '其他': 'Other',
  '載入中…': 'Loading…',
  '重新掃描': 'Rescan',
  '顯示全部': 'Show all',
  '空的': 'Empty',
  '無資料': 'No data',
  '未知': 'Unknown',
  '取消': 'Cancel',
  '確定': 'OK',

  // ── 分頁 ─────────────────────────────────────────
  '📋 對話': '📋 Chats',
  '🎮 辦公室': '🎮 Office',
  '⚔️ 冒險': '⚔️ Adventure',

  // ── 屬性 ─────────────────────────────────────────
  '力量': 'Strength',
  '敏捷': 'Dexterity',
  '智力': 'Intellect',
  '信念': 'Faith',
  '體質': 'Vitality',
  '生命': 'HP',
  '魔力': 'MP',
  '攻擊': 'Attack',
  '防禦': 'Defence',
  '暴擊率': 'Crit rate',
  '急速': 'Haste',
  '吸血': 'Lifesteal',
  '經驗': 'XP',
  '等級': 'Level',

  // ── 技能線 ───────────────────────────────────────
  '近戰': 'Melee',
  '遠程': 'Ranged',
  '魔法': 'Magic',
  '信仰': 'Faith',

  // ── 裝備欄位 ─────────────────────────────────────
  '主手': 'Main hand',
  '副手': 'Off hand',
  '頭部': 'Head',
  '身體': 'Body',
  '手部': 'Hands',
  '腳部': 'Feet',
  '飾品 I': 'Trinket I',
  '飾品 II': 'Trinket II',

  // ── 品質 ─────────────────────────────────────────
  '粗製': 'Crude',
  '普通': 'Common',
  '精良': 'Fine',
  '稀有': 'Rare',
  '傳說': 'Legendary',

  // ── 技能 ─────────────────────────────────────────
  '斬擊': 'Slash',
  '基礎揮砍，沒有冷卻也不耗魔。': 'A basic swing. No cooldown, no mana.',
  '橫掃': 'Cleave',
  '大範圍揮擊，傷害高但要蓄力。': 'A wide arc. High damage, needs winding up.',
  '狂化': 'Berserk',
  '短時間內大幅提升攻擊力。': 'Sharply raises attack for a short while.',
  '處決': 'Execute',
  '對殘血目標造成致命一擊。': 'A killing blow against wounded targets.',
  '射擊': 'Shoot',
  '基礎射擊，命中穩定。': 'A basic shot. Reliable hits.',
  '連射': 'Volley',
  '快速連續射擊，冷卻短。': 'Rapid successive shots on a short cooldown.',
  '瞄準': 'Take Aim',
  '大幅提高暴擊率。': 'Greatly increases crit rate.',
  '狙擊': 'Snipe',
  '一發高傷，必定暴擊。': 'One heavy shot that always crits.',
  '魔彈': 'Arcane Bolt',
  '基礎法術彈。': 'A basic magic missile.',
  '烈焰': 'Blaze',
  '灼燒目標，傷害可觀。': 'Scorches the target for solid damage.',
  '凝神': 'Focus',
  '回復大量魔力。': 'Restores a large amount of mana.',
  '隕星': 'Meteor',
  '召喚隕石，全場最高單發傷害。': 'Calls down a meteor — the biggest single hit in the game.',
  '治癒': 'Mend',
  '回復自身生命。': 'Restores your own health.',
  '聖擊': 'Smite',
  '以信念之力打擊敵人。': 'Strikes an enemy with the force of faith.',
  '庇護': 'Ward',
  '提升防禦，減少受到的傷害。': 'Raises defence and reduces incoming damage.',
  '祝福': 'Blessing',
  '大幅回復生命，隊友也一起。': 'Heavily restores health — allies too.',

  // ── 怪物 ─────────────────────────────────────────
  '史萊姆': 'Slime',
  '巨鼠': 'Giant Rat',
  '野狼': 'Wolf',
  '哥布林': 'Goblin',
  '山賊': 'Bandit',
  '石魔像': 'Stone Golem',
  '怨靈': 'Wraith',
  '幼龍': 'Drake',
  '亡魂騎士': 'Revenant Knight',
  '食人魔頭目': 'Ogre Chieftain',
  '巫妖': 'Lich',
  '古龍': 'Ancient Wyrm',

  // ── 區域 ─────────────────────────────────────────
  '新手草原': 'Novice Meadow',
  '公司樓下的草地，適合剛開始練功。': 'The lawn downstairs. A good place to start.',
  '幽暗森林': 'Gloomwood',
  '狼群出沒，注意血量。': 'Wolves roam here. Watch your health.',
  '斷崖山道': 'Cliffside Pass',
  '山賊盤據的險路。': 'A dangerous road held by bandits.',
  '遺跡迴廊': 'Ruined Gallery',
  '怨靈在此徘徊不去。': 'Wraiths linger here and will not leave.',
  '深淵裂隙': 'Abyssal Rift',
  '最深處，只有亡魂與龍。': 'The deepest place. Only the dead and dragons.',

  // ── 地城 ─────────────────────────────────────────
  '哥布林洞窟': 'Goblin Cave',
  '第一個地城，帶一個隊友就夠。': 'The first dungeon. One ally is enough.',
  '冰封地穴': 'Frozen Crypt',
  '巫妖的巢穴，建議三人以上。': "The lich's lair. Bring three or more.",
  '古龍巢穴': 'Ancient Wyrm Lair',
  '最終試煉。': 'The final trial.',

  // ── 武器名 ───────────────────────────────────────
  '短劍': 'Shortsword', '闊斧': 'Broadaxe', '長槍': 'Spear', '巨劍': 'Greatsword', '戰鎚': 'Warhammer',
  '短弓': 'Shortbow', '十字弓': 'Crossbow', '長弓': 'Longbow', '飛刀': 'Throwing Knife', '獵槍': 'Hunting Gun',
  '木杖': 'Wooden Staff', '法杖': 'Mage Staff', '魔導書': 'Grimoire', '水晶球': 'Crystal Orb', '權杖': 'Sceptre',
  '聖徽': 'Holy Symbol', '祈禱書': 'Prayer Book', '聖錘': 'Sacred Mace', '聖印': 'Divine Seal', '神諭杖': 'Oracle Rod',

  // ── 防具名 ───────────────────────────────────────
  '皮帽': 'Leather Cap', '鐵盔': 'Iron Helm', '兜帽': 'Hood', '冠冕': 'Diadem',
  '皮甲': 'Leather Armour', '鎖子甲': 'Chainmail', '長袍': 'Robe', '胸甲': 'Cuirass',
  '皮手套': 'Leather Gloves', '護腕': 'Bracers', '指套': 'Finger Guards', '重手甲': 'Heavy Gauntlets',
  '皮靴': 'Leather Boots', '戰靴': 'War Boots', '軟鞋': 'Soft Shoes', '脛甲': 'Greaves',
  '圓盾': 'Round Shield', '塔盾': 'Tower Shield', '護符': 'Amulet', '副刃': 'Off-hand Blade',
  '素戒': 'Plain Ring', '寶石戒': 'Gem Ring', '徽章': 'Badge',

  // ── 前綴 ─────────────────────────────────────────
  '破損的': 'Battered ', '生鏽的': 'Rusted ', '普通的': 'Plain ',
  '精工': 'Masterwork ', '銳利的': 'Keen ', '堅固的': 'Sturdy ',
  '秘銀': 'Mithril ', '符文': 'Runed ', '風行': 'Windswift ',
  '龍紋': 'Dragonmarked ', '曙光': 'Dawnlit ', '終末': 'Endbringer ',

  // ── 戰鬥訊息 ─────────────────────────────────────
  '{who} 攻擊 {target}，造成 {dmg} 傷害{crit}': '{who} hits {target} for {dmg}{crit}',
  '{who} 使用「{skill}」對 {target} 造成 {dmg} 傷害{crit}': '{who} uses {skill} on {target} for {dmg}{crit}',
  '{who} 施放「{skill}」，回復 {amount} 生命': '{who} casts {skill}, restoring {amount} HP',
  '{who} 施放「{skill}」，回復 {amount} 魔力': '{who} casts {skill}, restoring {amount} MP',
  '{who} 施放「{skill}」，攻擊提升': '{who} casts {skill} — attack up',
  '{who} 施放「{skill}」，防禦提升': '{who} casts {skill} — defence up',
  '（暴擊！）': ' (CRIT!)',
  '{name} 倒下了': '{name} goes down',
  '你倒下了…被同事拖回辦公室休息': 'You go down… your colleagues drag you back to the office to rest',
  '拾獲 {item}': 'Picked up {item}',
  '進入 {place}': 'Entered {place}',
  '踏入 {place}（第 1 / {rooms} 間）': 'Entered {place} (room 1 of {rooms})',
  '前進到第 {room} / {rooms} 間': 'Advanced to room {room} of {rooms}',
  '最深處……{boss} 出現了！': 'At the deepest point… {boss} appears!',
  '{name} 通關！': '{name} cleared!',

  // ── 套裝 ─────────────────────────────────────────
  '主要': 'Primary',
  '第二套': 'Second set',
  '第三套': 'Third set',
  '套裝（裝備 + 技能 + 屬性整組切換）': 'Loadouts (gear + skills + attributes, swapped as one)',
}
