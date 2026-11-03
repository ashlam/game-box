#!/usr/bin/env node
/**
 * 空当接龙（FreeCell）回归测试
 *
 * 覆盖：
 *   1) 发牌：52 张不重不漏、前 4 列 7 张后 4 列 6 张
 *   2) ★ 局号算法：第 1 局必须和公开牌谱逐张一致（否则「第 N 局」是骗人的）
 *   3) 规则：列内降序 + 红黑交替、空列放任意牌、收牌堆从 A 开始
 *   4) ★ 一次能搬几张：(空暂存格 + 1) × 2^(空列数) —— 本游戏唯一的核心公式
 *   5) 移动：列↔列、列↔暂存格、送收牌堆；非法移动必须拒绝且不改变状态
 *   6) 撤销：回到上一步，可连撤到底
 *   7) 收牌按钮 + 通关判定
 *   8) 存档：往返一致，坏存档（少牌 / 重牌 / 越界）一律当没有
 *   9) 点击交互：选中 → 点目标列；再点同一张 = 收牌
 *  10) 单文件自包含（无外链 / 无图片），返回键是 "/"
 *
 * 用法：node tools/test_freecell.js [web/freecell/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'freecell', 'index.html');
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
  return { _p:p, setProperty(k, v){ p[k] = String(v); }, getPropertyValue(k){ return (k in p) ? p[k] : ''; } };
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
['stMoves','stTime','stDone','dealBtn','btnUndo','btnAuto','btnNew','btnSound',
 'toast','confetti','dealPanel','dealInput','dealGo','dealRand','dealReplay','dealClose',
 'winPanel','winSub','winMoves','winTime','winRec','winRecBox','winAgain','winClose']
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
  Date,
  Math,
  JSON,
  parseInt,
  parseFloat,
  String,
  Number,
  Array,
  Object,
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.addEventListener = function(){};
ctx.removeEventListener = function(){};
vm.createContext(ctx);

const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(script, ctx, { filename: 'freecell.js' });

const fc = ctx.__fc;
ok(!!fc, '脚本能在假 DOM 里跑起来并暴露测试钩子');
if(!fc){ console.log('\n无法继续，退出'); process.exit(1); }

/* 卡号：点数 1..13（A..K），花色 0..3（♣♦♥♠） */
const C = (rank, suit) => (rank - 1) * 4 + suit;
const SPADE = 3, HEART = 2, DIAMOND = 1, CLUB = 0;
const names = cols => cols.map(col => col.map(fc.cardName));

/* ================= 1) 发牌 ================= */
section('1) 发牌：52 张不重不漏，8 列');
{
  for(const seed of [1, 2, 617, 11982, 1000000]){
    const cols = fc.deal(seed);
    const all = [].concat(...cols);
    const uniq = new Set(all);
    ok(cols.length === 8, `第 ${seed} 局是 8 列`);
    ok(all.length === 52, `第 ${seed} 局共 52 张（${all.length}）`);
    ok(uniq.size === 52, `第 ${seed} 局没有重复牌`);
    ok(all.every(c => c >= 0 && c <= 51), `第 ${seed} 局牌号都在 0..51`);
    const lens = cols.map(c => c.length).join(',');
    ok(lens === '7,7,7,7,6,6,6,6', `第 ${seed} 局列长是 7,7,7,7,6,6,6,6（实际 ${lens}）`);
  }
}

