#!/usr/bin/env node
/**
 * 华容道「车阵」测试
 *
 * 重点（不靠传闻，自己算）：
 *   1) 经典「横刀立马」布局的坐标与空格位置
 *   2) ★ 内嵌 BFS 求该布局最少步数（规则：同一辆车朝一个方向滑动任意格 = 1 步），
 *      并把求出的解法**逐步回放进游戏**，验证游戏规则与求解器一致
 *   3) 移动规则：不能出界、不能压别的车、多格滑动可被空位截断
 *   4) 过关判定：曹操左上角到 (3,1)
 *   5) 拖动输入：1 格/多格/超长截断/被挡不生效/太短的忽略
 *   6) 键盘：选中后方向键移动
 *   7) 不变量：随机走 400 步，永远不重叠、不出界
 *   8) 绘制冒烟 / 音效 / 重置
 *
 * 用法：node tools/test_klotski.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'klotski', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 桩 ---------------- */
const gradient = { addColorStop() {} };
const mkCtx = () => new Proxy({}, {
  get(t, k){ if(k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient; if(k in t) return t[k]; return () => {}; },
  set(t, k, v){ t[k] = v; return true; },
});
const mkEl = tag => { const s = new Set(); return {
  tagName: tag, style: {}, textContent: '', className: '', children: [], clientWidth: 390, clientHeight: 700,
  classList: { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) },
  addEventListener(){}, appendChild(c){ this.children.push(c); return c; }, removeChild(c){ return c; },
  getBoundingClientRect(){ return { left: 0, top: 0, width: 390, height: 700 }; },
  select(){}, setSelectionRange(){}, focus(){},
}; };
const els = {};
const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx(); els.cv = cvEl;
const stageEl = mkEl('div'); stageEl.clientWidth = 390; stageEl.clientHeight = 700; els.stage = stageEl;
let sndNodes = 0, noiseNodes = 0;
class FakeCtx {
  constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
  createOscillator(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, connect(){}, start(){ sndNodes++; }, stop(){} }; }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, value:0 }, connect(){} }; }
  createBuffer(a, b){ return { getChannelData: () => new Float32Array(b) }; }
  createBufferSource(){ return { buffer: null, connect(){}, start(){ noiseNodes++; }, stop(){} }; }
  createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} }, Q:{ setValueAtTime(){} }, connect(){} }; }
  resume(){ this.state = 'running'; return Promise.resolve(); }
}
const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => 1000 }, requestAnimationFrame: () => 1,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: { getElementById: id => els[id] || (els[id] = mkEl('div')), createElement: mkEl, addEventListener(){},
              documentElement: { scrollHeight: 700 }, body: mkEl('body') },
  navigator: { userAgent: 'node-test' }, location: { search: '' },
};
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.window = sandbox;
sandbox.window.innerWidth = 411; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2.625;
sandbox.window.AudioContext = FakeCtx; sandbox.window.isSecureContext = false;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'klotski-inline.js' });
const win = sandbox.window;

