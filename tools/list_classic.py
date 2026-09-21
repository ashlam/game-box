#!/usr/bin/env python3
"""列出所有已验证的经典关卡：难度、尺寸、箱子数、出处。"""
import json

data = json.load(open("/opt/data/games-tools/classic_solutions.json"))
rows = []
for fname, recs in data.items():
    for r in recs:
        if not r["solvable"]:
            continue
        rows.append({
            "src": fname.replace(".sok", ""),
            "title": (r["title"] or "").split('"')[-1].strip('"') if r["title"] else f"#{r['i']}",
            "pushes": r["sol"]["pushes"], "moves": r["sol"]["moves"],
            "boxes": r["boxes"], "h": r["h"], "w": r["w"],
            "lines": r["lines"],
        })
rows.sort(key=lambda x: x["pushes"])
print(f"共 {len(rows)} 关已验证\n")
print(f"{'#':>3} {'推动':>5} {'步数':>6} {'箱':>2} {'尺寸':>7}  出处/标题")
for i, r in enumerate(rows, 1):
    print(f"{i:>3} {r['pushes']:>5} {r['moves']:>6} {r['boxes']:>2} "
          f"{str(r['h'])+'x'+str(r['w']):>7}  {r['src']} · {r['title']}")

fit = [r for r in rows if r["w"] <= 15 and r["h"] <= 12 and r["boxes"] <= 6]
print(f"\n手机尺寸合适（≤15x12，箱子≤6）：{len(fit)} 关")
print("其中的推动数：", [r["pushes"] for r in fit])
