#!/usr/bin/env node
/**
 * 舒尔特方格（Schulte Grid）逻辑回归测试
 *
 * 覆盖：
 *   1) 模式：4×4 ~ 9×9 六种，默认 5×5，本地存档记住上次选的档
 *   2) 棋盘生成：n² 格、1~n² 各出现一次、**不能正好是 1,2,3… 的顺序**
 *   3) 计时：点「1」才开始走表；点错不罚（不倒退、不停表、不结束）
 *   4) 点对：数字推进、格子标记 done、进度条推进
 *   5) 点错：miss++、next 不变、给出 bad 音效 + 震动，**没有别的惩罚**
 *   6) 全部点完：状态 done、秒表定格、记录成绩（首次 / 更快 / 更慢三种）
 *   7) 成绩按边长分开存，落盘 localStorage，重启后还在
 *   8) 过关特效：撒花粒子 + 冲击波；结算面板延迟约 1.5 秒才弹（演出先播完）
 *   9) 布局：棋盘正方形、边长取舞台短边、字号/圆角/间距随边长收缩（9×9 在窄屏也不为负）
 *  10) 音效（FakeCtx 计数）：点对升调、点错低沉、过关号角、破纪录额外一层；静音后彻底不发声
 *  11) 单文件自包含：没有外部 http(s) 依赖（离线 APK 要能直接用）
 *
 * 用法：node tools/test_schulte.js [web/schulte/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'schulte', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

/* ================= 假 DOM / 假音频 ================= */
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
function mkStyle(){
  const p = {};
  return {
    _p: p,
    setProperty(k, v){ p[k] = String(v); },
    getPropertyValue(k){ return (k in p) ? p[k] : ''; },
  };
}
function mkEl(tag){
  const handlers = {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: mkStyle(), dataset: {}, textContent: '', _cls: '',
    children: [], clientWidth: 390, clientHeight: 640, width: 0, height: 0,
    offsetWidth: 0,
    addEventListener(type, fn){ (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(){},
    fire(type, ev){ (handlers[type] || []).forEach(fn => fn(ev || {})); },
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ const i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); return c; },
    getBoundingClientRect(){
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
               right: this.clientWidth, bottom: this.clientHeight };
    },
    setAttribute() {}, focus() {}, blur() {},
  };
  // className 与 classList 共用同一份状态（真实 DOM 就是这样，
  // 分成两套会测出「写 className 但 contains 读不到」的假 bug）
  const list = () => el._cls.split(/\s+/).filter(Boolean);
  el.classList = {
    add(...cs){ const s = new Set(list()); cs.forEach(c => s.add(c)); el._cls = [...s].join(' '); },
    remove(...cs){ const s = new Set(list()); cs.forEach(c => s.delete(c)); el._cls = [...s].join(' '); },
    contains: c => list().indexOf(c) >= 0,
    toggle(c, on){
      const has = list().indexOf(c) >= 0;
      const want = (on === undefined) ? !has : !!on;
      if(want) el.classList.add(c); else el.classList.remove(c);
      return want;
    },
  };
  Object.defineProperty(el, 'className', {
    get(){ return el._cls; },
    set(v){ el._cls = String(v || ''); },
  });
  return el;
}

let toneNodes = 0, noiseNodes = 0, vibrates = 0;
class FakeCtx {
  constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
  createOscillator(){
    return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} },
             connect(){}, start(){ toneNodes++; }, stop(){} };
  }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, value:0 }, connect(){} }; }
  createBuffer(ch, len){ return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }; }
  createBufferSource(){ return { buffer: null, connect(){}, start(){ noiseNodes++; }, stop(){} }; }
  createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){} },
                                 Q:{ setValueAtTime(){} }, connect(){} }; }
  resume(){ this.state = 'running'; return Promise.resolve(); }
}

