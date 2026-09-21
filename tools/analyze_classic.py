#!/usr/bin/env python3
"""分析经典关卡集：逐个算最少推动数，输出按难度排序的清单。
人工设计的经典集优先（快），Boxoban 只抽样（机器生成的大关状态多）。"""
import glob
import json
import os
import sys
import time

sys.path.insert(0, "/opt/data/games-tools")
from solver2 import min_pushes, parse

BOARD_CHARS = set(" #.$*@+")


def extract_boards(text, max_levels=None):
    boards, cur = [], []
    for raw in text.splitlines():
        line = raw.rstrip("\r\n")
        is_board = (line.strip() != "" and all(ch in BOARD_CHARS for ch in line)
                    and any(ch in line for ch in "#$*@."))
        if is_board:
            cur.append(line)
        else:
            if cur:
                boards.append(cur); cur = []
    if cur:
        boards.append(cur)
    out = [b for b in boards
           if any('@' in l or '+' in l for l in b) and any('$' in l or '*' in l for l in b)]
    return out[:max_levels] if max_levels else out


def crop(lines):
    w = max(len(l) for l in lines)
    g = [l.ljust(w) for l in lines]
    while g and not g[0].strip(): g.pop(0)
    while g and not g[-1].strip(): g.pop()
    if not g: return g
    left = min((len(l) - len(l.lstrip(' ')) for l in g if l.strip()), default=0)
    right = max(len(l.rstrip(' ')) for l in g)
    return [l[left:right] for l in g]


def plan_files():
    out = []
    for pattern, cap, budget in [
        ("classic/*.sok", None, 25),                     # 人工设计，全跑
        ("classic/boxoban_medium_000.txt", 60, 4),       # 机器生成，抽样
        ("classic/boxoban_hard_000.txt", 60, 6),
    ]:
        for p in sorted(glob.glob("/opt/data/games-tools/" + pattern)):
            out.append((p, cap, budget))
    return out


def main():
    results = {}
    for path, cap, budget in plan_files():
        name = os.path.basename(path)
        text = open(path, encoding="utf-8", errors="replace").read()
        boards = extract_boards(text, cap)
        print(f"\n### {name}: 解析出 {len(boards)} 关（每关时间上限 {budget}s）", flush=True)
        recs, t0 = [], time.time()
        for i, b in enumerate(boards, 1):
            b = crop(b)
            if not b:
                continue
            try:
                H, W, walls, goals, boxes, player = parse(b)
            except Exception as e:
                recs.append({"i": i, "err": str(e)}); continue
            meta = {"i": i, "boxes": len(boxes), "h": len(b), "w": max(len(l) for l in b)}
            try:
                mp, states = min_pushes(b, time_budget=budget)
            except Exception as e:
                meta["err"] = f"solve:{e}"; recs.append(meta); continue
            meta.update({"pushes": mp, "states": states, "lines": b})
            recs.append(meta)
            if i % 10 == 0:
                print(f"    ...{i}/{len(boards)}  {time.time()-t0:.0f}s", flush=True)
        ok = [r for r in recs if isinstance(r.get("pushes"), int)]
        to = [r for r in recs if r.get("pushes") == "timeout"]
        bad = [r for r in recs if r.get("err")]
        print(f"    ✅可解 {len(ok)}  ⏱超时 {len(to)}  ❌解析失败 {len(bad)}  耗时 {time.time()-t0:.0f}s", flush=True)
        if ok:
            ps = sorted(r["pushes"] for r in ok)
            print(f"    推动数 {ps[0]}~{ps[-1]} 中位 {ps[len(ps)//2]}", flush=True)
        results[name] = recs
    json.dump(results, open("/opt/data/games-tools/classic_analysis.json", "w"), ensure_ascii=False)
    print("\n已写出 classic_analysis.json")


if __name__ == "__main__":
    main()
