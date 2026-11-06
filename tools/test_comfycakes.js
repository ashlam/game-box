#!/usr/bin/env node
/**
 * 流水线做蛋糕（Comfy Cakes）回归测试
 *
 * 覆盖：
 *   1) 订单合法性：每一层的正确答案必须在该层的候选里（否则玩家永远做不对）
 *   2) ★ 蛋糕体和糖霜不许撞色 —— 小尺寸下撞色就分不出「这一层做了没有」
 *   3) 难度曲线：候选数、思考时间随关卡单调
 *   4) ★ 端到端：连做 3 单全对 → 分数涨、命不掉、订单队列往前推
 *   5) 出错：扣一条命、连击清零、不给分
 *   6) 超时：那一层空着，蛋糕照样送出去，但判定为失败
 *   7) 三条命用完 → 结算，且不再接受操作
 *   8) 画一帧不抛异常（五个形状 × 四层各种组合都走一遍）
 *   9) 单文件自包含：无外链、无图片，返回键是 "/"
 *
 * 用法：node tools/test_comfycakes.js [web/comfycakes/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'comfycakes', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t){ console.log('\n== ' + t + ' =='); }
function eq(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

/* ================= 假 DOM ================= */

const NOP = () => {};
function mkCtx(){
  const ctx = {
    save: NOP, restore: NOP, beginPath: NOP, closePath: NOP,
    moveTo: NOP, lineTo: NOP, quadraticCurveTo: NOP, bezierCurveTo: NOP,
    arc: NOP, arcTo: NOP, ellipse: NOP, rect: NOP,
    fill: NOP, stroke: NOP, clip: NOP,
    fillRect: NOP, strokeRect: NOP, clearRect: NOP,
    translate: NOP, scale: NOP, rotate: NOP, setTransform: NOP, transform: NOP,
    setLineDash: NOP, fillText: NOP, strokeText: NOP,
    measureText(){ return { width: 10 }; },
    createLinearGradient(){ return { addColorStop: checkColor }; },
    createRadialGradient(){ return { addColorStop: checkColor }; },
    createPattern(){ return null; },
    drawImage: NOP,
    getImageData(){ return { data: [0,0,0,0] }; },
  };
  return ctx;
}

function mkEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], parentNode: null,
    style: {}, dataset: {}, _cls: '', _html: '',
    textContent: '', clientWidth: 370, clientHeight: 620,
    hidden: false, disabled: false, type: '', title: '',
    _h: {}, _attr: {},
  };
  el.classList = {
    add(c){ const a = el._cls.split(/\s+/).filter(Boolean); if(a.indexOf(c) < 0) a.push(c); el._cls = a.join(' '); },
    remove(c){ el._cls = el._cls.split(/\s+/).filter(x => x && x !== c).join(' '); },
    contains(c){ return el._cls.split(/\s+/).indexOf(c) >= 0; },
    toggle(c, on){ if(on) el.classList.add(c); else el.classList.remove(c); },
  };
  Object.defineProperty(el, 'className', {
    get(){ return el._cls; },
    set(v){ el._cls = String(v); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){
      el._html = String(v);
      // 只需要区分「清空」这一种用法
      if(el._html === '') el.children = [];
    },
  });
  Object.defineProperty(el, 'width', { get(){ return el._w || 0; }, set(v){ el._w = v; } });
  Object.defineProperty(el, 'height', { get(){ return el._h2 || 0; }, set(v){ el._h2 = v; } });
  el.getContext = () => (el._ctx = el._ctx || mkCtx());
  el.addEventListener = (t, f) => { (el._h[t] = el._h[t] || []).push(f); };
  el.removeEventListener = NOP;
  el.fire = (t, ev) => { (el._h[t] || []).forEach(f => f(ev || { preventDefault: NOP, target: el })); };
  el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if(i >= 0) el.children.splice(i, 1); return c; };
  el.setAttribute = (k, v) => { el._attr[k] = String(v); };
  el.getAttribute = (k) => (k in el._attr ? el._attr[k] : null);
  el.closest = () => null;
  el.querySelectorAll = (sel) => (sel[0] === '.' ? byClass(el, sel.slice(1)) : byTag(el, sel));
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.focus = NOP; el.select = NOP;
  el.getBoundingClientRect = () => ({ left:0, top:0, width:el.clientWidth, height:el.clientHeight,
                                      right:el.clientWidth, bottom:el.clientHeight });
  return el;
}