/** 造一个独立的游戏实例（各实例有自己的 DOM 与时钟，方便测「重启后存档还在」） */
function makeVM(store){
  const els = {};
  const nowRef = { t: 1000 };

  // 有些元素在游戏里是按「子节点下标」用的，先摆好
  const hud = mkEl('div');
  for(let i = 0; i < 3; i++) hud.appendChild(mkEl('div'));
  els.hud = hud;

  const stage = mkEl('div'); stage.clientWidth = 390; stage.clientHeight = 460; els.stage = stage;
  els.board = mkEl('div');
  const fx = mkEl('canvas'); fx.getContext = () => mkCtx(); els.fx = fx;
  els.modes = mkEl('div');

  const doc = {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl,
    addEventListener() {}, removeEventListener() {},
    documentElement: { scrollHeight: 640 }, body: mkEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
  };

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => nowRef.t },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    document: doc,
    navigator: { userAgent: 'node-test', vibrate: () => { vibrates++; return true; } },
    location: { search: '' },
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  sandbox.window.innerWidth = 390;
  sandbox.window.innerHeight = 844;
  sandbox.window.devicePixelRatio = 3;
  sandbox.window.AudioContext = FakeCtx;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'gschulte-inline.js' });
  sandbox.__els = els;
  sandbox.__clock = nowRef;
  return sandbox;
}

/* 主实例 */
const store = {};
const sb = makeVM(store);
const win = sb.window;
const els = sb.__els;
const clock = sb.__clock;

const S = () => win.__schulte();
const newGame = (n, seed) => win.__schulteNewGame(n, seed);
const tap = v => win.__schulteTap(v);
const step = dt => win.__schulteStep(dt);
const cells = () => win.__schulteCells();
const DT = 1 / 60;
function run(sec){ const n = Math.round(sec / DT); for(let i = 0; i < n; i++) step(DT); }
/** 按正确顺序点完整盘，返回每次的返回值 */
function playAll(){
  const out = [];
  for(let v = 1; v <= S().n * S().n; v++) out.push(tap(v));
  return out;
}

/* ================= 1) 模式 ================= */
section('1) 模式：4×4 ~ 9×9');
{
  ok(JSON.stringify(win.__schulteSizes()) === JSON.stringify([4,5,6,7,8,9]),
     '六种模式 4/5/6/7/8/9', JSON.stringify(win.__schulteSizes()));
  ok(S().n === 5, '默认 5×5（实际 ' + S().n + '）');
  ok(els.modes.children.length === 6, '模式条 6 个按钮（实际 ' + els.modes.children.length + '）');
  const labels = els.modes.children.map(b => b.textContent);
  ok(JSON.stringify(labels) === JSON.stringify(['4×4','5×5','6×6','7×7','8×8','9×9']),
     '按钮文字就是边长', JSON.stringify(labels));
  ok(els.modes.children.filter(b => b.classList.contains('on')).length === 1,
     '★ 任何时刻只有一个模式高亮');
  ok(els.modes.children[1].classList.contains('on'), '高亮的是当前模式 5×5');

  for(const n of [4,5,6,7,8,9]){
    newGame(n);
    const s = S();
    ok(s.n === n && s.nums.length === n*n,
       n + '×' + n + '：棋盘有 ' + n*n + ' 格（实际 ' + s.nums.length + '）');
    ok(cells().length === n*n, n + '×' + n + '：DOM 格子数一致（实际 ' + cells().length + '）');
  }
  newGame(5);
}

/* ================= 2) 棋盘生成 ================= */
section('2) 棋盘生成');
{
  let badRange = 0, badDup = 0, identity = 0, cornerOne = 0, total = 0;
  for(let seed = 1; seed <= 120; seed++){
    newGame(6, seed);
    const nums = S().nums;
    total++;
    const sorted = nums.slice().sort((a,b) => a-b);
    for(let i = 0; i < sorted.length; i++) if(sorted[i] !== i + 1) badRange++;
    if(new Set(nums).size !== nums.length) badDup++;
    if(nums.every((v, i) => v === i + 1)) identity++;
    if(nums[0] === 1) cornerOne++;
  }
  ok(badRange === 0, '★ 每盘都是 1 ~ n² 各一次（越界 ' + badRange + ' 次）');
  ok(badDup === 0, '★ 没有重复数字（' + badDup + ' 次）');
  ok(identity === 0, '★ 从没洗出「1,2,3…」的顺序（' + identity + ' 次）');
  ok(cornerOne > 0 && cornerOne < total,
     '1 的位置随机（左上角出现 ' + cornerOne + '/' + total + ' 次，既非恒在也非从不）');

  // 同种子可复现、不同种子不同
  newGame(6, 777); const a = S().nums.join(',');
  newGame(6, 777); const b = S().nums.join(',');
  newGame(6, 778); const c = S().nums.join(',');
  ok(a === b, '同种子洗出的棋盘一致（可复现）');
  ok(a !== c, '不同种子洗出不同棋盘');

  // pos 映射必须和 nums 对得上
  newGame(7, 5);
  const s = S();
  let posBad = 0;
  for(let v = 1; v <= 49; v++) if(s.nums[s.pos[v]] !== v) posBad++;
  ok(posBad === 0, '★ 数字→格子 的下标映射正确（错 ' + posBad + ' 个）');
  const domOk = cells().every((c, i) => c.v === s.nums[i] && c.text === String(s.nums[i]));
  ok(domOk, '★ 每个格子上写的数字和内部数组一致（画的和判的是同一份）');
}

