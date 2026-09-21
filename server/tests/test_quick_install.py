"""Execute the shipped Windows installer with isolated files and mocked side effects."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
POWERSHELL = shutil.which('powershell.exe')
VERSION = '1.6.0'
ASSET = f'ai-console-win32-x64-v{VERSION}.zip'
REQUIRED = (
    'AI控制台.exe', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak',
    'resources/app/electron/main.cjs', 'resources/app/dist/index.html',
    'resources/app/server/api.py', 'resources/app/server/devspace_console.py',
    'resources/app/scripts/find-python.cjs', 'resources/app/runtime/python/python.exe',
    'resources/app/electron/pty.cjs', 'resources/app/electron/preload.cjs',
    'resources/app/electron/opencode.cjs', 'resources/app/electron/devspace-mcp-bridge.cjs',
    'resources/app/runtime/python/python3.dll', 'resources/app/runtime/python/python314.dll',
    'resources/app/runtime/python/python314.zip', 'resources/app/runtime/python/python314._pth',
    'resources/app/runtime/python/runtime.json',
)


def ps(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == 'nt' and POWERSHELL, 'Windows PowerShell 5.1 required')
class QuickInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ai-console-install-test-')
        self.base = Path(self.temp.name)
        self.bundle = self.base / '繁中 空白 & ! 安裝包'
        scripts = self.bundle / 'scripts'
        scripts.mkdir(parents=True)
        self.script = scripts / 'quick-install.ps1'
        shutil.copyfile(ROOT / 'scripts/quick-install.ps1', self.script)
        shutil.copyfile(ROOT / 'scripts/quick-payload.ps1', scripts / 'quick-payload.ps1')
        (scripts / 'quick-start.json').write_text(json.dumps({
            'version': VERSION, 'repository': 'mars-tw/ai-console', 'asset': ASSET,
        }), encoding='utf-8')
        self.install = self.base / '本機 程式 & !'
        self.local = self.base / 'local-app-data'
        self.local.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def run_ps(self, body, *, success=True):
        runner = self.base / 'test-runner.ps1'
        runner.write_text(
            "$ErrorActionPreference = 'Stop'\n"
            "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n"
            f". {ps(self.script)} -LibraryOnly\n" + body,
            encoding='utf-8-sig',
        )
        env = {**os.environ, 'LOCALAPPDATA': str(self.local)}
        result = subprocess.run(
            [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(runner)],
            capture_output=True, encoding='utf-8', errors='replace', env=env, timeout=60,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def make_payload(self, target=None):
        target = target or self.bundle
        for name in REQUIRED:
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic test payload: ' + name.encode())
        (target / 'resources/app/package.json').write_text(json.dumps({
            'name': 'ai-console', 'version': VERSION, 'main': 'electron/main.cjs',
        }), encoding='utf-8')
        files = []
        for file in target.rglob('*'):
            if file.is_file() and file != target / 'quick-payload.json':
                data = file.read_bytes()
                files.append({'path': file.relative_to(target).as_posix(), 'size': len(data),
                              'sha256': hashlib.sha256(data).hexdigest()})
        (target / 'quick-payload.json').write_text(json.dumps({
            'schemaVersion': 1, 'version': VERSION, 'files': files,
        }), encoding='utf-8')
        return target

    def make_zip(self, extra=None, omit=None):
        payload = self.make_payload(self.base / 'payload')
        archive = self.base / ASSET
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
            for path in payload.rglob('*'):
                if path.is_file() and path.relative_to(payload).as_posix() != omit:
                    output.write(path, 'AI控制台-win32-x64/' + path.relative_to(payload).as_posix())
            if extra:
                output.writestr(*extra)
        return archive

    def test_script_has_bom_and_import_has_no_side_effects(self):
        self.assertTrue(self.script.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.run_ps("Write-Output 'IMPORTED'")
        self.assertFalse(self.install.exists())
        self.assertEqual(list(self.local.iterdir()), [])

    def test_plan_is_read_only_and_uses_pinned_download(self):
        result = self.run_ps(f"Invoke-QuickInstall -Source {ps(self.bundle)} -Destination {ps(self.install)} -Preview")
        plan = json.loads(result.stdout)
        self.assertEqual(plan['source'], 'github-release')
        self.assertEqual(plan['download'], f'https://github.com/mars-tw/ai-console/releases/download/v{VERSION}/{ASSET}')
        self.assertFalse(plan['requiresAdmin'])
        self.assertFalse(self.install.exists())
        self.assertEqual(list(self.local.iterdir()), [])

    def test_noninteractive_requires_explicit_devspace_skip_before_writes(self):
        result = self.run_ps(f"Invoke-QuickInstall -Source {ps(self.bundle)} -Destination {ps(self.install)} -Unattended", success=False)
        self.assertIn('INSTALL_NONINTERACTIVE', result.stderr)
        self.assertFalse(self.install.exists())
        self.assertEqual(list(self.local.iterdir()), [])

    def test_portable_install_idempotence_pointer_and_previous_version(self):
        self.make_payload()
        previous = self.install / 'versions/1.5.0/sentinel.txt'
        previous.parent.mkdir(parents=True)
        previous.write_text('keep')
        self.run_ps(f"""
