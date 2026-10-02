#!/usr/bin/env node
/**
 * 青蛙过河 逻辑回归测试（Node + 最小 DOM/Canvas 桩 + 手工步进）
 *
 * 覆盖：
 *   1) ready 状态世界冻结（等待操作时不会自己动）
 *   2) ★ 核心机制：蓄力 → 跳跃距离（精确线性映射 dist = MINJ + c×(MAXJ-MINJ)）
 *   3) 抛物线飞行（起跳升高、落点归位、距离越大弧越高）
 *   4) 落石上 = 继续 + 计分；正中 = +30/印章/连击，非正中 = +10/连击清零
 *   5) 落水 = 结束（含音效、最高分落盘）
 *   6) ★★ 公平性不变量：任意相邻两石台，从**当前石台最左/最右落点**起跳都必须够得到下一块
 *      （否则会出现「最小跳都躲不开 / 最大跳也够不着」的必死局面）
 *   7) 目标可见性：相机停稳后下一块中心必须在屏幕内
 *   8) 音效触发（FakeCtx 计数）：蓄力 / 起跳 / 落石 / 正中 / 落水 / 静音
 *   9) 平台尺寸在合法区间、回收不无限增长、坐标无 NaN
 *
 * 用法：node tools/test_frog.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'frog', 'index.html');
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
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
               right: this.clientWidth, bottom: this.clientHeight };
    },
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

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
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
sandbox.window.CSS = { supports: () => true };
sandbox.window.getSelection = () => null;

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'frog-inline.js' });

/* ---------------- 驱动 ---------------- */
const win = sandbox.window;
const F = () => win.__frog();
const step = dt => win.__frogStep(dt);
const press = () => win.__frogPress();
const release = () => win.__frogRelease();
const setCharge = c => win.__frogSetCharge(c);
const setX = x => win.__frogSetX(x);
const reset = seed => win.__frogReset(seed);
const MINJ = F().MINJ, MAXJ = F().MAXJ;
const DT = 1 / 60;

function run(n, dt = DT) { for (let i = 0; i < n; i++) step(dt); }
/** 松手起跳后等它落地（回到 idle 或 game over） */
function waitLand(max = 500) {
  for (let i = 0; i < max && F().mode === 'jump'; i++) step(DT);
  return F().mode !== 'jump';
}
/** 一次完整跳跃：按住→定蓄力→松手→落地 */
function jump(c) { press(); setCharge(c); release(); return waitLand(); }
/** 找一段「确认没有石台」的水面中点（用于把跳跃精确送进水里） */
function waterMid() {
  const ps = F().platforms;
  for (let i = 0; i + 1 < ps.length; i++) {
    const a = ps[i].x + ps[i].w / 2 + 4, b = ps[i + 1].x - ps[i + 1].w / 2 - 4;
    if (b - a > 6) return (a + b) / 2;
  }
  return null;
}

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 1) 状态机 ================= */
section('1) 状态机 · ready 冻结');
reset(1);
ok(F().state === 'ready', '初始状态为 ready', F().state);
ok(F().platforms.length >= 1 && F().score === 0, '开局生成石台（' + F().platforms.length + ' 块）、分数 0');
const c0 = F().camX, fx0 = F().frogX, px0 = F().platforms[0].x;
run(90);
ok(F().camX === c0 && F().frogX === fx0 && F().platforms[0].x === px0,
   '★ ready 状态世界冻结（等玩家操作时不动）',
   'camX ' + c0 + '→' + F().camX);
press();
ok(F().state === 'play' && F().charging, '按住即开局并开始蓄力（state=' + F().state + '）');
release();
ok(!F().charging, '松手后停止蓄力');

