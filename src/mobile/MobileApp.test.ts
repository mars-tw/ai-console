import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileApp, {
  attemptControl,
  attemptDispatch,
  canFollowupRecord,
  fetchReadiness,
  isAnswerOnlyTool,
  isLocalAnswerRecord,
  readinessFromProps,
  STALE_PAIRING_NOTE,
  type ConsoleDispatch,
  type DispatchTool,
} from './MobileApp'
import { capturePairing, createSnapshotFetch, isPairingIntact } from './remoteApi'

// 模擬派工契約資料
const mockDispatches: ConsoleDispatch[] = [
  {
    id: 'disp-stopped',
    tool: 'claude',
    task: '修正前端樣式與色彩對齊語意色票',
    started: '20260904-093000',
    log: '',
    mode: 'headless',
    state: 'stopped',
    outcome: 'stopped',
    tail: 'Interrupted by user',
  },
  {
    id: 'disp-running',
    tool: 'codex',
    task: '執行背景重構與大型檔案清理作業',
    started: '20260904-094500',
    log: '',
    mode: 'headless',
    state: 'running',
    tail: 'Processing file 42/100...',
  },
  {
    id: 'disp-waiting',
    tool: 'kimi',
    task: '等待終端輸入交互與確認指令',
    started: '20260904-095000',
    log: '',
    mode: 'terminal',
    state: 'waiting',
  },
  {
    id: 'disp-done',
    tool: 'qwen',
    task: '快速修復型別錯誤並產出回歸測試報告',
    started: '20260904-091500',
    log: '',
    mode: 'headless',
    state: 'done',
    outcome: 'ok',
    handedOffTo: 'gemini',
    handoffFrom: 'claude',
  },
]

// 模擬工具清單資料：旗標比照後端契約給滿（ready／limited／state），少給就等於「狀態未確認」
const mockTools: DispatchTool[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    mode: 'headless',
    ready: true,
    limited: false,
    state: 'login_unverified',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    mode: 'headless',
    ready: false,
    limited: true,
    state: 'limited',
    reason: '09/07 10:30 恢復',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    mode: 'headless',
    ready: false,
    limited: true,
    state: 'limited',
    reason: '',
  },
]

// ── 測試用 fetch 假替身：只注入 Response，不碰真的網路、token 或供應商 ──
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function makeFetch(get: () => Response, post: () => Response = () => jsonResponse({ ok: true })) {
  return vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'POST' ? post() : get()))
}
type FetchSpy = ReturnType<typeof makeFetch>
const asFetch = (spy: FetchSpy) => spy as unknown as typeof fetch
const urlsOf = (spy: FetchSpy) => spy.mock.calls.map(([url]) => String(url))
const postsOf = (spy: FetchSpy) => spy.mock.calls.filter(([, init]) => init?.method === 'POST')
function postBody(spy: FetchSpy): Record<string, unknown> {
  const call = postsOf(spy)[0]
  const body = call && call[1] ? call[1].body : ''
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
}

const READY_TOOLS = [
  { id: 'claude', label: 'Claude Code', mode: 'headless', ready: true, limited: false, state: 'login_unverified' },
  { id: 'local', label: '本機模型', mode: 'local', ready: true, limited: false, state: 'ready' },
]
const toolsGet = (auto: string) => () => jsonResponse({ ok: true, auto, tools: READY_TOOLS })

// 讀不到工具狀態的各種樣態：一律不可派工
const BAD_GETS: [string, () => Response][] = [
  ['401 未授權', () => jsonResponse({ error: 'unauthorized' }, 401)],
  ['主機 500', () => jsonResponse({ ok: false }, 500)],
  ['回覆不是 JSON', () => new Response('<html>nope</html>', { status: 200 })],
  ['格式不對（tools 不是陣列）', () => jsonResponse({ ok: true, tools: 'claude', auto: 'claude' })],
]

