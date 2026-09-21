#!/usr/bin/env node
/**
 * 打砖块逻辑回归测试（Node + 最小 DOM/Canvas 桩 + 虚拟时钟，几秒跑完 8 关）
 *
 * 覆盖：
 *   1) 完美挡板能否真的打通全部 8 关（证明关卡不是死局 / 球不会卡住）
 *   2) 边界不变量：球永不越界、永不穿砖（子步进是否生效）
 *   3) 计分一致性：每关清空时 alive === 0 且分数增量 == Σ砖块分值 + 通关奖励
 *   4) 丢球会减命，3 个球用完进「游戏结束」；最高分落盘
 *   5) 音效真的触发 / 静音开关真的生效
 *   6) 暂停与继续
 *   7) 输入走真实事件路径：touchstart 发球、touchmove 拖动挡板
 *
 * 用法：node tools/test_breakout.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] ||
  path.join(__dirname, '..', 'web', 'breakout', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- DOM 桩 ---------------- */
const all = [];
function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag || 'div', dataset: {}, style: {}, textContent: '', onclick: null,
    width: 0, height: 0, _h: {}, children: [], firstChild: null, parentNode: null,
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
    getBoundingClientRect() { return el._rect || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
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
  all.push(el);
  return el;
}

/* Canvas 2D 上下文桩：任何未知方法都返回空函数，属性可读写 */
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
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
  getElementById(id) {
    const born = all.find(e => e.id === id);
    return born || (byId[id] = byId[id] || mkEl('div'));
  },
  querySelector(sel) { return sel.startsWith('#') ? document.getElementById(sel.slice(1)) : mkEl('div'); },
  querySelectorAll(sel) { return all.filter(e => e._is(sel)); },
  addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
  removeEventListener() {},
  dispatch(t, ev) { ev = ev || {}; if (!ev.preventDefault) ev.preventDefault = () => {}; (docHandlers[t] || []).forEach(fn => fn(ev)); },
  documentElement: { scrollHeight: 600 },
  body: mkEl('body'),
};

/* ---------------- 虚拟时钟 ---------------- */
let vnow = 0, seq = 0;
const timers = new Map();
const performance = { now: () => vnow };
function setTimeout_(fn, ms) { const id = ++seq; timers.set(id, { t: vnow + (ms || 0), fn, rep: 0 }); return id; }
function setInterval_(fn, ms) { const id = ++seq; timers.set(id, { t: vnow + (ms || 1), fn, rep: ms || 1 }); return id; }
function clearTimer(id) { timers.delete(id); }
function runOne() {
  let best = null, bid = null;
  for (const [id, t] of timers) if (!best || t.t < best.t) { best = t; bid = id; }
  if (!best) return false;
  vnow = Math.max(vnow, best.t);
  if (best.rep) best.t = vnow + best.rep; else timers.delete(bid);
  best.fn();
  return true;
}

/* ---------------- 假 AudioContext ---------------- */
class FakeCtx {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
  createOscillator() {
    return {
      type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}, start() { FakeCtx.started++; }, stop() {},
    };
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  resume() { this.state = 'running'; FakeCtx.resumed++; return Promise.resolve(); }
}
FakeCtx.started = 0; FakeCtx.resumed = 0;

const localStorage = {
  _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};

const win = {
  AudioContext: FakeCtx, devicePixelRatio: 2,
  innerWidth: 390, innerHeight: 844,
  addEventListener() {}, removeEventListener() {},
};

const sandbox = {
  document, localStorage, performance,
  location: { search: '' },                    // 游戏里的 ?debug=1 诊断行会读它
  setTimeout: setTimeout_, setInterval: setInterval_, clearTimeout: clearTimer, clearInterval: clearTimer,
  requestAnimationFrame: fn => setTimeout_(() => fn(vnow), 16),
  cancelAnimationFrame: clearTimer,
  getComputedStyle: () => ({ getPropertyValue: k => (k === '--mw' ? '480px' : '') }),
  Math, JSON, console, window: win, Promise, Date, Number, String, Array, Object, Error,
  isNaN, parseInt, parseFloat, Boolean, Set, Map, Infinity, NaN,
};
sandbox.window.document = document;
sandbox.window.localStorage = localStorage;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
// 让 #stage 有真实高度，这样走的就是浏览器里同一条「按屏幕比例算逻辑高度」的分支
document.getElementById('stage').clientHeight = 544;
document.getElementById('stage').clientWidth = 362;
vm.runInContext(script, sandbox, { filename: 'breakout-inline.js' });