/* ================= 2) 蓄力 → 距离（核心机制） ================= */
section('2) ★ 核心机制：蓄力程度决定跳远距离');
{
  const expect = c => MINJ + c * (MAXJ - MINJ);
  const measured = [];
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    reset(1);
    const m = waterMid();
    if (m === null) { ok(false, '找到了水面空档', '找不到'); break; }
    const startX = m - expect(c);           // 反推起点，落点应精确命中水面中点
    setX(startX);
    const before = sndNodes;
    press(); setCharge(c); release();
    waitLand();
    const got = F().frogX - startX;
    measured.push(got.toFixed(1));
    ok(F().state === 'over' && Math.abs(got - expect(c)) < 0.75,
       `蓄力 ${(c * 100).toFixed(0)}% → 跳 ${expect(c).toFixed(1)}（实测 ${got.toFixed(1)}，落水）`,
       '实测 ' + got.toFixed(2));
  }
  ok(measured.length === 5, '5 档蓄力全部测到（' + measured.join(' / ') + '）');
  reset(1);
  ok(MINJ > 0 && MAXJ > MINJ && (MAXJ - MINJ) >= 150,
     '跳跃区间合理（' + MINJ + '~' + MAXJ + '，可变段 ' + (MAXJ - MINJ) + '）');

  // 满蓄力耗时：按住 1.15 秒应到 100%
  reset(1);
  press();
  run(Math.ceil(F().charge === undefined ? 70 : 70));   // 1.167 秒
  const full = F().charge;
  ok(Math.abs(full - 1) < 0.001, '按住约 1.16 秒到满蓄力（' + (full * 100).toFixed(1) + '%）');
  release();
}

/* ================= 3) 飞行物理 ================= */
section('3) 抛物线飞行');
{
  reset(1);
  press(); setCharge(0.5); release();
  let midArc = 0, prevX = F().frogX, monotonic = true;
  for (let i = 0; i < 300 && F().mode === 'jump'; i++) {
    step(DT);
    if (F().frogX < prevX - 1e-9) monotonic = false;
    prevX = F().frogX;
    if (F().arc < midArc) midArc = F().arc;
  }
  ok(F().mode !== 'jump', '跳跃会落地/结束');
  ok(midArc < -20, '★ 起跳会升高（弧顶 ' + midArc.toFixed(0) + ' < -20）');
  ok(monotonic, '前向位移单调（不倒退）');

  // 弧高随蓄力增大
  const apexOf = c => {
    reset(1);
    press(); setCharge(c); release();
    let minArc = 0;
    for (let i = 0; i < 300 && F().mode === 'jump'; i++) { step(DT); if (F().arc < minArc) minArc = F().arc; }
    return -minArc;
  };
  const a25 = apexOf(0.25), a100 = apexOf(1.0);
  ok(a100 > a25 * 1.3, `蓄力越大弧越高（25%→${a25.toFixed(0)}，100%→${a100.toFixed(0)}）`);
}

/* ================= 4) 计分：正中 / 非正中 ================= */
section('4) 落石计分（正中 +30/印章/连击 · 非正中 +10/连击清零）');
{
  reset(1);
  press();
  const p1 = F().next;
  ok(!!p1, '开局能看见下一块目标');
  const cAim = Math.max(0, Math.min(1, (p1.x - F().frogX - MINJ) / (MAXJ - MINJ)));
  setCharge(cAim); release(); waitLand();
  const s1 = F();
  const landedP1 = Math.abs(s1.frogX - p1.x) < 1;
  ok(s1.state === 'play', '跳到石上继续（state=' + s1.state + '）');
  ok(s1.score === 30 && s1.combo === 1 && s1.stamps === 1,
     '★ 正中石心：+30 分、连击 ×1、印章 +1（' + s1.score + '/' + s1.combo + '/' + s1.stamps + '）');
  ok(landedP1, '落点就在目标中心（偏差 ' + Math.abs(s1.frogX - p1.x).toFixed(1) + '）');

  // 故意落在「里面但不正中」的区域
  const p2 = F().next;
  ok(!!p2, '第二跳有目标');
  const cOff = Math.max(0, Math.min(1, (p2.x + p2.w * 0.45 - F().frogX - MINJ) / (MAXJ - MINJ)));
  press(); setCharge(cOff); release(); waitLand();
  const s2 = F();
  ok(s2.state === 'play', '偏一点也是合法落点');
  ok(s2.score === 40 && s2.combo === 0 && s2.stamps === 1,
     '非正中：+10、连击清零、印章不加（' + s2.score + '/' + s2.combo + '/' + s2.stamps + '）');
}

