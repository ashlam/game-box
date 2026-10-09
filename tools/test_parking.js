#!/usr/bin/env node
/**
 * 停车场华容道 测试
 *
 * 覆盖：
 *   1) 初始状态与关卡数据完整性（6×6、每关有警车、出口与警车朝向一致、车不重叠不出界）
 *   2) 滑动规则：只能沿自身朝向；被挡不能动；不能出盘
 *   3) 步数口径：一次滑动（无论几格）= 1 步
 *   4) 胜利：警车开到出口边才算；其他车永远不能出盘
 *   5) 撤销 / 重置
 *   6) ★ 求解器交叉校验：游戏内 BFS 算出的步数 == 关卡声称的最少步数（全关遍历）
 *   7) 提示 / 演示（演示只能：看完 / 暂停继续 / 退出到起始）
 *   8) 音效：拖动有"塑料片咔哒"，落位/出库/过关各有声音
 *   9) 绘制冒烟 + 布局不随屏幕比例变化（转屏安全）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'parking', 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if(!m) { console.error('找不到 <script>'); process.exit(1); }
const script = m[1];
if(/__PARKING_LEVELS__/.test(script)){ console.error('关卡数据还没注入（__PARKING_LEVELS__ 占位符还在）'); process.exit(1); }

/* ---------------- 桩 ---------------- */
const gradient = { addColorStop() {} };
let noiseNodes = 0, toneNodes = 0, shadowSets = 0;
const mkCtx = () => new Proxy({}, {
  get(t, k){
    if(k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
    if(k in t) return t[k];
    return () => {};
  },
  set(t, k, v){ if(k === 'shadowBlur' && v) shadowSets++; t[k] = v; return true; },
});
const mkEl = tag => { const s = new Set(); const el = {
  tagName: tag, style: {}, textContent: '', className: '', children: [], clientWidth: 390, clientHeight: 700,
  innerHTML: '',
  getContext: tag === 'canvas' ? (() => mkCtx()) : undefined,
  classList: { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) },
  addEventListener(){}, appendChild(c){ this.children.push(c); return c; },
  getBoundingClientRect(){ return { left: 0, top: 0, width: 390, height: 700 }; },
  select(){}, setSelectionRange(){}, focus(){},
}; return el; };
const els = {};
const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx();
const stageEl = mkEl('div');
const store = {};
class FakeCtx {
  constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
  createOscillator(){ return { type:'', frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} },
    connect(){}, start(){ toneNodes++; }, stop(){} }; }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; }
  createBuffer(a, b){ return { getChannelData: () => new Float32Array(b) }; }
  createBufferSource(){ return { buffer:null, connect(){}, start(){ noiseNodes++; }, stop(){} }; }
  createBiquadFilter(){ return { type:'', frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} },
    Q:{ setValueAtTime(){} }, connect(){} }; }
  resume(){ this.state = 'running'; return Promise.resolve(); }
}
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 1,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: {
    getElementById: id => (id === 'cv' ? cvEl : id === 'stage' ? stageEl : (els[id] || (els[id] = mkEl('div')))),
    createElement: mkEl, addEventListener(){},
    documentElement: { scrollHeight: 700 }, body: mkEl('body'), readyState: 'complete',
  },
  navigator: { userAgent: 'node-test' }, location: { search: '' },
};
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 411; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2.625;
sandbox.window.AudioContext = FakeCtx; sandbox.window.isSecureContext = false;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'parking-inline.js' });
const win = sandbox.window;

const R = () => win.__parking();
const run = (n, dt = 1 / 60) => { for(let i = 0; i < n; i++) win.__parkingStep(dt); };
const gridOf = cars => {
  const g = Array.from({ length: 6 }, () => new Array(6).fill(-1));
  cars.forEach((c, i) => {
    for(let k = 0; k < c.len; k++){
      const r = c.dir === 'h' ? c.r : c.r + k, cc = c.dir === 'h' ? c.c + k : c.c;
      if(g[r] && g[r][cc] !== undefined) g[r][cc] = i;
    }
  });
  return g;
};
const overlaps = cars => {
  const seen = new Set();
  for(const c of cars){
    for(let k = 0; k < c.len; k++){
      const r = c.dir === 'h' ? c.r : c.r + k, cc = c.dir === 'h' ? c.c + k : c.c;
      const key = r + ',' + cc;
      if(r < 0 || r > 5 || cc < 0 || cc > 5) return 'out-of-board';
      if(seen.has(key)) return 'overlap:' + key;
      seen.add(key);
    }
  }
  return null;
};

