#!/usr/bin/env python3
"""
停车场关卡册照片 -> 结构化棋盘图 提取工具 (v6)
流程：
  1) 竖幅照片自动转正
  2) 暗点掩膜连通域(膨胀桥接)粗定位每块棋盘 -> 按页 4xN 分槽
  3) 每槽在“未膨胀”掩膜里找该黑框自身的连通域 -> 取其四点(精确、不含题号文字)
  4) 缺检/碎框的槽位，用同行或同列已定位棋盘的四边形按格距平移补出
  5) 四点透视校正成方图 -> 检测印刷格线精确定位 -> 裁成方图并叠 6x6 格线
用法： python extract.py --all   |   python extract.py <照片路径>
"""
import os, sys, glob, json, shutil
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
SRC = "/volume1/docker/hermes/files/bot_workspace/tmp/parking"
OUTROOT = "/opt/data/parking_grid/out"
THRESH = 100
MID, SIDE, N = 1200, 720, 6
MINB, MAXB = 170, 900
TOL = 80


def quad_corners(m):
    ys, xs = np.nonzero(m)
    s = xs + ys
    d = xs - ys
    return [(float(xs[np.argmin(s)]), float(ys[np.argmin(s)])),
            (float(xs[np.argmax(d)]), float(ys[np.argmax(d)])),
            (float(xs[np.argmax(s)]), float(ys[np.argmax(s)])),
            (float(xs[np.argmin(d)]), float(ys[np.argmin(d)]))]


def dst2src(dst, src):
    A, B = [], []
    for (xo, yo), (xi, yi) in zip(dst, src):
        A.append([xo, yo, 1, 0, 0, 0, -xi * xo, -xi * yo])
        A.append([0, 0, 0, xo, yo, 1, -yi * xo, -yi * yo])
        B += [xi, yi]
    return tuple(np.linalg.solve(np.asarray(A, float), np.asarray(B, float)).tolist())


def cluster_k(vals, tol=TOL, kmax=4):
    order = np.argsort(vals)
    groups, cur = [], [order[0]]
    for k in order[1:]:
        if vals[k] - vals[cur[-1]] <= tol:
            cur.append(k)
        else:
            groups.append(cur); cur = [k]
    groups.append(cur)
    g = [{"idx": list(x)} for x in groups]
    while len(g) > kmax:
        c = [float(np.mean(vals[x["idx"]])) for x in g]
        j = int(np.argmin([c[i + 1] - c[i] for i in range(len(g) - 1)]))
        g[j]["idx"] += g[j + 1]["idx"]
        del g[j + 1]
    for x in g:
        x["c"] = float(np.mean(vals[x["idx"]]))
    return sorted(g, key=lambda x: x["c"])


def detect(a, bridge):
    mask = a < THRESH
    big = ndimage.binary_dilation(mask, iterations=bridge) if bridge else mask
    lab, n = ndimage.label(big)
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if not (MINB <= w <= MAXB and MINB <= h <= MAXB):
            continue
        if max(w, h) / min(w, h) > 1.7:
            continue
        sub = mask[sl] & (lab[sl] == i)
        if sub.sum() == 0:
            continue
        yy, xx = np.nonzero(sub)
        y0, x0 = sl[0].start + int(yy.min()), sl[1].start + int(xx.min())
        y1, x1 = sl[0].start + int(yy.max()) + 1, sl[1].start + int(xx.max()) + 1
        w, h = x1 - x0, y1 - y0
        if not (MINB <= w <= MAXB and MINB <= h <= MAXB):
            continue
        fill = sub.sum() / float(w * h)
        if fill < 0.012 or fill > 0.45:
            continue
        m = np.zeros_like(lab, bool)
        m[sl] = sub
        out.append({"id": i, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "w": w, "h": h,
                    "cx": (x0 + x1) / 2.0, "cy": (y0 + y1) / 2.0, "mask": m})
    return lab, out


def dark_profile(rgb):
    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    dark = (mx < 178) & ((mx - mn) < 45)
    dark &= ~ndimage.binary_dilation((mx - mn) >= 45, iterations=6)
    v = ndimage.binary_opening(dark, structure=np.ones((25, 1), bool))
    h = ndimage.binary_opening(dark, structure=np.ones((1, 25), bool))
    return v.sum(axis=0).astype(np.float32), h.sum(axis=1).astype(np.float32)


