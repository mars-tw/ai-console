# -*- coding: utf-8 -*-
"""桌面側欄 metadata 與刪除／封存交易的回歸測試。

全部來源都建在一次性目錄；不讀寫使用者真正的 Claude/Codex/Qwen/Kimi 資料。
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


SID = "12345678-1234-4abc-9def-1234567890ab"


class TestConversationMetadata(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ac_metadata_")
        self.root = Path(self._tmp.name)
        self.win32 = self.root / "win32"
        self.store = self.root / "store"
        self.trash = self.root / "trash"
        self.win32.mkdir()
        self.store.mkdir()
        self.index = self.root / "index.json"
        self._index_patch = mock.patch.object(api, "INDEX_JSON", self.index)
        self._roots_patch = mock.patch.object(
            api, "_claude_desktop_session_roots", return_value=[self.win32, self.store],
        )
        # 刪除交易只肯搬「家目錄內」的檔案。測試卡片建在 %TEMP%，而 TEMP
        # 不一定在家目錄下（這台機器就改到了 E:）—— 不把家目錄跟著指到
        # 測試根目錄的話，交易會以 400「路徑不在家目錄內」拒收假卡片。
        self._home_patch = mock.patch.object(
            api.Path, "home", staticmethod(lambda: self.root))
        self._index_patch.start()
        self._roots_patch.start()
        self._home_patch.start()

    def tearDown(self):
        self._home_patch.stop()
        self._roots_patch.stop()
        self._index_patch.stop()
        self._tmp.cleanup()

    def write_card(self, root: Path, name: str, *, archived: bool = False,
                   title: str = "同一個標題", cwd: str = "C:\\work",
                   sid: str = SID) -> Path:
        path = root / name
        path.write_text(json.dumps({
            "cliSessionId": sid,
            "isArchived": archived,
            "title": title,
            "cwd": cwd,
        }, ensure_ascii=False), encoding="utf-8")
        return path

    def write_index(self, conversations: list[dict]) -> None:
        self.index.write_text(json.dumps({
            "generated_at": "2026-08-29T00:00:00+0800",
            "conversations": conversations,
            # 故意放錯值，交易後必須由列資料重算，不可只 total - 1。
            "stats": {
                "total": 999, "subagent": 999, "duplicates": 999,
                "archived": 999, "trashed": 999, "dispatch": 999,
                "unique": 999, "elapsed_sec": 1.25,
            },
        }, ensure_ascii=False), encoding="utf-8")

    def claude_entry(self, **updates) -> dict:
        entry = {
            "id": f"claude__{SID}", "tool": "claude", "sessionId": SID,
            "path": str(self.root / "missing.jsonl"), "archived": False,
            "trashed": False, "trashReason": "", "hasMessages": True,
            "subagent": False, "dup": False, "dispatch": False,
            "inApp": True, "pinned": True, "metadataConflict": False,
        }
        entry.update(updates)
        return entry

    def handler(self, body: dict):
        handler = object.__new__(api.Handler)
        handler.TRASH = self.trash
        handler._body = lambda: body
        handler._json = lambda payload, code=200: (code, payload)
        return handler

    def read_index(self) -> dict:
        return json.loads(self.index.read_text(encoding="utf-8"))

    def test_claude_uuid接受大寫大括號空白且拒絕無效值(self):
        decorated = "  {" + SID.upper() + "}  "
        self.assertEqual(api.canonical_claude_session_id(decorated), SID)
        for invalid in ("", "session_123", "1234", "not-a-uuid"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                api.canonical_claude_session_id(invalid)

    def test_store與win32實體alias只回一次(self):
        card = self.write_card(self.win32, "local_original.json", sid=SID.upper())
        alias = self.store / "local_alias.json"
        try:
            os.link(card, alias)
        except OSError as exc:  # pragma: no cover - 非 NTFS CI 的保守退路
            self.skipTest(f"環境不支援 hard link：{exc}")

        got = api.discover_claude_desktop_cards("{" + SID + "}")

        self.assertEqual(got["sessionId"], SID)
        self.assertEqual(len(got["cards"]), 1)
        self.assertFalse(got["metadataConflict"])

    def test_distinct_cards_metadata不一致會明確回報衝突(self):
        self.write_card(self.win32, "local_a.json", title="甲")
        self.write_card(self.store, "local_b.json", title="乙")

        got = api.discover_claude_desktop_cards(SID)

        self.assertEqual(len(got["cards"]), 2)
        self.assertTrue(got["metadataConflict"])
        self.assertEqual(got["conflicts"]["title"], ["乙", "甲"])

    def test_metadata衝突時archive與delete都回409且零寫入(self):
        first = self.write_card(self.win32, "local_a.json", title="甲")
        second = self.write_card(self.store, "local_b.json", title="乙")
        self.write_index([self.claude_entry()])
        before_index = self.index.read_bytes()
        before_cards = (first.read_bytes(), second.read_bytes())

        for action, body in (
            ("archive", {"id": f"claude__{SID}", "archived": True}),
            ("delete", {"id": f"claude__{SID}"}),
        ):
            with self.subTest(action=action):
                handler = self.handler(body)
                result = (handler.do_conv_archive() if action == "archive"
                          else handler.do_conv_delete())
                code, response = result
                self.assertEqual(code, 409)
                self.assertTrue(response["metadataConflict"])
                self.assertEqual(self.index.read_bytes(), before_index)
                self.assertEqual((first.read_bytes(), second.read_bytes()), before_cards)

    def test_archive同步所有卡片並原子重算索引統計(self):
        cards = [
            self.write_card(self.win32, "local_a.json"),
            self.write_card(self.store, "local_b.json"),
        ]
        self.write_index([self.claude_entry()])

        code, body = self.handler({"id": f"claude__{SID}", "archived": True}).do_conv_archive()

        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["cards"], 2)
        self.assertTrue(all(json.loads(p.read_text(encoding="utf-8"))["isArchived"] for p in cards))
        data = self.read_index()
        self.assertTrue(data["conversations"][0]["archived"])
        self.assertEqual(data["conversations"][0]["trashReason"], "archived")
        self.assertEqual(data["stats"]["total"], 1)
        self.assertEqual(data["stats"]["archived"], 1)
        self.assertEqual(data["stats"]["trashed"], 1)
        self.assertEqual(data["stats"]["pinned"], 1)
        self.assertEqual(data["stats"]["inApp"], 1)
        self.assertFalse(list(self.root.rglob("*.tmp")), "唯一暫存檔必須清乾淨")

    def test_unarchive只清archive衍生垃圾狀態(self):
        self.write_card(self.win32, "local_a.json", archived=True)
        self.write_index([self.claude_entry(
            archived=True, trashed=True, trashReason="archived",
            archivePreviousTrashReason="stale",
        )])

        code, body = self.handler({"id": f"claude__{SID}", "archived": False}).do_conv_archive()

        self.assertEqual(code, 200)
        self.assertFalse(body["archived"])
        entry = self.read_index()["conversations"][0]
        self.assertFalse(entry["archived"])
        self.assertTrue(entry["trashed"])
        self.assertEqual(entry["trashReason"], "stale")
        self.assertNotIn("archivePreviousTrashReason", entry)

    def test_unarchive_active_metadata_only_card不會被no_messages留在垃圾桶(self):
        self.write_card(self.win32, "local_a.json", archived=True)
        self.write_index([self.claude_entry(
            archived=True, trashed=True, trashReason="archived",
            metadataOnly=True, hasMessages=False, inApp=True,
        )])

        code, body = self.handler(
            {"id": f"claude__{SID}", "archived": False},
        ).do_conv_archive()

        self.assertEqual(code, 200)
        self.assertFalse(body["archived"])
        entry = self.read_index()["conversations"][0]
        self.assertFalse(entry["trashed"])
        self.assertEqual(entry["trashReason"], "")

    def test_archive第二張卡失敗會回滾第一張且不改索引(self):
        first = self.write_card(self.win32, "local_a.json")
        second = self.write_card(self.store, "local_b.json")
        self.write_index([self.claude_entry()])
        before_index = self.index.read_bytes()
        real_replace = api._replace_file

        def fail_second(staged: Path, target: Path):
            if target == second:
                raise OSError("injected card failure")
            return real_replace(staged, target)

        with mock.patch.object(api, "_replace_file", side_effect=fail_second):
            code, body = self.handler(
                {"id": f"claude__{SID}", "archived": True},
            ).do_conv_archive()

        self.assertEqual(code, 500)
        self.assertFalse(body["ok"])
        self.assertTrue(body["rolledBack"])
        self.assertFalse(json.loads(first.read_text(encoding="utf-8"))["isArchived"])
        self.assertFalse(json.loads(second.read_text(encoding="utf-8"))["isArchived"])
        self.assertEqual(self.index.read_bytes(), before_index)

    def test_archive索引換入失敗不會吞錯且會回滾卡片(self):
        card = self.write_card(self.win32, "local_a.json")
        self.write_index([self.claude_entry()])
        before_index = self.index.read_bytes()
        real_replace = api._replace_file

        def fail_index(staged: Path, target: Path):
            if target == self.index:
                raise OSError("injected index failure")
            return real_replace(staged, target)

        with mock.patch.object(api, "_replace_file", side_effect=fail_index):
            code, body = self.handler(
                {"id": f"claude__{SID}", "archived": True},
            ).do_conv_archive()

        self.assertEqual(code, 500)
        self.assertIn("index failure", body["error"])
        self.assertTrue(body["rolledBack"])
        self.assertFalse(json.loads(card.read_text(encoding="utf-8"))["isArchived"])
        self.assertEqual(self.index.read_bytes(), before_index)

    def test_claude_card_only_delete會搬卡且重算所有aggregate(self):
        card = self.write_card(self.win32, "local_a.json")
        survivor = {
            "id": "grok__survivor", "tool": "grok", "path": str(self.root / "survivor.jsonl"),
            "archived": True, "trashed": True, "subagent": True,
            "dup": True, "dispatch": True, "pinned": False,
            "inApp": False, "metadataConflict": True,
        }
        self.write_index([self.claude_entry(), survivor])

        code, body = self.handler({"id": f"claude__{SID}"}).do_conv_delete()

        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["cardOnly"])
        self.assertFalse(card.exists())
        self.assertEqual(len(list(self.trash.iterdir())), 1)
        data = self.read_index()
        self.assertEqual([c["id"] for c in data["conversations"]], ["grok__survivor"])
        self.assertNotIn("dup", data["conversations"][0])
        self.assertNotIn("dupOf", data["conversations"][0])
        self.assertEqual(data["stats"], {
            "total": 1, "subagent": 1, "duplicates": 0, "archived": 1,
            "trashed": 1, "dispatch": 0, "unique": 1, "elapsed_sec": 1.25,
            "pinned": 0, "inApp": 0, "metadataConflict": 1,
        })

    def test_claude_delete任一卡搬移失敗會回滾且保留索引(self):
        first = self.write_card(self.win32, "local_a.json")
        second = self.write_card(self.store, "local_b.json")
        self.write_index([self.claude_entry()])
        before_index = self.index.read_bytes()
        real_move = api._move_path

        def fail_second(source: Path, destination: Path):
            if source == second:
                raise OSError("injected card move failure")
            return real_move(source, destination)

        with mock.patch.object(api, "_move_path", side_effect=fail_second):
            code, body = self.handler({"id": f"claude__{SID}"}).do_conv_delete()

        self.assertEqual(code, 500)
        self.assertFalse(body["ok"])
        self.assertTrue(body["rolledBack"])
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertEqual(self.index.read_bytes(), before_index)

    def test_codex_qwen_kimi刪除都要求回來源應用且不碰檔案(self):
        for tool in ("codex", "qwen", "kimi"):
            with self.subTest(tool=tool):
                source = self.root / f"{tool}.jsonl"
                source.write_text("{}\n", encoding="utf-8")
                conv_id = f"{tool}__safe"
                self.write_index([{
                    "id": conv_id, "tool": tool, "sessionId": "safe", "path": str(source),
                }])
                before = self.index.read_bytes()

                code, body = self.handler({"id": conv_id}).do_conv_delete()

                self.assertEqual(code, 409)
                self.assertFalse(body["ok"])
                self.assertTrue(body["sourceAppRequired"])
                self.assertTrue(source.exists())
                self.assertEqual(self.index.read_bytes(), before)

    def test_codex_archive也不會嘗試改內部資料庫(self):
        self.write_index([{
            "id": "codex__safe", "tool": "codex", "sessionId": "safe",
            "path": str(self.root / "codex.jsonl"),
        }])

        code, body = self.handler({"id": "codex__safe", "archived": True}).do_conv_archive()

        self.assertEqual(code, 409)
        self.assertTrue(body["sourceAppRequired"])

    def test_generic_drop_index_recomputes_counts而不是只減total(self):
        self.write_index([
            {"id": "drop", "subagent": True, "dup": True, "archived": True,
             "trashed": True, "dispatch": True},
            {"id": "keep", "subagent": False, "dup": False, "archived": False,
             "trashed": False, "dispatch": False},
        ])

        self.assertTrue(api.drop_index_conv("drop"))

        stats = self.read_index()["stats"]
        self.assertEqual(stats["total"], 1)
        self.assertEqual(stats["unique"], 1)
        for key in ("subagent", "duplicates", "archived", "trashed", "dispatch"):
            self.assertEqual(stats[key], 0)

    def test_delete_canonical後deterministically提升survivor並重建links(self):
        canonical_id = "claude__canonical"
        sid = "shared-session"
        self.write_index([
            {"id": canonical_id, "sessionId": sid, "tool": "claude",
             "toolLabel": "Claude", "mtime": 100, "inApp": True,
             "hasMessages": True, "subagent": False},
            {"id": "claude__older-cli", "sessionId": sid, "tool": "claude",
             "toolLabel": "Claude", "mtime": 90, "inApp": False,
             "hasMessages": True, "subagent": False, "dup": True,
             "dupOf": canonical_id, "dupOfTool": "Claude"},
            {"id": "claude__active-card", "sessionId": sid, "tool": "claude",
             "toolLabel": "Claude", "mtime": 10, "inApp": True,
             "hasMessages": False, "subagent": False, "dup": True,
             "dupOf": canonical_id, "dupOfTool": "Claude"},
        ])

        self.assertTrue(api.drop_index_conv(canonical_id))

        data = self.read_index()
        rows = {row["id"]: row for row in data["conversations"]}
        promoted = rows["claude__active-card"]
        duplicate = rows["claude__older-cli"]
        self.assertNotIn("dup", promoted)
        self.assertNotIn("dupOf", promoted)
        self.assertEqual(promoted["dupCount"], 1)
        self.assertTrue(duplicate["dup"])
        self.assertEqual(duplicate["dupOf"], promoted["id"])
        self.assertEqual(duplicate["dupOfTool"], "Claude")
        self.assertEqual(data["stats"]["duplicates"], 1)
        self.assertEqual(data["stats"]["unique"], 1)

    def test_archive跨程序鎖忙碌時回409且零寫入(self):
        card = self.write_card(self.win32, "local_a.json")
        self.write_index([self.claude_entry()])
        before_index = self.index.read_bytes()
        before_card = card.read_bytes()

        @contextlib.contextmanager
        def busy_lock(**_kwargs):
            raise TimeoutError("injected contention")
            yield  # pragma: no cover

        with mock.patch.object(api, "conversation_index_lock", busy_lock):
            code, body = self.handler(
                {"id": f"claude__{SID}", "archived": True},
            ).do_conv_archive()

        self.assertEqual(code, 409)
        self.assertTrue(body["busy"])
        self.assertEqual(self.index.read_bytes(), before_index)
        self.assertEqual(card.read_bytes(), before_card)

    def test_drop_index也會持有shared_cross_process_lock(self):
        self.write_index([{"id": "drop"}, {"id": "keep"}])
        entered = []

        @contextlib.contextmanager
        def recording_lock(**kwargs):
            entered.append(kwargs.get("timeout"))
            yield

        with mock.patch.object(api, "conversation_index_lock", recording_lock):
            self.assertTrue(api.drop_index_conv("drop"))

        self.assertEqual(entered, [60.0])
        self.assertEqual([c["id"] for c in self.read_index()["conversations"]], ["keep"])

    def test_refresh持process_lock等metadata交易但父程序不拿shared_lock(self):
        # fake indexer 回成功時也要像真 indexer 一樣留下可讀的新索引。
        self.write_index([])
        handler = self.handler({})
        handler.path = "/api/refresh"
        handler._same_origin = lambda: True
        attempting = threading.Event()
        child_started = threading.Event()
        result = []

        def fake_run(*_args, **_kwargs):
            child_started.set()
            return mock.Mock(returncode=0, stdout="indexed", stderr="")

        @contextlib.contextmanager
        def forbidden_parent_lock(**_kwargs):
            raise AssertionError("refresh parent must not take the child index lock")
            yield  # pragma: no cover

        def call_refresh():
            attempting.set()
            result.append(handler.do_POST())

        with mock.patch.object(api, "_run", side_effect=fake_run), \
                mock.patch.object(api, "conversation_index_lock", forbidden_parent_lock):
            with api._INDEX_LOCK:
                worker = threading.Thread(target=call_refresh)
                worker.start()
                self.assertTrue(attempting.wait(1))
                self.assertFalse(child_started.wait(0.1))
            worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertTrue(child_started.is_set())
        self.assertEqual(result[0][0], 200)
        self.assertTrue(result[0][1]["ok"])


if __name__ == "__main__":
    unittest.main()
