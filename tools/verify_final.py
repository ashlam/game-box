#!/usr/bin/env python3
"""严格规则终检：越界 = 墙（与游戏里 JS 的行为完全一致），BFS 确认可解并给出最短推动数。
外加渲染检查：确保不存在多余的外围空白格（避免手机上一堆无意义方格）。"""
import json, sys
from collections import deque

DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]

def parse(lines):
    lines = list(lines)
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
            elif ch == ' ': pass
            else: raise ValueError(f"非法字符 {ch!r} @({r},{c})")
    return grid, H, W, walls, goals, frozenset(boxes), player

def inside(p, H, W):
    return 0 <= p[0] < H and 0 <= p[1] < W

def strict_solve(lines, limit=800000):
    grid, H, W, walls, goals, boxes, player = parse(lines)
    start = (player, boxes)
    if boxes == goals: return {"solvable": True, "pushes": 0}
    seen = {start}; q = deque([(player, boxes, 0)]); n = 0
    while q:
        p, bs, d = q.popleft(); n += 1
        if n > limit: return {"solvable": None, "reason": "搜索超限"}
        for dr, dc in DIRS:
            np = (p[0]+dr, p[1]+dc)
            if not inside(np, H, W) or np in walls: continue
            if np in bs:
                bp = (np[0]+dr, np[1]+dc)
                if not inside(bp, H, W) or bp in walls or bp in bs: continue
                nbs = frozenset((bs - {np}) | {bp})
                if nbs == goals: return {"solvable": True, "pushes": d+1}
                k = (np, nbs)
                if k not in seen: seen.add(k); q.append((np, nbs, d+1))
            else:
                k = (np, bs)
                if k not in seen: seen.add(k); q.append((np, bs, d))
    return {"solvable": False}

def render_check(lines):
    """找出「会被画成地板、但其实在房间外面」的格子。"""
    width = max(len(l) for l in lines)
    grid = [l.ljust(width) for l in lines]
    H, W = len(grid), width
    bad = []
    for r in range(H):
        for c in range(W):
            if grid[r][c] != ' ': continue
            nbr_wall = any(0 <= r+dr < H and 0 <= c+dc < W and grid[r+dr][c+dc] == '#'
                           for dr, dc in DIRS)
            if not nbr_wall:
                # 二阶：周围一圈是否有被三面墙围住的实心地板
                solid = False
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        rr, cc = r+dr, c+dc
                        if not (0 <= rr < H and 0 <= cc < W) or grid[rr][cc] == '#': continue
                        cnt = sum(1 for a, b in DIRS
                                  if 0 <= rr+a < H and 0 <= cc+b < W and grid[rr+a][cc+b] == '#')
                        if cnt >= 2: solid = True
                if not solid: bad.append((r, c))
    return bad

if __name__ == '__main__':
    levels = json.load(open(sys.argv[1]))
    ok = True
    for i, lv in enumerate(levels, 1):
        lines = lv["lines"] if isinstance(lv, dict) else lv
        r = strict_solve(lines)
        bad = render_check(lines)
        status = "✅" if r.get("solvable") else ("⚠️ " if r.get("solvable") is None else "❌")
        if not r.get("solvable"): ok = False
        print(f"{status} 第{i:2d}关  严格最短推动={r.get('pushes','-')}  "
              f"箱子={sum(x.count('$')+x.count('*') for x in lines)}  "
              f"游离空格={len(bad)}{' ' + str(bad[:4]) if bad else ''}")
    print("\n结论：" + ("全部可解 ✔" if ok else "存在无解关卡 ✘"))
