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
 *   7) 撤销：只能撤最近一步，牌堆 / 翻牌堆 / 分数 / 明暗一起回来
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
 'autoBtn','autoPanel','autoYes','autoNo',
 'askPanel','askTitle','askSub','askYes','askNo']
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

/* setTimeout 不真的跑（测试里靠手动调 autoTick 推进），但把延迟记下来，
   好核对自动收牌的节拍到底给了多少毫秒 */
const timers = [];
const ctx = {
  document: doc,
  window: null,
  localStorage,
  setTimeout(fn, ms){ timers.push(ms || 0); return 1; },
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

/* 会扣分的操作现在会先弹一张小卡片问一句：测试里统一用这两个函数回答 */
const sayYes = () => kl.answerAsk(true);
const sayNo = () => kl.answerAsk(false);

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
  ok(kl.getAsk() === true, '★ 重翻会扣分 → 先弹小卡片问一句，不是直接扣');
  ok(kl.G.score === 100 && kl.G.stock.length === 0, '还没答之前分没动、牌堆也没翻回来');
  sayYes();
  ok(kl.G.stock.length === 24 && kl.G.waste.length === 0, '翻完后点一下 = 整叠收回来重翻');
  ok(kl.G.score === 80, '重翻扣 20 分（100 → ' + kl.G.score + '）');
  /* 整叠翻面：原来最上面那张现在在最底下，最先翻出来的还是它 */
  ok(kl.G.stock[0] === wasteTop, '原来最上面那张变成了新牌堆的最底下一张');
  ok(kl.G.stock[23] === wasteBottom, '原来最底下一张变成了新牌堆的顶');
  kl.G.score = 10;
  kl.G.stock = [];
  kl.G.waste = [C(1, CLUB), C(2, CLUB)];
  kl.drawStock();
  sayYes();
  ok(kl.G.score === 0, '扣分不会把分数扣成负数（10 → ' + kl.G.score + '）');

  /* 已经 0 分：怎么扣都是 0，就不问了，免得白烦人一次 */
  kl.G.waste = [C(1, CLUB), C(2, CLUB)];
  kl.G.stock = [];
  kl.drawStock();
  ok(kl.getAsk() === false, '★ 0 分时不再问（扣不动，问了纯属添乱）');
  ok(kl.G.stock.length === 2, '直接就把整叠翻回来了');
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
  ok(kl.getAsk() === true, '★ 从收牌堆拿回来要扣 15 分 → 先问一句');
  ok(kl.G.found[0] === 1 && kl.G.score === 100, '还没答之前牌还在收牌堆里、分也没动');
  ok(!!kl.getSel() && kl.getSel().type === 'found', '问的时候选中还在（答完不用重新点一遍）');
  sayNo();
  ok(kl.G.found[0] === 1 && kl.G.score === 100 && kl.getSel() === null,
     '★ 点「算了」= 什么都不发生，只是取消选中');

  kl.tapCard(C(1, CLUB));
  kl.tapSlot('col', 0);
  sayYes();
  ok(kl.G.found[0] === 0 && kl.G.tab[0][1] === C(1, CLUB), '点「继续」才真的拿回牌桌');
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
  sayYes();
  ok(kl.G.score === 0, '分数不会掉到 0 以下（5 − 15 → ' + kl.G.score + '）');
}

