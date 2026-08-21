# -*- coding: utf-8 -*-
"""定時工作的邏輯測試

用 unittest（標準庫）而不是 pytest：這個專案的 Python 端沒有相依套件，
測試也不該是第一個引進的。python -m unittest discover 就能跑。

重點測的是「壓測抓到但看程式碼看不出來」的那幾件：
  · 同一毫秒進來的兩筆不能拿到同一個 id
  · tick 要先把 nextRun 推掉再去派工，不然同一件會被派兩次
  · fire() 的時候不能握著鎖
"""
from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import schedule  # noqa: E402


class TempStore(unittest.TestCase):
    """每個測試各用一個暫存檔，不要碰到使用者真正的 schedules.json"""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._orig = schedule.STORE
        schedule.STORE = Path(self._dir.name) / "schedules.json"

    def tearDown(self):
        schedule.STORE = self._orig
        self._dir.cleanup()


class TestNormalize(TempStore):
    def test_id_不會撞號(self):
        """同一毫秒產生大量 id 不能重複

        原本 id 是 f"s{毫秒:x}"，壓測時同時存六筆只活三筆 ——
        同一毫秒的請求拿到同一個 id，upsert 把彼此當成同一筆蓋掉了。
        """
        ids = {schedule.normalize({"task": "x"})["id"] for _ in range(500)}
        self.assertEqual(len(ids), 500)

    def test_已有的_id_要保留(self):
        job = schedule.normalize({"id": "s-固定", "task": "x"})
        self.assertEqual(job["id"], "s-固定")

    def test_欄位收斂到合法範圍(self):
        job = schedule.normalize({"task": "x", "hour": 99, "minute": -5,
                                  "weekday": 12, "everyMinutes": -3, "kind": "亂寫"})
        self.assertEqual(job["hour"], 23)
        self.assertEqual(job["minute"], 0)
        self.assertEqual(job["weekday"], 6)
        self.assertEqual(job["everyMinutes"], 1)      # 負數夾到下限一分鐘
        self.assertEqual(job["kind"], "daily")        # 不認得的週期退回每天

    def test_間隔留空當成沒填而不是零(self):
        """0 是「欄位清空了」不是「每 0 分鐘」，要套預設 60。
        前端的 `+e.target.value || 60` 也是同一個規則，兩邊要一致。"""
        self.assertEqual(schedule.normalize({"task": "x", "everyMinutes": 0})["everyMinutes"], 60)
        self.assertEqual(schedule.normalize({"task": "x"})["everyMinutes"], 60)

    def test_沒給名稱就用工作內容當名稱(self):
        job = schedule.normalize({"task": "把測試跑一遍然後回報結果"})
        self.assertEqual(job["name"], "把測試跑一遍然後回報結果"[:24])
        self.assertEqual(schedule.normalize({"task": ""})["name"], "未命名")


class TestNextRun(TempStore):
    def test_每天_已經過了今天的時間就排到明天(self):
        base = datetime(2026, 8, 21, 15, 0, 0)
        ts = schedule.next_run({"kind": "daily", "hour": 9, "minute": 0}, after=base)
        self.assertEqual(datetime.fromtimestamp(ts), datetime(2026, 8, 22, 9, 0, 0))

    def test_每天_還沒到就排今天(self):
        base = datetime(2026, 8, 21, 7, 30, 0)
        ts = schedule.next_run({"kind": "daily", "hour": 9, "minute": 0}, after=base)
        self.assertEqual(datetime.fromtimestamp(ts), datetime(2026, 8, 21, 9, 0, 0))

    def test_每週_要落在指定的那一天(self):
        base = datetime(2026, 8, 21, 12, 0, 0)          # 週五
        ts = schedule.next_run({"kind": "weekly", "weekday": 0,   # 週一
                                "hour": 9, "minute": 0}, after=base)
        got = datetime.fromtimestamp(ts)
        self.assertEqual(got.weekday(), 0)
        self.assertEqual(got, datetime(2026, 8, 24, 9, 0, 0))

    def test_間隔型是從現在往後推(self):
        base = datetime(2026, 8, 21, 12, 0, 0)
        ts = schedule.next_run({"kind": "interval", "everyMinutes": 90}, after=base)
        self.assertEqual(datetime.fromtimestamp(ts), base + timedelta(minutes=90))

    def test_不補跑錯過的(self):
        """關機一整夜，早上開機不該一次噴出八份報告"""
        base = datetime(2026, 8, 21, 10, 0, 0)
        ts = schedule.next_run({"kind": "daily", "hour": 9, "minute": 0}, after=base)
        self.assertGreater(ts, base.timestamp())       # 只會往未來排


class TestDescribe(TempStore):
    def test_整點的間隔講成小時(self):
        self.assertEqual(schedule.describe({"kind": "interval", "everyMinutes": 120}), "每 2 小時")
        self.assertEqual(schedule.describe({"kind": "interval", "everyMinutes": 45}), "每 45 分鐘")

    def test_每天每週(self):
        self.assertEqual(schedule.describe({"kind": "daily", "hour": 9, "minute": 5}), "每天 09:05")
        self.assertEqual(
            schedule.describe({"kind": "weekly", "weekday": 2, "hour": 18, "minute": 0}),
            "每週三 18:00")