const R = () => win.__klotski();
const DT = 1 / 60;
function run(n, dt = DT){ for(let i = 0; i < n; i++) win.__klotskiStep(dt); }
// ★ 默认关现在是入门第 1 关；原有用例都是按经典局写的 → 助手先切到古典第 1 关（横刀立马）
const reset = () => { win.__klotskiGoto(1, 0); };
const resetIntro = () => { win.__klotskiGoto(0, 0); };
const moveByName = (n, dr, dc, want) => win.__klotskiMoveByName(n, dr, dc, want);
const drag = (r, c, dr, dc) => win.__klotskiDrag(r, c, dr, dc);
const allNodes = () => sndNodes + noiseNodes;

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 模型无关的求解器（用来独立验证最少步数） ================= */
/** 布局：{name, r, c, w, h, boss}[]；规则：同一辆车朝一个方向滑动任意格 = 1 步 */
function makeModel(layout){
  const ps = layout.map((p, i) => ({ i, r: p.r, c: p.c, w: p.w, h: p.h, boss: !!p.boss }));
  return {
    ps,
    key(){ return ps.map(p => p.w + 'x' + p.h + '@' + p.r + ',' + p.c).sort().join('|'); },
    clone(){ return makeModel(ps.map((p, i) => ({ name: 'p' + i, r: p.r, c: p.c, w: p.w, h: p.h, boss: p.boss }))); },   // 复制成同样带方法的模型（保持索引顺序）
    fits(p, r, c){
      if(r < 0 || c < 0 || r + p.h > 5 || c + p.w > 4) return false;
      for(const q of ps){
        if(q === p) continue;
        if(r < q.r + q.h && q.r < r + p.h && c < q.c + q.w && q.c < c + p.w) return false;
      }
      return true;
    },
    moves(){
      const out = [];
      for(const p of ps){
        for(const [dr, dc] of [[0,-1],[0,1],[-1,0],[1,0]]){
          let n = 0;
          while(this.fits(p, p.r + dr, p.c + dc)){
            p.r += dr; p.c += dc; n++;
            out.push({ piece: p.i, r: p.r, c: p.c, dr, dc, n, snapshot: ps.map(q => ({ r: q.r, c: q.c })) });
          }
          for(let k = 0; k < n; k++){ p.r -= dr; p.c -= dc; }   // 复原
        }
      }
      return out;
    },
    win(){ const b = ps.find(p => p.boss); return !!b && b.r === 3 && b.c === 1; },
    restore(snap, pieceIdx, r, c){ snap.forEach((s, i) => { ps[i].r = s.r; ps[i].c = s.c; }); ps[pieceIdx].r = r; ps[pieceIdx].c = c; },
  };
}
/** BFS 求最少步数 + 一条最短解 */
function solve(layout){
  const start = makeModel(layout);
  const key0 = start.key();
  const seen = new Set([key0]);
  const q = [{ m: start, path: [] }];
  while(q.length){
    const cur = q.shift();
    if(cur.m.win()) return { steps: cur.path.length, path: cur.path };
    for(const mv of cur.m.moves()){
      const nxt = cur.m.clone();
      // 复制后第 mv.piece 块挪到目标位置
      const p = nxt.ps[mv.piece];
      p.r = mv.r; p.c = mv.c;
      const k = nxt.key();
      if(seen.has(k)) continue;
      seen.add(k);
      q.push({ m: nxt, path: cur.path.concat([{ piece: mv.piece, r: mv.r, c: mv.c, n: mv.n, dr: mv.dr, dc: mv.dc }]) });
    }
  }
  return null;
}

/* 与游戏一致的经典布局（独立写一份，避免"测试跟着实现错"） */
const CLASSIC = [
  { name:'曹操', r:0, c:1, w:2, h:2, boss:true },
  { name:'关羽', r:2, c:1, w:2, h:1 },
  { name:'张飞', r:0, c:0, w:1, h:2 },
  { name:'赵云', r:0, c:3, w:1, h:2 },
  { name:'马超', r:2, c:0, w:1, h:2 },
  { name:'黄忠', r:2, c:3, w:1, h:2 },
  { name:'卒1',  r:3, c:1, w:1, h:1 },
  { name:'卒2',  r:3, c:2, w:1, h:1 },
  { name:'卒3',  r:4, c:0, w:1, h:1 },
  { name:'卒4',  r:4, c:3, w:1, h:1 },
];

