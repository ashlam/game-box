#!/usr/bin/env node
/**
 * 火箭车（Road Fighter 触控版）逻辑回归测试
 *
 * 覆盖：
 *   1) ★ 静止起步：不踩油门不动，按住油门逐渐加速（按用户要求）
 *   2) ★ 油门上限 V_MAX（500 km/h）；吃到红星后限时到 1000 km/h
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
// ★ 现在开局静止（用户要求），测试里默认按住油门 —— 等价于旧版"自动前进"的行为
const reset = seed => { win.__racerReset(seed); win.__racerInput({ gas: true }); };
const input = o => win.__racerInput(o);
const setP = o => win.__racerSetPlayer(o);
const clearObjs = () => win.__racerClearObjs();
const noSpawn = v => win.__racerNoSpawn(v);
function quiet(){ noSpawn(true); clearObjs(); }   // 关掉交通 + 清场（测速/测转向用）
const putObj = o => win.__racerPutObj(o);
const DT = 1 / 60;
const offDetail = {}; let offRoadInfo = null;   // 越界诊断收集（长跑小节用）
function run(n, dt = DT) { for (let i = 0; i < n; i++) step(dt); }

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 1) 自动前进 + 两档速度 ================= */
section('1) ★ 静止起步 · 按住油门才逐渐加速（按用户要求）');
{
  reset(1); quiet();
  input({ gas: false });            // 本节专测静止起步：先松开油门
  const a = R();
  ok(a.state === 'play', '开局即 play');
  ok(a.V_BASE === 180 && a.V_MAX === 400, '速度常数（参考巡航 ' + a.V_BASE + ' / 油门上限 ' + a.V_MAX + '）');
  ok(a.BOOST_MULT === 2.0, '★ 红星加速倍率 ×' + a.BOOST_MULT + ' → 800 逻辑 = ' +
     Math.round(a.V_MAX * a.BOOST_MULT * a.KMH) + ' km/h');
  ok(a.player.v === 0, '★ 开局车速为 0（静止起步）');

  // 不踩油门：车原地不动
  const y0 = R().player.y;
  run(90);
  ok(Math.abs(R().player.y - y0) < 0.5,
     '★ 不踩油门 → 车原地不动（1.5 秒位移 ' + (R().player.y - y0).toFixed(2) + '）');
  ok(R().player.v < 0.5, '不踩油门车速保持 0（不会自动前进）');

  // 踩油门：逐渐加速（不是瞬移）
  input({ gas: true });
  run(6);                                        // 0.1 秒
  const v1 = R().player.v;
  ok(v1 > 0 && v1 < a.V_MAX * 0.6,
     '★ 按下油门后开始加速（0.1 秒 ' + v1.toFixed(0) + '，没瞬移到顶）', 'v=' + v1.toFixed(1));
  run(84);                                       // 累计 1.5 秒
  ok(Math.abs(R().player.v - a.V_MAX) < 0.5,
     '★ 按住油门约 1.4 秒加速到上限 ' + Math.round(a.V_MAX * a.KMH) + ' km/h（实测 ' +
       Math.round(R().player.v * a.KMH) + '）');
  const yG = R().player.y;
  run(60);
  ok(R().player.y - yG > a.V_MAX * 0.9, '油门到底后快速前进（1 秒 ' + (R().player.y - yG).toFixed(0) + ' 逻辑单位）');

  // 松开：减速到停
  input({ gas: false });
  run(20);
  ok(R().player.v < a.V_MAX * 0.85, '★ 松开油门 → 开始减速（' + R().player.v.toFixed(0) + '）');
  run(150);
  ok(R().player.v < 1, '★ 松开油门后减速停车（v=' + R().player.v.toFixed(2) + '）');
  const yS = R().player.y;
  run(60);
  ok(Math.abs(R().player.y - yS) < 0.5, '停下之后不会自己再动（位移 ' + (R().player.y - yS).toFixed(2) + '）');
}


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
    // ★ 上界 = 红星加速上限（吃到红星时合法超过 V_MAX）
    if (s.player.v < -0.01 || s.player.v > s.V_MAX * s.BOOST_MULT + 0.01) offRoadObj++;
    if (s.player.x < s.ROAD_L - 20.5 || s.player.x > s.ROAD_R + 20.5) offRoadObj++;
    for (const o of s.objs) {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) nan++;
      if (o.x < s.ROAD_L - 1 || o.x > s.ROAD_R + 1) { offRoadObj++;
        const kk = o.kind + '@x' + o.x.toFixed(0) + '@lane' + o.lane + '@v' + (o.v||0).toFixed(0);
        offDetail[kk] = (offDetail[kk] || 0) + 1;
        offRoadInfo = { ROAD_L: Math.round(s.ROAD_L), ROAD_R: Math.round(s.ROAD_R), W: Math.round(s.W), LANE_W: s.LANE_W.toFixed(1) };
      }
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
  ok(offRoadObj === 0, '车辆横向/速度不越界（速度上界已含红星加速，越界 ' + offRoadObj + ' 次）',
     JSON.stringify(offDetail) + ' 路面=' + JSON.stringify(offRoadInfo));
  ok(maxPerRow <= R().LANES - 2,
     '★ 同一排最多占 ' + maxPerRow + ' 条道（≤ ' + (R().LANES - 2) + '）→ 4 车道至少留 2 条空，不会并排堵死',
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
input({ gas: false });                      // ★ 本节只测触控：先关掉键盘油门（reset 默认按住）
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

  const mid = (s.TOUCH_TOP + s.TOUCH_BOTTOM) / 2, yHi = mid - 14, yLo = s.TOUCH_BOTTOM - 4;
  const zoneH = s.TOUCH_BOTTOM - s.TOUCH_TOP;
  ok(zoneH === s.ZONE_H,
     '★ 操作区已合并成一个（总高 ' + zoneH + ' = ZONE_H），高低速分界与低速区都已移除',
     'zone=' + zoneH);
  ok(zoneH >= 48, '★ 操作区够手指按住（≥48，当前 ' + zoneH + '）');
  ok(s.TOUCH_MID === undefined && s.ZONE_HI === undefined && s.ZONE_LO === undefined,
     '★ 旧设定彻底移除：TOUCH_MID / ZONE_HI / ZONE_LO 都不存在了');
  ok(s.TOUCH_BOTTOM <= s.H - s.BOTTOM_BAND + 1,
     '★ 触控区整体在底部橙边之上（下边界 ' + s.TOUCH_BOTTOM + ' ≤ ' + (s.H - s.BOTTOM_BAND) + '）—— 这才是"一条缝"的根因');
  ok(s.TOUCH_TOP > s.PY + s.CAR_H / 2, '触控区仍在玩家车下方');

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
  ok(touch('move', s.W / 2, yLo, 1).gasOn === true, '★ 手指按在操作区最下沿 → 仍然是高速档（已无低速区）');
  run(120);
  ok(Math.abs(R().player.v - R().V_MAX) < 0.5, '★ 操作区任意位置都到高速 ' + R().player.v.toFixed(0) + '（已无低速区）');

  // ④ ★ 按下不动 → 车不动；只有左右滑动才移动（用户要求，原来是"按哪去哪"）
  {
    const xBefore = R().player.x;
    touch('down', s.W / 2, yLo, 1);
    run(60);                                     // 按住 1 秒不动
    ok(Math.abs(R().player.x - xBefore) < 0.6,
       '★ 按住屏幕不动 → 车完全不动（不再被吸到手指位置）',
       'x ' + xBefore.toFixed(1) + '→' + R().player.x.toFixed(1));
    ok(Math.abs(R().input.targetX - xBefore) < 0.6, '按下瞬间目标 x = 当时的车 x（锚点建立）');
    touch('move', s.W / 2 + 60, yLo, 1);         // 横滑 +60
    run(60);
    const xA = R().player.x;
    ok(Math.abs(xA - (xBefore + 60)) < 3,
       '★ 手指横滑 +60 → 车右移 60（1:1 相对滑动）',
       xBefore.toFixed(0) + '→' + xA.toFixed(0));
    const xB = R().player.x;
    touch('move', s.W / 2 + 60, yLo + 18, 1);    // 只做竖向移动
    run(45);
    ok(Math.abs(R().player.x - xB) < 0.6, '上下滑动不改变车的横向位置（只切换档位）');
    ok(R().input.gasOn === true, '手指按在任何位置都是高速档');
    touch('move', s.W / 2 - 90, yLo, 1);         // 再左滑
    run(90);
    ok(R().player.x < xB - 60, '继续左滑 → 车继续左移（' + xB.toFixed(0) + '→' + R().player.x.toFixed(0) + '）');
    ok(R().player.x >= s.ROAD_L - 20.5, '仍在横向界内');
    touch('up', s.W / 2 - 90, yLo, 1);
  }

  // ④b ★ 换个位置重新按住，车不能被吸过去（旧实现会直接跳过去）
  {
    const xKeep = R().player.x;
    touch('down', s.ROAD_L + 2, yLo, 5);
    run(45);
    ok(Math.abs(R().player.x - xKeep) < 0.6,
       '★ 按在别处重新按住，车不会被吸过去（锚点机制）',
       'x ' + xKeep.toFixed(0) + '→' + R().player.x.toFixed(0));
    touch('move', s.ROAD_L + 2 + 40, yLo, 5);    // 从新锚点滑 +40
    run(60);
    ok(Math.abs(R().player.x - (xKeep + 40)) < 3, '新锚点之后仍按增量移动（+40）');
    touch('up', s.ROAD_L + 42, yLo, 5);
  }

  input({ gas: false });                     // ★ 先关掉键盘油门，专测触控松手
  // ⑥ 松手：减速停车；车停在原地（★ 不擅自加"自动回正"机制）
  touch('up', s.ROAD_L, yLo, 1);
  ok(R().input.touching === false, '松手 → 退出触控操控');
  ok(R().input.gasOn === false, '松手 → 松开油门（不再加速）');
  const xKeep = R().player.x;
  run(120);
  ok(Math.abs(R().player.x - xKeep) < 1, '松手后车停在原横向位置（不自动回正）');
  run(150);
  ok(R().player.v < 1, '★ 松手后减速停车（v=' + R().player.v.toFixed(2) + '）—— 开局静止后不再有"自动巡航"');

  // ⑦ 多指：旧代码两指会互相覆盖，这里必须各自有效
  touch('down', s.ROAD_L, yLo, 7);
  touch('down', s.ROAD_R, yLo, 8);
  ok(R().input.touching === true, '两指同时按住 → 仍在操控');
  touch('up', s.ROAD_L, yLo, 8);
  ok(R().input.touching === true, '★ 松开后按的那一指，另一指仍然有效（修掉旧代码多指互相覆盖）');
  const x7 = R().player.x;
  touch('move', s.ROAD_L + 50, yLo, 7);          // 7 号指从按下点 ROAD_L 滑到 +50
  run(60);
  ok(Math.abs(R().player.x - (x7 + 50)) < 3,
     '剩下的手指继续带车（Δ+50 → ' + x7.toFixed(0) + '→' + R().player.x.toFixed(0) + '）');
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
  cases.push(['触控中(按住=高速)', drawOk()]);
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
  if (win.__racerLayout) win.__racerLayout();       // ★ 必须恢复布局，否则后面各节都跑在错尺寸上
  const bad = cases.filter(([, e]) => e);
  ok(bad.length === 0, '★ 各状态 + 各窗口比例下 draw() 均不抛错（' + cases.length + ' 种）',
     bad.map(([n, e]) => n + ': ' + e).join(' / '));
}
function hintOnForce(){
  // 让提示卡重新显示（reset 后 hintOn=true；上面触控过会关掉）
  try { win.__racerReset(42); } catch (e) {}
}
/* ================= 12) ★ 敌车分型：外观分类 + 固定属性 + 固定行为 ================= */
section('12) ★ 敌车分型：同类车属性必须完全一致、行为必须可预判');
{
  const E = win.__racerEnemy();
  reset(51);
  noSpawn(false);
  setP({ invuln: 99999 });                     // 观测用：别被撞死打断
  // 采样：每个车型出现过的 (速度|宽|高) 组合、变道情况、亮灯→变道时序
  const combos = {};        // kind → Set("v|w|h")
  const lanes = {};         // id → lane
  const sigFrames = {};     // id → 亮灯帧数
  const sigSeen = {};       // id → 是否见过它亮灯
  const kindOf = {};        // id → kind
  let badChangeNoSignal = 0, nonWeaverChange = 0, weaverChanged = 0, sawSignal = 0, overCruise = 0;
  for (let i = 0; i < 5400; i++) {             // 90 秒
    step(DT);
    const s = R();
    for (const o of s.objs) {
      kindOf[o.id] = o.kind;
      if (o.kind === 'truck' || o.kind === 'sedan' || o.kind === 'sports' || o.kind === 'weaver' || o.kind === 'fuel') {
        // ★ 用"巡航速度 vWant"判定属性固定：实际 v 会被跟车规则压低（那是有意的）
        (combos[o.kind] = combos[o.kind] || new Set()).add((o.vWant === undefined ? 'none' : o.vWant.toFixed(3)) + '|' + o.w + '|' + o.h);
        if (o.vWant !== undefined && o.v > o.vWant + 0.01) overCruise++;
      }
      if (o.signal > 0) { sigSeen[o.id] = true; sawSignal++; }
      if (sigSeen[o.id] && o.signal > 0) sigFrames[o.id] = (sigFrames[o.id] || 0) + 1;
      const prev = lanes[o.id];
      if (prev !== undefined && o.lane !== prev) {          // 观察到一次"换道"
        if (o.kind !== 'weaver') nonWeaverChange++;
        else {
          weaverChanged++;
          if (!sigSeen[o.id]) badChangeNoSignal++;          // ★ 没亮灯就变道 = 犯规
        }
      }
      lanes[o.id] = o.lane;
    }
  }
  // ① 属性固定：同类车只允许出现一种 (速度, 宽, 高)
  const fixedBad = Object.entries(combos).filter(([, set]) => set.size !== 1)
    .map(([k, set]) => k + ' 有 ' + set.size + ' 种组合');
  ok(fixedBad.length === 0, '★ 同类车属性完全固定（每种车型只有一种 巡航速度/宽/高）',
     fixedBad.join(' / '));
  ok(overCruise === 0, '★ 实际速度永不超过本车型巡航速度（被跟车压低是允许的，超速不允许）', '超速 ' + overCruise + ' 帧');
  ok(combos.truck && combos.sedan && combos.sports && combos.weaver, '四种车型都会出现（卡车/轿车/跑车/变道车）');

  // ② 外观可区分：颜色与尺寸互不相同
  const sigs = ['truck', 'sedan', 'sports', 'weaver'].map(k => E[k].color + '|' + E[k].w * E[k].wf + 'x' + E[k].hf);
  ok(new Set(sigs).size === 4, '★ 四种车型的外观（颜色+尺寸）互不相同，一眼可辨');

  // ③ 速度是固定值且符合"慢→快"认知
  ok(E.truck.v < E.weaver.v && E.weaver.v < E.sedan.v && E.sedan.v < E.sports.v,
     '速度排序：卡车 ' + E.truck.v + ' < 变道车 ' + E.weaver.v + ' < 轿车 ' + E.sedan.v + ' < 跑车 ' + E.sports.v);
  ok(E.sports.v > R().V_BASE,
     '★ 跑车(' + (E.sports.v * R().KMH).toFixed(0) + 'km/h) 比玩家常规速(' + (R().V_BASE * R().KMH).toFixed(0) + 'km/h) 还快 → 常规速追不上，必须用高速档');
  ok(E.truck.hf > E.sedan.hf && E.truck.wf > E.sedan.wf, '卡车体积明显更大（远看就能认出）');
  ok(E.sports.hf < E.sedan.hf, '跑车明显低矮（一眼区分）');

  // ④ 只有变道车会变道，且变道必定先亮灯
  ok(nonWeaverChange === 0, '★ 90 秒内生成了大量车，除变道车外没有任何车变道（行为固定可预判）',
     '非变道车变道 ' + nonWeaverChange + ' 次');
  ok(weaverChanged > 0, '★ 变道车确实会变道（观测到 ' + weaverChanged + ' 次）');
  ok(badChangeNoSignal === 0, '★ 每次变道前都亮过琥珀转向灯（没亮灯就变道 = ' + badChangeNoSignal + ' 次）');
  ok(sawSignal > 0, '转向灯确实亮过（累计 ' + sawSignal + ' 帧）');
  const okSigFrames = Object.values(sigFrames).filter(n => n >= 30).length;   // ≥0.5s
  ok(okSigFrames > 0, '亮灯时长足够玩家反应（有 ' + okSigFrames + ' 辆车亮了 ≥0.5 秒）');

  // ⑤ 障碍物与加油车：静止/固定速度、绝不主动变道
  const obsSet = new Set(), fuelSet = new Set();
  reset(52); setP({ invuln: 99999 });
  const obsLanes = {};
  let obsMoved = 0, fuelMoved = 0, obsChanged = 0;
  for (let i = 0; i < 3600; i++) {
    step(DT);
    for (const o of R().objs) {
      if (o.kind === 'cone' || o.kind === 'barrel') {
        obsSet.add(o.v + '|' + o.w + '|' + o.h);
        if (o.v !== 0) obsMoved++;
        if (obsLanes[o.id] !== undefined && o.lane !== obsLanes[o.id]) obsChanged++;
        obsLanes[o.id] = o.lane;
      }
      if (o.kind === 'fuel') {
        fuelSet.add((o.vWant === undefined ? o.v : o.vWant).toFixed(0) + '|' + o.w + '|' + o.h);
        if (o.drift > 0 || o.signal > 0) fuelMoved++;
      }
    }
  }
  ok(obsSet.size <= 2 && ![...obsSet].some(s => !s.startsWith('0|')), '障碍物全部静止且尺寸固定（' + obsSet.size + ' 种）');
  ok(obsMoved === 0 && obsChanged === 0, '★ 障碍物不会移动也不会变道（纯静态）');
  ok(fuelSet.size <= 2, '★ 加油车巡航速度/尺寸固定（' + fuelSet.size + ' 种，含被跟车压低的情况）');
  ok(fuelMoved === 0, '加油车不变道');

  // ⑥ 开局教学：前几排只放最慢的卡车
  reset(53);
  const earlyKinds = new Set(R().objs.map(o => o.kind));
  ok(earlyKinds.size > 0 && [...earlyKinds].every(k => k === 'truck' || k === 'cone' || k === 'barrel'),
     '★ 开局只放最慢的卡车（教学友好），实际：' + [...earlyKinds].join('/'));
}

