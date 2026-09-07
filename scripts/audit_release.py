"""Audit a staged app, portable directory or source/portable ZIP before release.

Only counts and relative file names are printed. Private values never enter output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import zipfile

TEXT_EXTENSIONS = {'.json', '.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.md', '.html',
                   '.css', '.map', '.toml', '.yaml', '.yml', '.txt', '.bat', '.ps1', '.webmanifest', '.svg'}
FORBIDDEN_PARTS = {'.claude', '.codex', '.gemini', '.qwen', '.grok', '.agents', '.git',
                   '.playwright-cli', '.audit-tmp', '__pycache__', 'output', 'private'}
FORBIDDEN_FILES = {'config.json', '_remote.json', 'auth.json', '.env', '.graphify-project.json',
                   'graphify-boot.md', 'gemini.md'}


def _parts(name: str) -> tuple[str, ...]:
    return PurePosixPath(name.replace('\\', '/')).parts


def forbidden_path(name: str) -> bool:
    parts = tuple(part.casefold() for part in _parts(name))
    if not parts or '..' in parts or name.startswith(('/', '\\')) or PureWindowsPath(name).drive:
        return True
    # Dependency manifests and reference docs are not host configuration.
    dependency = 'node_modules' in parts
    if any(part in FORBIDDEN_PARTS for part in parts):
        return True
    if parts[-1] in FORBIDDEN_FILES or parts[-1].endswith(('.log', '.pyc', '.local', '.bak')):
        return True
    joined = '/'.join(parts)
    if any(fragment in joined for fragment in ('dist/data/', 'public/data/', 'dispatch-log/')):
        return True
    if not dependency and 'node_modules' not in parts and parts[-1].startswith('.env'):
        return True
    return False


def contents(path: Path):
    if path.is_dir():
        for file in sorted(path.rglob('*')):
            relative = file.relative_to(path).as_posix()
            if file.is_symlink() or getattr(file, 'is_junction', lambda: False)():
                yield relative, b'', True
            elif file.is_file():
                yield relative, file.read_bytes(), False
    else:
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                if not entry.is_dir():
                    yield entry.filename, archive.read(entry), stat.S_ISLNK(entry.external_attr >> 16)


def audit(path: Path, kind: str, version: str, private_home: str | None = None,
          pairing_secret: bytes = b'') -> dict:
    home = private_home or str(Path.home())
    variants = {home, home.replace('\\', '/'), home.replace('\\', '\\\\')}
    needles = [value.casefold().encode('utf-8') for value in variants if len(value) > 5]
    files = {}
    folded_paths = set()
    issues = []
    total = 0
    for name, data, linked in contents(path):
        total += len(data)
        folded = '/'.join(_parts(name)).casefold()
        if folded in folded_paths:
            issues.append({'file': name, 'rule': 'duplicate-entry'})
        folded_paths.add(folded)
        files[name] = len(data)
        if linked or forbidden_path(name):
            issues.append({'file': name, 'rule': 'private-or-linked-path'})
        if pairing_secret and pairing_secret in data:
            issues.append({'file': name, 'rule': 'pairing-secret'})
        if PurePosixPath(name).suffix.casefold() in TEXT_EXTENSIONS:
            lowered = data.lower()
            if any(needle in lowered for needle in needles):
                issues.append({'file': name, 'rule': 'host-absolute-path'})
    prefix = ''
    if kind == 'windows':
        matches = [name for name in files if name.endswith('resources/app/package.json')]
    elif kind == 'source':
        matches = [name for name in files if name.endswith('/package.json') and len(_parts(name)) == 2]
        if not matches and 'package.json' in files:
            matches = ['package.json']
    else:
        matches = ['package.json'] if 'package.json' in files else []
    if len(matches) != 1:
        issues.append({'file': 'package.json', 'rule': 'missing-or-ambiguous-app-manifest'})
    else:
        manifest_name = matches[0]
        prefix = manifest_name[:-len('package.json')]
        manifest = next(data for name, data, _ in contents(path) if name == manifest_name)
        if json.loads(manifest).get('version') != version:
            issues.append({'file': manifest_name, 'rule': 'wrong-version'})
        required = ['server/api.py', 'electron/main.cjs', 'scripts/find-python.cjs']
        if kind != 'source':
            required += ['dist/index.html', 'dist/m/manifest.webmanifest',
                         'node_modules/node-pty/prebuilds/win32-x64/conpty.node']
        else:
            required += ['src/mobile/MobileApp.tsx', 'src/pages/Home.tsx']
        for relative in required:
            if prefix + relative not in files:
                issues.append({'file': relative, 'rule': 'missing-runtime-file'})
    digest = None
    if path.is_file():
        hasher = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                hasher.update(chunk)
        digest = hasher.hexdigest()
    return {'ok': not issues, 'kind': kind, 'version': version, 'files': len(files),
            'bytes': total, 'suspicious': len(issues), 'issues': issues,
            'sha256': digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path)
    parser.add_argument('--kind', choices=('source', 'stage', 'windows'), required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--check-local-pairing', action='store_true',
                        help='Check the current app pairing secret in memory; never print it')
    args = parser.parse_args()
    # Only the explicitly requested release check reads the app pairing store.
    # Unit tests and ordinary artifact checks never touch live pairing state.
    pairing = b''
    if args.check_local_pairing:
        remote = Path.home() / 'ai-hub' / 'dispatch-log' / '_remote.json'
        if remote.is_file():
            try:
                token = json.loads(remote.read_text(encoding='utf-8')).get('token', '')
                if isinstance(token, str) and len(token) >= 20:
                    pairing = token.encode('utf-8')
            except (OSError, ValueError):
                raise RuntimeError('Cannot read app pairing state for the release leak check') from None
    result = audit(args.path.resolve(strict=True), args.kind, args.version, pairing_secret=pairing)
    print(json.dumps(result, ensure_ascii=True))
    raise SystemExit(0 if result['ok'] else 1)


if __name__ == '__main__':
    main()