/* ================= 1) 初始布局 ================= */
section('1) 经典「横刀立马」初始布局');
{
  reset();
  const s = R();
  ok(s.COLS === 4 && s.ROWS === 5, '棋盘 4 列 × 5 行');
  ok(s.pieces.length === 10, '共 10 块棋子（实际 ' + s.pieces.length + '）');
  const byName = {};
  for(const p of s.pieces) byName[p.name] = p;
  ok(byName['曹操'] && byName['曹操'].w === 2 && byName['曹操'].h === 2 && byName['曹操'].r === 0 && byName['曹操'].c === 1,
     '曹操 2×2 在 (0,1)');
  ok(byName['关羽'] && byName['关羽'].w === 2 && byName['关羽'].h === 1 && byName['关羽'].r === 2 && byName['关羽'].c === 1,
     '关羽 横 2×1 在 (2,1)');
  const vans = s.pieces.filter(p => p.type === 'van');
  ok(vans.length === 4, '四员大将都是竖 1×2（' + vans.length + ' 块）');
  const minis = s.pieces.filter(p => p.type === 'mini');
  ok(minis.length === 4, '四卒都是 1×1（' + minis.length + ' 块）');
  // 车造型：四种车型都要出现
  const types = new Set(s.pieces.map(p => p.type));
  ok(types.has('bus') && types.has('sedan') && types.has('van') && types.has('mini'),
     '★ 车辆造型齐全：大客车/轿车/面包车/微型车（' + [...types].join('/') + '）');
  const colors = new Set(s.pieces.filter(p => p.type === 'van').map(p => p.color || ''));
  ok(true, '（颜色信息在渲染层，见绘制冒烟）');
  // 空格 = 底部中间两格
  const empty = [];
  for(let r = 0; r < 5; r++) for(let c = 0; c < 4; c++){
    if(!s.pieces.some(p => r >= p.r && r < p.r + p.h && c >= p.c && c < p.c + p.w)) empty.push(r + ',' + c);
  }
  ok(empty.length === 2 && empty.includes('4,1') && empty.includes('4,2'),
     '空格正好是底部中间两格 (4,1)(4,2)（= 出口）', empty.join(' '));
  ok(s.EXIT_C === 1 && s.EXIT_W === 2, '出口定义在底部中间两格');
  ok(s.WIN_R === 3 && s.WIN_C === 1, '过关条件：曹操左上角到 (3,1)');
  ok(s.steps === 0 && !s.won, '开局 0 步、未过关');
}

/* ================= 2) ★ BFS 最少步数 + 解法回放 ================= */
section('2) ★ BFS 求最少步数，并把解法回放进游戏验证');
let solution = null, minSteps = -1;
{
  const t0 = Date.now();
  solution = solve(CLASSIC);
  minSteps = solution ? solution.steps : -1;
  const ms = Date.now() - t0;
  ok(!!solution, 'BFS 找到解法（用时 ' + ms + 'ms）');
  ok(minSteps > 0, '★ 经典「横刀立马」最少步数 = ' + minSteps + ' 步（规则：同一辆车滑一次算 1 步）',
     'minSteps=' + minSteps);
  ok(minSteps > 40 && minSteps < 200, '★ 步数落在合理量级（40~200）');
  ok(minSteps === 90,
     '★ 最少步数自算结果 = 90（规则：同一辆车朝一个方向滑动任意格算 1 步；BFS 穷举，故为下界）',
     '实测 ' + minSteps + '；网上流传的"81 步"多为另一种计数口径，本游戏以自算口径为准');

  // 把解法逐步回放进游戏：每一步都要能走通，最后曹操到出口
  reset();
  let legal = true, badAt = -1;
  for(let i = 0; i < solution.path.length; i++){
    const mv = solution.path[i];
    // 求解器里的第 i 块 = 游戏里"当前占着该起点"的那块（同型车可互换，所以按位置找）
    const s = R();
    const model = makeModel(CLASSIC);
    // 重放前面已走的步，拿到本步开始时求解器的状态
    for(let j = 0; j < i; j++){
      const mj = solution.path[j];
      const p = model.ps[mj.piece]; p.r = mj.r; p.c = mj.c;
    }
    const p0 = model.ps[mv.piece];
    const src = { r: p0.r, c: p0.c };
    const gameP = s.pieces.find(q => src.r >= q.r && src.r < q.r + q.h && src.c >= q.c && src.c < q.c + q.w);
    if(!gameP){ legal = false; badAt = i; break; }
    const n = win.__klotskiMove(gameP.id, mv.dr, mv.dc, mv.n);
    if(n !== mv.n){ legal = false; badAt = i; break; }
    run(15);      // 推进动画
  }
  ok(legal, '★ 求解器的每一步在游戏里都能走通（' + solution.path.length + ' 步全部合法）', legal ? '' : '第 ' + badAt + ' 步失败');
  const s = R();
  ok(s.won && s.steps === minSteps,
     '★ 回放完成后游戏判定过关，步数与 BFS 一致（' + s.steps + ' 步）',
     'won=' + s.won + ' steps=' + s.steps);
  ok(s.best === minSteps, '最少步数已记录（best=' + s.best + '）');
}

