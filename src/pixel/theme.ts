// 像素辦公室：共用尺寸與配色
// 夜間辦公室色調，配合窗外城市燈景與室內暖光

export const TILE = 16
export const COLS = 42
export const ROWS = 28          // 42×28 = 672×448，正好 3:2，對上生圖比例
export const BASE_W = COLS * TILE // 672
export const BASE_H = ROWS * TILE // 448

export const C = {
  // 牆與地
  wallFace: '#1a2133',
  wallFaceLit: '#232c42',
  wallTop: '#0e1220',
  wallTrim: '#2d3850',
  skirting: '#141a28',
  floorA: '#7b5738',
  floorB: '#6e4c30',
  floorSeam: '#583d27',
  floorSheen: '#8a6340',

  // 窗與夜景
  glass: '#0d1730',
  glassLit: '#16244a',
  sash: '#10151f',
  tower: '#151f3c',
  towerFar: '#111931',
  litWarm: '#ffd489',
  litCool: '#8fd0ff',
  litRed: '#ff6b6b',

  // 家具
  deskTop: '#a87b4e',
  deskEdge: '#835c38',
  deskLeg: '#5f432a',
  monBody: '#22252d',
  monFoot: '#1a1d24',
  screenOff: '#141c2b',
  screenOn: '#1d4a78',
  screenHot: '#2f7fb8',
  keyboard: '#2b2f38',
  chair: '#333a4a',
  chairLit: '#414a5e',

  // 會議室
  glassWall: '#4e6a86',
  glassPane: '#22344d',
  meetTable: '#cbd5e1',
  meetTableEdge: '#94a3b8',
  meetRug: '#274450',

  // 休息區
  rug: '#7d3038',
  rugAlt: '#8e3b43',
  rugTrim: '#c99b4a',
  sofa: '#8a5a3c',
  sofaLit: '#a06c48',
  sofaCushion: '#d8b04c',
  table: '#8a6340',
  tableTop: '#a07a4e',

  // 雜項
  plantPot: '#a9603c',
  plantPotDark: '#8b4c2f',
  leaf: '#3f9a52',
  leafDark: '#2f7a3f',
  leafLit: '#57b96a',
  soil: '#4a3524',
  shelf: '#6b4a2f',
  shelfDark: '#523821',
  book: ['#c2453f', '#3f7fc2', '#d9a13a', '#4fa86a', '#8f5fc2', '#c96a3a'],
  board: '#e9eef4',
  boardFrame: '#aab4c2',
  boardInk: '#3b4758',
  machine: '#39404e',
  machineDark: '#272d38',
  machineLamp: '#ffb74d',
  doorFrame: '#4a5568',
  door: '#39435a',
  doorSign: '#7fd4e8',
  cupWhite: '#e8eef4',

  // 光暈
  lampPool: 'rgba(255, 208, 130, 0.10)',
  screenPool: 'rgba(90, 170, 255, 0.10)',
  shadow: 'rgba(0,0,0,0.30)',
} as const

/** 固定種子亂數：場景每次重載長得一樣 */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