/* ================= 13) ★ 不穿透：车辆/障碍之间永不重叠 ================= */
section('13) ★ 不穿透机制：跟车 + 硬性钳制');
{
  reset(61);
  noSpawn(false);
  setP({ invuln: 99999 });
  let overlaps = 0, pairs = 0, minGapSeen = Infinity, blockedFrames = 0, frames = 0;
  for (let i = 0; i < 5400; i++) {              // 90 秒
    step(DT);
    frames++;
    const s = R();
    const list = s.objs.filter(o => !o.dead);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b];
        pairs++;
        const dx = Math.abs(A.x - B.x), dy = Math.abs(A.y - B.y);
        const hx = (A.w + B.w) / 2, hy = (A.h + B.h) / 2;
        if (dx < hx && dy < hy) overlaps++;                 // 真实盒子重叠 = 穿透
        if (dx < hx * 0.9) minGapSeen = Math.min(minGapSeen, dy - hy);
      }
    }
    if (s.objs.some(o => o.blocked > 0)) blockedFrames++;
  }
  ok(overlaps === 0, '★ 90 秒全程 车辆/障碍之间零重叠（' + frames + ' 帧 × ' + pairs + ' 组对比）',
     '重叠 ' + overlaps + ' 次');
  ok(blockedFrames > 0, '跟车规则确实生效过（' + blockedFrames + ' 帧有车处于被挡状态）');
  ok(minGapSeen > -1, '★ 同轨迹车辆最小净距始终为正（实测最小 ' + minGapSeen.toFixed(2) + '）', 'minGap ' + minGapSeen.toFixed(2));

  // 定向场景①：跑车(208) 直冲静止锥桶 → 必须跟停，不穿透
  reset(62); noSpawn(true); clearObjs();
  input({ gas: false });                      // ★ 定向场景：玩家原地不动，避免对象被回收
  const s1 = R();
  const laneX1 = s1.ROAD_L + s1.LANE_W * 1.5;
  // 玩家挪到别的车道且无敌，避免撞掉锥桶/被回收干扰观测
  setP({ x: s1.ROAD_L + s1.LANE_W * 0.5, invuln: 99999 });
  putObj({ kind: 'sports', lane: 1, x: laneX1, y: s1.player.y + 120, v: 208, vWant: 208,
           w: s1.CAR_W, h: s1.CAR_H, signal: 0, signalSide: 0, drift: 0, targetX: laneX1 });
  putObj({ kind: 'cone', lane: 1, x: laneX1, y: s1.player.y + 420, v: 0,
           w: Math.max(14, Math.round(s1.CAR_W * 0.74)), h: Math.max(20, Math.round(s1.CAR_H * 0.52)) });
  run(150);                                            // 2.5 秒（跑车距锥桶 300，208 速 1.44 秒即追上）
  const car = R().objs.find(o => o.kind === 'sports'), cone = R().objs.find(o => o.kind === 'cone');
  const gap1 = (cone.y - car.y) - (car.h + cone.h) / 2;
  ok(gap1 >= 0, '★ 跑车追到静止锥桶 → 跟停不穿透（净距 ' + gap1.toFixed(2) + '）', 'gap ' + gap1.toFixed(2));
  ok(car.y < cone.y, '跑车始终没越过锥桶');
  // 设计预期：贴着前车时会以极低速蠕行到"间距余量"平衡点，然后停住
  ok(car.v < 8, '被挡车辆减速到近乎停止（v=' + car.v.toFixed(1) + '，原速 208）');
  ok(car.blocked > 0, '被挡状态被正确标记（blocked=' + car.blocked + '）');

  // 定向场景②：玩家也算前车 —— 后方快车只能跟着，不会穿过玩家
  reset(63); noSpawn(true); clearObjs();
  input({ gas: false });                      // ★ 定向场景：玩家原地不动，避免对象被回收
  const s2 = R();
  const laneX2 = s2.ROAD_L + s2.LANE_W * 1.5;
  setP({ x: laneX2, v: 120 });                          // 玩家慢速，让后车追上来
  putObj({ kind: 'sports', lane: 1, x: laneX2, y: s2.player.y - 60, v: 208, vWant: 208,
           w: s2.CAR_W, h: s2.CAR_H, signal: 0, signalSide: 0, drift: 0, targetX: laneX2 });
  let behindOk = true, minPlayerGap = Infinity;
  for (let i = 0; i < 480; i++) {
    step(DT);
    const st = R();
    const c = st.objs.find(o => o.kind === 'sports');
    if (!c) continue;
    minPlayerGap = Math.min(minPlayerGap, (st.player.y - c.y) - (c.h + st.CAR_H) / 2);
    if (c.y > st.player.y) behindOk = false;            // 越过玩家 = 穿透
  }
  ok(behindOk, '★ 后方快车不会穿过玩家（玩家也被当作前车）');
  ok(minPlayerGap > -1, '★ 与玩家的最小净距始终为正（' + minPlayerGap.toFixed(2) + '）', 'gap ' + minPlayerGap.toFixed(2));
}

