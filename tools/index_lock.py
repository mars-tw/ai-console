# -*- coding: utf-8 -*-
"""Cross-process lock shared by conversation metadata writers and the indexer."""
from __future__ import annotations

import contextlib
import os
import stat
import tempfile
import time
from pathlib import Path

WINDOWS_MUTEX_NAME = r"Local\AIConsoleConversationIndexV1"
POSIX_LOCK_PATH = Path(tempfile.gettempdir()) / "ai-console-conversation-index-v1.lock"


@contextlib.contextmanager
def conversation_index_lock(*, timeout: float = 60.0,
                            mutex_name: str = WINDOWS_MUTEX_NAME,
                            lock_path: Path | str | None = None):
    """Acquire the process-wide conversation-index lock.

    Metadata writers must release this lock before launching an indexer subprocess;
    the subprocess acquires it for its complete build. A timeout raises TimeoutError.
    """
    timeout = float(timeout)
    if timeout < 0:
        raise ValueError("timeout must be non-negative")
    if os.name == "nt":
        if not mutex_name or "\x00" in mutex_name:
            raise ValueError("invalid mutex name")
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.ReleaseMutex.argtypes = (wintypes.HANDLE,)
        kernel32.ReleaseMutex.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.CreateMutexW(None, False, mutex_name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        acquired = False
        try:
            millis = min(int(timeout * 1000), 0xFFFFFFFE)
            result = kernel32.WaitForSingleObject(handle, millis)
            if result in (0x00000000, 0x00000080):  # WAIT_OBJECT_0 / WAIT_ABANDONED
                acquired = True
            elif result == 0x00000102:  # WAIT_TIMEOUT
                raise TimeoutError("conversation index lock timed out")
            else:  # WAIT_FAILED or an unexpected result
                raise ctypes.WinError(ctypes.get_last_error())
            yield
        finally:
            if acquired:
                kernel32.ReleaseMutex(handle)
            kernel32.CloseHandle(handle)
        return

    # POSIX fallback. Never unlink the file: unlinking a live flock inode creates a
    # second lock domain for a racing process. O_NOFOLLOW blocks symlink substitution.
    import fcntl

    path = Path(lock_path) if lock_path is not None else POSIX_LOCK_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_CREAT | os.O_RDWR
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    acquired = False
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise PermissionError("conversation index lock is not a regular file")
        current = os.lstat(path)
        if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (
                st.st_dev, st.st_ino):
            raise PermissionError("conversation index lock path was replaced")
        if hasattr(os, "getuid") and st.st_uid != os.getuid():
            raise PermissionError("conversation index lock is owned by another user")
        os.fchmod(fd, 0o600)
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("conversation index lock timed out")
                time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        yield
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