/* ================= 3) 计时 ================= */
section('3) 计时：点「1」才开始');
{
  newGame(5, 1);
  clock.t = 5000;
  ok(S().state === 'ready', '开局是 ready（秒表没走）');
  ok(S().elapsed === 0, '开局用时 0');
  run(1.5);
  ok(S().elapsed === 0, '★ 没点之前，等多久秒表都不走（实际 ' + S().elapsed + '）');

  const first = S().nums[0];                 // 故意点一个不是 1 的数字
  const r = tap(first);
  ok(S().state === 'play', '★ 点了任意格子就开始计时（哪怕点错了）');
  ok(r === 'bad', '但不是 1 → 判为点错');
  ok(S().miss === 1, '点错计数 +1');

  clock.t += 1200;
  run(0.1);
  ok(Math.abs(S().elapsed - 1200) < 1, '秒表按真实时间走（1.2 秒后 elapsed≈1200ms，实际 ' + Math.round(S().elapsed) + '）');

  // 点错不罚：不倒退、不停表
  const before = S().elapsed, nextBefore = S().next;
  const wrong = S().nums.find(v => v !== S().next);
  tap(wrong);
  clock.t += 500; run(0.1);
  ok(S().next === nextBefore, '★ 点错不推进进度（next 仍是 ' + S().next + '）');
  ok(S().elapsed > before, '★ 点错不停表（照常继续走）');
  ok(S().state === 'play', '★ 点错不结束游戏');
  ok(S().miss === 2, '误点计数继续累加（' + S().miss + '）');

  // 第一下就点对 1，也应该开始计时
  newGame(5, 2);
  clock.t = 90000;
  ok(S().state === 'ready', '（新局重置回 ready）');
  tap(1);
  ok(S().state === 'play', '点对 1 也立刻开始计时');
  ok(S().next === 2, '点对 1 → 下一个是 2');
  clock.t += 300; run(0.05);
  ok(Math.abs(S().elapsed - 300) < 1, '计时从点 1 那一刻起算（实际 ' + Math.round(S().elapsed) + 'ms）');
}

/* ================= 4) 点对 ================= */
section('4) 点对：进度推进');
{
  newGame(5, 3);
  tap(1);
  const c = cells();
  const one = c.find(x => x.v === 1);
  ok(one && one.done, '★ 点过的 1 号格子被标记 done（视觉上会变暗）');
  ok(c.filter(x => x.done).length === 1, '只有点过的那一格是 done（实际 ' + c.filter(x => x.done).length + '）');

  tap(2);
  ok(cells().filter(x => x.done).length === 2, '点 2 之后有两格 done');
  ok(S().next === 3, '下一个变成 3');

  // 进度条
  const fill = els.barFill;
  ok(fill.style.width === '8.0%', '进度条 = 2/25 = 8.0%（实际 ' + fill.style.width + '）');
  tap(3);
  ok(fill.style.width === '12.0%', '进度条跟着涨到 12.0%（实际 ' + fill.style.width + '）');

  // 重复点已经点过的数字 = 点错（不会把进度搞坏）
  const r = tap(2);
  ok(r === 'bad', '★ 重复点已完成的数字算点错');
  ok(S().next === 4, '但进度不受影响（仍是 4）');
  ok(cells().filter(x => x.done).length === 3, '已完成标记也没有被抹掉');

  // HUD
  ok(els.next.textContent === '4', 'HUD 显示下一个数字（' + els.next.textContent + '）');
  ok(els.miss.textContent === '1', 'HUD 显示误点次数（' + els.miss.textContent + '）');
  ok(els.hint.textContent.indexOf('已点 3 / 25') >= 0,
     '★ 玩到一半时提示条显示进度（' + els.hint.textContent + '）');
}

