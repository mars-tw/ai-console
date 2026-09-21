# 快速安裝與快速啟動

適用 Windows 64 位元／AI Console v1.7.0。DevSpace 使用 Chrome ChatGPT「對話」中的 MCP 連線；OpenCode 從工作臺的獨立分頁開啟。

## 第一次使用

1. 下載 [快速安裝包 v1.7.0](https://github.com/mars-tw/ai-console/releases/download/v1.7.0/ai-console-quick-start-v1.7.0.zip)，完整解壓縮。
2. 雙擊 **`快速安裝.cmd`**。畫面會依序顯示下載、SHA256 校驗、解壓縮、複製檔案、再次驗證、設定目前版本及建立捷徑的進度；未通過驗證前不會顯示完成。
3. 控制台安裝並驗證完成後，選擇 **「現在設定 DevSpace」**，或 **「稍後設定，先開啟控制台」**。直接按 Enter 會選擇稍後設定。
4. 選擇現在設定時，若缺少 Node.js、Git Bash 或 DevSpace，依視窗提示處理。全新設定會進入官方 `devspace init`，使用方式選 **ChatGPT**，再指定已存在的專案資料夾並完成自己的公開 HTTPS 入口及認證設定。
5. 選擇稍後設定時，本次不檢查或修改 DevSpace；已安裝的控制台與捷徑會保留並照常開啟。既有設定保持不變，尚未設定者可稍後接續。

已有完整 DevSpace 設定時會沿用，保留允許目錄、認證與擴充。取消設定、設定失敗或發現不完整設定時，畫面會保留可處理的錯誤，不會重設認證、刪除已安裝控制台或假稱 DevSpace 已完成。

快速安裝不會自動建立公開網址、tunnel 或登入 ChatGPT。本機 `127.0.0.1` 位址不能直接給雲端 ChatGPT 連線。入口與帳號準備方式見 [完整安裝手冊](install-and-run.md)。

稍後要接續設定時，回到已解壓縮的快速安裝包資料夾，在 PowerShell 執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1
```

不需要重新安裝控制台。若上次設定顯示錯誤，先依原錯誤處理 Node.js、Git、DevSpace CLI、既有設定或公開入口，再執行同一命令。

## 開始一段 DevSpace 對話

1. 在「DevSpace」填入專案路徑與需求。
2. 按「複製指示並開啟 ChatGPT」；只有複製成功才會開啟網站，也可分開操作。
3. 確認 Chrome 使用正確帳號且 ChatGPT 選中「對話」，從新增內容或工具選單加入 DevSpace，選擇實際模型，再貼上指示自行送出。
4. 在同一對話查看 MCP 操作結果與接續指示；完成後讀回本機成果與測試結果。

此流程不使用 ChatGPT「工作」或 DevSpace 背景工作。GPT-5.6 SOL／GPT-6 ASTRA 必須在 ChatGPT 的可見選單實際選定；面板偏好不會替你切換模型。複製指示或開啟網站不代表訊息已送出，也不代表模型已執行成功。

## 開啟 OpenCode

要使用獨立的 OpenCode 對話，先在 PowerShell 安裝：

```powershell
npm.cmd install --global opencode-ai@1.18.31
```

完成 DevSpace 初始化並啟動本機 MCP 服務，在工作臺「OpenCode」分頁選擇專案與 SOL／ASTRA 預設模型，再按「開啟 OpenCode 對話」。第一次 MCP 連線會在瀏覽器開啟 DevSpace 授權頁，由你輸入初始化時的 owner 密碼並確認；回到 OpenCode 後，另依正常 Connect 流程登入 OpenAI。連線狀態以實際 bridge／MCP 心跳為準，服務停止、bridge 消失或重啟時可重新連接。模型是否可用，以實際回覆為準；服務健康檢查不會代你呼叫模型。

v1.7.0 內含連接官方 DevSpace 的 bridge；OpenCode、Node.js、DevSpace 與模型帳號仍需另外準備。完整操作見 [DevSpace 與 OpenCode 說明](devspace-desktop.md)。

## 以後怎麼開

雙擊桌面 **「DevSpace 控制台」**，或安裝包裡的 **`快速啟動.cmd`**，即可進入 DevSpace 分頁。日常啟動不會重新下載或安裝。

若下載 [完整 Windows 免安裝包](https://github.com/mars-tw/ai-console/releases/download/v1.7.0/ai-console-win32-x64-v1.7.0.zip)，完整解壓縮後可直接雙擊 `快速啟動.cmd`；想建立正式安裝位置與捷徑，再按 `快速安裝.cmd`。完整包使用同資料夾內的程式，不必再次下載桌面包。

## 安裝位置與版本

- 程式：`%LOCALAPPDATA%\Programs\AIConsole\versions\1.7.0\`
- 目前版本指標：`%LOCALAPPDATA%\Programs\AIConsole\current.json`
- 安裝日誌：`%LOCALAPPDATA%\AIConsole\installer-logs\`

控制台安裝到使用者目錄，不需要管理員權限；Node.js 或 Git 的系統安裝程式可能另外要求權限。新版使用獨立版本目錄，舊版保留；重跑同一版本會檢查檔案是否一致。從舊版升級時，請使用 v1.7.0 安裝包重新安裝，再開啟桌面捷徑。

快速安裝包首次需要網路下載完整程式。完整免安裝包已含 Electron 與 Python；DevSpace、OpenCode 或其他尚未安裝的工具仍可能需要網路。

## 遇到問題

| 問題 | 做法 |
| --- | --- |
| 下載失敗或 checksum 不符 | 檢查網路，重新下載官方完整包。未通過校驗的下載檔不會被使用。 |
| 找不到 winget | 依提示到 Node.js、Git 官方網站安裝，再重跑快速安裝。 |
| Node.js 版本不符 | 換成支援版本（`>=22.19 <27`），精靈不會自行取代現有版本。 |
| 已有不同的同版本安裝 | 保留原安裝，使用完整官方包檢查；進階使用者可用 `-InstallRoot` 指定新位置。 |
| 想稍後設定或使用 `SkipDevSpace` | 本次不檢查或修改既有 DevSpace 設定。控制台仍是已安裝狀態；既有設定保持不變，尚未設定者可稍後執行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1`。 |
| DevSpace 設定實際失敗或取消 | 依畫面保留的錯誤處理後，在安裝包資料夾重新執行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1`；全新官方初始化選 ChatGPT。 |
| ChatGPT 無法連到 MCP | 確認自己的公開 HTTPS 入口、認證及帳號權限；本機 MCP 有啟動不等於雲端可連入。 |
| OpenCode 未就緒 | 確認已安裝 OpenCode 1.18.31、官方 DevSpace 1.0.8、Node.js，並已啟動 DevSpace。 |
| 讀不到其他專案 | 允許目錄不會自動擴大，依 [完整安裝手冊](install-and-run.md)調整設定。 |

## 進階命令

在解壓縮後的資料夾開啟 PowerShell：

```powershell
# 只看安裝計畫，不下載或修改檔案
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/quick-install.ps1 -PlanOnly

# 只安裝控制台，略過 DevSpace 設定與立即啟動
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/quick-install.ps1 -NonInteractive -SkipDevSpace -NoLaunch

# 只檢查將要啟動的程式
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/quick-launch.ps1 -PlanOnly
```

原始碼 ZIP 或 Git checkout 也有這兩個入口。`快速安裝.cmd` 取得固定版本的已發布桌面包；若已在原始碼目錄完成 `npm ci` 與 `npm run build`，`快速啟動.cmd` 可開啟該目錄的開發版。
