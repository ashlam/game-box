#!/usr/bin/env bash
# =============================================================================
# 小游戏盒子离线 APK —— 可重复构建脚本（无需 Android Studio / sudo / gradle）
#
# 用法：
#   bash android/build_apk.sh              # 完整构建 + 签名 + 校验 + 同步 releases/
#   bash android/build_apk.sh --genkey     # 签名密钥丢失时先生成一把新密钥
#
# 依赖（用户态工具链，默认在 /opt/data/android-build/tools）：
#   jdk-17/{bin/java,bin/javac,bin/keytool}
#   build-tools/35.0.0/{aapt2,d8,zipalign,apksigner}
#   platforms/android-35/android.jar
#   可用环境变量 ANDROID_BASE 覆盖。
#
# 签名口令：优先读环境变量 GAMEBOX_KS_PASS / GAMEBOX_KEY_PASS；
#          否则读 private/keystore.pass（本机私有文件，已被 .gitignore 忽略）。
# =============================================================================
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${ANDROID_BASE:-/opt/data/android-build/tools}"
JDK="$BASE/jdk-17"
BUILD="$BASE/build-tools/35.0.0"
ANDROID_JAR="$BASE/platforms/android-35/android.jar"

PROJ="$PROJECT/android/project"
OUT="${GAMEBOX_OUT:-$PROJECT/android/output}"
KS="${GAMEBOX_KS:-$PROJECT/private/gamebox-release.jks}"
KS_ALIAS="${GAMEBOX_KS_ALIAS:-gamebox}"
VERSION_NAME="${GAMEBOX_VERSION_NAME:-}"
APP_NAME="${GAMEBOX_APK_NAME:-小游戏盒子离线版}"

# ---- 版本号（决定「能不能覆盖安装」）---------------------------------------
# versionCode 用 git 提交数当基线：先提交再打包，就一定单调递增。
# 同一提交重复打包得到同一个 code —— 内容也一样，装不上不影响什么。
# 需要手动指定时：GAMEBOX_VERSION_CODE=300 bash android/build_apk.sh
SRC_COUNT="$(git -C "$PROJECT" rev-list --count HEAD 2>/dev/null || echo 0)"
VERSION_CODE="${GAMEBOX_VERSION_CODE:-$SRC_COUNT}"
case "$VERSION_CODE" in
  ''|*[!0-9]*) VERSION_CODE=2 ;;            # 不是数字（比如不在 git 仓库里）
esac
if [ "$VERSION_CODE" -lt 2 ]; then VERSION_CODE=2; fi
if [ -z "${GAMEBOX_VERSION_NAME:-}" ]; then VERSION_NAME="1.$VERSION_CODE"; fi

export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$BUILD:$PATH"

if [ "${1:-}" = "--genkey" ]; then GENKEY=1; else GENKEY=0; fi

# ---- 签名口令 --------------------------------------------------------------
KS_PASS="${GAMEBOX_KS_PASS:-}"
KEY_PASS="${GAMEBOX_KEY_PASS:-}"
if [ -z "$KS_PASS" ] && [ -f "$PROJECT/private/keystore.pass" ]; then
  KS_PASS="$(tr -d '\r\n' < "$PROJECT/private/keystore.pass")"
fi
if [ -z "$KEY_PASS" ]; then KEY_PASS="$KS_PASS"; fi

# ---- 依赖检查 --------------------------------------------------------------
for f in "$JDK/bin/javac" "$BUILD/aapt2" "$BUILD/d8" "$BUILD/zipalign" "$BUILD/apksigner" "$ANDROID_JAR"; do
  if [ ! -e "$f" ]; then
    echo "缺少构建依赖: $f" >&2
    echo "可用 ANDROID_BASE 指定工具链根目录，参见 README「APK 构建」一节。" >&2
    exit 1
  fi
done

# ---- 生成密钥（可选）------------------------------------------------------
if [ "$GENKEY" = "1" ]; then
  mkdir -p "$(dirname "$KS")"
  if [ -z "$KS_PASS" ]; then
    echo "生成密钥需要口令：设置 GAMEBOX_KS_PASS，或先写好 private/keystore.pass" >&2
    exit 1
  fi
  "$JDK/bin/keytool" -genkeypair -v -keystore "$KS" -storepass "$KS_PASS" \
    -alias "$KS_ALIAS" -keypass "$KEY_PASS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Offline Games Box, OU=Local, O=Nous Research, L=Local, ST=Local, C=CN"
fi

if [ ! -f "$KS" ]; then
  echo "找不到签名密钥 $KS（可用 --genkey 生成一把新的）" >&2; exit 1
fi
if [ -z "$KS_PASS" ]; then
  echo "未提供签名口令：设置 GAMEBOX_KS_PASS，或写入 private/keystore.pass" >&2; exit 1
fi

echo "==> 清理输出目录 $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/compiled" "$OUT/R" "$OUT/classes" "$OUT/dex"

echo "==> 0/8 同步 web/ -> android/project/assets/（避免新游戏漏进 APK）"
python3 "$PROJECT/android/sync_assets.py"

echo "==> 0.5/8 写入默认更新源 assets/update_source.txt"
# App 第一次启动时读这个文件当默认更新源；用户在 App 里改过就以用户填的为准。
# 不进版本库（每台机器 IP 不同），见 .gitignore。
if [ -z "${GAMEBOX_UPDATE_URL:-}" ]; then
  BUILD_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "${BUILD_IP:-}" ]; then
    GAMEBOX_UPDATE_URL="http://${BUILD_IP}:4321/update.json"
  fi