/* ================= 5) 点错 ================= */
section('5) 点错：只给反馈，没有惩罚');
{
  newGame(5, 4);
  tap(1); tap(2);
  const t0 = toneNodes, n0 = noiseNodes, v0 = vibrates;
  const r = tap(9);
  ok(r === 'bad', '点错返回 bad');
  ok(toneNodes > t0, '★ 点错有音效（低频「咚」，+ ' + (toneNodes - t0) + ' 个音）');
  ok(noiseNodes > n0, '音效里带一点噪声（更像「无效」而不是「错误」）');
  ok(vibrates > v0, '★ 点错有震动反馈（手机上手感更明确）');
  const badCells = cells().filter(x => x.bad);
  ok(badCells.length === 1 && badCells[0].v === 9, '★ 点错的那一格单独抖动（其它格不受影响）');
  ok(S().miss === 1, '误点计数 +1');
  ok(S().next === 3, '进度不倒退');
  ok(S().state === 'play', '游戏继续');
  clock.t += 400; run(0.05);
  ok(S().elapsed > 0, '秒表继续走（点错之后照常计时，实际 ' + Math.round(S().elapsed) + 'ms）');

  // 点对不该震动
  const v1 = vibrates;
  tap(3);
  ok(vibrates === v1, '★ 点对不震动（只有点错才震）');
}

/* ================= 6) 通关与成绩 ================= */
section('6) 通关与成绩记录');
{
  newGame(4, 10);
  clock.t = 1000;
  const rets = [];
  for(let v = 1; v <= 16; v++){ if(v > 1) clock.t += 250; rets.push(tap(v)); }
  const s = S();
  ok(rets.slice(0, -1).every(r => r === 'ok'), '前 15 下都返回 ok');
  ok(rets[15] === 'win', '★ 最后一下返回 win');
  ok(s.state === 'done', '状态变成 done');
  ok(Math.abs(s.lastMs - 3750) < 5, '用时 = 15 个间隔 × 250ms = 3750ms（实际 ' + Math.round(s.lastMs) + '）');
  ok(s.elapsed === s.lastMs, 'elapsed 与 lastMs 一致');
  ok(s.newRecord === true, '★ 第一次通关算新纪录');
  ok(s.best['4'] > 0, '★ 4×4 的成绩已落盘（' + s.best['4'] + '）');
  ok(store['gschulte_v1'] && store['gschulte_v1'].indexOf('"4"') >= 0, 'localStorage 里写进了 4×4 的键');

  // 秒表定格
  clock.t += 5000; run(0.5);
  ok(S().lastMs === 3750, '★ 通关后秒表定格，不会再走');
  ok(S().elapsed === 3750, 'elapsed 也定格');

  // 全部格子 done
  ok(cells().every(x => x.done), '★ 通关后每一格都是 done');
  ok(els.next.textContent === '✓', 'HUD 的「下一个」变成 ✓');
  ok(els.barFill.style.width === '100.0%', '进度条拉满（' + els.barFill.style.width + '）');

  // 更快 → 破纪录
  newGame(4, 11);
  clock.t = 100000;
  for(let v = 1; v <= 16; v++){ if(v > 1) clock.t += 100; tap(v); }
  ok(S().newRecord === true, '★ 更快的一局 = 新纪录');
  ok(Math.abs(S().best['4'] - 1500) < 5, '成绩被刷新成 1500ms（实际 ' + S().best['4'] + '）');
  ok(S().prevBest === 3750, 'prevBest 记录的是上一档成绩（' + S().prevBest + '）');

  // 更慢 → 不刷新
  newGame(4, 12);
  clock.t = 200000;
  for(let v = 1; v <= 16; v++){ if(v > 1) clock.t += 900; tap(v); }
  ok(S().newRecord === false, '★ 更慢的一局不算新纪录');
  ok(Math.abs(S().best['4'] - 1500) < 5, '最佳成绩保持不变（' + S().best['4'] + '）');
  ok(S().prevBest === 1500, 'prevBest 仍是 1500');

  // 不同边长各记各的
  newGame(9, 13);
  clock.t = 300000;
  for(let v = 1; v <= 81; v++){ if(v > 1) clock.t += 100; tap(v); }
  ok(S().best['9'] > 0, '★ 9×9 有自己的成绩（' + S().best['9'] + '）');
  ok(Math.abs(S().best['4'] - 1500) < 5, '4×4 的成绩没被 9×9 覆盖');
  ok(S().best['9'] !== S().best['4'], '两个档位的成绩互相独立');
}

