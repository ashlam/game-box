#!/usr/bin/env node
/**
 * 仓库番关卡回归测试：把每一关的解法在**真实游戏逻辑**里重放一遍，两套关卡集都测。
 *
 * 断言：
 *   1) 关卡集结构正确（2 套、名称、关卡数）
 *   2) 每关重放解法后必须判定通关，且游戏自数的 pushes / moves 与数据里的参考值**逐字相等**
 *      —— 参考值由 tools/solver3.js 求得（可采纳 A* ⇒ 推动数最优），
 *         这一步同时证明「游戏规则 == 求解器规则」
 *   3) 关卡尺寸在手机可玩范围内（≤18×18）
 *   4) 从选关面板能切换到另一套关卡集，且两套的存档互不干扰（按集合分区）
 *   5) 导航链路完整（第 1 关一路「下一关」能走到最后一关）、撤销能逐字节还原
 *
 * 用法：node tools/test_sokoban.js [level_sets.json]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT = path.join(__dirname, '..');
const HTML = path.join(PROJECT, 'web', 'sokoban', 'index.html');
const SETS_JSON = process.argv[2] || path.join(PROJECT, 'tools', 'level_sets.json');

const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const setDefs = JSON.parse(fs.readFileSync(SETS_JSON, 'utf8'));

/* ---------------- DOM / Canvas 桩 ---------------- */
const all = [];
function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag || 'div', dataset: {}, style: {}, textContent: '', onclick: null, _h: {},
    width: 0, height: 0, clientWidth: 0, clientHeight: 0, value: '', src: '',
    children: [], firstChild: null, parentNode: null, title: '',
    appendChild(ch) { this.children.push(ch); ch.parentNode = this; this.firstChild = this.children[0] || null; return ch; },
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
    set: v => { el._html = String(v); if (v === '') { el.children = []; el.firstChild = null; } },
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
function runTimers(max = 200) {
  for (let n = 0; n < max; n++) {
    let best = null, bid = null;
    for (const [id, t] of timers) if (!best || t.t < best.t) { best = t; bid = id; }
    if (!best) return n;
    vnow = Math.max(vnow, best.t);
    if (best.rep) best.t = vnow + best.rep; else timers.delete(bid);
    best.fn();
  }
  return max;
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
const KEY = { U: 'ArrowUp', D: 'ArrowDown', L: 'ArrowLeft', R: 'ArrowRight' };

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0; const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
}

function goTo(idx) {
  let g = 0;
  while (S().lv !== idx + 1 && g++ < 300) {
    if (S().lv < idx + 1) $('btnNext').click(); else $('btnPrev').click();
  }
  return S().lv === idx + 1;
}

function switchToSet(i) {
  $('btnPick').click();                       // buildPicker() + 打开面板
  const tabs = $('setTabs').children;
  if (!tabs[i]) throw new Error(`没有第 ${i} 个关卡集标签（只有 ${tabs.length} 个）`);
  tabs[i].click();                            // switchSet(i) + 重建面板
  runTimers(10);
  $('picker').classList.remove('on');
  return S().set;
}

/* ================= 1) 关卡集结构 ================= */
console.log('\n== 1) 关卡集结构 ==');
ok(setDefs.length === 2, `共 2 套关卡集（实际 ${setDefs.length}）`);
ok(setDefs.map(s => s.id).join(',') === 'arcade,classic',
   '关卡集顺序：街机版在前（默认）、经典集在后', setDefs.map(s => s.id).join(','));
