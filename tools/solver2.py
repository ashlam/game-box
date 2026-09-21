#!/usr/bin/env python3
"""仓库番「推进式」最优求解器：区域归一化 + 简单死锁剪枝。
比全状态 BFS 快几个数量级，能处理经典大关。返回最少推动数。
规则与游戏内 JS 完全一致：越界 = 墙。
"""
import heapq
from collections import deque

DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


def parse(lines):
    width = max(len(l) for l in lines)
    grid = [l.ljust(width) for l in lines]
    H, W = len(grid), width
    walls, goals, boxes, player = set(), set(), set(), None
    for r in range(H):
        for c in range(W):
            ch = grid[r][c]
            if ch == '#':
                walls.add((r, c))
            elif ch == '.':
                goals.add((r, c))
            elif ch == '$':
                boxes.add((r, c))
            elif ch == '*':
                boxes.add((r, c)); goals.add((r, c))
            elif ch == '@':
                player = (r, c)
            elif ch == '+':
                player = (r, c); goals.add((r, c))
            elif ch != ' ':
                raise ValueError(f"非法字符 {ch!r} @({r},{c})")
    if player is None:
        raise ValueError("缺少玩家")
    if len(boxes) != len(goals):
        raise ValueError(f"箱子数 {len(boxes)} != 目标数 {len(goals)}")
    return H, W, frozenset(walls), frozenset(goals), frozenset(boxes), player


def region_of(start, boxes, walls, H, W):
    """玩家从 start 出发（箱子为障碍）能走到的所有格子。"""
    seen = {start}
    stack = [start]
    while stack:
        r, c = stack.pop()
        for dr, dc in DIRS:
            n = (r + dr, c + dc)
            if 0 <= n[0] < H and 0 <= n[1] < W and n not in walls and n not in boxes and n not in seen:
                seen.add(n); stack.append(n)
    return frozenset(seen)


def deadlock_corner(box, boxes, walls, goals):
    """箱子被推进死角（非目标）即判死。"""
    if box in goals:
        return False
    r, c = box
    up = (r - 1, c) in walls
    down = (r + 1, c) in walls
    left = (r, c - 1) in walls
    right = (r, c + 1) in walls
    if (up or down) and (left or right):
        return True
    return False


def min_pushes(lines, limit=1_500_000, time_budget=None):
    """返回 (最少推动数, 搜索状态数)；无解返回 (None, n)，超预算返回 ('timeout', n)。
    time_budget: 秒数上限，超时返回 ('timeout', n)。"""
    import time
    t0 = time.time()
    H, W, walls, goals, boxes, player = parse(lines)
    if boxes == goals:
        return 0, 0
    start = (boxes, min(region_of(player, boxes, walls, H, W)))
    seen = {start}
    q = deque([(boxes, player, 0)])
    n = 0
    while q:
        bs, p, d = q.popleft()
        n += 1
        if n > limit:
            return "timeout", n
        if time_budget and n % 500 == 0 and time.time() - t0 > time_budget:
            return "timeout", n
        reg = region_of(p, bs, walls, H, W)
        for b in bs:
            for dr, dc in DIRS:
                ahead = (b[0] + dr, b[1] + dc)
                behind = (b[0] - dr, b[1] - dc)
                if ahead in walls or ahead in bs:
                    continue
                if behind not in reg:
                    continue
                nbs = frozenset((bs - {b}) | {ahead})
                if deadlock_corner(ahead, nbs, walls, goals):
                    continue
                if nbs == goals:
                    return d + 1, n
                np_ = b                                  # 推完玩家站在箱子原位
                key = (nbs, min(region_of(np_, nbs, walls, H, W)))
                if key not in seen:
                    seen.add(key)
                    q.append((nbs, np_, d + 1))
    return None, n


def deadlock_corner(box, boxes, walls, goals):
    """箱子被推进死角（非目标）即判死。"""
    if box in goals:
        return False
    r, c = box
    up = (r - 1, c) in walls
    down = (r + 1, c) in walls
    left = (r, c - 1) in walls
    right = (r, c + 1) in walls
    if (up or down) and (left or right):
        return True
    return False


if __name__ == '__main__':
    import sys, time
    lines = [l.rstrip('\n') for l in open(sys.argv[1])]
    t = time.time()
    print(min_pushes(lines), f"{time.time()-t:.2f}s")
