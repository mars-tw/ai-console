// 語言切換：繁體中文 ↔ English
//
// 放在分頁列最右邊，因為它是「整個應用」的設定，不屬於任何一個分頁。

import { LANGS, setLang, useLang } from '@/i18n'

export default function LangSwitch() {
  const lang = useLang()
  return (
    <div className="ml-auto flex items-center gap-0.5 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
      {LANGS.map((l) => (
        <button
          key={l.id}
          onClick={() => setLang(l.id)}
          className={`rounded px-2 py-0.5 text-[11px] ${
            lang === l.id
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}
