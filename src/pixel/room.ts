// 俯視像素辦公室：格局、家具繪製、碰撞格、行為目的地
//
// 座標一律用「格」(tile)，繪製時再乘 TILE。格局圖（42×26）：
//
//   x  0        10        20        30        40
//   y0 ┌──────────── 窗戶牆 ────────────────────┐
//    3 │ 桌 桌 桌 桌      │      會議室（玻璃隔間）│
//   10 │ 桌 桌 桌  白板   │                      │
//   15 │ 花圃  書架       │  ─────────────────   │
//   17 │                 走 │  沙發   休息區  咖啡│
//   20 │   空地（走來走去）道│    茶几        廁所 │
//   24 └─────────────────────────────────────────┘

import { BASE_H, BASE_W, C, COLS, ROWS, TILE, mulberry32 } from './theme'

export type Dir = 'down' | 'up' | 'left' | 'right'
export interface Spot { x: number; y: number; face: Dir }

// ── 格局常數 ───────────────────────────────────────
/** 7 個工位：desk 佔 (x..x+3, y..y+1)，座位在正下方 */
export const DESKS: { x: number; y: number; seat: Spot }[] = [
  { x: 2, y: 5, seat: { x: 3, y: 7, face: 'up' } },
  { x: 7, y: 5, seat: { x: 8, y: 7, face: 'up' } },
  { x: 12, y: 5, seat: { x: 13, y: 7, face: 'up' } },
  { x: 17, y: 5, seat: { x: 18, y: 7, face: 'up' } },
  { x: 2, y: 10, seat: { x: 3, y: 12, face: 'up' } },
  { x: 7, y: 10, seat: { x: 8, y: 12, face: 'up' } },
  { x: 12, y: 10, seat: { x: 13, y: 12, face: 'up' } },
]

/** 會議桌 (26..35, 6..8)，上下各 3 個座位 */
export const MEETING_TABLE = { x: 26, y: 6, w: 10, h: 3 }
export const MEETING_SEATS: Spot[] = [
  { x: 27, y: 5, face: 'down' }, { x: 30, y: 5, face: 'down' }, { x: 33, y: 5, face: 'down' },
  { x: 27, y: 9, face: 'up' }, { x: 30, y: 9, face: 'up' }, { x: 33, y: 9, face: 'up' },
]

/** 沙發 (23..31, 17..18)：3 個睡位 */
export const SOFA = { x: 23, y: 17, w: 9, h: 2 }
export const SOFA_SPOTS: Spot[] = [
  { x: 24, y: 18, face: 'down' }, { x: 27, y: 18, face: 'down' }, { x: 30, y: 18, face: 'down' },
]

export const COFFEE_BAR = { x: 35, y: 15, w: 5, h: 2 }
export const COFFEE_SPOT: Spot = { x: 36, y: 17, face: 'up' }

export const BOOKSHELF = { x: 12, y: 15, w: 5, h: 2 }
export const READ_SPOT: Spot = { x: 14, y: 18, face: 'up' }

/** 花圃：3 個花盆，澆花站在正下方 */
export const PLANTERS = [
  { x: 2, y: 15 }, { x: 5, y: 15 }, { x: 8, y: 15 },
]
export const PLANT_SPOTS: Spot[] = PLANTERS.map((p) => ({ x: p.x, y: p.y + 2, face: 'up' }))

/** 廁所門開在上方牆面（俯視圖的下緣沒有牆，門只能放在遠端牆上）*/
export const TOILET_DOOR = { x: 1, y: 1, w: 3 }
export const TOILET_SPOT: Spot = { x: 2, y: 3, face: 'up' }

/**
 * 白板 = 派工台（tool call 時站這裡）
 *
 * 位置很挑：白板的圖有 5 格多高，但佔地只登記 1 格，所以它會往上長出去。
 * 原本擺在 (16,10)，結果整片白板蓋在上一排桌子上，把正在工作的龍擋住。
 * 現在移到桌區下方的空地，正上方五格必須淨空。
 */
export const BOARD = { x: 17, y: 15, w: 5, h: 1 }
export const BOARD_SPOT: Spot = { x: 19, y: 17, face: 'up' }

