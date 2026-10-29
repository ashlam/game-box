#!/usr/bin/env node
/**
 * 数字华容道（滑块拼图 / 15-puzzle）逻辑回归测试
 *
 * 覆盖：
 *   1) 开局：N²-1 块 + 1 个空格，数字恰好是 1..N²-1，默认 3×3
 *   2) ★ 打乱后**一定是可解的**（逆序数判据）—— 用随机排列打乱会有一半无解，
 *      玩家会玩到怀疑人生，这个坑必须用测试钉住
 *   3) 打乱后不是已完成状态，且确实够乱（曼哈顿距离）
 *   4) 移动：相邻点击、整行 / 整列一推多块、不同行列点了没反应
 *   5) 步数：每滑一格算 1 步（推一排 3 格 = 3 步）
 *   6) ★ 计时：第一次有效移动才走表；无效点击不启动
 *   7) 胜利：排好后 done、面板延迟约 0.9 秒弹出、记录落盘
 *   8) 记录：更少步数 / 更快用时才刷新，变慢不覆盖
 *   9) 尺寸切换：3/4/5 各档，选择记进 localStorage
 *  10) 长跑 2000 步随机走：不变量（排列合法、空格唯一、步数单调）
 *  11) 布局：棋盘正方形、边长取舞台短边
 *  12) 看目标层、音效开关、单文件自包含（无外链 / 无图片）
 *
 * 用法：node tools/test_slidepuzzle.js [web/slidepuzzle/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'slidepuzzle', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 假 DOM / 假音频 ================= */
function mkStyle(){
  const p = {};
  return {
    _p: p,
    setProperty(k, v){ p[k] = String(v); },
    getPropertyValue(k){ return (k in p) ? p[k] : ''; },
  };
}
function mkEl(tag){
  const handlers = {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: mkStyle(), dataset: {}, textContent: '', _cls: '', _html: '',
    children: [], clientWidth: 390, clientHeight: 600, width: 0, height: 0, offsetWidth: 0,
    addEventListener(type, fn){ (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(){},
    fire(type, ev){ (handlers[type] || []).forEach(fn => fn(ev || {})); },
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    removeChild(c){ const i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); return c; },
    getBoundingClientRect(){
      return { left:0, top:0, width:this.clientWidth, height:this.clientHeight,
               right:this.clientWidth, bottom:this.clientHeight };
    },
    setAttribute() {}, focus() {}, blur() {},
    querySelectorAll(sel){
      const byClass = sel[0] === '.';
      const want = byClass ? sel.slice(1) : sel.toUpperCase();
      const out = [];
      (function walk(n){
        n.children.forEach(c => {
          const hit = byClass ? (c.classList && c.classList.contains(want)) : (c.tagName === want);
          if(hit) out.push(c);
          walk(c);
        });
      })(el);
      return out;
    },
  };
  Object.defineProperty(el, 'firstChild', { get(){ return el.children[0] || null; } });
  const list = () => el._cls.split(/\s+/).filter(Boolean);
  el.classList = {
    add(...cs){ const s = new Set(list()); cs.forEach(c => s.add(c)); el._cls = [...s].join(' '); },
    remove(...cs){ const s = new Set(list()); cs.forEach(c => s.delete(c)); el._cls = [...s].join(' '); },
    contains: c => list().indexOf(c) >= 0,
    toggle(c, on){
      const has = list().indexOf(c) >= 0;
      const want = (on === undefined) ? !has : !!on;
      if(want) el.classList.add(c); else el.classList.remove(c);
      return want;
    },
  };
  Object.defineProperty(el, 'className', {
    get(){ return el._cls; },
    set(v){ el._cls = String(v || ''); },
  });
  return el;
}

let toneStarts = 0;
class FakeCtx {
  constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
  createOscillator(){
    return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} },
             connect(){}, start(){ toneStarts++; }, stop(){} };
  }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, value:0 }, connect(){} }; }
  resume(){ this.state = 'running'; return Promise.resolve(); }
}

