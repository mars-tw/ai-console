// 角色精靈：優先用 AI 產出的動作總表（sprite sheet），沒有就用程式繪製的備援龍
//
// 總表格位順序（pack_sprites.py 產出，4 欄 × 3 列）：
//   0 front-stand  1 front-step  2 back-stand  3 back-step
//   4 side-stand   5 side-step   6 sit-typing  7 sleeping
//   8 arguing      9 coffee     10 reading    11 watering

export const CELL = 48           // 引擎格尺寸（像素）
export const FOOT_Y = 46         // 腳底在格內的 y
export const SHEET_COLS = 4
export const SHEET_ROWS = 3
export const FRAME_COUNT = SHEET_COLS * SHEET_ROWS

export const F = {
  frontStand: 0, frontStep: 1, backStand: 2, backStep: 3,
  sideStand: 4, sideStep: 5, sitType: 6, sleep: 7,
  argue: 8, coffee: 9, read: 10, water: 11,
} as const

export interface DragonSkin {
  name: string
  color: string        // 品牌色（名牌、光暈）
  scale: string        // 鱗片主色
  scaleDark: string
  belly: string
  cloth: string        // 衣服
  clothDark: string
  horn: string
  silly?: boolean      // 傻龍：大眼、流口水、不穿衣服
}

export const SKINS: Record<string, DragonSkin> = {
  kimi: { name: 'KIMI', color: '#2563EB', scale: '#3b6fd4', scaleDark: '#26489b', belly: '#9dc0f5', cloth: '#f4f7fb', clothDark: '#1e2b4a', horn: '#dfe7f5' },
  claude: { name: 'CLAUDE', color: '#D97757', scale: '#d97757', scaleDark: '#a4523a', belly: '#f5c9ae', cloth: '#e8dcc8', clothDark: '#b5643f', horn: '#f2e0d0' },
  codex: { name: 'CODEX', color: '#10A37F', scale: '#2fa583', scaleDark: '#1c7259', belly: '#a8e5cf', cloth: '#1f4f3f', clothDark: '#143528', horn: '#d8f0e6' },
  grok: { name: 'GROK', color: '#1D9BF0', scale: '#39aef5', scaleDark: '#1c73ac', belly: '#b6e3ff', cloth: '#22262e', clothDark: '#14171c', horn: '#e0f2ff' },
  qwen: { name: 'QWEN', color: '#615CED', scale: '#7a72e8', scaleDark: '#4f49a8', belly: '#cdc9f7', cloth: '#c9c2f0', clothDark: '#6b64b8', horn: '#e8e5fa' },
  cursor: { name: 'CURSOR', color: '#F59E0B', scale: '#e8a53a', scaleDark: '#b57a20', belly: '#f7dfae', cloth: '#8b93a1', clothDark: '#5d646f', horn: '#f7ecd2' },
  gemini: { name: 'ANTIGRAVITY', color: '#FBBF24', scale: '#f5c928', scaleDark: '#c99a12', belly: '#fbe9a0', cloth: '#f5c928', clothDark: '#c99a12', horn: '#fdf0c0', silly: true },
}

export const AGENT_KEYS = Object.keys(SKINS)

// ── Sheet 載入 ────────────────────────────────────
const sheets = new Map<string, HTMLImageElement>()
const sheetReady = new Set<string>()

export function loadSheets(onDone?: () => void) {
  let pending = AGENT_KEYS.length
  const tick = () => { if (--pending === 0) onDone?.() }
  for (const key of AGENT_KEYS) {
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth >= CELL * SHEET_COLS) {
        sheets.set(key, img)
        sheetReady.add(key)
      }
      tick()
    }
    img.onerror = tick
    img.src = `/office/sprites/${key}.png`
  }
}

export const hasSheet = (key: string) => sheetReady.has(key)

// ── 程式繪製備援龍 ─────────────────────────────────
// 沒有 AI 圖時仍然要能動：畫一隻 chibi 小龍，四向 + 各種姿勢
const FALLBACK_CELL = 40      // 備援龍以 40 單位繪製，再等比放大到 CELL
const FALLBACK_FOOT = 38
const fallbackCache = new Map<string, HTMLCanvasElement>()