function allDesc(el, out){
  out = out || [];
  el.children.forEach(c => { out.push(c); allDesc(c, out); });
  return out;
}
function byClass(root, cls){
  return allDesc(root).filter(e => e.classList.contains(cls));
}
function byTag(root, tag){
  return allDesc(root).filter(e => e.tagName === String(tag).toUpperCase());
}

/* 浏览器认的颜色写法：hex / rgb() / rgba() / 关键字。其它一律算错。
   这条守着 shade() 叠着用时的解析问题。 */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;
function checkColor(pos, col){
  if(!COLOR_RE.test(String(col))) throw new Error('addColorStop 收到无法解析的颜色：' + col);
}

const els = {};
['stage','cv','ordersEl','optsEl','pickLabel','timerBox','timerBar','scoreEl','livesEl',
 'sndBtn','ov','sheetStart','sheetOver','bestStart','startBtn','againBtn','overScore',
 'overCakes','overBest','overLead','newBest','pickEl'].forEach(id => { els[id] = mkEl('div'); });
els.cv = mkEl('canvas');
els.stage.clientWidth = 370;
els.stage.clientHeight = 620;
els.sheetOver.hidden = true;
els.ov.hidden = false;

const document = {
  getElementById: (id) => els[id] || null,
  createElement: (tag) => mkEl(tag),
  addEventListener: NOP,
  body: mkEl('body'),
  title: '',
  hidden: false,
};

let rafQueue = [];
const win = {
  devicePixelRatio: 2,
  addEventListener: NOP,
  requestAnimationFrame: (f) => { rafQueue.push(f); return rafQueue.length; },
  performance: { now: () => Date.now() },
  localStorage: {
    _d: {},
    getItem(k){ return k in this._d ? this._d[k] : null; },
    setItem(k, v){ this._d[k] = String(v); },
  },
  AudioContext: undefined,
  webkitAudioContext: undefined,
};

const sandbox = {
  window: win,
  document,
  console,
  performance: win.performance,
  requestAnimationFrame: (f) => win.requestAnimationFrame(f),
  setTimeout: (f, t) => 0,
  clearTimeout: NOP,
  Math, Date, JSON, parseInt, parseFloat, String, Number, Object, Array, isNaN,
};
sandbox.globalThis = sandbox;
sandbox.window.window = win;
Object.assign(win, { document, localStorage: win.localStorage });

/* ================= 取脚本 ================= */
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if(!m){ console.error('找不到内联脚本'); process.exit(1); }

vm.createContext(sandbox);
try{
  vm.runInContext(m[1], sandbox, { filename: 'comfycakes.js' });
}catch(e){
  console.error('脚本执行失败:', e && e.stack || e);
  process.exit(1);
}

const CC = win.__cc;
if(!CC){ console.error('没有导出 window.__cc 调试接口'); process.exit(1); }
const G = CC.state;

/* ================= 驱动 ================= */
const DT = 1 / 60;
function tick(n){ for(let i = 0; i < n; i++) CC.tick(1, DT); }
function untilPh(ph, max){
  const lim = max || 3000;
  for(let i = 0; i < lim; i++){
    if(G.phase === ph) return true;
    CC.tick(1, DT);
  }
  return false;
}
function station(ok_){
  if(!untilPh('waiting')) return false;
  const order = G.orders[0];
  const f = ['shape','batter','icing','pattern'][G.station];
  const right = order.cake[f];
  if(ok_ === false){
    const pool = order.pool[G.station];
    const wrong = pool.filter(v => v.id !== right.id)[0];
    if(!wrong) return false;
    CC.choose(wrong.id);
  } else {
    CC.choose(right.id);
  }
  return true;
}
function makeCake(okLayers){
  for(let i = 0; i < 4; i++){
    const want = okLayers ? okLayers[i] : true;
    if(!station(want)) return false;
    tick(70);   // 走完加工 + 移动到下一站
  }
  return true;
}

