// AI 控制台 dev 啟動器：同時啟動本地控制 API（python）與 vite
// 用法等同 npm run dev，會轉發 --port / --host 等參數給 vite
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// 與 Electron 主行程共用同一套探測邏輯，避免兩邊各寫一份又各自過期。
// （這裡原本寫死開發機的絕對路徑，別人 clone 下來一定跑不起來。）
const { findPython } = createRequire(import.meta.url)('./find-python.cjs')
const PY = findPython()

const api = spawn(PY, [path.join(root, 'server', 'api.py')], { stdio: 'inherit' })
api.on('error', (e) => console.error('[api] 啟動失敗：', e.message))

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const vite = spawn(process.execPath, [viteBin, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root })
vite.on('error', (e) => console.error('[vite] 啟動失敗：', e.message))

const shutdown = () => {
  api.kill()
  vite.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
vite.on('exit', (code) => { api.kill(); process.exit(code ?? 0) })