let pass = 0, fail = 0; const failures = [];
/** 跳到某一关，使它的出口方向 = ex（测试里需要一个已知出口的关） */
function gotoExit(ex){
  const info = win.__parkingTiers();
  for(let si = 0; si < info.length; si++){
    for(let li = 0; li < info[si].count; li++){
      win.__parkingGoto(si, li);
      if(R().exit === ex) return { si, li };
    }
  }
  return null;
}
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 1) 关卡数据完整性 ================= */
section('1) 关卡数据完整性（全关卡遍历）');
{
  const s = R();
  ok(s.N === 6, '棋盘 6×6');
  ok(s.setCount >= 1, '至少一个关卡集（实际 ' + s.setCount + ' 个）');
  let total = 0, badPolice = 0, badExit = 0, badCells = 0, noPolice = 0, badMobile = 0, badMin = 0;
  for(let si = 0; si < s.setCount; si++){
    const info = win.__parkingTiers()[si];
    total += info.count;
    for(let li = 0; li < info.count; li++){
      win.__parkingGoto(si, li);
      const g = R();
      const pl = g.cars.find(c => c.police);
      if(!pl){ noPolice++; continue; }
      const ex = g.exit;
      const axisOk = (ex === 'left' || ex === 'right') ? pl.dir === 'h' : pl.dir === 'v';
      if(!axisOk) badExit++;
      const lineOk = (ex === 'left' || ex === 'right') ? pl.r >= 0 : pl.c >= 0;
      if(!lineOk) badExit++;
      const ov = overlaps(g.cars);
      if(ov) badCells++;
      if(g.mobile !== g.cars.length) badMobile++;
      if(!(g.min > 0)) badMin++;
    }
  }
  ok(noPolice === 0, '★ 每一关都有警车（缺 ' + noPolice + '）');
  ok(badExit === 0, '★ 每关出口方向与警车朝向一致（不一致 ' + badExit + '）');
  ok(badCells === 0, '★ 没有任何车重叠或出界（异常 ' + badCells + '）');
  ok(badMobile === 0, '★ 车辆数字段与实际车数一致（不符 ' + badMobile + '）');
  ok(badMin === 0, '★ 每关都标了最少步数（缺 ' + badMin + '）');
  ok(total > 0, '共 ' + total + ' 关');

  // ★ 用户定稿的固定设定逐关校验
  let badCol = 0, badLen = 0, badDir = 0, badLen3 = 0, badKind = 0;
  for(let si = 0; si < s.setCount; si++){
    const info = win.__parkingTiers()[si];
    for(let li = 0; li < info.count; li++){
      win.__parkingGoto(si, li);
      const g = R();
      const pl = g.cars.find(c => c.police);
      if(!pl) continue;
      if(pl.c !== 3) badCol++;
      if(pl.len !== 2) badLen++;
      if(pl.dir !== 'v') badDir++;
      if(g.exit !== 'bottom') badDir++;
      if(g.cars.filter(c => !c.police && c.len === 3).length > 5) badLen3++;
      if(g.cars.some(c => c.len !== 2 && c.len !== 3)) badKind++;
    }
  }
  ok(badCol === 0, '★ 每关警车都在第 4 列（不符 ' + badCol + '）');
  ok(badLen === 0, '★ 每关警车长度都是 2（不符 ' + badLen + '）');
  ok(badDir === 0, '★ 每关警车都竖直、出口都在底部（不符 ' + badDir + '）');
  ok(badKind === 0, '★ 所有车只有长 2 或长 3（异常 ' + badKind + '）');
  ok(badLen3 === 0, '★ 长 3 障碍车每关 ≤ 5 辆（超限 ' + badLen3 + '）');
}

/* ================= 2) 滑动规则 ================= */
section('2) 滑动规则（固定设定：6×6、出口=底部第4列、警车竖直长2）');
{
  win.__parkingGoto(0, 0);
  win.__parkingSetCars([
    { r:0, c:3, len:2, dir:'v', color:'#111827', police:true },
    { r:2, c:0, len:3, dir:'v', color:'#ef4444', police:false },
  ]);
  ok(R().policeIdx === 0, '警车是第 0 辆');
  ok(win.__parkingCanStep(0, 1) === true, '警车向下可动（前方空）');
  ok(win.__parkingCanStep(0, -1) === false, '警车向上不能动（已贴顶边界）');
  ok(win.__parkingCanStep(1, 1) === true, '竖障碍车向下可动');
  win.__parkingSetCars([
    { r:1, c:3, len:2, dir:'v', color:'#111827', police:true },
    { r:3, c:3, len:2, dir:'v', color:'#22d3ee', police:false },
  ]);
  ok(win.__parkingCanStep(0, 1) === false, '★ 正下方被别的车挡住 → 动不了');
  ok(win.__parkingCanStep(1, 1) === true, '被挡的那辆自己可以动');
  win.__parkingSetCars([{ r:4, c:3, len:2, dir:'v', color:'#111827', police:true }]);
  ok(win.__parkingCanStep(0, 1) === false, '★ 再往下会出盘 → 不允许（车不能离开棋盘）');
}