/* ================= 3) 移动规则 ================= */
section('3) 移动规则');
{
  reset();
  // 曹操(0,1) 2×2 左侧是张飞 → 不能左移
  ok(win.__klotskiFits('曹操', 0, 0) === false, '曹操不能左移（被张飞挡住）');
  ok(win.__klotskiFits('曹操', 0, 2) === false, '曹操不能右移（被赵云挡住）');
  ok(win.__klotskiFits('曹操', 1, 1) === false, '曹操不能下移（被关羽挡住）');
  ok(win.__klotskiFits('曹操', -1, 1) === false, '曹操不能出上界');
  ok(win.__klotskiFits('关羽', 2, 1) === true, '关羽原地不冲突');
  ok(win.__klotskiFits('关羽', 2, 0) === false, '关羽不能左移（被马超挡住）');

  reset();
  const r0 = win.__klotskiMoveByName('卒', 0, -1, 1);       // (4,0) 的卒往左 → 出界
  ok(r0 === 0, '卒不能移出棋盘（返回 0 格）');
  const r1 = win.__klotskiMoveByName('卒', -1, 0, 2);       // (4,0) 的卒向上 2 格 → 被马超挡住
  ok(r1 === 0, '卒向上被马超挡住 → 走不动');

  // 关羽(2,1) 下方 (3,1)(3,2) 是两枚卒 → 不能下移
  reset();
  const down = win.__klotskiMoveByName('关羽', 1, 0, 1);
  ok(down === 0, '关羽下方被两枚卒挡住 → 不能下移');
  // 曹操(0,1) 与 (4,1)(4,2) 之间被关羽+卒占住 → 一步到不了底
  ok(win.__klotskiFits('曹操', 3, 1) === false, '曹操一步下不到出口（中间有阻挡）');
}

/* ================= 4) 过关判定 ================= */
section('4) 过关判定（曹操到出口）');
{
  reset();
  // 摆到出口位置，再手动触发判定（过关判定只在移动时跑，所以用测试钩子触发）
  win.__klotskiSetPiece('曹操', 3, 1);
  win.__klotskiCheckWin();
  run(2);
  const s1 = R();
  ok(s1.won === true && s1.state === 'won', '★ 曹操左上角到 (3,1) → 判定过关');
  ok(s1.steps === 0, '（人为摆放不计步）');
  ok(els.over.classList.contains('on'), '过关面板弹出');
  reset();
  ok(R().won === false && R().steps === 0, '重开一局：步数与过关状态清零');
}

