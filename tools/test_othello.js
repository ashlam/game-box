#!/usr/bin/env node
/**
 * 黑白棋逻辑回归测试（Node + 最小 DOM 桩 + 虚拟时钟，秒级跑完整局）
 * 覆盖：整局流程 / 电脑思考延时 0.4~2s / 跳过分支 / 音效触发 / 结束时的「扫描清点」演出时序
 * 用法：node test_othello.js
 */
const fs = require('fs');
const vm = require('vm');

const HTML = '/volume1/docker/hermes/files/bot_workspace/projects/games-box/web/othello/index.html';
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- DOM 桩 ---------------- */
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
function isDesc(e, node) { let n = e.parentNode; while (n) { if (n === node) return true; n = n.parentNode; } return false; }

const byId = {};
const selCache = {};
const document = {
  createElement: mkEl,
  getElementById: id => {
    const born = all.find(e => e.id === id);          // JS 动态创建并赋了 id 的（如 #scanline）
    if (born) return born;
    return (byId[id] = byId[id] || mkEl('div'));
  },
  querySelector: sel => {
    if (sel.startsWith('#')) return document.getElementById(sel.slice(1));
    return selCache[sel] = selCache[sel] || mkEl('div');       // 没建过的（.seg 等）当成已存在的元素
  },
  querySelectorAll: sel => all.filter(e => e._is(sel)),
  addEventListener() {}, removeEventListener() {},
  documentElement: { scrollHeight: 1000 },
  body: mkEl('body'),
};

/* ---------------- 虚拟时钟 ---------------- */
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
// 推进虚拟时钟到「当前时间 + ms」，用于精确卡在动画中段观察
function runFor(ms) {
  const target = vnow + ms;
  let n = 0;
  while (n++ < 200000) {
    let min = Infinity;
    for (const t of timers.values()) if (t.t < min) min = t.t;
    if (min === Infinity || min > target) { vnow = Math.max(vnow, target); return; }
    runTimers(1);
  }
}

/* ---------------- 假 AudioContext ---------------- */
class FakeCtx {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; FakeCtx.ctx++; }
  createOscillator() {
    return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
             connect() {}, start() { FakeCtx.started++; }, stop() {} };
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  resume() { this.state = 'running'; FakeCtx.resumed++; return Promise.resolve(); }
}
FakeCtx.ctx = 0; FakeCtx.started = 0; FakeCtx.resumed = 0;

const localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const win = { AudioContext: FakeCtx, addEventListener() {}, removeEventListener() {}, innerWidth: 390, innerHeight: 844 };

const sandbox = {
  document, localStorage, performance, setTimeout: setTimeout_, setInterval: setInterval_,
  clearTimeout: clearTimer, clearInterval: clearTimer, requestAnimationFrame: fn => setTimeout_(() => fn(vnow), 16),
  cancelAnimationFrame: clearTimer, getComputedStyle: () => ({ paddingBottom: '20px' }),
  Math, JSON, console, window: win, Promise, Date, Number, String, Array, Object, Error, isNaN, parseInt,
};
sandbox.window.document = document;
sandbox.window.localStorage = localStorage;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'othello-inline.js' });

const el = id => document.getElementById(id);
const cellsWith = cls => all.filter(e => e._is(cls));

/* ---------------- 用例 ---------------- */

