#!/usr/bin/env node
/**
 * 弹珠乐园 逻辑回归测试（Node + 最小 DOM/Canvas 桩 + 手工步进）
 *
 * 覆盖（★ = 用户原话里的规则，逐条锁死）：
 *   1) ★ 初始 5 颗弹珠
 *   2) ★ 按住蓄力 → 松手按力量弹出（力量→出膛速度线性、单调）
 *   3) ★ 发射扣 1；落桶把「桶上的数字」原样加上去
 *   4) ★ 0 号桶不加（白损失一颗）；弹珠归 0 → 结束；重开回到 5
 *   5) 桶几何：9 格无缝铺满场地 → 任何落点必然属于某个桶
 *   6) 钉场几何：数量合理、不重叠、炮口正下方无钉（防原地打摆）、都在界内
 *   7) 物理：不出墙、不穿钉（每步都满足距离下界）、必然结算到某个桶、单球用不到超时兜底
 *   8) 确定性：同种子 + 同力量 → 同一个桶（含看门狗在内的随机都走本局种子）
 *   9) 看门狗：卡死的球会在 1.5s 内被踢醒（高速原地打摆也能救）
 *  10) 音效（FakeCtx 计数）：蓄力 / 出膛 / 撞钉 / 落桶(0 与 8 不同) / 静音
 *  11) 长跑：真实物理连发不越界、不 NaN、状态只在合法集合内
 *
 * 用法：node tools/test_marble.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'marble', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 桩 ---------------- */
const gradient = { addColorStop() {} };
function mkCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, textContent: '', className: '', _html: '',
    children: [], onclick: null, clientWidth: 390, clientHeight: 700, width: 0, height: 0,
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
                 toggle: (c, v) => (v ? set.add(c) : set.delete(c)) },
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
                                       right: this.clientWidth, bottom: this.clientHeight }; },
    select() {}, setSelectionRange() {}, focus() {}, blur() {},
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = v; } });
  return el;
}
const els = {};
const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx(); els.cv = cvEl;
const stageEl = mkEl('div'); stageEl.clientWidth = 390; stageEl.clientHeight = 700; els.stage = stageEl;

const store = {};
let sndNodes = 0;                       // 真正 start() 过的音频节点数
class FakeCtx {
  constructor(){ this.state='suspended'; this.currentTime=0; this.sampleRate=44100; this.destination={}; }
  createOscillator(){
    const freq = { value: 0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} };
    return { type:'', frequency:freq, connect(){}, start(){ sndNodes++; }, stop(){} };
  }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, value:0 }, connect(){} }; }
  createBuffer(ch, len){ return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource(){ return { buffer:null, connect(){}, start(){ sndNodes++; } }; }
  createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, Q:{ value:0 }, connect(){} }; }
  resume(){ this.state='running'; return Promise.resolve(); }
}

let perfNow = 1000;              // 模拟时钟：起步 1000 让「第一声」必然能通过节流
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  // ★ 必须有 performance：音效节流用 performance.now()，缺了会走 -999 分支导致永远不出声。
  // ★ 而且必须是「可推进的模拟时钟」而不是 Date.now()：
  //   真实时钟下，上一节测试撞的钉会把 26ms 节流窗口占住，下一节的叮声被吃掉 → 4/5 概率 flaky（踩过）。
  performance: { now: () => perfNow },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  localStorage: { getItem: k => (k in store ? store[k] : null),
                  setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl, addEventListener() {}, removeEventListener() {},
    documentElement: { scrollHeight: 700 }, body: mkEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
  },
  navigator: { userAgent: 'node-test' },
  location: { search: '' },
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 390; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2;
sandbox.window.AudioContext = FakeCtx;
sandbox.window.isSecureContext = false;
sandbox.window.screen = { width: 390, height: 780 };

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'marble-inline.js' });

/* ---------------- 驱动 ---------------- */
const win = sandbox.window;
const M = () => win.__marble();
const step = dt => win.__marbleStep(dt);
const press = () => win.__marblePress();
const release = () => win.__marbleRelease();
const setCharge = c => win.__marbleSetCharge(c);
const reset = seed => win.__marbleReset(seed);
const land = i => win.__marbleLand(i);
const setBall = o => win.__marbleSetBall(o);
const DT = 1 / 60;

function run(n, dt = DT) { for (let i = 0; i < n; i++) { perfNow += 16; step(dt); } }

