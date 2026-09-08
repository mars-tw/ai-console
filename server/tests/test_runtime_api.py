# -*- coding: utf-8 -*-
"""Readiness integration tests with isolated facts; never call LM Studio."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402
import runtime_readiness as rr  # noqa: E402


DENIED = {
    "ok": False,
    "error": "沒有可用的工具",
    "ready": False,
    "nextAction": "setup",
}
LOCAL_ROW = {
    "id": "local", "label": "地端模型", "mode": "local",
    "installed": True, "ready": True, "state": "needs_start",
    "readiness": "prepare_on_send", "authStatus": "not_required",
    "limited": False, "reason": "safe", "available": True,
    "models": ["qwen/qwen3.5-4b"], "model": "qwen/qwen3.5-4b", "loaded": [],
}
LOCAL_SNAPSHOT = {
    "ok": True, "tools": [LOCAL_ROW], "auto": "local", "ready": True,
    "reason": "safe", "local": LOCAL_ROW,
}
NO_AI_SNAPSHOT = {
    "ok": True, "tools": [{
        "id": "local", "label": "地端模型", "mode": "local",
        "installed": False, "ready": False, "state": "missing_tool",
        "readiness": "needs_setup", "authStatus": "not_required",
        "limited": False, "reason": "missing", "available": False,
        "models": [], "model": None, "loaded": [], "nextAction": "setup",
    }], "auto": None, "ready": False, "reason": "沒有可用的工具",
    "nextAction": "setup",
}
NO_AI_SNAPSHOT["local"] = NO_AI_SNAPSHOT["tools"][0]


class FakeHandler(api.Handler):
    def __init__(self, body=None, path="/api/dispatch", same_origin=True):
        self.payload = {} if body is None else body
        self.path = path
        self.same_origin = same_origin
        self.response = None
        self.headers = {"Origin": "http://127.0.0.1:5177"}

    def _body(self):
        return self.payload

    def _json(self, payload, code=200):
        self.response = code, payload
        return self.response

    def _same_origin(self):
        return self.same_origin


class RuntimeApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ac_runtime_api_"))
        self._dispatches = api.Handler.DISPATCHES
        self._registry = api.Handler.REGISTRY
        api.Handler.DISPATCHES = []
        api.Handler.REGISTRY = self.tmp / "registry.json"

    def tearDown(self):
        api.Handler.DISPATCHES = self._dispatches
        api.Handler.REGISTRY = self._registry
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def _ready_resolution():
        return LOCAL_SNAPSHOT, "local", LOCAL_ROW, None

    @staticmethod
    def _denied_resolution():
        return NO_AI_SNAPSHOT, None, None, dict(DENIED)

    def test_tools_then_dispatch_uses_a_fresh_denial_not_a_stale_green_snapshot(self):
        handler = FakeHandler({"task": "do work", "tool": "auto"})
        with mock.patch.object(api.Handler, "_readiness_snapshot",
                               side_effect=[LOCAL_SNAPSHOT, NO_AI_SNAPSHOT]), \
                mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch("subprocess.Popen") as spawn:
            handler.do_dispatch_tools()
            self.assertTrue(handler.response[1]["ready"])
            handler.do_dispatch()
        self.assertEqual(handler.response[0], 503)
        self.assertFalse(handler.response[1]["ok"])
        spawn.assert_not_called()

    def test_no_ai_plan_has_no_fake_steps(self):
        handler = FakeHandler({"instruction": "整理這件事"}, path="/api/plan")
        with mock.patch.object(api.Handler, "_readiness_snapshot", return_value=NO_AI_SNAPSHOT), \
                mock.patch.object(api, "planner_model", return_value=""):
            handler.do_plan()
        self.assertFalse(handler.response[1]["ok"])
        self.assertEqual(handler.response[1]["steps"], [])
        self.assertEqual(handler.response[1]["nextAction"], "setup")

    def test_rejected_single_dispatch_never_wraps_or_spawns(self):
        handler = FakeHandler({"task": "do work", "tool": "local"})
        with mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  side_effect=lambda *_: self._denied_resolution()), \
                mock.patch.object(api.rules, "wrap") as wrap, \
                mock.patch("subprocess.Popen") as spawn:
            handler.do_dispatch()
        self.assertEqual(handler.response[0], 503)
        self.assertEqual(handler.response[1]["nextAction"], "setup")
        wrap.assert_not_called()
        spawn.assert_not_called()

    def test_local_dispatch_ensures_selected_key_and_uses_returned_identifier(self):
        handler = FakeHandler({"task": "回答", "tool": "local", "raw": True})

        class Response:
            def read(self):
                return json.dumps({"choices": [{"message": {"content": "完成"}}]}).encode("utf-8")

        original_home = api.Path.home
        api.Path.home = staticmethod(lambda: self.tmp)
        try:
            with mock.patch.object(api.Handler, "_load_registry"), \
                    mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                      side_effect=lambda *_: self._ready_resolution()), \
                    mock.patch.object(api, "ensure_lms_chat_model", return_value="safe-instance") as ensure, \
                    mock.patch.object(api.urllib.request, "urlopen", return_value=Response()) as open_call, \
                    mock.patch.object(api.Handler, "_reg_append") as append:
                handler.do_dispatch()
        finally:
            api.Path.home = original_home
        self.assertEqual(handler.response[0], 200)
        self.assertTrue(handler.response[1]["ok"])
        ensure.assert_called_once_with("qwen/qwen3.5-4b")
        payload = json.loads(open_call.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(payload["model"], "safe-instance")
        append.assert_called_once()

    def test_local_reasoning_only_reply_is_not_success(self):
        handler = FakeHandler({"task": "回答", "tool": "local", "raw": True})

        class Response:
            def read(self):
                return json.dumps({"choices": [{"message": {"reasoning_content": "hidden"}}]}).encode("utf-8")

        original_home = api.Path.home
        api.Path.home = staticmethod(lambda: self.tmp)
        try:
            with mock.patch.object(api.Handler, "_load_registry"), \
                    mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                      side_effect=lambda *_: self._ready_resolution()), \
                    mock.patch.object(api, "ensure_lms_chat_model", return_value="safe-instance"), \
                    mock.patch.object(api.urllib.request, "urlopen", return_value=Response()), \
                    mock.patch.object(api.Handler, "_reg_append") as append:
                handler.do_dispatch()
        finally:
            api.Path.home = original_home
        self.assertEqual(handler.response[0], 502)
        self.assertFalse(handler.response[1]["ok"])
        append.assert_not_called()

    def test_batch_preflights_every_step_before_starting_a_thread(self):
        handler = FakeHandler({"steps": [
            {"tool": "local", "task": "first"},
            {"tool": "unknown", "task": "second"},
        ]}, path="/api/dispatch/batch")
        with mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                               side_effect=[self._ready_resolution(), self._denied_resolution()]), \
                mock.patch("threading.Thread") as worker:
            handler.do_dispatch_batch()
        self.assertEqual(handler.response[0], 503)
        self.assertEqual(handler.response[1]["failedStep"], 2)
        self.assertEqual(handler.response[1]["nextAction"], "setup")
        worker.assert_not_called()

    def test_schedule_run_rejects_before_dispatch(self):
        handler = FakeHandler({"id": "job-1"}, path="/api/schedule/run")
        with mock.patch.object(api.schedule, "load", return_value=[{
                    "id": "job-1", "tool": "local", "task": "run"}]), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  side_effect=lambda *_: self._denied_resolution()), \
                mock.patch.object(api.Handler, "_dispatch_now") as dispatch_now:
            handler.do_schedule_run()
        self.assertEqual(handler.response[0], 503)
        dispatch_now.assert_not_called()

    def test_retry_rejects_before_its_internal_http_dispatch(self):
        stamp = "20260101-000000"
        log = self.tmp / f"{stamp}_local.log"
        log.write_text("x", encoding="utf-8")
        (self.tmp / f"{stamp}_task.md").write_text("【工單】\noriginal task", encoding="utf-8")
        api.Handler.DISPATCHES = [{"id": stamp, "tool": "local", "pid": None,
                                   "log": str(log)}]
        handler = FakeHandler({"id": stamp}, path="/api/dispatch/retry")
        with mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                               side_effect=lambda *_: self._denied_resolution()), \
                mock.patch.object(api.urllib.request, "urlopen") as open_call:
            handler.do_dispatch_retry()
        self.assertEqual(handler.response[0], 503)
        self.assertEqual(handler.response[1]["nextAction"], "setup")
        open_call.assert_not_called()

    def test_followup_queues_an_alive_worker_before_handoff_or_readiness_checks(self):
        api.Handler.DISPATCHES = [{"id": "active", "tool": "qwen", "pid": 44,
                                   "pending": []}]
        handler = FakeHandler({"id": "active", "text": "補一句"}, path="/api/dispatch/followup")
        with mock.patch.object(api, "_alive_pids", return_value={44}), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  side_effect=AssertionError("queued work must not hand off")), \
                mock.patch.object(api.Handler, "_save_registry"):
            handler.do_followup()
        self.assertEqual(handler.response[0], 200)
        self.assertTrue(handler.response[1]["queued"])
        self.assertEqual(api.Handler.DISPATCHES[0]["pending"], ["補一句"])

    def test_unavailable_followup_rejects_without_spawning(self):
        api.Handler.DISPATCHES = [{"id": "done", "tool": "qwen", "pid": None,
                                   "log": str(self.tmp / "done.log")}]
        handler = FakeHandler({"id": "done", "text": "補一句"}, path="/api/dispatch/followup")
        with mock.patch.object(api, "_alive_pids", return_value=set()), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  side_effect=lambda *_: self._denied_resolution()), \
                mock.patch.object(api, "_bin_available", return_value=False), \
                mock.patch.object(api.urllib.request, "urlopen") as open_call:
            handler.do_followup()
        self.assertEqual(handler.response[0], 503)
        self.assertEqual(handler.response[1]["nextAction"], "setup")
        open_call.assert_not_called()

    def test_local_answer_followup_rejects_instead_of_rerouting_to_a_ready_cli(self):
        """A local answer is answer-only: following up must never become a CLI
        that edits files, even with a perfectly ready one standing by."""
        for record in ({"id": "chat", "tool": "local", "mode": "sync", "pid": None},
                       {"id": "chat", "tool": "local", "mode": "headless", "pid": None},
                       {"id": "chat", "tool": "qwen", "mode": "sync", "pid": None}):
            with self.subTest(record=record):
                api.Handler.DISPATCHES = [dict(record)]
                handler = FakeHandler({"id": "chat", "text": "再問一句"},
                                      path="/api/dispatch/followup")
                with mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                       side_effect=AssertionError("local answers must not reroute")), \
                        mock.patch.object(api.Handler, "_send_followup",
                                          side_effect=AssertionError("local answers must not be re-sent")), \
                        mock.patch.object(api, "_alive_pids", return_value=set()), \
                        mock.patch.object(api, "_bin_available", return_value=True), \
                        mock.patch.object(api.rules, "wrap") as wrap, \
                        mock.patch.object(api.Handler, "_save_registry") as save, \
                        mock.patch.object(api.urllib.request, "urlopen") as open_call, \
                        mock.patch("subprocess.Popen") as spawn:
                    handler.do_followup()
                self.assertEqual(handler.response[0], 409)
                self.assertFalse(handler.response[1]["ok"])
                self.assertEqual(handler.response[1]["nextAction"], "local_chat")
                self.assertIn("本機問答只回答", handler.response[1]["error"])
                for stub in (wrap, save, open_call, spawn):
                    stub.assert_not_called()
                # The record keeps its target and gains no queued text: the
                # frontend only clears the box on ok, so the user can resend.
                self.assertEqual(api.Handler.DISPATCHES[0], dict(record))

    def test_failed_pending_followup_is_restored_before_later_messages(self):
        record = {"id": "done", "tool": "qwen", "pending": ["first"], "pid": None}
        api.Handler.DISPATCHES = [record]
        handler = FakeHandler()
        with mock.patch.object(api.Handler, "_send_followup", return_value={"error": "not ready"}), \
                mock.patch.object(api.Handler, "_save_registry"):
            handler._flush_pending([{"id": "done", "alive": False, "pending": ["first"]}])
        self.assertEqual(record["pending"], ["first"])

    def test_setup_exposes_the_same_no_ai_contract_without_model_actions(self):
        manager = mock.Mock()
        manager.catalog.return_value = {"ok": True, "connections": []}
        handler = FakeHandler(path="/api/setup")
        with mock.patch.object(api, "_ai_connections", return_value=manager), \
                mock.patch.object(api.Handler, "_readiness_snapshot", return_value=NO_AI_SNAPSHOT), \
                mock.patch.object(api, "lms_models") as models:
            handler.do_GET()
        self.assertEqual(handler.response[0], 200)
        body = handler.response[1]
        self.assertIsNone(body["auto"])
        self.assertFalse(body["ready"])
        self.assertEqual(body["local"], NO_AI_SNAPSHOT["local"])
        models.assert_not_called()

    def test_skill_starters_are_lazy_same_origin_only(self):
        from skill_starters import starter_catalog
        catalog = starter_catalog()
        module = types.ModuleType("skill_starters")
        module.starter_catalog = mock.Mock(return_value=catalog)
        with mock.patch.dict(sys.modules, {"skill_starters": module}):
            good = FakeHandler(path="/api/skills/starters")
            good.do_GET()
            self.assertEqual(good.response, (200, catalog))
            module.starter_catalog.assert_called_once_with()
            blocked = FakeHandler(path="/api/skills/starters", same_origin=False)
            blocked.do_GET()
            module.starter_catalog.assert_called_once_with()
        self.assertEqual(blocked.response[0], 403)

    def test_refresh_uses_bundle_safe_utf8_arguments(self):
        args = api.refresh_arguments({})
        self.assertEqual(args[:4], [sys.executable, "-B", "-X", "utf8"])
        self.assertEqual(args[4:], [str(api.INDEXER), "--rescan"])

    def test_local_readiness_exposes_loaded_model_keys_not_instance_aliases(self):
        lms = self.tmp / "lms.exe"
        gate = self.tmp / "local_gate.py"
        lms.write_text("fixture", encoding="utf-8")
        gate.write_text("fixture", encoding="utf-8")
        record = {"modelKey": "qwen/qwen3.5-4b", "sizeBytes": 3 * 1024 ** 3}
        identifier = api._owned_identifier(record["modelKey"])
        loaded = [{"modelKey": record["modelKey"], "identifier": identifier}]
        api._remember_owned_lms_instance(record["modelKey"], identifier)
        with mock.patch.object(api, "LMS_BIN", lms), \
                mock.patch.object(api, "LOCAL_GATE", gate), \
                mock.patch.object(api, "lms_installed_model_records", return_value=[record]), \
                mock.patch.object(api, "_lms_ps_strict", return_value=loaded), \
                mock.patch.object(api, "_lms_cpu_runtime_status", return_value=(True, "cpu")), \
                mock.patch.object(api, "_passive_cpu_runtime_metadata", return_value={
                    "id": api.LMS_RUNTIME, "installed": True, "selected": False, "verified": True}):
            facts = api.local_runtime_readiness()
        self.assertEqual(facts["state"], rr.STATE_READY)
        self.assertEqual(facts["loaded"], [record["modelKey"]])
        self.assertNotIn(identifier, facts["loaded"])

    def test_skill_inventory_and_preview_report_actual_cli_presence_separately(self):
        package = {"name": "starter", "folder": "starter", "digest": "0" * 64}
        with mock.patch.object(api, "_bin_available", side_effect=lambda tool: tool == "codex"):
            inventory = api._installed_skill_inventory(self.tmp)
            preview = api._skill_target_states(package, self.tmp)
        targets = {row["id"]: row for row in inventory["targets"]}
        states = {row["id"]: row for row in preview}
        self.assertTrue(targets["codex"]["toolInstalled"])
        self.assertFalse(targets["qwen"]["toolInstalled"])
        self.assertTrue(states["codex"]["toolInstalled"])
        self.assertFalse(states["qwen"]["toolInstalled"])
        self.assertTrue(targets["qwen"]["available"], "filesystem safety is independent of CLI presence")

    def test_gate_authority_never_falls_back_from_configured_invalid_value(self):
        portable = self.tmp / "console_local_gate.py"
        portable.write_text("fixture", encoding="utf-8")
        for value in (None, "", "relative-gate.py", str(self.tmp)):
            with self.subTest(value=value), \
                    mock.patch.object(api, "_CFG", {"local_gate": value}), \
                    mock.patch.object(api, "_CFG_LOAD_ERROR", ""), \
                    mock.patch.object(api, "PORTABLE_LOCAL_GATE", portable):
                spec = api._gate_spec()
            self.assertEqual(spec["kind"], "configured")
            self.assertFalse(spec["ready"])
            self.assertEqual(spec["code"], "CONFIGURED_GATE_UNAVAILABLE")

    def test_absent_machine_gate_uses_portable_but_existing_bad_machine_blocks(self):
        portable = self.tmp / "console_local_gate.py"
        portable.write_text("fixture", encoding="utf-8")
        machine = self.tmp / "machine-gate.py"
        with mock.patch.object(api, "_CFG", {}), mock.patch.object(api, "_CFG_LOAD_ERROR", ""), \
                mock.patch.object(api, "_DEFAULT_MACHINE_GATE", machine), \
                mock.patch.object(api, "LOCAL_GATE", machine), \
                mock.patch.object(api, "PORTABLE_LOCAL_GATE", portable):
            self.assertEqual(api._gate_spec()["kind"], "portable")
            machine.mkdir()
            bad = api._gate_spec()
        self.assertEqual(bad["kind"], "machine")
        self.assertFalse(bad["ready"])

    def test_get_readiness_never_executes_the_gate(self):
        lms = self.tmp / "lms.exe"
        gate_file = self.tmp / "gate.py"
        lms.write_text("fixture", encoding="utf-8")
        gate_file.write_text("fixture", encoding="utf-8")
        record = {"modelKey": "qwen/qwen3.5-4b", "sizeBytes": 3 * 1024 ** 3}
        with mock.patch.object(api, "_CFG", {}), mock.patch.object(api, "_CFG_LOAD_ERROR", ""), \
                mock.patch.object(api, "LMS_BIN", lms), mock.patch.object(api, "LOCAL_GATE", gate_file), \
                mock.patch.object(api, "_DEFAULT_MACHINE_GATE", Path("C:/missing-machine-gate.py")), \
                mock.patch.object(api, "lms_installed_model_records", return_value=[record]), \
                mock.patch.object(api, "_lms_ps_strict", return_value=[]), \
                mock.patch.object(api, "cold_load_admission", return_value={"admitted": True}), \
                mock.patch.object(api, "_passive_cpu_runtime_metadata", return_value={
                    "id": api.LMS_RUNTIME, "installed": True, "selected": False, "verified": True}), \
                mock.patch.object(api, "_run_gate") as run_gate:
            facts = api.local_runtime_readiness()
        self.assertEqual(facts["state"], rr.STATE_NEEDS_START)
        run_gate.assert_not_called()

    def test_legacy_gate_keeps_pre_and_post_argv_with_utf8_flags(self):
        gate_file = self.tmp / "legacy_gate.py"
        gate_file.write_text("fixture", encoding="utf-8")
        calls = []
        def runner(argv, **kwargs):
            calls.append(argv)
            return __import__("subprocess").CompletedProcess(argv, 1, "裁決：GPU1_OK\n", "")
        with mock.patch.object(api, "_CFG", {"local_gate": str(gate_file)}), \
                mock.patch.object(api, "_CFG_LOAD_ERROR", ""), \
                mock.patch.object(api, "_run", side_effect=runner):
            self.assertTrue(api._run_gate(phase="pre")[0])
            self.assertTrue(api._run_gate("--post-load-identifier", "owned", phase="reuse", model_key="model")[0])
        prefix = [sys.executable, "-B", "-X", "utf8", str(gate_file)]
        self.assertEqual(calls[0], prefix)
        self.assertEqual(calls[1], prefix + ["--post-load-identifier", "owned"])

    def _legacy_verdict(self, stdout, rc, stderr=""):
        """Configured legacy gate with a canned process; never touches LM Studio."""
        spec = {"ready": True, "kind": "configured", "path": self.tmp / "legacy_gate.py",
                "code": "", "reason": ""}
        proc = subprocess.CompletedProcess(["gate"], rc, stdout, stderr)
        with mock.patch.object(api, "_gate_spec", return_value=spec), \
                mock.patch.object(api, "_run", return_value=proc):
            return api._gate_result()

    def test_legacy_gate_authorizes_only_one_clean_verdict_matching_its_exit_code(self):
        allowed = [
            ("裁決：CPU_ONLY\n", 0),
            ("裁決：GPU1_OK\n", 1),
            ("裁決：CPU_ONLY\n理由：顯卡忙碌中\n建議指令：lms ps\n", 0),
            ('{"verdict": "CPU_ONLY"}', 0),
            ('{"verdict": "GPU1_OK", "reason": "idle"}', 1),
        ]
        denied = [
            ("裁決：BLOCKED\n", 2), ('{"verdict": "BLOCKED"}', 2),
            ("", 0), ("", 1), ("   \n", 0),
            ("", 1, "裁決：GPU1_OK\n"), ("", 0, "裁決：CPU_ONLY\n"),
            ("裁決：GPU1_OK\n", 1, "Traceback (most recent call last):\nRuntimeError: leak\n"),
            ("裁決：CPU_ONLY\nTraceback (most recent call last):\nValueError: leak\n", 0),
            ("裁決：CPU_ONLY\n", 1), ("裁決：GPU1_OK\n", 0), ("裁決：BLOCKED\n", 0),
            ("裁決：CPU_ONLY\n", 3), ("裁決：GPU1_OK\n", -1), ("裁決：CPU_ONLY\n", "0"),
            ("裁決：CPU_ONLY\n裁決：CPU_ONLY\n", 0),
            ("裁決：CPU_ONLY\n裁決：GPU1_OK\n", 0),
            ("本次裁決：GPU1_OK 沒問題\n", 1), ("允許 GPU1_OK\n", 1), ("OK\n", 0),
            ('{"verdict": "CPU_ONLY"', 0), ('{"verdict": "ALLOW"}', 0),
            ('{"verdict": "CPU_ONLY", "verdict": "BLOCKED"}', 0),
            ('{"verdict": "CPU_ONLY", "decision": "GPU1_OK"}', 0),
            ('{"verdict": "CPU_ONLY", "blocked": true}', 0),
            ('{"verdict": 0}', 0), ('["CPU_ONLY"]', 0), ('"CPU_ONLY"', 0),
            ("裁決：CPU_ONLY\n" + "詳細" * 5000, 0),
            (None, 0), (b"\xe8\xa3\x81", 0), ({"verdict": "CPU_ONLY"}, 0),
        ]
        for case in allowed:
            with self.subTest(allow=case):
                self.assertTrue(self._legacy_verdict(*case)["ok"])
        for case in denied:
            with self.subTest(deny=case):
                got = self._legacy_verdict(*case)
                self.assertFalse(got["ok"])
                self.assertIn(got["reason"], ("地端安全把關擋下這次操作。", "地端安全把關回應無法確認。"))
                self.assertNotIn("Traceback", got["reason"])

    def test_real_raising_legacy_gate_is_denied_even_after_printing_a_verdict(self):
        for name, body in (("raiser.py", "raise RuntimeError('synthetic')\n"),
                           ("printer.py", "print('裁決：GPU1_OK')\nraise RuntimeError('synthetic')\n")):
            gate_file = self.tmp / name
            gate_file.write_text(body, encoding="utf-8")
            spec = {"ready": True, "kind": "configured", "path": gate_file, "code": "", "reason": ""}
            with self.subTest(fixture=name), mock.patch.object(api, "_gate_spec", return_value=spec):
                result = api._gate_result()
                allowed, note = api._run_gate()
                self.assertFalse(result["ok"])
                self.assertFalse(allowed)
                self.assertEqual(result["code"], "LEGACY_GATE_INVALID_RESPONSE")
                self.assertNotIn("synthetic", note)
                self.assertNotIn("synthetic", str(result))


if __name__ == "__main__":
    unittest.main()