/* ================= 1. 订单合法性 ================= */
section('1. 订单生成');
{
  CC.start();
  let allOk = true, badCase = '';
  for(let round = 0; round < 200; round++){
    // 通过连续失败把订单推走比较慢，直接造：反复 start 重新发牌
    G.orders = [];
    CC.state.done = round * 3;
    CC.start();
    G.orders.forEach((o, oi) => {
      for(let s = 0; s < 4; s++){
        const f = ['shape','batter','icing','pattern'][s];
        const want = o.cake[f];
        if(!want) { allOk = false; badCase = '第' + oi + '单第' + s + '层没有答案'; return; }
        if(!o.pool[s].some(v => v.id === want.id)){
          allOk = false; badCase = '第' + oi + '单第' + s + '层答案不在候选里';
        }
        if(o.pool[s].length < 2){
          allOk = false; badCase = '第' + oi + '单第' + s + '层候选少于 2';
        }
      }
    });
    if(!allOk) break;
  }
  ok(allOk, '每一层的正确答案都在这层的候选里（200 轮）', badCase);
}

/* ================= 2. 蛋糕体 / 糖霜不撞色 ================= */
{
  CC.start();
  let allOk = true, badCase = '';
  for(let i = 0; i < 300; i++){
    CC.start();
    G.orders.forEach((o, oi) => {
      if(o.cake.icing.id === o.cake.batter.id){
        allOk = false; badCase = '第' + oi + '单: ' + o.cake.batter.id;
      }
    });
    if(!allOk) break;
  }
  ok(allOk, '蛋糕体和糖霜不会同色（300 轮 × 3 单）', badCase);
}

/* ================= 3. 难度曲线 ================= */
section('3. 难度曲线');
{
  const levels = [1,2,3,4,5,6,7,8];
  const pools = levels.map(l => CC.poolSize(l));
  ok(pools[0] === 2, '第 1 关每层 2 个候选', '实际 ' + pools[0]);
  ok(pools[3] === 5 && pools[7] === 5, '第 4 关起封顶 5 个候选', pools.join(','));
  ok(pools.every((v, i) => i === 0 || v >= pools[i-1]), '候选数随关卡不减', pools.join(','));
  ok(pools[7] <= 5, '候选数不超过选项表长度');

  // 时间：等 cake 到第一站，看 waitMax
  CC.start();
  const waits = [];
  [1,2,3,8,12].forEach(l => {
    CC.start();
    G.level = l;
    G.orders = [];
    CC.start();
    G.level = l;
    untilPh('waiting');
    waits.push(+G.waitMax.toFixed(2));
  });
  ok(waits[0] === 5.5, '第 1 关每站给 5.5 秒', String(waits[0]));
  ok(waits[2] < waits[0] && waits[3] < waits[2], '关卡越高思考时间越短', waits.join(','));
  ok(waits[4] >= 2.6, '思考时间有下限（不低于 2.6 秒）', String(waits[4]));
}

/* ================= 4. 端到端：全对 ================= */
section('4. 端到端 · 全对');
{
  CC.start();
  const score0 = G.score;
  const lives0 = G.lives;
  const firstCake = G.orders[0].cake.shape.id;

  ok(makeCake(), '做完四层');
  ok(untilPh('result'), '蛋糕送到窗口');
  ok(G.ok === true, '判定为正确');
  ok(G.score > score0, '加分了', score0 + ' → ' + G.score);
  ok(G.lives === lives0, '不扣命');
  ok(G.done === 1, '做成数 +1', String(G.done));

  ok(untilPh('waiting'), '自动开下一单');
  ok(G.orders[0].cake.shape.id !== undefined, '下一单有内容');
  ok(G.orders.length === 3, '订单队列一直是 3 张', String(G.orders.length));

  // 连做三单
  makeCake();
  untilPh('waiting');
  makeCake();
  untilPh('waiting');
  ok(G.done >= 3, '连做 3 单都记上了', String(G.done));
  ok(G.lives === 3, '一次没扣命', String(G.lives));
  ok(G.combo >= 3, '连击累计', String(G.combo));
}