// 1) 完整对局 + 结束时「扫描清点」演出（逐拍推进，便于在动画中途观察）
function playFullGameAndWatch() {
  const boardEl = el('board');
  let plies = 0, passMsgs = 0, lastToast = '', guard = 0;
  while (!win.__othello().over && guard++ < 300000) {
    const can = cellsWith('.cell.can');
    if (can.length && !win.__othello().busy) { boardEl.dispatch('click', { target: can[0] }); plies++; }
    runTimers(1);                                   // 一拍一拍走：动画不会被一次性跑完
    const tt = el('toast').textContent;
    if (/跳过|继续/.test(tt) && tt !== lastToast) { passMsgs++; lastToast = tt; }
  }
  const s = win.__othello();
  const finalB = s.black, finalW = s.white;

  const snap = {
    plies, passMsgs, finalB, finalW, over: s.over,
    atFinish: {
      overlayShown: el('over').classList.contains('on'),
      cntB: el('cntB').textContent, cntW: el('cntW').textContent,
      status: el('status').textContent,
      introOn: el('intro').classList.contains('on'),
      tallyOn: el('tallyB').classList.contains('on'),
      flashed: cellsWith('.disc.flash').length,
    },
    samples: [],
  };
  const t0 = vnow;
  let g2 = 0, lastTotal = 0, introOffAt = null, firstDiscAt = null;
  const wanted = [3, 8, 15, 30, 50];                  // 数到第 N 枚时取样
  while (g2++ < 60000 && !el('over').classList.contains('on')) {
    const introWasOn = el('intro').classList.contains('on');
    runTimers(1);
    if (introWasOn && !el('intro').classList.contains('on') && introOffAt === null) introOffAt = vnow - t0;
    const b = +el('cntB').textContent || 0, w = +el('cntW').textContent || 0;
    if (b + w > lastTotal) {
      lastTotal = b + w;
      if (firstDiscAt === null) firstDiscAt = vnow - t0;
      if (wanted.includes(lastTotal)) {
        snap.samples.push({ nth: lastTotal, t: vnow - t0, b, w,
                            flashes: cellsWith('.disc.flash').length,
                            tallyB: el('tallyB').querySelector('.fill').style.height });
      }
    }
  }
  snap.introOffAt = introOffAt;          // 过渡提示收起（= 数子开始）的时刻
  snap.firstDiscAt = firstDiscAt;        // 第一枚被数到的时刻
  snap.overlayAtMs = vnow - t0;
  snap.after = {
    cntB: +el('cntB').textContent, cntW: +el('cntW').textContent,
    title: el('overTitle').textContent, text: el('overText').textContent,
    flashed: cellsWith('.disc.flash').length,
    tallyOff: !el('tallyB').classList.contains('on') && !el('tallyW').classList.contains('on'),
    winnerMarked: el('sideB').classList.contains('win') || el('sideW').classList.contains('win'),
  };
  return snap;
}

// 1b) 量「每枚棋子的清点间隔」——应当是固定的 COUNT_STEP_MS（0.4 秒）
function measureCountInterval(n = 10) {
  el('btnNew').dispatch('click', { target: el('btnNew') });
  runFor(60);
  const boardEl = el('board');
  let g = 0;
  while (!win.__othello().over && g++ < 300000) {
    const can = cellsWith('.cell.can');
    if (can.length && !win.__othello().busy) boardEl.dispatch('click', { target: can[0] });
    runTimers(1);
  }
  const marks = [];
  let prev = +el('cntB').textContent + +el('cntW').textContent || 0;
  let guard = 0;
  while (marks.length < n && guard++ < 200000) {
    runTimers(1);
    const now = (+el('cntB').textContent || 0) + (+el('cntW').textContent || 0);
    if (now > prev) { marks.push(vnow); prev = now; }
  }
  const deltas = marks.slice(1).map((t, i) => Math.round(t - marks[i]));
  return { deltas };
}

// 2) 电脑思考延时（重开一局后逐手量）
function measureDelays(n = 8) {
  el('btnNew').dispatch('click', { target: el('btnNew') });
  runTimers(50);
  const boardEl = el('board');
  const out = [];
  for (let i = 0; i < n; i++) {
    const can = cellsWith('.cell.can');
    if (!can.length) break;
    const t0 = vnow;
    boardEl.dispatch('click', { target: can[0] });
    let g = 0;
    while (win.__othello().busy && g++ < 5000) runTimers(1);
    out.push(Math.round(vnow - t0));
  }
  return out;
}

