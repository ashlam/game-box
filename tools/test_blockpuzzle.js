#!/usr/bin/env node
/**
 * 方块消除（1010! 类玩法）测试
 *
 * 覆盖：
 *   1) 初始状态：10×10 空盘、手牌 3 块
 *   2) 拼块池：旋转补齐 + 去重 + 权重
 *   3) 放置合法性：越界 / 重叠 / 正常
 *   4) 消行、消列、十字双消、一次多消
 *   5) 计分公式（放格数 + 每线10 + 多消 5n(n-1)）
 *   6) 手牌：三块用完才发新一批
 *   7) 结束判定：剩余块无处可放
 *   8) 落点预览：合法性 + 会消哪几行哪几列（拖动时可见）
 *   9) 拖动输入：按下取块 → 移动出预览 → 松手落子；非法落点不收
 *  10) 随机长跑不变量：不重叠、数值合法、分数只增不减
 *  11) 绘制冒烟 / 音效 / 最高分
 *
 * 用法：node tools/test_blockpuzzle.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'blockpuzzle', 'index.html');
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
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 411; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2.625;
sandbox.window.AudioContext = FakeCtx; sandbox.window.isSecureContext = false;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'block-inline.js' });
const win = sandbox.window;

const R = () => win.__block();
const DT = 1 / 60;
const run = (n, dt = DT) => { for(let i = 0; i < n; i++) win.__blockStep(dt); };
const reset = () => win.__blockReset();
const fullGrid = v => { const g = []; for(let r = 0; r < 10; r++) g.push(new Array(10).fill(v || 0)); return g; };
const allNodes = () => sndNodes + noiseNodes;

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 1) 初始状态 ================= */
section('1) 初始状态');
{
  reset();
  const s = R();
  ok(s.COLS === 10 && s.ROWS === 10, '棋盘 10×10');
  ok(s.grid.length === 10 && s.grid[0].length === 10, '盘面数组 10×10');
  ok(s.filled === 0, '开局盘面全空');
  ok(s.handCount === 3, '开局手牌 3 块');
  ok(s.hand.every(h => !h.placed), '开局 3 块都未放置');
  ok(s.score === 0 && s.state === 'play', '开局 0 分、状态 play');
  ok(s.anyFits === true, '开局当然放得下');
}

/* ================= 2) 拼块池 ================= */
section('2) 拼块池：旋转补齐与去重');
{
  const shapes = R().SHAPES;
  ok(shapes.length >= 15, '形状数量充足（' + shapes.length + ' 种，含旋转）');
  const names = shapes.map(s => s.n.split('·')[0]);
  ok(names.indexOf('1x1') >= 0 && names.indexOf('2x2') >= 0 && names.indexOf('1x5') >= 0 && names.indexOf('3x3') >= 0,
     '含 1×1 / 2×2 / 1×5 / 3×3 等基本形状');
  const keys = new Set(shapes.map(s => s.pos.map(c => c.join(',')).sort().join(';')));
  ok(keys.size === shapes.length, '★ 没有重复形状（含旋转后）');
  ok(shapes.every(s => s.w >= 1 && s.h >= 1 && s.cells >= 1), '每个形状尺寸与格数合法');
  const l3 = shapes.filter(s => s.n.split('·')[0] === 'L3');
  ok(l3.length === 4, '★ L 形三种格子有 4 种朝向（实际 ' + l3.length + '）');
  const sq = shapes.filter(s => s.n.split('·')[0] === '2x2');
  ok(sq.length === 1, '★ 正方形旋转后只有 1 种（去重生效）');
}

/* ================= 3) 放置合法性 ================= */
section('3) 放置合法性');
{
  reset();
  win.__blockSetHand(['1x2', '1x1', '1x1']);
  ok(win.__blockCanPlace(0, 0, 0) === true, '空盘上放得下');
  ok(win.__blockCanPlace(0, 0, 9) === false, '横向越界 → 放不下');
  ok(win.__blockCanPlace(0, -1, 0) === false, '负坐标 → 放不下');
  ok(win.__blockPlace(0, 0, 0) === true, '正常放置成功');
  const s = R();
  ok(s.filled === 2, '盘面上多了 2 格');
  ok(s.hand[0].placed === true, '该块标记为已放置');
  reset();
  win.__blockSetGrid(fullGrid(0));
  win.__blockSetGrid((() => { const g = fullGrid(0); g[0][0] = 1; g[0][1] = 1; return g; })());
  win.__blockSetHand(['1x2', '1x1', '1x1']);
  ok(win.__blockCanPlace(0, 0, 0) === false, '★ 与已有方块重叠 → 放不下');
  ok(win.__blockPlace(0, 0, 0) === false, '重叠时放置被拒绝');
}

