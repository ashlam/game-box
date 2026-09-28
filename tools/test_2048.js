#!/usr/bin/env node
/**
 * 2048（经典 2048 玩法）逻辑回归测试
 *
 * 覆盖：
 *   1) 开局：2 个方块、值为 2 或 4、分数 0
 *   2) 合并：2+2=4、4+4=8 …… 得分 = 合并所得之和
 *   3) ★ 一次移动中每个方块最多合并一次（[2,2,2,2] 左移 → [4,4] 而不是 8）
 *   4) ★ 合并链规则（[2,2,4,0] 左移 → [4,4,0,0]，新合成的 4 不再与 4 合并）
 *   5) 上下左右四个方向都要对
 *   6) ★ 无效移动不生成新方块（经典规则）
 *   7) 生成概率：90% 是 2、10% 是 4
 *   8) 通关：合成 1024 → won，且可选择继续
 *   9) ★ 死局：满盘且无可合并 → 结束（且"无效滑动"也要触发，否则会卡死）
 *  10) 确定性：同种子 + 同输入 → 同结果
 *  11) 长跑 2000 步：不变量（值都是 2 的幂、格子与方块数一致、分数单调不减、无 NaN）
 *  12) 滑动输入映射：四方向 + 太短的滑动忽略
 *  13) 绘制冒烟：各种状态 × 各种窗口比例都不抛错
 *  14) 音效（FakeCtx 计数）
 *
 * 用法：node tools/test_1024.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', '2048', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 桩 ---------------- */
const gradient = { addColorStop() {} };
function mkCtx(){
  return new Proxy({}, {
    get(t, k){
      if(k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if(k in t) return t[k];
      return () => {};
    },
    set(t, k, v){ t[k] = v; return true; },
  });
}
function mkEl(tag){
  const set = new Set();
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, textContent: '', className: '', _html: '',
    children: [], onclick: null, clientWidth: 390, clientHeight: 660, width: 0, height: 0,
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) },
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ const i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); return c; },
    getBoundingClientRect(){ return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
                                      right: this.clientWidth, bottom: this.clientHeight }; },
    select() {}, setSelectionRange() {}, focus() {}, blur() {},
  };
  Object.defineProperty(el, 'innerHTML', { get(){ return el._html; }, set(v){ el._html = v; } });
  return el;
}
const els = {};
const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx(); els.cv = cvEl;
const stageEl = mkEl('div'); stageEl.clientWidth = 390; stageEl.clientHeight = 660; els.stage = stageEl;

const store = {};
let sndNodes = 0;        // 振荡器（音调）节点数
let noiseNodes = 0;      // 噪声源节点数
class FakeCtx {
  constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
  createOscillator(){
    return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} },
             connect(){}, start(){ sndNodes++; }, stop(){} };
  }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, value:0 }, connect(){} }; }
  createBuffer(ch, len){ return { numberOfChannels: ch, length: len, __sr: this.sampleRate,
                                  getChannelData: () => new Float32Array(len) }; }
  createBufferSource(){ return { buffer: null, connect(){}, start(){ noiseNodes++; }, stop(){} }; }
  createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} },
                                 Q:{ setValueAtTime(){} }, connect(){} }; }
  resume(){ this.state = 'running'; return Promise.resolve(); }
}
const allNodes = () => sndNodes + noiseNodes;
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => 1000 },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  localStorage: { getItem: k => (k in store ? store[k] : null),
                  setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl, addEventListener() {}, removeEventListener() {},
    documentElement: { scrollHeight: 660 }, body: mkEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
  },
  navigator: { userAgent: 'node-test' },
  location: { search: '' },
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 411; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2.625;
sandbox.window.AudioContext = FakeCtx;
sandbox.window.isSecureContext = false;
sandbox.window.screen = { width: 411, height: 915 };

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'g2048-inline.js' });

