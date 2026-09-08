import { describe, expect, it } from 'vitest'
// 來源契約：同步鎖的歸屬與紅字來源沒有純函式介面，用原始碼比對釘住它們。
import homeSource from './Home.tsx?raw'
import {
  BEGINNER_ACTIONS,
  beginnerSearchSnippets,
  conversationMatchesSearch,
  conversationPassesFilters,
  localChatEndpoint,
  localChatPreflightState,
  nextChatError,
  onlyChineseDefault,
  originalAiActionLabel,
  ownsChatResponse,
  persistSelectedConversation,
  planLocalChatSend,
  planSetupReturn,
  restoreChatDraft,
  rollbackChatMessages,
  SELECTED_KEY,
  setupReturnModel,
  shouldShowSearchNoResults,
  sidebarVisible,
} from './Home'
import type { ChatErrorState, ChatMsg } from './Home'
import type { LocalSetupInfo } from '@/components/AskAI'
import type { ConversationSummary } from '@/types/data'

const base: ConversationSummary = {
  id: 'one',
  tool: 'codex',
  toolLabel: 'Codex',
  sessionId: 'one',
  title: '新手的第一份對話',
  project: 'other',
  projectDir: 'C:\\work',
  path: 'C:\\work\\one.jsonl',
  size: 5_000_000,
  mtime: 1_800_000_000_000,
  lastTs: '',
  msgCount: 0,
  subagent: false,
  resume: 'codex resume one',
  hasMessages: false,
  inApp: true,
}

const normalFilters = {
  showTrash: false,
  showSubagent: false,
  showDup: false,
  showOld: false,
  showDispatch: false,
  onlyCJK: true,
  cutoff: 1_700_000_000_000,
}

describe('新手首頁', () => {
  it('地端模型清單尚未載入或空白時，續聊選單停用且不預設顯示自動路由', () => {
    const selector = homeSource.slice(homeSource.indexOf('disabled={localSetupLoading || !readyModels.length}'), homeSource.indexOf('disabled={localSetupLoading || !readyModels.length}') + 750)
    expect(selector).toContain("value={localSetupLoading || !readyModels.length ? '' : chatModel}")
    expect(selector).toContain('localSetupLoading || !readyModels.length')
    expect(selector).toContain('<option value="" disabled>')
    expect(selector).toContain('尚未安裝地端模型')
    expect(selector).toContain(': <option value="auto">')
    expect(homeSource.match(/<SkillCenter onOpenSetup=/g)).toHaveLength(2)
  })
  it('第一個畫面提供四個白話意圖入口', () => {
    expect(BEGINNER_ACTIONS).toEqual([
      '找回舊對話',
      '直接問 AI',
      '交給 AI 執行',
      '管理 AI 技能',
    ])
  })

  it('大對話的主動作不顯示 CLI 術語', () => {
    expect(originalAiActionLabel()).toBe('繼續工作')
    expect(originalAiActionLabel()).not.toMatch(/CLI|指令|路徑/)
  })

  it('繼續工作改開中文對話框，不直接 POST /api/launch', () => {
    expect(homeSource).toContain('openContinueWork')
    expect(homeSource).toContain('<ContinueWorkDialog')
    expect(homeSource).not.toContain("fetch('/api/launch'")
    expect(homeSource).not.toContain('const launch =')
  })

  it('從繼續工作去設定會關閉對話框並可返回', () => {
    expect(homeSource).toContain('continueSetupId')
    expect(homeSource).toContain('openSetupFromContinueWork')
    expect(homeSource).toContain('returnToContinueWork')
    expect(homeSource).toContain('返回繼續工作')
    expect(homeSource).toContain('useCallback(() => setContinueTarget(null)')
  })
})

