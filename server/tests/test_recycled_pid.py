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

    def test_建立時間依pid快取(self):
        """被回收的判定不會變回來，沒必要每次輪詢都再開一次 PowerShell"""
        calls = []
        def fake_run(argv, **kw):
            calls.append(argv)
            class R: stdout = "2026-09-03T06:00:00Z"
            return R()
        with mock.patch.object(api, "_run", side_effect=fake_run), \
             mock.patch.object(api.os, "name", "nt"):
            api._proc_created_at(4588)
            api._proc_created_at(4588)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
