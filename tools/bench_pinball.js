#!/usr/bin/env node
/**
 * 弹珠台 发射手感实验台
 *
 * 要回答的问题：**「力度 → 落点」到底可不可控？**
 * 这是本作能不能玩起来的关键 —— 玩家必须能靠练力度打到想打的出口，
 * 否则「投币赌倍数」就退化成纯运气，技巧成分归零。
 *
 * 两个指标：
 *   1) **可控性**：同 seed 下，力度细分（200 档）能否覆盖 12 个出口；
 *      以及「相邻力度档的落点差」有多大（差越小 = 越好微调）。
 *   2) **单调性**：力度从小到大，落点是否整体从右往左移（Spearman 秩相关）。
 *      完全随机时秩相关 ≈ 0；理想可控接近 -1。
 *
 * 用法：
 *   node tools/bench_pinball.js                 # 当前参数
 *   node tools/bench_pinball.js --sweep         # 扫几组候选参数对比
 *   node tools/bench_pinball.js --jit 0         # 关掉出手抖动（看纯映射）
 */
const H = require('./pinball_harness.js');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? parseFloat(argv[i + 1]) : d; };

const JIT_OFF = has('--jit') && num('--jit', 1) === 0;

/* ---------------- 统计工具 ---------------- */
/** Spearman 秩相关（含并列的平均秩） */
function spearman(xs, ys){
  const rank = a => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    let i = 0;
    while(i < idx.length){
      let j = i;
      while(j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for(let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for(let i = 0; i < n; i++){
    const dx = rx[i] - mx, dy = ry[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : 0;
}

/* ---------------- 一组参数跑一遍 ---------------- */
function evaluate(win, M, shoot, tune, { seeds = 6, steps = 120, bet = 5, mult = 2 } = {}){
  const H2 = H.load();
  H2.win.__pinballTune(tune || {});
  const w = H2.win, m = H2.M, sh = H2.shoot;

  const slotHit = new Array(12).fill(0);
  const corrs = [], jumpMeans = [], timeouts = [];
  const repeatWorst = [], repeatAvg = [];
  let nan = 0, out = 0, tunnel = 0;
  let frames = [];

  for(let s = 0; s < seeds; s++){
    const seed = 90001 + s * 7919;
    const xs = [], ys = [];
    /* ★ 整档力度在**同一局连续**打完（不 reset）：RNG 持续推进，
       出手抖动才会每发不同 —— 这正是玩家真实体验。
       以前每发都 reset，抖动序列完全相同，「同力度同落点」是必然的，
       量出来的可控性数字好看但掩盖了 bug。 */
    w.__pinballReset(seed);
    for(let i = 0; i < steps; i++){
      const p = i / (steps - 1);
      const r = sh(p, { bet, mult, fresh: false });
      xs.push(p); ys.push(r.slot);
      if(r.slot >= 0 && r.slot < 12) slotHit[r.slot]++;
      if(r.nan) nan++;
      if(r.out) out++;
      if(r.tunnel) tunnel++;
      if(r.timedOut) timeouts.push(s);
      frames.push(r.frames);
    }
    corrs.push(spearman(xs, ys));
    /* 相邻力度档的落点跳变（越小越好微调） */
    let sum = 0, n = 0;
    for(let i = 1; i < ys.length; i++){ sum += Math.abs(ys[i] - ys[i - 1]); n++; }
    jumpMeans.push(sum / n);
    /* 同一力度反复打 8 发的重复度。
       ★ 报「平均值」而不是「最大值」：最大值只由某一个档位决定，噪声大；
         平均值才反映「整体上玩家会不会觉得每次都一样」。
         两个都留着 —— 最大值用来发现「某个档位特别死」的局部问题。 */
    let worst = 0, rsum = 0, rcnt = 0;
    for(let i = 0; i < steps; i += Math.max(1, Math.floor(steps / 12))){
      const p = i / (steps - 1);
      const slots = [];
      for(let k = 0; k < 8; k++) slots.push(sh(p, { bet, mult, fresh: false }).slot);
      const c = {};
      for(const v of slots) c[v] = (c[v] || 0) + 1;
      const modal = Math.max.apply(null, Object.values(c)) / 8;
      worst = Math.max(worst, modal);
      rsum += modal; rcnt++;
    }
    repeatWorst.push(worst);
    repeatAvg.push(rsum / rcnt);
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    tune: H2.win.__pinballTune(),
    slotHit,
    covered: slotHit.filter(v => v > 0).length,
    corr: avg(corrs),
    jump: avg(jumpMeans),
    repeat: avg(repeatWorst),
    repeatAvg: avg(repeatAvg),
    nan, out, tunnel,
    timeouts: timeouts.length,
    avgFrames: avg(frames),
  };
}

/* ---------------- 主流程 ---------------- */
const base = H.load();
const name = t => Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ');

console.log('=== 弹珠台 发射手感实验台 ===');
console.log(`出手抖动: ${JIT_OFF ? '关（纯映射）' : '开（真机手感）'}\n`);

const CANDIDATES = has('--sweep') ? [
  { label: 'P0 当前', tune: {} },
  { label: 'P1 D5J宽', tune: { PEG_DX: 72, PEG_ROWS: 5, REST_PEG: 0.42, VREL_MIN: 70, VREL_MAX: 190 } },
  { label: 'P2 +大角', tune: { PEG_DX: 72, PEG_ROWS: 5, REST_PEG: 0.42, VREL_MIN: 70, VREL_MAX: 190, PHI_MIN: 0.10, PHI_MAX: 3.00 } },
  { label: 'P3 +大角+抖小', tune: { PEG_DX: 72, PEG_ROWS: 5, REST_PEG: 0.42, VREL_MIN: 70, VREL_MAX: 190, PHI_MIN: 0.10, PHI_MAX: 3.00, PHI_JIT: 0.03, VREL_JIT: 6 } },
  { label: 'P4 钉6行', tune: { PEG_DX: 66, PEG_ROWS: 6, REST_PEG: 0.42, VREL_MIN: 70, VREL_MAX: 190, PHI_MIN: 0.10, PHI_MAX: 3.00 } },
  { label: 'P5 弹力0.5', tune: { PEG_DX: 72, PEG_ROWS: 5, REST_PEG: 0.50, VREL_MIN: 70, VREL_MAX: 190, PHI_MIN: 0.10, PHI_MAX: 3.00 } },
  { label: 'P6 速度更宽', tune: { PEG_DX: 72, PEG_ROWS: 5, REST_PEG: 0.42, VREL_MIN: 90, VREL_MAX: 220, PHI_MIN: 0.10, PHI_MAX: 3.00 } },
  { label: 'P7 抖更小', tune: { PEG_DX: 72, PEG_ROWS: 5, REST_PEG: 0.42, VREL_MIN: 70, VREL_MAX: 190, PHI_MIN: 0.10, PHI_MAX: 3.00, PHI_JIT: 0.02, VREL_JIT: 4 } },
] : [{ label: '当前参数', tune: {} }];

const results = [];
for(const c of CANDIDATES){
  const t = Object.assign({}, c.tune);
  if(JIT_OFF){ t.PHI_JIT = 0; t.VREL_JIT = 0; }
  const r = evaluate(null, null, null, t);
  results.push({ label: c.label, ...r });
  const bars = r.slotHit.map(v => v === 0 ? '·' : String(Math.min(9, Math.ceil(v / 20)))).join('');
  console.log(`${c.label.padEnd(14)} 覆盖 ${String(r.covered).padStart(2)}/12  秩相关 ${r.corr.toFixed(3).padStart(7)}  邻档跳变 ${r.jump.toFixed(2)}  重复 均${(r.repeatAvg*100).toFixed(0)}%/最差${(r.repeat*100).toFixed(0)}%  分布 ${bars}  超时 ${r.timeouts} NaN ${r.nan} 出界 ${r.out}`);
}

console.log('\n（分布条：每槽命中量的对数刻度，· = 完全没球落进去；左=0号槽，右=11号槽）');
console.log('  理想：覆盖 12/12、秩相关接近 -1（大力→左边）、邻档跳变小（好微调）');
console.log('        「重复」= 同一力度反复打时最常见落点占比 —— 越低越不会「每次都一样」');
console.log('        （这一项曾经是 100%：满力量 12/12 都落同一个口，见 README「发射手感」）');

if(results.length > 1){
  const best = results.slice().sort((a, b) =>
    (b.covered - a.covered) || (Math.abs(b.corr) - Math.abs(a.corr)) || (a.jump - b.jump))[0];
  console.log(`\n>>> 综合最优：${best.label}  （覆盖 ${best.covered}/12，秩相关 ${best.corr.toFixed(3)}，邻档跳变 ${best.jump.toFixed(2)}，同力度重复 ${(best.repeat*100).toFixed(0)}%）`);
}
