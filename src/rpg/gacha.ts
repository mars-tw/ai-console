// 抽卡：夥伴與裝備
//
// 兩件事情刻意跟手遊反著做：
//   1. **沒有課金**。抽卡券打王、清地城會掉，也可以直接用金幣換，
//      所以它是金幣的另一個出口，不是付費牆。
//   2. **重複不是垃圾**。抽到已經有的夥伴會轉成那一隻的經驗，
//      等於「歪了也在養」。單機遊戲裡讓玩家覺得白抽是沒有意義的懲罰。
//
// 十連保底稀有以上，理由一樣：單機沒有必要製造挫折。

import { GACHA_POOL, growRecruit, newRecruit } from './allies'
import { rollItem } from './engine'
import { makeUnique, missingUniques, recordUnique } from './secrets'
import type { AllyKind, Hero, Item, Rarity, Recruit } from './types'

export const ALLY_PULL_GOLD = 900
export const GEAR_PULL_GOLD = 700
/** 十連：付九抽的價 */
export const TEN = 10
export const tenCost = (one: number) => one * 9

/** 夥伴稀有度機率。傳說 4% 是單機該有的手感，不是要你抽三百次 */
const ALLY_ODDS: [Rarity, number][] = [['fine', 0.66], ['rare', 0.30], ['legend', 0.04]]
/** 裝備稀有度機率 */
const GEAR_ODDS: [Rarity, number][] = [['common', 0.34], ['fine', 0.40], ['rare', 0.22], ['legend', 0.04]]
/** 每抽裝備有多低的機率直接掉彩蛋裝 */
const UNIQUE_CHANCE = 0.02

function pickRarity(table: [Rarity, number][], floor?: Rarity): Rarity {
  // 刻意不含 mythic：神話只給彩蛋用，隨機表不該抽得到。
  // 寫死在這裡而不是用 RARITY_ORDER，正是為了讓「隨機掉不到神話」
  // 是一件看得見的事，而不是靠別處的表剛好沒列到。
  const order: Rarity[] = ['crude', 'common', 'fine', 'rare', 'legend']
  const min = floor ? order.indexOf(floor) : 0
  const pool = table.filter(([r]) => order.indexOf(r) >= min)
  const total = pool.reduce((n, [, w]) => n + w, 0)
  let r = Math.random() * total
  for (const [rar, w] of pool) {
    r -= w
    if (r <= 0) return rar
  }
  return pool[pool.length - 1]?.[0] ?? 'common'
}

const byRarity = (rar: Rarity): AllyKind[] => {
  const hit = GACHA_POOL.filter((k) => k.rarity === rar)
  return hit.length ? hit : GACHA_POOL
}

export interface AllyPull {
  kind: AllyKind
  /** 重複時轉成的經驗值；不是重複則為 0 */
  dupeXp: number
  recruit?: Recruit
}

/** 抽一隻夥伴。就地寫進 h.roster */
export function pullAlly(h: Hero, floor?: Rarity): AllyPull {
  h.roster ??= []
  const pool = byRarity(pickRarity(ALLY_ODDS, floor))
  const kind = pool[Math.floor(Math.random() * pool.length)]
  const owned = h.roster.find((r) => r.kind === kind.id)
  if (owned) {
    // 重複 → 餵給已經有的那一隻。稀有度越高，一張換的經驗越多
    const xp = { crude: 40, common: 60, fine: 90, rare: 180, legend: 400, mythic: 800 }[kind.rarity] ?? 90
    growRecruit(owned, xp)
    return { kind, dupeXp: xp, recruit: owned }
  }
  const r = newRecruit(kind.id)
  h.roster.push(r)
  return { kind, dupeXp: 0, recruit: r }
}

export interface GearPull {
  item: Item
  unique: boolean
}

/** 抽一件裝備。回傳物品，呼叫端自己決定要不要放進背包 */
export function pullGear(h: Hero, nextId: () => string, floor?: Rarity): GearPull {
  const left = missingUniques(h)
  if (left.length && Math.random() < UNIQUE_CHANCE) {
    const u = left[Math.floor(Math.random() * left.length)]
    // 記進永久紀錄。少了這一行，賣掉之後同一件又會再抽到 ——
    // 那叫「一次只能有一件」，不是「獨一無二」。
    recordUnique(h, u.id)
    return { item: makeUnique(u, h.level, nextId()), unique: true }
  }
  return { item: rollItem(h.level, undefined, pickRarity(GEAR_ODDS, floor)), unique: false }
}

/** 十連的保底：最後一抽至少稀有 */
export const floorAt = (i: number, n: number): Rarity | undefined => (i === n - 1 ? 'rare' : undefined)
