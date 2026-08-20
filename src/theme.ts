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
  const v = localStorage.getItem(KEY)
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system'
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

/**
 * 把「為深底挑的顏色」調整成在目前主題下讀得清楚。
 *
 * 角色定位徽章、技能線標題、稀有度這些是資料驅動的十六進位色（不是 class），
 * 全部是照深底挑的亮色調。放到白底上會糊成一片，所以亮色主題下壓暗一階。
 * 用計算而不是維護兩份色票 —— 兩份一定會有一份忘記更新。
 */
export function readable(hex: string, dark: boolean): string {
  if (dark || !/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const v = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c * 0.62)
  return '#' + [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    .map((c) => mix(c).toString(16).padStart(2, '0')).join('')
}

/** 元件裡直接用：主題一換就會重繪 */
export function useReadable(): (hex: string) => string {
  const t = useTheme()
  const dark = t === 'dark' || (t === 'system' && systemPrefersDark())
  return (hex: string) => readable(hex, dark)
}