/* ================= 7) 存档 ================= */
section('7) 存档：重启后还在');
{
  const store2 = {};
  const a = makeVM(store2);
  a.window.__schulteNewGame(6, 20);
  a.__clock.t = 1000;
  for(let v = 1; v <= 36; v++){ a.__clock.t += 120; a.window.__schulteTap(v); }
  const savedMs = a.window.__schulte().best['6'];
  ok(savedMs > 0, '第一台设备记下 6×6 成绩（' + savedMs + '）');
  ok(a.window.__schulte().n === 6, '上次选的模式也被记住（n=6）');

  // 用同一份存档重启
  const b = makeVM(store2);
  ok(b.window.__schulte().best['6'] === savedMs,
     '★ 重启后 6×6 成绩还在（' + b.window.__schulte().best['6'] + '）');
  ok(b.window.__schulte().n === 6, '★ 重启后回到上次玩的模式 6×6（实际 ' + b.window.__schulte().n + '）');

  // 坏存档不能把游戏搞崩
  const bad = { 'gschulte_v1': '{"best":{"5":"abc","7":-3},"n":99,"sound":"yes"}' };
  let threw = null;
  let c = null;
  try{ c = makeVM(bad); }catch(e){ threw = String(e && e.message || e); }
  ok(threw === null, '★ 坏存档不会让游戏崩（' + (threw || 'ok') + '）');
  ok(c && c.window.__schulte().n === 5, '★ 非法模式回落到 5×5（实际 ' + (c && c.window.__schulte().n) + '）');
  ok(c && Object.keys(c.window.__schulte().best).length === 0,
     '★ 非法成绩被丢弃（剩 ' + (c ? Object.keys(c.window.__schulte().best).length : '?') + ' 条）');
}

/* ================= 8) 过关特效 + 结算延迟 ================= */
section('8) 过关特效与结算延迟');
{
  newGame(5, 30);
  clock.t = 1000;
  tap(1);
  for(let v = 2; v <= 25; v++){ clock.t += 80; tap(v); }
  const s = S();
  ok(s.state === 'done', '通关');
  ok(els.board.classList.contains('won'), '★ 棋盘进入 won 状态（格子会按斜向波次点亮）');

  const fx = win.__schulteFx();
  ok(fx.parts >= 100, '★ 撒花粒子已生成（' + fx.parts + ' 片）');
  ok(fx.rings >= 3, '★ 冲击波光环已生成（' + fx.rings + ' 圈）');
  ok(fx.active === true, '特效处于播放中');

  // 格子的波次序号：右下角的 --w 一定大于左上角（斜向扩散而不是同时亮）
  const cs = cells();
  const wOf = i => parseInt(cs[i].w, 10);
  ok(wOf(0) === 0, '左上角是第 0 波');
  ok(wOf(cs.length - 1) === 8, '右下角是最后一波（5×5 → 8）');
  ok(wOf(cs.length - 1) > wOf(0), '★ 波次确实有先后（不是一起闪）');

  // 面板要等演出播完
  ok(S().panelShown === false, '★ 刚通关不立刻弹面板（先让特效演）');
  ok(!els.doneOv.classList.contains('on'), '面板此刻没显示');
  run(0.8);
  ok(S().panelShown === false, '0.8 秒时还没弹（' + win.__schultePanelDelay() + ' 秒后才弹）');
  run(0.8);
  ok(S().panelShown === true, '★ 演出播完（1.6 秒）后面板弹出');
  ok(els.doneOv.classList.contains('on'), '面板真的显示出来了');
  ok(String(els.doneTime.textContent).indexOf('.') >= 0, '面板里有用时（' + els.doneTime.textContent + '）');
  ok(els.doneRec.textContent.length > 0, '面板里有成绩说明（' + els.doneRec.textContent + '）');

  // 粒子会自己衰减干净，不会一直留着拖慢渲染
  run(4);
  const fx2 = win.__schulteFx();
  ok(fx2.parts === 0, '★ 粒子在几秒内落完（剩 ' + fx2.parts + '）');
  ok(fx2.rings === 0, '冲击波也收干净了（剩 ' + fx2.rings + '）');
  ok(fx2.active === false, '特效停止后 active=false（不再每帧重绘）');

  // 演出中点一下 = 立刻看成绩
  newGame(5, 31);
  clock.t = 5000;
  for(let v = 1; v <= 25; v++){ clock.t += 60; tap(v); }
  ok(S().panelShown === false, '（新一局通关，演出进行中）');
  tap(1);
  ok(S().panelShown === true, '★ 演出中点一下就能直接看成绩（不用干等）');
  ok(S().next === 26, '跳过演出不会影响已经记下的进度');

  // 关掉面板还能再看
  win.__schulteHideDone();
  ok(!els.doneOv.classList.contains('on'), '「看看棋盘」把面板收起来了');
  tap(1);
  ok(S().panelShown === true && els.doneOv.classList.contains('on'), '★ 再点一下又能把成绩叫回来');
  win.__schulteHideDone();
}