$first = Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}
Write-CurrentPointer {ps(self.install)} {ps(VERSION)}
$second = Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}
Write-CurrentPointer {ps(self.install)} {ps(VERSION)}
if ($first -cne $second) {{ throw 'Idempotent path changed' }}
""")
        pointer = json.loads((self.install / 'current.json').read_text(encoding='utf-8-sig'))
        self.assertEqual(pointer, {'version': VERSION, 'executable': f'versions/{VERSION}/AI控制台.exe'})
        self.assertEqual(previous.read_text(), 'keep')
        self.assertEqual((self.install / f'versions/{VERSION}/AI控制台.exe').read_bytes(), (self.bundle / 'AI控制台.exe').read_bytes())
        self.assertFalse(any(path.name.startswith('.staging-') for path in (self.install / 'versions').iterdir()))

    def test_different_existing_version_is_preserved(self):
        self.make_payload()
        self.run_ps(f'Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}')
        existing = self.install / f'versions/{VERSION}/AI控制台.exe'
        existing.write_bytes(b'previous custom build')
        result = self.run_ps(f'Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}', success=False)
        self.assertIn('VERSION_CONFLICT', result.stderr)
        self.assertEqual(existing.read_bytes(), b'previous custom build')

    def test_partial_payload_and_wrong_version_never_install(self):
        self.make_payload()
        (self.bundle / 'resources/app/server/devspace_console.py').unlink()
        self.run_ps(f'Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}', success=False)
        self.assertFalse(self.install.exists())
        self.make_payload()
        (self.bundle / 'resources/app/package.json').write_text('{"version":"0.0.0"}')
        self.run_ps(f'Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}', success=False)
        self.assertFalse(self.install.exists())

    def test_missing_pty_or_python_dll_never_replaces_previous_pointer(self):
        self.install.mkdir()
        pointer = self.install / 'current.json'
        original = '{"version":"1.5.0","executable":"versions/1.5.0/AI控制台.exe"}'
        pointer.write_text(original, encoding='utf-8')
        for missing in ('resources/app/electron/pty.cjs', 'resources/app/runtime/python/python314.dll',
                        'resources/app/electron/opencode.cjs', 'resources/app/electron/devspace-mcp-bridge.cjs'):
            with self.subTest(missing=missing):
                self.make_payload()
                (self.bundle / missing).unlink()
                self.run_ps(f"""
Invoke-QuickInstall -Source {ps(self.bundle)} -Destination {ps(self.install)} -Unattended -OmitDevSpace -OmitLaunch
""", success=False)
                self.assertEqual(pointer.read_text(encoding='utf-8'), original)
                self.assertFalse((self.install / f'versions/{VERSION}').exists())

    def test_payload_manifest_detects_missing_list_entries_hash_changes_and_unsafe_paths(self):
        self.make_payload()
        manifest_path = self.bundle / 'quick-payload.json'
        original = manifest_path.read_text(encoding='utf-8')
        data = json.loads(original)
        data['files'] = [entry for entry in data['files'] if entry['path'] != 'resources/app/electron/pty.cjs']
        manifest_path.write_text(json.dumps(data), encoding='utf-8')
        self.run_ps(f'Assert-QuickPayload {ps(self.bundle)} {ps(VERSION)} -VerifyHashes', success=False)
        manifest_path.write_text(original, encoding='utf-8')
        exe = self.bundle / 'AI控制台.exe'
        exe.write_bytes(b'x' * exe.stat().st_size)
        self.run_ps(f'Assert-QuickPayload {ps(self.bundle)} {ps(VERSION)} -VerifyHashes', success=False)
        self.make_payload()
        baseline = json.loads(manifest_path.read_text(encoding='utf-8'))
        for malformed in ('../escape', 'nested\\file', 'AI控制台.EXE'):
            with self.subTest(path=malformed):
                data = json.loads(json.dumps(baseline))
                data['files'].append({'path': malformed, 'size': 1, 'sha256': '0' * 64})
                manifest_path.write_text(json.dumps(data), encoding='utf-8')
                self.run_ps(f'Assert-QuickPayload {ps(self.bundle)} {ps(VERSION)} -VerifyHashes', success=False)
    def test_atomic_copy_failure_preserves_current_pointer(self):
        self.make_payload()
        self.install.mkdir()
        old = '{"version":"1.5.0","executable":"versions/1.5.0/AI控制台.exe"}'
        (self.install / 'current.json').write_text(old, encoding='utf-8')
        self.run_ps(f"""
