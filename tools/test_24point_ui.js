#!/usr/bin/env node
/**
 * 24 点 · 真机布局回归（无头 Chrome 真渲染，量真实像素）
 *
 * 为什么需要它：tools/test_24point.js 跑在假 DOM 里，CSS 不生效，
 * 「牌够不够大、四个运算符键会不会挤成一条缝、竖屏小手机上按钮会不会被挤出屏幕」
 * 这类纯布局问题只能在真浏览器里量。这个脚本补上那一半。
 *
 * 用法：node tools/test_24point_ui.js [站点根URL]
 *   默认 http://127.0.0.1:4321 —— 需要先跑 python ops/serve_site.py 4321 web
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const GAME = BASE.replace(/\/$/, '') + '/24point/';

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
function okNum(v, cmp, name, unit){
  if(typeof v !== 'number' || !Number.isFinite(v)){
    fail++; failures.push(name + ' → 量到的不是有限数: ' + JSON.stringify(v));
    console.log('  ✗ ' + name + '  → 量到的不是有限数: ' + JSON.stringify(v)); return;
  }
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

/** 探测页必须和游戏同源（file:// 读不了 http:// 的 iframe），所以写进 web/ 再删掉 */
function probe(chrome, W, H, siteRoot){
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title>
<style>body{margin:0}iframe{border:0;position:absolute;left:-99999px}</style></head><body>
<pre id="out">pending</pre>
<iframe id="f"></iframe>
<script>
const W=${W},H=${H};
const f=document.getElementById('f');
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/24point/';
f.onload=()=>setTimeout(()=>{
  let o;
  try{
    const d=f.contentDocument, E=id=>d.getElementById(id), g=id=>E(id).getBoundingClientRect();
    const rect=e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
    const cards=[...d.querySelectorAll('#cards .card')].map(rect);
    const ops=[...d.querySelectorAll('#ops button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim()}));
    const tools=[...d.querySelectorAll('#tools button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim()}));
    const body=d.body, de=d.documentElement;
    const base={
      ok:true,
      vw:de.clientWidth, vh:de.clientHeight,
      bodyScrollH:body.scrollHeight, bodyClientH:body.clientHeight,
      overflowY:body.scrollHeight-body.clientHeight,
      overflowX:de.scrollWidth-de.clientWidth,
      cards, ops, tools,
      opsTop:g('ops').top, opsBottom:g('ops').bottom,
      stageTop:g('stage').top, stageBottom:g('stage').bottom,
      cardFont:parseFloat(getComputedStyle(d.querySelector('#cards .card .val')).fontSize),
      tipH:g('tip').height,
    };

    /* ★ 选中两张牌（待算式出来）时的布局：这一行不能把整页顶出屏幕，
       也不能压到下面的运算符键。 */
    {
      const w0=f.contentWindow, cc=w0.__g24().cards;
      w0.__g24Pick(cc[0].id); w0.__g24Pick(cc[1].id);
      const pd=E('pending'), rp=pd.getBoundingClientRect();
      const pendingText=pd.textContent;
      const cardB=Math.max(...[...d.querySelectorAll('#cards .card')].map(e=>e.getBoundingClientRect().bottom));
      const opsT=g('ops').top;
      base.pending={
        shown: rp.height>0,
        text: pendingText,
        top:rp.top, bottom:rp.bottom, h:rp.height,
        cardBottom:cardB,
        opsTop:opsT,
        overflowY:d.body.scrollHeight-d.body.clientHeight,
        overflowX:d.documentElement.scrollWidth-d.documentElement.clientWidth,
        opsWant: E('ops').classList.contains('want'),
        tip: E('tip').textContent,
      };
      w0.__g24Reset();     // 量完恢复，别影响后面的结算探针
    }

    /* ★ 结算演出也要量。做法：直接把这局推到通关，再等到「大字 + 两行说明」都出来那一拍，
       量演出区的位置与整页溢出 —— 演出要是把牌盖住或者把按钮顶出屏幕，这里必须红。 */
    const w=f.contentWindow;
    let guard=0;
    while(w.__g24().state==='play' && guard++<8){ if(!w.__g24DemoStep(false)) break; }
    const BS=w.__g24Banner();

    setTimeout(()=>{
      try{
        const bn=E('banner'), big=E('bannerBig'), line=E('bannerLine');
        const rb=bn.getBoundingClientRect(), rbig=big.getBoundingClientRect();
        const cardRects=[...d.querySelectorAll('#cards .card')].map(rect);
        base.settle={
          state: w.__g24().state,
          title: BS.title,
          bannerH: rb.height,
          bannerTop: rb.top, bannerBottom: rb.bottom,
          bigTop: rbig.top, bigBottom: rbig.bottom,
          cardBottom: cardRects.length ? Math.max(...cardRects.map(r=>r.bottom)) : 0,
          lineText: line.textContent,
          overflowY: d.body.scrollHeight-d.body.clientHeight,
          overflowX: d.documentElement.scrollWidth-d.documentElement.clientWidth,
          toolsBottom: Math.max(...tools.map(t=>t.bottom)),
          total: BS.total,
        };
      }catch(e){ base.settleErr=e.message; }
      document.getElementById('out').textContent=JSON.stringify(base);
    }, 3400);
  }catch(e){
    document.getElementById('out').textContent=JSON.stringify({ok:false,err:e.message});
  }
},700);
</script></body></html>`;
  const tmpPage = path.join(siteRoot, '_ui_probe_24.html');
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-g24ui-'));
  const profile = path.join(tmpDir, 'profile');
  let dom = '';
  try{
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, '--virtual-time-budget=25000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_ui_probe_24.html',
    ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  }catch(e){
    dom = (e && e.stdout) ? String(e.stdout) : '';
  }finally{
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

const chrome = findChrome();
if(!chrome){
  console.log('没找到 Chrome/Edge，跳过真机布局回归。');
  process.exit(0);
}
const SITE_ROOT = path.join(__dirname, '..', 'web');
if(!fs.existsSync(SITE_ROOT)){ console.log('找不到站点根，跳过。'); process.exit(0); }

console.log('用 ' + path.basename(chrome) + ' 量真实渲染尺寸');
console.log('被测页面: ' + GAME);

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
for(const [w, h, name] of VIEWPORTS){
  const r = (w === 360 && h === 640) ? first : probe(chrome, w, h, SITE_ROOT);
  if(r === null){ console.log(`\n-- ${name} ${w}×${h} --\n  ⚠️ 量不到，跳过`); continue; }
  results.push([name, w, h, r]);
}

if(!results.length){ console.log('所有视口都量不到，跳过。'); process.exit(0); }

for(const [name, w, h, r] of results){
  section(`${name}  ${w}×${h}`);

  okNum(r.overflowX, v => v <= 1, '不横向溢出（页面没有左右滚动）', '溢出 ' + r.overflowX + 'px');
  okNum(r.overflowY, v => v <= 1, '不纵向溢出（一屏放得下，不用滚）', '溢出 ' + r.overflowY + 'px');

  ok(r.cards.length === 4, '四张牌都在', String(r.cards.length));

  // 牌要够大好点：短边 ≥ 76px（320 窄屏最低要求）
  const minCardW = Math.min(...r.cards.map(c => c.w));
  const minCardH = Math.min(...r.cards.map(c => c.h));
  okNum(minCardW, v => v >= 76, '每张牌宽 ≥ 76px（手指点得准）', '最窄 ' + minCardW.toFixed(1) + 'px');
  okNum(minCardH, v => v >= 76, '每张牌高 ≥ 76px', '最矮 ' + minCardH.toFixed(1) + 'px');

  // 2×2 布局：前两张同一行、后两张同一行
  const rows = new Set(r.cards.map(c => Math.round(c.top)));
  ok(rows.size === 2, '四张牌排成 2×2（不是 1×4 挤成一条）', '行数 ' + rows.size);
  const sameRow = Math.abs(r.cards[0].top - r.cards[1].top) < 1;
  ok(sameRow, '第 1、2 张在同一行');
  ok(r.cards[2].top > r.cards[1].bottom, '第 3、4 张在第 1、2 张下面', `gap=${(r.cards[2].top - r.cards[1].bottom).toFixed(1)}`);

  // 运算符键：四个一排，每个都够大、互不重叠
  ok(r.ops.length === 4, '四个运算符键都在', String(r.ops.length));
  const minOpH = Math.min(...r.ops.map(o => o.h));
  const minOpW = Math.min(...r.ops.map(o => o.w));
  okNum(minOpH, v => v >= 44, '运算符键高 ≥ 44px（触屏最小可点尺寸）', '最矮 ' + minOpH.toFixed(1) + 'px');
  okNum(minOpW, v => v >= 40, '运算符键宽 ≥ 40px', '最窄 ' + minOpW.toFixed(1) + 'px');
  ok(r.ops.every((o, i) => i === 0 || o.left >= r.ops[i - 1].right - 0.5), '四个运算符键不重叠');
  ok(Math.max(...r.ops.map(o => Math.abs(o.top - r.ops[0].top))) < 1, '四个运算符键在同一行');

  // 工具条三个键
  ok(r.tools.length === 3, '三个工具键都在', String(r.tools.length));
  const minToolH = Math.min(...r.tools.map(o => o.h));
  okNum(minToolH, v => v >= 38, '工具键高 ≥ 38px', '最矮 ' + minToolH.toFixed(1) + 'px');
  ok(r.tools.every(t => t.text && t.text.length > 0), '工具键都有文字（没被挤没）');

  // 牌桌区域要留够空间，不能被上下挤压成 0
  okNum(r.stageBottom - r.stageTop, v => v >= 240, '牌桌区域高 ≥ 240px', (r.stageBottom - r.stageTop).toFixed(1) + 'px');

  // 牌面数字字号要够看
  okNum(r.cardFont, v => v >= 26, '牌面数字字号 ≥ 26px', r.cardFont.toFixed(1) + 'px');

  // 最后一行按钮必须在屏幕内
  const lastBottom = Math.max(...r.tools.map(t => t.bottom), r.opsBottom);
  okNum(lastBottom, v => v <= h + 1, '底部按钮没被挤出屏幕', '最低点 ' + lastBottom.toFixed(1) + ' / 屏高 ' + h);

  /* ---------- 待算式（选中两张牌） ---------- */
  section(`${name} ${w}×${h} · 待算式`);
  if(!r.pending){
    ok(false, '待算式没量到（探针没跑完）');
  } else {
    const p = r.pending;
    ok(p.shown === true, '选满两张后待算式出现', JSON.stringify(p.text));
    ok(/\d/.test(p.text) && p.text.indexOf('?') >= 0, '待算式里有数字和待填空位', p.text);
    ok(p.opsWant === true, '运算符键被叫醒');
    okNum(p.h, v => v >= 20, '待算式有实际高度（真的画出来了）', p.h.toFixed(1) + 'px');
    ok(p.top >= p.cardBottom - 1, '待算式在牌下面', `pending.top=${p.top.toFixed(1)} card.bottom=${p.cardBottom.toFixed(1)}`);
    ok(p.bottom <= p.opsTop + 1, '★ 待算式没有压到运算符键',
       `pending.bottom=${p.bottom.toFixed(1)} ops.top=${p.opsTop.toFixed(1)}`);
    okNum(p.overflowY, v => v <= 1, '待算式出现时仍不纵向溢出', '溢出 ' + p.overflowY + 'px');
    okNum(p.overflowX, v => v <= 1, '待算式出现时仍不横向溢出', '溢出 ' + p.overflowX + 'px');
    ok(p.tip.indexOf('运算符') >= 0, '提示语指向下一步', p.tip);
  }

  /* ---------- 结算演出（通关后那一拍） ---------- */
  section(`${name} ${w}×${h} · 结算演出`);
  if(r.settleErr){
    ok(false, '结算演出量不到', r.settleErr);
  } else if(!r.settle){
    ok(false, '结算演出没量到（探针没跑完）');
  } else {
    const s = r.settle;
    ok(s.state === 'win', '探针把局面推到了通关', s.state);
    ok(s.title === '过 关', '演出大字已就位', s.title);
    okNum(s.bannerH, v => v > 40, '演出区有实际高度（大字+说明真的显示出来了）', s.bannerH.toFixed(1) + 'px');
    ok(s.lineText.length > 0, '说明文字已经浮出', JSON.stringify(s.lineText));

    // ★ 演出不能盖住那张 24
    ok(s.bannerTop >= s.cardBottom - 1, '★ 演出排在牌的下面，不遮挡那张 24',
       `banner.top=${s.bannerTop.toFixed(1)} card.bottom=${s.cardBottom.toFixed(1)}`);
    ok(s.bigTop >= s.cardBottom - 1, '★ 大字也不压牌',
       `big.top=${s.bigTop.toFixed(1)} card.bottom=${s.cardBottom.toFixed(1)}`);

    // 演出期间页面仍然不能溢出、按钮不能被顶出去
    okNum(s.overflowY, v => v <= 1, '演出期间仍不纵向溢出', '溢出 ' + s.overflowY + 'px');
    okNum(s.overflowX, v => v <= 1, '演出期间仍不横向溢出', '溢出 ' + s.overflowX + 'px');
    okNum(s.toolsBottom, v => v <= h + 1, '演出期间底部按钮还在屏幕内',
       '最低点 ' + s.toolsBottom.toFixed(1) + ' / 屏高 ' + h);
    okNum(s.total, v => v > 3000, '演出总时长 > 3 秒（放慢过）', s.total + 'ms');
  }
}

console.log('\n' + '='.repeat(52));
if(fail === 0) console.log(`全部通过：${pass} 项（${results.length} 个视口）`);
else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
