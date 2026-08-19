// 存檔：純 localStorage，跟這個專案「資料不出本機」的原則一致
import { newHero } from './engine'
import type { Hero } from './types'

const KEY = 'ac_rpg_hero_v1'

export function loadHero(): Hero {
  try {
    const raw = localStorage.getItem(KEY)
    // 新角色立刻寫檔，不要等到玩家第一次操作才存
    if (!raw) { const h = newHero(); saveHero(h); return h }
    const h = JSON.parse(raw) as Hero
    // 舊存檔補齊欄位，避免改版後炸掉
    if (!Array.isArray(h.loadouts) || !h.loadouts.length) { const fresh = newHero(); saveHero(fresh); return fresh }
    h.bag ??= []
    h.kills ??= 0
    h.deaths ??= 0
    h.zone ??= 'meadow'
    h.active = Math.min(h.active ?? 0, h.loadouts.length - 1)
    for (const lo of h.loadouts) {
      lo.equipped ??= {}
      lo.skills ??= {}
      lo.attrs ??= { str: 0, dex: 0, int: 0, fai: 0, vit: 0 }
    }
    return h
  } catch {
    return newHero()
  }
}

export function saveHero(h: Hero) {
  try {
    localStorage.setItem(KEY, JSON.stringify(h))
  } catch {
    /* 存檔失敗不該讓遊戲中斷 */
  }
}

export function resetHero(): Hero {
  const h = newHero()
  saveHero(h)
  return h
}
