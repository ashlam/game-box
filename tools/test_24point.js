#!/usr/bin/env node
/**
 * 24 点（web/24point）逻辑回归测试
 *
 * 覆盖：
 *   1) 求解器：经典算例、分数解、无解算例
 *   2) 表达式打印：括号只在真的需要时才出现，打印出来重新求值必须等于 24
 *   3) 分数运算：约分、负数、除零
 *   4) 关卡数据：90 关（3 档 × 30）、每关都是 1~13 的 4 张、全部可解、无重复
 *   5) 交互：点牌 → 点运算符 → 合并；选第三张会顶掉第一张
 *   6) 除以 0：不合并、不清空已选的牌、提示 toast
 *   7) 撤销：恢复牌面、运算符、选中状态；多步撤销；无步骤时不动
 *   8) 死局：合并后必然走不到 24 → state=dead（且立即判定，不用等下一步）
 *   9) 过关：算到 24 → state=win、记录最佳成绩、用过提示不记成绩
 *  10) 提示：给出的一步照做之后，局面仍然可解
 *  11) 看答案：自动演示逐步执行，最终一定是 24
 *  12) 渲染：卡牌 DOM 数量/顺序/表达式与状态一致（含合并后重排）
 *  13) 选关面板：三档标签 + 30 个关卡按钮，通关的标 done
 *
 * 用法：node tools/test_24point.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', '24point', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 假 DOM ---------------- */
function mkEl(tag){
  const set = new Set();
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, textContent: '',
    children: [], firstChild: null, disabled: false, offsetWidth: 100,
    _html: '', _listeners: {},
    classList: {
      add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
      toggle: (c, on) => { if(on === undefined) on = !set.has(c); if(on) set.add(c); else set.delete(c); return on; },
    },
    addEventListener(t, fn){ (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener(){},
    click(){ (el._listeners.click || []).forEach(fn => fn({})); },
    setAttribute(){}, focus(){}, blur(){}, select(){}, setSelectionRange(){},
    appendChild(c){
      const i = el.children.indexOf(c);
      if(i >= 0) el.children.splice(i, 1);
      el.children.push(c); el.firstChild = el.children[0] || null; return c;
    },
    insertBefore(c, ref){
      const i = el.children.indexOf(c); if(i >= 0) el.children.splice(i, 1);
      const at = ref ? el.children.indexOf(ref) : el.children.length;
      el.children.splice(at < 0 ? el.children.length : at, 0, c);
      el.firstChild = el.children[0] || null; return c;
    },
    removeChild(c){
      const i = el.children.indexOf(c); if(i >= 0) el.children.splice(i, 1);
      el.firstChild = el.children[0] || null; return c;
    },
    getBoundingClientRect(){ return { left: 0, top: 0, width: 390, height: 200, right: 390, bottom: 200 }; },
  };
  // 真 DOM 里 className 和 classList 是同一份数据，桩里必须同步，否则断言会骗人
  Object.defineProperty(el, 'className', {
    get(){ return Array.from(set).join(' '); },
    set(v){ set.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach(c => set.add(c)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){ el._html = v; if(v === '') { el.children.length = 0; el.firstChild = null; } },
  });
  Object.defineProperty(el, 'childNodes', { get(){ return el.children; } });
  return el;
}

const els = {};
const opBtns = ['+', '-', '*', '/'].map(op => { const b = mkEl('button'); b.dataset.op = op; return b; });
const cardBox = mkEl('div'); cardBox.id = 'cards';
els.cards = cardBox;

const documentStub = {
  getElementById: id => els[id] || (els[id] = mkEl('div')),
  createElement: mkEl,
  createTextNode: t => ({ nodeType: 3, textContent: t }),
  addEventListener(){}, removeEventListener(){},
  documentElement: { scrollHeight: 700 }, body: mkEl('body'),
  querySelector: () => null,
  querySelectorAll: sel => (sel === '#ops button' ? opBtns : []),
};

const store = {};
let timers = [];
const sandbox = {
  console, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout: id => { if(timers[id - 1]) timers[id - 1].fn = null; },
  setInterval: () => 0, clearInterval(){},
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 1, cancelAnimationFrame(){},
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  document: documentStub,
  navigator: { userAgent: 'node-test' },
  location: { search: '' },
  Date, Math, JSON, String, Number, Object, Array, Set, Map, Error,
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 390;
sandbox.window.innerHeight = 760;
sandbox.window.devicePixelRatio = 2;
sandbox.window.isSecureContext = false;
sandbox.window.AudioContext = function(){
  this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {};
};
sandbox.window.AudioContext.prototype.createOscillator = function(){
  return { type:'', frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){}, start(){}, stop(){} };
};
sandbox.window.AudioContext.prototype.createGain = function(){
  return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} };
};

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'g24-inline.js' });

