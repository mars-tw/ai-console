/* eslint-disable react-refresh/only-export-components -- focused tests cover the import safety decisions */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'

type SourceKind = 'zip' | 'files' | 'installed' | 'url'
type WizardStep = 1 | 2 | 3
type TargetPreviewStatus = 'available' | 'installed' | 'conflict' | 'unavailable'

export interface SkillRecord {
  name: string
  description?: string
  source: string
  targets?: string[]
  installedTargets?: string[]
  conflicts?: { target: string; reason: string }[]
}

export interface SkillTarget {
  id: string
  label: string
  available?: boolean
  /** 舊版後端欄位；available 是對外契約，保留相容避免升級瞬間空白。 */
  ready?: boolean
  installedCount?: number
  /** 全域治理會套用所有 AI，只能作為複製來源，不開放新手精靈寫入。 */
  readOnly?: boolean
}

interface SkillLimits {
  maxFiles?: number
  maxArchiveBytes?: number
  maxTotalBytes?: number
  maxFileBytes?: number
  files?: number
  unpackedBytes?: number
  archiveBytes?: number
  fileBytes?: number
}

interface SkillsResponse {
  ok: boolean
  status?: string
  skills?: SkillRecord[]
  targets?: SkillTarget[]
  limits?: SkillLimits
  error?: string
}

export interface PreviewTarget {
  id: string
  label: string
  status: TargetPreviewStatus
  reason?: string
}

interface PreviewSkill {
  name: string
  description?: string
  folder?: string
  fileCount?: number
  totalBytes?: number
  files?: string[]
}

interface PreviewResponse {
  ok: boolean
  status: 'ready' | 'conflict'
  skill?: PreviewSkill
  targets?: PreviewTarget[]
  choices?: unknown[]
  code?: string
  error?: string
  help?: string
}

interface InstallResult {
  target: string
  label?: string
  status: 'installed' | 'failed' | 'conflict' | 'skipped' | string
  location?: string
  error?: string
  reason?: string
}

interface InstallResponse {
  ok: boolean
  status?: string
  results?: InstallResult[]
  code?: string
  error?: string
  help?: string
}

type PackagePayload =
  | { kind: 'zip'; data: string }
  | { kind: 'files'; files: { path: string; data: string }[] }
  | { kind: 'installed'; source: string; name: string }

const HARD_MAX_FILES = 100
const HARD_MAX_TOTAL_BYTES = 5 * 1024 * 1024
const HARD_MAX_FILE_BYTES = 2 * 1024 * 1024

export interface FileCandidate {
  path: string
  size: number
}

export function validateFileCandidates(
  files: FileCandidate[],
  limits: SkillLimits = {},
): string {
  const maxFiles = Math.min(limits.maxFiles ?? limits.files ?? HARD_MAX_FILES, HARD_MAX_FILES)
  const maxTotal = Math.min(limits.maxTotalBytes ?? limits.unpackedBytes ?? HARD_MAX_TOTAL_BYTES, HARD_MAX_TOTAL_BYTES)
  const maxFile = Math.min(limits.maxFileBytes ?? limits.fileBytes ?? HARD_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES)
  if (!files.length) return '請先選擇檔案'
  if (files.length > maxFiles) return `檔案太多，最多 ${maxFiles} 個`
  const tooLarge = files.find((file) => file.size > maxFile)
  if (tooLarge) return `${tooLarge.path} 太大，單檔上限 ${formatBytes(maxFile)}`
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > maxTotal) return `檔案總量太大，上限 ${formatBytes(maxTotal)}`
  if (!files.some((file) => /(^|\/)SKILL\.md$/i.test(file.path.replace(/\\/g, '/')))) {
    return '找不到 SKILL.md；請選擇完整的技能資料夾或 ZIP'
  }
  return ''
}

export function installableTargetIds(targets: PreviewTarget[]): string[] {
  return targets.filter((target) => target.status === 'available').map((target) => target.id)
}

export function hasSkillConflict(targets: PreviewTarget[]): boolean {
  return targets.some((target) => target.status === 'conflict')
}

