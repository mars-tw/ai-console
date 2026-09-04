// 「📱 手機遙控」：開關遙控埠、把配對網址畫成 QR 給手機掃。
//
// 為什麼放在桌面主控台而不是設定頁：使用者要的是「人在外面也能看派工、停工」，
// 配對這件事本身就是派工流程的一部分。完整網址（含 token）只有這裡拿得到——
// 後端只回給同源的桌面頁面，token 藏在 # 後面，不會出現在任何伺服器日誌。
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { t } from '@/i18n'
import { maskUrl } from '@/lib/maskToken'

export interface RemoteStatus {
  ok: boolean
  enabled: boolean
  bind: string
  port: number
  url: string
  tokenTail: string
  created?: string
  tailscale: boolean
  error?: string
}

const PANEL_KEY = 'ac_remote_panel'

function readOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === 'open'
  } catch {
    return false
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_KEY, open ? 'open' : 'closed')
  } catch {
    // 無痕或受限環境：記不住就每次都收著，不影響功能
  }
}

interface Props {
  /** 測試用：直接給狀態，跳過第一次 fetch */
  initialStatus?: RemoteStatus
}

export default function RemotePanel({ initialStatus }: Props) {
  const [open, setOpen] = useState<boolean>(readOpen)
  const [status, setStatus] = useState<RemoteStatus | null>(initialStatus ?? null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  // QR 跟著網址走：存「哪個網址的 QR」，網址一換就自然失效，不用在 effect 裡同步清空
  const [qrFor, setQrFor] = useState<{ url: string; data: string }>({ url: '', data: '' })
  const qr = status?.enabled && qrFor.url === status.url ? qrFor.data : ''

  const load = async () => {
    try {
      const r = await fetch('/api/remote').then((x) => x.json()) as RemoteStatus
      setStatus(r)
    } catch {
      setStatus(null)
      setNote(t('⚠️ 控制 API 無回應'))
    }
  }

  useEffect(() => {
    if (initialStatus) return
    // 掛載時抓一次狀態。setState 只在回呼裡發生（effect 本體不同步 setState）
    let cancelled = false
    fetch('/api/remote')
      .then((x) => x.json() as Promise<RemoteStatus>)
      .then((r) => { if (!cancelled) setStatus(r) })
      .catch(() => { if (!cancelled) setNote(t('⚠️ 控制 API 無回應')) })
    return () => { cancelled = true }
  }, [initialStatus])

  // 網址變了才重畫 QR。用 data URL 而不是 canvas ref：關掉再打開時不用管 ref 還在不在。
  useEffect(() => {
    const url = status?.enabled ? status.url : ''
    if (!url) return
    let cancelled = false
    QRCode.toDataURL(url, { width: 208, margin: 1 })
      .then((d) => { if (!cancelled) setQrFor({ url, data: d }) })
      .catch(() => { /* 畫不出來就留著「產生 QR…」的框；網址照樣能複製 */ })
    return () => { cancelled = true }
  }, [status?.enabled, status?.url])

  const act = async (path: 'enable' | 'disable' | 'rotate', confirmText?: string) => {
    if (busy) return
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true)
    setNote('')
    try {
      const r = await fetch(`/api/remote/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((x) => x.json()) as RemoteStatus
      if (!r.ok) setNote(`⚠️ ${r.error || t('沒有成功')}`)
      setStatus(r.ok ? r : (status ? { ...status, error: r.error } : r))
      if (!r.ok) await load()
    } catch {
      setNote(t('⚠️ 控制 API 無回應'))
    }
    setBusy(false)
  }

  const copy = async () => {
    if (!status?.url) return
    try {
      await navigator.clipboard.writeText(status.url)
      setNote(t('已複製完整網址（含 token），只貼給自己的手機'))
    } catch {
      setNote(t('剪貼簿不可用；直接掃 QR'))
    }
  }

  const toggle = () => {
    setOpen((p) => { writeOpen(!p); return !p })
  }

  return (
    <div className="rounded border border-line bg-panel p-3 text-xs">
      <button type="button" aria-expanded={open} onClick={toggle}
        className="flex w-full items-center gap-2 text-left font-medium tracking-widest text-mute hover:text-ink2">
        <span className="text-mute3" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{t('📱 手機遙控')}</span>
        <span className={`ml-2 inline-block h-2 w-2 rounded-full ${status?.enabled ? 'bg-emerald-500' : 'bg-mute3'}`}
          aria-label={status?.enabled ? t('遙控開著') : t('遙控關著')} />
        <span className="text-[10px] text-mute3">
          {status?.enabled ? t('遙控開著：{bind}:{port}', { bind: status.bind, port: status.port }) : t('遙控關著')}
        </span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[11px] text-mute2">
            {t('只綁在 Tailscale 網卡上，不開放區網與公網；手機在同一個 Tailscale 網路裡掃 QR 就自動配對。遙控只管派工：看得到派工與日誌，看不到對話、檔案與設定。')}
          </p>

          {status?.enabled ? (
            <div className="flex flex-wrap items-start gap-3">
              {qr ? (
                <img src={qr} alt={t('配對 QR')} width={208} height={208}
                  className="rounded border border-line bg-white p-1" />
              ) : (
                <div className="flex h-[208px] w-[208px] items-center justify-center rounded border border-line text-mute3">
                  {t('產生 QR…')}
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="text-[10px] text-mute3">{t('配對網址（token 已遮）')}</div>
                <code className="break-all rounded bg-elev px-2 py-1 font-mono text-[11px] text-ink2">{maskUrl(status.url)}</code>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void copy()} disabled={busy}
                    className="rounded border border-line px-2 py-1 text-mute2 hover:text-ink2">
                    {t('複製完整網址')}
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act('rotate', t('換新 token 之後舊的手機連不上，要重新掃。確定？'))}
                    className="rounded border border-line px-2 py-1 text-mute2 hover:text-ink2">
                    {t('換一把 token')}
                  </button>
                  <button type="button" disabled={busy}
                    onClick={() => void act('disable', t('關掉之後手機那份 token 就作廢，要重新掃。確定？'))}
                    className="rounded border border-line px-2 py-1 text-mute2 hover:text-red-500">
                    {t('關閉並作廢 token')}
                  </button>
                </div>
                {status.tokenTail && (
                  <div className="text-[10px] text-mute3">{t('token 末四碼 {tail}', { tail: status.tokenTail })}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy} onClick={() => void act('enable')}
                className="rounded bg-sky-600 px-3 py-1.5 text-white hover:bg-sky-500 disabled:opacity-50">
                {busy ? '…' : t('開啟遙控')}
              </button>
              {status && !status.tailscale && (
                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                  {t('找不到 Tailscale：先裝好並登入，或在 server/config.json 設 remote_bind')}
                </span>
              )}
              {status?.error && <span className="text-[11px] text-red-600 dark:text-red-400">{status.error}</span>}
            </div>
          )}

          {note && <div className="text-[11px] text-mute2">{note}</div>}
        </div>
      )}
    </div>
  )
}
