// 找一個可用的 Python 直譯器
//
// 這裡刻意不寫死任何絕對路徑。開發機上曾經寫死過一條，結果那條路徑
// 同時是「別人 clone 下來一定不能跑」和「把作者的目錄結構印在原始碼裡」
// 兩個問題，所以一律改成按順序探測。
//
// 順序的理由：使用者明講的最優先；接著是本專案自帶的虛擬環境；
// 再來是 Kimi 桌面版內建的 runtime（本專案的產圖管線本來就會用到它）；
// 都沒有才退回系統 PATH 上的 python。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const WIN = process.platform === 'win32'

/** 專案根目錄（此檔案在 <root>/scripts/ 底下）*/
const ROOT = path.dirname(__dirname)

function venvPython(dir) {
  return WIN
    ? path.join(dir, 'Scripts', 'python.exe')
    : path.join(dir, 'bin', 'python')
}

/** Kimi 桌面版內建的 Python runtime（各平台的應用資料夾不同）*/
function kimiRuntime() {
  const home = os.homedir()
  const bases = WIN
    ? [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support')]
      : [process.env.XDG_CONFIG_HOME || path.join(home, '.config')]
  return bases.map((b) =>
    venvPython(path.join(b, 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'python', '.venv')))
}

/** 掃 PATH 上的可執行檔 */
function onPath(name) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase())
      try { if (fs.existsSync(full)) return full } catch { /* 無法存取就跳過 */ }
    }
  }
  return null
}

function findPython() {
  const candidates = [
    process.env.AI_CONSOLE_PYTHON,
    venvPython(path.join(ROOT, '.venv')),
    venvPython(path.join(ROOT, 'venv')),
    ...kimiRuntime(),
  ].filter(Boolean)

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* 忽略無法存取的候選 */ }
  }
  for (const name of WIN ? ['python', 'python3'] : ['python3', 'python']) {
    const hit = onPath(name)
    if (hit) return hit
  }
  // 真的找不到就交給系統解析，讓錯誤訊息由 spawn 拋出來比較好懂
  return WIN ? 'python.exe' : 'python3'
}

module.exports = { findPython }
