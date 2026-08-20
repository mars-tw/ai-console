<p align="center">
  <img src="docs/logo.png" width="120" alt="AI Console">
</p>

# AI 控制台 · AI Console

跨 AI 工具的本地對話中樞：統一檢視、去重、搜尋、派工，並用地端模型直接續聊任何一段對話。
附一間會動的像素辦公室，和一套可以邊工作邊玩的小型 MMORPG。

**100% 本地運行，資料不出本機。** 介面支援繁體中文與 English。

> A local hub for every AI CLI on your machine — one searchable inbox for all your
> conversations, one-click resume in the original working directory, and a local-model
> chat that continues any thread without burning cloud quota. Ships with a pixel office
> that visualises each tool as a dragon, and a small single-player MMORPG to idle in.
> Everything runs on `127.0.0.1`; nothing leaves your machine.
> The UI is available in Traditional Chinese and English.

![像素辦公室](docs/screenshot-office.png)

![地城戰鬥](docs/screenshot-battle.png)

![主控台派工](docs/screenshot-console.png)

## 功能

- **統一對話索引**：**掃描全機找出所有 AI 工具的對話紀錄**。判斷依據是檔案內容
  （JSONL 每行是不是帶 role 的訊息、SQLite 有沒有 thread/session/message 表），
  不是寫死的工具名單 —— 所以你裝的工具沒被寫進程式，一樣掃得到
- **還原原生名稱**：對話標題直接讀取各工具的官方紀錄（Codex threads DB、Grok summary.json、Kimi state.json…）
- **專案資料夾分組**：保留各工具原本的工作目錄結構，ChatGPT 式側欄
- **去重**：同一 session UUID 出現多份（跨工具副本 / resume 鏈）自動收攏，保留最新正本
- **時間收納**：一週未用的對話預設收起，保持清單清爽
- **控制 API**（僅 127.0.0.1）：
  - `▶ 派工 / 接續` — 一鍵在原本目錄開終端接續對話（claude --resume / codex resume / kimi -r）
  - `↻ 重新掃描` — 即時重建索引
- **主控台派工**：一個輸入框說一句話，系統自動拆成多張工單、決定每張交給哪個 AI CLI，
  再一次派出去。每張工單都會自動掛上這台機器的規範檔路徑與技能目錄，
  要求執行者先讀規範、自己比對 frontmatter 啟用該用的技能，不會裸奔執行
- **地端續聊**：選任何對話 → 用 LM Studio 地端模型（如 Qwen3.8-27B）帶著近期上下文直接繼續聊，不依賴雲端額度
- **像素辦公室**：把每個 AI 工具具象化成一隻龍，在俯視像素辦公室裡走動、工作、開會，狀態一眼看得出來
- **冒險模式**：內建一套小型 MMORPG，可以邊工作邊掛機練功；純單機，clone 下來就能玩
- **ai-hub 整合**（選配）：讀取 `~/ai-hub/status.json` 顯示各工具即時限流/活動狀態與專案接力標記

## 掃描全機 AI

```bash
python tools/scan_ai.py          # 看掃到哪些 AI 對話來源
python tools/scan_ai.py --deep   # 放寬上限，掃得更徹底
python tools/indexer.py --rescan # 重新掃描並重建索引
```

掃描只讀不寫，有深度、檔案數、時間三重上限，不會翻整台硬碟。結果快取在
`public/data/sources.json`，七天內不重掃。掃不到的話可以用
`AI_CONSOLE_SCAN_DIRS` 指定額外目錄。

## 生圖與生影片

```bash
python tools/imagegen.py          # 看這台機器有哪些 AI 能產圖
python tools/kimi_media.py check  # 檢查 Kimi 憑證與端點
```

**Kimi 桌面版是憑證登入的**，不需要另外申請 API key —— `tools/kimi_media.py`
會從桌面版自己的設定檔讀出金鑰與正式端點，接上 image / video / speech：

```bash
python tools/kimi_media.py image --description "…" --output out.png
python tools/kimi_media.py video --description "…" --output out.mp4 --duration 5
```

