#!/usr/bin/env node
/**
 * 舒尔特方格 · 真机布局回归（无头 Chrome 真渲染，量真实像素）
 *
 * 为什么需要它：tools/test_schulte.js 跑在假 DOM 里，CSS 完全不生效 ——
 * 「格子够不够大、9×9 在 320 宽的老机型上会不会挤成一条缝、页面会不会被顶出屏幕、
 * 撒花画布会不会盖住按钮点不着」这类纯布局问题只能在真浏览器里量。
 *
 * 用法：node tools/test_schulte_ui.js [站点根URL]
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

/* ⚠️ 无头 Chrome 的 --virtual-time-budget 会把虚拟时间一次性快进，
   但 requestAnimationFrame 只跑得到一两帧。本作的「演出播完 → 弹结算面板」
   是挂在 rAF 的 step(dt) 上的，所以在无头环境里它永远不会到点。
   探测页因此显式补一次 step，验证「时间到了面板会弹」这条逻辑；
   纯 CSS 的动画（错峰延迟、抖动、变红）不依赖 rAF，照常真渲染量。 */
const FORCE_PANEL_MS = 2000;

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
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/schulte/';

function rect(e){ const r=e.getBoundingClientRect();
  return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}; }

f.onload=()=>setTimeout(()=>{
  const out={ok:true,views:{}};
  try{
    const d=f.contentDocument, w0=f.contentWindow;
    const E=id=>d.getElementById(id);
    const de=d.documentElement, body=d.body;

    /* 量一个模式下棋盘与格子的真实尺寸 */
    function measure(n){
      w0.__schulteNewGame(n);
      const cells=[...d.querySelectorAll('#board .cell')].map(rect);
      const board=rect(E('board'));
      const modes=[...d.querySelectorAll('#modes button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim(),
        on:e.classList.contains('on')}));
      const ctl=[...d.querySelectorAll('#ctl button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim()}));
      const hud=[...d.querySelectorAll('#hud .st')].map(rect);
      const st=w0.__schulte();
      const minW=Math.min(...cells.map(c=>c.w));
      const minH=Math.min(...cells.map(c=>c.h));
      const maxRight=Math.max(...cells.map(c=>c.right));
      const maxBottom=Math.max(...cells.map(c=>c.bottom));
      const fs=parseFloat(getComputedStyle(d.querySelector('#board .cell')).fontSize);
      return {
        n, count:cells.length,
        board, cells: cells.slice(0, 4),
        cellW:minW, cellH:minH,
        cellRightMax:maxRight, cellBottomMax:maxBottom,
        fs, side:st.side, gap:st.gap, rad:st.rad,
        modes, ctl, hud,
        modesOn: modes.filter(m=>m.on).length,
        overflowY: body.scrollHeight - body.clientHeight,
        overflowX: de.scrollWidth - de.clientWidth,
        boardSquare: Math.abs(board.w - board.h) <= 1,
        boardInStage: board.top >= rect(E('stage')).top - 1 && board.bottom <= rect(E('stage')).bottom + 1,
        fxPE: getComputedStyle(E('fx')).pointerEvents,
        fxZ: getComputedStyle(E('fx')).zIndex,
        stageH: rect(E('stage')).h,
        ctlBottom: Math.max(...ctl.map(c=>c.bottom)),
      };
    }

    out.views['4']=measure(4);
    out.views['5']=measure(5);
    out.views['6']=measure(6);
    out.views['7']=measure(7);
    out.views['8']=measure(8);
    out.views['9']=measure(9);

    /* 点错时的视觉反馈：点一下非 1 的数字，量抖动样式真的生效 */
    w0.__schulteNewGame(5);
    const st0=w0.__schulte();
    const wrong = st0.nums.find(v=>v!==1);
    w0.__schulteTap(wrong);
    const badEl=[...d.querySelectorAll('#board .cell')].find(e=>e.classList.contains('bad'));
    out.badCell = badEl ? { anim:getComputedStyle(badEl).animationName,
                            color:getComputedStyle(badEl).color,
                            border:getComputedStyle(badEl).borderColor } : null;

    /* ★ 绿色只跟着「上一个正确数字」走，绝不累积：
       连点 10 个正确的数字后，盘面上必须**恰好一格**是绿的（10 号），
       其余 35 格（包括已点过的 1~9）的 computed 样式必须完全一致 ——
       否则等于把「哪些数字已经点过」标在盘面上，难度被自己的反馈削平。
       ⚠️ 不能在探测页里忙等真实时间 —— 无头 Chrome 的虚拟时间不会因为空转前进，
       那样会直接把 --virtual-time-budget 耗死。改成接管游戏时钟，确定性推进。 */
    let fakeT = 1000;
    w0.__schulteSetClock(()=>fakeT);
    w0.__schulteNewGame(6);
    const probeCells=[...d.querySelectorAll('#board .cell')];
    for(let v=1;v<=10;v++){ fakeT += 50; w0.__schulteTap(v); }
    const snapshot=()=>probeCells.map(e=>{
      const cs=getComputedStyle(e);
      return [cs.backgroundImage,cs.backgroundColor,cs.color,cs.borderColor,cs.opacity,
              cs.boxShadow,e.className].join('|');
    });
    const withFlash = snapshot();
    const hitCount = probeCells.filter(e=>e.classList.contains('hit')).length;
    const greenDuring = probeCells.filter(e=>e.classList.contains('prev')).length;
    /* 对照用：刚点的那一格（v=10）在「闪光中」和「闪光后」的样式必须不同 ——
       否则「其余 35 格样式一致」可能只是因为它压根没画 */
    const flashCellIdx = probeCells.findIndex(e=>e.dataset.v === '10');
    const flashCellStyle = snapshot()[flashCellIdx];
    fakeT += 1000;                       // 闪光早已过期
    w0.__schulteStep(0.016);             // step 里会 prune 掉过期闪光
    const clean = snapshot();
    const flashCellStyleAfter = clean[flashCellIdx];
    const uniqClean = [...new Set(clean)];
    const hitLeft = probeCells.filter(e=>e.classList.contains('hit')).length;
    const greenCells = probeCells.filter(e=>e.classList.contains('prev'));
    const greenVs = greenCells.map(e=>e.dataset.v);
    /* 除了那一格绿，其余 35 格的样式必须只有 1 种 */
    const others = probeCells.filter(e=>!e.classList.contains('prev'))
                             .map(e=>{const cs=getComputedStyle(e);
                               return [cs.backgroundImage,cs.backgroundColor,cs.color,
                                       cs.borderColor,cs.opacity,cs.boxShadow,e.className].join('|');});
    const uniqOthers = [...new Set(others)];
    /* 已点过的 1~9 必须和没点过的 11~36 完全同款 */
    const clickedStyles = probeCells.filter(e=>{
      const v=+e.dataset.v; return v>=1 && v<=9; })
      .map(e=>{const cs=getComputedStyle(e);
        return [cs.backgroundImage,cs.backgroundColor,cs.color,cs.borderColor,cs.opacity,
                cs.boxShadow,e.className].join('|');});
    const restStyles = probeCells.filter(e=>+e.dataset.v >= 11)
      .map(e=>{const cs=getComputedStyle(e);
        return [cs.backgroundImage,cs.backgroundColor,cs.color,cs.borderColor,cs.opacity,
                cs.boxShadow,e.className].join('|');});
    w0.__schulteSetClock(null);          // 还原真实时钟
    out.leak = {
      total: probeCells.length,
      hitDuring: hitCount,
      hitLeft,
      greenDuring,
      greenCount: greenCells.length,
      greenVs,
      withFlashUniq: [...new Set(withFlash)].length,
      cleanUniq: uniqClean.length,
      flashChanged: flashCellStyle !== flashCellStyleAfter,
      flashStyleBefore: flashCellStyle,
      flashStyleAfter: flashCellStyleAfter,
      uniqOthers: uniqOthers.length,
      clickedUniq: [...new Set(clickedStyles)].length,
      restUniq: [...new Set(restStyles)].length,
      sample: uniqOthers.slice(0,2),
    };

    /* 通关演出：棋盘要进 won 状态，撒花画布要真的在画 */
    w0.__schulteNewGame(5);
    for(let v=1; v<=25; v++) w0.__schulteTap(v);
    const fxCv=E('fx');
    const fxRect=rect(fxCv);
    out.win = {
      state: w0.__schulte().state,
      boardWon: E('board').classList.contains('won'),
      cellAnim: getComputedStyle(d.querySelector('#board .cell')).animationName,
      cellDelay: getComputedStyle(d.querySelector('#board .cell')).animationDelay,
      fx: w0.__schulteFx(),
      fxW: fxCv.width, fxH: fxCv.height,
      fxRect,
      fxZ: getComputedStyle(fxCv).zIndex,
      fxPE: getComputedStyle(fxCv).pointerEvents,
      overflowY: body.scrollHeight - body.clientHeight,
      overflowX: de.scrollWidth - de.clientWidth,
    };

    /* 撒花画布是否真的画上了东西（读像素，不是只看有没有 canvas） */
    setTimeout(()=>{
      try{
        const cv=E('fx');
        const ctx=cv.getContext('2d');
        let lit=0;
        if(ctx && cv.width>0 && cv.height>0){
          const stepX=Math.max(1, Math.floor(cv.width/60));
          const stepY=Math.max(1, Math.floor(cv.height/60));
          for(let y=0;y<cv.height;y+=stepY){
            for(let x=0;x<cv.width;x+=stepX){
              const px=ctx.getImageData(x,y,1,1).data;
              if(px[3]>16) lit++;
            }
          }
        }
        out.win.fxPixels=lit;

        /* 结算面板：等演出播完（无头环境里手动补一次 step，见文件头说明） */
        w0.__schulteStep(${FORCE_PANEL_MS / 1000});
        setTimeout(()=>{
          try{
            const ov=E('doneOv'), panel=ov.querySelector('.panel');
            /* ⚠️ 无头 Chrome 的虚拟时间会把 CSS 过渡卡在起始值上
               （.show 已经挂上了，computed opacity 却还是 0），
               所以量之前先把过渡关掉，读到的才是「目标样式」。
               这条断言要抓的是「面板到底是真不透明还是只挂了个 class」，
               而不是「过渡动画播到第几帧」。 */
            const shownCls = ov.classList.contains('show');
            if(panel){ panel.style.transition='none'; }
            ov.style.transition='none';
            void ov.offsetWidth;
            const ro=rect(ov), rp=panel?rect(panel):null;
            const btns=[...ov.querySelectorAll('button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim()}));
            out.done={
              shown: ov.classList.contains('on'),
              showCls: shownCls,
              panelShown: w0.__schulte().panelShown,
              panel: rp,
              /* ★ 光看 .on 不够：曾经出现过「状态已经 done、面板挂上了 .on，
                 却因为过渡动画没跑起来而一直是 opacity:0」的假显示。
                 这里直接读真实计算样式，面板必须真的不透明、遮罩必须真的变暗。 */
              panelOpacity: panel ? parseFloat(getComputedStyle(panel).opacity) : -1,
              panelBg: panel ? getComputedStyle(panel).backgroundColor : '',
              ovBg: getComputedStyle(ov).backgroundColor,
              btns,
              overflowY: body.scrollHeight - body.clientHeight,
              overflowX: de.scrollWidth - de.clientWidth,
              timeText: E('doneTime').textContent,
              recText: E('doneRec').textContent,
              titleText: (ov.querySelector('h2')||{}).textContent || '',
              ovRect: ro,
            };
            document.getElementById('out').textContent=JSON.stringify(out);
          }catch(e){ out.err='done:'+e.message; document.getElementById('out').textContent=JSON.stringify(out); }
        }, 2200);
      }catch(e){ out.err='fx:'+e.message; document.getElementById('out').textContent=JSON.stringify(out); }
    }, 700);
  }catch(e){
    document.getElementById('out').textContent=JSON.stringify({ok:false,err:e.message});
  }
},700);
</script></body></html>`;
  const tmpPage = path.join(siteRoot, '_ui_probe_schulte.html');
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gschulteui-'));
  const profile = path.join(tmpDir, 'profile');
  let dom = '';
  try{
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, '--virtual-time-budget=30000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_ui_probe_schulte.html',
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
console.log('被测页面: ' + BASE.replace(/\/$/, '') + '/schulte/');

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
  if(r.err){ console.log(`\n-- ${name} ${w}×${h} --\n  ⚠️ 探测中途出错：${r.err}`); }
  results.push([name, w, h, r]);
}

if(!results.length){ console.log('所有视口都量不到，跳过。'); process.exit(0); }

for(const [name, w, h, r] of results){
  section(`${name}  ${w}×${h}`);

  /* ---------- 整页：一屏放得下 ---------- */
  const v5 = r.views['5'];
  okNum(v5.overflowX, v => v <= 1, '不横向溢出', '溢出 ' + v5.overflowX + 'px');
  okNum(v5.overflowY, v => v <= 1, '不纵向溢出（一屏放得下，不用滚）', '溢出 ' + v5.overflowY + 'px');
  okNum(v5.ctlBottom, v => v <= h + 1, '底部控制条在屏幕内', '最低点 ' + v5.ctlBottom.toFixed(1) + ' / 屏高 ' + h);

  /* ---------- 模式条 ---------- */
  ok(v5.modes.length === 6, '模式条 6 个按钮都在', String(v5.modes.length));
  ok(v5.modesOn === 1, '★ 恰好一个模式高亮', '高亮 ' + v5.modesOn + ' 个');
  const minModeW = Math.min(...v5.modes.map(m => m.w));
  const minModeH = Math.min(...v5.modes.map(m => m.h));
  okNum(minModeH, v => v >= 26, '模式按钮高 ≥ 26px', '最矮 ' + minModeH.toFixed(1) + 'px');
  okNum(minModeW, v => v >= 40, '模式按钮宽 ≥ 40px（320 窄屏也不挤成一条缝）', '最窄 ' + minModeW.toFixed(1) + 'px');
  ok(v5.modes.every((m, i) => i === 0 || m.left >= v5.modes[i - 1].right - 0.5), '六个模式按钮不重叠');
  ok(v5.modes.every(m => m.text.length > 0), '模式按钮都有文字');

  /* ---------- 仪表 ---------- */
  ok(v5.hud.length === 3, '仪表三格（用时 / 下一个 / 误点）', String(v5.hud.length));
  ok(v5.hud.every(x => x.w > 40), '仪表每格都有宽度', v5.hud.map(x => x.w.toFixed(0)).join('/'));
  ok(v5.hud.every((x, i) => i === 0 || x.left >= v5.hud[i - 1].right - 0.5), '仪表三格不重叠');

  /* ---------- 棋盘：4×4 ~ 9×9 逐个量 ---------- */
  for(const n of [4,5,6,7,8,9]){
    const v = r.views[String(n)];
    if(!v){ ok(false, n + '×' + n + ' 没量到'); continue; }
    section(`${name} ${w}×${h} · ${n}×${n}`);

    ok(v.count === n * n, `格子数 = ${n * n}`, String(v.count));
    ok(v.boardSquare, '★ 棋盘是正方形（宽高差 ≤ 1px）',
       `宽 ${v.board.w.toFixed(1)} / 高 ${v.board.h.toFixed(1)}`);
    ok(v.boardInStage, '棋盘完整落在舞台内（没被顶出去）');
    okNum(v.board.w, x => x <= w + 1, '棋盘不超出屏宽', v.board.w.toFixed(1) + ' / ' + w);
    okNum(v.board.h, x => x <= h + 1, '棋盘不超出屏高', v.board.h.toFixed(1) + ' / ' + h);

    /* 触屏最小可点尺寸：44px 是舒适区，但 8×8 / 9×9 在窄屏上物理上做不到，
       所以按模式分档：≤6 要求 44px，7~8 要求 32px，9 要求 28px。 */
    const minTap = n <= 6 ? 44 : (n <= 8 ? 32 : 28);
    okNum(v.cellW, x => x >= minTap, `${n}×${n} 单格宽 ≥ ${minTap}px`, '最窄 ' + v.cellW.toFixed(1) + 'px');
    okNum(v.cellH, x => x >= minTap, `${n}×${n} 单格高 ≥ ${minTap}px`, '最矮 ' + v.cellH.toFixed(1) + 'px');

    okNum(v.fs, x => x >= 9, `${n}×${n} 数字字号 ≥ 9px`, v.fs.toFixed(1) + 'px');
    okNum(v.gap, x => x >= 2 && x <= 9, `${n}×${n} 格间距 2~9px`, v.gap + 'px');

    /* 格子不能溢出棋盘 */
    okNum(v.cellRightMax, x => x <= v.board.right + 1, `${n}×${n} 格子没超出棋盘右边`,
       '最右 ' + v.cellRightMax.toFixed(1) + ' / 棋盘右 ' + v.board.right.toFixed(1));
    okNum(v.cellBottomMax, x => x <= v.board.bottom + 1, `${n}×${n} 格子没超出棋盘下边`,
       '最下 ' + v.cellBottomMax.toFixed(1) + ' / 棋盘下 ' + v.board.bottom.toFixed(1));
    okNum(v.cellRightMax, x => x <= w + 1, `${n}×${n} 格子没超出屏宽`, v.cellRightMax.toFixed(1) + ' / ' + w);

    okNum(v.overflowY, x => x <= 1, `${n}×${n} 下整页仍不纵向溢出`, '溢出 ' + v.overflowY + 'px');
    okNum(v.overflowX, x => x <= 1, `${n}×${n} 下整页仍不横向溢出`, '溢出 ' + v.overflowX + 'px');
  }

  /* ---------- 点错反馈真的生效 ---------- */
  section(`${name} ${w}×${h} · 点错反馈`);
  if(!r.badCell){
    ok(false, '点错后找不到 .bad 格子（反馈没画出来）');
  } else {
    ok(r.badCell.anim && r.badCell.anim !== 'none', '★ 点错的格子有抖动动画（' + r.badCell.anim + '）');
    ok(/rgb\(255,\s*1[0-9][0-9]/.test(r.badCell.color) || r.badCell.color !== 'rgb(232, 236, 243)',
       '★ 点错的格子数字变红（' + r.badCell.color + '）');
    ok(r.badCell.border && r.badCell.border !== 'rgba(0, 0, 0, 0)', '边框也变了（' + r.badCell.border + '）');
  }

  /* ---------- ★ 绿色只跟着上一个正确数字 ---------- */
  section(`${name} ${w}×${h} · 绿色不累积`);
  const lk = r.leak || {};
  ok(lk.total === 36, '6×6 共 36 格', String(lk.total));
  ok(lk.hitDuring >= 1, '刚点的那一格确实闪了一下（hit）', '闪烁 ' + lk.hitDuring + ' 格');
  ok(lk.hitLeft === 0, '★ 闪光过期后一格都不剩', '残留 ' + lk.hitLeft + ' 格');
  ok(lk.greenCount === 1, '★ 点了 10 个之后，绿色仍然只有 1 格（实际 ' + lk.greenCount + ' 格）',
     JSON.stringify(lk.greenVs));
  ok(JSON.stringify(lk.greenVs) === JSON.stringify(['10']),
     '★ 绿的是刚点对的 10（下一个该点 11）', JSON.stringify(lk.greenVs));
  ok(lk.uniqOthers === 1,
     '★ 除那一格绿之外，其余 35 格的 computed 样式只有 1 种',
     '出现 ' + lk.uniqOthers + ' 种');
  ok(lk.clickedUniq === 1 && lk.restUniq === 1,
     '★ 已点过的 1~9 与没点过的 11~36 视觉上完全一样',
     '已点 ' + lk.clickedUniq + ' 种 / 未点 ' + lk.restUniq + ' 种');
  ok(lk.flashChanged === true,
     '（对照：刚点那一格在闪光中和闪光后的样式确实不同 —— 说明"其余 35 格一致"不是因为压根没画）',
     JSON.stringify(lk.flashStyleBefore) + ' vs ' + JSON.stringify(lk.flashStyleAfter));

  /* ---------- 过关特效 ---------- */
  section(`${name} ${w}×${h} · 过关特效`);
  const win = r.win || {};
  ok(win.state === 'done', '探针把这一局打通了', String(win.state));
  ok(win.boardWon === true, '★ 棋盘进入 won 状态');
  ok(win.cellAnim && win.cellAnim !== 'none', '★ 格子有庆祝动画（' + win.cellAnim + '）');
  ok(win.cellDelay && win.cellDelay !== '0s', '★ 庆祝动画有错峰延迟（' + win.cellDelay + '）—— 斜向波次而不是同时亮');
  ok((win.fx && win.fx.parts) >= 100, '★ 撒花粒子已生成（' + (win.fx && win.fx.parts) + ' 片）');
  ok((win.fx && win.fx.rings) >= 3, '★ 冲击波光环已生成（' + (win.fx && win.fx.rings) + ' 圈）');
  ok(win.fxW > 0 && win.fxH > 0, '撒花画布有真实像素尺寸（' + win.fxW + '×' + win.fxH + '）');
  okNum(win.fxRect && win.fxRect.w, x => Math.abs(x - w) <= 2, '画布宽度铺满屏幕', (win.fxRect && win.fxRect.w || 0).toFixed(1) + ' / ' + w);
  okNum(win.fxRect && win.fxRect.h, x => Math.abs(x - h) <= 2, '画布高度铺满屏幕', (win.fxRect && win.fxRect.h || 0).toFixed(1) + ' / ' + h);
  ok(win.fxPE === 'none', '★ 画布不吃点击（pointer-events:none）—— 不会挡住下面的按钮');
  okNum(win.fxPixels, x => x > 0, '★ 画布上真的画出了东西（采样到 ' + win.fxPixels + ' 个非透明像素）');
  okNum(win.overflowY, x => x <= 1, '演出期间仍不纵向溢出', '溢出 ' + win.overflowY + 'px');

  /* ---------- 结算面板 ---------- */
  section(`${name} ${w}×${h} · 结算面板`);
  const dn = r.done || {};
  ok(dn.panelShown === true, '★ 演出到点后结算面板弹出', String(dn.panelShown));
  ok(dn.shown === true, '面板真的显示了（.on）');
  ok(dn.showCls === true, '★ 面板挂上了 .show（过渡的终点状态），不是只有 .on 的空壳');
  okNum(dn.panelOpacity, x => x > 0.9, '★ 面板真的不透明（不是只挂了 class 的假显示）',
     'opacity=' + dn.panelOpacity);
  ok(/rgba?\(8,\s*10,\s*14/.test(dn.ovBg || '') && !/, 0\)$/.test(dn.ovBg || ''),
     '★ 遮罩真的变暗了（不是透明的）', dn.ovBg);
  if(dn.panel){
    okNum(dn.panel.w, x => x <= w - 8, '面板没超出屏宽', dn.panel.w.toFixed(1) + ' / ' + w);
    okNum(dn.panel.top, x => x >= 0, '面板顶端没出屏', dn.panel.top.toFixed(1));
    okNum(dn.panel.bottom, x => x <= h + 1, '面板底端没出屏', dn.panel.bottom.toFixed(1) + ' / ' + h);
    okNum(dn.panel.h, x => x >= 140, '面板有实际高度（内容没塌）', dn.panel.h.toFixed(1) + 'px');
  } else {
    ok(false, '量不到面板尺寸');
  }
  ok((dn.btns || []).length === 2, '面板两个按钮都在', String((dn.btns || []).length));
  if(dn.btns && dn.btns.length === 2){
    const minBH = Math.min(...dn.btns.map(b => b.h));
    okNum(minBH, x => x >= 34, '面板按钮高 ≥ 34px', '最矮 ' + minBH.toFixed(1) + 'px');
    ok(dn.btns.every(b => b.bottom <= (dn.panel ? dn.panel.bottom : h) + 1), '按钮都在面板内部');
    ok(dn.btns.every(b => b.text.length > 0), '按钮都有文字');
  }
  ok(/\d/.test(dn.timeText || ''), '面板显示了用时（' + dn.timeText + '）');
  ok((dn.recText || '').length > 0, '面板显示了成绩说明（' + dn.recText + '）');
  okNum(dn.overflowY, x => x <= 1, '面板弹出时整页仍不溢出', '溢出 ' + dn.overflowY + 'px');
  okNum(dn.overflowX, x => x <= 1, '面板弹出时仍不横向溢出', '溢出 ' + dn.overflowX + 'px');
}

console.log('\n' + '='.repeat(52));
if(fail === 0) console.log(`全部通过：${pass} 项（${results.length} 个视口）`);
else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
