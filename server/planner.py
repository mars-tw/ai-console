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
    "grok": "生圖、找資料、需要即時網路資訊的查詢。無無頭模式，會開終端。",
    "local": "地端模型兜底。不需要檔案存取的純問答、改寫、腦力激盪。雲端全限流時用。",
}

PROMPT = """你是一個派工調度員。把使用者的需求拆成可以直接交給 AI 執行的工作，並指定每件由誰做。

可用的執行者與擅長領域：
{skills}

規則：
1. 能一件事做完就不要硬拆。簡單的需求就回一行。
2. 最多 5 行。
3. 每一行的工作敘述要「可以直接貼給那個 AI 執行」，包含足夠上下文，不要寫「同上」「接續前一步」。

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
         available: list[str] | None = None, timeout: int = 120) -> dict:
    """回傳 {ok, steps, model, note}

    失敗時 steps 一定至少有一筆（整句話交給預設工具），呼叫端不用另外處理。
    """
    instruction = (instruction or "").strip()
    if not instruction:
        return {"ok": False, "steps": [], "note": "沒有輸入"}

    sk = dict(skills or DEFAULT_SKILLS)
    allowed = set(available) if available else set(sk)
    allowed &= set(sk) or allowed
    fallback = "claude" if "claude" in allowed else (sorted(allowed)[0] if allowed else "local")

    single = [{"tool": fallback, "task": instruction, "why": "拆解失敗，整件交給預設工具"}]
    if not model:
        return {"ok": False, "steps": single, "model": "", "note": "地端沒有可用模型，無法拆解"}

    listing = "\n".join(f"- {k}：{v}" for k, v in sk.items() if k in allowed)
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT.format(skills=listing) + instruction}],
        "temperature": 0.2,
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
        return {"ok": False, "steps": single, "model": model, "note": f"地端模型呼叫失敗：{e}"}

    # 先試 JSON，失敗再試行格式。小模型寫不出巢狀 JSON 但寫得出一行一件，
    # 而主控台在重載工作時本來就會被降級到小模型，所以兩種都要吃。
    data = _extract_json(content)
    steps = _clean_steps(data, allowed, fallback) if data else []
    if not steps:
        steps = _parse_lines(content, allowed, fallback)
    if not steps:
        return {"ok": False, "steps": single, "model": model,
                "note": "模型沒有回出可用的 JSON，改成整件派工"}
    return {"ok": True, "steps": steps, "model": model, "note": ""}
