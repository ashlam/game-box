#!/usr/bin/env python3
"""按「更难的前期关卡」重新选关 —— 产出 final_levels4.json（给 inject 用）。

为什么要有这一版：select3.py 是按推动数全局升序选，结果前 9 关全被 ExtremelyEasy 那套
1~9 推的消遣关占满（1 推、2 推…），玩起来前十分钟毫无挑战。用户反馈「前期太简单」。

本版规则：
  1. 丢掉所有 < 14 推的关卡（ExtremelyEasy 整集 + Illustrative 里那几个教学关）
  2. 尺寸上限从「宽≤16 高≤15」放宽到「宽≤18 高≤18」—— 手机上 18 列 × 382px 画布
     每格仍有 ~21px，看得清；这样能多解锁 10 关（原本被 17/18 宽的卡掉）
  3. 推动数升序；同一推动数优先「地图更紧凑」的（街机味：小盘面 + 高难度密度）
  4. 箱子数 ≤16（再多手机上就糊了）

输出：tools/final_levels4.json
"""
import json
import re
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
SRC = TOOLS / "classic_solutions.json"
OUT = TOOLS / "final_levels4.json"

SRC_LABEL = {
    "ExtremelyEasy": "极简",
    "SeeminglyHard": "貌似容易",
    "Laborious": "费时",
    "FrustratinglyDifficult": "折磨",
    "IllustrativeLevels": "教学示例",
}

MAX_W, MAX_H, MAX_BOXES = 18, 18, 16     # 手机可玩上限（放宽后）
MIN_PUSHES = 14                          # ★ 难度下限：丢掉所有消遣关


def title_of(t):
    m = re.search(r'"([^"]+)"', t or "")
    if m:
        return m.group(1).strip()
    return (t or "").split(",")[-1].strip() or "经典关"


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    pool, dropped = [], {"太小": 0, "太大": 0, "无解": 0}
    for fname, recs in data.items():
        src = fname.replace(".sok", "")
        for r in recs:
            if not r["solvable"] or not r["sol"]:
                dropped["无解"] += 1
                continue
            if r["sol"]["pushes"] < MIN_PUSHES:
                dropped["太小"] += 1
                continue
            if r["w"] > MAX_W or r["h"] > MAX_H or r["boxes"] > MAX_BOXES:
                dropped["太大"] += 1
                continue
            pool.append({
                "map": r["lines"],
                "pushes": r["sol"]["pushes"], "moves": r["sol"]["moves"],
                "sol": r["sol"]["moves_str"],
                "boxes": r["boxes"], "h": r["h"], "w": r["w"],
                "area": r["h"] * r["w"],
                "src": src,
                "name": f"{SRC_LABEL.get(src, src)} · {title_of(r['title'])}",
            })

    print(f"丢弃：{dropped}；入选候选 {len(pool)} 关")
    # 推动数升序；同推动数优先小盘面、少箱子
    pool.sort(key=lambda x: (x["pushes"], x["area"], x["boxes"]))

    out = []
    for i, c in enumerate(pool, 1):
        out.append({
            "no": i, "name": c["name"], "map": c["map"],
            "best": {"pushes": c["pushes"], "moves": c["moves"]},
            "sol": c["sol"], "boxes": c["boxes"], "size": f"{c['h']}x{c['w']}",
        })
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n选出 {len(out)} 关（推动数 {out[0]['best']['pushes']} → {out[-1]['best']['pushes']}）：")
    for c in out:
        print(f"  第{c['no']:2d}关  推{c['best']['pushes']:>4}  步{c['best']['moves']:>4}  "
              f"箱{c['boxes']:>2}  {c['size']:>6}  {c['name']}")


if __name__ == "__main__":
    main()
