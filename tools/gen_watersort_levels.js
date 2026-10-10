#!/usr/bin/env node
/**
 * 倒水分拣（Water Sort Puzzle / 倒水排序模拟）—— 求解器 + 关卡生成器
 *
 * 规则（与参考游戏一致）：
 *   · 每根试管容量固定（默认 4 格），管里是分层的颜色，互不融合
 *   · 点击 A 管把【顶部同色的一整段】倒入 B 管，一次倒水 = 1 步
 *   · 只能倒入「空管」或「顶部同色且还有空位」的管
 *   · 通关：每根非空管里只有一种颜色
 *
 * 求解器：BFS 求最少步数。关键优化 = 状态归一化（管的顺序无关 → 排序后做键），
 *         外加两条剪枝：①满管且纯色 → 不必再动 ②纯色管倒入空管 → 无意义
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CAP = 4;                       // 每管容量
const TIERS = [
  { id: 'easy',   name: '入门', stars: 1, colors: [3, 4],     empties: 2, lo: 3,  hi: 9,   count: 24 },
  { id: 'mid',    name: '进阶', stars: 2, colors: [5, 6],     empties: 2, lo: 10, hi: 17,  count: 24 },
  { id: 'hard',   name: '挑战', stars: 3, colors: [7, 8],     empties: 2, lo: 18, hi: 27,  count: 24 },
  { id: 'expert', name: '大师', stars: 4, colors: [9, 10, 11], empties: 2, lo: 28, hi: 999, count: 24 },
];

/* 颜色只存索引，游戏侧按索引取调色板 */
function key(tubes){
  // 管顺序无关 → 排序后拼串（空管统一表示为 ''）
  return tubes.map(t => t.join(',')).sort().join('|');
}
/**
 * 通关判定（★ 按参考游戏的目标"将每种颜色分别装入同一个试管"）：
 *   每根非空管必须【满管且纯色】—— 颜色守恒（每色 CAP 格），
 *   所以只要某色被拆到两根管里（例如 3+1），就不算完成。
 */
function isDone(tubes){
  return tubes.every(t => t.length === 0 ||
    (t.length === CAP && t.every(c => c === t[0])));
}
function topRun(t){
  if(!t.length) return 0;
  const c = t[t.length - 1];
  let n = 1;
  while(n < t.length && t[t.length - 1 - n] === c) n++;
  return n;
}
/** 枚举所有合法倒法 */
function moves(tubes){
  const out = [];
  for(let i = 0; i < tubes.length; i++){
    const a = tubes[i];
    if(!a.length) continue;
    const run = topRun(a), col = a[a.length - 1];
    // 剪枝①：满且纯色 → 已经整理好，不必再动
    if(a.length === CAP && run === CAP) continue;
    for(let j = 0; j < tubes.length; j++){
      if(i === j) continue;
      const b = tubes[j];
      if(b.length >= CAP) continue;
      if(b.length && b[b.length - 1] !== col) continue;
      // 剪枝②：纯色管倒入空管 → 无意义（换个位置而已）
      if(!b.length && run === a.length) continue;
      const k = Math.min(run, CAP - b.length);
      out.push({ i, j, k });
    }
  }
  return out;
}
function applyMove(tubes, mv){
  const nt = tubes.map(t => t.slice());
  for(let k = 0; k < mv.k; k++) nt[mv.j].push(nt[mv.i].pop());
  return nt;
}
/** BFS 最少步数；返回 {steps, path} 或 {steps:-1} 无解/超限 */
function solve(tubes, opts){
  opts = opts || {};
  const maxDepth = opts.maxDepth || 60;
  const maxStates = opts.maxStates || 400000;
  if(isDone(tubes)) return { steps: 0, path: [] };
  const seen = new Set([key(tubes)]);
  let frontier = [{ t: tubes, p: [] }];
  let depth = 0;
  while(frontier.length && depth < maxDepth){
    const next = [];
    depth++;
    for(const node of frontier){
      for(const mv of moves(node.t)){
        const nt = applyMove(node.t, mv);
        const k = key(nt);
        if(seen.has(k)) continue;
        const p = node.p.concat([mv]);
        if(isDone(nt)) return { steps: depth, path: p };
        seen.add(k);
        if(seen.size > maxStates) return { steps: -2 };
        next.push({ t: nt, p });
      }
    }
    frontier = next;
  }
  return { steps: -1 };
}
/** 用解法逐步回放，独立校验（第二次验证，防求解器出错） */
function verify(tubes, path){
  let t = tubes.map(x => x.slice());
  for(const mv of path){
    const legal = moves(t);
    if(!legal.some(m => m.i === mv.i && m.j === mv.j && m.k === mv.k)) return false;
    t = applyMove(t, mv);
  }
  return isDone(t);
}

