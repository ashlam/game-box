#!/usr/bin/env node
/**
 * 打砖块（街机版）逻辑回归测试
 *
 * 这一版把「单纯打砖块」扩成了有街机味道的玩法：10 关图案、6 种砖、7 种道具、
 * 连击倍率、多球、激光、护盾。玩法一多，「会不会死锁 / 分数会不会算错 /
 * 会不会有一关永远打不完」就全靠这份测试兜着。
 *
 * 覆盖：
 *   1) 完美挡板能否打通全部 10 关（含钢砖自动松动、爆炸砖连环炸、移动砖）
 *   2) 边界不变量：球永不越界、永不穿砖
 *   3) ★ 计分恒等式：score === 砖块分 + 过关奖励 + 道具分（任何时刻都成立）
 *   4) 砖块类型规则：硬砖 3 下、钢砖打不碎、金砖高分、爆炸砖连坐邻居
 *   5) 连击倍率：连打升级、碰挡板清零、上限 ×5
 *   6) 道具：加宽/变窄/变慢/分裂/激光/接球/加命，各自的生效与到点失效
 *   7) 多球：全掉光才扣命，单球掉不扣命
 *   8) 护盾：第一次掉底被弹回来，只救一次
 *   9) 丢球减命 → 游戏结束 → 最高分落盘
 *  10) 音效开关 / 暂停 / 切后台自动暂停 / 真实事件路径
 *  11) 关卡数据自洽（10 关、图案宽度一致、钢砖不至于把关卡堵死）
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
    else if (s.state === 'play') dragTo(s.balls[0].x);
    runOne();
  }
  return S().state === 'play';
}

/* ================= 0) 关卡数据自洽 ================= */
section('0) 关卡数据自洽');
{
  const C = win.__breakoutConst;
  ok(C.MAX_LEVEL === 10, `一共 10 关（实际 ${C.MAX_LEVEL}）`);
  ok(C.LEVELS.length === 10, '10 个关卡名');
  ok(new Set(C.LEVELS).size === 10, '关卡名互不重复', C.LEVELS.join(','));
  ok(C.CAPS.length === 7, `7 种道具（实际 ${C.CAPS.length}：${C.CAPS.join('')}）`);
  ok(C.BT.length === 6, `6 种砖（实际 ${C.BT.join('')}）`);
  ok(C.COMBO_STEP === 4, '连击每 4 块升一级');
  ok(C.CAPSULE_MAX === 3, '场上最多 3 个道具');
}

/* ================= 0b) ★ 图案缩放必须左右对称 =================
   这条是玩家一眼看出来的 bug：第 1/2 关「左边总空一列、右边不空」。
   根因是图案按 10 字符宽写、真实列数 4~12 变，按 floor 分桶时左右桶宽不等，
   而这两关图案恰好以 '.' 开头，左边就凭空多空一列。
   这里把「所有对称图案 × 所有列数」都跑一遍，取样后必须仍然镜像对称。 */
