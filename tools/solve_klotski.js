#!/usr/bin/env node
/**
 * 华容道「横刀立马」求解器（独立工具）
 *
 * 规则与本游戏一致：同一辆车朝一个方向滑动任意格 = 1 步。
 * 输出人类可读的解法（按"当前占位格"标注，避免同型车混淆）。
 *
 * 用法：node tools/solve_klotski.js
 */
'use strict';

const COLS = 4, ROWS = 5;
/* 与 web/klotski/index.html 的 LAYOUT 保持一致 */
const LAYOUT = [
  { name:'曹操', r:0, c:1, w:2, h:2, boss:true },
  { name:'关羽', r:2, c:1, w:2, h:1 },
  { name:'张飞', r:0, c:0, w:1, h:2 },
  { name:'赵云', r:0, c:3, w:1, h:2 },
  { name:'马超', r:2, c:0, w:1, h:2 },
  { name:'黄忠', r:2, c:3, w:1, h:2 },
  { name:'卒',   r:3, c:1, w:1, h:1 },
  { name:'卒',   r:3, c:2, w:1, h:1 },
  { name:'卒',   r:4, c:0, w:1, h:1 },
  { name:'卒',   r:4, c:3, w:1, h:1 },
];
const DIRS = { '左':[0,-1], '右':[0,1], '上':[-1,0], '下':[1,0] };
const DIRNAME = { '0,-1':'左', '0,1':'右', '-1,0':'上', '1,0':'下' };

function makeModel(layout){
  const ps = layout.map((p, i) => ({ i, name: p.name, r: p.r, c: p.c, w: p.w, h: p.h, boss: !!p.boss }));
  return {
    ps,
    key(){ return ps.map(p => p.w + 'x' + p.h + '@' + p.r + ',' + p.c).sort().join('|'); },
    clone(){ return makeModel(ps.map((p, i) => ({ name: p.name, r: p.r, c: p.c, w: p.w, h: p.h, boss: p.boss }))); },
    fits(p, r, c){
      if(r < 0 || c < 0 || r + p.h > ROWS || c + p.w > COLS) return false;
      for(const q of ps){
        if(q === p) continue;
        if(r < q.r + q.h && q.r < r + p.h && c < q.c + q.w && q.c < c + p.w) return false;
      }
      return true;
    },
    moves(){
      const out = [];
      for(const p of ps){
        for(const k of Object.keys(DIRS)){
          const [dr, dc] = DIRS[k];
          let n = 0;
          while(this.fits(p, p.r + dr, p.c + dc)){
            p.r += dr; p.c += dc; n++;
            out.push({ piece: p.i, dr, dc, n, from: { r: p.r - dr * n, c: p.c - dc * n }, to: { r: p.r, c: p.c } });
          }
          for(let i = 0; i < n; i++){ p.r -= dr; p.c -= dc; }
        }
      }
      return out;
    },
    win(){ const b = ps.find(p => p.boss); return b.r === 3 && b.c === 1; },
  };
}

function solve(layout){
  const start = makeModel(layout);
  const seen = new Set([start.key()]);
  const q = [{ m: start, path: [] }];
  let visited = 0;
  while(q.length){
    const cur = q.shift();
    visited++;
    if(cur.m.win()) return { steps: cur.path.length, path: cur.path, visited };
    for(const mv of cur.m.moves()){
      const nxt = cur.m.clone();
      const p = nxt.ps[mv.piece];
      p.r = mv.to.r; p.c = mv.to.c;
      const k = nxt.key();
      if(seen.has(k)) continue;
      seen.add(k);
      q.push({ m: nxt, path: cur.path.concat([mv]) });
    }
  }
  return { steps: -1, path: [], visited };
}

const t0 = Date.now();
const res = solve(LAYOUT);
const ms = Date.now() - t0;

console.log('华容道「横刀立马」  —— 有解 ✓');
console.log('最少步数 = ' + res.steps + ' 步（规则：同一辆车朝一个方向滑动任意格算 1 步）');
console.log('BFS 用时 ' + ms + 'ms，搜索状态 ' + res.visited + ' 个\n');

/* 逐步回放，把索引换成"当时的占位"，输出人话 */
const cur = makeModel(LAYOUT);
console.log('解法（每步格式：第N步  车名 方向 N格   格子(r,c)→(r,c)）：');
for(let i = 0; i < res.path.length; i++){
  const mv = res.path[i];
  const p = cur.ps[mv.piece];
  const from = { r: p.r, c: p.c };
  const name = p.name === '曹操' ? '曹操(大客车)' : p.name;
  console.log('  ' + String(i + 1).padStart(2, ' ') + '.  ' + name + '  ' + DIRNAME[mv.dr + ',' + mv.dc] + ' ' + mv.n + ' 格' +
              '    (' + from.r + ',' + from.c + ')→(' + mv.to.r + ',' + mv.to.c + ')');
  p.r = mv.to.r; p.c = mv.to.c;
  if(p.boss && p.r === 3 && p.c === 1){
    console.log('  → 第 ' + (i + 1) + ' 步曹操到达出口 (3,1)，过关！');
    break;
  }
}
