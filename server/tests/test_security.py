# -*- coding: utf-8 -*-
"""安全與併發的回歸測試

這一份測的全部是「已經踩過或已經用探針重現過」的問題，不是假想情境。
每個測試的 docstring 寫的是當初怎麼發現的，將來有人想放寬時看得到代價。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402

HOME = str(Path.home())


class TestSafeSid(unittest.TestCase):
    """對話 id 最後會被寫進一個 .cmd 批次檔

    批次檔裡的 & 是真的會執行第二條命令 —— 這個機制已經用無害探針重現過
    （寫一個含 `" & echo ... & rem "` 的 .cmd，第二條確實跑了）。
    所以格式不合就拒絕，不要嘗試「跳脫掉再用」：cmd.exe 的跳脫規則太容易寫錯。
    """

    def _conv(self, tool, sid):
        return {"tool": tool, "sessionId": sid, "projectDir": HOME}

    def test_正常的_id_可以用(self):
        for tool, sid in [("claude", "7f3c9a1e-22b4-4d0e-9f11-8ab5cd3e0011"),
                          ("codex", "01JABCDEF0123456789"),
                          ("kimi", "session_abc123")]:
            with self.subTest(tool=tool):
                cmd, _ = api.build_launch(self._conv(tool, sid))
                self.assertIn(sid, cmd)
                self.assertIn(f'"{sid}"', cmd)      # 一定要加引號

    def test_擋掉會插入第二條命令的(self):
        with self.assertRaises(ValueError):
            api.build_launch(self._conv("claude", 'x" & calc & rem "'))

    def test_擋掉空白與路徑穿越(self):
        for sid in ("session_a b", "../../evil", "a|b", "a&b", "a>b", ""):
            with self.subTest(sid=sid), self.assertRaises(ValueError):
                api.build_launch(self._conv("claude", sid))

    def test_過長的也擋(self):
        with self.assertRaises(ValueError):
            api.build_launch(self._conv("claude", "a" * 200))


class TestNewStamp(unittest.TestCase):
    """派工編號同時是 id、log 檔名與工單檔名，同一秒不能撞

    原本是「檔案存在就加 _2」的迴圈 —— 先看再建，兩個執行緒可以同時
    看到「不存在」。批次派工正是一口氣送出好幾件。
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.d = Path(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()

    def test_同時搶四十個編號全部唯一(self):
        got, lock = [], threading.Lock()

        def grab():
            st = api._new_stamp(self.d, "claude")
            with lock:
                got.append(st)

        ths = [threading.Thread(target=grab) for _ in range(40)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        self.assertEqual(len(set(got)), 40)

    def test_編號會真的把_log_檔佔下來(self):
        st = api._new_stamp(self.d, "codex")
        self.assertTrue((self.d / f"{st}_codex.log").exists())


class TestTailText(unittest.TestCase):
    """派工輪詢每 8 秒讀一次 log，兩個分頁都在讀

    整份讀進來只為了取最後一行，遇到幾百 MB 的 CLI 輸出會把記憶體吃掉。
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.d = Path(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()

    def test_小檔案整份回傳(self):
        # 用 bytes 寫，不要讓 write_text 在 Windows 上把換行改成 CRLF ——
        # 這裡要驗的是「有沒有整份回傳」，不是換行風格
        f = self.d / "a.log"
        f.write_bytes("第一行\n第二行\n".encode("utf-8"))
        self.assertEqual(api._tail_text(f), "第一行\n第二行\n")

    def test_CRLF_的_log_照樣讀得到(self):
        """CLI 在 Windows 上吐的是 CRLF，讀出來不該壞掉"""
        f = self.d / "crlf.log"
        f.write_bytes("第一行\r\n第二行\r\n".encode("utf-8"))
        self.assertEqual(api._tail_text(f).splitlines(), ["第一行", "第二行"])

    def test_大檔案只回尾端而且最後一行完整(self):
        f = self.d / "b.log"
        f.write_text("".join(f"第 {i} 行 padding padding padding\n" for i in range(20000)),
                     encoding="utf-8")
        got = api._tail_text(f, limit=4096)
        self.assertLessEqual(len(got.encode("utf-8")), 4096)
        self.assertTrue(got.endswith("\n"))
        self.assertIn("第 19999 行", got)

    def test_從中間切也不會吐出壞掉的字(self):
        """尾端往回 seek 可能落在中文字的中間，切掉第一行就乾淨了"""
        f = self.d / "c.log"
        f.write_text("".join(f"中文中文中文中文中文 {i}\n" for i in range(5000)), encoding="utf-8")
        got = api._tail_text(f, limit=1000)
        self.assertNotIn("�", got)

    def test_檔案不見了回空字串(self):
        self.assertEqual(api._tail_text(self.d / "不存在.log"), "")


class TestAlivePids(unittest.TestCase):
    """序列派工靠這個判斷要不要等

    快取只能用來確認「還活著」，不能用來斷定「已經結束」。
    實測重現過：介面輪詢把快取填滿之後三秒內派出的新行程，
    會被回報成已結束，worker 立刻派下一件 —— 正是「一件一件跑」要防的事。
    """

    def test_剛誕生的行程不會被誤判為已結束(self):
        api._alive_pids({1})                    # 先把快取填滿
        p = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(20)"],
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            self.assertIn(p.pid, api._alive_pids({p.pid}))
        finally:
            p.kill()
            p.wait(timeout=10)

    def test_空集合直接回空(self):
        self.assertEqual(api._alive_pids(set()), set())

    def test_不存在的_pid_回空(self):
        # 用一個幾乎不可能存在的 pid
        self.assertEqual(api._alive_pids({999999}), set())


class TestFasterModelHintBoundary(unittest.TestCase):
    def test_空輸入不會炸(self):
        self.assertEqual(api.faster_model_hint("", []), "")
        self.assertEqual(api.faster_model_hint("", ["x-a3b"]), "　建議在 LM Studio 改載 x-a3b"
                                                                "（MoE，只啟用 3B，同樣的拆解快很多）。")


class TestLocalModelLifecycle(unittest.TestCase):
    """模型在磁碟上但 API 沒開時，續聊要能安全地自己準備好 CPU 實例。"""

    MODEL = "qwen/qwen3.5-4b"

    @staticmethod
    def _cp(stdout="", stderr="", returncode=0):
        return subprocess.CompletedProcess([], returncode, stdout, stderr)

    def setUp(self):
        # 用一定存在的檔案代替 lms.exe，避免單元測試依賴每台機器的安裝位置。
        self._lms = mock.patch.object(api, "LMS_BIN", Path(__file__))
        self._lms.start()

    def tearDown(self):
        self._lms.stop()

    def test_磁碟清單只收完整且已知的模型(self):
        rows = [
            {"modelKey": self.MODEL, "sizeBytes": 3 * 1024 ** 3},
            {"modelKey": "qwen3-coder-next", "sizeBytes": 2 * 1024 ** 3},
            {"modelKey": "not-in-model-table", "sizeBytes": 99 * 1024 ** 3},
            {"modelKey": "qwen3.8-27b"},
        ]
        with mock.patch.object(api, "_lms_run", return_value=self._cp(json.dumps(rows))), \
             mock.patch.object(api, "model_complete", return_value=False):
            self.assertEqual(api.lms_installed_models(), [self.MODEL])

    def test_模型清單永遠回_modelKey_不回自訂_identifier(self):
        with mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
             mock.patch.object(api.urllib.request, "urlopen",
                               side_effect=AssertionError("不該再查 /v1/models")):
            self.assertEqual(api.lms_models(), [self.MODEL])

    def test_未安裝的任意模型名會在拿鎖前被拒絕(self):
        with mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
             mock.patch.object(api, "_lifecycle_lock") as lock:
            with self.assertRaises(ValueError):
                api.ensure_lms_chat_model("copy-line")
            lock.assert_not_called()

    def test_恰好一個相符模型會沿用它的_identifier(self):
        loaded = [{"modelKey": self.MODEL, "identifier": "copy-line"}]
        with mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
             mock.patch.object(api, "_lifecycle_lock",
                               return_value=api.contextlib.nullcontext()), \
             mock.patch.object(api, "_lms_ps", return_value=loaded), \
             mock.patch.object(api, "_lms_server_start") as start, \
             mock.patch.object(api, "_run_gate") as gate:
            self.assertEqual(api.ensure_lms_chat_model(self.MODEL), "copy-line")
            start.assert_called_once_with()
            gate.assert_not_called()

    def test_外來或混合載入狀態一律不互踢(self):
        cases = [
            [{"modelKey": "qwen3.8-27b", "identifier": "foreign"}],
            [{"modelKey": self.MODEL, "identifier": "mine"},
             {"modelKey": "qwen3.8-27b", "identifier": "foreign"}],
            [{"modelKey": self.MODEL, "identifier": "a"},
             {"modelKey": self.MODEL, "identifier": "b"}],
        ]
        for loaded in cases:
            with self.subTest(loaded=loaded), \
                 mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
                 mock.patch.object(api, "_lifecycle_lock",
                                   return_value=api.contextlib.nullcontext()), \
                 mock.patch.object(api, "_lms_ps", return_value=loaded), \
                 mock.patch.object(api, "_run_gate") as gate, \
                 mock.patch.object(api, "_lms_run") as runner:
                with self.assertRaises(RuntimeError):
                    api.ensure_lms_chat_model(self.MODEL)
                gate.assert_not_called()
                runner.assert_not_called()

    def test_CPU_runtime_選擇失敗就停止(self):
        with mock.patch.object(api, "_lms_run", return_value=self._cp(stderr="bad", returncode=1)) as runner:
            with self.assertRaises(RuntimeError):
                api._lms_runtime_select()
        self.assertEqual(runner.call_args.args[0],
                         [str(api.LMS_BIN), "runtime", "select", api.LMS_RUNTIME])

    def test_伺服器固定啟動在_loopback_1234(self):
        statuses = [{"running": False, "port": 1234}, {"running": True, "port": 1234}]
        with mock.patch.object(api, "_lms_server_status", side_effect=statuses), \
             mock.patch.object(api, "_lms_run", return_value=self._cp()) as runner:
            api._lms_server_start()
        self.assertEqual(runner.call_args.args[0],
                         [str(api.LMS_BIN), "server", "start", "--port", "1234",
                          "--bind", "127.0.0.1"])

    def test_已在其他連接埠執行就不停止或重啟(self):
        with mock.patch.object(api, "_lms_server_status",
                               return_value={"running": True, "port": 4321}), \
             mock.patch.object(api, "_lms_run") as runner:
            with self.assertRaises(RuntimeError):
                api._lms_server_start()
            runner.assert_not_called()

    def test_新載入完整帶入_CPU_參數與前後把關(self):
        ident = api._owned_identifier(self.MODEL)
        with mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
             mock.patch.object(api, "_lifecycle_lock",
                               return_value=api.contextlib.nullcontext()), \
             mock.patch.object(api, "_lms_ps", return_value=[]), \
             mock.patch.object(api, "_run_gate",
                               side_effect=[(True, "pre"), (True, "post")]) as gate, \
             mock.patch.object(api, "_lms_runtime_select") as runtime, \
             mock.patch.object(api, "_lms_server_start") as server, \
             mock.patch.object(api, "_lms_run", return_value=self._cp()) as runner:
            self.assertEqual(api.ensure_lms_chat_model(self.MODEL), ident)
        runtime.assert_called_once_with()
        server.assert_called_once_with()
        self.assertEqual(gate.call_args_list,
                         [mock.call(), mock.call("--post-load-identifier", ident)])
        self.assertEqual(runner.call_args.args[0],
                         [str(api.LMS_BIN), "load", self.MODEL, "-y", "--gpu", "off",
                          "-c", "8192", "--ttl", "300", "--identifier", ident])
        self.assertEqual(runner.call_args.kwargs["timeout"], 300)

    def test_載入前把關未放行就完全不載(self):
        with mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
             mock.patch.object(api, "_lifecycle_lock",
                               return_value=api.contextlib.nullcontext()), \
             mock.patch.object(api, "_lms_ps", return_value=[]), \
             mock.patch.object(api, "_run_gate", return_value=(False, "blocked")), \
             mock.patch.object(api, "_lms_runtime_select") as runtime, \
             mock.patch.object(api, "_lms_run") as runner:
            with self.assertRaises(RuntimeError):
                api.ensure_lms_chat_model(self.MODEL)
            runtime.assert_not_called()
            runner.assert_not_called()

    def test_載入後把關失敗只卸載_owned_identifier(self):
        ident = api._owned_identifier(self.MODEL)
        with mock.patch.object(api, "lms_installed_models", return_value=[self.MODEL]), \
             mock.patch.object(api, "_lifecycle_lock",
                               return_value=api.contextlib.nullcontext()), \
             mock.patch.object(api, "_lms_ps", return_value=[]), \
             mock.patch.object(api, "_run_gate",
                               side_effect=[(True, "pre"), (False, "blocked")]), \
             mock.patch.object(api, "_lms_runtime_select"), \
             mock.patch.object(api, "_lms_server_start"), \
             mock.patch.object(api, "_lms_run", return_value=self._cp()) as runner:
            with self.assertRaises(RuntimeError):
                api.ensure_lms_chat_model(self.MODEL)
        self.assertEqual(runner.call_args_list[-1].args[0],
                         [str(api.LMS_BIN), "unload", ident])
        self.assertNotIn("--all", [str(x) for c in runner.call_args_list for x in c.args[0]])


class TestLimits(unittest.TestCase):
    """RES-01：沒有上限的話一批幾千件會在幾秒內開出幾千個 CLI 行程"""

    def test_上限是有設的而且合理(self):
        self.assertGreaterEqual(api.Handler.MAX_STEPS, 5)     # 拆解器最多回 5 件
        self.assertLessEqual(api.Handler.MAX_STEPS, 50)
        self.assertGreater(api.Handler.MAX_BODY, 100 * 1024)
        self.assertLessEqual(api.Handler.MAX_BODY, 16 * 1024 * 1024)


class TestKnownTools(unittest.TestCase):
    """tool 曾經完全沒驗證：可以拿它做路徑穿越，也可以拿它當執行檔名"""

    def test_危險的工具名不在白名單裡(self):
        for bad in ("../../evil", "..\\..\\evil", "calc", "cmd", "powershell",
                    "/etc/passwd", "a;b"):
            with self.subTest(bad=bad):
                self.assertNotIn(bad, api.Handler.KNOWN_TOOLS)

    def test_正常的工具都在(self):
        for good in ("claude", "codex", "local", "auto"):
            self.assertIn(good, api.Handler.KNOWN_TOOLS)


class TestFollowupNoShell(unittest.TestCase):
    """續談的指令不可以再經過 cmd.exe

    實測矩陣：經過 cmd /c 的話使用者補的那句話會被動三次手腳 ——
    遇到雙引號截斷、%VAR% 被展開成本機路徑（會跟著送進雲端模型）、
    含換行整個不執行。
    """

    def test_沒有任何工具走_cmd(self):
        for tool, make in api.Handler.FOLLOWUP_TOOLS.items():
            argv = make("測試提示")
            with self.subTest(tool=tool):
                self.assertNotEqual(str(argv[0]).lower(), "cmd",
                                    f"{tool} 的續談又走回 cmd.exe 了")
                self.assertNotIn("cmd /c", " ".join(str(a) for a in argv).lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