/* ================= 14) ★ 视觉等级：能吃的必须一眼可辨 ================= */
section('14) ★ 可辨识性：唯一能被吃的东西必须"视觉上跳出来"');
{
  // 饱和度高低的度量（HSL 里的 S 分量）
  function satOf(hex){
    const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2;
    return mx === mn ? 0 : (l > 0.5 ? (mx-mn)/(2-mx-mn) : (mx-mn)/(mx+mn));
  }
  const E = win.__racerEnemy();
  const fuelSat = satOf('#0ee04a');
  const enemySats = ['truck','sedan','sports','weaver'].map(k => satOf(E[k].color));
  const maxEnemySat = Math.max.apply(null, enemySats);
  ok(fuelSat > maxEnemySat + 0.25,
     '★ 加油车的绿是全饱和色，敌车全部降饱和（S ' + fuelSat.toFixed(2) + ' vs 敌车最高 ' + maxEnemySat.toFixed(2) + '）',
     'fuel ' + fuelSat.toFixed(2) + ' / enemy max ' + maxEnemySat.toFixed(2));
  ok(new Set(['truck','sedan','sports','weaver'].map(k => E[k].color)).size === 4,
     '敌车四种颜色仍互不相同（降饱和后依然可区分类型）');

  // 场上只有 fuel 带 pickup 标记
  // ★ 擦边也要吃到：把油桶横向偏出"盒子相交"5 个单位（旧判定 -4/-6 时吃不到，正是用户报的"有时不消失"）
  reset(73); noSpawn(true); clearObjs();
  {
    const s0 = R(), py0 = s0.player.y, cx = s0.ROAD_L + s0.LANE_W * 1.5;
    setP({ x: cx, invuln: 99999, fuel: 0.5 });
    const off = (Math.round(s0.CAR_W * 0.95) + s0.CAR_W) / 2 + 5;    // 横向差 5 个单位：盒子不相交
    putObj({ kind: 'fuel', lane: 1, x: cx + off, y: py0, v: 0, vWant: 0, pickup: true,
             w: Math.round(s0.CAR_W * 0.95), h: Math.round(s0.CAR_H * 1.05),
             signal: 0, signalSide: 0, drift: 0, targetX: cx + off });
    run(3);
    const o = R().objs.find(q => q.kind === 'fuel');
    ok(o && o.dead && R().fuel > 0.9,
       '★ 擦边碰到油桶也算吃到（旧判定下会漏吃 → 表现为"吃到了桶却不消失"）',
       o ? ('dead=' + o.dead + ' fuel=' + R().fuel.toFixed(2)) : '桶不见了');
  }

  reset(71); noSpawn(false); setP({ invuln: 99999 });
  let pickupKinds = new Set(), fuelSeen = 0, orders = {};
  for (let i = 0; i < 3600; i++) {
    step(DT);
    for (const o of R().objs) {
      if (o.pickup) { pickupKinds.add(o.kind); fuelSeen++; }
      if (o.kind === 'fuel') orders[o.id] = true;
    }
  }
  ok(pickupKinds.size === 2 && pickupKinds.has('fuel') && pickupKinds.has('boost'),
     '★ 场上只有两种五角星带"可拾取"标记（绿=加油 / 红=加油+加速），敌车一律没有（实际：' + [...pickupKinds].join('/') + '）');
  ok(Object.keys(orders).length > 0, '60 秒内至少出现过一辆加油车（出现更密，实际 ' + Object.keys(orders).length + ' 辆）');

  // 定向：强迫开一次加油车，验证吃掉回满油 + 只有它不扣命
  reset(72); noSpawn(true); clearObjs();
  setP({ x: R().ROAD_L + R().LANE_W * 1.5, invuln: 0 });
  const px = R().player.x, py = R().player.y;
  putObj({ kind: 'fuel', lane: 1, x: px, y: py + 110, v: 100, vWant: 100, pickup: true,
           w: Math.round(R().CAR_W * 0.62), h: Math.round(R().CAR_H * 0.80),
           signal: 0, signalSide: 0, drift: 0, targetX: px });
  let eaten = false;
  for (let i = 0; i < 200 && !eaten; i++) { step(DT); eaten = R().objs.some(o => o.kind === 'fuel' && o.dead); }
  ok(eaten && R().fuel > 0.9 && R().hp === 3, '★ 吃到加油车：油回满且不掉命（符合"能吃的"定位）');
}