const NO_DISPATCH_GETS: [string, () => Response][] = [
  ...BAD_GETS,
  ['明講沒有任何工具', () => jsonResponse({ ok: true, tools: [], auto: '' })],
  ['指名的工具限流', () => jsonResponse({
    ok: true,
    auto: '',
    tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless', ready: false, limited: true, state: 'limited', reason: '額度用完' }],
  })],
  ['明講 ready:false', () => jsonResponse({
    ok: true,
    auto: '',
    tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless', ready: false, limited: false, state: 'login_unverified' }],
  })],
  ['舊格式缺 ready／state', () => jsonResponse({
    ok: true,
    auto: 'claude',
    tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless' }],
  })],
]

describe('MobileApp 配對畫面算繪', () => {
  let memoryStorage: Record<string, string>

  beforeEach(() => {
    memoryStorage = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memoryStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        memoryStorage[key] = String(val)
      },
      removeItem: (key: string) => {
        delete memoryStorage[key]
      },
    })
  })

  it('沒 token 時渲染配對畫面，包含掃描說明、Token 輸入框與連線按鈕', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: false,
        initialToken: '',
      }),
    )

    // 驗證標題與掃描引導文字
    expect(html).toContain('AI 控制台 遙控')
    expect(html).toContain('用桌面版的「📱 手機遙控」掃 QR 會自動配對')

    // 驗證 Token 輸入框與連線按鈕
    expect(html).toContain('請輸入存取權限 Token')
    expect(html).toContain('連線')
  })
})

describe('MobileApp 主畫面派工清單與動作按鈕', () => {
  it('有清單資料時每列狀態與動作按鈕正確（stopped 列有重派、running 列有停止、waiting 列有取消）', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialDispatches: mockDispatches,
        initialTools: mockTools,
        initialAuto: 'claude',
      }),
    )

    // 1. stopped 列：必須有「↻ 重派」按鈕與「已停止」標籤
    expect(html).toContain('已停止')
    expect(html).toContain('↻ 重派')

    // 2. running 列：必須有「⏹ 停止」按鈕與「執行中」標籤
    expect(html).toContain('執行中')
    expect(html).toContain('⏹ 停止')

    // 3. waiting 列：必須有「✕ 取消」按鈕與「等你執行」標籤
    expect(html).toContain('等你執行')
    expect(html).toContain('✕ 取消')

    // 4. done 無頭列：具有「💬 補一句」按鈕與「完成」標籤
    expect(html).toContain('完成')
    expect(html).toContain('💬 補一句')

    // 5. 檢驗工作內容前 80 字有正常呈現
    expect(html).toContain('修正前端樣式與色彩對齊語意色票')
    expect(html).toContain('執行背景重構與大型檔案清理作業')
  })

  it('正確呈現 tail 行輸出與自動接力徽章', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialDispatches: mockDispatches,
        initialTools: mockTools,
      }),
    )

    // tail 輸出
    expect(html).toContain('Interrupted by user')
    expect(html).toContain('Processing file 42/100...')

    // 接力徽章
    expect(html).toContain('↪ 已自動接力給 gemini')
    expect(html).toContain('↩ 從 claude 接力而來')
  })

  it('掛載既有 QuotaStrip 元件', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
      }),
    )

    // QuotaStrip 的收合標題
    expect(html).toContain('額度與今日用量')
  })
})

