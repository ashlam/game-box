#!/usr/bin/env python3
"""仓库番求解器 v3：死格预判 + 2x2 冻结死锁 + A*（盒子→目标最小代价匹配启发式）。

比 solver2 的朴素 BFS 快一到几个数量级，目标是把 12x13 / 12 箱这种密集盘面也啃下来。

三条设计要点：
1. **可采纳启发式** h = 盒子到目标的最小代价完美匹配
     · 单盒距离：从每个目标做 BFS（只挡墙）得到「盒子推到这里要几步」
     · 匹配：匈牙利算法求最小代价完美匹配（盒数 == 目标数）
     · 松弛假设「盒子互不干扰、每次推动代价 1」⇒ h 是剩余推动数的**下界**，
       所以 A* 仍然给出**推动数最优**解，不是近似。
2. **死格预判**（pull-reachability）：从目标反向「拉」箱子，能拉到的格子才是活格。
   落在死格上的箱子永远回不到任何目标 ⇒ 可以直接剪。反向传播规则：
   箱子现在在 Y（说明是被人从 X=Y-d 推到 Y 的），那当时玩家站在 X-d=Y-2d，
   所以要求 X 与 Y-2d 都不是墙。
3. **2x2 冻结块**：某个 2x2 四格全是「墙或箱子」时，其中的箱子四个方向都被堵死，
   再也动不了。若其中有箱子不在目标上 ⇒ 死局。
   两条剪枝都是「推到就再也回不来」的充分条件，属安全剪枝，不会剪掉有解的分支。

规则与游戏内 JS 完全一致（越界 = 墙）。
"""
import heapq
import time
from collections import deque

DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]
DIRCH = {(-1, 0): 'U', (1, 0): 'D', (0, -1): 'L', (0, 1): 'R'}
BIG = 10 ** 6


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
    if not boxes:
        raise ValueError("没有箱子")
    if len(boxes) != len(goals):
        raise ValueError(f"箱子数 {len(boxes)} != 目标数 {len(goals)}")
    return H, W, frozenset(walls), frozenset(goals), frozenset(boxes), player


def free_cells(walls, H, W):
    return [(r, c) for r in range(H) for c in range(W) if (r, c) not in walls]


# ---------- 死格预判 ----------
def pull_reachable(walls, goals, H, W):
    """从目标反向拉箱子能到达的所有格子（活格）。"""
    good = set(goals)
    stack = list(goals)
    while stack:
        y = stack.pop()
        for dr, dc in DIRS:
            x = (y[0] - dr, y[1] - dc)          # 箱子推动前的位置
            stand = (y[0] - 2 * dr, y[1] - 2 * dc)  # 当时玩家站的位置
            if x in walls or x in good:
                continue
            if stand[0] < 0 or stand[0] >= H or stand[1] < 0 or stand[1] >= W or stand in walls:
                continue
            good.add(x)
            stack.append(x)
    return good


def bfs_dist(start, walls, H, W):
    """从 start 出发、只挡墙的最短步数表（值 = 盒子要走的推动次数）。"""
    dist = {start: 0}
    q = deque([start])
    while q:
        r, c = q.popleft()
        for dr, dc in DIRS:
            n = (r + dr, c + dc)
            if 0 <= n[0] < H and 0 <= n[1] < W and n not in walls and n not in dist:
                dist[n] = dist[(r, c)] + 1
                q.append(n)
    return dist