export const POTTED = [{ x: 34, y: 19 }, { x: 22, y: 22 }]

/**
 * 額外的辦公配件。座標是用佔用圖算出來的：
 * 每件家具的「實際繪製高度」（打包後像素高 ÷ 16）都比佔地高，
 * 所以擺位時要把往上長出去的部分算進去，否則就會像先前的白板一樣蓋到人。
 * 驗算工具：tools/check_layout.py
 */
export const EXTRAS: { name: string; x: number; y: number; w: number; h: number }[] = [
  { name: 'printer', x: 32, y: 11, w: 3, h: 2 },
  { name: 'filing-cabinet', x: 32, y: 15, w: 2, h: 2 },
  { name: 'server-rack', x: 36, y: 6, w: 3, h: 3 },
  { name: 'vending-machine', x: 36, y: 19, w: 3, h: 3 },
  { name: 'arcade-machine', x: 1, y: 23, w: 2, h: 3 },
  { name: 'fish-tank', x: 5, y: 24, w: 4, h: 2 },
  { name: 'standing-lamp', x: 20, y: 18, w: 1, h: 2 },
  { name: 'wall-clock', x: 20, y: 1, w: 2, h: 1 },
  { name: 'poster', x: 28, y: 1, w: 3, h: 2 },
]
export const COOLER = { x: 2, y: 19 }      // 飲水機
export const BOXES = { x: 18, y: 21 }      // 紙箱堆

/** 走來走去用的空地錨點 */
export const WANDER_SPOTS: { x: number; y: number }[] = [
  { x: 4, y: 21 }, { x: 9, y: 21 }, { x: 14, y: 22 }, { x: 18, y: 20 },
  { x: 21, y: 8 }, { x: 21, y: 15 }, { x: 21, y: 21 }, { x: 6, y: 19 },
  { x: 25, y: 14 }, { x: 33, y: 24 }, { x: 38, y: 23 }, { x: 30, y: 13 },
  { x: 8, y: 24 }, { x: 16, y: 25 }, { x: 27, y: 25 },
]

// ── 碰撞格 ─────────────────────────────────────────
const solid = new Uint8Array(COLS * ROWS)
const IDX = (x: number, y: number) => y * COLS + x
const block = (x: number, y: number, w = 1, h = 1) => {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++)
      if (i >= 0 && i < COLS && j >= 0 && j < ROWS) solid[IDX(i, j)] = 1
}

// 外牆
block(0, 0, COLS, 3)        // 上牆（含窗）
block(0, 27, COLS, 1)       // 下牆（底圖的地板一路鋪到底，只擋最後一列）
block(0, 0, 1, ROWS)        // 左牆
block(41, 0, 1, ROWS)       // 右牆
// 工位
DESKS.forEach((d) => block(d.x, d.y, 4, 2))
// 會議室玻璃隔間：左牆 x=22（門在 y 7..8）、下牆 y=12（門在 x 30..31）
for (let y = 3; y <= 12; y++) if (y !== 7 && y !== 8) block(22, y)
for (let x = 22; x <= 40; x++) if (x !== 30 && x !== 31) block(x, 12)
block(MEETING_TABLE.x, MEETING_TABLE.y, MEETING_TABLE.w, MEETING_TABLE.h)
// 休息區
block(SOFA.x, SOFA.y, SOFA.w, SOFA.h)
block(26, 20, 5, 2)                                   // 茶几
block(COFFEE_BAR.x, COFFEE_BAR.y, COFFEE_BAR.w, COFFEE_BAR.h)
block(BOOKSHELF.x, BOOKSHELF.y, BOOKSHELF.w, BOOKSHELF.h)
PLANTERS.forEach((p) => block(p.x, p.y, 2, 2))
POTTED.forEach((p) => block(p.x, p.y, 2, 2))
block(BOARD.x, BOARD.y, BOARD.w, BOARD.h)
block(COOLER.x, COOLER.y, 1, 2)
  // 牆上的掛飾不擋路，其餘會擋
  for (const e of EXTRAS) {
    if (e.name === 'wall-clock' || e.name === 'poster') continue
    block(e.x, e.y, e.w, e.h)
  }