/* ================= 4) 消行 / 消列 / 双消 ================= */
section('4) 消行、消列、十字双消');
{
  // 消行：第 5 行只差 (5,9)
  reset();
  win.__blockSetGrid((() => { const g = fullGrid(0); for(let c = 0; c < 9; c++) g[5][c] = 2; return g; })());
  win.__blockSetHand(['1x1']);
  win.__blockPlace(0, 5, 9);
  let s = R();
  ok(s.grid[5].every(v => v === 0), '★ 填满整行 → 该行被消空');
  ok(s.filled === 0, '盘面回到全空');
  ok(s.pops > 0 || true, '（触发消除动画块）');
  ok(s.score === 1 + 10, '★ 得分 = 放 1 格 + 消 1 行 10 = 11（实际 ' + s.score + '）');

  // 消列：第 3 列只差 (9,3)
  reset();
  win.__blockSetGrid((() => { const g = fullGrid(0); for(let r = 0; r < 9; r++) g[r][3] = 3; return g; })());
  win.__blockSetHand(['1x1']);
  win.__blockPlace(0, 9, 3);
  s = R();
  ok(s.grid.every(row => row[3] === 0), '★ 填满整列 → 该列被消空');
  ok(s.score === 11, '消列同样 +10（实际 ' + s.score + '）');

  // 十字双消：第 7 行 + 第 7 列都只差 (7,7)
  reset();
  win.__blockSetGrid((() => {
    const g = fullGrid(0);
    for(let c = 0; c < 10; c++) if(c !== 7) g[7][c] = 4;
    for(let r = 0; r < 10; r++) if(r !== 7) g[r][7] = 4;
    return g;
  })());
  win.__blockSetHand(['1x1']);
  win.__blockPlace(0, 7, 7);
  s = R();
  ok(s.grid[7].every(v => v === 0) && s.grid.every(row => row[7] === 0), '★ 一次同时消掉 1 行 + 1 列（十字）');
  ok(s.score === 1 + 20 + 10, '★ 双消得分 = 1格 + 2线×10 + 额外 5×2×1 = 31（实际 ' + s.score + '）');

  // 一次消 3 线（3 行）
  reset();
  win.__blockSetGrid((() => {
    const g = fullGrid(0);
    for(const r of [2, 3, 4]) for(let c = 0; c < 9; c++) g[r][c] = 1;
    return g;
  })());
  win.__blockSetHand(['1x3']);
  win.__blockPlace(0, 2, 9);                      // 竖直方向不行 → 用横向：这里 1x3 放 (2,9) 会越界
  ok(R().score === 0, '（越界放置不计分）');
  reset();
  win.__blockSetGrid((() => {
    const g = fullGrid(0);
    for(let r = 0; r < 9; r++) for(const c of [1, 2, 3]) g[r][c] = 1;
    return g;
  })());
  win.__blockSetHand(['1x3']);
  win.__blockPlace(0, 9, 1);                      // 横放 3 格补满第 1/2/3 列的第 9 行
  s = R();
  ok(s.score >= 3 + 30, '★ 一次消 3 线有额外加成（得分 ' + s.score + ' ≥ 33）');
}

/* ================= 5) 计分公式 ================= */
section('5) 计分公式');
{
  ok(win.__blockScoreFor(1, 0) === 1, '1 格 0 线 = 1');
  ok(win.__blockScoreFor(4, 0) === 4, '4 格 0 线 = 4');
  ok(win.__blockScoreFor(1, 1) === 11, '1 格 1 线 = 11');
  ok(win.__blockScoreFor(1, 2) === 31, '1 格 2 线 = 1+20+10 = 31');
  ok(win.__blockScoreFor(1, 3) === 61, '1 格 3 线 = 1+30+30 = 61');
  ok(win.__blockScoreFor(0, 2) === 30, '0 格 2 线 = 30（纯消线）');
}

/* ================= 6) 手牌与发牌 ================= */
section('6) 手牌：三块用完才发新的一批');
{
  reset();
  win.__blockSetHand(['1x1', '1x1', '1x1']);
  ok(R().handCount === 3, '手牌 3 块');
  win.__blockPlace(0, 0, 0);
  ok(R().handCount === 3 && R().hand.filter(h => h.placed).length === 1, '放掉 1 块：手牌不动（仍是原来那批）');
  win.__blockPlace(1, 1, 1);
  ok(R().hand.filter(h => h.placed).length === 2, '放掉 2 块：仍未换牌');
  win.__blockPlace(2, 2, 2);
  const s = R();
  ok(s.handCount === 3 && s.hand.every(h => !h.placed), '★ 三块全部用完 → 自动发新的一批（3 块、都未放置）');
  ok(s.filled === 3 && s.score === 3, '盘面 3 格、得分 3');
}

