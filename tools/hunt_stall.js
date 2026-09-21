#!/usr/bin/env node
/**
 * 卡死猎手：用真实游戏脚本跑大量完整对局，专找「棋盘已满/双方无子可下但游戏不结束」的 stall。
 * 抓到时 dump 局面（棋盘、轮到谁、双方能否落子），便于定位。
 * 用法：node hunt_stall.js [局数]
 */
const fs = require('fs');
const vm = require('vm');

const HTML = '/opt/data/games/othello/index.html';
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------- 复用测试桩（从 test_othello.js 里精简出来） ---------- */
const all = [];
function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag || 'div', dataset: {}, style: {}, textContent: '',
    children: [], firstChild: null, parentNode: null, onclick: null, _h: {},
    offsetHeight: 0, offsetWidth: 0,
    appendChild(ch) { this.children.push(ch); ch.parentNode = this; this.firstChild = this.children[0] || null; },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    removeEventListener(t, fn) { if (this._h[t]) this._h[t] = this._h[t].filter(f => f !== fn); },
    dispatch(t, ev) { (this._h[t] || []).forEach(fn => fn(ev)); if (t === 'click' && this.onclick) this.onclick(ev); },
    closest(sel) { let n = this; while (n) { if (n._is(sel)) return n; n = n.parentNode; } return null; },
    _is(sel) { return sel.split('.').filter(Boolean).every(c => set.has(c)); },
    getBoundingClientRect() { return { bottom: 640, top: 0, left: 0, right: 0, width: 0, height: 0 }; },
    querySelectorAll(sel) { return all.filter(e => e._is(sel) && isDesc(e, this)); },
    querySelector(sel) { return all.filter(e => e._is(sel) && isDesc(e, this))[0] || null; },
    click() { this.dispatch('click', { target: this }); },
  };
  el.classList = {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); },
  };
  Object.defineProperty(el, 'className', { get: () => [...set].join(' '), set: v => { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => set.add(x)); } });
  Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: v => { el._html = v; if (v === '') { el.children = []; el.firstChild = null; } } });
  all.push(el);
  return el;
}
function isDesc(e, node) { let n = e.parentNode; while (n) { if (n === node) return true; n = n.parentNode; } return false; }

const byId = {}, selCache = {};
const document = {
  createElement: mkEl,
  getElementById: id => { const born = all.find(e => e.id === id); return born || (byId[id] = byId[id] || mkEl('div')); },
  querySelector: sel => sel.startsWith('#') ? document.getElementById(sel.slice(1)) : (selCache[sel] = selCache[sel] || mkEl('div')),
  querySelectorAll: sel => all.filter(e => e._is(sel)),
  addEventListener() {}, removeEventListener() {},
  documentElement: { scrollHeight: 1000 }, body: mkEl('body'),
};
let vnow = 0, seq = 0;
const timers = new Map();
const performance = { now: () => vnow };
function setTimeout_(fn, ms) { const id = ++seq; timers.set(id, { t: vnow + (ms || 0), fn, rep: 0 }); return id; }
function setInterval_(fn, ms) { const id = ++seq; timers.set(id, { t: vnow + (ms || 1), fn, rep: ms || 1 }); return id; }
function clearTimer(id) { timers.delete(id); }
function runTimers(max = 200000) {
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
function runFor(ms) { const target = vnow + ms; let n = 0; while (n++ < 200000) { let min = Infinity; for (const t of timers.values()) if (t.t < min) min = t.t; if (min === Infinity || min > target) { vnow = Math.max(vnow, target); return; } runTimers(1); } }
class FakeCtx {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
  createOscillator() { return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  resume() { return Promise.resolve(); }
}
const localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const win = { AudioContext: FakeCtx, addEventListener() {}, removeEventListener() {}, innerWidth: 390, innerHeight: 844 };
const sandbox = { document, localStorage, performance, setTimeout: setTimeout_, setInterval: setInterval_, clearTimeout: clearTimer, clearInterval: clearTimer,
  requestAnimationFrame: fn => setTimeout_(() => fn(vnow), 16), cancelAnimationFrame: clearTimer, getComputedStyle: () => ({ paddingBottom: '20px' }),
  Math, JSON, console, window: win, Promise, Date, Number, String, Array, Object, Error, isNaN, parseInt };
sandbox.window.document = document; sandbox.window.localStorage = localStorage; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'othello-inline.js' });

const el = id => document.getElementById(id);
const cellsWith = cls => all.filter(e => e._is(cls));
const NAMES = { 1: '黑(玩家)', 2: '白(电脑)' };