/** 发一颗球并等它自然落桶（真实物理），返回观测数据 */
function shoot(c, maxFrames = 1200) {
  press(); setCharge(c); release();
  let frames = 0, maxT = 0, sawNaN = false, outOfBounds = false, tunnel = false;
  const s0 = M();
  while (M().state === 'play' && frames < maxFrames) {
    perfNow += 16; step(DT);
    frames++;
    const b = M().ball;
    if (b) {
      maxT = Math.max(maxT, b.flightT);
      if (![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) sawNaN = true;
      if (b.x < s0.fieldL + s0.RB - 0.6 || b.x > s0.fieldR - s0.RB + 0.6) outOfBounds = true;
      if (b.y < s0.fieldT + s0.RB - 0.6) outOfBounds = true;
      if (b.y < s0.mouthY) {
        for (const p of s0.pegs) {
          const dx = b.x - p.x, dy = b.y - p.y;
          if (dx * dx + dy * dy < (s0.RP + s0.RB - 0.8) * (s0.RP + s0.RB - 0.8)) { tunnel = true; break; }
        }
      }
    }
  }
  return { frames, resolved: M().state !== 'play', bucket: M().lastBucket,
           balls: M().balls, maxT, sawNaN, outOfBounds, tunnel, timedOut: frames >= maxFrames };
}

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 1) 规则（用户原话逐条） ================= */
section('1) ★ 规则：初始 5 / 发射扣 1 / 桶数字原样加 / 0 不加 / 归 0 结束');
{
  reset(1);
  const s = M();
  ok(s.balls === 5, '★ 初始 5 个球（' + s.balls + '）');
  ok(s.state === 'ready', '开局状态 ready');
  ok(JSON.stringify(s.NUMS) === JSON.stringify([1,0,2,4,8,4,2,0,1]),
     '★ 9 桶数字与参考图一致 1·0·2·4·8·4·2·0·1（' + s.NUMS.join('·') + '）');
  ok(s.START_BALLS === 5, '常数 START_BALLS=5');

  // 蓄力松手 = 发一颗，扣 1
  press();
  ok(M().charging, '按住进入蓄力');
  setCharge(0.5); release();
  const f = M();
  ok(f.balls === 4 && f.launched === 1 && f.state === 'play',
     '★ 发射即扣 1：5 → ' + f.balls + '（已发 ' + f.launched + ' 颗）');

  // 逐桶验证「桶上的数字原样加给剩余」
  for (let i = 0; i < 9; i++) {
    reset(1);
    press(); setCharge(0.4); release();            // 5 → 4
    land(i);                                        // + NUMS[i]
    const got = M().balls, want = 4 + M().NUMS[i];
    ok(got === want, `桶[${i}]=${M().NUMS[i]}：4 + ${M().NUMS[i]} = ${got}`, '得到 ' + got);
    ok(M().lastBucket === i, `  └ 记录落点桶[${i}]`, String(M().lastBucket));
  }

  // 白损失：连打 5 颗全落 0 桶 → 归 0 → 结束；再按也不发
  reset(1);
  let trace = [];
  for (let k = 1; k <= 5; k++) {
    press(); setCharge(0.5); release();
    const afterFire = M().balls;
    land(1);                                        // NUMS[1] = 0
    trace.push(`${afterFire}/${M().balls}`);
    if (M().launched !== k) break;
  }
  const g = M();
  ok(g.balls === 0, '★ 5 颗全落 0 号桶（每次都只扣不加）→ 0 颗', '轨迹 发射后/落桶后: ' + trace.join(' '));
  ok(g.state === 'over', '★ 归 0 → 结束（state=' + g.state + '）');
  press(); setCharge(1); release();
  ok(M().balls === 0 && M().launched === 5, '★ 没球时按住松手也不让发（仍为 ' + M().launched + ' 颗）');
  reset(3);
  ok(M().balls === 5 && M().state === 'ready', '★ 重开回到 5 颗、状态 ready');

  // 1 号桶是净持平（4+1=5，正好补回发射那颗）
  reset(1);
  press(); setCharge(0.5); release(); land(0);
  ok(M().balls === 5, '桶=1 时 4+1=5（正好补回发射那颗，净 0）');
}

/* ================= 2) 蓄力 → 力量 ================= */
section('2) ★ 按住蓄力，松手按力量弹出');
{
  const speedAt = c => { reset(1); press(); setCharge(c); release(); return M().lastSpeed; };
  const v0 = speedAt(0), v50 = speedAt(0.5), v100 = speedAt(1), v25 = speedAt(0.25), v75 = speedAt(0.75);
  const s = M();
  ok(Math.abs(v0 - s.MINV) < 1e-9, '蓄力 0% = 最小出膛速度 ' + v0);
  ok(Math.abs(v100 - s.MAXV) < 1e-9, '蓄力 100% = 最大出膛速度 ' + v100);
  ok(Math.abs(v50 - (s.MINV + s.MAXV) / 2) < 1e-9, '蓄力 50% 正好中点（线性映射）' + v50);
  ok(v25 < v50 && v50 < v75 && v75 < v100, '★ 力量随蓄力单调递增（' + [v0,v25,v50,v75,v100].join(' < ') + '）');
  ok(s.CHARGE_T >= 0.8 && s.CHARGE_T <= 2, '满蓄力耗时合理（' + s.CHARGE_T + 's）');

  // 按住涨到 100%
  reset(1); press();
  run(Math.ceil(s.CHARGE_T / DT) + 3);
  ok(Math.abs(M().charge - 1) < 0.001, '按住到满蓄力（' + (M().charge * 100).toFixed(1) + '%）');
  release();
}

