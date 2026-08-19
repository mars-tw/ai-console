# tools/

這裡放的是**開源版就會帶著走**的通用工具。

| 檔案 | 用途 |
|---|---|
| `scan_ai.py` | 掃描全機，靠檔案內容找出所有 AI 工具的對話紀錄 |
| `indexer.py` | 對話索引器：掃描 → 正規化 → 去重 → 專案分組 |
| `imagegen.py` | 共用產圖層：探測本機可用的產圖 AI，多後端平行 |
| `kimi_media.py` | Kimi 生圖／生影片（自動解析桌面版憑證） |
| `gen_sheets_grok.py` / `pack_sprites.py` | 角色動作圖生成與打包 |
| `gen_office_art.py` / `pack_props.py` | 辦公室環境材質與家具生成與打包 |
| `cleanup_old.py` / `cleanup_dispatch.py` | 對話封存與清理 |
| `clean_watermark.py` | 素材後處理 |

## 找不到某支腳本？

含個人專案路徑的私人工作流腳本**不在這裡**，在專案根目錄的 `private/`
（在 `.gitignore` 內，不進版控）。完整的搬遷清單、執行方式與憑證位置，
看 `private/README.md`。

## 設定

所有路徑都從 `server/config.json` 讀，程式碼裡不寫死任何個人目錄。
格式看 `server/config.example.json`。

專案分類規則放 `tools/projects.local.json`（gitignore），
格式看 `tools/projects.example.json`。
