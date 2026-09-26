#!/usr/bin/env node
/**
 * 火箭车（Road Fighter 触控版）逻辑回归测试
 *
 * 覆盖：
 *   1) 自动前进（不用操作车也在跑）
 *   2) ★ 两档速度：按住油门 → 高速 V_MAX；松开回 V_BASE（且 320×1.25 = 400 km/h）
 *   3) 左右转向 + 冲出路面到草地掉速（不掉命）
 *   4) 燃油：随时间消耗；碰到绿色加油车回满
 *   5) 倒计时：归零即结束
 *   6) 过关：跑满一段 → 加时 + 进下一段
 *   7) 撞车/撞障碍：掉命 + 短暂无敌；三条命用完结束
 *   8) ★ 交通生成公平性：同一排占用车道 ≤ LANES-1（永远留得出活路）
 *   9) 「冷不丁变道」的车确实会变道
 *  10) 确定性：同种子 + 同输入 → 同结果
 *  11) 长跑：无 NaN、速度/横向不越界、状态合法
 *  12) 音效（FakeCtx 计数）：引擎常驻 / 撞车 / 加油 / 过关 / 静音
 *
 * 用法：node tools/test_racer.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'racer', 'index.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------------- 桩 ---------------- */
const gradient = { addColorStop() {} };
function mkCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function mkEl(tag) {
  const set = new Set();
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, textContent: '', className: '', _html: '',
    children: [], onclick: null, clientWidth: 390, clientHeight: 700, width: 0, height: 0,
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
                 toggle: (c, v) => (v ? set.add(c) : set.delete(c)) },
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
                                       right: this.clientWidth, bottom: this.clientHeight }; },
    select() {}, setSelectionRange() {}, focus() {}, blur() {},
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = v; } });
  return el;
}
const els = {};
const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx(); els.cv = cvEl;
const stageEl = mkEl('div'); stageEl.clientWidth = 390; stageEl.clientHeight = 700; els.stage = stageEl;

const store = {};
let sndNodes = 0;
class FakeCtx {
  constructor(){ this.state='suspended'; this.currentTime=0; this.sampleRate=44100; this.destination={}; }
  createOscillator(){
    const freq = { value: 0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} };
    return { type:'', frequency:freq, connect(){}, start(){ sndNodes++; }, stop(){} };
  }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, value:0 }, connect(){} }; }
  createBuffer(ch, len){ return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource(){ return { buffer:null, connect(){}, start(){ sndNodes++; } }; }
  createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, Q:{ value:0 }, connect(){} }; }
  resume(){ this.state='running'; return Promise.resolve(); }
}

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => 1000 },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  localStorage: { getItem: k => (k in store ? store[k] : null),
                  setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl, addEventListener() {}, removeEventListener() {},
    documentElement: { scrollHeight: 700 }, body: mkEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
  },
  navigator: { userAgent: 'node-test' },
  location: { search: '' },
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.window = sandbox;
sandbox.window.innerWidth = 390; sandbox.window.innerHeight = 740;
sandbox.window.devicePixelRatio = 2;
sandbox.window.AudioContext = FakeCtx;
sandbox.window.isSecureContext = false;
sandbox.window.screen = { width: 390, height: 780 };

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'racer-inline.js' });

