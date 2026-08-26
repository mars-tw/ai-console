/**
 * 引導寫工單：四個問題，以及把答案組成一份工單。
 *
 * 為什麼是這四個、為什麼不多不少：
 *   目標    —— 沒有它，agent 不知道什麼時候該停
 *   範圍    —— 沒有它，agent 會動到你沒想過的檔案
 *   完成標準 —— 沒有它，「做完了」變成它說了算
 *   禁止    —— 沒有它，不可逆的動作沒有護欄
 * 少一個都會在真實派工裡出事，多一個就沒有人願意填完。
 *
 * 放 lib 不放元件檔：這裡全是純函式與常數，元件只負責畫。
 * 混在一起的話測試要連著 React 一起載，而且 fast refresh 會失效。
 */
import { t } from '@/i18n'

export type Msg = { role: string; text: string }

export type GuideStep = {
  key: 'goal' | 'scope' | 'done' | 'never'
  ask: string
  hint: string
  eg: string
  /** 可以跳過的問題。目標與完成標準不能跳 —— 跳掉就回到「派一句話出去」 */
  optional?: boolean
}

export const GUIDE_STEPS: GuideStep[] = [
  {
    key: 'goal',
    ask: '你想讓它做什麼？',
    hint: '講你要的結果，不要講步驟。步驟是它的工作。',
    eg: '把 p52 現在到底卡在哪裡確認清楚',
  },
  {
    key: 'scope',
    ask: '會動到哪些檔案或資料夾？',
    hint: '寫得出路徑就寫路徑。留白的話它會自己決定範圍。',
    eg: 'pipeline/specs/ 底下的 p52 相關設定',
    optional: true,
  },
  {
    key: 'done',
    ask: '怎樣算做完？',
    hint: '一個你自己驗得出來的條件。沒有這個，「做完了」就變成它說了算。',
    eg: '跑得出 fixture 驗證結果，而且能說出失敗原因還在不在',
  },
  {
    key: 'never',
    ask: '有什麼絕對不能做？',
    hint: '這件事專屬的限制就好。這台機器的不可違反條款（GPU0、Gigastone、金鑰、金流授權）派工時會自動附上。',
    eg: '不要自己把 queue_authorized 翻成 true，那是治理旗標',
    optional: true,
  },
]

const SECTION: Record<GuideStep['key'], string> = {
  goal: '要做的事',
  scope: '範圍',
  done: '完成標準',
  never: '不可以做的事',
}

/** 背景最多帶幾則、每則最多幾字。帶太多的話 agent 的注意力會被別人的對話吃光 */
const CTX_MSGS = 6
const CTX_CHARS = 300

/**
 * 把引導的回答組成一份工單。
 *
 * 刻意**不輸出空的段落**。「【範圍】」底下什麼都沒有，讀起來像是
 * 「這件事沒有範圍限制」—— 那比整段不寫更糟，因為它是一句錯的話，
 * 而 agent 會照著那句錯的話放手去做。沒填就是沒有這一段。
 */
export function buildOrder(
  answers: Partial<Record<GuideStep['key'], string>>,
  ctx?: { title?: string; dir?: string; recent?: Msg[] },
): string {
  const goal = (answers.goal || '').trim()
  const parts: string[] = [goal || t('（沒有填目標）')]

  for (const key of ['scope', 'done', 'never'] as const) {
    const v = (answers[key] || '').trim()
    if (v) parts.push(`【${t(SECTION[key])}】\n${v}`)
  }

  if (ctx?.recent?.length) {
    // 背景放最後。放最前面的話，agent 讀到的第一件事是別人的對話紀錄，
    // 而不是它要做什麼 —— 那時它會開始「回應那段對話」而不是執行工單。
    const lines = ctx.recent.slice(-CTX_MSGS).map(
      (m) => `${m.role === 'assistant' ? 'AI' : '人'}：${m.text.replace(/\s+/g, ' ').slice(0, CTX_CHARS)}`,
    )
    parts.push(`【${t('背景：這段對話先前談到的')}】\n${lines.join('\n')}`)
  }
  if (ctx?.dir) parts.push(`${t('專案目錄')}：${ctx.dir}`)

  return parts.join('\n\n')
}