block(BOXES.x, BOXES.y, 2, 2)

export function isSolid(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return true
  return solid[IDX(x, y)] === 1
}
/** 座位本身可站（角色要走到座位上），但別人不能穿過家具 */
export function walkable(x: number, y: number): boolean {
  return !isSolid(x, y)
}

// ── 繪製工具 ───────────────────────────────────────
type Ctx = CanvasRenderingContext2D
const r = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => {
  c.fillStyle = col
  c.fillRect(x, y, w, h)
}
/** 以格為單位填色 */
const rt = (c: Ctx, tx: number, ty: number, tw: number, th: number, col: string) =>
  r(c, tx * TILE, ty * TILE, tw * TILE, th * TILE, col)

// ── 地板 ───────────────────────────────────────────
function drawFloor(c: Ctx) {
  const rand = mulberry32(20260819)
  rt(c, 0, 0, COLS, ROWS, C.floorB)
  // 橫向木板，每 8px 一條，接縫錯開
  for (let y = 0; y < BASE_H; y += 8) {
    const row = y / 8
    r(c, 0, y, BASE_W, 8, row % 2 ? C.floorA : C.floorB)
    // 板與板之間的縫
    r(c, 0, y + 7, BASE_W, 1, C.floorSeam)
    let x = (row % 3) * 24
    while (x < BASE_W) {
      r(c, x, y, 1, 7, C.floorSeam)
      x += 48 + Math.floor(rand() * 40)
    }
  }
  // 會議室地毯
  rt(c, 23, 3, 18, 9, C.meetRug)
  for (let y = 3; y < 12; y++)
    for (let x = 23; x < 41; x++)
      if ((x + y) % 2 === 0) rt(c, x, y, 1, 1, '#2b4d59')
  // 休息區地毯（含邊框花紋）
  rt(c, 23, 16, 11, 7, C.rug)
  for (let y = 16; y < 23; y++)
    for (let x = 23; x < 34; x++)
      if ((x * 3 + y * 5) % 7 === 0) rt(c, x, y, 1, 1, C.rugAlt)
  r(c, 23 * TILE, 16 * TILE, 11 * TILE, 3, C.rugTrim)
  r(c, 23 * TILE, 23 * TILE - 3, 11 * TILE, 3, C.rugTrim)
  r(c, 23 * TILE, 16 * TILE, 3, 7 * TILE, C.rugTrim)
  r(c, 34 * TILE - 3, 16 * TILE, 3, 7 * TILE, C.rugTrim)
  // 廁所前的磁磚
  rt(c, 1, 3, 4, 2, '#4a5a63')
  for (let y = 3; y < 5; y++)
    for (let x = 1; x < 5; x++)
      if ((x + y) % 2) rt(c, x, y, 1, 1, '#54646e')
}

