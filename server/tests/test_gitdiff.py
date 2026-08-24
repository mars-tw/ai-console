# -*- coding: utf-8 -*-
"""派工改動檢視（_git_diff）的回歸測試

這一份主要守一件事：**中文內容要能完整穿過 subprocess**。

在 Windows 上 subprocess 的 text=True 會用系統 ANSI code page（這台是 CP950）
解碼子行程輸出。這個專案的原始碼註解全是中文，於是 `git diff --patch` 的內容
一進來就 UnicodeDecodeError —— reader thread 直接死掉，stdout 變成空字串。
沒有例外、沒有 returncode，畫面上只表現成「每個檔都有 +25 −2，
但點開 patch 是空的」。`--numstat` 逃過一劫只是因為它的輸出是純 ASCII。

同一個坑 _lms_run 的註解裡已經寫過一次，實作這個功能時還是踩了第二次。
所以它從註解升級成測試。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402

GIT = shutil.which("git")


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True,
                   capture_output=True, text=True, encoding="utf-8", errors="replace")


@unittest.skipIf(not GIT, "這台機器沒有 git")
class TestGitDiff(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="acdiff_"))
        _git(self.tmp, "init", "-q")
        _git(self.tmp, "config", "user.email", "t@example.com")
        _git(self.tmp, "config", "user.name", "t")
        (self.tmp / "a.py").write_text("# 原本的註解\nx = 1\n", encoding="utf-8")
        _git(self.tmp, "add", "-A")
        _git(self.tmp, "commit", "-qm", "init")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_不是git專案就明講(self):
        """回一個空清單會被讀成「這次什麼都沒改」——
        那跟「這裡看不到改動」是完全不同的兩件事。"""
        plain = Path(tempfile.mkdtemp(prefix="acplain_"))
        try:
            got = api._git_diff(str(plain))
            self.assertTrue(got["ok"])
            self.assertFalse(got["isGit"])
        finally:
            shutil.rmtree(plain, ignore_errors=True)

    def test_中文內容要完整穿過subprocess(self):
        """這個測試就是為了那個 CP950 的坑存在的。"""
        (self.tmp / "a.py").write_text(
            "# 原本的註解\n# 這一行是新加的中文註解，帶標點：「引號」與 —— 破折號\nx = 2\n",
            encoding="utf-8")
        got = api._git_diff(str(self.tmp))
        self.assertTrue(got["isGit"])
        f = next(x for x in got["files"] if x["path"] == "a.py")
        self.assertIn("這一行是新加的中文註解", f["patch"])
        self.assertIn("「引號」", f["patch"])

    def test_增刪行數要對得上檔案(self):
        (self.tmp / "b.txt").write_text("一\n二\n三\n", encoding="utf-8")
        _git(self.tmp, "add", "-A")
        got = api._git_diff(str(self.tmp))
        f = next(x for x in got["files"] if x["path"] == "b.txt")
        self.assertEqual(f["added"], 3)
        self.assertEqual(f["removed"], 0)
        self.assertFalse(f["binary"])

    def test_中文檔名也要配得到patch(self):
        """core.quotepath 預設會把非 ASCII 檔名轉成八進位跳脫，
        跟 numstat 的路徑對不起來 —— 結果是「檔案列得出來，但 patch 是空的」。
        這個專案本身就放在一個中文路徑底下，不是假想情境。"""
        (self.tmp / "說明.md").write_text("# 標題\n內容\n", encoding="utf-8")
        _git(self.tmp, "add", "-A")
        got = api._git_diff(str(self.tmp))
        f = next(x for x in got["files"] if x["path"] == "說明.md")
        self.assertTrue(f["patch"], "中文檔名的 patch 不該是空的")
        self.assertIn("標題", f["patch"])

    def test_單檔太長要截斷而且要說(self):
        """整份送到瀏覽器只會讓畫面卡住。截斷可以，但一定要標記 ——
        使用者以為看到的是全部、實際上少了一半，比看不到更糟。"""
        (self.tmp / "big.txt").write_text("x\n" * 200_000, encoding="utf-8")
        _git(self.tmp, "add", "-A")
        got = api._git_diff(str(self.tmp))
        self.assertTrue(got["truncated"])
        f = next(x for x in got["files"] if x["path"] == "big.txt")
        self.assertLessEqual(len(f["patch"]), api._DIFF_FILE_CAP + 200)

    def test_沒有改動時回空清單但仍是git(self):
        got = api._git_diff(str(self.tmp))
        self.assertTrue(got["isGit"])
        self.assertEqual(got["files"], [])


if __name__ == "__main__":
    unittest.main()