section('0b) ★ 图案缩放到任意列数都保持左右对称');
{
  /* 从页面里抠出关卡图案，用与游戏完全相同的取样算法重算一遍 */
  const src = fs.readFileSync(HTML, 'utf8');
  const arts = [...src.matchAll(/\{ name:'([^']+)', art:\[([\s\S]*?)\]\}/g)]
    .map(m => ({ name: m[1], art: [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]) }));
  ok(arts.length === 10, `抠出 10 关图案（实际 ${arts.length}）`);
  ok(arts.every(a => a.art.every(r => r.length === 10)), '每行图案都是 10 个字符宽');

  const PRI = { s:6, e:5, b:4, h:3, '~':2, n:1 };
  const cl = (v, a, b) => v < a ? a : (v > b ? b : v);
  const bounds = (n, cols) => {
    const b = new Array(cols + 1); b[0] = 0; b[cols] = n;
    for (let c = 1; c < cols; c++) b[c] = c * 2 <= cols ? Math.round(c * n / cols) : n - Math.round((cols - c) * n / cols);
    return b;
  };
  const sample = (line, cols) => {
    const n = line.length;
    if (cols >= n) {
      const o = [];
      for (let c = 0; c < cols; c++) {
        const i = Math.round((c + 0.5) * n / cols - 0.5);
        o.push(line[cl(i, 0, n - 1)] || '.');
      }
      return o;
    }
    const b = bounds(n, cols), o = [];
    for (let c = 0; c < cols; c++) {
      let best = '.', bp = 0;
      for (let i = b[c]; i < b[c + 1]; i++) { const p = PRI[line[i]] || 0; if (p > bp) { best = line[i]; bp = p; } }
      o.push(best);
    }
    return o;
  };

  const bad = [];
  for (let cols = 4; cols <= 12; cols++) {
    for (const lv of arts) {
      if (!lv.art.every(r => r === r.split('').reverse().join(''))) continue;   // 只查本身对称的图案
      const rows = lv.art.map(r => sample(r, cols).join(''));
      for (const r of rows) {
        if (r !== r.split('').reverse().join('')) { bad.push(`${lv.name}@${cols}列 行不对称：${r}`); break; }
      }
    }
  }
  ok(bad.length === 0, '★ 4~12 列下所有对称图案取样后仍左右对称', bad.slice(0, 4).join('；'));

  /* 直接盯住玩家报的那个现象：第 1/2 关在任何列数下，左右留白必须相等 */
  const margins = [];
  for (let cols = 4; cols <= 12; cols++) {
    for (const idx of [0, 1]) {
      const rows = arts[idx].art.map(r => sample(r, cols).join(''));
      const le = Math.min(...rows.map(r => r.match(/^\.*/)[0].length));
      const re = Math.min(...rows.map(r => r.match(/\.*$/)[0].length));
      if (le !== re) margins.push(`第${idx + 1}关@${cols}列 左${le}/右${re}`);
    }
  }
  ok(margins.length === 0, '★ 第 1/2 关在任何列数下左右留白相等', margins.join('；'));

  /* 拉伸时砖只会变多（一个字符被两列取到），绝不能变少。
     ★ 这条一开始写反了方向：最近邻插值在 10 字符 → 12 列时必然有字符被取两次
     （46 块变 58 块），我最初断言「数量必须相等」，结果整片红 ——
     其实那是拉伸的正常行为，真正该盯的是「不许丢砖」。 */
  const lost = [];
  for (let cols = 10; cols <= 12; cols++) {          // 列数 ≥ 图案宽：一块都不该丢
    for (const lv of arts) {
      const want = lv.art.reduce((s, r) => s + [...r].filter(ch => ch !== '.').length, 0);
      const got = lv.art.reduce((s, r) => s + sample(r, cols).filter(ch => ch !== '.').length, 0);
      if (got < want) lost.push(`${lv.name}@${cols}列 应有 ${want} 实得 ${got}`);
    }
  }
  ok(lost.length === 0, '★ 列数 ≥ 图案宽时一块砖都不丢（拉伸只会变多）', lost.join('；'));

  /* 缩列（4~9 列）时同理：桶内取优先级最高的字符，砖只会合并、不会凭空少 */
  const shrink = [];
  for (let cols = 4; cols <= 9; cols++) {
    for (const lv of arts) {
      const want = lv.art.reduce((s, r) => s + [...r].filter(ch => ch !== '.').length, 0);
      const got = lv.art.reduce((s, r) => s + sample(r, cols).filter(ch => ch !== '.').length, 0);
      if (got === 0) shrink.push(`${lv.name}@${cols}列 整关空了`);
    }
  }
  ok(shrink.length === 0, '★ 缩到 4 列时也没有哪一关整关变空', shrink.join('；'));
}

/* ================= 1) 完美挡板打通 10 关 ================= */
section('1) 完美挡板（挡板始终追球）能否打通全部 10 关');
touch('touchstart', W0 / 2);                       // 发球（同时把挡板放到中间）
ok(S().state === 'play', 'touchstart 后进入 play 状态');

const MAXF = 400000;
let frames = 0, minBallY = Infinity;
let escapeViolations = 0, worstEscape = null;
let levelStarts = [];                              // 每关起始快照
let lastLevel = S().level;
const snapOf = s => ({ level: s.level, score: s.score });
let snap = snapOf(S());
levelStarts.push(snap);
let clearedLevels = 0, scoreMismatch = null, identityBroken = null;
const levelTimes = [];
let sawSteel = 0, sawBomb = 0, sawMove = 0, sawGold = 0, sawHard = 0;
let capsulesSeen = 0, maxBallsSeen = 1, maxComboSeen = 0;