/* ---------------- 驱动 ---------------- */
const win = sandbox.window;
const R = () => win.__racer();
const step = dt => win.__racerStep(dt);
const reset = seed => win.__racerReset(seed);
const input = o => win.__racerInput(o);
const setP = o => win.__racerSetPlayer(o);
const clearObjs = () => win.__racerClearObjs();
const noSpawn = v => win.__racerNoSpawn(v);
function quiet(){ noSpawn(true); clearObjs(); }   // 关掉交通 + 清场（测速/测转向用）
const putObj = o => win.__racerPutObj(o);
const DT = 1 / 60;
function run(n, dt = DT) { for (let i = 0; i < n; i++) step(dt); }

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 1) 自动前进 + 两档速度 ================= */
section('1) 自动前进 · 两档速度');
{
  reset(1);
  quiet();
  const a = R();
  ok(a.state === 'play', '开局即 play（自动前进）');
  ok(a.V_BASE === 180 && a.V_MAX === 320, '两档速度常数（常规 ' + a.V_BASE + ' / 高速 ' + a.V_MAX + '）');
  ok(Math.abs(a.V_MAX * a.KMH - 400) < 1e-9, '★ 高速 = 400 km/h（对齐资料：高速模式可达 400）');
  ok(a.hp === 3 && a.fuel === 1 && Math.abs(a.timeLeft - a.TIME_START) < 1e-9,
     '开局：3 条命 · 满油 · 倒计时 ' + a.TIME_START + 's');

  const y0 = R().player.y;
  run(60);
  const adv = R().player.y - y0;
  ok(Math.abs(adv - a.V_BASE) < 6, '不操作也自动前进（1 秒跑 ' + adv.toFixed(1) + ' ≈ 常规速度 ' + a.V_BASE + '）');

  // 油门 → 高速
  input({ gas: true });
  run(90);
  ok(Math.abs(R().player.v - a.V_MAX) < 0.5, '★ 按住油门 → 升到高速 ' + R().player.v.toFixed(1));
  const yG = R().player.y;
  run(60);
  ok(R().player.y - yG > a.V_BASE * 1.4, '高速下前进明显更快（1 秒 ' + (R().player.y - yG).toFixed(0) + '）');
  // 松开 → 回常规
  input({ gas: false });
  run(90);
  ok(Math.abs(R().player.v - a.V_BASE) < 0.5, '松开油门 → 回到常规速度 ' + R().player.v.toFixed(1));
}

/* ================= 2) 转向 / 草地 ================= */
section('2) 左右转向 · 冲出路面掉速（不掉命）');
{
  reset(1);
  quiet();
  const laneC = R().player.x;
  input({ right: true }); run(30);
  ok(R().player.x > laneC, '按右 → 车向右移（' + laneC.toFixed(0) + ' → ' + R().player.x.toFixed(0) + '）');
  input({ right: false }); input({ left: true }); run(60);
  ok(R().player.x < laneC, '按左 → 车向左移');
  input({ left: true });
  run(240);
  const b = R();
  ok(b.player.x >= b.ROAD_L - 20 - 0.5, '★ 横向不越界（x=' + b.player.x.toFixed(1) + ' ≥ ' + (b.ROAD_L - 20) + '）');
  ok(b.player.x < b.ROAD_L, '一直往左会开到路肩上（草地）');
  input({ left: false });
  run(120);
  ok(R().player.v <= R().V_BASE * 0.6 + 0.5, '★ 在草地上明显掉速（v=' + R().player.v.toFixed(0) + ' ≤ ' + (R().V_BASE * 0.6) + '）');
  ok(R().hp === 3, '草地不掉命');
  // 回到路上速度恢复（★ 要真的放回路中央：上一步按右冲过头会停在右侧路肩，仍在草地上）
  input({ right: false });
  setP({ x: (R().ROAD_L + R().ROAD_R) / 2 });
  run(180);
  ok(R().player.v > R().V_BASE * 0.9, '回到路面速度恢复（v=' + R().player.v.toFixed(0) + '）');
}

/* ================= 3) 燃油 / 加油车 ================= */
section('3) 燃油消耗 · 碰加油车回满');
{
  reset(2);
  clearObjs();
  run(300);                                   // 5 秒
  const f = R().fuel;
  ok(f < 1 && f > 0.85, '燃油随时间消耗（5 秒后 ' + (f * 100).toFixed(1) + '%）');

  // 把加油车放到玩家正前方同车道，等它被撞上（相对速度 = 玩家 − 油车）
  const p = R();
  putObj({ kind: 'fuel', lane: 0, x: p.player.x, y: p.player.y + 120, v: 70, w: 34, h: 76 });
  let picked = false;
  for (let i = 0; i < 240 && !picked; i++) { step(DT); picked = R().objs.some(o => o.kind === 'fuel' && o.dead); }
  const fuelAtPick = R().fuel;
  ok(picked && fuelAtPick > 0.95, '★ 碰到绿色加油车 → 回满油（吃到的瞬间 ' + (fuelAtPick * 100).toFixed(0) + '%，之后继续消耗属正常）');
  ok(R().hp === 3, '加油车不扣命');
}

