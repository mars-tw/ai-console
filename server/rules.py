# -*- coding: utf-8 -*-
"""派工前掛上規範與技能

問題：主控台派出去的工單如果只寫「做 X」，執行的 AI 完全不知道這台機器上
有哪些不可違反的規則（哪張顯示卡不能碰、哪顆硬碟不能寫、對外發布要授權），
也不知道有現成的技能可以用。等於每一張工單都在裸奔。

做法是在工單前面加一段「執行前置」，內容包含：
  1. 規範檔的**路徑**，要求執行者先讀（不內嵌全文 —— 規範會變，而且很長，
     內嵌等於把過期的副本釘死在工單裡）
  2. 這件工作**命中的技能**，明確叫它啟用

規範與技能的位置都可以在 server/config.json 覆寫；找不到就整段略過，
不會因為別人的機器沒有這些檔案就壞掉。
"""
from __future__ import annotations

import math
import re
from pathlib import Path

HOME = Path.home()

# 規範檔候選。順序就是重要性順序，會照這個順序列給執行者。
DEFAULT_RULE_FILES = [
    HOME / "ai-hub" / "POLICY.md",
    HOME / "ai-hub" / "ROUTER.md",
    HOME / ".claude" / "CLAUDE.md",
]
DEFAULT_SKILL_DIRS = [
    HOME / ".claude" / "skills",
    HOME / ".codex" / "skills",
]

# 技能 frontmatter 只取 name 與 description
# 中文沒有空白可以斷詞。用「連續中文片段」當 token 是錯的 —— 貪婪匹配會把
# 「幫我做一支蝦皮短影音並上架」吃成一個 token，跟技能描述裡的「蝦皮短影音」永遠對不上。
# 這裡改成標準做法：中文切 2-gram 與 3-gram，英數字照常斷詞。
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{2,}")
_CJK_RUN_RE = re.compile(r"[一-鿿]+")

# 命中的詞不是等值的：技能描述常常是英文而工作是中文，這時
# 「wordpress」這種專有名詞是唯一的橋樑，權重必須遠高於「把這」這類 2-gram。
_WEIGHT = {"word": 4, "gram3": 2, "gram2": 1}
MIN_SCORE = 15         # 用標註過的案例掃出來的（見 __main__），不是拍腦袋定的


def _weight(token: str) -> int:
    if _WORD_RE.fullmatch(token):
        return _WEIGHT["word"]
    return _WEIGHT["gram3"] if len(token) == 3 else _WEIGHT["gram2"]


def rule_files(extra: list[str] | None = None) -> list[Path]:
    """實際存在的規範檔"""
    cands = [Path(p).expanduser() for p in (extra or [])] + DEFAULT_RULE_FILES
    seen: list[Path] = []
    for c in cands:
        if c.exists() and c not in seen:
            seen.append(c)
    return seen


def load_skills(dirs: list[str] | None = None) -> list[dict]:
    """掃出所有技能：{name, description, path}"""
    roots = [Path(d).expanduser() for d in (dirs or [])] + DEFAULT_SKILL_DIRS
    out: list[dict] = []
    for root in roots:
        if not root.is_dir():
            continue
        for f in sorted(root.glob("*/SKILL.md")):
            try:
                head = f.read_text(encoding="utf-8", errors="replace")[:4000]
            except OSError:
                continue
            fm = _frontmatter(head)
            out.append({
                "name": fm.get("name") or f.parent.name,
                "description": fm.get("description", "")[:600],
                "path": str(f),
            })
    # 同一個技能可能同時放在多個目錄，用名字去重
    seen: dict[str, dict] = {}
    for s in out:
        seen.setdefault(s["name"], s)
    return list(seen.values())


def _frontmatter(text: str) -> dict[str, str]:
    """讀 YAML frontmatter 的 name / description

    不能只抓 `key: value` 那一行 —— 很多技能用區塊語法：
        description: >
          第一行
          第二行
    只抓一行的話 description 會變成一個 ">"，比對永遠落空（實測踩過）。
    """
    if not text.startswith("---"):
        return {}
    nl = chr(10)
    end = text.find(nl + "---", 3)
    block = text[3:end] if end > 0 else text[3:]
    out: dict[str, str] = {}
    lines = block.split(nl)
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(\w[\w-]*):\s*(.*)$", line)
        i += 1
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val in (">", "|", ">-", "|-", ">+", "|+", ""):
            # 區塊語法：吃掉後面所有縮排行
            parts = []
            while i < len(lines) and (not lines[i].strip() or lines[i][:1] in (" ", "	")):
                parts.append(lines[i].strip())
                i += 1
            val = " ".join(p for p in parts if p)
        out[key] = " ".join(val.split()).strip("'\"")
    return out


