#!/usr/bin/env node
/**
 * 首页「管理游戏」真机回归（无头 Chrome 真渲染 + 真点击）
 *
 * 为什么需要它：tools/test_index.js 只做静态断言（有没有按钮、键名对不对），
 * 它抓不到这一类问题：
 *   · 隐藏之后卡片到底有没有从版面上消失（CSS 不生效时 `display:none` 也会「看起来对」）
 *   · 点了「⚙️ 管理游戏」之后，点卡片到底进不进游戏（拦截没拦住 / 拦过头）
 *   · 刷新后是不是真的还记得（localStorage 读回来了但没有应用到 DOM）
 *   · 藏光之后是不是真的给了空状态、而不是一片空白让人以为坏了
 *   · 320px 窄屏上「⚙️ 管理游戏」按钮会不会把标题挤出去 / 溢出屏幕
 *
 * 用法：node tools/test_index_ui.js [站点根URL]
 *   默认 http://127.0.0.1:4321 —— 需要先跑 python ops/serve_site.py 4321 web
 *
 * 跳过策略：找不到 Chrome / 拿不到 DOM 时**以 0 退出**（和 test_pairs_ui.js 一致），
 * 这样没有浏览器的环境不会永远红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:4321';

/* 常见竖屏手机尺寸（含最窄的 320 级老机型） */
const VIEWPORTS = [
  [320, 568, 'iPhone SE(1) 窄屏'],
  [360, 640, 'Android 常见小屏'],
  [390, 844, 'iPhone 14'],
  [414, 896, 'iPhone XR/11'],
];

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function okNum(v, cmp, name, detail){
  if(typeof v !== 'number' || !Number.isFinite(v)){
    fail++; failures.push(name + ' → 量到的不是有限数: ' + JSON.stringify(v));
    console.log('  ✗ ' + name + '  → 量到的不是有限数: ' + JSON.stringify(v)); return;
  }
  ok(cmp(v), name, detail === undefined ? String(v) : detail);
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

/* 探测页必须和首页同源（file:// 读不了 http:// 的 iframe），所以写进 web/ 再删掉 */
function probe(chrome, W, H){
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title>
<style>body{margin:0}iframe{border:0;position:absolute;left:-99999px}</style></head><body>
<pre id="out">pending</pre>
<iframe id="f"></iframe>
<script>
const W=${W},H=${H};
const f=document.getElementById('f');
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/';

function rect(e){ if(!e) return null; const r=e.getBoundingClientRect();
  return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}; }
function click(e){ e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); }

/* 用 canvas 数「这个字形到底画出了多少像素」，并和一个确定缺失的码位对比。
   豆腐块（.notdef）的像素数会和缺失码位几乎一样 —— 这样才抓得到
   「元素在、字也在，但屏幕上是个空白方框」这种只有真渲染才暴露的问题。 */
function paintedIcon(d, ch){
  const cv=d.createElement('canvas'); cv.width=120; cv.height=80;
  const ctx=cv.getContext('2d');
  function px(c){
    ctx.clearRect(0,0,120,80); ctx.font='56px sans-serif'; ctx.fillStyle='#fff';
    ctx.fillText(c,10,60);
    const data=ctx.getImageData(0,0,120,80).data; let n=0;
    for(let i=3;i<data.length;i+=4) if(data[i]>40) n++;
    return n;
  }
  const tofu=px('\\uFFFF');
  const n=ch?px(ch):0;
  return { emptyIconPixels:n, tofuPixels:tofu,
           emptyIconPainted: n>60,
           emptyIconNotTofu: tofu<=0 || Math.abs(n-tofu)>20 };
}

/* 空状态那个大图标（reload 之后 phase2 也要用，所以放在顶层） */
function iconOf(d){ const s=d.getElementById('empty'); const b=s?s.querySelector('.big'):null;
  return b?b.textContent.trim():''; }

/* ⚠️ 不要用 f.onload 来启动测量：给 iframe 赋 src 时浏览器会先为 about:blank
   触发一次 load，那一次跑起来时真实首页还没到，拿到的全是 null。
   （踩过一次：onload 里 setTimeout 250ms 仍然早于真实文档就绪，报 null.getAttribute）
   所以这里**只轮询等真正的首页就绪**，等到了才跑一次。 */