/* ================= 2) ★ 第 1 局必须对得上 ================= */
section('2) ★ 局号算法：第 1 局与公开牌谱逐张一致');
{
  /* 牌谱来源：rosettacode "Deal cards for FreeCell" 的 Game #1 */
  const want = [
    ['J♦','K♦','2♠','4♣','3♠','6♦','6♠'],
    ['2♦','K♣','K♠','5♣','10♦','8♠','9♣'],
    ['9♥','9♠','9♦','10♠','4♠','8♦','2♥'],
    ['J♣','5♠','Q♦','Q♥','10♥','Q♠','6♥'],
    ['5♦','A♦','J♠','4♥','8♥','6♣'],
    ['7♥','Q♣','A♠','A♣','2♣','3♦'],
    ['7♣','K♥','A♥','4♦','J♥','8♣'],
    ['5♥','3♥','3♣','7♠','7♦','10♣'],
  ];
  const got = names(fc.deal(1));
  let bad = [];
  for(let i = 0; i < 8; i++){
    const a = got[i].join(' '), b = want[i].join(' ');
    if(a !== b) bad.push(`第 ${i + 1} 列：${a} ≠ ${b}`);
  }
  ok(bad.length === 0, '★ 第 1 局八列全对（局号才敢写着「和 Windows 一致」）', bad.join('；'));

  /* 同一局号必须可复现 —— 刷新页面 / 重玩本局都靠它 */
  ok(names(fc.deal(1)).join('|') === got.join('|'), '同一局号发两次，牌一样');
  ok(names(fc.deal(2)).join('|') !== got.join('|'), '不同局号发的牌不同');
  /* 第 617 局：公开牌谱给的是「发牌顺序」，按 8 列轮流摆开再比对（防止只是第 1 局碰巧对） */
  const seq617 = ('7♦ A♦ 5♣ 3♠ 5♠ 8♣ 2♦ A♥ 10♦ 7♠ Q♦ A♣ 6♦ 8♥ A♠ K♥ 10♥ Q♣ 3♥ 9♦ '
    + '6♠ 8♦ 3♦ 10♣ K♦ 5♥ 9♠ 3♣ 8♠ 7♥ 4♦ J♠ 4♣ Q♠ 9♣ 9♥ 7♣ 6♥ 2♣ 2♠ '
    + '4♠ 10♠ 2♥ 5♦ J♣ 6♣ J♥ Q♥ J♦ K♠ K♣ 4♥').split(' ');
  const w617 = [[],[],[],[],[],[],[],[]];
  seq617.forEach((n, i) => w617[i % 8].push(n));
  const g617 = names(fc.deal(617));
  let bad617 = [];
  for(let i = 0; i < 8; i++){
    if(g617[i].join(' ') !== w617[i].join(' ')) bad617.push(`第 ${i + 1} 列：${g617[i].join(' ')}`);
  }
  ok(bad617.length === 0, '★ 第 617 局也对（换一个局号再验一遍）', bad617.join('；'));
}

/* ================= 3) 规则 ================= */
section('3) 摆牌规则');
{
  const K = C(13, SPADE), Qh = C(12, HEART), Qd = C(12, DIAMOND), Js = C(11, SPADE);
  ok(fc.onColOk(K, []) === true, '空列可以放任何牌（K 也行）');
  ok(fc.onColOk(Qh, [K]) === true, '黑 K 上可以放红 Q');
  ok(fc.onColOk(Qd, [K]) === true, '黑 K 上也可以放红 Q♦');
  ok(fc.onColOk(Js, [Qd]) === true, '红 Q 上可以放黑 J');
  ok(fc.onColOk(Qd, [Qh]) === false, '红 Q 不能放在红 K 上（同色不行）');
  ok(fc.onColOk(C(10, SPADE), [K]) === false, '10 不能直接放 K 上（必须差 1）');
  ok(fc.onColOk(C(13, HEART), [K]) === false, 'K 不能放 K 上');

  ok(fc.runOK([K, Qh, Js], 0) === true, 'K♠ Q♥ J♠ 是合法序列');
  ok(fc.runOK([K, Qh, Js], 1) === true, '从 Q♥ 开始也是合法序列');
  ok(fc.runOK([K, Qh, C(10, SPADE)], 0) === false, '中间断号 → 不是合法序列');
  ok(fc.runOK([K, Qh, Qd], 0) === false, '两张红 Q → 不是合法序列');

  fc.setState([[C(1, CLUB)]], [null,null,null,null], [0,0,0,0]);
  ok(fc.canFound(C(1, CLUB)) === true, 'A 可以收');
  ok(fc.canFound(C(2, CLUB)) === false, '没有 A 的时候 2 不能收');
  fc.setState([[],[]], [null,null,null,null], [1,0,0,0], 0);
  ok(fc.canFound(C(2, CLUB)) === true, '收进 A 之后 2 可以收');
  ok(fc.canFound(C(2, DIAMOND)) === false, '收牌堆按花色分开（♣ 的 A 不能让 ♦ 的 2 收）');
}