/** 造一个独立实例（各实例共享 store 就能测「重启后记录还在」） */
function makeVM(store, clock){
  const els = {};

  const sizes = mkEl('div');
  [3, 4, 5].forEach(n => { const b = mkEl('button'); b.dataset.n = String(n); b.textContent = n + '×' + n; sizes.appendChild(b); });
  els.sizes = sizes;

  const board = mkEl('div');   els.board = board;
  const ghost = mkEl('div');   els.ghost = ghost;  board.appendChild(ghost);
  const wrap = mkEl('div');    els.wrap = wrap;    wrap.clientWidth = 390; wrap.clientHeight = 600;

  const doc = {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl,
    addEventListener() {}, removeEventListener() {},
    documentElement: { scrollHeight: 800 }, body: mkEl('body'),
    querySelector: () => null,
  };

  const sandbox = {
    console,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if(t.unref) t.unref(); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); if(t.unref) t.unref(); return t; },
    clearInterval,
    Date: class extends Date { static now(){ return clock.now; } },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    document: doc,
    navigator: { userAgent: 'node-test' },
    location: { search: '', host: 'test' },
    AudioContext: FakeCtx,
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  sandbox.innerWidth = 390;
  sandbox.innerHeight = 844;
  sandbox.devicePixelRatio = 3;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'gslide-inline.js' });
  sandbox.__els = els;
  return sandbox;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clock = { now: 1000000 };
const store = {};
const sb = makeVM(store, clock);
const win = sb.window;
const els = sb.__els;

const S = () => win.__gs();
const isPerm = arr => {
  const n = arr.length;
  const seen = new Set(arr);
  if(seen.size !== n) return false;
  for(const v of arr) if(!(Number.isInteger(v) && v >= 0 && v < n)) return false;
  return arr.filter(x => x === 0).length === 1;
};
/** 逆序数（不含 0） */
function inversions(arr){
  const a = arr.filter(x => x > 0);
  let inv = 0;
  for(let i = 0; i < a.length; i++) for(let j = i + 1; j < a.length; j++) if(a[i] > a[j]) inv++;
  return inv;
}
/** 标准可解判据：奇数阶看逆序数奇偶；偶数阶还要看空格所在行（从底部数，1 起） */
function solvable(vals, N){
  const inv = inversions(vals);
  if(N % 2 === 1) return inv % 2 === 0;
  const emptyIdx = vals.indexOf(0);
  const rowFromBottom = N - Math.floor(emptyIdx / N);   // 底行 = 1
  return (inv + rowFromBottom) % 2 === 1;
}

/* ================= 1) 开局 ================= */
section('1) 开局');
{
  const s = S();
  ok(s.N === 3, '默认 3×3（给小孩的第一档，实际 ' + s.N + '）');
  ok(s.tileCount === 8, '8 个方块（实际 ' + s.tileCount + '）');
  ok(isPerm(s.vals), 'vals 是 1..N²-1 + 一个空格的合法排列');
  ok(!s.solved, '开局不是已完成状态');
  ok(s.moves === 0, '步数从 0 开始');
  ok(s.t0 === 0 && s.running === false, '计时还没开始（第一次移动才走表）');
  const zeroAt = s.vals.indexOf(0);
  ok(s.empty.r === Math.floor(zeroAt / s.N) && s.empty.c === zeroAt % s.N,
     '空格坐标与数组里 0 的位置一致');

  win.__gsNew(4, 7);
  ok(S().N === 4 && S().tileCount === 15, '4×4 有 15 个方块');
  win.__gsNew(5, 7);
  ok(S().N === 5 && S().tileCount === 24, '5×5 有 24 个方块');
  win.__gsNew(3, 7);
}

/* ================= 2) ★ 打乱必须可解 ================= */
section('2) ★ 打乱一定可解（逆序数判据）');
{
  /* 先给判据本身做个校准：已完成局面必须判为可解 */
  ok(solvable([1,2,3,4,5,6,7,8,0], 3), '判据校准：3×3 完成态 → 可解');
  ok(solvable([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,0], 4), '判据校准：4×4 完成态 → 可解');
  /* 再拿一个人为造的无解局面校准（4×4 里把 14/15 对调） */
  ok(!solvable([1,2,3,4,5,6,7,8,9,10,11,12,13,15,14,0], 4),
     '判据校准：4×4 里 14/15 对调 → 无解');

  let bad = [];
  for(const N of [3, 4, 5]){
    for(let seed = 1; seed <= 60; seed++){
      win.__gsNew(N, seed * 7919);
      const s = S();
      if(!solvable(s.vals, N)) bad.push(N + '×' + N + ' seed=' + seed);
    }
  }
  ok(bad.length === 0, '★ 3/4/5 阶各 60 个种子，全部可解', bad.slice(0, 4).join('；'));
}

