#!/usr/bin/env python3
"""从经典关卡集里按难度曲线挑关，产出最终关卡表（带出处标注）。"""
import json
import sys

sys.path.insert(0, "/opt/data/games-tools")
from solver2 import parse

ANALYSIS = "/opt/data/games-tools/classic_analysis.json"
OUT = "/opt/data/games-tools/final_levels2.json"

# 手机可玩性上限
MAX_W, MAX_H, MAX_BOXES = 15, 12, 6
# 难度曲线：目标最少推动数（第 1 关是入门教学）
TARGETS = [1, 6, 12, 20, 28, 36, 45, 55, 65, 75, 85, 95, 105, 115, 125, 140, 155, 170, 190, 215]

SRC_LABEL = {
    "ExtremelyEasy.sok": "经典集·极简",
    "SeeminglyHard.sok": "经典集·貌似容易",
    "Laborious.sok": "经典集·费时",
    "FrustratinglyDifficult.sok": "经典集·折磨",
    "IllustrativeLevels.sok": "经典集·教学",
    "boxoban_hard_000.txt": "Boxoban·困难",
    "boxoban_medium_000.txt": "Boxoban·中等",
}

TUTORIAL = {"name": "入门教学", "map": ["#####", "#@$.#", "#####"], "pushes": 1, "src": "内置"}


def main():
    data = json.load(open(ANALYSIS))
    pool = []
    for fname, recs in data.items():
        for r in recs:
            if not isinstance(r.get("pushes"), int):
                continue
            if r["h"] > MAX_H or r["w"] > MAX_W or r["boxes"] > MAX_BOXES:
                continue
            pool.append({
                "map": r["lines"], "pushes": r["pushes"], "boxes": r["boxes"],
                "h": r["h"], "w": r["w"],
                "name": f"{SRC_LABEL.get(fname, fname)} #{r['i']}",
                "src": fname,
            })
    pool.sort(key=lambda x: (x["pushes"], x["boxes"]))
    print(f"候选池 {len(pool)} 关（符合手机尺寸与箱数限制）")
    if pool:
        print("推动数分布:", [p["pushes"] for p in pool[::max(1, len(pool)//25)]])

    chosen = [TUTORIAL]
    used = set()
    last = 0
    for t in TARGETS[1:]:
        cands = [p for p in pool
                 if p["pushes"] >= t and p["pushes"] > last and tuple(p["map"]) not in used]
        if not cands:
            print(f"⚠️ 没有推动数 ≥ {t} 的关卡了，曲线到此为止")
            break
        # 同难度优先：箱子多 → 地图小（手机上更好看）→ 推动数小
        cands.sort(key=lambda x: (-x["boxes"], x["h"] * x["w"], x["pushes"]))
        pick = cands[0]
        used.add(tuple(pick["map"]))
        last = pick["pushes"]
        chosen.append(pick)

    json.dump(chosen, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"\n选出 {len(chosen)} 关：")
    for i, c in enumerate(chosen, 1):
        print(f"  第{i:2d}关  推动{c['pushes']:>4}  箱子{c.get('boxes','?')}  "
              f"{len(c['map'])}x{max(len(m) for m in c['map'])}  {c['name']}")


if __name__ == "__main__":
    main()
