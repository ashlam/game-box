#!/usr/bin/env node
/**
 * 应用内升级（检查更新 / 下载 / 安装）回归测试
 *
 * 为什么要单独测：这条链路的失败**全是静默的**。
 *   · JS 里写 `N.cancelDownlaod()`，Java 没这个方法 → 点击毫无反应，控制台也不报错
 *     （Android 的 JS 接口调用失败只打一条 console warning，用户在手机上根本看不到）
 *   · Java 里 emit `{type:'found'}`，JS 的 switch 里少一个 case → 面板一片空白
 *   · 清单里写 `gamesbox-latest.apk`，发布脚本复制成别的名字 → 下载 404
 * 所以这里不测「能不能装上」，只把这几处**跨语言约定**钉死。
 *
 * 覆盖：
 *   1) 首页的升级区块结构与「网页版不显示」的判据
 *   2) ★ JS 调用的每个方法在 Java 的 @JavascriptInterface 里都存在（名字一个不差）
 *   3) ★ Java 发回的每个 state.type 在 JS 里都有 case
 *   4) ★ 清单文件名、版本号注入、provider 授权三处口径一致
 *   5) 清单生成脚本能真的跑出合法 JSON
 *
 * 用法：node tools/test_update.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'android', 'project', 'src', 'com', 'nous', 'gamesbox');

const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const updater = fs.readFileSync(path.join(SRC, 'Updater.java'), 'utf8');
const provider = fs.readFileSync(path.join(SRC, 'ApkProvider.java'), 'utf8');
const main = fs.readFileSync(path.join(SRC, 'MainActivity.java'), 'utf8');
const manifest = fs.readFileSync(path.join(ROOT, 'android', 'project', 'AndroidManifest.xml'), 'utf8');
const buildApk = fs.readFileSync(path.join(ROOT, 'android', 'build_apk.sh'), 'utf8');
const topBuild = fs.readFileSync(path.join(ROOT, 'build-apk.sh'), 'utf8');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 1) 首页区块 ================= */
section('1) 首页的升级入口');
{
  ok(/<section class="upd" id="upd" hidden>/.test(html),
     '★ 升级区块默认 hidden（网页版看不到，也不占位）');
  ok(/\.upd\[hidden\]\{display:none\}/.test(html),
     '★ 显式写了 .upd[hidden]{display:none}（作者样式的 display 会盖掉 UA 的 [hidden]）');
  ok(/id="updBtn"/.test(html) && /id="updPanel"/.test(html), '有按钮和面板两个容器');
  ok(/var N = window\.GamesBoxNative;/.test(html), '先取 GamesBoxNative');
  ok(/if\(!N \|\| !sec \|\| !btn \|\| !panel\) return;/.test(html),
     '★ 拿不到原生接口就直接 return（网页版行为与老版本完全一致）');
  ok(/sec\.hidden = false;/.test(html), '只有在 APK 里才把区块放出来');
  ok(/window\.__gboxUpdate = function/.test(html), '定义了原生的回调入口 __gboxUpdate');
  ok(/id="verline"/.test(html), 'footer 里有版本号的位置');
}

/* ================= 2) JS → Java 方法名 ================= */
section('2) JS 调的每个方法，Java 里都得有');
{
  const javaMethods = [];
  const re = /@JavascriptInterface\s+public\s+[\w$.<>\[\]]+\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(updater)) !== null) javaMethods.push(m[1]);

  const jsCalls = [];
  const re2 = /\bN\.(\w+)\s*\(/g;
  while ((m = re2.exec(html)) !== null) jsCalls.push(m[1]);

  const uniqCalls = Array.from(new Set(jsCalls));
  ok(javaMethods.length >= 6, 'Java 暴露了 ' + javaMethods.length + ' 个接口：' + javaMethods.join(', '));
  ok(uniqCalls.length >= 5, 'JS 调用了 ' + uniqCalls.length + ' 个接口：' + uniqCalls.join(', '));

  const missing = uniqCalls.filter(f => javaMethods.indexOf(f) < 0);
  ok(missing.length === 0, '★ JS 调用的方法在 Java 里全都有', '缺：' + missing.join(', '));

  const unused = javaMethods.filter(f => uniqCalls.indexOf(f) < 0);
  if (unused.length) console.log('    （Java 侧多出来、JS 暂时没用的：' + unused.join(', ') + '）');

  ok(/addJavascriptInterface\(updater\.bridge\(\), "GamesBoxNative"\)/.test(main),
     '★ 注入名必须是 GamesBoxNative（和网页里取的常量一致）');
  ok(/updater = new Updater\(this, webView\);[\s\S]*?webView\.loadUrl/.test(main),
     '★ 先注入接口再 loadUrl（否则首页脚本跑起来时接口还不存在）');
}

