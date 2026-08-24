// 互動終端：讓派工從「送出去就斷線」變成「握著一條活的連線」
//
// 為什麼需要這個：
//   在這之前，所有派工都是 stdin=DEVNULL 的一次性呼叫 —— agent 跑歪了
//   沒辦法插話，只能靠「用續談旗標再派一次」繞過去（那不是解法，是繞路），
//   而且要知道它在做什麼只能每 8 秒去 tail 一次 log 檔。
//
// 為什麼放在 Electron 主行程而不是 Python 那邊：
//   node-pty 是 Node 的原生模組，Electron 本來就是 Node 環境，直接就能用。
//   放進 Python 端就得引進 pywinpty，而這個專案的 Python 是刻意零 pip 依賴的
//   （README 明文寫的賣點）。把 PTY 留在 Node 這側，Python 一行都不用改。
//
// 安全邊界：
//   · 只允許啟動白名單裡的工具，跟 server/api.py 的 KNOWN_TOOLS 同一個道理 ——
//     沒有這一層，任意字串會被當成執行檔名跑起來
//   · 每個 session 有輸出上限與閒置逾時，跑飛的行程不會把記憶體吃光
//   · 視窗關掉時全部收乾淨，不留孤兒行程
'use strict'

const os = require('node:os')
const path = require('node:path')

let pty = null
try {
  pty = require('node-pty')
} catch (e) {
  // 原生模組載不起來不該讓整個 app 開不了 —— 終端功能停用，其餘照常。
  console.error('[pty] node-pty 載入失敗，互動終端停用：', e.message)
}

/** 一個 session 最多留多少輸出在記憶體裡（重開視窗時回放用） */
const SCROLLBACK = 200_000
/** 閒置多久自動收掉。跑一整夜的工作會持續有輸出，不會被誤殺 */
const IDLE_MS = 6 * 60 * 60 * 1000
/** 同時最多幾個 session */
const MAX_SESSIONS = 8

const sessions = new Map()

/**
 * 可以開終端的工具。
 *
 * 跟 server/api.py 的 KNOWN_TOOLS 是同一個理由：不擋的話，任何字串都會
 * 被當成執行檔名丟給系統跑。這裡多一層是因為 PTY 拿到的是完整的互動
 * shell，代價比一次性呼叫更高。
 */
const ALLOWED = new Set(['claude', 'codex', 'qwen', 'gemini', 'grok', 'kimi', 'cursor', 'shell'])

function shellFor(tool, bin) {
  if (tool === 'shell') {
    return process.platform === 'win32'
      ? { file: process.env.COMSPEC || 'cmd.exe', args: [] }
      : { file: process.env.SHELL || '/bin/bash', args: [] }
  }
  // 工具本身就是要互動的，直接把它當 shell 跑。
  // Windows 上 .cmd/.bat 沒辦法被 CreateProcess 直接執行，要透過 cmd /c ——
  // 但這裡不是把使用者文字放進命令列（那才是危險的），只有執行檔路徑本身，
  // 之後所有輸入都是走 pty.write()，不經過任何命令列解析。
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/c', bin] }
  }
  return { file: bin, args: [] }
}

/**
 * 開一個 session。回傳 { id } 或 { error }
 *
 * onData 是主行程往 renderer 推資料的回呼，由 main.cjs 綁到 webContents.send。
 */
function open({ id, tool, bin, cwd, cols, rows }, onData, onExit) {
  if (!pty) return { error: 'node-pty 沒有載入，互動終端不可用' }
  if (sessions.has(id)) return { error: `session ${id} 已存在` }
  if (sessions.size >= MAX_SESSIONS) {
    return { error: `同時最多 ${MAX_SESSIONS} 個終端，先關掉一個` }
  }
  if (!ALLOWED.has(tool)) return { error: `不認得的工具：${String(tool).slice(0, 40)}` }
  if (tool !== 'shell' && !bin) return { error: `找不到 ${tool} 的執行檔` }

  const { file, args } = shellFor(tool, bin)
  const home = os.homedir()
  // cwd 必須是真的存在的目錄，不然 spawn 會拋一個很難懂的錯
  let workdir = home
  try {
    if (cwd && require('node:fs').statSync(cwd).isDirectory()) workdir = cwd
  } catch { /* 用 home */ }

  // node-pty 在 Windows 上會另外起一個 conpty_console_list_agent 輔助行程，
  // 在沒有 console 的環境（GUI app、無頭腳本）它會印 "AttachConsole failed"。
  // 那個 agent 只服務 pty.consoleProcessList，我們沒有用到，功能不受影響 ——
  // 煙霧測試 11 項全過就是在那個錯誤一直噴的情況下跑出來的。
  // 之所以記在這裡：這台機器踩過「一直閃 CMD 視窗」，看到這行別誤以為是同一件事。
  let proc
  try {
    proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(20, Math.min(500, cols || 100)),
      rows: Math.max(5, Math.min(200, rows || 30)),
      cwd: workdir,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
  } catch (e) {
    return { error: `開不起來：${e.message}` }
  }

  const s = {
    id, tool, proc,
    buf: '',
    startedAt: Date.now(),
    lastAt: Date.now(),
    exited: false,
    exitCode: null,
  }
  sessions.set(id, s)

  proc.onData((chunk) => {
    s.lastAt = Date.now()
    s.buf += chunk
    // 只留尾端。CLI 可以吐出幾百 MB，整份留著會把記憶體吃光。
    if (s.buf.length > SCROLLBACK) s.buf = s.buf.slice(-SCROLLBACK)
    onData(id, chunk)
  })

  proc.onExit(({ exitCode }) => {
    s.exited = true
    s.exitCode = exitCode
    onExit(id, exitCode)
  })

  return { id, tool, cwd: workdir }
}

function write(id, data) {
  const s = sessions.get(id)
  if (!s || s.exited) return false
  s.lastAt = Date.now()
  s.proc.write(data)
  return true
}

function resize(id, cols, rows) {
  const s = sessions.get(id)
  if (!s || s.exited) return false
  try {
    s.proc.resize(Math.max(20, Math.min(500, cols)), Math.max(5, Math.min(200, rows)))
    return true
  } catch { return false }
}

/** 重新掛上一個既有 session 時，把之前的輸出回放給它 */
function backlog(id) {
  const s = sessions.get(id)
  return s ? s.buf : ''
}

function close(id) {
  const s = sessions.get(id)
  if (!s) return false
  try { s.proc.kill() } catch { /* 已經死了 */ }
  sessions.delete(id)
  return true
}

function list() {
  return [...sessions.values()].map((s) => ({
    id: s.id, tool: s.tool, exited: s.exited, exitCode: s.exitCode,
    startedAt: s.startedAt, bytes: s.buf.length,
  }))
}

/** 收掉閒置太久的。跑一整夜的工作會持續有輸出，lastAt 一直在更新，不會被誤殺 */
function sweep() {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (s.exited && now - s.lastAt > 60_000) { sessions.delete(id); continue }
    if (!s.exited && now - s.lastAt > IDLE_MS) close(id)
  }
}

/** app 要關了：全部收乾淨，不留孤兒行程 */
function killAll() {
  for (const id of [...sessions.keys()]) close(id)
}

module.exports = { open, write, resize, close, list, backlog, sweep, killAll, available: () => !!pty }
