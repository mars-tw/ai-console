"""Portable regressions with synthetic state; no real AI or dispatch calls."""
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api
import ai_connections


class VerificationEpochTests(unittest.TestCase):
    def manager(self, transport):
        with mock.patch.object(ai_connections.AIConnections, '_load'):
            manager = ai_connections.AIConnections(config_path=Path('fixture'), env={}, transport=transport)
        item = {'id': 'one', 'type': 'openai-compatible', 'label': 'test',
                'baseUrl': 'http://127.0.0.1:1/v1', 'model': 'm', 'apiKeyEnv': ''}
        manager._connections = {'one': dict(item)}
        return manager, item

    def test_old_failure_does_not_clear_newer_success(self):
        entered, release = threading.Event(), threading.Event()
        def transport(*_):
            if threading.current_thread().name == 'old':
                entered.set(); release.wait(2)
                return 401, {}
            return 200, {'choices': [{'message': {'content': 'fixture'}}]}
        manager, _ = self.manager(transport)
        worker = threading.Thread(target=lambda: manager.test({'id': 'one'}), name='old')
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertEqual(manager.test({'id': 'one'})['status'], 'reply_verified')
        finally:
            release.set(); worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(manager.catalog()['connections'][0]['status'], 'reply_verified')

    def test_old_success_does_not_override_newer_failure(self):
        entered, release = threading.Event(), threading.Event()
        def transport(*_):
            if threading.current_thread().name == 'old':
                entered.set(); release.wait(2)
                return 200, {'choices': [{'message': {'content': 'fixture'}}]}
            return 401, {}
        manager, _ = self.manager(transport)
        results = []
        worker = threading.Thread(target=lambda: results.append(manager.test({'id': 'one'})), name='old')
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertEqual(manager.test({'id': 'one'})['status'], 'authentication_failed')
        finally:
            release.set(); worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0]['status'], 'stale_result')
        self.assertFalse(results[0]['ok'])
        self.assertNotIn('content', results[0])
        self.assertEqual(manager.catalog()['connections'][0]['status'], 'saved')

    def test_deleted_then_recreated_identical_connection_rejects_old_success(self):
        entered, release = threading.Event(), threading.Event()
        def transport(*_):
            entered.set(); release.wait(2)
            return 200, {'choices': [{'message': {'content': 'fixture'}}]}
        manager, item = self.manager(transport)
        results = []
        worker = threading.Thread(target=lambda: results.append(manager.test({'id': 'one'})))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            with mock.patch.object(manager, '_persist'):
                self.assertTrue(manager.delete({'id': 'one'})['ok'])
                self.assertTrue(manager.save(item)['ok'])
        finally:
            release.set(); worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0]['status'], 'stale_result')
        self.assertFalse(results[0]['ok'])
        self.assertNotIn('content', results[0])
        self.assertEqual(manager.catalog()['connections'][0]['status'], 'saved')

    def test_stale_chat_success_does_not_expose_content_or_mark_new_identity_verified(self):
        entered, release = threading.Event(), threading.Event()
        def transport(*_):
            entered.set(); release.wait(2)
            return 200, {'choices': [{'message': {'content': 'private fixture reply'}}]}
        manager, item = self.manager(transport)
        results = []
        worker = threading.Thread(target=lambda: results.append(manager.chat({
            'id': 'one', 'messages': [{'role': 'user', 'content': 'fixture'}]})))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            with mock.patch.object(manager, '_persist'):
                self.assertTrue(manager.delete({'id': 'one'})['ok'])
                self.assertTrue(manager.save(item)['ok'])
        finally:
            release.set(); worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0]['status'], 'stale_result')
        self.assertFalse(results[0]['ok'])
        self.assertNotIn('content', results[0])
        self.assertNotIn('private fixture reply', str(results[0]))
        self.assertEqual(manager.catalog()['connections'][0]['status'], 'saved')

    def test_overlapping_chat_results_do_not_overwrite_newer_test(self):
        for old_ok, new_ok in ((True, True), (True, False), (False, True)):
            with self.subTest(old_ok=old_ok, new_ok=new_ok):
                entered, release = threading.Event(), threading.Event()
                def transport(*_):
                    if threading.current_thread().name == 'old-chat':
                        entered.set(); release.wait(2)
                        success = old_ok
                    else:
                        success = new_ok
                    return ((200, {'choices': [{'message': {'content': 'fixture'}}]})
                            if success else (401, {}))
                manager, _ = self.manager(transport)
                results = []
                worker = threading.Thread(name='old-chat', target=lambda: results.append(manager.chat({
                    'id': 'one', 'messages': [{'role': 'user', 'content': 'fixture'}]})))
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    latest = manager.test({'id': 'one'})
                    self.assertEqual(latest['ok'], new_ok)
                finally:
                    release.set(); worker.join(3)
                self.assertFalse(worker.is_alive())
                if old_ok:
                    self.assertEqual(results[0]['status'], 'stale_result')
                    self.assertNotIn('content', results[0])
                else:
                    self.assertFalse(results[0]['ok'])
                self.assertEqual(manager.catalog()['connections'][0]['status'],
                                 'reply_verified' if new_ok else 'saved')


