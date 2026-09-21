#!/usr/bin/env python3
"""看一眼 .sok 文件的真实结构：棋盘后面到底跟了什么。"""
path = "/opt/data/games-tools/classic/IllustrativeLevels.sok"
lines = [l.rstrip("\r\n") for l in open(path, encoding="utf-8", errors="replace").read().splitlines()]
BOARD = set(" #.$*@+")
start = None
for i, l in enumerate(lines):
    s = l.strip()
    if s and all(ch in BOARD for ch in l) and any(ch in l for ch in "#$*@."):
        start = i
        break
print(f"=== 第一个棋盘出现在第 {start+1} 行 ===")
for j in range(max(0, start - 12), min(len(lines), start + 28)):
    mark = "  <<<" if j == start else ""
    print(f"{j+1:4d}|{lines[j]}{mark}")