/* ================= 5) 拖动输入 ================= */
section('5) ★ 拖动输入');
{
  // 1 格：把 (4,0) 的卒向上拖 → 被马超挡住 → 不动
  reset();
  drag(4, 0, 0, -1);
  run(20);
  ok(R().steps === 0, '打车往有阻挡的方向拖 → 不生效、不计步');
  // (4,1) 是空格；先看 (3,1) 的卒往下拖 1 格到 (4,1)
  reset();
  drag(3, 1, 0, 1);
  run(20);
  let s = R();
  ok(s.steps === 1 && s.pieces.some(p => p.name === '卒' && p.r === 4 && p.c === 1),
     '★ 拖动 1 格 → 卒从 (3,1) 挪到 (4,1)，计 1 步', 'steps=' + s.steps);
  // 多格：再把这个卒往上拖 2 格（(2,1) 是关羽 → 只能到 (3,1)）
  drag(4, 1, 0, -2);
  run(20);
  s = R();
  ok(s.steps === 2, '★ 一次拖 2 格但被挡 → 只走 1 格，仍算 1 步（步数 ' + s.steps + '）');
  // 太短的拖动被忽略（只当选中）
  const before = R().steps;
  drag(3, 1, 0, 0.2);
  run(10);
  ok(R().steps === before, '太短的拖动被忽略（不算移动）');
  // 方向取主轴：同时给横竖位移，横向更大 → 走横向
  reset();
  win.__klotskiSetPiece('卒', 3, 0);            // 空出 (3,1)，让 (3,2) 的卒能左移
  drag(3, 2, -1, 0.4);
  run(20);
  ok(R().pieces.some(p => p.r === 3 && p.c === 1 && p.type === 'mini'), '★ 斜拖时按主轴（横向占优 → 左移）');
  // 拖动不吞输入：动画未结束时再拖，仍生效
  reset();
  drag(3, 1, 0, 1); drag(3, 2, 0, 1); drag(4, 0, 0, 0);
  run(20);
  ok(R().steps >= 2, '★ 连续快速拖动不被动画吞掉（步数 ' + R().steps + '）');
}

/* ================= 6) 键盘 ================= */
section('6) 键盘：选中 + 方向键');
{
  reset();
  ok(win.__klotskiKeys('ArrowDown') === false, '没选中任何车时方向键无效（返回 false）');
  win.__klotskiSelect('关羽');
  const bad = win.__klotskiKeys('ArrowUp');     // 关羽(2,1) 上方是曹操
  ok(bad === 0, '选中的关羽向上被曹操挡住 → 走不动');
  reset();
  win.__klotskiSelect('卒');
  const okMove = win.__klotskiKeys('ArrowDown');
  ok(okMove === 0 || okMove === 1, '选中卒后方向键可移动（返回实际格数）');
}

/* ================= 7) 不变量：随机长走 ================= */
section('7) ★ 随机走 400 步的不变量');
{
  reset();
  function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const rnd = mulberry32(2026);
  let badOverlap = 0, badBounds = 0, badCount = 0, badArea = 0;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  for(let i = 0; i < 400; i++){
    const s = R();
    if(s.state !== 'play'){ win.__klotskiReset(); continue; }
    const p = s.pieces[Math.floor(rnd() * s.pieces.length)];
    const d = dirs[Math.floor(rnd() * 4)];
    win.__klotskiMove(p.id, d[0], d[1], 1 + Math.floor(rnd() * 2));
    run(12);
    const t = R();
    if(t.pieces.length !== 10) badCount++;
    let area = 0;
    for(const q of t.pieces){
      area += q.w * q.h;
      if(q.r < 0 || q.c < 0 || q.r + q.h > 5 || q.c + q.w > 4) badBounds++;
      for(const o of t.pieces){
        if(o.id === q.id) continue;
        if(q.r < o.r + o.h && o.r < q.r + q.h && q.c < o.c + o.w && o.c < q.c + q.w) badOverlap++;
      }
    }
    if(area !== 18) badArea++;      // 2×2 + 2×1 + 4×(1×2) + 4×1 = 4+2+8+4 = 18
  }
  ok(badCount === 0, '棋子数量恒为 10');
  ok(badBounds === 0, '★ 永远不出界（越界 ' + badBounds + ' 次）');
  ok(badOverlap === 0, '★ 永远不重叠（重叠 ' + badOverlap + ' 次）');
  ok(badArea === 0, '★ 总面积恒为 18 格（2×2+2×1+4×1×2+4×1）');
}

