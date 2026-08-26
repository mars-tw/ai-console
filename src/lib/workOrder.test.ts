// 引導產出的工單長什麼樣。
//
// 這個組裝器值得測，是因為它的錯法全部都很安靜：組出來的工單一定「看起來
// 是一份工單」，只有派出去之後才會發現 agent 理解成別的意思。
import { describe, expect, it } from 'vitest'
import { GUIDE_STEPS, buildOrder } from './workOrder'

describe('引導組出來的工單', () => {
  it('只填目標時，工單就只有目標', () => {
    const s = buildOrder({ goal: '把 p52 卡在哪裡確認清楚' })
    expect(s).toBe('把 p52 卡在哪裡確認清楚')
  })

  it('跳過的問題不會留下一個空標題', () => {
    // 這是這個函式存在的主要理由。「【範圍】」底下什麼都沒有，
    // 讀起來是「這件事沒有範圍限制」—— 那是一句錯的話，
    // 比整段不寫更糟，因為 agent 會照著那句錯的話放手去做。
    const s = buildOrder({ goal: '做一件事', scope: '', done: '   ', never: '' })
    expect(s).not.toContain('【範圍】')
    expect(s).not.toContain('【完成標準】')
    expect(s).not.toContain('【不可以做的事】')
  })

  it('填了的段落照順序出現', () => {
    const s = buildOrder({
      goal: '確認 R12 現況',
      scope: 'wp-sites 底下的設定',
      done: '說得出哪些已生效',
      never: '不要重跑 wrapper',
    })
    expect(s.indexOf('確認 R12 現況')).toBeLessThan(s.indexOf('【範圍】'))
    expect(s.indexOf('【範圍】')).toBeLessThan(s.indexOf('【完成標準】'))
    expect(s.indexOf('【完成標準】')).toBeLessThan(s.indexOf('【不可以做的事】'))
    expect(s).toContain('不要重跑 wrapper')
  })

  it('對話背景放在最後面，不是最前面', () => {
    // 實測踩過的順序問題：背景放最前面時，agent 讀到的第一件事是
    // 一段別人的對話，於是它開始「回應那段對話」而不是執行工單。
    const s = buildOrder(
      { goal: '接續這件事' },
      { recent: [{ role: 'user', text: '我們剛剛在討論 canvas width' }] },
    )
    expect(s.indexOf('接續這件事')).toBeLessThan(s.indexOf('背景'))
    expect(s).toContain('canvas width')
  })

  it('背景只取最後 6 則，而且每則會截斷', () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `第${i}則` + 'x'.repeat(600) }))
    const s = buildOrder({ goal: 'g' }, { recent })
    expect(s).toContain('第19則')
    expect(s).not.toContain('第13則')          // 第 14~19 則才會進去
    expect(s).not.toContain('x'.repeat(400))   // 單則截在 300 字
  })

  it('背景裡的換行會被壓平 —— 不然一則多行訊息會看起來像好幾則', () => {
    const s = buildOrder({ goal: 'g' }, { recent: [{ role: 'assistant', text: 'a\n\nb\nc' }] })
    expect(s).toContain('AI：a b c')
  })

  it('沒有對話可帶的時候不會生出一個空的背景段', () => {
    expect(buildOrder({ goal: 'g' }, { recent: [] })).not.toContain('背景')
    expect(buildOrder({ goal: 'g' }, {})).not.toContain('背景')
  })

  it('有專案目錄就寫進工單 —— 派工要靠它才問得出改了什麼', () => {
    const s = buildOrder({ goal: 'g' }, { dir: 'C:\\proj\\x' })
    expect(s).toContain('C:\\proj\\x')
  })

  it('目標空白時給得出一份還讀得懂的工單，不是空字串', () => {
    // 目標本來就不能跳過（UI 擋著），但這個函式不能假設呼叫端一定守規矩 ——
    // 回空字串的話，派工端只會說「需要 task」，使用者看不出是哪裡沒填。
    expect(buildOrder({}).trim()).not.toBe('')
  })
})

describe('引導的四個問題', () => {
  it('目標與完成標準不可跳過，其餘可跳過', () => {
    // 跳掉這兩個等於回到「派一句話出去」，引導就沒有意義了
    const req = GUIDE_STEPS.filter((s) => !s.optional).map((s) => s.key)
    expect(req).toEqual(['goal', 'done'])
  })

  it('每一題都有提示與例子 —— 只有問句的空格子沒有人填得下去', () => {
    for (const s of GUIDE_STEPS) {
      expect(s.ask.length).toBeGreaterThan(0)
      expect(s.hint.length).toBeGreaterThan(0)
      expect(s.eg.length).toBeGreaterThan(0)
    }
  })
})