while (frames < MAXF) {
  const s = S();
  // 完美挡板：每帧把挡板拖到球的正下方
  if (s.state === 'play') dragTo(s.balls[0].x);
  else if (s.state === 'ready') tapFire(W0 / 2);
  else if (s.state === 'clear') $('overNext').click();      // 过关面板 -> 进入下一关

  runOne();
  frames++;

  const a = S();
  if (a.balls.length > maxBallsSeen) maxBallsSeen = a.balls.length;
  if (a.capsules.length > capsulesSeen) capsulesSeen = a.capsules.length;
  if (a.bestCombo > maxComboSeen) maxComboSeen = a.bestCombo;
  for (const k of a.kinds) {
    if (k === 's') sawSteel++;
    if (k === 'e') sawBomb++;
    if (k === 'm') sawMove++;
    if (k === 'b') sawGold++;
    if (k === 'h') sawHard++;
  }
  if (a.ball && a.state === 'play') {
    minBallY = Math.min(minBallY, a.ball.y);
    const r = a.ball.r;
    if (a.ball.x < r - 0.6 || a.ball.x > W0 - r + 0.6 || a.ball.y < r - 0.6 || a.ball.y > H0 + 3) {
      escapeViolations++; worstEscape = worstEscape || { x: a.ball.x, y: a.ball.y, f: frames };
    }
  }
  // ★ 计分恒等式：score 必须永远等于三个分项之和
  if (!identityBroken && a.score !== a.parts.brick + a.parts.bonus + a.parts.capsule) {
    identityBroken = `第${a.level}关 score=${a.score} 但分项和=${a.parts.brick}+${a.parts.bonus}+${a.parts.capsule}`;
  }
  // 过关：确认分数增量 == 本关砖块分 + 奖励分
  if (a.level !== lastLevel) {
    const got = a.score - snap.score;
    const pB = a.parts.brick, pC = a.parts.capsule, pN = a.parts.bonus;
    if (got <= 0 && !scoreMismatch) scoreMismatch = `第${snap.level}关 过关后总分没涨（增量 ${got}）`;
    clearedLevels++;
    levelTimes.push(`${snap.level}关(${a.parts.bonus - pN}奖励) ${(vnow / 1000).toFixed(1)}s`);
    lastLevel = a.level;
    snap = snapOf(a);
    levelStarts.push(snap);
  }
  if (a.state === 'over') break;
}

// 结算面板是 setTimeout 420ms 之后才弹的，得把虚拟时钟推过去
for (let i = 0; i < 60; i++) runOne();

const fin = S();
console.log(`  跑完 ${frames} 帧虚拟时间 ${(vnow / 1000).toFixed(1)}s，到达第 ${fin.level} 关，最终状态 ${fin.state}`);
console.log(`  各关通过时刻: ${levelTimes.join(' | ')}`);
console.log(`  见到的砖：硬${sawHard} 钢${sawSteel} 爆${sawBomb} 金${sawGold} 移${sawMove} 帧次`);
console.log(`  最多同时 ${maxBallsSeen} 个球 · 最高连击 ${maxComboSeen} · 场上道具峰值 ${capsulesSeen}`);
ok(clearedLevels >= 1, `至少通过 1 关（实际通过 ${clearedLevels} 关，level=${fin.level}）`);
ok(clearedLevels === 9 && fin.state === 'over', `打通全部 10 关并进入结算（通过 ${clearedLevels} 关，state=${fin.state}）`);
ok(escapeViolations === 0, '球全程没有越界/穿出场地', `${escapeViolations} 次，首次 ${JSON.stringify(worstEscape)}`);
ok(scoreMismatch === null, '每关过关后总分确实增长', scoreMismatch || '');
ok(identityBroken === null, '★ score 恒等于「砖块分 + 奖励分 + 道具分」', identityBroken || '');
ok(fin.panel === true, '通关后弹出结算面板');
ok(S().sounds > 0, `音效确实触发了（${S().sounds} 次振荡器）`);
ok(sawSteel > 0 && sawBomb > 0 && sawMove > 0 && sawGold > 0 && sawHard > 0,
   '10 关里六种砖都出现过（硬/钢/爆/金/移动）',
   `硬${sawHard} 钢${sawSteel} 爆${sawBomb} 金${sawGold} 移${sawMove}`);