/* ================= 8) 绘制冒烟 ================= */
section('8) ★ 绘制冒烟：多状态 × 多窗口比例');
{
  const drawOk = () => { try{ win.__klotskiDraw(); return null; }catch(e){ return String((e && e.message) || e); } };
  const cases = [];
  reset(); cases.push(['初始', drawOk()]);
  win.__klotskiSelect('曹操'); cases.push(['选中曹操', drawOk()]);
  drag(3, 1, 0, 1); cases.push(['动画中', drawOk()]);
  run(20); cases.push(['动画结束', drawOk()]);
  win.__klotskiSetPiece('曹操', 3, 1); run(2); cases.push(['过关瞬间', drawOk()]);
  reset(); cases.push(['提示卡', drawOk()]);
  const oW = els.stage.clientWidth, oH = els.stage.clientHeight;
  for(const [w, h] of [[390, 300], [390, 660], [760, 700]]){
    els.stage.clientWidth = w; els.stage.clientHeight = h;
    win.__klotskiLayout();
    cases.push(['窗口 ' + w + '×' + h, drawOk()]);
  }
  els.stage.clientWidth = oW; els.stage.clientHeight = oH; win.__klotskiLayout();
  const bad = cases.filter(([, e]) => e);
  ok(bad.length === 0, '★ ' + cases.length + ' 种状态/窗口下 draw() 均不抛错', bad.map(([n, e]) => n + ': ' + e).join(' / '));
  const s = R();
  ok(s.CELL > 10 && s.BOARD > 40, '格子尺寸有效（单元 ' + s.CELL + '，盘 ' + s.BOARD + '）');
  ok(s.BX >= 0 && s.BX + s.CELL * 4 <= s.W + 1, '棋盘横向不出屏（' + s.BX + ' + ' + (s.CELL * 4) + ' ≤ ' + s.W.toFixed(0) + '）');
  ok(s.BY > 0 && s.BY + s.BOARD <= s.H + 1, '棋盘纵向不出屏（BY=' + s.BY + '）');
}

/* ================= 9) 音效 / 重置 ================= */
section('9) 音效与重置');
{
  reset();
  const a = allNodes();
  drag(3, 1, 0, 1); run(5);
  ok(allNodes() > a, '移动有音效（+' + (allNodes() - a) + '）');
  const b = allNodes();
  drag(4, 0, 0, -1); run(5);
  ok(allNodes() > b, '被挡住有反馈音（+' + (allNodes() - b) + '）');
  els.btnSound.onclick();
  const c = allNodes();
  drag(3, 2, 0, 1); run(5);
  ok(allNodes() === c, '关掉音效后完全不发声');
  els.btnSound.onclick();
  ok(R().soundOn === true, '重新打开音效');
  ok(store['gklotski_sound'] !== undefined, '音效偏好已落盘');
}

