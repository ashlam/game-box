#!/usr/bin/env node
/**
 * 由 Fogleman rush1000.txt 生成三档关卡（用户定稿规则）
 *
 * 源数据: https://www.michaelfogleman.com/static/rush/rush1000.txt
 *   格式 <最少步数> <36字符盘面> <编号>，o=空、x=墙、A=目标车（经典约定：目标横放、出口在右边第3行）
 *   该文件是"最难 1000 盘"，步数区间 38~60（没有 20~37 的）
 *
 * 转换: 顺时针旋转 90° → 出口落在「底部第 4 列」、目标车变「竖直、朝下、长 2」
 * 过滤: 无墙、目标车长 2、车只有 2/3 格、长 3 车 ≤ 5 辆
 *
 * 三档来源:
 *   · 3★（≥38 步）：直接取源数据（38~60 步，按步数铺开）
 *   · 2★（30~37）/ 1★（20~29）：从 38~45 步的盘面【删掉 1~2 辆障碍车】，
 *     再用 BFS 反算真最优步数，落档才收（删车只会降难度，盘面依旧合法）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const N = 6, EXIT_COL = 3, POLICE_LEN = 2, MAX_LEN3 = 5;
const CAP = 200000;
const TIERS = [
  { id: 'star1', name: '1 星', stars: 1, lo: 14, hi: 22, count: 30 },   // 入门档（上限放宽到 22 步）
  { id: 'star2', name: '2 星', stars: 2, lo: 23, hi: 29, count: 40 },
  { id: 'star3', name: '3 星', stars: 3, lo: 30, hi: 37, count: 40 },
  { id: 'star4', name: '4 星', stars: 4, lo: 38, hi: 999, count: 40 },
];
const COLORS = ['#3b82f6','#22d3ee','#f59e0b','#ef4444','#a78bfa','#34d399','#e879f9','#fb7185',
                '#84cc16','#06b6d4','#f97316','#8b5cf6','#14b8a6','#eab308','#ec4899','#60a5fa'];

function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------- 求解器（与生成器同款：紧凑竞技场 BFS，一次滑动=1步、可停中途） ---------- */
function solve(cars, cap){
  cap = cap || CAP;
  const n = cars.length;
  const L = new Int8Array(n), V = new Int8Array(n);
  let PI = -1;
  for(let i = 0; i < n; i++){ L[i] = cars[i].len; V[i] = cars[i].dir === 'v' ? 1 : 0; if(cars[i].police) PI = i; }
  const S = n * 2;
  const arena = new Int8Array(S * cap);
  for(let i = 0; i < n; i++){ arena[i * 2] = cars[i].r; arena[i * 2 + 1] = cars[i].c; }
  let cnt = 1;
  const keyOf = a => { let s = ''; for(let k = 0; k < S; k++) s += String.fromCharCode(a[k]); return s; };
  const seen = new Set([keyOf(arena.subarray(0, S))]);
  const q = [0];
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
  const isOut = off => PI >= 0 && V[PI] === 1 && arena[off + PI * 2 + 1] === EXIT_COL &&
                       arena[off + PI * 2] + L[PI] >= N;
  while(head < q.length){
    if(head === levelEnd){ depth++; levelEnd = q.length; }
    const off = q[head++];
    if(isOut(off)) return depth;
    if(depth > 90) return -1;
    for(let i = 0; i < n; i++){
      for(let d = -1; d <= 1; d += 2){
        tmp.set(arena.subarray(off, off + S));
        for(let step = 1; step <= N; step++){     // ★ 滑动步口径：一次滑动（无论几格）算 1 步
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
            q.push(at);
          }
        }
      }
    }
  }
  return -1;
}

/* ---------- 解析 / 旋转 / 过滤 ---------- */
function parseLine(line){
  const p = line.split(/\s+/);
  if(p.length < 3) return null;
  const moves = parseInt(p[0], 10), board = p[1], no = p[2];
  if(!(moves > 0) || board.length !== N * N) return null;
  if(board.indexOf('x') >= 0) return null;                 // 不要墙
  const by = {};
  for(let i = 0; i < board.length; i++){
    const ch = board[i];
    if(ch === 'o' || ch === 'x') continue;
    (by[ch] = by[ch] || []).push([Math.floor(i / N), i % N]);
  }
  const cars = [];
  for(const ch in by){
    const cs = by[ch];
    const rs = cs.map(a => a[0]), cols = cs.map(a => a[1]);
    const r0 = Math.min.apply(null, rs), c0 = Math.min.apply(null, cols);
    const horiz = (Math.max.apply(null, rs) - r0 + 1) === 1;
    const len = horiz ? (Math.max.apply(null, cols) - c0 + 1) : (Math.max.apply(null, rs) - r0 + 1);
    cars.push({ letter: ch, r: r0, c: c0, len, dir: horiz ? 'h' : 'v' });
  }
  return { moves, no, cars };
}
/**
 * 顺时针 90°: 每格 (r,c) -> (c, N-1-r)
 *   · 横车 (r, c..c+len-1) → 竖车，新左上 = (c, N-1-r)
 *   · 竖车 (r..r+len-1, c) → 横车，新左上 = (c, N-1-(r+len-1))
 * ★ 两种朝向的新左上角算法不同，用错会让竖车串位造成重叠
 */
