#!/usr/bin/env node
/**
 * 弹珠乐园 · 真机布局回归（用无头 Chrome 量真实渲染尺寸）
 *
 * 为什么需要它：tools/test_marble.js 跑在**假 DOM** 里，CSS 完全不生效
 * （clientWidth/Height 全是写死值）。所以「方向键够不够大、两键之间够不够开、
 * 发射键会不会换行」这类**纯布局**问题，那边只能做源码级断言，量不出真实像素。
 * 这个脚本补上那一半：起真 Chrome、真渲染、读 getBoundingClientRect()。
 *
 * 用法：node tools/test_marble_ui.js [站点根URL]
 *   默认 http://127.0.0.1:4321 —— 需要先跑 ops/serve_site.py 4321 web
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const MARBLE = BASE.replace(/\/$/, '') + '/marble/';

/* 常见竖屏手机尺寸（含最窄的 320 级老机型） */
const VIEWPORTS = [
  [320, 568, 'iPhone SE(1) 窄屏'],
  [360, 640, 'Android 常见小屏'],
  [360, 740, 'Android 常见'],
  [375, 667, 'iPhone 8'],
  [390, 844, 'iPhone 14'],
  [414, 896, 'iPhone XR/11'],
];

let pass = 0, fail = 0;
const failures = [];
/** ★ 断言数值型指标时用这个：任何 NaN/null/undefined 一律判失败。
 *   起因：「控件条不溢出」那条曾经拿 undefined 比大小 → `null <= 1` 恒真 → 假绿。
 *   数值断言必须先确认「真的是个有限数」。 */
function okNum(v, cmp, name, unit) {
  const bad = (typeof v !== 'number') || !Number.isFinite(v);
  if (bad) { fail++; failures.push(name + ' → 量到的不是有限数: ' + JSON.stringify(v)); console.log('  ✗ ' + name + '  → 量到的不是有限数: ' + JSON.stringify(v)); return; }
  ok(cmp(v), name, unit);
}
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ---------------- 找 Chrome ---------------- */
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

/** 用无头 Chrome 打开一个探测页，页面把量到的 JSON 渲染进 <pre>，再用 --dump-dom 抓回来。
 *  ⚠️ 探测页必须和游戏**同源**，否则读不了 iframe 里的 DOM（file:// → http:// 是跨源）。
 *  所以探测页要写进站点根目录（web/），量完立刻删掉。 */