export function installStatusText(result: InstallResult): string {
  if (result.status === 'installed') return '已安裝，等待實際執行驗證'
  if (result.status === 'conflict') return result.reason || '同名內容不同，未安裝'
  if (result.status === 'skipped') return '未選擇，已略過'
  return result.reason || result.error || '安裝失敗'
}

export function classifyInstallResponse(data: InstallResponse): {
  success: InstallResponse | null
  failure: InstallResponse | null
} {
  return data.ok
    ? { success: data, failure: null }
    : { success: null, failure: data }
}

export function skillErrorText(message: string): string {
  let match = message.match(/^操作失敗（HTTP (\d+)）$/)
  if (match) return t('操作失敗（HTTP {code}）', { code: match[1] })
  match = message.match(/^檔案太多，最多 (\d+) 個$/)
  if (match) return t('檔案太多，最多 {n} 個', { n: match[1] })
  match = message.match(/^(.+) 太大，單檔上限 (.+)$/)
  if (match) return t('{path} 太大，單檔上限 {size}', { path: match[1], size: match[2] })
  match = message.match(/^檔案總量太大，上限 (.+)$/)
  if (match) return t('檔案總量太大，上限 {size}', { size: match[1] })
  return t(message)
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${bytes} B`
}

function targetAvailable(target: SkillTarget): boolean {
  return target.available ?? target.ready ?? false
}

const TARGET_LABELS: Record<string, string> = {
  governance: '全域治理（唯讀來源）',
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  qwen: 'Qwen',
  kimi: 'Kimi',
}

function targetLabel(id: string, fallback?: string): string {
  return t(TARGET_LABELS[id] || fallback || id)
}

function filePath(file: File): string {
  return file.webkitRelativePath || file.name
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => null) as (T & { error?: string; help?: string }) | null
  if (!data) {
    throw new Error(`操作失敗（HTTP ${response.status}）`)
  }
  return data
}

function StepBadge({ number, current, done, children }: {
  number: WizardStep
  current: WizardStep
  done: boolean
  children: string
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 ${
      number === current ? 'border-line3 bg-panel text-ink' : 'border-line bg-elev/30 text-mute2'
    }`} aria-current={number === current ? 'step' : undefined}>
      <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-emerald-600 text-white' : 'bg-elev2 text-ink2'}`}>
        {done ? '✓' : number}
      </span>
      <span className="truncate text-xs font-medium">{children}</span>
    </div>
  )
}