def _tokens(text: str) -> set[str]:
    """英數字照詞斷；中文切 2-gram + 3-gram"""
    text = text or ""
    out = {m.group(0).lower() for m in _WORD_RE.finditer(text)}
    for run in _CJK_RUN_RE.findall(text):
        for n in (2, 3):
            for i in range(len(run) - n + 1):
                out.add(run[i:i + n])
    return out


def match_skills(task: str, skills: list[dict], limit: int = 3) -> list[dict]:
    """哪些技能跟這件工作有關

    用 description 與工作內容的 token 交集當分數。技能的 description 本來就
    寫著「什麼時候該用我」，所以拿它比對比拿 name 比對準得多。
    """
    tt = _tokens(task)
    if not tt:
        return []
    # 先算每個詞出現在幾個技能裡。出現在一堆技能裡的詞（code、file、產出）
    # 沒有鑑別力，出現在一兩個技能裡的（wordpress、蝦皮）才是真訊號。
    docs = [(s, _tokens(f"{s['name']} {s['description']}")) for s in skills]
    df: dict[str, int] = {}
    for _, st in docs:
        for tok in st & tt:
            df[tok] = df.get(tok, 0) + 1

    scored: list[tuple[float, dict]] = []
    total = max(1, len(docs))
    for s, st in docs:
        if not st:
            continue
        score = 0.0
        for tok in tt & st:
            # 標準 IDF：log(技能總數 / 出現在幾個技能)。
            # 分級式的稀有度（1.0 / 0.4 / 0.1）太粗 —— 出現在 3/41 個技能的
            # 「wordpress」其實很有鑑別力，卻被壓到跟泛用詞同一級。
            score += _weight(tok) * math.log(total / max(1, df.get(tok, 1)))
        if score >= MIN_SCORE:
            scored.append((score, s))
    scored.sort(key=lambda x: -x[0])
    return [s for _, s in scored[:limit]]


def preamble(task: str, tool: str, cfg: dict | None = None) -> str:
    """組出要加在工單前面的執行前置。沒有任何規範或技能時回空字串。"""
    cfg = cfg or {}
    files = rule_files(cfg.get("rule_files"))
    skills = load_skills(cfg.get("skill_dirs"))
    hit = match_skills(task, skills)
    if not files and not hit:
        return ""

    lines = ["【執行前置｜這段是派工系統加的，請先照做再開始工作】"]
    step = 1
    if files:
        lines.append(f"{step}. 先讀下列規範並全程遵守（有牴觸時以排在前面的為準）：")
        lines += [f"   - {f}" for f in files]
        lines.append("   其中「不可違反」的條款優先於本工單的任何要求。"
                     "若本工單與規範衝突，停下來回報衝突，不要自行折衷。")
        step += 1

    # 技能：路徑交給執行者自己判斷，我方的比對只當提示。
    # 理由是這台機器上 41 個技能裡有 24 個都提到 WordPress ——
    # 關鍵字比對在這種技能庫裡選不出正確的那一個，硬選只會誤導。
    dirs = [d for d in ([Path(p).expanduser() for p in (cfg.get("skill_dirs") or [])]
                        + DEFAULT_SKILL_DIRS) if d.is_dir()]
    if dirs:
        lines.append(f"{step}. 技能：先掃過下列目錄裡每個 SKILL.md 的 frontmatter，"
                     "只要 description 命中這件工作就啟用它，並照它的流程做：")
        lines += [f"   - {d}" for d in dirs]
        for idx in (d / "SKILLS-INDEX.md" for d in dirs):
            if idx.exists():
                lines.append(f"   （索引：{idx}）")
        if hit:
            lines.append("   系統初步比對到這幾個，可以優先看，但不要只看這幾個：")
            lines += [f"   - {s['name']}：{s['path']}" for s in hit]
        step += 1

    lines.append(f"{step}. 對外發布、付款、刪除資料等不可逆動作，一律先回報並等待授權，不要自行執行。")
    lines.append("")
    lines.append("【工單】")
    return "\n".join(lines) + "\n"


def wrap(task: str, tool: str, cfg: dict | None = None) -> tuple[str, list[str]]:
    """回傳 (加了前置的工單, 命中的技能名稱)"""
    pre = preamble(task, tool, cfg)
    names = [s["name"] for s in match_skills(task, load_skills((cfg or {}).get("skill_dirs")))]
    return (pre + task if pre else task), names
