#!/usr/bin/env node
/**
 * 弹珠乐园 · 撞针寿命实验台（不是回归测试，是用来判断平衡的）
 *
 * 背景：用户要求「被地雷/火力球炸掉、被冰封球冻住的钉」不再回合结束就复原，
 *       而是保持 PEG_LIFE(=3) 回合。担心的是：一局十几发，如果炸钉太快，
 *       钉场会不会被越炸越空、最后「没钉可撞」，游戏变得没意思？
 *
 * 做法：模拟一局局的真实回合。每回合：
 *   - 按概率吃「地雷/火力球/冰封球」这三种会改变钉状态的道具（模拟玩家真的吃到）
 *   - 真实物理发球打完这一回合
 *   然后统计「钉场完整度」随回合的变化：
 *     intact%   还能正常反弹的钉占比
 *     broken    碎掉的钉数
 *     frozen    冻住的钉数
 *     restored  本回合刚复原的钉数（寿命耗尽）
 *
 * 用法：node tools/bench_marble_peg_life.js [局数] [每回合吃状态道具的概率]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'web', 'marble', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 最小 DOM/Canvas 桩 ---------------- */
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

const RUNS = parseInt(process.argv[2] || '12', 10);          // 跑几局
const P = process.argv[3] === undefined ? 0.55 : parseFloat(process.argv[3]);  // 每回合吃到「改变钉状态」道具的概率

const STATE_ITEMS = ['MINE', 'FIRE', 'ICE'];

/** 打完一回合的真实物理（发球直到落桶） */
function playRound(charge) {
  win.__marbleSetAim((Math.random() * 2 - 1) * 0.5);
  win.__marbleFire(charge);
  let f = 0;
  while (M().state === 'play' && f < 1500) { perfNow += 16; win.__marbleStep(DT); f++; }
  return f;
}

/** 模拟「这一回合吃到了一个会改变钉状态的道具」：在钉场里找一片区域炸/冻 */
function applyStateItem(kind) {
  const s = M();
  const alive = s.pegs.filter(p => !p.dead && !p.frozen);
  if (!alive.length) return;
  const target = alive[Math.floor(Math.random() * alive.length)];
  if (kind === 'MINE') win.__marbleExplode(target.x, target.y, s.MINE_R || 48, false);
  else if (kind === 'FIRE') win.__marbleExplode(target.x, target.y, s.FIRE_R || 44, false);
  else {
    // 冰封：冻住目标周围一片
    const r = s.ICE_R || 21;
    for (const p of s.pegs) {
      if (p.dead || p.frozen) continue;
      if (Math.hypot(p.x - target.x, p.y - target.y) <= r + 6) win.__marbleSetPeg(p.i, 'frozen');
    }
  }
}

const rows = [];
for (let run = 1; run <= RUNS; run++) {
  win.__marbleReset(run * 977 + 13);
  const total = M().pegs.length;
  const timeline = [];
  let round = 0;

  while (M().state !== 'over' && round < 40) {
    // 每回合按概率吃一个改变钉状态的道具
    if (Math.random() < P) applyStateItem(STATE_ITEMS[Math.floor(Math.random() * 3)]);
    const beforeRestored = M().pegs.filter(p => p.life === 1).length;   // 这回合末会复原的
    playRound(0.4 + Math.random() * 0.6);
    round++;
    const s = M();
    const dead = s.pegs.filter(p => p.dead).length;
    const frozen = s.pegs.filter(p => p.frozen).length;
    timeline.push({ round, dead, frozen, intact: total - dead,
                    intactPct: (total - dead) / total * 100, restored: beforeRestored });
  }
  rows.push({ run, total, rounds: round, timeline });
}

/* ---------------- 汇总 ---------------- */
console.log('\n撞针寿命实验：' + RUNS + ' 局，每回合吃到「改变钉状态」道具的概率 ' + (P * 100).toFixed(0) + '%');
console.log('（碎掉的钉 = 不能反弹；保持 ' + (M().PEG_LIFE) + ' 回合后复原）\n');
console.log('局  钉数  回合  末回合碎  末回合冻  末回合完整%  全程最低完整%  峰值碎  复原次数');
console.log('-'.repeat(88));

let aggMin = [], aggEnd = [], aggRounds = [];
for (const r of rows) {
  const minPct = Math.min(...r.timeline.map(t => t.intactPct));
  const last = r.timeline[r.timeline.length - 1];
  const peakDead = Math.max(...r.timeline.map(t => t.dead));
  const restores = r.timeline.filter(t => t.restored > 0).length;
  aggMin.push(minPct); aggEnd.push(last.intactPct); aggRounds.push(r.rounds);
  console.log(
    String(r.run).padStart(2) + '  ' +
    String(r.total).padStart(4) + '  ' +
    String(r.rounds).padStart(4) + '  ' +
    String(last.dead).padStart(8) + '  ' +
    String(last.frozen).padStart(8) + '  ' +
    last.intactPct.toFixed(1).padStart(11) + '%' +
    minPct.toFixed(1).padStart(14) + '%' +
    String(peakDead).padStart(7) +
    String(restores).padStart(10)
  );
}

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log('-'.repeat(88));
console.log('平均：末回合完整 ' + avg(aggEnd).toFixed(1) + '%   全程最低完整 ' + avg(aggMin).toFixed(1) +
            '%   平均局长度 ' + avg(aggRounds).toFixed(1) + ' 回合');
console.log('最惨一局：全程最低完整 ' + Math.min(...aggMin).toFixed(1) + '%');

/* 判断「会不会被炸空」 */
const worst = Math.min(...aggMin);
console.log('');
if (worst > 55) console.log('结论：钉场始终够密（最惨 ' + worst.toFixed(1) + '%）—— 3 回合复原足够快，不会被炸空。');
else if (worst > 35) console.log('结论：最惨会掉到 ' + worst.toFixed(1) + '%，偏空但还能玩 —— 值得盯着。');
else console.log('⚠ 结论：最惨只剩 ' + worst.toFixed(1) + '% —— 钉场会被炸空，需要考虑缩短寿命或减少炸钉。');
console.log('');
