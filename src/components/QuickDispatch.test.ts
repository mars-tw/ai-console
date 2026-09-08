/**
 * QuickDispatch 派工前置判讀的聚焦測試。
 *
 * 這裡刻意不做 DOM 互動測試：要守住的規則是「狀態不明就不准派工、也不准
 * 先跳確認視窗」，那是純函式與呼叫順序的問題。用假 fetch ＋ 原始碼接線
 * 檢查 ＋ SSR 字串，就能在沒有 jsdom 的環境下驗證，也不會因為換樣式而壞掉。
 *
 * 注意：檔內所有 AI 回覆／工具狀態都是寫死的測試假資料，不是真的執行結果，
 * 沒有連到任何模型或帳號。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canDispatch } from '@/lib/aiReadiness'
import QuickDispatch, {
  LOADING_READINESS,
  canStartDispatch,
  deniedReadiness,
  fetchReadiness,
  isAcceptedDispatch,
  shouldClearDraftAfterSend,
} from './QuickDispatch'

const FAKE_REPLY = '（測試假資料）這不是真的 AI 回覆'

const src = readFileSync(fileURLToPath(new URL('./QuickDispatch.tsx', import.meta.url)), 'utf8')
const homeSrc = readFileSync(fileURLToPath(new URL('../pages/Home.tsx', import.meta.url)), 'utf8')

/** 假回應：只實作元件真的會用到的 ok / json。 */
function res(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => body } as unknown as Response
}

function fetchOf(...steps: (Response | Error)[]): typeof fetch {
  let i = 0
  return (async () => {
    const step = steps[Math.min(i++, steps.length - 1)]
    if (step instanceof Error) throw step
    return step
  }) as unknown as typeof fetch
}

const READY_TOOL = { id: 'claude', label: 'Claude Code', mode: 'headless', ready: true, limited: false, state: 'ready' }
const base = { snapshot: LOADING_READINESS, requested: 'auto', draft: '整理這段對話' }

describe('fetchReadiness：任何讀不到都 fail closed', () => {
  it('尚未讀到狀態時預設就是不能派工', () => {
    expect(LOADING_READINESS.ok).toBe(false)
    expect(LOADING_READINESS.auto).toBeNull()
    expect(canStartDispatch({ ...base, loading: true })).toBe(false)
  })

  it('fetch 直接失敗 → 空快照、沒有 auto、不能派工', async () => {
    const snap = await fetchReadiness(fetchOf(new Error('offline')))
    expect(snap.ok).toBe(false)
    expect(snap.tools).toEqual([])
    expect(snap.auto).toBeNull()
    expect(canStartDispatch({ ...base, snapshot: snap })).toBe(false)
  })

  it('HTTP 非 2xx 不採用內容', async () => {
    const snap = await fetchReadiness(fetchOf(res({ ok: true, tools: [READY_TOOL], auto: 'claude' }, false)))
    expect(snap.ok).toBe(false)
    expect(snap.tools).toEqual([])
  })

  it('形狀不合（tools 不是陣列）整份作廢', async () => {
    const snap = await fetchReadiness(fetchOf(res({ ok: true, tools: 'claude' })))
    expect(snap.ok).toBe(false)
    expect(canStartDispatch({ ...base, snapshot: snap })).toBe(false)
  })

  it('重新檢查失敗時回到拒絕狀態，不留著上一次的可派工結果', async () => {
    const good = await fetchReadiness(fetchOf(res({ ok: true, tools: [READY_TOOL], auto: 'claude' })))
    expect(canStartDispatch({ ...base, snapshot: good })).toBe(true)
    const after = await fetchReadiness(fetchOf(new Error('boom')))
    expect(after.ok).toBe(false)
    expect(canStartDispatch({ ...base, snapshot: after })).toBe(false)
  })
})