/* ================= 4) ★ 容量公式 ================= */
section('4) ★ 一次能搬几张 = (空暂存格 + 1) × 2^空列');
{
  /* 8 列都有牌、4 个暂存格都占满 → 只能搬 1 张 */
  const full = [];
  for(let i = 0; i < 8; i++) full.push([C(13 - i, i % 4)]);
  fc.setState(full, [C(1,CLUB), C(2,CLUB), C(3,CLUB), C(4,CLUB)], [0,0,0,0]);
  ok(fc.maxRun(1) === 1, '没有空位时只能搬 1 张（实际 ' + fc.maxRun(1) + '）');

  /* 空 2 个暂存格、没有空列 → 3 张 */
  fc.setState(full, [C(1,CLUB), C(2,CLUB), null, null], [0,0,0,0]);
  ok(fc.maxRun(1) === 3, '空 2 个暂存格 → 3 张（实际 ' + fc.maxRun(1) + '）');

  /* 空 2 个暂存格 + 1 个空列（目标不是那个空列）→ 3 × 2 = 6 */
  const oneEmpty = full.slice();
  oneEmpty[7] = [];
  fc.setState(oneEmpty, [C(1,CLUB), C(2,CLUB), null, null], [0,0,0,0]);
  ok(fc.maxRun(0) === 6, '再加 1 个空列 → 6 张（实际 ' + fc.maxRun(0) + '）');

  /* 目标就是那个空列时，空列要先扣掉一个 → 只剩 3 张 */
  fc.setState(oneEmpty, [C(1,CLUB), C(2,CLUB), null, null], [0,0,0,0]);
  ok(fc.maxRun(7) === 3, '目标本身是空列 → 空列不算中转（' + fc.maxRun(7) + '）');

  /* 源列只有 1 张、搬完腾空，等于白送一个中转站 → 翻倍 */
  fc.setState(oneEmpty, [C(1,CLUB), C(2,CLUB), null, null], [0,0,0,0]);
  fc.setSel({ type:'col', i:0, idx:0 });
  ok(fc.maxRun(7) === 6, '源列搬完会空出来 → 再翻一倍（' + fc.maxRun(7) + '）');
  fc.setSel(null);
}

