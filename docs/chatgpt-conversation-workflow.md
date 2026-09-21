# AI 控制台統一執行流程：ChatGPT「對話」＋ DevSpace MCP

適用 AI Console v1.7.0 之後的工作臺。這份文件描述「需要讀寫專案、執行指令或延續編碼工作」時的唯一預設路徑。

## 核心原則

1. AI 控制台只準備工作內容、專案資料夾、模型偏好與必要背景。
2. 使用者在 ChatGPT 選擇「對話」，加入 DevSpace MCP，確認實際模型，再自行貼上並送出。
3. 模型先呼叫 `open_workspace` 開啟專案，再透過 DevSpace MCP 讀寫檔案與執行必要指令。
4. 成果留在本機專案；模型回覆修改路徑、驗證結果與未完成事項，供原派工者接手。
5. 控制台不宣稱已代為貼上、送出、選擇模型或完成工作。

上游 DevSpace 沒有提供控制台可呼叫的 ChatGPT `send-message`。因此「複製指示並開啟 ChatGPT」的正確成功定義只有：剪貼簿寫入成功，且瀏覽器頁面成功開啟。真正送出仍由使用者完成。

## 各入口如何處理

| 入口 | 控制台會做什麼 | 不會做什麼 |
| --- | --- | --- |
| 首頁「交給 AI 執行」 | 開啟 DevSpace 分頁，保留同次執行草稿 | 不挑 CLI、不建立工單 |
| DevSpace 分頁 | 選專案、保留 SOL／ASTRA 偏好、複製並開啟 ChatGPT | 不切換 ChatGPT 模型、不送出訊息 |
| 對話「在 ChatGPT 對話續作」 | 帶入標題、專案與有限近期背景 | 不執行原 `resume`、不恢復完整 session |
| 舊派工「重做／續作」 | 將舊工作與結果整理成新的 ChatGPT 對話草稿 | 不呼叫 retry／followup API |
| 舊排程 | 顯示紀錄並可轉成 ChatGPT 對話草稿 | 不在背景自動執行 |
| 辦公室中控／角色 | 將角色名稱當來源說明，帶到 DevSpace 草稿 | 不把角色或舊工具當實際執行模型 |
| 「問 AI」與辦公室「說說看」 | 保留文字問答；地端回答明確標示不改檔 | 不作為編碼執行、續作或專案改檔路徑 |
| 手機遙控 | 複製完整指示並開啟 ChatGPT；可查看舊紀錄 | 不從手機 POST 新派工、重派或補話 |
| OpenCode | 使用者明確開啟的獨立工具 | 不作為失敗時的自動替代路徑 |

近期背景最多 6 則，每則最多 300 字。這是為了給新 ChatGPT 對話必要上下文，不代表還原原工具狀態。唯讀匯入與 discovered 對話也可作為這種有限背景；原紀錄仍維持唯讀，不會被控制台修改或用原工具 resume。

## 草稿與清除範圍

DevSpace 的工作內容與專案路徑只保留在本次 AI Console 執行期間，切換工作臺頁籤後仍在，但不把 prompt 寫入永久儲存。模型偏好沿用原有偏好設定。

「清除對話草稿」只清除工作內容；專案資料夾與模型偏好保留。桌面資料夾選擇器取消時也保留原路徑。瀏覽器環境沒有選擇器時可手動輸入完整路徑。

## 舊紀錄與安全控制

舊派工紀錄仍可唯讀查看日誌、Git 差異和狀態。為了處理已存在且仍在執行的工作，停止與取消端點保留；這兩個動作不會建立新工作。

以下端點不再執行編碼工作，會回覆 HTTP 409 與 `USE_CHATGPT_CONVERSATION`：

- `/api/launch`
- `/api/dispatch`
- `/api/dispatch/batch`
- `/api/dispatch/retry`
- `/api/dispatch/followup`
- `/api/schedule/save`
- `/api/schedule/run`
- `/api/devspace/run`
- `/api/devspace/continue`

`GET /api/dispatches` 僅回傳狀態，不會 flush pending、auto-handoff、重派或啟動子行程。伺服器啟動時也不會啟動舊排程器。

## 操作步驟

1. 在任一入口寫下工作內容，或從舊對話／紀錄選擇續作。
2. 控制台切到 DevSpace 分頁後，確認專案資料夾位於 `allowedRoots`。
3. 確認工作內容與 SOL／ASTRA 偏好。偏好只會寫入指示；實際模型仍以 ChatGPT 畫面為準。
4. MCP 未啟動時可先整理草稿，但實際執行前必須啟動。
5. 按「複製指示並開啟 ChatGPT」。剪貼簿失敗時，從預覽區手動全選複製。
6. 在 ChatGPT 選擇「對話」，加入 DevSpace，確認模型，貼上後自行送出。
7. 需要修正時留在同一段 ChatGPT 對話接續，不回到舊 CLI 工單。
8. 完成後檢查本機差異與測試，不以聊天文字單獨當作完成證據。

## 開發驗收

統一路徑的回歸測試至少應涵蓋：

- 工作臺頁籤往返仍保留 DevSpace 草稿。
- 資料夾選擇取消不清空路徑。
- 剪貼簿失敗時不開啟 ChatGPT。
- 各準備狀態有不同原因與下一步。
- Home、Console、ContinueWorkDialog、Office、Mobile 不包含新派工／重派／補話執行請求。
- `GET /api/dispatches` 不呼叫 pending flush 或 auto-handoff。
- 舊執行端點回 409；stop／cancel 仍可路由。