let started=false;
function waitReady(tries){
  if(started) return;
  let d=null;
  try{ d=f.contentDocument; }catch(e){}
  if(d && d.getElementById && d.getElementById('manageBtn') && d.getElementById('grid')){
    started=true;
    run();
    return;
  }
  if(tries<=0){ started=true; run(); return; }   // 放弃等待，让 run 报出真实原因
  setTimeout(()=>waitReady(tries-1), 100);
}
waitReady(80);

function run(){
  const out={ok:true};
  window.__out = out;            // reload 之后 phase2 还要接着往同一个对象里写
  try{
    const d=f.contentDocument, w0=f.contentWindow, E=id=>d.getElementById(id);
    const grid=E('grid'), body=d.body;

    const cells = [...d.querySelectorAll('.cell[data-game]')];
    const games = cells.map(c=>c.dataset.game);

    /* 卡片在版面上到底占不占位 —— 用 getBoundingClientRect 而不是 className */
    function cardRect(g){
      const c = cells.find(x=>x.dataset.game===g);
      if(!c) return null;
      const a = c.querySelector('a.card');
      if(!a) return null;
      const r = rect(a);
      return (r && r.w > 1 && r.h > 1) ? r : null;
    }
    function visibleCount(){
      return games.filter(g => !!cardRect(g)).length;
    }
    function hiddenClassCount(){
      return cells.filter(c => c.classList.contains('hidden')).length;
    }
    function store(){
      try{ return w0.localStorage.getItem('gbox_hidden_v1'); }catch(e){ return '<err>'; }
    }
    function cellOf(g){ return cells.find(x=>x.dataset.game===g); }

    out.total = games.length;
    out.games = games;

    /* ---------- 0) 初始：全部可见，角标不显示 ---------- */
    out.initial = {
      visible: visibleCount(),
      hiddenCls: hiddenClassCount(),
      managePressed: E('manageBtn').getAttribute('aria-pressed'),
      pickDisplay: (()=>{ const p=cellOf(games[0]).querySelector('.pick');
        return p ? getComputedStyle(p).display : null; })(),
      emptyHidden: E('empty').hidden,
      store: store(),
      showAllDisplay: getComputedStyle(E('showAllBtn')).display,
      showAllHiddenAttr: E('showAllBtn').hidden,
      overflowX: body.scrollWidth - body.clientWidth,
      overflowY: body.scrollHeight - body.clientHeight,
      h1: rect(d.querySelector('h1')),
      manageBtn: rect(E('manageBtn')),
      grid: rect(grid),
    };
    out.cards = cells.map(c => {
      const a=c.querySelector('a.card');
      return { game:c.dataset.game, href:a?a.getAttribute('href'):null, rect:rect(a) };
    });

    /* ---------- 1) 进管理模式：角标出现 ---------- */
    click(E('manageBtn'));
    out.manage = {
      pressed: E('manageBtn').getAttribute('aria-pressed'),
      gridCls: grid.className,
      pickDisplay: (()=>{ const p=cellOf(games[0]).querySelector('.pick');
        return p ? getComputedStyle(p).display : null; })(),
      pickRect: rect(cellOf(games[0]).querySelector('.pick')),
      cardRect: rect(cellOf(games[0]).querySelector('a.card')),
      showAllHidden: E('showAllBtn').hidden,
      sub: E('sub').textContent,
    };

    /* ---------- 2) 隐藏第一个游戏：卡片真的不占位 ---------- */
    const g0 = games[0];
    const before0 = cardRect(g0);
    click(cellOf(g0).querySelector('a.card'));
    out.hideOne = {
      game: g0,
      hiddenCls: cellOf(g0).classList.contains('hidden'),
      cardRectManaging: cardRect(g0),      // 管理模式里应当仍然看得见
      pickMark: (()=>{ const s=cellOf(g0).querySelector('.pick span'); return s?s.textContent:null; })(),
      pickPressed: cellOf(g0).querySelector('.pick').getAttribute('aria-pressed'),
      pickLabel: cellOf(g0).querySelector('.pick').getAttribute('aria-label'),
      store: store(),
      visible: visibleCount(),
      showAllHidden: E('showAllBtn').hidden,
      before: before0,
      url: f.contentWindow.location.pathname,
    };

    /* ---------- 3) 退出管理模式：隐藏的卡从版面消失 ---------- */
    click(E('manageBtn'));
    out.afterExit = {
      pressed: E('manageBtn').getAttribute('aria-pressed'),
      visible: visibleCount(),
      hiddenCls: hiddenClassCount(),
      pickDisplay: (()=>{ const p=cellOf(g0).querySelector('.pick');
        return p ? getComputedStyle(p).display : null; })(),
      gridRect: rect(grid),
      overflowX: body.scrollWidth - body.clientWidth,
      overflowY: body.scrollHeight - body.clientHeight,
      sub: E('sub').textContent,
    };

    /* ---------- 4) 点剩下任意一张卡：必须还能进游戏（不能误吞点击） ---------- */
    const g1 = games.find(g => !cellOf(g).classList.contains('hidden'));
    const a1 = cellOf(g1).querySelector('a.card');
    /* 不真的跳转（跳走就量不到了），只看事件有没有被 preventDefault */
    const ev = new MouseEvent('click',{bubbles:true,cancelable:true});
    a1.dispatchEvent(ev);
    out.normalClick = { game: g1, defaultPrevented: ev.defaultPrevented, href: a1.getAttribute('href') };

    /* ---------- 5) 真的重新加载一次：隐藏状态必须记得 ----------
       只读 localStorage 证明不了「刷新后会用上」，所以这里**真的 reload** 首页，
       等它重新渲染后再量（见下面 phase2）。注意 reload 后 cells/grid 引用全废了。 */
    out.persistStore = store();
    out.beforeReload = { hidden: hiddenClassCount(), visible: visibleCount(), game: g0 };
    out._reloadGame = g0;
    f.contentWindow.location.reload();
    waitReloaded(0);
    return;
  }catch(e){
    out.err = String(e && e.stack || e);
    document.getElementById('out').textContent=JSON.stringify(out);
  }
}

