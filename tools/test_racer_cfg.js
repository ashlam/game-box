#!/usr/bin/env node
/**
 * 火箭车「调参页」联动测试
 *
 * 验证三件事（不能只靠自称）：
 *   1) 没保存过 → 游戏用默认值（和调参页显示的默认值一致）
 *   2) 保存过参数 → 游戏启动时真的生效（速度上限/时间/红星上限与持续时间）
 *   3) 存了坏数据 → 安全回退到默认值，不崩
 *
 * 用法：node tools/test_racer_cfg.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'web', 'racer', 'index.html');
const EDITOR = path.join(__dirname, '..', 'web', 'racer', 'editor.html');
const script = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const editorHtml = fs.readFileSync(EDITOR, 'utf8');
const gameHtml = fs.readFileSync(HTML, 'utf8');

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
class FakeCtx {
  constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
  createOscillator(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, connect(){}, start(){}, stop(){} }; }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, value:0 }, connect(){} }; }
  createBuffer(a, b){ return { getChannelData: () => new Float32Array(b) }; }
  createBufferSource(){ return { buffer: null, connect(){}, start(){} }; }
  createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, connect(){} }; }
  resume(){ this.state = 'running'; return Promise.resolve(); }
}
/** 用指定的 localStorage 内容加载游戏，返回 { win, store } */
function load(store){
  const els = {};
  const cv = mkEl('canvas'); cv.getContext = () => mkCtx(); els.cv = cv;
  const st = mkEl('div'); st.clientWidth = 390; st.clientHeight = 700; els.stage = st;
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => 1000 }, requestAnimationFrame: () => 1,
    localStorage: { getItem: k => (k in store ? store[k] : null),
                    setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { getElementById: id => els[id] || (els[id] = mkEl('div')), createElement: mkEl, addEventListener(){},
                documentElement: { scrollHeight: 700 }, body: mkEl('body') },
    navigator: { userAgent: 'node-test' }, location: { search: '' },
  };
  sb.addEventListener = () => {}; sb.removeEventListener = () => {}; sb.window = sb;
  sb.window.innerWidth = 390; sb.window.innerHeight = 700; sb.window.devicePixelRatio = 2;
  sb.window.AudioContext = FakeCtx; sb.window.isSecureContext = false;
  vm.createContext(sb);
  vm.runInContext(script, sb, { filename: 'racer-inline.js' });
  return sb.window;
}

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }

const DT = 1 / 60;
/** 按住油门跑 n 帧（开局静止，不按住车不走） */
function holdGas(win, n){ win.__racerInput({ gas: true }); for(let i = 0; i < n; i++) win.__racerStep(DT); }

/* ================= 1) 默认值 ================= */
section('1) 没调过参数 → 用默认值');
{
  const win = load({});
  const s = win.__racer();
  ok(s.V_MAX === 640, '默认 V_MAX = 640（' + Math.round(s.V_MAX * s.KMH) + ' km/h）');
  ok(s.BOOST_MULT === 1.38, '默认 BOOST_MULT = 1.38（红星 ' + Math.round(s.V_MAX * s.BOOST_MULT * s.KMH) + ' km/h）');
  ok(s.BOOST_TIME === 8.0, '默认 BOOST_TIME = 8.0 秒');
  ok(s.TIME_START === 55 && s.TIME_BONUS === 32, '默认时间 55 秒 / 过关加时 32 秒');
  // 按住油门到顶
  holdGas(win, 200);
  ok(Math.abs(win.__racer().player.v - 640) < 0.5, '按油门到顶 = ' + Math.round(640 * 1.25) + ' km/h');
}

