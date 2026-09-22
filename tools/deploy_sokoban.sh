#!/usr/bin/env bash
# 仓库番部署流水线：暂存副本 --(cp)--> 线上文件 --(inject5)--> 关卡数据注入 --(回拷)--> 暂存副本
#
# 为什么要有这个脚本：
#   暂存副本（/opt/data/games-box-stage）里存的是**占位符版**还是**已注入版**很容易搞混。
#   已经两次踩坑：① 改完暂存直接 cp 覆盖线上，把之前注入的 72 关数据冲回占位符；
#   ② 注入完又用旧的暂存副本覆盖，把顺序改回去。所以把顺序固定死：cp → inject → 回拷。
#
# 用法：bash tools/deploy_sokoban.sh
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${GAMEBOX_STAGE:-/opt/data/games-box-stage}"
FILE="web/sokoban/index.html"

echo "== 1) 暂存 -> 线上 =="
cp -f "$STAGE/$FILE" "$PROJ/$FILE"
chmod 644 "$PROJ/$FILE"

echo "== 2) 注入关卡数据 =="
(cd "$PROJ" && python3 tools/inject5.py | tail -3)

echo "== 3) 线上 -> 暂存（保持一致，下次编辑不会冲掉数据）=="
cp -f "$PROJ/$FILE" "$STAGE/$FILE"

echo "== 4) 校验 =="
python3 - "$PROJ/$FILE" <<'PY'
import re, sys
h = open(sys.argv[1], encoding='utf-8').read()
print('  关卡条目:', len(re.findall(r'\{tag:', h)))
print('  残留占位符:', 'LEVEL_SETS_PLACEHOLDER' in h)
ids = re.findall(r"id:\s*['\"](\w+)['\"]", h)
print('  关卡集顺序:', ' -> '.join(ids))
m = re.search(r'safe-area-inset-bottom\) \+ (\d+)px', h)
print('  底部内边距:', (m.group(1) + 'px') if m else '?')
PY