/* ================= 10) ★ 关卡集：每关都可解且步数属实 ================= */
section('10) ★ 关卡集：每一关都可解，最少步数与声明一致');
{
  const sets = win.__klotskiAllLevels();
  const s0 = R();
  ok(sets.length === 2, '两套关卡集（' + s0.setNames.join(' / ') + '）');
  ok(sets[0].length >= 6 && sets[1].length >= 3,
     '关卡数：' + s0.setNames[0] + ' ' + sets[0].length + ' 关 · ' + s0.setNames[1] + ' ' + sets[1].length + ' 关');
  const flat = sets.flat();
  const t0 = Date.now();
  const mismatched = [], unsolvable = [];
  function solveModel(start){
    const seen = new Set([start.key()]);
    const q = [{ m: start, d: 0 }];
    while(q.length){
      const cur = q.shift();
      if(cur.m.win()) return cur.d;
      for(const mv of cur.m.moves()){
        const nxt = cur.m.clone();
        if(!nxt.ps || !nxt.ps[mv.piece]) continue;
        const p = nxt.ps[mv.piece]; p.r = mv.r; p.c = mv.c;
        const k = nxt.key();
        if(seen.has(k)) continue;
        seen.add(k);
        q.push({ m: nxt, d: cur.d + 1 });
      }
    }
    return -1;
  }
  for(const lv of flat){
    let mk = null;
    try{ mk = win.__klotskiMakeModel(lv.pos); }
    catch(e){ console.log('    [诊断] __klotskiMakeModel 抛错 (' + lv.name + '): ' + e.message); unsolvable.push(lv.name); continue; }
    if(!Array.isArray(mk) || mk.length !== 10 || mk.some(p => !p || typeof p.r !== 'number' || typeof p.c !== 'number')){
      console.log('    [诊断] 关卡 ' + lv.name + ' (' + lv.set + '#' + lv.idx + ') pos=' + JSON.stringify(lv.pos) +
                  ' → 模型 ' + JSON.stringify(mk));
      unsolvable.push(lv.name + '(数据坏)'); continue;
    }
    let r = -1;
    try{ r = solveModel(makeModel(mk)); }
    catch(e){ console.log('    [诊断] 求解抛错 (' + lv.name + '): ' + e.message + ' | ' + e.stack.split('\n')[1]); unsolvable.push(lv.name); continue; }
    if(r < 0) unsolvable.push(lv.name);
    else if(r !== lv.min) mismatched.push(lv.name + '(声明 ' + lv.min + ' / 实测 ' + r + ')');
  }
  ok(unsolvable.length === 0, '★ 全部 ' + flat.length + ' 关都有解', unsolvable.join(' / '));
  ok(mismatched.length === 0,
     '★ 全部 ' + flat.length + ' 关：独立 BFS 复算最少步数 = 关卡声明值（用时 ' + (Date.now() - t0) + 'ms）',
     mismatched.join(' / '));

  const intro = sets[0].map(l => l.min);
  const classic = sets[1].map(l => l.min);
  ok(intro.every((v, i) => i === 0 || v >= intro[i - 1]), '★ 入门难度不倒退：' + intro.join(' → '));
  ok(intro[0] <= 4, '第 1 关足够简单（最少 ' + intro[0] + ' 步）');
  ok(Math.max.apply(null, intro) <= 30, '入门最难关 ≤ 30 步（实际 ' + Math.max.apply(null, intro) + '）');
  ok(classic.indexOf(90) >= 0, '★ 古典关卡集含经典横刀立马（最少 90 步）');
  ok(classic.every(v => v >= 30), '古典集都是难关（≥30 步：' + classic.join('/') + '）');

  resetIntro();
  let s = R();
  ok(s.setId === 0 && s.lvIdx === 0, '切到入门第 1 关');
  ok(s.levelMin === intro[0], '当前关最少步数跟随关卡（' + s.levelMin + ' 步）');
  reset();
  s = R();
  ok(s.setId === 1 && s.lvIdx === 0, '切回古典第 1 关');
  const b2 = s.pieces.find(p => p.boss);
  ok(b2.r === 0 && b2.c === 1, '横刀立马：曹操回到 (0,1)');
  ok(s.levelMin === 90, '横刀立马声明最少 90 步');
  win.__klotskiSetPiece('曹操', 3, 1);
  win.__klotskiCheckWin();
  ok(store['gklotski_cleared_classic_1'] === '1', '★ 过关记录按 关卡集_关号 分区存档');
  ok(store['gklotski_best_classic_1'] !== undefined, '本关最少步数单独记录');
  ok(store['gklotski_best_intro_1'] === undefined, '不同关卡记录互不干扰');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
