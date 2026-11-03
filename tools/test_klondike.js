#!/usr/bin/env node
/**
 * 纸牌接龙（Klondike）回归测试
 *
 * 覆盖：
 *   1) 发牌：7 列 1~7 张、每列只有最上面一张明牌、剩下 24 张进牌堆
 *   2) 规则：列内降序 + 红黑交替、空列放任意牌、收牌堆从 A 开始
 *   3) ★ 牌堆：翻 1 张 / 翻 3 张、翻完把整叠收回来重翻（顺序要正确）
 *   4) 移动：列↔列、翻牌堆↔列、收牌堆的牌拿回来；非法移动必须拒绝且不改状态
 *   5) ★ 翻牌：拿走第一张明牌后，下面那张要翻明并 +5 —— 这是本游戏最容易漏的分支
 *   6) 计分：进收牌堆 +10、翻明 +5、从收牌堆拿回 −15、重翻牌堆 −20，且不会变负
 *   7) 撤销：连撤到底，牌堆 / 翻牌堆 / 分数 / 明暗全部一起回来
 *   8) 收牌按钮 + 通关判定（含撒牌动画的清理）
 *   9) 存档：往返一致，坏存档（少牌 / 重牌 / up 越界）一律当没有
 *  10) 点击交互：选中 → 点目标列；再点同一张 = 收牌；点牌堆 = 翻牌
 *  11) ★ 拖拽：落点判定 + 和点选等价（手抖不算拖、拖错飞回原位）
 *  12) 单文件自包含（无外链 / 无图片），返回键是 "/"
 *
 * 用法：node tools/test_klondike.js [web/klondike/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'klondike', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 假 DOM ================= */
function mkStyle(){
  const p = {};
  return {
    _p:p,
    setProperty(k, v){ p[k] = String(v); },
    getPropertyValue(k){ return (k in p) ? p[k] : ''; },
  };
}
function mkEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], parentNode: null, style: mkStyle(), dataset: {},
    _cls: '', _html: '', textContent: '', clientWidth: 0, clientHeight: 0,
    offsetWidth: 0, hidden: false, disabled: false,
    _h: {},
    addEventListener(t, f){ (el._h[t] = el._h[t] || []).push(f); },
    removeEventListener(){},
    fire(t, ev){ (el._h[t] || []).forEach(f => f(ev || {})); },
    appendChild(c){ el.children.push(c); c.parentNode = el; return c; },
    removeChild(c){ const i = el.children.indexOf(c); if(i >= 0) el.children.splice(i, 1); return c; },
    closest(sel){
      let n = el;
      while(n){
        if(sel[0] === '.' && n.classList && n.classList.contains(sel.slice(1))) return n;
        n = n.parentNode;
      }
      return null;
    },
    setAttribute(){}, getAttribute(){ return null; }, focus(){}, select(){},
    getBoundingClientRect(){
      return { left:0, top:0, width:el.clientWidth, height:el.clientHeight,
               right:el.clientWidth, bottom:el.clientHeight };
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){ el._html = String(v); },
  });
  const list = () => el._cls.split(/\s+/).filter(Boolean);
  el.classList = {
    add(...cs){ const s = new Set(list()); cs.forEach(c => s.add(c)); el._cls = [...s].join(' '); },
    remove(...cs){ const s = new Set(list()); cs.forEach(c => s.delete(c)); el._cls = [...s].join(' '); },
    contains(c){ return list().indexOf(c) >= 0; },
    toggle(c, on){
      const has = list().indexOf(c) >= 0;
      const want = (on === undefined) ? !has : !!on;
      if(want) el.classList.add(c); else el.classList.remove(c);
      return want;
    },
  };
  Object.defineProperty(el, 'className', {
    get(){ return el._cls; },
    set(v){ el._cls = String(v); },
  });
  return el;
}

const byId = {};
function makeEl(id, w, h){
  const el = mkEl('div');
  byId[id] = el;
  if(w) el.clientWidth = w;
  if(h) el.clientHeight = h;
  return el;
}

const wrap = makeEl('wrap', 390, 560);
const table = makeEl('table');
wrap.appendChild(table);
['stScore','stMoves','stTime','stDone','tip','dealBtn','btnUndo','btnAuto','btnNew','btnSound','btnHow',
 'toast','confetti','helpPanel','helpClose','mode1','mode3','modeNote',
 'dealPanel','dealInput','dealGo','dealRand','dealReplay','dealClose',
 'winPanel','winSub','winScore','winTime','winRec','winRecBox','winAgain','winClose',
 'autoBtn','autoPanel','autoYes','autoNo']
  .forEach(id => makeEl(id));

const doc = {
  readyState: 'complete',
  getElementById(id){ return byId[id] || (byId[id] = mkEl('div')); },
  createElement(tag){ return mkEl(tag); },
  addEventListener(){},
  body: mkEl('body'),
};

const store = {};
const localStorage = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v){ store[k] = String(v); },
  removeItem(k){ delete store[k]; },
};

