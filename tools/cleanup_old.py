# -*- coding: utf-8 -*-
"""
刪除 2 週以上未使用的對話（安全版）
流程：掃描目標 → 封存到 tar.gz → 驗證封存完整 → 刪除原始檔 → 輸出報告
用法：
  python tools/cleanup_old.py --dry-run     # 只看範圍
  python tools/cleanup_old.py --execute     # 封存後刪除
"""
import argparse
import io
import json
import os
import sys
import tarfile
import time
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
APP_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_DIR = APP_ROOT / "archives"
DAYS = 14

# 與 indexer 相同的來源；delete_mode 決定刪單檔還是整個 session 目錄
SOURCES = [
    ("claude", HOME / ".claude" / "projects", "*.jsonl", "file"),
    ("codex", HOME / ".codex" / "sessions", "*.jsonl", "file"),
    ("codex", HOME / ".codex" / "archived_sessions", "*.jsonl", "file"),
    ("grok", HOME / ".grok" / "sessions", "chat_history.jsonl", "session_dir"),   # 刪整個 <uuid>/ 目錄
    ("qwen", HOME / ".qwen" / "projects", "*.jsonl", "file"),
    ("cursor", HOME / ".cursor" / "projects", "*.jsonl", "file"),
    ("kimi", HOME / ".kimi-code" / "sessions", "wire.jsonl", "kimi_session_dir"),  # 刪 session_xxx/ 目錄
]

GROK_SESSION_FILES = {  # grok session 目錄的完整成員（封存時一起帶上）
    "chat_history.jsonl", "events.jsonl", "prompt_context.json", "rewind_points.jsonl",
    "signals.json", "summary.json", "system_prompt.txt", "updates.jsonl", "prompt_history.jsonl",
}


def collect_targets(cutoff: float):
    """回傳 [(tool, path, size, delete_root)] — delete_root 為實際要刪的單位"""
    targets = []
    seen_dirs = set()
    for tool, root, pattern, mode in SOURCES:
        if not root.exists():
            continue
        for path in root.rglob(pattern):
            if not path.is_file() or path.suffix == ".lock":
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if st.st_mtime >= cutoff or st.st_size < 200:
                continue
            if mode == "file":
                targets.append((tool, path, st.st_size, path))
            elif mode == "session_dir":
                d = path.parent  # grok 的 <uuid> 目錄
                if d in seen_dirs:
                    continue
                seen_dirs.add(d)
                total = sum(f.stat().st_size for f in d.iterdir() if f.is_file() and f.suffix != ".lock")
                targets.append((tool, path, total, d))
            elif mode == "kimi_session_dir":
                p = path
                for _ in range(3):  # wire.jsonl → agents → session_xxx
                    p = p.parent
                    if p.name.startswith("session_"):
                        break
                if not p.name.startswith("session_") or p in seen_dirs:
                    continue
                seen_dirs.add(p)
                total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                targets.append((tool, path, total, p))
    return targets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.execute and not args.dry_run:
        args.dry_run = True

    cutoff = time.time() - DAYS * 86400
    targets = collect_targets(cutoff)

    by_tool = {}
    total_size = 0
    for tool, path, size, root in targets:
        by_tool.setdefault(tool, [0, 0])
        by_tool[tool][0] += 1
        by_tool[tool][1] += size
        total_size += size

    print(f"截止：{time.strftime('%Y-%m-%d %H:%M', time.localtime(cutoff))} 之前未動過的對話")
    for tool, (n, sz) in sorted(by_tool.items()):
        print(f"  {tool:8} {n:5} 份  {sz/1048576:9.1f} MB")
    print(f"  合計     {len(targets):5} 份  {total_size/1048576:9.1f} MB")

    if args.dry_run:
        print("\n(dry-run，未刪除任何檔案)")
        return

    # ── 封存 ──
    ARCHIVE_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")
    archive = ARCHIVE_DIR / f"conv-older-than-{DAYS}d-{stamp}.tar"
    print(f"\n封存到 {archive} …", flush=True)
    n_arch = 0
    with tarfile.open(archive, "w:") as tar:
        for tool, path, size, root in targets:
            files = [path] if root == path else [f for f in root.rglob("*") if f.is_file()]
            for f in files:
                try:
                    tar.add(f, arcname=str(f).replace(":", "").lstrip("\\/"))
                    n_arch += 1
                except OSError:
                    pass
            print(f"  已封存 {tool} ...", flush=True)
    print(f"封存完成：{n_arch} 個檔案，{archive.stat().st_size/1048576:.1f} MB", flush=True)

    # ── 驗證封存可讀 ──
    with tarfile.open(archive, "r:") as tar:
        names = sum(1 for _ in tar.getnames())
    if names < n_arch * 0.99:
        print("封存驗證失敗，中止刪除！")
        sys.exit(1)
    print(f"封存驗證通過（{names} 項目）")

    # ── 刪除 ──
    deleted = freed = 0
    errors = 0
    for tool, path, size, root in targets:
        try:
            if root == path:
                freed += path.stat().st_size
                path.unlink()
                deleted += 1
            else:
                import shutil
                shutil.rmtree(root, ignore_errors=False)
                deleted += 1
                freed += size
        except OSError as e:
            errors += 1
            print(f"  刪除失敗 {root}: {e}")

    print(f"\n已刪除 {deleted} 個單位，釋放約 {freed/1048576:.1f} MB；失敗 {errors}")
    print(f"備份位於：{archive}")


if __name__ == "__main__":
    main()
