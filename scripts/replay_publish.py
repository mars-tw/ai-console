# -*- coding: utf-8 -*-
"""把 master 上 <base> 之後的提交逐一重放到 publish 分支（開源鏡像）。

publish 是孤兒分支：等於 master 剔除 .claude/（本機規則與路徑）與 release/（打包產物）。
用臨時 worktree 重放，不碰目前的工作區；重放完把 publish 指到新頭，自己不推。

用法：python scripts/replay_publish.py <publish 目前對應的 master 提交>
之後：git push origin publish:main
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

STRIP = (".claude", "release")


def run(args, cwd, check=True):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and r.returncode:
        raise SystemExit(f"git {' '.join(args)} 失敗：\n{r.stdout}{r.stderr}")
    return r


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    base = sys.argv[1]
    root = run(["rev-parse", "--show-toplevel"], os.getcwd()).stdout.strip()
    commits = run(["rev-list", "--reverse", f"{base}..master"], root).stdout.split()
    if not commits:
        print("沒有要重放的提交")
        return
    wt = tempfile.mkdtemp(prefix="pub-")
    run(["worktree", "add", "-f", "--detach", wt, "publish"], root)
    try:
        for c in commits:
            run(["cherry-pick", "-n", c], wt, check=False)
            # 衝突幾乎都來自 .claude/ 裡 publish 根本沒有的檔：整個拿掉就解了
            for p in STRIP:
                run(["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", p], wt, check=False)
                shutil.rmtree(os.path.join(wt, p), ignore_errors=True)
            left = run(["diff", "--name-only", "--diff-filter=U"], wt).stdout.split()
            if left:
                raise SystemExit(f"{c[:7]} 剔除後仍有衝突：{left}")
            if not run(["status", "--porcelain"], wt).stdout.strip():
                print(f"  {c[:7]} 剔除後沒有東西，跳過")
                run(["reset", "-q", "--hard"], wt)
                continue
            run(["commit", "-q", "-C", c], wt)
            print(f"  {c[:7]} → {run(['rev-parse', '--short', 'HEAD'], wt).stdout.strip()}")
        leaked = run(["ls-files", *STRIP], wt).stdout.split()
        if leaked:
            raise SystemExit(f"publish 上不該有這些：{leaked[:5]}")
        head = run(["rev-parse", "HEAD"], wt).stdout.strip()
        run(["branch", "-f", "publish", head], root)
        print(f"publish → {head[:7]}")
    finally:
        run(["worktree", "remove", "--force", wt], root, check=False)


if __name__ == "__main__":
    main()