/* ================= 3) 桶几何 / 钉场几何 ================= */
section('3) 几何不变量');
{
  reset(1);
  const s = M();
  const span = s.fieldL + 9 * s.slotW;
  ok(Math.abs(span - s.fieldR) < 1e-9, '★ 9 个桶无缝铺满场地（' + s.fieldL + '+9×' + s.slotW.toFixed(2) + ' = ' + span.toFixed(2) + ' vs 右边界 ' + s.fieldR + '）→ 必然落进某个桶');
  ok(s.pegs.length >= 30 && s.pegs.length <= 130, '钉场数量合理（' + s.pegs.length + ' 颗）');

  let out = 0, nearCenter = 0, overlap = 0;
  for (const p of s.pegs) {
    if (p.x < s.fieldL + 11 || p.x > s.fieldR - 11 || p.y < s.fieldT + 21 || p.y > s.mouthY - 25) out++;
    if (Math.abs(p.x - s.cannonX) < 3.2) nearCenter++;
  }
  for (let i = 0; i < s.pegs.length; i++)
    for (let j = i + 1; j < s.pegs.length; j++) {
      const dx = s.pegs[i].x - s.pegs[j].x, dy = s.pegs[i].y - s.pegs[j].y;
      if (dx * dx + dy * dy < (2 * s.RP + 3 - 0.5) * (2 * s.RP + 3 - 0.5)) overlap++;
    }
  ok(out === 0, '所有钉都在界内（越界 ' + out + '）');
  ok(nearCenter === 0, '★ 炮口正下方无钉（否则球会原地上下打摆）（命中 ' + nearCenter + '）');
  ok(overlap === 0, '钉与钉不重叠（重叠对 ' + overlap + '）→ 球不会被夹死');

  // 同种子两次生成的钉场必须一模一样（确定性测试的前提）
  reset(9); const a = M().pegs.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join('|');
  reset(9); const b = M().pegs.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join('|');
  ok(a === b, '同种子生成的钉场完全一致');
  reset(10);
  const c = M().pegs.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join('|');
  ok(c !== a, '不同种子钉场不同（每局不一样）');
}

/* ================= 4) 物理：墙、钉、落桶 ================= */
section('4) 物理：不穿钉、不出墙、必落桶、用不到超时兜底');
{
  // 右墙：把球贴着右墙往右打 → 一个子步内必须被钳回并反弹（声音顺带验证）
  reset(1);
  let s = M();
  setBall({ x: s.fieldR - s.RB - 0.5, y: s.fieldT + 55, vx: 500, vy: 0 });
  const beforeWall = sndNodes;
  run(2);
  const w = M();
  ok(w.ball && w.ball.x <= w.fieldR - w.RB + 0.01, '右墙把球钳回界内（x=' + (w.ball ? w.ball.x.toFixed(1) : 'null') + ' ≤ ' + (w.fieldR - w.RB).toFixed(1) + '）');
  ok(w.ball && w.ball.vx < 0, '★ 撞墙反弹：vx 反向（' + (w.ball ? w.ball.vx.toFixed(0) : '?') + '）');
  ok(sndNodes > beforeWall, '撞墙有音效（+' + (sndNodes - beforeWall) + '）');

  // 左墙同理
  reset(1);
  s = M();
  setBall({ x: s.fieldL + s.RB + 0.5, y: s.fieldT + 55, vx: -500, vy: 0 });
  run(2);
  const l = M();
  ok(l.ball && l.ball.x >= l.fieldL + l.RB - 0.01 && l.ball.vx > 0, '左墙同样反弹并钳回界内');

  // 真实物理发一球：全程不越界、不穿钉、必然落桶、用不到超时
  const r = shoot(0.83, 1200);
  ok(r.resolved && r.bucket >= 0 && r.bucket <= 8, '真实物理必然结算到某个桶（桶[' + r.bucket + ']=' + M().NUMS[r.bucket] + '）', '帧数 ' + r.frames);
  ok(!r.outOfBounds, '全程不出墙（含顶棚）');
  ok(!r.tunnel, '★ 不穿钉：每一步对每颗钉都满足 r_球+r_钉 距离下界');
  ok(!r.sawNaN, '坐标无 NaN');
  ok(r.maxT < M().FLIGHT_CAP, '单球用不到超时兜底（实际 ' + r.maxT.toFixed(2) + 's < 上限 ' + M().FLIGHT_CAP + 's）');
  ok(r.maxT < 10, '一球在 10s 内打完（' + r.maxT.toFixed(2) + 's）');

  // 确定性：同种子同力量 → 同一个桶
  const d1 = (reset(7), shoot(0.61)), b1 = M().lastBucket, g1 = M().balls;
  const d2 = (reset(7), shoot(0.61)), b2 = M().lastBucket, g2 = M().balls;
  ok(b1 === b2 && g1 === g2 && d1.bucket === d2.bucket,
     '★ 确定性：同种子+同力量 → 同一个桶（' + b1 + ' vs ' + b2 + '，球数 ' + g1 + '/' + g2 + '）');
}

/* ================= 5) 看门狗 ================= */
section('5) 看门狗：卡死的球会被踢醒');
{
  // A：停在某颗钉顶（速度几乎为 0）
  reset(1);
  let s = M();
  const p0 = s.pegs[0];
  setBall({ x: p0.x, y: p0.y - (s.RP + s.RB), vx: 0, vy: 0, restT: 0.95 });
  run(Math.round(1.5 / DT));
  const a = M();
  const movedA = a.ball && (Math.abs(a.ball.vx) > 10 || Math.abs(a.ball.x - p0.x) > 3);
  ok(movedA, 'A·静止卡在钉顶 → 1.5s 内被踢醒（vx=' + (a.ball ? a.ball.vx.toFixed(1) : 'null') + '）');

  // B：高速原地打摆（球心正对钉心、横向速度恒为 0 → 速度看门抓不到，靠 x 停滞看门）
  reset(2);
  s = M();
  const p1 = s.pegs[0];
  setBall({ x: p1.x, y: p1.y - (s.RP + s.RB) - 0.4, vx: 0, vy: -300, restT: 0 });
  run(Math.round(1.8 / DT));
  const b = M();
  const movedB = b.ball && Math.abs(b.ball.vx) > 10;
  ok(movedB, 'B·高速原地打摆（vx 恒 0）→ 1.8s 内被踢醒（vx=' + (b.ball ? b.ball.vx.toFixed(1) : 'null') + '）');
}