class StaticValidatorTests(unittest.TestCase):
    def test_etag_precedence_subsecond_change_and_304_without_body_read(self):
        h = api.Handler.__new__(api.Handler)
        h.path, h.headers, h.wfile = '/', {}, io.BytesIO()
        h.send_response, h.send_header, h.end_headers, h._json = (mock.Mock() for _ in range(4))
        content = mock.MagicMock()
        content.__enter__.return_value = content
        content.fileno.return_value = 1
        content.read.side_effect = [b'aaaa', b'bbbb']
        first = SimpleNamespace(st_mtime=100.01, st_mtime_ns=100_010_000_000, st_size=4)
        second = SimpleNamespace(st_mtime=100.02, st_mtime_ns=100_020_000_000, st_size=4)
        with mock.patch.object(api, 'DIST_DIR', Path('fixture')), \
             mock.patch.object(Path, 'is_file', return_value=True), \
             mock.patch.object(Path, 'open', return_value=content), \
             mock.patch.object(api.os, 'fstat', side_effect=[first, second, second]):
            h._static()
            headers = dict(call.args for call in h.send_header.call_args_list)
            h.headers = {'If-None-Match': headers['ETag'], 'If-Modified-Since': headers['Last-Modified']}
            h.wfile = io.BytesIO()
            h._static()
            self.assertEqual(h.send_response.call_args.args[0], 200)
            self.assertEqual(h.wfile.getvalue(), b'bbbb')
            h.headers = {'If-None-Match': [c.args[1] for c in h.send_header.call_args_list if c.args[0] == 'ETag'][-1]}
            h._static()
        self.assertEqual(h.send_response.call_args.args[0], 304)
        self.assertEqual(content.read.call_count, 2)


