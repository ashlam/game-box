#!/usr/bin/env node
/**
 * 停车场华容道 —— 关卡生成 + 求解（性能版）
 *
 * 规则（据实体玩具《移车出库》说明书 + 照片核对）：
 *   · 6×6 棋盘；每辆车 1 格宽、长 2 或 3；横车只左右滑、竖车只上下滑
 *   · 每关一辆【黑色警车】= 目标车，从盘边出口开出去即过关
 *   · 一次滑动算 1 步；滑动【可以停在中途】→ 真·最少步数必须枚举 1..k 格
 *   · 车不能拐弯、不能被拿出棋盘；其他车也不能开出盘外
 *
 * 求解器：BFS，状态紧凑存进一个 Int8Array 竞技场（每状态 2n 字节），
 *        不做任何 per-state 对象拷贝 —— 6×6 的深盘也能在秒级跑完。
 *
 * 用法：node tools/gen_parking_levels.js [每档数量] [种子]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const N = 6;
const TIERS = [
  { id: 'beginner',     name: '初级', steps: [3, 10],  mobile: [4, 9]  },
  { id: 'intermediate', name: '中级', steps: [11, 18], mobile: [9, 14] },
  { id: 'advanced',     name: '高级', steps: [19, 26], mobile: [12, 18] },
];
const CAP = 220000;                // 单盘搜索状态上限（超了就当太难，换一盘）

function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ================= 求解器 ================= */
/** cars: [{r,c,len,dir,police}] → 最少步数；-1 无解；-2 超上限 */
function solve(cars, exit, cap){
  cap = cap || CAP;
  const n = cars.length;
  const L = new Int8Array(n), D = new Int8Array(n);   // 长 / 方向(0=横,1=竖)
  let PI = -1;
  for(let i = 0; i < n; i++){
    L[i] = cars[i].len; D[i] = cars[i].dir === 'h' ? 0 : 1;
    if(cars[i].police) PI = i;
  }
  const S = n * 2;                                     // 每状态字节数
  const arena = new Int8Array(S * cap);
  let cnt = 0;
  const push = (src, off) => {                          // 把状态写入竞技场，返回索引
    const at = cnt * S;
    arena.set(arena.subarray(off, off + S), at);
    cnt++;
    return at;
  };
  // 初始状态
  for(let i = 0; i < n; i++){ arena[i * 2] = cars[i].r; arena[i * 2 + 1] = cars[i].c; }
  cnt = 1;
  const keyOf = off => { let s = ''; for(let k = 0; k < S; k++) s += String.fromCharCode(arena[off + k]); return s; };
  const seen = new Set([keyOf(0)]);
  const queue = [0];                                    // 状态的竞技场偏移
  let head = 0, depth = 0, levelEnd = 1;

  const at = (off, i) => ({ r: arena[off + i * 2], c: arena[off + i * 2 + 1] });
  const free = (off, r, c, skip) => {
    if(r < 0 || r >= N || c < 0 || c >= N) return false;
    for(let i = 0; i < n; i++){
      if(i === skip) continue;
      const rr = arena[off + i * 2], cc = arena[off + i * 2 + 1];
      if(D[i] === 0){ if(rr === r && c >= cc && c < cc + L[i]) return false; }
      else          { if(cc === c && r >= rr && r < rr + L[i]) return false; }
    }
    return true;
  };
  /** ★ 注意：入参是【竞技场偏移】(数字)，必须从 arena 里读 */
  const isOut = off => {
    if(PI < 0) return false;
    const rr = arena[off + PI * 2], cc = arena[off + PI * 2 + 1], len = L[PI];
    if(exit === 'right')  return D[PI] === 0 && cc + len >= N;
    if(exit === 'left')   return D[PI] === 0 && cc <= 0;
    if(exit === 'bottom') return D[PI] === 1 && rr + len >= N;
    if(exit === 'top')    return D[PI] === 1 && rr <= 0;
    return false;
  };

  while(head < queue.length){
    if(head === levelEnd){ depth++; levelEnd = queue.length; }
    const off = queue[head++];
    if(isOut(off)) return depth;                        // 警车已到出口 → 胜利
    if(depth > 45) return -1;
    for(let i = 0; i < n; i++){
      for(let d = -1; d <= 1; d += 2){
        // 逐格推进；每推进一格就是一个"可停位置"= 一个新状态（一次滑动算 1 步，可停中途）
        const tmp = new Int8Array(S);
        tmp.set(arena.subarray(off, off + S));
        for(let step = 1; step <= N; step++){
          const r = tmp[i * 2] + (D[i] === 1 ? d : 0);
          const c = tmp[i * 2 + 1] + (D[i] === 0 ? d : 0);
          let ok = true;
          for(let k = 0; k < L[i]; k++){
            const rr = D[i] === 1 ? r + k : r, cc = D[i] === 0 ? c + k : c;
            if(!free(off, rr, cc, i)){ ok = false; break; }
          }
          if(!ok) break;
          tmp[i * 2] = r; tmp[i * 2 + 1] = c;
          const kk = keyOf2(tmp);
          if(!seen.has(kk)){
            seen.add(kk);
            if(cnt >= cap) return -2;
            const at2 = cnt * S; arena.set(tmp, at2); cnt++;
            queue.push(at2);
          }
        }
      }
    }
  }
  return -1;
}
function keyOf2(tmp){ let s = ''; for(let k = 0; k < tmp.length; k++) s += String.fromCharCode(tmp[k]); return s; }