/* ================= 2) 调参生效 ================= */
section('2) 保存过参数 → 启动时真的生效');
{
  const cfg = { vMaxKmh: 600, timeStart: 90, timeBonus: 40, boostKmh: 1500, boostTime: 8 };
  const win = load({ gracer_cfg: JSON.stringify(cfg) });
  const s = win.__racer();
  ok(s.V_MAX === Math.round(600 / 1.25), '★ 正常上限生效：600 km/h → 逻辑 ' + s.V_MAX);
  ok(s.TIME_START === 90 && s.TIME_BONUS === 40, '★ 时间生效：开局 90 秒 / 过关加时 40 秒');
  ok(Math.abs(s.BOOST_MULT - (1500 / (480 * 1.25))) < 1e-6,
     '★ 红星倍率按上限换算：' + s.BOOST_MULT.toFixed(2) + ' → ' + Math.round(s.V_MAX * s.BOOST_MULT * s.KMH) + ' km/h');
  ok(s.BOOST_TIME === 8, '★ 红星持续生效：8 秒');
  // 实跑：油门到顶 = 600 km/h
  holdGas(win, 260);
  ok(Math.abs(win.__racer().player.v - 480) < 0.5,
     '★ 实跑按油门到顶 = ' + Math.round(win.__racer().player.v * s.KMH) + ' km/h（期望 600）');
  // 实跑：吃红星 → 1500 km/h
  const s2 = win.__racer();
  win.__racerNoSpawn(true); win.__racerClearObjs();
  win.__racerSetPlayer({ x: s2.ROAD_L + s2.LANE_W * 1.5, invuln: 99999, fuel: 0.5 });
  win.__racerPutObj({ kind:'boost', lane:1, x: s2.ROAD_L + s2.LANE_W * 1.5, y: win.__racer().player.y + 150,
                      v:0, vWant:0, w: Math.round(s2.CAR_W*0.98), h: Math.round(s2.CAR_H*0.62),
                      signal:0, signalSide:0, drift:0, targetX: s2.ROAD_L + s2.LANE_W * 1.5 });
  holdGas(win, 150);
  ok(win.__racer().player.boost > 0, '吃到红星（加速计时 > 0）');
  for(let i = 0; i < 260; i++) win.__racerStep(DT);
  const a = win.__racer();
  ok(Math.abs(a.player.v - 480 * 2.5) < 0.5,
     '★ 实跑吃红星到顶 = ' + Math.round(a.player.v * a.KMH) + ' km/h（期望 1500）');
}

/* ================= 3) 坏数据回退 ================= */
section('3) 存了坏数据 → 安全回退默认值');
{
  for(const bad of ['{oops', 'null', '[]', '{"vMaxKmh":"abc"}', '{"vMaxKmh":-5}']){
    let win = null, err = null;
    try{ win = load({ gracer_cfg: bad }); }catch(e){ err = String(e.message || e); }
    ok(!err, '坏数据 ' + JSON.stringify(bad) + ' 不会崩（' + (err || 'ok') + '）');
    if(win){
      const s = win.__racer();
      ok(s.V_MAX === 640 && s.BOOST_MULT === 1.38, '  → 回退到默认值（V_MAX=' + s.V_MAX + '）');
    }
  }
}

/* ================= 4) 调参页与游戏默认值一致 ================= */
section('4) 调参页字段与游戏默认值一致');
{
  ok(/gracer_cfg/.test(editorHtml), '调参页使用同一个本机键 gracer_cfg');
  ok(/inp\.type = 'number'/.test(editorHtml) && !/type="range"/.test(editorHtml),
     '★ 参数改用数字输入框（−/＋ 微调 + 直接打字），不再是滑块');
  ok(/className = 'sp'/.test(editorHtml) && /textContent = '−'/.test(editorHtml),
     '输入框带 − / ＋ 步进按钮（手机上不用呼出键盘也能调）');
  // 整体参数表
  const gsrc = editorHtml.match(/const GLOBALS = \[([\s\S]*?)\n  \];/);
  ok(!!gsrc, '调参页有整体参数表 GLOBALS');
  const g = gsrc ? gsrc[1] : '';
  ok(['vMaxKmh', 'timeStart', 'timeBonus', 'boostKmh', 'boostTime'].every(k => new RegExp("k:'" + k + "'").test(g)),
     '整体参数含：正常上限 / 开局时间 / 过关加时 / 红星上限 / 红星持续');
  ok(/vMaxKmh:800/.test(editorHtml) && /timeStart:55/.test(editorHtml) &&
     /timeBonus:32/.test(editorHtml) && /boostKmh:1100/.test(editorHtml) && /boostTime:8/.test(editorHtml),
     '★ 调参页默认值 800/55/32/1100/8 = 游戏默认（V_MAX 640 · 时间 55·32 · 红星 1100）');
  ok(/editor\.html/.test(gameHtml), '游戏顶栏有调参页入口');
  ok(/localStorage\.getItem\('gracer_cfg'\)/.test(gameHtml), '游戏启动时读取本机参数');
}