// ── 牆與窗 ─────────────────────────────────────────
function drawWalls(c: Ctx) {
  // 上牆：天花板暗面 + 牆面 + 踢腳
  rt(c, 0, 0, COLS, 1, C.wallTop)
  rt(c, 0, 1, COLS, 2, C.wallFace)
  r(c, 0, 3 * TILE - 4, BASE_W, 4, C.skirting)
  // 側牆與下牆
  rt(c, 0, 0, 1, ROWS, C.wallFace)
  rt(c, 41, 0, 1, ROWS, C.wallFace)
  rt(c, 0, 26, COLS, 2, C.wallFace)
  r(c, 0, 26 * TILE, BASE_W, 4, C.wallTop)
  r(c, TILE - 4, 0, 4, 26 * TILE, C.skirting)
  r(c, 41 * TILE, 0, 4, 26 * TILE, C.skirting)

  // 窗戶：三大扇落地窗，窗外夜景
  const rand = mulberry32(77)
  const wins = [[2, 12], [15, 11], [27, 13]]
  for (const [wx, ww] of wins) {
    const px = wx * TILE, pw = ww * TILE, py = 6, ph = 2 * TILE + 4
    r(c, px - 2, py - 2, pw + 4, ph + 4, C.sash)
    r(c, px, py, pw, ph, C.glass)
    // 遠景樓房
    for (let i = 0; i < ww * 2; i++) {
      const bw = 8 + Math.floor(rand() * 14)
      const bh = 10 + Math.floor(rand() * (ph - 12))
      const bx = px + Math.floor(rand() * (pw - bw))
      const by = py + ph - bh
      r(c, bx, by, bw, bh, rand() > 0.5 ? C.tower : C.towerFar)
      // 亮窗
      for (let ly = by + 2; ly < py + ph - 2; ly += 4) {
        for (let lx = bx + 2; lx < bx + bw - 2; lx += 4) {
          const v = rand()
          if (v > 0.62) r(c, lx, ly, 2, 2, v > 0.93 ? C.litCool : C.litWarm)
        }
      }
      // 頂端航警燈
      if (rand() > 0.7) r(c, bx + (bw >> 1), by - 2, 2, 2, C.litRed)
    }
    // 窗框橫豎櫺
    for (let i = 1; i < ww; i += 3) r(c, px + i * TILE, py, 2, ph, C.sash)
    r(c, px, py + TILE, pw, 2, C.sash)
    // 玻璃反光
    c.fillStyle = 'rgba(150,200,255,0.06)'
    c.fillRect(px, py, pw, ph >> 1)
  }

  // 天花板燈條（暖光）
  for (const lx of [5, 14, 30]) {
    r(c, lx * TILE, 0, 5 * TILE, 5, '#3a4256')
    r(c, lx * TILE + 2, 2, 5 * TILE - 4, 3, '#ffe6b0')
  }
}

// ── 家具 ───────────────────────────────────────────
function drawDesk(c: Ctx, tx: number, ty: number) {
  const x = tx * TILE, y = ty * TILE, w = 4 * TILE, h = 2 * TILE
  r(c, x + 2, y + h - 4, w - 4, 6, C.shadow)          // 落地陰影
  r(c, x, y + 4, w, h - 6, C.deskEdge)                 // 桌側
  r(c, x, y + 2, w, h - 10, C.deskTop)                 // 桌面
  r(c, x, y + 2, w, 2, '#c09263')                      // 桌面高光
  for (let i = 1; i < 4; i++) r(c, x + i * TILE, y + 4, 1, h - 10, C.deskEdge)
  // 螢幕（靠桌子後緣）
  const mx = x + TILE - 2
  r(c, mx + 8, y + 2, 12, 3, C.monFoot)
  r(c, mx + 12, y - 2, 4, 5, C.monBody)
  r(c, mx - 2, y - 14, 32, 13, C.monBody)
  r(c, mx, y - 12, 28, 9, C.screenOff)                 // 螢幕內容由動態層畫
  // 鍵盤與滑鼠
  r(c, x + TILE - 4, y + h - 12, 22, 6, C.keyboard)
  r(c, x + TILE + 22, y + h - 11, 5, 4, C.keyboard)
  // 馬克杯
  r(c, x + 3 * TILE + 2, y + h - 13, 6, 7, C.cupWhite)
  r(c, x + 3 * TILE + 8, y + h - 11, 2, 3, C.cupWhite)
}

function drawChair(c: Ctx, tx: number, ty: number, faceUp = true) {
  const x = tx * TILE, y = ty * TILE
  r(c, x + 1, y + TILE - 4, TILE - 2, 4, C.shadow)
  // 靠背畫在遠離觀眾的一側
  if (faceUp) r(c, x + 2, y + TILE - 6, TILE - 4, 6, C.chair)
  else r(c, x + 2, y - 2, TILE - 4, 6, C.chair)
  r(c, x + 2, y + 2, TILE - 4, TILE - 6, C.chairLit)   // 椅面
  r(c, x + 2, y + 2, TILE - 4, 2, '#4e5a72')
  r(c, x + 4, y + TILE - 4, 3, 4, C.monFoot)           // 椅腳
  r(c, x + TILE - 7, y + TILE - 4, 3, 4, C.monFoot)
}

