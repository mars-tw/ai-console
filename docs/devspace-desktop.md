# DevSpace 對話入口與 OpenCode 工作臺

適用 AI Console v1.7.0。所有需要讀寫專案或執行指令的編碼工作，統一使用 **ChatGPT「對話」→ DevSpace MCP → 本機成果交接**。OpenCode 是工作臺裡另一個可由使用者明確開啟的對話工具，不是控制台的背景備援，也不會被自動選用。

DevSpace 分頁會準備指示、複製到剪貼簿，並開啟 ChatGPT 網站。訊息由使用者在 ChatGPT 對話送出，模型在對話中直接呼叫已加入的 DevSpace MCP。此流程不使用 ChatGPT「工作」、DevSpace agent 工作、CLI resume、auto-handoff 或 Codex app-server 對話。

## 整個控制台的統一執行路徑

以下入口都只會整理工作內容、專案路徑與必要背景，再帶到 DevSpace 分頁：

- 首頁「交給 AI 執行」與原「派工主控台」的新工作輸入。
- 對話清單的「在 ChatGPT 對話續作」。最多帶入最近 6 則訊息，每則最多 300 字；不會恢復原工具 session。唯讀匯入與 discovered 紀錄也只作為有限背景，原來源仍維持唯讀。
- 舊派工紀錄的重做、補充與舊排程內容。
- 辦公室中控與角色工作按鈕。
- 手機遙控的新工作、重做與續作。

「問 AI」與辦公室的「說說看」仍可作為純文字問答；地端回答不會被當成編碼執行或改檔路徑。需要讀寫專案時，必須改用上述 ChatGPT 對話流程。

這些入口不會 POST 新派工、重派、補話、排程執行或 `/api/launch`，也不會自動替使用者貼上或送出。舊派工頁面只保留唯讀紀錄，以及停止／取消已存在工作的必要控制。讀取 `/api/dispatches` 不會 flush pending、重試或 auto-handoff；伺服器也不會啟動舊背景排程器。

## 在 ChatGPT 對話中操作專案

1. 依 [安裝手冊](install-and-run.md)完成 DevSpace 與 ChatGPT MCP 連線設定，再開啟 AI Console，切到「DevSpace」。在「專案資料夾」填入 DevSpace 允許目錄內的完整路徑。
2. 在「要在對話中完成的內容」寫清楚需求、可修改範圍、驗收方式與成果位置。可展開「檢視將要複製的指示」確認內容。
3. 按主要操作「複製指示並開啟 ChatGPT」。只有剪貼簿成功後才會開啟網站；失敗時草稿仍保留，畫面會提供手動複製方式。也可使用分開的「複製對話指示」與「開啟 ChatGPT 對話」。確認瀏覽器使用已登入且有 DevSpace 連線的帳號。
4. 在 ChatGPT 確認選中「對話」，不要切換到「工作」。從新增內容或工具選單加入已設定的 DevSpace 連接器，再選擇要使用的模型。
5. 貼上指示，保留 DevSpace 連接器標籤，確認專案路徑後送出。模型應先透過 `open_workspace` 開啟指定專案，再使用 MCP 讀寫檔案或執行指令。
6. 在同一段 ChatGPT 對話查看工具結果與回覆，需要修改時也在原對話接續。完成後，由原派工者讀回本機檔案、檢查差異並執行必要驗證。

可以使用這樣的指示：

> 檢查指定專案的建置錯誤，修正相關程式並執行測試。只修改完成這個需求所需的檔案。成果留在本機專案，最後列出修改路徑、測試結果與未完成事項，供原派工者接手。

實際模型要在 **ChatGPT 的模型選單**選擇。需要 GPT-5.6 SOL 或 GPT-6 ASTRA 時，確認畫面確實顯示該模型；如果帳號沒有該選項，保留錯誤並處理權限，不自動換成其他模型。工作臺儲存的模型偏好、指示裡的模型名稱與 Codex 模型識別碼，都不會遠端切換 ChatGPT 的模型。

「複製對話指示」只準備文字，「開啟 ChatGPT 對話」只開啟網站。這兩個按鈕都不會自動送出訊息，也不會把開啟頁面記作執行完成。上游 DevSpace 沒有供控制台呼叫的 `send-message` 功能。

## MCP 連線與本機交接

ChatGPT 是 MCP client，透過使用者設定的公開 HTTPS 入口連入 DevSpace。分頁中顯示的 `127.0.0.1` 位址供本機狀態檢查使用，不能直接當作雲端 ChatGPT 的連線網址。升級時可沿用既有入口與認證；控制台不會自動建立公開網址、tunnel 或 OAuth 連線。

