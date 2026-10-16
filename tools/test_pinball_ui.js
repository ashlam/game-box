#!/usr/bin/env node
/**
 * 弹珠台 · 真机布局回归（用无头 Chrome 量真实渲染尺寸）
 *
 * 为什么需要它：tools/test_pinball.js 跑在**假 DOM** 里，CSS 完全不生效
 * （clientWidth/Height 全是写死值）。所以「记分牌会不会被挤出去、倍率灯会不会换行、
 * 出口灯排会不会溢出、扳机键够不够大」这类**纯布局**问题，那边量不出来。
 * 这个脚本补上那一半：起真 Chrome、真渲染、读 getBoundingClientRect()。
 *
 * ★ 这套东西第一次跑就抓到了真 bug：机台背板（4 个数据格 + 5 个倍率灯）
 *   在 390px 屏上比视口宽，第 4 格「最高代币」和「10x」灯被切掉一半。
 *
 * 用法：node tools/test_pinball_ui.js [站点根URL]
 *   默认 http://127.0.0.1:4321 —— 需要先跑 ops/serve_site.py 4321 web
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:4321';

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
/** ★ 数值断言必须先确认「真的是个有限数」：undefined/NaN 比大小会假绿 */
function okNum(v, cmp, name, unit){
  const bad = (typeof v !== 'number') || !Number.isFinite(v);
  if(bad){ fail++; failures.push(name + ' → 量到的不是有限数: ' + JSON.stringify(v));
           console.log('  ✗ ' + name + '  → 量到的不是有限数: ' + JSON.stringify(v)); return; }
  ok(cmp(v), name, unit);
}
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

function findChrome(){
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for(const c of cands){ try{ if(fs.existsSync(c)) return c; }catch(e){} }
  return null;
}

/** 用无头 Chrome 打开探测页，页面把量到的 JSON 塞进 <pre>，再 --dump-dom 抓回来。
 *  ⚠️ 探测页必须与游戏**同源**，否则读不了 iframe 里的 DOM。 */