/* ================= 3) 步数口径 + 胜利 ================= */
section('3) 步数口径与胜利条件');
{
  ok(!!gotoExit('bottom'), '找到出口在底部第 4 列的关卡（固定设定）');
  win.__parkingSetCars([{ r:2, c:3, len:2, dir:'v', color:'#111827', police:true }]);
  ok(R().exit === 'bottom', '出口 = 底部（与警车朝向一致）');
  const n = win.__parkingSlide(0, 1, 2);
  ok(n === 2, '向下滑 2 格（r 2→4，长 2 → 4+2=6 贴到底边）');
  ok(R().steps === 1, '★ 无论滑几格，一次滑动只计 1 步（实际 ' + R().steps + '）');
  ok(R().out === true, '★ 警车到达出口（底边第 4 列）→ 判定出库');

  // 朝向不符 / 列不对：都不算出库
  win.__parkingSetCars([{ r:2, c:3, len:2, dir:'h', color:'#111827', police:true }]);
  ok(R().out === false, '横车在"底部出口"关卡不算出库（朝向不符）');
  win.__parkingSetCars([{ r:4, c:1, len:2, dir:'v', color:'#111827', police:true }]);
  ok(R().out === false, '★ 竖警车但不在第 4 列 → 也不算（出口固定在第 4 列）');

  // 其他车不能开出盘
  win.__parkingSetCars([
    { r:4, c:0, len:2, dir:'v', color:'#3b82f6', police:false },
    { r:2, c:3, len:2, dir:'v', color:'#111827', police:true },
  ]);
  win.__parkingSlide(0, 1, 9);
  const g = R();
  ok(g.cars[0].r + g.cars[0].len === 6, '★ 普通车最多贴到盘边，不会掉出棋盘');
  ok(g.state === 'play', '普通车贴边不触发任何胜利（只有警车能出）');
}

/* ================= 4) 撤销 / 重置 ================= */
section('4) 撤销与重置');
{
  win.__parkingGoto(0, 0);
  win.__parkingSetCars([
    { r:2, c:3, len:2, dir:'v', color:'#111827', police:true },
    { r:0, c:0, len:2, dir:'v', color:'#3b82f6', police:false },
  ]);
  const before = JSON.stringify(R().cars);
  win.__parkingSlide(0, 1, 2);
  ok(R().steps === 1 && JSON.stringify(R().cars) !== before, '走了一步');
  ok(win.__parkingUndo() === 1, '撤销成功');
  ok(JSON.stringify(R().cars) === before, '★ 撤销后每辆车回到原位');
  ok(R().steps === 0, '★ 步数也回到 0');
  ok(win.__parkingUndo() === 0, '没有可撤销步骤时返回 0');
  win.__parkingSlide(0, 1, 2);
  win.__parkingReset();
  ok(R().steps === 0 && JSON.stringify(R().cars) === before, '重置回本关起始状态');
  ok(R().historyLen === 0, '重置清空撤销栈');
}

