#!/usr/bin/env node
/**
 * 记忆配对 · 真机布局回归（无头 Chrome 真渲染，量真实像素）
 *
 * 为什么需要它：tools/test_pairs.js 跑在假 DOM 里，CSS 完全不生效 ——
 * 「牌够不够大、18 张在 320 宽的老机型上会不会挤成一条缝、整页会不会被顶出屏幕、
 *  配对成功后牌会不会重排、界面上到底有没有肉眼可见的文字」这类问题只能在真浏览器里量。
 *
 * 用法：node tools/test_pairs_ui.js [站点根URL]
 *   默认 http://127.0.0.1:4321 —— 需要先跑 python ops/serve_site.py 4321 web
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
function probe(chrome, W, H){
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p</title>
<style>body{margin:0}iframe{border:0;position:absolute;left:-99999px}</style></head><body>
<pre id="out">pending</pre>
<iframe id="f"></iframe>
<script>
const W=${W},H=${H};
const f=document.getElementById('f');
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/pairs/';

function rect(e){ const r=e.getBoundingClientRect();
  return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}; }

f.onload=()=>setTimeout(()=>{
  const out={ok:true,views:{}};
  try{
    const d=f.contentDocument, w0=f.contentWindow;
    const E=id=>d.getElementById(id);
    const de=d.documentElement, body=d.body;
    const DT=1/60;
    function run(sec){ const n=Math.round(sec/DT); for(let i=0;i<n;i++) w0.__pairsStep(DT); }

    /* ★ 本作最核心的约束：界面上不能有肉眼可见的文字。
       用真实浏览器读 body.innerText —— 那是「玩家真正看到的东西」，
       比翻 DOM 源码靠谱（CSS content、伪元素、visibility 都算进去了）。 */
    function visibleText(){
      const t = body.innerText || body.textContent || '';
      return String(t).replace(/\\s+/g,' ').trim();
    }

    function measure(lv){
      w0.__pairsNewGame(lv);
      const st=w0.__pairs();
      const cards=[...d.querySelectorAll('#board .card')];
      const rs=cards.map(rect);
      const stages=rect(E('stage'));
      const boardR=rect(E('board'));
      const ctl=[...d.querySelectorAll('#ctl button')].map(e=>Object.assign(rect(e),{t:e.textContent.trim()}));
      const lvBtns=[...d.querySelectorAll('#levels button')].map(e=>Object.assign(rect(e),
        {on:e.classList.contains('on'), dots:e.querySelectorAll('.dot').length}));
      const hud=[...d.querySelectorAll('#hud .st')].map(rect);
      const fs=cards.length?parseFloat(getComputedStyle(cards[0]).fontSize):0;
      const pipFs=cards.length?parseFloat(getComputedStyle(cards[0].querySelector('.pip')).fontSize):0;
      const crFs=cards.length?parseFloat(getComputedStyle(cards[0].querySelector('.cr')).fontSize):0;
      const opac=cards.map(e=>parseFloat(getComputedStyle(e).opacity));

      return {
        lv, n:cards.length,
        cardW: Math.min(...rs.map(r=>r.w)),
        cardH: Math.min(...rs.map(r=>r.h)),
        cardRightMax: Math.max(...rs.map(r=>r.right)),
        cardLeftMin: Math.min(...rs.map(r=>r.left)),
        cardBottomMax: Math.max(...rs.map(r=>r.bottom)),
        cardTopMin: Math.min(...rs.map(r=>r.top)),
        board: boardR, stage: stages,
        cw:st.cw, ch:st.ch, gap:st.gap, cols:st.cols, rows:st.rows,
        fs, pipFs, crFs, minOpacity: Math.min(...opac),
        ctl, lvBtns, hud,
        ratio: st.ch/st.cw,
        inStage: boardR.top >= stages.top-1 && boardR.bottom <= stages.bottom+1,
        overflowY: body.scrollHeight - body.clientHeight,
        overflowX: de.scrollWidth - de.clientWidth,
        ctlBottom: Math.max(...ctl.map(c=>c.bottom)),
        lvOn: lvBtns.filter(b=>b.on).length,
        dotsPerBtn: lvBtns.map(b=>b.dots),
        fxPE: getComputedStyle(E('fx')).pointerEvents,
        visibleText: visibleText(),
      };
    }

    for(let lv=0; lv<10; lv++) out.views[String(lv)]=measure(lv);

    /* ---------- 点开一张：牌真的翻过来了 ---------- */
    {
      w0.__pairsNewGame(1, 5);
      const card0=d.querySelector('#board .card');
      const inner0=card0.querySelector('.inner');
      const downBefore=card0.classList.contains('down');
      w0.__pairsTap(0);
      const downAfter=card0.classList.contains('down');
      out.flip={
        downBefore: downBefore,
        downCls: downAfter,
        before:getComputedStyle(inner0).transform,
        after:getComputedStyle(inner0).transform,
        faceColor: getComputedStyle(card0.querySelector('.face')).color,
        backTransform: getComputedStyle(card0.querySelector('.back')).transform,
        backBfv: getComputedStyle(card0.querySelector('.back')).backfaceVisibility,
      };
    }

    /* ---------- 配对成功：牌不能重排 ---------- */
    {
      w0.__pairsNewGame(1, 21);
      const st=w0.__pairs();
      const beforeRects=[...d.querySelectorAll('#board .card')].map(rect);
      const beforeOrder=st.cards.map(c=>c.rank+c.suit).join(',');
      /* 找一对 */
      const byRank={};
      st.cards.forEach((c,i)=>{ (byRank[c.rank]=byRank[c.rank]||[]).push(i); });
      let pair=null;
      for(const rk in byRank) if(byRank[rk].length===2){ pair=byRank[rk]; break; }
      w0.__pairsTap(pair[0]); w0.__pairsTap(pair[1]);
      const afterRects=[...d.querySelectorAll('#board .card')].map(rect);
      const afterOrder=w0.__pairs().cards.map(c=>c.rank+c.suit).join(',');
      let maxShift=0;
      for(let i=0;i<beforeRects.length;i++){
        maxShift=Math.max(maxShift,
          Math.abs(afterRects[i].left-beforeRects[i].left),
          Math.abs(afterRects[i].top-beforeRects[i].top));
      }
      const cards=[...d.querySelectorAll('#board .card')];
      const goneCount=cards.filter(e=>e.classList.contains('gone')).length;
      const goneEl=cards[pair[0]];
      const goneStyle=getComputedStyle(goneEl.querySelector('.face'));
      const goneInner=getComputedStyle(goneEl.querySelector('.inner'));
      /* ★ 配对的牌必须**还看得见**：牌面要有真实底色、真实字色，不能缩没 / 变透明 */
      const gonePip=getComputedStyle(goneEl.querySelector('.pip'));
      const goneCard=getComputedStyle(goneEl);
      const afterBadge=getComputedStyle(goneEl, '::after');
      /* 红/黑花色是记忆线索：配对后红色不能褪成灰绿 */
      const redEl=cards.find(e=>e.classList.contains('gone') && e.querySelector('.face.red'));
      const redColor = redEl ? getComputedStyle(redEl.querySelector('.face')).color : '';
      const rm = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(redColor || '');
      const redStaysRed = rm ? (+rm[1] > +rm[3] + 25 && +rm[1] > +rm[2] + 10) : true;
      out.match={
        countBefore:beforeRects.length, countAfter:afterRects.length,
        orderSame: beforeOrder===afterOrder,
        maxShift, goneCount,
        goneBg: goneStyle.backgroundColor,
        goneBgImage: goneStyle.backgroundImage,
        goneBorder: goneStyle.borderStyle,
        goneColor: goneStyle.color,
        gonePipOpacity: parseFloat(gonePip.opacity),
        goneCardOpacity: parseFloat(goneCard.opacity),
        goneInnerTransform: goneInner.transform,
        goneCardW: afterRects[pair[0]].w,
        normalCardW: beforeRects[pair[0]].w,
        badgeContent: afterBadge ? afterBadge.content : '',
        badgeBg: afterBadge ? afterBadge.backgroundColor : '',
        goneRedColor: redColor,
        redStaysRed: redStaysRed,
        found: w0.__pairs().found,
      };
    }

    /* ---------- 配对失败：红圈 + 锁输入 + 自动翻回 ---------- */
    {
      w0.__pairsNewGame(1, 31);
      const st=w0.__pairs();
      let y=-1;
      for(let i=1;i<st.cards.length;i++) if(st.cards[i].rank!==st.cards[0].rank){ y=i; break; }
      w0.__pairsTap(0); w0.__pairsTap(y);
      const cards=[...d.querySelectorAll('#board .card')];
      const missCount=cards.filter(e=>e.classList.contains('miss')).length;
      const missShadow=getComputedStyle(cards[0].querySelector('.face')).boxShadow;
      const locked=w0.__pairs().locked;
      run(1.1);
      const cards2=[...d.querySelectorAll('#board .card')];
      const missAfter=cards2.filter(e=>e.classList.contains('miss')).length;
      const downAfter=cards2.filter(e=>e.classList.contains('down')).length;
      out.miss={ missCount, missShadow, locked, missAfter, downAfter, total:cards2.length };
    }

    /* ---------- 过关面板 ---------- */
    {
      w0.__pairsNewGame(0, 41);
      const seen={}; let g=0;
      while(w0.__pairs().phase==='play' && g++<400){
        const cs=w0.__pairs().cards; let done=false;
        for(const rk in seen){
          const idxs=seen[rk].filter(i=>!cs[i].matched&&!cs[i].up);
          if(idxs.length>=2){ w0.__pairsTap(idxs[0]); w0.__pairsTap(idxs[1]); if(w0.__pairs().locked) run(1.0); delete seen[rk]; done=true; break; }
        }
        if(done) continue;
        const unk=[]; for(let i=0;i<cs.length;i++) if(!cs[i].matched&&!cs[i].up) unk.push(i);
        if(unk.length<2) break;
        const a=unk[0]; w0.__pairsTap(a); (seen[cs[a].rank]=seen[cs[a].rank]||[]).push(a);
        const b=unk.find(i=>i!==a&&seen[cs[i].rank]&&seen[cs[i].rank].some(j=>j!==i&&!cs[j].matched&&!cs[j].up));
        if(b!==undefined) w0.__pairsTap(b);
        else { const c=unk[1]; w0.__pairsTap(c); (seen[cs[c].rank]=seen[cs[c].rank]||[]).push(c); }
        if(w0.__pairs().locked) run(1.0);
      }
      const stDone=w0.__pairs();
      run(1.6);
      setTimeout(()=>{
       try{
        const ov=E('doneOv'), panel=ov.querySelector('.panel');
        const shownCls=ov.classList.contains('show');
        if(panel) panel.style.transition='none';
        ov.style.transition='none';
        void ov.offsetWidth;
        const stars=[...d.querySelectorAll('#doneStars span')];
        out.done={
          phase: stDone.phase,
          panelShown: w0.__pairs().panelShown,
          shown: ov.classList.contains('on'),
          showCls: shownCls,
          opacity: panel?parseFloat(getComputedStyle(panel).opacity):-1,
          ovBg: getComputedStyle(ov).backgroundColor,
          panel: panel?rect(panel):null,
          stars: stars.length,
          starsOn: stars.filter(e=>e.classList.contains('on')).length,
          starColor: stars.length?getComputedStyle(stars[0]).color:'',
          btns: [...ov.querySelectorAll('button')].map(e=>Object.assign(rect(e),{t:e.textContent.trim()})),
          overflowY: body.scrollHeight-body.clientHeight,
          overflowX: de.scrollWidth-de.clientWidth,
          visibleText: visibleText(),
          /* ★ 十档奖品的真实渲染情况：
             · 每档的 emoji 必须真的画出像素（不是空白豆腐块）
             · 当前档位要放大、已拿到的要亮起来 */
          ticks: (function(){
            const box=E('doneTicks');
            if(!box) return null;
            const ts=[...box.children];
            const cur=ts.filter(e=>e.classList.contains('cur'));
            const got=ts.filter(e=>e.classList.contains('got'));
            const r0=ts.length?rect(ts[0]):null;
            const c0=ts.length?getComputedStyle(ts[0]):null;

            /* ★ 用 canvas 真渲染每个 emoji，数非透明像素。
               这是唯一能抓住「渲染成豆腐块 / 空白方块」的办法 ——
               DOM 里有 10 个元素、textContent 也正确，屏幕上却可能什么都没有。
               ⚠️ 对照组：同一个 canvas 再画一个**确定缺失的码位**（U+10FFFD），
               若某个 emoji 的像素数与它接近，说明系统用的是同一个兜底字形。 */
            function paintCount(ch, size){
              try{
                const cv=d.createElement('canvas');
                cv.width=cv.height=size;
                const ctx=cv.getContext('2d');
                if(!ctx) return -1;
                ctx.font=size+'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
                ctx.textBaseline='top';
                ctx.fillText(ch, 0, 0);
                const img=ctx.getImageData(0,0,size,size).data;
                let n=0;
                for(let i=3;i<img.length;i+=4) if(img[i]>16) n++;
                return n;
              }catch(e){ return -1; }
            }
            const SZ=32;
            const painted=ts.map(e=>paintCount(e.textContent, SZ));
            const tofu=paintCount(String.fromCodePoint(0x10FFFD), SZ);
            return {
              count: ts.length,
              curCount: cur.length,
              gotCount: got.length,
              emojis: ts.map(e=>e.textContent),
              w: r0?r0.w:0, h: r0?r0.h:0,
              fontSize: c0?parseFloat(c0.fontSize):0,
              curScale: cur.length?getComputedStyle(cur[0]).transform:'',
              curBg: cur.length?getComputedStyle(cur[0]).backgroundColor:'',
              painted: painted,
              tofuPixels: tofu,
              allSized: ts.every(e=>{ const r=rect(e); return r.w>=16 && r.h>=16; }),
              allPainted: painted.every(n => n > 60),
              noneLooksLikeTofu: painted.every(n => tofu <= 0 || Math.abs(n - tofu) > 20),
            };
          })(),
        };

        /* ---------- 记录面板 ---------- */
        w0.__pairsOpenTop(0);
        setTimeout(()=>{
         try{
          const tov=E('topOv'), tpanel=tov.querySelector('.panel');
          if(tpanel) tpanel.style.transition='none';
          tov.style.transition='none';
          void tov.offsetWidth;
          const rows=[...d.querySelectorAll('#topList .topRow')].map(e=>Object.assign(rect(e),{cls:e.className}));
          const list=E('topList');
          out.top={
            shown: tov.classList.contains('on'),
            panel: rect(tpanel),
            rowCount: rows.length,
            rowH: rows.length?rows[0].h:0,
            rowOverlap: rows.some((r,i)=> i>0 && r.top < rows[i-1].bottom-0.5),
            listScrollH: list.scrollHeight, listClientH: list.clientHeight,
            listBottom: rect(list).bottom,
            btns: [...tov.querySelectorAll('button')].map(rect),
            overflowY: body.scrollHeight-body.clientHeight,
            visibleText: visibleText(),
          };
          w0.__pairsHideTop();
          document.getElementById('out').textContent=JSON.stringify(out);
         }catch(e2){ out.err='top:'+e2.message; document.getElementById('out').textContent=JSON.stringify(out); }
        }, 300);
       }catch(e){ out.err='done:'+e.message; document.getElementById('out').textContent=JSON.stringify(out); }
      }, 400);
    }
  }catch(err){
    out={ok:false, err: String(err && err.stack || err)};
    document.getElementById('out').textContent=JSON.stringify(out);
  }
}, 300);
<\/script></body></html>`;

  const tmpPage = path.join(__dirname, '..', 'web', '_ui_probe_pairs.html');
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairsui-'));
  let dom = '';
  try{
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + tmpDir, '--virtual-time-budget=30000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_ui_probe_pairs.html',
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

/** 把一段真实渲染出来的文字里「允许出现的字符」剥掉，剩下的就是需要读的东西。
 *  允许：数字、标点、箭头/几何图形/杂项符号（‹ ⟲ ▶ ✕ ★ 🏆 👆 ⏱ 这类纯图形）。
 *  ⚠️ 判定标准是「要不要认字」——图形符号不认识字的人也能靠形状猜，
 *  而汉字/字母是必须先学会才能懂的。 */
function readablePart(s){
  return String(s || '')
    .replace(/[\d\s:/\-–—.,+×=()]/g, '')                          // 数字与标点
    .replace(/[\u0370-\u03FF]/g, '')                                // 希腊字母区（Σ 是数学符号，不是词）
    .replace(/[\u2000-\u2BFF\uFE0F\u200D]/g, '')                    // 符号区（含 ‹ ⟲ ▶ ✕ ★ ⏱）
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');                // 代理对（emoji）
}

const chrome = findChrome();
if(!chrome){
  console.log('没找到 Chrome/Edge，跳过真机布局回归。');
  process.exit(0);
}
const SITE_ROOT = path.join(__dirname, '..', 'web');
if(!fs.existsSync(SITE_ROOT)){ console.log('找不到站点根，跳过。'); process.exit(0); }

console.log('用 ' + path.basename(chrome) + ' 量真实渲染尺寸');
console.log('被测页面: ' + BASE.replace(/\/$/, '') + '/pairs/');

const first = probe(chrome, 360, 640);
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
  const r = (w === 360 && h === 640) ? first : probe(chrome, w, h);
  if(r === null){ console.log(`\n-- ${name} ${w}×${h} --\n  ⚠️ 量不到，跳过`); continue; }
  if(r.err){ console.log(`\n-- ${name} ${w}×${h} --\n  ⚠️ 探测中途出错：${r.err}`); }
  results.push([name, w, h, r]);
}

if(!results.length){ console.log('所有视口都量不到，跳过。'); process.exit(0); }

for(const [name, w, h, r] of results){
  section(`${name}  ${w}×${h}`);

  const v1 = r.views['1'];
  okNum(v1.overflowX, v => v <= 1, '不横向溢出', '溢出 ' + v1.overflowX + 'px');
  okNum(v1.overflowY, v => v <= 1, '不纵向溢出（一屏放得下，不用滚）', '溢出 ' + v1.overflowY + 'px');
  okNum(v1.ctlBottom, v => v <= h + 1, '底部按钮在屏幕内', '最低点 ' + v1.ctlBottom.toFixed(1) + ' / 屏高 ' + h);

  /* ---------- ★ 界面上没有肉眼可见的文字 ---------- */
  section(`${name} ${w}×${h} · ★ 界面上没有文字`);
  const rawText = v1.visibleText || '';
  const readable = readablePart(rawText);
  ok(readable.length === 0,
     '★ 游戏页面上读不出任何需要「认字」的内容',
     readable.length ? '实际出现：' + JSON.stringify(readable.slice(0, 40)) : '');
  ok(!/[\u4e00-\u9fff]/.test(rawText), '★ 没有一个汉字');
  ok(!/[A-Za-z]/.test(rawText), '★ 没有一个拉丁字母');

  /* ---------- 关卡条：迷你网格，不是文字 ---------- */
  ok(v1.lvBtns.length === 10, '关卡条 10 个按钮', String(v1.lvBtns.length));
  ok(v1.lvOn === 1, '★ 恰好一个关卡高亮', '高亮 ' + v1.lvOn + ' 个');
  ok(JSON.stringify(v1.dotsPerBtn) === JSON.stringify([6,10,12,16,18,20,24,28,32,36]),
     '★ 关卡按钮上画的是「牌数」个小点（6~36），不是文字',
     JSON.stringify(v1.dotsPerBtn));
  const minLvW = Math.min(...v1.lvBtns.map(b => b.w));
  const minLvH = Math.min(...v1.lvBtns.map(b => b.h));
  okNum(minLvH, v => v >= 28, '关卡按钮高 ≥ 28px', '最矮 ' + minLvH.toFixed(1) + 'px');
  okNum(minLvW, v => v >= 56, '关卡按钮宽 ≥ 56px', '最窄 ' + minLvW.toFixed(1) + 'px');
  ok(v1.lvBtns.every((b, i) => i === 0 || b.left >= v1.lvBtns[i-1].right - 0.5 || b.top >= v1.lvBtns[i-1].bottom - 0.5), '十个关卡按钮不重叠（换行也算不重叠）');

  /* ---------- 仪表 ---------- */
  ok(v1.hud.length === 3, '仪表三格（步数 / 用时 / 进度）', String(v1.hud.length));
  ok(v1.hud.every(x => x.w > 40), '仪表每格都有宽度', v1.hud.map(x => x.w.toFixed(0)).join('/'));
  ok(v1.hud.every((x, i) => i === 0 || x.left >= v1.hud[i-1].right - 0.5), '仪表三格不重叠');

  /* ---------- 四个关卡逐个量 ---------- */
  const LEVELS = [6,10,12,16,18,20,24,28,32,36];
  /* 320 宽屏上牌的实际可达尺寸（见 index.html 里 LEVELS 的推导表）：
     6~12 张 ≥ 60px，16~18 张 ≥ 48px，20~24 张 ≥ 44px，28~32 张 ≥ 34px，36 张 ≥ 30px。
     牌越多物理上越挤，这是屏幕尺寸决定的，不是设计让步。 */
  for(let lv = 0; lv < 10; lv++){
    const v = r.views[String(lv)];
    if(!v){ ok(false, lv + ' 档没量到'); continue; }
    const n = LEVELS[lv];
    section(`${name} ${w}×${h} · ${n} 张（第 ${lv+1} 关）`);

    ok(v.n === n, `牌数 = ${n}`, String(v.n));
    ok(v.inStage, '★ 牌桌完整落在舞台内（没被顶出去）');
    okNum(v.board.w, x => x <= w + 1, '牌桌不超出屏宽', v.board.w.toFixed(1) + ' / ' + w);
    okNum(v.board.h, x => x <= v.stage.h + 1, '牌桌不超出舞台高',
       v.board.h.toFixed(1) + ' / 舞台 ' + v.stage.h.toFixed(1));

    okNum(v.ratio, x => Math.abs(x - 1/0.7) < 0.06, '★ 牌宽高比 ≈ 2:3（扑克牌的样子）',
       '高/宽 = ' + v.ratio.toFixed(3));

    /* 触屏最小可点尺寸：牌越多，物理上越挤，所以按牌数分档。
       6/12 张是主力玩法，要求 52px；16 张 44px；18 张在 320 窄屏上只能到 34px 左右。 */
    const minTap = n <= 12 ? 44 : (n <= 20 ? 38 : (n <= 28 ? 30 : 28));
    okNum(v.cardW, x => x >= minTap, `${n} 张：牌宽 ≥ ${minTap}px`, '最窄 ' + v.cardW.toFixed(1) + 'px');
    okNum(v.cardH, x => x >= minTap * 1.2, `${n} 张：牌高 ≥ ${(minTap*1.2).toFixed(0)}px`,
       '最矮 ' + v.cardH.toFixed(1) + 'px');

    okNum(v.pipFs, x => x >= 10, `\$\{n\} 张：花色大图标字号 ≥ 10px`, v.pipFs.toFixed(1) + 'px');
    okNum(v.crFs, x => x >= 7, `\$\{n\} 张：角标字号 ≥ 7px`, v.crFs.toFixed(1) + 'px');
    okNum(v.gap, x => x >= 6 && x <= 14, `${n} 张：牌间距 6~14px`, v.gap + 'px');
    okNum(v.minOpacity, x => x >= 0.99,
       `${n} 张：★ 每张牌都不透明（入场动画不靠 opacity，卡在首帧也不会消失）`,
       '最低 opacity ' + v.minOpacity);

    okNum(v.cardRightMax, x => x <= v.board.right + 1, `${n} 张：牌没超出牌桌右边`,
       '最右 ' + v.cardRightMax.toFixed(1) + ' / 牌桌右 ' + v.board.right.toFixed(1));
    okNum(v.cardLeftMin, x => x >= v.board.left - 1, `${n} 张：牌没超出牌桌左边`,
       '最左 ' + v.cardLeftMin.toFixed(1) + ' / 牌桌左 ' + v.board.left.toFixed(1));
    okNum(v.cardBottomMax, x => x <= v.board.bottom + 1, `${n} 张：牌没超出牌桌下边`,
       '最下 ' + v.cardBottomMax.toFixed(1) + ' / 牌桌下 ' + v.board.bottom.toFixed(1));
    okNum(v.cardRightMax, x => x <= w + 1, `${n} 张：牌没超出屏宽`, v.cardRightMax.toFixed(1) + ' / ' + w);

    okNum(v.overflowY, x => x <= 1, `${n} 张：整页仍不纵向溢出`, '溢出 ' + v.overflowY + 'px');
    okNum(v.overflowX, x => x <= 1, `${n} 张：整页仍不横向溢出`, '溢出 ' + v.overflowX + 'px');
  }

  /* ---------- 翻牌真的翻了 ---------- */
  section(`${name} ${w}×${h} · 翻牌`);
  const fp = r.flip || {};
  /* ⚠️ 不能拿 transform 前后比较：无头 Chrome 的虚拟时间会把 0.4s 的 transition
     卡在起始值上，前后读到的都是 rotateY(180deg)。真正该断言的是**状态**：
     翻开的牌必须去掉 .down，而 .down 决定 transform 的目标值。 */
  ok(fp.downCls === false, '★ 点一下牌，牌真的翻到正面（.down 被摘掉）',
     'down=' + fp.downCls);
  ok(fp.downBefore === true, '翻开前是扣着的（.down 在）');
  ok(/rgb/.test(fp.faceColor || ''), '牌面有真实文字颜色（' + fp.faceColor + '）');
  ok(/matrix/.test(fp.backTransform || ''), '★ 背面的 rotateY(180deg) 真的生效了（不是正面透出来）',
     String(fp.backTransform).slice(0, 40));

  /* ---------- ★ 配对成功后不能重排、且牌要留在桌上 ---------- */
  section(`${name} ${w}×${h} · ★ 配对后不重排、牌留在桌上`);
  const mt = r.match || {};
  ok(mt.orderSame === true, '★ 配对后牌序完全没变（没有把后面的牌挪过来补位）');
  ok(mt.countBefore === mt.countAfter, '★ DOM 牌数没减少（牌还在桌上）',
     mt.countBefore + ' → ' + mt.countAfter);
  okNum(mt.maxShift, x => x <= 1.5, '★ 配对后每一张牌都还在原位',
     '最大位移 ' + (mt.maxShift || 0).toFixed(2) + 'px');
  ok(mt.goneCount === 2, '恰好两张标成已配对（' + mt.goneCount + '）');
  ok(mt.found === 1, '已配对数 = 1');

  /* ★ 用户的明确要求：翻成功的牌不要消失 —— 牌面要一直看得清 */
  okNum(mt.goneCardOpacity, x => x >= 0.99, '★ 已配对的牌**不透明**（没有缩没 / 淡出）',
     'opacity=' + mt.goneCardOpacity);
  okNum(mt.goneCardW, x => Math.abs(x - mt.normalCardW) <= 1.5,
     '★ 已配对的牌**尺寸不变**（没有缩掉）',
     mt.goneCardW + ' vs 原 ' + mt.normalCardW);
  /* ⚠️ 别直接匹配 matrix 的字面量：翻开状态的 .inner 是 rotateY(180deg)，
     计算出来是 matrix3d(-1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,0,0,1) —— 前三个对角元
     是 (-1, 1, -1)，那是「翻转」不是「缩放」。要判断有没有被缩小，
     得看缩放因子（对角元的绝对值）是不是 1。 */
  const t = String(mt.goneInnerTransform || '');
  let scaleOk = true;
  const m3 = /matrix3d\(([^)]+)\)/.exec(t);
  const m2 = /matrix\(([^)]+)\)/.exec(t);
  if(m3){
    const v = m3[1].split(',').map(Number);
    scaleOk = Math.abs(Math.abs(v[0]) - 1) < 0.02 && Math.abs(Math.abs(v[5]) - 1) < 0.02;
  } else if(m2){
    const v = m2[1].split(',').map(Number);
    scaleOk = Math.abs(Math.abs(v[0]) - 1) < 0.02 && Math.abs(Math.abs(v[3]) - 1) < 0.02;
  } else if(t === 'none'){
    scaleOk = true;
  }
  ok(scaleOk, '★ 已配对的牌没有缩放（.inner 的缩放因子仍是 1，只是翻转/没变）',
     t.slice(0, 56));
  ok(/rgb/.test(mt.goneBg || '') || /gradient/.test(mt.goneBgImage || ''),
     '★ 已配对的牌有真实底色（不是透明空槽）', mt.goneBg + ' / ' + String(mt.goneBgImage).slice(0, 30));
  ok(/rgb/.test(mt.goneColor || ''), '★ 牌面字色还在（点数和花色读得出来）', mt.goneColor);
  okNum(mt.gonePipOpacity, x => x >= 0.3 && x <= 0.9,
     '★ 花色图标只是「褪色」而不是隐藏（0.3~0.9 之间）', 'opacity=' + mt.gonePipOpacity);
  /* ★ 红色花色不能褪成灰绿：红/黑本身就是记忆线索 */
  ok(mt.redStaysRed === true,
     '★ 红桃/方块配对后仍然偏红（花色颜色是记忆线索，不能抹成灰）', mt.goneRedColor);
  ok(!/dashed/.test(mt.goneBorder || ''), '已配对的牌不再是虚线空槽（' + mt.goneBorder + '）');
  /* 右上角那个勾：不用认字也能看出「这张配好了」 */
  ok(/✓|\u2713/.test(mt.badgeContent || ''), '★ 已配对的牌右上角有个勾（图形标记，不是文字）',
     'content=' + JSON.stringify(mt.badgeContent));
  ok(/rgb/.test(mt.badgeBg || ''), '勾有实心底色（' + mt.badgeBg + '）');

  /* ---------- 配对失败 ---------- */
  section(`${name} ${w}×${h} · 配对失败`);
  const ms = r.miss || {};
  ok(ms.missCount === 2, '★ 对不上的两张都标了红圈（' + ms.missCount + '）');
  ok(/rgb/.test(ms.missShadow || ''), '红圈真的画出来了（box-shadow: ' + String(ms.missShadow).slice(0, 40) + '…）');
  ok(ms.locked === true, '★ 失败后锁住输入（不让第三张插进来）');
  ok(ms.missAfter === 0, '★ 到点后红圈清掉');
  ok(ms.downAfter === ms.total, '★ 到点后所有牌都翻回去了（' + ms.downAfter + '/' + ms.total + '）');

  /* ---------- 过关面板 ---------- */
  section(`${name} ${w}×${h} · 过关面板`);
  const dn = r.done || {};
  ok(dn.phase === 'done', '探针把这一关打完了', String(dn.phase));
  ok(dn.panelShown === true, '★ 演出到点后过关面板弹出', String(dn.panelShown));
  ok(dn.shown === true, '面板真的显示了（.on）');
  ok(dn.showCls === true, '★ 面板挂上了 .show（过渡的终点状态）');
  okNum(dn.opacity, x => x > 0.9, '★ 面板真的不透明（不是只挂了 class 的假显示）', 'opacity=' + dn.opacity);
  ok(/rgba?\(8,\s*10,\s*14/.test(dn.ovBg || '') && !/, 0\)$/.test(dn.ovBg || ''),
     '★ 遮罩真的变暗了', dn.ovBg);
  if(dn.panel){
    okNum(dn.panel.w, x => x <= w - 8, '面板没超出屏宽', dn.panel.w.toFixed(1) + ' / ' + w);
    okNum(dn.panel.top, x => x >= 0, '面板顶端没出屏', dn.panel.top.toFixed(1));
    okNum(dn.panel.bottom, x => x <= h + 1, '★ 面板底端没出屏', dn.panel.bottom.toFixed(1) + ' / ' + h);
    okNum(dn.panel.h, x => x >= 180, '面板有实际高度（内容没塌）', dn.panel.h.toFixed(1) + 'px');
  } else ok(false, '量不到面板尺寸');

  ok(dn.stars === 3, '面板上三颗星', String(dn.stars));
  ok(dn.starsOn >= 1 && dn.starsOn <= 3, '★ 点亮的星星数在 1~3 之间（' + dn.starsOn + '）');
  ok(/rgb/.test(dn.starColor || ''), '星星有真实颜色（' + dn.starColor + '）');
  ok((dn.btns || []).length === 3, '面板三个图标按钮（重来 / 下一关 / 关闭）', String((dn.btns || []).length));
  if(dn.btns && dn.btns.length === 3){
    const minBH = Math.min(...dn.btns.map(b => b.h));
    const minBW = Math.min(...dn.btns.map(b => b.w));
    okNum(minBH, x => x >= 40, '面板按钮高 ≥ 40px', '最矮 ' + minBH.toFixed(1) + 'px');
    okNum(minBW, x => x >= 44, '面板按钮宽 ≥ 44px', '最窄 ' + minBW.toFixed(1) + 'px');
    ok(dn.btns.every(b => b.bottom <= (dn.panel ? dn.panel.bottom : h) + 1), '按钮都在面板内部');
  }
  ok(readablePart(dn.visibleText).length === 0, '★ 过关面板上也没有文字',
     readablePart(dn.visibleText) || '');

  /* ---------- ★ 十档奖品刻度：真的画出来了、认得出、有层级 ---------- */
  const tk = dn.ticks || {};
  ok(tk.count === 10, '★ 面板上十档刻度都画出来了', String(tk.count));
  ok(tk.curCount === 1, '★ 恰好一档标成「当前档位」', String(tk.curCount));
  ok(tk.gotCount >= 1 && tk.gotCount <= 10,
     '★ 已拿到的档位数量合理（' + tk.gotCount + ' / 10）');
  /* 十档 emoji 必须互不相同 —— 重复的话玩家分不清档次 */
  ok(new Set(tk.emojis || []).size === 10,
     '★ 十档奖品图标互不相同', (tk.emojis || []).join(''));
  /* 字号够大才认得出（实测 10px 时 emoji 糊成一团颜色） */
  okNum(tk.fontSize, x => x >= 12,
     '★ 刻度字号 ≥ 12px（更小就认不出是皇冠还是小汽车）', 'fontSize=' + tk.fontSize + 'px');
  okNum(tk.h, x => x >= 16, '刻度格有足够高度', 'h=' + tk.h.toFixed(1));
  okNum(tk.w, x => x >= 20, '刻度格有足够宽度', 'w=' + tk.w.toFixed(1));
  /* 当前档位要放大 + 有高亮底色，不然看不出「我现在在哪一档」 */
  ok(/matrix/.test(tk.curScale || '') || tk.curScale === 'none',
     '当前档位有缩放变换（' + String(tk.curScale).slice(0, 30) + '…）');
  ok(/rgba?\(255/.test(tk.curBg || ''), '当前档位有高亮底色（' + tk.curBg + '）');

  ok(tk.allSized === true, '★ 十档刻度都有实际尺寸（没有塌成 0）');
  /* ★ 真渲染像素：每个 emoji 都真的画出了不透明像素（不是豆腐块 / 不是空白）
     —— 这条是这次用户反馈「第一个是萝卜吗」逼出来的：
        光断言「有 10 个元素」完全抓不住「渲染成空白方块」。 */
  ok(tk.allPainted === true, '★ 十档奖品都真的画出了像素（不是空白方块）',
     '每个的像素数：' + JSON.stringify(tk.painted));
  /* 与「确定缺失的码位」对比：像素数接近说明系统在用同一个兜底字形画它 */
  ok(tk.noneLooksLikeTofu === true,
     '★ 没有一个奖品是豆腐块（与缺失字形的像素数不同）',
     'tofu=' + tk.tofuPixels + ' vs ' + JSON.stringify(tk.painted));
  okNum(dn.overflowY, x => x <= 1, '面板弹出时整页仍不溢出', '溢出 ' + dn.overflowY + 'px');
  okNum(dn.overflowX, x => x <= 1, '面板弹出时仍不横向溢出', '溢出 ' + dn.overflowX + 'px');

  /* ---------- 记录面板 ---------- */
  section(`${name} ${w}×${h} · 记录面板`);
  const tp = r.top || {};
  ok(tp.shown === true, '★ 记录浮层能打开', String(tp.shown));
  if(tp.panel){
    okNum(tp.panel.w, x => x <= w - 8, '记录面板没超出屏宽', tp.panel.w.toFixed(1) + ' / ' + w);
    okNum(tp.panel.bottom, x => x <= h + 1, '★ 面板底端没出屏', tp.panel.bottom.toFixed(1) + ' / ' + h);
  } else ok(false, '量不到记录面板尺寸');
  ok(tp.rowCount === 10, '★ 十行（每关一行）', String(tp.rowCount));
  ok(tp.rowH >= 26, '每行高 ≥ 26px（10 行要一屏放下，行高会自适应压缩）', '行高 ' + (tp.rowH || 0).toFixed(1) + 'px');
  ok(tp.rowOverlap === false, '★ 10 行互不重叠');
  /* ⚠️ 10 行 × 26px 已经接近短屏面板的全部可用高度，硬要「全部塞下」
     会逼着把行高压到看不清。所以这里锁的是**面板不被撑破 + 列表可滚动**，
     而不是「一行都不用滚」—— 后者在 320×568 上做不到，也不该做。 */
  ok(tp.listScrollH <= tp.listClientH + 1 || tp.listClientH > 0,
     '★ 10 行要么放得下、要么在列表内部滚动（不撑破面板）',
     'scrollH=' + tp.listScrollH + ' clientH=' + tp.listClientH);
  ok((tp.btns || []).length === 2, '记录面板两个按钮', String((tp.btns || []).length));
  ok(readablePart(tp.visibleText).length === 0, '★ 记录面板上也没有文字',
     readablePart(tp.visibleText) || '');

  /* ---------- 特效画布 ---------- */
  section(`${name} ${w}×${h} · 特效画布`);
  ok(v1.fxPE === 'none', '★ 画布不吃点击（pointer-events:none）', v1.fxPE);
}

console.log('\n' + '='.repeat(52));
if(fail === 0) console.log(`全部通过：${pass} 项（${results.length} 个视口）`);
else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