describe('MobileApp 快速派工工具選單', () => {
  it('不能派的工具是 disabled，且保留具體原因或退回額度未確認說法', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialTools: mockTools,
        initialAuto: 'claude',
      }),
    )

    // 自動派工對象由伺服器指定，文案是現行的「自動選擇（目前是 …）」
    expect(html).toContain('自動選擇（目前是 claude）')

    // Codex 限流：保留後端給的恢復時間
    expect(html).toContain('Codex CLI（額度用完：09/07 10:30 恢復）')

    // Qwen 限流但沒給 reason：退回通用「額度狀態無法確認」，不假裝正常
    expect(html).toContain('Qwen Code（額度用完：額度狀態無法確認）')

    // Claude 可嘗試執行：講登入待確認，不宣稱已就緒、也不標成限流
    expect(html).toContain('Claude Code（已找到工具，登入待確認）')
    expect(html).not.toContain('Claude Code（額度用完')
    expect(html).not.toContain('[object Object]')
  })

  it('舊旗標／不同封鎖來源都看得到原因，沒有可執行的 AI 時停用送出並指回電腦設定', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialTools: [
          { id: 'claude', label: 'Claude Code', mode: 'headless' },
          { id: 'gemini', label: 'Gemini CLI', mode: 'headless', ready: false, limited: false, state: 'missing_tool', reason: '電腦上還沒安裝' },
          { id: 'codex', label: 'Codex CLI', mode: 'headless', ready: false, limited: true, state: 'limited', reason: '09/07 10:30 恢復' },
        ],
        initialAuto: 'claude',
      }),
    )

    expect(html).toContain('Claude Code（狀態未確認）')
    expect(html).toContain('Gemini CLI（尚未設定：電腦上還沒安裝）')
    expect(html).toContain('Codex CLI（額度用完：09/07 10:30 恢復）')
    // 沒有任何確認可執行的 AI：出口是回電腦設定，送出鈕停用，也不假裝有自動對象
    expect(html).toContain('請先在電腦上完成 AI 設定')
    expect(html).toContain('還沒有確認可以執行工作的 AI')
    expect(html).toContain('自動選擇（目前沒有可自動派工的工具）')
    expect(html).not.toContain('自動選擇（目前是')
  })

  it('本機問答那筆不給補一句，改講清楚要回原對話接續', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialTools: mockTools,
        initialAuto: 'claude',
        initialDispatches: [{
          id: 'disp-local',
          tool: 'local',
          task: '解釋這段錯誤訊息',
          started: '20260904-093000',
          log: '',
          mode: 'sync',
          state: 'done',
          outcome: 'ok',
        }],
      }),
    )

    expect(html).toContain('本機問答：只回答，沒有改任何檔案')
    expect(html).toContain('本機問答請回原對話接續')
    expect(html).not.toContain('💬 補一句')
  })
})

describe('MobileApp 純判讀函式', () => {
  it.each([
    ['沒有工具清單', undefined, null, false, null],
    ['舊格式缺 ready／state 不會被補成可派工', [{ id: 'claude', label: 'Claude Code', mode: 'headless' }], 'claude', false, null],
    ['旗標給滿才升級 auto', mockTools, 'claude', true, 'claude'],
  ] as [string, DispatchTool[] | undefined, string | null, boolean, string | null][])(
    'readinessFromProps：%s',
    (_name, tools, auto, ready, expectedAuto) => {
      const snap = readinessFromProps(tools, auto)
      expect(snap.ready).toBe(ready)
      expect(snap.auto).toBe(expectedAuto)
    },
  )

  it.each([
    ['查無此列時只認 id', 'local', [], true],
    ['宣告 mode=local', 'zen', [{ id: 'zen', label: 'Zen', mode: 'local' }], true],
    ['同名但 mode 不是 local', 'local', [{ id: 'local', label: '本機', mode: 'headless' }], false],
    ['CLI 工具', 'claude', mockTools, false],
  ] as [string, string, DispatchTool[], boolean][])(
    'isAnswerOnlyTool：%s',
    (_name, id, tools, expected) => {
      expect(isAnswerOnlyTool(id, tools)).toBe(expected)
    },
  )

  it.each([
    [{ tool: 'local', mode: 'headless' }, true],
    [{ tool: 'claude', mode: 'sync' }, true],
    [{ tool: 'claude', mode: 'headless' }, false],
    [null, false],
  ] as [{ tool?: string; mode?: string } | null, boolean][])(
    'isLocalAnswerRecord(%j) === %s',
    (record, expected) => {
      expect(isLocalAnswerRecord(record)).toBe(expected)
    },
  )

  it.each(BAD_GETS)('fetchReadiness：%s 一律回不可派工的空快照', async (_name, get) => {
    const snap = await fetchReadiness(asFetch(makeFetch(get)))
    expect(snap.ok).toBe(false)
    expect(snap.tools).toEqual([])
    expect(snap.auto).toBeNull()
    expect(snap.ready).toBe(false)
  })
})

