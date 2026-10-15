#!/usr/bin/env bash
# =============================================================================
# 小游戏盒子 —— 一键打包 APK（手动执行用）
#
# 用法（在 games-box 目录下）：
#   ./build-apk.sh              打包 + 发布到站点根 + 打印下载地址
#   ./build-apk.sh --commit     打包完成后，顺便把 releases/ 与 web/ 里的 APK 提交到 git
#   ./build-apk.sh --no-serve   跳过站点根发布（只出 releases/ 里的包）
#
# 它做的事（按顺序）：
#   0) 打印当前分支/提交/未提交改动（提醒你正在拿哪份代码打包）
#   1) 调用 android/build_apk.sh —— 同步 web/ → assets、aapt2/javac/d8、签名、校验
#   2) ★ 把成品复制到站点根 web/小游戏盒子离线版.apk（这样浏览器下载链接就是最新包）
#   3) 打印：大小、sha256、页数、主页卡片数、签名指纹、下载地址
#
# 依赖：/opt/data/android-build/tools 下的用户态工具链（见 android/build_apk.sh 头部注释）
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

DO_COMMIT=0
DO_SERVE=1
for a in "$@"; do
  case "$a" in
    --commit)  DO_COMMIT=1 ;;
    --no-serve) DO_SERVE=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $a（可用 --commit / --no-serve）" >&2; exit 1 ;;
  esac
done

# ---- 工具链自检：若当前环境没有 Android 工具链（例如你在 NAS 主机上直接跑），
#      且本机有 docker，就自动进容器里再跑一次（/volume1 两边路径相同，直接复用）----
if [ ! -x /opt/data/android-build/tools/jdk-17/bin/javac ]; then
  if command -v docker >/dev/null 2>&1; then
    CID="${GAMEBOX_CONTAINER:-hermes-official}"
    echo "==> 当前环境没有 Android 工具链，转由容器 [$CID] 执行…"
    exec docker exec -i "$CID" bash -lc "cd '$ROOT' && ./build-apk.sh $*"
  fi
  echo "找不到 Android 工具链（/opt/data/android-build/tools），且本机没有 docker 可用。" >&2
  echo "请在 NAS 上执行：docker exec -it hermes-official bash -lc 'cd $ROOT && ./build-apk.sh'" >&2
  exit 1
fi

APP_NAME="小游戏盒子离线版"
APK="$ROOT/releases/${APP_NAME}.apk"
SERVE_APK="$ROOT/web/${APP_NAME}.apk"

echo "============================================================"
echo " 小游戏盒子 · 打包 APK"
echo "============================================================"
echo "  目录   : $ROOT"
if git rev-parse --git-dir >/dev/null 2>&1; then
  echo "  分支   : $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
  DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
  if [ "$DIRTY" != "0" ]; then
    echo "  ⚠ 未提交改动 $DIRTY 个（下面这些也会被打进 APK）："
    git status --porcelain | head -10 | sed 's/^/      /'
  else
    echo "  未提交 : 0 个（干净）"
  fi
fi
echo

# ---- 1) 真正的构建（含资源同步 + 签名 + 校验）--------------------------------
bash android/build_apk.sh

if [ ! -f "$APK" ]; then
  echo "构建没有产出 $APK" >&2; exit 1
fi

# ---- 2) 发布到站点根（浏览器下载链接指向的就是这个文件）---------------------
if [ "$DO_SERVE" = "1" ]; then
  cp -f "$APK" "$SERVE_APK"
  chmod 644 "$SERVE_APK"
  echo "==> 已发布到站点根: web/${APP_NAME}.apk"
fi

# ---- 3) 汇报 -----------------------------------------------------------------
echo
python3 - "$APK" <<'PY'
import sys, zipfile, hashlib, re
apk = sys.argv[1]
b = open(apk, 'rb').read()
print('  大小    : %.1f KB (%d bytes)' % (len(b) / 1024, len(b)))
print('  sha256  : %s' % hashlib.sha256(b).hexdigest())
try:
    z = zipfile.ZipFile(apk)
    pages = sorted(n for n in z.namelist() if n.endswith('.html'))
    print('  页数    : %d' % len(pages))
    h = z.read('assets/index.html').decode('utf-8')
    links = re.findall(r'href="([^"]+)"', h)
    print('  主页卡片: %d 张 → %s' % (len(links), ' '.join(l.replace('/index.html', '') for l in links)))
except Exception as e:
    print('  （包内检查失败: %s）' % e)
PY

BASE=/opt/data/android-build/tools
if [ -x "$BASE/jdk-17/bin/keytool" ]; then
  "$BASE/jdk-17/bin/keytool" -printcert -jarfile "$APK" 2>/dev/null | grep -E "SHA256:" | head -1 | sed 's/^/  签名    : /'
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$HOST_IP" ] || HOST_IP="192.168.101.42"
echo
echo "  下载地址: http://${HOST_IP}:4321/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote('$APP_NAME'))").apk"
echo "  本地文件: $APK"
[ "$DO_SERVE" = "1" ] && echo "  站点副本: $SERVE_APK"

# ---- 可选提交 ---------------------------------------------------------------
if [ "$DO_COMMIT" = "1" ]; then
  echo
  echo "==> 提交 APK 到 git"
  git add -f "releases/${APP_NAME}.apk" "web/${APP_NAME}.apk" 2>/dev/null || git add -A
  if git diff --cached --quiet; then
    echo "  （没有需要提交的变化）"
  else
    git commit -q -m "build(apk): 重新打包（$(git rev-parse --short HEAD 2>/dev/null || echo local)）"
    echo "  已提交: $(git log --oneline -1)"
  fi
fi
echo
echo "==> 完成"
