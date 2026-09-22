#!/usr/bin/env node
/**
 * 仓库番关卡回归测试：把每一关的「官方解法」在真实游戏逻辑里重放一遍。
 *
 * 为什么用重放而不是自己求解：官方记录的解（多为 YASA/YASO 优化器的结果）本身就是
 * 可解性证明，比跑最优求解器可靠得多（Laborious 那类大关最优搜索会状态爆炸）。
 *
 * 断言：
 *   1) 每关重放官方解法后必须判定通关（win === true）
 *   2) 游戏自己数出来的 pushes / moves 必须与参考最优解**完全一致**
 *      —— 这一条才是关键：它证明游戏的移动规则（墙/推箱/只能推不能拉）与
 *         当初验证过官方解法的参考实现是同一套规则
 *   3) 关卡表覆盖完整（24 关）、每关地图尺寸在手机可玩范围内
 *   4) 从第 1 关能一路「下一关」走到最后一关（导航链路通）
 *
 * 用法：node tools/test_sokoban.js [关卡表.json]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT = path.join(__dirname, '..');
const HTML = path.join(PROJECT, 'web', 'sokoban', 'index.html');
const LEVELS_JSON = process.argv[2] || path.join(PROJECT, 'tools', 'final_levels4.json');

const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const refLevels = JSON.parse(fs.readFileSync(LEVELS_JSON, 'utf8'));

/* ---------------- DOM / Canvas 桩 ---------------- */
const all = [];
function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag || 'div', dataset: {}, style: {}, textContent: '', onclick: null,
    width: 0, height: 0, clientWidth: 0, clientHeight: 0, value: '', _h: {},
    children: [], firstChild: null, parentNode: null,
    appendChild(ch) { this.children.push(ch); ch.parentNode = this; this.firstChild = this.children[0] || null; },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    removeEventListener(t, fn) { if (this._h[t]) this._h[t] = this._h[t].filter(f => f !== fn); },
    dispatch(t, ev) {
      ev = ev || {};
      if (!ev.preventDefault) ev.preventDefault = () => {};
      if (!ev.target) ev.target = this;
      (this._h[t] || []).slice().forEach(fn => fn(ev));
      if (t === 'click' && this.onclick) this.onclick(ev);
    },
    closest() { return null; },
    _is(sel) { return sel.split('.').filter(Boolean).every(c => set.has(c)); },
    querySelectorAll(sel) { return all.filter(e => e._is(sel)); },
    querySelector(sel) { return all.filter(e => e._is(sel))[0] || null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 360, right: 360, bottom: 360 }; },
    getContext() { return ctxStub; },
    focus() {},
    click() { el.dispatch('click', { target: el }); },
  };
  el.classList = {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
  };
  Object.defineProperty(el, 'className', {
    get: () => [...set].join(' '),
    set: v => { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => set.add(x)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html || '',
    set: v => { el._html = v; if (v === '') { el.children = []; el.firstChild = null; } },
  });
  all.push(el);
  return el;
}
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'measureText') return () => ({ width: 10 });
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});

const byId = {};
const docHandlers = {};
const document = {
  hidden: false,
  createElement: mkEl,
  getElementById(id) { return all.find(e => e.id === id) || (byId[id] = byId[id] || mkEl('div')); },
  querySelector(sel) { return sel.startsWith('#') ? document.getElementById(sel.slice(1)) : mkEl('div'); },
  querySelectorAll(sel) { return all.filter(e => e._is(sel)); },
  addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
  removeEventListener() {},
  dispatch(t, ev) { ev = ev || {}; if (!ev.preventDefault) ev.preventDefault = () => {}; (docHandlers[t] || []).forEach(fn => fn(ev)); },
  documentElement: { scrollHeight: 600 },
  body: mkEl('body'),
};

let vnow = 0, seq = 0;
const timers = new Map();
const performance = { now: () => vnow };
function setTimeout_(fn, ms) { const id = ++seq; timers.set(id, { t: vnow + (ms || 0), fn, rep: 0 }); return id; }
function setInterval_(fn, ms) { const id = ++seq; timers.set(id, { t: vnow + (ms || 1), fn, rep: ms || 1 }); return id; }
function clearTimer(id) { timers.delete(id); }
function runTimers(max = 100000) {
  let n = 0;
  for (; n < max; n++) {
    let best = null, bid = null;
    for (const [id, t] of timers) if (!best || t.t < best.t) { best = t; bid = id; }
    if (!best) return n;
    vnow = Math.max(vnow, best.t);
    if (best.rep) best.t = vnow + best.rep; else timers.delete(bid);
    best.fn();
  }
  return n;
}

const localStorage = {
  _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};
const win = { devicePixelRatio: 1, innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} };

const sandbox = {
  document, localStorage, performance,
  location: { search: '' },
  setTimeout: setTimeout_, setInterval: setInterval_, clearTimeout: clearTimer, clearInterval: clearTimer,
  requestAnimationFrame: fn => setTimeout_(() => fn(vnow), 16), cancelAnimationFrame: clearTimer,
  getComputedStyle: () => ({ getPropertyValue: k => (k === '--mw' ? '480px' : '') }),
  Math, JSON, console, window: win, Promise, Date, Number, String, Array, Object, Error,
  isNaN, parseInt, parseFloat, Boolean, Set, Map, Infinity, NaN,
};
sandbox.window.document = document;
sandbox.window.localStorage = localStorage;
sandbox.globalThis = sandbox;