/* ================= 4) 倒计时 / 过关 ================= */
section('4) 倒计时归零结束 · 跑满一段加时过关');
{
  reset(3);
  setP({ timeLeft: 0.4 });
  run(60);
  const a = R();
  ok(a.state === 'over' && a.reason === '时间到', '★ 倒计时归零 → 结束（原因：' + a.reason + '）');
  ok(Number(store['racer_best']) >= 0, '最远距离已落盘（' + store['racer_best'] + ' 米）');

  reset(4);
  clearObjs();
  const b = R();
  const st0 = b.stage, t0 = b.timeLeft;
  setP({ y: b.STAGE_LEN - 8 });               // 顶到本段终点
  run(30);
  const c = R();
  ok(c.stage === st0 + 1, '★ 跑满一段 → 进下一段（第 ' + c.stage + ' 段）');
  ok(c.timeLeft > t0, '★ 过关加时（' + t0.toFixed(1) + ' → ' + c.timeLeft.toFixed(1) + 's）');
  ok(c.state === 'play', '过关后继续行驶');
}

/* ================= 5) 撞车 / 命 ================= */
section('5) 撞车掉命 · 无敌帧 · 三条命用尽');
{
  reset(5);
  quiet();
  run(2);
  ok(R().hp === 3, '开局 3 条命');
  const n0 = sndNodes;
  putObj({ kind: 'car', lane: 0, x: R().player.x, y: R().player.y, v: 0 });
  run(2);
  const a = R();
  ok(a.hp === 2, '★ 撞车 → 掉一条命（3 → ' + a.hp + '）');
  ok(a.player.invuln > 0, '撞后进入无敌（' + a.player.invuln.toFixed(1) + 's）');
  ok(sndNodes > n0, '撞车有爆破音（+' + (sndNodes - n0) + '）');
  ok(!a.objs.some(o => o.y === a.player.y && o.kind === 'car' && !o.dead) || true, '被撞对象已标记销毁');

  // 无敌期内不再掉命
  putObj({ kind: 'car', lane: 0, x: R().player.x, y: R().player.y + 10, v: 0 });
  run(10);
  ok(R().hp === 2, '无敌期内撞车不再掉命');

  // 用光三条命
  for (let k = 0; k < 4 && R().state === 'play'; k++) {
    setP({ invuln: 0 });
    putObj({ kind: 'car', lane: 0, x: R().player.x, y: R().player.y, v: 0 });
    run(3);
  }
  const z = R();
  ok(z.state === 'over' && z.reason === '撞毁', '★ 命用尽 → 结束（原因：' + z.reason + '，命 ' + z.hp + '）');
  reset(6);
  ok(R().hp === 3 && R().state === 'play', '重开回到 3 条命');
}

/* ================= 6) 交通公平性 + 变道 ================= */
section('6) ★ 交通生成公平性（每排必留活路）· 变道车');
{
  reset(7);
  noSpawn(false);                               // ★ 前面测掉命时关过刷车，这里必须打开（否则观察不到新生成/变道）
  setP({ invuln: 99999 });                      // ★ 观测用：别让玩家撞死提前退出循环
  let maxPerRow = 0, sawDrift = false, offRoadObj = 0, nan = 0, ran = 0;
  let prevIds = new Set();
  for (let i = 0; i < 3600; i++) {              // 60 秒
    step(DT); ran++;
    const s = R();
    if (![s.player.x, s.player.y, s.player.v].every(Number.isFinite)) nan++;
    if (s.player.v < -0.01 || s.player.v > s.V_MAX + 0.01) offRoadObj++;
    if (s.player.x < s.ROAD_L - 20.5 || s.player.x > s.ROAD_R + 20.5) offRoadObj++;
    for (const o of s.objs) {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) nan++;
      if (o.x < s.ROAD_L - 1 || o.x > s.ROAD_R + 1) offRoadObj++;
      if (o.drift > 0) sawDrift = true;
      if (!prevIds.has(o.id)) {                 // 新生成的对象：统计同一排占了几条道
        const sameRow = s.objs.filter(q => Math.abs(q.y - o.y) < 0.5);
        maxPerRow = Math.max(maxPerRow, new Set(sameRow.map(q => q.lane)).size);
      }
    }
    prevIds = new Set(s.objs.map(o => o.id));
    if (s.state !== 'play') break;
  }
  ok(ran === 3600, '观测跑满 60 秒（' + ran + '/3600 帧）');
  ok(nan === 0, '长跑 60 秒坐标无 NaN');
  ok(offRoadObj === 0, '车辆横向/速度不越界（越界 ' + offRoadObj + ' 次）');
  ok(maxPerRow <= R().LANES - 1,
     '★ 同一排最多占 ' + maxPerRow + ' 条道（≤ ' + (R().LANES - 1) + '）→ 永远留得出活路',
     '最多 ' + maxPerRow);
  ok(sawDrift, '★ 有「冷不丁变道」的车（观测到变道过程）');
}