/* ================= 3) Java → JS 状态名 ================= */
section('3) Java 发回的状态，JS 都得认');
{
  const states = [];
  const re = /(?:st|state)\("(\w+)"/g;
  let m;
  while ((m = re.exec(updater)) !== null) states.push(m[1]);
  const uniq = Array.from(new Set(states));
  ok(uniq.length >= 6, 'Java 会发这些状态：' + uniq.join(', '));

  // __gboxUpdate 里 switch 的 case（整个脚本里所有 case 也算，面板渲染那份不能漏）
  const cases = [];
  const re2 = /case '(\w+)':/g;
  while ((m = re2.exec(html)) !== null) cases.push(m[1]);

  const lost = uniq.filter(s => cases.indexOf(s) < 0);
  ok(lost.length === 0, '★ 每个状态在 JS 里都有对应的 case', '漏：' + lost.join(', '));

  const needPanel = ['found', 'latest', 'progress', 'ready', 'needPermission', 'installing', 'cancelled', 'error'];
  const painter = html.slice(html.indexOf('function html(st)'));
  const noRender = needPanel.filter(s => painter.indexOf("case '" + s + "'") < 0);
  ok(noRender.length === 0, '★ 每个状态都有面板渲染分支', '漏：' + noRender.join(', '));
}

/* ================= 4) 三处口径一致 ================= */
section('4) 清单文件名 / 版本号 / provider 授权');
{
  const codeInBuild = /versionCode="%s"/.test(buildApk);
  ok(codeInBuild, '★ 打包时把 versionCode 写进临时 manifest（不靠 aapt2 参数）');
  ok(/--manifest "\$OUT\/AndroidManifest\.xml"/.test(buildApk),
     'aapt2 link 用的是带版本号的那份清单');

  ok(/--file gamesbox-latest\.apk/.test(buildApk),
     '★ 清单里的文件名固定为 ASCII 的 gamesbox-latest.apk');
  ok(/cp -f "\$APK" "\$ROOT\/web\/gamesbox-latest\.apk"/.test(topBuild),
     '★ 发布时把包复制成同名的 gamesbox-latest.apk（名字对不上就是 404）');
  ok(/cp -f "\$ROOT\/releases\/update\.json" "\$ROOT\/web\/update\.json"/.test(topBuild),
     '发布时把 update.json 一起放到站点根');

  const authJava = (provider.match(/AUTHORITY\s*=\s*"([^"]+)"/) || [])[1];
  const authXml = (manifest.match(/android:authorities="([^"]+)"/) || [])[1];
  ok(!!authJava && authJava === authXml, '★ provider 的 authorities 两边一致',
     'Java=' + authJava + ' Manifest=' + authXml);
  ok(/android:exported="false"/.test(manifest) && /grantUriPermissions="true"/.test(manifest),
     'provider 不对外导出，只按次授权');

  ok(/android:name="\.ApkProvider"/.test(manifest), 'manifest 里注册了 ApkProvider');
  ok(/android\.permission\.REQUEST_INSTALL_PACKAGES/.test(manifest), '声明了安装未知应用的权限');
  ok(/android\.permission\.INTERNET/.test(manifest), '声明了网络权限');
  ok(/usesCleartextTraffic="true"/.test(manifest), '★ 允许明文 http（局域网更新源就是 http）');

  ok(/update_source\.txt/.test(buildApk) && /ASSET_SOURCE\s*=\s*"update_source\.txt"/.test(updater),
     '默认更新源用 assets/update_source.txt 传递');
  ok(/^android\/project\/assets\/update_source\.txt$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')),
     '这个文件不进版本库（每台机器 IP 不同）');
}

/* ================= 5) 清单生成器 ================= */
section('5) update.json 生成器');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbox-'));
  const fake = path.join(tmp, 'fake.apk');
  fs.writeFileSync(fake, Buffer.alloc(2048, 7));
  const out = path.join(tmp, 'update.json');
  let ran = true, err = '';
  try {
    execFileSync('python3', [
      path.join(ROOT, 'android', 'gen_update_json.py'),
      '--apk', fake, '--code', '37', '--name', '1.37',
      '--file', 'gamesbox-latest.apk', '--out', out,
    ], { stdio: 'pipe' });
  } catch (e) { ran = false; err = String(e.message || e); }

  ok(ran, '脚本能跑通', err.slice(0, 200));
  if (ran) {
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    ok(doc.versionCode === 37, '写入了 versionCode');
    ok(doc.versionName === '1.37', '写入了 versionName');
    ok(doc.file === 'gamesbox-latest.apk', '文件名是 ASCII 的 gamesbox-latest.apk');
    ok(doc.size === 2048, 'size 取自真实文件大小');
    ok(/^[0-9a-f]{64}$/.test(doc.sha256), 'sha256 是 64 位十六进制（App 下载后会拿它对）');
    ok(Array.isArray(doc.notes), 'notes 是数组（面板按列表渲染）');
    ok(typeof doc.builtAt === 'string' && doc.builtAt.length > 10, '有构建时间');
    ok(doc.minSdk === 23, '带 minSdk，太老的机器能被提前劝退');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

/* ================= 6) 不破坏「离线可玩」 ================= */
section('6) 升级功能不能把离线能力弄坏');
{
  ok(!/usesCleartextTraffic="true"[\s\S]{0,400}allowBackup="true"/.test(manifest), '（背景）不涉及备份策略');
  ok(/shouldOverrideUrlLoading/.test(main) && /startsWith\("file:\/\/\/android_asset\/"\)/.test(main),
     '★ WebView 仍然只认内置资源，网页不能自己跳去外部地址');
  ok(!/<script[^>]+src=/i.test(html), '首页仍然没有外部脚本');
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '首页仍然没有外链');
  ok(/if\(!N \|\| !sec/.test(html), '★ 网页版（无原生接口）连按钮都不出现');
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