/* ================= 5) 伤害分档 ================= */
section('5) 伤害分档：默认值 / 调参生效 / 0 值合法');
{
  const win = load({});
  const s = win.__racer();
  ok(s.DMG_BLOCK === 30 && s.DMG_CAR === 40 && s.DMG_TRUCK === 60 && s.DMG_HAULER === 80,
     '默认伤害：路障 30 / 小车 40 / 卡车 60 / 大货车 80');
  ok(s.DMG.cone === 30 && s.DMG.barrel === 30 && s.DMG.sports === 40 && s.DMG.sedan === 40 &&
     s.DMG.weaver === 40 && s.DMG.truck === 60 && s.DMG.hauler === 80,
     '★ 分档值已展开进伤害表（' + JSON.stringify(s.DMG) + '）');
  ok(s.DMG_DEFAULT === 40, '未知类型按小车算（DMG_DEFAULT=' + s.DMG_DEFAULT + '）');
  ok(s.DMG_BLOCK < s.DMG_CAR && s.DMG_CAR < s.DMG_TRUCK && s.DMG_TRUCK < s.DMG_HAULER,
     '★ 越重越疼：30 < 40 < 60 < 80');

  const w2 = load({ gracer_cfg: JSON.stringify({
    dmgCone: 5, dmgBarrel: 5, dmgSports: 15, dmgSedan: 15, dmgWeaver: 15, dmgTruck: 25, dmgHauler: 35 }) });
  const s2 = w2.__racer();
  ok(s2.DMG.cone === 5 && s2.DMG.barrel === 5 && s2.DMG.sedan === 15 &&
     s2.DMG.sports === 15 && s2.DMG.weaver === 15 && s2.DMG.truck === 25 && s2.DMG.hauler === 35,
     '★ 逐类型调参生效：5/5/15/15/15/25/35（' + JSON.stringify(s2.DMG) + '）');
  ok(s2.DMG_DEFAULT === 15, '调参后未知类型跟着小车走（' + s2.DMG_DEFAULT + '）');

  const w3 = load({ gracer_cfg: JSON.stringify({ dmgSedan: 0 }) });
  ok(w3.__racer().DMG.sedan === 0,
     '★ 伤害 0 是合法值（撞小车不扣血），不会被当成「没设」而回退默认');
  ok(w3.__racer().DMG.sports === 40 && w3.__racer().DMG.hauler === 80,
     '★ 只把轿车设成 0 时，跑车仍是 40、大货车仍是 80（同档形象互不牵连）');

  // 实跑：把大货车调成 100（= 生命上限）→ 一击必杀
  const w4 = load({ gracer_cfg: JSON.stringify({ dmgHauler: 100 }) });
  w4.__racerNoSpawn(true); w4.__racerClearObjs();
  const s4 = w4.__racer();
  w4.__racerSetPlayer({ invuln: 0 });
  w4.__racerPutObj({ kind: 'hauler', lane: 1, x: s4.player.x, y: s4.player.y, v: 0, vWant: 0,
                     w: s4.CAR_W, h: s4.CAR_H, signal: 0, signalSide: 0, drift: 0, targetX: s4.player.x });
  for (let i = 0; i < 10; i++) w4.__racerStep(DT);
  const r4 = w4.__racer();
  ok(r4.hp === 0 && r4.state === 'over',
     '★ 大货车调到 100 → 一击必杀（生命 ' + r4.hp + '，状态 ' + r4.state + '）');
}