// 3) 悔棋要能取消清点演出
function undoDuringCount() {
  el('btnNew').dispatch('click', { target: el('btnNew') });
  runFor(50);
  const boardEl = el('board');
  let g = 0;
  while (!win.__othello().over && g++ < 300000) {
    const can = cellsWith('.cell.can');
    if (can.length && !win.__othello().busy) boardEl.dispatch('click', { target: can[0] });
    runTimers(1);
  }
  runFor(1500);                                                // 数到中段（0.4s/枚 ⇒ 约 3 枚）
  const midFlashes = cellsWith('.disc.flash').length;
  const midCounts = { b: +el('cntB').textContent || 0, w: +el('cntW').textContent || 0,
                      overlayShown: el('over').classList.contains('on'),
                      tallyOn: el('tallyB').classList.contains('on') };
  el('btnUndo').dispatch('click', { target: el('btnUndo') });
  runFor(40);
  const flashesAfterUndo = cellsWith('.disc.flash').length;
  runFor(600);                                                 // 再等一段：不应该继续数下去
  const flashesLater = cellsWith('.disc.flash').length;
  const s = win.__othello();
  const stopped = flashesAfterUndo === flashesLater;            // 撤销后不再继续数
  const restored = +el('cntB').textContent === s.black && +el('cntW').textContent === s.white;
  const overlayStaysHidden = !el('over').classList.contains('on');
  return { midFlashes, midCounts, flashesAfterUndo, flashesLater, stopped, restored,
           overlayStaysHidden, black: s.black, white: s.white, over: s.over };
}

const res = {};
const g1 = playFullGameAndWatch();
res.game = {
  plies: g1.plies, over: g1.over, final: g1.finalB + ':' + g1.finalW, passMsgs: g1.passMsgs,
  atFinish: g1.atFinish, samples: g1.samples, overlayAtMs: g1.overlayAtMs, after: g1.after,
  introOffAt: g1.introOffAt, firstDiscAt: g1.firstDiscAt,
};
res.countDurationInRange = g1.overlayAtMs >= 10400 && g1.overlayAtMs <= 11900;   // 过渡 1100 + 64×150 + 停顿 460
res.overlayNotEarly = g1.atFinish.overlayShown === false;
res.introBeforeCount = g1.atFinish.introOn === true && g1.atFinish.status === '对局结束' &&
                       g1.atFinish.flashed === 0 && g1.atFinish.tallyOn === false && g1.atFinish.cntB === '–';
res.introDuration = g1.introOffAt !== null && Math.abs(g1.introOffAt - 1100) <= 40;      // 过渡约 1.1 秒
res.countStartsAfterIntro = g1.firstDiscAt !== null && g1.firstDiscAt > g1.introOffAt;    // 数子在过渡收起之后才开始
res.noEarlyOverlay = g1.samples.every(s => s.b + s.w < g1.finalB + g1.finalW);
res.countersGrow = g1.samples.length >= 2 && g1.samples[0].b + g1.samples[0].w < g1.samples[g1.samples.length - 1].b + g1.samples[g1.samples.length - 1].w;
res.oneByOne = g1.after.flashed === 64 && g1.samples.length > 0 &&
               g1.samples.every(s => s.flashes === s.b + s.w);     // 闪过的枚数 == 已计的黑+白 ⇒ 一枚一枚数
res.tallyGrew = parseFloat((g1.samples[g1.samples.length - 1] || {}).tallyB || '0') > 0;
res.delays = measureDelays();
res.delaysInRange = res.delays.length >= 5 && res.delays.every(d => d >= 400 && d <= 2000);
res.undo = undoDuringCount();
res.countInterval = measureCountInterval(10);
res.countIntervalOk = res.countInterval.deltas.length >= 5 &&
                      res.countInterval.deltas.every(d => Math.abs(d - 150) <= 15);   // 每枚 0.15 秒
res.audio = { oscStarted: FakeCtx.started };
res.verdict = {
  gameFinished: g1.over === true,
  discsAddTo64: (g1.finalB + g1.finalW) === 64,
  noResultBeforeCounting: res.overlayNotEarly,
  introShownAfterEnd: res.introBeforeCount,
  introDurationOk: res.introDuration,
  countStartsAfterIntro: res.countStartsAfterIntro,
  countDurationOk: res.countDurationInRange,
  countersCounted: g1.after.cntB === g1.finalB && g1.after.cntW === g1.finalW,
  oneByOneCounting: res.oneByOne,
  allDiscsFlashed: g1.after.flashed === 64,
  perDiscInterval150ms: res.countIntervalOk,
  delayInRange: res.delaysInRange,
  undoCancels: res.undo.stopped && res.undo.restored,
  soundFired: FakeCtx.started > 0,
};
res.verdict.allPass = Object.values(res.verdict).every(Boolean);
console.log(JSON.stringify(res, null, 1));