describe('對話搜尋', () => {
  it('不把新發現的唯讀來源當成過期的工具內對話隱藏', () => {
    expect(conversationPassesFilters({ ...base, tool: 'other-ai', sourceKind: 'discovered', readOnly: true, inApp: false, mtime: 1 }, normalFilters)).toBe(true)
    expect(conversationPassesFilters({ ...base, inApp: false, mtime: 1 }, normalFilters)).toBe(false)
  })
  it('能分辨「搜得到但被篩選收起」，不會當成沒有結果', () => {
    const worker = { ...base, id: 'worker', dispatch: true, inApp: false }
    expect(conversationMatchesSearch(worker, '第一份')).toBe(true)
    expect(conversationPassesFilters(worker, normalFilters)).toBe(false)
    expect(conversationPassesFilters(worker, { ...normalFilters, showDispatch: true })).toBe(true)
    expect(shouldShowSearchNoResults(0, 0, 1, false)).toBe(false)
    expect(shouldShowSearchNoResults(1, 0, 0, false)).toBe(false)
    expect(shouldShowSearchNoResults(0, 0, 0, false)).toBe(true)
    expect(shouldShowSearchNoResults(0, 0, 0, false, true)).toBe(false)
  })

  it('新手摘要會收起系統封包，但不刪除原資料', () => {
    const snippets = [
      { role: 'user', text: '<environment_context>technical</environment_context>' },
      { role: 'assistant', text: '這是真正的回答' },
      { role: 'tool', text: 'raw tool output' },
    ]
    expect(beginnerSearchSnippets(snippets)).toEqual([
      { role: 'assistant', text: '這是真正的回答' },
    ])
    expect(snippets).toHaveLength(3)
  })
})