/* ================= 6) 音效 ================= */
section('6) 音效（FakeCtx 计数）');
{
  reset(1);
  let n0 = sndNodes;
  press();
  ok(sndNodes > n0, '按住蓄力有持续音（+' + (sndNodes - n0) + '）');
  let n1 = sndNodes;
  setCharge(0.6); release();
  ok(sndNodes - n1 >= 2, '出膛有音效（+' + (sndNodes - n1) + '）');

  // 撞钉：把球放到第一颗钉正上方让它砸下去
  reset(1);
  let s = M();
  const p0 = s.pegs[0];
  setBall({ x: p0.x, y: p0.y - 22, vx: 0, vy: 60 });
  perfNow += 200;                                  // 显式跨过 26ms 节流窗口（不依赖前面各节耗了多久）
  let n2 = sndNodes;
  run(Math.round(0.8 / DT));
  ok(M().pegHits > 0, '撞钉计数 > 0（' + M().pegHits + ' 次）');
  ok(sndNodes > n2, '★ 撞钉有叮声（+' + (sndNodes - n2) + '；节流下至少第一声必响）');

  // 落桶：0 号（低沉）与 8 号（明亮多声）数量不同
  reset(1); press(); setCharge(0.5); release();
  let n3 = sndNodes; land(1);                       // 0 号桶
  const d0 = sndNodes - n3;
  reset(1); press(); setCharge(0.5); release();
  let n4 = sndNodes; land(4);                       // 8 号桶
  const d8 = sndNodes - n4;
  ok(d0 >= 1, '0 号桶有落桶音（+' + d0 + '，低沉「噗」）');
  ok(d8 > d0, '★ 8 号头奖比 0 号更隆重（+' + d8 + ' > +' + d0 + '）');

  // 静音开关
  els.btnSound.onclick();
  reset(1);
  let n5 = sndNodes;
  press(); setCharge(0.5); release();
  ok(sndNodes === n5, '关掉音效后完全不发声');
  els.btnSound.onclick();
  reset(1);
  let n6 = sndNodes;
  press(); setCharge(0.5); release();
  ok(sndNodes > n6, '重新打开后又能发声');
}

/* ================= 7) 长跑健壮性（真实物理） ================= */
section('7) 长跑：真实物理连发，不越界/不 NaN/状态合法');
{
  reset(21);
  let flights = 0, bad = 0, sawOver = false, peakBalls = 5;
  for (let k = 0; k < 40 && !sawOver; k++) {
    if (M().state !== 'ready') break;
    const c = [0.15, 0.4, 0.7, 0.95, 0.55][k % 5];
    const r = shoot(c, 1200);
    flights++;
    if (!r.resolved || r.sawNaN || r.outOfBounds || r.tunnel || r.timedOut) { bad++; break; }
    if (!(M().lastBucket >= 0 && M().lastBucket <= 8)) { bad++; break; }
    if (M().balls < 0) { bad++; break; }
    if (!['ready', 'over'].includes(M().state)) { bad++; break; }
    peakBalls = Math.max(peakBalls, M().balls);
    sawOver = M().state === 'over';
  }
  ok(bad === 0, flights + ' 颗连发全程合法（不越界/不穿钉/不 NaN/球数不为负）', '异常 ' + bad);
  ok(flights >= 5, '至少打完 ' + flights + ' 颗');
  ok(M().best >= 5 && M().best >= M().runPeak, '最高记录被正确维护（best=' + M().best + ' runPeak=' + M().runPeak + '）');
  ok(String(store['marble_best'] ?? '') === String(M().best), '★ 最高分已落盘（' + store['marble_best'] + '）');
  const st = M().state;
  ok(st === 'ready' || st === 'over', '最终状态合法（' + st + '）');
}

/* ================= 8) 提示 / 重开 ================= */
section('8) 首屏提示与重开');
{
  reset(1);
  ok(M().hintOn === true, '开局显示规则提示');
  press(); setCharge(1); release();
  ok(M().hintOn === false, '开火后提示消失');
  run(Math.round(6 / DT));                          // 让这球打完
  reset(5);
  ok(M().hintOn === true && M().balls === 5 && M().state === 'ready', '重开：提示回来、5 颗、ready');
}