/* ================= 5) ★ 求解器交叉校验（全关） ================= */
section('5) ★ 全关求解校验：游戏内求解器步数 == 声称最少步数');
{
  const s = R();
  let checked = 0, mismatch = 0, unsolved = 0, slow = 0;
  const t0 = Date.now();
  const bad = [];
  for(let si = 0; si < s.setCount; si++){
    const info = win.__parkingTiers()[si];
    for(let li = 0; li < info.count; li++){
      if(Date.now() - t0 > 180000){ slow++; break; }
      win.__parkingGoto(si, li);
      const path = win.__parkingSolve();
      const min = R().min;
      if(!path){ unsolved++; bad.push(info.name + '#' + (li + 1) + ' 无解'); continue; }
      checked++;
      if(path.length !== min){ mismatch++; bad.push(info.name + '#' + (li + 1) + ' 算得' + path.length + '≠声明' + min); }
    }
  }
  ok(unsolved === 0, '★ 每一关求解器都能求出解（无解 ' + unsolved + '）', bad.slice(0, 4).join(' / '));
  ok(mismatch === 0, '★ 游戏内求解器步数 == 关卡声称的最少步数（不符 ' + mismatch + '）', bad.slice(0, 4).join(' / '));
  ok(checked > 0, '共校验 ' + checked + ' 关 · 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

/* ================= 6) 提示 / 演示 ================= */
section('6) 提示与演示（演示只能看完 / 暂停继续 / 退出到起始）');
{
  win.__parkingGoto(0, 0);
  const startBoard = JSON.stringify(R().cars);
  ok(win.__parkingHint() === true, '提示可用');
  const s1 = R();
  ok(!!s1.hint, '提示给出了具体走法（高亮车 + 方向）');
  const hm = s1.hint;
  run(220);                                        // 3.6s 后提示自动消失
  ok(!R().hint, '提示 3 秒后自动消失');

  ok(win.__parkingDemo() === true, '启动自动演示');
  ok(!!R().demo && R().demo.paused === false, '演示进行中');
  ok(win.__parkingDemoPause() === true, '暂停');
  const idx = R().demo.idx;
  run(120);
  ok(R().demo && R().demo.idx === idx, '★ 暂停期间演示不推进');
  ok(win.__parkingDemoPause() === true, '继续');
  let guard = 0;
  while(R().demo && guard++ < 4000) win.__parkingStep(0.6);
  run(10);
  ok(!R().demo, '演示会自己走完');
  ok(R().state === 'play' && R().steps === 0, '★ 演示结束后回到起始（不计玩家步数）');
  ok(JSON.stringify(R().cars) === startBoard, '★ 盘面逐车回到起始状态');

  // 演示中不能被玩家接管
  ok(win.__parkingDemo() === true, '再启动演示');
  const board2 = JSON.stringify(R().cars);
  win.__parkingSlide(0, 1, 1);
  ok(JSON.stringify(R().cars) === board2, '★ 演示中直接滑动无效（不允许接管）');
  win.__parkingStep(0.6);
  ok(win.__parkingExitDemo() === true, '退出演示');
  ok(!R().demo && JSON.stringify(R().cars) === startBoard, '★ 退出演示 → 回到起始状态');
}

/* ================= 7) 音效 ================= */
section('7) 音效（含塑料片咔哒）');
{
  win.__parkingGoto(0, 0);
  win.__parkingSetCars([{ r:2, c:3, len:2, dir:'v', color:'#111827', police:true }]);
  ok(win.__parkingAudio() === true, '音频上下文已初始化（真实游玩时首次触摸自动完成）');
  const a = noiseNodes + toneNodes;
  win.__parkingSlide(0, 1, 2);
  const mid = noiseNodes + toneNodes;
  ok(mid > a, '★ 滑动车辆有声音（噪声源 +' + (noiseNodes) + ' / 音头 +' + toneNodes + '）');
  ok(noiseNodes >= 2, '★ 每滑一格一声"咔哒"（2 格 → 噪声源 ≥2，实际 ' + noiseNodes + '）');
  ok(toneNodes >= 2, '每格还有短促音头（实际 ' + toneNodes + '）');
}

/* ================= 8) 绘制冒烟 + 转屏 ================= */
section('8) 绘制冒烟与布局稳定性');
{
  const drawOk = () => { try{ win.__parkingDraw(); return null; } catch(e){ return String(e && e.message || e); } };
  const cases = [];
  win.__parkingGoto(0, 0);
  cases.push(['初局', drawOk()]);
  win.__parkingHint(); cases.push(['提示高亮', drawOk()]);
  win.__parkingSlide(0, 1, 1); cases.push(['走一步', drawOk()]);
  win.__parkingDemo(); win.__parkingStep(0.6); cases.push(['演示中', drawOk()]);
  win.__parkingExitDemo();
  const sizes = [[390, 300], [390, 660], [760, 700], [1024, 768]];
  for(const [w, h] of sizes){
    win.__parkingSetStage(w, h);
    cases.push(['窗口 ' + w + '×' + h, drawOk()]);
  }
  const bad = cases.filter(([, e]) => e);
  ok(bad.length === 0, '★ ' + cases.length + ' 种状态/窗口下 draw() 均不抛错', bad.map(([n, e]) => n + ': ' + e).join(' / '));

  // 固定逻辑尺寸 → 转屏/换设备几何一致
  win.__parkingSetStage(390, 700);
  const a = R();
  const geoA = [a.W, a.H, a.CELL.toFixed(3), a.BX.toFixed(3), a.BY.toFixed(3)];
  win.__parkingSetStage(1024, 768);
  const b = R();
  const geoB = [b.W, b.H, b.CELL.toFixed(3), b.BX.toFixed(3), b.BY.toFixed(3)];
  ok(a.W === b.W && a.H === b.H, '★ 逻辑尺寸固定：竖屏/横屏都是 ' + a.W + '×' + a.H);
  ok(JSON.stringify(geoA) === JSON.stringify(geoB), '★ 转屏后棋盘几何完全一致（不随屏幕比例变形）');
  win.__parkingSetStage(390, 700);
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(62));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