describe('就緒欄位缺漏或造假一律不能派工', () => {
  it('沒有 ready 欄位：工具仍看得見，但選不動', async () => {
    const snap = await fetchReadiness(fetchOf(res({
      ok: true,
      auto: 'claude',
      tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless', limited: false, state: 'ready' }],
    })))
    expect(snap.tools).toHaveLength(1)
    expect(canDispatch('claude', snap.tools, snap.auto)).toBe(false)
    expect(snap.auto).toBeNull()
  })

  it('ready 是字串 "true" 不算就緒', async () => {
    const snap = await fetchReadiness(fetchOf(res({
      ok: true,
      auto: 'claude',
      tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless', ready: 'true', limited: false, state: 'ready' }],
    })))
    expect(canDispatch('claude', snap.tools, snap.auto)).toBe(false)
    expect(canStartDispatch({ ...base, snapshot: snap, requested: 'claude' })).toBe(false)
  })

  it('限流工具不能派，auto 也不會升級', async () => {
    const snap = await fetchReadiness(fetchOf(res({
      ok: true,
      auto: 'claude',
      tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless', ready: true, limited: true, state: 'limited' }],
    })))
    expect(snap.tools).toHaveLength(1) // 仍要列出來，不能讓工具憑空消失
    expect(canDispatch('claude', snap.tools, snap.auto)).toBe(false)
    expect(snap.auto).toBeNull()
  })

  it('auto 指到不存在的工具（過期）→ 自動選項停用', async () => {
    const snap = await fetchReadiness(fetchOf(res({ ok: true, auto: 'gemini', tools: [READY_TOOL] })))
    expect(snap.auto).toBeNull()
    expect(canDispatch('auto', snap.tools, snap.auto)).toBe(false)
    expect(canDispatch('claude', snap.tools, snap.auto)).toBe(true)
  })

  it('沒有伺服器 auto 時，不會自己退回本地模型', async () => {
    const snap = await fetchReadiness(fetchOf(res({
      ok: true,
      tools: [{ id: 'ollama', label: 'Ollama', mode: 'local', ready: true, limited: false, state: 'ready' }],
    })))
    expect(canDispatch('auto', snap.tools, snap.auto)).toBe(false)
  })
})

describe('canStartDispatch：按鈕可按的唯一條件', () => {
  it('就緒且有內容才可按；載入中／送出中／外部停用／空白皆不可', async () => {
    const snap = await fetchReadiness(fetchOf(res({ ok: true, tools: [READY_TOOL], auto: 'claude' })))
    const ok = { snapshot: snap, requested: 'auto', draft: '更新文件' }
    expect(canStartDispatch(ok)).toBe(true)
    expect(canStartDispatch({ ...ok, loading: true })).toBe(false)
    expect(canStartDispatch({ ...ok, sending: true })).toBe(false)
    expect(canStartDispatch({ ...ok, disabled: true })).toBe(false)
    expect(canStartDispatch({ ...ok, draft: '   ' })).toBe(false)
    expect(canStartDispatch({ ...ok, snapshot: deniedReadiness('讀不到') })).toBe(false)
  })
})

describe('回應判讀與草稿保留', () => {
  it('HTTP 失敗或 ok!==true 都不算成功，草稿不清', () => {
    expect(isAcceptedDispatch(false, { ok: true })).toBe(false)
    expect(isAcceptedDispatch(true, { ok: false, error: '額度用完' })).toBe(false)
    expect(isAcceptedDispatch(true, null)).toBe(false)
    expect(isAcceptedDispatch(true, 'ok')).toBe(false)
    expect(isAcceptedDispatch(true, { ok: true, reply: FAKE_REPLY })).toBe(true)
    const sent = { draft: '寫測試', editSeq: 2 }
    expect(shouldClearDraftAfterSend(false, sent, sent)).toBe(false)
  })

  it('只有「送出後沒再動過」才清空草稿', () => {
    const sent = { draft: '寫測試', editSeq: 2 }
    expect(shouldClearDraftAfterSend(true, sent, { draft: '寫測試', editSeq: 2 })).toBe(true)
    // 送出後又打字（含改成空白）→ 保留使用者的新內容
    expect(shouldClearDraftAfterSend(true, sent, { draft: '寫測試 2', editSeq: 3 })).toBe(false)
    expect(shouldClearDraftAfterSend(true, sent, { draft: '', editSeq: 3 })).toBe(false)
    // 受控 props 被父層換掉（換對話）也不能清
    expect(shouldClearDraftAfterSend(true, sent, { draft: '別件事', editSeq: 2 })).toBe(false)
  })
})