/* ================= ★ 转屏：关卡布局必须不变 ================= */
section('★ 转屏（竖屏↔横屏）关卡布局不变');
{
  const portrait = win.__marbleSetStage(768, 1024);
  win.__marbleReset(20261001);
  const p1 = win.__marble();
  const pegsPortrait = JSON.stringify(p1.pegs);
  const geo = [p1.W, p1.H, p1.fieldL, p1.fieldR, p1.mouthY, p1.floorY, p1.cannonX, p1.slotW];
  const landscape = win.__marbleSetStage(1024, 768);
  const p2 = win.__marble();
  ok(portrait.W === landscape.W && portrait.H === landscape.H,
     '★ 逻辑尺寸固定：竖屏/横屏都是 ' + portrait.W + '×' + portrait.H);
  ok(JSON.stringify(p2.pegs) === pegsPortrait, '★ 转屏后钉阵逐颗完全一致（' + p1.pegs.length + ' 颗）');
  ok(JSON.stringify([p2.W, p2.H, p2.fieldL, p2.fieldR, p2.mouthY, p2.floorY, p2.cannonX, p2.slotW]) === JSON.stringify(geo),
     '★ 转屏后场地几何完全一致（fieldR=' + p2.fieldR + ' mouthY=' + p2.mouthY + '）');
  ok(p2.fieldL >= 0 && p2.fieldR <= p2.W, '★ 场地在逻辑宽内（' + p2.fieldL + '~' + p2.fieldR + ' ≤ ' + p2.W + '）');
  for(const [w, h] of [[1600, 600], [600, 1600], [900, 900]]){
    const st = win.__marbleSetStage(w, h);
    const s = win.__marble();
    ok(s.W === portrait.W && s.H === portrait.H && JSON.stringify(s.pegs) === pegsPortrait,
       '★ ' + w + '×' + h + ' 比例下逻辑尺寸与钉阵仍不变（scale ' + st.S.toFixed(2) + '）');
  }
  win.__marbleSetStage(768, 1024);
}

/* ================= 9) 方向控制（与发射键分离） ================= */
section('9) ★ 炮口方向控制：◀▶ 调角度，与蓄力/发射互不干扰');
{
  reset(9);
  ok(M().aim === 0, '开局炮口朝正下方（aim=0）');
  ok(win.__marbleSetAim(0.5) === 0.5, '可以设置炮口角度');
  ok(win.__marbleSetAim(99) === M().AIM_MAX, '★ 角度被夹在 ±AIM_MAX 内（' + M().AIM_MAX.toFixed(2) + ' rad）');
  ok(win.__marbleSetAim(-99) === -M().AIM_MAX, '反向同样夹紧');

  // 左转：按住方向键 → 角度连续变化，但【不会发射】
  reset(9);
  win.__marbleSetAim(0);
  win.__marbleAimDir(-1);
  run(30);
  ok(M().aim < 0, '★ 按住 ◀ 炮口持续左转（aim=' + M().aim.toFixed(3) + '）');
  ok(M().state === 'ready' && M().balls === 5 && M().launched === 0,
     '★ 转方向期间不会误发射（state=' + M().state + ' 已发=' + M().launched + '）');
  win.__marbleAimDir(0);
  const aimHeld = M().aim;
  run(30);
  ok(M().aim === aimHeld, '松开方向键后角度停住（不再自己转）');

  // 转完方向后，发射键照常可用
  press(); setCharge(0.6); release();
  ok(M().state === 'play' && M().launched === 1, '★ 调完角度，发射键照常可用（转方向没占用发射时机）');
  const fb = M().ball;
  ok(fb && fb.vx !== 0, '★ 带角度发射：出膛带横向速度（vx=' + (fb ? fb.vx.toFixed(0) : '—') + '）');
  ok(fb && Math.abs(Math.atan2(fb.vx, fb.vy) - aimHeld) < 0.02,
     '★ 出膛方向 = 炮口角度（偏差 ' + (fb ? Math.abs(Math.atan2(fb.vx, fb.vy) - aimHeld).toFixed(4) : '?') + ' rad）');

  // 右转发射 → 横向速度反号
  reset(9);
  win.__marbleSetAim(0.5);
  win.__marbleFire(0.6);
  const rgt = M().ball.vx;
  reset(9);
  win.__marbleSetAim(-0.5);
  win.__marbleFire(0.6);
  const lft = M().ball.vx;
  ok(rgt > 0 && lft < 0 && Math.abs(rgt + lft) < 1e-6,
     '★ 左/右角度对出膛方向严格反号（+' + rgt.toFixed(0) + ' / ' + lft.toFixed(0) + '）');
}

