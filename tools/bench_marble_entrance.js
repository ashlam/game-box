#!/usr/bin/env node
/**
 * 弹珠乐园 · 入口变化寿命实验台（判断平衡，不是回归测试）
 *
 * 背景：用户要求「入口桶的变化（错位等）也保持 3 回合」。
 * 担心的点：
 *   1) Left/Right 的倍率会**跨回合叠加**吗？（其实不会：层数不涨，只是活得久）
 *   2) 石化封桶以前一回合最多 2 个、回合末就复原；现在保持 3 回合 → 会累积。
 *      如果累积到把 9 个桶封掉一大半，球到处被弹回来，几乎没法得分。
 *   3) 整体「每回合平均得分」会不会因此崩掉或暴涨？
 *
 * 做法：模拟一局局真实回合。每回合按概率吃到一种「入口变化」道具
 *       （L / R / SHUF / STONE），然后真实物理发球打完，统计每回合得分与封桶数。
 *
 * 用法：node tools/bench_marble_entrance.js [局数] [每回合吃入口道具的概率]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'web', 'marble', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

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
sandbox.window.AudioContext = null;
sandbox.window.isSecureContext = false;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'marble-inline.js' });

const win = sandbox.window;
const M = () => win.__marble();
const DT = 1 / 60;

const RUNS = parseInt(process.argv[2] || '10', 10);
const P = process.argv[3] === undefined ? 0.5 : parseFloat(process.argv[3]);
const ENTRIES = ['L', 'R', 'SHUF', 'STONE'];

/** 像一个「看得懂局面」的玩家那样瞄准：看本回合实际数字，往最值钱的桶打。
 *  为什么需要：L/R 的设计就是「左边加倍、右边变负」——玩家当然会往左边打。
 *  用随机瞄准去评估 L/R 会严重低估它（把「该往哪打」当成「随机挨罚」）。 */
function aimAtBest() {
  const s = M();
  const eff = s.effNums;
  let best = -1, bestV = -Infinity;
  for (let i = 0; i < eff.length; i++) {
    if (s.fx.sealed[i]) continue;              // 封住的桶不考虑
    if (eff[i] > bestV) { bestV = eff[i]; best = i; }
  }
  if (best < 0) { win.__marbleSetAim(0); return; }
  const targetX = s.fieldL + (best + 0.5) * s.slotW;
  // 用「桶位偏移」粗略换算成炮口角度（够近似；本 bench 只关心相对变化）
  const frac = (targetX - s.cannonX) / (s.fieldR - s.fieldL);
  const aim = Math.max(-s.AIM_MAX, Math.min(s.AIM_MAX, frac * 2 * s.AIM_MAX));
  win.__marbleSetAim(aim);
}

function playRound(smart) {
  if (smart) aimAtBest();
  else win.__marbleSetAim((Math.random() * 2 - 1) * 0.5);
  win.__marbleFire(0.4 + Math.random() * 0.6);
  let f = 0;
  while (M().state === 'play' && f < 1500) { perfNow += 16; win.__marbleStep(DT); f++; }
}

const SMART = process.argv[4] !== 'random';       // 默认「会瞄准」；传 random 则随机瞄准

const rows = [];
for (let run = 1; run <= RUNS; run++) {
  win.__marbleReset(run * 613 + 7);
  win.__marbleClearFx();
  win.__marbleClearItems();
  const timeline = [];
  let round = 0;
  let totalGain = 0;

  while (M().state !== 'over' && round < 40) {
    if (Math.random() < P) win.__marbleEat(ENTRIES[Math.floor(Math.random() * ENTRIES.length)]);
    const before = M();
    const sealBefore = before.fx.sealed.filter(Boolean).length;
    const lifeBefore = before.fx.life;
    playRound(SMART);
    round++;
    const s = M();
    // 这一回合的得分 = roundGain 已经被 endRound 加进去了，用 balls 差反推不方便；
    // 直接读 roundGain（endRound 之后是 0），所以改成读 gain 的增量
    timeline.push({
      round, seal: sealBefore, life: lifeBefore,
      active: before.fx.active,
      balls: s.balls,
    });
  }
  // 用 gain 统计平均每回合得分
  const g = M().gain;
  rows.push({ run, rounds: round, gain: g, perRound: round ? g / round : 0, timeline, final: M().balls });
}

console.log('\n入口变化寿命实验：' + RUNS + ' 局，每回合吃到入口变化道具的概率 ' + (P * 100).toFixed(0) + '%');
console.log('（瞄准方式=' + (SMART ? '打最值钱的桶' : '随机') + '  ENTRANCE_LIFE=' + M().ENTRANCE_LIFE + '，SEAL_MAX=' + M().SEAL_MAX + '）\n');
console.log('局  回合  累计加球  平均每回合  峰值封桶  末局封桶  末局弹珠');
console.log('-'.repeat(66));
let sumPer = 0, sumRounds = 0, maxSeal = 0;
for (const r of rows) {
  const peakSeal = Math.max(...r.timeline.map(t => t.seal));
  const lastSeal = r.timeline[r.timeline.length - 1].seal;
  sumPer += r.perRound; sumRounds += r.rounds;
  maxSeal = Math.max(maxSeal, peakSeal);
  console.log(
    String(r.run).padStart(2) + String(r.rounds).padStart(6) +
    String(r.gain).padStart(10) + r.perRound.toFixed(2).padStart(12) +
    String(peakSeal).padStart(10) + String(lastSeal).padStart(10) + String(r.final).padStart(10)
  );
}
console.log('-'.repeat(66));
console.log('平均：每回合加球 ' + (sumPer / rows.length).toFixed(2) +
            '   平均局长度 ' + (sumRounds / rows.length).toFixed(1) + ' 回合' +
            '   全程峰值封桶 ' + maxSeal + '/' + M().NUMS.length);

// 对照：把入口变化寿命临时当 1（旧行为）跑一遍，看差距
console.log('\n--- 对照：入口变化「回合结束即复原」（旧行为）---');
const oldPer = [];
for (let run = 1; run <= RUNS; run++) {
  win.__marbleReset(run * 613 + 7);
  win.__marbleClearFx(); win.__marbleClearItems();
  let round = 0;
  while (M().state !== 'over' && round < 40) {
    if (Math.random() < P) win.__marbleEat(ENTRIES[Math.floor(Math.random() * ENTRIES.length)]);
    playRound(SMART);
    round++;
    win.__marbleClearFx();                 // ★ 每回合强行清掉 = 模拟旧行为
  }
  oldPer.push(round ? M().gain / round : 0);
}
const avgNew = sumPer / rows.length;
const avgOld = oldPer.reduce((a, b) => a + b, 0) / oldPer.length;
console.log('旧行为平均每回合加球 ' + avgOld.toFixed(2) + '   新行为 ' + avgNew.toFixed(2) +
            '   变化 ' + ((avgNew / avgOld - 1) * 100).toFixed(1) + '%');
console.log('');