function drawFallback(key: string, frame: number): HTMLCanvasElement {
  const cacheKey = `${key}:${frame}`
  const hit = fallbackCache.get(cacheKey)
  if (hit) return hit

  const cv = document.createElement('canvas')
  cv.width = FALLBACK_CELL
  cv.height = FALLBACK_CELL
  const c = cv.getContext('2d')!
  const s = SKINS[key] || SKINS.kimi
  const r = (x: number, y: number, w: number, h: number, col: string) => {
    c.fillStyle = col
    c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
  }

  const cx = FALLBACK_CELL / 2
  const lying = frame === F.sleep
  const sitting = frame === F.sitType
  const back = frame === F.backStand || frame === F.backStep
  const side = frame === F.sideStand || frame === F.sideStep
  const stepping = frame === F.frontStep || frame === F.backStep || frame === F.sideStep

  if (lying) {
    // 側躺：身體橫躺，頭在左
    const by = FALLBACK_FOOT - 10
    r(cx - 14, by, 26, 10, s.scale)
    r(cx - 14, by + 7, 26, 3, s.scaleDark)
    r(cx + 8, by + 2, 8, 5, s.scaleDark)          // 尾巴
    r(cx - 19, by - 5, 12, 12, s.scale)           // 頭
    r(cx - 19, by + 3, 12, 4, s.scaleDark)
    r(cx - 17, by - 8, 3, 4, s.horn)              // 角
    r(cx - 12, by - 8, 3, 4, s.horn)
    r(cx - 16, by - 1, 5, 2, '#1b1f2a')           // 閉眼
    r(cx - 6, by + 1, 12, 6, s.belly)
    fallbackCache.set(cacheKey, cv)
    return cv
  }

  const headH = 15
  const bodyH = sitting ? 10 : 13
  const bodyY = FALLBACK_FOOT - (sitting ? 12 : 16)
  const headY = bodyY - headH + 2

  // 尾巴（背面與側面看得到）
  if (back) r(cx + 8, bodyY + 4, 7, 4, s.scaleDark)
  if (side) r(cx - 15, bodyY + 4, 8, 4, s.scaleDark)

  // 翅膀
  r(cx - 13, bodyY + 1, 5, 7, s.scaleDark)
  r(cx + 8, bodyY + 1, 5, 7, s.scaleDark)

  // 身體
  r(cx - 8, bodyY, 16, bodyH, s.scale)
  r(cx - 8, bodyY + bodyH - 3, 16, 3, s.scaleDark)
  if (!back) {
    if (s.silly) r(cx - 5, bodyY + 2, 10, bodyH - 4, s.belly)
    else {
      r(cx - 8, bodyY, 16, bodyH - 2, s.cloth)          // 衣服
      r(cx - 8, bodyY, 16, 3, s.clothDark)
      r(cx - 2, bodyY + 2, 4, bodyH - 5, s.clothDark)   // 領口
    }
  } else {
    r(cx - 8, bodyY, 16, bodyH - 2, s.silly ? s.scale : s.cloth)
  }

  // 腿（走路時左右錯開）
  const off = stepping ? 3 : 0
  if (!sitting) {
    r(cx - 6, FALLBACK_FOOT - 5 + (stepping ? 0 : 0), 5, 5, s.scaleDark)
    r(cx + 1, FALLBACK_FOOT - 5, 5, 5, s.scaleDark)
    if (stepping) {
      r(cx - 8 - off, FALLBACK_FOOT - 5, 5, 5, s.scale)
      r(cx + 3 + off, FALLBACK_FOOT - 4, 5, 4, s.scaleDark)
    }
  } else {
    r(cx - 7, FALLBACK_FOOT - 6, 14, 6, '#333a4a')       // 椅子
  }

  // 頭
  r(cx - 9, headY, 18, headH, s.scale)
  r(cx - 9, headY + headH - 3, 18, 3, s.scaleDark)
  r(cx - 7, headY - 4, 4, 5, s.horn)              // 角
  r(cx + 3, headY - 4, 4, 5, s.horn)

  if (!back) {
    // 吻部
    r(cx - 4, headY + 8, 8, 5, s.belly)
    if (s.silly) {
      // 傻龍：超大眼 + 口水
      r(cx - 8, headY + 2, 7, 7, '#ffffff')
      r(cx + 1, headY + 2, 7, 7, '#ffffff')
      r(cx - 6, headY + 4, 4, 4, '#1b1f2a')
      r(cx + 3, headY + 4, 4, 4, '#1b1f2a')
      r(cx - 3, headY + 12, 6, 3, '#3b2430')       // 張嘴
      r(cx - 2, headY + 14, 2, 4, '#7dd3fc')       // 口水
    } else {
      r(cx - 6, headY + 4, 4, 3, '#ffffff')
      r(cx + 2, headY + 4, 4, 3, '#ffffff')
      r(cx - 5, headY + 5, 2, 2, '#1b1f2a')
      r(cx + 3, headY + 5, 2, 2, '#1b1f2a')
      if (frame === F.argue) r(cx - 3, headY + 11, 6, 3, '#3b2430')
    }
  }

  // 道具
  if (frame === F.coffee) { r(cx + 9, bodyY + 4, 6, 7, '#e8eef4'); r(cx + 15, bodyY + 6, 2, 3, '#e8eef4') }
  if (frame === F.read) { r(cx - 9, bodyY + 5, 18, 8, '#f2f5f8'); r(cx - 1, bodyY + 5, 2, 8, '#b8c2cc') }
  if (frame === F.water) { r(cx + 8, bodyY + 5, 8, 6, '#7fb8d4'); r(cx + 16, bodyY + 4, 4, 2, '#7fb8d4') }
  if (frame === F.argue) { r(cx + 9, bodyY + 2, 8, 3, s.scale) }
  if (frame === F.sitType) { r(cx - 8, bodyY + bodyH - 1, 16, 3, '#2b2f38') }

  fallbackCache.set(cacheKey, cv)
  return cv
}

// ── 對外繪製 ───────────────────────────────────────
/**
 * 把角色畫到畫布上。(px, py) 是「腳底中心」的像素座標。
 * flip=true 時水平鏡射（側面走路的左向、以及走路循環的另一半步伐）。
 */
export function drawAgent(
  c: CanvasRenderingContext2D,
  key: string,
  frame: number,
  px: number,
  py: number,
  flip = false,
  alpha = 1,
) {
  const sheet = sheets.get(key)
  const dx = Math.round(px - CELL / 2)
  const dy = Math.round(py - FOOT_Y)
  c.save()
  if (alpha < 1) c.globalAlpha = alpha
  if (flip) {
    c.translate(dx + CELL, dy)
    c.scale(-1, 1)
  } else {
    c.translate(dx, dy)
  }
  if (sheet) {
    const sx = (frame % SHEET_COLS) * CELL
    const sy = Math.floor(frame / SHEET_COLS) * CELL
    c.drawImage(sheet, sx, sy, CELL, CELL, 0, 0, CELL, CELL)
  } else {
    c.drawImage(drawFallback(key, frame), 0, 0, FALLBACK_CELL, FALLBACK_CELL, 0, 0, CELL, CELL)
  }
  c.restore()
}