/* ================= 10) Left / Right 道具 ================= */
section('10) ★ Left / Right：左(右)侧加倍、另一侧变负、中间归 0、可叠加');
{
  reset(10);
  const base = M().effNums;
  ok(JSON.stringify(base) === JSON.stringify([1,0,2,4,8,4,2,0,1]), '未吃道具时入口=底表（' + base.join('·') + '）');

  win.__marbleEat('L');
  ok(M().fx.L === 1, '吃到 Left → 层数 1');
  ok(JSON.stringify(M().effNums) === JSON.stringify([2,0,4,8,0,-4,-2,0,-1]),
     '★ 吃 1 次：左 ×2、右 变负、中间归 0（' + M().effNums.join('·') + '）');

  win.__marbleEat('L');
  ok(M().fx.L === 2, '再吃一次 → 层数 2');
  ok(JSON.stringify(M().effNums) === JSON.stringify([4,0,8,16,0,-8,-4,0,-2]),
     '★ 吃 2 次：继续翻倍（' + M().effNums.join('·') + '）');
  ok(M().effNums[1] === 0 && M().effNums[7] === 0, '★ 0 号位无论怎么叠都还是 0');

  for(let i = 0; i < 20; i++) win.__marbleEat('L');
  ok(M().fx.L === M().MAX_STACK, '★ 最多叠加 ' + M().MAX_STACK + ' 层（实际 ' + M().fx.L + '）');

  // Right 是镜像
  reset(10);
  win.__marbleEat('R');
  ok(JSON.stringify(M().effNums) === JSON.stringify([-1,0,-2,-4,0,8,4,0,2]),
     '★ Right：右侧加倍、左侧变负、中间归 0（' + M().effNums.join('·') + '）');

  // 实打实落桶：吃 L 后落 2 号桶（底表 2）→ 得 4
  reset(10);
  win.__marbleEat('L');
  const r1 = win.__marbleLand(2);
  ok(r1.n === 4 && M().balls === 9, '★ 吃 L 后落 2 号桶：实得 4（5 → ' + M().balls + '）');
  ok(M().fx.L === 0, '★ 回合结束，入口恢复正常（L 归零）');

  // 负数：吃 R 后落 0 号桶（底表 1）→ -1
  reset(10);
  win.__marbleEat('R');
  const r2 = win.__marbleLand(0);
  ok(r2.n === -1 && M().balls === 4, '★ 吃 R 后落左侧 0 号桶：扣 1（5 → ' + M().balls + '）');
}

/* ================= 11) 错位 / 石化 ================= */
section('11) ★ 错位（左右各自内部打乱，不串边）· 石化（封桶反弹）');
{
  reset(11);
  win.__marbleEat('SHUF');
  const perm = M().fx.perm;
  ok(!!perm, '吃到错位 → 生成排列');
  ok(perm[4] === 4, '★ 中间入口不动（perm[4]=' + perm[4] + '）');
  ok(perm.slice(0, 4).every(i => i < 4), '★ 左侧 4 格只在左侧内部交换（' + perm.slice(0,4).join(',') + '）');
  ok(perm.slice(5).every(i => i > 4), '★ 右侧 4 格只在右侧内部交换（' + perm.slice(5).join(',') + '）');
  ok(M().effNums[4] === 8, '中间仍是 8');
  const sorted = a => a.slice().sort((x, y) => x - y);
  ok(JSON.stringify(sorted(M().effNums.slice(0, 4))) === JSON.stringify([0,1,2,4]),
     '★ 左侧仍是 1·0·2·4 这四张牌（' + M().effNums.slice(0,4).join('·') + '）');
  ok(JSON.stringify(sorted(M().effNums.slice(5))) === JSON.stringify([0,1,2,4]),
     '★ 右侧仍是 4·2·0·1 这四张牌（' + M().effNums.slice(5).join('·') + '）');

  // 石化：封 1~2 个入口，球会弹回去、且该桶不得分
  reset(11);
  win.__marbleEat('STONE');
  const sealed = M().fx.sealed;
  const cnt = sealed.filter(Boolean).length;
  ok(cnt >= 1 && cnt <= 2, '★ 石化封住 1~2 个入口（' + cnt + ' 个）');
  let si = sealed.indexOf(true);
  const r3 = win.__marbleLand(si);
  ok(r3.n === 0, '★ 落进被封的桶：记 0 分（不白送分）');
  ok(M().fx.sealed.every(v => !v), '★ 回合结束，水泥筒消失（入口恢复）');

  // 封桶反弹：球掉到桶口被弹回场内
  reset(11);
  win.__marbleEat('STONE');
  let sidx = M().fx.sealed.indexOf(true);
  const s = M();
  const bx = s.fieldL + (sidx + 0.5) * s.slotW;
  setBall({ x: bx, y: s.mouthY - 26, vy: 420 });
  run(10);
  const bb = M().ball;
  ok(M().state === 'play' && bb && bb.y < s.mouthY - 4,
     '★ 被封的入口会把球弹回场内（y=' + (bb ? bb.y.toFixed(0) : '—') + ' < 桶口 ' + s.mouthY + '）');
}

/* ================= 12) 分裂 / UP ================= */
section('12) ★ 分裂球（一变三、可叠加、上限 9）· 1UP/2UP/3UP');
{
  reset(12);
  ok(M().flyers.length === 0, '开局场上没有在飞的球');
  win.__marbleEat('SPLIT');
  ok(M().flyers.length === 3, '★ 吃到分裂：一变三（' + M().flyers.length + ' 球）');
  ok(M().flyers.every(b => b.splitLv === 1), '三球都记了分裂层数 1');
  const angs = M().flyers.map(b => Math.atan2(b.vy, b.vx));
  ok(new Set(angs.map(a => a.toFixed(3))).size === 3, '★ 三球朝三个不同方向弹开');

  win.__marbleEat('SPLIT', 0);
  ok(M().flyers.length === 5, '★ 再吃一次继续分裂：3 → ' + M().flyers.length + ' 球');
  ok(M().flyers[0].splitLv === 2, '层数累加到 2');

  for(let i = 0; i < 30; i++) win.__marbleEat('SPLIT', 0);
  ok(M().flyers.length <= M().MAX_FLYERS, '★ 同屏封顶 ' + M().MAX_FLYERS + ' 球（实际 ' + M().flyers.length + '）');

  // 多球计分求和
  reset(12);
  win.__marbleEat('SPLIT');
  const per = M().effNums[4];
  win.__marbleLand(4); win.__marbleLand(4); win.__marbleLand(4);
  ok(M().balls === 5 + per * 3,
     '★ 三球全部落 8 号桶：得分按总和算（5 + ' + per + '×3 = ' + M().balls + '）');

  // UP
  reset(12);
  const b0 = M().balls;
  win.__marbleEat('UP3');
  ok(M().balls === b0 + 3, '★ 3UP 立即加 3 条命（' + b0 + ' → ' + M().balls + '）');
  ok(M().flyers.length === 3, '★ 3UP 同时分裂出 3 个小球（' + M().flyers.length + '）');
  reset(12);
  win.__marbleEat('UP1');
  ok(M().balls === 6 && M().flyers.length === 1, '★ 1UP 加 1 命、分裂出 1 个球（' + M().balls + ' 命 / ' + M().flyers.length + ' 球）');
}

