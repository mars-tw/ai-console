import { describe, expect, it } from 'vitest'
import { conversationSourceCounts, requestConversationSync, syncCompletionSummary } from './ConversationSync'
import type { ConversationSummary, IndexData } from '@/types/data'

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

describe('對話匯入／同步摘要', () => {
  it('會先用真正的 POST 同步，再讀回新索引', async () => {
    const next = indexWith([conversation('c1', 'codex')])
    const calls: { url: string; method?: string; cache?: RequestCache }[] = []
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, cache: init?.cache })
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
    })
    expect(calls[0]).toEqual({ url: '/api/refresh', method: 'POST', cache: undefined })
    expect(calls[1]?.url).toMatch(/^\/data\/index\.json\?sync=\d+$/)
    expect(calls[1]?.cache).toBe('no-store')
  })

  it('同步失敗時不會伪造新索引或成功數字', async () => {
    const fakeFetch = async () => new Response(
      JSON.stringify({ ok: false, error: '掃描器無法讀取' }),
      { status: 500 },
    )
    await expect(requestConversationSync(fakeFetch)).rejects.toThrow('掃描器無法讀取')
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

  it('完成摘要回傳可翻譯的數字，不先拼成中文句子', () => {
    expect(syncCompletionSummary({ codex: 3, claude: 2, qwen: 0, kimi: 0 }))
      .toEqual({ total: 5, needsAttention: 2 })
    expect(syncCompletionSummary(
      { codex: 1, claude: 1, qwen: 1, kimi: 1 },
      [
        { id: 'codex', label: 'Codex', status: 'ok', count: 1 },
        { id: 'claude', label: 'Claude', status: 'ok', count: 1 },
        { id: 'qwen', label: 'Qwen', status: 'ok', count: 1 },
        { id: 'kimi', label: 'Kimi', status: 'ok', count: 1 },
      ],
    )).toEqual({ total: 4, needsAttention: 0 })
  })
})
