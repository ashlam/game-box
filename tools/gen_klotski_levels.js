#!/usr/bin/env node
/**
 * 生成华容道关卡集（tools/klotski_levels.json）
 *
 * 做法（可验证，不编造）：
 *   1. 先用 BFS 求出经典「横刀立马」的通关局面（终局）
 *   2. 从终局**随机反向走 K 步**（每步都是合法移动）→ 得到必然有解的盘面（解 ≤ K 步）
 *   3. 再用 BFS 对每个新盘面求**真实最少步数**，按难度排序、去重
 *   4. 与经典「横刀立马」一起写入关卡集文件（入门 = 简单的；古典 = 难关）
 *
 * 用法：node tools/gen_klotski_levels.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const COLS = 4, ROWS = 5;
const LAYOUT = [
  { name:'曹操', r:0, c:1, w:2, h:2, boss:true, type:'bus',   color:'#e0483c' },
  { name:'关羽', r:2, c:1, w:2, h:1, type:'sedan', color:'#2fa36b' },
  { name:'张飞', r:0, c:0, w:1, h:2, type:'van',   color:'#3f6fd8' },
  { name:'赵云', r:0, c:3, w:1, h:2, type:'van',   color:'#8a5cd8' },
  { name:'马超', r:2, c:0, w:1, h:2, type:'van',   color:'#d8992f' },
  { name:'黄忠', r:2, c:3, w:1, h:2, type:'van',   color:'#3fb0c8' },
  { name:'卒',   r:3, c:1, w:1, h:1, type:'mini',  color:'#9aa7b8' },
  { name:'卒',   r:3, c:2, w:1, h:1, type:'mini',  color:'#9aa7b8' },
  { name:'卒',   r:4, c:0, w:1, h:1, type:'mini',  color:'#9aa7b8' },
  { name:'卒',   r:4, c:3, w:1, h:1, type:'mini',  color:'#9aa7b8' },
];
const DIRS = [[0,-1],[0,1],[-1,0],[1,0]];

function makeModel(layout){
  const ps = layout.map((p, i) => ({ i, name:p.name, r:p.r, c:p.c, w:p.w, h:p.h, boss:!!p.boss }));
  return {
    ps,
    key(){ return ps.map(p => p.w + 'x' + p.h + '@' + p.r + ',' + p.c).sort().join('|'); },
    clone(){ return makeModel(ps.map(p => ({ name:p.name, r:p.r, c:p.c, w:p.w, h:p.h, boss:p.boss }))); },
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
        for(const [dr, dc] of DIRS){
          let n = 0;
          while(this.fits(p, p.r + dr, p.c + dc)){
            p.r += dr; p.c += dc; n++;
            out.push({ piece:p.i, dr, dc, n, to:{ r:p.r, c:p.c } });
          }
          for(let i = 0; i < n; i++){ p.r -= dr; p.c -= dc; }
        }
      }
      return out;
    },
    win(){ const b = ps.find(p => p.boss); return b.r === 3 && b.c === 1; },
  };
}
function bfs(layout){
  const start = makeModel(layout);
  const seen = new Set([start.key()]);
  const q = [{ m:start, d:0 }];
  let visited = 0;
  while(q.length){
    const cur = q.shift(); visited++;
    if(cur.m.win()) return { steps:cur.d, visited };
    for(const mv of cur.m.moves()){
      const nxt = cur.m.clone();
      const p = nxt.ps[mv.piece]; p.r = mv.to.r; p.c = mv.to.c;
      const k = nxt.key();
      if(seen.has(k)) continue;
      seen.add(k);
      q.push({ m:nxt, d:cur.d + 1 });
    }
  }
  return { steps:-1, visited };
}
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* 1) 先求经典局的终局 */
const classic = LAYOUT.map(p => Object.assign({}, p));
const classicSol = bfs(classic);
console.log('经典「横刀立马」最少步数 = ' + classicSol.steps + '（搜索 ' + classicSol.visited + ' 状态）');

function finalState(){
  const m = makeModel(LAYOUT);
  // 重新走一遍最短解拿终局
  const seen = new Set(); const q = [{ m, path: [] }];
  while(q.length){
    const cur = q.shift();
    if(cur.m.win()) return cur.m.ps.map(p => ({ name:p.name, r:p.r, c:p.c, w:p.w, h:p.h, boss:p.boss }));
    for(const mv of cur.m.moves()){
      const k = cur.m.key() + '|' + mv.piece + '|' + mv.to.r + ',' + mv.to.c;
      if(seen.has(k)) continue;
      seen.add(k);
      const nxt = cur.m.clone();
      const p = nxt.ps[mv.piece]; p.r = mv.to.r; p.c = mv.to.c;
      q.push({ m:nxt, path:null });
    }
  }
  return null;
}
const WIN = finalState();
console.log('通关终局（曹操在 ' + WIN.find(p => p.boss).r + ',' + WIN.find(p => p.boss).c + '）\n');

