#!/usr/bin/env python3
"""严格规则下求每个关卡的最优操作序列（含走路），供浏览器端自动通关测试使用。"""
import json, sys
from collections import deque

DIRS = [('U', -1, 0), ('D', 1, 0), ('L', 0, -1), ('R', 0, 1)]

def parse(lines):
    width = max(len(l) for l in lines)
    grid = [l.ljust(width) for l in lines]
    H, W = len(grid), width
    walls, goals, boxes, player = set(), set(), set(), None
    for r in range(H):
        for c in range(W):
            ch = grid[r][c]
            if ch == '#': walls.add((r, c))
            elif ch == '.': goals.add((r, c))
            elif ch == '$': boxes.add((r, c))
            elif ch == '*': boxes.add((r, c)); goals.add((r, c))
            elif ch == '@': player = (r, c)
            elif ch == '+': player = (r, c); goals.add((r, c))
    return H, W, walls, frozenset(goals), frozenset(boxes), player

def solution(lines, limit=800000):
    H, W, walls, goals, boxes, player = parse(lines)
    start = (player, boxes)
    if boxes == goals: return ""
    seen = {start}
    q = deque([(player, boxes, "")])
    n = 0
    while q:
        p, bs, path = q.popleft(); n += 1
        if n > limit: return None
        for name, dr, dc in DIRS:
            np = (p[0] + dr, p[1] + dc)
            if not (0 <= np[0] < H and 0 <= np[1] < W) or np in walls: continue
            if np in bs:
                bp = (np[0] + dr, np[1] + dc)
                if not (0 <= bp[0] < H and 0 <= bp[1] < W) or bp in walls or bp in bs: continue
                nbs = frozenset((bs - {np}) | {bp})
                if nbs == goals: return path + name
                k = (np, nbs)
                if k not in seen: seen.add(k); q.append((np, nbs, path + name))
            else:
                k = (np, bs)
                if k not in seen: seen.add(k); q.append((np, bs, path + name))
    return None

if __name__ == '__main__':
    levels = json.load(open(sys.argv[1]))
    out = []
    for i, lv in enumerate(levels, 1):
        lines = lv["lines"] if isinstance(lv, dict) else lv
        s = solution(lines)
        print(f"第{i:2d}关  解长度={len(s) if s else '-'}  {s if s and len(s) <= 60 else (s[:57]+'...' if s else '')}", file=sys.stderr)
        out.append(s)
    json.dump(out, sys.stdout)
