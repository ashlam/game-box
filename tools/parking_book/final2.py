#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
停车场华容道 读盘 最终版 v2：
  tiling3 拼铺（竖边界亮缝 + 横边界暗线 证据）得到车辆 + 单格(出口标记)
  出口：标记所在列/行 = 警车线；方向看标记贴哪条边 / 箭头斜率
  警车：该线上饱和度最低的车
输出 boards2.json
"""
import sys, json, os, glob
import numpy as np
from PIL import Image
from scipy import ndimage
import tiling3 as T

N = 6; S = 120
DIR = "/opt/data/parking_grid/out/levels"


def rgb_of(val, sat, clean, cells):
    xs = []; ys = []
    for (r, c) in cells:
        ys += [int(r * S), int((r + 1) * S)]
        xs += [int(c * S), int((c + 1) * S)]
    y0, y1, x0, x1 = min(ys), max(ys), min(xs), max(xs)
    px = clean[y0:y1, x0:x1].reshape(-1, 3)
    s = px.max(1) - px.min(1)
    colpx = px[s > 55]
    if len(colpx) > 40:
        return [int(v) for v in np.median(colpx, 0)], float(s.mean())
    return [int(v) for v in np.median(px, 0)], float(s.mean())


def board(path):
    clean, val, sat, occ = T.prep(path)
    sols, cost, ev = T.solve(val, sat, occ)
    best = sols[0]
    cars = []; 
    for ori, st in best[0]:
        rgb, dsat = rgb_of(val, sat, clean, st)
        cars.append(dict(ori=ori, length=len(st), row=st[0][0], col=st[0][1],
                         cells=st, rgb=rgb, dsat=round(dsat, 1)))
    singles = best[1]
    return clean, val, sat, occ, cars, singles, cost(best)


def marker_cell(clean, val, cars, occ, singles):
    if len(singles) == 1:
        s = singles[0]
        # 单格=标记所在格，方向另用暗块斜率判（见下）
        blob = marker_shape(val, cars, occ, singles)
        return (s, blob, "singleton")
    blob = marker_shape(val, cars, occ, singles)
    if blob is None:
        return (None, None, "none")
    cell = (int(blob["cy"]), int(blob["cx"]))
    return (cell, blob, "darkblob")


def marker_shape(val, cars, occ, singles):
    carpx = np.zeros(val.shape, bool)
    for c in cars:
        for (r, cc) in c["cells"]:
            carpx[int(r * S - 5):int((r + 1) * S + 5), int(cc * S - 5):int((cc + 1) * S + 5)] = True
    dk = (val < 140) & (~carpx)
    m = 5
    dk[:m, :] = dk[-m:, :] = dk[:, :m] = dk[:, -m:] = False
    lab, n = ndimage.label(dk, structure=np.ones((3, 3), int))
    free = set(singles) | (set((r, c) for r in range(N) for c in range(N)) - set(occ))
    best = None
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        a = len(ys)
        if a < 150 or a > 7000: continue
        if ys.max() - ys.min() > 1.3 * S or xs.max() - xs.min() > 1.3 * S: continue
        cy = (ys.min() + ys.max() + 1) / 2 / S; cx = (xs.min() + xs.max() + 1) / 2 / S
        if (int(cy), int(cx)) not in free: continue
        rows = np.arange(ys.min(), ys.max() + 1)
        wid = np.array([(xs[ys == y].max() - xs[ys == y].min() + 1) if (ys == y).any() else 0 for y in rows], float)
        cols = np.arange(xs.min(), xs.max() + 1)
        hei = np.array([(ys[xs == x].max() - ys[xs == x].min() + 1) if (xs == x).any() else 0 for x in cols], float)
        sw = float(np.polyfit(rows, wid, 1)[0]) if len(rows) > 4 else 0.0
        sh = float(np.polyfit(cols, hei, 1)[0]) if len(cols) > 4 else 0.0
        if best is None or a > best["area"]:
            best = dict(area=a, cy=cy, cx=cx, sw=round(sw, 3), sh=round(sh, 3))
    return best


def run(ids, dump=None):
    out = {}
    for t in ids:
        path = os.path.join(DIR, "%s.png" % t)
        clean, val, sat, occ, cars, singles, costv = board(path)
        mcell, blobinfo, msrc = marker_cell(clean, val, cars, occ, singles)
        exit_ = None; pc = None; note = "ok"
        if mcell is None:
            note = "no-marker"
        else:
            mr, mc = mcell
            blob = blobinfo or {}
            sw = abs(blob.get("sw", 0.0)); sh = abs(blob.get("sh", 0.0))
            if max(sw, sh) > 0.30:                      # 箭头：用尖端方向
                if sw >= sh:
                    exit_ = "bottom" if blob["sw"] < 0 else "top"; line = "v"
                else:
                    exit_ = "right" if blob["sh"] < 0 else "left"; line = "h"
            else:                                        # 方框：按贴哪条边
                if mr < 1.4: exit_, line = "top", "v"
                elif mr > N - 1.4: exit_, line = "bottom", "v"
                elif mc < 1.4: exit_, line = "left", "h"
                elif mc > N - 1.4: exit_, line = "right", "h"
                else: exit_, line = None, ("v" if abs(mr - 2.5) >= abs(mc - 2.5) else "h")
            if line == "v":
                pool = [c for c in cars if c["ori"] == "v" and abs(c["col"] - mc) < 1.2]
            else:
                pool = [c for c in cars if c["ori"] == "h" and abs(c["row"] - mr) < 1.2]
            if exit_ is None and pool:                   # 位置判不出方向时，用该线上深色车 + 就近
                pass
            if pool:
                pool = sorted(pool, key=lambda c: c["dsat"])
                pc = pool[0]
                if len([c for c in pool if c["dsat"] <= 25]) > 1:
                    note = "multi-dark"
                # 若出口方向没定，用深色车位置与标记关系兜底
                if exit_ is None:
                    if line == "v":
                        exit_ = "bottom" if mr > (pc["row"] + pc["length"] / 2) else "top"
                    else:
                        exit_ = "right" if mc > (pc["col"] + pc["length"] / 2) else "left"
            else:
                note = "no-car-in-marker-line"
        if pc is None:
            if mcell is not None and note == "ok":
                note = "no-police"
        cars_ = []
        for c in cars:
            c["police"] = (c is pc)
            cars_.append(c)
        out[t] = dict(cars=cars_, singles=singles, marker=mcell, marker_src=msrc,
                      exit=exit_, note=note, occ_cost=costv,
                      mobile=len(cars) - (1 if pc else 0))
    if dump:
        json.dump(out, open(dump, "w"), ensure_ascii=False, default=str)
    return out


if __name__ == "__main__":
    ids = sys.argv[1:]
    if not ids or ids[0] == "--all":
        ids = ["%03d" % i for i in range(49, 361)]
    out = run(ids, dump="/opt/data/parking_grid/boards2.json")
    okc = sum(1 for v in out.values() if v["exit"] and v["note"] == "ok" and len(v["singles"]) == 1)
    print("总 %d · 出口明确+单一标记 %d" % (len(ids), okc))
    for t, v in out.items():
        print("  %s exit=%s note=%s 标记=%s(%s) 车=%d 单格=%d cost=%.0f" % (
            t, v["exit"], v["note"], v["marker"], v["marker_src"], len(v["cars"]), len(v["singles"]), v["occ_cost"]))