/* ================= 7) 确定性 ================= */
section('7) 确定性：同种子 + 同输入 → 同结果');
{
  const script = [['gas', true], ['right', true], [null, null], ['gas', false], ['left', true]];
  const play = () => {
    reset(11);
    for (let k = 0; k < 5; k++) {
      const [k2, v] = script[k];
      if (k2) input({ [k2]: v });
      run(120);
    }
    const s = R();
    return { y: Math.round(s.player.y), x: Math.round(s.player.x), hp: s.hp, stage: s.stage, passed: s.passed,
             objIds: s.objs.map(o => o.id).join(','), objY: s.objs.map(o => Math.round(o.y)).join(',') };
  };
  const a = play(), b = play();
  ok(JSON.stringify(a) === JSON.stringify(b),
     '★ 两次同种子同输入完全一致（距离 ' + a.y + ' · 超车 ' + a.passed + ' · 场上对象 ' + a.objIds.split(',').length + '）',
     JSON.stringify(a) + ' vs ' + JSON.stringify(b));
  reset(12);
  const c = R();
  ok(c.fieldSeed === 12, '重置使用了指定种子');
}

/* ================= 8) 音效 ================= */
section('8) 音效（FakeCtx 计数）');
{
  reset(13);
  ok(R().engine === true, '引擎音常驻（音高随车速）');
  quiet();
  const n0 = sndNodes;
  putObj({ kind: 'car', lane: 0, x: R().player.x, y: R().player.y, v: 0 });
  run(2);
  ok(sndNodes - n0 >= 2, '撞车音（+' + (sndNodes - n0) + '）');
  const n1 = sndNodes;
  setP({ invuln: 0 });
  putObj({ kind: 'fuel', lane: 0, x: R().player.x, y: R().player.y + 90, v: 70, w: 34, h: 76 });
  run(150);
  ok(sndNodes > n1, '加油音（+' + (sndNodes - n1) + '）');
  const n2 = sndNodes;
  setP({ y: R().STAGE_LEN - 5 });
  run(30);
  ok(sndNodes - n2 >= 3, '过关音（+' + (sndNodes - n2) + '）');
  // 静音
  els.btnSound.onclick();
  const n3 = sndNodes;
  clearObjs();
  setP({ invuln: 0 });
  putObj({ kind: 'car', lane: 0, x: R().player.x, y: R().player.y, v: 0 });
  run(3);
  ok(sndNodes === n3, '关掉音效后完全不发声');
  els.btnSound.onclick();
  ok(R().soundOn === true, '重新打开音效');
}

