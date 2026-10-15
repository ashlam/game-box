#!/usr/bin/env node
/**
 * 弹珠台（pinball）测试/实验台共用的「假 DOM + 假 canvas」装载器。
 *
 * 为什么抽成一份：test_pinball.js（断言规则）与 bench_pinball.js（扫参数调手感）
 * 需要**完全一样**的运行环境 —— 两份各写一遍的话，实验台调出来的手感未必等于
 * 测试里跑的那个环境（曾经在弹珠乐园上吃过「实验台与游戏不同源」的亏）。
 *
 * 用法：
 *   const H = require('./pinball_harness.js');
 *   const { win, M, DT, shoot, ... } = H.load();
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'web', 'pinball', 'index.html');

/* ---------------- 假 canvas ---------------- */
/* ★ 记录型 ctx：记下 fillText / arc 填充 / setLineDash / globalAlpha，
   这样「亮灯的出口真的画成红的」「未亮的是暗的」这类**绘制层**断言才做得出来 ——
   光看游戏状态看不出画没画对（弹珠乐园的地雷 alpha 坑就是这么抓出来的）。 */
function mkGradient(){ return { addColorStop(){} }; }
function load(){
  const drawRec = { texts: [], fills: [], dashes: [], alphas: [], arcs: [] };
  function mkCtx(){
    return new Proxy({}, {
      get(t, k){
        if(k === 'createLinearGradient' || k === 'createRadialGradient') return () => mkGradient();
        if(k === 'measureText') return txt => ({ width: String(txt).length * 7 });
        if(k === 'fillText') return (txt, x, y) => { drawRec.texts.push({ txt: String(txt), x, y, style: t.fillStyle, font: t.font }); };
        if(k === 'setLineDash') return a => { drawRec.dashes.push(a ? a.slice() : []); };
        if(k === 'arc') return (x, y, r) => { t._ax = x; t._ay = y; t._ar = r; };
        if(k === 'fill') return () => { drawRec.fills.push({ x: t._ax, y: t._ay, r: t._ar, style: t.fillStyle }); };
        if(k in t) return t[k];
        return () => {};
      },
      set(t, k, v){ t[k] = v; if(k === 'globalAlpha') drawRec.alphas.push(v); return true; },
    });
  }

  function mkEl(tag){
    const set = new Set();
    const el = {
      tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, textContent: '', _html: '',
      children: [], disabled: false, clientWidth: 390, clientHeight: 640, width: 0, height: 0,
      offsetHeight: 0,
      classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
                   toggle: (c, v) => { if(v === undefined) v = !set.has(c); if(v) set.add(c); else set.delete(c); return v; } },
      addEventListener(){}, removeEventListener(){}, setAttribute(){}, setPointerCapture(){}, releasePointerCapture(){},
      appendChild(c){ this.children.push(c); return c; },
      removeChild(c){ const i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); return c; },
      getBoundingClientRect(){ return { left:0, top:0, width:this.clientWidth, height:this.clientHeight,
                                        right:this.clientWidth, bottom:this.clientHeight }; },
      focus(){}, blur(){}, select(){},
    };
    Object.defineProperty(el, 'innerHTML', { get(){ return el._html; }, set(v){ el._html = v; } });
    return el;
  }

  /* 预置元素：led 排（syncUI 会 querySelectorAll('#leds .led')） */
  const els = {};
  const cvEl = mkEl('canvas'); cvEl.getContext = () => mkCtx(); els.cv = cvEl;
  els.stage = mkEl('div'); els.stage.clientWidth = 390; els.stage.clientHeight = 640;
  els.topbar = mkEl('div'); els.board = mkEl('div'); els.ctlbar = mkEl('div');
  const ledEls = [2,4,6,8,10].map(m => { const e = mkEl('div'); e.dataset.m = String(m); return e; });
  els.leds = mkEl('div'); els.leds.children = ledEls;

  const store = {};
  let sndNodes = 0, sndStarts = 0;
  class FakeCtx {
    constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
    createOscillator(){
      return { type:'', frequency: { value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} },
               connect(){}, start(){ sndStarts++; sndNodes++; }, stop(){} };
    }
    createGain(){ return { gain: { setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){}, value:0 }, connect(){} }; }
    createBuffer(ch, len){ return { getChannelData: () => new Float32Array(len) }; }
    createBufferSource(){ return { buffer:null, connect(){}, start(){ sndStarts++; sndNodes++; } }; }
    createBiquadFilter(){ return { type:'', frequency:{ value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, Q:{ value:0 }, connect(){} }; }
    resume(){ this.state = 'running'; return Promise.resolve(); }
  }

  let perfNow = 1000;
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    /* ★ 可推进的模拟时钟：音效节流用 performance.now()，用真实时钟会 flaky */
    performance: { now: () => perfNow },
    requestAnimationFrame: () => 1, cancelAnimationFrame(){},
    localStorage: { getItem: k => (k in store ? store[k] : null),
                    setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: {
      getElementById: id => els[id] || (els[id] = mkEl('div')),
      createElement: mkEl, addEventListener(){}, removeEventListener(){},
      documentElement: { scrollHeight: 640, classList: { add(){}, remove(){} } }, body: mkEl('body'),
      querySelector: () => null,
      querySelectorAll: sel => (sel === '#leds .led' ? ledEls : []),
    },
    navigator: { userAgent: 'node-test' },
    location: { search: '' },
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  sandbox.window.innerWidth = 390; sandbox.window.innerHeight = 780;
  sandbox.window.devicePixelRatio = 2;
  sandbox.window.AudioContext = FakeCtx;
  sandbox.window.screen = { width: 390, height: 780 };

  vm.createContext(sandbox);
  const RAW = fs.readFileSync(HTML, 'utf8');
  const script = RAW.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, sandbox, { filename: 'pinball-inline.js' });

  const win = sandbox.window;
  const M = () => win.__pinball();
  const DT = 1 / 60;
  const step = (dt = DT) => { perfNow += 16; win.__pinballStep(dt); };
  const run = n => { for(let i = 0; i < n; i++) step(); };

  /** 开一局（可选指定倍数），返回是否成功 */
  function openRound({ seed = null, bet = 5, mult = 2, skipAnim = true } = {}){
    win.__pinballReset(seed);
    if(mult) win.__pinballForceMult(mult);
    win.__pinballInsert(bet);
    const ok = win.__pinballStart();
    if(ok && skipAnim) win.__pinballSkipAnim();
    return ok;
  }

  /** 打一发并等它自然落槽（真实物理）。返回观测数据。
   *  ★ 落点必须在飞行途中抓 —— 结算展示结束后 endRound() 会把 landSlot 清掉。 */
  function shoot(power, { seed = null, bet = 5, mult = 2, maxFrames = 2400 } = {}){
    openRound({ seed, bet, mult });
    const s0 = M();
    win.__pinballLaunch(power);
    let f = 0, nan = false, out = false, tunnel = false;
    let landed = -1, won = false, gain = 0, coinsAt = 0, flightT = 0;
    while(M().phase === 'fly' && f < maxFrames){
      step(); f++;
      const b = M().ball;
      if(b){
        flightT = Math.max(flightT, b.flightT);
        if(![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) nan = true;
        if(b.x < s0.CX_MIN - 0.7 || b.x > s0.CX_MAX + 0.7) out = true;
        if(b.y < s0.ARC_CY){
          for(const p of M().pegs){
            const dx = b.x - p.x, dy = b.y - p.y;
            if(dx * dx + dy * dy < (s0.RP + s0.RB - 0.8) * (s0.RP + s0.RB - 0.8)) { tunnel = true; break; }
          }
        }
      }
      if(M().landSlot >= 0 && landed < 0){
        landed = M().landSlot; won = M().landWin; gain = M().landGain; coinsAt = M().coins;
      }
    }
    return { slot: landed, frames: f, nan, out, tunnel, timedOut: f >= maxFrames,
             won, gain, coins: coinsAt, flightT };
  }

  return { win, M, DT, step, run, shoot, openRound, els, ledEls, drawRec, sandbox,
           store, sndCount: () => sndStarts, HTML, RAW, script };
}

module.exports = { load, HTML };
