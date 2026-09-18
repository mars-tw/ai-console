# DevSpace 桌面控制台

AI Console 的「DevSpace」分頁把本機 DevSpace 的服務、專案目錄與 agent 任務放在同一個畫面。開啟畫面不會派工；只有按「派出任務」或續接任務後，才會呼叫所選 AI。

## 在 Windows 桌面使用

1. 依 [DevSpace 官方說明](https://github.com/Waishnav/devspace) 安裝 Node.js、Git Bash 與 DevSpace，完成 `devspace init`。已經有 DevSpace 的電腦可沿用既有安裝。
2. 開啟 AI Console，切到「DevSpace」。檢查畫面列出的服務狀態與允許目錄。
3. 選擇允許目錄內的專案，選 Codex、Claude 或本機 AI，輸入任務並送出。
4. 從任務清單選取一筆，查看狀態與結果。任務結束後可輸入後續指示，沿用同一個 agent session。

AI Console 不包含 AI 帳號、模型或 DevSpace 的 owner 密碼。目標出現在選單中，代表 DevSpace 已啟用該 provider；登入狀態、額度與模型是否可用，仍以實際派工結果為準。使用雲端 provider 時，任務內容會交給該服務。

從 Git checkout 建立桌面版本（打包程式需要 Git 追蹤清單）：

```powershell
git clone https://github.com/mars-tw/ai-console.git
cd ai-console
npm ci
npm run verify
npm run pack
powershell -ExecutionPolicy Bypass -File scripts/create-desktop-shortcut.ps1 -DevSpace
```

桌面會建立「DevSpace 控制台」捷徑，直接開啟 DevSpace 分頁。打包輸出在 `release/clean/AI控制台-win32-x64/`；請保留整個資料夾。也可以執行 `npm run app -- --devspace`，使用已建置的原始碼版本。

若使用原始碼 ZIP，可執行 `npm ci`、`npm run build`、`npm run app -- --devspace`；要製作發行包時請改用上述 Git checkout。

## 服務與任務分開管理

- **MCP 服務**：供 MCP client 連入。已有服務時會沿用；由 AI Console 啟動的服務才會出現可用的停止操作。
- **Agent daemon**：DevSpace 執行任務的背景程序，與 HTTP MCP 服務不同。MCP 服務未啟動時，已設定的本機 agent 仍可派工。
- **任務歷史**：只顯示所選專案的 DevSpace 任務。讀取歷史不會偷偷啟動 daemon。

DevSpace 1.0.8 沒有停止單一任務的 CLI，因此此頁不提供會誤停其他工作的替代按鈕。停止 MCP 服務也不代表取消 agent 任務。

## 本機邊界

目前依 DevSpace 1.0.8 的 CLI 與 `local_agent_sessions` 資料表整合，支援舊版 `config.json` 與 `configVersion: 1` 的 `config.jsonc`。遇到無法辨識的設定或資料表時會顯示錯誤，不會改寫資料庫或自行升級 DevSpace。

控制 API 只接受桌面控制台的同來源請求；手機遙控不開放這組端點。工作目錄必須位於 DevSpace 設定允許的根目錄內，並在後端解析實際路徑後檢查。查看與續接任務也會核對其專案。

控制台只讀取必要的設定欄位與任務資料，不把 DevSpace 登入檔、owner 密碼或完整設定傳給畫面。派工使用程式參數陣列，不經 shell 解讀使用者輸入；不會自動安裝、更新 DevSpace 或改寫其設定。

若安裝在非標準位置，可把 `AI_CONSOLE_DEVSPACE_BIN` 設為 DevSpace 的 `dist/cli.js` 完整路徑或原生執行檔；不接受 `.cmd`、`.bat`、`.ps1`。使用 JavaScript 入口時，Node.js 必須在 PATH 中。控制台也會沿用 `DEVSPACE_CONFIG_DIR` 與 `DEVSPACE_STATE_DIR`。

## 開發介面

所有回應都有 `ok`。失敗時包含 `code` 與可顯示的 `error`。

| 方法 | 路徑 | 內容 |
| --- | --- | --- |
| GET | `/api/devspace/status` | 安裝、版本、設定、允許目錄、服務、daemon 與已啟用 provider |
| POST | `/api/devspace/doctor` | `{}`，執行環境診斷 |
| POST | `/api/devspace/start` | `{}`，啟動 MCP 服務或沿用已在執行的服務 |
| POST | `/api/devspace/stop` | `{}`，停止此控制台擁有的 MCP 服務 |
| POST | `/api/devspace/tasks` | `{ "cwd": "專案絕對路徑" }` |
| POST | `/api/devspace/run` | `{ "cwd": "專案絕對路徑", "target": "codex", "prompt": "任務內容" }` |
| POST | `/api/devspace/show` | `{ "cwd": "專案絕對路徑", "id": "任務 ID" }` |
| POST | `/api/devspace/continue` | `{ "cwd": "專案絕對路徑", "id": "任務 ID", "prompt": "後續指示" }` |

整合程式位於 `server/devspace_console.py`；畫面位於 `src/components/DevSpaceConsole.tsx`。它使用 DevSpace 的 CLI 與本機資料庫，不改動上游 DevSpace 原始碼。[DevSpace](https://github.com/Waishnav/devspace) 與 [AI Console](https://github.com/mars-tw/ai-console) 均以各自的 MIT License 發佈。
