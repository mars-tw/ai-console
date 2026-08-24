// Renderer 與主行程之間唯一的通道。
//
// contextIsolation 是開著的（main.cjs 的 webPreferences），所以 renderer 拿不到
// Node 的任何東西 —— 這是對的，畫面那一層本來就不該能直接開行程。
// 這裡用 contextBridge 只暴露終端需要的那幾個動作，每一個都在主行程那側
// 再驗一次（工具白名單、數量上限、尺寸夾制），不信任 renderer 傳來的值。
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** 每個 session 的資料回呼。用 Map 而不是單一 listener，才能同時開多個終端 */
const dataSubs = new Map()
const exitSubs = new Map()

ipcRenderer.on('pty:data', (_e, id, chunk) => {
  const fn = dataSubs.get(id)
  if (fn) fn(chunk)
})
ipcRenderer.on('pty:exit', (_e, id, code) => {
  const fn = exitSubs.get(id)
  if (fn) fn(code)
})

contextBridge.exposeInMainWorld('acPty', {
  /** 這個環境有沒有互動終端（瀏覽器開發模式沒有，要能優雅退化） */
  available: () => ipcRenderer.invoke('pty:available'),

  open: (opts) => ipcRenderer.invoke('pty:open', opts),
  write: (id, data) => ipcRenderer.invoke('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  close: (id) => ipcRenderer.invoke('pty:close', id),
  list: () => ipcRenderer.invoke('pty:list'),
  /** 重新掛回一個既有 session 時，把之前的輸出要回來 */
  backlog: (id) => ipcRenderer.invoke('pty:backlog', id),

  onData: (id, fn) => { dataSubs.set(id, fn); return () => dataSubs.delete(id) },
  onExit: (id, fn) => { exitSubs.set(id, fn); return () => exitSubs.delete(id) },
})
