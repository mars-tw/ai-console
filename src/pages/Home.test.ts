import { describe, expect, it } from 'vitest'
import {
  BEGINNER_ACTIONS,
  beginnerSearchSnippets,
  conversationMatchesSearch,
  conversationPassesFilters,
  originalAiActionLabel,
  shouldShowSearchNoResults,
} from './Home'
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
  it('第一個畫面提供四個白話意圖入口', () => {
    expect(BEGINNER_ACTIONS).toEqual([
      '找回舊對話',
      '直接問 AI',
      '交給 AI 執行',
      '管理 AI 技能',
    ])
  })

  it('大對話的主動作不顯示 CLI 術語', () => {
    expect(originalAiActionLabel()).toBe('在原本的 AI 開啟')
    expect(originalAiActionLabel()).not.toMatch(/CLI|指令|路徑/)
  })
})

describe('對話搜尋', () => {
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
