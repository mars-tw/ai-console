import { describe, expect, it } from 'vitest'
import {
  IMPORT_GUIDE_LINKS,
  IMPORT_GUIDE_STEPS,
  additionalConversationSources,
  conversationSourceCounts,
  extraScanRoots,
  normalizeSourceHealth,
  requestConversationSync,
  scanCoverageWarning,
  scanReasonText,
  scanReasons,
  scanRoots,
  sourceCount,
  sourceNeedsAttention,
  sourceReasonText,
  sourceStatusLabel,
  sourceTone,
  syncCompletionSummary,
} from './ConversationSync'
import type { ConversationSourceHealth } from './ConversationSync'
import type { ConversationScanReport, ConversationSummary, IndexData } from '@/types/data'

function conversation(
  id: string,
  tool: ConversationSummary['tool'],
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    tool,
    toolLabel: tool,
    sessionId: id,
    title: `${tool} 對話`,
    project: 'other',
    projectDir: 'C:\\work',
    path: `C:\\work\\${id}.jsonl`,
    size: 100,
    mtime: 1_800_000_000_000,
    lastTs: '',
    msgCount: 2,
    subagent: false,
    resume: 'resume',
    hasMessages: true,
    inApp: true,
    ...extra,
  }
}

function indexWith(conversations: ConversationSummary[]): IndexData {
  return {
    generated_at: '2026-08-31T00:00:00Z',
    projects: [],
    tools: {},
    projectTitles: {},
    conversations,
    stats: { total: conversations.length, subagent: 0, elapsed_sec: 0 },
  }
}

function health(id: ConversationSourceHealth['id'], extra: Partial<ConversationSourceHealth> = {}): ConversationSourceHealth {
  return { id, label: id, status: 'ok', count: 0, ...extra }
}

const ZERO = { codex: 0, claude: 0, qwen: 0, kimi: 0 }

