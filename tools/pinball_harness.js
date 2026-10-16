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
      tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, _text: '', _html: '',
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
    /* ★ textContent 必须像真 DOM 一样**强制转成字符串**：
       真浏览器里 `el.textContent = 230` 读回来是 "230"（字符串）。
       假 DOM 如果原样存数字，就会出现「引用相等却 === 为 false」的怪事
       （断言写 el.textContent === String(coins) 会永远失败，而肉眼看两个值一模一样）。 */
    Object.defineProperty(el, 'textContent', {
      get(){ return el._text; }, set(v){ el._text = String(v); },
    });
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
  /* ★ 记录每次起振的**频率**，用来验证「中奖是上行、没中奖是下行」这类
     旋律走向的断言 —— 只数音符个数是查不出「音区/走向搞反了」的。 */
  const sndFreqs = [];
  class FakeCtx {
    constructor(){ this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; }
    createOscillator(){
      const o = { type:'', _f:0,
        frequency: {
          get value(){ return o._f; },
          set value(v){ o._f = v; },
          setValueAtTime(v){ o._f = v; },
          exponentialRampToValueAtTime(){}, setTargetAtTime(){},
        },
        connect(){},
        start(){ sndStarts++; sndNodes++; sndFreqs.push(o._f); },
        stop(){} };
      return o;
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

  /** 开一局（可选指定倍数），返回是否成功。
   *  seed 传 null = **不 reset**，沿用当前局的 RNG 与钉阵（连续对局用）。
   *  ★ 每局前自动给代币充值：实验台要连打几百发，玩家只有 200 枚，
   *    不充值就会打到没钱、后续全部「发射失败」，量出来的分布是假的。 */
  function openRound({ seed = null, bet = 5, mult = 2, skipAnim = true, fresh = true } = {}){
    if(fresh) win.__pinballReset(seed);
    if(win.__pinballSetCoins) win.__pinballSetCoins(100000);
    if(mult) win.__pinballForceMult(mult);
    win.__pinballInsert(bet);
    const ok = win.__pinballStart();
    if(ok && skipAnim) win.__pinballSkipAnim();
    return ok;
  }

  /** 打一发并等它自然落槽（真实物理）。返回观测数据。
   *  ★ 落点必须在飞行途中抓 —— 结算展示结束后 endRound() 会把 landSlot 清掉。
   *  ★ 默认 **不 reset**：一局一局连着打，RNG 持续推进。
   *    这很重要 —— 每发都 reset 的话出手抖动序列完全相同，
   *    「同力度 = 同落点」是必然的，量出来的多样性是假的（实验台踩过这个坑）。
   *  ★ 循环在「落点已定」时就停，**不等结算动画**：
   *    settle() 会把 mode 置成 'drop' 并倒计时 SETTLE_T（2 秒），
   *    如果等 phase 变化，那 2 秒会被算进「飞行时长」——
   *    实测因此量出「每发飞 10 秒」的假结论（真实飞行约 4 秒）。 */
  function shoot(power, { seed = null, bet = 5, mult = 2, maxFrames = 2400, fresh = false } = {}){
    openRound({ seed, bet, mult, fresh });
    const s0 = M();
    if(!win.__pinballLaunch(power)) return { slot: -1, frames: 0, nan: false, out: false,
                                            tunnel: false, timedOut: false, won: false,
                                            gain: 0, coins: 0, flightT: 0, launchFailed: true };
    let f = 0, nan = false, out = false, tunnel = false;
    let landed = -1, won = false, gain = 0, coinsAt = 0, flightT = 0, landX = NaN;
    let tunnelInfo = null, flyFrames = 0;
    let prevX = null, prevY = null, maxPen = 0, maxPenTouch = 0, maxPenStep = 0;
    /* ★ 循环条件用「phase 还是 fly」而不是「landed<0」：
       settle() 之后 phase 仍是 'fly'（要播结算动画），但 landSlot 已经定了。
       所以用 phase 判循环、用 landSlot 判「什么时候记下结果」，
       同时 flyFrames 只在 landSlot 还没定时累加 —— 这样飞行时长不含结算动画。 */
    while(M().phase === 'fly' && f < maxFrames){
      step(); f++;
      const b = M().ball;
      if(b){
        if(M().landSlot < 0){
          flyFrames++;
          flightT = Math.max(flightT, b.flightT);
        }
        if(![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) nan = true;
        if(b.x < s0.CX_MIN - 0.7 || b.x > s0.CX_MAX + 0.7) out = true;
        if(b.y < s0.ARC_CY){
          const lim = s0.RP + s0.RB;
          /* ★ 区分「真穿钉」与「多钉夹击的残差」：
             球在密集钉阵里可能同时贴住两颗钉，单趟解算把它推出 A 又压进 B，
             帧末残留约 1px 重叠 —— 那不是「穿过去」。
             真穿钉的特征是**单帧位移接近或超过 RB+RP**（球整颗跨过钉子）。
             所以这里一并记录「同时接触几颗钉」与「单帧位移」，供测试判定。 */
          let touch = 0, deepest = 0;
          for(const p of M().pegs){
            const dx = b.x - p.x, dy = b.y - p.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if(d < lim){ touch++; if(lim - d > deepest) deepest = lim - d; }
            if(d < lim - 0.8){
              tunnel = true;
              if(!tunnelInfo){
                tunnelInfo = { f, mode: b.mode, x: +b.x.toFixed(2), y: +b.y.toFixed(2),
                               d: +d.toFixed(2), pen: +(lim - d).toFixed(2),
                               peg: [+p.x.toFixed(1), +p.y.toFixed(1)],
                               sp: +Math.hypot(b.vx, b.vy).toFixed(0), flightT: +b.flightT.toFixed(2) };
              }
            }
          }
          if(deepest > maxPen){
            maxPen = deepest; maxPenTouch = touch;
            maxPenStep = (prevX == null) ? 0 : Math.hypot(b.x - prevX, b.y - prevY);
          }
        }
        prevX = b.x; prevY = b.y;
      }
      if(M().landSlot >= 0 && landed < 0){
        landed = M().landSlot; won = M().landWin; gain = M().landGain; coinsAt = M().coins;
        landX = M().landX;                     // ★ 落点连续 x（量技巧用，见 test_pinball）
      }
    }
    return { slot: landed, landX, frames: flyFrames, totalFrames: f, nan, out, tunnel, tunnelInfo,
             maxPen: +maxPen.toFixed(2), maxPenTouch, maxPenStep: +maxPenStep.toFixed(2),
             timedOut: f >= maxFrames, won, gain, coins: coinsAt, flightT, launchFailed: false };
  }

  return { win, M, DT, step, run, shoot, openRound, els, ledEls, drawRec, sandbox,
           store, sndCount: () => sndStarts, sndFreqs,
           /* ★ 取「最近 n 次起振」的频率 —— 音效计数是全局累加的，
              要单独看某一段（比如结算音乐）就得取尾部快照。 */
           sndFreqsTail: n => sndFreqs.slice(-n),
           HTML, RAW, script };
}

module.exports = { load, HTML };