describe('attemptDispatch 送出前複查與 POST 內容', () => {
  it.each(NO_DISPATCH_GETS)('%s：不會打出任何 POST', async (_name, get) => {
    const spy = makeFetch(get)
    const result = await attemptDispatch('claude', '幫我改一下樣式', { fetch: asFetch(spy) })

    expect(result.posted).toBe(false)
    expect(result.ok).toBe(false)
    expect(postsOf(spy)).toHaveLength(0)
    expect(result.message).toContain('沒有送出任何工作')
    expect(urlsOf(spy)).toEqual(['/api/dispatch/tools'])
  })

  it.each([
    ['CLI', 'claude', false, () => jsonResponse({ ok: true, id: 'd-1' }), '派工成功'],
    ['本機問答', 'local', true, () => jsonResponse({ ok: true, tool: 'local', mode: 'sync', id: 'd-2', reply: '先跑 npm run typecheck' }), '先跑 npm run typecheck'],
  ] as [string, string, boolean, () => Response, string][])(
    'auto 會釘死複查後的 %s，POST 帶明確 id',
    async (_name, id, answerOnly, post, expected) => {
      const spy = makeFetch(toolsGet(id), post)
      const result = await attemptDispatch('auto', '看一下這段', {
        fetch: asFetch(spy),
        confirm: () => true,
        isCurrent: () => true,
      })

      expect(result.posted).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.tool).toBe(id)
      expect(result.answerOnly).toBe(answerOnly)
      expect(postBody(spy).tool).toBe(id)
      expect(postBody(spy).tool).not.toBe('auto')
      expect(result.message).toContain(expected)
      // 這段流程只會碰派工相關端點，不碰設定或連線 API
      expect(urlsOf(spy)).toEqual(['/api/dispatch/tools', '/api/dispatch'])
      expect(urlsOf(spy).some((u) => u.includes('/api/setup') || u.includes('ai-connections'))).toBe(false)
    },
  )

  it.each([
    ['使用者在確認框按取消', () => false, () => true, false],
    ['複查回來時已經不是同一份配對', () => true, () => false, true],
    ['確認框按下去時配對才換掉', () => true, (() => { let n = 0; return () => ++n === 1 })(), true],
  ] as [string, () => boolean, () => boolean, boolean][])(
    '%s：不送出 POST',
    async (_name, confirm, isCurrent, stale) => {
      const spy = makeFetch(toolsGet('claude'))
      const result = await attemptDispatch('auto', '幫我改一下樣式', {
        fetch: asFetch(spy),
        confirm,
        isCurrent,
      })

      expect(result.posted).toBe(false)
      expect(result.stale).toBe(stale)
      expect(postsOf(spy)).toHaveLength(0)
      expect(urlsOf(spy)).toEqual(['/api/dispatch/tools'])
    },
  )

  it.each([
    ['本機同步回答顯示實際回答與不改檔說明', 'local', () => jsonResponse({ ok: true, tool: 'local', mode: 'sync', id: 'd-3', reply: '答案：先看 vite.config.ts' }), true, ['沒有改任何檔案', '答案：先看 vite.config.ts']],
    ['本機沒有可讀回答時不宣稱已回答', 'local', () => jsonResponse({ ok: true, tool: 'local', mode: 'sync', id: 'd-4' }), false, ['不代表 AI 已經回答完']],
    ['note 是物件時只顯示可讀字串', 'claude', () => jsonResponse({ ok: true, note: { text: '排進去了' } }), true, ['派工成功']],
    ['HTTP 500 但 body 說 ok:true 仍算失敗', 'claude', () => jsonResponse({ ok: true, note: '假的成功' }, 500), false, ['派工失敗']],
  ] as [string, string, () => Response, boolean, string[]][])(
    '%s',
    async (_name, id, post, ok, expected) => {
      const spy = makeFetch(toolsGet(id), post)
      const result = await attemptDispatch(id, '看一下這段', { fetch: asFetch(spy), isCurrent: () => true })

      expect(result.posted).toBe(true)
      expect(result.ok).toBe(ok)
      for (const piece of expected) expect(result.message).toContain(piece)
      expect(result.message).not.toContain('[object Object]')
      expect(typeof result.message).toBe('string')
    },
  )

  it('本機回答拿不到內容時不會被當成成功（草稿因此留著）', async () => {
    const spy = makeFetch(toolsGet('local'), () => jsonResponse({ ok: true, tool: 'local', mode: 'sync', id: 'd-5' }))
    const result = await attemptDispatch('local', '解釋這段錯誤', { fetch: asFetch(spy), isCurrent: () => true })

    expect(result.ok).toBe(false)
    expect(result.answerOnly).toBe(true)
    expect(result.message).not.toContain('本機模型已回答')
  })
})

