# 安裝與執行手冊

適用 AI Console v1.5.1／Windows 64 位元。一般使用者從第一節開始；自行修改程式的人可看第六節。

想減少手動設定，可先用 [快速安裝包](https://github.com/mars-tw/ai-console/releases/download/v1.5.1/ai-console-quick-start-v1.5.1.zip)，解壓縮後雙擊 `快速安裝.cmd`。完整步驟見 [快速開始說明](quick-start.md)。以下保留手動安裝與開發者操作方式。

## 1. 下載並開啟控制台

1. 下載 [Windows 免安裝版 v1.5.1](https://github.com/mars-tw/ai-console/releases/download/v1.5.1/ai-console-win32-x64-v1.5.1.zip)。請選檔名含 `win32-x64` 的 ZIP。
2. 用 Windows「全部解壓縮」解開整個 ZIP，放到之後會保留的資料夾。
3. 進入 `AI控制台-win32-x64`，雙擊 `AI控制台.exe`。
4. 一般問答請按「接入 AI」；要讀寫專案或寫程式，請完成下方的 DevSpace 設定，再切到「DevSpace」。

控制台已內附 Python。請保留同資料夾內的 `resources`、DLL 等檔案；只搬走 EXE 會無法啟動。DevSpace、AI 工具、模型與帳號需另外準備。

下次使用只要再次開啟 `AI控制台.exe`。在檔案總管中對 EXE 按右鍵，可用 Windows 的「建立捷徑」功能放到桌面。

要直接進入 DevSpace 分頁，可在 EXE 所在資料夾開啟 PowerShell，執行：

```powershell
& ".\AI控制台.exe" --devspace
```

## 2. 第一次安裝 DevSpace

已有可正常運作的 DevSpace 時，可直接檢查第三節的目錄設定。

先安裝：

- [Node.js](https://nodejs.org/en/download)：建議使用 24.x。此手冊查核時，上游要求 Node `>=22.19 <27`。
- [Git for Windows](https://git-scm.com/install/windows)：包含 Git Bash；DevSpace 執行專案指令時需要 Bash。
- 至少一個要派工的 AI 工具，例如 [Codex](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://code.claude.com/docs/en/quickstart)。依該工具的官方說明完成安裝與登入。

安裝後重新開啟 PowerShell，依序執行：

```powershell
node --version
npm.cmd --version
git --version
npm.cmd install --global @waishnav/devspace@1.0.8
devspace.cmd init
```

這份控制台目前依 DevSpace 1.0.8 的介面整合。上面使用 `.cmd`，可避免 PowerShell 改去執行 npm 產生的 `.ps1` 啟動檔。

安裝完成後若控制台仍找不到 Node.js 或 DevSpace，請在既有工作結束後重新啟動 Windows，再開啟控制台，讓背景程序讀到更新後的 PATH。

`init` 詢問使用方式時，僅使用本機桌面控制台可選 **Coding Agents**；執行者選擇你已準備好的 Codex 或 Claude。初始化會建立本機設定與認證檔。

**Coding Agents 模式不會詢問允許的專案目錄，仍須完成第三節。** 本機桌面派工不需要先架設公開網址或 tunnel。

「本機 AI」是選用整合：只有你的 DevSpace 安裝本身提供並啟用 `local` provider 時才可使用。標準上游 DevSpace 1.0.8 沒有這個 provider；單獨安裝 LM Studio 或下載 AI Console，並不會自動加入它。

## 3. 設定可以操作的專案目錄

先選一個已存在、要讓 AI 工作的專案資料夾，在檔案總管複製完整路徑。控制台只接受 DevSpace 設定允許的目錄與其子目錄。

在檔案總管的網址列輸入 `%USERPROFILE%\.devspace`，開啟初始化產生的設定檔。若有 `config.jsonc`，以它為準；舊版使用 `config.json`。只調整下面對應欄位，保留原檔的其他設定。

新版 `config.jsonc`：在既有 `workspaces` 物件內設定 `allowedRoots`。以下只示範相關欄位：

```json
{
  "workspaces": {
    "allowedRoots": ["C:/Users/你的帳號/Documents/AIProjects"]
  }
}
```

舊版 `config.json`：`allowedRoots` 放在最外層：

```json
{
  "allowedRoots": ["C:/Users/你的帳號/Documents/AIProjects"]
}
```

請把範例路徑換成剛才複製的實際路徑；範例中的「你的帳號」不能原樣使用。在 JSON 內用 `/` 分隔路徑，或把反斜線寫成 `\\`。這兩段是欄位位置示意，**不要用它們覆蓋整份既有設定檔**。

儲存後回到控制台，按「重新整理狀態」。正常時會看到「CLI 安裝：已安裝」、「工作目錄設定：已設定」，以及你新增的允許目錄。

若執行者仍顯示「未啟用」，請依 [DevSpace 設定說明](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md) 檢查 `subagents.enabled` 與對應 provider 的 `enabled`；安裝 AI 工具和啟用 provider 是兩個步驟。

## 4. 送出第一個工作

1. 開啟「DevSpace」分頁，按「檢查 DevSpace 設定」。
2. 從「允許的工作目錄」選擇資料夾，或在「專案或子目錄」填入其下的專案路徑。
3. 確認畫面列出的「實際執行目錄」。選到 Git 專案的子目錄時，DevSpace 會改以該專案的 Git 根目錄執行。
4. 選擇已安裝、登入並啟用的 Codex 或 Claude。
5. 在「要執行的工作」輸入需求，按「送出工作」。
6. 從下方「工作紀錄」選取任務，在「執行結果」查看回覆。完成後可輸入後續指示，按「接續執行」。

第一次可先確認讀取能力：

> 讀取這個專案的 README 與程式目錄，告訴我專案用途、啟動方式及測試指令，先不要修改檔案。

確認執行成功後，再交付具體修改工作，例如：

> 找出這個專案的建置錯誤，修正相關程式，執行測試，最後列出修改的檔案與測試結果。

派工可能實際修改專案檔案。選擇雲端 AI 時，任務內容與執行所需的專案資料會交給所選服務；模型、帳號及用量依該服務的規則處理。

## 5. 啟動、停止與常見問題

| 畫面或問題 | 處理方式 |
| --- | --- |
| MCP 顯示「未連線」 | 需要 MCP client 連入時按「啟動 MCP」。本機 agent 派工與 HTTP MCP 是不同服務，MCP 尚未啟動不一定會阻止派工。 |
| 任務服務顯示「未啟動」 | 送出工作時由 DevSpace 啟動；只開啟頁面不會派工。 |
| 找不到 `devspace.cmd` | 確認全域安裝完成，重新開啟 PowerShell；執行 `npm.cmd prefix --global`，確認該目錄在 PATH 中。 |
| CLI 已安裝，但顯示尚未設定 | 完成 `devspace.cmd init`，再按「重新整理狀態」。 |
| 沒有允許目錄，或工作目錄被拒絕 | 依第三節設定；資料夾必須存在，且實際 Git 根目錄也必須在允許範圍內。 |
| 顯示設定版本需轉換 | 先依上游的初始化／遷移流程完成設定，再回來重新整理。控制台不會自行改寫設定。 |
| 執行者灰色或未啟用 | 檢查 DevSpace 的 provider 設定與 AI 工具安裝。標準安裝沒有 `local` 時，本機 AI 會維持不可選。 |
| 任務回報登入、額度或模型錯誤 | 在原 AI 工具完成登入、檢查用量或模型，再回來派工。清單顯示已啟用不代表實際執行成功。 |
| 「停止 MCP」按鈕不可用 | 已有的外部服務不由控制台停止；請回原本的啟動工具操作。停止 MCP 也不會取消 agent 任務。 |
| 送出後連線中斷 | 先查看工作紀錄，確認任務是否已建立，再決定是否重送。 |

需要更多環境資訊時，可在 PowerShell 執行：

```powershell
devspace.cmd doctor
devspace.cmd agents targets --json
```

關閉控制台視窗不等於取消已送出的工作。DevSpace 1.0.8 沒有停止單一任務的 CLI，此版本控制台也未提供該按鈕。

## 6. 開發者：從原始碼執行或打包

需要 Node.js 24.x、Git 與 Python 3.10 以上。於 PowerShell 執行：

```powershell
git clone https://github.com/mars-tw/ai-console.git
cd ai-console
npm.cmd ci
npm.cmd run build
npm.cmd run app -- --devspace
```

開發時要熱更新，改執行 `npm.cmd run dev`，依終端顯示的本機網址開啟。前後端驗證指令是 `npm.cmd run verify`。

製作 Windows 發行包與桌面捷徑：

```powershell
npm.cmd run pack
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-desktop-shortcut.ps1 -DevSpace
```

成品在 `release/clean/AI控制台-win32-x64/`，桌面會新增「DevSpace 控制台」。打包程式依 Git 追蹤清單挑選檔案，因此 `npm.cmd run pack` 需要上面的 Git checkout。

如果下載的是原始碼 ZIP，可在解壓縮後執行 `npm.cmd ci`、`npm.cmd run build`、`npm.cmd run app -- --devspace`；要打包時請先改用 `git clone`。

## 參考

- [DevSpace 官方專案與安裝說明](https://github.com/Waishnav/devspace)
- [AI Console v1.5.1 下載頁](https://github.com/mars-tw/ai-console/releases/tag/v1.5.1)
- [DevSpace 桌面控制台與 API 說明](https://github.com/mars-tw/ai-console/blob/main/docs/devspace-desktop.md)