ok(maxComboSeen > 0, `连击机制真的被触发过（最高连击 ${maxComboSeen}）`);
ok(win.__breakoutConst.MAX_LEVEL === 10 && fin.best > 0, `最高分已落盘（best=${fin.best}）`);

/* ================= 2) 砖块类型规则 ================= */
section('2) 砖块类型规则');
{
  $('btnRetry').click();
  // 第 1 关没有 h/s/b/e，跳到有这些砖的关再测
  win.__breakoutGoto(7);                      // 第 7 关「铁壁」：ssssssssss + hhhhhhhh
  ok(S().bricks.some(b => b.kind === 's'), '第 7 关有钢砖');
  ok(S().bricks.some(b => b.kind === 'h'), '第 7 关有硬砖');

  const steelI = S().bricks.findIndex(b => b.kind === 's');
  const hpBefore = S().bricks[steelI].hp;
  const aliveBefore = S().alive;
  const scoreBefore = S().score;
  win.__breakoutHit(steelI);
  ok(S().bricks[steelI].dead === false, '★ 钢砖打不碎（dead 仍为 false）');
  ok(S().bricks[steelI].hp === hpBefore, '★ 钢砖血量不变（Infinity）');
  ok(S().alive === aliveBefore, '★ 钢砖不减少剩余砖数');
  ok(S().score === scoreBefore, '打钢砖不加分');

  const hardI = S().bricks.findIndex(b => b.kind === 'h');
  win.__breakoutHit(hardI);
  ok(S().bricks[hardI].dead === false, '硬砖第一下不碎');
  win.__breakoutHit(hardI);
  ok(S().bricks[hardI].dead === false, '硬砖第二下不碎');
  win.__breakoutHit(hardI);
  ok(S().bricks[hardI].dead === true, '★ 硬砖第三下才碎');
  ok(S().parts.brick >= 30, `硬砖分值 30（累计砖块分 ${S().parts.brick}）`);

  // 金砖 50 分
  win.__breakoutGoto(5);
  const goldI = S().bricks.findIndex(b => b.kind === 'b');
  ok(goldI >= 0, '第 5 关有金砖');
  const b0 = S().parts.brick;
  win.__breakoutHit(goldI);
  ok(S().parts.brick - b0 === 50, `★ 金砖一块 50 分（实得 ${S().parts.brick - b0}）`);

  // 爆炸砖连坐：第 4 关「炸弹阵」e 与 n 交错
  win.__breakoutGoto(4);
  const bombI = S().bricks.findIndex(b => b.kind === 'e');
  ok(bombI >= 0, '第 4 关有爆炸砖');
  const beforeAlive = S().alive;
  const beforeScore = S().parts.brick;
  win.__breakoutExplode(bombI);
  const killed = beforeAlive - S().alive;
  ok(killed >= 2, `★ 爆炸砖一次炸掉多块（实际 ${killed} 块）`);
  ok(S().parts.brick > beforeScore, '爆炸掉的砖照样计分');
}

/* ================= 3) 钢砖松动（关卡不可能卡死） ================= */
section('3) ★ 只剩钢砖时自动松动，关卡永远打得完');
{
  win.__breakoutGoto(7);
  tapFire(S().W / 2);                        // 发球 → 进 play（否则 clearLevel 会直接返回，测不出东西）
  ok(S().state === 'play', '（前置）第 7 关已开打');
  // 把除钢砖以外的砖全部干掉，再打掉最后一块普通砖触发判定
  const bricks = S().bricks;
  const lastNormal = bricks.map((b, i) => ({ b, i })).filter(o => o.b.kind !== 's');
  ok(lastNormal.length > 0, '（前置）第 7 关有非钢砖');
  for (let i = 0; i < lastNormal.length; i++) {
    if (S().state !== 'play') break;                 // 中途过关了
    win.__breakoutHit(lastNormal[i].i);
  }
  // 补打几下（硬砖要 3 下）
  let guard = 0;
  while (S().state === 'play' && guard++ < 60) {
    const i = S().bricks.findIndex(b => !b.dead && b.kind !== 's');
    if (i < 0) break;
    win.__breakoutHit(i);
  }
  ok(S().state === 'clear', '★ 只剩钢砖时关卡没有卡死（已过关）', `state=${S().state}`);
  // 注意：钢砖松动后又被一路打完，最后整关清空 —— 所以这里验的是「没有卡死」，
  // 而不是「钢砖还在」。「松动」本身在下一段单独验。
}