/* ================= 13) 地雷 / 火力球 / 冰封球 ================= */
section('13) ★ 地雷（炸死球+炸钉）· 火力球（撞钉引爆）· 冰封球（冻钉碎裂）');
{
  // 爆炸本身：炸掉范围内的钉（用独立的爆炸钩子，避免「炸完回合就结束、钉立刻复原」干扰观察）
  reset(13);
  const p0 = M().pegs[12];
  win.__marbleExplode(p0.x, p0.y, 48, true);
  const dead = M().pegs.filter(p => p.dead).length;
  ok(dead > 0, '★ 爆炸炸毁范围内的钉（' + dead + ' 颗）');
  ok(M().pegs.filter(p => p.dead).every(p => Math.hypot(p.x - p0.x, p.y - p0.y) <= 48 + M().RP + 0.01),
     '★ 只有范围内的钉被炸掉（没有全屏清空）');

  // 地雷：球被炸死 + 场上无球则回合结束
  reset(13);
  setBall({ x: p0.x, y: p0.y - 4, vy: 60 });
  win.__marbleEat('MINE');
  ok(M().state === 'ready' && M().flyers.length === 0, '★ 触碰的球被炸死，场上无球 → 该回合结束');
  ok(M().balls === 5, '★ 被地雷炸死 = 白打一颗（弹珠 5 → ' + M().balls + '）');
  ok(M().pegs.every(p => !p.dead), '★ 它是场上唯一的球 → 回合立即结束 → 钉随回合结束复原');

  // 地雷会连累其它球
  reset(13);
  win.__marbleEat('SPLIT');
  ok(M().flyers.length === 3, '先裂成 3 球');
  win.__marbleEat('MINE', 0);
  ok(M().flyers.length < 3, '★ 地雷把周围的球一起炸掉（剩 ' + M().flyers.length + '）');

  // 火力球
  reset(13);
  const p1 = M().pegs[20];
  setBall({ x: p1.x, y: p1.y - 40, vy: 520 });
  win.__marbleEat('FIRE');
  ok(M().flyers[0].fire === true, '吃到火力 → 球进入火力状态');
  run(14);
  ok(M().pegs.filter(p => p.dead).length > 0, '★ 撞到下一个钉时引爆，炸掉周围钉（'
     + M().pegs.filter(p => p.dead).length + ' 颗）');
  ok(!M().flyers.some(b => b.fire), '★ 引爆后小球恢复普通状态');

  // 冰封球
  reset(13);
  const p2 = M().pegs[30];
  setBall({ x: p2.x, y: p2.y - 60, vy: 260 });
  win.__marbleEat('ICE');
  ok(M().flyers[0].iceT > 0, '吃到冰封 → 冰封计时开始（' + M().flyers[0].iceT.toFixed(1) + 's）');
  run(20);
  const froz = M().pegs.filter(p => p.frozen).length;
  ok(froz > 0, '★ 前进途中把路径上的钉冻住（' + froz + ' 颗）');
  run(40);
  ok(M().pegs.filter(p => p.dead).length > 0, '★ 撞到冰冻的钉 → 碎裂消失（'
     + M().pegs.filter(p => p.dead).length + ' 颗）');

  // 回合结束：钉全部复原
  reset(13);
  win.__marbleExplode(M().pegs[12].x, M().pegs[12].y, 48, false);
  ok(M().pegs.some(p => p.dead), '（前置）爆炸确实炸掉了钉');
  win.__marbleLand(4);
  ok(M().pegs.every(p => !p.dead && !p.frozen), '★ 回合结束，被炸/被冻的钉全部复原');
}