class TestUpsertRemove(TempStore):
    def test_同時存不會互相蓋掉(self):
        """壓測抓到的那個問題：讀改寫不在同一個鎖裡就會掉資料"""
        jobs = [schedule.normalize({"name": f"併發{i}", "task": "x"}) for i in range(20)]
        threads = [threading.Thread(target=schedule.upsert, args=(j,)) for j in jobs]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(len(schedule.load()), 20)

    def test_upsert_同一個_id_是更新不是新增(self):
        job = schedule.normalize({"name": "甲", "task": "x"})
        schedule.upsert(job)
        schedule.upsert({**job, "name": "乙"})
        rows = schedule.load()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "乙")

    def test_remove_只刪指定那一筆(self):
        a = schedule.upsert(schedule.normalize({"name": "甲", "task": "x"}))
        b = schedule.upsert(schedule.normalize({"name": "乙", "task": "y"}))
        schedule.remove(a["id"])
        rows = schedule.load()
        self.assertEqual([r["id"] for r in rows], [b["id"]])

    def test_update_找不到就回_None(self):
        self.assertIsNone(schedule.update("不存在", lambda j: None))

    def test_壞掉的檔案當成空的(self):
        """存檔壞了不該讓整個伺服器起不來"""
        schedule.STORE.parent.mkdir(parents=True, exist_ok=True)
        schedule.STORE.write_text("{ 這不是合法 JSON", encoding="utf-8")
        self.assertEqual(schedule.load(), [])


class TestTick(TempStore):
    def _sched(self, fire):
        return schedule.Scheduler(fire)

    def test_只派到期的(self):
        fired = []
        now = time.time()
        schedule.save([
            schedule.normalize({"name": "到期", "task": "a", "nextRun": now - 10}),
            schedule.normalize({"name": "還沒", "task": "b", "nextRun": now + 9999}),
        ])
        self._sched(lambda j: fired.append(j["name"]) or "ok").tick()
        self.assertEqual(fired, ["到期"])

    def test_暫停的不派(self):
        fired = []
        schedule.save([schedule.normalize(
            {"name": "暫停", "task": "a", "enabled": False, "nextRun": time.time() - 10})])
        self._sched(lambda j: fired.append(j["name"]) or "ok").tick()
        self.assertEqual(fired, [])

    def test_派工當下就把_nextRun_推掉(self):
        """fire() 可能要跑幾十秒。那段時間下一次 tick 不能又看到同一件到期"""
        calls = []

        def slow_fire(job):
            calls.append(job["name"])
            # 派工還在進行中的時候，另一個 tick 進來不該重複派
            schedule.Scheduler(lambda j: calls.append("重複：" + j["name"]) or "x").tick()
            return "ok"

        schedule.save([schedule.normalize({"name": "唯一", "task": "a", "nextRun": time.time() - 10})])
        self._sched(slow_fire).tick()
        self.assertEqual(calls, ["唯一"])

    def test_fire_的時候沒有握著鎖(self):
        """前一版整個 tick 都在鎖裡，使用者存檔會被卡住最長 60 秒"""
        seen = []

        def fire(job):
            # 另一條執行緒此刻要能拿到鎖並成功存檔
            th = threading.Thread(target=lambda: seen.append(
                schedule.upsert(schedule.normalize({"name": "介面存的", "task": "z"}))))
            th.start()
            th.join(timeout=3)
            seen.append(not th.is_alive())
            return "ok"

        schedule.save([schedule.normalize({"name": "跑很久", "task": "a", "nextRun": time.time() - 10})])
        self._sched(fire).tick()
        self.assertTrue(seen[-1], "fire() 執行期間別的執行緒拿不到鎖，代表鎖罩得太大")

    def test_fire_丟例外不會讓排程停掉(self):
        def boom(job):
            raise RuntimeError("故意炸")

        schedule.save([
            schedule.normalize({"name": "會炸", "task": "a", "nextRun": time.time() - 10}),
        ])
        self._sched(boom).tick()                       # 不該往外拋
        row = schedule.load()[0]
        self.assertIn("派工失敗", row["lastResult"])
        self.assertGreater(row["nextRun"], time.time())  # 還是有排下一次

    def test_跑完會記錄結果與次數(self):
        schedule.save([schedule.normalize({"name": "甲", "task": "a", "nextRun": time.time() - 10})])
        self._sched(lambda j: "已派給 codex").tick()
        row = schedule.load()[0]
        self.assertEqual(row["lastResult"], "已派給 codex")
        self.assertEqual(row["runs"], 1)
        self.assertGreater(row["lastRun"], 0)

    def test_結果過長會截斷(self):
        schedule.save([schedule.normalize({"name": "甲", "task": "a", "nextRun": time.time() - 10})])
        self._sched(lambda j: "字" * 999).tick()
        self.assertEqual(len(schedule.load()[0]["lastResult"]), 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
