import { describe, expect, it } from 'vitest'

import {
  ALLY_KINDS,
  ensureRoster,
  growRecruit,
  newRecruit,
  recruitById,
  recruitCombatant,
  recruitXpForLevel,
} from './allies'
import { newHero } from './engine'
import type { Hero } from './types'

// ── 等級經驗曲線 ──────────────────────────────────────────

describe('recruitXpForLevel 等級經驗需求', () => {
  it('Lv.1 需求為 60 經驗，且隨等級單調嚴格遞增', () => {
    expect(recruitXpForLevel(1)).toBe(60)
    for (let lv = 1; lv <= 100; lv++) {
      const need = recruitXpForLevel(lv)
      expect(Number.isInteger(need)).toBe(true)
      expect(need).toBeGreaterThan(0)
      expect(recruitXpForLevel(lv + 1)).toBeGreaterThan(need)
    }
  })

  it('邊界：Lv.0 為 0，不會產生負數經驗需求', () => {
    expect(recruitXpForLevel(0)).toBe(0)
    expect(recruitXpForLevel(1)).toBeGreaterThan(0)
  })
})

// ── 新夥伴建立 ──────────────────────────────────────────

describe('newRecruit 新夥伴建立', () => {
  it('預設等級為 1、經驗值為 0、kindId 正確', () => {
    const r = newRecruit('knight')
    expect(r.kind).toBe('knight')
    expect(r.level).toBe(1)
    expect(r.xp).toBe(0)
    expect(r.id).toContain('knight-')
  })

  it('傳入自訂 id 時使用該自訂 id', () => {
    const r = newRecruit('mage', 'custom-mage-id')
    expect(r.id).toBe('custom-mage-id')
    expect(r.kind).toBe('mage')
  })

  it('每次未指定 id 生成的實例具有唯一 ID', () => {
    const r1 = newRecruit('knight')
    const r2 = newRecruit('knight')
    expect(r1.id).not.toBe(r2.id)
  })
})

// ── 夥伴養成與升級 ──────────────────────────────────────────

describe('growRecruit 夥伴經驗餵食與升級', () => {
  it('餵食不足以升級的經驗：經驗增加，等級不變，回傳 false', () => {
    const r = newRecruit('knight')
    const up = growRecruit(r, 30)
    expect(up).toBe(false)
    expect(r.level).toBe(1)
    expect(r.xp).toBe(30)
  })

  it('剛好達到升級經驗：等級 +1，經驗歸零，回傳 true', () => {
    const r = newRecruit('knight')
    const up = growRecruit(r, 60)
    expect(up).toBe(true)
    expect(r.level).toBe(2)
    expect(r.xp).toBe(0)
  })

  it('超額經驗升級：等級 +1，扣除當級需求並保留剩餘經驗', () => {
    const r = newRecruit('knight')
    const up = growRecruit(r, 75)
    expect(up).toBe(true)
    expect(r.level).toBe(2)
    expect(r.xp).toBe(15)
  })

  it('超大經驗一次連升多級：扣除累進需求，最終剩餘經驗小於下一級需求', () => {
    const r = newRecruit('knight')
    const up = growRecruit(r, 2000)
    expect(up).toBe(true)
    expect(r.level).toBeGreaterThan(3)
    expect(r.xp).toBeGreaterThanOrEqual(0)
    expect(r.xp).toBeLessThan(recruitXpForLevel(r.level))
  })

  it('邊界：增加 0 經驗回傳 false，等級與經驗皆不變', () => {
    const r = newRecruit('knight')
    const up = growRecruit(r, 0)
    expect(up).toBe(false)
    expect(r.level).toBe(1)
    expect(r.xp).toBe(0)
  })
})

// ── 戰鬥實體轉換與定位特性 ──────────────────────────────────