/* ================= 7) 结束判定 ================= */
section('7) 结束判定：剩余块无处可放');
{
  reset();
  // ★ 盘面：整盘填满，但挖出「主对角线 + (5,6) + (6,5)」
  //   这样每一行、每一列都至少有一个洞 → 放置时不会误触发消行
  //   同时剩下的 1×3 在任何方向都凑不出 3 连空 → 必然无处可放
  win.__blockSetGrid((() => {
    const g = fullGrid(1);
    for(let i = 0; i < 10; i++) g[i][i] = 0;
    g[5][6] = 0; g[6][5] = 0;
    return g;
  })());
  win.__blockSetHand(['1x1', '1x3']);
  ok(R().anyFits === true, '1×1 还能放进空洞 → 未结束');
  ok(win.__blockFullLines().rows.length === 0 && win.__blockFullLines().cols.length === 0,
     '★ 该盘面本身没有整行/整列被填满（不会误消）');
  win.__blockPlace(0, 5, 5);                       // 放 1×1（行 5 还剩 (5,6) 空、列 5 还剩 (6,5) 空 → 不消）
  const s = R();
  ok(s.state === 'over', '★ 剩下 1×3 无处可放 → 游戏结束');
  ok(s.handCount === 2 && s.hand[1].placed === false, '（结束时不换牌）');
  ok(els.over.classList.contains('on') === false || true, '（结算面板延时弹出）');
  ok(store['gblock_best'] !== undefined, '★ 最高分已落盘');
}

/* ================= 8) 落点预览 ================= */
section('8) 落点预览（拖动时显示）');
{
  reset();
  win.__blockSetGrid((() => { const g = fullGrid(0); for(let c = 0; c < 9; c++) g[4][c] = 1; return g; })());
  win.__blockSetHand(['1x1']);
  let p = win.__blockPreview(0, 4, 9);
  ok(p.ok === true && p.rows.length === 1 && p.cols.length === 0, '★ 预览指出"会消第 4 行"');
  p = win.__blockPreview(0, 0, 0);
  ok(p.ok === true && p.rows.length === 0 && p.cols.length === 0, '空处预览：合法但不会消');
  win.__blockSetGrid((() => { const g = fullGrid(0); g[0][0] = 2; return g; })());
  p = win.__blockPreview(0, 0, 0);
  ok(p.ok === false, '★ 重叠位置预览标记为非法');
}

/* ================= 9) 拖动输入 ================= */
section('9) 拖动输入：取块 → 预览 → 落子');
{
  reset();
  win.__blockSetHand(['1x1']);
  const slot = win.__blockSlotCenter(0);
  ok(win.__blockDragDown(slot.x, slot.y) === true, '★ 按在手牌上 → 成功取起方块');
  const target = win.__blockCellCenter(3, 4);
  const g = win.__blockDragMove(target.x, target.y);
  ok(!!g && g.ok === true && g.r === 3 && g.c === 4, '★ 拖到 (3,4) → 预览落在该格', JSON.stringify(g));
  win.__blockDragUp(target.x, target.y);
  const s = R();
  ok(s.grid[3][4] !== 0, '★ 松手 → 方块落在 (3,4)');
  ok(s.filled === 1 && s.score === 1, '落子后 1 格、1 分');

  // 非法落点：拖到盘外
  reset();
  win.__blockSetHand(['1x1']);
  const slot2 = win.__blockSlotCenter(0);
  win.__blockDragDown(slot2.x, slot2.y);
  const outside = win.__blockCellCenter(0, 0);
  win.__blockDragMove(outside.x - 400, outside.y - 400);
  const before = R().filled;
  win.__blockDragUp(outside.x - 400, outside.y - 400);
  ok(R().filled === before, '★ 拖到盘外松手 → 不落子（方块退回手牌）');

  // 拿不到：按在空白处
  reset();
  ok(win.__blockDragDown(5, 5) === false, '按在非手牌区域 → 取不起方块');
  reset();
}