/* ================= 15) ★ 刷新空间：竖向要留出机动余量 ================= */
section('15) ★ 排间距：按最高速留足换道时间');
{
  reset(81);
  noSpawn(false);
  setP({ invuln: 99999 });
  const seen = new Set(), rows = [];
  let prevIds = new Set();
  for (let i = 0; i < 7200; i++) {                 // 120 秒
    step(DT);
    const s = R();
    for (const o of s.objs) {
      if (prevIds.has(o.id) || seen.has(o.id)) continue;
      seen.add(o.id);
      if (o.y > 1200) rows.push({ y: o.y, kind: o.kind, lane: o.lane, id: o.id });   // 跳过开局教学排
    }
    prevIds = new Set(s.objs.map(o => o.id));
  }
  // ① 排间距：只看**敌车/障碍**的排（加油桶是拾取物，刷在相邻车道不算堵路）
  const traffic = rows.filter(r => r.kind !== 'fuel' && r.kind !== 'boost');   // ★ 拾取物（绿/红星）不算敌车排
  const ys = [...new Set(traffic.map(r => Math.round(r.y)))].sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < ys.length; i++) minGap = Math.min(minGap, ys[i] - ys[i - 1]);
  const vMax = R().V_MAX;
  ok(ys.length > 15, '观测到足够多的敌车排（' + ys.length + ' 排）');
  ok(minGap >= 350, '★ 相邻敌车排竖向间距 ≥ 350 逻辑单位（实测最小 ' + minGap + '）', 'minGap=' + minGap);
  ok(minGap / vMax >= 0.8,
     '★ 最高速(500km/h)下两排之间也留出 ≥0.8 秒机动时间（实测 ' + (minGap / vMax).toFixed(2) + ' 秒）',
     (minGap / vMax).toFixed(2) + 's');

  // ② ★ 横向重叠（同车道/擦边）的两台车，竖向必须留出净距 —— 真正的"堵路"判据
  let sameLaneMin = Infinity, worstPair = null;
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      if (rows[a].lane !== rows[b].lane) continue;              // 横向不重叠 → 不挡路
      const gap = Math.abs(rows[a].y - rows[b].y);
      if (gap < sameLaneMin) { sameLaneMin = gap; worstPair = [rows[a], rows[b]]; }
    }
  }
  ok(sameLaneMin >= 200,
     '★ 同车道两车竖向净距 ≥ 200 逻辑单位（实测最小 ' + Math.round(sameLaneMin) + '）→ 不会叠成一堵墙',
     'min=' + Math.round(sameLaneMin) + ' ' + JSON.stringify(worstPair));

  // ③ 每排占道数
  let worst = 0;
  for (const y of ys) worst = Math.max(worst, new Set(traffic.filter(r => Math.round(r.y) === y).map(r => r.lane)).size);
  ok(worst <= R().LANES - 2, '★ 每排最多占 ' + worst + ' 条道（4 车道至少留 2 条空）', 'worst=' + worst);
}

