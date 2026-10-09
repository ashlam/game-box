#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""收尾：定警车 + 定出口 + 求解，产出最终可用关卡。"""
import json, subprocess

B = json.load(open("/opt/data/parking_grid/boards2.json"))

def pick_police(b):
    """警车 = 出口标记所在列(竖车)里最深的深色车；否则全局最深的车"""
    mk = b.get("marker")
    cars = b["cars"]
    darks = sorted([c for c in cars if c["dsat"] <= 25], key=lambda c: c["dsat"])
    if mk:
        mc = mk[1]
        col = [c for c in darks if c["ori"] == "v" and abs(c["col"] - mc) < 1.2]
        if col: return col[0], "marker-col"
        row = [c for c in darks if c["ori"] == "h" and abs(c["row"] - mk[0]) < 1.2]
        if row: return row[0], "marker-row"
    if darks: return darks[0], "darkest"
    if cars:
        return sorted(cars, key=lambda c: c["dsat"])[0], "force-darkest"
    return None, "none"

for t, b in B.items():
    pc, how = pick_police(b)
    for c in b["cars"]:
        c["police"] = (c is pc)
    if pc is None:
        b["exit"] = None; b["police_how"] = "none"; continue
    b["police_how"] = how
    if pc["ori"] == "v":
        b["exit"] = "bottom"
    else:
        b["exit"] = "right"
json.dump(B, open("/opt/data/parking_grid/boards2.json", "w"), ensure_ascii=False)
print("警车定法:", {h: sum(1 for v in B.values() if v.get("police_how") == h)
                    for h in set(v.get("police_how") for v in B.values())})
print("出口定法:", {e: sum(1 for v in B.values() if v.get("exit") == e)
                    for e in set(v.get("exit") for v in B.values())})