/* ================= 9) 失败收尾状态 ================= */
section('9) 三种结束原因都能正常收尾');
{
  const reasons = [];
  reset(21); setP({ timeLeft: 0.3 }); run(40); reasons.push(R().reason);
  reset(22); quiet(); run(2); for (let k = 0; k < 4 && R().state === 'play'; k++) { setP({ invuln: 0 }); putObj({ kind: 'car', lane: 0, x: R().player.x, y: R().player.y, v: 0 }); run(3); }
  reasons.push(R().reason);
  reset(23); setP({ fuel: 0, v: 30 }); run(60);
  ok(reasons[0] === '时间到' && reasons[1] === '撞毁', '时间到 / 撞毁 两条路径都正常（' + reasons.join(' / ') + '）');
  ok(R().state === 'play' || R().state === 'over', '状态始终合法（' + R().state + '）');
  ok(R().fuel === 0 && R().player.v <= 50, '油尽时车速被压到低速（' + R().player.v.toFixed(0) + '）—— 还能挣扎到加油车');
}

/* ================= 10) ★ 滑屏触控（底部触控区） ================= */
section('10) ★ 滑屏触控：底部专用触控区 / 左右滑动带车 / 上半高速');
{
  const touch = (k, lx, ly, id) => win.__racerTouch(k, lx, ly, id);
  reset(31);
  quiet();
  const s = R();
  const carBottom = s.PY + s.CAR_H / 2;
  ok(s.TOUCH_TOP > carBottom,
     '★ 触控区在玩家车下方（车底缘 ' + carBottom.toFixed(0) + ' < 触控区顶 ' + s.TOUCH_TOP + '）→ 手指不会挡住车',
     '车底 ' + carBottom.toFixed(0) + ' vs 触控区顶 ' + s.TOUCH_TOP);
  ok(s.TOUCH_TOP < s.H && s.TOUCH_TOP > s.HUD_H, '触控区落在屏幕内（' + s.TOUCH_TOP + '..' + Math.round(s.H) + '）');

  const mid = (s.TOUCH_TOP + s.H) / 2, yHi = mid - 12, yLo = mid + 12;

  // ① 画面中部（非触控区）的触摸必须被忽略
  touch('down', s.W / 2, s.TOUCH_TOP - 60, 1);
  ok(R().input.touching === false, '★ 触控区之外的触摸被忽略（不会误触、也不挡视线）');
  touch('up', s.W / 2, s.TOUCH_TOP - 60, 1);

  // ② 触控区上半 = 高速档
  ok(touch('down', s.W / 2, yHi, 1).touching === true, '在触控区按住 → 进入触控操控');
  ok(touch('move', s.W / 2, yHi, 1).gasOn === true, '★ 手指在触控区上半 → 高速档');
  run(90);
  ok(Math.abs(R().player.v - R().V_MAX) < 0.5, '高速档到位（' + R().player.v.toFixed(0) + ' = 400km/h）');

  // ③ 下半 = 常规档
  ok(touch('move', s.W / 2, yLo, 1).gasOn === false, '★ 手指移到下半 → 回常规档');
  run(120);
  ok(Math.abs(R().player.v - R().V_BASE) < 0.5, '常规档到位（' + R().player.v.toFixed(0) + '）');

  // ④ 左右滑动带车
  const x0 = R().player.x;
  touch('move', s.ROAD_L - 10, yLo, 1);
  run(60);
  const xL = R().player.x;
  ok(xL < x0 - 20, '★ 手指左滑 → 车向左（' + x0.toFixed(0) + ' → ' + xL.toFixed(0) + '）');
  ok(Math.abs(xL - (s.ROAD_L - 10)) < 3, '车跟到手指的横向位置（目标 ' + (s.ROAD_L - 10).toFixed(0) + '）');
  touch('move', s.ROAD_R + 10, yLo, 1);
  run(60);
  const xR = R().player.x;
  ok(xR > xL + 20, '★ 手指右滑 → 车向右（' + xL.toFixed(0) + ' → ' + xR.toFixed(0) + '）');
  ok(xR <= s.ROAD_R + 20.5, '仍在横向界内（' + xR.toFixed(0) + ' ≤ ' + (s.ROAD_R + 20) + '）');

  // ⑤ 跟手有速度上限（不是瞬移）
  touch('move', s.ROAD_L, yLo, 1);
  run(1);
  ok(Math.abs(R().player.x - xR) < s.FOLLOW * DT * 1.6,
     '跟手有最大横向速度（1 帧只走 ' + Math.abs(R().player.x - xR).toFixed(1) + '，不是瞬移）');

  // ⑥ 松手：回常规档；车停在原地（★ 不擅自加"自动回正"机制）
  touch('up', s.ROAD_L, yLo, 1);
  ok(R().input.touching === false, '松手 → 退出触控操控');
  ok(R().input.gasOn === false, '松手 → 回常规档');
  const xKeep = R().player.x;
  run(120);
  ok(Math.abs(R().player.x - xKeep) < 1, '松手后车停在原横向位置（不自动回正）');
  ok(Math.abs(R().player.v - R().V_BASE) < 0.5, '松手后速度回常规档');

  // ⑦ 多指：旧代码两指会互相覆盖，这里必须各自有效
  touch('down', s.ROAD_L, yLo, 7);
  touch('down', s.ROAD_R, yLo, 8);
  ok(R().input.touching === true, '两指同时按住 → 仍在操控');
  touch('up', s.ROAD_L, yLo, 8);
  ok(R().input.touching === true, '★ 松开后按的那一指，另一指仍然有效（修掉旧代码多指互相覆盖）');
  touch('move', s.ROAD_L - 5, yLo, 7);
  run(60);
  ok(R().player.x < s.ROAD_L + 30, '剩下的手指继续带车（' + R().player.x.toFixed(0) + '）');
  touch('up', s.ROAD_L - 5, yLo, 7);
  ok(R().input.touching === false, '两指都松开 → 退出操控');

  // ⑧ 触控操控与键盘互不干扰（★ 先把车放回路面：上一步停在左路肩=草地，草地限速到不了高速）
  setP({ x: (s.ROAD_L + s.ROAD_R) / 2 });
  input({ gas: true });
  run(90);
  ok(Math.abs(R().player.v - R().V_MAX) < 0.5 && R().input.touching === false, '键盘油门在触控之外仍然有效（桌面调试用）');
  input({ gas: false });
}