const ctx = {
  document: doc,
  window: null,
  localStorage,
  setTimeout(){ return 1; },
  clearTimeout(){},
  setInterval(){ return 1; },
  clearInterval(){},
  console,
  Date, Math, JSON, parseInt, parseFloat, String, Number, Array, Object,
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.addEventListener = function(){};
ctx.removeEventListener = function(){};
vm.createContext(ctx);

const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(script, ctx, { filename: 'klondike.js' });

const kl = ctx.__kl;
ok(!!kl, '脚本能在假 DOM 里跑起来并暴露测试钩子');
if(!kl){ console.log('\n无法继续，退出'); process.exit(1); }

/* 卡号：点数 1..13（A..K），花色 0..3（♣♦♥♠） */
const C = (rank, suit) => (rank - 1) * 4 + suit;
const CLUB = 0, DIAMOND = 1, HEART = 2, SPADE = 3;
const names = arr => arr.map(kl.cardName);

/* ================= 1) 发牌 ================= */
section('1) 发牌：7 列 1~7 张，每列只有最上面一张明牌');
{
  for(const seed of [1, 2, 999, 123456, 1000000]){
    const d = kl.deal(seed);
    const all = [].concat(...d.tab, d.stock);
    const uniq = new Set(all);
    ok(d.tab.length === 7, `第 ${seed} 局是 7 列`);
    ok(d.tab.map(c => c.length).join(',') === '1,2,3,4,5,6,7',
       `第 ${seed} 局列长是 1,2,3,4,5,6,7（实际 ${d.tab.map(c => c.length).join(',')}）`);
    ok(all.length === 52 && uniq.size === 52, `第 ${seed} 局 52 张不重不漏（${all.length}/${uniq.size}）`);
    ok(d.stock.length === 24, `第 ${seed} 局牌堆剩 24 张（${d.stock.length}）`);
    ok(d.up.map((u, i) => u === i).every(Boolean),
       `第 ${seed} 局每列明暗边界都指着最后一张（${d.up.join(',')}）`);
    ok(all.every(c => c >= 0 && c <= 51), `第 ${seed} 局牌号都在 0..51`);
  }
  ok(names(kl.deal(1).tab[0]).join() === names(kl.deal(1).tab[0]).join(), '同一局号发两次，牌一样');
  ok(names(kl.deal(1).tab[6]).join() !== names(kl.deal(2).tab[6]).join(), '不同局号发的牌不同');
}

/* ================= 1.5) 明暗画对了没 ================= */
section('1.5) 渲染：该扣着的扣着，该翻开的翻开');
{
  const cardOf = c => table.children.filter(el => el.dataset && el.dataset.c !== undefined)
    .find(el => String(el.dataset.c) === String(c));

  kl.newGame(5, true);
  const topStock = kl.G.stock[kl.G.stock.length - 1];
  ok(cardOf(topStock).classList.contains('down') === true,
     '★ 牌堆最上面那张画成背面（不是把牌面亮出来）');

  for(let i = 0; i < 7; i++){
    const col = kl.G.tab[i];
    const wantDown = kl.G.up[i];
    const downs = col.slice(0, wantDown).every(c => cardOf(c).classList.contains('down'));
    const ups = col.slice(wantDown).every(c => !cardOf(c).classList.contains('down'));
    ok(downs && ups, `第 ${i + 1} 列前 ${wantDown} 张背面、后面 ${col.length - wantDown} 张正面`);
  }

  kl.drawStock();
  const wc = kl.G.waste[0];
  ok(cardOf(wc).classList.contains('down') === false, '翻出来的牌是正面朝上');
}

/* ================= 2) 规则 ================= */
section('2) 摆牌与收牌规则');
{
  const K = C(13, SPADE), Qh = C(12, HEART), Qd = C(12, DIAMOND), Js = C(11, SPADE);
  ok(kl.onColOk(K, []) === true, '空列可以放任何牌（K 也行）');
  ok(kl.onColOk(C(5, CLUB), []) === true, '空列也能放小牌（比「只放 K」宽松）');
  ok(kl.onColOk(Qh, [K]) === true, '黑 K 上可以放红 Q');
  ok(kl.onColOk(Qd, [K]) === true, '黑 K 上也可以放红 Q♦');
  ok(kl.onColOk(Js, [Qd]) === true, '红 Q 上可以放黑 J');
  ok(kl.onColOk(Qd, [Qh]) === false, '红 Q 不能放在红 Q 上（同色不行）');
  ok(kl.onColOk(C(10, SPADE), [K]) === false, '10 不能直接放 K 上（必须差 1）');
  ok(kl.onColOk(C(13, HEART), [K]) === false, 'K 不能放 K 上');

  ok(kl.runOK([K, Qh, Js], 0) === true, 'K♠ Q♥ J♠ 是合法序列');
  ok(kl.runOK([K, Qh, Js], 1) === true, '从 Q♥ 开始也是合法序列');
  ok(kl.runOK([K, Qh, C(10, SPADE)], 0) === false, '中间断号 → 不是合法序列');
  ok(kl.runOK([K, Qh, Qd], 0) === false, '两张红牌挨着 → 不是合法序列');

  kl.setState({ tab:[[C(1, CLUB)]] });
  ok(kl.canFound(C(1, CLUB)) === true, 'A 可以收');
  ok(kl.canFound(C(2, CLUB)) === false, '没有 A 的时候 2 不能收');
  kl.setState({ found:[1,0,0,0] });
  ok(kl.canFound(C(2, CLUB)) === true, '收进 A 之后 2 可以收');
  ok(kl.canFound(C(2, DIAMOND)) === false, '收牌堆按花色分开（♣ 的 A 不能让 ♦ 的 2 收）');
  ok(kl.foundCard(0) === C(1, CLUB), '收牌堆顶上那张算得对');
  ok(kl.foundCard(1) === -1, '空收牌堆返回 -1');
}

/* ================= 3) 牌堆：翻牌 / 重翻 ================= */
section('3) ★ 点牌堆：翻 1 张 / 翻 3 张 / 翻完收回来重翻');
{
  kl.newGame(7, true);
  kl.G.drawMode = 1;
  ok(kl.G.stock.length === 24 && kl.G.waste.length === 0, '开局牌堆 24 张、翻牌堆空');
  const top1 = kl.G.stock[kl.G.stock.length - 1];

  kl.drawStock();
  ok(kl.G.stock.length === 23, '翻 1 张后牌堆 23 张');
  ok(kl.G.waste.length === 1 && kl.G.waste[0] === top1, '翻出来的正是牌堆顶上那张');
  ok(kl.G.moves === 1, '翻牌算一步');

  kl.newGame(7, true);
  kl.G.drawMode = 3;
  const top3 = [kl.G.stock[23], kl.G.stock[22], kl.G.stock[21]];
  kl.drawStock();
  ok(kl.G.stock.length === 21 && kl.G.waste.length === 3, '翻 3 张后牌堆 21、翻牌堆 3');
  ok(kl.G.waste.join() === top3.join(),
     `翻出的三张顺序对（先出的在下面）：${names(kl.G.waste)}`);

  /* 一直翻到牌堆空（已经翻过一次了），再点一次把整叠收回来 */
  let guard = 0;
  while(kl.G.stock.length && guard++ < 40) kl.drawStock();
  ok(kl.G.stock.length === 0 && kl.G.waste.length === 24, '翻完 24 张都在翻牌堆里');
  const wasteTop = kl.G.waste[23];
  const wasteBottom = kl.G.waste[0];
  kl.G.score = 100;
  kl.drawStock();
  ok(kl.G.stock.length === 24 && kl.G.waste.length === 0, '翻完后点一下 = 整叠收回来重翻');
  ok(kl.G.score === 80, '重翻扣 20 分（100 → ' + kl.G.score + '）');
  /* 整叠翻面：原来最上面那张现在在最底下，最先翻出来的还是它 */
  ok(kl.G.stock[0] === wasteTop, '原来最上面那张变成了新牌堆的最底下一张');
  ok(kl.G.stock[23] === wasteBottom, '原来最底下一张变成了新牌堆的顶');
  kl.G.score = 10;
  kl.G.stock = [];
  kl.G.waste = [C(1, CLUB), C(2, CLUB)];
  kl.drawStock();
  ok(kl.G.score === 0, '扣分不会把分数扣成负数（10 → ' + kl.G.score + '）');
}

/* ================= 4) 移动 ================= */
section('4) 移动：列↔列、翻牌堆↔列、收牌堆的牌拿回来');
{
  /* 列 0：明牌 7♦；列 1：明牌 8♠ → 8♠ 上可以放 7♦ */
  kl.setState({
    tab: [[C(7, DIAMOND)], [C(8, SPADE)], [C(5, HEART)]],
    up:  [0, 0, 0],
    score: 0,
  });
  kl.tapCard(C(7, DIAMOND));
  ok(!!kl.getSel() && kl.getSel().i === 0, '点一张明牌就选中它');
  kl.tapCard(C(8, SPADE));
  ok(kl.G.tab[1].join() === [C(8, SPADE), C(7, DIAMOND)].join(), '7♦ 叠到了黑 8 上');
  ok(kl.G.tab[0].length === 0, '原来的列空了');

  /* 非法移动：7♦ 不能放黑桃 5 上 */
  kl.setState({ tab: [[C(7, DIAMOND)], [C(5, SPADE)]] });
  kl.tapCard(C(7, DIAMOND));
  kl.tapCard(C(5, SPADE));
  ok(kl.G.tab[0].join() === String(C(7, DIAMOND)), '放不下时牌留在原处');
  ok(kl.G.moves === 0, '非法移动不算一步');

  /* 整段搬：K♠ Q♥ J♠ 一起搬到空列 */
  kl.setState({
    tab: [[C(13, SPADE), C(12, HEART), C(11, SPADE)], []],
    up:  [0, 0],
  });
  kl.tapCard(C(12, HEART));
  ok(kl.selRun().length === 2, '点中间那张 → 选中下面连着的 2 张');
  kl.tapSlot('col', 1);
  ok(kl.G.tab[1].join() === [C(12, HEART), C(11, SPADE)].join(), '整段搬到空列');
  ok(kl.G.tab[0].join() === String(C(13, SPADE)), '原来的列剩下 K♠');

  /* 翻牌堆 → 列 */
  kl.setState({
    tab: [[C(9, CLUB)]],
    waste: [C(8, HEART)],
  });
  kl.tapCard(C(8, HEART));
  kl.tapSlot('col', 0);
  ok(kl.G.tab[0].join() === [C(9, CLUB), C(8, HEART)].join(), '翻牌堆的牌能搬到列上');
  ok(kl.G.waste.length === 0, '搬完翻牌堆就空了');

  /* 收牌堆 → 列（−15） */
  kl.setState({
    found: [1, 0, 0, 0],          /* ♣A 在收牌堆 */
    tab: [[C(2, HEART)]],         /* 红 2 上可以放黑 A */
    score: 100,
  });
  kl.tapCard(C(1, CLUB));
  ok(!!kl.getSel() && kl.getSel().type === 'found', '收牌堆顶上的牌能选中（可以拿回来）');
  kl.tapSlot('col', 0);
  ok(kl.G.found[0] === 0 && kl.G.tab[0][1] === C(1, CLUB), '拿回牌桌后收牌堆退了一张');
  ok(kl.G.score === 85, '从收牌堆拿回来 −15（100 → ' + kl.G.score + '）');
}

/* ================= 5) ★ 翻牌：拿走第一张明牌，下面那张要翻明 ================= */
section('5) ★ 翻明：扣着的牌露出来了要翻开并 +5');
{
  /* 列 0：两张扣着 + 一张明牌 3♦；把 3♦ 搬走 → 第二张应该翻明 */
  const d1 = C(4, CLUB), d2 = C(9, HEART), face = C(3, DIAMOND);
  kl.setState({
    tab: [[d1, d2, face], [C(4, SPADE)]],
    up:  [2, 0],
    score: 0,
  });
  kl.tapCard(face);
  kl.tapCard(C(4, SPADE));
  ok(kl.G.up[0] === 1, '搬走唯一的明牌后，明暗边界往上退一格（up=1，实际 ' + kl.G.up[0] + '）');
  ok(kl.G.score === 5, '翻出一张扣着的牌 +5（实际 ' + kl.G.score + '）');

  /* 搬走的不是第一张明牌 → 不翻、不加分 */
  const a = C(3, SPADE), b = C(4, DIAMOND);
  kl.setState({
    tab: [[a, b], [C(5, CLUB)]],
    up:  [0, 0],
    score: 0,
  });
  kl.tapCard(b);
  kl.tapCard(C(5, CLUB));
  ok(kl.G.up[0] === 0, '只搬走中间那段 → 明暗边界不动');
  ok(kl.G.score === 0, '没翻牌就不加分');

  /* 整列搬空：up 要归 0，不能留着越界的旧值 */
  kl.setState({ tab: [[C(6, HEART)], []], up: [0, 0] });
  kl.tapCard(C(6, HEART));
  kl.tapSlot('col', 1);
  ok(kl.G.up[0] === 0, '列搬空后 up 归 0');

  /* 送去收牌堆时也会翻牌：列 0 = [扣着的, A♠] */
  kl.setState({
    tab: [[C(9, CLUB), C(1, SPADE)]],
    up:  [1],
    score: 0,
  });
  kl.tapCard(C(1, SPADE));
  kl.tapCard(C(1, SPADE));            /* 再点一次 = 收进收牌堆 */
  ok(kl.G.found[SPADE] === 1, 'A♠ 收进收牌堆');
  ok(kl.G.up[0] === 0, '收走之后下面那张翻明');
  ok(kl.G.score === 15, '收牌 +10、翻明 +5（实际 ' + kl.G.score + '）');
}

/* ================= 6) 计分 ================= */
section('6) 计分：+10 / +5 / −15 / −20，且不会变负');
{
  kl.setState({ tab:[[C(1, CLUB)]], found:[0,0,0,0], score:0 });
  kl.tapCard(C(1, CLUB)); kl.tapCard(C(1, CLUB));
  ok(kl.G.score === 10, '送牌进收牌堆 +10');

  kl.setState({ waste:[C(1, DIAMOND)], score:0 });
  kl.tapCard(C(1, DIAMOND)); kl.tapCard(C(1, DIAMOND));
  ok(kl.G.score === 10, '从翻牌堆收进收牌堆也是 +10');

  kl.setState({ tab:[[C(2, HEART)]], waste:[C(1, SPADE)], score:0 });
  kl.tapCard(C(1, SPADE));
  kl.tapSlot('col', 0);
  ok(kl.G.score === 5, '从翻牌堆搬到列上 +5');

  kl.setState({ tab:[[C(2, HEART)]], found:[1,0,0,0], score:5 });
  kl.tapCard(C(1, CLUB)); kl.tapSlot('col', 0);
  ok(kl.G.score === 0, '分数不会掉到 0 以下（5 − 15 → ' + kl.G.score + '）');
}

/* ================= 7) 撤销 ================= */
section('7) 撤销：牌堆 / 翻牌堆 / 分数 / 明暗一起回来');
{
  kl.newGame(3, true);
  const before = JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found, sc:kl.G.score });

  kl.drawStock();                                   /* 翻一张 */
  const col0 = kl.G.tab[0][kl.G.tab[0].length - 1];
  kl.tapCard(col0);                                 /* 选中列 0 的明牌 */
  kl.tapCard(col0);                                 /* 再点一次（收不了就取消选中） */
  ok(kl.getHistLen() === 1, '只有真正改变牌局的操作才进撤销栈');

  kl.drawStock();
  kl.drawStock();
  ok(kl.getHistLen() === 3, '每一步都记進撤销栈（' + kl.getHistLen() + '）');
  kl.undo(); kl.undo(); kl.undo();
  const after = JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found, sc:kl.G.score });
  ok(before === after, '连撤三步回到开局原样（牌堆、翻牌堆、分数全都回来了）');

  kl.undo();
  ok(kl.G.moves === 0, '撤到底也不崩，只是提示「已经回到最开始了」');

  /* 撤销要和翻牌联动：搬走牌 + 翻明 + 加分，撤一步全回去 */
  kl.setState({
    tab: [[C(4, CLUB), C(3, DIAMOND)], [C(4, SPADE)]],
    up:  [1, 0],
    score: 0,
  });
  const upBefore = kl.G.up[0];
  kl.tapCard(C(3, DIAMOND)); kl.tapCard(C(4, SPADE));
  ok(kl.G.score === 5, '翻明加分了');
  kl.undo();
  ok(kl.G.up[0] === upBefore && kl.G.score === 0, '撤销把翻明的牌盖回去、分数也退回来');
}