function drawMeetingRoom(c: Ctx) {
  // 玻璃隔間：直牆 x=22（門在 y7..8）
  for (let y = 3; y <= 12; y++) {
    if (y === 7 || y === 8) continue
    const py = y * TILE
    r(c, 22 * TILE + 4, py, 6, TILE, C.glassPane)
    r(c, 22 * TILE + 4, py, 2, TILE, C.glassWall)
  }
  // 橫牆 y=12（門在 x30..31）
  for (let x = 22; x <= 40; x++) {
    if (x === 30 || x === 31) continue
    const px = x * TILE
    r(c, px, 12 * TILE + 4, TILE, 6, C.glassPane)
    r(c, px, 12 * TILE + 4, TILE, 2, C.glassWall)
  }
  // 門框
  r(c, 22 * TILE + 2, 7 * TILE, 4, 4, C.glassWall)
  r(c, 22 * TILE + 2, 9 * TILE - 4, 4, 4, C.glassWall)
  r(c, 30 * TILE, 12 * TILE + 2, 4, 4, C.glassWall)
  r(c, 32 * TILE - 4, 12 * TILE + 2, 4, 4, C.glassWall)

  // 會議長桌
  const t = MEETING_TABLE
  const x = t.x * TILE, y = t.y * TILE, w = t.w * TILE, h = t.h * TILE
  r(c, x + 3, y + h - 5, w - 6, 7, C.shadow)
  r(c, x, y + 4, w, h - 8, C.meetTableEdge)
  r(c, x, y, w, h - 8, C.meetTable)
  r(c, x, y, w, 3, '#eef2f7')
  // 桌上：筆電、紙、投影幕光點
  for (let i = 0; i < 4; i++) {
    const lx = x + 16 + i * 36
    r(c, lx, y + 6, 18, 10, '#5b6675')
    r(c, lx + 1, y + 7, 16, 8, C.screenOn)
  }
  r(c, x + w - 40, y + h - 16, 14, 10, '#f2f5f8')
  // 白板（會議室後牆）
  r(c, 27 * TILE, 3 * TILE + 2, 7 * TILE, 3, C.boardFrame)
  r(c, 27 * TILE, 3 * TILE + 5, 7 * TILE, 10, C.board)
  for (let i = 0; i < 5; i++)
    r(c, 27 * TILE + 8 + i * 20, 3 * TILE + 8, 12 + (i % 3) * 4, 2, C.boardInk)
  // 牆掛大螢幕（會議室後牆，白板右邊）
  r(c, 35 * TILE, 3 * TILE + 1, 5 * TILE, 15, '#161a24')
  r(c, 35 * TILE + 2, 3 * TILE + 3, 5 * TILE - 4, 11, '#1d3a58')
  for (let i = 0; i < 4; i++)
    r(c, 35 * TILE + 6 + i * 18, 3 * TILE + 6, 12, 2, '#5aa2d8')
  r(c, 35 * TILE + 2, 3 * TILE + 3, 5 * TILE - 4, 2, '#2f7fb8')
  // 會議室座椅
  MEETING_SEATS.forEach((s) => drawChair(c, s.x, s.y, s.face === 'up'))
}

function drawSofa(c: Ctx) {
  const { x, y, w, h } = SOFA
  const px = x * TILE, py = y * TILE, pw = w * TILE, ph = h * TILE
  r(c, px + 4, py + ph - 2, pw - 8, 7, C.shadow)
  // 椅背（含上緣高光與縫線）
  r(c, px, py - 6, pw, 16, C.sofa)
  r(c, px, py - 6, pw, 3, C.sofaLit)
  for (let i = 1; i < w; i += 3) r(c, px + i * TILE, py - 4, 2, 12, '#734a30')
  // 扶手
  r(c, px, py - 8, 10, ph + 6, C.sofa)
  r(c, px, py - 8, 10, 4, C.sofaLit)
  r(c, px + pw - 10, py - 8, 10, ph + 6, C.sofa)
  r(c, px + pw - 10, py - 8, 10, 4, C.sofaLit)
  // 坐墊：三大塊
  const seatX = px + 10, seatW = pw - 20
  r(c, seatX, py + 10, seatW, ph - 8, C.sofaLit)
  for (let i = 1; i < 3; i++) r(c, seatX + Math.round(seatW * i / 3), py + 10, 2, ph - 8, C.sofa)
  r(c, seatX, py + 10, seatW, 2, '#b57c53')
  // 抱枕
  r(c, seatX + 6, py + 2, 14, 12, C.sofaCushion)
  r(c, seatX + 7, py + 3, 12, 3, '#e8c665')
  r(c, seatX + seatW - 20, py + 2, 14, 12, C.sofaCushion)
  r(c, seatX + seatW - 19, py + 3, 12, 3, '#e8c665')
}


