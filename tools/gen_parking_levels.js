#!/usr/bin/env node
/**
 * 停车场华容道 —— 关卡生成（按用户定稿规则）
 *
 * 固定设定（用户明确）：
 *   · 棋盘 6×6
 *   · 出口固定：底部、第 4 列（0 基索引 3），朝下
 *   · 目标车固定：黑色警车，长度固定 2，竖直，永远处于出口所在列（第 4 列），朝向朝下
 *   · 障碍车只有长度 2 和 3，且【长度 3 的障碍车最多 5 辆（含）】
 *
 * 难度（按步数）：
 *   1★ ≥20 步　2★ ≥30 步　3★ ≥38 步　每档 16 关
 *
 * 生成思路（随机摆盘命中不了高步数）：
 *   ① 按固定设定摆一个合法盘（警车在第 4 列）
 *   ② 从该盘做 K 步【随机合法滑动】打乱（警车不许滑出库）
 *   ③ 用 BFS 求打乱后盘面的【真·最少步数】
 *   ④ 落在目标档位区间就收下，否则重摆重打乱
 */
'use strict';
const fs = require('fs');
const path = require('path');

const N = 6;
const EXIT_COL = 3;                       // ★ 第 4 列（0 基索引 3）
const EXIT_EDGE = 'bottom';               // ★ 朝下
const POLICE_LEN = 2;                     // ★ 警车固定长度 2
const MAX_LEN3 = 5;                       // ★ 长度 3 的障碍车最多 5 辆（含）
const MAX_CARS = 16;
const CAP = 130000;

const TIERS = [
  { id: 'star1', name: '1 星', stars: 1, lo: 4,  hi: 9,  count: 16 },
  { id: 'star2', name: '2 星', stars: 2, lo: 10, hi: 15, count: 16 },
  { id: 'star3', name: '3 星', stars: 3, lo: 16, hi: 22, count: 16 },
];

function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ================= 求解器（BFS，紧凑竞技场） ================= */
function solve(cars, cap){
  cap = cap || CAP;
  const n = cars.length;
  const L = new Int8Array(n), V = new Int8Array(n);      // V: 0=横 1=竖
  let PI = -1;
  for(let i = 0; i < n; i++){
    L[i] = cars[i].len; V[i] = cars[i].dir === 'v' ? 1 : 0;
    if(cars[i].police) PI = i;
  }
  const S = n * 2;
  const arena = new Int8Array(S * cap);
  for(let i = 0; i < n; i++){ arena[i * 2] = cars[i].r; arena[i * 2 + 1] = cars[i].c; }
  let cnt = 1;
  const keyOf = a => { let s = ''; for(let k = 0; k < S; k++) s += String.fromCharCode(a[k]); return s; };
  const seen = new Set([keyOf(arena.subarray(0, S))]);
  const queue = [0];
  let head = 0, depth = 0, levelEnd = 1;
  const tmp = new Int8Array(S);
  const free = (off, r, c, skip) => {
    if(r < 0 || r >= N || c < 0 || c >= N) return false;
    for(let i = 0; i < n; i++){
      if(i === skip) continue;
      const rr = arena[off + i * 2], cc = arena[off + i * 2 + 1];
      if(V[i] === 0){ if(rr === r && c >= cc && c < cc + L[i]) return false; }
      else          { if(cc === c && r >= rr && r < rr + L[i]) return false; }
    }
    return true;
  };
  const isOut = off => {
    if(PI < 0) return false;
    const rr = arena[off + PI * 2], cc = arena[off + PI * 2 + 1];
    return V[PI] === 1 && cc === EXIT_COL && rr + L[PI] >= N;   // 竖直警车在第 4 列、滑到最底
  };
  while(head < queue.length){
    if(head === levelEnd){ depth++; levelEnd = queue.length; }
    const off = queue[head++];
    if(isOut(off)) return depth;
    if(depth > 70) return -1;
    for(let i = 0; i < n; i++){
      for(let d = -1; d <= 1; d += 2){
        tmp.set(arena.subarray(off, off + S));
        for(let step = 1; step <= N; step++){
          const r = tmp[i * 2] + (V[i] === 1 ? d : 0);
          const c = tmp[i * 2 + 1] + (V[i] === 0 ? d : 0);
          let ok = true;
          for(let k = 0; k < L[i]; k++){
            const rr = V[i] === 1 ? r + k : r, cc = V[i] === 0 ? c + k : c;
            if(!free(off, rr, cc, i)){ ok = false; break; }
          }
          if(!ok) break;
          tmp[i * 2] = r; tmp[i * 2 + 1] = c;
          const kk = keyOf(tmp);
          if(!seen.has(kk)){
            seen.add(kk);
            if(cnt >= cap) return -2;
            const at = cnt * S; arena.set(tmp, at); cnt++;
            queue.push(at);
          }
        }
      }
    }
  }
  return -1;
}

