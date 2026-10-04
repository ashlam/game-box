#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
占用格 -> 车辆拼铺 v3
证据：
  竖边界（上下相邻）：异车之间有一线亮缝（亮占比高 ~0.5）；同车 ~0
  横边界（左右相邻）：异车之间有一条暗线（暗占比高）；同车 ~0（仅两侧车体都非纯黑时可用）
在全部合法拼铺里取「与证据最一致 + 单格最少」者。
"""
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage

N = 6; S = 120; OCC_TH = 178


def prep(path):
    a = np.asarray(Image.open(path).convert("RGB"), float)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    M = (R > 140) & (B > 140) & (G < 130)
    ind = ndimage.distance_transform_edt(M, return_distances=False, return_indices=True)
    clean = a[ind[0], ind[1]]
    val = clean.max(2); sat = clean.max(2) - clean.min(2)
    occ = set()
    for r in range(N):
        for c in range(N):
            sl = (slice(int(r * S + 22), int(r * S + 98)), slice(int(c * S + 22), int(c * S + 98)))
            if val[sl].mean() < OCC_TH:
                occ.add((r, c))
    return clean, val, sat, occ


def evidence(val, sat, r, c, dr, dc):
    """返回 'same' / 'diff' / None"""
    if dc == 1:      # 左右相邻：异车之间有一条【暗线】
        bx = int((c + 1) * S); ys = slice(int(r * S + 30), int((r + 1) * S - 30))
        band = val[ys, bx - 4:bx + 5]
        dark = float((band < 140).mean())
        vA = val[ys, int(c * S + 35):int(c * S + 90)].mean(); sA = sat[ys, int(c * S + 35):int(c * S + 90)].mean()
        vB = val[ys, int((c + 1) * S + 30):int((c + 1) * S + 85)].mean(); sB = sat[ys, int((c + 1) * S + 30):int((c + 1) * S + 85)].mean()
        if vA < 135 and sA < 45: return None
        if vB < 135 and sB < 45: return None
        if sA < 30 or sB < 30: return None      # 浅灰车（油罐车/银车）上也能看到车位线 → 不可用
        if dark > 0.6: return "diff"
        if dark < 0.35: return "same"
        return None
    else:            # 上下相邻：异车之间有一线【亮缝】
        by = int((r + 1) * S); xs = slice(int(c * S + 30), int((c + 1) * S - 30))
        band = val[by - 3:by + 4, xs]
        bright = float((band > 178).mean())
        if bright > 0.35: return "diff"
        if bright < 0.22: return "same"
        return None


def solve(val, sat, occ):
    cells = set(occ)
    ev = {}
    for (r, c) in cells:
        for (dr, dc) in ((0, 1), (1, 0)):
            n = (r + dr, c + dc)
            if n in cells:
                ev[((r, c), n)] = evidence(val, sat, r, c, dr, dc)
    # 邻接表
    nbr = {x: [] for x in cells}
    for (a, b) in ev:
        nbr[a].append(b); nbr[b].append(a)
    sys.setrecursionlimit(10000)
    best = [1e18, None]

    def rec(rem, cars, singles, assigned, costv):
        if costv >= best[0] - 1e-9:
            return
        if not rem:
            if costv < best[0]:
                best[0] = costv; best[1] = (list(cars), list(singles))
            return
        r, c = min(rem)

        def place(entry, newcells, addcost_bias):
            """entry=('h'/'v',strip) 或 None(单格)"""
            if entry is None:
                new = {c0_ := (r, c)} if False else {(r, c)}
                cell = (r, c)
                added = 0.0
                for b in nbr[cell]:
                    if b in assigned:            # 与已分配格不同车 → 期望 diff
                        e = ev.get((cell, b)) or ev.get((b, cell))
                        if e == "same": added += 1.0
                rec(rem - new, cars, singles + [cell], assigned | new, costv + added + 2.0)
            else:
                ori, st = entry
                new = set(st)
                added = 0.0
                for x in st:
                    for b in nbr[x]:
                        pair = (x, b) if (x, b) in ev else (b, x)
                        e = ev.get(pair)
                        if e is None: continue
                        if b in new:             # 同车内部 → 期望 same
                            if e == "diff": added += 1.0
                        elif b in assigned:      # 不同车 → 期望 diff
                            if e == "same": added += 1.0
                rec(rem - new, cars + [entry], singles, assigned | new, costv + added)
        for L in (3, 2):
            st = [(r, c + k) for k in range(L)]
            if all(x in rem for x in st): place(("h", st), st, 0)
        for L in (3, 2):
            st = [(r + k, c) for k in range(L)]
            if all(x in rem for x in st): place(("v", st), st, 0)
        place(None, [(r, c)], 0)
    rec(set(cells), [], [], set(), 0.0)
    sol = best[1]
    return ([sol], lambda s: best[0], ev) if sol else ([], lambda s: None, ev)


def render(sol):
    g = [["." for _ in range(N)] for _ in range(N)]
    for (r, c) in sol[1]:
        if 0 <= r < N and 0 <= c < N: g[r][c] = "#"
    names = iter(list("abcdefghijklmnopqrstuvwxyz"))
    for ori, st in sorted(sol[0], key=lambda x: x[1][0]):
        ch = next(names)
        for (r, c) in st:
            g[r][c] = ch
    return "\n".join("".join(x) for x in g)


if __name__ == "__main__":
    for t in (sys.argv[1:] or ["049"]):
        clean, val, sat, occ = prep("/opt/data/parking_grid/out/levels/%s.png" % t)
        sols, cost, ev = solve(val, sat, occ)
        print("=" * 44)
        print("%s 占用%d 解%d 最优=%.1f" % (t, len(occ), len(sols), cost(sols[0])))
        print(render(sols[0]))
        for k in range(1, min(2, len(sols))):
            print("  --- 次优%d  %.1f" % (k, cost(sols[k])))
            print("\n".join("     " + x for x in render(sols[k]).split("\n")))