function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** 由"已排好"状态洗牌生成一个盘面（保证颜色数量守恒：每色 CAP 格，另有 empties 根空管） */
function deal(rnd, nColors, empties){
  const bag = [];
  for(let c = 0; c < nColors; c++) for(let k = 0; k < CAP; k++) bag.push(c);
  // Fisher–Yates
  for(let i = bag.length - 1; i > 0; i--){
    const j = Math.floor(rnd() * (i + 1));
    const tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
  }
  const tubes = [];
  for(let i = 0; i < nColors; i++) tubes.push(bag.slice(i * CAP, i * CAP + CAP));
  for(let i = 0; i < empties; i++) tubes.push([]);
  return tubes;
}

function main(){
  const perTier = parseInt(process.argv[2] || '24', 10);
  const seed = parseInt(process.argv[3] || '20261009', 10);
  const rnd = mulberry32(seed);
  const sets = [];
  const used = new Set();
  const t0 = Date.now();
  for(const tier of TIERS){
    const made = [];
    const tt0 = Date.now();
    let tries = 0;
    while(made.length < Math.min(perTier, tier.count) && tries++ < 40000 && (Date.now() - tt0) < 120000){
      const nColors = tier.colors[Math.floor(rnd() * tier.colors.length)];
      const level = deal(rnd, nColors, tier.empties);
      if(isDone(level)) continue;
      const k0 = key(level);
      if(used.has(k0)) continue;
      const res = solve(level, { maxDepth: Math.max(40, tier.lo + 25) });
      if(res.steps < tier.lo || res.steps > tier.hi) continue;
      if(!verify(level, res.path)) continue;           // ★ 独立回放校验
      used.add(k0);
      made.push({ min: res.steps, colors: nColors, empties: tier.empties,
                  tubes: level.map(t => t.slice()),
                  sol: res.path.map(m => [m.i, m.j, m.k]) });   // ★ 存最优解法（给提示/自动演示用）
    }
    made.sort((a, b) => a.min - b.min);
    sets.push({ id: tier.id, name: tier.name, stars: tier.stars, cap: CAP,
                levels: made.map((m, i) => ({ id: i + 1, stars: tier.stars, min: m.min,
                  mobile: m.colors, colors: m.colors, empties: m.empties, tubes: m.tubes,
                  sol: m.sol })) });
    console.log('  %s: %d/%d 关 · 最少步数 %s · 用时 %ds', tier.name, made.length, perTier,
      made.map(m => m.min).join('/'), ((Date.now() - tt0) / 1000).toFixed(0));
  }
  const out = { cap: CAP, sets, source: '自研洗牌生成 + BFS 求最优 + 独立回放校验' };
  const p = path.join(__dirname, 'watersort_levels.json');
  fs.writeFileSync(p, JSON.stringify(out));
  console.log('已写入 %s · 总计 %d 关 · 总用时 %ds', p,
    sets.reduce((a, s) => a + s.levels.length, 0), ((Date.now() - t0) / 1000).toFixed(0));
}
module.exports = { CAP, TIERS, key, isDone, moves, applyMove, solve, verify, deal };
if(require.main === module) main();