function probe(chrome, iframeW, iframeH, siteRoot){
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title>
<style>body{margin:0}iframe{border:0;position:absolute;left:-99999px}</style></head><body>
<pre id="out">pending</pre>
<iframe id="f"></iframe>
<script>
const W=${iframeW},H=${iframeH};
const f=document.getElementById('f');
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/pinball/';
f.onload=()=>setTimeout(()=>{
  let o;
  try{
    const d=f.contentDocument, E=id=>d.getElementById(id), g=id=>E(id).getBoundingClientRect();
    const cv=g('cv'), board=g('board'), ctl=g('ctlbar'), trig=g('btnTrig');
    const coin=g('btnCoin'), start=g('btnStart');
    const boardEl=E('board'), ctlEl=E('ctlbar');
    const ledEls=[...d.querySelectorAll('#leds .led')];
    const ledRects=ledEls.map(e=>e.getBoundingClientRect());
    const stats=[...d.querySelectorAll('.stats .stat')].map(e=>e.getBoundingClientRect());
    const vEls=['vCoins','vBet','vMult','vBest'].map(id=>E(id));
    /* 出口灯/出口槽是画在 canvas 里的，量不到 DOM；这里只量 DOM 部分，
       画布内容由 tools/test_pinball.js 的绘制断言覆盖。 */
    /* ★ 关键：body 是 overflow:hidden，内容一旦比视口宽**不会出滚动条、会被静默裁掉**。
       所以 docScrollW 那类断言查不出问题（永远等于视口宽），必须直接比较
       「各元素的右沿 vs 视口宽」—— 第一版只查了 scrollWidth，于是漏掉了
       「背板/倍率灯被切掉一半」这个真实 bug（截图里肉眼可见）。 */
    const rights=[board.right, cv.right, ctl.right,
                  ...stats.map(r=>r.right), ...ledRects.map(r=>r.right)];
    const lefts=[board.left, cv.left, ctl.left,
                 ...stats.map(r=>r.left), ...ledRects.map(r=>r.left)];
    o={ok:true, vw:d.documentElement.clientWidth, vh:d.documentElement.clientHeight,
       docScrollW:d.documentElement.scrollWidth, docScrollH:d.documentElement.scrollHeight,
       bodyScrollW:d.body.scrollWidth,
       maxRight:Math.max.apply(null, rights),
       minLeft:Math.min.apply(null, lefts),
       bodyPadL:parseFloat(getComputedStyle(d.body).paddingLeft),
       bodyPadR:parseFloat(getComputedStyle(d.body).paddingRight),
       boardW:board.width, boardLeft:board.left, boardRight:board.right,
       boardScrollW:boardEl.scrollWidth, boardClientW:boardEl.clientWidth,
       boardOverflow:boardEl.scrollWidth-boardEl.clientWidth,
       cvW:cv.width, cvH:cv.height, cvLeft:cv.left, cvRight:cv.right,
       cvBottom:cv.bottom,
       ctlW:ctl.width, ctlLeft:ctl.left, ctlRight:ctl.right, ctlBottom:ctl.bottom,
       ctlScrollW:ctlEl.scrollWidth, ctlClientW:ctlEl.clientWidth,
       ctlOverflow:ctlEl.scrollWidth-ctlEl.clientWidth,
       trigW:trig.width, trigH:trig.height,
       trigTop:trig.top, trigLeft:trig.left, trigRight:trig.right,
       ctlH:ctl.height,
       coinW:coin.width, coinH:coin.height,
       coinTop:coin.top, coinLeft:coin.left, coinRight:coin.right,
       startW:start.width, startH:start.height,
       startTop:start.top, startLeft:start.left, startRight:start.right,
       ledN:ledRects.length,
       ledFirstLeft:ledRects.length?ledRects[0].left:null,
       ledLastRight:ledRects.length?ledRects[ledRects.length-1].right:null,
       ledMinW:ledRects.length?Math.min(...ledRects.map(r=>r.width)):null,
       ledMinH:ledRects.length?Math.min(...ledRects.map(r=>r.height)):null,
       statN:stats.length,
       statMinW:stats.length?Math.min(...stats.map(r=>r.width)):null,
       statLastRight:stats.length?stats[stats.length-1].right:null,
       statOverflow:stats.length?Math.max(...stats.map(r=>r.right))-board.right:null,
       /* 数值会不会溢出各自的数据格（scrollWidth > clientWidth = 被截） */
       valClipped:vEls.map(e=>e.scrollWidth-e.clientWidth),
       valTexts:vEls.map(e=>e.textContent),
       /* 文字太小会读不清 */
       ledFont:ledEls.length?parseFloat(getComputedStyle(ledEls[0]).fontSize):null,
       coinFont:parseFloat(getComputedStyle(E('btnCoin')).fontSize),
       trigFont:parseFloat(getComputedStyle(E('btnTrig')).fontSize),
      };
  }catch(e){ o={ok:false,err:e.message}; }
  document.getElementById('out').textContent=JSON.stringify(o);
},700);
</script></body></html>`;
  const tmpPage = path.join(siteRoot, '_pinball_probe.html');
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pui-'));
  const profile = path.join(tmpDir, 'profile');
  let dom = '';
  try{
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, '--virtual-time-budget=25000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_pinball_probe.html',
    ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  }catch(e){ dom = (e && e.stdout) ? String(e.stdout) : ''; }
  finally{
    try{ fs.rmSync(tmpDir, { recursive: true, force: true }); }catch(e){}
    try{ fs.rmSync(tmpPage, { force: true }); }catch(e){}
  }
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if(!m) return null;
  const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  if(!txt || txt === 'pending') return null;
  try{ return JSON.parse(txt); }catch(e){ return null; }
}

/* ---------------- 跑 ---------------- */
const chrome = findChrome();
if(!chrome){ console.log('没找到 Chrome/Edge，跳过真机布局回归。'); process.exit(0); }
const SITE_ROOT = path.join(__dirname, '..', 'web');
if(!fs.existsSync(SITE_ROOT)){ console.log('找不到站点根 ' + SITE_ROOT + '，跳过。'); process.exit(0); }
console.log('用 ' + path.basename(chrome) + ' 量真实渲染尺寸');
console.log('被测页面: ' + BASE.replace(/\/$/, '') + '/pinball/');

const first = probe(chrome, 360, 640, SITE_ROOT);
if(first === null){
  console.log('\n⚠️ 这个 Chrome 的 --dump-dom 拿不到内容，无法做真机布局测量 —— 跳过。');
  process.exit(0);
}
if(!first.ok){
  console.log('\n✗ 探测页读不到游戏页面: ' + first.err);
  console.log('  请先起本地站： python ops/serve_site.py 4321 web');
  process.exit(1);
}

const results = [];
for(const [w, h, label] of VIEWPORTS){
  const r = probe(chrome, w, h, SITE_ROOT);
  if(!r || !r.ok){ ok(false, label + ' ' + w + '×' + h + ' 测量失败', r ? r.err : 'dump-dom 无输出'); continue; }
  results.push({ w, h, label, r });
}

section('1) 机台背板与记分牌：不溢出、不被切');
ok(results.length === VIEWPORTS.length,
   '全部 ' + VIEWPORTS.length + ' 个尺寸都量到了（实际 ' + results.length + ' 个）');
for(const { w, h, label, r } of results){
  const tag = `${label} ${w}×${h}`;
  okNum(r.boardOverflow, v => v <= 1, tag + ' 背板不横向溢出', '溢出 ' + r.boardOverflow + 'px');
  /* ★ 最硬的一条：所有元素都必须落在视口内。
     body 是 overflow:hidden —— 超出去既不报错也不出滚动条，只会被静默裁掉，
     所以「scrollWidth 有没有超」查不出来，必须直接比右沿/左沿。 */
  okNum(r.maxRight, v => v <= r.vw + 1, tag + ' 所有元素右沿都在视口内',
        '最右 ' + (r.maxRight == null ? '?' : r.maxRight.toFixed(1)) + ' > 视口 ' + r.vw);
  okNum(r.minLeft, v => v >= -1, tag + ' 所有元素左沿都在视口内',
        '最左 ' + (r.minLeft == null ? '?' : r.minLeft.toFixed(1)));
  okNum(r.statOverflow, v => v <= 1, tag + ' 第 4 格「最高代币」没被切掉',
        '最右格右沿超出背板 ' + (r.statOverflow == null ? '?' : r.statOverflow.toFixed(1)) + 'px');
  okNum(r.statN, v => v === 4, tag + ' 记分牌 4 格都在');
  okNum(r.statMinW, v => v >= 56, tag + ' 每格宽度 ≥ 56px（够放 6 位数字）', '最窄 ' + r.statMinW + 'px');
  const clipped = (r.valClipped || []).filter(v => v > 1);
  ok(clipped.length === 0, tag + ' 4 个数值都没被截断',
     clipped.length ? ('被截的：' + JSON.stringify(r.valClipped) + ' 文本 ' + JSON.stringify(r.valTexts)) : '');
}

section('2) 五档倍率灯：都在、够大、不溢出');
for(const { w, h, label, r } of results){
  const tag = `${label} ${w}×${h}`;
  okNum(r.ledN, v => v === 5, tag + ' 五档倍率灯都在', '实际 ' + r.ledN + ' 个');
  okNum(r.ledMinW, v => v >= 42, tag + ' 每个灯宽 ≥ 42px', '最窄 ' + r.ledMinW + 'px');
  okNum(r.ledMinH, v => v >= 20, tag + ' 每个灯高 ≥ 20px', '最矮 ' + r.ledMinH + 'px');
  okNum(r.ledLastRight, v => v <= r.boardRight + 1, tag + ' 10x 灯没被切掉',
        '右沿 ' + (r.ledLastRight == null ? '?' : r.ledLastRight.toFixed(1)) + ' vs 背板 ' + r.boardRight.toFixed(1));
  okNum(r.ledFirstLeft, v => v >= r.boardLeft - 1, tag + ' 2x 灯没被切掉');
}

section('3) 场地画布：铺得开、不溢出');
for(const { w, h, label, r } of results){
  const tag = `${label} ${w}×${h}`;
  okNum(r.cvW, v => v > 0 && v <= r.vw + 1, tag + ' 画布宽度合理', r.cvW + 'px');
  okNum(r.cvH, v => v >= 220, tag + ' 画布高度 ≥ 220px（场地不至于压扁）', r.cvH + 'px');
  okNum(r.cvLeft, v => v >= -1, tag + ' 画布没往左溢出');
  okNum(r.cvRight, v => v <= r.vw + 1, tag + ' 画布没往右溢出');
  /* 画布要占掉视口相当一部分（不然场地太小看不清） */
  const ratio = r.cvH / r.vh;
  okNum(ratio, v => v >= 0.42, tag + ' 画布占视口高度 ≥ 42%', (ratio * 100).toFixed(1) + '%');
}

section('4) 控制条：一排三键（投币 | 开始 | 拉扳机）、都够大、不溢出');
for(const { w, h, label, r } of results){
  const tag = `${label} ${w}×${h}`;
  okNum(r.ctlOverflow, v => v <= 1, tag + ' 控制条不横向溢出', '溢出 ' + r.ctlOverflow + 'px');
  /* 触控目标 ≥ 44px（iOS HIG 的舒适区下限） */
  okNum(r.trigH, v => v >= 44, tag + ' 扳机键高 ≥ 44px', r.trigH + 'px');
  okNum(r.coinH, v => v >= 44, tag + ' 投币口高 ≥ 44px', r.coinH + 'px');
  okNum(r.startH, v => v >= 44, tag + ' 开始键高 ≥ 44px', r.startH + 'px');
  /* ★ 改成**一排三键**之后每个键都窄了，但每个都必须仍然好点：
     390px 宽的手机上可用宽约 382px，减去两个 6px 间隙 = 370px，
     按 flex 1 : 1.05 : 1.35 分 → 最窄的投币口 ≈ 108px。 */
  /* ★ 宽度门槛按**视口比例**给，不给固定像素：320px 的窄屏上三键平分之后
     每键必然更窄（实测扳机 100px），用固定 110px 卡会把「窄屏也能玩」误判成 bug。
     比例门槛取 0.29（320px → 93px；390px → 113px），保证窄屏也够点。 */
  okNum(r.coinW / r.vw, v => v >= 0.2, tag + ' 投币口宽 ≥ 视口 20%', r.coinW.toFixed(0) + 'px');
  okNum(r.startW / r.vw, v => v >= 0.2, tag + ' 开始键宽 ≥ 视口 20%', r.startW.toFixed(0) + 'px');
  okNum(r.trigW / r.vw, v => v >= 0.29, tag + ' 扳机键宽 ≥ 视口 29%（最常用，份额最大）', r.trigW.toFixed(0) + 'px');
  /* 扳机必须是三键里最宽的（份额最大 = 最顺手） */
  ok(r.trigW > r.coinW && r.trigW > r.startW,
     tag + ' 扳机键是三键里最宽的',
     `扳${r.trigW.toFixed(0)} 币${r.coinW.toFixed(0)} 开${r.startW.toFixed(0)}`);
  /* ★★ 关键：三键必须**真的在同一排** —— 用 bottom 对齐来验证，
     而不是只看宽度（原来「投币+开始」一行、扳机独占一行的老布局里宽度断言照样过）。 */
  okNum(Math.abs(r.trigTop - r.coinTop), v => v <= 2,
        tag + ' 三键顶端对齐 = 同一排', '差 ' + Math.abs(r.trigTop - r.coinTop).toFixed(1) + 'px');
  okNum(Math.abs(r.trigTop - r.startTop), v => v <= 2,
        tag + ' 扳机与开始同行', '差 ' + Math.abs(r.trigTop - r.startTop).toFixed(1) + 'px');
  /* 三键不重叠（按水平顺序：投币 < 开始 < 扳机） */
  ok(r.coinRight <= r.startLeft + 1 && r.startRight <= r.trigLeft + 1,
     tag + ' 三键左右不重叠（投币→开始→扳机）',
     `币右${r.coinRight.toFixed(0)} 开左${r.startLeft.toFixed(0)} 开右${r.startRight.toFixed(0)} 扳左${r.trigLeft.toFixed(0)}`);
  /* ★ 一排之后控制条必须**明显变矮**（这正是改布局的目的：把高度还给场地） */
  okNum(r.ctlH, v => v <= 72, tag + ' 控制条总高 ≤ 72px（一排的收益）', r.ctlH.toFixed(0) + 'px');
  okNum(r.trigFont, v => v >= 12, tag + ' 扳机键字号 ≥ 12px', r.trigFont + 'px');
  okNum(r.coinFont, v => v >= 10, tag + ' 投币口字号 ≥ 10px', r.coinFont + 'px');
}

section('5) 整页不出现滚动条（竖屏下应当刚好放下）');
for(const { w, h, label, r } of results){
  const tag = `${label} ${w}×${h}`;
  okNum(r.docScrollW, v => v <= r.vw + 1, tag + ' 页面不横向滚动', r.docScrollW + ' > ' + r.vw);
  okNum(r.docScrollH, v => v <= r.vh + 2, tag + ' 页面不纵向滚动', r.docScrollH + ' > ' + r.vh);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(60));
if(fail === 0) console.log(`全部通过：${pass} 项断言 ✅`);
else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项 ❌`);
  console.log('\n失败清单：');
  for(const f of failures) console.log('  · ' + f);
}
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
