# -*- coding: utf-8 -*-
"""把一句話拆成「誰做什麼」的派工計畫

主控台只有一個輸入框，使用者打一句「幫我把 X 做完」，這裡負責變成：
    [ {tool: codex, task: "..."}, {tool: claude, task: "..."} ]

拆解交給地端模型（LM Studio），理由是這件事本身不值得燒雲端額度，
而且主控台在雲端全限流時也要能用。

模型回的 JSON 一定會有各種格式問題（多包一層、加註解、用單引號），
所以解析寫得寬鬆，而且**任何失敗都退回「整句話當成一件工作」**——
主控台不能因為拆解失敗就完全不動。
"""
from __future__ import annotations

import json
import re
import urllib.request

LMS_URL = "http://127.0.0.1:1234/v1/chat/completions"

# 各工具擅長什麼。這份是預設值，使用者可以在 config.json 用 "tool_skills" 覆寫，
# 因為每個人裝的工具與額度狀況都不一樣。
DEFAULT_SKILLS: dict[str, str] = {
    "claude": "寫程式、重構、跨檔案修改、需要讀專案上下文的工作。執行力強但額度較貴。",
    "codex": "規格明確的程式任務、批次修改、測試與驗證。適合可以一次講清楚的工單。",
    "qwen": "分類、摘要、翻譯、格式轉換、初步整理。便宜、適合量大又不難的工作。",
    "grok": "生圖、找資料、需要即時網路資訊的查詢。無頭執行（--always-approve -p）。",
    "gemini": "ANTIGRAVITY（agy）。走獨立額度池，雲端其他家限流時特別有用；支援無人值守，能讀檔改檔。",
    "kimi": "中文長文、資料整理、跨檔案閱讀。",
    "cursor": "在編輯器裡的改動，適合需要看著結果調整的工作。",
    "local": "地端模型兜底。不需要檔案存取的純問答、改寫、腦力激盪。雲端全限流時用。",
}

# 使用者指名執行者時的別名。這個訊號優先於模型的判斷 ——
# 明明講了「用 codex」還派給別人，是最讓人不信任這個介面的行為。
TOOL_ALIASES: dict[str, tuple[str, ...]] = {
    "claude": ("claude", "克勞德"),
    "codex": ("codex",),
    "qwen": ("qwen", "千問", "通義"),
    "grok": ("grok",),
    "kimi": ("kimi",),
    "cursor": ("cursor",),
    "gemini": ("gemini", "antigravity", "agy", "反重力"),
    "local": ("地端", "本機模型", "lm studio", "lmstudio"),
}

# 拆不出來、或整句交給一個人的時候，交給誰。
# 原本寫死 claude —— 最貴、而且依使用者的規則它是派工平台不是工人
# （「CLAUDE CODEX 是主要派工平台，優先使用其他 AI 工作，AGY 可以先用」）。
# 順序與 api.py 的接力鏈一致：便宜的先。
CHEAP_ORDER: tuple[str, ...] = ("gemini", "qwen", "kimi", "grok", "codex", "claude", "local")


def default_tool(allowed: set[str]) -> str:
    return next((t for t in CHEAP_ORDER if t in allowed),
                sorted(allowed)[0] if allowed else "local")


# 指名的講法：用 X / 叫 X / 請 X / 派 X / 交給 X / 讓 X / use X …
_NAMED_BEFORE = re.compile(r"(用|叫|請|派|交給|讓|指定|by|use|ask)\s*$")


def named_tool(text: str, allowed: set[str] | None = None) -> str:
    """使用者有沒有在句子裡指名要誰做

    只認「動詞 + 工具名」或句首指名。不然「幫我修 codex 的設定檔」
    這種把工具名當受詞的句子會被誤判成指名。
    """
    low = (text or "").lower()
    best = ""
    best_pos = len(low) + 1
    for tool, names in TOOL_ALIASES.items():
        if allowed is not None and tool not in allowed:
            continue
        for n in names:
            i = low.find(n)
            if i < 0:
                continue
            if (i <= 2 or _NAMED_BEFORE.search(low[max(0, i - 6):i])) and i < best_pos:
                best, best_pos = tool, i
    return best