function drawCoffeeTable(c: Ctx) {
  const px = 26 * TILE, py = 20 * TILE, pw = 5 * TILE, ph = 2 * TILE
  r(c, px + 3, py + ph - 5, pw - 6, 6, C.shadow)
  r(c, px, py + 3, pw, ph - 6, C.table)
  r(c, px, py, pw, ph - 8, C.tableTop)
  r(c, px, py, pw, 2, '#b98d5c')
  // 桌上：泡麵、零食、罐子
  r(c, px + 12, py + 3, 10, 9, '#e8e4dc')
  r(c, px + 13, py + 2, 8, 2, '#c2453f')
  r(c, px + 30, py + 5, 14, 7, '#d9a13a')
  r(c, px + 52, py + 3, 7, 10, '#4fa86a')
}

function drawCoffeeBar(c: Ctx) {
  const { x, y, w, h } = COFFEE_BAR
  const px = x * TILE, py = y * TILE, pw = w * TILE, ph = h * TILE
  r(c, px + 3, py + ph - 4, pw - 6, 6, C.shadow)
  r(c, px, py + 4, pw, ph - 6, C.machineDark)           // 吧台側
  r(c, px, py, pw, ph - 8, '#5f6b7a')                   // 檯面
  r(c, px, py, pw, 2, '#7b8797')
  // 咖啡機
  r(c, px + 10, py - 16, 22, 20, C.machine)
  r(c, px + 12, py - 14, 18, 8, C.machineDark)
  r(c, px + 14, py - 12, 6, 4, C.machineLamp)
  r(c, px + 16, py - 4, 10, 4, C.machineDark)
  // 杯子一排
  for (let i = 0; i < 3; i++) r(c, px + 42 + i * 9, py - 6, 6, 7, C.cupWhite)
}

function drawBookshelf(c: Ctx) {
  const { x, y, w, h } = BOOKSHELF
  const px = x * TILE, py = y * TILE, pw = w * TILE, ph = h * TILE
  r(c, px + 2, py + ph - 4, pw - 4, 6, C.shadow)
  r(c, px, py - 10, pw, ph + 8, C.shelfDark)
  r(c, px + 2, py - 8, pw - 4, ph + 4, C.shelf)
  const rand = mulberry32(1234)
  for (const shelfY of [py - 6, py + 10]) {
    r(c, px + 2, shelfY + 14, pw - 4, 2, C.shelfDark)
    let bx = px + 5
    while (bx < px + pw - 8) {
      const bw = 3 + Math.floor(rand() * 3)
      const bh = 9 + Math.floor(rand() * 4)
      r(c, bx, shelfY + 14 - bh, bw, bh, C.book[Math.floor(rand() * C.book.length)])
      bx += bw + 1
    }
  }
  // 閱讀單人沙發（正面朝下）
  const cx = READ_SPOT.x * TILE, cy = READ_SPOT.y * TILE
  r(c, cx - 8, cy + TILE - 3, TILE + 16, 5, C.shadow)
  r(c, cx - 8, cy - 6, TILE + 16, 12, '#5c4a6b')      // 靠背
  r(c, cx - 8, cy - 6, TILE + 16, 3, '#75608a')
  r(c, cx - 8, cy + 4, 7, TILE - 4, '#5c4a6b')        // 扶手
  r(c, cx + TILE + 1, cy + 4, 7, TILE - 4, '#5c4a6b')
  r(c, cx - 2, cy + 5, TILE + 4, TILE - 8, '#6f5a80') // 坐墊
  r(c, cx - 2, cy + 5, TILE + 4, 2, '#8570a0')
}