fi
mkdir -p "$PROJ/assets"
printf '%s\n' "${GAMEBOX_UPDATE_URL:-}" > "$PROJ/assets/update_source.txt"
echo "  默认更新源: ${GAMEBOX_UPDATE_URL:-（空 —— 装好后在 App 里手动填）}"

echo "==> 1/8 aapt2 编译资源（逐文件；compile --dir 会把输出目录误当输入）"
"$BUILD/aapt2" compile "$PROJ/res/values/strings.xml"      -o "$OUT/compiled"
"$BUILD/aapt2" compile "$PROJ/res/drawable/ic_launcher.xml" -o "$OUT/compiled"

echo "==> 2/8 aapt2 link（未签名 APK + R.java）"
# 版本号不改源清单，而是在输出目录生成一份带版本号的副本 —— 源文件保持干净（diff 好看），
# 也不依赖 aapt2 的 --version-code 参数（不同 build-tools 版本行为不一致）。
python3 - "$PROJ/AndroidManifest.xml" "$OUT/AndroidManifest.xml" "$VERSION_CODE" "$VERSION_NAME" <<'PY'
import re, sys
src, dst, code, name = sys.argv[1:5]
t = open(src, encoding='utf-8').read()
t = re.sub(r'android:versionCode="[^"]*"', 'android:versionCode="%s"' % code, t, count=1)
t = re.sub(r'android:versionName="[^"]*"', 'android:versionName="%s"' % name, t, count=1)
open(dst, 'w', encoding='utf-8').write(t)
print('  manifest versionCode=%s versionName=%s' % (code, name))
PY
FLATS=()
while IFS= read -r f; do FLATS+=("-R" "$f"); done < <(find "$OUT/compiled" -name '*.flat' | sort)
"$BUILD/aapt2" link -o "$OUT/unsigned.apk" \
  --manifest "$OUT/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  -A "$PROJ/assets" \
  "${FLATS[@]}" \
  --auto-add-overlay \
  --java "$OUT/R"

echo "==> 3/8 javac 编译 Java + R.java"
find "$OUT/R" "$PROJ/src" -name '*.java' | sort > "$OUT/sources.txt"
"$JDK/bin/javac" -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -d "$OUT/classes" @"$OUT/sources.txt"
if [ ! -f "$OUT/classes/com/nous/gamesbox/MainActivity.class" ]; then
  echo "javac 未产出 MainActivity.class" >&2; exit 1
fi

echo "==> 4/8 d8 转 dex（必须传显式 .class 列表，不能传 class 目录）"
find "$OUT/classes" -name '*.class' | sort > "$OUT/classes.arg"
"$BUILD/d8" --release --min-api 23 --lib "$ANDROID_JAR" --output "$OUT/dex" @"$OUT/classes.arg"

echo "==> 5/8 把 classes.dex 装回 APK"
python3 - "$OUT/unsigned.apk" "$OUT/dex/classes.dex" "$OUT/unsigned_with_dex.apk" <<'PY'
import sys, zipfile
src, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        if item.filename == 'classes.dex':
            continue
        zout.writestr(item, zin.read(item.filename))
    zout.writestr('classes.dex', open(dex, 'rb').read(),
                  compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
print('  写入 classes.dex ->', dst)
PY

echo "==> 6/8 zipalign"
"$BUILD/zipalign" -f -P 16 4 "$OUT/unsigned_with_dex.apk" "$OUT/aligned.apk"

echo "==> 7/8 apksigner 签名"
"$BUILD/apksigner" sign \
  --ks "$KS" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" \
  --out "$OUT/${APP_NAME}.apk" "$OUT/aligned.apk"

echo "==> 8/8 校验"
"$BUILD/apksigner" verify --verbose --print-certs "$OUT/${APP_NAME}.apk"
"$BUILD/zipalign" -c -P 16 -v 4 "$OUT/${APP_NAME}.apk"
"$BUILD/aapt2" dump badging "$OUT/${APP_NAME}.apk" | head -6

mkdir -p "$PROJECT/releases"
cp -f "$OUT/${APP_NAME}.apk" "$PROJECT/releases/${APP_NAME}-v${VERSION_NAME}.apk"
cp -f "$OUT/${APP_NAME}.apk" "$PROJECT/releases/${APP_NAME}.apk"
python3 - "$PROJECT/releases/${APP_NAME}.apk" <<'PY'
import hashlib, sys
p = sys.argv[1]
print('  sha256', hashlib.sha256(open(p, 'rb').read()).hexdigest())
print('  产物  ', p)
PY

# ---- 升级清单：App 的「检查更新」读的就是它 ---------------------------------
# file 固定写 ASCII 文件名 gamesbox-latest.apk（中文名在 URL 里要编码，局域网
# 静态服务对非 ASCII 路径支持参差）；发布时把包复制成这个名字即可。
echo "==> 生成升级清单 releases/update.json"
python3 "$PROJECT/android/gen_update_json.py" \
  --apk "$PROJECT/releases/${APP_NAME}.apk" \
  --code "$VERSION_CODE" \
  --name "$VERSION_NAME" \
  --file gamesbox-latest.apk \
  --out "$PROJECT/releases/update.json"
echo "==> 构建完成（versionCode ${VERSION_CODE} / ${VERSION_NAME}）"