PROMPT = """你是一個派工調度員。把使用者的需求拆成可以直接交給 AI 執行的工作，並指定每件由誰做。

可用的執行者與擅長領域：
{skills}

規則：
1. 能一件事做完就不要硬拆。簡單的需求就回一行。
2. 最多 5 行。
3. 每一行的工作敘述要「可以直接貼給那個 AI 執行」，包含足夠上下文，不要寫「同上」「接續前一步」。
4. 執行者有價差：gemini、qwen 最便宜，kimi、grok 次之，codex、claude 最貴而且是派工平台。規格講得清楚的工作優先派給便宜的；只有需要跨檔案理解或困難推理的才派 codex 或 claude。

輸出：每行一件工作，三個欄位用直線 | 分隔，依序是「執行者、要做的事、原因」。
不要編號、不要標題列、不要程式碼框、不要任何說明文字。直接開始輸出工作。

使用者的需求："""


def _extract_json(text: str) -> dict | None:
    """從模型回覆裡挖出 JSON。模型很愛多包一層 markdown 或加開場白。"""
    if not text:
        return None
    # 去掉 markdown 程式碼框
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M)
    # 找最外層的大括號
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    blob = text[start:end + 1]
    for attempt in (blob, blob.replace("'", '"')):
        try:
            return json.loads(attempt)
        except json.JSONDecodeError:
            continue
    return None


def _clean_steps(data: dict, allowed: set[str], fallback_tool: str) -> list[dict]:
    steps = data.get("steps") if isinstance(data, dict) else None
    if not isinstance(steps, list):
        return []
    out: list[dict] = []
    for s in steps[:5]:
        if not isinstance(s, dict):
            continue
        task = str(s.get("task") or "").strip()
        if not task:
            continue
        tool = str(s.get("tool") or "").strip().lower()
        if tool not in allowed:
            tool = fallback_tool
        out.append({"tool": tool, "task": task, "why": str(s.get("why") or "").strip()})
    return out


def _parse_lines(text: str, allowed: set[str], fallback_tool: str) -> list[dict]:
    """解析「工具 | 工作 | 理由」的行格式

    小模型對巢狀 JSON 很不可靠，但一行一件的分隔格式幾乎都寫得出來。
    """
    out: list[dict] = []
    for raw in (text or "").splitlines():
        line = raw.strip().lstrip("-*0123456789. ").strip()
        if "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        tool = parts[0].strip("`*[] ").lower()
        task = parts[1] if len(parts) > 1 else ""
        if not task or tool.startswith("工具"):     # 跳過表頭
            continue
        if tool not in allowed:
            tool = fallback_tool
        # 小模型很愛把提示詞裡的欄位名或說明抄回來，這些不是工作
        low = task.lower()
        if low in ("task", "要做的事", "工作", "要執行的事") or len(task) < 4:
            continue
        if any(k in task for k in ("每行一件", "不要編號", "one per line", "separated by")):
            continue
        if any(o["task"] == task for o in out):     # 同一件事重複輸出
            continue
        out.append({"tool": tool, "task": task,
                    "why": (parts[2] if len(parts) > 2 else "").strip("`")})
        if len(out) >= 5:
            break
    return out