/* ================= 3) 打乱的「乱度」 ================= */
section('3) 打乱够乱');
{
  let solvedCount = 0, minM = Infinity;
  for(let seed = 1; seed <= 40; seed++){
    win.__gsNew(4, seed * 3571);
    const s = S();
    if(s.solved) solvedCount++;
    minM = Math.min(minM, s.manhattan);
  }
  ok(solvedCount === 0, '★ 打乱后从来不是「已经拼好」的样子', solvedCount + ' 局是完成态');
  ok(minM >= 4, '曼哈顿距离至少有 ' + minM + '（不会只挪了一两格）');

  /* 同种子 → 同局面（否则「看起来一样但复现不了」的 bug 没法查） */
  win.__gsNew(4, 12345);
  const a = S().vals.join(',');
  win.__gsNew(4, 12345);
  const b = S().vals.join(',');
  ok(a === b, '同种子得到同一局面');
  win.__gsNew(4, 999);
  ok(S().vals.join(',') !== a, '不同种子局面不同');
}

/* ================= 4) 移动规则 ================= */
section('4) 移动规则');
{
  win.__gsNew(3, 1);
  /* 人工摆一个干净的局面（空格在右下）：
       1 2 3
       4 5 6
       7 _ 8   */
  win.__gsSet([1,2,3,4,5,6,7,0,8]);
  ok(S().empty.r === 2 && S().empty.c === 1, '注入局面后空格在 (2,1)');

  /* 不相邻：既不同行也不同列 → 不动 */
  const r0 = win.__gsMove(0, 0);
  ok(r0 === 0, '点对角位置的块不生效（返回 0）');
  ok(S().moves === 0, '无效点击不加步数');

  /* 相邻（同行）：8 从 (2,2) 滑进空格 */
  const r1 = win.__gsMove(2, 2);
  ok(r1 === 1, '点空格旁边的块返回 1');
  ok(S().vals.join(',') === '1,2,3,4,5,6,7,8,0', '8 滑进空格，空格移到 (2,2)');
  ok(S().empty.r === 2 && S().empty.c === 2, '空格坐标跟着走');
  ok(S().moves === 1, '步数 +1');
  ok(S().solved, '这一下拼好了');

  /* 整行推：空格在 (2,2)，点 (2,0) → 7、8 一起向右滑两格 */
  win.__gsSet([1,2,3,4,5,6,0,7,8]);
  ok(S().empty.c === 0, '先把空格摆到 (2,0)');
  const r2 = win.__gsMove(2, 2);
  ok(r2 === 2, '点同一行更远的块，中间那排一起滑（移动 ' + r2 + ' 块）');
  ok(S().vals.join(',') === '1,2,3,4,5,6,7,8,0', '整排右移一格半，顺序不乱');
  ok(S().moves === 2, '★ 推 2 格算 2 步（不是 1 步）');

  /* 整列推：完成态空格在右下 (2,2)，点最上面的 3 → 3、6 一起下移 */
  win.__gsSet([1,2,3,4,5,6,7,8,0]);
  ok(S().empty.r === 2 && S().empty.c === 2, '空格在右下角 (2,2)');
  const r3 = win.__gsMove(0, 2);
  ok(r3 === 2, '点同一列最远的块，整列一起滑（移动 ' + r3 + ' 块）');
  ok(S().vals.join(',') === '1,2,0,4,5,3,7,8,6', '整列下移一格，块之间的先后顺序没乱');
  ok(S().moves === 2, '列方向也是每滑一格算 1 步');

  /* 反方向也要对（块在空格的左边 / 上边） */
  win.__gsSet([1,2,3,4,5,6,7,8,0]);       // 空格在 (2,2)
  win.__gsMove(2, 1);                     // 8 右移
  ok(S().vals.join(',') === '1,2,3,4,5,6,7,0,8', '块在空格左侧时向右推');
}