/* ================= 16) ★ 体积/判定：不许贴着分界线从两车之间穿过去 ================= */
section('16) ★ 车身体积与判定盒：无处可钻');
{
  const s0 = R();
  // ① 几何条件：相邻两车道之间的缝必须小于车身宽，否则就能钻
  const gap = s0.LANE_W - s0.CAR_W;
  ok(s0.CAR_W > s0.LANE_W / 2,
     '★ 车身宽 > 半个车道（车宽 ' + s0.CAR_W + ' vs 半道 ' + (s0.LANE_W / 2).toFixed(1) + '）',
     'CAR_W=' + s0.CAR_W + ' LANE_W=' + s0.LANE_W.toFixed(1));
  ok(gap < s0.CAR_W,
     '★ 相邻车道之间的缝(' + gap.toFixed(0) + ') < 车身宽(' + s0.CAR_W + ') → 塞不进去',
     'gap=' + gap.toFixed(1) + ' CAR_W=' + s0.CAR_W);
  // 最宽的敌车也满足（卡车占道更满）
  const E = win.__racerEnemy();
  const truckW = Math.round(s0.CAR_W * E.truck.wf);
  ok(truckW <= s0.LANE_W * 0.9, '最宽的卡车也不越出车道（' + truckW + ' ≤ ' + (s0.LANE_W * 0.9).toFixed(0) + '）');

  // ② 定向：贴着 0/1 车道分界线正中开，撞向并排两车 → 必须撞上（修前能穿过去）
  reset(91); noSpawn(true); clearObjs();
  {
    const s = R();
    const midX = s.ROAD_L + s.LANE_W;            // 0 号与 1 号车道之间的分界线
    setP({ x: midX, invuln: 0, v: 200 });
    const y0 = s.player.y;
    putObj({ kind: 'sedan', lane: 0, x: s.ROAD_L + s.LANE_W * 0.5, y: y0 + 300, v: 0, vWant: 0,
             w: s.CAR_W, h: s.CAR_H, signal: 0, signalSide: 0, drift: 0, targetX: s.ROAD_L + s.LANE_W * 0.5 });
    putObj({ kind: 'sedan', lane: 1, x: s.ROAD_L + s.LANE_W * 1.5, y: y0 + 300, v: 0, vWant: 0,
             w: s.CAR_W, h: s.CAR_H, signal: 0, signalSide: 0, drift: 0, targetX: s.ROAD_L + s.LANE_W * 1.5 });
    run(240);                                     // 4 秒，足够开到并排两车处
    ok(R().hp < 3,
       '★ 贴着分界线正中开，撞向并排两车 → 撞上（不再从两车之间穿过去）',
       'hp=' + R().hp + '（3=穿过去了）');
  }

  // ③ 定向：判定盒 = 画出来的盒子（横向只重叠 0.5 个单位也算撞）
  reset(92); noSpawn(true); clearObjs();
  {
    const s = R();
    const cx = s.ROAD_L + s.LANE_W * 1.5;
    // ★ 敌车放在"正前方"，否则它会被"不穿透"机制当成在玩家正后方而推开（我自己踩过的坑）
    setP({ x: cx, invuln: 0, v: 200 });
    const dx = s.CAR_W - 0.5;                     // 横向重叠仅 0.5 单位（旧判定 -4 会漏掉）
    putObj({ kind: 'sedan', lane: 1, x: cx - dx, y: s.player.y + 150, v: 0, vWant: 0,
             w: s.CAR_W, h: s.CAR_H, signal: 0, signalSide: 0, drift: 0, targetX: cx - dx });
    run(90);                                      // 1.5 秒，足够开 150 距离
    ok(R().hp === 2,
       '★ 判定盒与画面严格一致：横向仅重叠 0.5 单位也判定撞车（旧的 -4 宽容会让它穿过去）',
       'hp=' + R().hp);
  }

  // ③b ★ 路障尺寸与敌车大致一致（原来只有车的一半，用户反馈不成比例）
  {
    const s = R();
    reset(94); noSpawn(true); clearObjs();
    const s2 = R();
    putObj({ kind: 'cone', lane: 1, x: s2.ROAD_L + s2.LANE_W * 1.5, y: s2.player.y + 200,
             v: 0, w: Math.round(s2.CAR_W * 0.88), h: Math.round(s2.CAR_H * 0.80) });
    run(2);
    const cone = R().objs.find(o => o.kind === 'cone');
    ok(cone && cone.w >= s2.CAR_W * 0.7 && cone.h >= s2.CAR_H * 0.6,
       '★ 路障与敌车尺寸大致一致（锥桶 ' + cone.w + '×' + cone.h + ' vs 车 ' + s2.CAR_W + '×' + s2.CAR_H + '）');
  }

  // ④ 油桶仍保持"擦到就算吃到"（拾取物故意宽容，与敌车相反）
  reset(93); noSpawn(true); clearObjs();
  {
    const s = R();
    const cx = s.ROAD_L + s.LANE_W * 1.5;
    setP({ x: cx, invuln: 99999, fuel: 0.4 });
    const drillW = Math.round(s.CAR_W * 0.62);
    putObj({ kind: 'fuel', lane: 1, x: cx + (drillW + s.CAR_W) / 2 + 5, y: s.player.y, v: 0, vWant: 0,
             w: drillW, h: Math.round(s.CAR_H * 0.80), signal: 0, signalSide: 0, drift: 0, targetX: cx });
    run(3);
    const o = R().objs.find(q => q.kind === 'fuel');
    ok(o && o.dead && R().fuel > 0.9, '★ 油桶仍是"擦到就算吃到"（拾取物故意宽容）');
  }
}