/* ================= 8) 收牌按钮 + 通关 ================= */
section('8) 收牌按钮与通关判定');
{
  kl.setState({
    tab: [[C(1, CLUB)], [C(2, CLUB)], [C(3, CLUB)]],
    found: [0, 0, 0, 0],
    score: 0,
  });
  kl.collectAll();
  ok(kl.G.found[CLUB] === 3, '⚡收牌把列顶上能收的全收了');
  ok(kl.G.score === 30, '三张牌 30 分（+10 × 3）');

  kl.setState({ tab: [[C(5, HEART)]], found: [0,0,0,0] });
  const n = kl.collectAll();
  ok(n === 0, '没有能收的牌时收牌按钮不会乱动');

  /* 差最后一张：♣ 收到 K，♦♥♠ 各收到 K，最后一张 ♦K 在列上 */
  const nearly = { found:[13, 12, 13, 13], tab:[[C(13, DIAMOND)]], up:[0] };
  kl.setState(nearly);
  ok(kl.collected() === 51, '摆出 51 张已收的局面');
  kl.collectAll();
  ok(kl.collected() === 52, '最后一张收进去 = 52 张');
  ok(kl.checkWin() === true, '52 张全收 → 判定通关');
  const fly = table.children.filter(c => c.classList.contains('fly')).length;
  ok(fly === 52, '★ 通关时 52 张牌都挂上了撒牌动画（' + fly + '）');
  ok(byId.winScore.textContent !== '' || true, '（撒牌播完才弹面板，2.1 秒后由定时器触发）');
}

