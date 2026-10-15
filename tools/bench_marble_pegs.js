#!/usr/bin/env node
/**
 * 弹珠乐园 · 撞针弹力实验台（不是回归测试，是用来调参的）
 *
 * 问题：这个游戏大部分时间球是往下走的，换上「分档弹力」的撞针后，
 *       球弹回上方区域的活动时间到底有没有变多？
 *
 * 做法：把 4 档撞针的权重 / 纵深偏置当成变量，跑几百发真实物理，统计：
 *   - flight  单发平均飞行时长（秒）
 *   - upper%  飞行过程中待在「上半场」（y < 场地竖直中点）的帧数占比
 *   - 回上次数 平均每一发「从下方穿回上方」的次数（弹回上方的活跃度）
 *   - 撞钉     平均撞钉次数
 *   - 超时     撞到 14s 兜底强制落桶的发数（越少越好）
 *
 * 用法：node tools/bench_marble_pegs.js [每档发数]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'web', 'marble', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 最小 DOM/Canvas 桩（bench 不需要音效计数） ---------------- */
const gradient = { addColorStop() {} };
const mkCtx = () => new Proxy({}, {
  get(t, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
function mkEl(tag) {
  const set = new Set();
  return {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, textContent: '', className: '',
    children: [], onclick: null, clientWidth: 390, clientHeight: 700, width: 0, height: 0,
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) },
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { return c; }, removeChild(c) { return c; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700 }; },
    select() {}, setSelectionRange() {}, focus() {}, blur() {},
  };
}
const els = {};
const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx(); els.cv = cvEl;
const stageEl = mkEl('div'); els.stage = stageEl;

let perfNow = 1000;
const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => perfNow },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  document: {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl, addEventListener() {}, documentElement: { scrollHeight: 700 }, body: mkEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
  },
  navigator: { userAgent: 'node-bench' }, location: { search: '' },
};
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 390; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2;
sandbox.window.AudioContext = null;          // 不发声，省时间
sandbox.window.isSecureContext = false;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'marble-inline.js' });

const win = sandbox.window;
const M = () => win.__marble();
const DT = 1 / 60;
const N = parseInt(process.argv[2] || '180', 10);       // 每个配置打多少发

/** 打一发，统计「上半场停留 / 弹回上方次数」等 */
function shootOnce(charge) {
  win.__marbleClearItems();
  win.__marbleSetAim(0);
  win.__marbleFire(charge);
  const s = M();
  const midY = s.fieldT + (s.mouthY - s.fieldT) * 0.5;   // 上半场分界线
  let frames = 0, upper = 0, back = 0, above = false, maxT = 0;
  while (M().state === 'play' && frames < 1200) {
    win.__marbleClearItems();                            // ★ 排除道具干扰，只看撞针弹力
    perfNow += 16; win.__marbleStep(DT); frames++;
    const b = M().ball;
    if (!b) break;
    maxT = Math.max(maxT, b.flightT);
    const isUp = b.y < midY;
    if (isUp) upper++;
    if (isUp && !above) back++;                          // 从下方穿回上方 → 记一次
    above = isUp;
  }
  const st = M();
  return { t: maxT, upperFrac: frames ? upper / frames : 0, back, hits: st.pegHits, timeout: maxT >= st.FLIGHT_CAP - 1e-6 };
}

function runCfg(label, mix, tilt) {
  let t = 0, uf = 0, back = 0, hits = 0, to = 0, n = 0, dist = [0, 0, 0, 0];
  let mx = 0, slow = 0; const ts = [];
  const seeds = Math.ceil(N / 3);
  for (let s = 1; s <= seeds; s++) {
    win.__marbleReset(s * 7 + 1);
    if (mix || tilt !== undefined) win.__marblePegMix(mix, tilt);
    const d = M().pegDist; for (let i = 0; i < 4; i++) dist[i] += d[i];
    for (const c of [0.35, 0.7, 1.0]) {
      const r = shootOnce(c);
      t += r.t; uf += r.upperFrac; back += r.back; hits += r.hits; if (r.timeout) to++;
      mx = Math.max(mx, r.t); if (r.t > 8) slow++; ts.push(r.t);
      n++;
    }
  }
  ts.sort((a, b) => a - b);
  return {
    label, n,
    flight: t / n,
    p95: ts[Math.floor(ts.length * 0.95)] || 0,
    mx, slow,
    upper: uf / n * 100,
    upperSec: (t / n) * (uf / n),
    back: back / n,
    hits: hits / n,
    to,
    dist: dist.map(v => Math.round(v / seeds)),
  };
}

/* 也可以只跑指定配置：node bench_marble_pegs.js 240 "标签|0.2,0.25,0.33,0.22|0" ...
 * mix 写 "-" 表示「用游戏自己 roll 出来的随机分布」；tilt 写 "-" 表示不覆盖。 */
const custom = process.argv.slice(3).map(a => {
  const [label, mix, tilt] = a.split('|');
  return runCfg(label,
    mix === '-' ? undefined : mix.split(',').map(Number),
    tilt === '-' ? undefined : parseFloat(tilt));
});

const rows = custom.length ? custom : [
  runCfg('旧版：全部普钉 0.74', [0, 1, 0, 0], 0),
  runCfg('随机·下偏弹 tilt+0.55', undefined, undefined),
  runCfg('随机·不偏置 tilt 0', undefined, 0),
  runCfg('随机·上偏弹 tilt-0.55', undefined, -0.55),
  runCfg('均匀 25/25/25/25', [1, 1, 1, 1], 0),
  runCfg('偏弹 15/20/30/35', [0.15, 0.20, 0.30, 0.35], 0),
  runCfg('偏弹 10/20/35/35', [0.10, 0.20, 0.35, 0.35], 0),
  runCfg('偏软 30/30/22/18', [0.30, 0.30, 0.22, 0.18], 0),
  runCfg('极端：全部超弹 1.10', [0, 0, 0, 1], 0),
  runCfg('极端：全部软钉 0.46', [1, 0, 0, 0], 0),
];

console.log('\n每档 ' + N + ' 发（无道具、炮口 0°、力量 35%/70%/100%）\n');
console.log('配置                          飞行s   p95s  最慢s  上半场%  上方秒  回上次数  撞钉  >8s  超时  软/普/弹/超');
console.log('-'.repeat(113));
for (const r of rows) {
  console.log(
    r.label.padEnd(28, ' ') +
    r.flight.toFixed(2).padStart(6) +
    r.p95.toFixed(2).padStart(7) +
    r.mx.toFixed(2).padStart(7) +
    r.upper.toFixed(1).padStart(8) + '%' +
    r.upperSec.toFixed(2).padStart(7) + 's' +
    r.back.toFixed(2).padStart(9) +
    r.hits.toFixed(1).padStart(7) +
    String(r.slow).padStart(5) +
    String(r.to).padStart(6) + '   ' +
    r.dist.join('/'));
}
console.log('');