/* ================= 3b) 钢砖松动：不靠运气，直接验判定 ================= */
section('3b) 只剩钢砖 → 自动松动成普通砖');
{
  win.__breakoutGoto(7);
  tapFire(S().W / 2);                        // 必须真的在 play 里，clearLevel 才会生效
  ok(S().kinds.includes('s'), '（前置）第 7 关有钢砖');
  /* 一块块点掉非钢砖。★ 点掉最后一块可打砖的那一下就会触发「钢砖松动」，
     所以循环必须在「钢砖变少了」的那一刻立刻停手，否则会顺手把松动后的普通砖也打完，
     测出来的就是「已过关」而不是「刚松动」。 */
  let loosened = false;
  let g = 0;
  while (g++ < 200) {
    const steelsBefore = S().kinds.filter(k => k === 's').length;
    const i = S().bricks.findIndex(b => !b.dead && b.kind !== 's');
    if (i < 0) break;
    win.__breakoutHit(i);
    if (S().kinds.filter(k => k === 's').length < steelsBefore) { loosened = true; break; }
  }
  ok(loosened, '★ 打掉最后一块可打砖 → 钢砖自动松动');
  ok(S().kinds.every(k => k !== 's'), '松动后场上不再有钢砖', S().kinds.join(''));
  ok(S().state === 'play', '松动后关卡仍在进行（还能把剩下的砖收掉）', `state=${S().state}`);
  ok(S().alive > 0, `松动后还有砖要打（剩 ${S().alive} 块）`);
  // 松动后必须真的能打完
  g = 0;
  while (g++ < 200 && S().state === 'play') {
    const i = S().bricks.findIndex(b => !b.dead);
    if (i < 0) break;
    win.__breakoutHit(i);
  }
  ok(S().state !== 'play', '★ 松动后能把这一关打完');
}

/* ================= 4) 连击倍率 ================= */
section('4) 连击倍率');
{
  win.__breakoutGoto(1);
  ensurePlaying();
  const idx = S().bricks.findIndex(b => !b.dead);
  const startCombo = S().combo;
  // 连打 4 块普通砖 ⇒ 连击 4 ⇒ 倍率 ×2
  let hits = 0;
  while (S().combo - startCombo < 4 && hits++ < 20) {
    const i = S().bricks.findIndex(b => !b.dead && b.kind === 'n');
    if (i < 0) break;
    const before = S().parts.brick;
    win.__breakoutHit(i);
    if (S().combo - startCombo === 1) {
      ok(S().parts.brick - before === 10, `第 1 块按 ×1 计（+${S().parts.brick - before}）`);
    }
    if (S().combo - startCombo === 4) {
      ok(S().parts.brick - before === 20, `★ 连击第 4 块按 ×2 计（+${S().parts.brick - before}）`);
    }
  }
  ok(S().comboMult === 2, `连击 4 块 → 倍率 ×2（实际 ×${S().comboMult}）`);

  // 碰挡板清零：把球直接丢到挡板上
  win.__breakoutSetBall({ x: S().paddle.x, y: S().paddle.y - S().ball.r - 0.5, vx: 0, vy: 120, stuck: false });
  let g = 0;
  while (S().combo > 0 && g++ < 400) { dragTo(S().ball.x); runOne(); }
  ok(S().combo === 0, '★ 球碰到挡板 → 连击清零');

  // 上限 ×5
  win.__breakoutGoto(1);
  ensurePlaying();
  let h2 = 0;
  while (h2++ < 40) {
    const i = S().bricks.findIndex(b => !b.dead && b.kind === 'n');
    if (i < 0) break;
    win.__breakoutHit(i);
  }
  ok(S().comboMult <= 5, `★ 倍率封顶 ×5（实际 ×${S().comboMult}，连击 ${S().combo}）`);
  ok(S().combo >= 20 ? S().comboMult === 5 : true, '连击够多时倍率就是 ×5');
}

