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
/* ★ 记录型渐变：地雷弹体是用径向渐变画的（近黑），
 *   所以要能看到「这次渐变用了哪些颜色」，不能只留一个空桩。 */
function mkGradient() {
  const stops = [];
  const g = { stops, addColorStop(off, col) { stops.push({ off, col: String(col) }); } };
  return g;
}
/* ★ 记录型 ctx：把 save/restore/translate/rotate 记下来，
 *   用来断言「画出来的炮口朝向」和「发射方向」一致（光看数值看不出绘制反向）。
 *   另外记录 fillText 与「圆弧填充」(fillStyle + 半径)，用来断言地雷的黑色弹体 + 白骷髅。 */
const drawRec = { frames: [], stack: [], alphas: [], texts: [], fills: [], dashes: [], strokes: [] };
function mkCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => mkGradient();
      if (k === 'save') return () => drawRec.stack.push({ tx: 0, ty: 0, rot: 0 });
      if (k === 'restore') return () => drawRec.stack.pop();
      if (k === 'translate') return (x, y) => {
        const s = drawRec.stack[drawRec.stack.length - 1];
        if (s) { s.tx = x; s.ty = y; }
      };
      if (k === 'rotate') return a => {
        const s = drawRec.stack[drawRec.stack.length - 1];
        if (s) s.rot = a;
        drawRec.frames.push({ tx: s ? s.tx : 0, ty: s ? s.ty : 0, rot: a });
      };
      if (k === 'fillText') return (txt, x, y) => { drawRec.texts.push({ txt: String(txt), x, y, style: t.fillStyle, font: t.font }); };
      if (k === 'setLineDash') return arr => { drawRec.dashes.push(arr ? arr.slice() : []); };
      /* ★ 记录描边路径：入口外边缘是 moveTo/lineTo + stroke 画的，
       *   要能验证「真的画了」以及「用什么颜色/多粗」。 */
      if (k === 'beginPath') return () => { t._path = []; };
      if (k === 'moveTo') return (x, y) => { if (!t._path) t._path = []; t._path.push({ x, y, move: true }); };
      if (k === 'lineTo') return (x, y) => { if (!t._path) t._path = []; t._path.push({ x, y }); };
      if (k === 'stroke') return () => {
        for (const p of (t._path || [])) {
          if (p.move) continue;
          drawRec.strokes.push({ x: p.x, y: p.y, style: t.strokeStyle, w: t.lineWidth });
        }
      };
      if (k === 'arc') return (x, y, r) => { t._lastR = r; t._lastX = x; t._lastY = y; };
      if (k === 'fill') return () => { drawRec.fills.push({ r: t._lastR, x: t._lastX, y: t._lastY, style: t.fillStyle, alpha: t.globalAlpha }); };
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) {
      t[k] = v;
      if (k === 'globalAlpha') drawRec.alphas.push(v);   // ★ 抓透明度，用来断言「最后一回合的道具在闪」
      return true;
    },
  });
}
function resetDrawRec() { drawRec.texts.length = 0; drawRec.fills.length = 0; drawRec.dashes.length = 0; drawRec.alphas.length = 0; drawRec.strokes.length = 0; }
function mkClassList() {
  const s = new Set();
  return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), _all: () => [...s] };
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
    documentElement: { scrollHeight: 700, classList: mkClassList() }, body: mkEl('body'),
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
        // ★ 只看「还活着」的钉：被火力球/地雷炸掉的钉球本来就该穿过去，拿它判定穿钉是误报
        for (const p of M().pegs) {
          if (p.dead) continue;
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
  // （★ 先清空道具：这一节测的是纯物理，被地雷炸死的话根本不会落桶）
  win.__marbleClearItems();
  const r = shoot(0.83, 1200);
  ok(r.resolved && r.bucket >= 0 && r.bucket <= 8, '真实物理必然结算到某个桶（桶[' + r.bucket + ']=' + M().NUMS[r.bucket] + '）', '帧数 ' + r.frames);
  ok(!r.outOfBounds, '全程不出墙（含顶棚）');
  ok(!r.tunnel, '★ 不穿钉：每一步对每颗钉都满足 r_球+r_钉 距离下界');
  ok(!r.sawNaN, '坐标无 NaN');
  ok(r.maxT < M().FLIGHT_CAP, '单球用不到超时兜底（实际 ' + r.maxT.toFixed(2) + 's < 上限 ' + M().FLIGHT_CAP + 's）');
  ok(r.maxT < 10, '一球在 10s 内打完（' + r.maxT.toFixed(2) + 's）');

  // 确定性：同种子同力量 → 同一个桶
  const d1 = (reset(7), win.__marbleClearItems(), shoot(0.61)), b1 = M().lastBucket, g1 = M().balls;
  const d2 = (reset(7), win.__marbleClearItems(), shoot(0.61)), b2 = M().lastBucket, g2 = M().balls;
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
  run(Math.round(1.3 / DT));
  /* ★ 判「位移」而不是瞬时 vx：球被踢出去后还会在钉顶上弹几下，vx 会被蹭小，
   *   但「离原地多远」骗不了人。 */
  let far = 0;
  for (let f = 0; f < Math.round(0.5 / DT); f++) {
    perfNow += 16; step(DT);
    const bb = M().ball;
    if (bb) far = Math.max(far, Math.abs(bb.x - p1.x));
  }
  ok(far > 3, 'B·高速原地打摆（vx 恒 0）→ 1.8s 内被踢开（离原地最远 ' + far.toFixed(1) + '）');
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
section('10) ★ Left / Right：左(右)侧加倍、另一侧变负、中间归 0、可叠加（L/R 互斥见第 16 节）');
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
  /* ★ 用户改的：入口变化不再「回合结束就复原」，而是保持 ENTRANCE_LIFE 回合
   *   （旧断言是 `fx.L === 0`，已被第 17 节的寿命规则取代） */
  ok(M().fx.L === 1 && M().fx.life === M().ENTRANCE_LIFE - 1,
     '★ 回合结束：入口变化仍生效（L=1、还剩 ' + M().fx.life + ' 回合）');

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
  ok(M().fx.sealed.some(Boolean), '★ 回合结束，水泥筒仍封着（保持 ' + M().ENTRANCE_LIFE + ' 回合，不再立刻消失）');

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
section('12) ★ 分裂球（一变 ' + 4 + '、可叠加、上限 9）· 1UP/2UP/3UP');
{
  reset(12);
  const SN = M().SPLIT_N;
  ok(SN === 4, '★ 分裂常数 SPLIT_N=4（一变四，用户要求比原来多 1 个）');
  ok(M().flyers.length === 0, '开局场上没有在飞的球');
  win.__marbleEat('SPLIT');
  ok(M().flyers.length === SN, '★ 吃到分裂：一变 ' + SN + '（' + M().flyers.length + ' 球）');
  ok(M().flyers.every(b => b.splitLv === 1), SN + ' 球都记了分裂层数 1');
  const angs = M().flyers.map(b => Math.atan2(b.vy, b.vx));
  ok(new Set(angs.map(a => a.toFixed(3))).size === SN, '★ ' + SN + ' 球朝 ' + SN + ' 个不同方向弹开');
  /* ★ 张角没有变大：仍然铺在 ±0.55 内（只是从 3 条变 4 条） */
  const sorted = angs.slice().sort((a, b) => a - b);
  const spread = sorted[sorted.length - 1] - sorted[0];
  ok(spread <= 0.55 * 2 + 1e-6, '★ 张角仍在 ±0.55 内（实测 ' + spread.toFixed(3) + ' ≤ 1.100）');

  win.__marbleEat('SPLIT', 0);
  ok(M().flyers.length === 2 * SN - 1, '★ 再吃一次继续分裂：' + SN + ' → ' + M().flyers.length + ' 球');
  ok(M().flyers[0].splitLv === 2, '层数累加到 2');

  for(let i = 0; i < 30; i++) win.__marbleEat('SPLIT', 0);
  ok(M().flyers.length <= M().MAX_FLYERS, '★ 同屏封顶 ' + M().MAX_FLYERS + ' 球（实际 ' + M().flyers.length + '）');

  // 多球计分求和
  reset(12);
  win.__marbleEat('SPLIT');
  const per = M().effNums[4];
  for(let i = 0; i < SN; i++) win.__marbleLand(4);
  ok(M().balls === 5 + per * SN,
     '★ ' + SN + ' 球全部落 8 号桶：得分按总和算（5 + ' + per + '×' + SN + ' = ' + M().balls + '）');

  // UP
  reset(12);
  const b0 = M().balls;
  win.__marbleEat('UP3');
  ok(M().balls === b0 + 3, '★ 3UP 立即加 3 条命（' + b0 + ' → ' + M().balls + '）');
  ok(M().flyers.length === 3, '★ 3UP 同时分裂出 3 个小球（' + M().flyers.length + '）');
  reset(12);
  win.__marbleEat('UP1');
  ok(M().balls === 6 && M().flyers.length === 1, '★ 1UP 加 1 命、分裂出 1 个球（' + M().balls + ' 命 / ' + M().flyers.length + ' 球）');

  /* ★ 用户要求：UP 道具牌面上写「1up / 2up / 3up」，不是原来的「+1 / +2 / +3」 */
  const upTxt = k => win.__marbleItemMeta(k).txt;
  ok(upTxt('UP1') === '1up' && upTxt('UP2') === '2up' && upTxt('UP3') === '3up',
     '★ UP 道具字形改成 1up / 2up / 3up（' + [upTxt('UP1'), upTxt('UP2'), upTxt('UP3')].join(' / ') + '）');
  ok(![upTxt('UP1'), upTxt('UP2'), upTxt('UP3')].some(t => t.indexOf('+') >= 0),
     '★ 不再是 +1/+2/+3（不带加号）');

  // 3 个字要真的画得下：字号必须比单字小
  reset(12); win.__marbleClearItems();
  const fx1 = M().ITEM_FONT[1], fx3 = M().ITEM_FONT[3];
  ok(fx3 < fx1, '★ 3 字字号(' + fx3 + ') < 1 字字号(' + fx1 + ') —— 塞得进 19px 圆牌');
  const mx2 = M().fieldL + 60, my2 = M().fieldT + 150;
  win.__marblePutItem('UP2', mx2, my2);
  resetDrawRec();
  win.__marbleDraw();
  const upDraw = drawRec.texts.filter(t => t.txt === '2up');
  ok(upDraw.length === 1, '★ 「2up」真的被画到画布上了');
  ok(upDraw.length === 0 || parseFloat(String(upDraw[0].font).match(/([\d.]+)px/)[1]) === fx3,
     '★ 用的是 3 字字号（' + (upDraw[0] ? upDraw[0].font : '—') + '）');
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
  ok(M().pegs.filter(p => p.dead).length > 0,
     '★ 它是场上唯一的球 → 回合立即结束，但被炸掉的钉仍保持碎（寿命机制）');

  // 地雷会连累其它球
  reset(13);
  win.__marbleEat('SPLIT');
  ok(M().flyers.length === M().SPLIT_N, '先裂成 ' + M().SPLIT_N + ' 球');
  win.__marbleEat('MINE', 0);
  ok(M().flyers.length < M().SPLIT_N, '★ 地雷把周围的球一起炸掉（剩 ' + M().flyers.length + '）');

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
  reset(13); win.__marbleClearItems();      // ★ 只测冰封机制，别让路上的道具插一脚
  const p2 = M().pegs[30];
  setBall({ x: p2.x, y: p2.y - 60, vy: 260 });
  win.__marbleEat('ICE');
  ok(M().flyers[0].iceT > 0, '吃到冰封 → 冰封计时开始（' + M().flyers[0].iceT.toFixed(1) + 's）');
  run(20);
  const froz = M().pegs.filter(p => p.frozen).length;
  ok(froz > 0, '★ 前进途中把路径上的钉冻住（' + froz + ' 颗）');
  // ★ 取「过程中的峰值」：球一旦落桶回合就结束，钉不再复原（但状态是持续的，直接看即可）
  let shattered = 0;
  for (let f = 0; f < 40 && M().flyers.length; f++) { perfNow += 16; step(DT);
    shattered = Math.max(shattered, M().pegs.filter(p => p.dead).length); }
  ok(shattered > 0, '★ 撞到冰冻的钉 → 碎裂消失（' + shattered + ' 颗）');

  // ★ 回合结束：钉的状态不再复原，而是寿命 -1（保持 PEG_LIFE 回合）
  reset(13);
  win.__marbleExplode(M().pegs[12].x, M().pegs[12].y, 48, false);
  ok(M().pegs.some(p => p.dead), '（前置）爆炸确实炸掉了钉');
  win.__marbleLand(4);
  ok(M().pegs.some(p => p.dead), '★ 回合结束，被炸掉的钉仍保持碎（不再立刻复原）');
  ok(M().pegs.every(p => !p.frozen), '（前置）本回合没有被冻的钉');
}

/* ================= 14) 刷新时机 / 小丑礼盒 / 回合末清除 ================= */
section('14) ★ 刷新时机：局初 80% · 每回合 80% · 回合中出礼盒 · 道具寿命 3 回合');
{
  let withItems = 0;
  for(let s = 1; s <= 200; s++){ reset(s); if(M().itemsOn) withItems++; }
  const rate = withItems / 200;
  ok(rate > 0.68 && rate < 0.92, '★ 约 80% 的局开局会刷出道具（实测 ' + (rate * 100).toFixed(0) + '%）');

  // 找到一局有道具的
  let seedWith = 0;
  for(let s = 1; s <= 200; s++){ reset(s); if(M().itemsOn && M().items.length > 0){ seedWith = s; break; } }
  ok(seedWith > 0, '存在开局就带道具的局（种子 ' + seedWith + '，' + M().items.length + ' 个）');
  ok(M().items.length >= 1 && M().items.length <= 2, '★ 开局刷 1~2 个（' + M().items.length + '）');

  /* ★ 每回合开局也按 80% 刷：连打 12 回合，统计「开局就有道具的回合数」 */
  reset(31);
  let roundsWith = 0, rounds = 0;
  for(let k = 0; k < 12; k++){
    land(4);                                        // 直接落头奖（+8），弹珠不会耗光
    if(M().items.length > 0) roundsWith++;          // 本回合开局刷出来的
    rounds++;
  }
  const rr = roundsWith / rounds;
  ok(rr >= 0.6, '★ 每回合开局也大概率有道具（' + roundsWith + '/' + rounds + ' = ' + (rr * 100).toFixed(0) + '%）');
  ok(M().ITEM_ROUND_CHANCE === 0.8 && M().ITEM_RUN_CHANCE === 0.8,
     '★ 刷新概率常数 = 80%（局初 ' + M().ITEM_RUN_CHANCE + ' / 每回合 ' + M().ITEM_ROUND_CHANCE + '）');

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

  /* ★ 道具寿命：回合结束不再清空，life -1，最多活 ITEM_LIFE 回合
   *   （下一回合还会新刷道具，所以一律按 id 认人） */
  reset(14);
  win.__marbleClearItems();
  const putId = win.__marblePutItem('SPLIT', M().fieldL + 40, M().fieldT + 120);
  const LIFE = M().ITEM_LIFE, MAXN = M().ITEM_MAX;
  ok(LIFE === 3, '★ 道具寿命常数 ITEM_LIFE=3（' + LIFE + '）');
  ok(M().items.length === 1 && M().items[0].id === putId, '（前置）放 1 个道具（id=' + putId + '）');
  ok(M().items[0].life === LIFE, '（前置）初始寿命 = ' + M().items[0].life);

  /* 自然衰减：连打 5 回合，看这个道具的 life 变化
   *   （每回合还会自动刷道具，所以只认 id） */
  const alive = [];
  for(let k = 0; k < 5; k++){
    win.__marbleLand(4);                             // 直接落头奖（+8），弹珠耗不光
    const mine = M().items.find(it => it.id === putId);
    alive.push(mine ? mine.life : 0);
  }
  ok(alive[0] === LIFE - 1 && alive[1] === LIFE - 2 && alive[2] === 0,
     '★ 每回合结束寿命 -1，第 ' + LIFE + ' 回合后消失（' + LIFE + ' → ' + alive.slice(0, 3).join(' → ') + '）');
  ok(alive[3] === 0 && alive[4] === 0, '★ 消失后不会「复活」（第 4、5 回合仍为 0）');

  /* ★ 闪烁提醒：life=1 的道具明暗周期变化；life 满的恒亮
   *   （itemAlpha 是纯函数，直接采样；再用记录型 ctx 确认这个值真的写进画布了） */
  const sampleAlpha = life => {
    const out = [];
    for(let f = 0; f < 40; f++){ run(1); out.push(win.__marbleItemAlpha(life)); }
    return { mn: Math.min.apply(null, out), mx: Math.max.apply(null, out) };
  };
  const aLast = sampleAlpha(1), aFull = sampleAlpha(3);
  ok(aLast.mn < 0.4 && aLast.mx > 0.85,
     '★ 寿命=1（最后一回合）→ 忽明忽暗（alpha ' + aLast.mn.toFixed(2) + '~' + aLast.mx.toFixed(2) + '）');
  ok(aFull.mn > 0.99 && aFull.mx > 0.99,
     '★ 寿命没到最后 → 一直亮着（alpha ' + aFull.mn.toFixed(2) + '）');

  // 这个值确实被写进画布了（撞针光晕也在设 alpha，所以只看「有没有够暗的时刻」）
  reset(14); win.__marbleLand(4); run(120);
  win.__marbleClearItems();
  win.__marblePutItem('SPLIT', M().fieldL + 40, M().fieldT + 120, 1);
  let wrote = false;
  for(let f = 0; f < 40; f++){
    run(1);
    drawRec.alphas.length = 0;
    win.__marbleDraw();
    if(drawRec.alphas.some(v => v < 0.45)) { wrote = true; break; }
  }
  ok(wrote, '★ 闪烁的不透明度真的落到画布上了（抓到 alpha<0.45）');

  // 场上道具不会无限堆积
  reset(77);
  let peak = 0;
  for(let k = 0; k < 20; k++){ win.__marbleLand(4); peak = Math.max(peak, M().items.length); }
  ok(peak <= MAXN, '★ 连打 20 回合，场上道具不超上限（峰值 ' + peak + ' ≤ ' + MAXN + '）');
}

/* ========== 15) ★ 撞针状态的寿命：被炸掉 / 被冻住保持 PEG_LIFE 回合 ========== */
section('15) ★ 撞针状态寿命：被炸掉/被冻住不再回合结束即复原，保持 3 回合');
{
  /* 用户原话：地雷/火力球/冰封球导致的「撞钉消失或状态改变」不在本回合结束后重置，
   *           而是保持 3 回合，3 回合后撞针恢复。 */
  reset(31);
  const PL = M().PEG_LIFE;
  ok(PL === 3, '★ 撞针状态寿命常数 PEG_LIFE=3（' + PL + '）');

  // ---- 被炸掉：寿命从 PEG_LIFE 开始，每回合 -1，掉到 0 才复原 ----
  win.__marbleSetPeg(12, 'dead');
  let p = M().pegs[12];
  ok(p.dead && p.life === PL, '★ 炸掉一颗钉 → 状态=碎、寿命=' + PL + '（实际 ' + p.life + '）');
  ok(p.last === false, '（前置）刚炸掉时不闪烁（还剩 ' + PL + ' 回合）');

  const seen = [];
  for(let k = 0; k < 4; k++){
    win.__marbleLand(4);                          // 直接落头奖，弹珠耗不光
    const q = M().pegs[12];
    seen.push(q.dead ? q.life : 0);
  }
  ok(seen[0] === PL - 1 && seen[1] === PL - 2 && seen[2] === 0,
     '★ 每回合结束寿命 -1，第 ' + PL + ' 回合后复原（' + PL + ' → ' + seen.slice(0, 3).join(' → ') + '）');
  ok(seen[3] === 0 && !M().pegs[12].dead, '★ 复原后不会「复活」成碎（第 4 回合仍是好的）');

  // ---- 被冻住：同一套寿命规则 ----
  reset(31);
  win.__marbleSetPeg(20, 'frozen');
  let q = M().pegs[20];
  ok(q.frozen && q.life === PL, '★ 冻住一颗钉 → 状态=冻、寿命=' + PL + '（实际 ' + q.life + '）');
  win.__marbleLand(4);
  q = M().pegs[20];
  ok(q.frozen && q.life === PL - 1, '★ 冻住的钉回合结束仍在（寿命 ' + q.life + '）');
  win.__marbleLand(4);
  q = M().pegs[20];
  ok(q.frozen && q.life === 1, '★ 第 ' + (PL - 1) + ' 回合：冻住且只剩 1 回合寿命（会闪烁）');
  ok(q.last === true, '★ 最后一回合 last=true（画面外圈闪红提醒）');
  win.__marbleLand(4);
  ok(!M().pegs[20].frozen && M().pegs[20].life === 0, '★ 第 ' + PL + ' 回合后解冻复原');

  // ---- 闪红提醒只发生在最后一回合 ----
  ok(win.__marblePegStateLast(3) === false && win.__marblePegStateLast(2) === false,
     '★ 寿命 3/2 时不闪（不是最后一回合）');
  ok(win.__marblePegStateLast(1) === true, '★ 寿命 1 时才闪');

  // ---- 冻住 → 被撞碎：转成「碎」，寿命重新起算（两种状态互斥，共用一份寿命） ----
  reset(31);
  win.__marbleSetPeg(30, 'frozen', 1);
  ok(M().pegs[30].last === true, '（前置）冻住且只剩 1 回合');
  win.__marbleSetPeg(30, 'dead');
  const s = M().pegs[30];
  ok(s.dead && !s.frozen && s.life === PL, '★ 冻住的钉被撞碎 → 转成「碎」，寿命重新起算 ' + PL);

  // ---- 爆炸不会给已经碎掉的钉「续命」 ----
  reset(31);
  win.__marbleSetPeg(40, 'dead', 1);
  const pos = M().pegs[40];
  win.__marbleExplode(pos.x, pos.y, 48, false);      // 同一位置再炸一次
  ok(M().pegs[40].life === 1, '★ 已碎掉的钉不会再被炸到（寿命不被刷新，仍是 1）');

  // ---- 换新局：整场钉状态清空 ----
  reset(31);
  win.__marbleSetPeg(12, 'dead');
  win.__marbleSetPeg(20, 'frozen');
  ok(M().pegs.some(x => x.dead) && M().pegs.some(x => x.frozen), '（前置）场上有碎钉和冻钉');
  win.__marbleReset(31);                             // 重开一局
  ok(M().pegs.every(x => !x.dead && !x.frozen && x.life === 0),
     '★ 换新局：所有钉状态清空、寿命归 0');

  // ---- 状态是「跨回合持续」的：钉碎了以后这一回合内物理上真的穿过它 ----
  reset(31);
  win.__marbleSetPeg(50, 'dead', 2);
  const dp = M().pegs[50];
  ok(M().pegs[50].dead, '（前置）第 50 号钉已碎');
  // 从正上方朝它打，应该直接穿过去（不会被反弹）
  setBall({ x: dp.x, y: dp.y - 60, vx: 0, vy: 400 });
  let passed = false;
  for(let f = 0; f < 30 && M().flyers.length; f++){
    perfNow += 16; step(DT);
    const b = M().flyers[0];
    if(b && b.y > dp.y + 20){ passed = true; break; }
  }
  ok(passed, '★ 碎掉的钉不再碰撞 —— 球直接穿过去（跨回合保持有效）');

  // ---- 绘制：碎钉（凹痕）/ 冻钉 / 最后一回合闪红，都不报错 ----
  reset(31);
  win.__marbleSetPeg(12, 'dead', 1);
  win.__marbleSetPeg(20, 'frozen', 1);
  win.__marbleSetPeg(30, 'dead', 3);
  win.__marbleSetPeg(40, 'frozen', 3);
  let drawOk = true, err = '';
  try{ for(let f = 0; f < 6; f++){ run(1); win.__marbleDraw(); } }
  catch(e){ drawOk = false; err = e.message; }
  ok(drawOk, '★ 碎钉/冻钉/最后一回合闪红 绘制不报错', err);
}

/* ===== 16) ★ 入口桶变化的寿命：L/R 倍率 · 错位 · 石化 保持 ENTRANCE_LIFE 回合 ===== */
section('16) ★ 入口桶变化的寿命：左/右·错位·封桶 不再回合结束即复原，保持 3 回合');
{
  /* 用户原话：让入口桶的变化（比如错位等效果）也保持 3 回合。 */
  reset(51);
  const EL = M().ENTRANCE_LIFE;
  ok(EL === 3, '★ 入口变化寿命常数 ENTRANCE_LIFE=3（' + EL + '）');

  // ---- Left 倍率：寿命 3 → 2 → 1 → 0，归 0 才恢复底表 ----
  win.__marbleClearFx();
  win.__marbleEat('L');
  ok(M().fx.L === 1 && M().fx.life === EL, '★ 吃到 Left → 层数 1、寿命 ' + EL);
  ok(M().fx.active === true, '★ entranceActive() = true（有变化在生效）');
  const effAfter = M().effNums.slice();
  ok(JSON.stringify(effAfter) === JSON.stringify([2,0,4,8,0,-4,-2,0,-1]),
     '（前置）生效时入口数字被放大（' + effAfter.join('·') + '）');

  const alive = [];
  for(let k = 0; k < 4; k++){
    win.__marbleLand(4);                            // 直接落头奖，弹珠耗不光
    const f = M().fx;
    alive.push(f.L ? f.life : 0);
  }
  ok(alive[0] === EL - 1 && alive[1] === EL - 2 && alive[2] === 0,
     '★ 每回合结束寿命 -1，第 ' + EL + ' 回合后恢复底表（' + EL + ' → ' + alive.slice(0, 3).join(' → ') + '）');
  ok(alive[3] === 0 && M().fx.L === 0, '★ 恢复后不会「复活」（第 4 回合 L 仍为 0）');
  ok(JSON.stringify(M().effNums) === JSON.stringify([1,0,2,4,8,4,2,0,1]),
     '★ 恢复底表：入口数字回到 1·0·2·4·8·4·2·0·1（' + M().effNums.join('·') + '）');
  ok(M().fx.active === false, '★ 恢复后 entranceActive() = false');

  // ---- 错位也保持 3 回合 ----
  reset(51); win.__marbleClearFx();
  win.__marbleEat('SHUF');
  const perm0 = M().fx.perm.join(',');
  ok(M().fx.life === EL, '★ 吃到错位 → 寿命 ' + EL);
  win.__marbleLand(4);
  ok(M().fx.perm && M().fx.perm.join(',') === perm0, '★ 回合结束：错位排列仍在（没被清掉）');
  ok(M().fx.life === EL - 1, '★ 错位寿命 -1（还剩 ' + M().fx.life + ' 回合）');
  win.__marbleLand(4); win.__marbleLand(4);
  ok(M().fx.perm === null, '★ 第 ' + EL + ' 回合后错位消失（恢复底表顺序）');

  // ---- 石化也保持 3 回合 ----
  reset(51); win.__marbleClearFx();
  win.__marbleEat('STONE');
  const sealedIdx = M().fx.sealed.map((v, i) => v ? i : -1).filter(i => i >= 0);
  ok(sealedIdx.length >= 1, '（前置）封住了 ' + sealedIdx.length + ' 个入口');
  win.__marbleLand(4);
  ok(sealedIdx.every(i => M().fx.sealed[i]), '★ 回合结束：水泥筒仍封着（寿命机制）');
  win.__marbleLand(4); win.__marbleLand(4);
  ok(M().fx.sealed.every(v => !v), '★ 第 ' + EL + ' 回合后水泥筒全部消失');

  // ---- 再吃一次 = 一次新的状态变化 → 寿命重新起算 ----
  reset(51); win.__marbleClearFx();
  win.__marbleEat('L');
  win.__marbleLand(4); win.__marbleLand(4);          // 寿命掉到 1
  ok(M().fx.life === 1, '（前置）L 只剩 1 回合寿命（' + M().fx.life + '）');
  win.__marbleEat('SHUF');                            // 再吃到错位
  ok(M().fx.life === EL, '★ 又吃到入口变化 → 寿命重新起算 ' + EL + '（L 和错位一起续上）');
  ok(M().fx.L === 1 && !!M().fx.perm, '★ 两种变化同时在（L 与 错位 叠加，不是互相覆盖）');

  // ---- ★ Left / Right 互斥：不会出现「L 和 R 同时在场」的全负死局 ----
  /* 为什么必须锁住：effNums() 里 L 会让右侧变负、R 会让左侧变负，
   *   两者同时在场 → 9 个桶全是负数（只剩 0 桶），几乎没法得分。
   *   以前效果只活一回合，最多挨一回合；现在要保持 3 回合 → 必须先吃 L 再吃 R
   *   就会连挨 3 回合，玩家又不能完全控制吃到哪个，所以改成互相抵消。 */
  reset(51); win.__marbleClearFx();
  win.__marbleEat('L');
  ok(M().fx.L === 1 && M().fx.R === 0, '（前置）先吃 L：L=1');
  win.__marbleEat('R');
  ok(M().fx.R === 0 && M().fx.L === 0, '★ 再吃 R → 抵消掉 L（不是 L 和 R 并存）');
  ok(M().effNums.filter(v => v > 0).length >= 6,
     '★ 抵消后仍有足够正分桶（' + M().effNums.filter(v => v > 0).length + ' 个，不是全负死局）');
  ok(M().fx.life === EL, '★ 抵消也算一次入口变化 → 寿命重新起算 ' + EL);

  // 反向：先 R 后 L 同样抵消
  reset(51); win.__marbleClearFx();
  win.__marbleEat('R');
  win.__marbleEat('L');
  ok(M().fx.L === 0 && M().fx.R === 0, '★ 先 R 后 L 同样互相抵消');

  // 关键：任何时刻都不该出现「L>0 且 R>0」的全负状态
  reset(51); win.__marbleClearFx();
  let bothSeen = 0, allNegSeen = 0;
  for(let k = 0; k < 40; k++){
    win.__marbleEat(k % 2 ? 'R' : 'L');
    const f = M().fx;
    if(f.L > 0 && f.R > 0) bothSeen++;
    if(M().effNums.filter(v => v > 0).length === 0) allNegSeen++;
    if(k % 5 === 4) win.__marbleLand(4);              // 偶尔推进回合
  }
  ok(bothSeen === 0, '★ 连吃 40 次 L/R，从未出现「L 与 R 同时 > 0」（' + bothSeen + ' 次）');
  ok(allNegSeen === 0, '★ 连吃 40 次 L/R，从未出现「一个正分桶都没有」（' + allNegSeen + ' 次）');

  // 同向叠加仍然正常（L 叠 L 是加倍，不是抵消）
  reset(51); win.__marbleClearFx();
  win.__marbleEat('L'); win.__marbleEat('L');
  ok(M().fx.L === 2 && M().fx.R === 0, '★ 同向叠加照旧：L 吃两次 = 层数 2（' + M().fx.L + '）');

  // ---- 封桶有上限：连续吃石化不会把 9 个桶全封死 ----
  reset(51); win.__marbleClearFx();
  for(let k = 0; k < 12; k++) win.__marbleEat('STONE');
  const sealCnt = M().fx.sealed.filter(Boolean).length;
  ok(sealCnt <= M().SEAL_MAX, '★ 连续吃 12 次石化，被封入口不超上限（' + sealCnt + ' ≤ ' + M().SEAL_MAX + '）');
  const freeCnt = M().fx.sealed.filter(v => !v).length;
  ok(freeCnt >= 6, '★ 始终留着足够的可得分入口（空着 ' + freeCnt + '/9）');

  // ---- ★ 入口外边缘闪烁（用户要求：L / R / 变换时闪，起提醒作用） ----
  /* 断言方式：入口区那几条边是用 stroke 画的，且颜色/线宽会随效果和寿命变。
   *   记录型 ctx 记了 lineWidth 与 strokeStyle，所以能验证「真的画到画布上了」。 */
  const edgeColors = () => {
    reset(51); win.__marbleClearFx();
    return null;
  };
  reset(51); win.__marbleClearFx();
  ok(win.__marbleEntranceEdge().key === '', '（前置）没有入口变化时，没有闪烁色');

  win.__marbleEat('L');
  ok(win.__marbleEntranceEdge().col === '#ffd166', '★ 倍率生效 → 入口边缘用金色闪（' + win.__marbleEntranceEdge().col + '）');
  win.__marbleClearFx(); win.__marbleEat('SHUF');
  ok(win.__marbleEntranceEdge().col === '#c2a3ff', '★ 错位生效 → 入口边缘用紫色闪（' + win.__marbleEntranceEdge().col + '）');
  win.__marbleClearFx(); win.__marbleEat('STONE');
  ok(win.__marbleEntranceEdge().col === '#cfd6e0', '★ 封桶生效 → 入口边缘用灰白闪（' + win.__marbleEntranceEdge().col + '）');
  // 多种叠加取优先级最高的（错位 > 倍率 > 封桶）
  win.__marbleClearFx(); win.__marbleEat('L'); win.__marbleEat('STONE'); win.__marbleEat('SHUF');
  ok(win.__marbleEntranceEdge().col === '#c2a3ff', '★ 多种叠加时取优先级最高的（错位）');

  /* ★ 关键：闪烁必须真的落到画布上，而且「有变化」和「没变化」要能区分开。
   *   做法：分别在有/无入口变化时各画若干帧，统计「入口区附近被 stroke 的次数与线宽」。 */
  const countEntranceStrokes = () => {
    let n = 0, widths = [];
    for (let f = 0; f < 12; f++) {
      run(1);
      drawRec.strokes.length = 0;
      win.__marbleDraw();
      for (const s of drawRec.strokes) {
        // 入口区：y 在桶口~桶底之间，且是横贯场地的长边
        if (s.y >= M().mouthY - 3 && s.y <= M().floorY + 3) { n++; widths.push(s.w); }
      }
    }
    return { n, widths };
  };
  reset(51); win.__marbleClearFx(); win.__marbleClearItems();
  const noEnt = countEntranceStrokes();
  win.__marbleEat('SHUF');
  const withEnt = countEntranceStrokes();
  ok(withEnt.n > noEnt.n,
     '★ 入口变化生效时，入口外边缘真的被画了（' + withEnt.n + ' 次 vs 无变化 ' + noEnt.n + ' 次）');

  // 最后一回合要变红、加粗
  win.__marbleClearFx(); win.__marbleEat('L');
  win.__marbleLand(4); win.__marbleLand(4);          // 寿命掉到 1
  ok(M().fx.life === 1, '（前置）入口变化只剩最后一回合');
  let sawRed = false, sawThick = false;
  for (let f = 0; f < 12; f++) {
    run(1);
    drawRec.strokes.length = 0;
    win.__marbleDraw();
    for (const s of drawRec.strokes) {
      if (s.y >= M().mouthY - 3 && s.y <= M().floorY + 3) {
        if (String(s.style).replace(/\s/g, '') === '#ff3b30') sawRed = true;
        if (s.w >= 3) sawThick = true;
      }
    }
  }
  ok(sawRed, '★ 最后一回合入口边缘变红（提醒「下回合就恢复底表」）');
  ok(sawThick, '★ 最后一回合入口边缘加粗（更醒目）');

  // 恢复底表后不再闪
  win.__marbleLand(4);                                // 寿命归 0
  ok(!M().fx.active, '（前置）入口已恢复底表');
  const afterRestore = countEntranceStrokes();
  ok(afterRestore.n <= noEnt.n + 1,
     '★ 恢复底表后入口边缘不再闪（' + afterRestore.n + ' 次 ≈ 无变化 ' + noEnt.n + ' 次）');

  // ---- 换新局：入口整体重置 ----
  reset(51); win.__marbleClearFx();
  win.__marbleEat('L'); win.__marbleEat('STONE'); win.__marbleEat('SHUF');
  ok(M().fx.active, '（前置）场上有入口变化');
  win.__marbleReset(51);
  ok(M().fx.L === 0 && M().fx.R === 0 && M().fx.perm === null &&
     M().fx.sealed.every(v => !v) && M().fx.life === 0,
     '★ 换新局：入口变化全部清空、寿命归 0');

  // ---- 结算真的跟着走：跨回合落桶仍按被改过的数字算 ----
  /* 语义（跟道具一致）：life=ENTRANCE_LIFE 表示「含吃到的那一回合，共 3 个回合生效」。
   *   吃后 life=3 → 第 1 回合生效；回合末 -1 → 2
   *   第 2 回合生效（life=2）→ 回合末 -1 → 1
   *   第 3 回合生效（life=1）→ 回合末 -1 → 0 → 清空
   *   第 4 回合起恢复底表 */
  reset(51); win.__marbleClearFx();
  win.__marbleEat('L');
  const r1st = win.__marbleLand(2);
  ok(r1st.n === 4, '★ 第 1 回合（吃到的这回合）落 2 号桶按「×2」结算（得 4）');
  const r2nd = win.__marbleLand(2);
  ok(r2nd.n === 4, '★ 第 2 回合仍按「×2」结算（得 4，不是底表的 2）');
  const r3rd = win.__marbleLand(2);
  ok(r3rd.n === 4, '★ 第 3 回合（最后一回合）仍按「×2」结算（得 4）');
  ok(!M().fx.L && M().fx.life === 0, '（前置）第 3 回合末寿命归 0 → 入口已恢复底表');
  const r4th = win.__marbleLand(2);
  ok(r4th.n === 2, '★ 第 4 回合恢复底表后落 2 号桶只得 2（确认真的复原了）');

  // ---- 石化跨回合仍然物理弹球 ----
  reset(51); win.__marbleClearFx();
  win.__marbleEat('STONE');
  const si2 = M().fx.sealed.indexOf(true);
  win.__marbleLand(4);                                // 过一回合，水泥筒还在
  ok(M().fx.sealed[si2], '（前置）第 2 回合水泥筒仍封着');
  const s2 = M();
  setBall({ x: s2.fieldL + (si2 + 0.5) * s2.slotW, y: s2.mouthY - 26, vy: 420 });
  run(10);
  const bb2 = M().ball;
  ok(M().state === 'play' && bb2 && bb2.y < s2.mouthY - 4,
     '★ 第 2 回合被封入口照样把球弹回场内（y=' + (bb2 ? bb2.y.toFixed(0) : '—') + '）');

  // ---- 绘制：入口变化的最后一回合（整排桶红圈）不报错 ----
  reset(51); win.__marbleClearFx();
  win.__marbleEat('L'); win.__marbleEat('SHUF');
  let dOk = true, dErr = '';
  try{
    for(let k = 0; k < 4; k++){ run(1); win.__marbleDraw(); win.__marbleLand(4); }
  }catch(e){ dOk = false; dErr = e.message; }
  ok(dOk, '★ 入口变化各寿命阶段（含最后一回合红圈）绘制不报错', dErr);
}

/* ================= 17) 压力：道具全程开启 ================= */
section('17) 压力：每回合都塞道具，连打不卡死 / 数值不坏');
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

/* ================= 17) 地雷外观：黑炸弹 + 白骷髅 ================= */
section('18) ★ 地雷外观：黑色炸弹 + 白骷髅（与其它「彩色圆牌」道具明确区分）');
{
  const meta = win.__marbleItemMeta('MINE');
  const vis = win.__marbleMineVisual();
  const ITEM_R_OF = () => M().ITEM_R;
  ok(meta && meta.shape === 'bomb', '★ 地雷走独立外观 shape=bomb（不再画成彩色圆牌）');
  ok(vis.R > vis.ITEM_R, '★ 画得比判定略大（画 ' + vis.R.toFixed(1) + ' > 判定 ' + vis.ITEM_R +
     '）—— 视觉预警宁可偏大');
  ok(vis.blastR > vis.R * 3, '★ 爆炸半径远大于道具本身（' + vis.blastR + ' vs ' + vis.R.toFixed(1) + '）→ 值得画预警圈');

  // 其它道具仍然是彩色圆牌（没有被误伤）
  const others = ['L', 'R', 'SHUF', 'SPLIT', 'FIRE', 'ICE', 'STONE', 'CLOWN', 'UP1', 'UP2', 'UP3'];
  ok(others.every(k => win.__marbleItemMeta(k).shape === 'plate'),
     '★ 其余 ' + others.length + ' 种道具仍是彩色圆牌（shape=plate）');

  // ---- 真的画出来：黑弹体 + 白骷髅 + 红色预警圈 ----
  reset(41);
  win.__marbleClearItems();
  const mx = M().fieldL + 60, my = M().fieldT + 150;
  win.__marblePutItem('MINE', mx, my);
  resetDrawRec();
  win.__marbleDraw();

  // 弹体：近黑填充（半径 ≈ 道具半径）
  const body = drawRec.fills.filter(f => f.r >= ITEM_R_OF() - 0.01 && f.r <= ITEM_R_OF() + 2.5);
  ok(body.length > 0, '★ 画出了道具大小的圆形弹体（' + body.length + ' 个）');
  /* 弹体是径向渐变（近黑）→ 从渐变的 colorStop 里判断「是不是深色」 */
  const hexOf = c => String(c).replace(/\s/g, '');
  const lum = c => {
    const m = /^#([0-9a-f]{6})$/i.exec(hexOf(c));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return ((n >> 16 & 255) + (n >> 8 & 255) + (n & 255)) / 3;
  };
  const gradBody = body.filter(f => f.style && Array.isArray(f.style.stops) && f.style.stops.length);
  ok(gradBody.length > 0, '★ 弹体用径向渐变画（有 ' + gradBody.length + ' 个渐变填充）');
  const darkest = gradBody.length
    ? Math.min(...gradBody.flatMap(f => f.style.stops.map(s => lum(s.col)).filter(v => v !== null)))
    : 999;
  ok(darkest < 0x60, '★ 弹体是深色/近黑（最暗色阶 ' + (darkest === 999 ? '—' : Math.round(darkest)) + ' < 96）');

  // 骷髅：纯白填充 + 比弹体小的圆（颅骨）
  const white = drawRec.fills.filter(f => String(f.style).replace(/\s/g, '') === '#ffffff' && f.r < ITEM_R_OF());
  ok(white.length > 0, '★ 画出了白色骷髅（白填充 ' + white.length + ' 处，颅骨半径 ' +
     (white[0] ? white[0].r.toFixed(1) : '—') + '）');
  ok(white.every(f => f.r < ITEM_R_OF()), '★ 骷髅在弹体内部（白圆半径都小于弹体）');

  // 眼窝/鼻腔：用近黑挖空
  const holes = drawRec.fills.filter(f => String(f.style).replace(/\s/g, '') === '#0d1015' && f.r < ITEM_R_OF());
  ok(holes.length >= 2, '★ 骷髅有挖空的眼窝/鼻腔（' + holes.length + ' 处）');

  // 预警圈：虚线 + 半径 = MINE_R
  const warn = drawRec.dashes.some(d => Array.isArray(d) && d.length === 2 && d[0] > 0);
  ok(warn, '★ 画了虚线爆炸预警圈（setLineDash 被调用）');
  const ring = drawRec.fills.filter(f => Math.abs(f.r - vis.blastR) < 0.01);
  ok(ring.length === 0, '（说明）预警圈是描边不是填充 —— 填充里不该有它');

  // 地雷不画字形（没有彩色圆牌上的字母）
  const mineTexts = drawRec.texts.filter(t => Math.abs(t.x - mx) < 12 && Math.abs(t.y - my) < 16);
  ok(mineTexts.length === 0, '★ 地雷不再画「✹」字形（改用矢量骷髅）');

  // 对照：普通道具仍然画字形
  win.__marbleClearItems();
  win.__marblePutItem('SPLIT', mx, my);
  resetDrawRec();
  win.__marbleDraw();
  ok(drawRec.texts.some(t => t.txt === 'Y'), '★ 对照：普通道具（分裂 Y）照旧画字形');

  // 最后一回合：地雷的寿命点仍变红（跟其它道具一致）
  win.__marbleClearItems();
  win.__marblePutItem('MINE', mx, my, 1);
  resetDrawRec();
  win.__marbleDraw();
  const redDots = drawRec.fills.filter(f => String(f.style).replace(/\s/g, '') === '#ff3b30');
  ok(redDots.length > 0, '★ 地雷最后一回合：寿命点变红（与其它道具同一套提醒）');

  /* ★ 回归：地雷最后一回合也必须真的「闪」
   *   （踩过的坑：drawMine 内部把 globalAlpha 写死回 1，把调用方的闪烁值冲掉了
   *     → 地雷在最后一回合反而不闪，跟其它道具不一致） */
  win.__marbleClearItems();
  win.__marblePutItem('MINE', mx, my, 1);
  let mineDark = false;
  for (let f = 0; f < 40 && !mineDark; f++) {
    run(1);
    resetDrawRec();
    win.__marbleDraw();
    // 只认「画在弹体附近」的填充：alpha 明显变暗 = 闪烁生效
    if (drawRec.fills.some(x => x.alpha < 0.5 && Math.abs(x.x - mx) < 26 && Math.abs(x.y - my) < 26)) mineDark = true;
  }
  ok(mineDark, '★ 地雷最后一回合会闪烁（globalAlpha 没被内部写死冲掉）');
}

/* ================= 18) 绘制冒烟 ================= */
section('19) 绘制：各种状态下画图都不报错（含道具/旋转炮口/水泥筒/负分桶）');
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
  win.__marbleClearItems(); win.__marblePutItem('MINE', M().fieldL + 50, M().fieldT + 140);
  tryDraw('场上有地雷（黑炸弹 + 白骷髅 + 预警圈）');
  win.__marbleClearItems(); win.__marblePutItem('MINE', M().fieldL + 50, M().fieldT + 140, 1);
  tryDraw('地雷最后一回合（闪烁 + 红圈）');
  win.__marbleClearItems(); win.__marbleSpawnItems(3);
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

/* ================= 17) 炮口方向 == 发射方向 ================= */
section('20) ★ 炮口朝向与发射方向必须一致（曾经画反：往右调角度、炮口却朝左歪）');
{
  reset(1);
  const s0 = M();
  const dirOf = a => {
    reset(1);
    win.__marbleSetAim(a);
    win.__marbleFire(0.6);                       // 直接发射，读取出膛速度方向
    return M().flyers[0];
  };
  const bR = dirOf(0.5), bL = dirOf(-0.5), b0 = dirOf(0);
  ok(bR.vx > 0 && Math.abs(b0.vx) < 1e-9 && bL.vx < 0,
     '★ 出膛方向跟角度走：右 ' + bR.vx.toFixed(0) + ' / 中 ' + b0.vx.toFixed(0) + ' / 左 ' + bL.vx.toFixed(0));
  ok(bR.vy > 0 && bL.vy > 0, '★ 不管朝哪边，都是往下打（vy 恒为正）');

  /* ★ 画出来的炮口：抓 drawCannon 里 translate(cannonX, 74) 之后的 rotate 值，
   *   再按画布规则算出炮管末端（局部 (0,21) → 屏幕 (tx - 21·sinθ, 74 + 21·cosθ)） */
  const muzzleOf = a => {
    reset(1);
    win.__marbleSetAim(a);
    drawRec.frames.length = 0;
    win.__marbleDraw();
    const f = drawRec.frames.filter(r => Math.abs(r.tx - M().cannonX) < 0.6 && Math.abs(r.ty - 74) < 0.6);
    if (!f.length) return null;
    const r = f[0];
    return { rot: r.rot, tipX: r.tx - 21 * Math.sin(r.rot), baseX: r.tx };
  };
  const mR = muzzleOf(0.5), mL = muzzleOf(-0.5);
  ok(mR && mL, '★ 抓到炮身的旋转变换（' + (mR ? mR.rot.toFixed(3) : 'null') + ' rad）');
  ok(mR && Math.abs(mR.rot - -0.5) < 1e-9, '★ 炮身 rotate = -aim（+0.5 → ' + (mR ? mR.rot.toFixed(3) : '?') + '）');
  ok(mR && mL && mR.tipX > mR.baseX + 5 && mL.tipX < mL.baseX - 5,
     '★ 炮口末端与发射方向同侧（右调→末端偏右 ' + (mR ? (mR.tipX - mR.baseX).toFixed(1) : '?') +
     '，左调→偏左 ' + (mL ? (mL.tipX - mL.baseX).toFixed(1) : '?') + '）');
  ok(mR && mL && Math.sign(mR.tipX - mR.baseX) === Math.sign(bR.vx) &&
                 Math.sign(mL.tipX - mL.baseX) === Math.sign(bL.vx),
     '★ 炮口指向与出膛 vx 同号（绘制与物理不打架）');
  ok(s0.AIM_MAX > 0 && Math.abs(win.__marbleSetAim(9)) - s0.AIM_MAX < 1e-9,
     '炮口摆角有上限（AIM_MAX=' + s0.AIM_MAX + ' rad）');
}

/* ================= 18) 撞针弹力分档 ================= */
section('21) ★ 撞针 4 档弹力：颜色区分 · 每局分布随机 · 超弹把球顶回上方');
{
  reset(1);
  const s = M();
  const K = s.PEG_KINDS;
  ok(K.length === 4, '★ 撞针分 4 档（' + K.map(k => k.name).join('/') + '）');
  ok(K[0].rest < K[1].rest && K[1].rest < K[2].rest && K[2].rest < K[3].rest,
     '★ 弹力递增：' + K.map(k => k.rest.toFixed(2)).join(' < '));
  ok(K[0].rest < 1 && K[3].rest > 1, '★ 软钉泄能(<1)、超弹加能(>1)');
  ok(s.pegs.every(p => p.k >= 0 && p.k <= 3 && Math.abs(p.rest - K[p.k].rest) < 1e-9),
     '★ 每颗钉都带档位和对应恢复系数（' + s.pegs.length + ' 颗）');

  // 每局分布随机：30 个种子的档位分布要足够分散
  const sigs = new Set();
  let kindsPerRun = [];
  for (let sd = 1; sd <= 30; sd++) {
    reset(sd * 13 + 5);
    sigs.add(M().pegDist.join('/'));
    kindsPerRun.push(M().pegDist.filter(v => v > 0).length);
  }
  ok(sigs.size >= 20, '★ 每局的撞针分布都不一样（30 局出现 ' + sigs.size + ' 种分布）');
  ok(Math.min.apply(null, kindsPerRun) >= 3,
     '★ 每局至少 3 种撞针同场（最少 ' + Math.min.apply(null, kindsPerRun) + ' 种）');

  /* 权重有上限 → 不会 roll 出「全是软钉」（球一路直坠）或「全是超弹」（飞满 14s 兜底）的极端板子。
   * ★ 注意断言的是「权重」：实际钉阵还经过纵深偏置（上方偏高弹），某一档会被再放大一截，
   *   所以下面再单独给实际占比留一道宽松的兜底。 */
  let wWorst = 0;
  for (let sd = 1; sd <= 60; sd++) {
    reset(sd * 7 + 3);
    M().pegMix.forEach((v, i) => { wWorst = Math.max(wWorst, v - M().PEG_CAP[i]); });
  }
  ok(wWorst <= 1e-9, '★ 权重都不超上限（最大超出 ' + wWorst.toExponential(1) + '，上限 ' + M().PEG_CAP.join('/') + '）');

  let rMax = 0, rAt = '';
  for (let sd = 1; sd <= 60; sd++) {
    reset(sd * 7 + 3);
    const d = M().pegDist, tot = d.reduce((a, b) => a + b, 0);
    d.forEach((v, i) => { if (v / tot > rMax) { rMax = v / tot; rAt = K[i].name; } });
  }
  ok(rMax <= 0.65, '★ 实际钉阵里没有哪一档一家独大（最大 ' + rAt + ' ' + (rMax * 100).toFixed(1) + '%）');
  ok(M().pegMix.reduce((a, b) => a + b, 0) > 0.999, '本局权重归一化（和 = ' + M().pegMix.reduce((a, b) => a + b, 0).toFixed(6) + '）');

  /* 物理：同一高度自由落体砸同一颗钉，档位越高弹得越高 */
  const bounceV = mix => {
    reset(1);
    win.__marblePegMix(mix, 0);
    const st = M();
    const p = st.pegs.find(q => q.y > st.fieldT + 70 &&
      !st.pegs.some(o => o !== q && Math.hypot(o.x - q.x, o.y - q.y) < 46 && o.y < q.y));
    setBall({ x: p.x, y: p.y - 34, vx: 0, vy: 0 });
    for (let f = 0; f < 60; f++) {
      perfNow += 16; step(DT);
      const b = M().ball;
      if (!b) return -1;
      if (b.vy < 0) return -b.vy;
    }
    return -1;
  };
  const vS = bounceV([1, 0, 0, 0]), vM = bounceV([0, 1, 0, 0]),
        vP = bounceV([0, 0, 1, 0]), vU = bounceV([0, 0, 0, 1]);
  ok(vS > 0 && vM > 0 && vP > 0 && vU > 0, '（前置）四档都能测到反弹（' + [vS, vM, vP, vU].map(v => v.toFixed(0)).join('/') + '）');
  ok(vS < vM && vM < vP && vP < vU,
     '★ 同样落下 → 弹起速度 软<' + '普<弹<超弹（' + [vS, vM, vP, vU].map(v => v.toFixed(0)).join(' < ') + '）');
  ok(vU > 0.9 * Math.sqrt(2 * s.G * 22.5), '★ 超弹几乎不掉能量（弹起 ' + vU.toFixed(0) + ' vs 落下 ' + Math.sqrt(2 * s.G * 22.5).toFixed(0) + '）');

  /* ★ 超弹钉能把球顶回上方：从 60 高处自由落体砸下去 → 反弹后能往上飞回一大截 */
  reset(1); win.__marblePegMix([0, 0, 0, 1], 0);
  const st2 = M();
  const pu = st2.pegs.find(q => q.y > st2.fieldT + 130 &&
    !st2.pegs.some(o => o !== q && o.y < q.y && q.y - o.y < 62 && Math.abs(o.x - q.x) < 16));
  setBall({ x: pu.x, y: pu.y - 60, vx: 0, vy: 0 });
  let upV = 0, topY = 1e9, bounced = false;
  for (let f = 0; f < 90; f++) {
    perfNow += 16; step(DT);
    const b = M().ball; if (!b) break;
    if (b.vy < 0) { bounced = true; if (b.vy < upV) upV = b.vy; topY = Math.min(topY, b.y); }
    else if (bounced) break;             // 弹到最高点开始下落 → 收工
  }
  ok(upV < -150, '★ 球砸在超弹钉上被顶回上方（反弹 vy=' + upV.toFixed(0) + '，最高回到 y=' + topY.toFixed(0) + '）');

  // 速度封顶：超弹加能也不会快到穿钉（820/120 = 6.8 < r球+r钉 11.5）
  reset(1); win.__marblePegMix([0, 0, 0, 1], 0);
  setBall({ x: M().cannonX, y: M().fieldT + 20, vx: 300, vy: 200 });
  let vmax = 0;
  for (let f = 0; f < 200 && M().state === 'play'; f++) {
    perfNow += 16; step(DT);
    const b = M().ball; if (!b) break;
    vmax = Math.max(vmax, Math.hypot(b.vx, b.vy));
  }
  ok(vmax <= M().SPD_CAP + 1, '★ 速度封顶生效（峰值 ' + vmax.toFixed(0) + ' ≤ ' + M().SPD_CAP + '）');
  ok(M().SPD_CAP / 120 < M().RP + M().RB, '★ 封顶后一子步位移 ' + (M().SPD_CAP / 120).toFixed(1) + ' < 球钉半径和 ' + (M().RP + M().RB) + '（不会穿钉）');
}

/* ================= 19) 看门狗 C：垂直弹跳死循环 ================= */
section('22) ★ 看门狗 C：撞顶会清掉旧计时器，靠「整秒位移」把垂直弹跳救出来');
{
  reset(5);
  win.__marblePegMix([0, 0, 1, 0], 0);          // 全是弹钉：最容易「天花板↔钉顶」垂直弹跳
  const st = M();
  const top = st.pegs.reduce((a, b) => (a.y < b.y ? a : b));
  ok(top.rest > 0.9, '（前置）这一板全是弹钉（rest=' + top.rest + '）');
  setBall({ x: top.x, y: top.y - (st.RP + st.RB) - 0.4, vx: 0, vy: -300 });
  run(Math.round(0.9 / DT));
  ok(M().ball && Math.abs(M().ball.vx) < 10, '（前置）0.9s 时还在原地垂直弹（vx=' + (M().ball ? M().ball.vx.toFixed(1) : 'null') + '）');
  run(Math.round(0.6 / DT));
  const b = M().ball;
  ok(b && Math.abs(b.vx) > 10, '★ 1.5s 内被踢出垂直死循环（vx=' + (b ? b.vx.toFixed(1) : 'null') + '）');
}

/* ================= 20) ★ 容器尺寸兜底（黑屏事故） ================= */
section('23) ★ 布局兜底：容器尺寸为 0 / 太矮，都不能变成「一片黑只剩按钮」');
{
  const sg = M();
  ok(sg.MIN_STAGE_H === 320, '最小画布高度常数 MIN_STAGE_H=320（' + sg.MIN_STAGE_H + '）');
  ok(sg.squeezed === false, '（前置）默认尺寸下没走兜底');

  // 容器太矮（预览面板的小 iframe）：硬撑一块场地 + 放开滚动，别把画布压成一条缝
  win.__marbleSetStage(390, 200);
  ok(M().squeezed === true, '★ 容器只有 200px 高 → 判定为太矮');
  ok(stageEl.style.height === '320px', '★ 画布区域硬撑到 320px（实际 ' + JSON.stringify(stageEl.style.height) + '）');
  ok(sandbox.document.documentElement.classList.contains('squeezed'), '★ <html> 挂上 squeezed（CSS 里放开滚动）');
  ok(M().W === sg.W && M().H === sg.H, '逻辑尺寸不受影响（' + M().W + '×' + M().H + '）');

  // 恢复正常尺寸：撤掉硬撑
  win.__marbleSetStage(390, 700);
  ok(M().squeezed === false, '★ 高度够用 → 兜底撤销');
  ok(!stageEl.style.height, '★ 硬撑的高度清掉（' + JSON.stringify(stageEl.style.height) + '）');
  ok(!sandbox.document.documentElement.classList.contains('squeezed'), '★ <html> 的 squeezed 也摘掉');

  // 尺寸为 0（首帧拿不到）：用窗口尺寸估算，先画出来 + 排重试，绝不 return 掉
  win.__marbleSetStage(390, 0);
  ok(M().W > 0 && M().H > 0 && sg.W > 0, '★ stage 高 0 时也照常画（逻辑 ' + M().W + '×' + M().H + '）');
  ok(M().pegs.length > 20, '★ 钉场照常生成（' + M().pegs.length + ' 颗，没有因为尺寸 0 就空场）');
  ok(typeof M().cannonX === 'number' && M().cannonX > 0, '★ 炮台坐标有效（cannonX=' + M().cannonX + '）');
  win.__marbleSetStage(390, 700);
  ok(M().squeezed === false, '（复位）恢复常规尺寸');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