/* ================= 5. 出错 ================= */
section('5. 出错');
{
  CC.start();
  makeCake();            // 先做对一个，攒连击
  untilPh('waiting');
  const s0 = G.score, l0 = G.lives, c0 = G.combo;
  ok(c0 >= 1, '此时有连击', String(c0));

  makeCake([false, true, true, true]);   // 第一层故意错
  ok(untilPh('result'), '仍然会送到窗口');
  ok(G.ok === false, '判定为失败');
  ok(G.lives === l0 - 1, '扣一条命', l0 + ' → ' + G.lives);
  ok(G.score === s0, '错误不加分', String(G.score));
  ok(G.combo === 0, '连击清零');
  ok(eq(G.layerOk, [false, true, true, true]), '逐层结果对得上', JSON.stringify(G.layerOk));
}

/* ================= 6. 超时 ================= */
section('6. 超时');
{
  CC.start();
  ok(untilPh('waiting'), '到第一站');
  // 干等着，不给任何输入
  let waited = 0;
  while(G.phase === 'waiting' && waited < 400){ CC.tick(1, DT); waited++; }
  ok(G.phase !== 'waiting', '超时后自己往下走', G.phase);
  ok(G.doneLayers[0] === false, '这一层没做上');
  ok(G.cake.shape === null, '蛋糕形状还是空的');

  // 剩下三层做对，仍然应该失败
  for(let i = 1; i < 4; i++){ station(true); tick(70); }
  ok(untilPh('result'), '送到窗口');
  ok(G.ok === false, '缺一层就算失败');
  ok(G.layerOk[0] === false && G.layerOk[1] === true, '逐层结果：第一层空');
}

/* ================= 7. 三条命用完 ================= */
section('7. 结算');
{
  CC.start();
  let guard = 0;
  while(!G.over && guard < 12){
    makeCake([false, false, false, false]);
    untilPh('result');
    tick(120);
    guard++;
  }
  ok(G.over === true, '错三次后进入结算', '用了 ' + guard + ' 单');
  ok(G.lives === 0, '命归零', String(G.lives));
  ok(els.ov.hidden === false, '弹层显示出来了');
  ok(els.sheetOver.hidden === false, '是结算那一页');
  ok(String(els.overScore.textContent) === String(G.score),
     '结算分数写进去了', String(els.overScore.textContent));

  // 结算后不再接受输入
  const before = G.score;
  CC.choose('circle');
  tick(30);
  ok(G.score === before, '结算后点按钮没反应');
}

/* ================= 8. 绘制不抛异常 ================= */
section('8. 绘制');
{
  let threw = null;
  try{
    const shapes = ['circle','square','heart','star','flower'];
    CC.start();
    for(let i = 0; i < shapes.length; i++){
      G.cake = {
        shape: { id: shapes[i], name: shapes[i] },
        batter: { id:'vanilla', name:'香草', color:'#f2cf94' },
        icing: { id:'pink', name:'粉糖', color:'#ffa8c6' },
        pattern: { id:'dots', name:'圆点' },
      };
      G.doneLayers = [true, true, true, true];
      CC.tick(1, DT);
      // 半成品：每层单独缺一次
      for(let k = 0; k < 4; k++){
        G.doneLayers = [true, true, true, true];
        G.doneLayers[k] = false;
        if(k === 0) G.cake.shape = null;
        if(k === 1) G.cake.batter = null;
        if(k === 2) G.cake.icing = null;
        if(k === 3) G.cake.pattern = null;
        CC.tick(1, DT);
        G.cake = {
          shape: { id: shapes[i], name: shapes[i] },
          batter: { id:'vanilla', name:'香草', color:'#f2cf94' },
          icing: { id:'pink', name:'粉糖', color:'#ffa8c6' },
          pattern: { id:'dots', name:'圆点' },
        };
      }
    }
    // 五种花纹也走一遍
    ['dots','stripes','stars','hearts','zigzag'].forEach(function(pid){
      G.cake.pattern = { id: pid, name: pid };
      G.doneLayers = [true, true, true, true];
      CC.tick(1, DT);
    });
  }catch(e){ threw = e; }
  ok(!threw, '五个形状 × 四层半成品 × 五种花纹都能画', threw && threw.message);
}