def fit_grid(prof, span=10):
    p = np.convolve(prof.astype(np.float32), np.ones(7) / 7, mode="same")
    n = len(p)
    ii = np.arange(N + 1, dtype=float)
    best, ba, bs = -1.0, None, None
    for s in np.arange(0.86 * MID / N, 1.02 * MID / N, 1.0):
        av = np.arange(0, MID - N * s - 1, 1.0)
        if av.size == 0:
            continue
        idx = np.round(av[:, None] + ii[None, :] * s).astype(int)
        sc = p[idx].sum(axis=1)
        j = int(np.argmax(sc))
        if sc[j] > best:
            best, ba, bs = float(sc[j]), float(av[j]), float(s)
    if ba is None:
        return MID * 0.02, MID / N * 0.95, False
    pos = []
    for i in range(N + 1):
        e = ba + i * bs
        lo, hi = max(0, int(round(e - span))), min(n, int(round(e + span)) + 1)
        if hi - lo < 5:
            return ba, bs, False
        pos.append(lo + int(np.argmax(p[lo:hi])))
    pos = np.asarray(pos, float)
    i = np.arange(N + 1, dtype=float)
    s, a = np.polyfit(i, pos, 1)
    res = np.abs(pos - (a + s * i))
    if res.max() > 8:
        keep = np.argsort(res)[:-1]
        s, a = np.polyfit(i[keep], pos[keep], 1)
        res = np.abs(pos - (a + s * i))
    ok = (0.88 * MID / N < s < 1.04 * MID / N and -25 < a < MID and a + N * s < MID + 25 and res.mean() < 9)
    return float(a), float(s), bool(ok)


def render(rgb, corners, path, save):
    A = rgb.transform((MID, MID), Image.PERSPECTIVE,
                      dst2src([(0, 0), (MID, 0), (MID, MID), (0, MID)], corners), Image.BICUBIC)
    cp, rp = dark_profile(np.asarray(A, dtype=np.uint8))
    ax, sx, okx = fit_grid(cp)
    ay, sy, oky = fit_grid(rp)
    s = (sx + sy) / 2.0
    if not (okx and oky):
        s = MID / float(N) * 0.95
        ax = ay = (MID - N * s) / 2.0
    L, T = max(0, int(round(ax))), max(0, int(round(ay)))
    R, B = min(MID, int(round(ax + N * s))), min(MID, int(round(ay + N * s)))
    C = A.crop((L, T, R, B)).resize((SIDE, SIDE), Image.LANCZOS)
    d = ImageDraw.Draw(C)
    st = SIDE / float(N)
    for i in range(1, N):
        q = i * st
        d.line([(q, 0), (q, SIDE)], fill=(255, 0, 255), width=2)
        d.line([(0, q), (SIDE, q)], fill=(255, 0, 255), width=2)
    d.rectangle([1, 1, SIDE - 2, SIDE - 2], outline=(0, 200, 255), width=3)
    if save:
        C.save(path)
    return bool(okx and oky), round(s, 1)


def shift_quad(q, dx, dy):
    return [(x + dx, y + dy) for (x, y) in q]


