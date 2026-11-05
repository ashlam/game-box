#!/usr/bin/env bash
# 用无头 Chrome 给站点/单个游戏截手机尺寸的图。
#
# 为什么要绕这一圈：本机 Chrome 的老版 --headless 会**忽略 --window-size 对布局的影响**
# （innerWidth 实测被钉在 500），截图裁成 390 宽之后右边全是切掉的内容。
# 做法是外面套一层 wrapper 页，把目标页塞进 390×844 的 iframe —— iframe 内部的
# 布局视口就是 390，媒体查询也跟着 390 走，截出来才是真机的样子。
#
# 用法：
#   tools/shot.sh web/index.html out.png            # 默认 390×844
#   tools/shot.sh web/mathadd/index.html out.png 390 900
set -u
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$1"
OUT="$2"
W="${3:-390}"
H="${4:-844}"
BUDGET="${5:-4000}"

if [ -z "${TARGET:-}" ] || [ -z "${OUT:-}" ]; then
  echo "usage: tools/shot.sh <html 相对路径> <输出 png> [宽] [高]" >&2
  exit 2
fi
[ -f "$TARGET" ] || TARGET="$ROOT/$TARGET"
[ -f "$TARGET" ] || { echo "找不到 $TARGET" >&2; exit 2; }

ABS="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
# --screenshot 只认绝对路径（相对路径会在 Windows 上写不出来）
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
# file:/// 形式（Windows 路径要转成 /e/... 这种，Chrome 认 C:/ 前言的正斜杠）
URL="file:///$(printf '%s' "$ABS" | sed 's|^/\([a-zA-Z]\)/|\1:/|')"

TMP="$(mktemp -d)"
cat > "$TMP/wrap.html" <<HTML
<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}
iframe{width:${W}px;height:${H}px;border:0;display:block}</style></head>
<body><iframe src="$URL"></iframe></body></html>
HTML

"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size="${W},${H}" --virtual-time-budget="${BUDGET}" \
  --screenshot="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")" \
  "file:///$(printf '%s' "$TMP/wrap.html" | sed 's|^/\([a-zA-Z]\)/|\1:/|')" >/dev/null 2>&1

rm -rf "$TMP"
if [ -f "$OUT" ]; then
  echo "ok $OUT  ($(wc -c < "$OUT") bytes)"
else
  echo "失败：没有产出 $OUT" >&2
  exit 1
fi