/* 2) 从终局做 BFS：每个状态的"深度"= 它的最少步数（移动可逆，图是对称的） */
function bfsFromWin(){
  const start = makeModel(WIN);
  const seen = new Map();
  const byDepth = {};
  const keyOf = m => m.key();
  const snap = m => m.ps.map(p => ({ r:p.r, c:p.c }));
  seen.set(keyOf(start), 0);
  byDepth[0] = [snap(start)];
  const q = [start];
  let maxD = 0;
  while(q.length){
    const cur = q.shift();
    const curD = seen.get(keyOf(cur));
    for(const mv of cur.moves()){
      const nxt = cur.clone();
      const p = nxt.ps[mv.piece]; p.r = mv.to.r; p.c = mv.to.c;
      const k = keyOf(nxt);
      if(seen.has(k)) continue;
      seen.set(k, curD + 1);
      (byDepth[curD + 1] = byDepth[curD + 1] || []).push(snap(nxt));
      q.push(nxt);
      if(curD + 1 > maxD) maxD = curD + 1;
    }
  }
  return { seen, byDepth, maxD, count: seen.size };
}

console.log('从终局 BFS（穷举整个可解空间）…');
const F = bfsFromWin();
console.log('可达状态 ' + F.count + ' 个，最深 ' + F.maxD + ' 步');
// 自检：经典横刀立马的深度必须等于它的最少步数
const classicKey = makeModel(LAYOUT).key();
const classicDepth = F.seen.get(classicKey);
console.log('自检：经典横刀立马在 BFS 里的深度 = ' + classicDepth + '（应等于其最少步数 ' + classicSol.steps + '）');
if(classicDepth !== classicSol.steps) { console.error('✗ 深度与最少步数不一致，退出'); process.exit(1); }

/** 取指定深度的第一个盘面（同一深度内挑"曹操离出口较远"的，盘面更好看） */
function pickAt(depth){
  const arr = F.byDepth[depth];
  if(!arr || !arr.length) return null;
  let best = null, bestScore = -1;
  for(const snap of arr){
    const boss = snap[0];                    // 曹操在 LAYOUT 里是第 0 个
    const score = Math.abs(boss.r - 3) * 2 + Math.abs(boss.c - 1);
    if(score > bestScore){ bestScore = score; best = snap; }
  }
  return best;
}

const PLAN = {
  intro:   [2, 4, 6, 9, 12, 16, 20, 26],          // 入门：精确最少步数依次递增
  classic: [40, 55, 70],                          // 古典：难关（外加经典横刀立马 90）
  mid:     [28, 30, 32, 34, 36, 38],              // 中级：比入门(≤26)难、比古典(≥40)易
};

const out = { sets: [ { id:'intro', name:'入门关卡', levels:[] },
                      { id:'classic', name:'古典关卡集', levels:[] },
                      { id:'mid', name:'中级关卡', levels:[] } ] };   // 中级先放末尾，最后再排到中间
const seenKeys = new Set();
function addTo(setId, name, layout, min, note){
  const key = layout.slice().map(p => p.r + ',' + p.c).sort().join('|');
  if(seenKeys.has(key)) return false;
  seenKeys.add(key);
  const set = out.sets.find(s => s.id === setId);
  set.levels.push({ id: set.levels.length + 1, name, min, note: note || '', layout });
  return true;
}

function addLevel(setId, name, snap, min, note){
  const layout = snap.map((s, i) => ({ i, r:s.r, c:s.c }));
  const key = layout.map(p => p.r + ',' + p.c).sort().join('|');
  if(seenKeys.has(key)) return false;
  seenKeys.add(key);
  const set = out.sets.find(s => s.id === setId);
  set.levels.push({ id: set.levels.length + 1, name, min, note: note || '', layout });
  return true;
}