/* ---------- 棋规参考实现（独立于游戏代码，用来判断"该不该结束"） ---------- */
function refLegal(map, p) {
  const q = 3 - p, dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const out = [];
  const val = (r, c) => map[r][c] === 'b' ? 1 : map[r][c] === 'w' ? 2 : 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (val(r, c) !== 0) continue;
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc, n = 0;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && val(rr, cc) === q) { rr += dr; cc += dc; n++; }
      if (n && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && val(rr, cc) === p) { out.push([r, c]); break; }
    }
  }
  return out;
}
function boardStr(map) { return map.map(r => r.join('')).join('\n'); }

/* ---------- 跑对局，找 stall ---------- */
function setDepth(d) {
  const seg = el('segLv');
  const btns = seg.children && seg.children.length ? seg.children : all.filter(e => e.dataset && e.dataset.lv);
  const b = btns[String(d)] || btns.find(x => String(x.dataset.lv) === String(d));
  if (b) { b.dispatch('click', { target: b }); runFor(10); }
}

function playOne(strategy, depth, undoRate) {
  el('btnNew').dispatch('click', { target: el('btnNew') });
  setDepth(depth);
  el('btnNew').dispatch('click', { target: el('btnNew') });   // 难度重开生效
  runFor(50);
  const boardEl = el('board');
  let plies = 0, guard = 0, passCount = 0, lastToast = '', stallAt = null, undos = 0;
  while (!win.__othello().over && guard++ < 500000) {
    const s = win.__othello();
    const can = cellsWith('.cell.can');
    if (can.length && !s.busy) {
      const pick = strategy === 'first' ? can[0] : strategy === 'last' ? can[can.length - 1] : can[Math.floor(Math.random() * can.length)];
      boardEl.dispatch('click', { target: pick });
      plies++;
    }
    // 随机悔棋：模拟玩家在"电脑连下"的间隙乱点悔棋（busy=false 时是允许的）
    if (undoRate && Math.random() < undoRate && !win.__othello().busy) {
      el('btnUndo').dispatch('click', { target: el('btnUndo') });
      undos++;
    }
    // 精确卡死探测：无人可落子、不忙、也没有任何待触发的定时器 ⇒ 游戏卡住了
    if (!win.__othello().over && !win.__othello().busy && !can.length && !cellsWith('.cell.can').length && timers.size === 0) {
      stallAt = { plies, undos, ...dump() };
      break;
    }
    runTimers(1);
    const tt = el('toast').textContent;
    if (/跳过|继续/.test(tt) && tt !== lastToast) { passCount++; lastToast = tt; }
  }
  const s = win.__othello();
  return { plies, undos, passCount, over: s.over, score: s.black + ':' + s.white, stallAt };
}

function dump() {
  const s = win.__othello();
  const map = s.map;
  const empty = map.join('').split('').filter(ch => ch === ' ' || ch === '.').length;
  const curTurn = s.turn;
  return {
    turn: NAMES[curTurn] || curTurn,
    emptyCells: empty,
    black: s.black, white: s.white,
    aiCanMove: refLegal(map, 2).length,
    humanCanMove: refLegal(map, 1).length,
    pendingTimers: timers.size,
    busy: s.busy, counting: /清点/.test(el('status').textContent),
    status: el('status').textContent,
    board: boardStr(map),
  };
}

const games = parseInt(process.argv[2] || '30', 10);
const undoRate = parseFloat(process.argv[3] || '0');
const strategies = ['first', 'last', 'random'];
const depths = [1, 2, 3, 4];
let stalls = 0, done = 0;
const perDepth = {};
const report = [];
for (let i = 0; i < games; i++) {
  const st = strategies[i % strategies.length];
  const dp = depths[i % depths.length];
  const r = playOne(st, dp, undoRate);
  perDepth[dp] = perDepth[dp] || { games: 0, finished: 0, stalls: 0, passEvents: 0, undos: 0 };
  perDepth[dp].games++;
  perDepth[dp].passEvents += r.passCount;
  perDepth[dp].undos += r.undos || 0;
  if (r.stallAt) {
    stalls++;
    perDepth[dp].stalls++;
    report.push({ game: i + 1, strategy: st, depth: dp, plies: r.plies, undos: r.undos, passCount: r.passCount, stalled: true, ...r.stallAt });
    continue;
  }
  if (!win.__othello().over) {
    runFor(30000);
    if (!win.__othello().over) {
      const d = dump();
      stalls++;
      perDepth[dp].stalls++;
      report.push({ game: i + 1, strategy: st, depth: dp, plies: r.plies, undos: r.undos, passCount: r.passCount, stuck: d.aiCanMove === 0 && d.humanCanMove === 0, ...d });
      continue;
    }
  }
  done++;
  perDepth[dp].finished++;
}
console.log(JSON.stringify({ games, undoRate, finished: done, stalls, perDepth, stallDetails: report }, null, 1));