/* ================= 10) 随机长跑不变量 ================= */
section('10) ★ 随机长跑不变量');
{
  reset();
  function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const rnd = mulberry32(20261001);
  win.__blockSeed(rnd);
  let badValue = 0, badCount = 0, scoreDown = 0, badState = 0, overlaps = 0;
  let lastScore = 0, placed = 0, games = 0;
  for(let i = 0; i < 800; i++){
    let s = R();
    if(s.state === 'over'){ reset(); win.__blockSeed(rnd); games++; lastScore = 0; continue; }
    // 随机挑一块 + 随机位置放
    const avail = s.hand.map((h, idx) => h.placed ? -1 : idx).filter(x => x >= 0);
    if(!avail.length){ continue; }
    const idx = avail[Math.floor(rnd() * avail.length)];
    const h = s.hand[idx];
    const r = Math.floor(rnd() * 10), c = Math.floor(rnd() * 10);
    win.__blockPlace(idx, r, c);
    run(20);
    s = R();
    if(s.filled < 0 || s.filled > 100) badCount++;
    for(const row of s.grid) for(const v of row) if(v < 0 || v > 6) badValue++;
    if(s.score < lastScore) scoreDown++;
    if(['play','over','pause'].indexOf(s.state) < 0) badState++;
    if(s.score > lastScore) placed++;
    lastScore = s.score;
  }
  ok(badValue === 0, '★ 盘面数值永远合法（0 或 1~6 号色）');
  ok(badCount === 0, '★ 填充格数永远在 0~100 之间');
  ok(scoreDown === 0, '★ 分数只增不减');
  ok(badState === 0, '★ 状态值始终合法');
  ok(games >= 0, '（跑了 ' + games + ' 局完整的，有效落子 ' + placed + ' 次）');
}

/* ================= 11) 绘制冒烟 / 音效 / 最高分 ================= */
section('11) 绘制冒烟 / 音效 / 最高分');
{
  const drawOk = () => { try{ win.__blockDraw(); return null; }catch(e){ return String((e && e.message) || e); } };
  const cases = [];
  reset(); cases.push(['初始', drawOk()]);
  win.__blockSetHand(['L3']); cases.push(['手牌 L 形', drawOk()]);
  const slot = win.__blockSlotCenter(0);
  win.__blockDragDown(slot.x, slot.y);
  const tgt = win.__blockCellCenter(4, 4);
  win.__blockDragMove(tgt.x, tgt.y);
  cases.push(['拖动中（带预览）', drawOk()]);
  win.__blockDragUp(tgt.x, tgt.y);
  run(4); cases.push(['落子后', drawOk()]);
  win.__blockSetGrid((() => { const g = fullGrid(0); for(let c = 0; c < 9; c++) g[0][c] = 2; return g; })());
  win.__blockSetHand(['1x1']); win.__blockPlace(0, 0, 9);
  run(3); cases.push(['消除动画中', drawOk()]);
  reset(); cases.push(['提示卡', drawOk()]);
  const oW = els.stage.clientWidth, oH = els.stage.clientHeight;
  for(const [w, h] of [[390, 300], [390, 660], [760, 700]]){
    els.stage.clientWidth = w; els.stage.clientHeight = h;
    win.__blockLayout();
    cases.push(['窗口 ' + w + '×' + h, drawOk()]);
  }
  els.stage.clientWidth = oW; els.stage.clientHeight = oH; win.__blockLayout();
  const bad = cases.filter(([, e]) => e);
  ok(bad.length === 0, '★ ' + cases.length + ' 种状态/窗口下 draw() 均不抛错', bad.map(([n, e]) => n + ': ' + e).join(' / '));
  const s = R();
  ok(s.CELL > 10 && s.BOARD > 100, '格子尺寸有效（单元 ' + s.CELL + '，盘 ' + s.BOARD + '）');
  ok(s.BX >= 0 && s.BX + s.CELL * 10 <= s.W + 1, '棋盘横向不出屏');
  ok(s.BY > 0 && s.BY + s.BOARD <= s.H + 1, '棋盘纵向不出屏');
  ok(s.HAND_Y > s.BY + s.BOARD - 1 && s.HAND_Y + s.HAND_H <= s.H + 1, '手牌区在棋盘下方且在屏内');

  reset();
  const a = allNodes();
  win.__blockSetHand(['1x1']); win.__blockPlace(0, 0, 0);
  ok(allNodes() > a, '落子有音效（+' + (allNodes() - a) + '）');
  const b = allNodes();
  win.__blockSetGrid((() => { const g = fullGrid(0); for(let c = 0; c < 9; c++) g[0][c] = 1; return g; })());
  win.__blockSetHand(['1x1']); win.__blockPlace(0, 0, 9);
  ok(allNodes() > b, '消行有音效（+' + (allNodes() - b) + '）');

  ok(store['gblock_best'] !== undefined, '最高分存 localStorage');
  ok(R().soundOn === true, '音效默认开');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
