#!/usr/bin/env python3
"""把选好的关卡表注入 sokoban/index.html（对象格式：name / best / map）。

与 inject3.py 的区别：inject3 读 final_levels3.json（旧难度曲线），本脚本读
final_levels4.json（丢掉 <14 推的消遣关之后的新曲线）。用法：

    python3 tools/inject4.py [关卡表.json]

注入后会自动把 localStorage 的键加上版本后缀 —— 关卡编号变了，
旧存档（已通关列表 / 最好成绩 / 上次进度）对着新关卡会错位，必须换键。
"""
import json
import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
PROJECT = TOOLS.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else TOOLS / "final_levels4.json"
HTML = PROJECT / "web" / "sokoban" / "index.html"

# 关卡表换代 ⇒ 存档键换代（否则旧进度会套到新关卡上）
KEY_BUMP = [
    ("'sokoban_cleared'", "'sokoban_cleared_v4'"),
    ("'sokoban_best'", "'sokoban_best_v4'"),
    ("'sokoban_last'", "'sokoban_last_v4'"),
]


def main():
    levels = json.loads(SRC.read_text(encoding="utf-8"))
    rows = []
    for lv in levels:
        maps = ", ".join(json.dumps(s, ensure_ascii=False) for s in lv["map"])
        rows.append(
            '    {name: ' + json.dumps(lv["name"], ensure_ascii=False)
            + ', best: {pushes: %d, moves: %d}, map: [%s]}'
            % (lv["best"]["pushes"], lv["best"]["moves"], maps)
        )
    block = "  const LEVELS = [\n" + ",\n".join(rows) + "\n  ];"

    html = HTML.read_text(encoding="utf-8")
    new, n = re.subn(r"  const LEVELS = \[.*?\n  \];", block, html, count=1, flags=re.S)
    if n != 1:
        sys.exit(f"注入失败：匹配到 {n} 处 LEVELS 块")

    for old, rep in KEY_BUMP:
        if old in new:
            new = new.replace(old, rep)
            print(f"  存档键 {old} -> {rep}")
        elif rep not in new:
            print(f"  ⚠️ 没找到 {old}，也没找到 {rep}")

    HTML.write_text(new, encoding="utf-8")
    print(f"已注入 {len(levels)} 关 -> {HTML.relative_to(PROJECT)}")
    for lv in levels:
        print(f"  第{lv['no']:2d}关  推{lv['best']['pushes']:>4}  步{lv['best']['moves']:>4}  "
              f"{lv['size']:>6}  {lv['name']}")


if __name__ == "__main__":
    main()
