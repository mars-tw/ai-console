"""The distributed artifact must never include private runtime data."""
import importlib.util
import hashlib
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
    def test_payload_inventory_detects_missing_or_corrupt_files(self):
        with tempfile.TemporaryDirectory(prefix='ac_payload_audit_') as tmp:
            artifact = Path(tmp) / 'windows.zip'
            entries = {'resources/app/package.json': b'{"version":"1.5.1"}',
                       'resources/app/electron/pty.cjs': b'fixture'}
            inventory = {'schemaVersion': 1, 'version': '1.5.1', 'files': [
                {'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                for name, data in entries.items()]}
            def write(mode):
                with zipfile.ZipFile(artifact, 'w') as archive:
                    for name, data in entries.items():
                        if mode == 'missing' and name.endswith('pty.cjs'):
                            continue
                        archive.writestr('app/' + name, b'changed' if mode == 'corrupt' and name.endswith('pty.cjs') else data)
                    archive.writestr('app/quick-payload.json', json.dumps(inventory))
            write('complete')
            self.assertNotIn('payload-manifest-mismatch', {i['rule'] for i in release_audit.audit(artifact, 'windows', '1.5.1')['issues']})
            for mode in ('missing', 'corrupt'):
                write(mode)
                self.assertIn('payload-manifest-mismatch', {i['rule'] for i in release_audit.audit(artifact, 'windows', '1.5.1')['issues']})

    def test_bootstrap_requires_exact_inventory_and_matching_public_release(self):
        with tempfile.TemporaryDirectory(prefix='ac_bootstrap_audit_') as tmp:
            artifact = Path(tmp) / 'bootstrap.zip'
            def write(extra=None, version='1.5.1'):
                with zipfile.ZipFile(artifact, 'w') as archive:
                    for name in (*release_audit.QUICK_FILES, 'LICENSE'):
                        content = json.dumps({'version': version, 'repository': 'mars-tw/ai-console',
                                              'asset': f'ai-console-win32-x64-v{version}.zip'}) if name.endswith('quick-start.json') else 'fixture'
                        archive.writestr('quick/' + name, content)
                    if extra:
                        archive.writestr('quick/' + extra, 'unexpected')
            write()
            self.assertTrue(release_audit.audit(artifact, 'bootstrap', '1.5.1')['ok'])
            write('private-data.txt')
            self.assertIn('unexpected-bootstrap-file', {i['rule'] for i in release_audit.audit(artifact, 'bootstrap', '1.5.1')['issues']})
            write(version='1.5.0')
            self.assertIn('invalid-quick-manifest', {i['rule'] for i in release_audit.audit(artifact, 'bootstrap', '1.5.1')['issues']})

    def test_private_paths_are_refused_in_both_package_prefixes(self):
        for prefix in ('', 'app/resources/app/', 'ai-console-1.3.1/'):
            for filename in ('.claude/launch.json', 'dist/data/conv/a.json',
                             'server/config.json', 'public/data/index.json',
                             'logs/_remote.json', '__pycache__/api.pyc', '.env.local',
                             '.ai-console/connections.json'):
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