function drawPlanter(c: Ctx, tx: number, ty: number, big = false) {
  const px = tx * TILE, py = ty * TILE, s = 2 * TILE
  r(c, px + 3, py + s - 5, s - 6, 6, C.shadow)
  r(c, px + 3, py + s - 16, s - 6, 14, C.plantPotDark)
  r(c, px + 4, py + s - 17, s - 8, 5, C.plantPot)
  r(c, px + 6, py + s - 14, s - 12, 3, C.soil)
  // 葉子
  const rand = mulberry32(tx * 31 + ty)
  const n = big ? 9 : 6
  for (let i = 0; i < n; i++) {
    const lx = px + 6 + Math.floor(rand() * (s - 14))
    const ly = py + s - 20 - Math.floor(rand() * (big ? 20 : 13))
    const lw = 4 + Math.floor(rand() * 4)
    r(c, lx, ly, lw, 3, rand() > 0.6 ? C.leafLit : rand() > 0.3 ? C.leaf : C.leafDark)
    r(c, lx + 1, ly - 3, lw - 2, 3, C.leaf)
  }
  // 小花
  if (!big) {
    r(c, px + 10, py + s - 30, 3, 3, '#e8749b')
    r(c, px + 18, py + s - 26, 3, 3, '#f2c14e')
  }
}

function drawBoard(c: Ctx) {
  const { x, y, w } = BOARD
  const px = x * TILE, py = y * TILE, pw = w * TILE
  r(c, px + 6, py + TILE + 4, pw - 12, 4, C.shadow)
  // 立架雙腳
  r(c, px + 8, py + TILE - 2, 3, 8, C.machineDark)
  r(c, px + pw - 11, py + TILE - 2, 3, 8, C.machineDark)
  r(c, px + 8, py + TILE + 4, pw - 16, 2, C.machineDark)
  // 板框與板面
  r(c, px, py - 16, pw, TILE + 14, C.boardFrame)
  r(c, px + 3, py - 13, pw - 6, TILE + 8, C.board)
  r(c, px + 3, py - 13, pw - 6, 2, '#ffffff')
  // 板上內容：兩個流程方塊 + 箭頭 + 條列
  r(c, px + 9, py - 9, 18, 11, '#cfe0f0')
  r(c, px + 9, py - 9, 18, 2, '#8fb4d8')
  r(c, px + 37, py - 9, 18, 11, '#f0d8cf')
  r(c, px + 37, py - 9, 18, 2, '#d8a48f')
  r(c, px + 28, py - 4, 8, 2, C.boardInk)
  r(c, px + 33, py - 6, 2, 2, C.boardInk)
  r(c, px + 33, py - 2, 2, 2, C.boardInk)
  r(c, px + 9, py + 5, 44, 2, C.boardInk)
  r(c, px + 9, py + 9, 28, 2, C.boardInk)
  // 便利貼
  r(c, px + 60, py - 8, 8, 8, '#f2d14e')
  r(c, px + 60, py + 3, 8, 8, '#7fd48f')
  // 筆槽
  r(c, px + 3, py + TILE - 5, pw - 6, 4, C.boardFrame)
  r(c, px + 12, py + TILE - 4, 9, 2, '#c2453f')
  r(c, px + 24, py + TILE - 4, 9, 2, '#3f7fc2')
}


function drawCooler(c: Ctx) {
  const px = COOLER.x * TILE, py = COOLER.y * TILE
  r(c, px + 2, py + 2 * TILE - 4, TILE - 2, 5, C.shadow)
  r(c, px + 2, py + 10, TILE - 3, 2 * TILE - 12, '#cfd8e0')   // 機身
  r(c, px + 2, py + 10, 3, 2 * TILE - 12, '#e8eef4')
  r(c, px + 5, py - 8, 9, 18, '#7fc7e8')                       // 水桶
  r(c, px + 5, py - 8, 9, 3, '#a8dcf2')
  r(c, px + 6, py + 22, 6, 4, '#4a5568')                       // 出水口
  r(c, px + 4, py + 30, 4, 5, C.cupWhite)                      // 紙杯
}