document.getElementById('stage').clientHeight = 560;
document.getElementById('stage').clientWidth = 362;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'sokoban-inline.js' });

const S = () => win.__sokoban();
const $ = id => document.getElementById(id);

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0; const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
}
const KEY = { U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' };

/* ================= 1) 关卡表体检 ================= */
console.log('\n== 1) 关卡表体检 ==');
ok(refLevels.length === 24, `关卡数 24（实际 ${refLevels.length}）`);
const minPush = Math.min(...refLevels.map(l => l.best.pushes));
ok(minPush >= 14, `难度下限 ≥14 推（实际 ${minPush}）`,
   '前期不该出现 1~9 推的消遣关');
const sizes = refLevels.map(l => l.size.split('x').map(Number));
ok(sizes.every(([h, w]) => w <= 18 && h <= 18), '所有关卡尺寸 ≤18×18（手机可玩）',
   JSON.stringify(refLevels.filter((l, i) => sizes[i][0] > 18 || sizes[i][1] > 18).map(l => l.size)));
const pushSeq = refLevels.map(l => l.best.pushes);
ok(pushSeq.every((p, i) => i === 0 || p >= pushSeq[i - 1]), '推动数单调不减（难度曲线不回头）', pushSeq.join(','));

/* ================= 2) 逐关重放官方解法 ================= */
console.log('\n== 2) 逐关重放官方解法（真实游戏逻辑）==');
const rows = [];
for (let i = 0; i < refLevels.length; i++) {
  const ref = refLevels[i];
  const before = S();
  if (before.lv !== i + 1) {
    // 用 UI 导航到目标关（点和玩家一样的按钮）
    $('btnReset').click();
    let guard = 0;
    while (S().lv !== i + 1 && guard++ < 60) {
      if (S().lv < i + 1) $('btnNext').click(); else $('btnPrev').click();
    }
  }
  const start = S();
  if (start.lv !== i + 1) { rows.push({ no: i + 1, err: `无法导航到第 ${i + 1} 关（当前 ${start.lv}）` }); continue; }

  const sol = (ref.sol || '').toUpperCase().replace(/[^UDLR]/g, '');
  for (const ch of sol) document.dispatch('keydown', { key: KEY[ch], preventDefault() {} });
  runTimers(50);                                   // 消化 checkWin 的延迟面板

  const end = S();
  const good = end.win === true && end.pushes === ref.best.pushes && end.moves === ref.best.moves;
  rows.push({
    no: i + 1, name: ref.name, size: ref.size,
    refPush: ref.best.pushes, refMove: ref.best.moves,
    gotPush: end.pushes, gotMove: end.moves, gotWin: end.win, good,
  });
  if (!good) {
    ok(false, `第 ${i + 1} 关 重放失败`,
       `ref=${ref.best.pushes}推/${ref.best.moves}步 got=${end.pushes}推/${end.moves}步 win=${end.win}`);
  }
}
const bad = rows.filter(r => !r.good);
ok(bad.length === 0, `24 关全部重放通关且步数/推动数与参考最优解一致`,
   bad.map(b => `#${b.no} ${b.err || `${b.gotPush}推/${b.gotMove}步 win=${b.gotWin} (ref ${b.refPush}/${b.refMove})`}`).join('; '));

console.log('\n    #  推(参考/实得)  步(参考/实得)  判定  关卡');
for (const r of rows) {
  if (r.err) { console.log(`   ${String(r.no).padStart(2)}  ${r.err}`); continue; }
  console.log(`   ${String(r.no).padStart(2)}  ${String(r.refPush).padStart(4)}/${String(r.gotPush).padEnd(4)}`
    + `   ${String(r.refMove).padStart(4)}/${String(r.gotMove).padEnd(4)}   ${r.good ? '✅' : '❌'}  ${r.size}  ${r.name}`);
}

/* ================= 3) 导航链路（1 → 24）================= */
console.log('\n== 3) 导航链路 ==');
$('btnReset').click();
let g = 0;
while (S().lv < refLevels.length && g++ < 200) $('btnNext').click();
ok(S().lv === refLevels.length, `一路「下一关」能走到第 ${refLevels.length} 关（实际 ${S().lv}）`);
const extra = $('btnNext').click();               // 最后一关再点一次：应提示而不是报错
ok(true, '最后一关再点「下一关」不抛异常');
// 撤销一致性：把最后一关重开，走一步再撤销，地图应逐字节还原
$('btnReset').click();
const snap0 = S().map.join('|');
document.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
document.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
const moved = S().map.join('|');
$('btnUndo').click(); $('btnUndo').click();
ok(S().map.join('|') === snap0, '撤销两次后地图逐字节还原（箱子没丢）', moved === snap0 ? '（本来就没动）' : '');

/* ================= 汇总 ================= */
console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
