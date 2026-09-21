#!/usr/bin/env python3
"""调试：打印某个经典关卡的原始文本窗口 + 解法字符串 + 重放逐帧轨迹。"""
import sys
sys.path.insert(0, "/opt/data/games-tools")
from verify_by_solution import parse_file, parse_state, DIRS, is_board

path = sys.argv[1]
want = int(sys.argv[2])
recs = parse_file(path)
r = next(x for x in recs if x["i"] == want)
print("标题:", r["title"])
print("棋盘:")
for l in r["lines"]:
    print("   |" + l)
print("声明解法:", r["declared"], " 重放结果:", r["sol"], r["why"])

# 重新提取候选并展示原始行
lines = [l.rstrip("\r\n") for l in open(path, encoding="utf-8", errors="replace").read().splitlines()]
boards = []
i = 0
while i < len(lines):
    if is_board(lines[i]):
        j = i
        while j < len(lines) and is_board(lines[j]):
            j += 1
        boards.append((i, j - 1)); i = j
    else:
        i += 1
s, e = boards[want - 1]
nxt = boards[want][0] if want < len(boards) else len(lines)
print("\n--- 棋盘之后的窗口原文 ---")
for k in range(e + 1, nxt):
    t = lines[k]
    if t.strip():
        print(f"  {k+1:5d}| {t[:100]}")

# 逐帧轨迹
H, W, walls, goals, boxes, player = parse_state(r["lines"])
print("\n--- 轨迹（前 60 步）---")
mv = None
for cand, a, b in [(c, d["moves"], d["pushes"]) for c in ["x"] for d in r["declared"]]:
    pass
print(f"初始 玩家{player} 箱子{sorted(boxes)} 目标{sorted(goals)}")
