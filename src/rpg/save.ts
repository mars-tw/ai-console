// 存檔：純 localStorage，跟這個專案「資料不出本機」的原則一致
import { ensureRoster } from './allies'
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
    // 藥水是後來加的，舊存檔沒有；補一組起始量而不是 0，
    // 否則老玩家一打開就少了一個剛做出來的操作手段
    h.potions ??= { hp: 3, mp: 2 }
    // 外觀與寵物都是後來加的，舊存檔要補
    h.look ??= 'hero'
    h.pets ??= []
    h.party ??= []
    // 夥伴、抽卡券、彩蛋都是後來加的。舊存檔要補齊，
    // 尤其 roster —— 少了它老玩家一打開會發現隊伍全空，像被沒收了一樣。
    ensureRoster(h)
    h.tickets ??= { ally: 1, gear: 1 }
    h.tickets.ally ??= 0
    h.tickets.gear ??= 0
    h.secrets ??= []
    h.tally ??= { deathStreak: 0, crits: 0, superKills: 0, cleanClears: 0, breaks: 0 }
    h.potions.hp ??= 0
    h.potions.mp ??= 0
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