/* ================= 4b) 连击换护盾 ================= */
section('4b) ★ 连到 12 块 → 送一次护盾（连击不只是加分）');
{
  win.__breakoutGoto(1);
  ensurePlaying();
  ok(S().shieldT === 0, '（前置）开局没有护盾');
  let hits = 0;
  while (hits++ < 30 && S().shieldT === 0) {
    const i = S().bricks.findIndex(b => !b.dead && b.kind === 'n');
    if (i < 0) break;
    win.__breakoutHit(i);
  }
  ok(S().combo >= 12, `连击数到了 ${S().combo}`);
  ok(S().shieldT > 0, `★ 连到 12 块送护盾（shieldT=${S().shieldT.toFixed(1)}）`);
  ok(S().shieldT <= 6.01, '护盾时长 6 秒，不会多给');
  // 护盾真的能救球（不只是个数字）
  const lv0 = S().lives;
  win.__breakoutSetBall({ x: S().W / 2, y: S().H + 20, vx: 0, vy: 200, stuck: false });
  let g = 0;
  while (g++ < 40 && S().shieldT > 0) { dragTo(S().balls[0].x); runOne(); }
  ok(S().lives === lv0, '★ 连击护盾真的救回一球');
}

/* ================= 5) 道具：逐个验证生效与失效 ================= */
section('5) 道具');
{
  /* ★ 测「计时器到点失效」必须有一个能安静流过十几秒的沙盒：
     砖还多的时候，球会一直撞砖把关打通（实测 E 还没到期关卡就过了，计时器被重置）。
     所以先把砖全清空但不触发过关判定 —— 球就只在墙和挡板之间来回弹。 */
  const sandboxQuiet = () => {
    win.__breakoutGoto(1);
    ensurePlaying();
    win.__breakoutEmpty();
    return true;
  };

  win.__breakoutGoto(1);
  ensurePlaying();
  const baseW = S().paddleW;

  // E 加宽
  win.__breakoutApply('E');
  ok(S().paddleScale === 1.45, 'E：挡板加宽倍率 1.45');
  ok(S().capsulesGot === 1, '接到道具计数 +1');
  ok(S().parts.capsule === 20, '接道具 +20 分');
  // 让时间流过 1 秒，挡板宽度应该真的变宽了
  let g = 0;
  while (g++ < 80) { dragTo(S().paddle.x); runOne(); }
  ok(S().paddle.w > baseW * 1.2, `E：挡板实际变宽（${baseW.toFixed(1)} → ${S().paddle.w.toFixed(1)}）`);

  // 到期失效（14 秒）
  sandboxQuiet();
  win.__breakoutApply('E');
  ok(S().expandT > 13, 'E：加宽计时从 14 秒开始');
  g = 0;
  while (g++ < 4000 && S().expandT > 0) { dragTo(S().balls[0].x); runOne(); }
  ok(S().expandT === 0, 'E：14 秒后到期');
  ok(S().paddleScale === 1, 'E：到期后缩放回到 1');
  g = 0;
  while (g++ < 200 && Math.abs(S().paddle.w - baseW) > 1) { dragTo(S().balls[0].x); runOne(); }
  ok(Math.abs(S().paddle.w - baseW) <= 1, `E：到期后宽度回到 ${baseW}（实际 ${S().paddle.w.toFixed(1)}）`);

  // P 变窄
  sandboxQuiet();
  win.__breakoutApply('P');
  ok(S().paddleScale === 0.72, 'P：挡板变窄倍率 0.72');
  g = 0;
  while (g++ < 4000 && S().shrinkT > 0) { dragTo(S().balls[0].x); runOne(); }
  ok(S().shrinkT === 0 && S().paddleScale === 1, 'P：到期后恢复原宽');

  // S 变慢
  sandboxQuiet();
  win.__breakoutApply('S');
  ok(S().slowT > 0, 'S：慢速计时启动');
  g = 0;
  while (g++ < 4000 && S().slowT > 0) { dragTo(S().balls[0].x); runOne(); }
  ok(S().slowT === 0, 'S：9 秒后到期');

  // C 接球
  sandboxQuiet();
  win.__breakoutApply('C');
  ok(S().catchT > 0, 'C：接球计时启动');
  g = 0;
  while (g++ < 4000 && S().catchT > 0) { dragTo(S().balls[0].x); runOne(); }
  ok(S().catchT === 0, 'C：12 秒后到期');

  // U 加命
  const lv0 = S().lives;
  win.__breakoutApply('U');
  ok(S().lives === lv0 + 1, `U：多一个球（${lv0} → ${S().lives}）`);
  win.__breakoutApply('U'); win.__breakoutApply('U'); win.__breakoutApply('U');
  ok(S().lives === 5, `U：生命上限 5（实际 ${S().lives}）`);

  // L 激光
  win.__breakoutGoto(1);
  ensurePlaying();
  win.__breakoutApply('L');
  ok(S().lasers === 8, 'L：8 发激光');
  const bolts0 = S().bolts;
  g = 0;
  while (g++ < 40 && S().bolts === bolts0) { dragTo(S().ball.x); runOne(); }
  ok(S().bolts > bolts0, `L：激光弹真的发射了（${S().bolts} 颗在飞）`);
  ok(S().lasers < 8, 'L：发一发少一发');

  // M 多球
  win.__breakoutGoto(1);
  ensurePlaying();
  const n0 = S().balls.length;
  const added = win.__breakoutSplit();
  ok(added > 0, `M：分裂出 ${added} 个球`);
  ok(S().balls.length > n0, `M：球数 ${n0} → ${S().balls.length}`);
  ok(S().balls.length <= 6, 'M：球数上限 6');
  // 多球颜色要不一样，否则分不清谁是谁
  ok(new Set(S().balls.map(b => b.color)).size > 1, 'M：分裂出的球颜色不同（看得清）');
}

