// AI 控制台 · Electron 主程序
//
// 啟動流程：找 Python → 確保整合伺服器（server/api.py）在跑 → 開視窗。
//
// 這裡刻意把每一步都寫進啟動日誌，因為打包後主程序的 console 看不到，
// 出事時只會看到一個白視窗，很難查。日誌位置會顯示在錯誤畫面上。
const { app, BrowserWindow, Menu, shell, ipcMain, Notification } = require('electron')
const ptyMgr = require('./pty.cjs')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

// Windows 的通知中心（Action Center）依賴 AppUserModelId 來歸屬與顯示通知。
// 如果沒有設定，Windows 無法識別發送通知的應用程式身份，導致 Toast 通知被系統靜默丟棄。
if (process.platform === 'win32') {
  app.setAppUserModelId('tw.mars.ai-console')
}

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

/**
 * 應用程式選單。
 *
 * 不設的話 Electron 會給一份預設選單，全部是英文（File / Edit / View…）——
 * 整個介面都是繁體中文，只有按 Alt 叫出來的選單是英文，很突兀。
 *
 * 每一項都保留 role：role 決定實際行為（複製、貼上、縮放這些跟系統整合的動作），
 * label 只換顯示文字。自己寫 click 去實作複製貼上會漏掉輸入法、選取範圍這些細節。
 */
function buildMenu() {
  const template = [
    {
      label: '檔案',
      submenu: [
        { role: 'reload', label: '重新載入' },
        { role: 'forceReload', label: '強制重新載入' },
        { type: 'separator' },
        { role: 'quit', label: '結束' },
      ],
    },
    {
      label: '編輯',
      submenu: [
        { role: 'undo', label: '復原' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪下' },
        { role: 'copy', label: '複製' },
        { role: 'paste', label: '貼上' },
        { role: 'selectAll', label: '全選' },
      ],
    },
    {
      label: '檢視',
      submenu: [
        { role: 'resetZoom', label: '實際大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全螢幕' },
        { role: 'toggleDevTools', label: '開發人員工具' },
      ],
    },
    {
      label: '說明',
      submenu: [
        {
          label: '開啟啟動日誌',
          click: () => { shell.openPath(LOG) },
        },
        {
          label: '專案首頁（GitHub）',
          click: () => { shell.openExternal('https://github.com/mars-tw/ai-console') },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 互動終端的 IPC。
 *
 * 每一個都在這一側再驗一次（工具白名單、數量上限、尺寸夾制）——
 * renderer 是畫面那一層，它傳來的東西一律當成不可信。
 */
function wirePty() {
  const push = (channel) => (id, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, id, payload)
  }
  ipcMain.handle('pty:available', () => ptyMgr.available())
  ipcMain.handle('pty:open', (_e, opts) => {
    const o = opts || {}
    return ptyMgr.open(
      { id: String(o.id || ''), tool: String(o.tool || ''), bin: String(o.bin || ''),
        cwd: o.cwd ? String(o.cwd) : '', cols: +o.cols || 100, rows: +o.rows || 30 },
      push('pty:data'), push('pty:exit'),
    )
  })
  ipcMain.handle('pty:write', (_e, id, data) => ptyMgr.write(String(id), String(data)))
  ipcMain.handle('pty:resize', (_e, id, c, r) => ptyMgr.resize(String(id), +c, +r))
  ipcMain.handle('pty:close', (_e, id) => ptyMgr.close(String(id)))
  ipcMain.handle('pty:list', () => ptyMgr.list())
  ipcMain.handle('pty:backlog', (_e, id) => ptyMgr.backlog(String(id)))

  // 收掉閒置與已結束的。跑一整夜的工作持續有輸出，不會被誤殺。
  setInterval(() => ptyMgr.sweep(), 60_000).unref()
  log(`互動終端：${ptyMgr.available() ? '可用' : '不可用（node-pty 沒載入）'}`)
}

/**
 * 系統通知 IPC。
 *
 * 派工完成或失敗時，發出作業系統層級的桌面通知。
 * 當使用者切換到其他視窗工作時，透過通知得知派工結束；
 * 點擊通知時會將主視窗展開並移至前景，讓使用者能立即查看結果。
 */
const activeNotifications = new Set()

function wireNotify() {
  ipcMain.handle('notify:available', () => Notification.isSupported())
  ipcMain.handle('notify:send', (_e, opts) => {
    if (!Notification.isSupported()) return false
    const o = opts || {}
    const title = String(o.title || 'AI 控制台')
    const body = String(o.body || '')
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
    const n = new Notification({
      title,
      body,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
    })

    // Electron 的 Notification 物件若只保留在區域變數，可能在使用者點擊前
    // 就被 V8 垃圾回收機制回收，導致 click 與 close 監聽器失效。
    // 這裡暫存引用，待事件結束後再釋放。
    activeNotifications.add(n)
    const cleanup = () => activeNotifications.delete(n)

    n.on('click', () => {
      cleanup()
      // 點擊通知將視窗喚醒至前景：
      // 若視窗被最小化，必須先呼叫 restore()，否則單獨 show()/focus() 無法解除最小化狀態。
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    n.on('close', cleanup)
    n.on('failed', cleanup)
    n.show()
    return true
  })
}


async function createWindow() {
  log(`--- 啟動 --- ${app.isPackaged ? '打包版' : '開發版'}  資源=${__dirname}`)
  buildMenu()
  wirePty()
  wireNotify()
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
    webPreferences: {
      contextIsolation: true,
      // preload 是 renderer 唯一能碰到主行程的通道。
      // contextIsolation 維持開著 —— 畫面那一層不該直接拿到 Node。
      preload: path.join(__dirname, 'preload.cjs'),
    },
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

app.on('before-quit', () => {
  // 不收的話那些 CLI 會變成孤兒行程繼續佔著資源
  try { ptyMgr.killAll() } catch { /* 關閉流程不要因為這個中斷 */ }
})
app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
