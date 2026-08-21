// 宣傳截圖：用專案已經有的 Electron 開一個乾淨視窗，擺好畫面再拍
//
// 為什麼不用瀏覽器擷圖：
//   1. 要能在拍之前先把存檔擺成「看起來像玩了一陣子」的樣子，
//      而且絕對不能動到使用者自己的存檔 —— Electron 有自己的儲存空間，天然隔離
//   2. capturePage() 直接吐 PNG，不用把 base64 搬來搬去
//
// 用法：npx electron scripts/shot.cjs [dev server URL]
// 產出：docs/screenshot-*.png

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL_BASE = process.argv[2] || 'http://localhost:3000'
const OUT_DIR = path.join(__dirname, '..', 'docs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 拍之前先把存檔擺成玩了一段時間的樣子。跑在頁面裡。 */
const SEED = `(async () => {
  const E = await import('/src/rpg/engine.ts')
  const S = await import('/src/rpg/save.ts')
  const h = E.newHero('你', 'hero')
  h.level = 26
  h.gold = 5840
  h.kills = 1247
  h.deaths = 9
  h.potions = { hp: 6, mp: 4 }
  // 隊伍混一隻 AI 龍與兩個人形夥伴，兩種夥伴都要入鏡
  const A = await import('/src/rpg/allies.ts')
  A.ensureRoster(h)
  for (const kind of ['knight', 'mage', 'cleric', 'miko']) {
    h.roster.push({ id: kind, kind, level: 24, xp: 0 })
  }
  // newHero() 在 level 還是 1 的時候就補了七隻龍，這裡把等級補到跟主角同一段。
  // 不然畫面上會出現一隻 Lv.1 的隊友被一下秒掉，看起來像壞了
  for (const r of h.roster) r.level = Math.max(r.level, 24)
  h.party = ['knight', 'mage', 'kimi']
  h.tickets = { ally: 3, gear: 2, protect: 2 }
  const lo = E.activeLoadout(h)
  Object.assign(lo.attrs, { str: 26, dex: 14, int: 8, fai: 6, vit: 24 })
  Object.assign(lo.skills, { slash: 5, cleave: 4, execute: 3, guardup: 2 })
  for (let i = 0; i < 14; i++) h.bag.push(E.rollItem(26, undefined, i < 6 ? 'rare' : 'fine'))
  E.autoEquipBest(h)
  // art 一定要用 PET_KINDS 裡真的有的 id，否則畫出來是佔位方塊。
  // 不要靠 fetch 檢查圖檔在不在 —— Vite 對未知路徑會回 index.html 加 200，驗不出來。
  const kind = (await import('/src/rpg/data.ts')).PET_KINDS[2]
  h.pets = [{ id: 'p1', ...kind, level: 7, xp: 20 }]
  h.activePet = 'p1'
  S.saveHero(h)
  localStorage.setItem('ac_lang', 'zh')
  // 主題釘成深色。預設是「跟隨系統」，而系統是亮的還暗的因人而異 ——
  // 辦公室與地城那兩張本來就是深色像素場景，主控台跟著亮起來會不搭。
  // 釘死之後不管誰在哪台機器上重拍，三張都是同一個色調。
  localStorage.setItem('ac_theme', 'dark')

  // 主控台那張的派工計畫也擺在這裡，不要在截圖時真的去呼叫拆解器。
  //
  // 原本是「填輸入框 → 按分析並排程 → 輪詢等結果」。那看起來比較誠實，
  // 但結果取決於當下 LM Studio 載了哪個模型 —— 這台機器載 dense 27B 時
  // 一份三步驟的計畫要四分鐘以上，輪詢視窗等不到，拍出來會是「拆解中…」
  // 或逾時後的警告訊息。宣傳圖不該有這種不確定性。
  // 計畫本來就存在 localStorage（切分頁不會弄丟），從這裡塞進去
  // 跟使用者自己拆出來的完全一樣，畫面沒有造假。
  localStorage.setItem('ac_console_steps', JSON.stringify([
    { tool: 'codex', task: '掃過 tools/ 底下每一個 .py，補上檔案開頭的用途說明與參數表',
      why: '規格明確、範圍清楚，適合一次講完的工單', state: 'idle' },
    { tool: 'claude', task: '依補好的說明調整 README 的架構段落，讓它跟實際檔案對得起來',
      why: '要跨檔案讀上下文再改寫', state: 'idle' },
    { tool: 'qwen', task: '跑一次完整測試（npm test），把失敗的項目整理成清單',
      why: '量大但不難，用便宜的就好', state: 'idle' },
  ]))
  return h.level
})()`

/**
 * 每張截圖前都要做的事：把畫面上所有本機絕對路徑換成中性佔位字串。
 *
 * 派工面板（辦公室的「中控指揮台」、主控台的「執行中的派工」）會顯示工單全文，
 * 裡面含專案的絕對路徑。在使用者自己的機器上顯示是對的 —— 他要靠它找回工作紀錄；
 * 但拍成宣傳圖放上 GitHub 就等於把本機目錄結構公開。
 *
 * 選擇「就地取代」而不是「整塊藏起來」，是因為那些面板本來就是要展示的功能，
 * 藏掉等於少拍一個賣點；只把路徑匿名化，畫面其餘部分仍然是真的。
 *
 * 用 String.raw 是必要的：一般樣板字串會把 backslash-s 吃掉、把 backslash-slash
 * 變成 slash，後者會讓 regex 字面值提早結束，整段檢查靜靜地壞掉。
 */
const REDACT = String.raw`(() => {
  const re = /[A-Za-z]:\\[^\s]+|\/(?:Users|home)\/[^\s]+/g
  const SAFE = '~/projects/ai-console'
  const walk = (el) => {
    for (const nd of el.childNodes) {
      if (nd.nodeType === 3) nd.textContent = nd.textContent.replace(re, SAFE)
      else if (nd.nodeType === 1) walk(nd)
    }
  }
  walk(document.querySelector('main'))
  for (const e of document.querySelectorAll('main [title]')) {
    e.setAttribute('title', e.getAttribute('title').replace(re, SAFE))
  }
})()`

/** 找按鈕：用文字比對，跟人一樣 */
const clickJs = (re) =>
  `[...document.querySelectorAll('button')].find(b => ${re}.test(b.textContent.trim()))?.click(), 1`

const SHOTS = [
  {
    name: 'screenshot-office',
    steps: [clickJs('/^🎮 辦公室$/')],
    settle: 6000,          // 等美術載完 + 龍走到定位
  },
  {
    name: 'screenshot-battle',
    steps: [
      clickJs('/^⚔️ 冒險$/'),
      // 挑等級最接近上限的地城：人不夠會自動補位，而且怪夠硬，
      // 拍到的是打到一半（血條有缺角、特效在播），不是「通關！」的結算畫面
      `await new Promise(r => setTimeout(r, 800)); ${clickJs('/古龍巢穴/')}`,
    ],
    settle: 4200,
  },
  {
    name: 'screenshot-console',
    steps: [
      clickJs('/^🎙️ 主控台$/'),
      // 打一句範例需求進去，空白的輸入框看不出這個分頁在做什麼
      `const ta = document.querySelector('main textarea')
       if (ta) {
         const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
         set.call(ta, '幫我把 tools 底下的腳本都補上使用說明，然後跑一次測試')
         ta.dispatchEvent(new Event('input', { bubbles: true }))
       }`,
      // 計畫已經由 SEED 擺好了，這裡不按「分析並排程」——
      // 見 SEED 裡的說明：真的去呼叫地端拆解器會讓截圖結果取決於
      // 當下載了哪個模型，慢的時候只拍得到「拆解中…」。
      //
      // 定時工作那一區**刻意不展開**。它讀的是伺服器上使用者真實的排程，
      // 名稱與工作內容都是私人的，而 REDACT 只處理絕對路徑、擋不住這種。
      // 收著至少看得到「⏰ 定時工作 · N 件啟用中」，功能有交代到；
      // 為了多拍一個賣點把別人的排程放上公開 README 不划算。
    ],
    settle: 1500,
    fit: true,             // 裁掉下面一大片黑，不要留半個畫面的空白
  },
]

async function run(win, shot) {
  for (const step of shot.steps) {
    await win.webContents.executeJavaScript(`(async () => { ${step} })()`)
    await sleep(600)
  }
  await sleep(shot.settle)
  await win.webContents.executeJavaScript(REDACT)

  // 上鎖：拍之前掃一遍畫面上的文字，出現任何絕對路徑就整個中止。
  //
  // 這種洩漏用肉眼檢查會漏 —— 上一版就漏了主控台那張的工單路徑（即時派工區
  // 讀的是伺服器上真實的工單，內容含本機絕對路徑）。用 String.raw 是因為
  // 一般樣板字串會把 backslash-s 這種不認識的跳脫吃掉，regex 會被改寫壞掉。
  const leaked = await win.webContents.executeJavaScript(String.raw`(() => {
    const re = new RegExp('[A-Za-z]:\\\\[^\\s]+|/(?:Users|home)/[^\\s]+', 'g')
    return (document.querySelector('main').innerText.match(re) || []).slice(0, 5)
  })()`)
  if (leaked.length) {
    throw new Error(`${shot.name}：畫面上有本機路徑，不拍 → ${leaked.join(' | ')}`)
  }

  // 只拍主內容區。左邊的對話側欄是使用者真實的專案資料夾名稱，
  // 放上公開 README 等於把工作內容攤出去。
  // 只拍主內容區。左邊的對話側欄是使用者真實的專案資料夾名稱，
  // 放上公開 README 等於把工作內容攤出去。
  // fit 的那幾張再往上收到內容底端，不要留半個畫面的黑。
  const rect = await win.webContents.executeJavaScript(`(() => {
    const m = document.querySelector('main')
    const b = m.getBoundingClientRect()
    let bottom = b.bottom
    if (${JSON.stringify(!!shot.fit)}) {
      // 只量「真的畫了東西」的葉節點。版面容器多半是 flex-1 撐滿高度的，
      // 把它們算進去的話底端永遠等於畫面底端，等於沒有裁到。
      bottom = b.top
      for (const el of m.querySelectorAll('*')) {
        const leaf = el.children.length === 0
        const paints = leaf && (el.textContent.trim() !== '' ||
          ['IMG', 'CANVAS', 'INPUT', 'TEXTAREA', 'SVG'].includes(el.tagName.toUpperCase()))
        if (!paints) continue
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && r.bottom > bottom && r.bottom <= b.bottom) bottom = r.bottom
      }
      bottom = Math.min(b.bottom, bottom + 16)
    }
    return { x: Math.round(b.x), y: Math.round(b.y),
             width: Math.round(b.width), height: Math.round(bottom - b.top) }
  })()`)
  const img = await win.webContents.capturePage(rect)
  const file = path.join(OUT_DIR, `${shot.name}.png`)
  fs.writeFileSync(file, img.toPNG())
  console.log(`${shot.name}.png  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: true,                 // 隱藏視窗在 Windows 上不會合成，拍出來是全黑
    backgroundColor: '#09090b',
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await win.loadURL(URL_BASE)
    await sleep(3000)
    await win.webContents.executeJavaScript(SEED)
    await win.webContents.reload()
    await sleep(4000)
    for (const s of SHOTS) await run(win, s)
  } catch (e) {
    console.error('截圖失敗：', e)
    process.exitCode = 1
  }
  win.destroy()
  app.quit()
})
