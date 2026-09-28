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
  ok(s.V_MAX === 400, '默认 V_MAX = 400（' + Math.round(s.V_MAX * s.KMH) + ' km/h）');
  ok(s.BOOST_MULT === 2.0, '默认 BOOST_MULT = 2.0（红星 ' + Math.round(s.V_MAX * s.BOOST_MULT * s.KMH) + ' km/h）');
  ok(s.BOOST_TIME === 4.0, '默认 BOOST_TIME = 4.0 秒');
  ok(s.TIME_START === 55 && s.TIME_BONUS === 32, '默认时间 55 秒 / 过关加时 32 秒');
  // 按住油门到顶
  holdGas(win, 200);
  ok(Math.abs(win.__racer().player.v - 400) < 0.5, '按油门到顶 = 500 km/h');
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
      ok(s.V_MAX === 400 && s.BOOST_MULT === 2.0, '  → 回退到默认值（V_MAX=' + s.V_MAX + '）');
    }
  }
}

/* ================= 4) 调参页与游戏默认值一致 ================= */
section('4) 调参页字段与游戏默认值一致');
{
  ok(/gracer_cfg/.test(editorHtml), '调参页使用同一个本机键 gracer_cfg');
  ok(/id="rVmax"/.test(editorHtml) && /id="rTime"/.test(editorHtml) && /id="rBoost"/.test(editorHtml) && /id="rBoostT"/.test(editorHtml),
     '调参页有：正常上限 / 开局时间 / 红星上限 / 红星持续 四个滑块');
  ok(/id="rBonus"/.test(editorHtml), '调参页另有关过加时滑块');
  // 调参页默认值 vs 游戏默认值
  const dm = editorHtml.match(/const DEF = \{([^}]+)\}/);
  ok(!!dm, '调参页定义了默认值表');
  const defSrc = dm[1];
  ok(/vMaxKmh:\s*500/.test(defSrc), '调参页默认正常上限 500 km/h（= 游戏 V_MAX 400）');
  ok(/boostKmh:\s*1000/.test(defSrc), '调参页默认红星上限 1000 km/h（= 游戏 400×2.0）');
  ok(/boostTime:\s*4/.test(defSrc), '调参页默认红星持续 4 秒（= 游戏 BOOST_TIME）');
  ok(/timeStart:\s*55/.test(defSrc) && /timeBonus:\s*32/.test(defSrc),
     '调参页默认时间 55/32 秒（= 游戏 TIME_START/TIME_BONUS）');
  ok(/editor\.html/.test(gameHtml), '游戏顶栏有调参页入口');
  ok(/localStorage\.getItem\('gracer_cfg'\)/.test(gameHtml), '游戏启动时读取本机参数');
}

console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