/* ================= 5) 计时 ================= */
section('5) 计时从第一次有效移动开始');
{
  win.__gsNew(3, 3);
  ok(S().running === false && S().t0 === 0, '开局没走表');
  /* 找一对不相邻的格子点一下，确认不会误启动 */
  const s0 = S();
  let pr = -1, pc = -1;
  for(let r = 0; r < 3 && pr < 0; r++) for(let c = 0; c < 3; c++){
    if(r !== s0.empty.r && c !== s0.empty.c){ pr = r; pc = c; break; }
  }
  ok(win.__gsMove(pr, pc) === 0, '先点一个不同行不同列的块（无效）');
  ok(S().running === false && S().t0 === 0, '★ 无效点击不会启动计时');

  win.__gsMove(s0.empty.r + (s0.empty.r > 0 ? -1 : 1), s0.empty.c);
  ok(S().t0 > 0 && S().running === true, '★ 第一次有效移动才开始走表');

  clock.now += 5000;
  win.__gsTick(clock.now - S().t0);
  ok(S().elapsed === 5000, '计时能正确累计（5 秒）');
}

/* ================= 6) 胜利 / 记录 ================= */
section('6) 胜利结算与记录');
(async () => {
  /** 「玩了一会儿再拼完」：先走一步让表走起来，推进时钟，再摆到只差一步收尾 */
  function finishAfter(sec, seed, n){
    n = n || 3;
    const last = (n === 3) ? [1,2,3,4,5,6,7,0,8]
                           : [1,2,3,4,5,6,7,8,9,10,11,12,13,14,0,15];
    win.__gsNew(n, seed);
    win.__gsSet(last);
    const st = S();
    win.__gsMove(st.empty.r - 1, st.empty.c);      // 启动计时（空格上一格）
    clock.now += sec * 1000;
    win.__gsSet(last, true);                       // 摆回只差一步，表继续走
    win.__gsMove(n - 1, n - 1);                    // 最后一格归位
    return S();
  }

  /* 先清掉可能留下的记录，让本段从零开始 */
  delete store['gslide_best_v1'];
  const s = finishAfter(12, 5, 3);
  ok(s.done === true, '拼好后 done = true');
  ok(s.elapsed === 12000, '用时定格在 12 秒（' + s.elapsed + 'ms）');
  ok(s.best['3'] && s.best['3'].moves === 1, '首次通关记下最少步数 1（' + JSON.stringify(s.best['3']) + '）');
  ok(s.best['3'] && s.best['3'].time === 12000, '首次通关记下最快用时');
  ok(JSON.parse(store['gslide_best_v1'])['3'].moves === 1, '记录写进了 localStorage');

  await sleep(950);
  ok(els.over.classList.contains('on'), '面板延迟约 0.9 秒才弹（先看金闪）');
  ok(els.overMoves.textContent === '1', '面板显示本局步数');
  ok(els.overTime.textContent === '0:12', '面板显示用时 0:12（实际 ' + els.overTime.textContent + '）');

  /* 变慢不覆盖 */
  const slow = finishAfter(60, 6, 3);
  ok(slow.best['3'].time === 12000, '★ 更慢的一局不会覆盖最快记录（' + slow.elapsed + 'ms）');
  ok(slow.best['3'].moves === 1, '步数相同也不覆盖');

  /* 更快才刷新 */
  const fast = finishAfter(3, 7, 3);
  ok(fast.best['3'].time === 3000, '★ 更快的一局刷新最快记录');

  /* 不同尺寸分开记 */
  const s4 = finishAfter(9, 8, 4);
  ok(s4.done === true, '4×4 也能正确判胜');
  ok(s4.best['4'] && s4.best['4'].moves === 1, '4×4 的记录单独存，不串档');
  ok(s4.best['3'].time === 3000, '★ 打通 4×4 不会动到 3×3 的记录');

  /* 重启后记录还在（同一份 store 建新实例） */
  const sb2 = makeVM(store, clock);
  const s2 = sb2.window.__gs();
  ok(s2.best['3'] && s2.best['3'].time === 3000, '★ 重开页面（新实例）记录还在');
  ok(s2.N === 4, '上次选的尺寸也被记住了（4×4）');

  /* ================= 7) 长跑不变量 ================= */
  section('7) 长跑 2000 步随机走');
  {
    win.__gsNew(4, 424242);
    let bad = 0, lastMoves = 0, mono = true, solvs = 0;
    for(let i = 0; i < 2000; i++){
      const st = S();
      if(!isPerm(st.vals)) bad++;
      if(st.vals.indexOf(0) !== st.empty.r * st.N + st.empty.c) bad++;
      const tgt = Math.random() < 0.5
        ? [st.empty.r, Math.floor(Math.random() * 4)]
        : [Math.floor(Math.random() * 4), st.empty.c];
      const before = st.moves;
      win.__gsMove(tgt[0], tgt[1]);
      if(S().moves < before) mono = false;
      if(S().solved) solvs++;
    }
    ok(bad === 0, '★ 2000 次随机移动后局面始终合法（不重块、空格唯一）', bad + ' 次异常');
    ok(mono, '步数只增不减');
    lastMoves = S().moves;
    ok(lastMoves > 500, '确实走了很多步（' + lastMoves + ' 步）');
  }

  /* ================= 8) 尺寸切换 / 看目标 / 音效 ================= */
  section('8) 尺寸切换、看目标、音效');
  {
    win.__gsNew(3, 11);
    els.sizes.fire('click', { target: els.sizes.children[2], preventDefault(){} });
    ok(S().N === 5, '点「5×5」切到 5 阶');
    ok(store['gslide_n'] === '5', '尺寸记进 localStorage');
    ok(els.sizes.children[2].classList.contains('on'), '被选中的尺寸按钮高亮');
    ok(els.sizes.children[0].classList.contains('on') === false, '别的按钮不再高亮');

    els.btnPeek.fire('click');
    ok(els.ghost.classList.contains('on'), '点「看目标」显示目标虚线层');
    ok(els.ghost.children.length === 24, '目标层里是 24 个格（5×5）');

    const before = toneStarts;
    els.btnSound.fire('click');
    ok(store['gslide_sound'] === '0', '关音效会写进 localStorage');
    ok(els.btnSound.textContent === '🔇', '按钮图标变成静音');
    const mid = toneStarts;
    win.__gsNew(3, 12);
    win.__gsMove(S().empty.r === 0 ? 1 : 0, S().empty.c);   // 有效移动，本该发声
    ok(toneStarts === mid, '★ 关掉音效后移动完全不出声');
    els.btnSound.fire('click');
    ok(store['gslide_sound'] === '1' && mid >= before, '再点一下能开回来');
  }

  /* ================= 9) 布局 ================= */
  section('9) 布局');
  {
    win.__gsNew(4, 13);
    const s = S();
    const w = parseFloat(s.boardW);
    ok(/px$/.test(s.boardW), '棋盘宽度是像素值（' + s.boardW + '）');
    ok(Math.abs(w - 390) < 1, '边长取舞台短边（390）');
    ok(Math.abs(parseFloat(s.cell) - 390 / 4) < 0.5, '--cell = 边长/阶数');

    els.wrap.clientHeight = 300;             // 矮屏：高度成短板
    win.__gsNew(4, 14);
    ok(Math.abs(parseFloat(S().boardW) - 300) < 1, '★ 矮屏时按高度收，不会溢出屏幕');
  }

  /* ================= 10) 单文件自包含 ================= */
  section('10) 单文件、可离线');
  {
    ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链');
    ok(!/<link\b/i.test(html), '没有外部样式表');
    ok(!/<img\b/i.test(html), '没有图片');
    ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
    ok(/href="\/"/.test(html), '返回键指向站点根（离线包会改写成 ../index.html）');
    ok(/<meta name="viewport"/.test(html), '有 viewport');
    ok(/gslide_best_v1/.test(html), '存档键固定（改名会丢玩家记录）');
  }

  console.log('\n' + '='.repeat(60));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