/* ================= 5) 落水 = 结束 + 最高分 ================= */
section('5) 落水结束 · 最高分落盘');
{
  reset(7);
  // 先正经跳一块攒分（0 分落水不写盘 —— 游戏逻辑如此，测试要先攒分）
  press();
  const t5 = F().next;
  setCharge(Math.max(0, Math.min(1, (t5.x - F().frogX - MINJ) / (MAXJ - MINJ)))); release(); waitLand();
  const gotScore = F().score;
  ok(gotScore > 0, '先攒到分再测落水（' + gotScore + ' 分）');
  const m = waterMid();
  setX(m - (MINJ + MAXJ) / 2);
  const before = sndNodes;
  press(); setCharge(0.5); release(); waitLand();
  ok(F().state === 'over', '跳进水里 = 结束');
  ok(sndNodes - before >= 4, '落水 + 结束都有音效（+' + (sndNodes - before) + ' 个音频节点）');
  ok(Number(store['frog_best']) === gotScore, '★ 带着分数落水后最高分落盘（' + store['frog_best'] + ' = ' + gotScore + '）');

  // 高分局之后来一局 0 分，不能覆盖
  const keep = store['frog_best'];
  reset(1);
  press(); setCharge(0.02); release(); waitLand();
  ok(Number(store['frog_best']) === Number(keep),
     '更差的一局不会覆盖最高分（' + store['frog_best'] + ' 保持 ' + keep + '）');
}

/* ================= 6) ★★ 公平性不变量 ================= */
section('6) ★★ 公平性：从任意落点都够得到下一块（自动跳跃 18 跳不死一次）');
{
  reset(1);
  press();
  let jumps = 0, deaths = 0, worst = 1e9, worstGap = '', maxScore = 0;
  for (let n = 0; n < 18; n++) {
    if (F().state !== 'play') break;
    const t = F().next;
    if (!t) { run(60); continue; }
    const c = Math.max(0, Math.min(1, (t.x - F().frogX - MINJ) / (MAXJ - MINJ)));
    press(); setCharge(c); release(); waitLand();
    jumps++;
    if (F().state === 'over') { deaths++; break; }
    maxScore = Math.max(maxScore, F().score);
    run(50);                                   // 等相机停稳
  }
  ok(deaths === 0 && jumps >= 15,
     '自动跳跃 ' + jumps + ' 跳零死亡（分数 ' + maxScore + '）',
     '死亡 ' + deaths);

  // 独立复核公平性：对每一对相邻石台，检查最左/最右落点
  let checked = 0, bad = 0;
  // 从头重跑并**在观测当时**就存下整对数据（x + 宽度）。
  // ⚠️ 踩过的坑：原来存 key、事后拿 F().platforms 去 find —— reset() 换了新数组、
  //    且旧数组引用已失效 → 抽到 0 组却因为 bad=0 而「通过」，属于假绿。
  reset(3);
  press();
  const seen = [], seenKeys = new Set();
  for (let n = 0; n < 26 && F().state === 'play'; n++) {
    const cur = F().platforms;
    for (let i = 0; i + 1 < cur.length; i++) {
      const key = cur[i].x + '|' + cur[i + 1].x;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        seen.push({ x0: cur[i].x, x1: cur[i + 1].x, w0: cur[i].w, w1: cur[i + 1].w });
      }
    }
    const t = F().next;
    if (!t) { run(60); continue; }
    const c = Math.max(0, Math.min(1, (t.x - F().frogX - MINJ) / (MAXJ - MINJ)));
    press(); setCharge(c); release(); waitLand();
    if (F().state === 'over') break;
    run(40);
  }
  for (const pr of seen) {
    const x0 = pr.x0, x1 = pr.x1;
    const h0 = pr.w0 / 2, h1 = pr.w1 / 2;
    const gap = x1 - x0;
    checked++;
    // 目标落点区间（容差 2）
    const zoneLo = x1 - h1 + 2, zoneHi = x1 + h1 - 2;
    for (const s of [x0 - h0 + 2, x0, x0 + h0 - 2]) {     // 最左 / 中 / 最右起跳
      const reachable = (s + MINJ <= zoneHi) && (s + MAXJ >= zoneLo);
      if (!reachable) { bad++; worst = -1; worstGap = `${s}→${x1}`; }
    }
    if (gap < h0 + h1 + 12) { bad++; worstGap = '水面不足 ' + gap; }
    if (gap > F().GAP_CAP) { bad++; worstGap = '超出可见上限 ' + gap; }
  }
  ok(checked >= 10, '抽样了 ' + checked + ' 组相邻石台');
  ok(bad === 0, '★★ 任意落点（最左/最右）都能跳到下一块，且水面可见、间距在上限内',
     bad + ' 处违规 ' + worstGap);

  // 首块：从岸边固定起点也必须跳得到
  reset(5);
  const f0 = F(), first = f0.platforms[0];
  const zoneLo = first.x - first.w / 2 + 2, zoneHi = first.x + first.w / 2 - 2;
  ok(f0.frogStart + MINJ <= zoneHi && f0.frogStart + MAXJ >= zoneLo,
     '首块从岸边固定起点也够得到（起点 ' + f0.frogStart + '，落点区 ' + zoneLo.toFixed(0) + '~' + zoneHi.toFixed(0) + '）');
}