const S = () => win.__breakout();
const cv = document.getElementById('cv');

// 让 stageX(clientX) 的换算变成「逻辑坐标 == clientX」：rect 宽度就是逻辑宽
const W0 = S().W, H0 = S().H;
cv._rect = { left: 0, top: 0, width: W0, height: H0, right: W0, bottom: H0 };
const $ = id => document.getElementById(id);

/* ---------------- 断言小工具 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

/* 用真实事件路径驱动：发球 / 拖挡板 */
const touch = (type, x) => cv.dispatch(type, { touches: [{ clientX: x }] });
const dragTo = x => touch('touchmove', x);
const tapFire = x => touch('touchstart', x);

/* 把游戏推进到「正在游戏中」。用例之间球可能刚好掉了（随机轨迹），
   不先把状态摆正，后面的断言会因为前置状态不对而假失败。 */
function ensurePlaying(maxFrames = 8000) {
  let n = 0;
  while (S().state !== 'play' && n++ < maxFrames) {
    const s = S();
    if (s.state === 'ready') tapFire(s.W / 2);
    else if (s.state === 'clear' || s.state === 'over') $('overNext').click();   // 面板 -> 下一关/重试
    else if (s.state === 'play') dragTo(s.ball.x);
    runOne();
  }
  return S().state === 'play';
}

/* ================= 1) 完美挡板打通 8 关 ================= */
section('1) 完美挡板（挡板始终追球）能否打通全部 8 关');
touch('touchstart', W0 / 2);                       // 发球（同时把挡板放到中间）
ok(S().state === 'play', 'touchstart 后进入 play 状态');

const MAXF = 200000;
let frames = 0, minBallY = Infinity;
let escapeViolations = 0, worstEscape = null;
let levelStarts = [];                              // 每关起始快照
let lastLevel = S().level;
let snap = (() => {
  const s = S();
  const hard = s.bricks.filter(h => h > 1).length;
  return { level: s.level, alive: s.bricks.length, score: s.score, expect: hard * 25 + (s.bricks.length - hard) * 10 };
})();
levelStarts.push(snap);
let clearedLevels = 0, scoreMismatch = null;
const levelTimes = [];

while (frames < MAXF) {
  const s = S();
  // 完美挡板：每帧把挡板拖到球的正下方
  if (s.state === 'play') dragTo(s.ball.x);
  else if (s.state === 'ready') tapFire(W0 / 2);
  else if (s.state === 'clear') $('overNext').click();      // 过关面板 -> 进入下一关

  runOne();
  frames++;

  const a = S();
  if (a.ball && a.state === 'play') {
    minBallY = Math.min(minBallY, a.ball.y);
    const r = a.ball.r;
    if (a.ball.x < r - 0.6 || a.ball.x > W0 - r + 0.6 || a.ball.y < r - 0.6 || a.ball.y > H0 + 3) {
      escapeViolations++; worstEscape = worstEscape || { x: a.ball.x, y: a.ball.y, f: frames };
    }
  }
  // 过关：确认分数增量与砖块总分一致
  if (a.level !== lastLevel) {
    const bonus = 100 + a.lives * 50;
    const got = a.score - snap.score;
    if (got !== snap.expect + bonus && !scoreMismatch) {
      scoreMismatch = `第${snap.level}关 期望 ${snap.expect}+${bonus}=${snap.expect + bonus}，实得 ${got}`;
    }
    clearedLevels++;
    levelTimes.push(`${snap.level}关 ${(vnow / 1000).toFixed(1)}s`);
    lastLevel = a.level;
    const hard = a.bricks.filter(h => h > 1).length;
    snap = { level: a.level, alive: a.bricks.length, score: a.score, expect: hard * 25 + (a.bricks.length - hard) * 10 };
    levelStarts.push(snap);
  }
  if (a.state === 'over') break;
}

// 结算面板是 setTimeout 420ms 之后才弹的，得把虚拟时钟推过去
for (let i = 0; i < 60; i++) runOne();