def process_photo(path, tag, save=True):
    im = Image.open(path)
    if im.size[1] > im.size[0]:
        im = im.transpose(Image.ROTATE_90)
    W, H = im.size
    a = np.asarray(im.convert("L"))
    rgb = im.convert("RGB")
    _, b5 = detect(a, 5)          # 齐全（含题号），用来分槽
    _, b0 = detect(a, 0)          # 精确分量（框），用来取四点
    outdir = os.path.join(OUTROOT, tag)
    if save:
        if os.path.isdir(outdir):
            shutil.rmtree(outdir)
        os.makedirs(outdir, exist_ok=True)
    res = []
    k = 0
    for page in (0, 1):
        lo, hi = page * W / 2, (page + 1) * W / 2
        pg5 = [b for b in b5 if lo <= b["cx"] < hi]
        if len(pg5) < 6:
            continue
        rows = cluster_k(np.array([b["y0"] for b in pg5], float), kmax=4)
        cols = cluster_k(np.array([b["x0"] for b in pg5], float), kmax=4)
        if len(pg5) >= 12:                       # 该页应有 4 行：聚类不足时收紧阈值重试
            for t in (TOL, 55, 40, 30):
                rows2 = cluster_k(np.array([b["y0"] for b in pg5], float), tol=t, kmax=4)
                if len(rows2) > len(rows):
                    rows = rows2
                if len(rows) == 4:
                    break
        if len(cols) != 4 or len(rows) < 2:
            continue
        med_w = float(np.percentile([b["w"] for b in pg5], 70))
        # 第一轮：每槽找最完整的“未膨胀”黑框分量
        pick = {}
        slot5 = {}
        for r, row in enumerate(rows):
            for c, col in enumerate(cols):
                cand = [b for b in pg5
                        if abs(b["y0"] - row["c"]) < TOL and abs(b["x0"] - col["c"]) < TOL]
                if not cand:
                    continue
                b = max(cand, key=lambda t: t["w"] * t["h"])
                slot5[(r, c)] = b
                inner = [x for x in b0 if b["x0"] - 10 <= x["x0"] and x["x1"] <= b["x1"] + 10
                         and b["y0"] - 10 <= x["y0"] and x["y1"] <= b["y1"] + 10]
                if inner:
                    pick[(r, c)] = max(inner, key=lambda t: t["w"] * t["h"])
        # 每列取“正常尺寸”参考（同列内互相比较，抵消透视带来的列间差异）
        ref = {}
        for c in range(4):
            ws = [v["w"] for (r, cc), v in pick.items() if cc == c]
            if ws:
                ref[c] = float(np.median(ws))
        # 参考尺寸用全页中位数（同一页透视差异约 ±20%，给 ±40% 容差；过小的碎片即被剔除）
        allw = [v["w"] for v in pick.values()]
        refg = float(np.median(allw)) if allw else 0.0
        quads = {}
        for (r, c), q in pick.items():
            if 0.72 * refg < q["w"] < 1.45 * refg and q["h"] > 0.80 * q["w"]:
                quads[(r, c)] = quad_corners(q["mask"])
        # 每列高宽比参考（棋盘框在照片里是竖长矩形）
        kcol = {}
        for c in range(4):
            ks = []
            for (r, cc), qd in quads.items():
                if cc != c:
                    continue
                wq = np.hypot(qd[1][0] - qd[0][0], qd[1][1] - qd[0][1])
                hq = np.hypot(qd[3][0] - qd[0][0], qd[3][1] - qd[0][1])
                if wq > 10:
                    ks.append(hq / wq)
            kcol[c] = float(np.median(ks)) if ks else 1.25
        # 尺寸不合格或未检出：用该槽“含题号”分量的上边（可靠）+ 列高宽比推出整框
        for (r, c), b in slot5.items():
            if (r, c) in quads:
                continue
            q5 = quad_corners(b["mask"])
            tl = np.array(q5[0]); tr = np.array(q5[1])
            wq = np.hypot(*(tr - tl))
            if wq < 0.72 * refg:
                continue
            d = np.array([-(tr - tl)[1], (tr - tl)[0]])
            d = d / (np.hypot(*d) + 1e-6)
            if d[1] < 0:
                d = -d
            d *= kcol[c] * wq
            quads[(r, c)] = [tuple(tl), tuple(tr), tuple(tr + d), tuple(tl + d)]
        # 缺槽：按“行内已知槽位”线性外推（列间距≈0.85 个网格步长，不能直接用棋盘宽当步长）
        for r in range(len(rows)):
            cs = sorted([c for c in range(4) if (r, c) in quads])
            if len(cs) >= 2:
                A = np.column_stack([np.ones(len(cs)), np.asarray(cs, float)])
                tls = np.array([quads[(r, c)][0] for c in cs], float)
                bx, *_ = np.linalg.lstsq(A, tls[:, 0], rcond=None)
                by, *_ = np.linalg.lstsq(A, tls[:, 1], rcond=None)
                base = np.array(quads[(r, cs[0])][0])
                for c in range(4):
                    if (r, c) in quads:
                        continue
                    tgt = np.array([bx[0] + bx[1] * c, by[0] + by[1] * c])
                    quads[(r, c)] = shift_quad(quads[(r, cs[0])], *(tgt - base))
            elif len(cs) == 1:
                c0 = cs[0]
                base = np.array(quads[(r, c0)][0])
                step = np.array(quads[(r, c0)][1]) - base        # 退化：用棋盘宽作步长
                for c in range(4):
                    if (r, c) not in quads:
                        quads[(r, c)] = shift_quad(quads[(r, c0)], *(step * (c - c0)))
        # 仍有缺槽：按列外推
        for c in range(4):
            rs = sorted([r for r in range(len(rows)) if (r, c) in quads])
            if len(rs) < 2:
                continue
            A = np.column_stack([np.ones(len(rs)), np.asarray(rs, float)])
            tls = np.array([quads[(r, c)][0] for r in rs], float)
            bx, *_ = np.linalg.lstsq(A, tls[:, 0], rcond=None)
            by, *_ = np.linalg.lstsq(A, tls[:, 1], rcond=None)
            base = np.array(quads[(rs[0], c)][0])
            for r in range(len(rows)):
                if (r, c) in quads:
                    continue
                tgt = np.array([bx[0] + bx[1] * r, by[0] + by[1] * r])
                quads[(r, c)] = shift_quad(quads[(rs[0], c)], *(tgt - base))
        for r in range(len(rows)):
            for c in range(4):
                if (r, c) not in quads:
                    continue
                k += 1
                ok, s = render(rgb, quads[(r, c)], os.path.join(outdir, f"{k:02d}.png"), save)
                res.append({"k": k, "page": page, "rc": [r, c], "grid_ok": ok, "s": s,
                            "corners": [[round(v, 1) for v in p] for p in quads[(r, c)]]})
    if save:
        json.dump({"tag": tag, "image": [W, H], "boards": res},
                  open(os.path.join(outdir, "index.json"), "w"), ensure_ascii=False)
    return res


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        for p in sorted(glob.glob(os.path.join(SRC, "*.jpg"))):
            t = os.path.basename(p)[:-4]
            r = process_photo(p, t)
            print(f"{t}: {len(r)} boards, grid_bad={sum(1 for x in r if not x['grid_ok'])}")
    else:
        p = sys.argv[1]
        t = os.path.basename(p)[:-4]
        r = process_photo(p, t)
        print(f"{t}: {len(r)} boards, grid_bad={sum(1 for x in r if not x['grid_ok'])}")