def plan(instruction: str, model: str, skills: dict[str, str] | None = None,
         available: list[str] | None = None, timeout: int = 240) -> dict:
    """回傳 {ok, steps, model, note}

    timeout 240 秒是量出來的，不是猜的：這台機器如果載的是 dense 27B，
    吞吐只有 3.7 tok/s，一份計畫要 90～150 秒 —— 原本設 120 秒正好卡在邊界，
    時好時壞。而逾時的代價（把整句話原封不動當一件工派出去）比多等一分鐘高。
    前端有秒數與「不等了」按鈕，所以等待是看得見、可以中止的。

    失敗時 steps 一定至少有一筆（整句話交給預設工具），呼叫端不用另外處理。
    """
    instruction = (instruction or "").strip()
    if not instruction:
        return {"ok": False, "steps": [], "note": "沒有輸入"}

    sk = dict(skills or DEFAULT_SKILLS)
    allowed = set(available) if available else set(sk)
    allowed &= set(sk) or allowed
    fallback = default_tool(allowed)

    # 使用者指名了誰，就照他講的。這比任何自動判斷都優先 ——
    # 明明講了「用 codex」卻派給別人，會讓人完全不敢再用這個介面。
    want = named_tool(instruction, allowed)
    if want:
        return {"ok": True, "model": "", "note": f"你指名了 {want}，直接交給它",
                "steps": [{"tool": want, "task": instruction, "why": "你指名的執行者"}]}

    single = [{"tool": fallback, "task": instruction, "why": "沒有拆解，整件交給預設工具"}]
    if not model:
        return {"ok": False, "steps": single, "model": "", "note": "地端沒有可用模型，無法拆解"}

    listing = "\n".join(f"- {k}：{v}" for k, v in sk.items() if k in allowed)
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT.format(skills=listing) + instruction}],
        "temperature": 0.2,
        # ai-hub/ROUTER.md 要求所有地端聊天第一發就關推理；
        # 否則 Qwen 會把 max_tokens 全花在 reasoning_content，永遠沒有可派的正文。
        "reasoning": "off",
        # 地端很多是推理型模型，reasoning_content 會先吃掉額度。
        # 實測 27B 拆一個四步驟需求就用掉 1350 token 在推理上，
        # 額度不夠時 content 會是空的 —— 拆解就永遠失敗。留寬一點。
        "max_tokens": 6000,
    }, ensure_ascii=False).encode("utf-8")

    try:
        req = urllib.request.Request(
            LMS_URL, data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"})
        resp = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        msg = (resp.get("choices") or [{}])[0].get("message", {}) or {}
        # 有些模型會把 JSON 留在推理欄位裡，content 反而空的，兩邊都要看
        content = msg.get("content") or msg.get("reasoning_content") or ""
    except Exception as e:
        # 錯誤訊息要能讓人知道下一步做什麼。原本直接吐 "timed out"，
        # 使用者只會看到一個英文詞，不知道那是「LM Studio 沒開」還是
        # 「模型沒載入所以正在臨時載一個 27B」—— 這兩件的處理方式完全不同。
        why = str(e)
        if "timed out" in why or "timeout" in why.lower():
            why = f"等了 {timeout} 秒沒回應（模型可能正在載入，或這台機器跑不動這個尺寸）"
        elif "refused" in why.lower() or "urlopen" in why.lower():
            why = "連不上 LM Studio（127.0.0.1:1234）——它可能沒開，或沒開伺服器模式"
        return {"ok": False, "steps": single, "model": model,
                "note": f"地端拆解失敗：{why}。已改成整件派工，請先確認下面這件再送。"}

    # 先試 JSON，失敗再試行格式。小模型寫不出巢狀 JSON 但寫得出一行一件，
    # 而主控台在重載工作時本來就會被降級到小模型，所以兩種都要吃。
    data = _extract_json(content)
    steps = _clean_steps(data, allowed, fallback) if data else []
    if not steps:
        steps = _parse_lines(content, allowed, fallback)
    if not steps:
        return {"ok": False, "steps": single, "model": model,
                "note": "模型沒有回出可用的 JSON，改成整件派工"}
    # 拆完之後每一句自己也可能帶著指名（「用 codex 改 X」被拆成一件）。
    # 模型常常忽略它，這裡再蓋回去一次。
    for st in steps:
        w = named_tool(st.get("task", ""), allowed)
        if w and w != st["tool"]:
            st["tool"] = w
            st["why"] = "工作內容裡指名了執行者"
    return {"ok": True, "steps": steps, "model": model, "note": ""}
