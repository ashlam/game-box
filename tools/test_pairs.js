#!/usr/bin/env node
/**
 * 记忆配对（Memory Pairs）逻辑回归测试
 *
 * 覆盖：
 *   1) ★ 界面上**一个可见文字都没有**（本作的核心约束：不识字也能玩）
 *   2) ★ 牌面只有数字点数 2~10，没有 A/J/Q/K 这些字母
 *   3) 四个难度：3/6/8/9 对 → 6/12/16/18 张，网格尺寸
 *   4) 发牌：每个点数恰好两张、花色不同、位置随机、id 连续
 *   5) 配对成功 / 失败；失败会锁输入、到点翻回去
 *   6) ★ 配对成功的牌**留在桌上不消失**，且不重排（否则位置记忆作废）
 *   7) 计时从第一次点击才开始
 *   8) 星级、成绩存档（先比步数再比时间）
 *   9) 单文件自包含
 *
 * 用法：node tools/test_pairs.js [web/pairs/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'pairs', 'index.html');
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
    style: mkStyle(), dataset: {}, textContent: '', _cls: '', _html: '',
    children: [], parentNode: null,
    clientWidth: 390, clientHeight: 320, width: 0, height: 0, offsetWidth: 0,
    addEventListener(type, fn){ (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(){},
    fire(type, ev){ (handlers[type] || []).forEach(fn => fn(ev || {})); },
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    removeChild(c){
      const i = this.children.indexOf(c);
      if(i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    setAttribute(k, v){ this['__attr_' + k] = String(v); },
    getAttribute(k){ return this['__attr_' + k]; },
    getBoundingClientRect(){
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
               right: this.clientWidth, bottom: this.clientHeight };
    },
    focus() {}, blur() {},
  };
  /* 真 DOM 的 textContent 是聚合的：设值清掉子节点，读值拼接整棵子树 */
  let _txt = '';
  Object.defineProperty(el, 'textContent', {
    get(){
      if(el.children.length === 0) return _txt;
      return _txt + el.children.map(c => (c && c.textContent !== undefined) ? c.textContent : '').join('');
    },
    set(v){
      _txt = (v === null || v === undefined) ? '' : String(v);
      el.children.length = 0;
    },
  });
  /* innerHTML 只用于放实体（&#128266; 这类）—— 记下来，供「无文字」断言换算 */
  Object.defineProperty(el, 'innerHTML', {
    get(){ return el._html; },
    set(v){ el._html = String(v || ''); el.children.length = 0; _txt = decodeEntities(el._html); },
  });
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
/** 把 &#128266; / &#x1F446; 这类实体换成真字符，才能判断「是不是文字」 */
function decodeEntities(s){
  return String(s || '').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
                        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
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

function makeVM(store){
  const els = {};
  const nowRef = { t: 1000 };
  const stage = mkEl('div'); stage.clientWidth = 390; stage.clientHeight = 320; els.stage = stage;
  els.board = mkEl('div');
  els.levels = mkEl('div');
  els.hud = mkEl('div');
  for(let i = 0; i < 3; i++) els.hud.appendChild(mkEl('div'));
  els.topList = mkEl('div');
  const stars = mkEl('div');
  for(let i = 0; i < 3; i++) stars.appendChild(mkEl('span'));
  els.doneStars = stars;
  els.doneNext = mkEl('button');
  const fx = mkEl('canvas'); fx.getContext = () => mkCtx(); els.fx = fx;

  const doc = {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl,
    createTextNode: txt => { const e = mkEl('#text'); e.textContent = String(txt); return e; },
    addEventListener() {}, removeEventListener() {},
    documentElement: { scrollHeight: 640 }, body: mkEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
  };
  doc.body.appendChild(els.hud);
  doc.body.appendChild(els.levels);
  doc.body.appendChild(els.board);
  doc.body.appendChild(els.stage);
  doc.body.appendChild(els.topList);
  doc.body.appendChild(els.doneStars);

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
  vm.runInContext(script, sandbox, { filename: 'gpairs-inline.js' });
  sandbox.__els = els;
  sandbox.__clock = nowRef;
  return sandbox;
}

const store = {};
const sb = makeVM(store);
const win = sb.window;
const els = sb.__els;
const clock = sb.__clock;

const S = () => win.__pairs();
const newGame = (lv, seed) => win.__pairsNewGame(lv, seed);
const tap = i => win.__pairsTap(i);
const step = dt => win.__pairsStep(dt);
const cards = () => win.__pairsCards();
const DT = 1 / 60;
function run(sec){ const n = Math.round(sec / DT); for(let i = 0; i < n; i++) step(DT); }

/** 找出某一对牌（点数相同）的两张下标 */
function pairIdx(rank){
  const cs = S().cards;
  const out = [];
  for(let i = 0; i < cs.length; i++) if(cs[i].rank === rank) out.push(i);
  return out;
}
/** 用最优策略打完当前局：每轮记住翻开的牌，凑齐所有对 */
function playPerfect(){
  const seen = {};                       // rank -> 已知的下标
  let guard = 0;
  while(S().phase === 'play' && guard++ < 400){
    const cs = S().cards;
    /* 先找「两张都已知道」的一对 */
    let done = false;
    for(const rk in seen){
      const idxs = seen[rk].filter(i => !cs[i].matched && !cs[i].up);
      if(idxs.length >= 2){
        tap(idxs[0]); tap(idxs[1]);
        if(S().locked) run(1.0);
        delete seen[rk];
        done = true;
        break;
      }
    }
    if(done) continue;
    /* 没有现成的一对：翻开两张没见过的 */
    const unknown = [];
    for(let i = 0; i < cs.length; i++) if(!cs[i].matched && !cs[i].up) unknown.push(i);
    if(unknown.length < 2) break;
    const a = unknown[0];
    tap(a);
    const rkA = cs[a].rank;
    (seen[rkA] = seen[rkA] || []).push(a);
    const b = unknown.find(i => i !== a && seen[cs[i].rank] && seen[cs[i].rank].length &&
                                seen[cs[i].rank].some(j => j !== i && !cs[j].matched && !cs[j].up));
    if(b !== undefined){
      tap(b);
    } else {
      const c = unknown[1];
      tap(c);
      (seen[cs[c].rank] = seen[cs[c].rank] || []).push(c);
    }
    if(S().locked) run(1.0);
  }
}

/* ================= 1) ★ 界面上没有可见文字 ================= */
section('1) ★ 界面上一个可见文字都没有（不识字也能玩）');
{
  /* 把 body 整棵树的叶子节点文字收集起来 —— 任何一段出现中文/英文/数字以外的
     「需要读」的东西都算违规。数字和 : / 之类的符号是允许的（阿拉伯数字几乎人人认得）。 */
  const texts = win.__pairsVisibleText();
  const readable = texts.filter(t => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z]/.test(t));
  ok(readable.length === 0,
     '★ 页面上没有任何中文 / 英文 / 假名 / 谚文',
     readable.length ? '出现了：' + JSON.stringify(readable.slice(0, 6)) : '');

  /* 只有数字、冒号、破折号、星号这类「非语言符号」是允许的 */
  const allowed = /^[\d\s:\-\u2014\u2605\u2756\u2022]+$/;
  const weird = texts.filter(t => !allowed.test(t) && !/^[\u2190-\u21ff\u2600-\u27bf\ufe0f\ud800-\udfff]+$/.test(t));
  ok(weird.length === 0, '★ 其余可见字符都是数字或图形符号',
     weird.length ? JSON.stringify(weird.slice(0, 8)) : '');

  /* 按钮必须有 aria-label（读屏能用，但不显示）——这是「无文字」不等于「无障碍更差」的关键。
     ⚠️ 假 DOM 里那些按钮是 getElementById 惰性造出来的空壳，HTML 里写的 aria-label 不会
     自动出现在上面。所以这里**直接查 HTML 源码**（那才是真浏览器里生效的东西）。 */
  const labeled = ['btnSound', 'btnAgain', 'btnTop', 'doneAgain', 'doneNext', 'doneClose',
                   'topPlay', 'topClose'];
  let missing = [];
  for(const id of labeled){
    const re = new RegExp('id="' + id + '"[^>]*aria-label');
    const re2 = new RegExp('aria-label[^>]*id="' + id + '"');
    if(!re.test(html) && !re2.test(html)) missing.push(id);
  }
  ok(missing.length === 0, '★ 所有纯图标按钮都带 aria-label（读屏可念，但屏幕上不显示）',
     missing.length ? '缺：' + missing.join(',') : '');

  /* 关卡按钮的 aria-label 也要有 */
  let lvMissing = 0;
  for(const b of els.levels.children) if(!b.getAttribute('aria-label')) lvMissing++;
  ok(lvMissing === 0, '关卡按钮也都有 aria-label', lvMissing ? lvMissing + ' 个缺' : '');

  /* 返回键是图标 */
  ok(/&#8249;|‹/.test(html), '★ 返回键是「‹」符号，不是「返回」两个字');
}

/* ================= 2) ★ 牌面只有数字 ================= */
section('2) ★ 牌面只有数字点数（没有 A/J/Q/K）');
{
  const ranks = new Set();
  for(let seed = 1; seed <= 200; seed++){
    newGame(3, seed);
    for(const c of S().cards) ranks.add(c.rank);
  }
  const letters = [...ranks].filter(r => /[A-Za-z]/.test(r));
  ok(letters.length === 0, '★ 200 局里从没出现字母点数（A/J/Q/K）',
     letters.length ? '出现了：' + letters.join(',') : '');
  ok(ranks.size === 9, '点数池是 2~10 共 9 种（实际 ' + ranks.size + ' 种）');
  const bad = [...ranks].filter(r => !/^(10|[2-9])$/.test(r));
  ok(bad.length === 0, '★ 点数全是数字 2~10', bad.join(','));
}

/* ================= 3) 关卡 ================= */
section('3) 十个关卡');
{
  const lv = win.__pairsLevels();
  ok(lv.length === 10, '十个关卡（实际 ' + lv.length + '）');
  ok(JSON.stringify(lv.map(l => l.pairs)) === JSON.stringify([3,5,6,8,9,10,12,14,16,18]),
     '对数 3/5/6/8/9/10/12/14/16/18', JSON.stringify(lv.map(l => l.pairs)));
  ok(lv.every(l => l.cards === l.pairs * 2), '牌数 = 对数 × 2',
     JSON.stringify(lv.map(l => l.cards)));
  /* 难度必须单调递增 —— 第 5 关比第 4 关还简单的话，曲线就乱了 */
  ok(lv.every((l, i) => i === 0 || l.pairs >= lv[i-1].pairs),
     '★ 难度单调递增（后一关不少于前一关）', JSON.stringify(lv.map(l => l.pairs)));
  ok(lv[0].pairs === 3 && lv[9].pairs === 18, '第一关 3 对、最后一关 18 对');
  /* 点数池 9 种，每种 4 张 → 对数上限 9×2 = 18 对，正好是第 10 关 */
  ok(lv.every(l => l.pairs <= 18),
     '★ 对数不超过理论上限 18（9 种点数 × 每种最多 2 对）',
     '最大 ' + Math.max(...lv.map(l => l.pairs)));
  ok(Math.max(...lv.map(l => l.pairs)) === 18, '★ 第 10 关用满了 18 对的上限');

  /* 网格要**装得下**所有牌。不要求严丝合缝：最后一行允许留空 ——
     因为手机竖屏是「矮而宽」，多给一列比多给一行能让牌更大（见 index.html 里的注释）。 */
  /* 网格是**布局时算出来的**（pickCols 按牌面积最大选列数），关卡表里只有默认列数。
     所以这里断言的是「算出来的网格真的装得下」，不是「表里写死的数字对得上」。 */
  ok(S().cols * S().rows >= S().cards.length,
     '★ 网格装得下所有牌', S().cols + '×' + S().rows + ' ≥ ' + S().cards.length);
  ok(S().rows === Math.ceil(S().cards.length / S().cols),
     '行数 = ceil(牌数 / 列数)（不多留空行）',
     S().rows + ' = ceil(' + S().cards.length + '/' + S().cols + ')');

  /* ⚠️ 不能直接断言「默认是第 1 关」：前面几节跑过 newGame 会写存档，
     boot() 读回来的是上次玩的那一关（这正是「记住上次选的关卡」功能）。
     所以这里断言的是「全新存档下默认第 1 关」。 */
  const freshSb = makeVM({});
  ok(freshSb.window.__pairs().level === 0, '★ 全新存档下默认第一关（实际 ' + freshSb.window.__pairs().level + '）');
  ok(els.levels.children.length === 10, '关卡条 10 个按钮（实际 ' + els.levels.children.length + '）');
  ok(els.levels.children.filter(b => b.classList.contains('on')).length === 1,
     '★ 任何时刻只有一个关卡高亮');
  /* 关卡按钮上是迷你网格，不是文字 */
  for(let i = 0; i < els.levels.children.length; i++){
    const b = els.levels.children[i];
    const g = b.children[0];
    ok(g && g.classList.contains('glyph'), '关卡 ' + (i+1) + ' 的按钮画的是迷你网格（不是文字）');
    if(g) ok(g.children.length === lv[i].cards,
            '关卡 ' + (i+1) + ' 的迷你网格有 ' + lv[i].cards + ' 个点（实际 ' + g.children.length + '）');
  }

  for(const l of lv){
    newGame(l.id);
    const s = S();
    ok(s.cards.length === l.cards, '关卡 ' + (l.id+1) + '：牌数 ' + l.cards);
    ok(s.cols * s.rows >= l.cards && s.rows === Math.ceil(l.cards / s.cols),
       '关卡 ' + (l.id+1) + '：网格 ' + s.cols + '×' + s.rows + ' 装得下 ' + l.cards + ' 张');
    ok(cards().length === l.cards, '关卡 ' + (l.id+1) + '：DOM 牌数一致');
  }
  newGame(0);
}

/* ================= 4) 发牌 ================= */
section('4) 发牌');
{
  let badPair = 0, sameSuit = 0, badId = 0, total = 0, undefinedRank = 0, tooMany = 0;
  const SUIT_SYMS = ['\u2660','\u2665','\u2666','\u2663'];
  /* 每一关都要能发出来 —— 尤其第 10 关（18 对 = 36 张），
     点数池只有 9 种，必须靠「同点数 4 张 = 两对」才凑得够 */
  for(let lv = 0; lv < 10; lv++){
    for(let seed = 1; seed <= 40; seed++){
      newGame(lv, seed);
      total++;
      const cs = S().cards;
      const L = win.__pairsLevels()[lv];
      if(cs.length !== L.cards) badPair++;
      if(cs.some(c => !c.rank || c.rank === 'undefined')) undefinedRank++;
      const byRank = {};
      for(const c of cs) (byRank[c.rank] = byRank[c.rank] || []).push(c);
      for(const rk in byRank){
        /* 每个点数只能出 2 张（一对）或 4 张（两对），绝不能 1 张或 3 张 */
        const n = byRank[rk].length;
        if(n !== 2 && n !== 4) badPair++;
        if(n > 4) tooMany++;
        /* 同一点数的牌花色必须互不相同（不能出现两张一样的牌） */
        const suits = byRank[rk].map(c => c.suit);
        if(new Set(suits).size !== suits.length) sameSuit++;
      }
      if(cs.some(c => SUIT_SYMS.indexOf(c.suit) < 0)) badPair++;
      cs.forEach((c, i) => { if(c.id !== i) badId++; });
    }
  }
  ok(total === 400, '跑了 400 局（10 关 × 40 个种子）');
  ok(badPair === 0, '★ 每关的牌数都对，且每个点数只出 2 或 4 张（错 ' + badPair + ' 次）');
  ok(undefinedRank === 0, '★ 没有任何一张牌的点数是 undefined（第 10 关 18 对的经典坑）',
     undefinedRank ? undefinedRank + ' 张空牌' : '');
  ok(tooMany === 0, '★ 同一点数不超过 4 张（一副牌就 4 种花色）', tooMany + ' 次');
  ok(sameSuit === 0, '★ 同一点数的牌花色互不相同（不会出现两张一模一样的牌）', sameSuit + ' 次');
  ok(badId === 0, '★ id 连续且等于下标（错 ' + badId + ' 个）');

  /* 位置必须随机：同一张牌不该总在同一个位置 */
  const firstRank = {};
  for(let seed = 1; seed <= 200; seed++){
    newGame(0, seed);
    const r = S().cards[0].rank;
    firstRank[r] = (firstRank[r] || 0) + 1;
  }
  const kinds = Object.keys(firstRank).length;
  ok(kinds >= 5, '★ 第 0 张牌的点数是随机的（200 局里出现 ' + kinds + ' 种）');

  /* 同种子可复现 */
  newGame(1, 777); const a = S().cards.map(c => c.rank + c.suit).join(',');
  newGame(1, 777); const b = S().cards.map(c => c.rank + c.suit).join(',');
  newGame(1, 778); const c = S().cards.map(c => c.rank + c.suit).join(',');
  ok(a === b, '同种子发的牌一致（可复现）');
  ok(a !== c, '不同种子发不同的牌');

  /* 第 10 关的结构：9 个点数各 4 张 = 18 对 */
  newGame(9, 3);
  const cs9 = S().cards;
  const r9 = {};
  cs9.forEach(c => { r9[c.rank] = (r9[c.rank] || 0) + 1; });
  const counts9 = Object.keys(r9).map(k => r9[k]);
  ok(Object.keys(r9).length === 9, '第 10 关用满 9 个点数（实际 ' + Object.keys(r9).length + '）');
  ok(counts9.every(n => n === 4), '★ 第 10 关每个点数 4 张 = 两对', JSON.stringify(counts9));
}

/* ================= 5) 配对 ================= */
section('5) 配对成功 / 失败');
{
  newGame(0, 11);
  ok(S().phase === 'play', '开局在玩');
  ok(S().moves === 0 && S().found === 0, '步数与已配对数都是 0');
  ok(cards().every(c => c.down), '★ 所有牌一开始都是扣着的');
  ok(cards().every(c => !c.gone), '没有牌处于「已配对」状态');

  /* 翻第一张：不算一步，也不配对 */
  const cs0 = S().cards;
  const r0 = cs0[0].rank;
  const pr = pairIdx(r0);
  const r1 = tap(pr[0]);
  ok(r1 === 'first', '翻第一张 → first');
  ok(S().moves === 0, '★ 翻第一张不算一步');
  ok(S().first === pr[0], '记下了第一张');
  ok(cards()[pr[0]].down === false, '第一张翻开了');
  ok(S().started === true, '★ 第一次点击就开始了计时');

  /* 翻它的对：配对成功 */
  const r2 = tap(pr[1]);
  ok(r2 === 'match', '★ 同点数 → 配对成功');
  ok(S().moves === 1, '配对成功算 1 步（实际 ' + S().moves + '）');
  ok(S().found === 1, '已配对数 +1');
  ok(S().first === null, '清空了「第一张」');
  ok(cards()[pr[0]].gone && cards()[pr[1]].gone, '★ 两张都变成已配对');
  ok(S().locked === false, '配对成功不锁输入');

  /* 再点已配对的牌：无效 */
  const before = S().moves;
  ok(tap(pr[0]) === 'ignore', '★ 点已配对的牌无效');
  ok(S().moves === before, '无效点击不加步数');

  /* 翻两张不一样的：失败 */
  newGame(0, 12);
  const cs1 = S().cards;
  let x = 0, y = -1;
  for(let i = 1; i < cs1.length; i++) if(cs1[i].rank !== cs1[0].rank){ y = i; break; }
  tap(x);
  const r3 = tap(y);
  ok(r3 === 'miss', '★ 点数不同 → 配对失败');
  ok(S().moves === 1, '失败也算 1 步');
  ok(S().found === 0, '失败不加配对数');
  ok(S().locked === true, '★ 失败后锁住输入');
  ok(cards()[x].miss && cards()[y].miss, '两张都标上了「错」的提示');
  ok(cards()[x].down === false && cards()[y].down === false, '★ 失败后两张暂时还是翻开的（要让玩家看清）');

  /* 锁住期间点第三张：必须无效（否则会同时亮三张，玩家以为规则坏了） */
  const third = cs1.findIndex((c, i) => i !== x && i !== y && !c.matched);
  ok(tap(third) === 'locked', '★ 锁住期间点第三张被拒绝');
  ok(cards()[third].down === true, '第三张没被翻开');
  ok(S().moves === 1, '被拒绝的点击不加步数');

  /* 到点自动翻回去 */
  run(1.0);
  ok(S().locked === false, '★ 等待结束自动解锁');
  ok(cards()[x].down && cards()[y].down, '★ 两张都翻回去了');
  ok(!cards()[x].miss && !cards()[y].miss, '「错」的提示也清掉了');
  ok(S().moves === 1, '翻回去不额外加步数');
}

/* ================= 6) ★ 配对后牌留在桌上、不重排 ================= */
section('6) ★ 配对成功的牌留在桌上（不消失、不重排）');
{
  newGame(1, 21);
  const before = S().cards.map(c => c.id + ':' + c.rank + c.suit);
  const pr = pairIdx(S().cards[0].rank);
  tap(pr[0]); tap(pr[1]);

  const after = S().cards.map(c => c.id + ':' + c.rank + c.suit);
  ok(before.join(',') === after.join(','), '★ 配对后牌序完全没变（没有把后面的牌挪过来补位）');

  /* DOM 上：已配对的那两张还在原来的位置，只是多了 gone 类 */
  const cs = cards();
  ok(cs.length === before.length, '★ DOM 牌数没减少（牌还在桌上，不是删掉）');
  ok(cs[pr[0]].gone && cs[pr[1]].gone, '那两张标成已配对');
  ok(cs[pr[0]].idx === pr[0] && cs[pr[1]].idx === pr[1], '位置下标也没变');

  /* 其余牌都还在原位、还是扣着的 */
  let stillThere = 0;
  for(let i = 0; i < cs.length; i++){
    if(i === pr[0] || i === pr[1]) continue;
    if(cs[i].down) stillThere++;
  }
  ok(stillThere === cs.length - 2, '★ 其余牌都还在原位扣着（' + stillThere + '/' + (cs.length-2) + '）');

  /* ★ 用户的明确要求：翻成功的牌不要消失。
     状态上要满足三件事：还翻开、数据还在、位置没动。
     （视觉层面「看得见」由 UI 测试量 computed 样式。） */
  ok(cs[pr[0]].down === false && cs[pr[1]].down === false,
     '★ 已配对的牌保持翻开（没有翻回背面）');
  ok(cs[pr[0]].rank === S().cards[pr[0]].rank && cs[pr[1]].suit === S().cards[pr[1]].suit,
     '★ 已配对的牌牌面数据还在（点数和花色都读得出来）',
     cs[pr[0]].rank + cs[pr[0]].suit + ' / ' + cs[pr[1]].rank + cs[pr[1]].suit);
  ok(cs[pr[0]].rank && cs[pr[1]].suit, '★ DOM 上 dataset 里的点数花色没被清掉');

  /* 再点一下已配对的牌：必须无效（不能重复计分） */
  const foundBefore = S().found, movesBefore = S().moves;
  ok(tap(pr[0]) === 'ignore', '★ 再点已配对的牌无效（不会重复配对）');
  ok(S().found === foundBefore && S().moves === movesBefore, '重复点击不加分也不加步数');

  /* 而且后面还能继续玩：再配一对 */
  const remainRank = cs.find(c => !c.gone).rank;
  const pr2 = [];
  for(let i = 0; i < S().cards.length; i++)
    if(S().cards[i].rank === remainRank && !S().cards[i].matched) pr2.push(i);
  if(pr2.length >= 2){
    tap(pr2[0]); tap(pr2[1]);
    ok(S().found === 2, '★ 已配对的牌留在桌上，也不影响继续配对（已配 ' + S().found + ' 对）');
  }
}

/* ================= 7) 计时 ================= */
section('7) 计时从第一次点击才开始');
{
  newGame(0, 31);
  clock.t = 5000;
  ok(S().started === false, '开局还没开始计时');
  ok(S().elapsed === 0, '用时是 0');
  run(2.0);
  ok(S().elapsed === 0, '★ 没点之前，等 2 秒也不走表（不然先扣掉看牌桌的时间）');
  ok(S().started === false, '还没开始');

  tap(0);
  ok(S().started === true, '★ 第一次点击才开始计时');
  clock.t += 1500;
  run(0.1);
  ok(Math.abs(S().elapsed - 1500) < 60,
     '秒表按真实时间走（1.5 秒后 elapsed≈1500ms，实际 ' + Math.round(S().elapsed) + '）');

  /* 时间格式：只有数字和冒号 */
  const fmt = win.__pairsFmtTime;
  ok(fmt(0) === '0:00', '0ms → 0:00（' + fmt(0) + '）');
  ok(fmt(5000) === '0:05', '5s → 0:05（' + fmt(5000) + '）');
  ok(fmt(65000) === '1:05', '65s → 1:05（' + fmt(65000) + '）');
  ok(fmt(600000) === '10:00', '600s → 10:00（' + fmt(600000) + '）');
  ok(/^[\d:]+$/.test(fmt(123456)), '★ 时间格式只有数字和冒号（没有「秒」「分」这类字）', fmt(123456));
}

/* ================= 8) 星级 ================= */
section('8) 星级');
{
  const st = win.__pairsStars;
  ok(st(3, 3) === 3, '3 对 3 步（全凭记忆）→ 3 星');
  ok(st(4, 3) === 3, '3 对 4 步 → 3 星（1.33 倍，仍在 3 星内）');
  ok(st(5, 3) === 2, '3 对 5 步 → 2 星（1.67 倍）');
  ok(st(6, 3) === 2, '3 对 6 步 → 2 星（2.0 倍，正好在边界上）');
  ok(st(7, 3) === 1, '3 对 7 步 → 1 星（2.33 倍，超过 2.05 的边界）');
  ok(st(3, 9) === 3, '9 对 3 步 → 3 星（不可能的步数也算 3 星，无副作用）');
  ok(st(9, 9) === 3, '9 对 9 步 → 3 星');
  ok(st(13, 9) === 3, '9 对 13 步 → 3 星（1.44 倍）');
  ok(st(14, 9) === 2, '9 对 14 步 → 2 星（1.56 倍）');
  ok(st(18, 9) === 2, '9 对 18 步 → 2 星（2.0 倍，正好在边界上）');
  ok(st(19, 9) === 1, '9 对 19 步 → 1 星（2.11 倍）');
  ok(st(100, 9) === 1, '9 对 100 步 → 1 星');
  ok(st(1, 1) === 3, '单对 1 步 → 3 星');
  /* 边界本身要锁死：阈值是 1.45 / 2.05 */
  ok(st(Math.ceil(1.45*9), 9) === 2, '9 对 14 步（1.56）刚好掉出 3 星 —— 阈值 1.45 生效');
  ok(st(13, 9) === 3, '9 对 13 步（1.44）还在 3 星 —— 阈值没被调松');
}

/* ================= 8b) ★ 分数与奖品 ================= */
section('8b) ★ 单关分数 / 总分 / 十档奖品');
{
  const scoreFor = win.__pairsScoreFor;
  const prizeFor = win.__pairsPrizeFor;
  const maxTotal = win.__pairsMaxTotal();
  const prizes = win.__pairsPrizes();

  /* ---- 分数公式 ---- */
  ok(prizes.length === 10, '★ 奖品正好十档（实际 ' + prizes.length + '）');
  ok(prizes.every(p => p.em && p.name), '每档都有图标和名字（名字只用于 aria-label，不显示）');
  ok(new Set(prizes.map(p => p.em)).size === 10, '★ 十档图标互不相同',
     prizes.map(p => p.em).join(''));
  ok(prizes[9].em === '\uD83C\uDFC6', '最高档是金杯 🏆');
  ok(prizes.some(p => p.em === '\uD83D\uDC51'), '里面有皇冠 👑');
  ok(prizes.some(p => p.em === '\uD83D\uDE97'), '里面有小汽车 🚗');
  /* ⚠️ 这里锁的是「选 emoji 的两条硬要求」，不是具体挑了哪几个：
     · 不能是 Unicode 13+ 的新字符（老安卓渲染成豆腐块）
     · 相邻两档形状要有差异（13px 下认不出就白搭） */
  const cps = prizes.map(p => p.em.codePointAt(0));
  ok(cps.every(c => c < 0x1FA00),
     '★ 十档奖品都是 Unicode 13 之前的老字符（老安卓不会显示成豆腐块）',
     prizes.map(p => 'U+' + p.em.codePointAt(0).toString(16).toUpperCase()).join(' '));
  ok(!prizes.some(p => p.em === '\uD83C\uDF31' || p.em === '\uD83C\uDF3F'),
     '★ 没有 🌱 小芽 / 🌿 小草（用户认不出来，已删掉）');
  ok(prizes.some(p => p.em === '\uD83C\uDF81'), '里面有礼物盒 🎁');
  ok(prizes.some(p => p.em === '\uD83D\uDC8E'), '里面有宝石 💎');

  /* 分数必须随「星级」「牌数」「速度」单调变化 */
  const s3 = scoreFor(3, 9000, 3, 3);       // 3 对，3 星，每对 3 秒
  const s2 = scoreFor(6, 15000, 3, 2);      // 3 对，2 星，每对 5 秒
  const s1 = scoreFor(9, 27000, 3, 1);      // 3 对，1 星，每对 9 秒
  ok(s3 > s2 && s2 > s1, '★ 星级越高分数越高（' + s3 + ' > ' + s2 + ' > ' + s1 + '）');
  ok(scoreFor(9, 27000, 9, 3) > scoreFor(9, 27000, 3, 3), '★ 牌数越多基础分越高');
  ok(scoreFor(9, 9000, 3, 3) > scoreFor(9, 27000, 3, 3), '★ 同样星级，越快分越高');
  /* 速度加成封顶 ×1.5，不能无限涨 */
  const fast = scoreFor(3, 1000, 3, 3), slow = scoreFor(3, 99000, 3, 3);
  ok(fast / slow <= 1.55, '★ 速度加成封顶在 1.5 倍左右（' + (fast/slow).toFixed(2) + '）');
  /* 记忆游戏不该逼人抢时间：最慢也不清零，至少有 1 倍基础分 */
  ok(slow > 0 && slow >= Math.round(100*3*2.2*1), '★ 慢也不会把分数压到 0（' + slow + '）');
  ok(scoreFor(3, 9000, 3, 3) === Math.round(100*3*2.2*1.5),
     '3 对 3 星 每对 3 秒 = 满分公式（' + scoreFor(3,9000,3,3) + '）');

  /* ---- 奖品档位 ---- */
  ok(maxTotal > 0, '满分是正数（' + maxTotal + '）');
  ok(prizeFor(0) === 0, '★ 0 分 → 第 1 档（最低档）');
  ok(prizeFor(-5) === 0, '★ 负数也按 0 档处理，不会崩');
  ok(prizeFor(maxTotal) === 9, '★ 满分 → 第 10 档（金杯）');
  ok(prizeFor(maxTotal * 2) === 9, '★ 超过满分也不会越界（还是第 10 档）');
  /* 单调：分数越高档位只升不降 */
  let mono = true, prev = -1;
  for(let i = 0; i <= 100; i++){
    const p = prizeFor(Math.round(maxTotal * i / 100));
    if(p < prev) mono = false;
    prev = p;
  }
  ok(mono, '★ 分数越高奖品档位只升不降（单调）');

  /* 十档必须**都够得着**：从 0 到满分扫一遍，十档都得出现 */
  const seen = new Set();
  for(let i = 0; i <= 2000; i++) seen.add(prizeFor(Math.round(maxTotal * i / 2000)));
  ok(seen.size === 10, '★ 从 0 扫到满分，十档全部出现过（实际 ' + seen.size + ' 档）',
     [...seen].sort((a,b)=>a-b).join(','));
  ok(seen.has(0) && seen.has(9), '★ 最低档和最高档都够得着');

  /* 分档不能太廉价：只打第 1 关（3 对满分）不该拿到高档位 */
  const firstOnly = scoreFor(3, 9000, 3, 3);
  ok(prizeFor(firstOnly) <= 1,
     '★ 只打完第 1 关（' + firstOnly + ' 分）最多第 2 档 —— 奖品不能太廉价',
     '实际第 ' + (prizeFor(firstOnly) + 1) + ' 档');

  /* 但也不该太苛刻：十关全打（哪怕每关都 2 星）至少该拿到中档 */
  let all2 = 0;
  win.__pairsLevels().forEach(l => { all2 += scoreFor(Math.round(l.pairs*2), l.pairs*5000, l.pairs, 2); });
  ok(prizeFor(all2) >= 4, '★ 十关都打通（哪怕全是 2 星）至少第 5 档',
     '实际第 ' + (prizeFor(all2) + 1) + ' 档，总分 ' + all2);
}

/* ================= 9) 完整一局 ================= */
section('9) 完整一局：打到底 → 过关');
{
  newGame(0, 41);
  playPerfect();
  ok(S().phase === 'done', '★ 全部配完 → 进入过关状态（实际 ' + S().phase + '）');
  ok(S().found === 3, '3 对全配完（实际 ' + S().found + '）');
  ok(S().moves >= 3, '步数至少 3（实际 ' + S().moves + '）');
  ok(S().stars >= 1 && S().stars <= 3, '★ 星级在 1~3 之间（' + S().stars + '）');

  /* 过关面板：先庆祝再弹 */
  ok(S().panelShown === false, '★ 面板先不弹（要让撒花演完）');
  ok(S().panelDue === true, '面板已排期');
  run(1.5);
  ok(S().panelShown === true, '★ 到点弹出过关面板');
  ok(els.doneOv.classList.contains('on'), '浮层真的打开了（.on）');
  ok(els.doneMoves.textContent === String(S().moves), '面板显示步数（' + els.doneMoves.textContent + '）');
  ok(/^[\d:]+$/.test(els.doneTime.textContent), '★ 面板显示的时间也只有数字和冒号（' + els.doneTime.textContent + '）');

  /* 星星：点亮的数量必须等于星级 */
  const starState = win.__pairsStars_();
  ok(starState.total === 3, '面板上三颗星');
  ok(starState.on === S().stars, '★ 点亮 ' + starState.on + ' 颗 = 星级 ' + S().stars);

  /* ★ 本关得分 / 总分 / 奖品 —— 面板上要真的显示出来 */
  ok(S().lastScore > 0, '本关算出了得分（' + S().lastScore + '）');
  ok(els.doneScore.textContent === String(S().lastScore),
     '★ 面板显示本关得分（' + els.doneScore.textContent + '）');
  ok(S().total > 0, '总分算出来了（' + S().total + '）');
  ok(els.doneTotal.textContent === String(S().total),
     '★ 面板显示总分（' + els.doneTotal.textContent + '）');
  ok(S().prize >= 0 && S().prize <= 9, '★ 奖品档位在 0~9 之间（' + S().prize + '）');
  ok(els.donePrizeEmoji.textContent.length > 0,
     '★ 面板显示奖品图标（' + els.donePrizeEmoji.textContent + '）');
  /* 十档刻度全部画出来，当前档位标亮 */
  const ticks = els.doneTicks.children;
  ok(ticks.length === 10, '★ 面板上十档刻度都画出来了（实际 ' + ticks.length + '）');
  ok([...ticks].filter(t => t.classList.contains('cur')).length === 1,
     '★ 恰好一档标成「当前档位」');
  ok([...ticks].filter(t => t.classList.contains('got')).length === S().prize + 1,
     '★ 已拿到的档位数量 = 当前档位 + 1（' + S().prize + ' → ' + (S().prize+1) + '）');
  ok(els.doneBarFill.style.width && els.doneBarFill.style.width !== '0%',
     '★ 进度条有宽度（' + els.doneBarFill.style.width + '）');

  /* 存档 */
  const best = S().best['0'];
  ok(best && best.moves === S().moves, '★ 成绩写进存档');
  ok(st2Saved(), '落盘到 localStorage');
  function st2Saved(){ return store['gpairs_v1'] !== undefined; }
  const saved = JSON.parse(store['gpairs_v1']);
  ok(saved.best && saved.best['0'] && saved.best['0'].moves === S().moves, '存档里 best[0].moves 对得上');
  ok(typeof saved.best['0'].ms === 'number' && saved.best['0'].ms >= 0, '也记了用时');
  ok(saved.scores && typeof saved.scores['0'] === 'number' && saved.scores['0'] > 0,
     '★ 每关的得分也落盘了（scores[0] = ' + (saved.scores && saved.scores['0']) + '）');
  ok(typeof saved.total === 'number' && saved.total === S().total,
     '★ 总分也落盘了（' + saved.total + '）');

  /* 最后一关不该显示「下一关」 */
  newGame(9, 42);
  playPerfect();
  run(1.5);
  ok(S().phase === 'done', '最后一关（第 10 关，18 对）也打完了');
  ok(win.__pairsNextVisible() === false, '★ 最后一关（第 10 关）不显示「下一关」按钮（点了没反应更让人困惑）');
  /* 前三关要显示 */
  newGame(0, 43);
  playPerfect();
  run(1.5);
  ok(win.__pairsNextVisible() === true, '非最后一关显示「下一关」');
}

/* ================= 10) 成绩比较：先步数后时间 ================= */
section('10) 成绩比较：先比步数，步数相同再比时间');
{
  const st2 = {};
  const sb2 = makeVM(st2);
  const w2 = sb2.window;
  const S2 = () => w2.__pairs();
  const c2 = sb2.__clock;
  function play(w, lv, seed){
    w.__pairsNewGame(lv, seed);
    const seen = {};
    let guard = 0;
    while(w.__pairs().phase === 'play' && guard++ < 400){
      const cs = w.__pairs().cards;
      let done = false;
      for(const rk in seen){
        const idxs = seen[rk].filter(i => !cs[i].matched && !cs[i].up);
        if(idxs.length >= 2){
          w.__pairsTap(idxs[0]); w.__pairsTap(idxs[1]);
          if(w.__pairs().locked) for(let k=0;k<70;k++) w.__pairsStep(DT);
          delete seen[rk]; done = true; break;
        }
      }
      if(done) continue;
      const unknown = [];
      for(let i = 0; i < cs.length; i++) if(!cs[i].matched && !cs[i].up) unknown.push(i);
      if(unknown.length < 2) break;
      const a = unknown[0];
      w.__pairsTap(a);
      (seen[cs[a].rank] = seen[cs[a].rank] || []).push(a);
      const b = unknown.find(i => i !== a && seen[cs[i].rank] && seen[cs[i].rank].some(j => j !== i && !cs[j].matched && !cs[j].up));
      if(b !== undefined) w.__pairsTap(b);
      else {
        const c = unknown[1];
        w.__pairsTap(c);
        (seen[cs[c].rank] = seen[cs[c].rank] || []).push(c);
      }
      if(w.__pairs().locked) for(let k=0;k<70;k++) w.__pairsStep(DT);
    }
  }

  play(w2, 0, 101);
  const r1 = S2();
  ok(r1.newBest === true, '★ 第一局就是新纪录');
  ok(S2().prevBest === null, '之前没有成绩');

  /* 更差的一局：不该覆盖 */
  play(w2, 0, 102);
  const r2 = S2();
  const bestAfter1 = JSON.parse(JSON.stringify(S2().best['0']));
  ok(bestAfter1.moves > 0, '榜上有成绩');
  if(r2.moves > bestAfter1.moves){
    ok(r2.newBest === false, '★ 步数更多 → 不算新纪录');
    ok(S2().best['0'].moves === bestAfter1.moves, '★ 更差的成绩不覆盖好的');
  } else {
    ok(true, '（这局步数不多于最好成绩，跳过覆盖检查）');
  }

  /* 重启后还在 */
  const sb3 = makeVM(st2);
  ok(sb3.window.__pairs().best['0'] && sb3.window.__pairs().best['0'].moves === bestAfter1.moves,
     '★ 重启后成绩还在（同一个 localStorage）');

  /* 坏存档不能崩 */
  let crashed = false, sb4 = null;
  try{ sb4 = makeVM({ 'gpairs_v1': '{"best":{"0":{"moves":"x"},"1":null,"9":{"moves":5,"ms":100}},"level":77}' }); }
  catch(e){ crashed = true; }
  ok(!crashed, '★ 坏存档不会让页面崩');
  if(sb4){
    ok(!sb4.window.__pairs().best['0'], 'moves 不是数字的条目被丢掉');
    ok(!sb4.window.__pairs().best['99'], '不认识的关卡（99）被丢掉');
    ok(sb4.window.__pairs().level === 0, '★ 越界的 level 回落到第一关');
  }
  let sb5 = null;
  try{ sb5 = makeVM({ 'gpairs_v1': 'not json' }); }catch(e){}
  ok(sb5 !== null, '★ 存档根本不是 JSON 也不会崩');
}

/* ================= 10b) ★ 跨关累积总分 ================= */
section('10b) ★ 打多关，总分要累加');
{
  const st = {};
  const sb = makeVM(st);
  const w = sb.window;
  const S2 = () => w.__pairs();
  const DT2 = 1/60;
  function run2(sec){ const n = Math.round(sec/DT2); for(let i=0;i<n;i++) w.__pairsStep(DT2); }
  function solve(lv, seed){
    w.__pairsNewGame(lv, seed);
    const seen = {};
    let g = 0;
    while(S2().phase === 'play' && g++ < 3000){
      const cs = S2().cards;
      let done = false;
      for(const rk in seen){
        const idxs = seen[rk].filter(i => !cs[i].matched && !cs[i].up);
        if(idxs.length >= 2){
          w.__pairsTap(idxs[0]); w.__pairsTap(idxs[1]);
          if(S2().locked) run2(1.0);
          delete seen[rk]; done = true; break;
        }
      }
      if(done) continue;
      const unk = [];
      for(let i = 0; i < cs.length; i++) if(!cs[i].matched && !cs[i].up) unk.push(i);
      if(unk.length < 2) break;
      const a = unk[0];
      w.__pairsTap(a);
      (seen[cs[a].rank] = seen[cs[a].rank] || []).push(a);
      const b = unk.find(i => i !== a && seen[cs[i].rank] && seen[cs[i].rank].some(j => j !== i && !cs[j].matched && !cs[j].up));
      if(b !== undefined) w.__pairsTap(b);
      else {
        const c = unk[1];
        w.__pairsTap(c);
        (seen[cs[c].rank] = seen[cs[c].rank] || []).push(c);
      }
      if(S2().locked) run2(1.0);
    }
    run2(1.5);
    return S2();
  }

  const t0 = S2().total;
  ok(t0 === 0, '全新存档总分是 0（实际 ' + t0 + '）');

  /* 打第 1 关 */
  const r1 = solve(0, 101);
  ok(r1.phase === 'done', '第 1 关打完了');
  const after1 = S2().total;
  ok(after1 === r1.lastScore, '★ 总分 = 第 1 关得分（' + after1 + '）');
  ok(Object.keys(S2().scores).length === 1, '只记了一关的分数');

  /* 打第 2 关：总分要**累加**，不是覆盖 */
  const r2 = solve(1, 102);
  ok(r2.phase === 'done', '第 2 关打完了');
  const after2 = S2().total;
  ok(after2 === after1 + r2.lastScore,
     '★ 总分累加了（' + after1 + ' + ' + r2.lastScore + ' = ' + after2 + '）');
  ok(after2 > after1, '总分严格变大');
  ok(Object.keys(S2().scores).length === 2, '记了两关的分数');

  /* 重复打第 1 关（更差）：总分不该被拉低 —— 每关只保留最好分数 */
  const before3 = S2().total;
  solve(0, 999);
  const after3 = S2().total;
  ok(after3 >= before3, '★ 重打同一关（更差）不会把总分拉低（' + before3 + ' → ' + after3 + '）');
  ok(after3 === before3 || S2().scores['0'] > r1.lastScore,
     '★ 每关只保留最好分数');

  /* 十关全打完：总分 = 各关最好分数之和 */
  for(let lv = 2; lv < 10; lv++) solve(lv, 200 + lv);
  const all = S2();
  ok(Object.keys(all.scores).length === 10, '★ 十关都有分数了（实际 ' + Object.keys(all.scores).length + ' 关）');
  let sum = 0;
  for(let lv = 0; lv < 10; lv++) sum += all.scores[String(lv)] || 0;
  ok(all.total === sum, '★ 总分 = 各关最好分数之和（' + all.total + ' vs ' + sum + '）');
  ok(all.total > 0 && all.total <= all.maxTotal,
     '★ 总分落在 0 ~ 满分之间（' + all.total + ' / ' + all.maxTotal + '）');
  ok(all.prize >= 0 && all.prize <= 9, '★ 十关打完奖品档位有效（第 ' + (all.prize+1) + ' 档）');

  /* 十关全打通至少要拿到中档奖品（不然攒十关没意义） */
  ok(all.prize >= 4, '★ 十关都打通至少第 5 档（实际第 ' + (all.prize+1) + ' 档）');

  /* 重启后总分还在 */
  const sb2 = makeVM(st);
  ok(sb2.window.__pairs().total === all.total,
     '★ 重启后总分还在（' + sb2.window.__pairs().total + '）');
  ok(Object.keys(sb2.window.__pairs().scores).length === 10, '★ 重启后十关分数都在');
  ok(Object.keys(sb2.window.__pairs().cleared).length === 10,
     '★ 重启后「哪几关打过了」也恢复出来了（从 scores 派生，不另存一份）');

  /* 关卡按钮上应该有「通关过」的标记 */
  const doneBtns = sb2.__els.levels.children.filter(b => b.classList.contains('done'));
  ok(doneBtns.length === 10, '★ 十个关卡按钮都标了「已通关」的绿点（实际 ' + doneBtns.length + '）');
}

/* ================= 11) 记录面板 ================= */
section('11) 记录面板');
{
  newGame(0, 51);
  playPerfect();
  run(1.5);
  win.__pairsOpenTop(0);
  const rows = win.__pairsTopRows();
  ok(rows.length === 10, '★ 十行（每关一行）', String(rows.length));
  ok(rows.filter(r => /has/.test(r.cls)).length >= 1, '打过的那关有成绩标记');
  ok(rows.filter(r => /me/.test(r.cls)).length === 1, '★ 恰好一行标着「当前看的这关」');
  /* 每行必须是「迷你网格 + 步数 + 用时」，不能有文字。
     ⚠️ emoji 落在 \u{1F000}-\u{1FAFF}（代理对）以及 \u2600-\u27BF 里，
     正则要把这些范围都排掉，否则会把图标误判成文字。 */
  for(let i = 0; i < rows.length; i++){
    const readable = rows[i].text
      .replace(/[\d\s:\-\u2014\u2013]/g, '')                  // 数字与标点
      .replace(/[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u2B00-\u2BFF\uFE0F]/g, '')  // 常见符号
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');        // 代理对（emoji）
    ok(readable.length === 0, '记录第 ' + (i+1) + ' 行没有文字（只有图标和数字）',
       JSON.stringify(rows[i].text) + ' 残留 ' + JSON.stringify(readable));
  }
  const topRe = /id="topPlay"[^>]*aria-label|aria-label[^>]*id="topPlay"/;
  ok(topRe.test(html), '记录面板的按钮也有 aria-label');
}

/* ================= 12) 换关 / 重来 ================= */
section('12) 换关 / 重来');
{
  newGame(1, 61);
  tap(0);
  ok(S().started === true, '已经开始计时');
  els.btnAgain.fire('click');
  ok(S().started === false, '★ 重来后回到「还没开始」状态');
  ok(S().moves === 0 && S().found === 0, '步数和配对数都归零');
  ok(cards().every(c => c.down), '★ 重来后所有牌都扣回去');
  ok(cards().every(c => !c.gone), '没有残留的已配对状态');

  /* 切关 */
  els.levels.children[3].fire('click');
  ok(S().level === 3, '★ 点第 4 关切过去了');
  ok(S().cards.length === 16, '★ 牌桌立刻变成 16 张（第 4 关 = 8 对）');
  ok(S().moves === 0, '切关后步数归零');

  /* 玩到一半点同一个关：不该打断 */
  tap(0); tap(1);
  const mv = S().moves;
  els.levels.children[3].fire('click');
  ok(S().moves === mv, '★ 玩到一半点同一个关不会打断当前局');
  newGame(0);
}

/* ================= 13) 音效 ================= */
section('13) 音效');
{
  if(win.__pairsProg().sound === false) els.btnSound.fire('click');
  ok(win.__pairsProg().sound === true, '默认开音效');

  newGame(0, 71);
  const t0 = toneNodes;
  tap(0);
  ok(toneNodes > t0, '★ 翻牌有声音（+' + (toneNodes - t0) + '）');

  const pr = pairIdx(S().cards[0].rank);
  newGame(0, 72);
  const pr2 = pairIdx(S().cards[0].rank);
  tap(pr2[0]);
  const t1 = toneNodes;
  tap(pr2[1]);
  ok(toneNodes > t1, '★ 配对成功有声音（+' + (toneNodes - t1) + '）');

  newGame(0, 73);
  const cs = S().cards;
  let y = -1;
  for(let i = 1; i < cs.length; i++) if(cs[i].rank !== cs[0].rank){ y = i; break; }
  tap(0);
  const t2 = toneNodes;
  tap(y);
  ok(toneNodes > t2, '★ 配对失败有声音（+' + (toneNodes - t2) + '）');

  /* 静音 */
  els.btnSound.fire('click');
  ok(win.__pairsProg().sound === false, '点静音 → sound=false');
  const t3 = toneNodes, n3 = noiseNodes, v3 = vibrates;
  newGame(0, 74);
  const cs2 = S().cards;
  let y2 = -1;
  for(let i = 1; i < cs2.length; i++) if(cs2[i].rank !== cs2[0].rank){ y2 = i; break; }
  tap(0); tap(y2);
  ok(toneNodes === t3 && noiseNodes === n3, '★ 静音后一个音都不发（+' + (toneNodes - t3) + '）');
  ok(vibrates === v3, '★ 静音后连震动也一起关掉');
  els.btnSound.fire('click');
  ok(win.__pairsProg().sound === true, '再点一次恢复音效');
}

/* ================= 14) 布局 ================= */
section('14) 布局');
{
  const lv = win.__pairsLevels();
  for(const l of lv){
    newGame(l.id);
    const s = S();
    ok(Math.abs(s.ch / s.cw - 1 / 0.7) < 0.06,
       '关卡 ' + (l.id+1) + '：牌宽高比 ≈ 2:3（' + s.cw + '×' + s.ch + '）');
    const bw = s.cols * s.cw + s.gap * (s.cols - 1);
    const bh = s.rows * s.ch + s.gap * (s.rows - 1);
    ok(bw <= 390 - 16 + 1, '关卡 ' + (l.id+1) + '：牌桌宽不超出舞台（' + bw + ' ≤ ' + (390-16) + '）');
    ok(bh <= 320 - 16 + 1, '关卡 ' + (l.id+1) + '：牌桌高不超出舞台（' + bh + ' ≤ ' + (320-16) + '）');
    ok(s.cw >= 26, '关卡 ' + (l.id+1) + '：牌不至于小得看不见（宽 ' + s.cw + 'px）');
    ok(s.gap >= 6 && s.gap <= 14, '关卡 ' + (l.id+1) + '：牌间距 6~14px（' + s.gap + '）');
  }
}

/* ================= 15) 单文件自包含 ================= */
section('15) 单文件自包含（离线可用）');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok((html.match(/href="\//g) || []).length === 1, '只有一个站点根链接（返回键 href="/"）');
  ok(/<canvas id="fx"/.test(html), '特效画布在页面里');
  /* 牌面花色用 Unicode，不依赖图片或图标字体 */
  ok(/\\u2660/.test(script) && /\\u2665/.test(script) && /\\u2666/.test(script) && /\\u2663/.test(script),
     '★ 四种花色用 Unicode 字符，不依赖图片');
  /* 不能有 ES6 的 \u{...}（老 Android WebView 不认） */
  ok(!/\\u\{[0-9a-fA-F]+\}/.test(script), '★ 没有 ES6 的 \\u{...} 转义（老 WebView 不认）');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
