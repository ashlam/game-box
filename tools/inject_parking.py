#!/usr/bin/env python3
"""把 tools/parking_levels.json 注入 web/parking/index.html 的 __PARKING_LEVELS__ 占位符"""
import json, re, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
data = json.loads((ROOT / 'tools' / 'parking_levels.json').read_text(encoding='utf-8'))
html_p = ROOT / 'web' / 'parking' / 'index.html'
h = html_p.read_text(encoding='utf-8')
js = json.dumps(data['sets'], ensure_ascii=False, separators=(',', ':'))   # ★ 只注入 sets 数组
if '__PARKING_LEVELS__' in h:
    h = h.replace('__PARKING_LEVELS__', js, 1)
else:
    # 已注入过：替换整个 LEVEL_SETS 赋值行
    h = re.sub(r"let LEVEL_SETS = .*?;\s*// 注入过", "let LEVEL_SETS = " + js + ";  // 注入过", h, count=1, flags=re.S)
    if js not in h:
        h = re.sub(r"let LEVEL_SETS = [^\n]*;", "let LEVEL_SETS = " + js + ";", h, count=1)
if '__PARKING_META__' in h:
    meta = json.dumps({k: data[k] for k in ('n', 'exitEdge', 'exitCol', 'policeLen') if k in data}, ensure_ascii=False)
    h = h.replace('__PARKING_META__', meta, 1)
html_p.write_text(h, encoding='utf-8')
tot = sum(len(s['levels']) for s in data['sets'])
print('已注入：%d 个关卡集 / %d 关' % (len(data['sets']), tot))
for s in data['sets']:
    print('  %-6s %2d 关 · 最少步数 %s' % (s['name'], len(s['levels']), '/'.join(str(l['min']) for l in s['levels'])))
