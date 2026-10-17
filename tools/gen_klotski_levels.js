#!/usr/bin/env node
/**
 * 生成华容道关卡集（tools/klotski_levels.json）
 *
 * 做法（可验证，不编造）：
 *   1. 用 BFS 求出经典「横刀立马」的最少步数（当作自检基准）
 *   2. 穷举经典局所在的整个可解空间（约 2.6 万个局面）
 *   3. ★ 华容道的"通关局面"不是唯一的：只要曹操左上角落在 (3,1) 就算赢，
 *      可解空间里有近千个这样的局面。所以这里用**多源 BFS** —— 把所有通关局面
 *      同时当作源点（0 步）向外扩散，每个局面的深度 = 它的真实最少步数。
 *      （早期版本只从单个终局扩散，深度会偏大，导致"声明 20 步、实测 15 步"的 bug。）
 *   4. 按目标深度挑盘面，每一关再用独立的 BFS 复算一次最少步数做交叉验证
 *   5. 关卡集：入门 30 关（≤30 步）· 中级 50 关（26~50 步）· 高级 40 关（38~70 步）· 古典
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
/** 独立求解：从某盘面 BFS 到任意胜利局面，返回真实最少步数（-1 = 无解） */
function bfs(layout){
  const start = makeModel(layout);
  const seen = new Set([start.key()]);
  const q = [{ m:start, d:0 }];
  let visited = 0;
  for(let qi = 0; qi < q.length; qi++){
    const cur = q[qi]; visited++;
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

const snapOf   = m => m.ps.map(p => ({ r:p.r, c:p.c }));
const keyOfSnap = sn => sn.map(p => p.r + ',' + p.c).sort().join('|');
/** 把"只含坐标的盘面"还原成模型（车型/名字沿用 LAYOUT 的顺序） */
const modelOf = sn => makeModel(LAYOUT.map((p, i) =>
  ({ name:p.name, r:sn[i].r, c:sn[i].c, w:p.w, h:p.h, boss:p.boss })));
const layoutOf = sn => LAYOUT.map((p, i) => Object.assign({}, p, { r:sn[i].r, c:sn[i].c }));

/* ---------- 1) 经典「横刀立马」的最少步数（自检基准） ---------- */
const classicSol = bfs(LAYOUT);
console.log('经典「横刀立马」最少步数 = ' + classicSol.steps + '（搜索 ' + classicSol.visited + ' 状态）');

/* ---------- 2) 穷举可解空间，顺便收集全部"通关局面" ---------- */
function enumerate(){
  const start = makeModel(LAYOUT);
  const seen = new Set([start.key()]);
  const q = [start];
  const wins = [];
  for(let qi = 0; qi < q.length; qi++){
    const cur = q[qi];
    if(cur.win()) wins.push(snapOf(cur));
    for(const mv of cur.moves()){
      const nxt = cur.clone();
      const p = nxt.ps[mv.piece]; p.r = mv.to.r; p.c = mv.to.c;
      const k = nxt.key();
      if(seen.has(k)) continue;
      seen.add(k);
      q.push(nxt);
    }
  }
  return { count: seen.size, wins };
}
console.log('穷举经典局所在的可解空间…');
const SPACE = enumerate();
console.log('可解局面 ' + SPACE.count + ' 个，其中"曹操已在出口"的通关局面 ' + SPACE.wins.length + ' 个');

/* ---------- 3) ★ 多源 BFS：所有通关局面同时作为源点 ---------- */
function bfsFromAllWins(wins){
  const seen = new Map();
  const byDepth = {};
  const q = [];
  for(const sn of wins){
    const m = modelOf(sn);
    const k = m.key();
    if(seen.has(k)) continue;
    seen.set(k, 0);
    (byDepth[0] = byDepth[0] || []).push(sn);
    q.push(m);
  }
  let maxD = 0;
  for(let qi = 0; qi < q.length; qi++){
    const cur = q[qi];
    const curD = seen.get(cur.key());
    for(const mv of cur.moves()){
      const nxt = cur.clone();
      const p = nxt.ps[mv.piece]; p.r = mv.to.r; p.c = mv.to.c;
      const k = nxt.key();
      if(seen.has(k)) continue;
      seen.set(k, curD + 1);
      (byDepth[curD + 1] = byDepth[curD + 1] || []).push(snapOf(nxt));
      q.push(nxt);
      if(curD + 1 > maxD) maxD = curD + 1;
    }
  }
  return { seen, byDepth, maxD, count: seen.size };
}
console.log('多源 BFS（所有通关局面 = 0 步）…');
const F = bfsFromAllWins(SPACE.wins);
console.log('可达局面 ' + F.count + ' 个，最深 ' + F.maxD + ' 步');

// 自检：经典横刀立马的多源深度必须等于它的最少步数
const classicKey = makeModel(LAYOUT).key();
const classicDepth = F.seen.get(classicKey);
console.log('自检：经典横刀立马的多源深度 = ' + classicDepth + '（应等于其最少步数 ' + classicSol.steps + '）');
if(classicDepth !== classicSol.steps){ console.error('✗ 深度与最少步数不一致，退出'); process.exit(1); }
if(F.count !== SPACE.count){ console.error('✗ 多源 BFS 覆盖面与穷举不一致，退出'); process.exit(1); }

/* ---------- 4) 关卡表结构 ---------- */
const SET_ORDER = ['intro', 'mid', 'high', 'classic'];
const out = { sets: [
  { id:'intro',   name:'入门关卡',   levels:[] },
  { id:'mid',     name:'中级关卡',   levels:[] },
  { id:'high',    name:'高级关卡',   levels:[] },
  { id:'classic', name:'古典关卡集', levels:[] },
] };
const seenKeys = new Set();

function addLevel(setId, snap, min, note){
  const layout = snap.map((s, i) => ({ i, r:s.r, c:s.c }));
  const key = keyOfSnap(snap);
  if(seenKeys.has(key)) return null;
  seenKeys.add(key);
  const set = out.sets.find(s => s.id === setId);
  const lv = { id: set.levels.length + 1, name: '第 ' + (set.levels.length + 1) + ' 关',
               min, note: note || ('最少 ' + min + ' 步'), layout };
  set.levels.push(lv);
  return lv;
}

/* ---------- 5) 按深度批量挑盘面（同一深度可挑多张，随机但不重复、可复现） ---------- */
const RNG = mulberry32(20261120);
function shuffled(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(RNG() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
/** 从指定深度里挑 want 张还没用过的盘面（不放宽到其它深度） */
function pickMany(depth, want){
  const arr = F.byDepth[depth];
  if(!arr || !arr.length) return [];
  const picked = [];
  for(const sn of shuffled(arr)){
    if(picked.length >= want) break;
    if(seenKeys.has(keyOfSnap(sn))) continue;
    picked.push(sn);
  }
  return picked;
}
/** 从某深度取 want 关：每关都独立复算，只有复算值等于目标深度才收下 */
function addFromDepth(setId, depth, want){
  const snaps = pickMany(depth, want + 4);
  let added = 0, bad = 0;
  for(const sn of snaps){
    if(added >= want) break;
    const check = bfs(layoutOf(sn));                        // ★ 独立复算
    if(check.steps !== depth){
      bad++;
      console.log('  ✗ 深度 ' + depth + ' 的盘面独立复算为 ' + check.steps + ' 步，丢弃');
      continue;
    }
    if(addLevel(setId, sn, check.steps)) added++;
  }
  if(added < want) console.log('  ⚠ 深度 ' + depth + ' 只取到 ' + added + '/' + want + ' 关（候选不足）');
  if(bad) console.log('  ⚠ 深度 ' + depth + ' 丢弃 ' + bad + ' 张不一致的盘面');
  return added;
}

/* ---------- 6) 古典集（盘面沿用现有 4 关，保证老存档对得上） ---------- */
const CLASSIC_POS = [
  { min:40, pos:[0,2,2,2,3,1,3,2,1,0,1,1,3,3,4,3,0,0,0,1] },
  { min:55, pos:[0,0,4,1,2,1,3,3,2,0,2,2,2,3,1,2,0,3,0,2] },
  { min:70, pos:[0,0,4,2,3,1,2,2,2,0,0,3,2,3,1,2,3,3,2,1] },
];
console.log('\n写入古典关卡集（沿用既有盘面）：');
{
  const sn = LAYOUT.map(p => ({ r:p.r, c:p.c }));
  const d = F.seen.get(classicKey);
  if(d !== classicSol.steps){ console.error('✗ 横刀立马深度异常'); process.exit(1); }
  const lv = addLevel('classic', sn, classicSol.steps, '经典布局（自算最少 ' + classicSol.steps + ' 步）');
  lv.name = '横刀立马';
  console.log('  横刀立马 → 最少 ' + classicSol.steps + ' 步');
  for(const c of CLASSIC_POS){
    const s2 = [];
    for(let i = 0; i < 10; i++) s2.push({ r:c.pos[i * 2], c:c.pos[i * 2 + 1] });
    const check = bfs(layoutOf(s2));
    const dep = F.seen.get(makeModel(layoutOf(s2)).key());
    if(check.steps !== c.min || dep !== c.min){
      console.error('✗ 古典难关复算 ' + check.steps + ' / 深度 ' + dep + '，与声明 ' + c.min + ' 不符，退出');
      process.exit(1);
    }
    addLevel('classic', s2, c.min);
    console.log('  古典难关 ' + out.sets.find(s => s.id === 'classic').levels.length +
                ' → 最少 ' + c.min + ' 步 ✓');
  }
}

/* ---------- 7) 各关卡集：按目标深度取盘面 ---------- */
const range = (a, b) => { const r = []; for(let d = a; d <= b; d++) r.push(d); return r; };

/* 入门 30 关：深度 2~30 每档 1 关，再在 30 步补 1 关（最难的放最后） */
const INTRO_DEPTHS = range(2, 30).concat([30]);
/* 中级 50 关：深度 26~50 每档 2 关 */
const MID_DEPTHS = range(26, 50).reduce((a, d) => a.concat([d, d]), []);
/* 高级 40 关：深度 38~70 每档 1 关，再在深水区（候选多）补 7 关 */
const HIGH_DEPTHS = range(38, 70).concat([56, 57, 62, 64, 66, 68, 70]);

console.log('\n生成入门关卡（' + INTRO_DEPTHS.length + ' 关，≤30 步）：');
for(const d of INTRO_DEPTHS) addFromDepth('intro', d, 1);

console.log('\n生成中级关卡（' + MID_DEPTHS.length + ' 关，26~50 步）：');
for(const d of MID_DEPTHS) addFromDepth('mid', d, 1);

console.log('\n生成高级关卡（' + HIGH_DEPTHS.length + ' 关，38~70 步）：');
for(const d of HIGH_DEPTHS) addFromDepth('high', d, 1);

/* ---------- 8) 排序 / 编号 / 命名 ---------- */
const BANDS = {
  intro:   { lo:2,  hi:30 },
  mid:     { lo:26, hi:50 },
  high:    { lo:38, hi:70 },
};
for(const id of ['intro', 'mid', 'high']){
  const set = out.sets.find(s => s.id === id);
  set.levels.sort((a, b) => a.min - b.min || a.layout[0].r - b.layout[0].r || a.layout[0].c - b.layout[0].c);
  set.levels.forEach((l, i) => { l.id = i + 1; l.name = '第 ' + (i + 1) + ' 关'; l.note = '最少 ' + l.min + ' 步'; });
}
// 古典：横刀立马固定第 1 关（门面关），其余按难度升序
{
  const set = out.sets.find(s => s.id === 'classic');
  set.levels.sort((a, b) => (a.name === '横刀立马' ? -1 : b.name === '横刀立马' ? 1 : a.min - b.min));
  set.levels.forEach((l, i) => { l.id = i + 1; if(l.name !== '横刀立马') l.name = '古典难关 ' + (i + 1); });
}

/* ---------- 9) 汇总 + 硬断言 + 落盘 ---------- */
const WANT = { intro:30, mid:50, high:40 };
let fail = 0;
for(const id of SET_ORDER){
  const set = out.sets.find(s => s.id === id);
  const mins = set.levels.map(l => l.min);
  const band = BANDS[id];
  if(WANT[id] && set.levels.length !== WANT[id]){
    console.error('✗ ' + set.name + ' 应有 ' + WANT[id] + ' 关，实际 ' + set.levels.length); fail = 1;
  }
  if(band && !mins.every(v => v >= band.lo && v <= band.hi)){
    console.error('✗ ' + set.name + ' 有越界步数：' + mins.join('/')); fail = 1;
  }
  if(!band && mins.some(v => !(v > 0))){ console.error('✗ ' + set.name + ' 步数异常'); fail = 1; }
  for(let i = 1; i < mins.length; i++) if(mins[i] < mins[i - 1] && set.id !== 'classic'){
    console.error('✗ ' + set.name + ' 难度倒退：' + mins.join('/')); fail = 1;
  }
  const keys = new Set(set.levels.map(l => l.layout.map(p => p.r + ',' + p.c).sort().join('|')));
  if(keys.size !== set.levels.length){ console.error('✗ ' + set.name + ' 内部有重复盘面'); fail = 1; }
}
if(out.sets.find(s => s.id === 'classic').levels[0].name !== '横刀立马'){
  console.error('✗ 古典第 1 关必须是横刀立马'); fail = 1;
}
if(fail){ console.error('✗ 关卡集校验失败'); process.exit(1); }

const file = path.join(__dirname, 'klotski_levels.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
console.log('\n已写入 ' + file);
for(const s of out.sets){
  const mins = s.levels.map(l => l.min);
  console.log(s.name + ' ' + s.levels.length + ' 关（' + mins[0] + '~' + mins[mins.length - 1] + ' 步）: ' + mins.join('/'));
}
