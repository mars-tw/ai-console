# -*- coding: utf-8 -*-
"""靜態檔的條件式請求

起因是模擬實驗量到的：畫面每 60 秒重讀一次 index.json，而那個檔在
實機上是 1.4 MB。它只有在跑過掃描之後才會變（預設 15 分鐘一次）——
十五次裡有十四次是把同一份 1.4 MB 再搬一遍。

前端本來就寫著 `if (r.status === 304) return null`，它一直在等這個 304；
是伺服器這半從來沒實作，所以那行是永遠走不到的死碼。

浪費的不只是頻寬。每次拿到 body 就 setIndex(新物件)，於是「目前選取的
對話」換了身分，正在讀的那份對話跟著被重抓，畫面還會自動捲回最底 ——
捲上去讀舊訊息的人每 60 秒被打斷一次，而且沒有任何錯誤訊息可查。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


class TestConditionalStatic(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="acstatic_"))
        (cls.tmp / "data").mkdir()
        cls._orig_data, cls._orig_dist = api.DATA_DIR, api.DIST_DIR
        api.DATA_DIR = cls.tmp / "data"
        api.DIST_DIR = cls.tmp / "dist"
        api.DIST_DIR.mkdir()
        (api.DATA_DIR / "index.json").write_text(
            json.dumps({"conversations": [], "note": "中文內容也要正確"},
                       ensure_ascii=False), encoding="utf-8")
        # 綁 0：讓作業系統挑一個沒人用的埠，不要去踩實際在跑的 5177
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        api.DATA_DIR, api.DIST_DIR = cls._orig_data, cls._orig_dist
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _get(self, path="/data/index.json", headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}",
                                     headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_第一次要給ETag與Last_Modified(self):
        status, headers, body = self._get()
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("ETag"), "沒有 ETag 的話客戶端無從問起")
        self.assertTrue(headers.get("Last-Modified"))
        self.assertGreater(len(body), 0)

    def test_沒變就回304而且不送body(self):
        """這是整件事的重點：省下來的是 body，不是 header。"""
        _, headers, body = self._get()
        status, _, body304 = self._get(headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(body304, b"")
        self.assertGreater(len(body), 0)

    def test_If_Modified_Since也認得(self):
        """有些客戶端只送這個。只認 ETag 的話它們永遠拿不到 304。"""
        _, headers, _ = self._get()
        status, _, _ = self._get(headers={"If-Modified-Since": headers["Last-Modified"]})
        self.assertEqual(status, 304)

    def test_檔案變了就要回200(self):
        """這一項比 304 更重要：漏掉更新等於畫面永遠停在舊資料，
        而且使用者完全看不出來 —— 那比多傳 1.4 MB 糟糕得多。"""
        _, headers, _ = self._get()
        old = headers["ETag"]
        p = api.DATA_DIR / "index.json"
        p.write_text(json.dumps({"conversations": [{"id": "新的"}]},
                                ensure_ascii=False), encoding="utf-8")
        # mtime 的解析度可能只有一秒，所以直接往前推，確保 ETag 一定不同
        import os
        st = p.stat()
        os.utime(p, (st.st_atime, st.st_mtime + 5))
        status, headers2, body = self._get(headers={"If-None-Match": old})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers2["ETag"], old)
        self.assertIn("新的", body.decode("utf-8"))

    def test_對不上的ETag要回200(self):
        status, _, body = self._get(headers={"If-None-Match": 'W/"0-0"'})
        self.assertEqual(status, 200)
        self.assertGreater(len(body), 0)

    def test_中文內容不會被弄壞(self):
        """這個專案的資料檔全是中文；靜態層若處理成 bytes 以外的東西就會壞。"""
        _, _, body = self._get()
        self.assertIn("中文內容也要正確", body.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
