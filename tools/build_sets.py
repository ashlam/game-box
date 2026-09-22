#!/usr/bin/env python3
"""把两套关卡合成为 tools/level_sets.json，供 inject5.py 注入游戏。

输入：
  tools/final_levels4.json     经典集 24 关（地图 + 原始参考值）
  tools/classic_optima.json    （可选）用 solver3.js 重算的经典集真最优
  tools/arcade_solutions.json  街机版求解结果（solve_arcade.js 产出）

输出：
  tools/level_sets.json = [ {id,name,hint,levels:[{tag,name,best,map}]}, ... ]

★ 关于「参考值」的诚实标注（这是本次发现的问题）：
  经典集原来的参考值来自 .sok 文件里附带的解，实测**并非最优**（第 18 关声明 40 推，
  真最优只有 14 推）。所以这里改成：
    best.opt = true   → 由 solver3.js 以可采纳 A* 求得，**推动数最优**（可放心标「最优」）
    best.opt = false  → 只找到一条合法参考解（加权/贪心搜出来的），不能称最优
"""
import json
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
CLASSIC = TOOLS / "final_levels4.json"
COPT = TOOLS / "classic_optima.json"
ARCADE = TOOLS / "arcade_solutions.json"
OUT = TOOLS / "level_sets.json"


def load(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def main():
    sets = []

    # ---------- 经典集 ----------
    classic = load(CLASSIC)
    copt = load(COPT) or {}
    lvls = []
    for lv in classic:
        no = lv["no"]
        o = copt.get(str(no)) or copt.get(no)
        if o and o.get("status") == "ok":
            pushes, moves, opt = o["pushes"], o["moves"], bool(o.get("optimal"))
            sol = o.get("sol")
        else:
            pushes, moves = lv["best"]["pushes"], lv["best"]["moves"]
            opt = False           # 语句来源是 .sok 附带解，实测非最优
            sol = lv.get("sol")
        lvls.append({
            "tag": str(no), "name": lv["name"],
            "best": {"pushes": pushes, "moves": moves, "opt": opt},
            "map": lv["map"],
            "sol": sol,          # 仅供 tools/test_sokoban.js 重放验证；inject5 不会写进 HTML
        })
    ps = [l["best"]["pushes"] for l in lvls]
    sets.append({
        "id": "classic", "name": "经典集",
        "hint": f"{len(lvls)} 关 · 难度 {min(ps)}→{max(ps)} 推",
        "levels": lvls,
    })

    # ---------- 街机版 ----------
    arc = load(ARCADE) or []
    ok = [r for r in arc if r.get("status") == "ok"]
    bad = [r for r in arc if r.get("status") == "invalid"]
    a_lvls = []
    for r in ok:
        a_lvls.append({
            "tag": r["id"],
            "name": f"{r['id']} {r.get('world','')}".strip(),
            "best": {"pushes": r["pushes"], "moves": r["moves"], "opt": bool(r.get("optimal"))},
            "map": r["map"],
            "sol": r.get("sol"),     # 仅供测试重放
        })
    sets.append({
        "id": "arcade", "name": "街机版",
        "hint": f"Sokoban Deluxe · Namco 1990 · {len(a_lvls)} 关（原版 55，剔除 {len(bad)} 关损坏数据）",
        "levels": a_lvls,
    })

    # 街机版难度更低（6→84 推）且关卡更多，放前面作为默认关卡集
    order = {"arcade": 0, "classic": 1}
    sets.sort(key=lambda s: order.get(s["id"], 99))

    OUT.write_text(json.dumps(sets, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写出 {OUT.name}")
    for s in sets:
        n_opt = sum(1 for l in s["levels"] if l["best"]["opt"])
        ps = [l["best"]["pushes"] for l in s["levels"]]
        print(f"  {s['name']:<8} {len(s['levels']):>3} 关  推动 {min(ps)}→{max(ps)}  "
              f"（其中推动数最优 {n_opt} 关）  {s['hint']}")
    if bad:
        print("  已剔除的损坏关卡：" + ", ".join(f"{r['id']}({r.get('err','')})" for r in bad))


if __name__ == "__main__":
    main()
