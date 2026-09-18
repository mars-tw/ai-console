"""The desktop bridge must never become an unauthenticated remote control."""
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api


class FakeHandler(api.Handler):
    def __init__(self, path, body=None, **headers):
        self.path = path
        self.payload = {} if body is None else body
        self.headers = {
            'Host': '127.0.0.1:5177', 'Origin': 'http://127.0.0.1:5177',
            'Content-Type': 'application/json', **headers,
        }
        self.response = None

    def _body(self):
        return self.payload

    def _json(self, obj, code=200):
        self.response = code, obj
        return self.response


class DevSpaceAPITest(unittest.TestCase):
    def test_status_is_passive(self):
        handler = FakeHandler('/api/devspace/status')
        manager = mock.Mock()
        manager.status.return_value = {'ok': True, 'installed': False}
        with mock.patch.object(api, '_devspace_console', return_value=manager):
            handler.do_GET()
        manager.status.assert_called_once_with()
        manager.start.assert_not_called()
        self.assertEqual(handler.response, (200, {'ok': True, 'installed': False}))

    def test_only_explicit_actions_are_exposed(self):
        for action, method in (('doctor', 'doctor'), ('start', 'start'), ('stop', 'stop'),
                               ('tasks', 'tasks'), ('run', 'run'), ('show', 'show'),
                               ('continue', 'continue_task')):
            with self.subTest(action=action):
                payload = {'cwd': 'synthetic', 'prompt': 'hello'}
                handler = FakeHandler('/api/devspace/' + action, payload)
                manager = mock.Mock()
                getattr(manager, method).return_value = {'ok': True}
                with mock.patch.object(api, '_devspace_console', return_value=manager):
                    handler.do_POST()
                getattr(manager, method).assert_called_once_with(payload)
                self.assertEqual(handler.response[0], 200)

    def test_missing_or_foreign_origin_and_rebinding_host_are_refused(self):
        for headers in ({'Origin': ''}, {'Origin': 'https://example.com'},
                        {'Host': 'attacker.example:5177'},
                        {'Origin': '', 'Referer': 'http://localhost:5177.attacker.example/'},
                        {'Origin': '', 'Referer': 'http://localhost:5177@attacker.example/'},
                        {'Origin': '', 'Referer': 'http://localhost:51770/'}):
            for path, method in (('/api/devspace/status', 'do_GET'), ('/api/devspace/run', 'do_POST')):
                with self.subTest(headers=headers, path=path):
                    handler = FakeHandler(path, **headers)
                    with mock.patch.object(api, '_devspace_console') as manager:
                        getattr(handler, method)()
                    self.assertEqual(handler.response[0], 403)
                    manager.assert_not_called()

    def test_same_origin_browser_get_with_referer_is_accepted(self):
        handler = FakeHandler('/api/devspace/status', Origin='', Referer='http://127.0.0.1:5177/?view=devspace')
        manager = mock.Mock()
        manager.status.return_value = {'ok': True}
        with mock.patch.object(api, '_devspace_console', return_value=manager):
            handler.do_GET()
        self.assertEqual(handler.response[0], 200)

    def test_non_json_or_invalid_body_is_rejected_before_service_call(self):
        for body, headers, expected in (([], {}, 400), ({}, {'Content-Type': 'text/plain'}, 415)):
            handler = FakeHandler('/api/devspace/run', body, **headers)
            with mock.patch.object(api, '_devspace_console') as manager:
                handler.do_POST()
            self.assertEqual(handler.response[0], expected)
            manager.assert_not_called()
        handler = FakeHandler('/api/devspace/run')
        handler._body_error = ('INVALID_JSON', 'bad', 400)
        with mock.patch.object(api, '_devspace_console') as manager:
            handler.do_POST()
        self.assertEqual(handler.response[0], 400)
        manager.assert_not_called()

    def test_unsupported_command_is_not_exposed(self):
        handler = FakeHandler('/api/devspace/bash', {'command': 'anything'})
        with mock.patch.object(api, '_devspace_console') as manager:
            handler.do_POST()
        self.assertEqual(handler.response[0], 404)
        manager.assert_not_called()

    def test_exception_never_echoes_private_values(self):
        handler = FakeHandler('/api/devspace/start')
        with mock.patch.object(api, '_devspace_console', side_effect=RuntimeError('synthetic-secret')):
            handler.do_POST()
        self.assertEqual(handler.response[0], 503)
        self.assertNotIn('synthetic-secret', str(handler.response))

    def test_remote_allowlist_never_exposes_devspace(self):
        for path in api.REMOTE_ALLOWED_GET | api.REMOTE_ALLOWED_POST:
            self.assertFalse(path.startswith('/api/devspace'))


if __name__ == '__main__':
    unittest.main()