若尚未建立 ChatGPT 連線，依 [OpenAI 官方 MCP 連接說明](https://developers.openai.com/plugins/deploy/connect-chatgpt)完成帳號允許的連接流程，再從對話的工具選單加入連線。

工作成果應寫在已允許的專案範圍內。需要交接時，可在指示中指定成果、`response.md` 與 `handoff.json` 的位置，要求模型寫入後讀回確認。原派工者以本機內容和驗證結果接手。這些交接檔由你的需求決定，不會因複製指示而自動產生。只有聊天回覆「已完成」，不足以證明檔案已寫入。

模型無法呼叫工具、認證失敗或檔案缺少時，留在原對話處理具體錯誤。不要改送 DevSpace 背景工作，也不要自動改用 OpenCode。

## 使用 OpenCode

[OpenCode](https://opencode.ai/zht)已加入本機工作臺的獨立分頁。本次整合使用 1.18.31；未安裝的電腦可在 PowerShell 執行：

```powershell
npm.cmd install --global opencode-ai@1.18.31
```

1. 完成 DevSpace 初始化並啟動本機 MCP 服務。在桌面版工作臺開啟「OpenCode」，選擇 DevSpace 允許目錄內已存在的專案。
2. 選擇 GPT-5.6 SOL 或 GPT-6 ASTRA，按「開啟 OpenCode 對話」。工作臺會把所選模型設為這次 OpenCode 服務的預設模型。
3. 第一次 MCP 連線會在預設瀏覽器開啟「Connect DevSpace／AI Console OpenCode」授權頁。由你輸入初始化時設定的 DevSpace owner 密碼，確認授權後回到 OpenCode。控制台不讀取 owner 密碼，也不代為同意。
4. 在 OpenCode 的正常 Connect 流程完成 OpenAI 帳號登入。這與前一步的 DevSpace 授權分開處理；不要把密碼、API key 或認證檔內容貼進對話指示。
5. 在 OpenCode 對話中輸入需求。讀寫檔案和執行指令走綁定該專案的 DevSpace MCP，並在對話內顯示權限確認。
6. 關閉對話視窗後，可以按「返回 OpenCode 對話」再次開啟。切換專案或預設模型前，先按「停止 OpenCode」；停止服務保留對話紀錄。

這個整合在 `127.0.0.1` 啟動 OpenCode 服務，每次啟動產生隨機 Basic 認證密碼，由桌面主程序處理連線。模型帳號登入與本機服務認證分開處理，密碼不回傳工作臺畫面。控制台內附 `electron/devspace-mcp-bridge.cjs`，連接官方 DevSpace 1.0.8，不依賴私人修改版。

Bridge 經由使用者確認的 OAuth PKCE 流程建立自己的 DevSpace client 認證，快取只保存在使用者的 DevSpace 設定目錄；不附帶帳號密碼，也不複製其他 AI 工具的登入檔。首次授權等待最多 150 秒，逾時可停止並重新開啟 OpenCode，再完成授權。MCP 工具綁定所選專案，僅提供所需的檔案與指令工具；這個入口關閉 OpenCode 的背景子代理與 task 操作。

OpenCode 連線狀態以實際 bridge／MCP 心跳為準，不把舊的 `connected` 進度紀錄永久視為已連線。服務停止、bridge 消失或服務重啟時，工作臺會回到可重試狀態並提供重新連接；一般連線故障不會被誤標為 owner 授權失敗。這些檢查只驗證服務與 MCP 連線生命週期，不代表真人 OAuth 已完成或所選模型已成功推論。

「已安裝」、「已啟動」或選單中有模型，只能證明相應設定或服務狀態。所選帳號與模型能否實際回覆，須以真正的對話執行結果確認。OpenCode 的選單也不會改變 Chrome ChatGPT 的模型。

## 服務與範圍

- 「本機 MCP 服務」可檢查設定、啟動 MCP，或停止由此控制台啟動的 MCP。外部啟動的服務不由控制台停止。
- 專案路徑必須位於 DevSpace 的 `allowedRoots` 範圍內。允許目錄不等於完整作業系統沙盒；終端指令仍受本機執行帳號的權限影響。
- 對話內容及工具結果會交給所使用的模型服務，請只提供完成需求所需的專案資料。
- 控制台不把 DevSpace 認證檔、owner 密碼或完整設定傳給畫面，也不因開啟分頁而安裝工具或建立 agent 工作。

非標準安裝可用 `AI_CONSOLE_DEVSPACE_BIN` 指向 DevSpace 的 `dist/cli.js` 或原生執行檔完整路徑；不接受 `.cmd`、`.bat`、`.ps1` 作為此欄位。Node.js 必須在 PATH 中。服務管理沿用 `DEVSPACE_CONFIG_DIR` 與 `DEVSPACE_STATE_DIR`。OpenCode 分頁另需已安裝的原生 OpenCode、Node.js 與官方 DevSpace；MCP bridge 已包含在控制台內，不需額外安裝 MCP SDK。

## 開發與相容介面

完成原始碼建置後，可執行：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run app -- --devspace
```

目前對話入口使用下列 DevSpace 服務 API。回應包含 `ok`；失敗時包含 `code` 與可顯示的 `error`。

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/devspace/status` | 本機安裝、設定、允許目錄與服務狀態 |
| POST | `/api/devspace/doctor` | 執行環境診斷 |
| POST | `/api/devspace/start` | 啟動或沿用 MCP 服務 |
| POST | `/api/devspace/stop` | 停止此控制台擁有的 MCP 服務 |

`/api/devspace/tasks` 與 `show` 僅保留舊紀錄讀取用途。`/api/devspace/run`、`/api/devspace/continue`、`/api/launch`、新派工、批次派工、重派、補話、排程儲存與排程執行端點現在會回覆 HTTP 409、`code: USE_CHATGPT_CONVERSATION`，並指向 DevSpace 分頁；它們不會建立或接續工作。新增對話也不會寫入 DevSpace 的 `local_agent_sessions` 工作紀錄。ChatGPT 對話由 ChatGPT 保存，本機交接檔另存於指定專案。

DevSpace 畫面位於 `src/components/DevSpaceConsole.tsx`，服務管理位於 `server/devspace_console.py`；Chrome 開啟入口位於 `electron/main.cjs`。OpenCode 畫面與桌面服務分別位於 `src/components/OpenCodePanel.tsx`、`electron/opencode.cjs`，內附的 MCP bridge 位於 `electron/devspace-mcp-bridge.cjs`。

[安裝手冊](install-and-run.md)與[快速安裝說明](quick-start.md)提供 v1.7.0 的下載、初始化與啟動步驟；[統一執行流程](chatgpt-conversation-workflow.md)整理所有入口、舊 API 邊界與驗收方式。從舊版升級後，新的編碼工作與續作統一走上述 ChatGPT 對話流程；舊派工入口只保留紀錄查看與停止／取消。