describe('對話匯入／同步摘要', () => {
  it('會先用真正的 POST 同步，再讀回新索引', async () => {
    const next = indexWith([conversation('c1', 'codex')])
    const calls: { url: string; method?: string; cache?: RequestCache; body?: BodyInit | null }[] = []
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, cache: init?.cache, body: init?.body })
      return calls.length === 1
        ? new Response(JSON.stringify({
          ok: true,
          sources: [{ id: 'codex', label: 'Codex', status: 'ok', count: 1 }],
        }), { status: 200 })
        : new Response(JSON.stringify(next), { status: 200 })
    }

    await expect(requestConversationSync(fakeFetch)).resolves.toEqual({
      index: next,
      sources: [{ id: 'codex', label: 'Codex', status: 'ok', count: 1 }],
      malformedSources: 0,
    })
    expect(calls[0]).toEqual({ url: '/api/refresh', method: 'POST', cache: undefined, body: JSON.stringify({ rescan: true, deep: false }) })
    expect(calls[1]?.url).toMatch(/^\/data\/index\.json\?sync=\d+$/)
    expect(calls[1]?.cache).toBe('no-store')
  })

  it('sends explicit expanded-search options and unique user-chosen roots', async () => {
    const roots = extraScanRoots(' C:\\extra\r\n\nC:\\other\nC:\\extra ')
    expect(roots).toEqual(['C:\\extra', 'C:\\other'])
    const calls: RequestInit[] = []
    await requestConversationSync(async (_url, init) => {
      calls.push(init || {})
      return new Response(JSON.stringify(calls.length === 1 ? { ok: true } : indexWith([])))
    }, undefined, { deep: true, extraRoots: roots })
    expect(JSON.parse(String(calls[0].body))).toEqual({ rescan: true, deep: true, extraRoots: roots })
  })

  it('keeps partial coverage visible even if all four source counts are nonzero', () => {
    const report: ConversationScanReport = {
      complete: false, reasons: ['time_budget'], deep: true, startedAt: '', durationMs: 10,
      candidates: 4, directories: 5, filesInspected: 10, matchedFiles: 4, skippedFiles: 0,
      skippedDirectories: 1, unsupportedFiles: 0, roots: ['C:\\extra'],
    }
    expect(scanCoverageWarning(report)).toBe(true)
    const all = syncCompletionSummary({ codex: 2, claude: 2, qwen: 2, kimi: 2 }, [
      health('codex', { count: 2 }), health('claude', { count: 2 }), health('qwen', { count: 2 }), health('kimi', { count: 2 }),
    ])
    expect(all.needsAttention).toBe(0)
    expect(scanCoverageWarning({ ...report, complete: true, reasons: [] })).toBe(false)
    expect(scanCoverageWarning()).toBe(false)
    expect(scanReasonText('time-limit')).toContain('搜尋時間')
    expect(scanReasonText('unsupported-format')).toContain('格式')
  })

  it('同步失敗時不會伪造新索引或成功數字', async () => {
    const fakeFetch = async () => new Response(
      JSON.stringify({ ok: false, error: '掃描器無法讀取' }),
      { status: 500 },
    )
    await expect(requestConversationSync(fakeFetch)).rejects.toThrow('掃描器無法讀取')
  })

  it('讀回的索引格式壞掉時，回報誠實錯誤而不是假成功', async () => {
    let call = 0
    await expect(requestConversationSync(async () => {
      call += 1
      return call === 1
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(JSON.stringify({ conversations: 'nope' }))
    })).rejects.toThrow('索引格式無法辨識')
  })

  it('只把原 AI 側欄的正本主對話算進新手數字', () => {
    const counts = conversationSourceCounts(indexWith([
      conversation('c1', 'codex'),
      conversation('c2', 'codex', { subagent: true }),
      conversation('a1', 'claude'),
      conversation('q1', 'qwen', { dup: true }),
      conversation('k1', 'kimi', { inApp: false }),
    ]))

    expect(counts).toEqual({ codex: 1, claude: 1, qwen: 0, kimi: 0 })
  })

  it('另外列出發現的唯讀來源，並保持四個權威側欄計數獨立', () => {
    const index = indexWith([
      conversation('c1', 'codex'),
      conversation('o1', 'other-ai', { sourceKind: 'discovered', readOnly: true, inApp: false }),
      conversation('o2', 'other-ai', { sourceKind: 'discovered', readOnly: true, inApp: false }),
    ])
    expect(additionalConversationSources(index)).toEqual([{ id: 'other-ai', label: 'other-ai', count: 2 }])
    expect(conversationSourceCounts(index)).toEqual({ codex: 1, claude: 0, qwen: 0, kimi: 0 })
  })

  it('四個 optional ＋ 一個唯讀來源＝總數 1、零個需要處理', () => {
    const optional = [health('codex', { status: 'optional' }), health('claude', { status: 'optional' }), health('qwen', { status: 'optional' }), health('kimi', { status: 'optional', needsAttention: false })]
    expect(syncCompletionSummary(ZERO, optional, { additionalTotal: 1 }))
      .toEqual({ total: 1, originalTotal: 0, additionalTotal: 1, needsAttention: 0 })
  })

  it('後端沒回報來源且份數為 0 時，不推論出四個故障', () => {
    expect(syncCompletionSummary({ codex: 3, claude: 2, qwen: 0, kimi: 0 }))
      .toEqual({ total: 5, originalTotal: 5, additionalTotal: 0, needsAttention: 0 })
    expect(sourceNeedsAttention(undefined, { current: 0, previous: 0 })).toBe(false)
  })

  it('optional／empty 是中性狀態，不會叫使用者去安裝所有 AI', () => {
    const optional = health('qwen', { status: 'optional' })
    const empty = health('kimi', { status: 'empty' })
    expect(sourceTone(optional, 0, false)).toBe('neutral')
    expect(sourceStatusLabel(optional, 0, false)).toBe('尚未使用，可略過')
    expect(sourceTone(empty, 0, false)).toBe('neutral')
    expect(sourceStatusLabel(empty, 0, false)).toBe('還沒有對話')
  })

  it('真正的 warning／error 一定要處理，份數是 0 或大於 0 都一樣', () => {
    const warning = health('codex', { status: 'warning', count: 0, reason: '有些檔案無法讀取' })
    const busy = health('claude', { status: 'warning', count: 7, reason: '中繼資料無法確認' })
    expect(sourceNeedsAttention(warning)).toBe(true)
    expect(sourceNeedsAttention(busy, { current: 7 })).toBe(true)
    expect(sourceTone(busy, 7, true)).toBe('warning')
    expect(sourceNeedsAttention(health('kimi', { status: 'error', count: 3, reason: '資料庫無法開啟' }))).toBe(true)
  })

  it('已知 missing 有對話數才算需要處理', () => {
    const missing = health('codex', { status: 'missing', count: 0 })
    expect(sourceNeedsAttention(missing)).toBe(false)
    expect(sourceStatusLabel(missing, 0, false)).toBe('尚未使用，可略過')
    expect(sourceNeedsAttention(missing, { previous: 4 })).toBe(true)
    expect(sourceNeedsAttention(health('codex', { status: 'missing', count: 2 }))).toBe(true)
    expect(sourceNeedsAttention(health('codex', { status: 'missing', needsAttention: true, count: 0 }))).toBe(true)
    expect(sourceStatusLabel(missing, 2, true)).toBe('找不到對話來源')
  })

  it('needsAttention:false 不能蓋掉真正的 error 或 warning', () => {
    expect(sourceNeedsAttention(health('codex', { status: 'error', needsAttention: false, reason: '讀取失敗' }))).toBe(true)
    expect(sourceNeedsAttention(health('claude', { status: 'warning', needsAttention: false }))).toBe(true)
    expect(sourceTone(health('codex', { status: 'error', needsAttention: false, count: 5 }), 5, true)).toBe('error')
  })

  it('完成摘要含唯讀匯入，不會把唯讀對話說成原 AI 可開啟', () => {
    const summary = syncCompletionSummary({ codex: 1, claude: 0, qwen: 0, kimi: 0 }, [
      health('codex', { count: 1 }), health('claude', { status: 'optional' }),
      health('qwen', { status: 'optional' }), health('kimi', { status: 'optional' }),
    ], { additionalTotal: 2 })
    expect(summary).toEqual({ total: 3, originalTotal: 1, additionalTotal: 2, needsAttention: 0 })
    expect(summary.originalTotal).toBeLessThan(summary.total)
  })

  it('壞掉的來源列不會 crash，也不會被當成 0 份或成功', () => {
    const parsed = normalizeSourceHealth([
      null,
      { id: 'nope', status: 'ok', count: 1 },
      { id: 'codex', status: 'weird', count: 1 },
      { id: 'claude', label: 'Claude', status: 'error', count: 'many', reason: { code: 1 } },
    ])
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.malformed).toBe(4)
    const bad = parsed.sources[0]
    expect(sourceCount(bad, 6)).toBe(6)
    expect(sourceNeedsAttention(bad, { current: 6 })).toBe(true)
    expect(sourceReasonText(bad)).toEqual(expect.any(String))
    expect(sourceReasonText(bad)).not.toContain('object')
    expect(normalizeSourceHealth(undefined)).toEqual({ sources: [], malformed: 0 })
    expect(normalizeSourceHealth('boom')).toEqual({ sources: [], malformed: 1 })
  })

  it('壞掉的掃描中繼資料不會被直接 map／render', () => {
    const broken = { complete: true, reasons: null, roots: [1, 'C:\\ok'] } as unknown as ConversationScanReport
    expect(scanReasons(broken)).toEqual([])
    expect(scanRoots(broken)).toEqual(['C:\\ok'])
    expect(scanReasons()).toEqual([])
    expect(conversationSourceCounts({ conversations: null } as unknown as IndexData)).toEqual(ZERO)
    expect(additionalConversationSources({ conversations: [null] } as unknown as IndexData)).toEqual([])
  })

  it('新手指引只有三步，且只連已驗證的官方說明', () => {
    expect(IMPORT_GUIDE_STEPS).toHaveLength(3)
    expect(IMPORT_GUIDE_STEPS[0]).toContain('官方匯出')
    expect(IMPORT_GUIDE_STEPS[1]).toContain('ZIP')
    expect(IMPORT_GUIDE_STEPS[2]).toContain('資料夾')
    expect(IMPORT_GUIDE_LINKS.map(link => link.href)).toEqual([
      'https://support.claude.com/en/articles/9450526-export-your-claude-data',
      'https://lmstudio.ai/docs/app/basics/chat',
    ])
    expect(JSON.stringify(IMPORT_GUIDE_STEPS).toLowerCase()).not.toContain('chatgpt')
  })
})
