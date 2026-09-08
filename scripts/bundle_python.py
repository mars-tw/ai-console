"""Stage the pinned official Windows runtime; never install or modify system Python."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PureWindowsPath
import stat
import time
import urllib.request
import zipfile

PIN = json.loads(Path(__file__).with_name('python-runtime.json').read_text(encoding='utf-8'))
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_FILES = 64


def linked(path: Path) -> bool:
    # Detect Windows junctions too on Python versions before Path.is_junction.
    return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & 0x400)


def checked_destination(stage: Path) -> Path:
    stage = stage.absolute()
    for part in (stage, *stage.parents):
        if part.exists() and linked(part):
            raise ValueError('Linked staging path refused')
    if not stage.is_dir():
        raise ValueError('Stage must be an existing directory')
    destination = stage / 'runtime' / 'python'
    for part in (stage / 'runtime', destination):
        if part.exists() and (linked(part) or not part.is_dir()):
            raise ValueError('Linked or non-directory runtime path refused')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Runtime destination must be empty')
    if not destination.resolve().is_relative_to(stage.resolve()):
        raise ValueError('Runtime destination escapes stage')
    return destination


def validated_files(data: bytes, pin: dict) -> dict[str, bytes]:
    """Validate everything before writing; tests can supply a synthetic trusted pin."""
    if len(data) > MAX_ARCHIVE_BYTES or hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise ValueError('Python archive SHA256 mismatch or excessive size')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or sum(e.file_size for e in entries) > MAX_EXPANDED_BYTES:
            raise ValueError('Python archive expansion limit exceeded')
        names = set()
        result = {}
        for entry in entries:
            name = entry.filename
            # This pinned distribution is deliberately flat: no archive paths needed.
            if (not name or name in ('.', '..') or '/' in name or '\\' in name
                    or ':' in name or PureWindowsPath(name).drive
                    or name.endswith((' ', '.')) or entry.is_dir()
                    or stat.S_ISLNK(entry.external_attr >> 16)
                    or name.casefold() in names):
                raise ValueError('Unsafe or duplicate Python archive entry')
            names.add(name.casefold())
            result[name] = archive.read(entry)
    if set(result) != set(pin['files']):
        raise ValueError('Python runtime inventory mismatch')
    result['python314._pth'] = pin['pth'].encode('utf-8')
    if any(hashlib.sha256(value).hexdigest() != pin['files'][name] for name, value in result.items()):
        raise ValueError('Python runtime file integrity mismatch')
    return result


def download() -> bytes:
    # Ignore environment proxy configuration and refuse redirects to alternate URLs.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise ValueError('Python archive redirect refused')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    started = time.monotonic()
    chunks = []
    count = 0
    with opener.open(PIN['url'], timeout=15) as response:
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_ARCHIVE_BYTES or time.monotonic() - started > 90:
                raise ValueError('Python download limit exceeded')
            chunks.append(chunk)
    return b''.join(chunks)


def bundle(stage: Path, archive: Path | None = None) -> Path:
    destination = checked_destination(stage)
    if archive is None:
        data = download()
    else:
        if archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError('Python archive excessive size')
        data = archive.read_bytes()
    files = validated_files(data, PIN)
    # Recheck immediately before mutations; never merge into an existing runtime.
    destination = checked_destination(stage)
    destination.mkdir(parents=True, exist_ok=True)
    for name, contents in files.items():
        with (destination / name).open('xb') as stream:
            stream.write(contents)
    with (destination / 'runtime.json').open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(PIN, stream, indent=2)
        stream.write('\n')
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', type=Path)
    args = parser.parse_args()
    source = os.environ.get('AI_CONSOLE_PYTHON_ZIP')
    bundle(args.stage, Path(source) if source else None)
    print(json.dumps({'ok': True, 'version': PIN['version'], 'sha256': PIN['sha256']}))


if __name__ == '__main__':
    main()
