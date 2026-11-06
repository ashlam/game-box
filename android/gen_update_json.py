#!/usr/bin/env python3
"""生成应用内升级用的清单 update.json。

App 里的「检查更新」就是拉这个文件，比对 versionCode，比本机大就提示下载。

清单长这样：
  {
    "versionCode": 208,          # 必须严格大于旧包，否则装不上
    "versionName": "1.208",
    "file": "gamesbox-latest.apk",  # 相对本文件的路径；写绝对 URL 也认
    "size": 8123456,
    "sha256": "…",               # App 下载完会校验，断了/被改过都能发现
    "notes": ["新增 xxx", "修复 yyy"],
    "builtAt": "2026-11-06T11:30:00+08:00",
    "minSdk": 23
  }

文件名刻意用纯 ASCII 的 `gamesbox-latest.apk`：中文名在 URL 里要编码，
局域网里随便一个 http 服务（python -m http.server 之类）对非 ASCII 路径支持不一，
踩过一次就再也不想踩了。

用法：
  python3 android/gen_update_json.py --apk releases/x.apk --code 208 --name 1.208 \
      --file gamesbox-latest.apk --out releases/update.json
"""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
NOTES_FILE = PROJECT / "docs" / "release-notes.txt"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def load_notes(limit: int = 6) -> list:
    """优先读 docs/release-notes.txt（一行一条，# 开头是注释）；没有就退回 git log。"""
    if NOTES_FILE.exists():
        out = []
        for line in NOTES_FILE.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            out.append(s.lstrip("-·*• ").strip())
            if len(out) >= limit:
                break
        if out:
            return out
    try:
        r = subprocess.run(
            ["git", "-C", str(PROJECT), "log", "-n", "20", "--pretty=%s"],
            capture_output=True, text=True, timeout=5,
        )
        out = [l.strip() for l in r.stdout.splitlines()
               if l.strip() and not l.strip().startswith("build(apk)")]
        return out[:limit]
    except Exception:
        return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True, help="签名后的 APK 路径")
    ap.add_argument("--code", required=True, type=int, help="versionCode")
    ap.add_argument("--name", required=True, help="versionName")
    ap.add_argument("--file", default="gamesbox-latest.apk", help="清单里的文件名（相对清单所在目录）")
    ap.add_argument("--out", default="", help="清单输出路径，默认 apk 同目录/update.json")
    ap.add_argument("--min-sdk", type=int, default=23)
    ap.add_argument("--notes", default="", help="额外附加的一条更新说明")
    args = ap.parse_args()

    apk = Path(args.apk).resolve()
    if not apk.is_file():
        print(f"找不到 APK: {apk}", file=sys.stderr)
        return 1

    notes = load_notes()
    if args.notes:
        notes.insert(0, args.notes)

    doc = {
        "versionCode": args.code,
        "versionName": args.name,
        "file": args.file,
        "size": apk.stat().st_size,
        "sha256": sha256_of(apk),
        "notes": notes,
        "builtAt": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "minSdk": args.min_sdk,
    }

    out = Path(args.out).resolve() if args.out else apk.parent / "update.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"已生成 {out}")
    print(f"  versionCode {doc['versionCode']} / {doc['versionName']}")
    print(f"  {doc['size']} 字节  sha256 {doc['sha256'][:16]}…")
    for n in notes:
        print(f"  · {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
