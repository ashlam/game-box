#!/usr/bin/env node
/**
 * 汉诺塔（Tower of Hanoi）逻辑回归测试
 *
 * 覆盖：
 *   1) 开局：N 个盘全在最左柱、底大顶小、步数 0、计时未启动、理论最少步数 2^N-1
 *   2) 拿起 / 取消：点柱浮起、点回原柱放回，都不算步
 *   3) 合法搬盘：步数 +1、盘真的换了柱、第一次有效移动才走表
 *   4) 非法搬盘：大盘压小盘被拒、步数不变、盘不动、空柱拿不起来
 *   5) ★ 求解器：任意合法局面 → 执行解后全部归位，且步数 ≤ 2^N-1、每步都合法
 *   6) 胜利：全部到最右柱 → done、结算面板、记录落盘；星级按超步数分档
 *   7) 记录：更少步数 / 更快用时才刷新；演示局（assisted）不记
 *   8) 撤销：回退一步、步数 -1、撤销栈空时给提示
 *   9) 提示：算出剩余步数、不动棋盘
 *  10) 演示：从任意局面自动走完 → 全部到右柱、标记 assisted、不记成绩
 *  11) 盘数 3~8：理论最少步数、盘宽随盘号单调递增、大盘比小盘宽
 *  12) 单文件自包含（无外链 / 无图片 / 无外部脚本）
 *
 * 用法：node tools/test_hanoi.js [web/hanoi/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'hanoi', 'index.html');
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
    title: '',
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
    querySelector(sel){ return this.querySelectorAll(sel)[0] || null; },
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
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){ el._html = String(v); if(v === '') el.children.length = 0; },
  });
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
  [3, 4, 5, 6, 7, 8].forEach(n => { const b = mkEl('button'); b.dataset.n = String(n); b.textContent = String(n); sizes.appendChild(b); });
  els.sizes = sizes;

  const board = mkEl('div');   els.board = board;
  const stage = mkEl('div');   els.stage = stage;  stage.clientWidth = 390; stage.clientHeight = 600;
  stage.appendChild(board);

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
  vm.runInContext(script, sandbox, { filename: 'ghanoi-inline.js' });
  sandbox.__els = els;
  return sandbox;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clock = { now: 1000000 };
const store = {};
const sb = makeVM(store, clock);
const win = sb.window;
const els = sb.__els;

const S = () => win.__hn();
/** 合法局面吗：每根柱从下到上严格递减，且盘号是 1..n 的一个排列 */
function legal(pegs, n){
  const all = [];
  for(const p of pegs){
    for(let i = 1; i < p.length; i++) if(p[i] >= p[i - 1]) return false;
    all.push(...p);
  }
  if(all.length !== n) return false;
  all.sort((a, b) => a - b);
  for(let i = 0; i < n; i++) if(all[i] !== i + 1) return false;
  return true;
}