function Test-EqualInventory {{ return $false }}
Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}
""", success=False)
        self.assertEqual((self.install / 'current.json').read_text(encoding='utf-8'), old)
        self.assertFalse((self.install / f'versions/{VERSION}').exists())
        self.assertFalse(any(path.name.startswith('.staging-') for path in (self.install / 'versions').iterdir()))

    def test_checksum_mismatch_writes_no_extracted_payload(self):
        archive = self.make_zip()
        sums = self.base / 'SHA256SUMS.txt'
        sums.write_text('0' * 64 + '  ' + ASSET + '\n')
        result = self.run_ps(f'Assert-ReleaseChecksum {ps(archive)} {ps(sums)} {ps(ASSET)}', success=False)
        self.assertIn('CHECKSUM_MISMATCH', result.stderr)
        self.assertFalse(self.install.exists())

    def test_bootstrap_download_is_verified_and_side_effects_are_mocked(self):
        archive = self.make_zip()
        sums = self.base / 'SHA256SUMS.txt'
        sums.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + ASSET + '\n')
        record = self.base / 'calls.txt'
        self.run_ps(f"""
function Receive-ReleaseFile([string]$Uri, [string]$OutFile) {{
    if ($Uri -eq 'https://github.com/mars-tw/ai-console/releases/download/v{VERSION}/SHA256SUMS.txt') {{
        [IO.File]::Copy({ps(sums)}, $OutFile)
    }} elseif ($Uri -eq 'https://github.com/mars-tw/ai-console/releases/download/v{VERSION}/{ASSET}') {{
        [IO.File]::Copy({ps(archive)}, $OutFile)
    }} else {{ throw 'Unpinned download' }}
}}
function New-AppShortcuts([string]$Executable) {{ [IO.File]::AppendAllText({ps(record)}, 'shortcut|') }}
function Invoke-DevSpaceSetup {{ throw 'Unexpected dependency mutation' }}
function Start-InstalledApp([string]$Executable) {{ throw 'Unexpected app launch' }}
Invoke-QuickInstall -Source {ps(self.bundle)} -Destination {ps(self.install)} -Unattended -OmitDevSpace -OmitLaunch
""")
        self.assertEqual(record.read_text(), 'shortcut|')
        self.assertTrue((self.install / f'versions/{VERSION}/AI控制台.exe').exists())
        self.assertTrue((self.install / 'current.json').exists())
        self.assertEqual(list((self.local / 'AIConsole').glob('download-*')), [])

    def test_archive_traversal_collisions_reserved_paths_links_and_expansion(self):
        cases = [('../escape', b'x'), ('/absolute', b'x'), ('C:drive', b'x'),
                 ('AI控制台-win32-x64/ICUDTL.DAT', b'collision'), ('a./b', b'x'),
                 ('a/CON.txt', b'x'), ('a/stream:ads', b'x'),
                 ('AI控制台-win32-x64/resources/app/server/api.py/child', b'x')]
        link = zipfile.ZipInfo('linked')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases.append((link, b'target'))
        for index, extra in enumerate(cases):
            with self.subTest(entry=str(extra[0])):
                archive = self.make_zip(extra)
                target = self.base / f'extract-{index}'
                self.run_ps(f'Expand-SafeArchive {ps(archive)} {ps(target)}', success=False)
                self.assertFalse(target.exists())
        archive = self.make_zip()
        self.run_ps(f'Expand-SafeArchive {ps(archive)} {ps(self.install)} -MaxExpandedBytes 1', success=False)
        self.assertFalse(self.install.exists())

    def test_partial_download_does_not_publish_pointer(self):
        archive = self.make_zip(omit='resources/app/runtime/python/python.exe')
        sums = self.base / 'SHA256SUMS.txt'
        sums.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + ASSET + '\n')
        scratch = self.base / 'scratch'
        scratch.mkdir()
        self.run_ps(f"""
function Receive-ReleaseFile([string]$Uri, [string]$OutFile) {{
    $source = if ($Uri.EndsWith('SHA256SUMS.txt')) {{ {ps(sums)} }} else {{ {ps(archive)} }}
    [IO.File]::Copy($source, $OutFile)
}}
Get-DownloadedPayload (Get-QuickInstallManifest) {ps(scratch)}
""", success=False)
        self.assertFalse(self.install.exists())

    def test_junction_destination_is_refused_without_touching_target(self):
        self.make_payload()
        real = self.base / 'real-target'
        real.mkdir()
        (real / 'sentinel').write_text('preserve')
        self.run_ps(f"""
New-Item -ItemType Junction -Path {ps(self.install)} -Target {ps(real)} | Out-Null
Install-AppPayload {ps(self.bundle)} {ps(self.install)} {ps(VERSION)}
""", success=False)
        self.assertEqual([path.name for path in real.iterdir()], ['sentinel'])


if __name__ == '__main__':
    unittest.main()