/* ================= 摆盘 / 打乱 ================= */
const COLORS = ['#3b82f6','#22d3ee','#f59e0b','#ef4444','#a78bfa','#34d399','#e879f9','#fb7185',
                '#84cc16','#06b6d4','#f97316','#8b5cf6','#14b8a6','#eab308','#ec4899','#60a5fa'];

function emptyGrid(){ return new Int8Array(N * N).fill(-1); }
function cells(car){
  const out = [];
  for(let k = 0; k < car.len; k++) out.push(car.dir === 'h' ? [car.r, car.c + k] : [car.r + k, car.c]);
  return out;
}
function fits(grid, car){
  for(const [r, c] of cells(car)){
    if(r < 0 || r >= N || c < 0 || c >= N) return false;
    if(grid[r * N + c] !== -1) return false;
  }
  return true;
}
function paint(grid, car, v){ for(const [r, c] of cells(car)) grid[r * N + c] = v; }
function clone(cars){ return cars.map(c => ({ r:c.r, c:c.c, len:c.len, dir:c.dir, color:c.color, police:!!c.police })); }

/** 撞出一个合法盘：警车固定在第 4 列、竖直、长 2；障碍车 len2/len3，len3 ≤ MAX_LEN3 */
function buildBoard(rnd, wantCars, wantLen3){
  for(let attempt = 0; attempt < 40; attempt++){
    const grid = emptyGrid();
    const cars = [];
    // ① 警车（固定设定）
    const pr = Math.floor(rnd() * (N - POLICE_LEN));           // 0..3，保证还有往下走的空间
    const police = { r: pr, c: EXIT_COL, len: POLICE_LEN, dir:'v', color:'#111827', police:true };
    cars.push(police); paint(grid, police, 0);
    // ② 障碍车
    let len3 = 0, guard = 0;
    while(cars.length < wantCars && guard++ < 900){
      const want3 = len3 < Math.min(wantLen3, MAX_LEN3) && rnd() < 0.34;
      const len = want3 ? 3 : 2;
      const dir = rnd() < 0.5 ? 'h' : 'v';
      const r = Math.floor(rnd() * N), c = Math.floor(rnd() * N);
      const car = { r, c, len, dir, color: COLORS[Math.floor(rnd() * COLORS.length)], police:false };
      if(!fits(grid, car)) continue;
      // 不允许障碍车把出口通道"永久堵死"：出口列的最底格不能被横车占住，否则警车永远出不去
      const blocksExit = cells(car).some(([rr, cc]) => cc === EXIT_COL && rr === N - 1);
      if(blocksExit && car.dir === 'h') continue;
      cars.push(car); paint(grid, car, cars.length - 1);
      if(len === 3) len3++;
    }
    if(cars.length >= Math.max(5, Math.floor(wantCars * 0.7))) return cars;
  }
  return null;
}