// 按 id 取用，避免断言和展示顺序耦合
const setById = Object.fromEntries(setDefs.map(s => [s.id, s]));
const idxOfSet = id => setDefs.findIndex(s => s.id === id);
ok(setById.classic.levels.length === 24, `经典集 24 关（实际 ${setById.classic.levels.length}）`);
ok(setById.arcade.levels.length === 48, `街机版 48 关（实际 ${setById.arcade.levels.length}，原版 55 剔除 3 关损坏数据）`);
const allLv = setDefs.flatMap(s => s.levels);
ok(allLv.every(l => /^[# .$*@+]+$/.test([].concat(l.map).join(''))), '所有关卡地图只含合法字符');
const oversize = allLv.filter(l => Math.max(...l.map.map(r => r.length)) > 18 || l.map.length > 18);
ok(oversize.length === 0, '所有关卡尺寸 ≤18×18（手机可玩）', oversize.map(l => l.tag).join(','));
ok(allLv.every(l => l.sol && l.sol.length > 0), '所有关卡都带解法串（可重放验证）',
   allLv.filter(l => !l.sol).map(l => l.tag).join(','));

/* ================= 2) 逐关重放（两套） ================= */
console.log('\n== 2) 逐关重放解法（真实游戏逻辑）==');
for (let si = 0; si < setDefs.length; si++) {
  const set = setDefs[si];
  const got = switchToSet(si);
  console.log(`\n  ── ${set.name}（${set.levels.length} 关）──`);
  ok(got === set.id, `选关面板能切到「${set.name}」（__sokoban().set = ${got}）`);
  ok(S().total === set.levels.length, `切换后关卡总数正确（${S().total}）`);

  const rows = [];
  for (let i = 0; i < set.levels.length; i++) {
    const ref = set.levels[i];
    if (!goTo(i)) { rows.push({ no: i + 1, err: `无法导航到第 ${i + 1} 关` }); continue; }
    const sol = (ref.sol || '').toUpperCase().replace(/[^UDLR]/g, '');
    for (const ch of sol) document.dispatch('keydown', { key: KEY[ch], preventDefault() {} });
    runTimers(60);
    const end = S();
    const good = end.win === true && end.pushes === ref.best.pushes && end.moves === ref.best.moves;
    rows.push({ no: i + 1, tag: ref.tag, refPush: ref.best.pushes, refMove: ref.best.moves,
                gotPush: end.pushes, gotMove: end.moves, gotWin: end.win, good });
  }
  const bad = rows.filter(r => !r.good);
  ok(bad.length === 0, `${set.name}：${set.levels.length} 关全部重放通关，且推动数/步数与参考值一致`,
     bad.map(b => `#${b.tag} ${b.err || `${b.gotPush}推/${b.gotMove}步 win=${b.gotWin} (参考 ${b.refPush}/${b.refMove})`}`).join('; '));
  const show = rows.slice(0, 4).concat(rows.slice(-2));
  show.forEach((r, k) => {
    if (r.err) return console.log(`     ${r.tag}\t${r.err}`);
    console.log(`     ${r.tag}\t参考 ${r.refPush}推/${r.refMove}步\t实得 ${r.gotPush}推/${r.gotMove}步\t${r.good ? '✅' : '❌'}`);
    if (k === 3) console.log('     ...');
  });
}

/* ================= 3) 存档分区 / 导航 / 撤销 ================= */
console.log('\n== 3) 存档分区 · 导航 · 撤销 ==');
const keys = Object.keys(localStorage._d);
ok(keys.some(k => k.startsWith('sokoban_cleared_v5:classic')), '经典集有独立存档键 sokoban_cleared_v5:classic', keys.join(' | '));
ok(keys.some(k => k.startsWith('sokoban_cleared_v5:arcade')), '街机版有独立存档键 sokoban_cleared_v5:arcade');
const cClear = JSON.parse(localStorage._d['sokoban_cleared_v5:classic'] || '[]');
const aClear = JSON.parse(localStorage._d['sokoban_cleared_v5:arcade'] || '[]');
ok(cClear.length === 24 && aClear.length === 48, `两套进度互不干扰（经典 ${cClear.length}/24，街机 ${aClear.length}/48）`);
ok((localStorage._d['sokoban_last_v5:classic'] !== undefined)
   && (localStorage._d['sokoban_last_v5:arcade'] !== undefined), '「上次进度」也按关卡集分开存');

// 导航链路：切回经典集一路点到最后一关
switchToSet(idxOfSet('classic'));
ok(S().set === 'classic', '切回经典集');
$('btnReset').click();
const cLen = setById.classic.levels.length;
let g = 0;
while (S().lv < cLen && g++ < 300) $('btnNext').click();
ok(S().lv === cLen, `一路「下一关」能走到第 ${cLen} 关（实际 ${S().lv}）`);
$('btnNext').click();
ok(true, '最后一关再点「下一关」不抛异常');

$('btnReset').click();
const snap0 = S().map.join('|');
document.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
document.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
$('btnUndo').click(); $('btnUndo').click();
ok(S().map.join('|') === snap0, '撤销两次后地图逐字节还原（箱子没丢）');

/* ================= 汇总 ================= */
console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
