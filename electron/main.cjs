// AI 控制台 · Electron 主程序
//
// 啟動流程：找 Python → 確保整合伺服器（server/api.py）在跑 → 開視窗。
//
// 這裡刻意把每一步都寫進啟動日誌，因為打包後主程序的 console 看不到，
// 出事時只會看到一個白視窗，很難查。日誌位置會顯示在錯誤畫面上。
const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const PORT = 5177
const APP_URL = `http://127.0.0.1:${PORT}/`
const API = path.join(__dirname, '..', 'server', 'api.py')
const LOG = path.join(os.tmpdir(), 'ai-console-launch.log')

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`
  try { fs.appendFileSync(LOG, line) } catch { /* 日誌寫不了也不能影響啟動 */ }
}

// Python 探測（環境變數 → 專案 venv → Kimi 桌面版 runtime → PATH）。
// 與 scripts/dev.mjs 共用同一份，見 scripts/find-python.cjs。
const { findPython } = require('../scripts/find-python.cjs')

function health() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => { req.destroy(); resolve(false) })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ensureServer() {
  if (await health()) {
    log('伺服器已在執行，沿用它')
    return true
  }
  const py = findPython()
  log(`啟動伺服器：python=${py}`)
  log(`             api=${API}  存在=${fs.existsSync(API)}`)

  let child
  try {
    // stderr 收進日誌：Python 掛掉時才知道為什麼，不然只會看到白視窗
    child = spawn(py, [API], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  } catch (e) {
    log(`spawn 直接拋錯：${e.message}`)
    return false
  }
  child.on('error', (e) => log(`spawn 失敗：${e.message}`))
  child.on('exit', (code, sig) => log(`Python 結束 code=${code} sig=${sig}`))
  if (child.stderr) child.stderr.on('data', (d) => log(`python stderr: ${String(d).trim().slice(0, 500)}`))
  child.unref()

  for (let i = 0; i < 60; i++) {
    await sleep(500)
    if (await health()) {
      log(`伺服器就緒（等了 ${((i + 1) * 0.5).toFixed(1)} 秒）`)
      return true
    }
  }
  log('等了 30 秒伺服器仍未就緒')
  return false
}

function errorPage(reason) {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  body{background:#09090b;color:#e4e4e7;font:14px/1.7 system-ui,"Noto Sans TC",sans-serif;
       margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
  .box{max-width:640px;padding:32px}
  h1{font-size:18px;margin:0 0 12px}
  code{background:#18181b;padding:2px 6px;border-radius:4px;font-size:12px}
  li{margin:6px 0}
</style>
<div class="box">
  <h1>整合伺服器沒有啟動</h1>
  <p>${reason}</p>
  <p>可以這樣查：</p>
  <ul>
    <li>啟動日誌：<code>${LOG}</code></li>
    <li>手動啟動看錯誤訊息：<code>python server/api.py</code></li>
    <li>指定 Python：設環境變數 <code>AI_CONSOLE_PYTHON</code> 指向可用的直譯器</li>
  </ul>
</div>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

let win = null

async function createWindow() {
  log(`--- 啟動 --- ${app.isPackaged ? '打包版' : '開發版'}  資源=${__dirname}`)
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'AI 控制台',
    // 打包版的工作列圖示由 electron-packager 的 --icon 決定，
    // 這裡是給開發時（npm run dev）用的，不然視窗會頂著 Electron 預設圖
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  })

  const ok = await ensureServer()
  if (!ok) {
    log('改顯示錯誤畫面')
    win.loadURL(errorPage('嘗試啟動 <code>server/api.py</code> 失敗，或它沒有在 30 秒內就緒。'))
    return
  }
  // 伺服器剛起來時偶爾第一次連線會被拒，載入失敗就重試幾次
  for (let i = 0; i < 5; i++) {
    try {
      await win.loadURL(APP_URL)
      log('畫面載入成功')
      return
    } catch (e) {
      log(`載入失敗（第 ${i + 1} 次）：${e.message}`)
      await sleep(600)
    }
  }
  win.loadURL(errorPage('伺服器有回應，但畫面一直載入失敗。'))
}

app.whenReady()
  .then(createWindow)
  .catch((e) => log(`createWindow 例外：${e && e.stack}`))

app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
