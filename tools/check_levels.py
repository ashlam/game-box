#!/usr/bin/env python3
"""确认网页里的关卡数组和已验证的 final_levels3.json 完全一致。"""
import json
import re

html = open('/opt/data/games/sokoban/index.html', encoding='utf-8').read()
m = re.search(r'  const LEVELS = \[(.*?)\n  \];', html, re.S)
assert m, '没找到 LEVELS 数组'
blocks = re.findall(r'\{name:.*?map: \[(.*?)\]\}', m.group(1), re.S)
parsed = [[s for s in re.findall(r'"([^"]*)"', b)] for b in blocks]
final = [lv['map'] for lv in json.load(open('/opt/data/games-tools/final_levels3.json'))]

print(f'网页关卡数 = {len(parsed)}，已验证关卡数 = {len(final)}')
print('内容完全一致：', parsed == final)
legal = set('# .$*@+')
bad = [(i + 1, ch) for i, lv in enumerate(parsed) for row in lv for ch in row if ch not in legal]
print('非法字符：', bad if bad else '无')
print('每关箱/目标数匹配：', all(
    sum(r.count('$') + r.count('*') for r in lv) ==
    sum(r.count('.') + r.count('*') + r.count('+') for r in lv) for lv in parsed))
sizes = [(max(len(r) for r in lv), len(lv)) for lv in parsed]
print('最大尺寸 宽x高：', max(sizes))