function rotate(cars){
  return cars.map(c => {
    const nr = c.c;
    const nc = c.dir === 'h' ? (N - 1 - c.r) : (N - 1 - (c.r + c.len - 1));
    return { letter: c.letter, r: nr, c: nc, len: c.len, dir: c.dir === 'h' ? 'v' : 'h' };
  });
}
function toLevel(cars, order){
  const out = [];
  let ci = 0;
  const sorted = cars.slice().sort((a, b) => (a.letter === 'A' ? 1 : 0) - (b.letter === 'A' ? 1 : 0));
  for(const c of sorted){
    const isP = c.letter === 'A';
    out.push({ r: c.r, c: c.c, len: c.len, dir: c.dir,
               color: isP ? '#111827' : COLORS[ci % COLORS.length], police: isP });
    if(!isP) ci++;
  }
  return out;
}
function valid(cars){
  const A = cars.find(c => c.letter === 'A');
  if(!A || A.len !== 2 || A.dir !== 'v' || A.c !== EXIT_COL) return false;
  if(A.r + A.len > N) return false;
  if(cars.some(c => c.len !== 2 && c.len !== 3)) return false;
  if(cars.filter(c => c.letter !== 'A' && c.len === 3).length > MAX_LEN3) return false;
  return true;
}
function key(cars){ return cars.map(c => c.r + '' + c.c).join('|'); }