/** 从某盘做 K 步随机合法滑动打乱（警车不许滑出库） */
function scramble(rnd, carsIn, K){
  let cars = clone(carsIn);
  for(let s = 0; s < K; s++){
    const legal = [];
    for(let i = 0; i < cars.length; i++){
      for(const d of [-1, 1]){
        const n = maxSlide(cars, i, d);
        // 打乱过程中警车不允许真的滑到底（否则等于已经通关）
        for(let n2 = 1; n2 <= n; n2++){
          const trial = clone(cars);
          for(let k = 0; k < n2; k++) trial[i].dir === 'h' ? trial[i].c += d : trial[i].r += d;
          if(trial[i].police && trial[i].r + trial[i].len >= N) continue;   // 警车不能已经滑到底
          legal.push({ i, d, n: n2 });
        }
      }
    }
    if(!legal.length) break;
    const mv = legal[Math.floor(rnd() * legal.length)];
    cars[mv.i].dir === 'h' ? cars[mv.i].c += mv.d * mv.n : cars[mv.i].r += mv.d * mv.n;
  }
  return cars;
}
function maxSlide(cars, i, d){
  let n = 0;
  while(true){
    const t = { ...cars[i] };
    if(t.dir === 'h') t.c += d * (n + 1); else t.r += d * (n + 1);
    if(!placeFree(cars, i, t)) break;
    n++;
    if(n > N) break;
  }
  return n;
}
function placeFree(cars, skip, car){
  for(const [r, c] of cells(car)){
    if(r < 0 || r >= N || c < 0 || c >= N) return false;
    for(let j = 0; j < cars.length; j++){
      if(j === skip) continue;
      for(const [rr, cc] of cells(cars[j])) if(rr === r && cc === c) return false;
    }
  }
  return true;
}
function sig(cars){ return cars.map(c => c.r + '' + c.c + c.len + c.dir).join('|'); }

/* ================= 主流程 ================= */
function main(){
  const perTier = parseInt(process.argv[2] || '16', 10);
  const seed = parseInt(process.argv[3] || '20261004', 10);
  const rnd = mulberry32(seed);
  const sets = [];
  const used = new Set();
  const t0all = Date.now();
  for(const tier of TIERS){
    const made = []; const t0 = Date.now(); let tries = 0;
    while(made.length < perTier && tries++ < 60000 && (Date.now() - t0) < 240000){
      const wantCars = 7 + Math.floor(rnd() * 4);                 // 7~10 辆（含警车）
      const wantLen3 = Math.floor(rnd() * (MAX_LEN3 + 1));        // 0~5
      const base = buildBoard(rnd, wantCars, wantLen3);
      if(!base) continue;
      const K = tier.lo * 2 + 12 + Math.floor(rnd() * 40);
      const lvl = scramble(rnd, base, K);
      if(lvl[0].r + lvl[0].len > N) continue;                     // 警车不能已在出口
      if(lvl[0].r + lvl[0].len === N) continue;
      const s = sig(lvl);
      if(used.has(s)) continue;
      const st = solve(lvl);
      if(st < tier.lo || st > tier.hi) continue;
      used.add(s);
      made.push({ min: st, cars: lvl.map(c => ({ r:c.r, c:c.c, len:c.len, dir:c.dir, color:c.color, police:!!c.police })) });
    }
    made.sort((a, b) => a.min - b.min);
    const levels = made.map((m, i) => ({
      id: i + 1, stars: tier.stars, min: m.min, mobile: m.cars.length, cars: m.cars,
    }));
    const len3s = levels.map(l => l.cars.filter(c => !c.police && c.len === 3).length);
    console.log('  %s: %d/%d 关 · 最少步数 %s · 长3车数 %s · 用时 %ds',
      tier.name, levels.length, perTier, levels.map(l => l.min).join('/'),
      len3s.join('/'), ((Date.now() - t0) / 1000).toFixed(0));
    sets.push({ id: tier.id, name: tier.name, stars: tier.stars, levels });
  }
  const outPath = path.join(__dirname, 'parking_levels.json');
  fs.writeFileSync(outPath, JSON.stringify({
    n: N, exitEdge: EXIT_EDGE, exitCol: EXIT_COL, policeLen: POLICE_LEN, sets,
  }, null, 1));
  console.log('已写入 %s', outPath);
  console.log('总计 %d 关 · 总用时 %ds', sets.reduce((a, s) => a + s.levels.length, 0),
    ((Date.now() - t0all) / 1000).toFixed(0));
}
module.exports = { N, solve, TIERS, EXIT_COL, EXIT_EDGE };
if(require.main === module) main();
