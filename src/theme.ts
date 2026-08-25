// 主題：黑色 / 亮色 / 跟隨系統
//
// Tailwind 設定的是 class 模式的深色（darkMode: ["class"]），但在這之前
// **全專案沒有任何地方加上那個 class** —— 所以 83 個 dark: 變體從來沒生效過。
// 對話頁因此一直是白的，而其他三個分頁是寫死的深色，看起來像兩個 app。
//
// 深色是這個 app 的本體（像素辦公室、戰鬥畫面都是深底），所以預設跟隨系統、
// 系統沒表態時走深色。

import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light' | 'system'

const KEY = 'ac_theme'
const listeners = new Set<() => void>()

function read(): Theme {
  // 這一行在模組載入時就會跑。沒有防護的話，只要 localStorage 讀不到
  //（無痕模式、被封鎖第三方儲存、或任何非瀏覽器環境）就是模組層級的例外，
  // 整個 app 白畫面 —— 而使用者只是想選一個佈景主題。
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

let current: Theme = read()

/** 系統偏好。沒有 matchMedia（很舊的環境）就當作深色 */
function systemPrefersDark(): boolean {
  try {
    return !window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return true
  }
}

function apply(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && systemPrefersDark())
  document.documentElement.classList.toggle('dark', dark)
  // 讓瀏覽器把捲軸、表單元件也一起換色，不然亮色主題下捲軸還是黑的
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function setTheme(t: Theme) {
  current = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* 存不了不影響當下這一次切換 */
  }
  apply(t)
  listeners.forEach((f) => f())
}

/** 在 React 掛載之前就套用，避免先閃一下白畫面 */
export function initTheme() {
  apply(current)
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (current === 'system') {
        apply(current)
        listeners.forEach((f) => f())
      }
    })
  } catch {
    /* 沒有 matchMedia 就不跟隨系統，使用者還是可以手動選 */
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    () => current,
    () => 'system' as Theme,
  )
}

/** sRGB 相對亮度（WCAG 2.x 的定義） */
function relLum(rgb: number[]): number {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

function contrast(a: number[], b: number[]): number {
  const l1 = relLum(a), l2 = relLum(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/**
 * 判定基準取「同一個主題裡對比最差的那塊底色」，不是最常見的那塊。
 * 亮色是 --c-elev2（最深的一塊），深色是 --c-elev（最亮的一塊）。
 * 拿平均值或最常見值來調，換個面板就又不合格了。
 */
const LIGHT_SURFACE = [228, 228, 231]
const DARK_SURFACE = [39, 39, 42]
/** WCAG AA 的一般文字門檻 */
export const MIN_CONTRAST = 4.5

/**
 * 把「為深底挑的顏色」調整成在目前主題下讀得清楚。
 *
 * 角色定位徽章、技能線標題、稀有度這些是資料驅動的十六進位色（不是 class），
 * 全部是照深底挑的亮色調。放到白底上會糊成一片。
 * 用計算而不是維護兩份色票 —— 兩份一定會有一份忘記更新。
 *
 * 為什麼不是固定乘一個係數：
 *   上一版是「亮色主題下每個通道乘 0.62」。那是猜的，不是解出來的 ——
 *   實測 #4ade80（治療／遠程）壓完只有 4.32、#fbbf24（信仰／輔助）4.19，
 *   兩個都還在 AA 的 4.5 底下。固定係數對深色也完全不作用，
 *   於是深底上偏暗的顏色一樣沒人管。
 *
 * 現在改成二分找「剛好跨過門檻」的那一點：往安全的方向（亮色壓暗、
 * 深色提亮）混，一過門檻就停。不一路壓到黑是因為顏色本身也是資訊 ——
 * 職業、稀有度、定位都靠它區分，壓成一團黑等於把那個資訊刪掉。
 */
export function readable(hex: string, dark: boolean, min: number = MIN_CONTRAST): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const v = parseInt(hex.slice(1), 16)
  const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  const bg = dark ? DARK_SURFACE : LIGHT_SURFACE
  if (contrast(rgb, bg) >= min) return hex

  // 深色主題往白色混、亮色主題往黑色混：兩邊都是「離底色更遠」的方向
  const target = dark ? 255 : 0
  const mixed = (k: number) => rgb.map((c) => Math.round(c + (target - c) * k))
  let lo = 0, hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (contrast(mixed(mid), bg) >= min) hi = mid
    else lo = mid
  }
  return '#' + mixed(hi).map((c) => c.toString(16).padStart(2, '0')).join('')
}

/** 元件裡直接用：主題一換就會重繪 */
export function useReadable(): (hex: string) => string {
  const t = useTheme()
  const dark = t === 'dark' || (t === 'system' && systemPrefersDark())
  return (hex: string) => readable(hex, dark)
}