/* ================= 6) 多球：全掉光才扣命 ================= */
section('6) 多球：掉一个不扣命，全掉光才扣命');
{
  win.__breakoutGoto(1);
  ensurePlaying();
  win.__breakoutSplit();
  const lv0 = S().lives;
  const n = S().balls.length;
  ok(n >= 3, `（前置）场上有 ${n} 个球`);
  // 把第 2..n 个球直接从底部送出去：只留 1 个球
  let g = 0;
  while (S().balls.length > 1 && g++ < 400) {
    // 通过调试口把球推到底部以下：直接改坐标
    win.__breakoutSetBall({ y: S().H + 40 });
    dragTo(S().ball.x);
    runOne();
  }
  ok(S().balls.length === 1, `只剩 1 个球（${S().balls.length}）`);
  ok(S().lives === lv0, '★ 还有球在场上时不扣命');
  // 再把最后一个球送出去
  g = 0;
  while (S().state === 'play' && g++ < 200) {
    win.__breakoutSetBall({ y: S().H + 40 });
    runOne();
  }
  ok(S().lives === lv0 - 1, `★ 最后一个球掉了才扣命（${lv0} → ${S().lives}）`);
}

/* ================= 7) 护盾救球 ================= */
section('7) 护盾：第一次掉底被弹回来，只救一次');
{
  win.__breakoutGoto(1);
  ensurePlaying();
  win.__breakoutEmpty();                     // 别让球撞砖过关，安静测护盾
  const lv0 = S().lives;
  win.__breakoutSetShield(10);
  ok(S().shieldT > 0, '（前置）护盾已开启');
  win.__breakoutSetBall({ x: S().W / 2, y: S().H + 20, vx: 0, vy: 200, stuck: false });
  let g = 0;
  while (g++ < 40 && S().shieldT > 0) { dragTo(S().ball.x); runOne(); }
  ok(S().shieldT === 0, '★ 掉底时护盾消耗掉');
  ok(S().lives === lv0, '★ 护盾救回这一球，不扣命');
  ok(S().state === 'play', '护盾救球后仍在游戏中');
  // 护盾没了，再掉就真扣命
  win.__breakoutSetBall({ x: S().W / 2, y: S().H + 20, vx: 0, vy: 200, stuck: false });
  g = 0;
  while (S().state === 'play' && g++ < 60) { dragTo(S().ball.x); runOne(); }
  ok(S().lives === lv0 - 1, '★ 护盾只救一次，第二次照扣');
}