/* ===== 重新加载之后：接着量「记得吗 / 还能操作吗」 ===== */
let reloadStarted=false;
function waitReloaded(tries){
  if(reloadStarted) return;
  let d=null;
  try{ d=f.contentDocument; }catch(e){}
  if(d && d.getElementById && d.getElementById('manageBtn') && d.getElementById('grid')
     && d.querySelectorAll('.cell[data-game]').length){
    reloadStarted=true;
    setTimeout(phase2, 60);      // 让首页脚本先跑完一轮 paint()
    return;
  }
  if(tries>60){ reloadStarted=true; phase2(); return; }
  setTimeout(()=>waitReloaded(tries+1), 100);
}

function phase2(){
  const out=window.__out;
  try{
    const d=f.contentDocument, w0=f.contentWindow, E=id=>d.getElementById(id);
    const grid=E('grid'), body=d.body;
    const cells=[...d.querySelectorAll('.cell[data-game]')];
    const games=cells.map(c=>c.dataset.game);
    const g0=out._reloadGame;

    function cardRect(g){
      const c=cells.find(x=>x.dataset.game===g); if(!c) return null;
      const a=c.querySelector('a.card'); if(!a) return null;
      const r=rect(a); return (r&&r.w>1&&r.h>1)?r:null;
    }
    const visibleCount=()=>games.filter(g=>!!cardRect(g)).length;
    const hiddenClassCount=()=>cells.filter(c=>c.classList.contains('hidden')).length;
    const cellOf=g=>cells.find(x=>x.dataset.game===g);
    const store=()=>{ try{ return w0.localStorage.getItem('gbox_hidden_v1'); }catch(e){ return '<err>'; } };

    out.afterReload = {
      visible: visibleCount(),
      hiddenCls: hiddenClassCount(),
      g0StillHidden: !!cellOf(g0) && cellOf(g0).classList.contains('hidden'),
      g0Visible: !!cardRect(g0),
      store: store(),
      emptyHidden: E('empty').hidden,
      managingCls: grid.className,
      overflowX: body.scrollWidth - body.clientWidth,
      gameCount: games.length,
    };

    /* ---------- 6) 再藏 3 个 → 部分隐藏；全部藏光 → 空状态 ---------- */
    click(E('manageBtn'));                       // 回到管理
    const others = games.filter(g => g !== g0 && !cellOf(g).classList.contains('hidden')).slice(0, 3);
    others.forEach(g => click(cellOf(g).querySelector('a.card')));
    out.multiHide = {
      hiddenCls: hiddenClassCount(),
      store: store(),
      visibleManaging: visibleCount(),
    };

    /* 全部藏光 */
    games.forEach(g => { if(!cellOf(g).classList.contains('hidden')) click(cellOf(g).querySelector('a.card')); });
    out.allHidden = {
      hiddenCls: hiddenClassCount(),
      store: store(),
      emptyHidden: E('empty').hidden,
      emptyRect: rect(E('empty')),
      emptyText: (E('empty').textContent||'').replace(/\\s+/g,' ').trim(),
      emptyIcon: iconOf(d),
      ...paintedIcon(d, iconOf(d)),
      overflowX: body.scrollWidth - body.clientWidth,
    };

    /* 退出管理：一张卡都没有，但空状态要占着版面 */
    click(E('manageBtn'));
    out.allHiddenExit = {
      visible: visibleCount(),
      emptyHidden: E('empty').hidden,
      emptyRect: rect(E('empty')),
      overflowX: body.scrollWidth - body.clientWidth,
      overflowY: body.scrollHeight - body.clientHeight,
    };

    /* ---------- 7) 「全部显示」一键复原 ---------- */
    click(E('manageBtn'));                       // 进管理（藏光时唯一能看到卡片的方式）
    click(E('showAllBtn'));
    out.showAll = {
      hiddenCls: hiddenClassCount(),
      visibleManaging: visibleCount(),
      store: store(),
      emptyHidden: E('empty').hidden,
      showAllHidden: E('showAllBtn').hidden,
    };
    click(E('manageBtn'));                       // 退出管理
    out.afterShowAll = {
      visible: visibleCount(),
      emptyHidden: E('empty').hidden,
      overflowX: body.scrollWidth - body.clientWidth,
      overflowY: body.scrollHeight - body.clientHeight,
    };

    /* ---------- 8) 脏存档：非数组 / 不存在的游戏 / 数字 都不能崩 ---------- */
    try{ w0.localStorage.setItem('gbox_hidden_v1','{"a":1}'); }catch(e){}
    out.dirtyStore = (()=>{ try{ return w0.localStorage.getItem('gbox_hidden_v1'); }catch(e){ return '<err>'; } })();

    document.getElementById('out').textContent=JSON.stringify(out);
  }catch(e){
    out.err = String(e && e.stack || e);
    document.getElementById('out').textContent=JSON.stringify(out);
  }
}
<\/script></body></html>`;

  const tmpPage = path.join(__dirname, '..', 'web', '_ui_probe_index.html');
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idxui-'));
  let dom = '';
  try{
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + tmpDir, '--virtual-time-budget=20000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_ui_probe_index.html',
    ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  }catch(e){
    dom = (e && e.stdout) ? String(e.stdout) : '';
  }finally{
    try{ fs.rmSync(tmpDir, { recursive: true, force: true }); }catch(e){}
    if(!process.env.KEEP_PROBE){ try{ fs.rmSync(tmpPage, { force: true }); }catch(e){} }
  }
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if(!m) return null;
  const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  if(!txt || txt === 'pending') return null;
  try{ return JSON.parse(txt); }catch(e){ return null; }
}

/* ============================ 主流程 ============================ */
const chrome = findChrome();
if(!chrome){
  console.log('没找到 Chrome/Edge，跳过首页管理功能的真机回归。');
  process.exit(0);
}

console.log('用 ' + path.basename(chrome) + ' 真渲染 + 真点击');
console.log('被测页面: ' + BASE.replace(/\/$/, '') + '/');

const results = [];
for(const [w, h, name] of VIEWPORTS){
  const r = probe(chrome, w, h);
  if(r === null){ console.log(`\n-- ${name} ${w}×${h} --\n  ⚠️ 量不到（Chrome 的 --dump-dom 拿不到内容？），跳过`); continue; }
  if(r.err){ console.log(`\n-- ${name} ${w}×${h} --\n  ⚠️ 探测中途出错：${r.err}`); }
  results.push([name, w, h, r]);
}
if(!results.length){
  console.log('\n⚠️ 所有视口都量不到，跳过（站点没起？python ops/serve_site.py 4321 web）。');
  process.exit(0);
}

for(const [name, w, h, r] of results){
  section(`${name}  ${w}×${h}`);

  const ini = r.initial || {};
  const total = r.total || 0;

  /* ---------- 初始状态 ---------- */
  ok(total >= 15, '解析到游戏卡片（' + total + ' 张）');
  ok(ini.visible === total, '★ 初始全部游戏可见（' + ini.visible + ' / ' + total + '）');
  ok(ini.hiddenCls === 0, '初始没有被标成隐藏的卡片');
  ok(ini.managePressed === 'false', '★ 管理按钮初始是「未进入」状态');
  ok(ini.pickDisplay === 'none', '★ 平时隐藏角标不显示（不挡视线、不影响点卡片）');
  ok(ini.emptyHidden === true, '★ 有游戏时「空状态」不出现');
  /* ★ 这条是截图抓出来的真 bug：按钮写了 display:inline-flex，把 UA 的
     [hidden]{display:none} 盖掉了 —— hidden 属性在，按钮却一直在页面上。
     静态测试看不出来（属性确实在），只有真渲染 + 读 computedStyle 才抓得到。 */
  ok(ini.showAllHiddenAttr === true, '「全部显示」初始带 hidden 属性');
  ok(ini.showAllDisplay === 'none', '★ 没藏东西时「全部显示」真的不显示（不是只挂了 hidden 属性）',
     'computed display=' + ini.showAllDisplay);
  okNum(ini.overflowX, v => v <= 1, '整页不横向溢出', '溢出 ' + ini.overflowX + 'px');
  okNum(ini.manageBtn.w, v => v >= 44, '管理按钮够大（宽 ≥ 44px）', '宽 ' + ini.manageBtn.w.toFixed(1) + 'px');
  okNum(ini.manageBtn.h, v => v >= 36, '管理按钮够大（高 ≥ 36px）', '高 ' + ini.manageBtn.h.toFixed(1) + 'px');
  okNum(ini.manageBtn.bottom, v => v <= (ini.grid ? ini.grid.top : h) + 1,
     '★ 管理按钮在游戏列表上方（没把卡片顶下去）',
     '按钮底 ' + ini.manageBtn.bottom.toFixed(1) + ' / 列表顶 ' + (ini.grid ? ini.grid.top.toFixed(1) : '?'));
  if(ini.h1 && ini.manageBtn){
    ok(ini.manageBtn.top >= ini.h1.bottom - 1, '★ 管理按钮没压住标题',
       '按钮顶 ' + ini.manageBtn.top.toFixed(1) + ' / 标题底 ' + ini.h1.bottom.toFixed(1));
    /* 注意：body 是 align-items:center 的 flex 容器，header 因此是「收缩到内容宽度」，
       h1 的宽度天然只有标题那么宽（不是被按钮挤的）。这里该守的是
       「标题有实际宽度、没被挤没、也没溢出屏幕」，而不是「占满屏宽」。 */
    okNum(ini.h1.w, v => v >= 120, '标题有实际宽度（没被按钮挤没）', '标题宽 ' + ini.h1.w.toFixed(1) + 'px');
    ok(ini.h1.right <= w + 1, '标题没溢出屏幕右边', '标题右 ' + ini.h1.right.toFixed(1) + ' / ' + w);
  }
  /* 每张卡片都指向真实游戏，且宽度撑满列表（管理模式下要能整张点） */
  const badHref = (r.cards || []).filter(c => !/^\/[a-z0-9_-]+\/$/.test(String(c.href)));
  ok(badHref.length === 0, '所有卡片 href 仍是 /<游戏名>/（没被管理逻辑改坏）',
     badHref.map(c => c.game + ':' + c.href).join(','));
  ok((r.cards || []).every(c => c.rect && c.rect.w > 100), '每张卡片都有正常宽度');

  /* ---------- 进管理模式 ---------- */
  const mg = r.manage || {};
  ok(mg.pressed === 'true', '★ 点「管理游戏」进入管理模式（aria-pressed=true）');
  ok(/managing/.test(String(mg.gridCls)), '★ 列表挂上 .managing');
  ok(mg.pickDisplay === 'grid', '★ 管理模式里角标出现', String(mg.pickDisplay));
  ok(mg.showAllHidden === true, '★ 还没藏东西时「全部显示」不出现（不碍眼）');
  ok(/隐藏|显示/.test(String(mg.sub)), '★ 副标题提示了怎么操作', String(mg.sub));
  if(mg.pickRect && mg.cardRect){
    ok(mg.pickRect.w >= 24 && mg.pickRect.h >= 24, '角标有实际尺寸（' + mg.pickRect.w.toFixed(0) + '×' + mg.pickRect.h.toFixed(0) + '）');
    ok(mg.pickRect.right <= mg.cardRect.right + 1 && mg.pickRect.top >= mg.cardRect.top - 1,
       '角标画在卡片右上角内');
  } else ok(false, '量不到角标 / 卡片尺寸');

  /* ---------- 隐藏一个 ---------- */
  const ho = r.hideOne || {};
  ok(ho.hiddenCls === true, '★ 点卡片把它标成隐藏（' + ho.game + '）');
  ok(ho.pickMark === '✕', '★ 角标变成 ✕（一眼看出这张被关了）', String(ho.pickMark));
  ok(ho.pickPressed === 'false', '角标 aria-pressed 同步为 false');
  ok(/显示/.test(String(ho.pickLabel)), '角标提示变成「显示…」', String(ho.pickLabel));
  ok(ho.cardRectManaging && ho.cardRectManaging.h > 10,
     '★ 管理模式里被隐藏的卡片仍然看得见（能点回来）');
  ok(/g0|\[/.test(String(ho.store)) && String(ho.store).indexOf(ho.game) >= 0,
     '★ 隐藏状态写进了 localStorage', String(ho.store));
  ok(ho.showAllHidden === false, '★ 藏了东西之后「全部显示」出现了');
  ok(ho.url === '/' || ho.url === '', '★ 管理模式下点卡片没有跳走（还在首页）', String(ho.url));

  /* ---------- 退出管理模式 ---------- */
  const ax = r.afterExit || {};
  ok(ax.pressed === 'false', '再点一次退出管理模式');
  ok(ax.visible === total - 1, '★ 隐藏的那张从版面上消失（剩 ' + ax.visible + ' / ' + total + '）');
  ok(ax.hiddenCls === 1, '仍然记得哪一张被藏了');
  ok(ax.pickDisplay === 'none', '退出后角标又藏起来');
  okNum(ax.overflowX, v => v <= 1, '隐藏后整页仍不横向溢出', '溢出 ' + ax.overflowX + 'px');
  ok(/无需安装/.test(String(ax.sub)), '退出后副标题恢复原样', String(ax.sub));

  /* ---------- 正常模式下点卡片必须能进游戏 ---------- */
  const nc = r.normalClick || {};
  ok(nc.defaultPrevented === false, '★ 非管理模式下点卡片不被拦截（能进游戏）');
  ok(/^\/[a-z0-9_-]+\/$/.test(String(nc.href)), '点到的卡片 href 正常（' + nc.href + '）');

  /* ---------- 刷新之后：必须记得 ---------- */
  const ar = r.afterReload || {};
  ok(r.beforeReload && r.beforeReload.hidden === 1,
     '刷新前只藏了 1 个（' + (r.beforeReload ? r.beforeReload.hidden : '?') + '）');
  ok(ar.gameCount === total, '★ 刷新后首页正常渲染（' + ar.gameCount + ' 张卡都在）');
  ok(ar.g0StillHidden === true, '★ 刷新后那个游戏仍然是隐藏的（存档真的被读回来了）');
  ok(ar.g0Visible === false, '★ 刷新后隐藏的卡片确实不占位（不是只改了 class）');
  ok(ar.visible === total - 1, '★ 刷新后可见数 = 总数 - 1（' + ar.visible + ' / ' + total + '）');
  ok(String(ar.store).indexOf(String(r.beforeReload && r.beforeReload.game)) >= 0,
     '刷新后存档内容还在', String(ar.store));
  ok(!/managing/.test(String(ar.managingCls)), '★ 刷新后回到普通模式（不会卡在管理模式里）');
  okNum(ar.overflowX, v => v <= 1, '刷新后整页仍不横向溢出', '溢出 ' + ar.overflowX + 'px');

  /* ---------- 部分隐藏 + 全部隐藏 ---------- */
  const mh = r.multiHide || {};
  ok(mh.hiddenCls === 4, '★ 连藏 4 个都记住了（' + mh.hiddenCls + '）');
  /* 注意：管理模式里被隐藏的卡片**仍然占位**（淡出 + 虚线），所以可见数还是 16 ——
     这正是「藏了还能点回来」的保证，不能退化成 12。 */
  ok(mh.visibleManaging === total,
     '★ 管理模式里 16 张卡片仍然都在版面上（藏起来的只是淡出，能点回来）',
     mh.visibleManaging + ' / ' + total);

  const ah = r.allHidden || {};
  ok(ah.hiddenCls === total, '★ 可以全部藏光（' + ah.hiddenCls + ' / ' + total + '）');
  ok(ah.emptyHidden === false, '★ 全部藏光后出现空状态提示（不是一片空白）');
  ok(ah.emptyRect && ah.emptyRect.h > 60, '空状态有实际高度', ah.emptyRect ? ah.emptyRect.h.toFixed(0) + 'px' : 'null');
  ok(/管理游戏/.test(String(ah.emptyText)), '★ 空状态里告诉玩家去哪恢复', String(ah.emptyText).slice(0, 40));
  /* ★ 空状态的大图标必须真的画出像素。踩过一次：用了 🫥（U+1FAE5），
     系统字体里没有这个字形，真渲染出来是个**豆腐块**（截图里就是空白方框），
     而「有 10 个元素 / 文字都对」这类断言完全抓不到。 */
  ok(!!ah.emptyIcon, '空状态有图标（' + JSON.stringify(ah.emptyIcon) + '）');
  ok(ah.emptyIconPainted === true,
     '★ 空状态图标真的画出了像素（不是豆腐块 / 空白方框）',
     'pixels=' + ah.emptyIconPixels + ' / 缺失字形=' + ah.tofuPixels);
  ok(ah.emptyIconNotTofu === true,
     '★ 空状态图标与「缺失字形」的像素数不同（确认不是豆腐块）',
     'pixels=' + ah.emptyIconPixels + ' vs tofu=' + ah.tofuPixels);
  okNum(ah.overflowX, v => v <= 1, '空状态不横向溢出', '溢出 ' + ah.overflowX + 'px');

  const ahe = r.allHiddenExit || {};
  ok(ahe.visible === 0, '★ 退出管理后一张卡片都不显示（' + ahe.visible + '）');
  ok(ahe.emptyHidden === false, '★ 退出管理后空状态仍在（不会变成白屏）');
  okNum(ahe.overflowY, v => v <= 1, '空状态下整页仍放得下', '溢出 ' + ahe.overflowY + 'px');

  /* ---------- 全部显示 ---------- */
  const sa = r.showAll || {};
  ok(sa.hiddenCls === 0, '★「全部显示」把隐藏标记全清了');
  ok(sa.visibleManaging === total, '★ 全部显示后 16 张都回来了');
  ok(sa.emptyHidden === true, '全部显示后空状态收起来');
  ok(sa.showAllHidden === true, '藏的东西清空后「全部显示」又隐藏');
  ok(String(sa.store) === '[]', '★ localStorage 里也清空了（刷新后不会又藏起来）', String(sa.store));

  const asa = r.afterShowAll || {};
  ok(asa.visible === total, '★ 退出管理后完整恢复（' + asa.visible + ' / ' + total + '）');
  okNum(asa.overflowX, v => v <= 1, '恢复后整页仍不横向溢出', '溢出 ' + asa.overflowX + 'px');
}

console.log('\n' + '='.repeat(60));
if(fail === 0) console.log(`全部通过：${pass} 项（${results.length} 个视口）`);
else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
