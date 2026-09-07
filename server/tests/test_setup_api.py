"""Setup integration is passive; writes require desktop same-origin requests."""
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api
from setup_catalog import setup_catalog


class FakeHandler(api.Handler):
    def __init__(self, path, body=None, origin='http://127.0.0.1:5177'):
        self.path = path
        self.payload = {} if body is None else body
        self.headers = {'Origin': origin} if origin else {}
        self.response = None

    def _body(self):
        return self.payload

    def _json(self, payload, code=200):
        self.response = code, payload
        return self.response


class SetupAPITest(unittest.TestCase):
    def test_missing_cli_is_shown_with_official_link_and_no_login_claim(self):
        catalog = setup_catalog(lambda tool: tool == 'qwen', [], [], tailscale_available=False)
        indexed = {tool['id']: tool for tool in catalog['tools']}
        self.assertTrue(indexed['qwen']['installed'])
        self.assertFalse(indexed['codex']['installed'])
        self.assertTrue(indexed['codex']['installUrl'].startswith('https://'))
        self.assertEqual(indexed['qwen']['authStatus'], 'unknown')
        self.assertFalse(catalog['local']['available'])

    def test_reading_setup_or_connections_requires_same_origin(self):
        for path in ('/api/setup', '/api/ai-connections'):
            for origin in ('https://example.com', None):
                handler = FakeHandler(path, origin=origin)
                with mock.patch.object(api, '_ai_connections') as manager:
                    handler.do_GET()
                self.assertEqual(handler.response[0], 403)
                manager.assert_not_called()

    def test_setup_is_passive_and_does_not_probe_or_test_models(self):
        manager = mock.Mock()
        manager.catalog.return_value = {'ok': True, 'connections': []}
        handler = FakeHandler('/api/setup')
        with mock.patch.object(api, '_ai_connections', return_value=manager), \
                mock.patch.object(api, 'lms_models', return_value=[]), \
                mock.patch.object(api, '_find_bin', return_value=''), \
                mock.patch.dict(api.BIN, api.BIN.copy()):
            handler.do_GET()
        self.assertEqual(handler.response[0], 200)
        manager.probe.assert_not_called()
        manager.test.assert_not_called()

    def test_only_declared_connection_action_runs(self):
        manager = mock.Mock()
        manager.probe.return_value = {'ok': True, 'models': ['demo']}
        handler = FakeHandler('/api/ai-connections/probe', {'baseUrl': 'http://localhost:9999/v1'})
        with mock.patch.object(api, '_ai_connections', return_value=manager):
            handler.do_POST()
        manager.probe.assert_called_once_with(handler.payload)
        manager.chat.assert_not_called()
        self.assertEqual(handler.response[1]['models'], ['demo'])

    def test_connection_errors_never_echo_private_exception(self):
        manager = mock.Mock()
        manager.probe.side_effect = RuntimeError('synthetic-private-value')
        handler = FakeHandler('/api/ai-connections/probe')
        with mock.patch.object(api, '_ai_connections', return_value=manager):
            handler.do_POST()
        self.assertEqual(handler.response[0], 503)
        self.assertNotIn('synthetic-private-value', str(handler.response))

    def test_connection_post_rejects_array_and_cross_origin_before_call(self):
        for handler in (FakeHandler('/api/ai-connections/probe', []),
                        FakeHandler('/api/ai-connections/save', origin='https://example.com')):
            with mock.patch.object(api, '_ai_connections') as manager:
                handler.do_POST()
            self.assertIn(handler.response[0], (400, 403))
            manager.assert_not_called()

    def test_manual_refresh_bypasses_cache_and_accepts_bounded_extra_roots(self):
        self.assertIn('--rescan', api.refresh_arguments({}))
        args = api.refresh_arguments({'deep': True, 'extraRoots': [str(Path.cwd())]})
        self.assertIn('--deep-scan', args)
        self.assertEqual(args[-2:], ['--scan-root', str(Path.cwd())])
        for payload in ([], {'deep': 'true'}, {'extraRoots': ['/']}, {'extraRoots': ['x'] * 9}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                api.refresh_arguments(payload)

    def test_parent_segments_cannot_hide_a_drive_root(self):
        anchor = Path.cwd().anchor
        disguised = str(Path(anchor) / 'Users' / '..')
        with self.assertRaises(ValueError):
            api.refresh_arguments({'extraRoots': [disguised]})

    def test_discovered_sources_cannot_launch_archive_or_delete(self):
        for entry in ({'tool': 'example', 'readOnly': True},
                      {'tool': 'claude', 'sourceKind': 'discovered'}):
            for path in ('/api/launch', '/api/conv/archive', '/api/conv/delete'):
                handler = FakeHandler(path, {'id': 'synthetic'})
                with mock.patch.object(api, 'find_conv', return_value=entry), \
                        mock.patch.object(api, 'build_launch') as launch, \
                        mock.patch.object(api, '_load_index_snapshot') as mutation:
                    handler.do_POST()
                self.assertEqual(handler.response[0], 409)
                launch.assert_not_called()
                mutation.assert_not_called()


if __name__ == '__main__':
    unittest.main()
