// 商店：金幣的出口
//
// 在這之前金幣只會往上加，永遠花不掉 —— 打贏拿到的數字沒有任何意義，
// 藥水喝完也只能等掉落。有了出口之後，「要不要現在買裝備」「留著洗點」
// 才會變成決策，掉落的雜物拿去賣也才有理由。
//
// 定價一律隨等級走。固定價格在前期買不起、後期又便宜到沒有取捨，
// 兩頭都不成立。

import { autoEquipBest, rollItem } from './engine'
import type { Hero, Item, Rarity } from './types'

/** 藥水帶太多就沒有補給壓力，上限壓在這裡 */
export const POTION_CAP = 9

/** 買東西給玩家看的回饋。訊息用原文當 key，交給呼叫端翻譯 */
export interface BuyResult {
  msg: string
  params?: Record<string, string | number>
  /** 買到的裝備，讓介面可以直接標示 */
  item?: Item
}

export interface ShopEntry {
  id: string
  icon: string
  name: string
  desc: string
  price: (h: Hero) => number
  /** 不能買的原因；回 null 代表可以買 */
  blocked?: (h: Hero) => string | null
  buy: (h: Hero) => BuyResult
}

const potionFull = (h: Hero, kind: 'hp' | 'mp') =>
  h.potions[kind] >= POTION_CAP ? '藥水帶滿了' : null

/** 精製以上的稀有度，越好機率越低 */
function fineRarity(): Rarity {
  const r = Math.random()
  return r > 0.93 ? 'legend' : r > 0.68 ? 'rare' : 'fine'
}

function grantItem(h: Hero, it: Item): BuyResult {
  h.bag.push(it)
  const changed = autoEquipBest(h)
  return {
    msg: changed.some((c) => c.to === it.id)
      ? '買到 {name}，已經直接換上'
      : '買到 {name}，放進背包（沒有比現在穿的好）',
    params: { name: it.name },
    item: it,
  }
}

export const SHOP: ShopEntry[] = [
  {
    id: 'potion-hp',
    icon: '🧪',
    name: '生命藥水',
    desc: '戰鬥中回復大量生命。帶著才敢打硬的',
    price: (h) => 40 + h.level * 6,
    blocked: (h) => potionFull(h, 'hp'),
    buy: (h) => { h.potions.hp++; return { msg: '生命藥水 +1（目前 {n} 瓶）', params: { n: h.potions.hp } } },
  },
  {
    id: 'potion-mp',
    icon: '💧',
    name: '魔力藥水',
    desc: '回復魔力。技能放得出來，回合制才有得打',
    price: (h) => 55 + h.level * 8,
    blocked: (h) => potionFull(h, 'mp'),
    buy: (h) => { h.potions.mp++; return { msg: '魔力藥水 +1（目前 {n} 瓶）', params: { n: h.potions.mp } } },
  },
  {
    id: 'potion-pack',
    icon: '🎒',
    name: '補給包',
    desc: '生命 ×3 + 魔力 ×2，比單買便宜兩成',
    price: (h) => Math.round(((40 + h.level * 6) * 3 + (55 + h.level * 8) * 2) * 0.8),
    blocked: (h) => (h.potions.hp >= POTION_CAP && h.potions.mp >= POTION_CAP ? '藥水帶滿了' : null),
    buy: (h) => {
      h.potions.hp = Math.min(POTION_CAP, h.potions.hp + 3)
      h.potions.mp = Math.min(POTION_CAP, h.potions.mp + 2)
      return { msg: '補滿了：生命 {hp} 瓶、魔力 {mp} 瓶', params: { hp: h.potions.hp, mp: h.potions.mp } }
    },
  },
  {
    id: 'gear',
    icon: '⚔️',
    name: '冒險者裝備',
    desc: '隨機一件，等級跟著你。比現在穿的好就自動換上',
    price: (h) => 150 + h.level * 55,
    buy: (h) => grantItem(h, rollItem(h.level)),
  },
  {
    id: 'gear-fine',
    icon: '✨',
    name: '精製裝備',
    desc: '保證精良以上，有機會出傳說。運氣不好時的保底管道',
    price: (h) => 520 + h.level * 160,
    buy: (h) => grantItem(h, rollItem(h.level, undefined, fineRarity())),
  },
  {
    id: 'protect',
    icon: '🛡️',
    name: '強化保護符',
    desc: '強化失敗時擋下碎裂（仍會退級）。衝 +10 以上前先囤幾張',
    price: (h) => 380 + h.level * 90,
    buy: (h) => {
      h.tickets ??= { ally: 0, gear: 0 }
      h.tickets.protect = (h.tickets.protect ?? 0) + 1
      return { msg: '保護符 +1（目前 {n} 張）', params: { n: h.tickets.protect } }
    },
  },
  {
    id: 'ticket-ally',
    icon: '🎴',
    name: '夥伴招募令',
    desc: '抽一次人形夥伴。打王與超級菁英也會掉',
    price: (h) => 820 + h.level * 40,
    buy: (h) => {
      h.tickets ??= { ally: 0, gear: 0 }
      h.tickets.ally++
      return { msg: '招募令 +1（目前 {n} 張）', params: { n: h.tickets.ally } }
    },
  },
  {
    id: 'respec-attr',
    icon: '🔄',
    name: '洗屬性點',
    desc: '退回目前套裝裡所有已配的屬性點，重新分配',
    price: (h) => 200 + h.level * 70,
    blocked: (h) => {
      const lo = h.loadouts[h.active]
      const spent = Object.values(lo.attrs).reduce((a, b) => a + b, 0)
      return spent > 0 ? null : '這一套還沒有配點'
    },
    buy: (h) => {
      const lo = h.loadouts[h.active]
      const spent = Object.values(lo.attrs).reduce((a, b) => a + b, 0)
      for (const k of Object.keys(lo.attrs) as (keyof typeof lo.attrs)[]) lo.attrs[k] = 0
      return { msg: '退回 {n} 點屬性，重新配吧', params: { n: spent } }
    },
  },
  {
    id: 'respec-skill',
    icon: '🌀',
    name: '洗技能點',
    desc: '退回目前套裝裡所有已學的技能點，換一條路走',
    price: (h) => 260 + h.level * 90,
    blocked: (h) => {
      const lo = h.loadouts[h.active]
      const spent = Object.values(lo.skills).reduce((a, b) => a + b, 0)
      return spent > 0 ? null : '這一套還沒有學技能'
    },
    buy: (h) => {
      const lo = h.loadouts[h.active]
      const spent = Object.values(lo.skills).reduce((a, b) => a + b, 0)
      lo.skills = {}
      return { msg: '退回 {n} 點技能，換一條路走', params: { n: spent } }
    },
  },
]
