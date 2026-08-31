import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import QuickDispatch from '@/components/QuickDispatch'
import officeSource from '@/components/Office.tsx?raw'
import {
  classifyInstallResponse,
  hasSkillConflict,
  installableTargetIds,
  installStatusText,
  validateFileCandidates,
} from '@/components/SkillCenter'

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
