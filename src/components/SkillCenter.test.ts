import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import QuickDispatch from '@/components/QuickDispatch'
import officeSource from '@/components/Office.tsx?raw'
import {
  classifyInstallResponse,
  canCopySkillSource,
  createPreviewSession,
  hasSkillConflict,
  installableTargetIds,
  installStatusText,
  validateFileCandidates,
  parseStarterCatalog,
  toolEvidenceText,
  copySkillPrompt,
  SkillUseGuide,
} from '@/components/SkillCenter'
import SkillCenter from '@/components/SkillCenter'

describe('提問與執行意圖分離', () => {
  it('QuickDispatch 自己提供執行草稿，不借用聊天輸入框', () => {
    const html = renderToStaticMarkup(createElement(QuickDispatch, {
      conv: null,
      recent: [],
      onToast: () => {},
    }))

    expect(html).toContain('交給 AI 執行')
    expect(html).toContain('id="qd-task"')
    expect(html).toContain('開始執行')
    expect(html).toContain('不是傳送問題')
  })
})

describe('Office 隱私邊界', () => {
  it('不再呼叫會讀取帳號資料的 /api/map', () => {
    expect(officeSource).not.toContain("fetch('/api/map')")
    expect(officeSource).toContain("fetch('/api/skills')")
    expect(officeSource).toContain('onClick={toggleSkillStatus}')
  })
})

describe('技能匯入安全流程', () => {
  it('預設入門來源且 ZIP 仍可使用，沒有預選安裝目標', () => {
    const html = renderToStaticMarkup(createElement(SkillCenter))
    expect(html).toMatch(/name="skill-source"[^>]*checked=""[^>]*value="starter"/)
    expect(html).toContain('ZIP 技能包')
    expect(html).not.toContain('name="skill-install-target"')
  })

  it('拒絕格式錯誤的入門清單並複製合法的一般 ZIP 資料', () => {
    const entry = { id: 'a', name: 'starter-a', title: 'A', description: 'purpose', testPrompt: 'try', package: { kind: 'zip', data: 'UEs=' } }
    const valid = { ok: true, starters: [entry, { ...entry, id: 'b', name: 'starter-b' }] }
    const parsed = parseStarterCatalog(valid)
    expect(parsed[0].package).toEqual({ kind: 'zip', data: 'UEs=' })
    parsed[0].package.data = 'changed'
    expect(entry.package.data).toBe('UEs=')
    for (const invalid of [null, [], { ok: true }, { ...valid, ok: false }, { ...valid, starters: [entry, entry] }, { ...valid, starters: [entry, { ...entry, id: 'b', title: {} }] }]) {
      expect(() => parseStarterCatalog(invalid)).toThrow('可改用 ZIP')
    }
  })

  it('工具不存在或只找到執行檔，都不能宣稱已登入或執行成功', () => {
    expect(toolEvidenceText()).toContain('AI 尚未安裝')
    expect(toolEvidenceText(false)).toContain('可先存放技能')
    expect(toolEvidenceText(true)).toContain('登入與實際執行仍待驗證')
    expect(installableTargetIds([{ id: 'codex', label: 'Codex', status: 'unavailable', toolInstalled: true }])).toEqual([])
    expect(classifyInstallResponse({ ok: true }).success).toBeNull()
    expect(classifyInstallResponse({ ok: true, results: [{ target: 'codex', status: 'failed' }] }).success).toBeNull()
  })

  it('安裝後提供可選取提示詞，剪貼簿失敗仍有手動複製路徑', async () => {
    const prompt = '請使用 starter-a 技能測試'
    expect(await copySkillPrompt(prompt, async () => { throw new Error('denied') })).toContain('手動複製')
    let copied = ''
    expect(await copySkillPrompt(prompt, async (text) => { copied = text })).toContain('尚未執行 AI')
    expect(copied).toBe(prompt)
    const html = renderToStaticMarkup(createElement(SkillUseGuide, { prompt }))
    expect(html).toMatch(/readonly=""/i)
    expect(html).toContain(prompt)
    expect(html).toContain('接入 AI')
    expect(html).toContain('重新啟動')
    expect(html).toContain('實際回答')
  })
  it('來源變更或取消後，晚到的成功與失敗都不可取代目前預覽', async () => {
    const session = createPreviewSession()
    const first = session.begin()
    let finishFirst!: () => void
    const lateResponse = new Promise<void>((resolve) => { finishFirst = resolve })
    const adopted: string[] = []
    const pending = lateResponse.then(() => { if (first.isCurrent()) adopted.push('old') })
    session.cancel()
    const next = session.begin()
    finishFirst()
    await pending
    expect(first.signal.aborted).toBe(true)
    expect(adopted).toEqual([])
    expect(next.isCurrent()).toBe(true)
    session.cancel()
    expect(next.isCurrent()).toBe(false)
    expect(session.begin().isCurrent()).toBe(true)
  })

  it('只有該來源通過格式檢查時才能複製，不借用另一個 AI 的通過結果', () => {
    const skill = {
      name: 'shared-skill', source: 'claude', validationStatus: 'valid-format' as const,
      validationByTarget: {
        claude: { status: 'valid-format' as const },
        codex: { status: 'invalid' as const, reason: 'Missing description' },
        qwen: { status: 'unverified' as const },
      },
    }
    expect(canCopySkillSource(skill, 'claude')).toBe(true)
    expect(canCopySkillSource(skill, 'codex')).toBe(false)
    expect(canCopySkillSource(skill, 'qwen')).toBe(false)
    expect(canCopySkillSource(skill, 'kimi')).toBe(false)
    expect(canCopySkillSource({ name: 'legacy', source: 'codex' }, 'codex')).toBe(false)
  })

  it('資料夾必須含 SKILL.md，並在上傳前擋下超量檔案', () => {
    expect(validateFileCandidates([
      { path: 'my-skill/SKILL.md', size: 100 },
      { path: 'my-skill/references/help.md', size: 200 },
    ])).toBe('')

    expect(validateFileCandidates([{ path: 'readme.md', size: 100 }])).toContain('找不到 SKILL.md')
    expect(validateFileCandidates([{ path: 'skill/SKILL.md', size: 201 }], { maxFileBytes: 200 })).toContain('太大')
  })

  it('衝突目標不會進入可安裝清單', () => {
    const targets = [
      { id: 'codex', label: 'Codex', status: 'available' as const },
      { id: 'claude', label: 'Claude', status: 'conflict' as const },
      { id: 'qwen', label: 'Qwen', status: 'installed' as const },
    ]
    expect(hasSkillConflict(targets)).toBe(true)
    expect(installableTargetIds(targets)).toEqual(['codex'])
  })

  it('安裝完成仍誠實標示要等真實執行驗證', () => {
    expect(installStatusText({ target: 'codex', status: 'installed' }))
      .toBe('已安裝，等待實際執行驗證')
    expect(installStatusText({ target: 'claude', status: 'conflict' }))
      .toBe('同名內容不同，未安裝')
  })

  it('失敗回應保留逐工具原因，但不會被當成成功鎖定', () => {
    const response = {
      ok: false,
      status: 'conflict',
      error: '沒有寫入',
      results: [{ target: 'codex', status: 'conflict', reason: '同名技能剛剛已存在' }],
    }
    const outcome = classifyInstallResponse(response)
    expect(outcome.success).toBeNull()
    expect(outcome.failure?.results?.[0]?.target).toBe('codex')
    expect(installStatusText(response.results[0])).toBe('同名技能剛剛已存在')
  })
})
