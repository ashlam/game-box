#!/usr/bin/env python3
"""把 web/ 的静态页面同步成 android/project/assets/ 里的离线版资源。

为什么要这一步：网页版和 APK 内嵌版的**链接写法必须不同**。
  - 网页版：`href="/"`、`href="/othello/"`（站点根绝对路径）
  - 离线版：assets 里没有站点根，必须 `href="../index.html"`、`href="othello/index.html"`
之前是手工改一次就放着，导致新加的游戏很容易"网页上有、打出来的 APK 里没有"。
现在改成构建前自动同步 —— web/ 是唯一事实来源，assets/ 是生成物。

用法：
  python3 android/sync_assets.py          # 同步
  python3 android/sync_assets.py --check  # 只检查是否已同步（供 CI / build_apk.sh 前置校验）
"""
import re
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
WEB = PROJECT / "web"
ASSETS = PROJECT / "android" / "project" / "assets"

# 单个游戏的返回链接：站点根 -> 上级 index.html
REWRITE = [
    (re.compile(r'href="/([a-z0-9_-]+)/"'), r'href="\1/index.html"'),   # 卡片 -> 子目录 index
    (re.compile(r'href="/"'),               'href="../index.html"'),    # 返回 -> 上级 index
    (re.compile(r"document\.getElementById\('addr'\)\.textContent = location\.host;"),
     "document.getElementById('addr').textContent = '离线版 · 无需网络';"),
]

# 离线包里不允许出现的外部/站点根引用
BAD = re.compile(r'(?:href|src)=["\'](?:https?://|//|/[^"\']*["\'])')


def offline(text: str) -> str:
    for pat, rep in REWRITE:
        text = pat.sub(rep, text)
    return text


def main() -> int:
    check = "--check" in sys.argv

    pages = sorted(p for p in WEB.rglob("*.html") if p.is_file())
    if not pages:
        print("web/ 下没找到任何 html", file=sys.stderr)
        return 1

    changed, missing, dirty = [], [], []
    for src in pages:
        rel = src.relative_to(WEB)
        dst = ASSETS / rel
        want = offline(src.read_text(encoding="utf-8"))
        if not dst.exists():
            missing.append(str(rel))
        elif dst.read_text(encoding="utf-8") != want:
            dirty.append(str(rel))
        if not missing or missing[-1] != str(rel):
            changed.append(str(rel))

        if not check:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(want, encoding="utf-8")
            # 顺手校验：离线版里不能再有站点根 / 外部链接
            bad = BAD.findall(want)
            if bad:
                print(f"✗ {rel} 同步后仍含站点根/外部链接: {bad[:3]}", file=sys.stderr)
                return 1

    # 清理 assets 里已被删除的页面（保持与 web/ 一致）
    stale = []
    if ASSETS.exists():
        for f in sorted(ASSETS.rglob("*.html")):
            if f.relative_to(ASSETS) not in [p.relative_to(WEB) for p in pages]:
                stale.append(str(f.relative_to(ASSETS)))
                if not check:
                    f.unlink()

    if check:
        ok = not (missing or dirty or stale)
        print("assets 已与 web/ 同步" if ok else
              f"assets 未同步：缺 {missing} 旧 {dirty} 多余 {stale}")
        return 0 if ok else 1

    print(f"已同步 {len(pages)} 个页面 -> {ASSETS.relative_to(PROJECT)}/")
    for rel in changed:
        print("  ·", rel)
    if stale:
        print("  清理多余：", stale)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
