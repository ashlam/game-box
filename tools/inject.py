#!/usr/bin/env python3
"""把验证过的最终关卡表注入 sokoban/index.html 的 LEVELS 数组。"""
import json, re, sys

SRC = '/volume1/docker/hermes/files/bot_workspace/projects/games-box/tools/final_levels.json'
HTML = '/volume1/docker/hermes/files/bot_workspace/projects/games-box/web/sokoban/index.html'

levels = json.load(open(SRC))
rows = []
for lv in levels:
    rows.append('    [' + ', '.join(json.dumps(s, ensure_ascii=False) for s in lv['lines']) + '],')
block = '  const LEVELS = [\n' + '\n'.join(rows).rstrip(',') + '\n  ];'

html = open(HTML, encoding='utf-8').read()
new, n = re.subn(r'  const LEVELS = \[.*?\n  \];', block, html, count=1, flags=re.S)
if n != 1:
    sys.exit(f'注入失败：匹配到 {n} 处')
open(HTML, 'w', encoding='utf-8').write(new)
print(f'已注入 {len(levels)} 关')
for i, lv in enumerate(levels, 1):
    print(f'  第{i:2d}关  推动{lv["pushes"]}  ' + ' / '.join(lv['lines']))