describe('recruitCombatant 戰鬥屬性與角色定位', () => {
  it('坦克 (tank)：具有更高的血量與防禦配比，攻擊力較低', () => {
    const knight = recruitCombatant({ id: 'r1', kind: 'knight', level: 10, xp: 0 })
    const ranger = recruitCombatant({ id: 'r2', kind: 'ranger', level: 10, xp: 0 })

    expect(knight.hp).toBeGreaterThan(ranger.hp)
    expect(knight.def).toBeGreaterThan(ranger.def)
    expect(ranger.atk).toBeGreaterThan(knight.atk)
  })

  it('輸出 (dps)：具有最高的攻擊力與 14% 暴擊率', () => {
    const rogue = recruitCombatant({ id: 'r1', kind: 'rogue', level: 10, xp: 0 })
    const bard = recruitCombatant({ id: 'r2', kind: 'bard', level: 10, xp: 0 })

    expect(rogue.crit).toBe(0.14)
    expect(bard.crit).toBe(0.08)
    expect(rogue.atk).toBeGreaterThan(bard.atk)
  })

  it('治療 (healer)：技能列表內必定包含 mend 技能', () => {
    const cleric = recruitCombatant({ id: 'r1', kind: 'cleric', level: 10, xp: 0 })
    const kimi = recruitCombatant({ id: 'kimi', kind: 'kimi', level: 10, xp: 0 })

    expect(cleric.skills).toContain('mend')
    expect(kimi.skills).toContain('mend')
  })

  it('稀有度成長率影響：傳說夥伴 (legend) 在同等下的屬性高於精良 (fine)', () => {
    const fineDps = recruitCombatant({ id: 'r1', kind: 'ranger', level: 20, xp: 0 }) // fine dps
    const legendDps = recruitCombatant({ id: 'r2', kind: 'dragoon', level: 20, xp: 0 }) // legend dps

    expect(legendDps.atk).toBeGreaterThan(fineDps.atk)
    expect(legendDps.hp).toBeGreaterThan(fineDps.hp)
    expect(legendDps.def).toBeGreaterThan(fineDps.def)
  })

  it('圖鑑缺失保底 (fallback)：未知 kind 依然回傳合理 Combatant 且不拋錯', () => {
    const brokenRecruit = { id: 'bad-id', kind: 'non_existent_kind', level: 5, xp: 0 }
    const c = recruitCombatant(brokenRecruit)

    expect(c).toBeDefined()
    expect(c.uid).toBe('ally-bad-id')
    expect(c.hp).toBeGreaterThan(0)
    expect(c.atk).toBeGreaterThan(0)
    expect(c.skills).toEqual(['slash'])
  })
})

// ── 舊存檔與 AI 龍補齊 ──────────────────────────────────────

describe('ensureRoster 陣容完整性與舊存檔相容', () => {
  it('舊存檔缺 roster 或為空時，自動補齊全部 7 隻 AI 龍', () => {
    const h = newHero()
    delete (h as Partial<Hero>).roster
    ensureRoster(h)

    expect(h.roster).toBeDefined()
    expect(h.roster?.length).toBe(7)
    const aiDragons = ALLY_KINDS.filter((k) => k.cat === 'ai')
    expect(aiDragons.length).toBe(7)
    for (const dragon of aiDragons) {
      expect(h.roster?.some((r) => r.id === dragon.id)).toBe(true)
    }
  })

  it('補齊的 AI 龍初始等級為 Math.max(1, hero.level - 1)', () => {
    const h1 = newHero()
    h1.level = 1
    h1.roster = []
    ensureRoster(h1)
    expect(h1.roster?.every((r) => r.level === 1)).toBe(true)

    const h10 = newHero()
    h10.level = 10
    h10.roster = []
    ensureRoster(h10)
    expect(h10.roster?.every((r) => r.level === 9)).toBe(true)
  })

  it('已存在的 AI 龍與人形夥伴保留其原有等級與經驗，不被重置', () => {
    const h = newHero()
    h.level = 10
    h.roster = [
      { id: 'kimi', kind: 'kimi', level: 15, xp: 50 },
      { id: 'custom-knight', kind: 'knight', level: 8, xp: 20 },
    ]

    ensureRoster(h)
    const kimi = h.roster.find((r) => r.id === 'kimi')
    const knight = h.roster.find((r) => r.id === 'custom-knight')

    expect(kimi?.level).toBe(15)
    expect(kimi?.xp).toBe(50)
    expect(knight?.level).toBe(8)
    expect(h.roster.length).toBe(8) // 7 隻龍 + 1 人形
  })

  it('重複呼叫 ensureRoster 具冪等性，不會增加重複的龍', () => {
    const h = newHero()
    ensureRoster(h)
    const len = h.roster?.length
    ensureRoster(h)
    expect(h.roster?.length).toBe(len)
  })
})

// ── 夥伴查詢 ──────────────────────────────────────────

describe('recruitById 夥伴查詢', () => {
  it('能正確依 ID 查找到陣容中的夥伴', () => {
    const h = newHero()
    ensureRoster(h)
    const found = recruitById(h, 'kimi')
    expect(found).toBeDefined()
    expect(found?.kind).toBe('kimi')
  })

  it('查無此 ID 或 roster 為 undefined 時回傳 undefined', () => {
    const h = newHero()
    expect(recruitById(h, 'non_existent_id')).toBeUndefined()

    delete (h as Partial<Hero>).roster
    expect(recruitById(h, 'kimi')).toBeUndefined()
  })
})