describe('送出流程接線（原始碼順序）', () => {
  const iGate = src.indexOf('if (!canStartDispatch({ snapshot')
  const iPreflight = src.indexOf('await fetchReadiness(fetch, ac.signal)')
  const iFreshGate = src.indexOf('canDispatch(resolvedTool, freshTools, freshAuto)')
  const iConfirm = src.indexOf('window.confirm(')
  const iPost = src.indexOf("fetch('/api/dispatch', {")

  it('共用判讀在確認視窗與 POST 之前', () => {
    expect(iGate).toBeGreaterThan(-1)
    expect(iGate).toBeLessThan(iConfirm)
    expect(iGate).toBeLessThan(iPost)
  })

  it('確認前會重新查一次狀態，狀態變了就不 POST', () => {
    expect(iPreflight).toBeGreaterThan(iGate)
    expect(iFreshGate).toBeGreaterThan(iPreflight)
    expect(iFreshGate).toBeLessThan(iConfirm)
    expect(iConfirm).toBeLessThan(iPost)
  })

  it('連點以同步旗標上鎖，且 disabled 擋的是行為不只是按鈕', () => {
    expect(src).toContain('if (disabled || sendingRef.current || sending) return')
    expect(src).toContain('sendingRef.current = true')
  })

  it('取消／換對話／卸載會作廢前置檢查，不會有遲到的確認或 POST', () => {
    expect(src.match(/sendSeq\.current \+= 1/g)?.length).toBeGreaterThanOrEqual(3)
    expect(src).toContain('if (seq !== sendSeq.current) return')
    expect(src).toContain('preflightAbort.current?.abort()')
  })

  it('已送出的工作不會被畫面中止（POST 不帶 signal，取消鍵在 POST 後失效）', () => {
    expect(src.slice(iPost, iPost + 400)).not.toContain('signal')
    expect(src).toContain('if (!sendingRef.current || postedRef.current) return')
  })

  it('成功訊息不宣稱一定完成，同步回覆講明沒有改檔案', () => {
    expect(src).toContain('送出不代表一定會完成')
    expect(src).toContain('沒有修改任何檔案')
    expect(src).toContain('還沒有人按下去') // 終端仍要使用者動作
  })

  it('後端 mode=sync 且帶 id 仍走「這是回答」分支，不會被講成已排程', () => {
    // 本地派工實際回傳形狀（寫死的假資料，不發任何請求）：
    //   { ok: true, tool: 'local', mode: 'sync', id: '…', reply: '…' }
    // 舊條件只認 mode==='local' 或「有 reply 且沒有 id」，這個形狀兩邊都不中，
    // 於是回答被吞掉、還宣稱「已送出，去主控台看進度」。
    const iTerminal = src.indexOf("mode === 'terminal'")
    const iSync = src.indexOf("mode === 'sync'")
    const iAnswer = src.indexOf('這是回答，沒有修改任何檔案')
    const iQueued = src.indexOf('已送出給 {who}')
    expect(iSync).toBeGreaterThan(-1)
    expect(iTerminal).toBeLessThan(iSync)   // 終端分支仍在最前面，行為不變
    expect(iSync).toBeLessThan(iAnswer)     // sync 命中的是回答分支
    expect(iAnswer).toBeLessThan(iQueued)   // 已排程訊息留在最後的 else，headless 不受影響
    // sync 的判定不再被 id 的有無否決
    expect(src).toMatch(/mode === 'sync' \|\| mode === 'local'/)
  })
})