/* ================= 摆盘 ================= */
const COLORS = ['#3b82f6','#22d3ee','#f59e0b','#ef4444','#a78bfa','#34d399','#e879f9','#fb7185',
                '#84cc16','#06b6d4','#f97316','#8b5cf6','#14b8a6','#eab308','#ec4899','#60a5fa'];
function genBoard(rnd, exit, wantCars){
  const occ = new Int8Array(N * N).fill(-1);
  const cars = [];
  const EX = (exit === 'right' || exit === 'left') ? 'h' : 'v';
  const plen = rnd() < 0.75 ? 2 : 3;
  let pr, pc;
  if(EX === 'h'){
    pr = Math.floor(rnd() * N);
    pc = exit === 'right' ? Math.floor(rnd() * (N - plen)) : (1 + Math.floor(rnd() * (N - plen)));
  }else{
    pc = Math.floor(rnd() * N);
    pr = exit === 'bottom' ? Math.floor(rnd() * (N - plen)) : (1 + Math.floor(rnd() * (N - plen)));
  }
  const police = { r: pr, c: pc, len: plen, dir: EX, color: '#111827', police: true };
  cars.push(police); mark(occ, police);
  let guard = 0;
  while(cars.length < wantCars + 1 && guard++ < 1200){
    const dir = rnd() < 0.5 ? 'h' : 'v';
    const len = rnd() < 0.62 ? 2 : 3;
    const r = Math.floor(rnd() * N), c = Math.floor(rnd() * N);
    if(dir === 'h' && c + len > N) continue;
    if(dir === 'v' && r + len > N) continue;
    let ok = true;
    for(let k = 0; k < len; k++){
      const rr = dir === 'h' ? r : r + k, cc = dir === 'h' ? c + k : c;
      if(occ[rr * N + cc] !== -1){ ok = false; break; }
    }
    if(!ok) continue;
    const car = { r, c, len, dir, color: COLORS[Math.floor(rnd() * COLORS.length)] };
    cars.push(car); mark(occ, car);
  }
  return cars;
}
function mark(occ, car){
  for(let k = 0; k < car.len; k++){
    const r = car.dir === 'h' ? car.r : car.r + k, c = car.dir === 'h' ? car.c + k : car.c;
    occ[r * N + c] = 1;
  }
}
function sig(cars, exit){
  return cars.map(c => [c.r, c.c, c.len, c.dir].join('')).join('|') + '@' + exit;
}

function main(){
  const perTier = parseInt(process.argv[2] || '16', 10);
  const seed = parseInt(process.argv[3] || '20261004', 10);
  const rnd = mulberry32(seed);
  const sets = []; const allSigs = new Set();
  const t0all = Date.now();
  for(const tier of TIERS){
    const made = []; const t0 = Date.now(); let tries = 0;
    while(made.length < perTier && tries++ < 30000 && (Date.now() - t0) < 600000){
      const exit = ['right','left','top','bottom'][Math.floor(rnd() * 4)];
      const want = tier.mobile[0] + Math.floor(rnd() * (tier.mobile[1] - tier.mobile[0] + 1));
      const cars = genBoard(rnd, exit, want);
      if(cars.length - 1 < tier.mobile[0]) continue;
      const s = sig(cars, exit);
      if(allSigs.has(s)) continue;
      const st = solve(cars, exit);
      if(st < tier.steps[0] || st > tier.steps[1]) continue;
      allSigs.add(s);
      made.push({ exit, min: st, cars });
    }
    made.sort((a, b) => a.min - b.min);
    const levels = made.map((m, i) => ({
      id: i + 1, min: m.min, exit: m.exit, mobile: m.cars.length,
      cars: m.cars.map(c => ({ r: c.r, c: c.c, len: c.len, dir: c.dir, color: c.color, police: !!c.police })),
    }));
    console.log('  %s: %d 关 · 最少步数 %s · 用时 %ds',
      tier.name, levels.length, levels.map(l => l.min).join('/'), ((Date.now() - t0) / 1000).toFixed(0));
    sets.push({ id: tier.id, name: tier.name, levels });
  }
  const outPath = path.join(__dirname, 'parking_levels.json');
  fs.writeFileSync(outPath, JSON.stringify({ n: N, sets }, null, 1));
  console.log('已写入 %s', outPath);
  console.log('总计 %d 关 · 总用时 %ds', sets.reduce((a, s) => a + s.levels.length, 0),
    ((Date.now() - t0all) / 1000).toFixed(0));
}
module.exports = { N, solve, TIERS };
if(require.main === module) main();