describe('選取的對話寫進 storage', () => {
  const fakeStore = () => {
    const map = new Map<string, string>([[SELECTED_KEY, 'old'], ['ac_other', 'keep']])
    const calls: string[] = []
    return {
      map,
      calls,
      setItem: (key: string, value: string) => { calls.push(`set:${key}`); map.set(key, value) },
      removeItem: (key: string) => { calls.push(`remove:${key}`); map.delete(key) },
    }
  }

  it.each<[string, string | null, string | undefined, string[]]>([
    ['選了一份對話就只寫選取鍵', 'two', 'two', ['set:ac_selected']],
    ['回首頁就只清掉選取鍵', null, undefined, ['remove:ac_selected']],
  ])('%s', (_label, id, expected, calls) => {
    const store = fakeStore()
    expect(persistSelectedConversation(id, store)).toBe(true)
    expect(store.map.get(SELECTED_KEY)).toBe(expected)
    expect(store.map.get('ac_other')).toBe('keep')
    expect(store.calls).toEqual(calls)
  })

  it('已經是 null 也要再清一次，而且不碰其他鍵', () => {
    const store = fakeStore()
    expect(persistSelectedConversation(null, store)).toBe(true)
    expect(persistSelectedConversation(null, store)).toBe(true)
    expect(store.calls).toEqual(['remove:ac_selected', 'remove:ac_selected'])
    expect(store.map.get('ac_other')).toBe('keep')
  })

  it('沒有 storage 就回報失敗，不丟例外', () => {
    expect(persistSelectedConversation('two', null)).toBe(false)
    expect(persistSelectedConversation(null, null)).toBe(false)
  })

  it.each<[string, string | null]>([
    ['寫入丟例外', 'two'],
    ['清除丟例外', null],
  ])('%s 只回報失敗，不讓切換對話壞掉', (_label, id) => {
    const throwing = {
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(persistSelectedConversation(id, throwing)).toBe(false)
  })
})

const ready: LocalSetupInfo = { ready: true, state: 'ready', models: ['qwen', 'llama'] }

describe('地端續聊：沒準備好就不准動畫面', () => {
  it.each<[string, LocalSetupInfo | null, string, string]>([
    ['讀不到 /api/setup', null, 'auto', 'local_unavailable'],
    ['只有庫存清單、沒說可以載入', { models: ['qwen'] }, 'auto', 'local_not_ready'],
    ['ready 卻沒有可用模型', { ready: true, state: 'ready', models: [] }, 'auto', 'local_no_models'],
    ['選到的模型不在可用清單裡', ready, 'gone', 'local_model_missing'],
  ])('%s：送出／Enter 都擋在清空輸入框之前', (_label, local, model, reason) => {
    const plan = planLocalChatSend({ text: '接續上面那段', busy: false, local, localLoading: false, model })
    expect(plan).toEqual({ action: 'blocked', reason })
  })

  it('還在檢查、空字串與送出中都不會再送一次', () => {
    expect(planLocalChatSend({ text: '嗨', busy: false, local: null, localLoading: true, model: 'auto' }))
      .toEqual({ action: 'blocked', reason: 'loading' })
    expect(planLocalChatSend({ text: '   ', busy: false, local: ready, localLoading: false, model: 'auto' }))
      .toEqual({ action: 'ignore' })
    expect(planLocalChatSend({ text: '嗨', busy: true, local: ready, localLoading: false, model: 'auto' }))
      .toEqual({ action: 'ignore' })
  })

  it('準備好才放行，而且永遠是地端 /api/chat，不會自動改走雲端', () => {
    expect(planLocalChatSend({ text: ' 接續 ', busy: false, local: ready, localLoading: false, model: 'qwen' }))
      .toEqual({ action: 'send', text: '接續' })
    expect(localChatPreflightState({ local: ready, localLoading: false, model: 'auto' }))
      .toMatchObject({ connections: [], connectionsError: '' })
    expect(localChatPreflightState({ local: ready, localLoading: false, model: 'auto' }))
      .not.toHaveProperty('connectionId')
    expect(localChatEndpoint()).toBe('/api/chat')
  })
})

describe('送出失敗之後的草稿與提問', () => {
  const consumed = { conversationId: 'one', draft: '幫我接續', editSeq: 3 }

  it('路由或 POST 失敗，原封不動的草稿要放回輸入框', () => {
    expect(restoreChatDraft({ consumed, owns: true, currentInput: '', editSeq: 3 })).toBe('幫我接續')
  })

  it.each<[string, string, number, boolean]>([
    ['已經打了新的問題', '換個問題', 4, false],
    ['打了又自己清掉', '', 4, false],
    ['已經是別份對話或別次請求', '', 3, true],
  ])('%s 就不把舊句子長回來', (_label, currentInput, editSeq, stale) => {
    expect(restoreChatDraft({ consumed, owns: !stale, currentInput, editSeq })).toBeNull()
  })

  it('重試沒有吃草稿，所以也沒有東西要還', () => {
    expect(restoreChatDraft({ owns: true, currentInput: '', editSeq: 3 })).toBeNull()
  })

  it('只收回自己寫進去的那一則提問，別份對話一個字都不動', () => {
    const prior: ChatMsg[] = [{ role: 'user', text: '舊的' }]
    const echoed: ChatMsg[] = [...prior, { role: 'user', text: '幫我接續' }]
    const other: ChatMsg[] = [{ role: 'user', text: '另一份對話' }]
    expect(rollbackChatMessages(echoed, echoed, prior)).toBe(prior)
    expect(rollbackChatMessages(other, echoed, prior)).toBe(other)
    expect(rollbackChatMessages(other, null, prior)).toBe(other)
  })

  it('換過對話或又送了一次，晚到的回應不能蓋回畫面', () => {
    expect(ownsChatResponse({ requestSeq: 5, requestId: 5, selectedId: 'one', conversationId: 'one' })).toBe(true)
    expect(ownsChatResponse({ requestSeq: 6, requestId: 5, selectedId: 'one', conversationId: 'one' })).toBe(false)
    expect(ownsChatResponse({ requestSeq: 5, requestId: 5, selectedId: 'two', conversationId: 'one' })).toBe(false)
    expect(ownsChatResponse({ requestSeq: 5, requestId: 5, selectedId: null, conversationId: 'one' })).toBe(false)
  })
})

describe('去接入 AI 再回來', () => {
  it('地端設定完成就回原本那份對話，不自動送出、也不改選取以外的東西', () => {
    expect(planSetupReturn({ origin: 'one' })).toEqual({ view: 'list', conversationId: 'one', carryHistory: false })
  })

  it('選了雲端連線只另開新的問答，舊對話與草稿留在原地且不隨行', () => {
    const plan = planSetupReturn({ origin: 'one', connectionId: 'openai-1' })
    expect(plan).toEqual({ view: 'ask', conversationId: 'one', connectionId: 'openai-1', carryHistory: false })
    expect(plan.carryHistory).toBe(false)
  })

  it('不是從對話進來的設定，維持原本的問答流程', () => {
    expect(planSetupReturn({ origin: null })).toEqual({ view: 'ask', conversationId: null, connectionId: undefined, carryHistory: false })
  })
})

describe('窄視窗的側欄與既有偏好', () => {
  it('390px 回首頁收掉浮層，桌面的常駐偏好照舊', () => {
    expect(sidebarVisible({ pref: true, fallback: true, narrow: true, dismissed: true })).toBe(false)
    expect(sidebarVisible({ pref: true, fallback: true, narrow: false, dismissed: true })).toBe(true)
    expect(sidebarVisible({ pref: true, fallback: false, narrow: true, dismissed: false })).toBe(true)
    expect(sidebarVisible({ pref: undefined, fallback: true, narrow: false, dismissed: false })).toBe(true)
    expect(sidebarVisible({ pref: false, fallback: true, narrow: false, dismissed: false })).toBe(false)
  })

  it('只顯示有中文的對話仍然預設開著', () => {
    expect(onlyChineseDefault(null)).toBe(true)
    expect(onlyChineseDefault('1')).toBe(true)
    expect(onlyChineseDefault('0')).toBe(false)
    expect(conversationPassesFilters({ ...base, title: 'row_kind,id' }, normalFilters)).toBe(false)
  })
})

describe('設定完成回來要用哪個模型', () => {
  it('設定頁回報的地端模型是選用的：有給就沿用，沒給就不動原本的選擇', () => {
    expect(setupReturnModel('auto', 'qwen3')).toBe('qwen3')
    expect(setupReturnModel('auto', ' qwen3 ')).toBe('qwen3')
    expect(setupReturnModel('llama')).toBe('llama')
    expect(setupReturnModel('llama', '')).toBe('llama')
    expect(setupReturnModel('llama', '   ')).toBe('llama')
    expect(setupReturnModel('llama', 123)).toBe('llama')
    expect(setupReturnModel('llama', { model: 'ghost' })).toBe('llama')
  })

  it('回原對話與另開問答兩條路都吃同一個選用參數，而且不自動送出', () => {
    expect(homeSource).toContain('const startSetupChat = (connection?: AIConnection, localModel?: string) => {')
    expect(homeSource).toContain('setChatModel(current => setupReturnModel(current, localModel))')
    expect(homeSource).toContain("model: connection?.model || setupReturnModel('auto', localModel)")
    // 回原對話仍走既有的返回路徑，setupOrigin 與草稿由原本那條路負責。
    expect(homeSource).toContain('selectConversation(plan.conversationId)')
  })
})

describe('續聊紅字的來源與同步鎖', () => {
  const preflight: ChatErrorState = { kind: 'preflight', text: '地端 AI 還沒準備好，請先設定 AI 再送出。' }
  const failure: ChatErrorState = { kind: 'chat', text: '⚠️ HTTP 500' }

  it('地端恢復可用時只清掉過期的事前提示', () => {
    expect(nextChatError(preflight, true)).toBeNull()
    expect(nextChatError(null, true)).toBeNull()
  })

  it('真正的路由／傳輸失敗不會被一次狀態刷新吞掉', () => {
    expect(nextChatError(failure, true)).toBe(failure)
    expect(nextChatError(failure, false)).toBe(failure)
    expect(nextChatError(preflight, false)).toBe(preflight)
  })

  it('來源用旗標分辨，不是比對翻譯後的顯示字串', () => {
    expect(homeSource).toContain("setChatError(t(askBlockMessage(plan.reason)), 'preflight')")
    expect(homeSource).toContain('setChatErrorState((current) => nextChatError(current, !chatBlocked))')
    expect(homeSource).toContain('{chatError.text}')
  })

  it('舊請求的 finally 不會放開新對話那一次送出的同步鎖', () => {
    const finallyAt = homeSource.indexOf('} finally {', homeSource.indexOf('const runChat ='))
    expect(finallyAt).toBeGreaterThan(-1)
    const block = homeSource.slice(finallyAt, finallyAt + 700)
    const guardAt = block.indexOf('if (isCurrent()) {')
    const releaseAt = block.indexOf('chatInFlight.current = false')
    expect(guardAt).toBeGreaterThan(-1)
    expect(releaseAt).toBeGreaterThan(guardAt)
    // 換對話與清空仍然明確重置，不靠 finally 代勞。
    expect(homeSource).toContain('chatInFlight.current = false')
  })

  it('失敗善後只說我們真的知道的事，不宣稱「沒有送出」', () => {
    expect(homeSource).toContain('尚未確認回覆，問題已放回輸入框。')
    expect(homeSource).not.toContain('你的問題已經放回輸入框，沒有送出。')
  })
})