/* ================= 8) 道具胶囊：掉落 → 接住 → 生效 ================= */
section('8) 道具胶囊：掉下来、被接住才生效');
{
  win.__breakoutGoto(1);
  ensurePlaying();
  const got0 = S().capsulesGot;
  // 在挡板正上方放一个胶囊，让它自己落下来被接住
  win.__breakoutSetPaddle(S().W / 2);
  win.__breakoutDrop('E', S().W / 2, S().H - 90);
  ok(S().capsules.length === 1, '（前置）场上有一个胶囊');
  let g = 0;
  while (g++ < 400 && S().capsules.length > 0) { dragTo(S().W / 2); runOne(); }
  ok(S().capsules.length === 0, '胶囊落地后被挡板接走（不再挂在场上）');
  ok(S().capsulesGot === got0 + 1, '★ 接住胶囊 → 道具生效');
  ok(S().paddleScale === 1.45, '接住的是 E → 挡板加宽');

  // 掉到场地底部之外就消失，不会一直占着名额
  win.__breakoutDrop('S', 6, S().H - 4);
  g = 0;
  while (g++ < 400 && S().capsules.length > 0) { dragTo(6); runOne(); }
  ok(S().capsules.length === 0, '没接住的胶囊会掉出场地消失');
}

/* ================= 9) 丢球减命 + 游戏结束 ================= */
section('9) 丢球会减命，3 个球用完进入「游戏结束」');
{
  $('btnRetry').click();
  const W1 = S().W;
  ok(S().lives === 3 && S().level === 1, '重开后回到第 1 关 / 3 个球');
  tapFire(W1 / 2);

  const lifeTrail = [S().lives];
  let f2 = 0;
  while (f2++ < 200000 && S().state !== 'over') {
    const s = S();
    if (s.state === 'play') dragTo(s.balls[0].x < W1 / 2 ? W1 - 6 : 6);   // 故意把挡板拖到球的另一边
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
  ok(/重试第 \d+ 关/.test($('overNext').textContent), `结算按钮是「重试本关」而不是打回第 1 关（${$('overNext').textContent}）`);
}

/* ================= 10) 音效开关 ================= */
section('10) 音效开关真的生效');
{
  $('btnRetry').click();
  tapFire(S().W / 2);
  $('btnSound').click();                                  // 关
  ok(S().soundOn === false && localStorage.getItem('breakout_sound') === '0', '关闭音效并写入偏好');
  const before = S().sounds;
  let f3 = 0;
  while (f3++ < 400) { const s = S(); if (s.state === 'play') dragTo(s.balls[0].x); runOne(); }
  ok(S().sounds === before, `静音后不再产生音效（保持 ${before}）`);
  $('btnSound').click();                                  // 开
  ok(S().soundOn === true && localStorage.getItem('breakout_sound') === '1', '重新开启音效并写入偏好');
  let f3b = 0;
  while (f3b++ < 400 && S().sounds === before) { const s = S(); if (s.state === 'play') dragTo(s.balls[0].x); runOne(); }
  ok(S().sounds > before, '重开后音效恢复触发');
}

/* ================= 11) 暂停 / 继续 ================= */
section('11) 暂停与继续');
{
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
  while (f4b++ < 120) { const s = S(); if (s.state === 'play') dragTo(s.balls[0].x); runOne(); }
  ok(S().ball.x !== px || S().ball.y !== py, '继续后球恢复运动');
}

/* ================= 12) 切后台自动暂停 ================= */
section('12) 切到后台自动暂停');
{
  ok(ensurePlaying(), '（前置）处于游戏中');
  document.hidden = true;
  document.dispatch('visibilitychange');
  ok(S().state === 'pause', 'visibilitychange(hidden) → 自动暂停');
  document.hidden = false;
}

/* ================= 汇总 ================= */
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