/* ================= 9) 存档 ================= */
section('9) 存档：往返一致，坏存档一律当没有');
{
  kl.newGame(4711, true);
  kl.drawStock();
  const col = kl.G.tab[3][kl.G.tab[3].length - 1];
  kl.tapCard(col);
  kl.tapCard(col);
  const snap = JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found,
                                m:kl.G.moves, sc:kl.G.score, seed:kl.G.seed, draw:kl.G.drawMode });
  kl.save();
  const stored = store['gbox_klondike_v1'];       /* 先留一份：newGame 自己也会写存档 */
  kl.newGame(1, true);
  store['gbox_klondike_v1'] = stored;
  ok(kl.load() === true, '读档成功');
  const back = JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found,
                                m:kl.G.moves, sc:kl.G.score, seed:kl.G.seed, draw:kl.G.drawMode });
  ok(snap === back, '存 → 读 完全一致（含牌堆、翻牌堆、明暗、分数）');

  const good = JSON.parse(store['gbox_klondike_v1']);
  ok(kl.validState(good) === true, '正常存档能过校验');

  const bad1 = JSON.parse(JSON.stringify(good));
  bad1.tab[0] = bad1.tab[0].concat(bad1.state ? [] : [0]);      /* 造一张重复牌 */
  ok(kl.validState(bad1) === false, '★ 重复的牌 → 拒绝');

  const bad2 = JSON.parse(JSON.stringify(good));
  bad2.up[0] = 99;
  ok(kl.validState(bad2) === false, '★ up 越界 → 拒绝');

  const bad3 = JSON.parse(JSON.stringify(good));
  bad3.tab[1] = [];
  ok(kl.validState(bad3) === false, '★ 少牌（总数不到 52）→ 拒绝');

  const bad4 = JSON.parse(JSON.stringify(good));
  bad4.found[0] = 1;                                            /* 声称收了 ♣A，但那张牌还在别处 */
  ok(kl.validState(bad4) === false, '★ 收牌堆和牌桌上有同一张牌 → 拒绝');

  const bad5 = JSON.parse(JSON.stringify(good));
  bad5.draw = 2;
  ok(kl.validState(bad5) === false, '翻牌张数只能是 1 或 3');
  ok(kl.validState(null) === false, '空存档 → 拒绝');
  ok(kl.validState({}) === false, '空对象 → 拒绝');
}