/* ---------------- 驱动 ---------------- */
const win = sandbox.window;
const R = () => win.__g2048();
const reset = seed => win.__g2048Reset(seed);
const move = dir => win.__g2048Move(dir);
const setGrid = arr => win.__g2048SetGrid(arr);
const swipe = (x1, y1, x2, y2, id) => win.__g2048Swipe(x1, y1, x2, y2, id);
const setScore = v => win.__g2048SetScore(v);
const DT = 1 / 60;
function run(n, dt = DT){ for(let i = 0; i < n; i++) win.__g2048Step(dt); }
function empty(){ return [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]; }
function nonZero(g){ let n = 0; for(const row of g) for(const v of row) if(v) n++; return n; }

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 1) 开局 ================= */
section('1) 开局');
{
  reset(1);
  const s = R();
  ok(s.gridSize === 4, '棋盘 4×4');
  ok(s.target === 2048, '目标 2048');
  ok(s.tiles.length === 2, '开局 2 个方块（实际 ' + s.tiles.length + '）');
  ok(s.score === 0 && s.moves === 0, '开局分数 0、移动 0 次');
  ok(s.tiles.every(t => t.v === 2 || t.v === 4), '开局方块都是 2 或 4');
  ok(!s.won && s.state === 'play', '开局未通关、状态 play');
  // 两个方块不能重叠
  const pos = new Set(s.tiles.map(t => t.r + ',' + t.c));
  ok(pos.size === s.tiles.length, '两个方块不重叠');
}