/* ================= 9) 重新开始 ================= */
section('9) 重新开始 / 换模式');
{
  newGame(5, 40);
  clock.t = 1000;
  tap(1); tap(2); tap(3);
  const before = S().nums.join(',');
  const r = els.btnAgain;
  ok(r.textContent.indexOf('重新开始') >= 0, '玩到一半按钮写「重新开始」（' + r.textContent + '）');
  r.fire('click');
  const s = S();
  ok(s.state === 'ready', '★ 重新开始回到 ready');
  ok(s.next === 1 && s.miss === 0 && s.elapsed === 0, '★ 进度/误点/用时全部归零');
  ok(s.nums.join(',') !== before, '重新开始会重新洗牌（不是同一盘）');
  ok(cells().every(c => !c.done), '★ 所有格子的 done 标记都清掉了');
  ok(els.barFill.style.width === '0.0%', '进度条归零（' + els.barFill.style.width + '）');
  ok(!els.board.classList.contains('won'), 'won 状态被清掉');
  ok(win.__schulteFx().active === false, '残留特效被清掉');

  // 换模式
  els.modes.children[4].fire('click');       // 8×8
  ok(S().n === 8 && S().nums.length === 64, '★ 点模式条切到 8×8（' + S().n + '）');
  ok(els.modes.children[4].classList.contains('on'), '8×8 按钮高亮');
  ok(els.modes.children.filter(b => b.classList.contains('on')).length === 1, '仍然只有一个高亮');
  ok(cells().length === 64, 'DOM 重建成 64 格');

  // 通关后按钮文案
  clock.t = 1000;
  for(let v = 1; v <= 64; v++){ clock.t += 40; tap(v); }
  ok(S().state === 'done', '8×8 也能打通');
  win.__schulteShowDone();
  ok(els.btnAgain.textContent.indexOf('再来一次') >= 0, '通关后按钮写「再来一次」（' + els.btnAgain.textContent + '）');
}

