#!/usr/bin/env python3
"""把经典关卡表注入 sokoban/index.html（对象格式：name / map / best）。"""
import json
import re
import sys

SRC = "/opt/data/games-tools/final_levels3.json"
HTML = "/opt/data/games/sokoban/index.html"

levels = json.load(open(SRC))
rows = []
for lv in levels:
    maps = ", ".join(json.dumps(s, ensure_ascii=False) for s in lv["map"])
    rows.append(
        '    {name: ' + json.dumps(lv["name"], ensure_ascii=False) +
        ', best: {pushes: %d, moves: %d}, map: [%s]}' % (lv["best"]["pushes"], lv["best"]["moves"], maps)
    )
block = '  const LEVELS = [\n' + ',\n'.join(rows) + '\n  ];'

html = open(HTML, encoding="utf-8").read()
new, n = re.subn(r'  const LEVELS = \[.*?\n  \];', block, html, count=1, flags=re.S)
if n != 1:
    sys.exit(f"注入失败：匹配到 {n} 处")
open(HTML, "w", encoding="utf-8").write(new)
print(f"已注入 {len(levels)} 关")
for lv in levels:
    print(f"  第{lv['no']:2d}关  最优{lv['best']['pushes']:>3}推/{lv['best']['moves']:>3}步  {lv['size']:>6}  {lv['name']}")
