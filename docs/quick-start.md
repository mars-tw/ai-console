# 快速安裝與快速啟動

適用 Windows 64 位元／AI Console v1.5.1。

## 第一次使用

1. 下載 [快速安裝包](https://github.com/mars-tw/ai-console/releases/download/v1.5.1/ai-console-quick-start-v1.5.1.zip)，解壓縮整個 ZIP。
2. 雙擊 **`快速安裝.cmd`**。
3. 程式會下載固定版本的 Windows 桌面包，比對 SHA256，再安裝到你的使用者目錄。
4. 缺少 Node.js、Git Bash 或 DevSpace 時，依視窗提示選擇是否安裝。若 Windows 顯示權限或授權條款，由你確認後繼續。
5. 第一次設定 DevSpace 時，輸入已存在的專案資料夾完整路徑，再選 `codex` 或 `claude`。只會授權這個專案；不需手動修改 JSON。
6. 安裝完成會建立桌面與開始功能表捷徑，並開啟 DevSpace 控制台。

已有完整的 DevSpace 設定時會直接沿用，保留原本的允許目錄、認證與本機擴充。若現有設定不完整，精靈會顯示處理方式，不會重新產生認證覆蓋原檔。

AI 工具與帳號登入仍依原工具的流程完成。安裝完成代表控制台及 DevSpace 準備步驟已完成，不代表 AI 已登入、有可用額度或模型已載入。標準上游 DevSpace 沒有 `local` provider，需另外提供相容整合才可使用本機 AI。

## 以後怎麼開

雙擊桌面 **「DevSpace 控制台」**，或安裝包裡的 **`快速啟動.cmd`**，即可直接進入 DevSpace 分頁。日常啟動不會重新下載或安裝。

若你下載的是 [完整 Windows 免安裝包](https://github.com/mars-tw/ai-console/releases/download/v1.5.1/ai-console-win32-x64-v1.5.1.zip)，解壓縮後可直接雙擊 `快速啟動.cmd`；想建立正式安裝位置與捷徑，再按 `快速安裝.cmd`。完整包會使用同資料夾內的程式，不必再次下載桌面包。

## 安裝位置與版本

- 程式：`%LOCALAPPDATA%\Programs\AIConsole\versions\1.5.1\`
- 目前版本指標：`%LOCALAPPDATA%\Programs\AIConsole\current.json`
- 安裝日誌：`%LOCALAPPDATA%\AIConsole\installer-logs\`

控制台安裝到自己的使用者目錄，不需要管理員權限。Node.js 或 Git 的系統安裝程式可能另外要求權限。新版放在獨立版本目錄，舊版檔案保留；重跑相同版本時會檢查檔案是否一致。

快速安裝包只有啟動腳本與說明，首次需要網路下載完整程式。完整免安裝包已含 Electron 與 Python；DevSpace 或其他尚未安裝的工具仍可能需要網路。

## 遇到問題

| 問題 | 做法 |
| --- | --- |
| 下載失敗或 checksum 不符 | 檢查網路，重新下載完整官方安裝包後重試。程式不會使用未通過校驗的下載檔。 |
| 找不到 winget | 依提示到 Node.js、Git 官方網站安裝，再重跑快速安裝。 |
| 現有 Node.js 版本不符 | 先用自己的版本管理工具換成支援版本（`>=22.19 <27`）。精靈不會自行升級或取代現有版本。 |
| 提示已有不同的同版本安裝 | 保留原安裝，使用完整官方包重新檢查。進階使用者可用 `-InstallRoot` 指定新的安裝位置。 |
| 程式已裝好，但 DevSpace 設定未完成 | 依錯誤提示處理，重跑 `快速安裝.cmd`；也可直接執行 `scripts\setup-devspace.ps1` 繼續設定。 |
| 讀不到其他專案 | 已存在的允許目錄不會自動擴大。請依 [完整安裝手冊](https://github.com/mars-tw/ai-console/blob/main/docs/install-and-run.md) 調整 DevSpace 設定。 |

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

原始碼 ZIP 或 Git checkout 也有這兩個入口。`快速安裝.cmd` 會取得已發布的桌面版；若你已在原始碼目錄完成 `npm ci` 與 `npm run build`，`快速啟動.cmd` 可開啟該目錄的開發版。
