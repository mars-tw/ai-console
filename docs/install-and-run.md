# 安裝與執行手冊

適用 AI Console v1.7.0／Windows 64 位元。DevSpace 分頁使用 **ChatGPT「對話」＋ DevSpace MCP**；OpenCode 另有獨立入口。第一次安裝可先看 [快速開始說明](quick-start.md)。

## 1. 下載並開啟控制台

1. 下載 [快速安裝包 v1.7.0](https://github.com/mars-tw/ai-console/releases/download/v1.7.0/ai-console-quick-start-v1.7.0.zip)，完整解壓縮後雙擊 `快速安裝.cmd`；或下載 [Windows 免安裝版 v1.7.0](https://github.com/mars-tw/ai-console/releases/download/v1.7.0/ai-console-win32-x64-v1.7.0.zip)。
2. 使用快速安裝包時，畫面會顯示下載、SHA256 校驗、解壓縮、檔案複製與驗證、版本指標及捷徑建立進度。控制台驗證完成後，可選 **「現在設定 DevSpace」**，或 **「稍後設定，先開啟控制台」**；未通過檢查前不會顯示完成。
3. 選擇稍後設定時，本次不檢查或修改既有 DevSpace 設定，既有設定保持不變。只有實際開始設定後取消或發生錯誤，才會顯示「DevSpace 設定未完成」。兩種情況都不會刪除已安裝的控制台；除非使用 `-NoLaunch`，控制台仍會開啟。
4. 使用免安裝版時，解壓縮整個 ZIP，進入 `AI控制台-win32-x64`，雙擊 `AI控制台.exe`。
5. 要透過 ChatGPT 讀寫專案，切到「DevSpace」；使用 OpenCode，切到「OpenCode」。一般文字問答與原有其他功能仍從各自入口使用。

Windows 發行包已內附 Python。請保留同資料夾內的 `resources`、DLL 等檔案；只搬走 EXE 會無法啟動。DevSpace、OpenCode、模型與帳號需另外準備。

下次雙擊桌面「DevSpace 控制台」、`快速啟動.cmd` 或 `AI控制台.exe` 即可。要直接進入 DevSpace 分頁，也可以執行：

```powershell
& ".\AI控制台.exe" --devspace
```

## 2. 第一次安裝 DevSpace

已有可正常運作的 DevSpace 時，沿用既有設定與認證，再檢查第三節的允許目錄。

先準備：

- [Node.js](https://nodejs.org/en/download)：DevSpace 1.0.8 支援 `>=22.19 <27`，可使用 24.x。
- [Git for Windows](https://git-scm.com/install/windows)：包含執行專案指令需要的 Git Bash。
- 已登入的 Chrome ChatGPT，以及該帳號允許使用的 MCP 連接功能。

快速安裝精靈會檢查本機工具；全新互動設定會開啟官方 `devspace init`。若在快速安裝時選擇稍後設定，或先前設定被取消／失敗，回到快速安裝包資料夾執行下列第一個命令即可接續，不必重新安裝控制台：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1
```

要自行準備工具時，也可以在 PowerShell 手動執行：

```powershell
node --version
npm.cmd --version
git --version
npm.cmd install --global @waishnav/devspace@1.0.8
devspace.cmd init
```

官方初始化詢問使用方式時，選擇 **ChatGPT**。依提示設定允許的專案目錄，以及你自己的公開 HTTPS 入口與正常認證流程。控制台不會替你建立公開網址、變更 DNS、建立 tunnel 或登入 ChatGPT。已有能使用的 HTTPS MCP 入口時，保留原設定即可。

ChatGPT 必須能連到你的 DevSpace MCP 入口。本機 `http://127.0.0.1:7676/mcp` 只供這台電腦使用，不能直接填入雲端 ChatGPT 作為公開連線。依 [DevSpace 官方說明](https://github.com/Waishnav/devspace)準備入口，再依 [OpenAI 官方 MCP 連接說明](https://developers.openai.com/plugins/deploy/connect-chatgpt)加入連線。

這個流程不需要安裝 Codex 或 Claude CLI，也不需要啟用 DevSpace agent 工作。舊版相容參數 `-Provider` 仍保留給原有 Coding Agents 設定，首次使用本手冊的對話流程不需指定它。

安裝後若控制台仍找不到工具，先關閉並重開控制台，讓程序取得新的 PATH；必要時重新登入 Windows。PowerShell 指令使用 `.cmd`，可避免改去執行 npm 產生的 `.ps1` 啟動檔。

## 3. 設定可以操作的專案目錄

選擇已存在的專案資料夾並複製完整路徑。DevSpace 只允許設定中的根目錄及其子目錄；選到 Git 專案子目錄時，也須確認該專案實際根目錄在允許範圍內。

在檔案總管輸入 `%USERPROFILE%\.devspace`。若有 `config.jsonc`，以它為準；舊版使用 `config.json`。只調整對應欄位，保留原檔其他設定。

新版 `config.jsonc` 的欄位位置：

```json
{
  "workspaces": {
    "allowedRoots": ["C:/Projects/MyProject"]
  }
}
```

舊版 `config.json` 的欄位位置：

```json
{
  "allowedRoots": ["C:/Projects/MyProject"]
}
```

把範例換成實際存在的專案路徑。JSON 內可用 `/` 或 `\\` 分隔路徑。**這兩段只示範欄位位置，不要覆蓋整份既有設定檔。** 儲存後回到「DevSpace」，查看允許目錄與 MCP 狀態。

## 4. 在 ChatGPT 對話中完成第一個需求

1. 在「DevSpace」填入專案資料夾與「要在對話中完成的內容」。
2. 按主要操作「複製指示並開啟 ChatGPT」。只有剪貼簿寫入成功後才會開啟網站；也可分別使用複製與開啟按鈕。
3. 確認 Chrome 已登入正確帳號，ChatGPT 選中「對話」，從新增內容或工具選單加入 DevSpace，並在 ChatGPT 畫面選擇實際模型。
4. 貼上指示，保留 DevSpace 連接器標籤，確認專案路徑後自行送出。
5. 查看對話中的 MCP 工具結果；模型應透過 `open_workspace` 開啟專案，再讀寫檔案或執行指令。需要修改時，在同一段對話接續。
6. 回到本機檢查產出的檔案、程式差異與測試結果。原派工者以這些實際成果接手。

第一個需求可以是：

> 讀取指定專案的 README 與程式目錄，整理啟動與測試方式，在專案內寫入一份使用說明，並讀回確認內容。最後列出成果路徑與尚未確認的事項。

使用 GPT-5.6 SOL 或 GPT-6 ASTRA 時，以 ChatGPT 選單真正顯示的模型為準。面板偏好與指示文字都不會遠端切換模型；帳號未提供該模型時，不會自動改派其他模型。點擊開啟網站或複製文字，也不等於訊息已送出。

此入口不建立 ChatGPT「工作」或 DevSpace 背景工作。對話內容與必要的工具結果會交給所選模型服務；請限定操作範圍，避免加入無關私人資料。

## 5. 使用 OpenCode 工作臺

OpenCode 是獨立的對話工具，並非 ChatGPT 失敗時的自動替代路線。在 PowerShell 安裝：

```powershell
npm.cmd install --global opencode-ai@1.18.31
```

完成 DevSpace 初始化並啟動本機 MCP 服務後：

1. 在桌面控制台切到「OpenCode」，選擇 DevSpace 允許的專案與 SOL／ASTRA 預設模型。
2. 按「開啟 OpenCode 對話」。首次 MCP 連線會開啟「Connect DevSpace／AI Console OpenCode」授權頁，由你輸入初始化時的 DevSpace owner 密碼並確認授權。
3. 回到 OpenCode，依正常 Connect 流程完成 OpenAI 帳號登入。這與 DevSpace 授權是兩個不同步驟。
4. 在對話中輸入需求，查看並確認 MCP 讀寫檔案與指令操作。
5. 要切換專案或預設模型，先按「停止 OpenCode」，再重新開啟。

控制台提供 OpenCode 所需的 DevSpace bridge，不必安裝私人修改版 DevSpace。OpenCode 服務只綁定本機，使用每次啟動產生的 Basic 認證；帳號登入與服務認證分開處理。詳見 [DevSpace 與 OpenCode 說明](devspace-desktop.md)。

安裝檢查與服務健康狀態不會呼叫模型。「已安裝」或「已啟動」不代表帳號已登入、有額度或模型能回覆，仍須以實際對話結果確認。

## 6. 常見問題

| 畫面或問題 | 處理方式 |
| --- | --- |
| 快速安裝顯示本次未執行 DevSpace 設定 | 這不代表既有設定有問題；安裝器沒有檢查或修改它。尚未設定者可在安裝包資料夾執行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1`。 |
| 快速安裝顯示控制台已安裝，但 DevSpace 設定未完成 | 這表示實際設定步驟已失敗或取消，不必重裝控制台。先依保留的錯誤處理，再於安裝包資料夾重新執行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1`。 |
| 找不到 Node.js、Git Bash 或 DevSpace | 完成對應安裝，重開控制台；可在 PowerShell 執行版本指令檢查 PATH。 |
| 沒有允許目錄，或路徑被拒絕 | 依第三節設定，確認資料夾存在，Git 根目錄也在允許範圍內。 |
| MCP 未啟動 | 在 DevSpace 分頁展開「本機 MCP 服務」，按「啟動 MCP」。已有外部服務時沿用原服務。 |
| 本機 MCP 有啟動，但 ChatGPT 無法連線 | 檢查 ChatGPT 連接器的公開 HTTPS 入口、認證與帳號權限；本機健康狀態不能證明雲端入口正常。 |
| Chrome 開到錯誤帳號 | 切回已有 DevSpace 連線的 Chrome 設定檔，再開啟 ChatGPT。 |
| 模型選單沒有 SOL／ASTRA，或回覆失敗 | 檢查使用中的服務、登入帳號、模型權限與用量，保留原錯誤，不自動換模型。 |
| 複製指示後沒有執行 | 複製只準備文字；還要在已加入 DevSpace 的 ChatGPT 對話貼上並送出。 |
| 對話說完成，但本機沒有檔案 | 回到同一對話提供具體缺少的路徑，要求讀回確認；不要把文字承諾視為成果。 |
| OpenCode 顯示找不到 bridge 或 DevSpace | 使用完整的 v1.7.0 包，確認官方 DevSpace 1.0.8、Node.js 與 OpenCode 已安裝，再重新整理狀態。 |
| OpenCode 首次 MCP 授權逾時 | 授權頁等待最多 150 秒；先停止並重開 OpenCode，再於瀏覽器完成 DevSpace 正常授權。服務停止、bridge 消失或重啟時，工作臺會回到可重試狀態；實際心跳恢復後再重新連接。 |
| 「停止 MCP」不可用 | 只能停止控制台自行啟動的服務；外部服務請回原啟動工具操作。 |

診斷 DevSpace 可執行 `devspace.cmd doctor`。關閉對話視窗不等於終止已在執行的本機指令；請在原對話確認操作結果再接手。

## 7. 開發者：從原始碼執行或打包

準備 Node.js 24.x、Git 與 Python 3.10 以上，於 PowerShell 執行：

```powershell
git clone https://github.com/mars-tw/ai-console.git
cd ai-console
npm.cmd ci
npm.cmd run build
npm.cmd run app -- --devspace
```

開發時執行 `npm.cmd run dev`；前後端驗證用 `npm.cmd run verify`。Windows 發行包與捷徑可用：

```powershell
npm.cmd run pack
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-desktop-shortcut.ps1 -DevSpace
```

成品位於 `release/clean/AI控制台-win32-x64/`，請保留整個資料夾。打包程式依 Git 追蹤清單挑選檔案；原始碼 ZIP 可建置與執行，要打包請改用 Git checkout。

## 參考

- [DevSpace 官方專案](https://github.com/Waishnav/devspace)
- [OpenAI：連接並測試 MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenCode 官方網站](https://opencode.ai/zht)
- [AI Console v1.7.0 下載與版本說明](https://github.com/mars-tw/ai-console/releases/tag/v1.7.0)