/* ---------- 主流程 ---------- */
function main(){
  const src = process.argv[2] || '/tmp/rush1000.txt';
  const rnd = mulberry32(20261006);
  const pool = [];          // 旋转后合法、且知道步数的盘面
  const lines = fs.readFileSync(src, 'utf8').trim().split('\n');
  for(const line of lines){
    const p = parseLine(line);
    if(!p) continue;
    const rot = rotate(p.cars);
    if(!valid(rot)) continue;
    pool.push({ min: p.moves, no: p.no, cars: rot });
  }
  console.log('源数据合法盘面: %d 个（步数 %d~%d）',
    pool.length, Math.min.apply(null, pool.map(p => p.min)), Math.max.apply(null, pool.map(p => p.min)));

  const sets = [];
  const used = new Set();

  // ── 4★（最难档）：直接取源数据，按步数铺开（38 → 60）──
  {
    const t = TIERS[3];
    const sorted = pool.slice().sort((a, b) => a.min - b.min || (rnd() - 0.5));
    const byStep = {};
    for(const p of sorted) (byStep[p.min] = byStep[p.min] || []).push(p);
    const steps = Object.keys(byStep).map(Number).sort((a, b) => a - b);
    const picked = [];
    let si = 0;
    while(picked.length < t.count && si < 400){
      for(const st of steps){
        const arr = byStep[st];
        if(!arr || !arr.length) continue;
        const p = arr.shift();
        const k = key(p.cars);
        if(used.has(k)) continue;
        used.add(k); picked.push({ min: st, src: p.no, cars: toLevel(p.cars) });
        if(picked.length >= t.count) break;
      }
      si++;
    }
    picked.sort((a, b) => a.min - b.min);
    sets.push({ id: t.id, name: t.name, stars: t.stars,
                levels: picked.map((p, i) => ({ id: i + 1, stars: t.stars, min: p.min, mobile: p.cars.length, src: p.src, cars: p.cars })) });
    console.log('  %s: %d 关 · 步数 %s', t.name, picked.length, picked.map(p => p.min).join('/'));
  }

  // ── 2★ / 1★：从 38~50 步的盘面删掉 1~2 辆障碍车，BFS 反算 ──
  const seeds = pool.filter(p => p.min >= 38 && p.min <= 50).sort((a, b) => a.min - b.min);
  const need3 = TIERS[2], need2 = TIERS[1], need1 = TIERS[0];
  const got3 = [], got2 = [], got1 = [];
  const t0 = Date.now();
  const maxMs = parseInt(process.argv[3] || '420000', 10);
  for(const seed of seeds){
    if((got1.length >= need1.count && got2.length >= need2.count && got3.length >= need3.count) || (Date.now() - t0) > maxMs) break;
    const cars = seed.cars;
    const obstacles = cars.map((c, i) => ({ c, i })).filter(x => x.c.letter !== 'A').map(x => x.i);
    // 组合：删 1 辆 / 删 2 辆
    const combos = [];
    for(const i of obstacles) combos.push([i]);
    for(let a = 0; a < obstacles.length; a++)
      for(let b = a + 1; b < obstacles.length; b++) combos.push([obstacles[a], obstacles[b]]);
    // 打乱后取前若干个，避免总在同一批上耗时间
    combos.sort(() => rnd() - 0.5);
    for(const rm of combos.slice(0, 26)){
      if((got1.length >= need1.count && got2.length >= need2.count && got3.length >= need3.count) || (Date.now() - t0) > maxMs) break;
      const sub = [];
      const removed = new Set(rm);
      cars.forEach((c, i) => { if(!removed.has(i)) sub.push(c); });
      if(!valid(sub)) continue;
      const k = key(sub);
      if(used.has(k)) continue;
      const st = solve(sub.map(c => ({ r: c.r, c: c.c, len: c.len, dir: c.dir, police: c.dir === 'v' && c.letter === 'A' })));
      if(st < 0) continue;
      if(st >= 30 && st <= 37 && got3.length < need3.count){
        used.add(k); got3.push({ min: st, src: seed.no + '-r' + rm.join(','), cars: toLevel(sub) });
        // ★ 级联一层：再删一辆 → 20~29（2★）
        if(got2.length < need2.count){
          for(let j = 0; j < sub.length; j++){
            if(sub[j].letter === 'A') continue;
            const sub2 = sub.filter((_, x) => x !== j);
            if(!valid(sub2)) continue;
            const k2 = key(sub2);
            if(used.has(k2)) continue;
            const st2 = solve(sub2.map(c => ({ r: c.r, c: c.c, len: c.len, dir: c.dir, police: c.dir === 'v' && c.letter === 'A' })));
            if(st2 >= 23 && st2 <= 29){
              used.add(k2); got2.push({ min: st2, src: seed.no + '-r' + rm.join(',') + '-' + j, cars: toLevel(sub2) });
              break;
            }
          }
        }
      } else if(st >= 23 && st <= 29 && got2.length < need2.count){
        used.add(k); got2.push({ min: st, src: seed.no + '-r' + rm.join(','), cars: toLevel(sub) });
        // ★ 级联两层：再删 1~2 辆 → 14~19（1★ 入门档）
        if(got1.length < need1.count){
          for(let j = 0; j < sub.length; j++){
            if(sub[j].letter === 'A') continue;
            const sub2 = sub.filter((_, x) => x !== j);
            if(!valid(sub2)) continue;
            const k2 = key(sub2);
            if(used.has(k2)) continue;
            const st2 = solve(sub2.map(c => ({ r: c.r, c: c.c, len: c.len, dir: c.dir, police: c.dir === 'v' && c.letter === 'A' })));
            if(st2 >= 14 && st2 <= 22){
              used.add(k2); got1.push({ min: st2, src: seed.no + '-r' + rm.join(',') + '-' + j, cars: toLevel(sub2) });
              break;
            }
          }
        }
      } else if(st >= 14 && st <= 22 && got1.length < need1.count){
        used.add(k); got1.push({ min: st, src: seed.no + '-r' + rm.join(','), cars: toLevel(sub) });
      }
    }
    if(((got1.length + got2.length) % 4) === 0 && (Date.now() - t0) > 20000) {
      process.stdout.write('    …1★ ' + got1.length + '/' + need1.count + ' · 2★ ' + got2.length + '/' + need2.count + ' · 3★ ' + got3.length + '/' + need3.count + '   \r');
    }
  }
  for(const [t, got] of [[need1, got1], [need2, got2], [need3, got3]]){
    got.sort((a, b) => a.min - b.min);
    sets.unshift({ id: t.id, name: t.name, stars: t.stars,
                   levels: got.map((p, i) => ({ id: i + 1, stars: t.stars, min: p.min, mobile: p.cars.length, src: p.src, cars: p.cars })) });
    console.log('  %s: %d 关 · 步数 %s', t.name, got.length, got.map(p => p.min).join('/'));
  }
  sets.sort((a, b) => a.stars - b.stars);
  const out = { n: N, exitEdge: 'bottom', exitCol: EXIT_COL, policeLen: POLICE_LEN,
                source: 'michaelfogleman.com/static/rush/rush1000.txt（删车派生 1★/2★）', sets };
  const p = path.join(__dirname, 'parking_levels.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 1));
  console.log('已写入 %s · 总计 %d 关 · 用时 %ds', p,
    sets.reduce((a, s) => a + s.levels.length, 0), ((Date.now() - t0) / 1000).toFixed(0));
}
module.exports = { solve, parseLine, rotate, valid, toLevel };
if(require.main === module) main();
