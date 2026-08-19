# -*- coding: utf-8 -*-
"""刪除 AI 派工對話（使用者確認為浪費空間的工單對話）
流程：從索引取 dispatch=True 的對話 → 封存 → 驗證 → 刪除原始檔
"""
import json
import sys
import tarfile
import time
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
INDEX = APP_ROOT / "public" / "data" / "index.json"
ARCHIVE_DIR = APP_ROOT / "archives"


def main():
    execute = "--execute" in sys.argv
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    targets = []
    for c in data["conversations"]:
        if not c.get("dispatch"):
            continue
        p = Path(c["path"])
        if p.exists():
            targets.append((c, p))

    total = sum(p.stat().st_size for _, p in targets)
    print(f"派工對話：{len(targets)} 份，共 {total/1048576:.1f} MB")
    from collections import Counter
    print("按工具：", dict(Counter(c["tool"] for c, _ in targets)))
    if not execute:
        print("(dry-run，未刪除)")
        return

    stamp = time.strftime("%Y%m%d-%H%M")
    archive = ARCHIVE_DIR / f"dispatch-conv-{stamp}.tar"
    ARCHIVE_DIR.mkdir(exist_ok=True)
    n = 0
    with tarfile.open(archive, "w:") as tar:
        for c, p in targets:
            try:
                tar.add(p, arcname=str(p).replace(":", "").lstrip("\\/"))
                n += 1
            except OSError:
                pass
    with tarfile.open(archive, "r:") as tar:
        valid = len(tar.getnames())
    if valid < n * 0.99:
        print("封存驗證失敗，中止！")
        sys.exit(1)
    print(f"封存完成並驗證：{n} 個檔案 → {archive.name}")

    deleted = 0
    for c, p in targets:
        try:
            p.unlink()
            deleted += 1
        except OSError as e:
            print(f"  失敗 {p.name}: {e}")
    print(f"已刪除 {deleted}/{len(targets)}，釋放 {total/1048576:.1f} MB")


if __name__ == "__main__":
    main()
