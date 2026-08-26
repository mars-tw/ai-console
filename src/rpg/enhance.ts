// 裝備強化：+1 到 +15，高段會爆
//
// 為什麼要有爆裝：沒有失敗代價的強化只是「按到夠有錢為止」，
// 那不是選擇，是打字練習。有爆裝之後才會出現真正的取捨 ——
// 這件 +9 的主手，要不要冒 25% 的險去衝 +10？還是先囤保護符？
//
// 對應地，+7 以下永遠不會爆。前期玩家還在摸索的時候把裝備炸掉，
// 學到的不是「風險管理」而是「別碰這個系統」。

import type { Hero, Item } from './types'
import { easeOut } from './battleFx'

export const MAX_PLUS = 15
/** 每一級加多少（乘在基礎 atk/def 上） */
export const PLUS_STEP = 0.09

/**
 * 彩蛋（神話）裝備不能強化。
 *
 * 三個理由，缺一個都不足以擋掉一個系統：
 *   1. **碎了就永遠沒了。** 每種只有一件、而且不可重複取得 ——
 *      強化台上一次 55% 的碎裂率，賭掉的是這個存檔再也拿不到的東西。
 *   2. **它本來就會自己長。** 等級跟著主角走（secrets.syncUniques），
 *      強化要解決的「後期變廢鐵」問題，在它身上不存在。
 *   3. 兩個成長來源疊在一起，數值會直接失控。
 *
 * 擋在 enhance() 裡而不是只在介面上藏按鈕：介面會改，規則不該靠介面守。
 */
export const canEnhance = (it: Item): boolean => !it.unique
export const CANNOT_ENHANCE_MSG = '神話裝備會自己跟著等級成長，不需要也不能強化'

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

/**
 * 這件裝備實際生效的攻／防（已含強化）。
 *
 * 為什麼一定要有這兩個函式，而不是各處自己乘：
 *   強化本來只有 computeStats() 會乘 plusMult，而**畫面上每一個
 *   會去看的地方都沒乘**：背包那一行寫的是 it.atk（基礎值）、
 *   分數 itemScore() 也只吃 it.atk。於是把一把劍強化到 +10：
 *     背包顯示「攻100」——跟 +0 一模一樣
 *     分數不變
 *     ⚡ 一鍵擇優裝備會把它換成基礎攻擊多 1 點的白裝
 *   使用者的原話是「強化裝備能力值也沒有上升，那強化要幹嘛」。
 *   他是對的：從每一個他會看的地方，強化都像沒有作用。
 *
 * 詞綴刻意不放大 —— 一起放大的話，一件 +15 的傳說會讓其他裝備變成裝飾品。
 */
export const effAtk = (it: Item) => Math.round(it.atk * plusMult(it))
export const effDef = (it: Item) => Math.round(it.def * plusMult(it))

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
  if (!canEnhance(it)) return { outcome: 'stay', msg: CANNOT_ENHANCE_MSG }
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

// ── 強化手感層 ──
// 戰鬥的手感在 battleFx.ts，這裡是強化的對應物，分工相同：
// 邏輯層只骰出「發生了什麼」，這一層把它變成看得見的回饋。
// 繪製函式一律收正規化進度 t: 0..1，時長由呼叫端決定 ——
// 跟戰鬥同一套協議，兩邊特效才能用同一個 rAF 迴圈驅動。
//
// 為什麼要有這層：三種結果原本只跳同一顆灰色提示，+15 碎裝跟 +1 成功
// 看起來一模一樣。玩家不是不怕風險，是根本看不到風險發生了。

/** 各結果的特效時長（毫秒）。
 * 最重的碎裂壓在 900：強化是會連做幾十次的操作，再長第三次就開始煩。
 * stay 是 0 —— 失敗但沒損失沒有值得一看的東西，不必鎖按鈕。 */
export const ENHANCE_FX_MS: Record<EnhanceOutcome, number> = {
  up: 650,
  down: 500,
  destroy: 900,
  stay: 0,
}