/* ================= 6) 对象图鉴 ================= */
section('6) 调参页：每种形象都有缩略图 + 独立数值');
{
  const kinds = ['cone', 'barrel', 'sports', 'sedan', 'weaver', 'truck', 'hauler'];
  const osrc = editorHtml.match(/const OBJS = \[([\s\S]*?)\n  \];/);
  ok(!!osrc, '调参页有对象表 OBJS');
  const o = osrc ? osrc[1] : '';
  ok(kinds.every(k => new RegExp("kind:'" + k + "'").test(o)),
     '★ 七种形象都有条目：锥桶 / 油桶 / 跑车 / 轿车 / 变道车 / 卡车 / 大货车');
  ok(/drawIcon/.test(editorHtml) && /carShape/.test(editorHtml) &&
     /haulerShape/.test(editorHtml) && /starShape/.test(editorHtml),
     '★ 缩略图是照游戏画法重画的（普通车 / 大货车 / 五角星各有画法），不是占位块');
  ok(kinds.every(k => new RegExp("dmg:'dmg" + k.charAt(0).toUpperCase() + k.slice(1) + "'").test(o)),
     '★ 每种形象的扣血都能单独设（dmgCone…dmgHauler 各自一个键）');
  ok(['sports', 'sedan', 'weaver', 'truck', 'hauler'].every(
       k => new RegExp("spd:'spd" + k.charAt(0).toUpperCase() + k.slice(1) + "'").test(o)),
     '★ 五种车的速度都能单独设');
  ok(/block:30, car:40, truck:60, hauler:80/.test(editorHtml),
     '★ 默认值按档位给：路障 30 / 小车 40 / 卡车 60 / 大货车 80');
  ok(/护盾无效/.test(o) && /危/.test(o), '大货车条目标了「护盾无效」与「危」字（和游戏里一致）');
  ok(/绿色油箱/.test(editorHtml) && /红色油箱/.test(editorHtml) && /class="tag eat"/.test(editorHtml),
     '另有「能吃的」分区：绿色 / 红色油箱，标了可吃');
  ok(/applyDmg/.test(gameHtml) && /DMG_BLOCK/.test(gameHtml),
     '游戏侧有分档变量 + 展开函数（调参后能重建伤害表）');
  ok(/DMG_OVER/.test(gameHtml) && /dmg'\s*\+/.test(gameHtml),
     '游戏侧支持逐类型覆盖（DMG_OVER 优先于档位）');
}

/* ================= 7) 逐类型覆盖生效 ================= */
section('7) 逐类型覆盖：每种形象的数值独立生效');
{
  const w = load({ gracer_cfg: JSON.stringify({
    dmgCone: 7, dmgBarrel: 9, dmgSports: 11, dmgSedan: 13, dmgWeaver: 17, dmgTruck: 23, dmgHauler: 29,
    spdSports: 400, spdHauler: 200 }) });
  const s = w.__racer();
  ok(s.DMG.cone === 7 && s.DMG.barrel === 9 && s.DMG.sports === 11 && s.DMG.sedan === 13 &&
     s.DMG.weaver === 17 && s.DMG.truck === 23 && s.DMG.hauler === 29,
     '★ 七种形象各扣各的血（' + JSON.stringify(s.DMG) + '）');
  ok(s.DMG_BLOCK === 30 && s.DMG_CAR === 40 && s.DMG_TRUCK === 60 && s.DMG_HAULER === 80,
     '★ 档位默认值仍在（逐类型是覆盖，不是替换档位）');
  ok(s.ENEMY.sports.v === Math.round(400 / 1.25) && s.ENEMY.hauler.v === Math.round(200 / 1.25),
     '★ 速度按 km/h 换算生效：跑车 400 → ' + s.ENEMY.sports.v + '，大货车 200 → ' + s.ENEMY.hauler.v);
  ok(s.ENEMY.sedan.v === 150 && s.ENEMY.truck.v === 88,
     '没调的车保持默认速度（轿车 ' + s.ENEMY.sedan.v + ' / 卡车 ' + s.ENEMY.truck.v + '）');

  const w2 = load({ gracer_cfg: JSON.stringify({ dmgBarrel: 45 }) });
  const s2 = w2.__racer();
  ok(s2.DMG.barrel === 45 && s2.DMG.cone === 30,
     '★ 只改油桶时，锥桶仍按路障档 30（' + s2.DMG.cone + '）—— 同档形象可分开设');
}

