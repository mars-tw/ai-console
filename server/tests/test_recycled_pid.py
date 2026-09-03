# -*- coding: utf-8 -*-
"""PID 被回收之後的假存活

實際案例（2026-09-03）：08-26 派出的一筆 claude 派工，八天後畫面還顯示
「執行中」。查下去 pid 4588 現在是 tailscale-ipn.exe —— 原本的行程早就
結束，Windows 把同一個號碼發給了別人，而存活偵測只問「這個 pid 存不存在」。

後果不只是畫面上一行錯的狀態：序列派工的 worker 等的就是那個 pid 消失，
它永遠不會消失，後面的工單就永遠排不到。

這一份守的是「拿建立時間對」這件事，以及它的反面：
查不到建立時間時**不能**判成結束 —— 把還在跑的工作判成結束，
正是「一件一件跑」壞掉的直接原因（見 _alive_pids 的說明）。
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402

# 一個明確的派工開始時間：2026-08-26 12:02:03 本機時間
STAMP = "20260826-120203"
T0 = api._stamp_epoch(STAMP)


class TestStampEpoch(unittest.TestCase):

    def test_認得派工編號(self):
        self.assertIsNotNone(T0)
        self.assertEqual(time.localtime(T0).tm_mday, 26)
        self.assertEqual(time.localtime(T0).tm_hour, 12)

    def test_帶尾碼的編號也認得(self):
        """同一秒派兩件會變成 20260826-120203_2；尾碼不該讓它認不出來"""
        self.assertEqual(api._stamp_epoch(STAMP + "_2"), T0)

    def test_不像編號的東西回None(self):
        for bad in ("", "abc", "2026-08-26", None):
            self.assertIsNone(api._stamp_epoch(bad))


class TestRecycled(unittest.TestCase):

    def setUp(self):
        api._CREATED_CACHE.clear()
        api._RECYCLED_PIDS.clear()   # 正向結論會跨測試留下來，不清的話「同一件」那些會誤判

    def test_行程比派工晚建立就是被回收了(self):
        """這就是 tailscale 那個案例：派工 08-26，行程 09-03 才誕生。"""
        later = T0 + 8 * 86400
        with mock.patch.object(api, "_proc_created_at", return_value=later):
            self.assertTrue(api._recycled(4588, STAMP, now=T0 + 9 * 86400))

    def test_行程在派工當下建立就是同一件(self):
        with mock.patch.object(api, "_proc_created_at", return_value=T0 + 2):
            self.assertFalse(api._recycled(4588, STAMP, now=T0 + 9 * 86400))

    def test_五分鐘內的延遲算同一件(self):
        """Popen 回來到行程真的跑起來之間有延遲，不能因此判成別人"""
        with mock.patch.object(api, "_proc_created_at", return_value=T0 + 240):
            self.assertFalse(api._recycled(4588, STAMP, now=T0 + 9 * 86400))

    def test_查不到建立時間一律當作沒被回收(self):
        """查不到不等於死了。把還在跑的判成結束，序列派工就會兩件同時跑。"""
        with mock.patch.object(api, "_proc_created_at", return_value=None):
            self.assertFalse(api._recycled(4588, STAMP, now=T0 + 9 * 86400))

    def test_六小時內根本不去查(self):
        """每 8 秒的輪詢裡對每筆開 PowerShell 比假訊號本身更貴。
        年輕的派工不可能被回收（Windows 不會這麼快重發號碼），直接略過。"""
        with mock.patch.object(api, "_proc_created_at") as probe:
            self.assertFalse(api._recycled(4588, STAMP, now=T0 + 3600))
            probe.assert_not_called()

    def test_編號認不出來就不判(self):
        with mock.patch.object(api, "_proc_created_at") as probe:
            self.assertFalse(api._recycled(4588, "garbage", now=time.time()))
            probe.assert_not_called()

    # ── 快取的語意：只有「已被回收」可以久留 ──
    #
    # 第一版把建立時間永久快取（連 None 也存），而且把這個行為釘進了測試。
    # 稽核者（qwen，第三輪）指出那正好讓防線失效：只要第一次查詢發生在
    # 原行程還活著時，或落在號碼還沒被認領的空窗，之後被誰拿走都永遠判「沒回收」。
    # 下面四個測試釘的是修正後的語意。

    def _runner(self, answers: list):
        """依序回傳 answers 的假 PowerShell；記錄被叫了幾次"""
        calls = []
        def fake_run(argv, **kw):
            calls.append(argv)
            class R: stdout = answers[min(len(calls) - 1, len(answers) - 1)]
            return R()
        return fake_run, calls

    def test_十分鐘內同一個pid不重查(self):
        fake, calls = self._runner(["2026-08-26T04:02:05Z"])
        with mock.patch.object(api, "_run", side_effect=fake), \
             mock.patch.object(api.os, "name", "nt"):
            api._proc_created_at(4588, now=1000.0)
            api._proc_created_at(4588, now=1000.0 + 60)
        self.assertEqual(len(calls), 1)

    def test_過了TTL要重查(self):
        fake, calls = self._runner(["2026-08-26T04:02:05Z"])
        with mock.patch.object(api, "_run", side_effect=fake), \
             mock.patch.object(api.os, "name", "nt"):
            api._proc_created_at(4588, now=1000.0)
            api._proc_created_at(4588, now=1000.0 + api._CREATED_TTL_SEC + 1)
        self.assertEqual(len(calls), 2)

    def test_查不到不能快取(self):
        """空窗期查到 None，五秒後號碼被別人拿走 —— 下一次一定要再看一眼"""
        fake, calls = self._runner(["", "2026-09-03T06:00:00Z"])
        with mock.patch.object(api, "_run", side_effect=fake), \
             mock.patch.object(api.os, "name", "nt"):
            self.assertIsNone(api._proc_created_at(4588, now=1000.0))
            self.assertIsNotNone(api._proc_created_at(4588, now=1000.0 + 5))
        self.assertEqual(len(calls), 2)

    def test_第一次沒回收_之後被回收要抓得到(self):
        """稽核者描述的那個情境。八天前派工；第一次查時原行程還活著。"""
        # 第一次：建立時間 ≈ 派工時間 → 沒回收
        with mock.patch.object(api, "_proc_created_at", return_value=T0 + 3):
            self.assertFalse(api._recycled(4588, STAMP, now=T0 + 7 * 3600))
        # 過了很久，號碼被 tailscale 拿走：建立時間是幾天後 → 必須判回收
        with mock.patch.object(api, "_proc_created_at", return_value=T0 + 8 * 86400):
            self.assertTrue(api._recycled(4588, STAMP, now=T0 + 9 * 86400))

    def test_判定回收之後就記住_不再開PowerShell(self):
        """回收是不可逆的。每 8 秒的輪詢對同一筆再開 PowerShell 是浪費。"""
        with mock.patch.object(api, "_proc_created_at", return_value=T0 + 8 * 86400) as probe:
            self.assertTrue(api._recycled(4588, STAMP, now=T0 + 9 * 86400))
            self.assertTrue(api._recycled(4588, STAMP, now=T0 + 9 * 86400 + 8))
            self.assertEqual(probe.call_count, 1)
        # 即使之後查不到建立時間（行程又結束了），結論也不會退回「沒回收」
        with mock.patch.object(api, "_proc_created_at", return_value=None):
            self.assertTrue(api._recycled(4588, STAMP, now=T0 + 10 * 86400))


if __name__ == "__main__":
    unittest.main()