/* ================= 2) 基本合并 ================= */
section('2) 合并与得分');
{
  reset(2); setGrid([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  const before = R().score;
  move('left');
  const s = R();
  ok(s.grid[0][0] === 4, '2+2 → 4（在 [0][0]）', JSON.stringify(s.grid[0]));
  ok(s.score === before + 4, '得分 +4（合并所得）');
  ok(nonZero(s.grid) === 2, '移动后生成 1 个新方块（合并后的 4 + 新块 = 2）', 'count=' + nonZero(s.grid));

  reset(3); setGrid([[4,4,8,8],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  move('left');
  const t2 = R();
  ok(t2.grid[0][0] === 8 && t2.grid[0][1] === 16, '4+4→8 且 8+8→16');
  ok(t2.score === 8 + 16, '得分 = 8+16 = 24（实际 ' + t2.score + '）');
}

/* ================= 3) 一次移动每块只合并一次 ================= */
section('3) ★ 每个方块一次移动最多合并一次');
{
  reset(4); setGrid([[2,2,2,2],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  move('left');
  const s = R();
  ok(s.grid[0][0] === 4 && s.grid[0][1] === 4, '★ [2,2,2,2] 左移 → [4,4]（不是 8）', JSON.stringify(s.grid[0]));
  ok(s.score === 8, '得分 = 4+4 = 8（实际 ' + s.score + '）');

  reset(5); setGrid([[2,2,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  move('left');
  const s2 = R();
  ok(s2.grid[0][0] === 4 && s2.grid[0][1] === 2, '[2,2,2] 左移 → [4,2]（剩下的 2 不参与）', JSON.stringify(s2.grid[0]));
}

/* ================= 4) 合并链规则 ================= */
section('4) ★ 新合成的方块不再与同值合并');
{
  reset(6); setGrid([[2,2,4,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  move('left');
  const s = R();
  ok(s.grid[0][0] === 4 && s.grid[0][1] === 4, '★ [2,2,4] 左移 → [4,4]（不是 8）', JSON.stringify(s.grid[0]));
  ok(s.score === 4, '只算一次合并得分 4（实际 ' + s.score + '）');

  reset(7); setGrid([[4,2,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  move('left');
  const s2 = R();
  ok(s2.grid[0][0] === 4 && s2.grid[0][1] === 4, '[4,2,2] 左移 → [4,4]', JSON.stringify(s2.grid[0]));
}

/* ================= 5) 四个方向 ================= */
section('5) 上下左右方向正确');
{
  const dirs = [
    ['left',  [0,0,0,0,0,0,0,2], '左移后应在 [0][0]'],
    ['right', [0,0,0,0,2,0,0,0], '右移后应在 [0][3]'],
    ['up',    [0,0,0,2,0,0,0,0], '上移后应在 [0][0]'],
    ['down',  [2,0,0,0,0,0,0,0], '下移后应在 [3][0]'],
  ];
  // 用单个方块放在 [3][3]，各方向移动后检查落点
  const cases = [
    ['left',  3, 3, 3, 0],
    ['right', 3, 0, 3, 3],
    ['up',    3, 3, 0, 3],
    ['down',  0, 3, 3, 3],
  ];
  for(const [dir, r0, c0, r1, c1] of cases){
    reset(10); const g = empty(); g[r0][c0] = 2; setGrid(g); setScore(0);
    const before = R().tiles.find(t => t.v === 2);
    move(dir);
    const s = R();
    const t = s.tiles.filter(x => x.v === 2);
    const at = t.some(x => x.r === r1 && x.c === c1);
    ok(at, '方向 ' + dir + '：单个方块 (' + r0 + ',' + c0 + ') → (' + r1 + ',' + c1 + ')',
       JSON.stringify(s.tiles.map(x => [x.v, x.r, x.c])));
  }
}

/* ================= 6) 无效移动不生成 ================= */
section('6) ★ 无效移动不生成新方块');
{
  reset(11); setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,64]]);
  const s0 = R(); const cnt0 = nonZero(s0.grid);
  const ret = move('left');                       // 已经贴左且无可合并 → 无效
  const s1 = R();
  ok(ret === false, '无效移动返回 false');
  ok(nonZero(s1.grid) === cnt0, '★ 无效移动不生成新方块（' + cnt0 + ' → ' + nonZero(s1.grid) + '）');
  ok(s1.moves === s0.moves, '无效移动不计入移动次数');
}

/* ================= 7) 生成概率 ================= */
section('7) 生成概率 90% 2 / 10% 4');
{
  let twos = 0, fours = 0, other = 0;
  for(let i = 1; i <= 300; i++){
    reset(i);
    for(const t of R().tiles){ if(t.v === 2) twos++; else if(t.v === 4) fours++; else other++; }
  }
  const ratio = fours / (twos + fours);
  ok(other === 0, '只生成 2 或 4（无其它值）');
  ok(ratio > 0.05 && ratio < 0.18, '4 的比例约 10%（实测 ' + (ratio * 100).toFixed(1) + '%，样本 600）');
  ok(twos > fours * 3, '2 明显多于 4（' + twos + ' vs ' + fours + '）');
}

/* ================= 8) 通关 1024 ================= */
section('8) ★ 合成 2048 通关');
{
  reset(12); setGrid([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); setScore(0);
  ok(!R().won, '合之前未通关');
  move('left');
  const s = R();
  ok(s.grid[0][0] === 2048, '1024+1024 → 2048');
  ok(s.won === true, '★ 合成 2048 → 标记通关');
  ok(s.score === 2048, '得分 +2048（实际 ' + s.score + '）');
  ok((els.over.classList.contains('on')), '通关面板已弹出');
  // 继续玩
  els.overKeep.onclick();
  ok(R().state === 'play' && R().keepPlaying === true, '★ 可以"继续玩"（状态回到 play）');
  ok(R().won === true, '继续玩之后通关标记保留（不会反复弹窗）');
}

/* ================= 9) 死局 ================= */
section('9) ★ 死局判定');
{
  // 满盘但还有可合并 → 没死
  reset(13); setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,32]]);
  ok(win.__g2048HasMoves() === true, '满盘但右边有两个 32 可合并 → 还没死');
  // 满盘且无可合并 → 死
  reset(14); setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,64]]);
  ok(win.__g2048HasMoves() === false, '满盘且无可合并 → 无路可走');
  ok(R().state === 'play', '（此刻还没触发结束，等玩家尝试移动）');
  const ret = move('left');                       // ★ 无效移动也必须触发死局
  ok(ret === false, '无解时移动返回 false');
  ok(R().state === 'over', '★ 无解时玩家再滑动 → 判定结束（不会卡死没有任何反应）');
  ok(els.over.classList.contains('on'), '结束面板已弹出');
}

/* ================= 10) 确定性 ================= */
section('10) 确定性：同种子 + 同输入 → 同结果');
{
  const script = ['left','up','right','down','left','up','right','down','left','left'];
  const play = () => {
    reset(77);
    for(const d of script) move(d);
    const s = R();
    return { grid: s.grid, score: s.score, moves: s.moves, tiles: s.tiles.length, won: s.won };
  };
  const a = play(), b = play();
  ok(JSON.stringify(a) === JSON.stringify(b),
     '★ 两次同种子同输入完全一致（分数 ' + a.score + '、移动 ' + a.moves + '）',
     JSON.stringify(a.grid) + ' vs ' + JSON.stringify(b.grid));
  reset(78);
  ok(R().fieldSeed === 78, '重置使用指定种子');
}

/* ================= 11) 长跑不变量 ================= */
section('11) 长跑 2000 步不变量');
{
  // 用测试内部的可复现随机驱动
  function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const drv = mulberry32(2024);
  reset(99);
  const dirs = ['left','right','up','down'];
  let bad = 0, badSum = 0, badPow = 0, badScore = 0, maxTile = 0, lastScore = 0, games = 1, overs = 0;
  for(let i = 0; i < 2000; i++){
    if(R().state === 'over'){ reset(1000 + games); games++; overs++; lastScore = 0; continue; }   // ★ 换局要重置分数基准
    const d = dirs[Math.floor(drv() * 4)];
    move(d);
    run(8);                                        // 推进动画
    const s = R();
    if(s.tiles.length !== nonZero(s.grid)) badSum++;
    if(new Set(s.tiles.map(t => t.r + ',' + t.c)).size !== s.tiles.length) badSum++;
    for(const t of s.tiles){
      if(!Number.isFinite(t.v) || t.v < 2 || (t.v & (t.v - 1)) !== 0) badPow++;   // 必须是 2 的幂
      if(t.r < 0 || t.r > 3 || t.c < 0 || t.c > 3) bad++;
      maxTile = Math.max(maxTile, t.v);
    }
    if(s.score < lastScore) badScore++;
    lastScore = s.score;
    for(const row of s.grid) for(const v of row) if(!Number.isFinite(v) || v < 0) bad++;
  }
  ok(bad === 0, '坐标/数值始终合法（越界或非法值 ' + bad + ' 次）');
  ok(badSum === 0, '★ 方块数与棋盘非空格数始终一致（不一致 ' + badSum + ' 次）');
  ok(badPow === 0, '★ 所有方块值都是 2 的幂且 ≥2（违规 ' + badPow + ' 次）');
  ok(badScore === 0, '分数单调不减（倒退 ' + badScore + ' 次）');
  ok(maxTile >= 64, '长跑能自然合成到较大数字（最大 ' + maxTile + '）');
  ok(overs > 0, '长跑中出现过死局并正确结束（' + overs + ' 次）');
}

/* ================= 12) 滑动输入 ================= */
section('12) ★ 滑动输入映射');
{
  const mk = (r, c, v) => { const g = empty(); g[r][c] = v; return g; };
  const cases = [
    ['left',  [2,2,0,0], [4,0,0,0]],
    ['right', [2,2,0,0], [0,0,0,4]],
  ];
  // 用单块验证方向
  for(const [dir, r0, c0, r1, c1] of [['left',0,3,0,0], ['right',0,0,0,3], ['up',3,0,0,0], ['down',0,0,3,0]]){
    reset(30); setGrid(mk(r0, c0, 2));
    const W = R().W, H = R().H;
    const cx = W / 2, cy = H / 2;
    const dx = dir === 'left' ? -70 : dir === 'right' ? 70 : 0;
    const dy = dir === 'up' ? -70 : dir === 'down' ? 70 : 0;
    swipe(cx, cy, cx + dx, cy + dy, 1);
    const s = R();
    ok(s.tiles.some(t => t.v === 2 && t.r === r1 && t.c === c1),
       '滑动 ' + dir + ' → 方块落到 (' + r1 + ',' + c1 + ')',
       JSON.stringify(s.tiles.map(t => [t.v, t.r, t.c])));
  }
  // 太短的滑动忽略
  reset(31); setGrid(mk(0, 3, 2));
  const g0 = JSON.stringify(R().grid), n0 = R().tiles.length;
  swipe(R().W / 2, R().H / 2, R().W / 2 + 6, R().H / 2, 1);      // 只滑 6（< 22 阈值）
  const s = R();
  ok(JSON.stringify(s.grid) === g0 && s.tiles.length === n0,
     '★ 太短的滑动被忽略（阈值 ' + s.SWIPE_MIN + '）', 'grid=' + JSON.stringify(s.grid));
  ok(s.moves === 0, '被忽略的滑动不计移动次数');
  // 斜滑取主轴
  reset(32); setGrid(mk(0, 3, 2));
  swipe(R().W / 2, R().H / 2, R().W / 2 - 80, R().H / 2 + 30, 1);   // 横向占优 → left
  ok(R().tiles.some(t => t.v === 2 && t.r === 0 && t.c === 0), '斜向滑动取主轴方向（横 > 纵 → 左）');
}

/* ================= 13) 绘制冒烟 ================= */
section('13) ★ 绘制冒烟：各种状态 × 窗口比例都不抛错');
{
  const drawOk = () => { try{ win.__g2048Draw(); return null; }catch(e){ return String((e && e.message) || e); } };
  const cases = [];
  reset(40); cases.push(['开局', drawOk()]);
  setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,64]]);
  cases.push(['满盘大数字', drawOk()]);
  reset(41); move('left'); cases.push(['动画进行中', drawOk()]);
  run(10); cases.push(['动画结束', drawOk()]);
  reset(42); setGrid([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); move('left');
  cases.push(['通关瞬间', drawOk()]);
  reset(43); setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,64]]);
  move('left'); cases.push(['死局结束', drawOk()]);
  reset(44); cases.push(['提示卡显示中（moves=0）', drawOk()]);
  const sizes = [[390, 300], [390, 660], [760, 700]];
  const oW = els.stage.clientWidth, oH = els.stage.clientHeight;
  for(const [w, h] of sizes){
    els.stage.clientWidth = w; els.stage.clientHeight = h;
    win.__g2048Layout();
    cases.push(['窗口 ' + w + '×' + h, drawOk()]);
  }
  els.stage.clientWidth = oW; els.stage.clientHeight = oH;
  win.__g2048Layout();
  const bad = cases.filter(([, e]) => e);
  ok(bad.length === 0, '★ ' + cases.length + ' 种状态/窗口下 draw() 均不抛错',
     bad.map(([n, e]) => n + ': ' + e).join(' / '));
  // 棋盘必须始终是正方形且不出屏
  const s = R();
  ok(s.BOARD > 0 && s.CELL > 0, '棋盘与单元尺寸有效（板 ' + s.BOARD + ' / 单元 ' + s.CELL.toFixed(1) + '）');
  ok(s.BX >= 0 && s.BX + s.BOARD <= s.W + 1, '棋盘横向不出屏（' + s.BX + ' + ' + s.BOARD + ' ≤ ' + s.W.toFixed(0) + '）');
  ok(s.BY > s.HUD_H * 0.5 && s.BY + s.BOARD <= s.H + 1, '棋盘纵向在仪表台之下、且不出屏（BY=' + s.BY + '）');
}

/* ================= 14) 音效 ================= */
section('14) 音效（FakeCtx 计数）');
{
  reset(50); setGrid([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const n0 = sndNodes;
  win.__g2048Move('left');
  ok(sndNodes > n0, '合并有声（+' + (sndNodes - n0) + '）');
  reset(51); setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,32]]);
  const n1 = sndNodes;
  win.__g2048Move('right');
  ok(sndNodes >= n1, '普通滑动不报错（+' + (sndNodes - n1) + '）');
  reset(52); setGrid([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const n2 = sndNodes;
  win.__g2048Move('left');
  ok(sndNodes - n2 >= 3, '通关有音效（+' + (sndNodes - n2) + '）');
  // 静音
  els.btnSound.onclick();
  const n3 = sndNodes;
  reset(53); setGrid([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  win.__g2048Move('left');
  ok(sndNodes === n3, '关掉音效后完全不发声');
  els.btnSound.onclick();
  ok(R().soundOn === true, '重新打开音效');
}

/* ================= 15) ★ 快速连划不吞输入 ================= */
section('15) ★ 连续快速输入不被动画吞掉');
{
  reset(60); setGrid([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,2,0]]);
  // 动画进行中立刻再输入：必须立即生效（旧实现会被 anim.active 挡住返回 false）
  const r1 = move('left');
  const animAfter = R().animActive;
  const r2 = move('right');                        // 动画还在播
  const r3 = move('up');
  const r4 = move('down');
  ok(r1 === true, '第一次移动生效');
  ok(animAfter === true, '移动后确实进入动画状态');
  ok(r2 || r3 || r4, '★ 动画期间继续输入仍会被处理（不吞输入）', 'r2/r3/r4=' + [r2, r3, r4].join(','));
  // 连划 8 次，至少大部分生效
  reset(61); setGrid([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,2,0]]);
  const dirs = ['left','up','right','down','left','down','right','up'];
  let applied = 0;
  for(const d of dirs) if(move(d)) applied++;
  ok(applied >= 4, '★ 连续 8 次移动至少生效 4 次（实际 ' + applied + '）—— 快速连划不被吞');
}

/* ================= 16) ★ 音效补强 + 节奏放慢 ================= */
section('16) ★ 音效补强 + 动画节奏放慢');
{
  const c = win.__g2048Const();
  ok(c && c.ANIM_DUR >= 0.18, '★ 动画时长已放慢（' + (c && c.ANIM_DUR) + 's ≥ 0.18）');

  // 纯滑动（无合并）：应有 滑动 whoosh + 新块出现音
  reset(70); setGrid([[0,0,0,2],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const a0 = allNodes(); const nz0 = noiseNodes;
  move('left');
  const a1 = allNodes();
  ok(a1 - a0 >= 2, '★ 一次普通移动至少 2 个音效节点（滑动 + 新块），实际 +' + (a1 - a0));
  ok(noiseNodes > nz0, '★ 滑动用了噪声源（whoosh）');

  // 无效滑动：有"走不了"的反馈音
  reset(71); setGrid([[2,4,8,16],[32,64,128,256],[512,1024,2,4],[8,16,32,64]]);
  const b0 = allNodes();
  const ret = move('left');
  ok(ret === false, '（构造的是无效移动）');
  ok(allNodes() - b0 >= 2, '★ 无效滑动给出反馈音（+' + (allNodes() - b0) + '）');

  // 合并次数越多，音效节点越多（琶音）
  reset(72); setGrid([[2,2,8,8],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const c0 = sndNodes; move('left'); const two = sndNodes - c0;      // 两次合并
  reset(73); setGrid([[2,2,4,8],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const c1 = sndNodes; move('left'); const one = sndNodes - c1;      // 一次合并
  ok(two > one, '★ 合并次数越多音效越丰富（琶音）：两次合并 ' + two + ' 个节点 > 一次 ' + one + ' 个');

  // 大合并加低频垫（128 及以上）
  reset(74); setGrid([[64,64,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const d0 = sndNodes; move('left'); const big = sndNodes - d0;
  reset(75); setGrid([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const d1 = sndNodes; move('left'); const small = sndNodes - d1;
  ok(big > small, '★ 合成 128 的音效比合成 4 更厚（' + big + ' > ' + small + '）');

  // 动画节奏确实拉长
  reset(76); setGrid([[0,0,0,2],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  move('left');
  ok(R().animActive === true, '移动后进入动画状态');
  run(Math.max(1, Math.round(c.ANIM_DUR / DT) - 3));
  ok(R().animActive === true, '★ ' + c.ANIM_DUR + 's 动画未走完前仍在进行（节奏确实放慢）');
  run(7);
  ok(R().animActive === false, '动画按时结束');

  // 但快速连划仍然不被吞（节奏放慢后更关键）
  reset(77); setGrid([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,2,0]]);
  let applied = 0;
  for(const d of ['left','up','right','down','left','up']) if(move(d)) applied++;
  ok(applied >= 3, '★ 节奏放慢后连续输入依旧不被吞（6 次生效 ' + applied + ' 次）');
}

/* ================= 17) ★ 底部里程碑进度条 ================= */
section('17) ★ 底部里程碑进度条（2-4-8-…-1024-2048）');
{
  const bars = win.__g2048Bars();
  reset(80); setGrid([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  const s0 = R();
  ok(s0.milestones.length === 11 && s0.milestones[0] === 2 && s0.milestones[10] === 2048,
     '里程碑序列 = 2,4,8,…,1024,2048（11 档）', JSON.stringify(s0.milestones));

  reset(81);
  ok(R().litCount === 0, '★ 开局 11 盏全暗（0/11）');

  reset(82); setGrid([[4,4,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); move('left');
  let s = R();
  ok(s.maxEver === 8 && s.litCount === 3, '★ 合出 8 → 点亮 3 盏（2/4/8）', 'maxEver=' + s.maxEver + ' lit=' + s.litCount);

  setGrid([[8,8,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); move('left');
  s = R();
  ok(s.maxEver === 16 && s.litCount === 4, '★ 再合成 16 → 亮 4 盏（8 那盏不熄灭）');

  setGrid([[256,256,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); move('left');
  s = R();
  ok(s.maxEver === 512 && s.litCount === 9, '一次合出 512 → 2..512 共 9 盏连亮');

  reset(83);
  s = R();
  ok(s.litCount === 0 && s.maxEver === 0, '★ 开新一局 → 灯全部重新熄灭');

  reset(84); setGrid([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]); move('left');
  s = R();
  ok(s.maxEver === 2048 && s.litCount === 11, '★ 合成 2048 → 11 盏全亮');

  // 位置：必须在棋盘下方、且不出屏
  ok(s.BOT_H > 0 && bars.barY >= s.BY + s.BOARD - 0.5,
     '★ 里程碑条位于棋盘下方（条顶 ' + bars.barY.toFixed(0) + ' ≥ 棋盘底 ' + (s.BY + s.BOARD) + '）');
  ok(bars.barBottom <= s.H + 0.5, '里程碑条不出屏（底 ' + bars.barBottom.toFixed(0) + ' ≤ ' + s.H + '）');
  ok(s.BY + s.BOARD <= s.H - s.BOT_H + 0.5, '棋盘不侵入底条预留区');
  ok(s.BY > s.HUD_H * 0.5, '棋盘仍在仪表台之下（BY=' + s.BY + '）');

  // 多窗口比例下绘制不抛错
  const errs = [];
  for(const [w2, h2] of [[390,300],[390,660],[760,700]]){
    els.stage.clientWidth = w2; els.stage.clientHeight = h2; win.__g2048Layout();
    try{ win.__g2048Draw(); }catch(e){ errs.push(w2 + 'x' + h2 + ': ' + e.message); }
  }
  els.stage.clientWidth = 390; els.stage.clientHeight = 660; win.__g2048Layout();
  ok(errs.length === 0, '里程碑条在多种窗口比例下绘制不抛错', errs.join(' / '));
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