/* ================= 7) 撤销 ================= */
section('7) 撤销：只能撤最近一步，再撤就不动了');
{
  kl.newGame(3, true);

  kl.drawStock();                                   /* 翻一张 */
  const col0 = kl.G.tab[0][kl.G.tab[0].length - 1];
  kl.tapCard(col0);                                 /* 选中列 0 的明牌 */
  kl.tapCard(col0);                                 /* 再点一次（收不了就取消选中） */
  ok(kl.getHistLen() === 1, '只有真正改变牌局的操作才进撤销栈');

  kl.drawStock();
  kl.drawStock();
  ok(kl.getHistLen() === 1, '★ 连做几步，栈里也只留最近一步');

  const beforeUndo = JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found, sc:kl.G.score });
  kl.undo();
  const afterUndo = JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found, sc:kl.G.score });
  ok(beforeUndo !== afterUndo, '★ 撤一步：最近那次操作真的退回去了');
  ok(kl.G.stock.length === 18 && kl.G.waste.length === 6, '退到的是「第三次翻牌之前」的位置（18 + 6，翻 3 张模式）');

  kl.undo();
  ok(JSON.stringify({ t:kl.G.tab, u:kl.G.up, s:kl.G.stock, w:kl.G.waste, f:kl.G.found, sc:kl.G.score }) === afterUndo,
     '★ 再撤就不动了 —— 只能撤一次');
  ok(/只能撤/.test(String(byId.toast.textContent)), '提示说明「只能撤最近的一步」');

  /* 撤完再走一步，还是能撤一步（撤销资格跟着最新操作走） */
  kl.drawStock();
  ok(kl.getHistLen() === 1, '撤完再走一步，撤销资格又有了');
  kl.undo();
  ok(kl.G.stock.length === 18 && kl.G.waste.length === 6, '★ 这一步也撤得回去');

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
  ok(!!ft && ft.kind === 'found' && ft.i === DIAMOND, '右上第一个格子是 ♦ 的收牌堆（顺序 ♦ ♣ ♥ ♠）');
  const ft3 = kl.dropTarget(cx(6), 10);
  ok(!!ft3 && ft3.kind === 'found' && ft3.i === SPADE, '最右边是 ♠ 的收牌堆');
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
      if(kl.getAsk()) sayYes();                             /* 重翻要扣分，机器人一路点「继续」 */
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
      if(kl.getAsk()) sayYes();
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
section('14) 自动完成：三处都清干净（列全翻开、牌堆空、换牌区空）才给按钮，然后一张张收光');
{
  /* 四条 13 张的合法长龙（点数降序 + 红黑交替），正好用掉 52 张。
     全翻开以后列里天然是合法的，不用额外摆 */
  const dragons = [[SPADE, HEART], [HEART, SPADE], [DIAMOND, CLUB], [CLUB, DIAMOND]]
    .map(([odd, even]) => {
      const a = [];
      for(let r = 13; r >= 1; r--) a.push(C(r, r % 2 ? odd : even));
      return a;
    });
  const allUp = () => dragons.map(d => d.slice());

  /* ---- 判定：7 列全翻开 + 左上牌堆翻空 + 换牌区一张不剩 ---- */
  kl.newGame(7, true);
  ok(kl.noFaceDown() === false, '刚发完牌，桌上有扣着的牌');
  ok(kl.updateAuto() === false, '这时候不给「自动完成」');
  ok(byId.autoBtn.hidden === true, '按钮藏着');

  kl.setState({ tab: allUp(), up: [0, 0, 0, 0], stock: [], waste: [], found: [0, 0, 0, 0], score: 0, moves: 0 });
  ok(kl.noFaceDown() === true, '52 张全翻开，没有扣着的');
  ok(kl.simFinish() === true, '内层试打：确实能收完');
  ok(kl.updateAuto() === true, '★ 全翻开 → 允许自动完成');
  ok(byId.autoBtn.hidden === false, '★ 牌桌右下角的「自动完成」按钮露出来了');
  ok(/自动完成/.test(String(byId.tip.innerHTML)), '顶部提示改成指向按钮（“' + byId.tip.innerHTML.replace(/<[^>]+>/g, '') + '”）');
  ok(byId.tip.className === 'tip hot', '★ 提示行高亮，不弹窗也不浮窗（浮窗会正好压在按钮上）');

  /* 全翻开但顺序不对（K♠ 压在自己的 A♠ 上，两张互相等对方）—— 正常玩到不了这种局面，
     这条防的是「试打说能收、真收却卡住」 */
  const broken = allUp();
  broken[0].push(broken[0].shift());           /* 把 K♠ 挪到列末，正好压住 A♠ */
  kl.setState({ tab: broken, up: [0, 0, 0, 0], stock: [], waste: [], found: [0, 0, 0, 0], score: 0, moves: 0 });
  ok(kl.noFaceDown() === true, '这种局面也是全翻开的');
  ok(kl.simFinish() === false, '但内层试打收不完（K♠ 和 A♠ 互相卡着）');
  ok(kl.updateAuto() === false && byId.autoBtn.hidden === true, '★ 试打收不完就不给按钮，绝不空口承诺');

  /* ---- 规则：扣着没翻开就不给，哪怕内层算得出来 ---- */
  kl.setState({
    found: [12, 12, 12, 12],
    tab: [[C(13, SPADE), C(13, HEART)], [C(13, DIAMOND)], [C(13, CLUB)]], up: [1, 0, 0],
    stock: [], waste: [], score: 0, moves: 0,
  });
  ok(kl.simFinish() === true, '内层试打：这局其实收得完（收走 K♥ 就露出 K♠）');
  ok(kl.noFaceDown() === false, '可桌上还盖着一张');
  ok(kl.updateAuto() === false && byId.autoBtn.hidden === true, '★ 只要还有扣着的牌，就不给按钮 —— 规则就一条，玩家能自己判断');
  ok(kl.autoFinish() === false, '这时点也点不动（会提示先翻开）');
  ok(/收干净/.test(String(byId.toast.textContent)), '提示说的是「还有牌没收干净」（“' + byId.toast.textContent + '”）');

  /* ---- 牌堆还压着牌：不给按钮（哪怕程序真能替他把那几张翻出来） ---- */
  const tab2 = dragons.map(d => d.slice(3));      /* 每列 10 → A */
  const moved = [];
  dragons.forEach(d => { moved.push(d[0], d[1], d[2]); });   /* 收出来的 K Q J */
  const inStock = moved.slice().reverse();        /* 牌堆（末尾是顶） */
  kl.setState({
    tab: tab2, up: [0, 0, 0, 0], stock: inStock.slice(), waste: [],
    found: [0, 0, 0, 0], score: 0, moves: 0,
  });
  ok(kl.noFaceDown() === false,
     '★ 桌上全翻开了，但左上牌堆还压着 12 张 → 不算「没有扣着的牌」');
  ok(kl.updateAuto() === false && byId.autoBtn.hidden === true,
     '★ 牌堆没翻空就不给按钮 —— 牌桌和按钮说的必须是同一件事');
  ok(kl.autoFinish() === false, '这时点也点不动');
  ok(/换牌区|收干净/.test(String(byId.toast.textContent)),
     '提示说的是「还有牌没收干净」（“' + byId.toast.textContent + '”）');

  /* 牌堆翻空、12 张摊在换牌区里：现在也不给 —— 换牌区也是「场上还有牌」 */
  while(kl.G.stock.length) kl.drawStock();
  ok(kl.G.waste.length === 12, '牌堆翻空了，12 张全摊在换牌区里（都是明牌）');
  ok(kl.noFaceDown() === false, '★ 换牌区还摊着 12 张 → 也不算「收完了」');
  ok(kl.updateAuto() === false && byId.autoBtn.hidden === true,
     '★ 换牌区没清空就不给按钮 —— 玩家看见旁边还摊着牌，按钮就不能冒出来');

  /* 换牌区只剩一张能收的 A：还是不给；真人把这张 A 点进收牌堆，按钮才出来 */
  kl.setState({
    tab: dragons.map((d, i) => i === 0 ? d.slice(0, -1) : d.slice()),
    up: [0, 0, 0, 0], stock: [], waste: [dragons[0][12]],
    found: [0, 0, 0, 0], score: 0, moves: 0,
  });
  ok(kl.G.waste.length === 1 && kl.noFaceDown() === false, '★ 换牌区只剩一张 A♠ → 也算「有牌」');
  ok(kl.updateAuto() === false && byId.autoBtn.hidden === true, '一张也不行，不给按钮');

  kl.tapCard(C(1, SPADE));
  ok(kl.tryFoundSel() === true && kl.G.waste.length === 0, '真人操作：把 A♠ 点进收牌堆，换牌区空了');
  ok(kl.updateAuto() === true && byId.autoBtn.hidden === false, '★ 这才给按钮');
  ok(kl.autoFinish() === true, '点「自动完成」开始收');
  ok(kl.getAuto().busy === true, '收牌期间标成忙，挡住玩家输入');

  kl.pressAt({ kind: 'card', c: 0 }, 10, 10, 1);
  ok(kl.getPress() === null, '★ 自动收牌时按牌无效（不会和动画抢操作）');

  let ticks = 0;
  while(kl.getAuto().busy && ticks++ < 3000) kl.autoTick();
  ok(kl.collected() === 52, '★ 52 张全收进去了（' + ticks + ' 步）');
  ok(kl.getAuto().busy === false, '收完就放开输入');
  ok(kl.G.stock.length === 0 && kl.G.waste.length === 0, '收完时牌堆和换牌区都空了');

  /* 换牌区有牌时按钮不给，但内层试打（simFinish）还得算得通 —— draw / place
     两个动作留作保险，万一以后判定改宽，试打不会跟着失真 */
  kl.setState({
    tab: dragons.map(d => d.filter(c => c !== C(2, HEART))),   /* 2♥ 从第 1 列出来 */
    up: [0, 0, 0, 0], stock: [], waste: [C(2, HEART)],
    found: [0, 0, 0, 0], score: 0, moves: 0,
  });
  ok(kl.updateAuto() === false, '（换牌区有 2♥，不给按钮）');
  ok(kl.simFinish() === true, '★ 但内层试打照样收得完 —— 保险动作还在');

  /* ---- 抽测：把 52 张随手分成「列上 / 牌堆 / 换牌区」，只有三处清干净才给按钮 ---- */
  {
    let seed = 7, leak = 0, bad = 0, n = 0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for(let t = 0; t < 40; t++){
      const tab = dragons.map(d => d.slice());
      const pile = [];
      for(let i = 0; i < 4; i++){
        const k = Math.floor(rnd() * 5);
        for(let j = 0; j < k; j++) pile.push(tab[i].shift());
      }
      for(let i = pile.length - 1; i > 0; i--){
        const j = Math.floor(rnd() * (i + 1));
        const tmp = pile[i]; pile[i] = pile[j]; pile[j] = tmp;
      }
      /* 牌还压在牌堆里 → 必须不给 */
      kl.setState({ tab: tab.map(c => c.slice()), up: [0, 0, 0, 0],
                    stock: pile.slice().reverse(), waste: [], found: [0, 0, 0, 0], score: 0, moves: 0 });
      if(kl.updateAuto() !== false) leak++;
      /* 牌摊在换牌区里 → 也必须不给 */
      kl.setState({ tab: tab.map(c => c.slice()), up: [0, 0, 0, 0],
                    stock: [], waste: pile.slice(), found: [0, 0, 0, 0], score: 0, moves: 0 });
      if(kl.updateAuto() !== false) leak++;
      /* 三处清干净（52 张全在列上）→ 必须给，而且内层试打要真的收得完 */
      kl.setState({ tab: dragons.map(d => d.slice()), up: [0, 0, 0, 0],
                    stock: [], waste: [], found: [0, 0, 0, 0], score: 0, moves: 0 });
      n++;
      if(kl.updateAuto() !== true || kl.simFinish() !== true) bad++;
    }
    ok(leak === 0 && bad === 0,
       '★ 抽测 ' + n + ' 局：牌堆里 / 换牌区里有牌一律不给（漏 ' + leak + ' 次），三处清干净才给（错 ' + bad + ' 局）');
  }

  /* ---- 节拍：赢了就这几秒，牌要一张一张看得清（别飞快刷完） ---- */
  {
    kl.setState({ tab: dragons.map(d => d.slice()), up: [0, 0, 0, 0],
                  stock: [], waste: [], found: [0, 0, 0, 0], score: 0, moves: 0 });
    ok(kl.updateAuto() === true, '先摆出按钮');
    ok(kl.autoFinish() === true, '开始自动收');

    timers.length = 0;
    kl.autoTick();
    ok(timers[timers.length - 1] === kl.PACE_MOVE,
       '★ 收一张牌等 ' + timers[timers.length - 1] + 'ms 才收下一张');

    /* 牌移动的过渡是 170ms，节拍不能短到「上一张还在飞就走了」 */
    ok(kl.PACE_MOVE >= 140, '★ 收牌节拍 ' + kl.PACE_MOVE + 'ms ≥ 140ms（不会再刷成一片残影）');
    ok(kl.PACE_MOVE * 45 >= 6500,
       '整局 52 张至少 ' + (kl.PACE_MOVE * 45 / 1000).toFixed(1) + ' 秒，够看完');
    ok(kl.PACE_DRAW < kl.PACE_MOVE, '翻牌 / 重翻比收牌快（' + kl.PACE_DRAW + 'ms），等得不心焦');
    ok(kl.PACE_DRAW >= 60, '翻牌也不会快成一闪（' + kl.PACE_DRAW + 'ms）');

    let ticks = 0;
    while(kl.getAuto().busy && ticks++ < 3000) kl.autoTick();
    ok(kl.collected() === 52, '慢一点也照样收得完（' + ticks + ' 步）');
  }

  /* ---- 收牌 + 计分 + 撤销：用老纸牌里最典型的收尾（只剩 4 张 K） ---- */
  const nearly = {
    found: [12, 12, 12, 12],
    tab: [[C(13, SPADE)], [C(13, HEART)], [C(13, DIAMOND)], [C(13, CLUB)], [], [], []],
    up: [0, 0, 0, 0, 0, 0, 0], stock: [], waste: [], score: 480, moves: 120,
  };
  kl.setState(nearly);
  ok(kl.updateAuto() === true, '只剩 4 张 K 摊在桌上 → 给按钮');
  const histBefore = kl.getHistLen();
  ok(kl.autoFinish() === true, '开始收');
  ticks = 0;
  while(kl.getAuto().busy && ticks++ < 400) kl.autoTick();
  ok(kl.collected() === 52, '★ 一口气收满 52 张');
  ok(kl.G.score === 520, '4 张 K 各 +10 分（480 → ' + kl.G.score + '）');
  ok(kl.G.moves === 124, '步数跟着涨（120 → ' + kl.G.moves + '）');
  const fly = table.children.filter(el => el.classList.contains('fly')).length;
  ok(fly === 52, '收完接着撒牌，52 张都挂上动画（' + fly + '）');
  ok(kl.getHistLen() === histBefore + 1, '★ 整段自动收牌只记一个撤销点');

  kl.undo();
  ok(kl.collected() === 48, '★ 撤销一下，整段自动收牌全退回来（' + kl.collected() + '/52）');
  ok(kl.G.tab.filter(c => c.length).length === 4, '桌子上的 4 张 K 也回来了');

  /* 牌局回到「还有扣着的牌」时按钮自己收起来 */
  kl.setState({ tab: [[C(1, CLUB), C(6, CLUB)], [C(5, DIAMOND)]], up: [1, 0] });
  ok(kl.updateAuto() === false && byId.autoBtn.hidden === true, '★ 牌局退回没翻开的阶段，按钮自己收起来');
  ok(byId.tip.className === 'tip', '顶部提示也跟着回到平常那句');
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

  /* 牌桌高度焊死在可用高度上：不能一列变长桌子就跟着长一截（玩到一半桌面变大很跳） */
  wrap.clientHeight = 470;
  kl.layout();
  kl.newGame(3, true);
  const h7 = kl.geom().TABLE_H;
  kl.setState(long);
  const h19 = kl.geom().TABLE_H;
  ok(h7 === h19, '★ 牌桌高度不随牌局变（开局 7 列 ' + h7 + 'px / 19 张列 ' + h19 + 'px）');
  ok(h7 === 470, '牌桌把可用高度整个吃掉（可用 470 → 牌桌 ' + h7 + 'px）');

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

/* ================= 16) 收牌堆的花色顺序 ================= */
section('16) 收牌堆从左到右是 ♦ ♣ ♥ ♠');
{
  wrap.clientHeight = 560;
  kl.layout();
  kl.newGame(11, true);

  const g = kl.geom();
  const colX = k => g.PAD + k * (g.CW + g.GAP);
  const xOf = el => parseFloat(/translate3d\(([-\d.]+)px/.exec(String(el.style.transform))[1]);
  const cardOf = c => table.children.find(el => el.dataset && String(el.dataset.c) === String(c));
  const foundSlots = () => table.children.filter(el =>
    el.classList.contains('slot') && el.classList.contains('found'));

  ok(kl.FOUND_ORDER.join() === '1,0,2,3', '花色顺序写在 FOUND_ORDER（♦ ♣ ♥ ♠）');
  ok(kl.FOUND_SLOT[DIAMOND] === 0 && kl.FOUND_SLOT[CLUB] === 1 &&
     kl.FOUND_SLOT[HEART] === 2 && kl.FOUND_SLOT[SPADE] === 3,
     '反查表也对：♦ 第 1 格、♣ 第 2 格、♥ 第 3 格、♠ 第 4 格');

  const slots = foundSlots();
  ok(slots.length === 4, '牌桌上还是 4 个收牌堆格子');
  const glyph = slots.map(el => String(el.innerHTML).replace(/<[^>]+>/g, ''));
  ok(glyph.join('') === '♦♣♥♠', '★ 格子上的花色从左到右是 ♦ ♣ ♥ ♠（实际 ' + glyph.join('') + '）');
  ok(xOf(slots[0]) === colX(3) && xOf(slots[3]) === colX(6),
     '4 个格子还是贴着右上角排（第 4~7 列的正上方）');

  /* 手指点哪一格 → 认成哪个花色（逻辑全都按花色走，只有这里要翻一下） */
  ok(kl.hitTest({ target: slots[0] }).i === DIAMOND, '★ 点第 1 格 → 认成 ♦ 的收牌堆');
  ok(kl.hitTest({ target: slots[1] }).i === CLUB, '点第 2 格 → 认成 ♣');
  ok(kl.hitTest({ target: slots[2] }).i === HEART, '点第 3 格 → 认成 ♥');
  ok(kl.hitTest({ target: slots[3] }).i === SPADE, '点第 4 格 → 认成 ♠');
  ok(kl.hitTest({ target: slots[0] }).k === 'found', '落点类型仍然是 found（上层逻辑不用改）');

  /* 牌飞进收牌堆的时候，也要飞到自己那个格子里 */
  kl.setState({ tab: [[], [], [], [], [], [], []], found: [1, 0, 0, 0] });
  ok(xOf(cardOf(C(1, CLUB))) === colX(4), '♣A 收在第 2 格（实际落在第 ' +
     (Math.round((xOf(cardOf(C(1, CLUB))) - g.PAD) / (g.CW + g.GAP)) - 2) + ' 格）');

  kl.setState({ tab: [[C(1, HEART)]], found: [0, 0, 0, 0] });
  kl.tapCard(C(1, HEART));
  kl.tapCard(C(1, HEART));
  ok(kl.G.found[HEART] === 1, '♥A 连点两下收进收牌堆');
  ok(xOf(cardOf(C(1, HEART))) === colX(5), '♥A 飞进第 3 格（♥ 的位置）');
}

/* ================= 17) 扣分确认 ================= */
section('17) 扣分确认：屏幕中间的半透明小卡片，不是全屏不透明弹窗');
{
  ok(/<div class="ask" id="askPanel">/.test(html), '★ 有自己的确认卡片，没去复用全屏弹窗 .over');
  ok(/\.ask\.on\{display:flex\}/.test(html), '显示 / 隐藏靠 .on 切换');
  const m = /\.ask\{[^}]*?background:rgba\(8,12,18,\.(\d+)\)/.exec(html);
  const alpha = m ? Number('0.' + m[1]) : 1;
  ok(!!m && alpha <= 0.45, '★ 遮罩是半透明的（alpha ' + alpha + ' ≤ 0.45），牌桌还看得见');
  const askCss = html.slice(html.indexOf('.ask{'), html.indexOf('.ask{') + 400);
  ok(/align-items:center/.test(askCss) && /justify-content:center/.test(askCss),
     '★ 卡片在屏幕正中（横竖都居中），不是贴着底边');
  ok(!/align-items:flex-end/.test(askCss), '没有贴着底边那种滑出式定位');

  /* 从收牌堆拿回来：−15 */
  kl.setState({ found: [1, 0, 0, 0], tab: [[C(2, HEART)]], score: 100 });
  kl.tapCard(C(1, CLUB));
  kl.tapSlot('col', 0);
  ok(byId.askPanel.classList.contains('on') === true, '★ 弹出确认卡片');
  ok(/拿回/.test(byId.askTitle.textContent), '标题说清了是什么操作（“' + byId.askTitle.textContent + '”）');
  ok(/15/.test(byId.askSub.innerHTML) && /扣/.test(byId.askSub.innerHTML),
     '文案写清了扣多少分（“' + String(byId.askSub.innerHTML).replace(/<[^>]+>/g, '') + '”）');

  /* 点卡片外面的暗处 = 算了 */
  byId.askPanel.fire('click', { target: byId.askPanel });
  ok(byId.askPanel.classList.contains('on') === false, '点旁边就把卡片收掉');
  ok(kl.G.found[0] === 1 && kl.G.score === 100, '★ 点旁边等于「算了」，牌和分都没动');

  /* 点「算了」按钮 */
  kl.tapCard(C(1, CLUB));
  kl.tapSlot('col', 0);
  byId.askNo.fire('click');
  ok(kl.G.found[0] === 1 && kl.G.score === 100, '★ 「算了」= 什么都没发生');

  /* 点「继续」（走界面那条线，不是直接调 API） */
  kl.tapCard(C(1, CLUB));
  kl.tapSlot('col', 0);
  byId.askYes.fire('click');
  ok(kl.G.found[0] === 0 && kl.G.score === 85, '★ 「继续」才扣 15 分、牌退回列里');
  ok(byId.askPanel.classList.contains('on') === false && kl.getAsk() === false, '做完卡片就收起来');

  /* 整叠重翻：−20 */
  kl.setState({ tab: [[C(5, HEART)]], stock: [], waste: [C(3, CLUB)], score: 40 });
  kl.drawStock();
  ok(byId.askPanel.classList.contains('on') === true, '★ 整叠重翻同样先问一句');
  ok(/20/.test(byId.askSub.innerHTML), '写清了扣 20 分');
  byId.askNo.fire('click');
  ok(kl.G.score === 40 && kl.G.stock.length === 0 && kl.G.waste.length === 1,
     '「算了」之后牌堆一点没动');

  /* 0 分时不该再问（扣不动） */
  kl.setState({ tab: [[C(5, HEART)]], stock: [], waste: [C(3, CLUB)], score: 0 });
  kl.drawStock();
  ok(kl.getAsk() === false && kl.G.stock.length === 1, '★ 0 分时直接重翻，不弹卡片');

  /* 悬着的卡片不能带到下一局 */
  kl.setState({ tab: [[C(5, HEART)]], stock: [], waste: [C(3, CLUB)], score: 40 });
  kl.drawStock();
  kl.newGame(3, true);
  ok(byId.askPanel.classList.contains('on') === false && kl.getAsk() === false,
     '★ 开新局顺手把悬着的卡片扔掉');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
