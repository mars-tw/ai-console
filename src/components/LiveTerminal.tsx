// 互動終端：真的握著一條活的連線，不是每 8 秒去 tail log
//
// 它做得到的：在同一個工作目錄開一條可以打字的 CLI，接手往下做。
//
// 它**做不到**的，講清楚免得又變成「介面承諾了程式做不到的事」：
//   這條終端是**新的行程**，不會接到已經在跑的那個派工。
//   無頭派工是用 stdin=DEVNULL 啟動的，那個行程從誕生起就沒有標準輸入，
//   任何人（包括這裡）都插不進去 —— 那是作業系統層級的事實，不是實作偷懶。
//   要對進行中的工作補話，只能用「💬 補一句」（各家 CLI 的續談旗標再派一次）。
//
// 只在桌面版有（Electron 才有 node-pty）。瀏覽器開發模式會拿不到 window.acPty，
// 這時候要明白講出來，不要給一個永遠不會亮的空框。
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { t, useLang } from '@/i18n'
import { useTheme } from '@/theme'

interface Props {
  /** session 識別碼。同一個 id 重新掛上會把先前的輸出回放出來 */
  id: string
  tool: string
  /** 執行檔路徑，由後端 /api/bins 給。shell 不需要 */
  bin?: string
  cwd?: string
  onClose?: () => void
}

/** preload 暴露的介面。桌面版才有。 */
interface PtyApi {
  available: () => Promise<boolean>
  open: (o: Record<string, unknown>) => Promise<{ id?: string; error?: string }>
  write: (id: string, data: string) => Promise<boolean>
  resize: (id: string, cols: number, rows: number) => Promise<boolean>
  close: (id: string) => Promise<boolean>
  backlog: (id: string) => Promise<string>
  onData: (id: string, fn: (chunk: string) => void) => () => void
  onExit: (id: string, fn: (code: number) => void) => () => void
}

const ptyApi = (): PtyApi | null =>
  (window as unknown as { acPty?: PtyApi }).acPty ?? null

/** xterm 的配色跟著介面主題走，不然深色介面配白底終端會刺眼 */
function themeOf(dark: boolean) {
  return dark
    ? { background: '#0b0d12', foreground: '#d4d8e0', cursor: '#7dd3fc',
        selectionBackground: '#26334d', black: '#11141b', brightBlack: '#4b5563' }
    : { background: '#ffffff', foreground: '#1f2430', cursor: '#0369a1',
        selectionBackground: '#cfe4f7', black: '#1f2430', brightBlack: '#6b7280' }
}

export default function LiveTerminal({ id, tool, bin, cwd, onClose }: Props) {
  useLang()
  const theme = useTheme()
  const boxRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [err, setErr] = useState('')
  const [exited, setExited] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  const dark = theme === 'dark'
    || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const api = ptyApi()
    if (!api) {
      setErr(t('互動終端只有桌面版有（瀏覽器開發模式沒有 node-pty）'))
      return
    }
    const box = boxRef.current
    if (!box) return

    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", "Noto Sans Mono CJK TC", monospace',
      fontSize: 13,
      cursorBlink: true,
      // CJK 要寬字元對齊，不然中文輸出會錯位
      allowProposedApi: true,
      scrollback: 5000,
      theme: themeOf(dark),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(box)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let offData = () => {}
    let offExit = () => {}
    let disposed = false

    ;(async () => {
      // 同一個 id 重新掛上：先把先前的輸出回放，不然切走再切回來畫面是空的
      const prev = await api.backlog(id)
      if (disposed) return
      if (prev) term.write(prev)

      offData = api.onData(id, (chunk) => term.write(chunk))
      offExit = api.onExit(id, (code) => {
        setExited(code)
        term.write(`\r\n\x1b[90m── ${t('行程已結束（代碼 {c}）', { c: code })} ──\x1b[0m\r\n`)
      })

      if (!prev) {
        const r = await api.open({
          id, tool, bin: bin || '', cwd: cwd || '',
          cols: term.cols, rows: term.rows,
        })
        if (disposed) return
        if (r?.error) { setErr(r.error); return }
      }
      setReady(true)
      term.focus()
    })()

    // 打進去的字直接送給**這條終端自己的**行程。
    // 再說一次免得誤會：這不是那個已經在跑的派工，那個插不進去。
    const onKey = term.onData((data) => { void api.write(id, data) })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void api.resize(id, term.cols, term.rows)
      } catch { /* 元件正在卸載 */ }
    })
    ro.observe(box)

    return () => {
      disposed = true
      ro.disconnect()
      onKey.dispose()
      offData()
      offExit()
      term.dispose()
      // 刻意不 close session —— 切到別的分頁再回來要能接回同一條連線。
      // 真正要結束是按「結束」按鈕，或關掉 app（主行程會 killAll）。
    }
    // id/tool/bin/cwd 變了就是換一條 session，本來就該整個重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tool, bin, cwd])

  // 主題切換時只換配色，不重建 session
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeOf(dark)
  }, [dark])

  const kill = async () => {
    const api = ptyApi()
    if (api) await api.close(id)
    onClose?.()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-line bg-panel">
      <div className="flex flex-none items-center gap-2 border-b border-line px-2 py-1 text-[11px]">
        <span className="font-medium text-ink3">{tool}</span>
        {ready && exited === null && (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            {t('連線中')}
          </span>
        )}
        {exited !== null && <span className="text-mute2">{t('已結束（{c}）', { c: exited })}</span>}
        <span className="min-w-0 flex-1 truncate text-mute3" title={cwd}>{cwd}</span>
        <button className="flex-none text-mute2 hover:text-red-500" onClick={() => void kill()}>
          {t('結束')}
        </button>
      </div>
      {err && <div className="px-2 py-3 text-xs text-amber-600 dark:text-amber-400">⚠️ {err}</div>}
      <div ref={boxRef} className={`min-h-0 flex-1 p-1 ${err ? 'hidden' : ''}`} />
    </div>
  )
}
