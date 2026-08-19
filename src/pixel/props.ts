// 辦公室環境素材：AI 生成的空房間底圖 + 家具精靈
//
// 家具是獨立精靈而不是畫死在底圖上，這樣才能做深度排序 ——
// 角色走到沙發後面就會被沙發擋住，走到前面就蓋過沙發。
// 素材還沒生好時，room.ts 的程式繪製版本會頂上，畫面不會開天窗。

import {
  BOARD, BOOKSHELF, BOXES, COFFEE_BAR, COOLER, DESKS, EXTRAS, MEETING_SEATS,
  MEETING_TABLE, PLANTERS, POTTED, READ_SPOT, SOFA, TOILET_DOOR,
} from './room'
import { BASE_H, BASE_W, TILE } from './theme'

export interface Placement {
  name: string
  x: number; y: number      // 佔地左上角（格）
  w: number; h: number      // 佔地格數
  /** 深度排序微調（像素）。椅子要負值，人才會坐在椅子前面 */
  bias?: number
}

/** 地板貼花：地毯類，永遠畫在最底層，不參與深度排序 */
export const FLOOR_DECALS: Placement[] = [
  { name: 'rug-desks', x: 1, y: 3, w: 20, h: 9 },
  { name: 'rug-meeting', x: 23, y: 3, w: 18, h: 9 },
  { name: 'rug-lounge', x: 23, y: 16, w: 11, h: 7 },
]

/** 會參與深度排序的家具 */
export const PROPS: Placement[] = [
  ...DESKS.map((d) => ({ name: 'desk', x: d.x, y: d.y, w: 4, h: 2 })),
  ...DESKS.map((d) => ({ name: 'chair', x: d.seat.x, y: d.seat.y, w: 1, h: 1, bias: -10 })),
  { name: 'meeting-table', x: MEETING_TABLE.x, y: MEETING_TABLE.y, w: MEETING_TABLE.w, h: MEETING_TABLE.h },
  ...MEETING_SEATS.map((s) => ({ name: 'chair', x: s.x, y: s.y, w: 1, h: 1, bias: -10 })),
  { name: 'sofa', x: SOFA.x, y: SOFA.y, w: SOFA.w, h: SOFA.h },
  { name: 'coffee-table', x: 26, y: 20, w: 5, h: 2 },
  { name: 'coffee-bar', x: COFFEE_BAR.x, y: COFFEE_BAR.y, w: COFFEE_BAR.w, h: COFFEE_BAR.h },
  { name: 'bookshelf', x: BOOKSHELF.x, y: BOOKSHELF.y, w: BOOKSHELF.w, h: BOOKSHELF.h },
  { name: 'armchair', x: READ_SPOT.x - 1, y: READ_SPOT.y - 1, w: 2, h: 2, bias: -10 },
  ...PLANTERS.map((p) => ({ name: 'plant-small', x: p.x, y: p.y, w: 2, h: 2 })),
  ...POTTED.map((p) => ({ name: 'plant-big', x: p.x, y: p.y, w: 2, h: 2 })),
  { name: 'whiteboard', x: BOARD.x, y: BOARD.y, w: BOARD.w, h: BOARD.h },
  { name: 'water-cooler', x: COOLER.x, y: COOLER.y, w: 1, h: 2 },
  { name: 'boxes', x: BOXES.x, y: BOXES.y, w: 2, h: 2 },
  { name: 'toilet-door', x: TOILET_DOOR.x, y: TOILET_DOOR.y, w: TOILET_DOOR.w, h: 2 },
  { name: 'wall-screen', x: 34, y: 1, w: 5, h: 2 },
  ...EXTRAS,
]

/** 深度排序鍵：佔地下緣。數字越大代表越靠近鏡頭，越晚畫 */
export const sortYOf = (p: Placement) => (p.y + p.h) * TILE + (p.bias ?? 0)

// ── 載入 ───────────────────────────────────────────
const images = new Map<string, HTMLImageElement>()
let shellReady = false
let loadedCount = 0

const ALL_NAMES = [...new Set([...FLOOR_DECALS, ...PROPS].map((p) => p.name))]

export function loadArt(onDone?: () => void) {
  let pending = ALL_NAMES.length + 1
  const tick = () => { if (--pending === 0) onDone?.() }

  const shell = new Image()
  shell.onload = () => { images.set('shell', shell); shellReady = true; tick() }
  shell.onerror = tick
  shell.src = '/office/props/shell.png'

  for (const name of ALL_NAMES) {
    const img = new Image()
    img.onload = () => { images.set(name, img); loadedCount++; tick() }
    img.onerror = tick
    img.src = `/office/props/${name}.png`
  }
}

/** 生成素材是否齊全到可以取代程式繪製的房間 */
export const hasArt = () => shellReady && loadedCount >= ALL_NAMES.length
export const hasShell = () => shellReady
export const hasProp = (name: string) => images.has(name)

// ── 繪製 ───────────────────────────────────────────
export function drawShell(c: CanvasRenderingContext2D) {
  const img = images.get('shell')
  if (img) c.drawImage(img, 0, 0, BASE_W, BASE_H)
}

export function drawDecals(c: CanvasRenderingContext2D) {
  for (const d of FLOOR_DECALS) {
    const img = images.get(d.name)
    if (img) c.drawImage(img, d.x * TILE, d.y * TILE, d.w * TILE, d.h * TILE)
  }
}

/** 畫一件家具：寬度貼齊格數，底部對齊佔地下緣（往上長出來是正常的） */
export function drawProp(c: CanvasRenderingContext2D, p: Placement) {
  const img = images.get(p.name)
  if (!img) return
  const w = p.w * TILE
  const h = Math.round(img.naturalHeight * (w / img.naturalWidth))
  c.drawImage(img, p.x * TILE, (p.y + p.h) * TILE - h, w, h)
}