// ── 工單級配對綁定的整合測試替身 ──
// 全程只用合成字串當 token（tok-A／tok-B），不碰真的憑證、localStorage 或網路。
const SNAP_WIN = { location: { origin: 'http://localhost' } } as unknown as typeof window

type LivePairing = { token: string; epoch: number }
type Rotate = (live: LivePairing) => void

/** 起手釘住快照，之後可從外部改動「目前的」token／代次來模擬送出當下被換掉 */
function intentEnv(startToken: string, startEpoch: number) {
  const live: LivePairing = { token: startToken, epoch: startEpoch }
  const readToken = () => live.token
  const intent = capturePairing(startEpoch, readToken)
  const alive = () => isPairingIntact(intent, live.epoch, readToken)
  const build = (spy: FetchSpy): typeof fetch =>
    createSnapshotFetch(intent, { fetch: asFetch(spy), win: SNAP_WIN, isCurrent: alive, readToken })
  return { live, intent, alive, build }
}

const authsOf = (spy: FetchSpy): string[] =>
  spy.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization') || '')
const postAuth = (spy: FetchSpy): string => {
  const call = postsOf(spy)[0]
  return new Headers(call?.[1]?.headers).get('Authorization') || ''
}

const UNREADY_GET = () => jsonResponse({
  ok: true,
  auto: '',
  tools: [{ id: 'claude', label: 'Claude Code', mode: 'headless', ready: false, limited: true, state: 'limited', reason: '額度用完' }],
})

const LIVE_CLI: ConsoleDispatch = {
  id: 'disp-live',
  tool: 'claude',
  task: '重構模組並補測試',
  started: '20260904-094500',
  log: '',
  mode: 'headless',
  state: 'running',
}
const LOCAL_ROW: ConsoleDispatch = {
  id: 'disp-local',
  tool: 'local',
  task: '解釋這段錯誤訊息',
  started: '20260904-093000',
  log: '',
  mode: 'sync',
  state: 'done',
  outcome: 'ok',
}

