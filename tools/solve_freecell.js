#!/usr/bin/env node
/**
 * 空当接龙的求解器 —— 用来证明「这游戏真能通关、规则没写死」
 *
 * 为什么需要它：单元测试只能验证单条规则（能不能放、能搬几张），
 * 但「一整套规则凑在一起还走得通吗」只有真解一局才能证明。
 * 如果移动生成里多了个拒绝条件，单测照样全绿，游戏却可能永远赢不了。
 *
 * 用法：
 *   node tools/solve_freecell.js              # 解第 1 局
 *   node tools/solve_freecell.js 617 1024     # 解几局
 *   FC_BUDGET=2000000 node ... 617            # 放宽搜索预算
 *
 * 算法：最佳优先（A* 的贪心版）+ 状态去重，启发式看「收了几张 + 牌排得多顺」。
 * 这是**验证工具**，不是高性能求解器；开局难的局（如第 11982 局）解不出来是正常的，
 * 能解出第 1 局这种基础局，就足以说明规则是通的。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 复用游戏本体的发牌算法：只把 imul32 / deal 抠出来跑，不加载整个页面 */
function extractFn(src, name){
  const at = src.indexOf('function ' + name + '(');
  if(at < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, i = src.indexOf('{', at);
  const start = at;
  for(; i < src.length; i++){
    if(src[i] === '{') depth++;
    else if(src[i] === '}'){ depth--; if(depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('函数 ' + name + ' 的大括号没配上');
}
function loadDeal(){
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'freecell', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const code = extractFn(script, 'imul32') + '\n' + extractFn(script, 'deal') + '\nthis.__deal = deal;';
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'deal.js' });
  return ctx.__deal;
}
const deal = loadDeal();

/* ===== 规则（与 index.html 里那套完全一致） ===== */
const suitOf = c => c & 3;
const rankOf = c => (c >> 2) + 1;
const isRed = c => suitOf(c) === 1 || suitOf(c) === 2;
const onCol = (card, col) => col.length === 0 ||
  (rankOf(col[col.length - 1]) === rankOf(card) + 1 && isRed(col[col.length - 1]) !== isRed(card));

/* 一次能搬几张：和游戏里的 maxRun 一模一样（含「源列搬空 +1」「目标空列 -1」） */
function capFor(s, srcCol, dstCol, runLen){
  let free = 0, empty = 0;
  for(let i = 0; i < 4; i++) if(s.free[i] === null) free++;
  for(let i = 0; i < 8; i++) if(!s.cols[i].length) empty++;
  if(s.cols[dstCol].length === 0) empty--;
  if(s.cols[srcCol].length === runLen) empty++;
  if(empty < 0) empty = 0;
  return (free + 1) * Math.pow(2, empty);
}

const clone = s => ({ cols: s.cols.map(c => c.slice()), free: s.free.slice(), found: s.found.slice() });
const key = s => s.cols.map(c => c.join('.')).join('|') + '#' + s.free.join('.') + '#' + s.found.join('.');
const won = s => s.found[0] + s.found[1] + s.found[2] + s.found[3] === 52;

/* ===== 走法生成 ===== */
function moves(s){
  const out = [];

  /* 1. 能收就收 */
  for(let i = 0; i < 4; i++){
    const c = s.free[i];
    if(c !== null && rankOf(c) === s.found[suitOf(c)] + 1) out.push({ t:'fc2f', i:i });
  }
  for(let i = 0; i < 8; i++){
    const col = s.cols[i];
    if(!col.length) continue;
    const c = col[col.length - 1];
    if(rankOf(c) === s.found[suitOf(c)] + 1) out.push({ t:'c2f', i:i });
  }

  /* 2. 暂存格里的牌放回列 */
  for(let i = 0; i < 4; i++){
    const c = s.free[i];
    if(c === null) continue;
    for(let j = 0; j < 8; j++){
      if(onCol(c, s.cols[j])) out.push({ t:'f2c', i:i, j:j });
    }
  }

  /* 3. 列 → 列（列尾那段合法序列，长度受空位限制） */
  for(let i = 0; i < 8; i++){
    const col = s.cols[i];
    if(!col.length) continue;
    let start = col.length - 1;
    while(start > 0){
      const a = col[start - 1], b = col[start];
      if(rankOf(a) !== rankOf(b) + 1 || isRed(a) === isRed(b)) break;
      start--;
    }
    for(let k = start; k < col.length; k++){
      const run = col.slice(k);
      for(let j = 0; j < 8; j++){
        if(j === i) continue;
        if(!onCol(run[0], s.cols[j])) continue;
        if(run.length > capFor(s, i, j, run.length)) continue;
        out.push({ t:'c2c', i:i, j:j, k:k });
      }
    }
  }

  /* 4. 列顶的牌进暂存格（最后才考虑，暂存格很宝贵） */
  for(let i = 0; i < 4; i++){
    if(s.free[i] !== null) continue;
    for(let j = 0; j < 8; j++){
      if(s.cols[j].length) out.push({ t:'c2fc', i:i, j:j });
    }
  }
  return out;
}

function apply(s, m){
  if(m.t === 'fc2f'){
    const c = s.free[m.i];
    s.free[m.i] = null;
    s.found[suitOf(c)] = rankOf(c);
  } else if(m.t === 'c2f'){
    const c = s.cols[m.i].pop();
    s.found[suitOf(c)] = rankOf(c);
  } else if(m.t === 'f2c'){
    const c = s.free[m.i];
    s.free[m.i] = null;
    s.cols[m.j].push(c);
  } else if(m.t === 'c2c'){
    const run = s.cols[m.i].slice(m.k);
    s.cols[m.i].length = m.k;
    s.cols[m.j] = s.cols[m.j].concat(run);
  } else if(m.t === 'c2fc'){
    s.free[m.i] = s.cols[m.j].pop();
  }
}

/* ===== 最小堆 ===== */
class Heap {
  constructor(){ this.a = []; }
  get size(){ return this.a.length; }
  push(item, pri){
    const a = this.a;
    a.push({ item, pri });
    let i = a.length - 1;
    while(i > 0){
      const p = (i - 1) >> 1;
      if(a[p].pri <= a[i].pri) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop(){
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if(a.length){
      a[0] = last;
      let i = 0;
      for(;;){
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if(l < a.length && a[l].pri < a[m].pri) m = l;
        if(r < a.length && a[r].pri < a[m].pri) m = r;
        if(m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top.item;
  }
}


/* 自动收牌：能收的全收掉。真人也是这么干的，搜索里省掉大量无意义分支。
 * 收牌不会让局面变差 —— foundation 只需要同花色的下一张，收走的牌再也用不到。 */
function autoCollect(s){
  let any = false, guard = 0, moved = false;
  do {
    moved = false;
    for(let i = 0; i < 4; i++){
      const c = s.free[i];
      if(c !== null && rankOf(c) === s.found[suitOf(c)] + 1){
        s.found[suitOf(c)] = rankOf(c);
        s.free[i] = null;
        moved = any = true;
      }
    }
    for(let i = 0; i < 8; i++){
      const col = s.cols[i];
      const c = col[col.length - 1];
      if(c !== undefined && rankOf(c) === s.found[suitOf(c)] + 1){
        col.pop();
        s.found[suitOf(c)] = rankOf(c);
        moved = any = true;
      }
    }
    guard++;
  } while(moved && guard < 60);
  return any;
}

/* 启发式：收牌越多越好、牌排得越顺越好、别把暂存格堵死 */
function priority(s, g){
  let found = 0;
  for(let i = 0; i < 4; i++) found += s.found[i];
  let bump = 0;
  for(let i = 0; i < 8; i++){
    const col = s.cols[i];
    let run = col.length ? 1 : 0;
    for(let k = col.length - 1; k > 0; k--){
      const a = col[k - 1], b = col[k];
      if(rankOf(a) === rankOf(b) + 1 && isRed(a) !== isRed(b)) run++;
      else break;
    }
    bump += run;
  }
  let freeUsed = 0;
  for(let i = 0; i < 4; i++) if(s.free[i] !== null) freeUsed++;
  return g - found * 40 - bump * 2 + freeUsed * 4;
}

/* ===== 搜索 ===== */
function solve(seed, budget){
  budget = budget || 400000;
  const start = { cols: deal(seed), free: [null, null, null, null], found: [0, 0, 0, 0] };
  autoCollect(start);
  const open = new Heap();
  const best = new Map();
  open.push({ s:start, parent:null, move:null, g:0 }, priority(start, 0));
  best.set(key(start), 0);

  let nodes = 0;
  while(open.size && nodes < budget){
    const node = open.pop();
    nodes++;
    if(won(node.s)){
      const path = [];
      let n = node;
      while(n && n.move){ path.push(n.move); n = n.parent; }
      return { ok:true, nodes, steps: path.length, path: path.reverse() };
    }
    for(const m of moves(node.s)){
      const n = clone(node.s);
      apply(n, m);
      autoCollect(n);
      const k = key(n);
      const g = node.g + 1;
      if(best.has(k) && best.get(k) <= g) continue;
      best.set(k, g);
      open.push({ s:n, parent:node, move:m, g }, priority(n, g));
    }
  }
  return { ok:false, nodes, steps:0, path:[] };
}

/* ===== 命令行 ===== */
if(require.main === module){
  const seeds = process.argv.slice(2).map(Number).filter(n => n > 0);
  if(!seeds.length) seeds.push(1);
  const budget = Number(process.env.FC_BUDGET || 400000);
  let bad = 0;
  for(const seed of seeds){
    const t0 = Date.now();
    const r = solve(seed, budget);
    console.log(
      (r.ok ? '✓' : '✗') + ' 第 ' + seed + ' 局：' +
      (r.ok ? '有解，' + r.steps + ' 步' : '预算内没解出来') +
      '（' + r.nodes + ' 个局面，' + (Date.now() - t0) + 'ms）'
    );
    if(!r.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { solve, moves, apply, won, capFor, deal, autoCollect };
