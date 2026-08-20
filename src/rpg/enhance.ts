// 裝備強化：+1 到 +15，高段會爆
//
// 為什麼要有爆裝：沒有失敗代價的強化只是「按到夠有錢為止」，
// 那不是選擇，是打字練習。有爆裝之後才會出現真正的取捨 ——
// 這件 +9 的主手，要不要冒 25% 的險去衝 +10？還是先囤保護符？
//
// 對應地，+7 以下永遠不會爆。前期玩家還在摸索的時候把裝備炸掉，
// 學到的不是「風險管理」而是「別碰這個系統」。

import type { Hero, Item } from './types'

export const MAX_PLUS = 15
/** 每一級加多少（乘在基礎 atk/def 上） */
export const PLUS_STEP = 0.09

export interface EnhanceOdds {
  /** 成功率 0..1 */
  success: number
  /** 失敗時被摧毀的機率 0..1 */
  destroy: number
  /** 失敗但沒爆時掉幾級 */
  down: number
}

/**
 * 各段的機率。
 * +1~+6 是「保底段」：失敗頂多退一級，不會消失。
 * +7 起進入風險段，這也是玩家開始需要保護符的地方。
 */
export function odds(plus: number, h?: Hero): EnhanceOdds {
  // 彩蛋技能「鐵匠之手」：爆過五件之後才拿得到，算是繳過學費的補償
  const bonus = h?.secrets?.includes('ironhand') ? 0.08 : 0
  const cap = (v: number) => Math.max(0.05, Math.min(1, v + bonus))
  if (plus < 3) return { success: 1, destroy: 0, down: 0 }
  if (plus < 6) return { success: cap(0.82), destroy: 0, down: 1 }
  if (plus < 9) return { success: cap(0.55), destroy: 0.22, down: 1 }
  if (plus < 12) return { success: cap(0.36), destroy: 0.4, down: 2 }
  return { success: cap(0.22), destroy: 0.55, down: 2 }
}

/** 強化費用：跟著裝備等級與目前強化度一起長 */
export function enhanceCost(it: Item): number {
  const p = it.plus ?? 0
  return Math.round((60 + it.ilvl * 22) * Math.pow(1 + p, 1.35))
}

/** 強化後的實際數值（畫面與戰鬥都用這個，不要各算各的） */
export const plusMult = (it: Item) => 1 + (it.plus ?? 0) * PLUS_STEP

export type EnhanceOutcome = 'up' | 'down' | 'stay' | 'destroy'

export interface EnhanceResult {
  outcome: EnhanceOutcome
  /** 給玩家看的訊息（原文當 key，呼叫端翻譯） */
  msg: string
  params?: Record<string, string | number>
  /** 有沒有用掉保護符 */
  usedProtect?: boolean
}

/**
 * 就地強化一件裝備。
 *
 * 呼叫端負責先扣錢、確認背包裡真的有這件。這裡只管骰。
 * protect=true 時失敗也不會摧毀，但保護符照樣消耗 ——
 * 「失敗才扣」聽起來比較佛，實作上卻會讓玩家在 100% 成功的低段
 * 也掛著保護符，反而變成沒有決策。
 */
export function enhance(h: Hero, it: Item, protect: boolean): EnhanceResult {
  const p = it.plus ?? 0
  if (p >= MAX_PLUS) return { outcome: 'stay', msg: '已經強化到頂了' }
  const o = odds(p, h)

  if (Math.random() < o.success) {
    it.plus = p + 1
    return { outcome: 'up', msg: '強化成功！{name} +{n}', params: { name: it.name, n: it.plus } }
  }
  if (!protect && Math.random() < o.destroy) {
    h.tally ??= { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }
    h.tally.breaks++
    return { outcome: 'destroy', msg: '{name} 在強化中碎掉了', params: { name: it.name } }
  }
  if (o.down > 0) {
    it.plus = Math.max(0, p - o.down)
    return {
      outcome: 'down',
      msg: protect ? '失敗，保護符擋下了碎裂（{name} +{n}）' : '強化失敗，{name} 退到 +{n}',
      params: { name: it.name, n: it.plus },
      usedProtect: protect,
    }
  }
  return { outcome: 'stay', msg: '強化失敗，但沒有損失', usedProtect: protect }
}