/** 取小數部分。跟 battleFx.shake 同一招的偽亂數：
 * 特效每幀重畫，用 Math.random 每次擲出不同方向，會閃成雜訊而不是粒子。 */
const frac = (v: number) => v - Math.floor(v)

/** 成功：往上炸的金色火花。
 * 不沿用 battleFx.drawSparks —— 那是整圈放射，是「被打」的語彙；
 * 強化成功要有明確的「往上」方向，否則讀起來像升上去的只是灰塵。 */
export function drawEnhSparks(c: CanvasRenderingContext2D, x: number, y: number, t: number) {
  if (t >= 1) return
  const n = 9
  const reach = 34 * easeOut(t)
  const lift = 16 * t
  c.save()
  c.globalAlpha = Math.max(0, 1 - t)
  c.strokeStyle = '#fbbf24'
  c.lineWidth = 2
  c.lineCap = 'round'
  for (let i = 0; i < n; i++) {
    // 上半圓扇形＋每支火花固定的小偏角，做出參差感
    const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 2.6 + Math.sin(i * 12.9) * 0.1
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    c.beginPath()
    c.moveTo(x + dx * reach * 0.45, y + dy * reach * 0.45 - lift * 0.4)
    c.lineTo(x + dx * reach, y + dy * reach - lift)
    c.stroke()
  }
  c.restore()
}

/** 成功的 +N 跳字：先放大、再上浮淡出。
 * 描邊＋填充跟戰鬥跳字同一套畫法，兩種數字才像同一個遊戲生的。 */
export function drawEnhPop(c: CanvasRenderingContext2D, x: number, y: number, t: number, plus: number) {
  if (t >= 1) return
  const scale = 1 + 0.55 * easeOut(Math.min(1, t / 0.45))
  const alpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45
  c.save()
  c.translate(x, y - t * 16)
  c.scale(scale, scale)
  c.globalAlpha = Math.max(0, alpha)
  c.font = 'bold 14px ui-sans-serif, system-ui, sans-serif'
  c.textAlign = 'center'
  c.lineWidth = 3
  c.strokeStyle = 'rgba(0,0,0,0.65)'
  c.fillStyle = '#fbbf24'
  c.strokeText(`+${plus}`, 0, 0)
  c.fillText(`+${plus}`, 0, 0)
  c.restore()
}

/** 碎裂的紅色警示閃爍。
 * 碎裂開場有一段頓幀，那瞬間畫面是靜止的 —— 沒有這層閃爍，
 * 最重的一擊在前 60 毫秒反而什麼都看不見。 */
export function drawEnhAlarm(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number,
) {
  if (t >= 1) return
  c.save()
  c.globalAlpha = 0.3 * Math.abs(Math.sin(t * Math.PI * 3)) * (1 - t * 0.5)
  c.fillStyle = '#ef4444'
  c.fillRect(x, y, w, h)
  c.restore()
}

/** 碎裂：碎片往外炸、接著受重力下落。
 * 碎塊畫成像素方塊而不是圓點 —— 整個遊戲是像素風，圓粒子會像別的遊戲混進來。 */
export function drawEnhShards(c: CanvasRenderingContext2D, x: number, y: number, t: number) {
  if (t <= 0 || t >= 1) return
  const n = 14
  c.save()
  c.globalAlpha = Math.max(0, 1 - t * t)
  for (let i = 0; i < n; i++) {
    const r1 = frac(Math.sin(i * 127.1) * 43758.5453)
    const r2 = frac(Math.sin(i * 311.7) * 12543.853)
    const a = r1 * Math.PI * 2
    const spd = (16 + r2 * 30) * easeOut(t)
    // 外炸後疊重力項，碎片走拋物線，墜落感才出得來
    const px = x + Math.cos(a) * spd
    const py = y + Math.sin(a) * spd * 0.7 + 52 * t * t
    const s = 1.5 + r2 * 2.5
    c.fillStyle = i % 3 === 0 ? '#f87171' : '#cbd5e1'
    c.fillRect(Math.round(px - s / 2), Math.round(py - s / 2), Math.round(s), Math.round(s))
  }
  c.restore()
}