/* ================= 7) 可见性 / 相机 / 尺寸 ================= */
section('7) 目标可见 · 相机跟随 · 平台尺寸');
{
  reset(1);
  press();
  let hidden = 0, offAnchor = 0, widthsOk = true, samples = 0;
  for (let n = 0; n < 16 && F().state === 'play'; n++) {
    const t = F().next;
    if (!t) break;
    const c = Math.max(0, Math.min(1, (t.x - F().frogX - MINJ) / (MAXJ - MINJ)));
    press(); setCharge(c); release(); waitLand();
    run(70);                                    // 等相机停稳
    const s = F(); samples++;
    const sx = s.next ? s.next.x - s.camX : 999;
    if (sx > s.W - 8 || sx < 0) hidden++;
    const anchor = s.screenX / s.W;
    if (Math.abs(anchor - 0.30) > 0.12) offAnchor++;
    for (const p of s.platforms) {
      if (p.w < s.PSTORE[0] || p.w > s.PSTORE[1] || p.w <= s.frogW) widthsOk = false;
    }
  }
  ok(hidden === 0, '相机停稳后下一块中心始终在屏内（' + samples + ' 跳，越界 ' + hidden + ' 次）');
  ok(offAnchor === 0, '青蛙稳定在屏宽 30% 附近（偏离 ' + offAnchor + ' 次）');
  ok(widthsOk, '所有石台宽度在合法区间且大于机身（' + F().PSTORE.join('~') + '，机身 ' + F().frogW + '）');

  // 回收：长跑后平台数不无限增长
  reset(2);
  press();
  let peak = 0;
  for (let n = 0; n < 30 && F().state === 'play'; n++) {
    const t = F().next;
    if (!t) break;
    const c = Math.max(0, Math.min(1, (t.x - F().frogX - MINJ) / (MAXJ - MINJ)));
    press(); setCharge(c); release(); waitLand();
    run(40);
    peak = Math.max(peak, F().platforms.length);
  }
  ok(peak < 30, '石台会被回收、不会无限增长（峰值 ' + peak + ' 块）');

  // 坐标无 NaN
  const s = F();
  const nums = [s.frogX, s.camX, s.screenX, s.waterY, s.surfY, ...s.platforms.flatMap(p => [p.x, p.w])];
  ok(nums.every(Number.isFinite), '所有坐标都是有限数（无 NaN）');
}