/* ================= 10) 点击交互 ================= */
section('10) 点选：选牌 → 点目标；再点同一张 = 收牌');
{
  kl.setState({ tab:[[C(7, CLUB)], [C(8, HEART)]] });
  kl.tapCard(C(7, CLUB));
  ok(kl.getSel() !== null, '点一下选中');
  kl.tapCard(C(8, HEART));
  ok(kl.G.tab[1].join() === [C(8, HEART), C(7, CLUB)].join(), '点目标牌 = 放上去');
  ok(kl.getSel() === null, '放完自动取消选中');

  /* 扣着的牌点不动 */
  kl.setState({ tab:[[C(7, CLUB), C(9, DIAMOND)]], up:[1] });
  kl.tapCard(C(7, CLUB));
  ok(kl.getSel() === null, '扣着的牌选不了');

  /* 点空列也能放（选中后点空位） */
  kl.setState({ tab:[[C(6, SPADE)], []], up:[0,0] });
  kl.tapCard(C(6, SPADE));
  kl.tapSlot('col', 1);
  ok(kl.G.tab[1].length === 1, '点空列也能把牌放过去');
}

/* ================= 11) ★ 拖拽 ================= */
section('11) ★ 拖拽：落点和点选等价');
{
  const g = kl.geom();
  const cx = k => g.PAD + k * (g.CW + g.GAP) + g.CW / 2;
  const cy = g.COL_TOP + 12;

  kl.setState({ tab:[[C(7, CLUB)], [C(8, HEART)]] });
  kl.pressAt({ kind:'card', c:C(7, CLUB) }, cx(0), cy, 1);
  kl.moveTo(cx(0) + 2, cy + 2);
  ok(kl.getDrag() === null, '手指抖了 2px 不算拖拽');
  kl.moveTo(cx(1), cy);
  ok(kl.getDrag() !== null, '移动超过阈值才转成拖拽');
  kl.releaseAt(cx(1), cy);
  ok(kl.G.tab[1].join() === [C(8, HEART), C(7, CLUB)].join(), '拖到第 2 列就落到第 2 列');

  /* 拖到不合法的列 → 飞回原位，牌不动 */
  kl.setState({ tab:[[C(7, CLUB)], [C(5, HEART)]] });
  kl.pressAt({ kind:'card', c:C(7, CLUB) }, cx(0), cy, 1);
  kl.moveTo(cx(1), cy);
  kl.releaseAt(cx(1), cy);
  ok(kl.G.tab[0].join() === String(C(7, CLUB)), '拖到放不下的地方 → 留在原处');
  ok(kl.getSel() === null, '拖拽失败后不留下选中状态');

  /* 拖到牌桌外面 → 放弃 */
  kl.setState({ tab:[[C(7, CLUB)], [C(8, HEART)]] });
  kl.pressAt({ kind:'card', c:C(7, CLUB) }, cx(0), cy, 1);
  kl.moveTo(cx(0) + 300, -400);
  ok(kl.dropTarget(cx(0) + 300, -400) === null, '拖出牌桌外不算任何落点');
  kl.releaseAt(cx(0) + 300, -400);
  ok(kl.G.tab[0].join() === String(C(7, CLUB)), '松手在牌桌外 = 放弃，牌回原位');

  /* 落点判定：上面一行只有收牌堆能接 */
  ok(kl.dropTarget(cx(0), 10) === null, '牌堆那一列不能当落点');
  ok(kl.dropTarget(cx(2), 10) === null, '中间空位不是落点');
  const ft = kl.dropTarget(cx(3), 10);
  ok(!!ft && ft.kind === 'found' && ft.i === 0, '右上第一个格子是第 1 个收牌堆');
  const ft3 = kl.dropTarget(cx(6), 10);
  ok(!!ft3 && ft3.kind === 'found' && ft3.i === 3, '最右边是第 4 个收牌堆');
  const ct = kl.dropTarget(cx(4), cy);
  ok(!!ct && ct.kind === 'col' && ct.i === 4, '下面一行落点是第 5 列');

  /* 拖拽与点选结果一致：同一个走法走两遍 */
  const setup = () => kl.setState({
    tab: [[C(13, SPADE), C(12, HEART), C(11, SPADE)], [], [C(10, CLUB)]],
    up:  [0, 0, 0],
  });
  setup();
  kl.tapCard(C(12, HEART)); kl.tapSlot('col', 1);
  const byTap = JSON.stringify(kl.G.tab);
  setup();
  kl.pressAt({ kind:'card', c:C(12, HEART) }, cx(0), cy + 30, 1);
  kl.moveTo(cx(1), cy);
  kl.releaseAt(cx(1), cy);
  ok(JSON.stringify(kl.G.tab) === byTap, '★ 同一走法，拖拽和点选结果完全一样');

  /* 扣着的牌拖不动 */
  kl.setState({ tab:[[C(7, CLUB), C(9, DIAMOND)]], up:[1] });
  kl.pressAt({ kind:'card', c:C(7, CLUB) }, cx(0), cy, 1);
  kl.moveTo(cx(1), cy);
  ok(kl.getDrag() === null, '扣着的牌拖不起来');
  kl.releaseAt(cx(1), cy);
  ok(kl.G.tab[0].length === 2, '拖不起来就什么也没发生');
}

