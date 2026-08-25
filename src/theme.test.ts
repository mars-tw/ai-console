// 可讀性換算的測試
//
// 這一份守的是一個承諾：readable() 回傳的顏色，在對應主題最差的那塊底色上
// 一定過得了 WCAG AA 的 4.5:1。
//
// 為什麼需要測：上一版是「亮色主題下每個通道乘 0.62」——那是猜的不是解的。
// 實測（把程式跑起來、在瀏覽器裡量的）#4ade80 壓完只有 4.32、
// #fbbf24 只有 4.19，兩個都還在門檻底下；而深色主題完全不作用。
// 畫面上不會有任何徵兆，只是那幾個字比較難看清楚而已 —— 只能靠測試守住。
import { describe, expect, it } from 'vitest'
import { MIN_CONTRAST, readable } from './theme'

/** 跟 theme.ts 裡同一組基準底色：各主題裡對比最差的那一塊 */
const LIGHT_SURFACE = [228, 228, 231]
const DARK_SURFACE = [39, 39, 42]

function relLum(rgb: number[]): number {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

function contrast(hex: string, bg: number[]): number {
  const v = parseInt(hex.slice(1), 16)
  const l1 = relLum([(v >> 16) & 255, (v >> 8) & 255, v & 255])
  const l2 = relLum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/** 這個 app 裡真的用到的資料驅動色：技能線、夥伴定位、裝備稀有度 */
const PALETTE = [
  '#f87171', '#4ade80', '#60a5fa', '#fbbf24',   // LINE_COLOR
  '#60a5fa', '#f87171', '#4ade80', '#fbbf24',   // ALLY_ROLE_COLOR
  '#9ca3af', '#e5e7eb', '#4ade80', '#60a5fa', '#fbbf24',   // RARITY_COLOR
]

describe('readable：資料驅動的顏色要在兩種主題都讀得清楚', () => {
  it('亮色主題下每一個顏色都過 AA', () => {
    for (const hex of PALETTE) {
      const got = readable(hex, false)
      expect(contrast(got, LIGHT_SURFACE),
        `${hex} → ${got}`).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
  })

  it('深色主題下每一個顏色都過 AA', () => {
    for (const hex of PALETTE) {
      const got = readable(hex, true)
      expect(contrast(got, DARK_SURFACE),
        `${hex} → ${got}`).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
  })

  it('本來就夠清楚的顏色原封不動', () => {
    // 顏色本身是資訊（職業、稀有度靠它區分），沒必要就不要動它
    expect(readable('#0b3d1e', false)).toBe('#0b3d1e')
    expect(readable('#e5e7eb', true)).toBe('#e5e7eb')
  })

  it('不是六位十六進位就原樣回傳，不要自作聰明', () => {
    for (const bad of ['', 'red', 'var(--x)', '#fff', 'rgb(1,2,3)']) {
      expect(readable(bad, false)).toBe(bad)
    }
  })

  it('只調到剛好過門檻，不會一路壓成黑或白', () => {
    // 全壓黑的話四種職業色會變成同一個顏色，等於把分類資訊刪掉
    const outs = PALETTE.map((h) => readable(h, false))
    expect(new Set(outs).size).toBeGreaterThan(3)
    for (const hex of outs) {
      expect(hex).not.toBe('#000000')
      expect(hex).not.toBe('#ffffff')
    }
  })

  it('壓過之後仍看得出是原本那個色相', () => {
    // 綠的壓完還是綠的：綠通道要仍然是最大的那個
    const g = readable('#4ade80', false)
    const v = parseInt(g.slice(1), 16)
    const [r, gg, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    expect(gg).toBeGreaterThan(r)
    expect(gg).toBeGreaterThan(b)
  })

  it('可以要求更高的門檻', () => {
    const strict = readable('#4ade80', false, 7)
    expect(contrast(strict, LIGHT_SURFACE)).toBeGreaterThanOrEqual(7)
  })
})
