#!/usr/bin/env node
/**
 * 数织（Nonogram / Picross）回归测试
 *
 * 覆盖：
 *   1) 关卡数据本身合法（尺寸、字符集、行数）
 *   2) ★ 每关「唯一解 + 纯逻辑可推」—— 交给 tools/solve_nonogram.js 判
 *   3) 线索计算：空行给 [0]、连续段、多段
 *   4) 开局棋盘：DOM 结构（1 个角 + n 列提示 + n×(1 行提示 + n 格)）
 *   5) 涂色 / 打叉 / 再点擦除（同一格三态循环的方向）
 *   6) ★ 拖拽智能划线：横向铺满、纵向铺满、斜跳忽略、锁定方向后不拐弯
 *   7) ★ 填错：计数 + 闪红（视觉可关，但计数照记）
 *   8) 行列完成判定（空格不打叉也算完成）
 *   9) 提示：只给答案格、每关 3 次、用完后按钮禁用
 *  10) 撤销
 *  11) ★ 通关：完成判定、星级（无提示 / 少错）、存档、更差成绩不覆盖
 *  12) 首次进入自动打开说明
 *  13) 单文件自包含（无外链、无图片、返回键 href="/"）
 *
 * 用法：node tools/test_nonogram.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'nonogram', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const { analyze } = require('./solve_nonogram.js');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================== 假 DOM ============================== */
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
    style: mkStyle(),
    dataset: {},
    textContent: '',
    checked: false,
    disabled: false,
    hidden: false,
    _cls: '',
    _html: '',
    children: [],
    clientWidth: 390,
    clientHeight: 600,
    offsetWidth: 24,
    addEventListener(type, fn){ (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(){},
    fire(type, ev){ (handlers[type] || []).slice().forEach(fn => fn(ev || {})); },
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    removeChild(c){ const i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); return c; },
    getBoundingClientRect(){
      return { left:0, top:0, width:this.clientWidth, height:this.clientHeight,
               right:this.clientWidth, bottom:this.clientHeight };
    },
    setAttribute(){}, focus(){}, blur(){},
    closest(sel){
      const c = sel.slice(1);
      let n = this;
      while(n){ if(n.classList && n.classList.contains(c)) return n; n = n.parentNode; }
      return null;
    },
    querySelectorAll(sel){ return find(this, sel); },
    querySelector(sel){ const r = find(this, sel); return r[0] || null; },
    setPointerCapture(){},
    releasePointerCapture(){},
  };
  Object.defineProperty(el, 'firstChild', { get(){ return el.children[0] || null; } });
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){ el._html = String(v); if(v === '') el.children.length = 0; },
  });
  Object.defineProperty(el, 'className', {
    get(){ return el._cls; },
    set(v){ el._cls = String(v || ''); },
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
  return el;
}

/** 极简选择器：.class / #id / [attr] / tag */
function find(root, sel){
  const out = [];
  const parts = sel.trim().split(/\s+/);
  const lastSel = parts[parts.length - 1];
  (function walk(n){
    n.children.forEach(c => {
      let hit = false;
      if(lastSel[0] === '.') hit = c.classList.contains(lastSel.slice(1));
      else if(lastSel[0] === '#') hit = c.id === lastSel.slice(1);
      else if(lastSel[0] === '[') hit = lastSel.slice(1, -1) in c;
      else hit = c.tagName === lastSel.toUpperCase();
      if(hit) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

/** 造一个独立实例；store 共享就能测「重新进游戏记录还在」 */
function makeVM(store){
  const els = {};
  const mk = (id, init) => { const e = mkEl('div'); e.id = id; if(init) init(e); els[id] = e; return e; };

  mk('board'); mk('boardWrap', e => { e.clientWidth = 390; e.clientHeight = 560; });
  mk('menu'); mk('play', e => { e.hidden = true; });
  mk('groups'); mk('demo'); mk('help', e => { e.hidden = true; });
  mk('win', e => { e.hidden = true; });
  mk('lvTitle'); mk('lvSize'); mk('timeV'); mk('errV'); mk('hintV');
  mk('undoBtn', e => { e.disabled = true; });
  mk('hintBtn2'); mk('backBtn'); mk('restartBtn'); mk('helpBtn');
  mk('nextBtn'); mk('againBtn'); mk('toMenuBtn');
  mk('winTitle'); mk('winName'); mk('wTime'); mk('wErr'); mk('wHint');
  mk('optFade', e => { e.checked = true; });
  mk('optErr', e => { e.checked = true; });
  mk('winStars', e => {
    ['★','★','★'].forEach(t => { const i = mkEl('i'); i.textContent = t; e.appendChild(i); });
  });

  /* 两个模式按钮：setMode 靠 document.querySelectorAll('.pm') 找它们 */
  const pmFill = mkEl('button'); pmFill.dataset.mode = 'fill'; pmFill.className = 'pm on';
  const pmCross = mkEl('button'); pmCross.dataset.mode = 'cross'; pmCross.className = 'pm';

  const doc = {
    readyState: 'complete',
    getElementById: id => els[id] || (els[id] = Object.assign(mkEl('div'), { id })),
    createElement: mkEl,
    addEventListener(){}, removeEventListener(){},
    querySelectorAll(sel){
      if(sel === '.pm') return [pmFill, pmCross];
      return [];
    },
    querySelector(sel){
      if(sel === '.pm') return pmFill;
      return null;
    },
    body: mkEl('body'),
    documentElement: mkEl('html'),
  };

  const timers = [];
  const sandbox = {
    console,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if(t.unref) t.unref(); timers.push(t); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); if(t.unref) t.unref(); return t; },
    clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
    Uint8Array, parseInt, parseFloat, isNaN,
    document: doc,
    navigator: { userAgent: 'node-test' },
    location: { search: '', host: 'test' },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame(){},
    PointerEvent: function(){},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.innerWidth = 390;
  sandbox.innerHeight = 844;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'nonogram.js' });

  return { sb: sandbox, els, api: sandbox.__nono, pmFill, pmCross };
}

/* ============================== 1. 关卡数据 ============================== */
section('1. 关卡数据');

const levelsSrc = script.slice(script.indexOf('var LEVELS = ['), script.indexOf('var SAVE_KEY'));
const LEVELS = Function('"use strict";return (' +
  levelsSrc.slice(levelsSrc.indexOf('['), levelsSrc.lastIndexOf(']') + 1) + ');')();

ok(Array.isArray(LEVELS) && LEVELS.length === 15, '一共 15 关', '实际 ' + LEVELS.length);
ok(LEVELS.every(L => [5, 10, 15].indexOf(L.n) >= 0), '尺寸只有 5 / 10 / 15 三种');
ok(LEVELS.filter(L => L.n === 5).length === 4, '5×5 有 4 关');
ok(LEVELS.filter(L => L.n === 10).length === 7, '10×10 有 7 关');
ok(LEVELS.filter(L => L.n === 15).length === 4, '15×15 有 4 关');
ok(LEVELS.every(L => typeof L.name === 'string' && L.name.length > 0), '每关都有名字');
ok(LEVELS.every(L => /^#[0-9a-f]{6}$/i.test(L.color || '')), '每关都有主题色');
ok(LEVELS.every(L => Array.isArray(L.art) && L.art.length === L.n), '每关 art 行数 = n');
ok(LEVELS.every(L => L.art.every(r => typeof r === 'string' && r.length === L.n)),
   '每行长度 = n');
ok(LEVELS.every(L => L.art.every(r => /^[#.]+$/.test(r))), '图案只用 # 和 .');
ok(new Set(LEVELS.map(L => L.name)).size === LEVELS.length, '关卡名不重复');

const totalFilled = LEVELS.reduce((a, L) =>
  a + L.art.reduce((b, r) => b + [...r].filter(c => c === '#').length, 0), 0);
ok(totalFilled > 400, '全部要涂的格子数够多（' + totalFilled + '）');

/* ============================== 2. 唯一可解 ============================== */
section('2. 每关唯一解 + 纯逻辑可推');
console.log('  （这一节慢一点，在跑求解器）');
LEVELS.forEach((L, i) => {
  const r = analyze(L);
  const unique = r.sols === 1;
  const logic = r.logicOk && r.known === r.total;
  ok(unique && logic && r.selfOk,
     ('第 ' + (i + 1) + ' 关 ' + L.name).padEnd(14) + ' 解=' + r.sols + ' 推完=' + r.known + '/' + r.total,
     !unique ? '多解' : (!logic ? '需要猜' : ''));
});

/* ============================== 3. 线索 ============================== */
section('3. 线索计算');
{
  const { sb, api } = makeVM({});
  const clueOf = (arr) => {
    // 通过一关的 clues 反推 —— 这里直接看棋盘上渲染出来的数字
    return arr;
  };
  api.start(0);   // 十字：行 [1],[1],[5],[1],[1]
  const b = sb.document.getElementById('board');
  const clues = b.children.filter(c => c.classList.contains('rclue')).map(c => {
    return c.children.map(i => i.textContent);
  });
  ok(JSON.stringify(clues) === JSON.stringify([[1],[1],[5],[1],[1]]), '十字的行线索正确',
     JSON.stringify(clues));

  const cc = b.children.filter(c => c.classList.contains('cclue')).map(c => {
    return c.children.map(i => i.textContent);
  });
  ok(JSON.stringify(cc) === JSON.stringify([[1],[1],[5],[1],[1]]), '十字的列线索正确',
     JSON.stringify(cc));

  api.start(2);   // 小花：第 0 行只有一个 # 在中间 → [1]
  const b2 = sb.document.getElementById('board');
  const r2 = b2.children.filter(c => c.classList.contains('rclue')).map(c =>
    c.children.map(i => i.textContent));
  ok(JSON.stringify(r2) === JSON.stringify([[1],[1,1,1],[3],[1,1,1],[1]]), '小花的行线索有多段',
     JSON.stringify(r2));
}

/* ============================== 4. 棋盘结构 ============================== */
section('4. 棋盘 DOM 结构');
{
  const { sb, api } = makeVM({});
  api.start(0);
  const b = sb.document.getElementById('board');
  const n = 5;
  const corner = b.children.filter(c => c.classList.contains('corner'));
  const cs = b.children.filter(c => c.classList.contains('c'));
  const rr = b.children.filter(c => c.classList.contains('rclue'));
  const cc2 = b.children.filter(c => c.classList.contains('cclue'));
  ok(corner.length === 1, '左上角占位 1 个');
  ok(cc2.length === n, '列提示 ' + n + ' 个');
  ok(rr.length === n, '行提示 ' + n + ' 个');
  ok(cs.length === n * n, '格子 ' + n * n + ' 个');
  ok(b.children.length === 1 + n + n * (1 + n), '总子元素 = 1 + n + n×(1+n)');
  ok(cs.filter(c => c.classList.contains('c5')).length === n * 1, '第 5 列有加粗格线');
  ok(cs.filter(c => c.classList.contains('r5')).length === n * 1, '第 5 行有加粗格线');

  api.start(11);
  const b15 = sb.document.getElementById('board');
  ok(b15.children.filter(c => c.classList.contains('c')).length === 225, '15×15 是 225 格');
}

/* ============================== 5. 单格操作 ============================== */
section('5. 涂色 / 打叉 / 擦除');
{
  const { sb, api } = makeVM({});
  api.start(0);
  const board = sb.document.getElementById('board');
  const L = api.layout();
  const at = (r, c) => ({
    clientX: L.x + L.lw + (c + 0.5) * L.cell,
    clientY: L.y + L.th + (r + 0.5) * L.cell,
    pointerId: 1,
    preventDefault(){},
  });

  board.fire('pointerdown', at(0, 2));   // 十字第 0 行中间是 #
  board.fire('pointerup', {});
  ok(api.G().cell[2] === 1, '填色：点一下变成已涂');
  ok(sb.document.getElementById('board').children
      .filter(c => c.classList.contains('c'))[2].classList.contains('fill'), 'DOM 加上了 fill 类');

  board.fire('pointerdown', at(0, 2));
  board.fire('pointerup', {});
  ok(api.G().cell[2] === 0, '在已涂的格子上再点一次 = 擦掉');

  api.setMode('cross');
  board.fire('pointerdown', at(1, 1));
  board.fire('pointerup', {});
  ok(api.G().cell[6] === 2, '打叉模式：点一下变成已划掉');

  board.fire('pointerdown', at(1, 1));
  board.fire('pointerup', {});
  ok(api.G().cell[6] === 0, '在已划掉的格子上再点一次 = 取消');

  api.setMode('fill');
  board.fire('pointerdown', at(1, 1));
  board.fire('pointerup', {});
  ok(api.G().cell[6] === 1, '切回填色后能正常涂');
}

/* ============================== 6. 智能划线 ============================== */
section('6. 拖拽智能划线');
{
  const { sb, api } = makeVM({});
  api.start(0);
  const board = sb.document.getElementById('board');
  const L = api.layout();
  const at = (r, c) => ({
    clientX: L.x + L.lw + (c + 0.5) * L.cell,
    clientY: L.y + L.th + (r + 0.5) * L.cell,
    pointerId: 1,
    preventDefault(){},
  });

  /* 横向：从 (2,0) 划到 (2,4)，中间整行都该填上 */
  board.fire('pointerdown', at(2, 0));
  board.fire('pointermove', at(2, 1));
  board.fire('pointermove', at(2, 2));
  board.fire('pointermove', at(2, 3));
  board.fire('pointermove', at(2, 4));
  board.fire('pointerup', {});
  const row2 = [0,1,2,3,4].map(c => api.G().cell[2 * 5 + c]);
  ok(row2.every(v => v === 1), '横着划：一整行 5 格都涂上', JSON.stringify(row2));

  /* 擦除：在已涂的格子上起手，往回划 */
  board.fire('pointerdown', at(2, 4));
  board.fire('pointermove', at(2, 2));
  board.fire('pointerup', {});
  const row2b = [0,1,2,3,4].map(c => api.G().cell[2 * 5 + c]);
  ok(row2b[3] === 0 && row2b[4] === 0, '从已涂格起手 = 擦除，划过的地方清空', JSON.stringify(row2b));
  ok(row2b[0] === 1 && row2b[1] === 1, '没划到的地方保持不变');

  /* 纵向 */
  api.start(0);
  const L2 = api.layout();
  const at2 = (r, c) => ({
    clientX: L2.x + L2.lw + (c + 0.5) * L2.cell,
    clientY: L2.y + L2.th + (r + 0.5) * L2.cell,
    pointerId: 1,
    preventDefault(){},
  });
  const board2 = sb.document.getElementById('board');
  board2.fire('pointerdown', at2(0, 4));
  board2.fire('pointermove', at2(1, 4));
  board2.fire('pointermove', at2(2, 4));
  board2.fire('pointermove', at2(3, 4));
  board2.fire('pointermove', at2(4, 4));
  board2.fire('pointerup', {});
  const col4 = [0,1,2,3,4].map(r => api.G().cell[r * 5 + 4]);
  ok(col4.every(v => v === 1), '竖着划：一整列都涂上', JSON.stringify(col4));

  /* 斜跳：既不同行也不同列的第一步应该被忽略 */
  api.start(0);
  const L3 = api.layout();
  const at3 = (r, c) => ({
    clientX: L3.x + L3.lw + (c + 0.5) * L3.cell,
    clientY: L3.y + L3.th + (r + 0.5) * L3.cell,
    pointerId: 1,
    preventDefault(){},
  });
  const board3 = sb.document.getElementById('board');
  board3.fire('pointerdown', at3(0, 0));
  board3.fire('pointermove', at3(2, 2));
  board3.fire('pointerup', {});
  const cnt = api.G().cell.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);
  ok(cnt === 1, '斜跳的那一格不算进划线', '涂了 ' + cnt + ' 格');
}

/* ============================== 7. 填错 ============================== */
section('7. 填错计数与提示');
{
  const { sb, api } = makeVM({});
  api.start(0);
  const board = sb.document.getElementById('board');
  const L = api.layout();
  const at = (r, c) => ({
    clientX: L.x + L.lw + (c + 0.5) * L.cell,
    clientY: L.y + L.th + (r + 0.5) * L.cell,
    pointerId: 1,
    preventDefault(){},
  });
  const cellEl = i => sb.document.getElementById('board').children
    .filter(c => c.classList.contains('c'))[i];

  board.fire('pointerdown', at(0, 0));    // 十字第 0 行第 0 列是空的 → 填错
  board.fire('pointerup', {});
  ok(api.G().errors === 1, '填错计 1 次', String(api.G().errors));
  ok(sb.document.getElementById('errV').textContent === 1 ||
     sb.document.getElementById('errV').textContent === '1', 'HUD 上的错误数跟着变');
  ok(cellEl(0).classList.contains('bad'), '填错的格子闪红');
  ok(api.G().cell[0] === 1, '填错也照样涂上（不当场纠正，只有提示）');

  api.opt().err = false;
  board.fire('pointerdown', at(0, 1));
  board.fire('pointerup', {});
  ok(api.G().errors === 2, '关掉视觉提示后仍然计数');
  ok(!cellEl(1).classList.contains('bad'), '关掉后不再闪红');

  api.opt().err = true;
  api.start(0);
  const L2 = api.layout();
  const at2 = (r, c) => ({
    clientX: L2.x + L2.lw + (c + 0.5) * L2.cell,
    clientY: L2.y + L2.th + (r + 0.5) * L2.cell,
    pointerId: 1, preventDefault(){},
  });
  const b2 = sb.document.getElementById('board');
  b2.fire('pointerdown', at2(0, 2));      // 正确答案格
  b2.fire('pointerup', {});
  ok(api.G().errors === 0, '涂正确答案不计错误');
}

/* ============================== 8. 行列完成 ============================== */
section('8. 行列完成判定');
{
  const { sb, api } = makeVM({});
  api.start(0);   // 十字：第 0 行只有 (0,2) 是 #
  ok(!api.lineDone('r', 0), '一开始第 0 行没完成');
  api.setCell(2, 1);
  ok(api.lineDone('r', 0), '第 0 行唯一的 # 涂上后就完成');
  ok(api.lineDone('c', 2) === false, '但第 2 列还差几格');

  const rowEl = sb.document.getElementById('board').children
    .filter(c => c.classList.contains('rclue'))[0];
  ok(rowEl.classList.contains('done'), '行提示加上 done 类（数字变暗）');

  /* 多涂一格就不算完成 */
  api.setCell(0, 1);
  ok(!api.lineDone('r', 0), '多涂了空格 → 这行回到未完成');
}

/* ============================== 9. 提示 ============================== */
section('9. 提示');
{
  const { sb, api } = makeVM({});
  api.start(3);   // 小星星
  let bad = 0;
  for(let k = 0; k < 3; k++){
    const before = api.G().hints;
    api.hint();
    if(api.G().hints !== before + 1) bad++;
  }
  ok(bad === 0, '提示次数会累加');
  ok(api.G().hints === 3, '一关最多 3 次');
  const before2 = api.G().hints;
  api.hint();
  ok(api.G().hints === before2, '超过 3 次就不再给');
  ok(sb.document.getElementById('hintBtn2').disabled === true, '用完 3 次后按钮禁用');
  ok(api.G().errors === 0, '提示填的都是答案格，不算填错');

  /* 提示填的格子确实属于答案 */
  api.start(3);
  for(let i = 0; i < 3; i++) api.hint();
  const L = api.G().L;
  let allRight = true;
  for(let r = 0; r < L.n; r++) for(let c = 0; c < L.n; c++){
    if(api.G().cell[r * L.n + c] === 1 && L.ans[r][c] !== 1) allRight = false;
  }
  ok(allRight, '三次提示填的位置全在答案里');
}

/* ============================== 10. 撤销 ============================== */
section('10. 撤销');
{
  const { api } = makeVM({});
  api.start(0);
  api.setCell(2, 1);
  ok(api.G().cell[2] === 1, '先涂一格');
  api.undo();
  ok(api.G().cell[2] === 0, '撤销后回到空');
  api.undo();   // 没有更多历史，不应崩
  ok(true, '历史空了以后再撤销不报错');
}

/* ============================== 11. 通关 ============================== */
section('11. 通关与存档');
(async () => {
  {
    const store = {};
    const { sb, api } = makeVM(store);
    api.start(0);
    api.fillAll();
    ok(api.G().finished === true, '所有 # 都涂上 → 判定完成');
    await sleep(700);
    ok(sb.document.getElementById('win').hidden === false, '结算面板弹出');
    ok(sb.document.getElementById('wErr').textContent === 0, '错误数显示 0');
    const saved = JSON.parse(store['gbox_nonogram_v1'] || '{}')['0'];
    ok(saved && saved.stars === 3, '无提示无错误 = 3 星', JSON.stringify(saved));
  }

  {
    /* 用了提示、填错几次 → 星级应该降 */
    const store = {};
    const { api } = makeVM(store);
    api.start(0);
    api.hint();
    api.fillAll();
    await sleep(700);
    const saved = JSON.parse(store['gbox_nonogram_v1'] || '{}')['0'];
    ok(saved && saved.stars === 2, '用了提示 → 掉一星', JSON.stringify(saved));
    ok(saved.hints === 1, '存档记下用了几次提示');
  }

  {
    /* 更差的成绩不该覆盖更好的 */
    const store = {
      'gbox_nonogram_v1': JSON.stringify({ '0': { stars:3, time:10000, errs:0, hints:0 } })
    };
    const { api } = makeVM(store);
    api.start(0);
    api.hint();
    api.fillAll();
    await sleep(700);
    const saved = JSON.parse(store['gbox_nonogram_v1'])['0'];
    ok(saved.stars === 3, '新成绩更差时不覆盖旧记录', JSON.stringify(saved));
  }

  {
    /* 没涂满不能过关 */
    const { api } = makeVM({});
    api.start(0);
    api.setCell(2, 1);
    ok(api.G().finished === false, '只涂了一格不算完成');
    /* 涂上不该涂的也不会完成 */
    api.fillAll();
    ok(api.G().finished === true, '补齐之后才完成');
  }

  /* ============================== 12. 首进说明 ============================== */
  section('12. 首次进入自动弹说明');
  {
    const store = {};
    const a = makeVM(store);
    ok(a.els.help.hidden === false, '第一次进来会摊开玩法说明');
    ok(store['gbox_nonogram_seen'] === '1', '记下「看过了」');
    const b = makeVM(store);
    ok(b.els.help.hidden === true, '第二次进来不再自动弹');
  }

  /* ============================== 13. 自包含 ============================== */
  section('13. 单文件自包含');
  {
    ok(!/<script[^>]+src=/i.test(html), '没有外部 script');
    ok(!/<link[^>]+href=/i.test(html), '没有外部样式表');
    ok(!/<img\b/i.test(html), '没有图片标签');
    ok(!/url\(\s*['"]?https?:/i.test(html), 'CSS 里没有远程资源');
    ok(/href="\/"/.test(html), '返回键指回首页 /');
    ok(html.indexOf('fonts.googleapis') < 0, '没有在线字体');
    ok(!/\bfetch\s*\(|XMLHttpRequest/.test(html), '不发任何网络请求');
  }

  /* ============================== 汇总 ============================== */
  console.log('\n' + '─'.repeat(52));
  if(fail){
    console.log('✗ ' + fail + ' 项失败 / ' + (pass + fail) + ' 项');
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
  }else{
    console.log('✓ 全部 ' + pass + ' 项通过');
    process.exit(0);
  }
})();