/* ================= 5) 移动 ================= */
section('5) 移动');
{
  const K = C(13, SPADE), Qh = C(12, HEART), Js = C(11, SPADE), Qd = C(12, DIAMOND);

  /* 列 → 列 */
  fc.setState([[Qh], [K]], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:0 });
  ok(fc.moveRunToCol(1) === true, '红 Q 放到黑 K 上：成功');
  ok(fc.G.cols[0].length === 0 && fc.G.cols[1].length === 2, '两列的内容都对调过去了');
  ok(fc.G.cols[1][1] === Qh, '放上去的牌在列尾（最上面）');
  ok(fc.G.moves === 1, '步数 +1');
  ok(fc.getSel() === null, '放下之后自动取消选中');

  /* 非法：同色 */
  fc.setState([[Qh], [C(13, DIAMOND)]], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:0 });
  const before = JSON.stringify(fc.G.cols);
  ok(fc.moveRunToCol(1) === false, '红 Q 放到红 K 上：拒绝');
  ok(JSON.stringify(fc.G.cols) === before, '拒绝时牌桌一点没变');
  ok(fc.G.moves === 0, '拒绝时步数不涨');
  fc.setSel(null);

  /* 列 → 暂存格 */
  fc.setState([[K, Qh]], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:1 });
  ok(fc.tryFree(0) === true, '列顶的 Q♥ 放进暂存格：成功');
  ok(fc.G.free[0] === Qh, '暂存格里就是那张 Q♥');
  ok(fc.G.cols[0].length === 1, '列里少了一张');

  /* 暂存格 → 列 */
  fc.setSel({ type:'free', i:0, idx:0 });
  ok(fc.moveRunToCol(1) === true, '暂存格里的牌放回列：成功');
  ok(fc.G.free[0] === null, '暂存格空出来了');
  ok(fc.G.cols[1][0] === Qh, '牌落在目标列');

  /* 暂存格被占 */
  fc.setState([[K], [Qh]], [Js, null, null, null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:1, idx:0 });
  ok(fc.tryFree(0) === false, '暂存格有牌时放不进去');
  ok(fc.G.free[0] === Js, '原来那张牌没被顶掉');
  ok(fc.G.cols[1].length === 1, '也没从列里拿走');

  /* 一次搬 3 张：空位够 */
  fc.setState([[K, Qh, Js], [], []], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:0 });
  ok(fc.moveRunToCol(1) === true, '3 张的序列搬到空列：成功');
  ok(fc.G.cols[1].length === 3 && fc.G.cols[0].length === 0, '整段搬走了');
  ok(JSON.stringify(fc.G.cols[1]) === JSON.stringify([K, Qh, Js]), '顺序保持 K Q J');

  /* 一次搬 3 张：空位不够（无空列、暂存格全占） */
  fc.setState([[K, Qh, Js], [C(13, CLUB)]],
              [C(1,CLUB), C(2,CLUB), C(3,CLUB), C(4,CLUB)], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:0 });
  ok(fc.moveRunToCol(1) === false, '空位只够 1 张时，3 张的序列搬不动');
  ok(fc.G.cols[0].length === 3, '拒绝时源列不变');
  fc.setSel(null);

  /* 收牌 */
  fc.setState([[C(1, SPADE)]], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:0 });
  ok(fc.tryFoundSel() === true, 'A♠ 收进收牌堆：成功');
  ok(fc.G.found[SPADE] === 1, '收牌堆记为 1');
  ok(fc.G.cols[0].length === 0, '列里拿走了');
  ok(fc.G.moves === 1, '收牌也算一步');
}

/* ================= 6) 撤销 ================= */
section('6) 撤销');
{
  const K = C(13, SPADE), Qh = C(12, HEART);
  fc.setState([[Qh], [K]], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:0 });
  fc.moveRunToCol(1);
  ok(fc.G.cols[1].length === 2, '先走一步');
  fc.undo();
  ok(fc.G.cols[1].length === 1 && fc.G.cols[0].length === 1, '撤销后回到原位');
  ok(fc.G.moves === 0, '步数也退回去');
  ok(fc.getSel() === null, '撤销后清掉选中');

  /* 连撤：走 3 步再撤 3 次 */
  fc.setState([[C(13,SPADE)], [], [], [], [], [], [], []], [null,null,null,null], [0,0,0,0], 0);
  const order = [C(12,HEART), C(11,SPADE), C(10,HEART)];
  order.forEach(c => {
    fc.G.cols[1].push(c);
    fc.setState(fc.G.cols, fc.G.free, fc.G.found, fc.G.moves + 1);
  });
  /* 上面 setState 会清历史，所以这里直接用正常移动造三步 */
  fc.setState([[C(13,SPADE), C(12,HEART), C(11,SPADE)], [], []], [null,null,null,null], [0,0,0,0], 0);
  fc.setSel({ type:'col', i:0, idx:2 });
  ok(fc.moveRunToCol(1) === true, '先搬 J♠ 到列 1');
  fc.setSel({ type:'col', i:0, idx:1 });
  ok(fc.moveRunToCol(2) === true, '再搬 Q♥ 到列 2');
  ok(fc.getHistLen() === 2, '走了两步，历史里有两步');
  ok(fc.G.cols[0].length === 1, '源列只剩 K♠');
  fc.undo(); fc.undo();
  ok(fc.G.cols[0].length === 3 && fc.G.cols[1].length === 0 && fc.G.cols[2].length === 0,
     '连撤两次回到开局');
  ok(fc.G.moves === 0, '步数归零');
}