/* ================= 9. 控制台与反馈 ================= */
section('9. 控制台与反馈');
{
  CC.start();
  untilPh('waiting');

  const cells = () => els.optsEl.children.filter(c =>
    c.classList.contains('opt') || c.classList.contains('slot'));

  ok(cells().length === 5, '控制台永远是 5 个位置，按钮不会挪来挪去', String(cells().length));

  const n = G.orders[0].pool[G.station].length;
  ok(cells().filter(c => c.classList.contains('opt')).length === n,
     '能按的按钮数正好等于候选数');
  ok(cells().filter(c => c.classList.contains('slot')).length === 5 - n,
     '候选不够就用虚线空位补齐');

  const lyr = els.ordersEl.querySelectorAll('.lyr');
  ok(lyr.length === 4, '订单卡把蛋糕拆成四行', String(lyr.length));
  ok(lyr.filter(l => l.classList.contains('on')).length === 1, '同时只点亮一行');
  ok(lyr[G.station] && lyr[G.station].classList.contains('on'),
     '点亮的就是当前工位那一行');

  const st0 = G.station;
  station(true);
  untilPh('waiting');
  ok(G.station === st0 + 1, '做完一层，蛋糕走到下一站', String(G.station));
  const lyr2 = els.ordersEl.querySelectorAll('.lyr');
  ok(lyr2.filter(l => l.classList.contains('on')).length === 1 &&
     lyr2[G.station].classList.contains('on'), '高亮跟着工位一起走');

  // 做错的那一层也得照样高亮，不能提前泄漏答案
  ok(lyr2[st0].classList.contains('on') === false, '上一站那一行已经熄灭');
}

section('9b. 轮到你了');
{
  CC.start();
  untilPh('waiting');
  ok(els.pickEl.classList.contains('your-turn'),
     '蛋糕到站，操作台亮起来叫人');

  const btns = els.optsEl.children.filter(c => c.classList.contains('opt'));
  ok(btns.length > 0, '有按钮可按');
  ok(btns.filter(b => b.classList.contains('hint')).length === 1,
     '第一单把正确的那个按钮点亮（只亮一个）', String(btns.filter(b => b.classList.contains('hint')).length));

  btns[0].fire('click');
  ok(!els.pickEl.classList.contains('your-turn'),
     '按下去之后操作台退回收起状态');
}

section('10. 结果反馈');
{
  CC.start();
  makeCake();
  untilPh('result');
  ok(els.optsEl.children.some(c => c.classList.contains('resultFace') && c.classList.contains('ok')),
     '送出去了，底部换成大绿勾');
  ok(els.optsEl.children.filter(c => c.classList.contains('opt')).length === 0,
     '结算时按钮全部撤掉，不会误按');
  ok(G.layerOk && G.layerOk.every(Boolean), '四层都记成对的', JSON.stringify(G.layerOk));
}
{
  CC.start();
  makeCake([false, true, true, true]);
  untilPh('result');
  ok(els.optsEl.children.some(c => c.classList.contains('resultFace') && c.classList.contains('bad')),
     '没送出去，底部换成大红叉');
  ok(G.layerOk && G.layerOk[0] === false && G.layerOk[1] === true,
     '错在第几层记得清清楚楚', JSON.stringify(G.layerOk));
  ok(G.resultT < 0.6, '结果先原地停一会儿再走', String(G.resultT.toFixed(2)));
}

/* ================= 11. 自包含 ================= */
section('11. 单文件自包含');
{
  ok(!/https?:\/\//.test(html), '没有 http(s) 外链');
  ok(!/<img\b/i.test(html), '没有 <img>');
  ok(!/@import/.test(html), '没有 @import');
  ok(!/\bsrc\s*=/.test(html), '没有 src= 属性（外链资源）');
  ok(/<a[^>]+href="\/"/.test(html), '返回键指向 "/"（离线版会被改成 ../index.html）');
  ok(/<meta[^>]+viewport/.test(html), '有 viewport（手机上不缩放）');
  ok(html.split('<script').length === 2, '只有一个内联脚本块');
}

/* ================= 汇总 ================= */
console.log('\n' + '─'.repeat(46));
if(fail === 0){
  console.log('全部通过：' + pass + ' 项');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
