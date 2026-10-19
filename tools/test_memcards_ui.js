#!/usr/bin/env node
/**
 * 记忆扑克 · 真机布局回归（无头 Chrome 真渲染，量真实像素）
 *
 * 为什么需要它：tools/test_memcards.js 跑在假 DOM 里，CSS 完全不生效 ——
 * 「牌够不够大、9 张在 320 宽的老机型上会不会挤成一条缝、整页会不会被顶出屏幕、
 *  撒花画布会不会盖住按钮点不着、牌桌会不会随阶段跳来跳去」这类问题只能在真浏览器里量。
 *
 * 用法：node tools/test_memcards_ui.js [站点根URL]
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
f.style.width=W+'px'; f.style.height=H+'px'; f.src='/memcards/';

function rect(e){ const r=e.getBoundingClientRect();
  return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}; }

f.onload=()=>setTimeout(()=>{
  const out={ok:true,views:{}};
  try{
    const d=f.contentDocument, w0=f.contentWindow;
    const E=id=>d.getElementById(id);
    const de=d.documentElement, body=d.body;
    const DT=1/60;
    function run(sec){ const n=Math.round(sec/DT); for(let i=0;i<n;i++) w0.__memStep(DT); }
    function toAsk(){ let g=0; while(w0.__mem().phase!=='ask' && g++<4000) w0.__memStep(DT); }

    /* 量一个难度档的真实尺寸（含牌桌在三个阶段的位置，验证「牌不跳」） */
    function measure(lv){
      w0.__memNewGame(lv);
      const st0=w0.__mem();
      const idleBoard=rect(E('board'));
      const idleCards=[...d.querySelectorAll('#board .card')].map(rect);
      w0.__memStart();
      const showCards=[...d.querySelectorAll('#board .card')].map(rect);
      const showBoard=rect(E('board'));
      toAsk();
      const askCards=[...d.querySelectorAll('#board .card')].map(rect);
      const askBoard=rect(E('board'));

      const cards=[...d.querySelectorAll('#board .card')];
      const fs=parseFloat(getComputedStyle(cards[0]).fontSize);
      const pipFs=parseFloat(getComputedStyle(cards[0].querySelector('.pip')).fontSize);
      const crFs=parseFloat(getComputedStyle(cards[0].querySelector('.cr')).fontSize);
      /* ★ 牌的可见性：入场动画绝不能靠 opacity 从 0 开始。
         无头 Chrome 的虚拟时间会把 CSS 动画卡在起始帧上，一旦 0% 里写了
         opacity:0（或者 animation-fill-mode:both 让延迟期套上 0% 关键帧），
         整手牌就会**永久透明** —— 截图里看到的是空牌桌，但 DOM 一切正常。 */
      const opacities=cards.map(e=>parseFloat(getComputedStyle(e).opacity));
      const minOpacity=Math.min(...opacities);
      const stages=rect(E('stage'));
      const ask=rect(E('askWrap'));
      const ctl=[...d.querySelectorAll('#ctl button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim()}));
      const modes=[...d.querySelectorAll('#modes button')].map(e=>Object.assign(rect(e),{text:e.textContent.trim(),
        on:e.classList.contains('on')}));
      const hud=[...d.querySelectorAll('#hud .st')].map(rect);

      const minW=Math.min(...askCards.map(c=>c.w));
      const minH=Math.min(...askCards.map(c=>c.h));
      const maxRight=Math.max(...askCards.map(c=>c.right));
      const maxBottom=Math.max(...askCards.map(c=>c.bottom));
      const minLeft=Math.min(...askCards.map(c=>c.left));
      const minTop=Math.min(...askCards.map(c=>c.top));
      const maxIdleBottom=Math.max(...idleCards.map(c=>c.bottom));

      /* 「牌不跳」：看牌 → 提问，每张牌的位置变化（牌数不变，位置就该一模一样） */
      let maxShift=0;
      for(let i=0;i<askCards.length;i++){
        maxShift=Math.max(maxShift,
          Math.abs(askCards[i].left-showCards[i].left),
          Math.abs(askCards[i].top-showCards[i].top));
      }

      const st=w0.__mem();
      return {
        lv, n:cards.length,
        cardW:minW, cardH:minH,
        cardRightMax:maxRight, cardBottomMax:maxBottom,
        cardLeftMin:minLeft, cardTopMin:minTop,
        idleBottomMax:maxIdleBottom,
        board:askBoard, showBoard, idleBoard,
        cw:st.cw, ch:st.ch, gap:st.gap, cols:st.cols, rows:st.rows,
        fs, pipFs, crFs, minOpacity,
        stage:stages, ask, ctl, modes, hud,
        maxShift,
        overflowY: body.scrollHeight - body.clientHeight,
        overflowX: de.scrollWidth - de.clientWidth,
        boardSquare: null,
        ratio: st.ch / st.cw,
        inStage: askBoard.top >= stages.top - 1 && askBoard.bottom <= stages.bottom + 1,
        modesOn: modes.filter(m=>m.on).length,
        fxPE: getComputedStyle(E('fx')).pointerEvents,
        fxZ: getComputedStyle(E('fx')).zIndex,
        ctlBottom: Math.max(...ctl.map(c=>c.bottom)),
        askH: ask.h,
      };
    }

    out.views['0']=measure(0);
    out.views['1']=measure(1);
    out.views['2']=measure(2);
    out.views['3']=measure(3);

    /* ---------- 提问阶段的视觉：牌真的扣着 ---------- */
    {
      /* ⚠️ 必须确定性挑一局**非顺序题**：顺序题在提问阶段是翻开的（它要的就是把牌点出来），
         随机抽到它就会整段跳过，断言数在 823~828 之间抖 —— 覆盖不稳定。 */
      let picked=null;
      for(let seed=1; seed<400 && !picked; seed++){
        w0.__memNewGame(1, 20000+seed); w0.__memStart(); toAsk();
        const st=w0.__mem();
        if(st.task!=='order') picked=st;
      }
      if(!picked){
        out.facedown = { task:'none', all:[], first:null };
      } else {
        const cards=[...d.querySelectorAll('#board .card')];
        const backs=cards.map(e=>{
          const inner=e.querySelector('.inner');
          return { t: getComputedStyle(inner).transform, back: getComputedStyle(e.querySelector('.back')).backfaceVisibility };
        });
        out.facedown = { task: picked.task, all: backs, first: backs[0] };
      }
      out.askText = w0.__memAskText();
      out.askOpts = w0.__memAsk().map(o=>o.text);
    }

    /* ---------- 揭晓：目标牌亮金框 ---------- */
    {
      /* 找一局 suit / point 题来验「揭晓才亮金框」 */
      let found=null;
      for(let seed=1; seed<200 && !found; seed++){
        w0.__memNewGame(1, 9000+seed); w0.__memStart(); toAsk();
        const st=w0.__mem();
        if(st.task==='suit'||st.task==='point'){
          const before=[...d.querySelectorAll('#board .card')].map(e=>e.className);
          const right = st.task==='suit' ? st.cards[st.target].suit : st.cards[st.target].rank;
          w0.__memAnswer(right);
          const els=[...d.querySelectorAll('#board .card')];
          const targetIdx=els.findIndex(e=>e.classList.contains('target'));
          const tStyle=targetIdx>=0 ? getComputedStyle(els[targetIdx].querySelector('.face')) : null;
          found={
            task:st.task, target:st.target, targetIdx,
            beforeHasTarget: before.some(c=>/target/.test(c)),
            boxShadow: tStyle ? tStyle.boxShadow : '',
            cardBoxShadow: targetIdx>=0 ? getComputedStyle(els[targetIdx]).boxShadow : '',
          };
        }
      }
      out.reveal = found;
    }

    /* ---------- 顺序题：洗位后牌要能点、序号角标看得见 ---------- */
    {
      let found=null;
      for(let seed=1; seed<300 && !found; seed++){
        w0.__memNewGame(1, 4000+seed); w0.__memStart(); toAsk();
        const st=w0.__mem();
        if(st.task==='order'){
          const idxOf={}; st.cards.forEach((c,i)=>{ idxOf[c.id]=i; });
          w0.__memTapCard(idxOf[st.order[0]]);
          /* ⚠️ 必须重新读一次状态：上面那个 st 是点击**之前**的快照 */
          const st2=w0.__mem();
          const els=[...d.querySelectorAll('#board .card')];
          const withOrd=els.filter(e=>e.querySelector('.ord'));
          const ordRect = withOrd.length ? rect(withOrd[0].querySelector('.ord')) : null;
          found={
            picks: st2.picked.length,
            ordCount: withOrd.length,
            ordText: withOrd.length ? withOrd[0].querySelector('.ord').textContent : null,
            ordRect,
            cardRect: withOrd.length ? rect(withOrd[0]) : null,
            tipText: (w0.__memAsk().find(o=>/已点/.test(o.text))||{}).text || '',
          };
        }
      }
      out.order = found;
    }

    /* ---------- 收牌动画：牌真的翻过去了（transform 变了） ----------
       ⚠️ 这段必须放在结算探针**之前**：它要 newGame（会 hideDone），
       放在后面就会把刚弹出来的结算面板状态清掉（第一版就是这么错的）。 */
    {
      w0.__memNewGame(1, 77); w0.__memStart();
      const el0=d.querySelector('#board .card .inner');
      const t0=getComputedStyle(el0).transform;
      run(w0.__mem().showT + 0.1);
      const t1=getComputedStyle(el0).transform;
      const downCls=d.querySelector('#board .card').classList.contains('down');
      out.flip={ before:t0, after:t1, changed:t0!==t1, downCls };
    }

    /* ---------- 结算面板 ---------- */
    {
      w0.__memNewGame(0); w0.__memStart();
      const lv=w0.__memLevels()[0];
      for(let r=0;r<lv.rounds;r++){
        toAsk();
        const st=w0.__mem();
        if(st.task==='order'){
          const idxOf={}; st.cards.forEach((c,i)=>{ idxOf[c.id]=i; });
          for(const id of st.order) w0.__memTapCard(idxOf[id]);
        } else {
          let right;
          if(st.task==='red') right=st.cards.filter(c=>c.red).length;
          else if(st.task==='suit') right=st.cards[st.target].suit;
          else right=st.cards[st.target].rank;
          w0.__memAnswer(right);
        }
        let g=0;
        while((w0.__mem().phase==='reveal'||w0.__mem().phase==='hide'||w0.__mem().phase==='show') && g++<4000) w0.__memStep(DT);
      }
      const stDone=w0.__mem();
      /* 无头环境里 rAF 只跑得到一两帧，所以手动补帧让「演出播完 → 弹面板」到点。
         ⚠️ 必须用 run() 一帧帧累加，**不能** __memStep(2.0) —— step 内部把 dt 夹到 0.12s，
         一次传 2 秒只会前进 0.12 秒（第一版就是这么错的，面板永远不弹）。 */
      run(2.0);
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
        out.done={
          phase: stDone.phase,
          panelShown: w0.__mem().panelShown,
          shown: ov.classList.contains('on'),
          showCls: shownCls,
          opacity: panel ? parseFloat(getComputedStyle(panel).opacity) : -1,
          ovBg: getComputedStyle(ov).backgroundColor,
          panel: panel ? rect(panel) : null,
          btns: [...ov.querySelectorAll('button')].map(rect),
          scoreText: E('doneScore').textContent,
          subText: E('doneSub').textContent,
          recText: E('doneRec').textContent,
          overflowY: body.scrollHeight - body.clientHeight,
          overflowX: de.scrollWidth - de.clientWidth,
        };

        /* ---------- 排行榜面板 ---------- */
        w0.__memOpenTop(0);
        setTimeout(()=>{
         try{
          const tov=E('topOv'), tpanel=tov.querySelector('.panel');
          if(tpanel){ tpanel.style.transition='none'; }
          tov.style.transition='none';
          void tov.offsetWidth;
          const rows=[...d.querySelectorAll('#topList .topRow')].map(e=>Object.assign(rect(e),{cls:e.className}));
          const list=E('topList');
          out.top={
            shown: tov.classList.contains('on'),
            panel: rect(tpanel),
            rows,
            rowCount: rows.length,
            rowH: rows.length ? rows[0].h : 0,
            rowOverlap: rows.some((r2,i)=> i>0 && r2.top < rows[i-1].bottom - 0.5),
            listScrollH: list.scrollHeight, listClientH: list.clientHeight,
            listBottom: rect(list).bottom,
            btns: [...tov.querySelectorAll('button')].map(rect),
            overflowY: body.scrollHeight - body.clientHeight,
            overflowX: de.scrollWidth - de.clientWidth,
          };
          w0.__memHideTop();
          document.getElementById('out').textContent=JSON.stringify(out);
         }catch(e2){ out.err='top:'+e2.message; document.getElementById('out').textContent=JSON.stringify(out); }
        }, 300);
       }catch(e){ out.err='done:'+e.message; document.getElementById('out').textContent=JSON.stringify(out); }
      }, 400);
    }

    /* 上面那段结算 / 排行榜是异步的，结果由它自己写进 <pre>。
       这里不再覆盖 out —— 只标记同步部分已经量完。 */
    out.ok=true;
  }catch(err){
    out={ok:false, err: String(err && err.stack || err)};
    document.getElementById('out').textContent=JSON.stringify(out);
  }
}, 260);
<\/script></body></html>`;

  const tmpPage = path.join(__dirname, '..', 'web', '_ui_probe_memcards.html');
  fs.writeFileSync(tmpPage, page, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memui-'));
  let dom = '';
  try{
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + tmpDir, '--virtual-time-budget=30000',
      '--window-size=1200,900', '--dump-dom',
      BASE.replace(/\/$/, '') + '/_ui_probe_memcards.html',
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
console.log('被测页面: ' + BASE.replace(/\/$/, '') + '/memcards/');

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

  /* ---------- 整页：一屏放得下 ---------- */
  const v1 = r.views['1'];
  okNum(v1.overflowX, v => v <= 1, '不横向溢出', '溢出 ' + v1.overflowX + 'px');
  okNum(v1.overflowY, v => v <= 1, '不纵向溢出（一屏放得下，不用滚）', '溢出 ' + v1.overflowY + 'px');
  okNum(v1.ctlBottom, v => v <= h + 1, '底部控制条在屏幕内', '最低点 ' + v1.ctlBottom.toFixed(1) + ' / 屏高 ' + h);

  /* ---------- 难度条 ---------- */
  ok(v1.modes.length === 4, '难度条 4 个按钮都在', String(v1.modes.length));
  ok(v1.modesOn === 1, '★ 恰好一个难度高亮', '高亮 ' + v1.modesOn + ' 个');
  const minModeW = Math.min(...v1.modes.map(m => m.w));
  const minModeH = Math.min(...v1.modes.map(m => m.h));
  okNum(minModeH, v => v >= 30, '难度按钮高 ≥ 30px', '最矮 ' + minModeH.toFixed(1) + 'px');
  okNum(minModeW, v => v >= 56, '难度按钮宽 ≥ 56px（320 窄屏也不挤成一条缝）', '最窄 ' + minModeW.toFixed(1) + 'px');
  ok(v1.modes.every((m, i) => i === 0 || m.left >= v1.modes[i - 1].right - 0.5), '四个难度按钮不重叠');
  ok(v1.modes.every(m => m.text.length > 0), '难度按钮都有文字');

  /* ---------- 仪表 ---------- */
  ok(v1.hud.length === 3, '仪表三格（轮次 / 得分 / 连击）', String(v1.hud.length));
  ok(v1.hud.every(x => x.w > 40), '仪表每格都有宽度', v1.hud.map(x => x.w.toFixed(0)).join('/'));
  ok(v1.hud.every((x, i) => i === 0 || x.left >= v1.hud[i - 1].right - 0.5), '仪表三格不重叠');

  /* ---------- 牌桌：四个难度逐个量 ---------- */
  for(const lv of [0,1,2,3]){
    const v = r.views[String(lv)];
    if(!v){ ok(false, lv + ' 档没量到'); continue; }
    const cardsN = [3,5,7,9][lv];
    section(`${name} ${w}×${h} · ${cardsN} 张（${v.lv} 档）`);

    ok(v.n === cardsN, `牌数 = ${cardsN}`, String(v.n));
    ok(v.inStage, '★ 牌桌完整落在舞台内（没被顶出去）');
    okNum(v.board.w, x => x <= w + 1, '牌桌不超出屏宽', v.board.w.toFixed(1) + ' / ' + w);
    okNum(v.board.h, x => x <= v.stage.h + 1, '牌桌不超出舞台高',
       v.board.h.toFixed(1) + ' / 舞台 ' + v.stage.h.toFixed(1));

    /* 牌宽高比 ≈ 2:3 */
    okNum(v.ratio, x => Math.abs(x - 1/0.7) < 0.06, '★ 牌宽高比 ≈ 2:3（扑克牌的样子）', '高/宽 = ' + v.ratio.toFixed(3));

    /* 触屏最小可点尺寸：3/5 张要求 52px，7 张 44px，9 张 36px（牌越多越挤，物理上就这样） */
    const minTap = cardsN <= 5 ? 52 : (cardsN <= 7 ? 44 : 36);
    okNum(v.cardW, x => x >= minTap, `${cardsN} 张：牌宽 ≥ ${minTap}px`, '最窄 ' + v.cardW.toFixed(1) + 'px');
    okNum(v.cardH, x => x >= minTap * 1.2, `${cardsN} 张：牌高 ≥ ${(minTap*1.2).toFixed(0)}px`,
       '最矮 ' + v.cardH.toFixed(1) + 'px');

    okNum(v.pipFs, x => x >= 12, `${cardsN} 张：花色大图标字号 ≥ 12px`, v.pipFs.toFixed(1) + 'px');
    okNum(v.crFs, x => x >= 8, `${cardsN} 张：角标字号 ≥ 8px`, v.crFs.toFixed(1) + 'px');
    okNum(v.gap, x => x >= 6 && x <= 14, `${cardsN} 张：牌间距 6~14px`, v.gap + 'px');
    okNum(v.minOpacity, x => x >= 0.99,
       `${cardsN} 张：★ 每张牌都是不透明的（入场动画不靠 opacity，卡在首帧也不会消失）`,
       '最低 opacity ' + v.minOpacity);

    /* 牌不能溢出牌桌 / 屏幕 */
    okNum(v.cardRightMax, x => x <= v.board.right + 1, `${cardsN} 张：牌没超出牌桌右边`,
       '最右 ' + v.cardRightMax.toFixed(1) + ' / 牌桌右 ' + v.board.right.toFixed(1));
    okNum(v.cardBottomMax, x => x <= v.board.bottom + 1, `${cardsN} 张：牌没超出牌桌下边`,
       '最下 ' + v.cardBottomMax.toFixed(1) + ' / 牌桌下 ' + v.board.bottom.toFixed(1));
    okNum(v.cardLeftMin, x => x >= v.board.left - 1, `${cardsN} 张：牌没超出牌桌左边`,
       '最左 ' + v.cardLeftMin.toFixed(1) + ' / 牌桌左 ' + v.board.left.toFixed(1));
    okNum(v.cardRightMax, x => x <= w + 1, `${cardsN} 张：牌没超出屏宽`, v.cardRightMax.toFixed(1) + ' / ' + w);
    okNum(v.idleBottomMax, x => x <= v.stage.bottom + 1, `${cardsN} 张：idle 摆的牌也在舞台内`,
       v.idleBottomMax.toFixed(1) + ' / 舞台下 ' + v.stage.bottom.toFixed(1));

    /* ★ 阶段切换时牌不能跳：位置一变，玩家刚锁定的记忆就作废了 */
    okNum(v.maxShift, x => x <= 1.5, `${cardsN} 张：★ 看牌 → 提问，牌的位置一点没变`,
       '最大位移 ' + v.maxShift.toFixed(2) + 'px');

    okNum(v.overflowY, x => x <= 1, `${cardsN} 张：整页仍不纵向溢出`, '溢出 ' + v.overflowY + 'px');
    okNum(v.overflowX, x => x <= 1, `${cardsN} 张：整页仍不横向溢出`, '溢出 ' + v.overflowX + 'px');
  }

  /* ---------- ★ 提问阶段牌真的扣着 ---------- */
  section(`${name} ${w}×${h} · 提问时牌是扣着的`);
  const fd = r.facedown || {};
  if(fd.task === 'order'){
    console.log('  （这局抽到顺序题，跳过扣牌检查）');
  } else {
    ok(!!fd.first, '量到了牌的背面');
    if(fd.first){
      ok(/matrix3d|matrix/.test(fd.first.t) && !/^none$/.test(fd.first.t),
         '★ 扣牌时 .inner 有 3D 翻转（' + String(fd.first.t).slice(0, 42) + '…）');
      ok(fd.first.back === 'hidden', '★ 背面 backface-visibility:hidden（翻过去时正面不透视）',
         fd.first.back);
    }
    ok((r.askOpts || []).length === 4, '提问区 4 个选项按钮', String((r.askOpts || []).length));
    ok((r.askText || '').length > 0, '题干有文字（' + r.askText + '）');
  }

  /* ---------- ★ 揭晓才亮金框 ---------- */
  section(`${name} ${w}×${h} · 揭晓标记`);
  const rv = r.reveal;
  if(!rv){
    ok(false, '没找到 suit/point 题来验揭晓');
  } else {
    ok(rv.beforeHasTarget === false, '★ 提问时盘面上没有任何 target 标记（没提前泄露答案）');
    ok(rv.targetIdx === rv.target, '★ 揭晓时标出来的正是被问的那一张',
       '标 idx ' + rv.targetIdx + ' / 问 idx ' + rv.target);
    ok(/rgb|rgba/.test(rv.boxShadow || ''), '★ 目标牌真的画了金色描边（box-shadow: ' +
       String(rv.boxShadow).slice(0, 40) + '…）');
  }

  /* ---------- 顺序题：点选与角标 ---------- */
  section(`${name} ${w}×${h} · 顺序题`);
  const od = r.order;
  if(!od){
    ok(false, '没找到顺序题');
  } else {
    ok(od.picks === 1, '点一张牌 → 记录 1 次（实际 ' + od.picks + '）');
    ok(od.ordCount === 1, '★ 恰好一张牌带序号角标（实际 ' + od.ordCount + '）');
    ok(od.ordText === '1', '★ 角标写的是「1」（实际 ' + od.ordText + '）');
    ok(/已点\s*1/.test(od.tipText || ''), '进度文案跟着更新（' + od.tipText + '）');
    if(od.ordRect && od.cardRect){
      okNum(od.ordRect.w, x => x >= 14, '序号角标够大（≥14px）', od.ordRect.w.toFixed(1) + 'px');
      ok(od.ordRect.left < od.cardRect.right + 6 && od.ordRect.right > od.cardRect.left - 6,
         '角标贴在它自己那张牌的角上（不是跑到别处）');
    }
  }

  /* ---------- 收牌动画真的翻过去了 ---------- */
  section(`${name} ${w}×${h} · 收牌动画`);
  const fp = r.flip || {};
  ok(fp.changed === true, '★ 收牌后 .inner 的 transform 真的变了（不是透明度假动画）',
     String(fp.before).slice(0, 24) + ' → ' + String(fp.after).slice(0, 24));
  ok(fp.downCls === true, '★ 收牌后牌挂上了 .down');

  /* ---------- 结算面板 ---------- */
  section(`${name} ${w}×${h} · 结算面板`);
  const dn = r.done || {};
  ok(dn.phase === 'done', '探针把这一局打完了', String(dn.phase));
  ok(dn.panelShown === true, '★ 演出到点后结算面板弹出', String(dn.panelShown));
  ok(dn.shown === true, '面板真的显示了（.on）');
  ok(dn.showCls === true, '★ 面板挂上了 .show（过渡的终点状态），不是只有 .on 的空壳');
  okNum(dn.opacity, x => x > 0.9, '★ 面板真的不透明（不是只挂了 class 的假显示）', 'opacity=' + dn.opacity);
  ok(/rgba?\(8,\s*10,\s*14/.test(dn.ovBg || '') && !/, 0\)$/.test(dn.ovBg || ''),
     '★ 遮罩真的变暗了（不是透明的）', dn.ovBg);
  if(dn.panel){
    okNum(dn.panel.w, x => x <= w - 8, '面板没超出屏宽', dn.panel.w.toFixed(1) + ' / ' + w);
    okNum(dn.panel.top, x => x >= 0, '面板顶端没出屏', dn.panel.top.toFixed(1));
    okNum(dn.panel.bottom, x => x <= h + 1, '★ 面板底端没出屏', dn.panel.bottom.toFixed(1) + ' / ' + h);
    okNum(dn.panel.h, x => x >= 160, '面板有实际高度（内容没塌）', dn.panel.h.toFixed(1) + 'px');
  } else {
    ok(false, '量不到面板尺寸');
  }
  ok((dn.btns || []).length === 3, '结算面板三个按钮都在（再来一局 / 排行榜 / 看看牌桌）',
     String((dn.btns || []).length));
  if(dn.btns && dn.btns.length === 3){
    const minBH = Math.min(...dn.btns.map(b => b.h));
    okNum(minBH, x => x >= 34, '面板按钮高 ≥ 34px', '最矮 ' + minBH.toFixed(1) + 'px');
    ok(dn.btns.every(b => b.bottom <= (dn.panel ? dn.panel.bottom : h) + 1), '按钮都在面板内部');
  }
  ok(/\d/.test(dn.scoreText || ''), '面板显示了分数（' + dn.scoreText + '）');
  ok((dn.subText || '').length > 0, '面板显示了明细（' + dn.subText + '）');
  ok((dn.recText || '').length > 0, '面板显示了纪录说明（' + dn.recText + '）');
  okNum(dn.overflowY, x => x <= 1, '面板弹出时整页仍不溢出', '溢出 ' + dn.overflowY + 'px');
  okNum(dn.overflowX, x => x <= 1, '面板弹出时仍不横向溢出', '溢出 ' + dn.overflowX + 'px');

  /* ---------- 排行榜面板 ---------- */
  section(`${name} ${w}×${h} · 排行榜面板`);
  const tp = r.top || {};
  ok(tp.shown === true, '★ 排行榜浮层能打开', String(tp.shown));
  if(tp.panel){
    okNum(tp.panel.w, x => x <= w - 8, '排行榜面板没超出屏宽', tp.panel.w.toFixed(1) + ' / ' + w);
    okNum(tp.panel.top, x => x >= 0, '面板顶端没出屏', tp.panel.top.toFixed(1));
    okNum(tp.panel.bottom, x => x <= h + 1, '★ 面板底端没出屏', tp.panel.bottom.toFixed(1) + ' / ' + h);
    okNum(tp.panel.h, x => x >= 200, '面板有实际高度（内容没塌）', tp.panel.h.toFixed(1) + 'px');
  } else {
    ok(false, '量不到排行榜面板尺寸');
  }
  ok(tp.rowCount === 4, '★ 四个难度都在榜里（空榜也不多塞行）', String(tp.rowCount));
  ok(tp.rowH >= 36, '每行高 ≥ 36px（点得着、看得清）', '行高 ' + (tp.rowH || 0).toFixed(1) + 'px');
  ok(tp.rowOverlap === false, '★ 4 行互不重叠');
  okNum(tp.listBottom, x => x <= (tp.panel ? tp.panel.bottom : h) + 1, '列表底边没溢出面板',
     '列表底 ' + tp.listBottom.toFixed(1));
  ok(tp.listScrollH <= tp.listClientH + 1, '★ 4 行全部放得下（不用滚动）',
     'scrollH=' + tp.listScrollH + ' clientH=' + tp.listClientH);
  ok((tp.btns || []).length === 2, '面板两个按钮都在', String((tp.btns || []).length));
  if(tp.btns && tp.btns.length === 2){
    const minBH = Math.min(...tp.btns.map(b => b.h));
    okNum(minBH, x => x >= 34, '排行榜按钮高 ≥ 34px', '最矮 ' + minBH.toFixed(1) + 'px');
  }
  okNum(tp.overflowY, x => x <= 1, '排行榜打开时整页仍不纵向溢出', '溢出 ' + tp.overflowY + 'px');
  okNum(tp.overflowX, x => x <= 1, '排行榜打开时仍不横向溢出', '溢出 ' + tp.overflowX + 'px');

  /* ---------- 特效画布不吃点击 ---------- */
  section(`${name} ${w}×${h} · 特效画布`);
  ok(v1.fxPE === 'none', '★ 画布不吃点击（pointer-events:none）—— 不会挡住下面的按钮', v1.fxPE);
  okNum(parseInt(v1.fxZ, 10), x => x >= 0, '画布有层级', String(v1.fxZ));
}

console.log('\n' + '='.repeat(52));
if(fail === 0) console.log(`全部通过：${pass} 项（${results.length} 个视口）`);
else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
