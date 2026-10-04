#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""boards2.json(含 min) -> tools/parking_levels.json（游戏格式，按册分三档）"""
import json, os

B = json.load(open("/opt/data/parking_grid/boards2.json"))
PAL = ['#3b82f6','#22d3ee','#f59e0b','#ef4444','#a78bfa','#34d399','#e879f9','#fb7185',
       '#84cc16','#06b6d4','#f97316','#8b5cf6','#14b8a6','#eab308','#ec4899','#60a5fa']
PALRGB = [tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) for h in PAL]

def nearest(rgb):
    best = None
    for i, p in enumerate(PALRGB):
        d = sum((rgb[k]-p[k])**2 for k in range(3))
        if best is None or d < best[0]:
            best = (d, PAL[i])
    return best[1]

def tier(n):
    n = int(n)
    if n <= 112: return "beginner"
    if n <= 224: return "intermediate"
    return "advanced"

sets = {"beginner": {"id": "beginner", "name": "初级", "levels": []},
        "intermediate": {"id": "intermediate", "name": "中级", "levels": []},
        "advanced": {"id": "advanced", "name": "高级", "levels": []}}

skip = []
for t in sorted(B):
    b = B[t]
    if b.get("min") is None or b["min"] < 0 or not b.get("exit"):
        skip.append((t, b.get("min"), b.get("note"), b.get("exit"))); continue
    cars = []
    for c in b["cars"]:
        cars.append({"r": c["row"], "c": c["col"], "len": c["length"], "dir": c["ori"],
                     "color": "#111827" if c.get("police") else nearest(c["rgb"]),
                     "police": bool(c.get("police"))})
    lv = {"id": int(t), "min": b["min"], "exit": b["exit"],
          "mobile": b["mobile"], "cars": cars}
    sets[tier(t)]["levels"].append(lv)

out = {"n": 6, "sets": list(sets.values())}
json.dump(out, open("/opt/data/parking_grid/parking_levels.json", "w"), ensure_ascii=False, indent=1)
print("档位:", {k: len(v["levels"]) for k, v in sets.items()})
print("合计", sum(len(v["levels"]) for v in sets.values()), " 跳过", len(skip))
for s in skip[:20]:
    print("   跳过", s)