export default function SkillCenter() {
  useLang()
  const [catalog, setCatalog] = useState<SkillsResponse | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [step, setStep] = useState<WizardStep>(1)
  const [sourceKind, setSourceKind] = useState<SourceKind>('zip')
  const [pickedFiles, setPickedFiles] = useState<File[]>([])
  const [installedChoice, setInstalledChoice] = useState('')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [packagePayload, setPackagePayload] = useState<PackagePayload | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<string[]>([])
  const [conflictChoice, setConflictChoice] = useState<'cancel' | 'available' | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [installResult, setInstallResult] = useState<InstallResponse | null>(null)
  const [installFailure, setInstallFailure] = useState<InstallResponse | null>(null)
  const firstError = useRef<HTMLDivElement>(null)

  const loadCatalog = async () => {
    setCatalogBusy(true)
    setCatalogError('')
    try {
      const data = await apiJson<SkillsResponse>('/api/skills')
      if (!data.ok) throw new Error(data.error || '目前無法讀取技能清單')
      setCatalog(data)
    } catch (loadError) {
      setCatalogError(loadError instanceof Error ? loadError.message : '目前無法讀取技能清單')
    } finally {
      setCatalogBusy(false)
    }
  }

  useEffect(() => { void loadCatalog() }, [])
  useEffect(() => { if (error) firstError.current?.focus() }, [error])

  const installedOptions = useMemo(() => {
    const rows = catalog?.skills || []
    return rows.flatMap((skill) => {
      const sources = skill.installedTargets?.length ? skill.installedTargets : [skill.source]
      return sources.filter(Boolean).map((source) => ({
        key: `${source}\u0000${skill.name}`,
        source,
        name: skill.name,
        description: skill.description || '',
      }))
    })
  }, [catalog])

  const clearAfterSource = () => {
    setPreview(null)
    setPackagePayload(null)
    setSelectedTargets([])
    setConflictChoice('')
    setInstallResult(null)
    setInstallFailure(null)
    setError('')
    setStep(1)
  }

  const chooseSource = (kind: SourceKind) => {
    setSourceKind(kind)
    setPickedFiles([])
    setInstalledChoice('')
    clearAfterSource()
  }

  const buildPackage = async (): Promise<PackagePayload> => {
    if (sourceKind === 'installed') {
      const chosen = installedOptions.find((option) => option.key === installedChoice)
      if (!chosen) throw new Error('請先選擇一個已安裝的技能')
      return { kind: 'installed', source: chosen.source, name: chosen.name }
    }
    const candidates = pickedFiles.map((file) => ({ path: filePath(file), size: file.size }))
    // ZIP 裡的 SKILL.md 要由後端安全解開後確認；資料夾可以在傳送前先擋掉選錯層級。
    const validation = sourceKind === 'zip'
      ? validateFileCandidates(
        candidates.map((file) => ({ ...file, path: file.path.replace(/\.zip$/i, '/SKILL.md') })),
        {
          maxFiles: 1,
          maxFileBytes: catalog?.limits?.maxArchiveBytes ?? catalog?.limits?.archiveBytes,
          maxTotalBytes: catalog?.limits?.maxArchiveBytes ?? catalog?.limits?.archiveBytes,
        },
      )
      : validateFileCandidates(candidates, catalog?.limits)
    if (validation) throw new Error(validation)
    if (sourceKind === 'zip') {
      if (pickedFiles.length !== 1 || !/\.zip$/i.test(pickedFiles[0].name)) throw new Error('請選擇一個 ZIP 技能包')
      return { kind: 'zip', data: await fileToBase64(pickedFiles[0]) }
    }
    return {
      kind: 'files',
      files: await Promise.all(pickedFiles.map(async (file) => ({ path: filePath(file), data: await fileToBase64(file) }))),
    }
  }

  const runPreview = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const payload = await buildPackage()
      const data = await apiJson<PreviewResponse>('/api/skills/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!data.ok || !data.skill) throw new Error(data.error || '無法預覽這個技能')
      setPackagePayload(payload)
      setPreview(data)
      // 安裝是外部寫入：不替使用者預選，更不一次灑到全部工具。
      setSelectedTargets([])
      setConflictChoice(hasSkillConflict(data.targets || []) ? '' : 'available')
      setStep(2)
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : '無法預覽這個技能')
    } finally {
      setBusy(false)
    }
  }

  const goToConfirm = () => {
    if (!selectedTargets.length) {
      setError('至少選擇一個可安裝的 AI')
      return
    }
    if (hasSkillConflict(preview?.targets || []) && conflictChoice !== 'available') {
      setError('請先選擇如何處理同名衝突；系統不會自動覆寫')
      return
    }
    setError('')
    setStep(3)
  }

  const install = async () => {
    if (!packagePayload || busy || !selectedTargets.length) return
    setBusy(true)
    setError('')
    setInstallResult(null)
    setInstallFailure(null)
    try {
      const data = await apiJson<InstallResponse>('/api/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...packagePayload, targets: selectedTargets }),
      })
      const outcome = classifyInstallResponse(data)
      setInstallResult(outcome.success)
      setInstallFailure(outcome.failure)
      if (!data.ok) {
        throw new Error([data.error, data.help].filter(Boolean).join('；') || '技能未安裝')
      }
      await loadCatalog()
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : '技能未安裝')
    } finally {
      setBusy(false)
    }
  }

  const resetWizard = () => {
    setPickedFiles([])
    setInstalledChoice('')
    clearAfterSource()
  }

  return (
    <div className="h-full overflow-y-auto bg-app px-4 py-5 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5">
          <p className="text-xs font-medium tracking-widest text-mute2">AI SKILL CENTER</p>
          <h1 className="mt-1 text-2xl font-bold">🧩 {t('AI 技能')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-mute2">
            {t('把一套工作方法交給 AI。這裡的「技能」是 AI 的操作說明，不是「冒險」頁裡的角色招式。')}
          </p>
        </header>

        <section className="mb-5" aria-labelledby="skill-overview-title">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="skill-overview-title" className="text-sm font-semibold">{t('各 AI 的技能狀態')}</h2>
            <button className="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-elev disabled:opacity-40" disabled={catalogBusy} onClick={() => void loadCatalog()}>
              {catalogBusy ? t('讀取中…') : t('重新整理')}
            </button>
          </div>
          {catalogBusy && !catalog ? (
            <div role="status" aria-live="polite" className="rounded-lg border border-line bg-panel p-3 text-sm text-mute2">
              {t('正在讀取各 AI 的技能狀態…')}
            </div>
          ) : catalogError ? (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {skillErrorText(catalogError)}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(catalog?.targets || []).map((target) => {
                const compatible = (catalog?.skills || []).filter((skill) => skill.targets?.includes(target.id)).length
                const installed = target.installedCount
                  ?? (catalog?.skills || []).filter((skill) => skill.installedTargets?.includes(target.id)).length
                return (
                  <article key={target.id} className="rounded-lg border border-line bg-panel p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-medium">{targetLabel(target.id, target.label)}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${target.readOnly ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : targetAvailable(target) ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-elev text-mute2'}`}>
                        {target.readOnly ? t('唯讀來源') : targetAvailable(target) ? t('可接收技能') : t('未安裝工具')}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-mute2">
                      <span className="font-semibold text-ink2">{installed}</span> {t('個已安裝')}
                      <span className="mx-2 text-line3">·</span>
                      <span className="font-semibold text-ink2">{compatible}</span> {t('個相容')}
                    </p>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-line2 bg-panel p-4 sm:p-5" aria-labelledby="import-title">
          <h2 id="import-title" className="text-lg font-semibold">{t('匯入 AI 技能')}</h2>
          <p className="mt-1 text-xs text-mute2">{t('不需要輸入路徑或開啟終端機；依照三步驟確認後才會安裝。')}</p>
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            {t('所有匯入包都視為不受信任文件：只檢查與複製檔案，不執行程式、不啟用 hook，也不會因資料夾存在就宣稱技能可用。')}
          </p>

          <nav className="my-4 grid gap-2 sm:grid-cols-3" aria-label={t('技能匯入步驟')}>
            <StepBadge number={1} current={step} done={step > 1}>{t('選擇來源')}</StepBadge>
            <StepBadge number={2} current={step} done={step > 2}>{t('預覽與處理衝突')}</StepBadge>
            <StepBadge number={3} current={step} done={!!installResult}>{t('選擇 AI 並安裝')}</StepBadge>
          </nav>

          {error && (
            <div ref={firstError} tabIndex={-1} role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 outline-none dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {skillErrorText(error)}
            </div>
          )}

          {step === 1 && (
            <div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{t('技能放在哪裡？')}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    ['zip', 'ZIP 技能包', '選擇一個已下載的 .zip 檔'],
                    ['files', '技能資料夾', '直接選擇含 SKILL.md 的資料夾'],
                    ['installed', '從現有技能複製', '把已安裝技能加到另一個相容 AI'],
                  ] as const).map(([kind, title, note]) => (
                    <label key={kind} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${sourceKind === kind ? 'border-line3 bg-elev' : 'border-line hover:bg-elev/40'}`}>
                      <input type="radio" name="skill-source" value={kind} checked={sourceKind === kind} onChange={() => chooseSource(kind)} />
                      <span><span className="block text-sm font-medium">{t(title)}</span><span className="mt-0.5 block text-xs text-mute2">{t(note)}</span></span>
                    </label>
                  ))}
                  <label className="flex cursor-not-allowed gap-3 rounded-lg border border-line bg-elev/20 p-3 opacity-60">
                    <input type="radio" name="skill-source" value="url" disabled />
                    <span><span className="block text-sm font-medium">{t('網址／GitHub')}</span><span className="mt-0.5 block text-xs text-mute2">{t('尚未提供安全下載驗證，暫時不能使用')}</span></span>
                  </label>
                </div>
              </fieldset>

              <div className="mt-4 rounded-lg border border-line bg-elev/30 p-4">
                {sourceKind === 'zip' && (
                  <label className="block text-sm font-medium">
                    {t('選擇 ZIP')}
                    <input className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-panel file:px-3 file:py-2 file:text-xs" type="file" accept=".zip,application/zip" onChange={(event) => { setPickedFiles(Array.from(event.target.files || [])); setError('') }} />
                  </label>
                )}
                {sourceKind === 'files' && (
                  <label className="block text-sm font-medium">
                    {t('選擇技能資料夾')}
                    <input
                      className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-panel file:px-3 file:py-2 file:text-xs"
                      type="file"
                      multiple
                      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                      onChange={(event) => { setPickedFiles(Array.from(event.target.files || [])); setError('') }}
                    />
                  </label>
                )}
                {sourceKind === 'installed' && (
                  <label className="block text-sm font-medium">
                    {t('選擇現有技能')}
                    <select className="mt-2 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm" value={installedChoice} onChange={(event) => { setInstalledChoice(event.target.value); setError('') }}>
                      <option value="">{t('請選擇…')}</option>
                      {installedOptions.map((option) => <option key={option.key} value={option.key}>{option.name} — {targetLabel(option.source)}</option>)}
                    </select>
                  </label>
                )}
                {pickedFiles.length > 0 && (
                  <p className="mt-2 text-xs text-mute2">{t('已選 {count} 個檔案，共 {size}', { count: pickedFiles.length, size: formatBytes(pickedFiles.reduce((sum, file) => sum + file.size, 0)) })}</p>
                )}
              </div>
              <div className="mt-4 flex justify-end">
                <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40" disabled={busy || catalogBusy} onClick={() => void runPreview()}>
                  {busy ? t('正在安全檢查…') : t('下一步：安全預覽')}
                </button>
              </div>
            </div>
          )}

          {step === 2 && preview?.skill && (
            <div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-line bg-elev/30 p-4">
                  <h3 className="font-semibold">{preview.skill.name}</h3>
                  <p className="mt-1 text-sm text-mute2">{preview.skill.description || t('這個技能沒有提供說明')}</p>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-mute2">{t('資料夾')}</dt><dd className="break-all">{preview.skill.folder || '—'}</dd>
                    <dt className="text-mute2">{t('檔案')}</dt><dd>{preview.skill.fileCount ?? preview.skill.files?.length ?? 0} {t('個')}</dd>
                    <dt className="text-mute2">{t('大小')}</dt><dd>{formatBytes(preview.skill.totalBytes || 0)}</dd>
                  </dl>
                  <div className="mt-3 rounded-md bg-emerald-50 p-2 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                    {t('已完成檔名安全性、路徑與大小檢查；預覽及安裝過程不會執行技能內的程式。')}
                  </div>
                </div>
                <div className="rounded-lg border border-line bg-elev/30 p-4">
                  <h3 className="text-sm font-semibold">{t('這次要安裝到哪一個 AI？')}</h3>
                  <p className="mt-1 text-xs text-mute2">{t('一次只安裝一個，完成後可再為另一個 AI 重複匯入。')}</p>
                  <div className="mt-2 space-y-2">
                    {(preview.targets || []).map((target) => {
                      const available = target.status === 'available'
                      return (
                        <label key={target.id} className={`flex items-start gap-2 rounded-md border px-3 py-2 ${available ? 'cursor-pointer border-line bg-panel' : 'cursor-not-allowed border-line bg-elev/40 opacity-70'}`}>
                          <input
                            type="radio"
                            name="skill-install-target"
                            className="mt-0.5"
                            checked={selectedTargets.includes(target.id)}
                            disabled={!available}
                            onChange={() => setSelectedTargets([target.id])}
                          />
                          <span className="min-w-0"><span className="block text-sm font-medium">{targetLabel(target.id, target.label)}</span><span className={`block text-xs ${target.status === 'conflict' ? 'text-red-600 dark:text-red-400' : 'text-mute2'}`}>
                            {target.status === 'available' ? t('可以安裝') : target.status === 'installed' ? t('相同版本已安裝') : target.status === 'conflict' ? t('同名但內容不同，禁止覆寫') : t('這個工具目前不可用')}
                          </span></span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              </div>

              {hasSkillConflict(preview.targets || []) && (
                <fieldset className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/20">
                  <legend className="px-1 text-sm font-semibold text-red-700 dark:text-red-300">{t('發現同名衝突，請明確選擇')}</legend>
                  <p className="mb-2 text-xs text-red-700 dark:text-red-300">{t('系統不會覆寫現有技能。若要保留兩份，請先替匯入資料夾改名，再重新選擇。')}</p>
                  <label className="mr-4 inline-flex items-center gap-2 text-sm"><input type="radio" name="conflict-choice" checked={conflictChoice === 'cancel'} onChange={() => setConflictChoice('cancel')} />{t('取消這次匯入')}</label>
                  {installableTargetIds(preview.targets || []).length > 0 && (
                    <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="conflict-choice" checked={conflictChoice === 'available'} onChange={() => setConflictChoice('available')} />{t('只安裝到沒有衝突的 AI')}</label>
                  )}
                </fieldset>
              )}

              <div className="mt-4 flex flex-wrap justify-between gap-2">
                <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-elev" onClick={() => setStep(1)}>{t('← 返回選擇來源')}</button>
                {conflictChoice === 'cancel' ? (
                  <button className="rounded-md bg-ink px-4 py-2 text-sm text-invink hover:bg-ink2" onClick={resetWizard}>{t('取消並重新選擇')}</button>
                ) : (
                  <button className="rounded-md bg-ink px-4 py-2 text-sm text-invink hover:bg-ink2 disabled:opacity-40" disabled={!selectedTargets.length} onClick={goToConfirm}>{t('下一步：最後確認')}</button>
                )}
              </div>
            </div>
          )}

          {step === 3 && preview?.skill && (
            <div>
              <div className="rounded-lg border border-line2 bg-elev/30 p-4">
                <h3 className="text-base font-semibold">{t('確認安裝')}</h3>
                <p className="mt-1 text-sm">{t('技能：')}<strong>{preview.skill.name}</strong></p>
                <p className="mt-1 text-sm text-mute2">{t('目標 AI：{targets}', { targets: (preview.targets || []).filter((target) => selectedTargets.includes(target.id)).map((target) => targetLabel(target.id, target.label)).join('、') })}</p>
                <p className="mt-3 text-xs text-mute2">{t('按下後只會複製已預覽的檔案，不會覆寫同名技能，也不會執行技能內容。')}</p>
              </div>

              {installResult?.results && (
                <div className="mt-4" role="status" aria-live="polite">
                  <h3 className="mb-2 text-sm font-semibold">{t('各 AI 安裝結果')}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {installResult.results.map((result) => (
                      <div key={result.target} className={`rounded-md border p-3 ${result.status === 'installed' ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/20'}`}>
                        <div className="text-sm font-medium">{targetLabel(result.target, result.label)}</div>
                        <div className="mt-0.5 text-xs">{t(installStatusText(result))}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                    {t('「已安裝」不等於「已驗證可用」。等這個 AI 真正執行過一次並回報使用證據後，才會標示為可用。')}
                  </p>
                </div>
              )}

              {installFailure?.results && installFailure.results.length > 0 && (
                <div className="mt-4" role="status" aria-live="polite">
                  <h3 className="mb-2 text-sm font-semibold">{t('各 AI 未安裝原因')}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {installFailure.results.map((result) => (
                      <div key={result.target} className="rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/20">
                        <div className="text-sm font-medium">{targetLabel(result.target, result.label)}</div>
                        <div className="mt-0.5 text-xs">{t(installStatusText(result))}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap justify-between gap-2">
                <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-elev disabled:opacity-40" disabled={busy || !!installResult} onClick={() => { setInstallFailure(null); setStep(2) }}>{t('← 返回修改')}</button>
                {installResult ? (
                  <button className="rounded-md bg-ink px-4 py-2 text-sm text-invink hover:bg-ink2" onClick={resetWizard}>{t('匯入另一個技能')}</button>
                ) : (
                  <button className="rounded-md bg-ink px-5 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40" disabled={busy} onClick={() => void install()}>
                    {busy ? t('正在安裝…') : t('確認並安裝到所選 AI')}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