金鑰只在記憶體裡傳給 SDK，不會印出來也不會寫進 log。

## 快速開始

需求：Node.js 20+、Python 3.10+（純標準庫，無 pip 依賴）

```bash
npm install                # 安裝前端依賴
python tools/indexer.py    # 建立對話索引 → public/data/
npm run build              # 建置前端 → dist/
python server/api.py       # 啟動整合伺服器 → http://127.0.0.1:5177/
```

開發模式（熱更新）：`npm run dev`（會同時啟動 API + vite）。

地端續聊：安裝 LM Studio 並啟動其本地伺服器（預設 `127.0.0.1:1234`），載入任一模型即可。

## 像素辦公室（🎮 分頁）

七個 AI 工具各自是一隻龍，住在一間程式繪製的俯視像素辦公室裡。畫面不是裝飾，
每個動作都直接對應真實狀態：

| 真實狀態 | 畫面行為 |
|---|---|
| `active` | 坐回自己桌前**瘋狂打電腦**（角色抖動、螢幕跑碼）；兩成機率走去找同事**辯論**（互冒 💢 與對白） |
| `idle` | 在辦公室**偷懶**：上廁所（人消失在門後）、看書、走來走去、泡咖啡、種花 |
| `rate_limited` | 走去沙發**躺下睡覺**，頭上對話框寫明**休息到幾點**（從派工 log 解析工具自己回報的恢復時間） |
| 有 alive 派工 | 走到白板前**執行任務**，白板亮起並跑進度條 |
| `unknown` | 灰階淡出 |
| 三人以上在工作 | 定期自動**開會**：全員走進玻璃會議室就座 |

點任何一隻龍即可開對話框，用地端模型跟它聊天。

## ⚔️ 冒險（小型 MMORPG）

第四個分頁，設計成「邊工作邊玩又不無聊」。**純單機**，不需要任何雲端服務或帳號。

戰鬥是**回合制**（吞食天地／軒轅劍天之痕那種）：一回合裡你先下令要打誰、用哪招，
全場再依速度依序出手。不想動手時切成「沉浸自動」，它會自己打 ——
你切去派工、看對話的時候它照打，切回來隨時接手。

- **沒有職業**：近戰／遠程／魔法／信仰四條線共 16 個技能，各線投點到門檻才解鎖下一階
- **三組套裝**：裝備 + 技能配點 + 屬性配點各存一份，一鍵整組換（坦組／輸出組／補師組）。
  **每一套的配點額度各自獨立**，不共用同一個點數池
- **裝備**：8 個部位、5 種品質、隨機詞綴，附分數方便比較；一鍵擇優換裝、一鍵賣雜物
- **商店**：藥水、補給包、隨機裝備、精製保底、洗屬性點／技能點 —— 金幣有地方花
- **夥伴**：兩種來源、四種定位。七隻 AI 龍是內建的，永遠揪得到；八個人形夥伴要抽卡。
  定位分坦克／輸出／治療／輔助，數值配比與出手偏好都不同。
  **每個夥伴各自累積經驗、各自升級** —— 練誰不練誰是真的有差。
  地城人數不夠會自動補位，打到一半才入隊也會立刻出現在戰場上
- **抽卡**：夥伴與裝備兩個池。**沒有課金** —— 券從打王與超級菁英掉，
  也可以用金幣換，所以它是金幣的另一個出口而不是付費牆。
  重複的夥伴會轉成那一隻的經驗，十連最後一抽保底稀有
- **強化（會爆裝）**：裝備可以 +1 到 +15。+6 以前失敗頂多退級，+7 起有機率直接碎掉；
  保護符可以擋碎裂。沒有失敗代價的強化只是按到夠有錢為止，不是選擇
- **超級菁英**：每 20 等開一階，最高四階。數值不是乘小怪算的，是對著
  「當前等級、全身像樣裝備的主角」定的 —— 全身普通裝打不贏（實測 0%），
  精良裝約六成，稀有裝才穩。一隻抵一整波：保底傳說、抽卡券，還會掉彩蛋裝備
