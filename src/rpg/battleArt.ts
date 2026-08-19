// 戰鬥畫面的素材載入與繪製
//
// 三種來源湊成一個畫面：
//   背景  public/office/rpg/bg/*.png       （不透明，鋪滿）
//   怪物  public/office/rpg/monsters/*.png （側面朝左，站在右半邊）
//   主角  public/office/rpg/hero/*.png     （四個動作）
//   隊友  重用辦公室那七隻龍的側面走路格（本來就朝右，正好面向敵人）
//
// 素材沒到齊時一律退回色塊，畫面不會開天窗。

import { CELL, FOOT_Y, SHEET_COLS, SKINS } from '@/pixel/sprites'
import { F } from '@/pixel/sprites'

export const BG_W = 480
export const BG_H = 270

const images = new Map<string, HTMLImageElement>()
const failed = new Set<string>()

function load(key: string, url: string) {
  if (images.has(key) || failed.has(key)) return
  const img = new Image()
  img.onload = () => images.set(key, img)
  img.onerror = () => failed.add(key)
  img.src = url
}

const WEAPON_LINES = ['melee', 'ranged', 'magic', 'faith'] as const

/** 一次把戰鬥要用的素材都排進載入佇列（重複呼叫不會重載）*/
export function loadBattleArt(monsterIds: string[], bgId: string, allyKeys: string[]) {
  load(`bg:${bgId}`, `/office/rpg/bg/${bgId}.png`)
  for (const m of monsterIds) load(`mon:${m}`, `/office/rpg/monsters/${m}.png`)
  for (const p of ['hero-stand', 'hero-attack', 'hero-cast', 'hero-hurt']) {
    load(`hero:${p}`, `/office/rpg/hero/${p}.png`)
  }
  for (const w of WEAPON_LINES) load(`wpn:${w}`, `/office/rpg/weapons/weapon-${w}.png`)
  for (const k of allyKeys) load(`ally:${k}`, `/office/sprites/${k}.png`)
}

/**
 * 主角每個姿勢裡「手」的位置，相對於腳底中心點。
 * 主角圖是空手畫的，武器另外疊上去，所以換裝備看得出來；
 * 代價就是這張對照表要人工對一次。
 */
const HAND: Record<string, { x: number; y: number; rot: number }> = {
  'hero-stand': { x: 9, y: -20, rot: 0.25 },
  'hero-attack': { x: 20, y: -34, rot: -0.6 },
  'hero-cast': { x: 17, y: -30, rot: -0.2 },
  'hero-hurt': { x: -4, y: -22, rot: 0.9 },
}

export const bgImage = (id: string) => images.get(`bg:${id}`)
export const monImage = (id: string) => images.get(`mon:${id}`)
export const heroImage = (pose: string) => images.get(`hero:${pose}`)

/**
 * 畫一隻隊友：從辦公室的動作總表裁「側面」那一格。
 * 側面素材朝右，正好面向站在右邊的敵人，所以不用鏡射。
 */
export function drawAlly(
  c: CanvasRenderingContext2D, key: string, x: number, footY: number, stepping: boolean, scale = 1,
) {
  const sheet = images.get(`ally:${key}`)
  const frame = stepping ? F.sideStep : F.sideStand
  const w = CELL * scale
  const h = CELL * scale
  const dx = Math.round(x - w / 2)
  const dy = Math.round(footY - FOOT_Y * scale)
  if (!sheet) {
    c.fillStyle = SKINS[key]?.color ?? '#888'
    c.fillRect(dx + w * 0.3, dy + h * 0.35, w * 0.4, h * 0.6)
    return
  }
  const sx = (frame % SHEET_COLS) * CELL
  const sy = Math.floor(frame / SHEET_COLS) * CELL
  c.drawImage(sheet, sx, sy, CELL, CELL, dx, dy, w, h)
}

/** 畫一隻怪物（素材沒到就畫灰色剪影，至少看得出位置與大小）*/
export function drawMonster(
  c: CanvasRenderingContext2D, id: string, x: number, footY: number, fallbackH = 44,
) {
  const img = monImage(id)
  if (!img) {
    c.fillStyle = '#6b7280'
    c.fillRect(Math.round(x - fallbackH * 0.3), Math.round(footY - fallbackH),
      Math.round(fallbackH * 0.6), fallbackH)
    return { w: fallbackH * 0.6, h: fallbackH }
  }
  c.drawImage(img, Math.round(x - img.width / 2), Math.round(footY - img.height))
  return { w: img.width, h: img.height }
}

/**
 * 把裝備中的武器畫進主角手裡。
 * line 是主手武器的技能線（melee/ranged/magic/faith）；沒裝武器就不畫。
 */
export function drawWeapon(
  c: CanvasRenderingContext2D, line: string | null, pose: string, x: number, footY: number,
) {
  if (!line) return
  const img = images.get(`wpn:${line}`)
  const hand = HAND[pose] ?? HAND['hero-stand']
  if (!img) return
  c.save()
  c.translate(Math.round(x + hand.x), Math.round(footY + hand.y))
  c.rotate(hand.rot)
  // 以握把（圖的左下角）為支點，武器才會像「握著」而不是浮在旁邊
  c.drawImage(img, 0, -img.height)
  c.restore()
}

/** 畫主角 */
export function drawHero(
  c: CanvasRenderingContext2D, pose: string, x: number, footY: number,
) {
  const img = heroImage(pose) ?? heroImage('hero-stand')
  if (!img) {
    c.fillStyle = '#e8eef4'
    c.fillRect(Math.round(x - 10), Math.round(footY - 48), 20, 48)
    return { w: 20, h: 48 }
  }
  c.drawImage(img, Math.round(x - img.width / 2), Math.round(footY - img.height))
  return { w: img.width, h: img.height }
}