function probe(chrome, iframeW, iframeH, siteRoot) {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title>
<style>body{margin:0}iframe{border:0;position:absolute;left:-99999px}</style></head><body>
<pre id="out">pending</pre>
<iframe id="f"></iframe>
<script>
const W=${iframeW},H=${iframeH};
const f=document.getElementById('f');
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/marble/';
f.onload=()=>setTimeout(()=>{
  let o;
  try{
    /* ⚠️ 元素本身（才有 scrollWidth/clientWidth）和 rect 要分开取：
     *   以前把 ctl 写成 getBoundingClientRect()，结果 ctl.scrollWidth 是 undefined
     *   → NaN → JSON 变 null → "null <= 1" 恒真，那条「不溢出」断言是假的。 */
    const d=f.contentDocument, E=id=>d.getElementById(id), g=id=>E(id).getBoundingClientRect();
    const L=g('btnLeft'), R=g('btnRight'), fire=g('btnFire'), cv=g('cv');
    const ctlEl=E('ctlbar'), fireEl=E('btnFire');
    o={ok:true, vw:d.documentElement.clientWidth,
       aimW:L.width, aimH:L.height, gap:R.left-L.right,
       centerDist:Math.abs((L.left+L.width/2)-(R.left+R.width/2)),
       fireW:fire.width, fireH:fire.height,
       fireScrollH:fireEl.scrollHeight,
       fireClientH:fireEl.clientHeight,
       ctlScrollW:ctlEl.scrollWidth, ctlClientW:ctlEl.clientWidth,
       ctlOverflow:ctlEl.scrollWidth-ctlEl.clientWidth,
       cvH:cv.height, ctlBottom:ctlEl.getBoundingClientRect().bottom};
  }catch(e){ o={ok:false,err:e.message}; }
  document.getElementById('out').textContent=JSON.stringify(o);
},600);
</script></body></html>`;
  const tmpPage = path.join(siteRoot, '_ui_probe.html');   // ★ 与游戏同源
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mui-'));
  const profile = path.join(tmpDir, 'profile');
  let dom = '';
  try {
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, '--virtual-time-budget=25000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_ui_probe.html',
    ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    dom = (e && e.stdout) ? String(e.stdout) : '';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpPage, { force: true }); } catch (e) {}
  }
  /* ⚠️ 拿不到 DOM（有的 Chrome 构建 --dump-dom 是空的）时返回 null，
   *   由调用方决定「跳过」而不是当成失败 —— 否则脚本会在这种环境里永远红。 */
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!m) return null;
  const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  if (!txt || txt === 'pending') return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

/* ---------------- 跑 ---------------- */
const chrome = findChrome();
if (!chrome) {
  console.log('没找到 Chrome/Edge，跳过真机布局回归。');
  process.exit(0);
}
/* 探测页要写进站点根（与游戏同源），所以得知道 web/ 在哪 */
const SITE_ROOT = path.join(__dirname, '..', 'web');
if (!fs.existsSync(SITE_ROOT)) {
  console.log('找不到站点根 ' + SITE_ROOT + '，跳过。');
  process.exit(0);
}
console.log('用 ' + path.basename(chrome) + ' 量真实渲染尺寸');
console.log('被测页面: ' + MARBLE);

/* 先探测一次，判断能否真量到 */
const first = probe(chrome, 360, 640, SITE_ROOT);
if (first === null) {
  console.log('\n⚠️ 这个 Chrome 的 --dump-dom 拿不到内容，无法做真机布局测量 —— 跳过。');
  console.log('   （纯布局部分请用真机/开发者工具人工确认；JS 逻辑由 tools/test_marble.js 覆盖）');
  process.exit(0);
}
if (!first.ok) {
  console.log('\n✗ 探测页读不到游戏页面: ' + first.err);
  console.log('  请先起本地站： python ops/serve_site.py 4321 web');
  process.exit(1);
}

section('1) 每个竖屏尺寸下，方向键都要够大、够开');
const results = [];
for (const [w, h, label] of VIEWPORTS) {
  const r = probe(chrome, w, h, SITE_ROOT);
  if (!r || !r.ok) { ok(false, label + ' ' + w + '×' + h + ' 测量失败', r ? r.err : 'dump-dom 无输出'); continue; }
  results.push({ w, h, label, r });
}
ok(results.length === VIEWPORTS.length,
   '全部 ' + VIEWPORTS.length + ' 个尺寸都量到了（实际 ' + results.length + ' 个）');

if (results.length) {
  section('2) 触摸目标与防误触');
  for (const { w, h, label, r } of results) {
    okNum(r.aimW, v => v >= 64,
       label + ' ' + w + '×' + h + '：方向键宽 ' + r.aimW + ' ≥ 64');
    okNum(r.aimH, v => v >= 64,
       '  └ 方向键高 ' + r.aimH + ' ≥ 64');
    ok(r.aimW >= 44 && r.aimH >= 44, '  └ 达到 44px 最小触摸目标');
    /* 防误触：两键中心距要够大，间隙要够宽（原来 8px 间隙 / 62px 中心距太挤） */
    okNum(r.gap, v => v >= 10, '  └ 两键间隙 ' + r.gap + 'px ≥ 10（原来 8px）');
    okNum(r.centerDist, v => v >= 80,
       '  └ 两键中心距 ' + r.centerDist + 'px ≥ 80（原来 62px，容易点进缝里按错）');
  }

  section('3) 发射键：不换行、不溢出');
  for (const { w, h, label, r } of results) {
    okNum(r.fireH, v => v >= 40, label + '：发射键高 ' + r.fireH + 'px ≥ 40');
    okNum(r.fireScrollH, () => true, '  └ 发射键 scrollHeight 可读（' + r.fireScrollH + '）');
    ok(r.fireScrollH <= r.fireClientH + 1,
       '  └ 文字没有换行顶破按钮（scrollH ' + r.fireScrollH + ' ≤ clientH ' + r.fireClientH + '）');
    okNum(r.ctlOverflow, v => v <= 1,
       '  └ 控件条不横向溢出（' + r.ctlScrollW + ' / ' + r.ctlClientW + '，超出 ' + r.ctlOverflow + 'px）');
  }

  section('4) 画布仍占主要高度（别为了放大按钮把场地挤没了）');
  for (const { w, h, label, r } of results) {
    okNum(r.cvH, v => v / h * 100 >= 65,
       label + '：画布高 ' + r.cvH + 'px = 视口 ' + (r.cvH / h * 100).toFixed(0) + '% ≥ 65%');
  }
}

console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