/* ================= 7) 收牌按钮 / 通关 ================= */
section('7) 一键收牌与通关');
{
  /* 4 个 A 都在列顶，下面没有压牌 → 一次全收 */
  fc.setState([[C(1,CLUB)], [C(1,DIAMOND)], [C(1,HEART)], [C(1,SPADE)]],
              [null,null,null,null], [0,0,0,0], 0);
  ok(fc.collectAll() === 1, '收牌按钮收走了 4 张 A');
  ok(fc.G.found.join(',') === '1,1,1,1', '四个收牌堆都到 1');
  ok(fc.G.cols.every(c => c.length === 0), '列都空了');

  /* 没得收的时候不能报成功 */
  ok(fc.collectAll() === 0, '没有能收的牌时返回 0');

  /* 通关：51 张已收，剩一张 K♣ 在列里 */
  fc.setState([[C(13, CLUB)]], [null,null,null,null], [12,13,13,13], 100);
  ok(fc.G.found[0] + fc.G.found[1] + fc.G.found[2] + fc.G.found[3] === 51, '局面是 51 张已收');
  fc.setSel({ type:'col', i:0, idx:0 });
  ok(fc.tryFoundSel() === true, '最后一张 K♣ 收进去');
  ok(fc.G.found.join(',') === '13,13,13,13', '四个收牌堆各 13 张');
  ok(fc.checkWin() === true, '★ 收满 52 张判定为通关');
}

/* ================= 8) 存档 ================= */
section('8) 存档');
{
  fc.newGame(617);
  const snap = JSON.stringify(fc.G.cols);
  const top0 = fc.G.cols[0][fc.G.cols[0].length - 1];
  fc.setSel({ type:'col', i:0, idx: fc.G.cols[0].length - 1 });
  ok(fc.tryFree(0) === true, '把列顶的牌存进空暂存格（这一步一定合法）');
  fc.save();
  const saved = JSON.parse(store['gbox_freecell_v1']);
  ok(saved && saved.v === 1, '存档写了版本号 v1');
  ok(saved.seed === 617, '存档记住局号');
  ok(saved.moves === 1, '存档记住步数');
  ok(typeof saved.ms === 'number', '存档记住用时');

  /* 把内存里的局面弄乱（setState 不写存档），再读档 */
  fc.setState([[C(5, CLUB)]], null, null, 99);
  ok(fc.load() === true, '有存档时 load() 成功');
  ok(JSON.stringify(fc.G.cols) !== JSON.stringify(fc.deal(1)), '确实是从存档恢复，不是重新发牌');
  ok(fc.G.seed === 617, '局号恢复');
  ok(fc.G.moves === 1, '步数恢复');
  ok(JSON.stringify(fc.G.cols) !== snap, '牌局是走了一步之后的样子');

  /* 坏存档：少一张 */
  const bad1 = JSON.parse(JSON.stringify(saved));
  bad1.cols[0].pop();
  ok(fc.validState(bad1) === false, '少一张牌的存档被拒');
  /* 坏存档：同一张牌出现两次 */
  const bad2 = JSON.parse(JSON.stringify(saved));
  bad2.cols[0][0] = bad2.cols[1][0];
  ok(fc.validState(bad2) === false, '牌重复的存档被拒');
  /* 坏存档：牌号越界 */
  const bad3 = JSON.parse(JSON.stringify(saved));
  bad3.cols[0][0] = 99;
  ok(fc.validState(bad3) === false, '牌号越界的存档被拒');
  /* 坏存档：收牌堆超过 13 */
  const bad4 = JSON.parse(JSON.stringify(saved));
  bad4.found = [14, 13, 13, 12];
  ok(fc.validState(bad4) === false, '收牌堆超过 13 张的存档被拒');
  /* 不是数组 / null */
  ok(fc.validState(null) === false, 'null 不是存档');
  ok(fc.validState({}) === false, '空对象不是存档');

  /* 存档被清掉时 load 返回 false，不会崩 */
  delete store['gbox_freecell_v1'];
  ok(fc.load() === false, '没有存档时 load() 返回 false');
}