/* ================= 14) 刷新时机 / 小丑礼盒 / 回合末清除 ================= */
section('14) ★ 刷新时机：局初 30% · 回合中出礼盒 · 回合末清空');
{
  let withItems = 0;
  for(let s = 1; s <= 120; s++){ reset(s); if(M().itemsOn) withItems++; }
  const rate = withItems / 120;
  ok(rate > 0.12 && rate < 0.55, '★ 约 30% 的局开局会刷出道具（实测 ' + (rate * 100).toFixed(0) + '%）');

  // 找到一局有道具的
  let seedWith = 0;
  for(let s = 1; s <= 120; s++){ reset(s); if(M().itemsOn && M().items.length > 0){ seedWith = s; break; } }
  ok(seedWith > 0, '存在开局就带道具的局（种子 ' + seedWith + '，' + M().items.length + ' 个）');
  ok(M().items.length <= 2, '★ 开局最多刷 2 个（' + M().items.length + '）');

  // 道具位置合法：在场地内、不压钉
  const st = M();
  const bad = st.items.filter(it =>
    it.x < st.fieldL + 8 || it.x > st.fieldR - 8 || it.y < st.fieldT + 20 || it.y > st.mouthY - 8);
  ok(bad.length === 0, '★ 道具都刷在场地内且不越过桶口（' + st.items.length + ' 个）');

  // 小丑礼盒：吃到后刷出 1~3 个新道具
  reset(14);
  win.__marbleClearItems();
  ok(M().items.length === 0, '（前置）清空道具');
  win.__marbleEat('CLOWN');
  const after = M().items.length;
  ok(after >= 1 && after <= 3, '★ 小丑礼盒刷出 1~3 个随机道具（' + after + ' 个）');

  // 回合进行到一定阶段刷礼盒
  reset(14);
  win.__marbleClearItems();
  win.__marbleFire(0.5);
  ok(M().state === 'play', '（前置）发射，回合进行中');
  win.__marbleAddPegHits(10);
  run(2);
  ok(M().clownDone && M().items.some(it => it.kind === 'CLOWN'),
     '★ 回合打到一定阶段（撞钉 ≥10）刷出小丑礼盒');

  // 回合结束：没吃到的道具不带到下一回合
  reset(14);
  win.__marbleClearItems();
  win.__marblePutItem('SPLIT', M().fieldL + 40, M().fieldT + 120);
  ok(M().items.length === 1, '（前置）放 1 个道具');
  win.__marbleLand(4);
  ok(M().items.length === 0, '★ 回合结束，没吃到的道具消失（不带到下一回合）');
}

/* ================= 15) 压力：道具全程开启 ================= */
section('15) 压力：每回合都塞道具，连打不卡死 / 数值不坏');
{
  reset(21);
  let shots = 0, stuck = 0, bad = 0, maxFly = 0, longest = 0;
  while(M().state !== 'over' && shots < 80){
    win.__marbleSpawnItems(2);                       // 每回合都塞 2 个随机道具
    win.__marbleSetAim(((shots % 7) - 3) / 6);       // 顺便换个角度
    press(); setCharge((shots % 10) / 10); release();
    let f = 0;
    while(M().state === 'play' && f < 1600){
      perfNow += 16; step(DT); f++;
      const st = M();
      maxFly = Math.max(maxFly, st.flyers.length);
      if(!Number.isFinite(st.balls) || st.balls < 0) bad++;
      for(const b of st.flyers) if(![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) bad++;
    }
    longest = Math.max(longest, f);
    if(f >= 1600) stuck++;
    shots++;
  }
  ok(stuck === 0, '★ ' + shots + ' 发（每发都带道具）没有一发卡住不落桶（卡住 ' + stuck + ' 发）');
  ok(bad === 0, '★ 全程没有 NaN / 负弹珠（异常 ' + bad + ' 次）');
  ok(maxFly <= M().MAX_FLYERS, '★ 同屏球数始终 ≤ ' + M().MAX_FLYERS + '（峰值 ' + maxFly + '）');
  ok(longest < 1200, '最长一发 ' + longest + ' 帧就收工（远小于 1600 帧上限）');
  ok(M().state === 'over' || shots === 80, '正常结束或打满（' + shots + ' 发，state=' + M().state + '）');
}

/* ================= 16) 绘制冒烟 ================= */
section('16) 绘制：各种状态下画图都不报错（含道具/旋转炮口/水泥筒/负分桶）');
{
  const tryDraw = label => {
    let r = 'ok';
    try { win.__marbleDraw(); } catch (e) { r = String(e && e.message || e); }
    ok(r === 'ok', '★ ' + label + ' 绘制不报错', r);
  };
  reset(16);
  tryDraw('开局（带提示）');
  win.__marbleSetAim(0.5); tryDraw('炮口转到 30°');
  win.__marbleSpawnItems(3); tryDraw('场上有 3 个道具');
  win.__marbleFire(0.7); tryDraw('单球飞行中');
  win.__marbleEat('SPLIT'); tryDraw('三球同屏');
  win.__marbleEat('FIRE', 0); tryDraw('火力球');
  win.__marbleEat('ICE', 1); tryDraw('冰封球');
  win.__marbleEat('L'); win.__marbleEat('L'); win.__marbleEat('R');
  tryDraw('负分桶 + 两位数桶号');
  win.__marbleEat('SHUF'); tryDraw('入口错位');
  win.__marbleEat('STONE'); tryDraw('水泥筒封桶');
  win.__marbleExplode(M().pegs[12].x, M().pegs[12].y, 48, false);
  tryDraw('爆炸特效进行中');
  win.__marbleLand(4); tryDraw('回合结束（复原后）');
  win.__marbleSetBall({ x: M().cannonX, y: M().mouthY - 30, vy: 200 });
  win.__marbleEat('MINE'); tryDraw('地雷炸完');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