describe('attemptDispatch × 工單快照傳輸：絕不用新 token 送舊工單', () => {
  it.each([
    ['確認框按下去的當下 token 被換成 B（代次沒動）', 'confirm', (l: LivePairing) => { l.token = 'tok-B' }],
    ['確認框按下去的當下 token 被清掉', 'confirm', (l: LivePairing) => { l.token = '' }],
    ['複查途中換代又換 token', 'get', (l: LivePairing) => { l.token = 'tok-B'; l.epoch = 8 }],
  ] as [string, 'confirm' | 'get', Rotate][])(
    '%s：整件中止，一個 POST 都不打',
    async (_name, when, rotate) => {
      const env = intentEnv('tok-A', 7)
      const spy = makeFetch(() => {
        if (when === 'get') rotate(env.live)
        return toolsGet('claude')()
      })

      const result = await attemptDispatch('auto', '幫我改一下樣式', {
        fetch: env.build(spy),
        confirm: () => {
          if (when === 'confirm') rotate(env.live)
          return true
        },
        isCurrent: env.alive,
      })

      expect(result.stale).toBe(true)
      expect(result.posted).toBe(false)
      expect(result.ok).toBe(false)
      expect(postsOf(spy)).toHaveLength(0)
      // 讀狀態的 GET 允許發生（那是換掉之前的事），但只有那一次
      expect(urlsOf(spy)).toEqual(['/api/dispatch/tools'])
      // 快照本身不會被外部改動污染
      expect(env.intent.epoch).toBe(7)
      expect(env.intent.token).toBe('tok-A')
      expect(authsOf(spy)).not.toContain('Bearer tok-B')
    },
  )

  it('配對全程沒變：POST 帶的是當初那把 A 的明確授權', async () => {
    const env = intentEnv('tok-A', 7)
    const spy = makeFetch(toolsGet('claude'), () => jsonResponse({ ok: true, id: 'd-9' }))

    const result = await attemptDispatch('auto', '幫我改一下樣式', {
      fetch: env.build(spy),
      confirm: () => true,
      isCurrent: env.alive,
    })

    expect(result.posted).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.stale).toBe(false)
    expect(result.tool).toBe('claude')
    expect(postBody(spy).tool).toBe('claude')
    expect(postAuth(spy)).toBe('Bearer tok-A')
    expect(authsOf(spy).every((a) => a === 'Bearer tok-A')).toBe(true)
    expect(urlsOf(spy)).toEqual(['/api/dispatch/tools', '/api/dispatch'])
  })
})

