"""Safely extract a UTF-8 Git ZIP archive into a new, isolated build snapshot."""
import argparse
from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil
import stat
import zipfile

MAX_FILES = 100_000
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024


def extract(archive_path: Path, destination: Path) -> None:
    destination = destination.absolute()
    if not destination.is_dir() or destination.is_symlink() or any(destination.iterdir()):
        raise ValueError('Snapshot destination must be an empty, unlinked directory')
    if any(p.is_symlink() or bool(getattr(p.lstat(), 'st_file_attributes', 0) & 0x400)
           for p in (destination, *destination.parents)):
        raise ValueError('Linked snapshot path refused')
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or sum(e.file_size for e in entries) > MAX_EXPANDED_BYTES:
            raise ValueError('Snapshot expansion limit exceeded')
        seen = set()
        for entry in entries:
            name = entry.filename.rstrip('/')
            parts = PurePosixPath(name).parts
            mode = entry.external_attr >> 16
            if (entry.orig_filename != entry.filename or not name or '\\' in name or ':' in name or name.startswith('/')
                    or PureWindowsPath(name).drive or any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in name.split('/'))
                    or stat.S_ISLNK(mode) or not (entry.is_dir() or stat.S_IFMT(mode) in (0, stat.S_IFREG))
                    or name.casefold() in seen):
                raise ValueError('Unsafe or duplicate snapshot entry')
            seen.add(name.casefold())
            target = destination.joinpath(*parts)
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError('Snapshot entry escapes destination')
        for entry in entries:
            target = destination.joinpath(*PurePosixPath(entry.filename.rstrip('/')).parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    extract(args.archive, args.destination)