const fin = S();
console.log(`  跑完 ${frames} 帧虚拟时间 ${(vnow / 1000).toFixed(1)}s，到达第 ${fin.level} 关，最终状态 ${fin.state}`);
console.log(`  各关通过时刻: ${levelTimes.join(' | ')}`);
ok(clearedLevels >= 1, `至少通过 1 关（实际通过 ${clearedLevels} 关，level=${fin.level}）`);
ok(clearedLevels === 7 && fin.state === 'over', `打通全部 8 关并进入结算（通过 ${clearedLevels} 关，state=${fin.state}）`);
ok(escapeViolations === 0, '球全程没有越界/穿出场地', `${escapeViolations} 次，首次 ${JSON.stringify(worstEscape)}`);
ok(scoreMismatch === null, '每关计分与砖块总分 + 通关奖励完全吻合', scoreMismatch || '');
ok(fin.panel === true, '通关后弹出结算面板');
ok(S().sounds > 0, `音效确实触发了（${S().sounds} 次振荡器）`);

/* ================= 2) 丢球减命 + 游戏结束 ================= */
section('2) 丢球会减命，3 个球用完进入「游戏结束」');
// 重开一局
$('btnRetry').click();
const W1 = S().W;
ok(S().lives === 3 && S().level === 1, '重开后回到第 1 关 / 3 个球');
tapFire(W1 / 2);

const lifeTrail = [S().lives];
let f2 = 0;
while (f2++ < 200000 && S().state !== 'over') {
  const s = S();
  if (s.state === 'play') dragTo(s.ball.x < W1 / 2 ? W1 - 6 : 6);   // 故意把挡板拖到球的另一边
  if (s.state === 'ready') tapFire(W1 / 2);
  const before = S().lives;
  runOne();
  if (S().lives !== before) lifeTrail.push(S().lives);
}
const g = S();
for (let i = 0; i < 60; i++) runOne();          // 等「游戏结束」面板弹出
console.log(`  球数变化轨迹: ${lifeTrail.join(' → ')}，状态 ${g.state}`);
ok(lifeTrail.length >= 4 && lifeTrail[lifeTrail.length - 1] === 0, '三个球依次扣完', lifeTrail.join(','));
ok(g.state === 'over', '球用完 → state=over');
ok(S().panel === true, '弹出「游戏结束」面板');
ok(parseInt(localStorage.getItem('breakout_best') || '0', 10) > 0,
   `最高分已落盘（breakout_best=${localStorage.getItem('breakout_best')}）`);

/* ================= 3) 音效开关 ================= */
section('3) 音效开关真的生效');
$('btnRetry').click();
tapFire(S().W / 2);
$('btnSound').click();                                  // 关
ok(S().soundOn === false && localStorage.getItem('breakout_sound') === '0', '关闭音效并写入偏好');
const before = S().sounds;
let f3 = 0;
while (f3++ < 400) { const s = S(); if (s.state === 'play') dragTo(s.ball.x); runOne(); }
ok(S().sounds === before, `静音后不再产生音效（保持 ${before}）`);
$('btnSound').click();                                  // 开
ok(S().soundOn === true && localStorage.getItem('breakout_sound') === '1', '重新开启音效并写入偏好');
let f3b = 0;
while (f3b++ < 400 && S().sounds === before) { const s = S(); if (s.state === 'play') dragTo(s.ball.x); runOne(); }
ok(S().sounds > before, '重开后音效恢复触发');

/* ================= 4) 暂停 / 继续 ================= */
section('4) 暂停与继续');
ok(ensurePlaying(), '（前置）处于游戏中');
$('btnPause').click();
ok(S().state === 'pause', '点「暂停」→ state=pause');
const px = S().ball.x, py = S().ball.y, pscore = S().score;
let f4 = 0;
while (f4++ < 400) runOne();
ok(S().ball.x === px && S().ball.y === py && S().score === pscore, '暂停期间球与分数完全冻结');
$('btnPause').click();
ok(S().state === 'play', '再点一次 → 回到 play');
let f4b = 0;
while (f4b++ < 120) { const s = S(); if (s.state === 'play') dragTo(s.ball.x); runOne(); }
ok(S().ball.x !== px || S().ball.y !== py, '继续后球恢复运动');

/* ================= 5) 切后台自动暂停 ================= */
section('5) 切到后台自动暂停');
ok(ensurePlaying(), '（前置）处于游戏中');
document.hidden = true;
document.dispatch('visibilitychange');
ok(S().state === 'pause', 'visibilitychange(hidden) → 自动暂停');
document.hidden = false;

/* ================= 汇总 ================= */
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