/* ================= 10) 布局 ================= */
section('10) 布局：正方形棋盘 + 尺寸随模式收缩');
{
  const stage = els.stage;
  const cases = [
    [390, 460, '常见竖屏'],
    [336, 300, '舞台偏矮'],
    [320, 568, '最窄的老机型'],
    [760, 700, '平板/横屏'],
  ];
  let bad = 0, detail = [];
  for(const [w, h] of cases){
    stage.clientWidth = w; stage.clientHeight = h;
    for(const n of [4,5,6,7,8,9]){
      newGame(n, 1);
      win.__schulteLayout();
      const s = S();
      const want = Math.min(w, h);
      if(s.side !== want) { bad++; detail.push(w+'x'+h+' '+n+'x'+n+' side='+s.side+'≠'+want); }
      if(!(s.cell > 0)) { bad++; detail.push(n+'x'+n+' cell='+s.cell); }
      if(s.gap < 2 || s.gap > 9) { bad++; detail.push(n+'x'+n+' gap='+s.gap); }
      if(s.fs < 9 || s.fs > 46) { bad++; detail.push(n+'x'+n+' fs='+s.fs); }
      if(s.rad < 5 || s.rad > 16) { bad++; detail.push(n+'x'+n+' rad='+s.rad); }
      // 格子的实际可用宽度
      const real = (s.side - s.gap * (n - 1)) / n;
      if(Math.abs(real - s.cell) > 0.001) { bad++; detail.push(n+'x'+n+' cell 算错'); }
      if(real < 20) { bad++; detail.push(n+'x'+n+' 单格只有 '+real.toFixed(1)+'px'); }
    }
  }
  ok(bad === 0, '★ 4 种窗口 × 6 种模式的尺寸全部合法（问题 ' + bad + ' 处）', detail.slice(0, 3).join(' / '));

  // 棋盘本身是正方形、并且写进了样式
  stage.clientWidth = 390; stage.clientHeight = 300;
  newGame(6, 1); win.__schulteLayout();
  const s = S();
  ok(els.board.style.width === s.side + 'px', '棋盘宽度 = ' + s.side + 'px（' + els.board.style.width + '）');
  ok(els.board.style.height === s.side + 'px', '★ 棋盘高度也 = 同一个值（正方形，' + els.board.style.height + '）');
  ok(els.board.style.gridTemplateColumns.split(' ').length === 6,
     '★ 列数跟着模式走（6 列，' + els.board.style.gridTemplateColumns + '）');
  ok(els.board.style.gridTemplateRows === els.board.style.gridTemplateColumns,
     '★ 行数与列数一致（正方形网格）');
  ok(els.board.style.gridTemplateColumns.indexOf(s.cell.toFixed(3)) >= 0,
     '★ 每列写死成算好的单格宽 ' + s.cell.toFixed(3) + 'px（不用 1fr，避免棋盘里留出空槽）');
  ok(els.board.style.fontSize === s.fs.toFixed(2) + 'px', '字号写进了棋盘（' + els.board.style.fontSize + '）');
  ok(els.board.style.getPropertyValue('--rad').length > 0, '圆角通过 CSS 变量下发（' + els.board.style.getPropertyValue('--rad') + '）');

  // 9×9 在最窄屏上也要点得着（单格 ≥ 24px 左右）
  stage.clientWidth = 320; stage.clientHeight = 300;
  newGame(9, 1); win.__schulteLayout();
  const s9 = S();
  ok(s9.cell >= 24, '★ 9×9 在 320 宽的屏上单格仍 ≥ 24px（' + s9.cell.toFixed(1) + 'px）');
  ok(s9.fs >= 9, '数字字号不低于 9px（' + s9.fs.toFixed(1) + 'px）');

  // 舞台尺寸为 0（某些机型首帧如此）也不能算出 NaN
  stage.clientWidth = 0; stage.clientHeight = 0;
  newGame(5, 1); win.__schulteLayout();
  const s0 = S();
  ok(isFinite(s0.side) && s0.side > 0 && isFinite(s0.cell) && s0.cell > 0,
     '★ 舞台尺寸为 0 时仍算出有效尺寸（side=' + s0.side + ' cell=' + (isFinite(s0.cell) ? s0.cell.toFixed(1) : s0.cell) + '）');
  stage.clientWidth = 390; stage.clientHeight = 460;
  newGame(5, 1); win.__schulteLayout();
}