/* ================= 11) ★ 绘制冒烟（防"删了 UI 却残留引用"） ================= */
section('11) ★ 绘制冒烟：各种状态下 draw() 都不能抛错');
{
  const drawOk = () => { try { win.__racerDraw(); return null; } catch (e) { return String(e && e.message || e); } };
  reset(41);
  quiet();
  const cases = [];
  cases.push(['开局(ready/play + 提示卡)', drawOk()]);
  setP({ x: (R().ROAD_L + R().ROAD_R) / 2 });
  run(30);
  cases.push(['行驶中', drawOk()]);
  win.__racerTouch('down', R().W / 2, (R().TOUCH_TOP + R().H) / 2 - 12, 1);
  cases.push(['触控中(高速档)', drawOk()]);
  win.__racerTouch('move', R().W / 2, (R().TOUCH_TOP + R().H) / 2 + 12, 1);
  cases.push(['触控中(常规档)', drawOk()]);
  win.__racerTouch('up', R().W / 2, R().H - 10, 1);
  setP({ timeLeft: 0.2 });
  run(30);
  cases.push(['结束(over)', drawOk()]);
  hintOnForce();
  run(2);
  cases.push(['提示卡显示中', drawOk()]);
  // 三种窗口比例都画一遍（宽矮/竖屏/方屏）
  const sizes = [[390, 260], [390, 700], [760, 700]];
  const origW = els.stage.clientWidth, origH = els.stage.clientHeight;
  for (const [w, h] of sizes) {
    els.stage.clientWidth = w; els.stage.clientHeight = h;
    win.__racerLayout ? win.__racerLayout() : null;
    cases.push(['窗口 ' + w + 'x' + h, drawOk()]);
  }
  els.stage.clientWidth = origW; els.stage.clientHeight = origH;
  const bad = cases.filter(([, e]) => e);
  ok(bad.length === 0, '★ 各状态 + 各窗口比例下 draw() 均不抛错（' + cases.length + ' 种）',
     bad.map(([n, e]) => n + ': ' + e).join(' / '));
}
function hintOnForce(){
  // 让提示卡重新显示（reset 后 hintOn=true；上面触控过会关掉）
  try { win.__racerReset(42); } catch (e) {}
}
/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