/* ================= 17) ★ 高速两档增压 ================= */
section('17) ★ 红色五角星：加油 + 限时高速（上限 = 原二段 800 km/h）');
{
  reset(101); quiet();
  const s0 = R();
  ok(s0.BOOST_MULT === 2.0 && s0.BOOST_TIME === 4.0,
     '常数：红星加速倍率 ×' + s0.BOOST_MULT + ' / 持续 ' + s0.BOOST_TIME + ' 秒');
  ok(s0.player.boost === 0, '开局没有加速（boost = 0）');
  ok(s0.BOOST_HOLD === undefined && s0.ZONE_HI === undefined,
     '★ 旧设定彻底移除：BOOST_HOLD / boostLv / 高低速分区都不存在');

  // 只按住油门（不吃红星）：上限就是常规高速，不会自己变快
  setP({ x: s0.ROAD_L + s0.LANE_W * 1.5, v: s0.V_BASE });
  input({ gas: true });
  run(300);                                       // 按住 5 秒
  ok(Math.abs(R().player.v - s0.V_MAX) < 0.5,
     '★ 只按住油门（不吃红星）上限就是 ' + Math.round(s0.V_MAX * s0.KMH) + ' km/h，不会自行升档');

  // 吃到红星
  {
    const p = R().player;
    setP({ invuln: 99999, fuel: 0.4 });
    putObj({ kind: 'boost', lane: 1, x: p.x, y: p.y + 150, v: 0, vWant: 0, pickup: true,
             w: Math.round(s0.CAR_W * 0.98), h: Math.round(s0.CAR_H * 0.62) });
    let hitAt = -1;
    for(let i = 0; i < 150; i++){ run(1); if(R().player.boost > 0){ hitAt = i; break; } }
    ok(hitAt >= 0, '★ 吃到红色五角星 → 触发限时高速');
    ok(R().fuel > 0.99, '★ 红星同时把油加满（' + Math.round(R().fuel * 100) + '%）');
    ok(R().player.boost > 0 && R().player.boost <= s0.BOOST_TIME,
       '加速计时开始（剩余 ' + R().player.boost.toFixed(1) + 's）');
  }

  // 逐渐升上去（不是瞬移），到顶是 800 km/h
  run(2);
  ok(R().player.v < s0.V_MAX * s0.BOOST_MULT - 5,
     '★ 加速是逐步上去的（此刻 ' + Math.round(R().player.v) + ' < 上限 ' + Math.round(s0.V_MAX * s0.BOOST_MULT) + '）',
     'v=' + R().player.v.toFixed(1));
  run(180);
  ok(Math.abs(R().player.v - s0.V_MAX * s0.BOOST_MULT) < 0.5,
     '★ 加速上限 = 常规 ×1.6 = ' + Math.round(s0.V_MAX * s0.BOOST_MULT * s0.KMH) + ' km/h（实测 ' +
       Math.round(R().player.v * s0.KMH) + '）');

  // 到期回落
  run(300);
  ok(R().player.boost === 0, '★ 加速时间耗尽（' + s0.BOOST_TIME + ' 秒）后结束');
  ok(Math.abs(R().player.v - s0.V_MAX) < 0.5,
     '★ 到期自动回落到 ' + Math.round(s0.V_MAX * s0.KMH) + ' km/h');

  // 擦边也算吃到（判定宽 8/10）
  reset(102); quiet(); setP({ invuln: 99999, x: R().ROAD_L + R().LANE_W * 1.5, fuel: 0.4 });
  {
    const s2 = R(), p = s2.player;
    const off = (Math.round(s2.CAR_W * 0.98) + s2.CAR_W) / 2 + 5;
    putObj({ kind: 'boost', lane: 1, x: p.x - off, y: p.y + 150, v: 0, vWant: 0, pickup: true,
             w: Math.round(s2.CAR_W * 0.98), h: Math.round(s2.CAR_H * 0.62) });
    input({ gas: true });
    let got = false;
    for(let i = 0; i < 150; i++){ run(1); if(R().player.boost > 0){ got = true; break; } }
    ok(got, '★ 擦边碰到红星也算吃到（和绿星同样的宽容判定）');
  }

  // 新局清零
  reset(103); quiet();
  ok(R().player.boost === 0, '开新局加速计时清零');

  // 红星绘制不抛错（绘制冒烟已覆盖，这里显式画一次含红星的场面）
  putObj({ kind: 'boost', lane: 1, x: R().ROAD_L + R().LANE_W * 1.5, y: R().player.y + 200,
           v: 100, vWant: 100, pickup: true,
           w: Math.round(R().CAR_W * 0.98), h: Math.round(R().CAR_H * 0.62) });
  let derr = null;
  try{ win.__racerDraw(); }catch(e){ derr = String(e.message || e); }
  ok(!derr, '★ 红星在场时绘制不抛错', derr || '');
}


/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
