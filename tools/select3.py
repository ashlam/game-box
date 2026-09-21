#!/usr/bin/env python3
"""按难度曲线从经典关卡里选关，产出最终关卡表（含标题、参考最优解、可从浏览器重放的解法）。"""
import json
import re

SRC = "/opt/data/games-tools/classic_solutions.json"
OUT = "/opt/data/games-tools/final_levels3.json"

SRC_LABEL = {
    "ExtremelyEasy": "极简",
    "SeeminglyHard": "貌似容易",
    "Laborious": "费时",
    "FrustratinglyDifficult": "折磨",
    "IllustrativeLevels": "教学示例",
}

MAX_W, MAX_H, MAX_BOXES = 16, 15, 14          # 手机可玩上限


def title_of(t):
    m = re.search(r'"([^"]+)"', t or "")
    if m:
        return m.group(1).strip()
    return (t or "").split(",")[-1].strip() or "经典关"


def main():
    data = json.load(open(SRC))
    pool = []
    for fname, recs in data.items():
        src = fname.replace(".sok", "")
        for r in recs:
            if not r["solvable"]:
                continue
            if r["h"] > MAX_H or r["w"] > MAX_W or r["boxes"] > MAX_BOXES:
                continue
            pool.append({
                "map": r["lines"],
                "pushes": r["sol"]["pushes"], "moves": r["sol"]["moves"],
                "sol": r["sol"]["moves_str"],
                "boxes": r["boxes"], "h": r["h"], "w": r["w"],
                "src": src,
                "name": f"{SRC_LABEL.get(src, src)} · {title_of(r['title'])}",
            })
    pool.sort(key=lambda x: (x["pushes"], x["boxes"]))
    print(f"可用候选 {len(pool)} 关；推动数 {[p['pushes'] for p in pool]}")

    # 难度曲线：同一推动数只留一关（优先箱子多、地图小）
    chosen, seen_pushes = [], set()
    for p in pool:
        if p["pushes"] in seen_pushes:
            continue
        seen_pushes.add(p["pushes"])
        chosen.append(p)

    # 写入：编号、名称、地图、参考最优
    out = []
    for i, c in enumerate(chosen, 1):
        out.append({
            "no": i, "name": c["name"], "map": c["map"],
            "best": {"pushes": c["pushes"], "moves": c["moves"]},
            "sol": c["sol"], "boxes": c["boxes"], "size": f"{c['h']}x{c['w']}",
        })
    json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"\n选出 {len(out)} 关：")
    for c in out:
        print(f"  第{c['no']:2d}关  推动{c['best']['pushes']:>4}  步数{c['best']['moves']:>4}  "
              f"箱子{c['boxes']:>2}  {c['size']:>6}  {c['name']}")


if __name__ == "__main__":
    main()