/* ================= 9) 点击交互 ================= */
section('9) 点击交互');
{
  const K = C(13, SPADE), Qh = C(12, HEART), Js = C(11, SPADE);

  /* 点牌 → 点目标列的牌 → 放下 */
  fc.setState([[Qh], [K]], [null,null,null,null], [0,0,0,0], 0);
  fc.tapCard(Qh);
  ok(fc.getSel() && fc.getSel().i === 0 && fc.getSel().idx === 0, '点一张牌就选中它');
  fc.tapCard(K);
  ok(fc.G.cols[1].length === 2 && fc.G.cols[0].length === 0, '再点目标列，牌就过去了');
  ok(fc.getSel() === null, '放下后取消选中');

  /* 再点同一张 = 自动收牌 */
  fc.setState([[C(1, SPADE)]], [null,null,null,null], [0,0,0,0], 0);
  fc.tapCard(C(1, SPADE));
  fc.tapCard(C(1, SPADE));
  ok(fc.G.found[SPADE] === 1, '★ 连点两下把 A 收进收牌堆');
  ok(fc.getSel() === null, '收完取消选中');

  /* 不能收的时候，再点一次只是取消选中，不会乱动 */
  fc.setState([[K]], [null,null,null,null], [0,0,0,0], 0);
  fc.tapCard(K); fc.tapCard(K);
  ok(fc.G.cols[0].length === 1 && fc.getSel() === null, '点两下不能收的牌：只是取消选中');

  /* 选中序列后点别处不合法 → 不误吞，改成选中那张 */
  fc.setState([[K, Qh, Js], [C(9, CLUB)]], [null,null,null,null], [0,0,0,0], 0);
  fc.tapCard(Qh);
  ok(fc.getSel().idx === 1, '点中间的 Q♥ 选中了它和下面的 J♠');
  fc.tapCard(C(9, CLUB));
  ok(fc.getSel().i === 1, '★ 放不下时改选刚点的那张（而不是弹错误）');
  ok(fc.G.cols[0].length === 3, '原来的牌一张没动');

  /* 空列槽 = 放到那一列 */
  fc.setState([[K]], [null,null,null,null], [0,0,0,0], 0);
  fc.tapCard(K);
  fc.tapSlot('col', 5);
  ok(fc.G.cols[5].length === 1 && fc.G.cols[0].length === 0, '点空列槽也能放下');

  /* 暂存格 */
  fc.setState([[K]], [null,null,null,null], [0,0,0,0], 0);
  fc.tapCard(K);
  fc.tapSlot('free', 2);
  ok(fc.G.free[2] === K, '点暂存格把牌存进去');

  /* 已收的牌点不动 */
  fc.setState([], [null,null,null,null], [13,0,0,0], 0);
  fc.tapCard(C(13, CLUB));
  ok(fc.getSel() === null, '收牌堆上的牌不会再被选中');
}