/* ================= 8) 调参页脚本冒烟 ================= */
section('8) 调参页脚本真的能跑起来（假 DOM 里执行一遍）');
{
  const editorScript = editorHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {}, store = {}, icons = [];
  // canvas 的 ctx 换成「记账版」：每调用一次绘制 API 就 +1，用来证明图不是空白
  const mkCanvas = () => {
    const c = mkEl('canvas'), rec = { n: 0 };
    c.getContext = () => new Proxy({}, {
      get(t, k){
        if(k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
        if(k in t) return t[k];
        return () => { rec.n++; };
      },
      set(t, k, v){ t[k] = v; rec.n++; return true; },
    });
    icons.push(rec);
    return c;
  };
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => 1000 }, requestAnimationFrame: () => 1,
    localStorage: { getItem: k => (k in store ? store[k] : null),
                    setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { getElementById: id => els[id] || (els[id] = mkEl('div')),
                createElement: tag => (tag === 'canvas' ? mkCanvas() : mkEl(tag)),
                addEventListener(){}, documentElement: { scrollHeight: 700 },
                body: mkEl('body'), activeElement: null },
    navigator: { userAgent: 'node-test' }, location: { href: '', search: '' },
    devicePixelRatio: 2, isSecureContext: false,
  };
  sb.addEventListener = () => {}; sb.window = sb;
  let err = null;
  try{
    vm.createContext(sb);
    vm.runInContext(editorScript, sb, { filename: 'editor-inline.js' });
  }catch(e){ err = String((e && e.message) || e); }
  ok(!err, '★ 调参页脚本执行不报错（含 7 张缩略图 + 2 张道具图绘制）' + (err ? ' → ' + err : ''));
  ok(icons.length === 9, '★ 一共 9 张缩略图（7 种障碍/车 + 2 种油箱），实际建了 ' + icons.length + ' 个 canvas');
  ok(icons.every(r => r.n >= 8),
     '★ 每张缩略图都真的画了东西（最少的一张也有 ' + Math.min.apply(null, icons.map(r => r.n)) + ' 次绘制调用）');
  const calc = (els.calc && els.calc.textContent) || '';
  ok(/正常上限/.test(calc) && /红星持续/.test(calc), '换算结果渲染出来了');
  ok(['锥桶', '油桶', '跑车', '轿车', '变道车', '卡车', '大货车'].every(n => calc.indexOf(n) >= 0),
     '★ 换算结果逐条列出每种形象的扣血');
  els.btnSave.onclick();
  const saved = store.gracer_cfg ? JSON.parse(store.gracer_cfg) : null;
  ok(!!saved, '点「保存并试玩」会写入本机 gracer_cfg');
  if(saved){
    ok(saved.dmgHauler === 80 && saved.dmgCone === 30 && saved.dmgBarrel === 30 && saved.spdHauler === 78,
       '★ 存的是逐类型值（大货车 80 / 锥桶 30 / 油桶 30 / 大货车 78 km/h）');
    const w = load({ gracer_cfg: store.gracer_cfg });
    const s = w.__racer();
    ok(s.DMG.hauler === 80 && s.DMG.cone === 30 && s.ENEMY.hauler.v === 62,
       '★ 游戏读到这份存档后确实生效（大货车扣 80 · 锥桶 30 · 大货车速度 62）');
  }
}

console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