/* ================= 11) 音效 ================= */
section('11) 音效');
{
  newGame(5, 50);
  const t0 = toneNodes;
  tap(1);
  const first = toneNodes - t0;
  ok(first >= 2, '点对至少有 2 个音（主音 + 泛音，+' + first + '）');

  const t1 = toneNodes;
  tap(2);
  const second = toneNodes - t1;
  ok(second >= 2, '连续点对都有声（+' + second + '）');

  // 音高随进度上升：抓 oscillator 实际设置的主频来验
  const freqs = [];
  const sb3 = makeVM({});
  sb3.window.AudioContext = class {
    constructor(){ this.state='running'; this.currentTime=0; this.sampleRate=44100; this.destination={}; }
    createOscillator(){
      const self = this;
      return { type:'', frequency:{ value:0,
                 setValueAtTime(v){ freqs.push(v); },
                 exponentialRampToValueAtTime(){} },
               connect(){}, start(){ toneNodes++; }, stop(){} };
    }
    createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, value:0 }, connect(){} }; }
    createBuffer(){ return { getChannelData: () => new Float32Array(8) }; }
    createBufferSource(){ return { connect(){}, start(){}, stop(){} }; }
    createBiquadFilter(){ return { type:'', frequency:{ setValueAtTime(){} }, connect(){} }; }
  };
  sb3.window.__schulteNewGame(5, 60);
  freqs.length = 0;
  sb3.window.__schulteTap(1);
  const f1 = freqs[freqs.length - 2];     // 最后一对是「主音 + 泛音」，取主音
  freqs.length = 0;
  sb3.window.__schulteTap(2);
  const f2 = freqs[freqs.length - 2];
  freqs.length = 0;
  sb3.window.__schulteTap(3);
  const f3 = freqs[freqs.length - 2];
  ok(f1 > 0 && f2 > f1 && f3 > f2,
     '★ 点得越多音高越高（' + f1.toFixed(0) + ' → ' + f2.toFixed(0) + ' → ' + f3.toFixed(0) + 'Hz）');

  // 点错的音比点对低
  freqs.length = 0;
  sb3.window.__schulteTap(20);
  ok(freqs.length > 0 && freqs[0] < f3, '★ 点错的音明显更低（' + (freqs[0] || 0).toFixed(0) + 'Hz < ' + f3.toFixed(0) + 'Hz）');

  // 过关号角
  const t2 = toneNodes;
  newGame(4, 51);
  clock.t = 1000;
  for(let v = 1; v <= 16; v++){ clock.t += 50; tap(v); }
  ok(toneNodes - t2 >= 6, '★ 过关号角（+' + (toneNodes - t2) + ' 个音）');

  // 破纪录时还会多一层高音闪光
  const slowBest = S().best['4'];
  newGame(4, 52);
  clock.t = 100000;
  const t3 = toneNodes;
  for(let v = 1; v <= 16; v++){ if(v > 1) clock.t += 30; tap(v); }
  const recExtra = toneNodes - t3;
  ok(S().newRecord === true, '★ 这一局（450ms）确实比上一档 ' + slowBest + 'ms 快 → 新纪录');
  ok(recExtra >= 6, '★ 破纪录额外多一层音（共 +' + recExtra + '）');

  // 静音
  els.btnSound.fire('click');
  ok(win.__schulteProg().sound === false, '点静音按钮 → sound=false');
  ok(els.btnSound.textContent.indexOf('静音') >= 0, '按钮文字变成静音（' + els.btnSound.textContent + '）');
  const t4 = toneNodes, n4 = noiseNodes, v4 = vibrates;
  newGame(4, 53);
  clock.t = 1000;
  tap(1); tap(9); tap(2);
  for(let v = 3; v <= 16; v++){ clock.t += 20; tap(v); }
  ok(toneNodes === t4 && noiseNodes === n4, '★ 静音后一个音都不发（+ ' + (toneNodes - t4) + '）');
  ok(vibrates === v4, '★ 静音后连震动也一起关掉');
  els.btnSound.fire('click');
  ok(win.__schulteProg().sound === true, '再点一次恢复音效');
  ok(els.btnSound.textContent.indexOf('音效') >= 0, '按钮文字回到音效');
}

/* ================= 12) 时间格式 ================= */
section('12) 秒表格式');
{
  const fmt = win.__schulteFmt;
  ok(fmt(0) === '0.00', '0 → 0.00（' + fmt(0) + '）');
  ok(fmt(1234) === '1.23', '1234ms → 1.23（' + fmt(1234) + '）');
  ok(fmt(59999) === '59.99', '59999ms → 59.99（' + fmt(59999) + '）');
  ok(fmt(60000) === '1:00.00', '60000ms → 1:00.00（' + fmt(60000) + '）');
  ok(fmt(65432) === '1:05.43', '65432ms → 1:05.43（' + fmt(65432) + '）');
  ok(fmt(null) === '--', '没有成绩显示 --');
}

/* ================= 13) 单文件自包含 ================= */
section('13) 单文件自包含（离线可用）');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链（http/https/协议相对）');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok((html.match(/href="\//g) || []).length === 1, '只有一个站点根链接（返回键 href="/"）');
  ok(/<canvas id="fx"/.test(html), '特效画布在页面里（不是外部资源）');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