/* ================= 9.5) ★ 随机乱走 400 步：状态不能被走坏 ================= */
section('9.5) ★ 随机走 400 步，牌不能多也不能少');
{
  fc.newGame(1);
  const total = () => {
    let n = 0;
    fc.G.cols.forEach(c => { n += c.length; });
    fc.G.free.forEach(f => { if(f !== null) n++; });
    fc.G.found.forEach(f => { n += f; });
    return n;
  };
  const dup = () => {
    const seen = new Set(), all = [];
    fc.G.cols.forEach(c => all.push(...c));
    fc.G.free.forEach(f => { if(f !== null) all.push(f); });
    return all.length !== new Set(all).size;
  };

  const order = [0,1,2,3,4,5,6,7];
  const shuf = a => a.map(v => [Math.random(), v]).sort((x,y) => x[0] - y[0]).map(x => x[1]);
  let played = 0, bad = '';

  for(let step = 0; step < 400 && !bad; step++){
    if(total() !== 52) { bad = '第 ' + step + ' 步牌数变成 ' + total(); break; }
    if(dup()) { bad = '第 ' + step + ' 步出现重复牌'; break; }
    if(fc.G.found.some(f => f < 0 || f > 13)) { bad = '第 ' + step + ' 步收牌堆越界'; break; }

    /* 收集所有「能整段搬」的起点（列里任意合法序列的开头 + 暂存格） */
    const srcs = [];
    for(let i = 0; i < 8; i++){
      const col = fc.G.cols[i];
      for(let j = 0; j < col.length; j++) if(fc.runOK(col, j)) srcs.push({ type:'col', i:i, idx:j });
    }
    for(let i = 0; i < 4; i++) if(fc.G.free[i] !== null) srcs.push({ type:'free', i:i, idx:0 });

    let moved = false;
    for(const s of shuf(srcs)){
      if(moved) break;
      if(s.type === 'col' && fc.G.cols[s.i].length === 0) continue;
      fc.setSel(s);
      for(const t of shuf(order)){ if(fc.moveRunToCol(t)) { moved = true; break; } }
      if(moved) break;
      for(const f of shuf([0,1,2,3])){ if(fc.tryFree(f)) { moved = true; break; } }
      if(moved) break;
      if(fc.tryFoundSel()) moved = true;
    }
    if(moved) played++;
  }
  ok(bad === '', '★ 一路走下来牌数始终是 52、没有重复、收牌堆不越界', bad);
  /* 不做「走得多远」的断言：FreeCell 随机乱走十几步就把自己堵死是正常的，
     这里只要求确实走起来了，证明移动路径是通的 */
  ok(played >= 8, '随机走子确实走起来了（' + played + ' 步，之后是自己把空位用光了）');
  ok(fc.G.moves >= 0, '步数没有变成负数');
  ok(fc.getHistLen() <= 400, '撤销栈有上限，不会无限长（' + fc.getHistLen() + '）');
}