describe('attemptControl × 工單快照傳輸：停止／取消／重派／補一句同一條路', () => {
  it('stop 確認框按下去時 token 換成 B：中止，不 POST（也不複查就緒度）', async () => {
    const env = intentEnv('tok-A', 7)
    const spy = makeFetch(toolsGet('claude'))

    const result = await attemptControl('stop', LIVE_CLI, {
      fetch: env.build(spy),
      confirm: () => { env.live.token = 'tok-B'; return true },
      isCurrent: env.alive,
    })

    expect(result.stale).toBe(true)
    expect(result.posted).toBe(false)
    expect(result.snapshot).toBeNull()
    expect(urlsOf(spy)).toEqual([])
  })

  it('retry 複查途中 token 換成 B：中止，不 POST', async () => {
    const env = intentEnv('tok-A', 7)
    const spy = makeFetch(() => { env.live.token = 'tok-B'; return toolsGet('claude')() })

    const result = await attemptControl('retry', LIVE_CLI, {
      fetch: env.build(spy),
      isCurrent: env.alive,
    })

    expect(result.stale).toBe(true)
    expect(result.posted).toBe(false)
    expect(postsOf(spy)).toHaveLength(0)
    expect(urlsOf(spy)).toEqual(['/api/dispatch/tools'])
    expect(authsOf(spy)).not.toContain('Bearer tok-B')
  })

  it('還在跑的 CLI 補一句（live）：跳過就緒度複查，只打 followup', async () => {
    const env = intentEnv('tok-A', 7)
    const spy = makeFetch(UNREADY_GET)

    const result = await attemptControl('followup', LIVE_CLI, {
      fetch: env.build(spy),
      isCurrent: env.alive,
      text: '再檢查一下型別',
      live: true,
    })

    expect(result.posted).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.snapshot).toBeNull()
    expect(urlsOf(spy)).toEqual(['/api/dispatch/followup'])
    expect(postBody(spy)).toEqual({ id: 'disp-live', text: '再檢查一下型別' })
    expect(postAuth(spy)).toBe('Bearer tok-A')
  })

  it('已結束的工作補一句（非 live）：同一份讀不到就緒度的狀態就不送', async () => {
    const env = intentEnv('tok-A', 7)
    const spy = makeFetch(UNREADY_GET)

    const result = await attemptControl('followup', { ...LIVE_CLI, state: 'done', outcome: 'ok' }, {
      fetch: env.build(spy),
      isCurrent: env.alive,
      text: '再檢查一下型別',
      live: false,
    })

    expect(result.posted).toBe(false)
    expect(result.ok).toBe(false)
    expect(postsOf(spy)).toHaveLength(0)
    expect(urlsOf(spy)).toEqual(['/api/dispatch/tools'])
    expect(result.message).toContain('沒有送出這句話')
  })

  it.each([
    ['已完成的本機問答', false],
    ['宣稱還在跑的本機問答', true],
  ] as [string, boolean][])(
    '本機問答補一句（%s）：一律不送，改指回原對話',
    async (_name, live) => {
      const env = intentEnv('tok-A', 7)
      const spy = makeFetch(toolsGet('claude'))

      const result = await attemptControl('followup', LOCAL_ROW, {
        fetch: env.build(spy),
        isCurrent: env.alive,
        text: '再幫我改一下',
        live,
      })

      expect(result.posted).toBe(false)
      expect(result.ok).toBe(false)
      expect(urlsOf(spy)).toEqual([])
      expect(result.message).toContain('回原對話接續')
    },
  )

  it.each([
    ['stop', 'running', '/api/dispatch/stop'],
    ['cancel', 'waiting', '/api/dispatch/cancel'],
  ] as ['stop' | 'cancel', ConsoleDispatch['state'], string][])(
    '%s：沒有任何可執行的 AI 也照送（只看配對，不看就緒度）',
    async (action, state, endpoint) => {
      const env = intentEnv('tok-A', 7)
      const spy = makeFetch(UNREADY_GET)

      const result = await attemptControl(action, { ...LIVE_CLI, state }, {
        fetch: env.build(spy),
        confirm: () => true,
        isCurrent: env.alive,
      })

      expect(result.posted).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.stale).toBe(false)
      expect(result.snapshot).toBeNull()
      expect(urlsOf(spy)).toEqual([endpoint])
      expect(postBody(spy)).toEqual({ id: 'disp-live' })
      expect(postAuth(spy)).toBe('Bearer tok-A')
    },
  )

  it('POST 送出後回應晚回、token 已換成 B：stale 且 ok=false（呼叫端不能清草稿）', async () => {
    const env = intentEnv('tok-A', 7)
    const spy = makeFetch(toolsGet('claude'), () => {
      env.live.token = 'tok-B'
      return jsonResponse({ ok: true, note: '排進去了' })
    })

    const result = await attemptControl('followup', LIVE_CLI, {
      fetch: env.build(spy),
      isCurrent: env.alive,
      text: '再看一下這段',
      live: true,
    })

    expect(result.posted).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.stale).toBe(true)
    expect(result.message).toBe('')
    // 送出的仍然是當初那把 A
    expect(postAuth(spy)).toBe('Bearer tok-A')
  })

  it('STALE_PAIRING_NOTE：要人去確認工作狀態，不宣稱沒有送出', () => {
    const note = STALE_PAIRING_NOTE()
    expect(note).toContain('工作的狀態')
    expect(note).not.toContain('沒有送出')
  })
})