# ---------- 匈牙利算法（最小代价完美匹配，方阵） ----------
def hungarian(a):
    """经典 O(n^3) 实现（e-maxx 版）。a 为 n x n 代价矩阵，返回最小总代价。"""
    n = len(a)
    INF = float('inf')
    u = [0] * (n + 1)
    v = [0] * (n + 1)
    p = [0] * (n + 1)
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [INF] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = INF
            j1 = -1
            for j in range(1, n + 1):
                if not used[j]:
                    cur = a[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    return -v[0]


class Solver:
    def __init__(self, lines):
        self.H, self.W, self.walls, self.goals, self.boxes0, self.player0 = parse(lines)
        self.alive = pull_reachable(self.walls, self.goals, self.H, self.W)
        self.goal_list = sorted(self.goals)
        # 每个目标到各格的距离表（盒子视角）
        self.gdist = [bfs_dist(g, self.walls, self.H, self.W) for g in self.goal_list]
        self.goal_dirs = {g: [d for d in DIRS] for g in self.goals}
        # 箱子到最近目标的距离（快速下界，也用于死格判断）
        self.min_goal_dist = {}
        for cell in free_cells(self.walls, self.H, self.W):
            self.min_goal_dist[cell] = min((d.get(cell, BIG) for d in self.gdist), default=BIG)
        # ★ 缓存：同一组箱子布局会在不同玩家区域下反复出现，启发式和区域都值得缓存
        self.hcache = {}
        self.rcache = {}

    # ---------- 剪枝 ----------
    def box_dead(self, bs):
        for b in bs:
            if b not in self.goals and b not in self.alive:
                return True
        return False

    def frozen_2x2(self, bs):
        """2x2 四格全是墙或箱子 ⇒ 其中的箱子永久卡死。若含非目标箱则死局。"""
        for (r, c) in bs:
            for dr in (0, -1):
                for dc in (0, -1):
                    sq = [(r + dr, c + dc), (r + dr, c + dc + 1),
                          (r + dr + 1, c + dc), (r + dr + 1, c + dc + 1)]
                    boxes_in = [p for p in sq if p in bs]
                    if not boxes_in:
                        continue
                    if all(p in self.walls or p in bs for p in sq):
                        if any(p not in self.goals for p in boxes_in):
                            return True
        return False

    def heuristic(self, bs):
        hit = self.hcache.get(bs)
        if hit is not None:
            return hit
        if len(bs) == 1:
            b = next(iter(bs))
            val = min((self.gdist[j].get(b, BIG) for j in range(len(self.goal_list))), default=BIG)
        else:
            mat = []
            for b in bs:
                mat.append([self.gdist[j].get(b, BIG) for j in range(len(self.goal_list))])
            val = hungarian(mat)
        self.hcache[bs] = val
        return val

    # ---------- 玩家连通区域（箱子与墙为障碍） ----------
    def region(self, start, bs):
        ck = (bs, start)
        hit = self.rcache.get(ck)
        if hit is not None:
            return hit
        seen = {start}
        stack = [start]
        while stack:
            r, c = stack.pop()
            for dr, dc in DIRS:
                n = (r + dr, c + dc)
                if 0 <= n[0] < self.H and 0 <= n[1] < self.W and n not in self.walls \
                        and n not in bs and n not in seen:
                    seen.add(n)
                    stack.append(n)
        out = frozenset(seen)
        self.rcache[ck] = out
        return out

    def region_min(self, start, bs):
        """该起点所在连通分量的规范化代表（分量最小值）。"""
        ck = (bs, start)
        hit = self.rcache.get(ck)
        if hit is not None:
            return min(hit)
        return min(self.region(start, bs))

    def is_solved(self, bs):
        return bs == self.goals

    # ---------- A* ----------
    def solve(self, time_budget=None, max_states=2_000_000, weight=1.0):
        """weight=1 为可采纳 A*（推动数最优）；weight>1 为加权 A*（快但非最优）；
        weight=None 为纯贪心（f=h，最快，只保证找到解不保证最优）。"""
        t0 = time.time()
        bs0 = frozenset(self.boxes0)
        if self.is_solved(bs0):
            return 0, '', 0, 0.0
        if self.box_dead(bs0) or self.frozen_2x2(bs0):
            return 'dead', '', 0, 0.0
        h0 = self.heuristic(bs0)
        if h0 >= BIG:
            return 'dead', '', 0, 0.0

        def F(g, h):
            return h if weight is None else g + weight * h

        start_key = (bs0, self.region_min(self.player0, bs0))
        pq = [(F(0, h0), 0, bs0, self.player0, start_key)]
        best_g = {start_key: 0}
        parent = {start_key: None}          # nkey -> (父 nkey, 箱子起点, 箱子终点, 推前玩家位置)
        n = 0
        goal_key = None
        while pq:
            f, g, bs, p, key = heapq.heappop(pq)
            if best_g.get(key, 1 << 30) < g:
                continue
            n += 1
            if n > max_states:
                return 'timeout', '', n, time.time() - t0
            if time_budget and n % 200 == 0 and time.time() - t0 > time_budget:
                return 'timeout', '', n, time.time() - t0
            reg = self.region(p, bs)
            for b in bs:
                for dr, dc in DIRS:
                    ahead = (b[0] + dr, b[1] + dc)
                    behind = (b[0] - dr, b[1] - dc)
                    if ahead in self.walls or ahead in bs:
                        continue
                    if behind not in reg:
                        continue
                    nbs = frozenset((bs - {b}) | {ahead})
                    if self.box_dead(nbs) or self.frozen_2x2(nbs):
                        continue
                    nkey = (nbs, self.region_min(b, nbs))
                    ng = g + 1
                    if best_g.get(nkey, 1 << 30) <= ng:
                        continue
                    best_g[nkey] = ng
                    parent[nkey] = (key, b, ahead, p)
                    if self.is_solved(nbs):
                        goal_key = nkey
                        pq = []
                        break
                    hh = self.heuristic(nbs)
                    if hh >= BIG:
                        continue
                    heapq.heappush(pq, (F(ng, hh), ng, nbs, b, nkey))
                if goal_key:
                    break
        if goal_key is not None:
            return best_g[goal_key], self.reconstruct(parent, goal_key), n, time.time() - t0
        return 'dead', '', n, time.time() - t0

    @staticmethod
    def reconstruct(parent, goal_key):
        """沿父指针回溯，还原推动序列 [(箱子起点, 方向), ...]。"""
        chain = []
        cur = goal_key
        while parent.get(cur) is not None:
            prev_key, bfrom, bto, _player = parent[cur]
            chain.append((bfrom, (bto[0] - bfrom[0], bto[1] - bfrom[1])))
            cur = prev_key
        chain.reverse()
        return chain


def moves_from_pushes(lines, pushes, start_player=None):
    """把「推动序列」展开成完整按键串：每步先 BFS 走位到箱后，再推。"""
    H, W, walls, goals, boxes, player = parse(lines)
    boxes = set(boxes)
    p = start_player if start_player is not None else player
    out = []

    def bfs_path(src, dst, blocked):
        if src == dst:
            return []
        prev = {src: None}
        q = deque([src])
        while q:
            r, c = q.popleft()
            for d in DIRS:
                n = (r + d[0], c + d[1])
                if n in prev or n in walls or n in blocked:
                    continue
                if not (0 <= n[0] < H and 0 <= n[1] < W):
                    continue
                prev[n] = ((r, c), d)
                if n == dst:
                    path = []
                    cur = n
                    while prev[cur]:
                        pp, dd = prev[cur]
                        path.append(DIRCH[dd])
                        cur = pp
                    return path[::-1]
                q.append(n)
        return None

    for bfrom, d in pushes:
        stand = (bfrom[0] - d[0], bfrom[1] - d[1])
        path = bfs_path(p, stand, boxes)
        if path is None:
            return None
        out.extend(path)
        # 推
        out.append(DIRCH[d])
        boxes.discard(bfrom)
        boxes.add((bfrom[0] + d[0], bfrom[1] + d[1]))
        p = bfrom
    return ''.join(out)


def solve_level(lines, time_budget=None, max_states=2_000_000, weight=1.0):
    """返回 dict：pushes / moves / sol / states / secs / status / optimal"""
    s = Solver(lines)
    pushes, chain, states, secs = s.solve(time_budget=time_budget, max_states=max_states, weight=weight)
    if isinstance(pushes, str):
        return {'status': pushes, 'states': states, 'secs': secs}
    ms = moves_from_pushes(lines, chain)
    if ms is None:
        return {'status': 'replay-failed', 'pushes': pushes, 'states': states, 'secs': secs}
    return {'status': 'ok', 'pushes': pushes, 'moves': len(ms), 'sol': ms,
            'states': states, 'secs': secs, 'optimal': weight == 1.0}


if __name__ == '__main__':
    import sys
    lines = [l.rstrip('\n') for l in open(sys.argv[1], encoding='utf-8')]
    budget = float(sys.argv[2]) if len(sys.argv) > 2 else None
    print(solve_level(lines, time_budget=budget))