function drawBoxes(c: Ctx) {
  const px = BOXES.x * TILE, py = BOXES.y * TILE
  r(c, px + 2, py + 2 * TILE - 5, 2 * TILE - 4, 6, C.shadow)
  // 下層兩箱
  r(c, px + 1, py + 14, 15, 16, '#a8814f')
  r(c, px + 1, py + 14, 15, 3, '#c19a63')
  r(c, px + 17, py + 16, 14, 14, '#9a7546')
  r(c, px + 17, py + 16, 14, 3, '#b38b57')
  // 上層一箱（歪斜堆疊感）
  r(c, px + 6, py + 2, 16, 13, '#b38b57')
  r(c, px + 6, py + 2, 16, 3, '#cba36a')
  // 封箱膠帶
  r(c, px + 12, py + 2, 3, 13, '#d8c9a8')
  r(c, px + 7, py + 20, 3, 10, '#d8c9a8')
}


function drawToiletDoor(c: Ctx) {
  const { x, y, w } = TOILET_DOOR
  const px = x * TILE, py = y * TILE, pw = w * TILE
  r(c, px - 3, py - 6, pw + 6, TILE + 6, C.doorFrame)
  r(c, px, py - 3, pw, TILE + 3, C.door)
  r(c, px + 4, py + 1, pw - 8, 10, '#2c3547')
  // 門牌
  r(c, px + (pw >> 1) - 7, py - 12, 14, 9, '#e8eef4')
  r(c, px + (pw >> 1) - 4, py - 10, 3, 5, C.doorSign)
  r(c, px + (pw >> 1) + 1, py - 10, 3, 5, '#e879a9')
  // 門把
  r(c, px + pw - 8, py + 6, 3, 3, '#d8c48a')
}

// ── 光暈疊層（畫在家具之上，讓夜間氣氛出來）────────
function drawLightPools(c: Ctx) {
  const pools: [number, number, number, string][] = [
    [7.5, 3, 130, 'rgba(255,214,150,0.16)'],
    [16.5, 3, 130, 'rgba(255,214,150,0.16)'],
    [32.5, 3, 140, 'rgba(255,214,150,0.14)'],
    [37.5, 16, 90, 'rgba(255,183,77,0.16)'],
    [28, 19, 130, 'rgba(255,190,120,0.13)'],
    [31, 7, 150, 'rgba(120,190,255,0.10)'],
    [14, 17, 100, 'rgba(255,214,150,0.10)'],
    [8, 21, 110, 'rgba(255,214,150,0.08)'],
  ]
  for (const [tx, ty, rad, col] of pools) {
    const g = c.createRadialGradient(tx * TILE, ty * TILE, 0, tx * TILE, ty * TILE, rad)
    g.addColorStop(0, col)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = g
    c.fillRect(tx * TILE - rad, ty * TILE - rad, rad * 2, rad * 2)
  }
  // 整體夜間壓暗
  c.fillStyle = 'rgba(10,14,30,0.16)'
  c.fillRect(0, 0, BASE_W, BASE_H)
}

/** 建靜態底圖（地板 + 牆 + 家具），只畫一次然後重複使用 */
export function buildStaticLayer(): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = BASE_W
  cv.height = BASE_H
  const c = cv.getContext('2d')!
  c.imageSmoothingEnabled = false

  drawFloor(c)
  drawWalls(c)
  DESKS.forEach((d) => { drawChair(c, d.seat.x, d.seat.y); drawDesk(c, d.x, d.y) })
  drawMeetingRoom(c)
  drawSofa(c)
  drawCoffeeTable(c)
  drawCoffeeBar(c)
  drawBookshelf(c)
  PLANTERS.forEach((p) => drawPlanter(c, p.x, p.y))
  POTTED.forEach((p) => drawPlanter(c, p.x, p.y, true))
  drawBoard(c)
  drawCooler(c)
  drawBoxes(c)
  drawToiletDoor(c)
  drawLightPools(c)
  return cv
}

/** 每張桌子的螢幕矩形（動態層畫閃爍用），單位 px */
export function screenRect(d: { x: number; y: number }) {
  return { x: d.x * TILE + TILE - 4, y: d.y * TILE - 12, w: 28, h: 9 }
}