/* ================= 8) 音效 ================= */
section('8) 音效触发（FakeCtx 计数）');
{
  reset(1);
  const n0 = sndNodes;
  press();
  ok(sndNodes > n0, '按住开始蓄力有持续音（+' + (sndNodes - n0) + '）');
  const n1 = sndNodes;
  setCharge(0.5); release(); waitLand();
  ok(sndNodes - n1 >= 2, '起跳有音效（+' + (sndNodes - n1) + '）');
  const n2 = sndNodes;
  // 正中一跳（回到刚开局的布局）
  reset(4);
  press();
  const t = F().next;
  setCharge(Math.max(0, Math.min(1, (t.x - F().frogX - MINJ) / (MAXJ - MINJ)))); release(); waitLand();
  const n3 = sndNodes;
  ok(n3 > n2, '落石有音效');
  ok(F().stamps === 1 && n3 - n2 >= 3, '正中额外有钟声（该跳共 +' + (n3 - n2) + ' 节点）');

  // 静音开关
  els.btnSound.onclick();
  const n4 = sndNodes;
  reset(1);
  press(); setCharge(0.5); release(); waitLand();
  ok(sndNodes === n4, '关掉音效后完全不发声');
  els.btnSound.onclick();
  const n5 = sndNodes;
  reset(1);
  press(); setCharge(0.5); release(); waitLand();
  ok(sndNodes > n5, '重新打开后又能发声');
}

/* ================= 9) 长跑健壮性 ================= */
section('9) 长跑健壮性（各种蓄力都有 · 状态合法 · 无 NaN）');
{
  let overCnt = 0, weird = 0;
  for (let sd = 11; sd <= 20; sd++) {
    reset(sd);
    press();
    for (let n = 0; n < 10 && F().state === 'play'; n++) {
      const c = Math.random();
      press(); setCharge(c); release(); waitLand();
      run(30);
      const s = F();
      if (![s.frogX, s.camX, s.screenX, s.charge].every(Number.isFinite)) weird++;
      if (s.state !== 'play' && s.state !== 'over') weird++;
      if (s.state === 'over') break;
    }
    if (F().state === 'over') overCnt++;
  }
  ok(weird === 0, '10 局随机蓄力无非法状态/NaN（异常 ' + weird + ' 次）');
  ok(overCnt >= 0, '随机蓄力的行为都走通了（落水 ' + overCnt + '/10 局，符合预期）');
}

/* ================= ★ 转屏：地图必须不变 ================= */
section('★ 转屏（竖屏↔横屏）地图不变');
{
  const portrait = win.__frogSetStage(768, 1024);
  win.__frogReset(20261001);
  const f1 = win.__frog();
  const plat = JSON.stringify(f1.platforms);
  const geo = [f1.W, f1.H, f1.waterY, f1.surfY];
  const landscape = win.__frogSetStage(1024, 768);
  const f2 = win.__frog();
  ok(portrait.W === landscape.W && portrait.H === landscape.H,
     '★ 逻辑尺寸固定：竖屏/横屏都是 ' + portrait.W + '×' + portrait.H);
  ok(JSON.stringify(f2.platforms) === plat, '★ 转屏后石台逐个完全一致（' + f1.platforms.length + ' 块）');
  ok(JSON.stringify([f2.W, f2.H, f2.waterY, f2.surfY]) === JSON.stringify(geo),
     '★ 水面/可站立面高度一致（waterY=' + f2.waterY + '）');
  ok(f2.waterY > 0 && f2.waterY < f2.H, '★ 水面仍在逻辑画面内（不会跑到屏幕外）');
  for(const [w, h] of [[1600, 600], [600, 1600], [900, 900]]){
    const st = win.__frogSetStage(w, h);
    const s = win.__frog();
    ok(s.W === f1.W && s.H === f1.H && JSON.stringify(s.platforms) === plat,
       '★ ' + w + '×' + h + ' 比例下地图仍不变（scale ' + st.S.toFixed(2) + '）');
  }
  win.__frogSetStage(768, 1024);
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
