"""The distributed artifact must never include private runtime data."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    'release_audit', Path(__file__).resolve().parents[2] / 'scripts' / 'audit_release.py')
release_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_audit)


class ReleaseArtifactTests(unittest.TestCase):
    def test_private_paths_are_refused_in_both_package_prefixes(self):
        for prefix in ('', 'app/resources/app/', 'ai-console-1.3.1/'):
            for filename in ('.claude/launch.json', 'dist/data/conv/a.json',
                             'server/config.json', 'public/data/index.json',
                             'logs/_remote.json', '__pycache__/api.pyc', '.env.local'):
                with self.subTest(name=prefix + filename):
                    self.assertTrue(release_audit.forbidden_path(prefix + filename))

    def test_public_runtime_and_mobile_assets_are_allowed(self):
        for name in ('server/config.example.json', 'server/api.py', 'src/mobile/remoteApi.ts',
                     'dist/m/sw.js', 'dist/m/manifest.webmanifest', 'docs/screenshot-home.png',
                     'node_modules/node-pty/prebuilds/win32-x64/conpty.node'):
            self.assertFalse(release_audit.forbidden_path(name), name)

    def test_windows_drive_and_case_collisions_are_refused(self):
        self.assertTrue(release_audit.forbidden_path('C:/Windows/probe.txt'))
        self.assertTrue(release_audit.forbidden_path('C:relative.txt'))
        with tempfile.TemporaryDirectory(prefix='ac_release_case_') as tmp:
            artifact = Path(tmp) / 'source.zip'
            with zipfile.ZipFile(artifact, 'w') as archive:
                archive.writestr('app/README.md', 'safe')
                archive.writestr('app/readme.MD', 'other')
            result = release_audit.audit(artifact, 'source', '1.3.1')
            self.assertIn('duplicate-entry', {issue['rule'] for issue in result['issues']})

    def test_zip_detects_wrong_version_and_host_path_without_echoing_content(self):
        with tempfile.TemporaryDirectory(prefix='ac_release_test_') as tmp:
            artifact = Path(tmp) / 'source.zip'
            with zipfile.ZipFile(artifact, 'w') as archive:
                archive.writestr('app/package.json', json.dumps({'version': '0.0.0'}))
                archive.writestr('app/README.md', 'Host path: C:/Synthetic/PrivateHost/work')
            result = release_audit.audit(artifact, 'source', '1.3.1', 'C:/Synthetic/PrivateHost')
            self.assertFalse(result['ok'])
            rules = {issue['rule'] for issue in result['issues']}
            self.assertIn('wrong-version', rules)
            self.assertIn('host-absolute-path', rules)
            self.assertNotIn('PrivateHost', json.dumps(result))

    def test_pairing_secret_is_injected_and_never_echoed(self):
        with tempfile.TemporaryDirectory(prefix='ac_release_pairing_') as tmp:
            artifact = Path(tmp) / 'source.zip'
            with zipfile.ZipFile(artifact, 'w') as archive:
                archive.writestr('app/README.md', 'synthetic-pairing-marker')
            result = release_audit.audit(artifact, 'source', '1.3.1',
                                         pairing_secret=b'synthetic-pairing-marker')
            self.assertIn('pairing-secret', {issue['rule'] for issue in result['issues']})
            self.assertNotIn('synthetic-pairing-marker', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