class HealthIdentityTests(unittest.TestCase):
    def test_matching_identity_and_mismatch(self):
        identity = {'service': 'ai-console', 'version': 'fixture', 'appRootHash': 'root', 'serverCodeSha256': 'code'}
        def response(data):
            context = mock.MagicMock()
            context.__enter__.return_value.status = 200
            context.__enter__.return_value.read.return_value = json.dumps(data).encode()
            return context
        with mock.patch.object(api, '_HEALTH_IDENTITY', identity), \
             mock.patch.object(api.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = response({'ok': True, **identity})
            self.assertEqual(api._existing_server_status(), 'same')
        for data in ({'ok': True}, {'ok': True, **identity, 'appRootHash': 'different'}):
            with self.subTest(data=data), mock.patch.object(api, '_HEALTH_IDENTITY', identity), \
                 mock.patch.object(api.urllib.request, 'build_opener') as build:
                build.return_value.open.return_value = response(data)
                self.assertEqual(api._existing_server_status(), 'unknown')

    def test_refusal_is_absent_but_timeout_is_unknown(self):
        with mock.patch.object(api.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = api.urllib.error.URLError(ConnectionRefusedError())
            self.assertEqual(api._existing_server_status(), 'absent')
        with mock.patch.object(api.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = TimeoutError()
            self.assertEqual(api._existing_server_status(), 'unknown')

    def test_loopback_probe_bypasses_proxies_and_allows_delayed_windows_refusal(self):
        def windows_refusal(_url, *, timeout):
            # WSAECONNREFUSED has been observed after ~2.05 seconds on Windows.
            if timeout <= 2.1:
                raise api.urllib.error.URLError(TimeoutError())
            raise api.urllib.error.URLError(ConnectionRefusedError())

        with mock.patch.object(api.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = windows_refusal
            self.assertEqual(api._existing_server_status(), 'absent')
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertLessEqual(build.return_value.open.call_args.kwargs['timeout'], 5)


class RemoteRejectTests(unittest.TestCase):
    def test_small_rejected_body_is_drained_with_deadline(self):
        h = api.RemoteHandler.__new__(api.RemoteHandler)
        h.command, h.headers, h.rfile = 'POST', {'Content-Length': '2'}, io.BytesIO(b'{}')
        h.connection, h._json = mock.Mock(), mock.Mock()
        h.connection.gettimeout.return_value = None
        h._remote_reject({'ok': False}, 403)
        self.assertEqual(h.rfile.tell(), 2)
        self.assertTrue(h.close_connection)
        self.assertEqual(h.connection.settimeout.call_args_list, [mock.call(0.5), mock.call(None)])
        h._json.assert_called_once_with({'ok': False}, 403)

    def test_oversize_or_ambiguous_framing_is_not_drained(self):
        for headers in ({'Content-Length': '4097'}, {'Content-Length': '2', 'Transfer-Encoding': 'chunked'},
                        {'Content-Length': 'invalid'}, {'Content-Length': '9' * 5000}):
            with self.subTest(headers=headers):
                h = api.RemoteHandler.__new__(api.RemoteHandler)
                h.command, h.headers, h.rfile = 'POST', headers, mock.Mock()
                h.connection, h._json = mock.Mock(), mock.Mock()
                h._remote_reject({'ok': False}, 403)
                h.rfile.read.assert_not_called()
                h._json.assert_called_once_with({'ok': False}, 403)

    def test_read_timeout_still_returns_rejection(self):
        h = api.RemoteHandler.__new__(api.RemoteHandler)
        h.command, h.headers, h.rfile = 'POST', {'Content-Length': '2'}, mock.Mock()
        h.rfile.read.side_effect = TimeoutError('fixture')
        h.connection, h._json = mock.Mock(), mock.Mock()
        h.connection.gettimeout.return_value = None
        h._remote_reject({'ok': False}, 401)
        h._json.assert_called_once_with({'ok': False}, 401)


class LegacyBoundaryTests(unittest.TestCase):
    def test_dispatches_exposes_pending_cancellation_as_unknown_including_old_records(self):
        h = api.Handler.__new__(api.Handler)
        older = {'id': 'old', 'cancelOrderPending': True, 'cancelled': 'fixture',
                 'task': 'do not expose', 'log': 'private path'}
        newest = {'id': 'new', 'cancelOrderPending': True, 'cancelled': 'fixture',
                  'mode': 'sync', 'log': '__absent_fixture__'}
        h.DISPATCHES = [older] + [{'id': f'fill-{i}', 'mode': 'sync',
                                  'log': '__absent_fixture__'} for i in range(30)] + [newest]
        h._json = lambda body, code=200: (code, body)
        with mock.patch.object(api, '_alive_pids', return_value=set()), \
             mock.patch.object(api, '_has_git', return_value=False), \
             mock.patch.object(api.Handler, '_flush_pending') as flush, \
             mock.patch.object(api.Handler, '_auto_handoff') as handoff:
            status, body = h.do_dispatches()
        self.assertEqual(status, 200)
        rows = {d['id']: d for d in body['dispatches']}
        self.assertEqual(rows['old'], {'id': 'old', 'state': 'unknown', 'cancelOrderPending': True})
        self.assertEqual(rows['new']['state'], 'unknown')
        self.assertTrue(rows['new']['cancelOrderPending'])
        self.assertNotIn('cancelled', rows['new'])
        flush.assert_not_called()
        handoff.assert_not_called()

    def test_legacy_409_drains_only_bounded_bytes_without_parsing_or_spawning(self):
        h = api.Handler.__new__(api.Handler)
        h.path, h.command, h.headers, h.rfile = '/api/dispatch', 'POST', {'Content-Length': '2'}, io.BytesIO(b'{}')
        h.connection = mock.Mock()
        h.connection.gettimeout.return_value = None
        h._same_origin = lambda: True
        h._json = lambda body, code=200: (code, body)
        h._body = mock.Mock(side_effect=AssertionError('must not parse'))
        with mock.patch.object(api.subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as spawn:
            status, body = h.do_POST()
        self.assertEqual((status, body['code']), (409, 'USE_CHATGPT_CONVERSATION'))
        self.assertEqual(h.rfile.tell(), 2)
        h._body.assert_not_called()
        spawn.assert_not_called()

    def test_legacy_execution_routes_return_409_without_read_or_worker(self):
        h = api.Handler.__new__(api.Handler)
        h._same_origin = lambda: True
        h._json = lambda body, code=200: (code, body)
        h._body = mock.Mock(side_effect=AssertionError('must not read or dispatch'))
        paths = ('/api/launch', '/api/schedule/save', '/api/schedule/run', '/api/dispatch',
                 '/api/dispatch/batch', '/api/dispatch/followup', '/api/dispatch/retry')
        with mock.patch.object(api.subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as spawn:
            for path in paths:
                with self.subTest(path=path):
                    h.path = path
                    status, body = h.do_POST()
                    self.assertEqual((status, body['code']), (409, 'USE_CHATGPT_CONVERSATION'))
        h._body.assert_not_called()
        spawn.assert_not_called()

    def test_legacy_dispatches_read_does_not_flush_or_handoff(self):
        h = api.Handler.__new__(api.Handler)
        h.DISPATCHES = [{'id': 'fixture', 'pid': None, 'log': '__absent_fixture__'}]
        h._json = lambda body, code=200: (code, body)
        with mock.patch.object(api, '_alive_pids', return_value=set()), \
             mock.patch.object(api, '_has_git', return_value=False), \
             mock.patch.object(api.Handler, '_dispatch_state', return_value='done'), \
             mock.patch.object(api.Handler, '_flush_pending', side_effect=AssertionError('must not flush')), \
             mock.patch.object(api.Handler, '_auto_handoff', side_effect=AssertionError('must not hand off')):
            status, body = h.do_dispatches()
        self.assertEqual(status, 200)
        self.assertEqual([row['id'] for row in body['dispatches']], ['fixture'])


if __name__ == '__main__':
    unittest.main()
