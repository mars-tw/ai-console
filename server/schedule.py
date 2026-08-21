# -*- coding: utf-8 -*-
"""定時工作：設定一次，之後自己跑

主控台原本只能「打一句話 → 派出去 → 看它跑完」，每一次都要人在場。
真正省力的是「每天早上八點幫我整理進度」這種：設定一次就不用再管。

設計上刻意做得很小：
  · 只存在一個 JSON 檔，沒有資料庫
  · 排程用一個背景執行緒，每 30 秒醒來看有沒有到期的
  · 到期就走跟手動派工完全一樣的路徑（同樣掛規範、同樣寫 log、同樣進派工登錄）
    —— 定時工作不該有一套自己的執行方式，不然兩邊的行為會慢慢分岔

時間一律用本機時間。使用者講「早上八點」指的是他看到的那個八點。
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

STORE = Path.home() / ".ai-console" / "schedules.json"

# 支援的週期。刻意不做 cron 語法 —— 那是給工程師的，
# 而這個介面要讓人「看一眼就知道下次什麼時候跑」。
KINDS = ("interval", "daily", "weekly")


def _now() -> datetime:
    return datetime.now()


def load() -> list[dict]:
    try:
        if STORE.exists():
            data = json.loads(STORE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
    except Exception:
        pass
    return []


# 排程執行緒與請求執行緒都會讀寫這個檔，要序列化。
# 用 RLock 是因為 upsert()／remove() 會在持鎖狀態下再呼叫 save()，
# 普通 Lock 會自己卡死自己。
_LOCK = threading.RLock()


def save(rows: list[dict]) -> None:
    with _LOCK:
        try:
            STORE.parent.mkdir(parents=True, exist_ok=True)
            # 先寫暫存再換掉：同時寫或中途斷電，至少不會留下半個 JSON
            tmp = STORE.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(STORE)
        except OSError:
            pass


def upsert(job: dict) -> dict:
    """新增或更新一筆，整段讀改寫都在鎖裡

    呼叫端不可以自己 load() 改完再 save() —— 那是三個獨立動作，
    中間插進另一個執行緒就會互相蓋掉（壓測實證：同時存三筆只活一筆）。
    """
    with _LOCK:
        rows = [j for j in load() if j.get("id") != job["id"]]
        rows.append(job)
        save(rows)
        return job


def remove(job_id: str) -> None:
    with _LOCK:
        save([j for j in load() if j.get("id") != job_id])


def update(job_id: str, fn) -> dict | None:
    """就地改一筆。fn 收到那一筆的 dict，直接改它"""
    with _LOCK:
        rows = load()
        job = next((j for j in rows if j.get("id") == job_id), None)
        if job is None:
            return None
        fn(job)
        save(rows)
        return job


def next_run(job: dict, after: datetime | None = None) -> float:
    """算下一次該跑的時間（epoch 秒）

    刻意不做「補跑錯過的」：電腦關了一整夜，早上開機時不該一次噴出八份報告。
    錯過就算了，跑下一次。
    """
    base = after or _now()
    kind = job.get("kind")
    if kind == "interval":
        mins = max(1, int(job.get("everyMinutes") or 60))
        return (base + timedelta(minutes=mins)).timestamp()
    hh = int(job.get("hour", 9))
    mm = int(job.get("minute", 0))
    nxt = base.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if nxt <= base:
        nxt += timedelta(days=1)
    if kind == "weekly":
        want = int(job.get("weekday", 0))          # 0 = 週一
        while nxt.weekday() != want:
            nxt += timedelta(days=1)
    return nxt.timestamp()


def describe(job: dict) -> str:
    """人看得懂的週期說明。介面直接顯示這句，不要讓使用者自己解讀欄位"""
    kind = job.get("kind")
    if kind == "interval":
        m = max(1, int(job.get("everyMinutes") or 60))
        if m % 60 == 0:
            return f"每 {m // 60} 小時"
        return f"每 {m} 分鐘"
    hhmm = f"{int(job.get('hour', 9)):02d}:{int(job.get('minute', 0)):02d}"
    if kind == "weekly":
        names = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]
        return f"每{names[int(job.get('weekday', 0)) % 7]} {hhmm}"
    return f"每天 {hhmm}"


def normalize(job: dict) -> dict:
    """把使用者送來的設定收成乾淨的樣子，並算好下一次"""
    kind = job.get("kind") if job.get("kind") in KINDS else "daily"
    out = {
        # id 一定要夠獨特。原本是 f"s{毫秒:x}" —— 同一毫秒進來的兩個請求
        # 會拿到同一個 id，upsert 就把彼此覆蓋掉了。
        # 壓測實證：同時存六筆只活三筆（三個不同的毫秒）。
        "id": str(job.get("id") or f"s{int(time.time() * 1000):x}{uuid.uuid4().hex[:6]}"),
        "name": str(job.get("name") or "").strip()[:60],
        "task": str(job.get("task") or "").strip(),
        "tool": str(job.get("tool") or "auto").strip(),
        "kind": kind,
        "enabled": bool(job.get("enabled", True)),
        "everyMinutes": max(1, int(job.get("everyMinutes") or 60)),
        "hour": min(23, max(0, int(job.get("hour", 9)))),
        "minute": min(59, max(0, int(job.get("minute", 0)))),
        "weekday": min(6, max(0, int(job.get("weekday", 0)))),
        "lastRun": job.get("lastRun") or 0,
        "lastResult": job.get("lastResult") or "",
        "runs": int(job.get("runs") or 0),
    }
    if not out["name"]:
        out["name"] = out["task"][:24] or "未命名"
    out["nextRun"] = float(job.get("nextRun") or 0) or next_run(out)
    return out


class Scheduler(threading.Thread):
    """背景排程。每 30 秒看一次有沒有到期的。

    30 秒是刻意的：更密沒有意義（最小週期是一分鐘），更疏會讓
    「每 5 分鐘」這種設定實際上偏移太多。
    """

    def __init__(self, fire):
        super().__init__(daemon=True)
        self.fire = fire            # fire(job) -> str，回傳這次的結果摘要
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        while not self._stop.wait(30):
            try:
                self.tick()
            except Exception:
                # 排程執行緒不能死。單一工作出錯不該讓其他工作也停掉。
                pass

    def tick(self) -> None:
        """挑出到期的 → 放開鎖去派 → 再拿鎖寫回結果

        三段是刻意分開的。前一版整個 tick 都在鎖裡，包含 fire()，
        而 fire() 是打 HTTP 回自己的 /api/dispatch、逾時 60 秒 ——
        那 60 秒內使用者在介面上按「存起來」會整個卡住，看起來像當機。
        鎖只該保護讀寫檔案的那兩小段，不該罩住對外呼叫。
        """
        now = time.time()
        with _LOCK:
            rows = load()
            due = [j for j in rows
                   if j.get("enabled") and float(j.get("nextRun") or 0) <= now]
            if not due:
                return
            # 先把 nextRun 推掉再放開鎖。不然 fire() 那 60 秒內下一次 tick
            # 進來會看到同一批還沒到期的紀錄，同一件工作被派兩次。
            for job in due:
                job["lastRun"] = now
                job["runs"] = int(job.get("runs") or 0) + 1
                job["nextRun"] = next_run(job)
            save(rows)
            fire_list = [(j["id"], dict(j)) for j in due]

        # ── 這一段沒有鎖 ──
        results: dict[str, str] = {}
        for job_id, job in fire_list:
            try:
                results[job_id] = (self.fire(job) or "")[:200]
            except Exception as e:
                results[job_id] = f"派工失敗：{e}"[:200]

        with _LOCK:
            rows = load()
            for job in rows:
                if job.get("id") in results:
                    job["lastResult"] = results[job["id"]]
            save(rows)
