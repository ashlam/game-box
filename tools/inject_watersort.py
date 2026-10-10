#!/usr/bin/env python3
"""把 tools/watersort_levels.json 注入 web/watersort/index.html 的 __WATERSORT_LEVELS__ 占位符"""
import json, re, sys
from pathlib import Path
here = Path(__file__).resolve().parent
root = here.parent
data = json.loads((here / 'watersort_levels.json').read_text(encoding='utf-8'))
js = json.dumps({k: v for k, v in data.items() if k in ('cap', 'sets')},
                ensure_ascii=False, separators=(',', ':'))
p = root / 'web' / 'watersort' / 'index.html'
h = p.read_text(encoding='utf-8')
if '__WATERSORT_LEVELS__' in h:
    h = h.replace('__WATERSORT_LEVELS__', js, 1)
elif re.search(r'const DATA = \{.*?\};', h, re.S):
    h = re.sub(r'const DATA = \{.*?\};', 'const DATA = ' + js + ';', h, count=1, flags=re.S)
else:
    print('!! 找不到占位符'); sys.exit(1)
p.write_text(h, encoding='utf-8')
n = sum(len(s['levels']) for s in data['sets'])
print('已注入：%d 个关卡集 / %d 关 · 文件 %.1f KB' % (len(data['sets']), n, len(h.encode()) / 1024))