describe('補一句資格：算繪與判讀一致', () => {
  const UNREADY_TOOLS: DispatchTool[] = [
    { id: 'claude', label: 'Claude Code', mode: 'headless', ready: false, limited: true, state: 'limited', reason: '額度用完' },
    { id: 'local', label: '本機模型', mode: 'local', ready: false, limited: false, state: 'missing_tool', reason: '電腦上還沒設定' },
  ]
  const renderRow = (row: ConsoleDispatch) => renderToStaticMarkup(
    createElement(MobileApp, {
      initialPaired: true,
      initialToken: 'valid-test-token',
      initialDispatches: [row],
      initialTools: UNREADY_TOOLS,
      initialAuto: null,
    }),
  )

  it('讀不到可執行的 AI，還在跑的無頭 CLI 仍看得到「這輪完成後送出」', () => {
    const html = renderRow(LIVE_CLI)

    expect(html).toContain('補一句（這輪完成後送出）')
    expect(html).toContain('這一輪跑完後才會送出')
    // 就緒度確實是讀不到的狀態，但那只擋新派工，不擋補話
    expect(html).toContain('還沒有確認可以執行工作的 AI')
  })

  it('同一組情境換成本機問答（tool=local／mode=sync）：完全沒有補一句入口', () => {
    const html = renderRow({ ...LOCAL_ROW, state: 'running' })

    expect(html).not.toContain('💬 補一句')
    expect(html).not.toContain('補一句（這輪完成後送出）')
    expect(html).toContain('本機問答請回原對話接續')
  })

  it.each([
    ['執行中的無頭 CLI', { mode: 'headless', tool: 'claude' }, true],
    ['已完成的無頭 CLI', { mode: 'headless', tool: 'codex' }, true],
    ['本機問答（tool=local）', { mode: 'headless', tool: 'local' }, false],
    ['同步問答（mode=sync）', { mode: 'sync', tool: 'claude' }, false],
    ['終端互動', { mode: 'terminal', tool: 'kimi' }, false],
    ['沒有資料', null, false],
  ] as [string, { mode?: string; tool?: string } | null, boolean][])(
    'canFollowupRecord：%s',
    (_name, record, expected) => {
      expect(canFollowupRecord(record)).toBe(expected)
    },
  )
})

describe('原始碼契約：意圖綁定確實接到畫面上', () => {
  const SOURCE = readFileSync(new URL('./MobileApp.tsx', import.meta.url), 'utf8')

  /** 只取單一函式區塊，避免整檔快照式的脆弱比對 */
  function sourceBlock(name: string): string {
    const start = SOURCE.indexOf(`const ${name} = `)
    expect(start).toBeGreaterThan(-1)
    const end = SOURCE.indexOf('\n  const ', start + 1)
    return SOURCE.slice(start, end > start ? end : SOURCE.length)
  }

  it('handleDispatch 用工單專屬傳輸與存活判定，不直接用全域 fetch', () => {
    const block = sourceBlock('handleDispatch')

    expect(block).toContain('beginIntent()')
    expect(block).toContain('intentFetch(intent)')
    expect(block).toContain('intentAlive(intent)')
    expect(block).not.toMatch(/fetch:\s*fetch\b/)
  })

  it('意圖三件套接到 remoteApi 的快照函式', () => {
    expect(SOURCE).toContain('capturePairing(pairingAttempt.current)')
    expect(SOURCE).toContain('isPairingIntact(intent, pairingAttempt.current)')
    expect(SOURCE).toContain('createSnapshotFetch(intent')
  })

  it('runControl 是唯一的 attemptControl 呼叫點，且同樣綁定意圖', () => {
    const block = sourceBlock('runControl')

    expect(block).toContain('beginIntent()')
    expect(block).toContain('intentFetch(intent)')
    expect(block).toContain('intentAlive(intent)')
    expect(block).toContain('await attemptControl(')
    expect(SOURCE.match(/await attemptControl\(/g) ?? []).toHaveLength(1)
  })

  it.each([
    ['stop', 'handleStop'],
    ['cancel', 'handleCancel'],
    ['retry', 'handleRetry'],
    ['followup', 'handleSendFollowup'],
  ] as [string, string][])(
    '%s 一律經由共用的 runControl',
    (action, handler) => {
      const block = sourceBlock(handler)
      expect(block).toContain(`runControl('${action}'`)
      expect(block).not.toContain('attemptControl(')
    },
  )

  it('列表算繪用 canFollowupRecord 判資格，不是舊的 !live', () => {
    expect(SOURCE).toContain('const canFollowup = canFollowupRecord(d)')
    expect(SOURCE).toContain('const queuedFollowup = canFollowup && live')
    expect(SOURCE).not.toMatch(/canFollowup\s*=\s*[^\n]*!\s*live/)
  })
})
