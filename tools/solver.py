#!/usr/bin/env python3
"""仓库番关卡验证器：BFS 求最短推动解，确认每关可解 + 统计难度。"""
import json, sys
from collections import deque

def parse(lines):
    lines = [l.rstrip('\n').replace('\t', '    ') for l in lines]
    width = max(len(l) for l in lines)
    lines = [l.ljust(width) for l in lines]
    walls, goals, boxes, player = set(), set(), set(), None
    for r, row in enumerate(lines):
        for c, ch in enumerate(row):
            if ch == '#': walls.add((r, c))
            elif ch == '.': goals.add((r, c))
            elif ch == '$': boxes.add((r, c))
            elif ch == '*': boxes.add((r, c)); goals.add((r, c))
            elif ch == '@': player = (r, c)
            elif ch == '+': player = (r, c); goals.add((r, c))
            elif ch == ' ': pass
            else: raise ValueError(f"非法字符 {ch!r} at ({r},{c})")
    assert player is not None, "没有玩家"
    assert len(boxes) == len(goals), f"箱子 {len(boxes)} != 目标 {len(goals)}"
    return walls, goals, frozenset(boxes), player, (len(lines), width)

DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]

def solve(lines, limit=4_000_000):
    walls, goals, boxes, player, dims = parse(lines)
    start = (player, boxes)
    if boxes == goals:
        return {"solvable": True, "pushes": 0, "states": 0}
    seen = {start}
    q = deque([(player, boxes, 0)])
    states = 0
    while q:
        p, bs, d = q.popleft()
        states += 1
        if states > limit:
            return {"solvable": None, "reason": "搜索超限", "states": states}
        for dr, dc in DIRS:
            np = (p[0] + dr, p[1] + dc)
            if np in walls:
                continue
            if np in bs:
                bp = (np[0] + dr, np[1] + dc)
                if bp in walls or bp in bs:
                    continue
                nbs = frozenset((bs - {np}) | {bp})
                if nbs == goals:
                    return {"solvable": True, "pushes": d + 1, "states": states}
                key = (np, nbs)
                if key not in seen:
                    seen.add(key); q.append((np, nbs, d + 1))
            else:
                key = (np, bs)
                if key not in seen:
                    seen.add(key); q.append((np, bs, d))
    return {"solvable": False, "states": states}

if __name__ == '__main__':
    levels = json.load(open(sys.argv[1]))
    for i, lv in enumerate(levels, 1):
        try:
            r = solve(lv)
        except Exception as e:
            r = {"solvable": None, "reason": f"解析错误: {e}"}
        flag = "✅" if r.get("solvable") else ("⚠️ " if r.get("solvable") is None else "❌ 无解")
        print(f"{flag} 第{i:2d}关  尺寸={len(lv)}x{max(len(x) for x in lv)}  最短推动={r.get('pushes','-')}  搜索态={r.get('states')} {r.get('reason','')}")