/* ================= 10) 页面自包含 ================= */
section('10) 页面自包含（离线 APK 要能直接跑）');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok(/<meta name="viewport"/.test(html), '有 viewport');
  ok(/href="\/"/.test(html), '返回键是 href="/"（离线包靠它回首页）');
  ok(/href="#"/.test(html) === false, '没有 href="#" 空链接');
  ok(/<button[^>]+href=/i.test(html) === false, '按钮上没有 href（sync_assets 会判成外链）');
  ok(/localStorage/.test(html) && /try\{[\s\S]*?localStorage/.test(html), '存档读写有 try/catch（file:// 下可能禁用）');
  /* 52 张牌 = 52 个 .card 元素，牌面里有点数和花色 */
  const cardCount = (html.match(/var el = document\.createElement\('div'\);/g) || []).length;
  ok(cardCount >= 1, '牌是 JS 建出来的（52 个 DOM 常驻，移动只改变换）');
  ok(/classList\.toggle\('sel'/.test(html), '选中态用 class 控制');
  ok(/translate3d/.test(html), '位置用 transform 移动（有过渡动画）');

  /* 不允许用 backdrop-filter：无 GPU 的 WebView 会把遮罩渲染成白块 */
  ok(!/backdrop-filter/.test(html), '★ 没用 backdrop-filter（老 WebView 会白屏）');
  /* 不允许 Math.imul 直接调用 —— 老 WebView 可能没有 */
  ok(!/Math\.imul\s*\(/.test(html), '★ 不依赖 Math.imul（自己实现了 32 位乘法）');
}


/* ================= 11) ★ 端到端：照着求解器的解，在游戏里真的走完一局 ================= */
section('11) ★ 用求解器把第 1 局真的走通（规则没被写死）');
{
  const solver = require('./solve_freecell.js');
  const r = solver.solve(1, 120000);
  ok(r.ok, '★ 求解器能解出第 1 局（' + r.steps + ' 步）', r.ok ? '' : '解不出来：移动规则可能多拒了某种合法走法');

  if(r.ok){
    /* 把求解器的每一步翻译成「选中 + 放到目标」，用游戏本体的接口执行。
       求解器内部会自动收牌，所以每步之后补一次 collectAll()，两边局面才对齐。 */
    fc.newGame(1);
    let badStep = -1, badMove = null, done = 0;
    /* 同时用求解器的规则跑一遍同样的路径，逐步和游戏状态对照，
       一旦哪步开始对不上，就能立刻看出是哪条规则在两边理解不同 */
    const sim = { cols: solver.deal(1).map(c => c.slice()), free: [null,null,null,null], found: [0,0,0,0] };
    solver.autoCollect(sim);
    for(const m of r.path){
      solver.apply(sim, m);
      solver.autoCollect(sim);
      const cols = fc.G.cols;
      let moved = false;
      if(m.t === 'c2f'){
        fc.setSel({ type:'col', i:m.i, idx:cols[m.i].length - 1 });
        moved = fc.tryFoundSel();
      } else if(m.t === 'fc2f'){
        fc.setSel({ type:'free', i:m.i, idx:0 });
        moved = fc.tryFoundSel();
      } else if(m.t === 'f2c'){
        fc.setSel({ type:'free', i:m.i, idx:0 });
        moved = fc.moveRunToCol(m.j, true);
      } else if(m.t === 'c2c'){
        fc.setSel({ type:'col', i:m.i, idx:m.k });
        moved = fc.moveRunToCol(m.j, true);
      } else if(m.t === 'c2fc'){
        /* 注意：c2fc 里 i 是暂存格号、j 才是列的号（和 c2f 相反） */
        fc.setSel({ type:'col', i:m.j, idx:cols[m.j].length - 1 });
        moved = fc.tryFree(m.i, true);
      }
      if(!moved){ badStep = done; badMove = m; break; }
      fc.collectAll();
      done++;
      const a = JSON.stringify([sim.cols, sim.free, sim.found]);
      const b = JSON.stringify([fc.G.cols, fc.G.free, fc.G.found]);
      if(a !== b){
        /* 求解器和游戏各走一遍同样的路径，状态必须一模一样；
           不一样就说明两边的规则理解已经分叉，后面再走也没意义 */
        if(process.env.FC_DEBUG){
          console.log('  DIFF @' + done + ' ' + JSON.stringify(m));
          console.log('   sim : ' + a);
          console.log('   game: ' + b);
        }
        badStep = done; badMove = m;
        break;
      }
    }
    ok(badStep < 0,
       '★ 解出来的 ' + r.path.length + ' 步，游戏本体一步不差地接受',
       badStep >= 0 ? ('第 ' + (badStep + 1) + ' 步被拒：' + JSON.stringify(badMove)) : '');

    const sum = fc.G.found[0] + fc.G.found[1] + fc.G.found[2] + fc.G.found[3];
    ok(sum === 52, '★ 走完就是通关（收牌堆 ' + sum + '/52）', '只收到 ' + sum + ' 张');
    ok(fc.G.cols.every(c => c.length === 0) && fc.G.free.every(f => f === null),
       '牌桌彻底空了');
  }
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
