"""Connection lifecycle and credential boundaries using only a loopback fixture."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_connections as ac  # noqa: E402


FAKE_KEY = "fixture-secret-not-a-real-key"


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self._respond(None)

    def do_POST(self):
        self._respond(json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0")))))

    def _respond(self, body):
        server = self.server
        server.requests.append((self.command, self.path, dict(self.headers), body))
        response_body = server.models if self.command == "GET" else server.reply
        raw = response_body if isinstance(response_body, bytes) else json.dumps(response_body).encode()
        self.send_response(server.response_status)
        self.send_header("Content-Type", "application/json")
        if server.redirect:
            self.send_header("Location", server.redirect)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            if server.drip:
                for byte in raw:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.03)
            else:
                self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class ConnectionsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ac-connections-test-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "connections.json"
        self.env = {}
        self.connections = ac.AIConnections(self.path, env=self.env)
        self.server.requests = []
        self.server.models = {"data": [{"id": "fixture-model"}, {"id": "fixture-other"}]}
        self.server.reply = {"choices": [{"message": {"role": "assistant", "content": "Hello from the isolated fixture."}}]}
        self.server.response_status = 200
        self.server.redirect = ""
        self.server.drip = False

    def draft(self, **overrides):
        return {"id": "fixture", "label": "Fixture", "baseUrl": self.base,
                "model": "fixture-model", **overrides}

    def save(self, **overrides):
        result = self.connections.save(self.draft(**overrides))
        self.assertTrue(result["ok"], result)
        return result["connection"]

    def assert_no_secret(self, value):
        self.assertNotIn(FAKE_KEY, json.dumps(value))

    def test_catalog_never_calls_network_or_reads_auth_files(self):
        with mock.patch.object(self.connections, "_transport", side_effect=AssertionError("network")), mock.patch.object(Path, "open", side_effect=AssertionError("disk")):
            result = self.connections.catalog({"codex": True, "claude": False, "arbitrary-shell": True})
        self.assertTrue(result["ok"])
        tools = {item["id"]: item for item in result["cli"]}
        self.assertEqual(tools["codex"]["status"], "installed_unverified")
        self.assertFalse(tools["claude"]["available"])
        self.assertNotIn("arbitrary-shell", tools)
        self.assertFalse(self.server.requests)

    def test_probe_lists_models_without_inference_or_save(self):
        result = self.connections.probe(self.draft(model=""))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "models_available")
        self.assertEqual(result["models"], ["fixture-model", "fixture-other"])
        self.assertEqual([(r[0], r[1]) for r in self.server.requests], [("GET", "/v1/models")])
        self.assertFalse(self.path.exists())
        self.assertEqual(self.connections.catalog()["connections"], [])

    def test_memory_key_never_persisted_or_returned_and_restart_loses_it(self):
        connection = self.save(apiKey=FAKE_KEY, unrelated="ignored")
        self.assertEqual(connection["credentialStatus"], "memory")
        self.assertTrue(connection["hasKey"])
        self.assert_no_secret(connection)
        self.assert_no_secret(self.connections.catalog())
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn(FAKE_KEY, raw)
        self.assertNotIn('"apiKey"', raw)
        self.assertNotIn('"unrelated"', raw)
        restarted = ac.AIConnections(self.path, env={})
        self.assertFalse(restarted.catalog()["connections"][0]["hasKey"])
        self.assertEqual(restarted.catalog()["connections"][0]["status"], "saved")

    def test_environment_reference_persists_but_value_does_not(self):
        self.env["FIXTURE_API_KEY"] = FAKE_KEY
        connection = self.save(apiKeyEnv="FIXTURE_API_KEY")
        self.assertEqual(connection["credentialStatus"], "environment")
        self.assertIn("FIXTURE_API_KEY", self.path.read_text(encoding="utf-8"))
        self.assertNotIn(FAKE_KEY, self.path.read_text(encoding="utf-8"))
        self.assertTrue(self.connections.test({"id": "fixture"})["ok"])
        self.assertEqual(self.server.requests[-1][2]["Authorization"], "Bearer " + FAKE_KEY)

    def test_missing_env_key_has_actionable_failure_and_no_request(self):
        self.save(apiKeyEnv="MISSING_FIXTURE_KEY")
        result = self.connections.test({"id": "fixture"})
        self.assertEqual(result["status"], "missing_key")
        self.assertTrue(result["nextAction"])
        self.assertFalse(self.server.requests)

    def test_transient_probe_key_is_not_remembered(self):
        result = self.connections.probe(self.draft(apiKey=FAKE_KEY))
        self.assertTrue(result["ok"])
        self.assert_no_secret(result)
        self.assertEqual(self.server.requests[-1][2]["Authorization"], "Bearer " + FAKE_KEY)
        self.save()
        self.connections.test({"id": "fixture"})
        self.assertNotIn("Authorization", self.server.requests[-1][2])

    def test_test_requires_actual_answer_and_bounded_request(self):
        self.save()
        result = self.connections.test({"id": "fixture"})
        self.assertEqual(result["status"], "reply_verified")
        self.assertEqual(self.server.requests[-1][1], "/v1/chat/completions")
        body = self.server.requests[-1][3]
        self.assertEqual(body["max_tokens"], 32)
        self.assertFalse(body["stream"])
        self.assertNotIn("tools", body)
        self.assertEqual(self.connections.catalog()["connections"][0]["verifiedModel"], "fixture-model")
        self.assertNotIn("reply_verified", self.path.read_text(encoding="utf-8"))

    def test_reasoning_only_does_not_verify_and_clears_previous_badge(self):
        self.save()
        self.assertTrue(self.connections.test({"id": "fixture"})["ok"])
        self.server.reply = {"choices": [{"message": {"content": "  ", "reasoning_content": "Thinking only"}}]}
        result = self.connections.test({"id": "fixture"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "reasoning_only")
        self.assertTrue(result["nextAction"])
        self.assertEqual(self.connections.catalog()["connections"][0]["status"], "saved")

    def test_empty_reply_and_tool_requests_are_not_success(self):
        self.save()
        for message, expected in (({"content": ""}, "empty_reply"),
                                  ({"content": "Try a tool", "tool_calls": [{"function": {"name": "danger"}}]}, "unsupported_tools")):
            with self.subTest(expected=expected):
                self.server.reply = {"choices": [{"message": message}]}
                result = self.connections.test({"id": "fixture"})
                self.assertFalse(result["ok"])
                self.assertEqual(result["status"], expected)

    def test_chat_forwards_only_text_messages_with_bounded_tokens(self):
        self.save()
        result = self.connections.chat({"id": "fixture", "model": "fixture-other", "tools": [{"name": "shell"}],
                                        "max_tokens": 900000, "messages": [{"role": "user", "content": "Hi", "tool_call_id": "ignored"}]})
        self.assertTrue(result["ok"], result)
        body = self.server.requests[-1][3]
        self.assertEqual(body["model"], "fixture-other")
        self.assertEqual(body["max_tokens"], 512)
        self.assertEqual(body["messages"], [{"role": "user", "content": "Hi"}])
        self.assertNotIn("tools", body)

    def test_invalid_message_shapes_and_lengths_never_call_provider(self):
        self.save()
        for messages in ([], [{"role": "tool", "content": "x"}], [{"role": "user", "content": []}],
                         [{"role": "user", "content": "x"}] * 41, [{"role": "user", "content": "x" * 64001}]):
            self.assertFalse(self.connections.chat({"id": "fixture", "messages": messages})["ok"])
        self.assertFalse(self.server.requests)

    def test_echoed_key_is_scrubbed_from_answer_and_reasoning(self):
        self.save(apiKey=FAKE_KEY)
        self.server.reply = {"choices": [{"message": {"content": "Echo " + FAKE_KEY, "reasoning_content": FAKE_KEY}}]}
        result = self.connections.test({"id": "fixture"})
        self.assertTrue(result["ok"])
        self.assert_no_secret(result)

    def test_api_error_never_returns_echoed_key_or_provider_body(self):
        self.save(apiKey=FAKE_KEY)
        self.server.response_status = 401
        self.server.reply = {"error": {"message": FAKE_KEY}}
        result = self.connections.test({"id": "fixture"})
        self.assertEqual(result["status"], "authentication_failed")
        self.assert_no_secret(result)

    def test_redirect_is_never_followed(self):
        self.server.response_status = 302
        self.server.redirect = "http://169.254.169.254/latest/meta-data"
        result = self.connections.probe(self.draft(apiKey=FAKE_KEY))
        self.assertEqual(result["status"], "redirect_rejected")
        self.assertEqual(len(self.server.requests), 1)

    def test_errors_are_distinct_and_actionable(self):
        for status, expected in ((403, "authentication_failed"), (429, "rate_limited"), (500, "provider_error"), (503, "provider_error")):
            with self.subTest(status=status):
                self.server.response_status = status
                result = self.connections.probe(self.draft())
                self.assertEqual(result["status"], expected)
                self.assertFalse(result["ok"])
                self.assertTrue(result["error"])
                self.assertTrue(result["nextAction"])
                self.assertNotIn("manualModelAllowed", result)

    def test_probe_models_404_and_405_allow_manual_model(self):
        for status in (404, 405):
            with self.subTest(status=status):
                self.server.requests = []
                self.server.response_status = status
                result = self.connections.probe(self.draft())
                self.assertFalse(result["ok"])
                self.assertEqual(result["status"], "model_list_unavailable")
                self.assertEqual(result["models"], [])
                self.assertTrue(result["manualModelAllowed"])
                self.assertFalse(result["verified"])
                self.assertIn("手動", result["nextAction"])
                self.assertIn("儲存", result["nextAction"])
                self.assertEqual([(r[0], r[1]) for r in self.server.requests], [("GET", "/v1/models")])

    def test_chat_404_stays_not_supported_without_manual_model(self):
        self.save()
        self.server.response_status = 404
        result = self.connections.test({"id": "fixture"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "not_supported")
        self.assertNotIn("manualModelAllowed", result)

    def test_invalid_json_and_large_body_are_rejected(self):
        self.server.models = b"not-json"
        self.assertEqual(self.connections.probe(self.draft())["status"], "invalid_response")
        self.server.models = b"x" * (ac.MAX_RESPONSE_BYTES + 1)
        self.assertEqual(self.connections.probe(self.draft())["status"], "response_too_large")

    def test_slow_drip_response_obeys_overall_deadline(self):
        self.server.drip = True
        before = time.monotonic()
        with mock.patch.object(ac, "REQUEST_TIMEOUT", 0.15):
            result = self.connections.probe(self.draft())
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "timeout")
        self.assertLess(time.monotonic() - before, 2)

    def test_model_list_excludes_invalid_duplicate_and_secret_ids(self):
        self.server.models = {"data": [{"id": "a"}, {"id": "a"}, {"id": FAKE_KEY}, {"id": "bad\n"}, {"id": 2}, None]}
        result = self.connections.probe(self.draft(apiKey=FAKE_KEY))
        self.assertEqual(result["models"], ["a"])
        self.assert_no_secret(result)

    def test_empty_and_malformed_model_lists_are_distinct(self):
        for body, expected in (({"data": []}, "no_models"), ({"models": []}, "invalid_response")):
            self.server.models = body
            self.assertEqual(self.connections.probe(self.draft())["status"], expected)

    def test_endpoint_change_cannot_reuse_remembered_key(self):
        self.save(apiKey=FAKE_KEY)
        before = self.path.read_bytes()
        result = self.connections.save(self.draft(baseUrl=self.base + "/changed"))
        self.assertEqual(result["status"], "endpoint_change_requires_new_connection")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(self.connections.catalog()["connections"][0]["hasKey"])
        self.assertFalse(self.server.requests)

    def test_draft_cannot_borrow_key_by_saved_id(self):
        self.save(apiKey=FAKE_KEY)
        result = self.connections.probe(self.draft(baseUrl=self.base + "/changed"))
        self.assertEqual(result["status"], "endpoint_change_requires_new_connection")
        self.assertFalse(self.server.requests)

    def test_environment_key_does_not_follow_edited_endpoint_in_probe_or_save(self):
        self.env["FIXTURE_API_KEY"] = FAKE_KEY
        self.save(apiKeyEnv="FIXTURE_API_KEY")
        before = self.path.read_bytes()
        for endpoint in (self.base + "/other-service", "https://other-provider.example.com/v1"):
            for operation in (self.connections.probe, self.connections.save):
                with self.subTest(endpoint=endpoint, operation=operation.__name__):
                    with mock.patch.object(self.connections, "_transport", side_effect=AssertionError("Changed endpoint must not be contacted")) as transport:
                        result = operation(self.draft(baseUrl=endpoint, apiKeyEnv="FIXTURE_API_KEY"))
                        transport.assert_not_called()
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["status"], "endpoint_change_requires_new_connection")
                    self.assertIn("新增另一個 AI", result["nextAction"])
                    self.assert_no_secret(result)
                    self.assertEqual(self.path.read_bytes(), before)
                    self.assertFalse(self.server.requests)

    def test_even_new_transient_key_requires_new_connection_for_changed_endpoint(self):
        self.save(apiKey=FAKE_KEY)
        changed = self.draft(baseUrl=self.base + "/another", apiKey="separate-fixture-key")
        self.assertEqual(self.connections.probe(changed)["status"], "endpoint_change_requires_new_connection")
        self.assertEqual(self.connections.save(changed)["status"], "endpoint_change_requires_new_connection")
        self.assertFalse(self.server.requests)

    def test_new_connection_can_explicitly_set_its_own_environment_reference(self):
        self.env["FIXTURE_API_KEY"] = FAKE_KEY
        self.save(apiKeyEnv="FIXTURE_API_KEY")
        new = self.draft(id="new-fixture", label="New service", baseUrl=self.base + "/new-service", apiKeyEnv="FIXTURE_API_KEY")
        self.assertTrue(self.connections.probe(new)["ok"])
        self.assertEqual(self.server.requests[-1][1], "/new-service/v1/models")
        self.assertEqual(self.server.requests[-1][2]["Authorization"], "Bearer " + FAKE_KEY)
        self.assertTrue(self.connections.save(new)["ok"])
        self.assertEqual(len(self.connections.catalog()["connections"]), 2)
        self.assertNotIn(FAKE_KEY, self.path.read_text(encoding="utf-8"))

    def test_full_real_loopback_http_connection_lifecycle_keeps_key_memory_only(self):
        # No injected transport: exercise HTTP request construction, real sockets,
        # provider replies, and local persistence as one onboarding/chat flow.
        self.assertIs(self.connections._transport, ac.http_transport)
        draft = self.draft(apiKey=FAKE_KEY)
        probed = self.connections.probe(draft)
        self.assertEqual(probed["status"], "models_available")
        self.assertFalse(self.path.exists())
        saved = self.connections.save(draft)
        self.assertTrue(saved["ok"])
        self.assertEqual(saved["connection"]["credentialStatus"], "memory")
        self.assertEqual(saved["connection"]["status"], "saved")
        before = self.path.read_bytes()
        tested = self.connections.test({"id": "fixture", "model": probed["models"][0]})
        self.assertEqual(tested["status"], "reply_verified")
        chatted = self.connections.chat({"id": "fixture", "messages": [{"role": "user", "content": "Hello fixture"}]})
        self.assertEqual(chatted["status"], "reply_verified")
        self.assertEqual(chatted["content"], "Hello from the isolated fixture.")
        self.assertEqual([(row[0], row[1]) for row in self.server.requests], [
            ("GET", "/v1/models"), ("POST", "/v1/chat/completions"), ("POST", "/v1/chat/completions"),
        ])
        self.assertTrue(all(row[2].get("Authorization") == "Bearer " + FAKE_KEY for row in self.server.requests))
        self.assertEqual(self.server.requests[1][3]["max_tokens"], 32)
        self.assertEqual(self.server.requests[2][3]["max_tokens"], 512)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn(FAKE_KEY.encode(), before)
        self.assert_no_secret([probed, saved, tested, chatted, self.connections.catalog()])
        # A new server instance reuses only public config, never the old key or badge.
        restarted = ac.AIConnections(self.path, env={})
        connection = restarted.catalog()["connections"][0]
        self.assertFalse(connection["hasKey"])
        self.assertEqual(connection["status"], "saved")

    def test_same_endpoint_draft_can_probe_renamed_label_and_model_with_memory_key(self):
        self.save(apiKey=FAKE_KEY)
        result = self.connections.probe(self.draft(label="Renamed", model="fixture-other"))
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.server.requests[-1][2]["Authorization"], "Bearer " + FAKE_KEY)

    def test_testing_another_model_does_not_verify_configured_model(self):
        self.save()
        result = self.connections.test({"id": "fixture", "model": "fixture-other"})
        self.assertTrue(result["ok"], result)
        saved = self.connections.catalog()["connections"][0]
        self.assertEqual(saved["model"], "fixture-model")
        self.assertEqual(saved["verifiedModel"], "fixture-other")
        self.assertEqual(saved["status"], "saved")

    def test_renaming_retains_key_and_explicit_empty_key_clears_it(self):
        self.save(apiKey=FAKE_KEY)
        self.assertTrue(self.save(label="Renamed")["hasKey"])
        self.assertFalse(self.save(label="Renamed", apiKey="")["hasKey"])

    def test_delete_removes_key_and_config_and_survives_restart(self):
        self.save(apiKey=FAKE_KEY)
        self.assertTrue(self.connections.delete({"id": "fixture"})["ok"])
        self.assertEqual(ac.AIConnections(self.path, env={}).catalog()["connections"], [])
        self.assertEqual(self.connections.test({"id": "fixture"})["status"], "not_found")
        self.assertEqual(self.connections._keys, {})

    def test_atomic_replace_failure_preserves_existing_config_and_key(self):
        self.save(apiKey=FAKE_KEY)
        before = self.path.read_bytes()
        with mock.patch.object(ac.os, "replace", side_effect=OSError("fixture")):
            result = self.connections.save(self.draft(label="Changed", apiKey="replacement-fake-key"))
        self.assertEqual(result["status"], "save_failed")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.connections._keys["fixture"], FAKE_KEY)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_invalid_existing_file_is_not_silently_overwritten(self):
        self.path.write_text('{"bad":true}', encoding="utf-8")
        connections = ac.AIConnections(self.path, env={})
        self.assertFalse(connections.catalog()["ok"])
        result = connections.save(self.draft())
        self.assertEqual(result["status"], "config_unavailable")
        self.assertEqual(self.path.read_text(encoding="utf-8"), '{"bad":true}')

    def test_disk_config_containing_secret_field_is_rejected_without_exposure(self):
        self.path.write_text(json.dumps({"version": 1, "connections": [self.draft(apiKey=FAKE_KEY)]}), encoding="utf-8")
        result = ac.AIConnections(self.path, env={}).catalog()
        self.assertFalse(result["ok"])
        self.assert_no_secret(result)

    def test_credentials_cannot_be_saved_in_public_fields(self):
        for field in ("label", "model"):
            result = self.connections.save(self.draft(apiKey=FAKE_KEY, **{field: FAKE_KEY}))
            self.assertFalse(result["ok"])
            self.assert_no_secret(result)
        self.assertFalse(self.path.exists())

    def test_late_response_does_not_validate_replaced_connection(self):
        self.save()

        def transport(*args):
            self.save(label="Replaced")
            return 200, {"choices": [{"message": {"content": "A late response"}}]}

        self.connections._transport = transport
        self.assertTrue(self.connections.test({"id": "fixture"})["ok"])
        self.assertEqual(self.connections.catalog()["connections"][0]["status"], "saved")

    def test_invalid_configuration_inputs_are_structured_errors(self):
        for payload in (None, [], {"id": []}, self.draft(id="../bad"), self.draft(apiKeyEnv="A-B"),
                        self.draft(apiKey="key\r\nAuthorization: bad"), self.draft(type="shell"), self.draft(model="")):
            self.assertFalse(self.connections.save(payload)["ok"])
        self.assertFalse(self.server.requests)


class UrlBoundaryTest(unittest.TestCase):
    def test_normalizes_supported_bases_without_network(self):
        for raw, expected in (("https://api.example.com", "https://api.example.com/v1"),
                              ("https://api.example.com/v1/", "https://api.example.com/v1"),
                              ("https://api.example.com/service", "https://api.example.com/service/v1"),
                              ("https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"),
                              ("https://api.example.com/v2", "https://api.example.com/v2"),
                              ("http://localhost:11434", "http://localhost:11434/v1"),
                              ("http://[::1]:11434", "http://[::1]:11434/v1")):
            self.assertEqual(ac.normalize_base_url(raw), expected)

    def test_rejects_ambiguous_credential_private_and_metadata_urls(self):
        invalid = ("file:///etc/passwd", "http://example.com", "https://user:password@example.com", "https://example.com?key=secret",
                   "https://example.com#secret", "https://example.com/%2e%2e", "https://example.com/../bad", "https://example.com/\\evil",
                   "https://127.0.0.2", "https://169.254.169.254", "https://10.0.0.1", "https://192.168.1.1",
                   "https://[::ffff:127.0.0.1]", "https://0.0.0.0", "https://[fd00::1]", "https://host", "https://example.com:0",
                   "https://localhost.", "https://api..example.com", "https://example.com/a//b")
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ac.ConnectionError):
                ac.normalize_base_url(url)

    def test_lmstudio_port_is_always_routed_to_gated_builtin(self):
        for host in ("127.0.0.1", "localhost", "[::1]", "api.example.com"):
            with self.subTest(host=host), self.assertRaises(ac.ConnectionError) as caught:
                ac.normalize_base_url(f"https://{host}:1234/v1")
            self.assertEqual(caught.exception.status, "use_builtin_lmstudio")

    def test_public_dns_resolving_private_or_mixed_addresses_is_rejected(self):
        for ips in (("169.254.169.254",), ("10.0.0.5",), ("8.8.8.8", "127.0.0.1")):
            rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]
            with mock.patch.object(socket, "getaddrinfo", return_value=rows), self.assertRaises(ac.ConnectionError) as caught:
                ac._resolve_addresses("api.example.com", 443, 1)
            self.assertEqual(caught.exception.status, "unsafe_address")

    def test_localhost_uses_literal_loopback_without_dns(self):
        with mock.patch.object(socket, "getaddrinfo", side_effect=AssertionError("must not resolve localhost")):
            self.assertEqual(ac._resolve_addresses("localhost", 11434, 1), ["127.0.0.1"])

    def test_transport_pins_public_address_and_verifies_original_hostname(self):
        connection = ac._PinnedHTTPSConnection("api.example.com", 443, "8.8.8.8", 2)
        sock = mock.Mock()
        with mock.patch.object(socket, "create_connection", return_value=sock) as connect, mock.patch.object(connection._context, "wrap_socket") as wrap:
            connection.connect()
        connect.assert_called_once_with(("8.8.8.8", 443), 2)
        wrap.assert_called_once_with(sock, server_hostname="api.example.com")


if __name__ == "__main__":
    unittest.main()
