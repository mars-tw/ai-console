// 介面語言：繁體中文（預設）／English
//
// 這裡刻意用「中文原文當 key」而不是 t('nav.office') 這種鍵名，理由有三個：
//   1. 這個專案是先寫成中文再國際化的，發明 350 個鍵名只會讓程式碼變難讀
//   2. 漏翻的字串會原樣顯示中文，而不是顯示 "nav.office" 這種除錯殘骸
//   3. 之後要加語言，只要再補一份對照表，不用動任何呼叫端
//
// 帶變數的句子用 {name} 佔位，例如：
//   t('{a} 攻擊 {b}，造成 {n} 傷害', { a: '你', b: '哥布林', n: 12 })

import { useSyncExternalStore } from 'react'
import { EN } from './en'

export type Lang = 'zh-TW' | 'en'
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
]

const KEY = 'ai-console.lang'

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'zh-TW') return saved
  } catch { /* 無痕模式讀不到 localStorage，用預設值即可 */ }
  // 預設繁體中文；只有在瀏覽器完全沒有中文偏好時才給英文
  const langs = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : []
  return langs.some((l) => l && l.toLowerCase().startsWith('zh')) || langs.length === 0
    ? 'zh-TW'
    : 'en'
}

let current: Lang = initial()
const listeners = new Set<() => void>()

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang) {
  if (lang === current) return
  current = lang
  try { localStorage.setItem(KEY, lang) } catch { /* 存不了就算了，這一輪還是會生效 */ }
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant'
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 元件用：語言變了會重繪 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}

/**
 * 翻譯。zh 就是原文本身，所以中文永遠不會漏字；
 * 英文查不到對照時退回中文，寧可顯示看得懂的中文也不要顯示空白。
 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  let s = current === 'en' ? (EN[zh] ?? zh) : zh
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}

/** 開發用：列出還沒翻譯的字串（production 會被摺掉）*/
export function missingTranslations(all: string[]): string[] {
  return all.filter((s) => !(s in EN))
}