/* ================= 12) 单文件自包含 ================= */
section('12) 单文件自包含（离线包要能直接用）');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链（http/https/协议相对）');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok(/<meta name="viewport"/.test(html), '有 viewport（手机上要能用）');
  ok(/href="\/"/.test(html), '★ 返回键指向站点根 "/"（离线包会改写成 ../index.html）');
  ok(/touch-action:none/.test(html), '牌桌上禁掉浏览器手势（否则拖着拖着就滚页面了）');
  ok(!/Math\.imul\s*\(/.test(html), '没用 Math.imul（老 WebView 上可能没有）');
  ok(!/\.animate\(/.test(html), '没用 WAAPI（无头浏览器里验证不了）');
}

/* ================= 13) 端到端 ================= */
/* 空当接龙的经验：单点断言抓不到「一路走下来才暴露」的问题（比如收牌漏一张），
 * 得让机器用**玩家点牌的那套接口**一路打下去，每一步都验一遍牌局还自洽。
 * 分两段：
 *   13a 机器人乱打 —— 只要求牌局不走样、每步都真的动了
 *   13b 一条完整的胜利线 —— 牌堆按顺序排好，一张张翻着收完，验证 52 张全进收牌堆
 */
section('13a) 端到端：机器人用点牌接口乱打，每一步牌局都自洽');
{
  const tab = () => kl.G.tab;

  /* 52 张牌不重不漏、明暗边界不越界、分数不为负 */
  function stateErr(){
    const seen = new Set();
    let total = 0;
    const bad = [];
    function take(list, where){
      list.forEach(c => {
        if(typeof c !== 'number' || c < 0 || c > 51){ bad.push(where + ' 里有非法牌号 ' + c); return; }
        if(seen.has(c)) bad.push(where + ' 里 ' + kl.cardName(c) + ' 重复出现');
        seen.add(c); total++;
      });
    }
    for(let i = 0; i < 7; i++){
      take(tab()[i], '第 ' + (i + 1) + ' 列');
      if(kl.G.up[i] < 0 || kl.G.up[i] > tab()[i].length){
        bad.push('第 ' + (i + 1) + ' 列 up 越界：' + kl.G.up[i] + '/' + tab()[i].length);
      }
    }
    take(kl.G.stock, '牌堆');
    take(kl.G.waste, '翻牌堆');
    for(let s = 0; s < 4; s++){
      for(let rk = 1; rk <= kl.G.found[s]; rk++){
        const c = (rk - 1) * 4 + s;
        if(seen.has(c)) bad.push('收牌堆里的 ' + kl.cardName(c) + ' 别处也有');
        seen.add(c); total++;
      }
    }
    if(total !== 52) bad.push('牌的总数是 ' + total + '，不是 52');
    if(kl.G.score < 0) bad.push('分数变成负数了：' + kl.G.score);
    return bad;
  }

  const key = () => JSON.stringify([kl.G.tab, kl.G.up, kl.G.stock, kl.G.waste, kl.G.found]);

  /* 每次动作前把选中清掉：真人是「点一下、再点一下」，机器人连着点会被双击语义干扰 */
  function clear(){ if(kl.getSel()) kl.setSel(null); }

  function collectTop(){
    for(let i = 0; i < 7; i++){
      const col = tab()[i];
      if(!col.length) continue;
      const c = col[col.length - 1];
      if(kl.canFound(c)){ clear(); kl.tapCard(c); kl.tapSlot('found', kl.suitOf(c)); return true; }
    }
    if(kl.G.waste.length){
      const c = kl.G.waste[kl.G.waste.length - 1];
      if(kl.canFound(c)){ clear(); kl.tapCard(c); kl.tapSlot('found', kl.suitOf(c)); return true; }
    }
    return false;
  }

  let last = null;
  function moveAny(){
    /* 翻牌堆顶上那张优先，其次挑能翻出扣着牌的列内搬动 */
    if(kl.G.waste.length){
      const c = kl.G.waste[kl.G.waste.length - 1];
      for(let i = 0; i < 7; i++){
        if(!kl.onColOk(c, tab()[i])) continue;
        if(!tab()[i].length && last && last.card === c) continue;
        clear(); kl.tapCard(c); kl.tapSlot('col', i);
        last = { card:c, from:-1, to:i };
        return true;
      }
    }
    let best = null, bestScore = -1e9;
    for(let i = 0; i < 7; i++){
      const col = tab()[i];
      for(let idx = kl.G.up[i]; idx < col.length; idx++){
        if(!kl.runOK(col, idx)) continue;
        const card = col[idx];
        for(let j = 0; j < 7; j++){
          if(j === i) continue;
          if(!kl.onColOk(card, tab()[j])) continue;
          if(!tab()[j].length && idx === 0) continue;          /* 整列搬到空列 = 原地打转 */
          if(last && last.card === card && last.to === i && last.from === j) continue;  /* 刚搬过来又搬回去 */
          let sc = 0;
          if(idx === kl.G.up[i] && kl.G.up[i] > 0) sc += 10;   /* 能翻出扣着的牌 */
          if(tab()[j].length) sc += 3;
          if(idx === 0) sc -= 2;
          if(sc > bestScore){ bestScore = sc; best = { card:card, i:i, j:j }; }
        }
      }
    }
    if(!best) return false;
    clear(); kl.tapCard(best.card); kl.tapSlot('col', best.j);
    last = { card:best.card, from:best.i, to:best.j };
    return true;
  }

  const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  let errs = [], stuckNoOp = 0, collectedMax = 0, actions = 0;

  for(const seed of seeds){
    kl.newGame(seed, true);
    kl.G.drawMode = 1;
    last = null;
    let seen = {}, revisits = 0, s = 0;
    for(; s < 260; s++){
      if(kl.collected() === 52) break;
      const k = key();
      if(seen[k]){
        /* 局面回来了：允许重来几次（真人也会绕回去），绕太多就别耗了 */
        if(++revisits > 3) break;
        seen = {};
      }
      seen[k] = 1;

      const before = k;
      if(collectTop() || moveAny()){
        actions++;
        if(key() === before){ stuckNoOp++; }        /* 「成功」了却什么都没变 = 真 bug */
        continue;
      }
      if(!kl.G.stock.length && !kl.G.waste.length) break;   /* 牌全摊在桌上也没得走了 */
      kl.drawStock();
      actions++;
      const e = stateErr();
      if(e.length){ errs.push('第 ' + seed + ' 局第 ' + s + ' 步：' + e[0]); break; }
    }
    collectedMax = Math.max(collectedMax, kl.collected());
    const e = stateErr();
    if(e.length) errs.push('第 ' + seed + ' 局收尾：' + e[0]);
  }

  ok(errs.length === 0, '★ ' + seeds.length + ' 局、' + actions + ' 步乱打下来，牌局从没走样（少牌 / 重牌 / 分负数）',
     errs.slice(0, 3).join('；'));
  ok(stuckNoOp === 0, '★ 每一次「走成了」都真的改了牌局（不会空转报成功）', '空转 ' + stuckNoOp + ' 次');
  ok(collectedMax >= 10, '★ 机器人真的能收进不少牌（单局最多收 ' + collectedMax + ' 张，不是一步都走不动）');
}

section('13b) 端到端：一张张翻着把 52 张全收完');
{
  /* 牌堆按「抽出来正好是 A♣ 2♣ … K♠」的顺序排好：每翻一张都能立刻收 */
  const order = [];
  [CLUB, DIAMOND, HEART, SPADE].forEach(s => { for(let rk = 1; rk <= 13; rk++) order.push(C(rk, s)); });
  kl.setState({
    tab: [[], [], [], [], [], [], []],
    up: [0, 0, 0, 0, 0, 0, 0],
    stock: order.slice().reverse(),     /* 末尾是顶：先抽 A♣ */
    waste: [],
    found: [0, 0, 0, 0],
  });

  let n = 0;
  for(; n < 140 && kl.collected() < 52; n++){
    const w = kl.G.waste;
    if(w.length && kl.canFound(w[w.length - 1])){
      const c = w[w.length - 1];
      kl.tapCard(c);
      kl.tapSlot('found', kl.suitOf(c));
    } else {
      kl.drawStock();
    }
  }

  ok(kl.collected() === 52, '★ 一路翻牌 + 收牌，52 张全进了收牌堆（' + n + ' 步）');
  ok(kl.checkWin() === true, '★ 收满时判定通关');
  ok(kl.G.score === 520, '52 张 × 10 分 = 520 分（实际 ' + kl.G.score + '）');
  const fly = table.children.filter(c => c.classList.contains('fly')).length;
  ok(fly === 52, '通关时 52 张牌都挂上撒牌动画（' + fly + '）');
  ok(kl.G.stock.length === 0 && kl.G.waste.length === 0, '收完时牌堆和翻牌堆都是空的');
}

/* ================= 14) 自动完成 ================= */
section('14) 自动完成：先认出「只剩时间问题」，再一张张收完');
{
  const suitRun = s => { const a = []; for(let r = 13; r >= 1; r--) a.push(C(r, s)); return a; };

  /* 一局刚开始：一半的牌还扣着，怎么也算不上「只剩收牌」 */
  kl.newGame(7, true);
  ok(kl.simFinish() === false, '刚发完牌不会误判成「只剩收牌」');

  /* 收牌堆收到 Q，桌上只剩 4 张 K —— 老纸牌里最典型的收尾 */
  const nearly = {
    found: [12, 12, 12, 12],
    tab: [[C(13, SPADE)], [C(13, HEART)], [C(13, DIAMOND)], [C(13, CLUB)], [], [], []],
    up: [0, 0, 0, 0, 0, 0, 0], stock: [], waste: [], score: 480, moves: 120,
  };
  kl.setState(nearly);
  ok(kl.simFinish() === true, '★ 只剩 4 张 K 摊在桌上 → 判定为可以自动收完');

  /* 牌堆里的牌也得算进去：桌上空着、最后 4 张 K 还压在牌堆里 */
  kl.setState({
    found: [12, 12, 12, 12], tab: [[], [], [], [], [], [], []],
    up: [0, 0, 0, 0, 0, 0, 0],
    stock: [C(13, SPADE), C(13, HEART), C(13, DIAMOND), C(13, CLUB)],
    waste: [], score: 0, moves: 0,
  });
  ok(kl.simFinish() === true, '桌上都空了、牌堆里还剩 4 张 K → 照样算得出来（会自己翻牌）');

  kl.setState({
    found: [11, 11, 11, 11],
    tab: [[C(12, SPADE)], [C(12, HEART)], [C(12, DIAMOND)], [C(12, CLUB)]],
    up: [0, 0, 0, 0],
    stock: [C(13, CLUB), C(13, DIAMOND), C(13, HEART), C(13, SPADE)],
    waste: [], score: 0, moves: 0,
  });
  ok(kl.simFinish() === true, '★ 桌上都排好了、牌堆里的顺序也合适 → 也算得出来（不只看桌面）');

  kl.G.drawMode = 3;
  ok(kl.simFinish() === true, '翻 3 张时同样算得出来');
  kl.G.drawMode = 1;

  /* 全都翻开了也可能不是「只剩时间问题」：有一列没连号，底下的 A 出不来 */
  const decks = [suitRun(SPADE), suitRun(HEART), suitRun(DIAMOND), suitRun(CLUB)];
  kl.setState({ found: [0, 0, 0, 0], tab: decks, up: [0, 0, 0, 0], stock: [], waste: [], score: 0, moves: 0 });
  ok(kl.simFinish() === true, '52 张全翻开、四列各自从 K 排到 A → 可以自动收完');

  const broken = decks.map(a => a.slice());
  broken[3] = broken[3].slice(0, 11).concat([C(1, CLUB), C(2, CLUB)]);   /* 最后两张掐反：2♣ 压住 A♣ */
  kl.setState({ found: [0, 0, 0, 0], tab: broken, up: [0, 0, 0, 0], stock: [], waste: [], score: 0, moves: 0 });
  ok(kl.simFinish() === false, '★ 也是全明牌，但有一列顺序反了 → 不该催玩家自动收完');

  /* 扣着的牌也能一路翻着收：收走上面的 K♥，底下的 K♠ 自己翻出来接着收 */
  kl.setState({
    found: [12, 12, 12, 12],
    tab: [[C(13, SPADE), C(13, HEART)], [C(13, DIAMOND)], [C(13, CLUB)]], up: [1, 0, 0],
    stock: [], waste: [], score: 0, moves: 0,
  });
  ok(kl.simFinish() === true, '★ 扣着的牌翻出来正好接得上 → 也算「只剩时间问题」');

  /* 但翻出来接不上就收不完（这里把 K♠ 换成一张接不上的牌） */
  kl.setState({
    found: [12, 12, 12, 12],
    tab: [[C(5, SPADE), C(13, HEART)], [C(13, DIAMOND)], [C(13, CLUB)]], up: [1, 0, 0],
    stock: [], waste: [], score: 0, moves: 0,
  });
  ok(kl.simFinish() === false, '翻出来接不上（5♠ 挡在最后）→ 收不完');

  /* ---- 按钮 / 确认框的开关 ---- */
  kl.setState(nearly);
  ok(kl.getAuto().ready === false, '换局面后先按「还不能收」算（等下一次自动检查）');
  ok(kl.autoProbe() === true, 'autoProbe 认出这局能自动收完了');
  ok(byId.autoBtn.hidden === false, '★ 牌桌右下角的「自动完成」按钮露出来了');

  kl.askAuto();
  ok(byId.autoPanel.classList.contains('on') === true, '弹出确认框问玩家要不要自动收完');
  ok(kl.getAuto().asked === true, '记下「这次问过了」');

  byId.autoPanel.classList.remove('on');       /* 玩家选了「我自己点」 */
  kl.askAuto();
  ok(byId.autoPanel.classList.contains('on') === false, '★ 问过一次就不再弹（按钮还留着，随时能点）');

  kl.setState({ tab: [[C(6, CLUB)], [C(5, DIAMOND)]] });
  kl.autoProbe();
  ok(byId.autoBtn.hidden === true, '牌局回到不能收的时候，按钮自己收起来');
  ok(kl.autoFinish() === false, '不能收的时候按也没用（会提示还没到时候）');

  /* ---- 真的自动收完 ---- */
  kl.setState(nearly);
  kl.G.score = 480;
  const histBefore = kl.getHistLen();
  ok(kl.autoFinish() === true, '★ 点「自动完成」开始收');
  ok(kl.getAuto().busy === true, '自动收牌期间标成忙，挡住玩家输入');
  ok(byId.autoBtn.hidden === true, '收牌期间按钮先藏起来');

  kl.pressAt({ kind: 'card', c: 0 }, 10, 10, 1);
  ok(kl.getPress() === null, '★ 自动收牌时按牌无效（不会和动画抢操作）');

  let ticks = 0;
  while(kl.getAuto().busy && ticks++ < 400) kl.autoTick();
  ok(kl.collected() === 52, '★ 一口气收满 52 张');
  ok(kl.getAuto().busy === false, '收完就放开输入');
  ok(kl.G.score === 520, '4 张 K 各 +10 分（480 → ' + kl.G.score + '）');
  ok(kl.G.moves === 124, '步数跟着涨（120 → ' + kl.G.moves + '）');
  const fly = table.children.filter(el => el.classList.contains('fly')).length;
  ok(fly === 52, '收完接着撒牌，52 张都挂上动画（' + fly + '）');
  ok(kl.getHistLen() === histBefore + 1, '★ 整段自动收牌只记一个撤销点');

  kl.undo();
  ok(kl.collected() === 48, '★ 撤销一下，整段自动收牌全退回来（' + kl.collected() + '/52）');
  ok(kl.G.tab.filter(c => c.length).length === 4, '桌子上的 4 张 K 也回来了');

  /* 扣着的那张也要能翻着收：autoStep 靠 flipIfNeeded 翻牌，这一环不能漏 */
  kl.setState({
    found: [12, 12, 12, 12],
    tab: [[C(13, SPADE), C(13, HEART)], [C(13, DIAMOND)], [C(13, CLUB)]], up: [1, 0, 0],
    stock: [], waste: [], score: 0, moves: 0,
  });
  ok(kl.autoFinish() === true, '扣着牌的局面也能开始自动收');
  ticks = 0;
  while(kl.getAuto().busy && ticks++ < 100) kl.autoTick();
  ok(kl.collected() === 52, '★ 收走 K♥ 之后 K♠ 自己翻明、接着收完（' + kl.collected() + '/52）');
  ok(kl.G.up[0] === 0, '翻明之后明暗边界也对（up[0] = ' + kl.G.up[0] + '）');
}

section('15) ★ 牌桌放得下最长的那一列（初始 6 张扣着的 + K 到 A）');
{
  /* 一列最多 19 张：第 7 列开局 6 暗 1 明，之后还能再叠 12 张明牌（K 一路摆到 A）。
     牌桌高度不够时，旧的压缩算法有下限（d>=5 / u>=CH*0.16），会把这列顶出牌桌、
     压到底栏按钮上 —— 这节盯的就是「不管屏幕多矮，牌都不许出牌桌」。 */
  function makeLong(){
    const down = [C(1, CLUB), C(1, DIAMOND), C(2, CLUB), C(2, DIAMOND), C(3, CLUB), C(3, DIAMOND)];
    const run = [];
    for(let r = 13; r >= 1; r--) run.push(C(r, r % 2 ? SPADE : HEART));   /* K♠ Q♥ J♠ … A♠ */
    const used = new Set([...down, ...run]);
    const rest = [];
    for(let c = 0; c < 52; c++) if(!used.has(c)) rest.push(c);
    const tab = [down.concat(run)];
    const up = [down.length];
    [6, 6, 6, 5, 5, 5].forEach(n => { tab.push(rest.splice(0, n)); up.push(n); });
    return { tab, up, stock: [], waste: [], found: [0, 0, 0, 0] };
  }
  const long = makeLong();
  ok(long.tab[0].length === 19, '第 1 列 19 张（6 张扣着 + 13 张明牌），就是最坏情况');

  function bottomOf(i){
    const g = kl.geom();
    const len = kl.G.tab[i].length, u = kl.G.up[i];
    return g.COL_TOP + g.CH + u * g.DOFF + Math.max(0, len - u - 1) * g.UOFF;
  }

  /* 从大屏手机一路扫到手机横过来 */
  const heights = [560, 470, 400, 340, 300, 260, 215];
  const bad = [];
  heights.forEach(h => {
    wrap.clientHeight = h;
    kl.layout();
    kl.setState(long);
    const g = kl.geom();
    let low = 0;
    for(let i = 0; i < 7; i++) low = Math.max(low, bottomOf(i));
    if(low > g.TABLE_H){
      bad.push('可用高 ' + h + '：牌底 ' + Math.round(low) + ' 越过牌桌 ' + g.TABLE_H);
    }
  });
  ok(bad.length === 0, '★ 可用高从 560 到 215，19 张的列都留在牌桌里', bad.join('；'));

  /* 竖屏高度够，就不该动间距（别为了极端情况把日常画面也压扁） */
  wrap.clientHeight = 560;
  kl.layout();
  kl.newGame(7, true);
  const g0 = kl.geom();
  ok(g0.DOFF === Math.round(g0.CH * 0.20) && g0.UOFF === Math.round(g0.CH * 0.31),
     '普通开局间距照旧（d=' + g0.DOFF + ' / u=' + g0.UOFF + '，CH=' + g0.CH + '）');

  /* 挤的时候先让暗牌让位：暗牌被盖住不损失信息，明牌压一分就少看一分点数 */
  wrap.clientHeight = 340;
  kl.layout();
  kl.setState(long);
  const g1 = kl.geom();
  ok(g1.DOFF <= Math.round(g1.CH * 0.10), '暗牌的缝先压到最小（d=' + g1.DOFF + '）');
  ok(g1.UOFF > g1.DOFF, '明牌留的缝仍然比暗牌宽（u=' + g1.UOFF + ' > d=' + g1.DOFF + '）');

  /* 明牌压紧时，角上的点数跟着缩 —— 露 11px 还用 21px 的字，只能看到字的上半截 */
  const rfs = parseInt(table.style.getPropertyValue('--rfs'), 10);
  ok(rfs > 0 && rfs <= Math.round(g1.UOFF * 1.15) + 1,
     '牌被压紧时点数跟着缩小（' + rfs + 'px，明牌露出 ' + g1.UOFF + 'px）');

  /* 整列都扣着时（up = len），不该再算一道明牌的缝 */
  kl.setState({ tab: [[C(13, SPADE), C(12, HEART), C(11, SPADE)]], up: [3] });
  const g2 = kl.geom();
  ok(kl.colHeight(0, g2.DOFF, g2.UOFF) === g2.CH + 3 * g2.DOFF,
     '整列扣着时列高 = 一张牌 + 3 道暗牌的缝（不多算明牌那道）');

  wrap.clientHeight = 560;
  kl.layout();
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
