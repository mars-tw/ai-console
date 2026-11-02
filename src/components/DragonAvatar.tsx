import { useState } from 'react'

// 精確對照既有素材；未知或未歸屬工具不推測角色身分。
const SHEETS = new Map([
  ['kimi', 'kimi'], ['claude', 'claude'], ['codex', 'codex'], ['grok', 'grok'],
  ['qwen', 'qwen'], ['cursor', 'cursor'], ['gemini', 'gemini'],
])

interface Props {
  tool: string | null
  status: string
}

/** 4×3、每格 48px 的既有素材只作裝飾；任務狀態仍以文字及來源資料為準。 */
export default function DragonAvatar({ tool, status }: Props) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const sheet = tool ? SHEETS.get(tool) : undefined
  const source = sheet ? `/office/sprites/${sheet}.png` : null
  const pose = status === 'running' ? 'running'
    : status === 'waiting' ? 'waiting'
      : status === 'rate_limited' ? 'resting' : 'neutral'
  const frame = pose === 'running' ? 6 : pose === 'resting' ? 7 : 0

  return (
    <span className={`wm-dragon wm-dragon--${pose}`} aria-hidden="true">
      <span className="wm-dragon-clip">
        {source && failedSource !== source
          ? <img className="wm-dragon-sheet" src={source} alt="" draggable={false} decoding="async" loading="lazy" style={{ left: `${-(frame % 4) * 48}px`, top: `${-Math.floor(frame / 4) * 48}px` }} onError={() => setFailedSource(source)} />
          : <span className="wm-dragon-fallback">✦</span>}
      </span>
      <span className="wm-dragon-state" />
    </span>
  )
}