(async () => {

/* ================= 1) 开局 ================= */
section('1) 开局');
{
  const s = S();
  ok(s.N === 4, '默认 4 个盘（给小孩的第一档，实际 ' + s.N + '）');
  ok(s.pegs[0].length === 4 && s.pegs[1].length === 0 && s.pegs[2].length === 0, '4 个盘全在最左柱');
  ok(s.pegs[0].join(',') === '4,3,2,1', '底大顶小（数组是 底→顶）：' + s.pegs[0].join(','));
  ok(s.moves === 0 && s.t0 === 0, '步数 0、计时未启动');
  ok(s.opt === 15, '理论最少步数 2^4-1 = 15（实际 ' + s.opt + '）');
  ok(s.held === null && s.done === false, '没拿盘、没结束');
  ok(s.history === 0, '撤销栈是空的');
}

/* ================= 2) 拿起 / 取消 ================= */
section('2) 拿起与取消（不算步）');
{
  win.__hnNew(4);
  ok(win.__hnTap(0) === true, '点左柱 → 拿起了顶上那个盘');
  ok(S().held && S().held.disk === 1 && S().held.peg === 0, '手上是 1 号盘（最小的那个）');
  ok(S().towerSel[0] === true, '被拿的那根柱高亮');
  ok(S().moves === 0, '拿起不算一步');

  win.__hnTap(0);                          // 点回原柱
  ok(S().held === null, '点回原柱 → 盘放回去了');
  ok(S().moves === 0, '放回去也不算步');
  ok(S().pegs[0].join(',') === '4,3,2,1', '左柱恢复原样');

  ok(win.__hnTap(1) === false, '点空柱拿不起东西');
  ok(S().held === null && S().moves === 0, '空柱点了什么都没发生');
}

/* ================= 3) 合法搬盘 ================= */
section('3) 合法搬盘');
{
  win.__hnNew(4);
  win.__hnTap(0); win.__hnTap(1);
  ok(S().pegs[1].join(',') === '1' && S().pegs[0].length === 3, '1 号盘从左柱搬到中间');
  ok(S().moves === 1, '步数 +1');
  ok(S().history === 1, '记进撤销栈');
  ok(S().t0 !== 0, '第一次有效移动开始走表');

  /* 计时：推时钟看 elapsed 会不会跟着走 */
  clock.now += 5000;
  await sleep(320);
  ok(S().elapsed >= 5000, '走了 5 秒，用时跟着涨（实际 ' + S().elapsed + 'ms）');
  ok(els.stTime.textContent !== '0:00', 'HUD 上的用时也更新了：' + els.stTime.textContent);
}

/* ================= 4) 非法搬盘 ================= */
section('4) 非法搬盘');
{
  win.__hnNew(4);
  win.__hnTap(0); win.__hnTap(1);       // 1 号盘 → 中
  win.__hnTap(0); win.__hnTap(2);       // 2 号盘 → 右
  win.__hnTap(1); win.__hnTap(2);       // 1 号盘 → 右（压在 2 上）
  ok(S().pegs[2].join(',') === '2,1', '右柱摞成 2,1（底大顶小）');
  const before = JSON.stringify(S().pegs);
  /* 左柱顶是 3 号盘，右柱顶是 1 号盘 → 3 压 1 必须被拒 */
  win.__hnTap(0);
  const r = win.__hnTap(2);
  ok(r === false, '3 号盘压 1 号盘 → 拒绝');
  ok(JSON.stringify(S().pegs) === before, '棋盘一点没变');
  ok(S().moves === 3, '步数没变（还是 3）');
  ok(S().held && S().held.disk === 3, '★ 盘还在手上 —— 玩家可以改放别的柱，不用从头再拿');
  ok(/不能压在/.test(win.__hnToast()), '有说清为什么的提示：' + win.__hnToast());
  win.__hnTap(1);
  ok(S().pegs[1].join(',') === '3', '改放空的中柱成功');
  ok(S().held === null, '放下后手上空了');
  ok(S().moves === 4, '这一下才计步（4）');
}

/* ================= 5) ★ 求解器 ================= */
section('5) ★ 求解器（任意局面 → 最右柱，且步数最优）');
{
  /* 校准：已经在家的局面不需要走 */
  ok(win.__hnSolveFrom([[],[],[3,2,1]], 2).length === 0, '全部在最右柱 → 0 步');
  /* 教科书序列：3 个盘从左到右 = 7 步，且第一步是「1 号 左→右」 */
  const s3 = win.__hnSolveFrom([[3,2,1],[],[]], 2);
  ok(s3.length === 7, '3 个盘最少 7 步（实际 ' + s3.length + '）');
  ok(s3[0].join('>') === '0>2', '第一步是 1 号盘 左→右（实际 ' + s3[0].join('>') + '）');

  /* 随机局面走一遍：每个中间状态都必须合法，最终全在右柱 */
  let bad = null, overOpt = 0;
  for(let n = 3; n <= 6 && !bad; n++){
    for(let trial = 0; trial < 40 && !bad; trial++){
      win.__hnNew(n);
      /* 先随机走 k 步（合法步），造一个任意局面 */
      const steps = Math.floor(Math.random() * (n * n + 6));
      for(let i = 0; i < steps; i++){
        const cand = [];
        for(let a = 0; a < 3; a++) for(let b = 0; b < 3; b++) if(win.__hnCanMove(a, b)) cand.push([a, b]);
        if(!cand.length) break;
        const mv = cand[Math.floor(Math.random() * cand.length)];
        win.__hnApply(mv[0], mv[1]);
      }
      const before = S();
      if(before.done) continue;

      const seq = win.__hnSolve(2);
      const st = [before.pegs[0].slice(), before.pegs[1].slice(), before.pegs[2].slice()];
      for(const [a, b] of seq){
        const top = st[a][st[a].length - 1];
        if(top === undefined){ bad = 'n=' + n + ' 从空柱搬'; break; }
        if(st[b].length && st[b][st[b].length - 1] < top){ bad = 'n=' + n + ' 大盘压小盘'; break; }
        st[a].pop(); st[b].push(top);
      }
      if(bad) break;
      if(st[2].length !== n){ bad = 'n=' + n + ' 没搬完（' + st[2].length + '/' + n + '）'; break; }
      if(!legal(st, n)){ bad = 'n=' + n + ' 结果不是合法局面'; break; }
      if(seq.length > (1 << n) - 1) overOpt++;
    }
  }
  ok(bad === null, '★ 4 种盘数 × 40 个随机局面：解执行后全部归位且每步合法', bad || '');
  ok(overOpt === 0, '★ 解从来不超过 2^N-1 步（超过就是走了冤枉路）', overOpt + ' 局超了');

  /* 乱序局面也要给「不多走」的解：3 在左、1/2 摞在中柱。
     最优是 4 步（3 直接搬空右柱 → 再把 1、2 依次搬过去），不是教科书那条 7 步路线 */
  const weird = [[3],[2,1],[]];
  const sw = win.__hnSolveFrom(weird, 2);
  ok(sw.length === 4, '怪局面 [3] [2,1] [] → 4 步（实际 ' + sw.length + '）');
  ok(sw[0].join('>') === '0>2', '第一步先把 3 号盘搬到空右柱');
  const st = [[3],[2,1],[]];
  for(const [a, b] of sw){ const t = st[a].pop(); st[b].push(t); }
  ok(st[2].join(',') === '3,2,1', '这个解确实能走完：' + st[2].join(','));
}

/* ================= 6) 胜利 ================= */
section('6) 胜利与记录');
{
  win.__hnNew(3);
  clock.now = 2000000;
  const seq = win.__hnSolve(2);
  for(const [a, b] of seq){ win.__hnTap(a); win.__hnTap(b); clock.now += 900; await sleep(280); }
  await sleep(300);
  const s = S();
  ok(s.pegs[2].join(',') === '3,2,1', '3 个盘全到最右柱');
  ok(s.done === true, '判定为完成');
  ok(s.moves === 7, '走了 7 步（= 理论最少）');
  ok(s.stars === 3, '一步没多走 → 3 星');
  await sleep(600);
  ok(win.__hnOver() === true, '结算面板弹出来了');
  ok(els.overStars.children.length === 3, '面板上是 3 颗星');
  ok(/理论最少步数/.test(els.overNote.innerHTML), '面板说明：这是理论最少步数');

  const rec = JSON.parse(store.ghanoi_best_v1 || '{}');
  ok(rec['3'] && rec['3'].moves === 7, '最佳步数落盘：' + (rec['3'] && rec['3'].moves));
  ok(rec['3'] && rec['3'].time > 0, '最快用时落盘：' + (rec['3'] && rec['3'].time) + 'ms');
  ok(rec['3'].stars === 3, '记录里存了 3 星');
}

/* ================= 7) 记录刷新规则 ================= */
section('7) 记录只往好的方向刷新');
{
  const before = JSON.parse(store.ghanoi_best_v1)['4'];
  win.__hnNew(4);
  clock.now = 3000000;
  /* 先来回走两趟（净结果是 0 变化，但步数白花 2 步），再走最优解 → 17 步 */
  win.__hnTap(0); win.__hnTap(1); clock.now += 900; await sleep(280);
  win.__hnTap(1); win.__hnTap(0); clock.now += 900; await sleep(280);
  const seq = win.__hnSolve(2);
  for(const [a, b] of seq){ win.__hnTap(a); win.__hnTap(b); clock.now += 900; await sleep(280); }
  await sleep(900);
  const after = JSON.parse(store.ghanoi_best_v1)['4'];
  ok(after.moves === 17, '多走 2 步 → 17 步完成（实际 ' + after.moves + '）');
  ok(before === undefined, '4 个盘之前没有记录（首次通关才创建）');

  /* 再来一局，走得更慢更多步 → 记录不该被冲掉 */
  const prev = JSON.parse(JSON.stringify(after));
  win.__hnNew(4);
  clock.now += 999000;
  for(let i = 0; i < 3; i++){                     // 白走 6 步
    win.__hnTap(0); win.__hnTap(1); clock.now += 900; await sleep(280);
    win.__hnTap(1); win.__hnTap(0); clock.now += 900; await sleep(280);
  }
  const seq2 = win.__hnSolve(2);
  for(const [a, b] of seq2){ win.__hnTap(a); win.__hnTap(b); clock.now += 900; await sleep(280); }
  await sleep(900);
  const now = JSON.parse(store.ghanoi_best_v1)['4'];
  ok(S().moves === 21, '第二局走了 21 步（比 17 多）');
  ok(now.moves === prev.moves, '步数变多了，最佳步数记录没被更差的成绩覆盖');
  ok(now.time === prev.time, '用时变长了，最快用时记录没被覆盖');
}

/* ================= 8) 撤销 ================= */
section('8) 撤销');
{
  win.__hnNew(4);
  win.__hnUndo();
  ok(/还没走过/.test(win.__hnToast()), '开局按撤销 → 提示还没走过一步');

  win.__hnTap(0); win.__hnTap(1); await sleep(280);
  ok(S().moves === 1 && S().pegs[1].join(',') === '1', '走了一步');
  win.__hnUndo(); await sleep(280);
  ok(S().pegs[1].length === 0 && S().pegs[0].join(',') === '4,3,2,1', '撤销后盘回到原处');
  ok(S().moves === 0, '步数 -1');
  ok(S().history === 0, '撤销栈空了');
  win.__hnUndo();
  ok(/还没走过/.test(win.__hnToast()), '再撤销 → 还是提示没走过');
}

/* ================= 9) 提示 ================= */
section('9) 提示');
{
  win.__hnNew(4);
  win.__hnTap(0); win.__hnTap(1); await sleep(280);
  const before = JSON.stringify(S().pegs);
  win.__hnHint();
  const msg = win.__hnToast();
  ok(JSON.stringify(S().pegs) === before, '提示不动棋盘');
  ok(/还需 14 步/.test(msg), '说清还剩多少步：' + msg);
  ok(/先把 2 号盘搬到/.test(msg), '说清下一步该搬哪个盘：' + msg);
  win.__hnTap(1);          // 清掉拿起状态
}

/* ================= 10) 演示 ================= */
section('10) 演示');
{
  win.__hnNew(3);
  win.__hnDemo();
  ok(S().demo === true, '演示中（按钮变成停止）');
  ok(S().assisted === true, '★ 一开演示就标记 assisted —— 这局不能算成绩');
  await sleep(2400);
  const s = S();
  ok(s.demo === false, '演示自己停了');
  ok(s.pegs[2].join(',') === '3,2,1', '演示把 3 个盘全搬到了最右柱');
  await sleep(900);
  ok(JSON.parse(store.ghanoi_best_v1)['3'].moves === 7, '演示没有覆盖已有记录（' + JSON.parse(store.ghanoi_best_v1)['3'].moves + ' 步）');
  ok(/演示/.test(els.overSub.textContent), '结算上标明这是演示局：' + els.overSub.textContent);

  /* 中途停：位置必须归位（不能有盘悬空） */
  win.__hnNew(5);
  win.__hnDemo();
  await sleep(300);
  win.__hnStopDemo();
  const s2 = S();
  ok(s2.demo === false, '点「停止」→ 演示停下');
  ok(legal(s2.pegs, 5), '停下时局面仍合法（没有悬空 / 重影的盘）', JSON.stringify(s2.pegs));
}

/* ================= 11) 盘数 3~8 ================= */
section('11) 盘数 3~8');
{
  const optTable = [];
  for(let n = 3; n <= 8; n++){
    win.__hnNew(n);
    const s = S();
    optTable.push(n + ':' + s.opt);
    const d = s.diskW;
    /* 盘宽必须严格随盘号递增：孩子靠宽度认大小 */
    let mono = true, gaps = [];
    for(let k = 2; k <= n; k++){
      if(!(d[k] > d[k - 1])) mono = false;
      gaps.push(d[k] - d[k - 1]);
    }
    ok(mono, n + ' 个盘：盘宽随盘号严格递增（' + n + ' 号 ' + d[n] + 'px > 1 号 ' + d[1] + 'px）');
    ok(s.opt === (1 << n) - 1, n + ' 个盘的最少步数 = ' + s.opt);
    ok(s.pegs[0].join(',') === Array.from({length:n}, (_, i) => n - i).join(','), n + ' 个盘按 底大顶小 摆好');
    ok(gaps.every(g => g >= 2), n + ' 个盘：相邻盘至少差 2px，看着不糊（最小间隔 ' + Math.min(...gaps) + 'px）');
    ok(s.rowH * n <= s.boardH, n + ' 个盘：摞起来不超过棋盘高（' + (s.rowH * n) + ' ≤ ' + s.boardH + '）');
  }
  ok(optTable.join(' ') === '3:7 4:15 5:31 6:63 7:127 8:255', '最少步数表：' + optTable.join(' '));

  /* 盘数选择要记进 localStorage */
  ok(store.ghanoi_n === '8', '选过的盘数存进了 localStorage（' + store.ghanoi_n + '）');
}

/* ================= 12) 自包含 ================= */
section('12) 单文件自包含');
{
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok(!/<link[^>]+href=/i.test(html), '没有外部样式表');
  ok(!/url\(\s*['"]?(https?:)?\/\//i.test(html), '没有远程字体 / 图片');
  ok(!/<img\b/i.test(html), '没有图片标签');
  ok(!/@import/i.test(html), '没有 @import');
  ok(/href="\/"/.test(html), '返回键指回首页 href="/"');
}

/* ================= 汇总 ================= */
console.log('\n' + '─'.repeat(52));
if(fail){
  console.log('✗ ' + fail + ' 项失败 / ' + (pass + fail) + ' 项');
  failures.forEach(f => console.log('   · ' + f));
  process.exit(1);
}else{
  console.log('✓ 全部 ' + pass + ' 项通过');
}
process.exit(fail ? 1 : 0);
})();
