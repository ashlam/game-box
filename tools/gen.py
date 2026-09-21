#!/usr/bin/env python3
"""【已废弃 — 别用这个】纯随机布局生成器：实测 6000 个候选筛出 0 关（随机摆箱子几乎必然无解）。
请用 gen2.py（反向构造法：从通关态倒着拉箱子，数学上保证可解）。保留此文件仅作踩坑记录。"""

import json, random, sys
from collections import deque
from solver import solve

DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]

def connected(floor, start):
    seen = {start}; q = deque([start])
    while q:
        r, c = q.popleft()
        for dr, dc in DIRS:
            n = (r + dr, c + dc)
            if n in floor and n not in seen:
                seen.add(n); q.append(n)
    return seen

def gen(rng, nboxes):
    h = rng.randint(5, 9); w = rng.randint(5, 9)
    grid = [['#'] * (w + 2) for _ in range(h + 2)]
    for r in range(1, h + 1):
        for c in range(1, w + 1):
            if rng.random() < 0.16:
                grid[r][c] = '#'
    floor = {(r, c) for r in range(1, h + 1) for c in range(1, w + 1) if grid[r][c] == ' '}
    if len(floor) < 8 + nboxes * 2:
        return None
    # 地板必须连通（避免孤立小房间）
    fl = list(floor)
    if len(connected(floor, rng.choice(fl))) < len(floor) * 0.85:
        return None
    cells = rng.sample(fl, nboxes * 2)
    goals = set(cells[:nboxes]); boxes = set(cells[nboxes:])
    p = rng.choice([c for c in floor if c not in boxes])
    if not boxes <= connected(floor, p):
        return None
    # 起始不能已经有箱子在目标上
    if boxes & goals:
        return None
    lines = []
    for r in range(h + 2):
        row = []
        for c in range(w + 2):
            ch = grid[r][c]
            if (r, c) in boxes: ch = '$'
            elif (r, c) in goals: ch = '.'
            if (r, c) == p: ch = '@'
            row.append(ch)
        lines.append(''.join(row).rstrip())
    return lines

def main():
    rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 7)
    buckets = {1: [], 2: [], 3: [], 4: []}   # 按箱子数分桶
    tried = 0
    while sum(len(v) for v in buckets.values()) < 40 and tried < 6000:
        tried += 1
        nb = rng.choice([1, 1, 2, 2, 3, 4])
        lv = gen(rng, nb)
        if not lv:
            continue
        try:
            res = solve(lv, limit=400000)
        except Exception:
            continue
        if res.get("solvable") is not True:
            continue
        pushes = res["pushes"]
        if not (2 <= pushes <= 45):
            continue
        # 箱子数要够，长宽比别太极端
        key = tuple(lv)
        if any(key == tuple(x["lines"]) for v in buckets.values() for x in v):
            continue
        buckets[nb].append({"lines": lv, "boxes": nb, "pushes": pushes, "states": res["states"]})
    out = []
    for nb in [1, 1, 1, 2, 2, 2, 2, 3, 3, 4]:
        pool = sorted(buckets[nb], key=lambda x: x["pushes"])
        if not pool:
            continue
        # 每个箱子数档位里换着难度取，避免全是同一种
        take = pool[min(len(pool) - 1, rng.randint(0, max(0, len(pool) // 3)))]
        out.append(take)
        buckets[nb].remove(take)
    print(f"# 生成 {tried} 个候选，选出 {len(out)} 关", file=sys.stderr)
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()