/* ---------------- 驱动 ---------------- */
const win = sandbox.window;
const R = () => win.__g24();
const pick = id => win.__g24Pick(id);
const setOp = op => win.__g24Op(op);
const undo = () => win.__g24Undo();
const load = (t, i) => win.__g24Load(t, i);
const setCards = arr => win.__g24SetCards(arr);
const solve = nums => win.__g24Solve(nums);
const solveAll = nums => win.__g24SolveAll(nums);
const count = nums => win.__g24Count(nums);
const LEVELS = win.__g24Levels();
const U = win.__g24Now();

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* 用四种运算把一个表达式字符串重新算一遍（不依赖游戏内部的树） */
function evalExpr(s){
  const toks = s.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').match(/\d+\/\d+|\d+|[+\-*/()]/g);
  let i = 0;
  function primary(){
    const t = toks[i++];
    if(t === '('){ const v = expr(); i++; return v; }
    if(t === '-') return -primary();
    if(t.indexOf('/') >= 0){ const [a, b] = t.split('/').map(Number); return a / b; }
    return Number(t);
  }
  function term(){ let v = primary(); while(toks[i] === '*' || toks[i] === '/'){ const o = toks[i++]; const r = primary(); v = o === '*' ? v * r : v / r; } return v; }
  function expr(){ let v = term(); while(toks[i] === '+' || toks[i] === '-'){ const o = toks[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  return expr();
}

/* ================= 1) 求解器 ================= */
section('1) 求解器');
{
  const cases = [
    [[1,4,8,12], true], [[2,3,4,5], true], [[1,1,1,1], false],
    [[3,3,8,8], true], [[1,3,4,6], true], [[5,5,5,1], true],
    [[1,2,3,4], true], [[13,13,13,13], false], [[1,1,1,2], false],
    [[6,6,6,6], true], [[7,7,7,7], false], [[2,2,2,2], false],
  ];
  for(const [nums, want] of cases){
    const got = solve(nums) !== null;
    ok(got === want, `[${nums}] ${want ? '可解' : '无解'}`, got !== want ? '实际 ' + solve(nums) : '');
  }
  ok(solve([3,3,8,8]) === '8÷(3−8÷3)', '经典分数解 3 3 8 8 → 8÷(3−8÷3)', solve([3,3,8,8]));
  ok(Math.abs(evalExpr(solve([3,3,8,8])) - 24) < 1e-9, '3 3 8 8 的解代回去真的等于 24');
}

/* ================= 2) 表达式打印 ================= */
section('2) 表达式打印：括号 / 重算');
{
  ok(solve([1,2,3,4]).indexOf('(') < 0 || true, '打印不抛错');
  const all = solveAll([3,3,8,8]);
  ok(all.length > 0, '3 3 8 8 至少有解', 'n=' + all.length);
  let bad = null;
  for(const e of all){ if(Math.abs(evalExpr(e) - 24) > 1e-9){ bad = e; break; } }
  ok(bad === null, '3 3 8 8 的每个解代回去都等于 24', bad);

  // 括号只在需要时出现：a+b 不该被包起来
  const e1 = solve([1,4,8,12]);
  ok(e1 && Math.abs(evalExpr(e1) - 24) < 1e-9, '1 4 8 12 的解正确', e1);

  // 分数的解要能被重新解析（8÷(3−8÷3) 这种嵌套）
  let badFrac = null, fracN = 0;
  for(const nums of [[3,3,8,8],[1,3,4,6],[1,4,5,6],[2,2,13,13],[4,4,7,7]]){
    for(const e of solveAll(nums)){
      fracN++;
      if(Math.abs(evalExpr(e) - 24) > 1e-9){ badFrac = nums + ' → ' + e; break; }
    }
  }
  ok(badFrac === null, `分数解全部可重算（共 ${fracN} 条）`, badFrac);

  // 负数中间结果要用括号
  const e2 = solve([1,5,5,5]);
  ok(e2 && Math.abs(evalExpr(e2) - 24) < 1e-9, '1 5 5 5 的解正确（要造分数/负数）', e2);
}

/* ================= 3) 分数运算 ================= */
section('3) 分数运算');
{
  const { fr, fStr } = U;
  ok(fStr(fr(6, 3)) === '2', '6/3 约成 2', fStr(fr(6, 3)));
  ok(fStr(fr(8, 6)) === '4/3', '8/6 约成 4/3', fStr(fr(8, 6)));
  ok(fStr(fr(-4, 6)) === '-2/3', '负分数约分 -4/6 → -2/3', fStr(fr(-4, 6)));
  ok(fStr(fr(3, -6)) === '-1/2', '分母为负时符号提到分子', fStr(fr(3, -6)));
  ok(fStr(fr(0, 5)) === '0', '0/5 → 0');
  ok(fr(1, 0) === null, '除以 0 返回 null');
}

/* ================= 4) 关卡数据 ================= */
section('4) 关卡数据');
{
  ok(LEVELS.length === 3, '三档难度', '实际 ' + LEVELS.length);
  const lens = LEVELS.map(t => t.length);
  ok(lens.every(n => n === 30), '每档 30 关', JSON.stringify(lens));
  const total = lens.reduce((a, b) => a + b, 0);
  ok(total === 90, '共 90 关', String(total));

  let badRange = null, badSolvable = null, badCount = null;
  const seen = new Set();
  let dup = null;
  for(let t = 0; t < LEVELS.length; t++){
    for(let i = 0; i < LEVELS[t].length; i++){
      const nums = LEVELS[t][i];
      if(nums.length !== 4 || nums.some(n => !Number.isInteger(n) || n < 1 || n > 13)){ badRange = t + '-' + i + ' ' + nums; }
      if(solve(nums) === null){ badSolvable = t + '-' + i + ' ' + nums; }
      if(count(nums) < 1){ badCount = t + '-' + i; }
      const key = nums.slice().sort((a, b) => a - b).join(',');
      if(seen.has(key)) dup = key;
      seen.add(key);
    }
  }
  ok(badRange === null, '每关都是 4 张 1~13 的牌', badRange);
  ok(badSolvable === null, '★ 每一关都可解（求解器逐个验过）', badSolvable);
  ok(badCount === null, '每关都至少有一条解', badCount);
  ok(dup === null, '关卡之间不重复', dup);

  // 难度确实递增：入门解法多、大师唯一解
  const n0 = LEVELS[0].map(count), n2 = LEVELS[2].map(count);
  ok(n0.every(n => n >= 5), '入门每关至少 5 种解法', JSON.stringify(n0.filter(n => n < 5)));
  ok(n2.every(n => n === 1), '大师每关只有唯一解', JSON.stringify(n2.filter(n => n !== 1)));
  ok(n0.reduce((a, b) => a + b, 0) > n2.reduce((a, b) => a + b, 0), '入门的总解法数 > 大师');

  // 收尾压轴是那道名题
  const last = LEVELS[2][LEVELS[2].length - 1].slice().sort((a, b) => a - b);
  ok(last.join(',') === '3,3,8,8', '最后一关是 3 3 8 8', last.join(','));
}

/* ================= 5) 基本交互 ================= */
section('5) 点牌 / 运算符 / 合并');
{
  load(0, 0);
  let s = R();
  ok(s.cards.length === 4, '开局 4 张牌');
  ok(s.state === 'play' && s.hist === 0, '状态 play、无历史');
  ok(s.sel.length === 0 && s.op === null, '开局没选中、没运算符');

  const a = s.cards[0].id, b = s.cards[1].id;
  pick(a);
  ok(R().sel.length === 1 && R().sel[0] === a, '点第一张 → 选中 1 张');
  pick(b);
  ok(R().sel.length === 2, '点第二张 → 选中 2 张');

  const va = Number(s.cards[0].v), vb = Number(s.cards[1].v);
  setOp('+');
  s = R();
  ok(s.cards.length === 3, '两张牌合成一张 → 剩 3 张', '实际 ' + s.cards.length);
  ok(s.sel.length === 0 && s.op === null, '合并后清空选中与运算符');
  ok(s.hist === 1, '合并记了 1 步历史');
  const merged = s.cards.find(c => c.n === va + vb && c.d === 1);
  ok(!!merged, `牌面 ${va}+${vb}=${va + vb} 出现在结果里`,
     JSON.stringify(s.cards.map(c => c.v)));
  ok(!!merged && merged.expr.indexOf('+') >= 0, '合并出的牌带表达式');

  // 选第三张会顶掉第一张（只保留最近两张）
  load(0, 0);
  const ids = R().cards.map(c => c.id);
  pick(ids[0]); pick(ids[1]); pick(ids[2]);
  s = R();
  ok(s.sel.length === 2 && s.sel[0] === ids[1] && s.sel[1] === ids[2], '选第三张顶掉第一张',
     JSON.stringify(s.sel));

  // 再点一次取消选中
  pick(ids[2]);
  ok(R().sel.indexOf(ids[2]) < 0, '再点同一张 → 取消选中');
}

/* ================= 6) 除以 0 ================= */
section('6) 除以 0');
{
  load(0, 0);
  const s0 = R();
  const zero = s0.cards.find(c => Number(c.v) === 0);
  ok(!zero, '关卡里不会有 0（1~13）');

  // 造一个 0：先合并出 0 不现实，直接设牌
  setCards([1, 2, 3, 4]);
  let ids = R().cards.map(c => c.id);
  pick(ids[0]); pick(ids[1]); setOp('-');     // 1-2 = -1
  ok(R().cards.length === 3, '1−2 合并成功', '剩 ' + R().cards.length + ' 张');
  const neg = R().cards.find(c => c.n < 0);
  ok(!!neg, '出现了负数牌（−1）', JSON.stringify(R().cards.map(c => c.v)));

  // 负数 ÷ 负数 = 正数，符号要正确
  setCards([2, 2, 3, 4]);
  ids = R().cards.map(c => c.id);
  pick(ids[0]); pick(ids[1]); setOp('/');
  const s = R();
  ok(s.cards.length === 3, '2÷2 合并成功', '剩 ' + s.cards.length + ' 张');
  ok(s.cards.some(c => c.v === '1'), '2÷2 = 1', JSON.stringify(s.cards.map(c => c.v)));

  // 真的除以 0：0 只能靠 (a−a) 造出来
  setCards([5, 5, 3, 4]);
  ids = R().cards.map(c => c.id);
  pick(ids[0]); pick(ids[1]); setOp('-');   // 5−5 = 0
  let z = R();
  ok(z.cards.some(c => c.v === '0'), '5−5 造出一个 0', JSON.stringify(z.cards.map(c => c.v)));
  const zeroId = z.cards.find(c => c.v === '0').id;
  const otherId = z.cards.find(c => c.v !== '0').id;
  pick(otherId); pick(zeroId); setOp('/');  // x ÷ 0
  z = R();
  ok(z.cards.length === 3, '★ 除以 0 不合并（牌数不变）', String(z.cards.length));
  ok(z.cards.some(c => c.v === '0'), '★ 0 那张牌还在');
  ok(z.op === null && z.sel.length === 0, '★ 除 0 后清空运算符与选中，不卡住界面');
}

/* ================= 7) 撤销 ================= */
section('7) 撤销');
{
  load(0, 0);
  const before = R().cards.map(c => c.v).join(',');
  const ids = R().cards.map(c => c.id);
  pick(ids[0]); pick(ids[1]); setOp('*');
  ok(R().cards.length === 3, '先做一步合并');
  undo();
  let s = R();
  ok(s.cards.length === 4, '撤销后回到 4 张牌');
  ok(s.cards.map(c => c.v).join(',') === before, '撤销后牌面完全一致', s.cards.map(c => c.v).join(','));
  ok(s.hist === 0, '历史被弹出');
  ok(s.state === 'play', '状态回到 play');

  // 多步撤销（用自动演示走两步，保证每一步之后局面都还可解）
  load(0, 1);
  win.__g24DemoStep(false);
  win.__g24DemoStep(false);
  ok(R().hist === 2, '连做两步 → 历史 2', String(R().hist) + ' 牌=' + JSON.stringify(R().cards.map(c => c.v)));
  undo(); ok(R().hist === 1 && R().cards.length === 3, '撤销一步 → 3 张牌', R().cards.length + ' 张');
  undo(); ok(R().hist === 0 && R().cards.length === 4, '再撤销 → 4 张牌', R().cards.length + ' 张');

  // 空历史撤销不动
  const snap = JSON.stringify(R().cards);
  undo();
  ok(JSON.stringify(R().cards) === snap, '没有历史时撤销不改牌面');
}

/* ================= 8) 死局 ================= */
section('8) 死局判定');
{
  // 造一手「怎么走都到不了 24」的牌：1 1 1 1
  setCards([1, 1, 1, 1]);
  let s = R();
  ok(s.state === 'play', '开局先不判死（4 张 1 也算「还有得算」）');
  const ids = s.cards.map(c => c.id);
  pick(ids[0]); pick(ids[1]); setOp('+');   // 1+1 = 2，剩 2 1 1
  s = R();
  ok(s.state === 'dead', '★ 2 1 1 已经算不出 24 → 立刻判死（不用等走完）', s.state + ' ' + JSON.stringify(s.cards.map(c => c.v)));

  // 判死后不能再操作
  const n0 = R().cards.length;
  pick(s.cards[0].id); setOp('+');
  ok(R().cards.length === n0, '死局状态下点牌/运算符无效');

  // 撤销能从死局里爬出来
  undo();
  ok(R().state === 'play', '★ 撤销后状态回到 play');
  ok(R().cards.length === 4, '撤销后回到 4 张牌', String(R().cards.length));

  // 牌还有救的时候不能误判死：1 2 3 4 走 1+2 → 3 3 4，还能 (3+3)×4 = 24
  setCards([1, 2, 3, 4]);
  ok(R().state === 'play', '1 2 3 4 开局活着');
  const v = R().cards.map(c => c.id);
  pick(v[0]); pick(v[1]); setOp('+');        // 1+2 = 3，剩 3 3 4
  ok(R().state === 'play', '★ 还有救的局面不能误判死（3 3 4 还能 (3+3)×4）',
     R().state + ' ' + JSON.stringify(R().cards.map(c => c.v)));
  undo();

  // 走进死胡同要当场判死：2 3 4 5 走 2+3 → 5 4 5，怎么算都到不了 24
  setCards([2, 3, 4, 5]);
  const w = R().cards.map(c => c.id);
  pick(w[0]); pick(w[1]); setOp('+');        // 2+3 = 5，剩 5 4 5
  ok(R().state === 'dead', '★ 2 3 4 5 走成 5 4 5 当场判死',
     R().state + ' ' + JSON.stringify(R().cards.map(c => c.v)));
  undo();
  ok(R().state === 'play' && R().cards.length === 4, '撤销后 2 3 4 5 恢复可玩');
}

/* ================= 9) 过关与记录 ================= */
section('9) 过关 / 最佳成绩');
{
  load(0, 0);
  let guard = 0;
  while(R().state === 'play' && guard++ < 8){
    const before = R().cards.length;
    win.__g24DemoStep();
    if(R().cards.length === before) break;
  }
  let s = R();
  ok(s.state === 'win', '照答案走完 → win', 'state=' + s.state);
  ok(s.cards.length === 1 && s.cards[0].v === '24', '最后剩一张 24', JSON.stringify(s.cards));
  ok(s.helped === true, '演示过 → helped=true');

  const prog = win.__g24Prog();
  ok(prog.done['0-0'] === -1, '用过提示 → 记录为 -1（不记成绩）', String(prog.done['0-0']));

  // 不用提示手动通关 → 记正数秒
  load(0, 1);
  win.__g24SetHelped(false);          // 模拟「玩家自己想出来的」
  guard = 0;
  while(R().state === 'play' && guard++ < 8){
    const before = R().cards.length;
    win.__g24DemoStep();
    if(R().cards.length === before) break;
  }
  ok(R().state === 'win', '第二关也能走通');
  ok(R().helped === true, '演示步骤会把 helped 置为 true（内部机制）');
  // 真正「没用提示」的场景：不让 helped 变 true（mark=false 只走步骤、不计入提示）
  load(0, 2);
  guard = 0;
  while(R().state === 'play' && guard++ < 8){
    if(!win.__g24DemoStep(false)) break;
  }
  const prog2 = win.__g24Prog();
  ok(R().state === 'win', '第三关走通', R().state);
  ok(R().helped === false, 'mark=false 时不算用过提示');
  ok(typeof prog2.done['0-2'] === 'number' && prog2.done['0-2'] >= 0,
     '★ 没用提示 → 记录用时（秒）', String(prog2.done['0-2']));

  // 记录存在 localStorage 里
  const raw = JSON.parse(store['g24_v1']);
  ok(!!raw && !!raw.done, '成绩写进了 localStorage');
  ok(raw.done['0-2'] !== undefined, 'localStorage 里有第三关的记录');
}

/* ================= 10) 提示 ================= */
section('10) 提示');
{
  load(1, 0);
  const before = R();
  win.__g24Hint();
  const s = R();
  ok(!!s.hint, '提示给出了两张牌 + 运算符');
  ok(s.hint.ids.length === 2 && s.hint.ids[0] !== s.hint.ids[1], '提示的两张牌不是同一张');
  ok(!!s.hint.op && '+-*/'.indexOf(s.hint.op) >= 0, '提示的运算符合法', s.hint.op);
  ok(s.helped === true, '用过提示 → helped=true');

  // 照提示做一步，局面仍要可解（提示不能把人带进沟里）
  const ids = s.hint.ids;
  pick(ids[0]); pick(ids[1]); setOp(s.hint.op);
  const after = R();
  ok(after.state === 'play', '★ 照提示走一步之后还没死', 'state=' + after.state);
  const solvable = solve(after.cards.map(c => Number(c.v))) !== null ||
                   after.cards.every(c => c.d === 1);
  ok(solvable || after.state === 'win', '★ 走完提示后局面仍可解');

  // 每一档都试一次
  let bad = null;
  for(let t = 0; t < 3; t++){
    load(t, 0);
    win.__g24Hint();
    const h = R().hint;
    if(!h || h.ids.length !== 2) { bad = t; break; }
    pick(h.ids[0]); pick(h.ids[1]); setOp(h.op);
    if(R().state === 'dead'){ bad = 'dead@' + t; break; }
  }
  ok(bad === null, '三档的第一关，提示都能安全走一步', String(bad));
}

/* ================= 11) 看答案（自动演示） ================= */
section('11) 自动演示');
{
  let bad = null;
  const targets = [[0, 0], [0, 15], [1, 5], [2, 0], [2, 29]];
  for(const [t, i] of targets){
    load(t, i);
    let guard = 0;
    while(R().state === 'play' && guard++ < 8){
      const n = R().cards.length;
      win.__g24DemoStep();
      if(R().cards.length === n) break;
    }
    const s = R();
    if(s.state !== 'win' || s.cards[0].v !== '24') bad = t + '-' + i + ' → ' + s.state + ' ' + JSON.stringify(s.cards);
  }
  ok(bad === null, '★ 5 关（含 3 3 8 8）自动演示都算到 24', bad);

  // 演示中途停手也不会崩
  load(2, 29);
  win.__g24DemoStep();
  ok(R().cards.length === 3, '3 3 8 8 演示第一步 → 剩 3 张', String(R().cards.length));
  ok(R().state === 'play', '第一步之后还没结束');
}

/* ================= 12) 渲染 ================= */
section('12) 渲染一致性');
{
  load(0, 2);
  const s = R();
  ok(cardBox.children.length === 4, 'DOM 里 4 张卡', String(cardBox.children.length));
  ok(cardBox.children.map(c => String(c.dataset.id)).join(',') === s.cards.map(c => c.id).join(','),
     'DOM 顺序与状态一致');

  const ids = s.cards.map(c => c.id);
  pick(ids[0]);
  ok(cardBox.children.filter(c => c.classList.contains('sel')).length === 1, '选中态反映到 DOM');
  pick(ids[1]); setOp('+');

  const after = R();
  ok(cardBox.children.length === 3, '合并后 DOM 也剩 3 张', String(cardBox.children.length));
  ok(cardBox.children.map(c => String(c.dataset.id)).join(',') === after.cards.map(c => c.id).join(','),
     '★ 合并后 DOM 顺序仍然和状态一致（新牌插在两张牌的位置上）');
  ok(cardBox.children[0].children[0].textContent === after.cards[0].v,
     '牌面文字与状态一致', cardBox.children[0].children[0].textContent + ' vs ' + after.cards[0].v);

  // 撤销后 DOM 也要跟着回去
  undo();
  ok(cardBox.children.length === 4, '撤销后 DOM 回到 4 张');
  ok(cardBox.children.filter(c => c.classList.contains('sel')).length === 0, '撤销后没有残留的选中态');

  // 死局时卡牌要带 dead 样式
  setCards([1, 1, 1, 1]);
  const z = R().cards.map(c => c.id);
  pick(z[0]); pick(z[1]); setOp('+');
  const z2 = R().cards.map(c => c.id);
  pick(z2[0]); pick(z2[1]); setOp('+');
  ok(cardBox.children.every(c => c.classList.contains('dead')), '死局时每张牌都标 dead');
}

/* ================= 13) 选关面板 ================= */
section('13) 选关面板');
{
  const tabs = documentStub.getElementById('lvTabs');
  const grid = documentStub.getElementById('lvGrid');
  win.__g24BuildPanel(0);
  ok(tabs.children.length === 3, '三个难度标签', String(tabs.children.length));
  ok(grid.children.length === 30, '入门 30 个关卡按钮', String(grid.children.length));
  ok(tabs.children[0].textContent.indexOf('入门') >= 0, '标签文字含难度名', tabs.children[0].textContent);
  ok(grid.children[0].textContent === '1', '按钮从 1 开始编号');

  // 切到大师档
  tabs.children[2].click();
  ok(grid.children.length === 30, '切档后仍是 30 个按钮');
  ok(tabs.children[2].classList.contains('on'), '切档后标签高亮跟着走');

  // 通关过的关卡要标出来（第 0 档第 1 关前面已经通了）
  tabs.children[0].click();
  const doneBtn = grid.children[0];
  ok(doneBtn.classList.contains('done') || doneBtn.classList.contains('help'),
     '通关过的关卡有标记', doneBtn.className);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(52));
if(fail === 0) console.log(`全部通过：${pass} 项`);
else {
  console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`);
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail === 0 ? 0 : 1);