console.log('\n生成入门关卡（按精确深度挑选）：');
for(const d of PLAN.intro){
  const snap = pickAt(d);
  if(!snap){ console.log('  深度 ' + d + ' 无盘面，跳过'); continue; }
  const layout = LAYOUT.map((p, i) => Object.assign({}, p, { r:snap[i].r, c:snap[i].c }));
  const check = bfs(layout);                       // ★ 独立再算一遍，交叉验证
  const name = '第 ' + (out.sets[0].levels.length + 1) + ' 关';
  if(addLevel('intro', name, snap, check.steps, '最少 ' + d + ' 步')) {
    console.log('  ' + name + '  目标深度 ' + String(d).padStart(2) + ' → 独立复算最少 ' +
                String(check.steps).padStart(2) + ' 步' + (check.steps === d ? ' ✓一致' : ' ✗不一致！'));
  }
}

console.log('\n生成古典关卡集：');
addLevel('classic', '横刀立马', WIN.map((p, i) => ({ r:p.r, c:p.c })), 0, '');
out.sets[1].levels.pop();                          // 上面只是占位，下面正式加
out.sets[1].levels.push({ id:1, name:'横刀立马', min:classicSol.steps, note:'经典布局（自算最少 ' + classicSol.steps + ' 步）',
                          layout: LAYOUT.map((p, i) => ({ i, r:p.r, c:p.c })) });
seenKeys.add(LAYOUT.map(p => p.r + ',' + p.c).sort().join('|'));
console.log('  横刀立马 → 经典布局，自算最少 ' + classicSol.steps + ' 步');
for(const d of PLAN.classic){
  const snap = pickAt(d);
  if(!snap){ console.log('  深度 ' + d + ' 无盘面，跳过'); continue; }
  const layout = LAYOUT.map((p, i) => Object.assign({}, p, { r:snap[i].r, c:snap[i].c }));
  const check = bfs(layout);
  const name = '古典难关 ' + out.sets[1].levels.length;
  if(addLevel('classic', name, snap, check.steps, '最少 ' + d + ' 步')) {
    console.log('  ' + name + '  目标深度 ' + String(d).padStart(2) + ' → 独立复算最少 ' +
                String(check.steps).padStart(2) + ' 步' + (check.steps === d ? ' ✓一致' : ' ✗不一致！'));
  }
}
out.sets[0].levels.sort((a, b) => a.min - b.min);                       // 入门按复算值严格递增
out.sets[0].levels.forEach((l, i) => { l.name = '第 ' + (i + 1) + ' 关'; l.note = '最少 ' + l.min + ' 步'; });
// ★ 经典「横刀立马」固定放古典集第 1 关（门面关），其余按难度升序
out.sets[1].levels.sort((a, b) => (a.name === '横刀立马' ? -1 : b.name === '横刀立马' ? 1 : a.min - b.min));
out.sets[1].levels.forEach((l, i) => { l.id = i + 1; l.name = l.name === '横刀立马' ? l.name : '古典难关 ' + (i + 1); });
out.sets[0].levels.forEach((l, i) => { l.id = i + 1; });

/* ---- 中级关卡（比入门难、比古典易）---- */
console.log('\n生成中级关卡：');
for(const d of PLAN.mid){
  const snap = pickAt(d);
  if(!snap){ console.log('  深度 ' + d + ' 无盘面，跳过'); continue; }
  const layout = LAYOUT.map((p, i) => Object.assign({}, p, { r:snap[i].r, c:snap[i].c }));
  const check = bfs(layout);                       // 独立复算
  const name = '第 ' + (out.sets[2].levels.length + 1) + ' 关';
  if(addLevel('mid', name, snap, check.steps, '最少 ' + d + ' 步'))
    console.log('  ' + name + '  目标深度 ' + String(d).padStart(2) + ' → 独立复算最少 ' +
                String(check.steps).padStart(2) + ' 步' + (check.steps === d ? ' ✓一致' : ' ✗不一致！'));
}
out.sets[2].levels.sort((a, b) => a.min - b.min);
out.sets[2].levels.forEach((l, i) => { l.name = '第 ' + (i + 1) + ' 关'; l.note = '最少 ' + l.min + ' 步'; });
out.sets[2].levels.forEach((l, i) => { l.id = i + 1; });

/* ---- 集顺序：入门 → 中级 → 古典 ---- */
out.sets = [out.sets[0], out.sets[2], out.sets[1]];

const file = path.join(__dirname, 'klotski_levels.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
console.log('\n已写入 ' + file);
for(const s of out.sets) console.log(s.name + ' ' + s.levels.length + ' 关（最少步数 ' + s.levels.map(l => l.min).join('/') + '）');
