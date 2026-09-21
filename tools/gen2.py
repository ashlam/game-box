#!/usr/bin/env python3
"""反向构造仓库番关卡：从「所有箱子已在目标上」的通关态倒着拉箱子，正向局面必然可解。
房间带封闭外墙（保证与游戏内「越界=墙」的规则一致），再用 BFS 量出最短推动数排难度。"""
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

def build_room(rng):
    """带封闭外墙的矩形房间，内部随机柱子（但地板必须连通）。"""
    h = rng.randint(5, 8); w = rng.randint(5, 8)
    walls = {(r, c) for r in range(h + 2) for c in range(w + 2)
             if r in (0, h + 1) or c in (0, w + 1)}
    for r in range(1, h + 1):
        for c in range(1, w + 1):
            if rng.random() < 0.15:
                walls.add((r, c))
    floor = {(r, c) for r in range(1, h + 1) for c in range(1, w + 1)} - walls
    if len(floor) < 14:
        return None
    if len(connected(floor, next(iter(floor)))) < len(floor):
        return None
    return walls, floor, h + 2, w + 2

def reverse_build(rng, boxes_n, target_pushes):
    room = build_room(rng)
    if not room:
        return None
    walls, floor, H, W = room
    fl = list(floor)
    if len(fl) < boxes_n * 3 + 3:
        return None
    spots = rng.sample(fl, boxes_n * 2)
    goals = set(spots[:boxes_n])
    boxes = set(goals)                     # 终局：箱子都在目标上
    player = rng.choice([c for c in fl if c not in boxes])

    done = steps = stalls = 0
    while done < target_pushes and steps < target_pushes * 40:
        steps += 1
        opts = []
        for d in DIRS:
            nb = (player[0] + d[0], player[1] + d[1])       # 相邻箱子
            back = (player[0] - d[0], player[1] - d[1])     # 拉完后玩家站位
            if nb in boxes and back in floor and back not in boxes:
                opts.append((nb, back))
        if opts and rng.random() < 0.55:
            nb, back = rng.choice(opts)
            boxes.discard(nb); boxes.add(player)
            player = back
            done += 1; stalls = 0
        else:
            cand = [c for c in [(player[0]+d[0], player[1]+d[1]) for d in DIRS]
                    if c in floor and c not in boxes]
            if not cand:
                stalls += 1
                if stalls > 40:
                    break
                continue
            player = rng.choice(cand)
    if done < 3 or boxes == goals:
        return None

    lines = []
    for r in range(H):
        row = []
        for c in range(W):
            p = (r, c)
            if p in walls: row.append('#')
            elif p in boxes and p in goals: row.append('*')
            elif p in boxes: row.append('$')
            elif p in goals: row.append('.')
            elif p == player: row.append('@')
            else: row.append(' ')
        lines.append(''.join(row))
    return lines

def main():
    rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 11)
    pool, tried = [], 0
    while len(pool) < 60 and tried < 3000:
        tried += 1
        nb = rng.choice([1, 2, 2, 3, 3, 4])
        lv = reverse_build(rng, nb, rng.randint(4, 8) * nb)
        if not lv:
            continue
        try:
            res = solve(lv, limit=600000)
        except Exception:
            continue
        if res.get("solvable") is not True:
            continue
        p = res["pushes"]
        if not (3 <= p <= 45):
            continue
        if any(tuple(x["lines"]) == tuple(lv) for x in pool):
            continue
        pool.append({"lines": lv, "boxes": nb, "pushes": p, "states": res["states"]})
    pool.sort(key=lambda x: x["pushes"])
    print(f"# 尝试 {tried}，得到 {len(pool)} 关，推动数 {[x['pushes'] for x in pool]}", file=sys.stderr)
    json.dump(pool, sys.stdout, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()