- **彩蛋**：六個藏起來的常駐技能與六件獨一無二的裝備。
  條件都做得到但不會不小心達成（例如連續倒下十次會拿到「復仇者」：每回合回復 10% 生命），
  沒解鎖時介面只給線索
- **寵物**：打王有機會收服，會跟著出戰、自己升級
- **男女主角**：外觀可選，戰鬥圖跟著換
- **地圖**：8 張野外 + 5 座地城，地城要多房間推進到王，掉落階級更高
- **一波多隻怪**：等級越高一次遇到越多（最多 4 隻），還會出精英怪 —— 回合制才有得選

存檔在瀏覽器 localStorage，資料不出本機。

如果剛好接得到本機工具狀態，夥伴會多一層風味：`idle` 精神飽滿（+15% 等級）、
`rate_limited` 睡眼惺忪（−15%）。接不到完全不影響遊玩。

### 素材產生管線

角色與環境都是 AI 生成的像素圖，但**不是**直接把生成圖丟進場景 ——
生成模型畫不出對齊的 sprite sheet，也畫不出比例正確的俯視平面圖，所以拆開處理：

```bash
python tools/imagegen.py                     # 先看這台機器上有哪些 AI 能畫圖
python tools/gen_sheets_grok.py              # 角色：逐格生成 12 個姿勢
python tools/gen_sheets_grok.py kimi --pose 6  # 只重生某一格（以 canonical 為參考）
python tools/pack_sprites.py                 # 切格 → 去背 → 統一比例 → 對齊腳底 → 打包

python tools/gen_office_art.py               # 環境：地板材質 + 家具配件
python tools/gen_office_art.py --only sofa   # 只重生某一件
python tools/pack_props.py                   # 去背 → trim → 依格數縮放
```

**產圖不綁單一 AI。** `tools/imagegen.py` 會探測這台機器上裝了哪些能畫圖的
AI（Grok CLI / Codex CLI / Qwen / kimi 產圖外掛），批次時「一個後端一個執行緒」
平行跑，某一家撞額度就把那件丟回佇列換別家接手。要指定的話用 `--backend grok`。

執行檔位置一律用「設定檔 → 環境變數 → PATH → 常見安裝位置」探測，沒有寫死任何
個人目錄；找不到時可用 `AI_CONSOLE_GROK` / `AI_CONSOLE_CODEX` / `AI_CONSOLE_QWEN`
指定，或設 `KIMI_API_KEY`。

`pack_sprites.py` 做的正規化是動畫不抖的關鍵：每格依 alpha 去除留白、**全部格子套用
同一個縮放比例**（由正面站姿決定）、腳底對齊格內固定基準線。產出
`public/office/sprites/{agent}.png`（4 欄 × 3 列，每格 48×48）。

素材缺席時引擎會退回程式繪製的備援龍，畫面不會開天窗。

## 架構

```
tools/indexer.py           # 對話索引器：掃描 → 正規化 → 去重 → 專案分組 → public/data/*.json
tools/gen_sheets_grok.py   # 角色動作圖生成（派工給 Grok CLI）
tools/pack_sprites.py      # 動作圖 → 引擎用 sprite sheet
server/api.py              # 整合伺服器：dist 靜態 + /data 即時資料 + /api 控制端點
tools/imagegen.py          # 共用產圖層：多 AI 後端探測與派工
tools/gen_office_art.py    # 環境材質與家具生成
tools/pack_props.py        # 家具 → 引擎用素材
src/pixel/                 # 像素辦公室引擎：房間、精靈、尋路、狀態機、渲染
src/rpg/                   # 冒險模式：資料模型、內容表、戰鬥引擎、存檔
src/                       # React + TypeScript + Tailwind 前端
```

路徑全部以 `Path.home()` 推導，無硬編碼使用者目錄。

## 隱私與安全

- 所有資料與 API 僅綁定 `127.0.0.1`，不對外開放
- 索引器對原始對話檔**只讀不寫**
- 清理工具（`tools/cleanup_old.py`）採「封存 → 驗證 → 刪除」流程

## License

MIT