describe('SSR 與受控草稿', () => {
  const props = { conv: null, recent: [], onToast: () => {} }

  it('受控草稿在伺服器渲染就看得到，且未就緒時開始鍵是停用的', () => {
    const html = renderToStaticMarkup(
      createElement(QuickDispatch, { ...props, draft: 'ssr-draft-keep-me', onDraftChange: () => {} }),
    )
    expect(html).toContain('ssr-draft-keep-me')
    expect(html).toContain('disabled') // 尚未讀到狀態＝不能派工
  })

  it('不給受控 props 也能獨立運作', () => {
    const html = renderToStaticMarkup(createElement(QuickDispatch, props))
    expect(html).toContain('<textarea')
  })

  it('有 onSetup 才出現設定按鈕，沒有就只給文字指引（不放沒反應的按鈕）', () => {
    const withSetup = renderToStaticMarkup(createElement(QuickDispatch, { ...props, onSetup: () => {} }))
    const without = renderToStaticMarkup(createElement(QuickDispatch, props))
    const count = (s: string) => s.split('<button').length
    expect(count(withSetup)).toBeGreaterThan(count(without))
    expect(count(without)).toBeGreaterThan(1) // 仍有「重新檢查」，不會是死路
  })
})

describe('Home 接線', () => {
  it('傳入受控草稿、setup CTA 與對話 key', () => {
    expect(homeSrc).toContain('onSetup={() => setViewMode(\'setup\')}')
    expect(homeSrc).toContain('draft={quickDrafts[selected?.id ?? \'\'] ?? \'\'}')
    expect(homeSrc).toContain('onDraftChange={(v) => setQuickDrafts(')
    expect(homeSrc).toContain('key={selected?.id ?? \'none\'}')
  })

  it('草稿只在記憶體，沒有寫進 localStorage', () => {
    expect(homeSrc).toContain('useState<Record<string, string>>({})')
    expect(homeSrc).not.toMatch(/localStorage[^\n]*[Qq]uick/)
  })

  it('既有 AskSession 狀態沒有被動到', () => {
    expect(homeSrc).toContain('const [askSession, setAskSession] = useState<AskSession>({ model: \'auto\', messages: [], input: \'\' })')
    const setupReturn = homeSrc.slice(homeSrc.indexOf('const startSetupChat ='), homeSrc.indexOf('/**', homeSrc.indexOf('const startSetupChat =')))
    expect(setupReturn).toContain('setAskSession(current => ({ ...current,')
    expect(setupReturn).toContain('selectConversation(plan.conversationId)')
    expect(setupReturn).not.toMatch(/\bfetch\(|\bsend\(|input:\s*['"]['"]|messages:\s*\[\]/)
  })
})

describe('headlessOnly 新手繼續工作', () => {
  it('只列出無頭工具，並在 POST 帶 expectedMode', () => {
    expect(src).toContain('headlessOnly')
    expect(src).toContain('filterHeadlessDispatchTools')
    expect(src).toContain('if (expectedMode) body.expectedMode = expectedMode')
    expect(src).toContain("matched?.mode !== 'headless'")
    expect(src).toContain('pickInitialHeadlessTool')
  })

  it('headlessOnly 時 auto 只採用無頭鏈上的 auto', () => {
    expect(src).toContain('const headlessAuto = tools.some((row) => row.id === snapshot.auto) ? snapshot.auto : null')
  })

  it('確認前顯示實際收件人名稱', () => {
    expect(src).toContain('resolveDispatchRecipientLabel')
    expect(src).toContain('這會交給 {who}')
  })

  it('重新檢查不覆寫使用者已選工具', () => {
    expect(src).toContain('userPickedTool.current')
    expect(src).not.toMatch(/useEffect\(\(\) => \{[\s\S]*pickInitialHeadlessTool[\s\S]*\}, \[headlessOnly, initialTool, loading, snapshot\]\)/)
  })

  it('窄視窗下拉與 flex 子項不撐出橫向溢出', () => {
    expect(src).toContain('min-w-0 max-w-full')
    expect(src).toContain('flex min-w-0 flex-wrap')
    expect(src).toContain('break-words')
    expect(src).toContain("embedded ? 'mt-2 min-w-0 overflow-hidden'")
  })
})
