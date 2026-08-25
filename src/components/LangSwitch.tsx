// 語言與主題切換
//
// 放在分頁列最右邊，因為它們是「整個應用」的設定，不屬於任何一個分頁。
//
// 這裡不再寫 dark: 配對：顏色改用語意色（ink / invink / mute…），
// 兩個主題各自的實際值定義在 index.css，元件只講「這是主色還是次要色」。

import { LANGS, setLang, t, useLang } from '@/i18n'
import { setTheme, useTheme, type Theme } from '@/theme'

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'system', label: '🖥️', hint: '跟隨系統' },
  { id: 'dark', label: '🌙', hint: '黑色' },
  { id: 'light', label: '☀️', hint: '亮色' },
]

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
      {children}
    </div>
  )
}

export default function LangSwitch() {
  const lang = useLang()
  const theme = useTheme()
  const pill = (on: boolean) =>
    `rounded px-2 py-1 text-[11px] ${on ? 'bg-ink text-invink' : 'text-mute2 hover:bg-elev'}`

  return (
    <div className="ml-auto flex items-center gap-1.5">
      <Group>
        {THEMES.map((x) => (
          <button
            key={x.id}
            onClick={() => setTheme(x.id)}
            title={t(x.hint)}
            aria-pressed={theme === x.id}
            className={pill(theme === x.id)}
          >
            {x.label}
          </button>
        ))}
      </Group>
      <Group>
        {LANGS.map((l) => (
          <button
            key={l.id}
            onClick={() => setLang(l.id)}
            aria-pressed={lang === l.id}
            className={pill(lang === l.id)}
          >
            {l.label}
          </button>
        ))}
      </Group>
    </div>
  )
}
