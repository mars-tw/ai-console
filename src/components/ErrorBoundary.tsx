// 錯誤邊界：一個元件炸掉不要拖垮整頁
//
// 在這之前，任何 render 期間的例外都會讓 React 卸載整棵樹 ——
// 使用者看到的是一片白，沒有訊息、沒有線索，也不知道要回報什麼。
// 這個專案的資料來源是掃描出來的（各家 AI 工具的紀錄格式各不相同，
// 而且會隨著它們改版而變），所以「某一筆資料形狀跟預期不一樣」是遲早的事，
// 不是假想的情況。
//
// 錯誤邊界目前只有 class 元件寫得出來，React 19 也還沒有 hook 版本。

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@/i18n'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  stack: string
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 留在 console 給開發時看。不往外送 —— 這個專案的原則是資料不出本機，
    // 錯誤報告裡常常夾著檔案路徑與對話標題，那正是不該外流的東西。
    console.error('[ErrorBoundary]', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? '' })
  }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-200">
        <div className="w-full max-w-2xl rounded border border-red-900/60 bg-zinc-900 p-5">
          <div className="mb-2 text-sm font-medium text-red-300">
            {t('這個畫面出錯了')}
          </div>
          <p className="mb-3 text-xs leading-relaxed text-zinc-400">
            {t('資料還在，沒有東西被刪掉。重新整理通常就好；如果每次都出錯，把下面這段訊息記下來。')}
          </p>
          <pre className="max-h-56 overflow-auto rounded bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-400">
            {error.message}
            {stack && `\n${stack.trim().split('\n').slice(0, 8).join('\n')}`}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              className="rounded bg-zinc-100 px-3 py-1 text-xs text-zinc-900 hover:bg-white"
              onClick={() => location.reload()}
            >
              {t('重新整理')}
            </button>
            <button
              className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              onClick={() => this.setState({ error: null, stack: '' })}
            >
              {t('試著繼續')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
