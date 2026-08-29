# -*- coding: utf-8 -*-
"""來源工具側欄 metadata 與索引去重的回歸測試（不碰真實 index）。"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import indexer  # noqa: E402
import index_lock  # noqa: E402


UUID = "12345678-1234-4abc-8def-1234567890ab"
UUID_2 = "22345678-1234-4abc-8def-1234567890ab"
UUID_3 = "32345678-1234-4abc-8def-1234567890ab"
UUID_4 = "42345678-1234-4abc-8def-1234567890ab"


class IndexerMetadataTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ac_indexer_")
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _card(self, base: Path, filename: str, **overrides) -> Path:
        path = base / "account" / "project" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "cliSessionId": UUID,
            "title": "側欄標題",
            "cwd": r"C:\work\exact",
            "isArchived": False,
            "lastActivityAt": 1000,
        }
        data.update(overrides)
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def _run_main(self, sources: list[dict]) -> dict:
        data = self.root / "public" / "data"
        conv = data / "conv"
        with mock.patch.object(indexer, "HOME", self.root), \
             mock.patch.object(indexer, "AI_HUB", self.root / "ai-hub"), \
             mock.patch.object(indexer, "DATA_DIR", data), \
             mock.patch.object(indexer, "CONV_DIR", conv), \
             mock.patch.object(indexer, "SOURCES_CACHE", data / "sources.json"), \
             mock.patch.object(indexer, "SOURCES", sources), \
             mock.patch.object(indexer, "discover_sources", return_value=[]):
            indexer.main()
        return json.loads((data / "index.json").read_text(encoding="utf-8"))

    def _qwen_header(self, sid: str, **overrides) -> Path:
        path = (self.root / ".craft-agent" / "workspaces" / "ws" /
                "sessions" / sid / "session.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "id": sid, "name": f"card {sid[-4:]}",
            "workspaceRootPath": r"C:\qwen", "hidden": False,
            "isArchived": False,
        }
        data.update(overrides)
        path.write_text(json.dumps(data) + "\n", encoding="utf-8")
        return path

    def _qwen_body(self, sid: str) -> Path:
        path = self.root / ".qwen" / "projects" / "p" / f"{sid}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "role": "user", "content": "body-" + sid + ("x" * 240),
        }) + "\n", encoding="utf-8")
        return path

    def _qwen_source(self) -> dict:
        return {
            "tool": "qwen", "label": "Qwen",
            "root": self.root / ".qwen" / "projects", "pattern": "*.jsonl",
            "resume": lambda sid, cwd: "",
        }

    def test_uuid_大小寫大括號與空白會_join_成同一筆(self):
        self.assertEqual(
            indexer.normalize_session_id(f"  {{{UUID.upper()}}}  "), UUID)
        self.assertEqual(
            indexer.normalize_session_id(f"SESSION_{{{UUID.upper()}}}"),
            f"session_{UUID}")

    def test_claude_實體別名去重且最新版衝突明確揭露(self):
        a = self.root / "roaming"
        b = self.root / "store"
        self._card(a, "local_a.json", cliSessionId=f" {{{UUID.upper()}}} ")
        self._card(b, "local_a.json", cliSessionId=UUID)

        got = indexer.load_claude_desktop(bases=[a, b])[UUID]
        self.assertEqual(got.alias_count, 1)
        self.assertFalse(got.conflict)
        self.assertEqual(len(got.cards), 2)
        self.assertEqual(got.title, "側欄標題")
        self.assertEqual(got.cwd, r"C:\work\exact")

        newer = self._card(
            b, "local_new.json",
            sessionId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            title="最新版", cwd=r"D:\new", isArchived=True,
            lastActivityAt=2000,
        )
        os.utime(newer, (2000, 2000))
        got = indexer.load_claude_desktop(bases=[a, b])[UUID]
        self.assertTrue(got.conflict)
        self.assertEqual(got.title, "最新版")
        self.assertEqual(got.cwd, r"D:\new")
        self.assertTrue(got.archived)
        self.assertIn("title", got.conflicts)
        self.assertIn("archived", got.conflicts)
        self.assertEqual(got.selected_card, str(newer))

    def test_claude_同新鮮度_archive_衝突會_fail_open(self):
        a = self.root / "a"
        b = self.root / "b"
        p1 = self._card(a, "local_1.json", isArchived=False, lastActivityAt=99)
        p2 = self._card(
            b, "local_2.json", sessionId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            isArchived=True, lastActivityAt=99)
        stamp = 1_700_000_000_000_000_000
        os.utime(p1, ns=(stamp, stamp))
        os.utime(p2, ns=(stamp, stamp))
        got = indexer.load_claude_desktop(bases=[a, b])[UUID]
        self.assertTrue(got.conflict)
        self.assertFalse(got.archived)

    def test_claude_壞卡不會崩潰且_cli_only_不是側欄對話(self):
        base = self.root / "cards"
        base.mkdir()
        (base / "local_bad.json").write_text("{not json", encoding="utf-8")
        self._card(base, "local_type.json", isArchived="false")
        catalog = indexer.load_claude_desktop(bases=[base])
        self.assertIn("invalid-isArchived", catalog[UUID].metadata_errors)
        self.assertFalse(catalog[UUID].in_app)
        self.assertTrue(catalog[UUID].conflict)
        self.assertIn("isArchivedType", catalog[UUID].conflicts)
        self.assertFalse(indexer.claude_metadata_for(UUID_2, catalog).in_app)
        self.assertEqual(indexer.claude_metadata_for(UUID_2, catalog).source,
                         "claude-cli-only")

    def _codex_dbs(self):
        codex = self.root / ".codex"
        (codex / "sqlite").mkdir(parents=True)
        state = sqlite3.connect(codex / "state_5.sqlite")
        state.execute("""CREATE TABLE threads (
            id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT,
            archived INTEGER, preview TEXT, is_pinned INTEGER,
            thread_source TEXT, updated_at_ms INTEGER)""")
        state.execute("CREATE TABLE thread_spawn_edges (child_thread_id TEXT)")
        rp1 = str(codex / "sessions" / f"rollout-{UUID}.jsonl")
        rp2 = str(codex / "sessions" / f"rollout-{UUID_2}.jsonl")
        rp3 = str(codex / "sessions" / f"rollout-{UUID_3}.jsonl")
        rp4 = str(codex / "sessions" / f"rollout-{UUID_4}.jsonl")
        state.executemany(
            "INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)", [
                (f" {{{UUID.upper()}}} ", rp1, "state title", r"C:\state", 1,
                 "preview one", 1, "root", 1_700_000_000_000),
                (UUID_2, rp2, "missing title", r"C:\missing", 0,
                 "preview missing", 0, "root", 1_700_000_001_000),
                (UUID_3, rp3, "card only", r"C:\card", 0,
                 "card preview", 1, "subagent", 1_700_000_002_000),
                (UUID_4, rp4, "archived only", r"C:\archive", 1,
                 "archive preview", 0, "root", 1_700_000_003_000),
            ])
        state.commit()
        state.close()

        cat = sqlite3.connect(codex / "sqlite" / "codex-dev.db")
        cat.execute("""CREATE TABLE local_thread_catalog (
            host_id TEXT, thread_id TEXT, display_title TEXT, cwd TEXT,
            source_kind TEXT, source_updated_at REAL, source_recency_at REAL,
            observation_sequence INTEGER, missing_candidate INTEGER,
            PRIMARY KEY (host_id, thread_id))""")
        cat.executemany(
            "INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?,?,?,?)", [
                ("local", UUID, "本機標題", r"C:\catalog", "vscode", 10, 20, 3, 0),
                ("chatgpt", UUID, "雲端標題", r"Z:\cloud", "chatgpt", 99, 99, 9, 0),
                ("local", UUID_2, "候選已失蹤", r"C:\missing", "vscode", 10, 10, 1, 1),
                ("local", UUID_3.upper(), "無 rollout 卡", r"C:\card", "vscode", 30, 30, 4, 0),
            ])
        cat.commit()
        cat.close()
        return Path(rp1).name, Path(rp2).name, Path(rp3).name, Path(rp4).name

    def test_codex_只_join_本機_catalog_並保留_state_權威欄位(self):
        name1, name2, name3, name4 = self._codex_dbs()
        info, children, cards, state = indexer.load_codex_threads(self.root)
        self.assertTrue(info[name1]["in_app"])
        self.assertEqual(info[name1]["title"], "本機標題")
        self.assertEqual(info[name1]["cwd"], r"C:\catalog")
        self.assertTrue(info[name1]["archived"])
        self.assertEqual(info[name1]["preview"], "preview one")
        self.assertTrue(info[name1]["is_pinned"])
        self.assertEqual(info[name1]["thread_source"], "root")
        self.assertFalse(info[name2]["in_app"])  # missing_candidate=1
        self.assertNotIn(UUID_2, cards)
        self.assertTrue(info[name3]["in_app"])
        self.assertIn(UUID_3, cards)  # 本機檔不存在仍要輸出 metadata-only card
        self.assertIn(UUID_3, state)
        self.assertIn(UUID_3, children)  # thread_source 比 spawn edge 完整
        self.assertTrue(state[UUID_4]["archived"])
        self.assertFalse(info[name4]["in_app"])
        self.assertNotEqual(info[name1]["title"], "雲端標題")

    def test_main_只在暫存輸出_codex_metadata_only_卡(self):
        self._codex_dbs()
        data = self.root / "public" / "data"
        conv = data / "conv"
        with mock.patch.object(indexer, "HOME", self.root), \
             mock.patch.object(indexer, "AI_HUB", self.root / "ai-hub"), \
             mock.patch.object(indexer, "DATA_DIR", data), \
             mock.patch.object(indexer, "CONV_DIR", conv), \
             mock.patch.object(indexer, "SOURCES_CACHE", data / "sources.json"), \
             mock.patch.object(indexer, "SOURCES", []), \
             mock.patch.object(indexer, "discover_sources", return_value=[]):
            indexer.main()
        rows = json.loads((data / "index.json").read_text(encoding="utf-8"))["conversations"]
        by_sid = {row["sessionId"]: row for row in rows}
        self.assertEqual(set(by_sid), {UUID, UUID_3, UUID_4})
        self.assertTrue(by_sid[UUID_3]["metadataOnly"])
        self.assertTrue(by_sid[UUID_3]["inApp"])
        self.assertFalse(by_sid[UUID_3]["trashed"])
        self.assertTrue(by_sid[UUID_3]["pinned"])
        self.assertTrue(by_sid[UUID_3]["subagent"])
        self.assertTrue(by_sid[UUID]["archived"])
        self.assertTrue(by_sid[UUID_4]["metadataOnly"])
        self.assertFalse(by_sid[UUID_4]["inApp"])
        self.assertEqual(by_sid[UUID_4]["trashReason"], "archived")

    def test_kimi_state_archive_完整_id_與非_main_子代理(self):
        app = self.root / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent"
        app.mkdir(parents=True)
        (app / "conversation-archive.json").write_text(json.dumps({
            f"session_{UUID}": {"title": "桌面覆寫", "archivedAt": 123, "project": ""},
        }), encoding="utf-8")
        overlays, ok = indexer.load_kimi_desktop(self.root)
        self.assertTrue(ok)

        session = self.root / "sessions" / f"session_{UUID.upper()}"
        main = session / "agents" / "main" / "wire.jsonl"
        agent = session / "agents" / "agent-1" / "wire.jsonl"
        main.parent.mkdir(parents=True)
        agent.parent.mkdir(parents=True)
        main.write_text("{}\n", encoding="utf-8")
        agent.write_text("{}\n", encoding="utf-8")
        (session / "state.json").write_text(json.dumps({
            "id": f"SESSION_{UUID.upper()}", "title": "state title",
            "cwd": r"C:\kimi", "archived": False,
        }), encoding="utf-8")

        got = indexer.load_sidecar(
            main, "kimi", kimi_desktop=overlays, kimi_catalog_ok=ok)
        self.assertEqual(got.session_id, f"session_{UUID}")
        self.assertEqual(got.title, "桌面覆寫")
        self.assertTrue(got.archived)
        self.assertTrue(got.in_app)
        self.assertEqual(indexer.session_id_for(main, self.root / "sessions"),
                         f"session_{UUID}")
        self.assertFalse(indexer.load_sidecar(
            agent, "kimi", kimi_desktop=overlays, kimi_catalog_ok=ok).in_app)

    def test_kimi_或_qwen_權威_metadata_損壞時_fail_closed(self):
        session = self.root / f"session_{UUID}"
        main = session / "agents" / "main" / "wire.jsonl"
        main.parent.mkdir(parents=True)
        main.write_text("{}\n", encoding="utf-8")
        (session / "state.json").write_text("not-json", encoding="utf-8")
        self.assertFalse(indexer.load_sidecar(main, "kimi").in_app)

        qwen = self.root / "ws" / "sessions" / UUID / "session.jsonl"
        qwen.parent.mkdir(parents=True)
        qwen.write_text("not-json\n", encoding="utf-8")
        self.assertFalse(indexer.load_sidecar(
            qwen, "qwen", qwen_catalog_available=True).in_app)

    def test_kimi_qwen_布林欄位型別錯誤會_fail_closed_並揭露衝突(self):
        app = self.root / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent"
        app.mkdir(parents=True)
        state = (self.root / ".kimi-code" / "sessions" / "wd" /
                 f"session_{UUID}" / "state.json")
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({
            "id": f"session_{UUID}", "title": "bad archived",
            "cwd": r"C:\kimi", "archived": "false",
        }), encoding="utf-8")
        kimi, _ = indexer.load_kimi_catalog(self.root)
        self.assertFalse(kimi[f"session_{UUID}"].in_app)
        self.assertTrue(kimi[f"session_{UUID}"].conflict)
        self.assertIn("invalid-archived", kimi[f"session_{UUID}"].metadata_errors)

        self._qwen_header(UUID, isArchived="false")
        self._qwen_header(UUID_2, hidden="false")
        qwen, _ = indexer.load_qwen_catalog(
            root=self.root / ".craft-agent" / "workspaces")
        for sid, error in ((UUID, "invalid-isArchived"), (UUID_2, "invalid-hidden")):
            self.assertFalse(qwen[sid].in_app)
            self.assertTrue(qwen[sid].conflict)
            self.assertIn(error, qwen[sid].metadata_errors)
            self.assertIn(error, qwen[sid].conflicts)

    def test_qwen_desktop_header_權威且舊_cli_依_catalog_fail_closed(self):
        qwen = self.root / "ws" / "sessions" / UUID / "session.jsonl"
        qwen.parent.mkdir(parents=True)
        qwen.write_text(json.dumps({
            "id": f" {{{UUID.upper()}}} ", "name": "Qwen 側欄",
            "workspaceRootPath": r"C:\qwen", "hidden": False,
            "isArchived": True,
        }) + "\n", encoding="utf-8")
        got = indexer.load_sidecar(qwen, "qwen", qwen_catalog_available=True)
        self.assertTrue(got.in_app)
        self.assertTrue(got.archived)
        self.assertEqual(got.title, "Qwen 側欄")
        self.assertEqual(got.session_id, UUID)

        legacy = self.root / "legacy" / f"{UUID}.jsonl"
        legacy.parent.mkdir()
        legacy.write_text("{}\n", encoding="utf-8")
        self.assertFalse(indexer.load_sidecar(
            legacy, "qwen", qwen_catalog_available=True).in_app)
        self.assertTrue(indexer.load_sidecar(
            legacy, "qwen", qwen_catalog_available=False).in_app)

    def test_qwen_14_張卡疊到_56_份本文後只有_14_筆側欄現役(self):
        ids = [f"00000000-0000-4000-8000-{i:012x}" for i in range(56)]
        for sid in ids[:14]:
            self._qwen_header(sid)
        for sid in ids:
            self._qwen_body(sid)

        index = self._run_main([self._qwen_source()])
        rows = [r for r in index["conversations"] if r["tool"] == "qwen"]
        active = [r for r in rows if r["inApp"] and r["trashReason"] != "not-in-app"]
        self.assertEqual(len(rows), 56)
        self.assertEqual(len(active), 14)
        self.assertTrue(all(r["hasMessages"] for r in active))
        self.assertTrue(all(not r.get("metadataOnly") for r in active))
        self.assertTrue(all(".qwen" in r["path"] for r in active))
        self.assertEqual(sum(r["trashReason"] == "not-in-app" for r in rows), 42)

    def test_qwen_缺本文卡用_metadata_only_補齊且不判_no_messages(self):
        self._qwen_header(UUID)
        self._qwen_header(UUID_2)
        self._qwen_body(UUID)

        rows = [r for r in self._run_main([self._qwen_source()])["conversations"]
                if r["tool"] == "qwen"]
        by_sid = {r["sessionId"]: r for r in rows}
        self.assertTrue(by_sid[UUID]["hasMessages"])
        self.assertFalse(by_sid[UUID].get("metadataOnly", False))
        self.assertTrue(by_sid[UUID_2]["metadataOnly"])
        self.assertTrue(by_sid[UUID_2]["inApp"])
        self.assertFalse(by_sid[UUID_2]["trashed"])
        self.assertNotEqual(by_sid[UUID_2]["trashReason"], "no-messages")
        self.assertTrue(by_sid[UUID_2]["path"].endswith("session.jsonl"))

    def test_權威現役卡不受_stale_或_not_active_tool_規則影響(self):
        header = self._qwen_header(UUID)
        body = self._qwen_body(UUID)
        old = 1_500_000_000
        os.utime(header, (old, old))
        os.utime(body, (old, old))
        with mock.patch.object(indexer, "ACTIVE_TOOLS", {"codex"}), \
             mock.patch.object(indexer, "TRASH_AFTER_DAYS", 1):
            rows = self._run_main([self._qwen_source()])["conversations"]
        row = next(r for r in rows if r["tool"] == "qwen")
        self.assertTrue(row["inApp"])
        self.assertFalse(row["archived"])
        self.assertFalse(row["trashed"])
        self.assertEqual(row["trashReason"], "")

    def test_qwen_archived_hidden_與_active_各自保留正確狀態(self):
        self._qwen_header(UUID)
        self._qwen_header(UUID_2, isArchived=True)
        self._qwen_header(UUID_3, hidden=True)
        for sid in (UUID, UUID_2, UUID_3):
            self._qwen_body(sid)
        rows = [r for r in self._run_main([self._qwen_source()])["conversations"]
                if r["tool"] == "qwen"]
        by_sid = {r["sessionId"]: r for r in rows}
        self.assertFalse(by_sid[UUID]["trashed"])
        self.assertTrue(by_sid[UUID_2]["archived"])
        self.assertEqual(by_sid[UUID_2]["trashReason"], "archived")
        self.assertFalse(by_sid[UUID_3]["inApp"])
        self.assertEqual(by_sid[UUID_3]["trashReason"], "not-in-app")

    def test_qwen_codex_同_uuid_都是真側欄時不互相去重(self):
        self._codex_dbs()
        self._qwen_header(UUID)
        self._qwen_body(UUID)
        rows = self._run_main([self._qwen_source()])["conversations"]
        collision = [r for r in rows if r["sessionId"] == UUID and r["tool"] in ("codex", "qwen")]
        self.assertEqual({r["tool"] for r in collision}, {"codex", "qwen"})
        self.assertTrue(all(r["inApp"] for r in collision))
        self.assertTrue(all(not r.get("dup", False) for r in collision))

    def test_claude_權威卡沒有_jsonl_仍輸出_active_metadata_only(self):
        base = (self.root / "AppData" / "Roaming" / "Claude" /
                "claude-code-sessions")
        self._card(base, "local_card.json")
        rows = self._run_main([])["conversations"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["tool"], "claude")
        self.assertTrue(row["metadataOnly"])
        self.assertTrue(row["inApp"])
        self.assertFalse(row["trashed"])
        self.assertEqual(row["title"], "側欄標題")
        self.assertNotEqual(row["trashReason"], "no-messages")

    def test_kimi_state_沒有_main_wire_仍輸出_active_metadata_only(self):
        app = self.root / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent"
        app.mkdir(parents=True)
        state = (self.root / ".kimi-code" / "sessions" / "wd_x" /
                 f"session_{UUID}" / "state.json")
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({
            "id": f"session_{UUID}", "title": "Kimi 卡",
            "cwd": r"C:\kimi", "archived": False,
        }), encoding="utf-8")
        wire = state.parent / "agents" / "main" / "wire.jsonl"
        wire.parent.mkdir(parents=True)
        wire.write_text("{}\n", encoding="utf-8")  # 過小本文也不能讓卡片消失
        source = {
            "tool": "kimi", "label": "Kimi CLI",
            "root": self.root / ".kimi-code" / "sessions", "pattern": "*.jsonl",
            "resume": lambda sid, cwd: f"kimi -r {sid}",
        }
        rows = self._run_main([source])["conversations"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sessionId"], f"session_{UUID}")
        self.assertTrue(rows[0]["metadataOnly"])
        self.assertTrue(rows[0]["inApp"])
        self.assertFalse(rows[0]["trashed"])
        self.assertTrue(rows[0]["path"].endswith("state.json"))

    def test_三家_metadata_id_無效都_fail_closed(self):
        claude = self.root / "claude"
        self._card(claude, "local_bad_id.json", cliSessionId="not-a-uuid")
        self._card(claude, "local_bad_card.json", cliSessionId=UUID,
                   sessionId="local_not-a-uuid")
        self.assertEqual(indexer.load_claude_desktop(bases=[claude]), {})

        self._qwen_header(UUID, id="not-a-uuid")
        qwen, available = indexer.load_qwen_catalog(
            root=self.root / ".craft-agent" / "workspaces")
        self.assertTrue(available)
        self.assertEqual(qwen, {})

        app = self.root / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent"
        app.mkdir(parents=True)
        state = (self.root / ".kimi-code" / "sessions" / "wd" /
                 f"session_{UUID}" / "state.json")
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({
            "id": UUID, "title": "bad", "cwd": "", "archived": False,
        }), encoding="utf-8")  # Kimi 必須帶 session_ 前綴
        kimi, present = indexer.load_kimi_catalog(self.root)
        self.assertTrue(present)
        self.assertEqual(kimi, {})
        wire = state.parent / "agents" / "main" / "wire.jsonl"
        wire.parent.mkdir(parents=True)
        wire.write_text("{}\n", encoding="utf-8")
        self.assertFalse(indexer.load_sidecar(wire, "kimi").in_app)

    def test_subagents_目錄是雜訊(self):
        root = self.root / "source"
        path = root / "subagents" / "x.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text("{}\n", encoding="utf-8")
        self.assertTrue(indexer._in_noise_dir(path, root))

    def test_自動發現的父目錄不會重複掃已知子目錄(self):
        known = self.root / ".codex" / "sessions"
        discovered_parent = self.root / ".codex"
        sibling = self.root / ".codex-other"
        self.assertTrue(indexer.source_roots_overlap(discovered_parent, known))
        self.assertTrue(indexer.source_roots_overlap(known, discovered_parent))
        self.assertFalse(indexer.source_roots_overlap(sibling, known))

    def test_stale_source_cache_仍套用完整敏感目錄與檔名政策(self):
        root = self.root / "source"
        for dirname in ("Bridge_Store", "OAuth Storage", "Local Storage",
                        "credentials-db", "Session Storage"):
            path = root / dirname / "conversation.jsonl"
            self.assertTrue(indexer._in_noise_dir(path, root), dirname)
        for filename in ("refresh_token.jsonl", "current_session.jsonl",
                         "Cookies", "api-keys.json"):
            self.assertTrue(indexer._in_noise_dir(root / filename, root), filename)

        sensitive_root = self.root / "OAuth Storage"
        sensitive_root.mkdir()
        sources, labels = indexer.merge_discovered_sources([], [{
            "tool": "bad", "label": "Bad", "root": str(sensitive_root),
            "pattern": "*.jsonl", "hits": 9,
        }])
        self.assertEqual(sources, [])
        self.assertEqual(labels, [])

    def test_接受_discovered_root_後立即擋祖先與後代重疊(self):
        parent = self.root / "tool"
        child = parent / "sessions"
        child.mkdir(parents=True)

        def row(path, label):
            return {"tool": label.lower(), "label": label, "root": str(path),
                    "pattern": "*.jsonl", "hits": 2}

        sources, _ = indexer.merge_discovered_sources(
            [], [row(parent, "Parent"), row(child, "Child")])
        self.assertEqual([Path(s["root"]) for s in sources], [parent])

        sources, _ = indexer.merge_discovered_sources(
            [], [row(child, "Child"), row(parent, "Parent")])
        self.assertEqual([Path(s["root"]) for s in sources], [child])

    def test_index_json_原子換檔且失敗不破壞舊檔(self):
        target = self.root / "data" / "index.json"
        target.parent.mkdir()
        target.write_text('{"old":true}', encoding="utf-8")
        indexer._atomic_write_json(target, {"new": "完整"})
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"new": "完整"})
        self.assertEqual(list(target.parent.glob(".index.json.*.tmp")), [])

        target.write_text('{"stable":true}', encoding="utf-8")
        with mock.patch.object(indexer.os, "replace", side_effect=OSError("replace failed")), \
             self.assertRaises(OSError):
            indexer._atomic_write_json(target, {"partial": True})
        self.assertEqual(target.read_text(encoding="utf-8"), '{"stable":true}')
        self.assertEqual(list(target.parent.glob(".index.json.*.tmp")), [])

    def test_index_lock_跨程序互斥逾時且釋放後可重取(self):
        mutex_name = rf"Local\AIConsoleIndexTest{os.getpid()}_{id(self)}"
        lock_path = self.root / "index-test.lock"
        tools_dir = str(Path(index_lock.__file__).resolve().parent)
        code = (
            "import sys\n"
            "from index_lock import conversation_index_lock\n"
            "try:\n"
            "  with conversation_index_lock(timeout=0.15, mutex_name=sys.argv[1], lock_path=sys.argv[2]):\n"
            "    print('acquired')\n"
            "except TimeoutError:\n"
            "  print('timeout')\n"
        )
        env = dict(os.environ)
        env["PYTHONPATH"] = tools_dir + os.pathsep + env.get("PYTHONPATH", "")
        with index_lock.conversation_index_lock(
                timeout=1, mutex_name=mutex_name, lock_path=lock_path):
            child = subprocess.run(
                [sys.executable, "-X", "utf8", "-c", code,
                 mutex_name, str(lock_path)], capture_output=True,
                text=True, timeout=5, env=env, check=True)
        self.assertEqual(child.stdout.strip(), "timeout")
        with index_lock.conversation_index_lock(
                timeout=0.5, mutex_name=mutex_name, lock_path=lock_path):
            pass

    def test_main_以_shared_lock_包住整個_build(self):
        with mock.patch.object(indexer, "conversation_index_lock") as lock, \
             mock.patch.object(indexer, "_build_index", return_value="done") as build:
            self.assertEqual(indexer.main(), "done")
        lock.assert_called_once_with(timeout=60.0)
        lock.return_value.__enter__.assert_called_once()
        lock.return_value.__exit__.assert_called_once()
        build.assert_called_once_with()

    def test_indexer_同時支援_package_與_direct_script_import(self):
        project = Path(indexer.__file__).resolve().parent.parent
        env = dict(os.environ)
        env["PYTHONPATH"] = str(project) + os.pathsep + env.get("PYTHONPATH", "")
        package = subprocess.run(
            [sys.executable, "-X", "utf8", "-c",
             "import tools.indexer as m; print(m.__name__)"],
            cwd=project, env=env, capture_output=True, text=True,
            timeout=10, check=True)
        self.assertEqual(package.stdout.strip(), "tools.indexer")

        direct = subprocess.run(
            [sys.executable, "-X", "utf8", "-c",
             "import sys; sys.path.insert(0, 'tools'); import indexer as m; print(m.__name__)"],
            cwd=project, env=env, capture_output=True, text=True,
            timeout=10, check=True)
        self.assertEqual(direct.stdout.strip(), "indexer")

    def test_codex_delegation_後置重分類只計一次_subagent(self):
        sessions = self.root / ".codex" / "sessions"
        path = sessions / f"rollout-{UUID}.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({
            "role": "user", "content": "普通訊息" + ("x" * 240),
        }) + "\n", encoding="utf-8")
        meta = {
            "title": "<codex_delegation task>", "cwd": r"C:\work",
            "archived": False, "in_app": False, "preview": "",
            "is_pinned": False, "thread_source": "root",
            "session_id": UUID, "rollout_path": str(path), "updated_at": 0,
        }
        source = {
            "tool": "codex", "label": "Codex CLI", "root": sessions,
            "pattern": "*.jsonl", "resume": lambda sid, cwd: f"codex resume {sid}",
        }
        with mock.patch.object(
                indexer, "load_codex_threads",
                return_value=({path.name: meta}, set(), {}, {UUID: meta})):
            result = self._run_main([source])
        self.assertEqual(len(result["conversations"]), 1)
        self.assertTrue(result["conversations"][0]["subagent"])
        self.assertEqual(result["stats"]["subagent"], 1)

    def test_去重保留跨工具真側欄並讓_kimi_main_勝過較新子代理(self):
        def row(tool, suffix, *, in_app, subagent=False, mtime=1):
            return {"id": f"{tool}__{suffix}", "tool": tool,
                    "toolLabel": tool, "sessionId": UUID,
                    "inApp": in_app, "subagent": subagent,
                    "hasMessages": True, "mtime": mtime}

        codex = row("codex", "card", in_app=True, mtime=1)
        qwen = row("qwen", "card", in_app=True, mtime=9)
        qwen_cli = row("qwen", "cli", in_app=False, mtime=99)
        rows = [codex, qwen, qwen_cli]
        self.assertEqual(indexer._mark_duplicates(rows), 1)
        self.assertFalse(codex.get("dup", False))
        self.assertFalse(qwen.get("dup", False))
        self.assertEqual(qwen_cli["dupOf"], qwen["id"])

        main = row("kimi", "main", in_app=True, mtime=1)
        agent = row("kimi", "agent", in_app=False, subagent=True, mtime=999)
        self.assertEqual(indexer._mark_duplicates([main, agent]), 1)
        self.assertFalse(main.get("dup", False))
        self.assertEqual(agent["dupOf"], main["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
