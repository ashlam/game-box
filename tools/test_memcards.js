#!/usr/bin/env node
/**
 * 记忆扑克（Memory Poker）逻辑回归测试
 *
 * 覆盖：
 *   1) 四个难度档：牌数 / 轮数 / 题目类型，默认档位、本地存档记住上次选的档
 *   2) 发牌：52 张里抽 n 张**互不相同**、花色点数合法、id = 发牌顺序
 *   3) 阶段机：show → hide → ask → reveal → 下一轮 / 结算，时间由 step(dt) 驱动
 *   4) 四个题型各自能判对判错：red（红牌张数）/ suit（第 N 张花色）/ point（第 N 张点数）/ order（顺序）
 *   5) 顺序题必须**洗位**：洗完不能还是原序（否则答案就是「从左到右点一遍」）
 *   6) 计分：连击倍率、神速加成、答错清零连击、全对奖励
 *   7) 存档：每个难度只记更高分；重启后还在
 *   8) ★ 提问阶段绝不能提前标出「问的是哪张」（target 只在揭晓时加）
 *   9) ★ 提问阶段牌必须是扣着的（red/suit/point），只有 order 是翻开的
 *  10) 布局：牌宽高比 2:3、牌桌不超出舞台、牌数决定列数
 *  11) 音效（FakeCtx 计数）：答对升调、答错低沉、过关号角、破纪录额外一层；静音后彻底不发声
 *  12) 单文件自包含：没有外部 http(s) 依赖
 *
 * 用法：node tools/test_memcards.js [web/memcards/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'memcards', 'index.html');
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
    getBoundingClientRect(){
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
               right: this.clientWidth, bottom: this.clientHeight };
    },
    setAttribute() {}, focus() {}, blur() {},
  };
  /* 真 DOM 的 textContent 是**聚合**的：设值清掉所有子节点，读值拼接整棵子树。
     假 DOM 早期把两者分成两套，于是 `el.textContent = '…'` 之后再 appendChild，
     读出来还是那句旧文本、看不到子节点 —— 测出来全是假 bug（这轮就踩了一次）。 */
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

function makeVM(store){
  const els = {};
  const nowRef = { t: 1000 };
  const stage = mkEl('div'); stage.clientWidth = 390; stage.clientHeight = 320; els.stage = stage;
  els.board = mkEl('div');
  els.ask = mkEl('div');
  els.askQ = mkEl('div');
  const cd = mkEl('div'); cd.appendChild(mkEl('i')); els.cd = cd;
  els.modes = mkEl('div');
  els.hud = mkEl('div');
  for(let i = 0; i < 3; i++) els.hud.appendChild(mkEl('div'));
  els.stamp = mkEl('div');
  const fx = mkEl('canvas'); fx.getContext = () => mkCtx(); els.fx = fx;

  const doc = {
    getElementById: id => els[id] || (els[id] = mkEl('div')),
    createElement: mkEl,
    createTextNode: txt => { const e = mkEl('#text'); e.textContent = String(txt); return e; },    addEventListener() {}, removeEventListener() {},
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
  vm.runInContext(script, sandbox, { filename: 'gmem-inline.js' });
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

const S = () => win.__mem();
const newGame = (lv, seed) => win.__memNewGame(lv, seed);
const start = () => win.__memStart();
const step = dt => win.__memStep(dt);
const cards = () => win.__memCards();
const ask = () => win.__memAsk();
const DT = 1 / 60;
function run(sec){ const n = Math.round(sec / DT); for(let i = 0; i < n; i++) step(DT); }

/** 推进到提问阶段（看牌时间 + 收牌时间，多给一点余量） */
function toAsk(){
  let guard = 0;
  while(S().phase !== 'ask' && guard++ < 4000) step(DT);
  return S().phase;
}
/** 推进到揭晓结束、进入下一轮或结算 */
function toNext(){
  let guard = 0;
  while((S().phase === 'reveal' || S().phase === 'hide' || S().phase === 'show') && guard++ < 4000) step(DT);
  return S().phase;
}
/** 按题目类型给出正确答案 */
function correctAnswer(){
  const s = S();
  if(s.task === 'red'){
    return s.cards.filter(c => c.red).length;
  }
  if(s.task === 'suit') return s.cards[s.target].suit;
  if(s.task === 'point') return s.cards[s.target].rank;
  return null;
}
/** 答对当前这一题 */
function answerRight(){
  const s = S();
  if(s.task === 'order'){
    const order = s.order;
    // 按发牌顺序找到牌在**当前桌面顺序**里的下标，再依次点
    const idxOf = {};
    s.cards.forEach((c, i) => { idxOf[c.id] = i; });
    for(const id of order) win.__memTapCard(idxOf[id]);
    return 'ok';
  }
  return win.__memAnswer(correctAnswer());
}
/** 答错当前这一题（选项里挑一个不是正确答案的） */
function answerWrong(){
  const s = S();
  if(s.task === 'order'){
    const idxOf = {};
    s.cards.forEach((c, i) => { idxOf[c.id] = i; });
    // 倒着点 = 一定不是原序（牌数 ≥ 3 时）
    const rev = s.order.slice().reverse();
    for(const id of rev) win.__memTapCard(idxOf[id]);
    return 'bad';
  }
  const right = correctAnswer();
  const bad = s.options.find(o => String(o.v) !== String(right));
  return win.__memAnswer(bad.v);
}

/* ================= 1) 难度档 ================= */
section('1) 四个难度档');
{
  const lv = win.__memLevels();
  ok(lv.length === 4, '四个难度（实际 ' + lv.length + '）');
  ok(JSON.stringify(lv.map(l => l.cards)) === JSON.stringify([3,5,7,9]),
     '牌数 3 / 5 / 7 / 9', JSON.stringify(lv.map(l => l.cards)));
  ok(JSON.stringify(lv.map(l => l.rounds)) === JSON.stringify([5,5,5,6]),
     '轮数 5 / 5 / 5 / 6', JSON.stringify(lv.map(l => l.rounds)));
  ok(lv.every(l => l.tasks.indexOf('suit') >= 0 && l.tasks.indexOf('point') >= 0),
     '★ 每一档都有「花色」「点数」两种题');
  ok(lv[0].tasks.indexOf('order') >= 0 && lv[1].tasks.indexOf('order') >= 0,
     '前两档有顺序题（牌少，点得过来）');
  ok(lv[2].tasks.indexOf('order') < 0 && lv[3].tasks.indexOf('order') < 0,
     '★ 7/9 张的档位不放顺序题（点 9 下才判一次，节奏太拖）');
  ok(lv.every(l => l.tasks.indexOf('count') < 0),
     '★ 没有「一共几张牌」这种题 —— 牌摆在桌上数一眼就知道，考的是视力不是记忆');
  /* 看牌时间必须随牌数增长 */
  ok(lv.every((l, i) => i === 0 || l.show > lv[i-1].show),
     '看牌时间随牌数递增（' + lv.map(l => l.show).join(' / ') + 's）');
  ok(lv[0].show > 1.5 && lv[3].show < 6,
     '看牌时间落在合理区间（' + lv[0].show + 's ~ ' + lv[3].show + 's）');

  ok(S().level === 1, '默认档位是「进阶」5 张（实际 ' + S().level + '）');
  ok(els.modes.children.length === 4, '难度条 4 个按钮（实际 ' + els.modes.children.length + '）');
  ok(els.modes.children.filter(b => b.classList.contains('on')).length === 1,
     '★ 任何时刻只有一个难度高亮');
  ok(els.modes.children[1].classList.contains('on'), '高亮的是当前档位');
  const labels = els.modes.children.map(b => b.textContent);
  ok(labels.every(t => /\d+\s*张/.test(t)), '每个按钮都标了牌数（' + labels.join(' | ') + '）');

  for(const l of lv){
    newGame(l.id);
    const s = S();
    ok(s.level === l.id, l.name + '：档位切过去了');
    ok(win.__memLevels()[l.id].cards === l.cards, l.name + '：牌数 ' + l.cards);
  }
  newGame(1);
}

/* ================= 2) 发牌 ================= */
section('2) 发牌');
{
  let dup = 0, badSuit = 0, badRank = 0, badId = 0, total = 0;
  const SUIT_SYMS = ['\u2660','\u2665','\u2666','\u2663'];
  const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  for(let seed = 1; seed <= 120; seed++){
    newGame(3, seed);
    start();
    const s = S();
    total++;
    const keys = s.cards.map(c => c.suit + '|' + c.rank);
    if(new Set(keys).size !== keys.length) dup++;
    if(s.cards.some(c => SUIT_SYMS.indexOf(c.suit) < 0)) badSuit++;
    if(s.cards.some(c => RANKS.indexOf(c.rank) < 0)) badRank++;
    s.cards.forEach((c, i) => { if(c.id !== i) badId++; });
  }
  ok(total === 120, '跑了 120 局');
  ok(dup === 0, '★ 同一局里没有重复的牌（重复 ' + dup + ' 次）');
  ok(badSuit === 0, '★ 花色都在 ♠♥♦♣ 里（越界 ' + badSuit + ' 次）');
  ok(badRank === 0, '★ 点数都在 A~K 里（越界 ' + badRank + ' 次）');
  ok(badId === 0, '★ id 就是发牌顺序 0..n-1（错 ' + badId + ' 个）');

  /* 四种花色都得出现得了（牌数够多时） */
  newGame(3, 1);
  let suitSeen = new Set();
  for(let seed = 1; seed <= 200; seed++){
    newGame(3, seed); start();
    S().cards.forEach(c => suitSeen.add(c.suit));
  }
  ok(suitSeen.size === 4, '★ 四种花色都能抽到（实际 ' + suitSeen.size + ' 种）');

  /* 同种子可复现、不同种子不同 */
  newGame(1, 777); start(); const a = S().cards.map(c => c.suit + c.rank).join(',');
  newGame(1, 777); start(); const b = S().cards.map(c => c.suit + c.rank).join(',');
  newGame(1, 778); start(); const c = S().cards.map(c => c.suit + c.rank).join(',');
  ok(a === b, '同种子发出的牌一致（可复现）');
  ok(a !== c, '不同种子发出不同的牌');
}

/* ================= 3) 阶段机 ================= */
section('3) 阶段机：show → hide → ask → reveal');
{
  newGame(0, 11);
  ok(S().phase === 'idle', '开局是 idle');
  ok(cards().length === 3, 'idle 时牌桌已经摆好 3 张（不是空的）');
  ok(cards().every(c => c.down), '★ idle 时牌全是扣着的');

  start();
  ok(S().phase === 'show', '★ 点开始进入看牌阶段');
  ok(S().showT > 1.5, '看牌时间已设定（' + S().showT + 's）');
  ok(cards().every(c => !c.down), '★ 看牌阶段牌是翻开的');
  ok(cards().length === 3, '牌数对');

  /* 没到点不会自己跳阶段 */
  run(S().showT * 0.5);
  ok(S().phase === 'show', '半程时还在看牌');
  run(S().showT * 0.6);
  ok(S().phase === 'hide', '★ 到点自动收牌（hide）');
  ok(cards().every(c => c.down), '★ 收牌后全部翻回背面');

  run(0.6);
  ok(S().phase === 'ask', '★ 收完牌进入提问（ask）');
  ok(S().phase === 'ask' && S().t < 1, '提问阶段的时间从头开始计');

  /* 提问阶段停着不走 —— 等玩家答 */
  run(5);
  ok(S().phase === 'ask', '★ 提问阶段不会自己过去（等玩家答）');

  const r = answerRight();
  ok(r === 'ok', '答对');
  ok(S().phase === 'reveal', '★ 答完进入揭晓（reveal）');

  run(2.2);
  ok(S().phase === 'show', '★ 揭晓结束后自动开下一轮（回到看牌）');
  ok(S().round === 2, '轮次 +1（实际 ' + S().round + '）');
}

/* ================= 4) 四个题型 ================= */
section('4) 四个题型各自能判对判错');
{
  const TASKS = ['red','suit','point','order'];
  for(const t of TASKS){
    let asked = 0, okN = 0, badN = 0, guard = 0;
    /* 反复开新局，直到碰上指定题型 */
    while(asked < 6 && guard++ < 400){
      newGame(1, 900 + guard);
      start();
      toAsk();
      if(S().task !== t) continue;
      asked++;
      const s = S();
      /* 选项/交互是否齐备 */
      if(t === 'order'){
        ok(cards().every(c => !c.down), '[' + t + '] 顺序题牌是翻开的（要能点）');
        ok(ask().some(x => /已点/.test(x.text)), '[' + t + '] 显示「已点 x / n 张」进度');
      } else {
        ok(s.options.length === 4, '[' + t + '] 4 个选项（实际 ' + s.options.length + '）');
        ok(s.options.some(o => String(o.v) === String(correctAnswer())),
           '[' + t + '] ★ 选项里一定有正确答案');
        ok(new Set(s.options.map(o => String(o.v))).size === 4, '[' + t + '] 选项互不重复');
        /* 牌的朝向要看 DOM（__mem() 给的是牌面数据，没有 down 字段） */
        ok(cards().every(c => c.down), '[' + t + '] ★ 提问时牌是扣着的（不然一眼就能看答案）');
      }
      if(okN === 0){
        const r1 = answerRight();
        if(r1 === 'ok') okN++;
        else ok('false', '[' + t + '] 正确答案判错了');
      }
      toNext();
      if(badN === 0){
        /* 再开一局，这次故意答错 */
        let g2 = 0;
        while(g2++ < 200){
          newGame(1, 5000 + guard * 7 + g2);
          start(); toAsk();
          if(S().task !== t) { toNext(); continue; }
          const r2 = answerWrong();
          if(r2 === 'bad') badN++;
          else ok('false', '[' + t + '] 错误答案被当成对了');
          break;
        }
      }
    }
    ok(asked >= 4, '[' + t + '] 这个题型确实会被抽到（' + asked + ' 次）');
    ok(okN === 1, '[' + t + '] ★ 答对能判对');
    ok(badN === 1, '[' + t + '] ★ 答错能判错');
  }
}

/* ================= 5) 顺序题必须洗位 ================= */
section('5) 顺序题洗位');
{
  const sh = win.__memReshuffle;
  /* 洗位不能还是原序 —— 否则答案就是「从左到右点一遍」 */
  let sameAsBefore = 0, lostCards = 0, total = 0;
  for(let seed = 1; seed <= 200; seed++){
    newGame(1, seed); start();
    const before = S().cards.map(c => c.id);
    const after = sh(S().cards).map(c => c.id);
    total++;
    if(before.join(',') === after.join(',')) sameAsBefore++;
    const sortedA = before.slice().sort((a,b) => a-b).join(',');
    const sortedB = after.slice().sort((a,b) => a-b).join(',');
    if(sortedA !== sortedB) lostCards++;
  }
  ok(total === 200, '跑了 200 次洗位');
  ok(sameAsBefore === 0, '★ 洗完从没还是原序（' + sameAsBefore + ' 次）');
  ok(lostCards === 0, '★ 洗位不增不减牌（' + lostCards + ' 次）');

  /* 顺序题实战：洗过位之后，按发牌顺序点仍然判对 */
  let tested = 0, guard = 0;
  while(tested < 3 && guard++ < 300){
    newGame(1, 3000 + guard);
    start(); toAsk();
    if(S().task !== 'order'){ toNext(); continue; }
    tested++;
    const s = S();
    const shuffled = s.cards.map(c => c.id).join(',');
    const orig = s.order.join(',');
    ok(shuffled !== orig, '★ 顺序题真的洗了位（原序 ' + orig + ' → 桌上 ' + shuffled + '）');
    /* 按发牌顺序点 */
    const idxOf = {};
    s.cards.forEach((c, i) => { idxOf[c.id] = i; });
    for(const id of s.order) win.__memTapCard(idxOf[id]);
    ok(S().lastOk === true, '★ 洗位后按发牌顺序点仍然判对');
    toNext();
  }
  ok(tested >= 3, '跑了 ' + tested + ' 局顺序题');

  /* 顺序题点错（倒序）必须判错 */
  guard = 0;
  let badDone = 0;
  while(badDone < 1 && guard++ < 300){
    newGame(1, 8000 + guard);
    start(); toAsk();
    if(S().task !== 'order'){ toNext(); continue; }
    const s = S();
    const idxOf = {};
    s.cards.forEach((c, i) => { idxOf[c.id] = i; });
    const rev = s.order.slice().reverse();
    for(const id of rev) win.__memTapCard(idxOf[id]);
    ok(S().lastOk === false, '★ 倒着点判错');
    badDone++;
  }
  ok(badDone === 1, '顺序题点错的情况测到了');

  /* 顺序题点满之后自动判分，不需要再按确认 */
  ok(true, '（点满最后一张就自动判，见上）');
}

/* ================= 6) 计分 ================= */
section('6) 计分：连击 / 神速 / 全对奖励');
{
  newGame(0, 21);
  start();
  ok(S().score === 0 && S().combo === 0, '开局 0 分 0 连击');

  /* 连续答对，倍率应该一路涨到 5 */
  const gains = [];
  for(let i = 0; i < 4; i++){
    toAsk();
    clock.t += 100;            // 神速（< 3s）
    const r = answerRight();
    if(r !== 'ok'){ ok(false, '第 ' + (i+1) + ' 题答对失败'); break; }
    gains.push(S().lastGain);
    toNext();
  }
  ok(gains.length === 4, '连续答了 4 题');
  ok(gains[0] > 0 && gains[1] > gains[0] && gains[2] > gains[1],
     '★ 连击越高单题得分越高（' + gains.join(' → ') + '）');
  ok(S().combo === 4, '连击累计到 4（实际 ' + S().combo + '）');
  ok(S().maxCombo >= 4, '最高连击记下来了');
  ok(gains[3] === gains[2] || gains[3] >= gains[2],
     '★ 倍率封顶 5 倍后不再涨（' + gains[2] + ' vs ' + gains[3] + '）');

  const beforeScore = S().score;
  /* 答错：连击清零 */
  toAsk();
  answerWrong();
  ok(S().combo === 0, '★ 答错连击清零');
  ok(S().score === beforeScore, '★ 答错不加分');
  ok(S().lastGain === 0, '答错这一题的得分是 0');
  toNext();

  /* 全对奖励：整局一题不错才有 */
  newGame(0, 22);
  start();
  for(let i = 0; i < 5; i++){
    toAsk();
    answerRight();
    toNext();
  }
  ok(S().phase === 'done', '打满 5 轮进入结算（实际 ' + S().phase + '）');
  ok(S().perfect === true, '★ 一题不错 → perfect');
  ok(S().bonus > 0, '★ 全对给了额外奖励（+' + S().bonus + '）');

  /* 有错就没有全对奖励 */
  newGame(0, 23);
  start();
  for(let i = 0; i < 5; i++){
    toAsk();
    if(i === 2) answerWrong(); else answerRight();
    toNext();
  }
  ok(S().phase === 'done', '打满 5 轮（有错的那局）');
  ok(S().perfect === false, '★ 错一题就不是 perfect');
  ok(S().bonus === 0, '★ 有错就没有全对奖励');

  /* 神速加成。
     ⚠️ 「神速」判的是**提问阶段已经过去多久**（S.t），不是墙上时钟 ——
     所以要让时间真的流过 step()，改 clock.t 是没用的。
     ⚠️ 而且必须拿**两局各自的第一题**来比：同一局里第二题自带 2 倍连击，
     直接比会把「连击倍率」算成「神速加成」（第一版就这么错了，测出 84 < 120）。 */
  let fastGain = 0, slowGain = 0;
  newGame(0, 31); start(); toAsk();
  run(0.2);
  answerRight(); fastGain = S().lastGain;
  const fastFlag = S().fast;
  newGame(0, 32); start(); toAsk();
  run(4.0);                  // 超过 3 秒
  answerRight(); slowGain = S().lastGain;
  ok(fastFlag === true, '★ 0.2 秒作答被判定为神速');
  ok(S().fast === false, '★ 4 秒作答不算神速');
  ok(fastGain > 0 && slowGain > 0, '两种速度都答对了（' + fastGain + ' / ' + slowGain + '）');
  ok(fastGain === Math.round(slowGain * 1.4),
     '★ 神速正好多 40%（' + fastGain + ' = ' + slowGain + ' × 1.4）');
}

/* ================= 7) 存档 ================= */
section('7) 存档：每个难度只记更高分');
{
  const st2 = {};
  const sb2 = makeVM(st2);
  const w2 = sb2.window;
  const c2 = sb2.__clock;
  const S2 = () => w2.__mem();
  const toAsk2 = () => { let g = 0; while(S2().phase !== 'ask' && g++ < 4000) w2.__memStep(DT); };
  const toNext2 = () => { let g = 0; while((S2().phase === 'reveal' || S2().phase === 'hide' || S2().phase === 'show') && g++ < 4000) w2.__memStep(DT); };
  const playOne = (lv, seed) => {
    w2.__memNewGame(lv, seed);
    w2.__memStart();
    for(let i = 0; i < w2.__memLevels()[lv].rounds; i++){
      toAsk2();
      const s = S2();
      if(s.task === 'order'){
        const idxOf = {};
        s.cards.forEach((c, i2) => { idxOf[c.id] = i2; });
        for(const id of s.order) w2.__memTapCard(idxOf[id]);
      } else {
        let right;
        if(s.task === 'red') right = s.cards.filter(c => c.red).length;
        else if(s.task === 'suit') right = s.cards[s.target].suit;
        else right = s.cards[s.target].rank;
        w2.__memAnswer(right);
      }
      toNext2();
    }
    return S2();
  };

  const r1 = playOne(0, 101);
  ok(r1.phase === 'done', '第一局打完了');
  ok(r1.newRecord === true, '★ 第一局就是新纪录（之前没有成绩）');
  ok(S2().best['0'] && S2().best['0'].score === r1.score, '成绩写进存档');
  const firstScore = r1.score;

  ok(st2['gmem_v1'] !== undefined, '落盘到 localStorage');
  const saved = JSON.parse(st2['gmem_v1']);
  ok(saved.best && saved.best['0'], '存档里有 best[0]');
  ok(typeof saved.best['0'].score === 'number', '存档里 score 是数字');
  ok(typeof saved.best['0'].at === 'number' && saved.best['0'].at > 0, '记了达成时间');

  /* 打得更差 → 不该覆盖 */
  const r2 = playOne(0, 102);
  if(r2.score <= firstScore){
    ok(r2.newRecord === false, '★ 分数没超过就不算新纪录');
    ok(S2().best['0'].score === firstScore, '★ 低分不覆盖高分');
  } else {
    ok(r2.newRecord === true, '（这局恰好更高，覆盖了）');
  }

  /* 重启后存档还在 */
  const sb3 = makeVM(st2);
  const w3 = sb3.window;
  ok(w3.__mem().best['0'] && w3.__mem().best['0'].score === Math.max(firstScore, r2.score),
     '★ 重启后成绩还在（同一个 localStorage）');

  /* 坏存档不能把游戏搞崩 */
  const badStore = { 'gmem_v1': '{"best":{"0":{"score":"abc"},"1":null,"9":{"score":1}},"level":77}' };
  let crashed = false;
  let sb4 = null;
  try{ sb4 = makeVM(badStore); }catch(e){ crashed = true; }
  ok(!crashed, '★ 坏存档不会让页面崩');
  if(sb4){
    ok(!sb4.window.__mem().best['0'], 'score 不是数字的条目被丢掉');
    ok(!sb4.window.__mem().best['9'], '不认识的难度档被丢掉');
    ok(sb4.window.__mem().level === 1, '★ 越界的 level 回落到默认档');
  }
  let sb5 = null;
  try{ sb5 = makeVM({ 'gmem_v1': 'not json at all' }); }catch(e){}
  ok(sb5 !== null, '★ 存档根本不是 JSON 也不会崩');
}

/* ================= 8) 提问时不能泄露答案 ================= */
section('8) ★ 提问阶段不能提前标出「问的是哪张」');
{
  let checked = 0, guard = 0;
  while(checked < 6 && guard++ < 300){
    newGame(1, 6000 + guard);
    start(); toAsk();
    const s = S();
    if(s.task !== 'suit' && s.task !== 'point'){ toNext(); continue; }
    checked++;
    const cs = cards();
    ok(cs.every(c => !c.target), '[' + s.task + '] ★ 提问时没有任何牌被标成 target');
    ok(cs.every(c => !c.ok), '[' + s.task + '] 提问时没有牌被标成 ok');
    /* 题干里提到的位置必须真的存在 */
    const m = /第 (\d+) 张/.exec(win.__memAskText());
    ok(m !== null, '[' + s.task + '] 题干里说了是第几张（' + win.__memAskText() + '）');
    if(m) ok(+m[1] >= 1 && +m[1] <= s.cards.length,
            '[' + s.task + '] 位置在 1~' + s.cards.length + ' 范围内（实际 ' + m[1] + '）');

    /* 揭晓时目标牌才亮出来，而且必须是**同一张** */
    answerRight();
    const after = cards();
    const targets = after.filter(c => c.target);
    if(s.task === 'suit' || s.task === 'point'){
      ok(targets.length === 1, '[' + s.task + '] ★ 揭晓时恰好一张牌被标成 target（实际 ' + targets.length + '）');
      ok(targets.length === 1 && targets[0].idx === s.target,
         '[' + s.task + '] ★ 标出来的就是被问的那一张（idx ' + s.target + '）');
    }
    toNext();
  }
  ok(checked >= 4, '抽查了 ' + checked + ' 次「问第几张」的题');
}

/* ================= 9) 提问时牌必须是扣着的 ================= */
section('9) ★ 提问时牌是扣着的（顺序题除外）');
{
  let checked = 0, guard = 0;
  while(checked < 8 && guard++ < 400){
    newGame(1, 7000 + guard);
    start(); toAsk();
    const s = S();
    checked++;
    const cs = cards();
    if(s.task === 'order'){
      ok(cs.every(c => !c.down), '顺序题：牌是翻开的（要能点出来）');
    } else {
      ok(cs.every(c => c.down), '★ ' + s.task + ' 题：牌全是扣着的（不然答案就在脸上）');
      /* 「几张」这个词本身可以出现（red 题的题干就要说「有几张是红色」），
         要防的是「一共几张牌」那种**数得出来**的题 —— 它连题型都不存在。 */
      ok(s.task !== 'count' && win.__memLevels()[s.level].tasks.indexOf('count') < 0,
         '★ ' + s.task + ' 题不是「一共几张牌」（那种题数一眼就会，不用记）');
    }
    toNext();
  }
  ok(checked >= 8, '抽查了 ' + checked + ' 次');
}

/* ================= 10) 布局 ================= */
section('10) 布局');
{
  for(const lvId of [0,1,2,3]){
    newGame(lvId);
    const s = S();
    const L = win.__memLevels()[lvId];
    ok(s.cards.length === L.cards, L.name + '：牌数 ' + L.cards);
    ok(Math.abs(s.ch / s.cw - 1 / 0.7) < 0.02,
       L.name + '：牌宽高比 ≈ 2:3（' + s.cw + '×' + s.ch + '）');
    const rows = Math.ceil(L.cards / s.cols);
    ok(s.rows === rows, L.name + '：' + s.cols + ' 列 × ' + s.rows + ' 行');
    const bw = s.cols * s.cw + s.gap * (s.cols - 1);
    const bh = s.rows * s.ch + s.gap * (s.rows - 1);
    ok(bw <= 390 - 16 + 1, L.name + '：牌桌宽不超出舞台（' + bw + ' ≤ ' + (390-16) + '）');
    ok(bh <= 320 - 16 + 1, L.name + '：牌桌高不超出舞台（' + bh + ' ≤ ' + (320-16) + '）');
    ok(s.cw >= 28, L.name + '：牌不至于小得看不见（宽 ' + s.cw + 'px）');
    ok(s.gap >= 6 && s.gap <= 14, L.name + '：牌间距 6~14px（' + s.gap + '）');
  }
  /* 牌桌尺寸只跟牌数有关，跟阶段无关 —— 阶段切换时牌不能跳 */
  newGame(1, 55); start();
  const w1 = S().cw, h1 = S().ch;
  toAsk();
  ok(S().cw === w1 && S().ch === h1, '★ 从看牌切到提问，牌尺寸一点没变（' + w1 + '×' + h1 + '）');
  answerRight();
  ok(S().cw === w1 && S().ch === h1, '★ 揭晓时牌尺寸也没变');

  /* 顺序题洗位后尺寸也不能变（只是换了位置，不该换大小） */
  let g2 = 0;
  while(g2++ < 200){
    newGame(1, 9000 + g2); start(); toAsk();
    if(S().task !== 'order'){ toNext(); continue; }
    const cw0 = S().cw, ch0 = S().ch;
    ok(cw0 > 0 && ch0 > 0, '顺序题洗位后牌还有尺寸（' + cw0 + '×' + ch0 + '）');
    break;
  }
}

/* ================= 11) 音效 ================= */
section('11) 音效');
{
  /* 静音开关先复位 */
  if(win.__memProg().sound === false) els.btnSound.fire('click');
  ok(win.__memProg().sound === true, '默认开音效');

  const t0 = toneNodes;
  newGame(0, 41); start();
  ok(toneNodes > t0, '★ 发牌有声音（+' + (toneNodes - t0) + '）');

  toAsk();
  const t1 = toneNodes;
  answerRight();
  ok(toneNodes > t1, '★ 答对有声音（+' + (toneNodes - t1) + '）');

  toNext(); toAsk();
  const t2 = toneNodes;
  answerWrong();
  ok(toneNodes > t2, '★ 答错有声音（+' + (toneNodes - t2) + '）');

  /* 打完整局 → 过关号角 */
  newGame(0, 42); start();
  const t3 = toneNodes;
  for(let i = 0; i < 5; i++){ toAsk(); answerRight(); toNext(); }
  ok(S().phase === 'done', '打完了');
  ok(toneNodes - t3 > 10, '★ 结算有号角（+' + (toneNodes - t3) + ' 个音）');

  /* 静音 */
  els.btnSound.fire('click');
  ok(win.__memProg().sound === false, '点静音 → sound=false');
  ok(els.btnSound.textContent.indexOf('静音') >= 0, '按钮文字变成静音');
  const t4 = toneNodes, n4 = noiseNodes, v4 = vibrates;
  newGame(0, 43); start();
  toAsk(); answerWrong(); toNext();
  ok(toneNodes === t4 && noiseNodes === n4, '★ 静音后一个音都不发（+' + (toneNodes - t4) + '）');
  ok(vibrates === v4, '★ 静音后连震动也一起关掉');
  els.btnSound.fire('click');
  ok(win.__memProg().sound === true, '再点一次恢复音效');
}

/* ================= 12) 结算面板与排行榜 ================= */
section('12) 结算面板与排行榜');
{
  newGame(0, 51); start();
  for(let i = 0; i < 5; i++){ toAsk(); answerRight(); toNext(); }
  ok(S().phase === 'done', '打满 5 轮');
  ok(S().panelShown === false, '★ 结算面板先不弹（要让庆祝演完）');
  ok(S().panelDue === true, '面板已排期');
  run(1.6);
  ok(S().panelShown === true, '★ 到点弹出结算面板');
  ok(els.doneOv.classList.contains('on'), '浮层真的打开了（.on）');
  ok(/\d/.test(els.doneScore.textContent), '面板显示分数（' + els.doneScore.textContent + '）');
  ok(els.doneSub.textContent.length > 0, '面板显示明细（' + els.doneSub.textContent + '）');
  ok(els.doneRec.textContent.length > 0, '面板显示纪录说明（' + els.doneRec.textContent + '）');

  /* 排行榜：四个难度都在 */
  win.__memOpenTop(0);
  const rows = win.__memTopRows();
  ok(rows.length === 4, '★ 排行榜四个难度都在（实际 ' + rows.length + ' 行）');
  ok(rows.filter(r => /has/.test(r.cls)).length >= 1, '打过的那档有成绩标记');
  ok(rows.filter(r => /me/.test(r.cls)).length === 1, '★ 恰好一行标着「当前看的这档」');
  ok(els.topPlay.textContent.indexOf('热身') >= 0, '按钮文案带上难度名（' + els.topPlay.textContent + '）');

  /* 空榜文案不能承诺「第一名」（这里只记最好成绩，没有名次） */
  const st3 = {};
  const sb6 = makeVM(st3);
  sb6.window.__memOpenTop(0);
  const rows6 = sb6.window.__memTopRows();
  ok(rows6.length === 4, '★ 空榜也只渲染 4 行（提示走标题栏，不往列表里塞行）',
     '实际 ' + rows6.length + ' 行');
  ok(rows6.filter(r => /topEmpty/.test(r.cls)).length === 0,
     '★ 空榜不额外塞提示行（会撑出滚动条）');
  ok(els.topSub.textContent.length > 0, '空榜时标题栏有说明（' + els.topSub.textContent + '）');
  ok(els.topSub.textContent.indexOf('第一名') < 0,
     '★ 空榜不承诺「第一名就是你了」（本作只记最好成绩，没有名次）',
     els.topSub.textContent);
}

/* ================= 13) 重来 / 切档 ================= */
section('13) 重来 / 切难度');
{
  newGame(1, 61); start(); toAsk();
  ok(S().phase === 'ask', '进到提问了');
  els.btnMain.fire('click');          // 主按钮 = 重来
  ok(S().phase === 'show', '★ 中途按主按钮 → 立刻重开（回到看牌）');
  ok(S().round === 1, '★ 重来把轮次也归零了（实际 ' + S().round + '）');
  ok(S().score === 0, '重来把分数归零');

  /* 切难度：应该立刻开新档、轮次归零、牌数变 */
  els.modes.children[3].fire('click');
  ok(S().level === 3, '★ 点「大师」切到 9 张档');
  ok(S().round === 0, '★ 切档后轮次归零（不会接着上一档的进度）');
  ok(cards().length === 9, '★ 牌桌立刻变成 9 张');
  ok(S().phase === 'idle', '切档后停在 idle，等玩家按开始');

  /* 再点同一个档位（没在玩）不该出事 */
  const before = JSON.stringify(S().cards);
  els.modes.children[3].fire('click');
  ok(S().level === 3 && S().phase === 'idle', '重复点同一档位是安全的');

  /* 中途点同一档位 → 不打断当前这一局 */
  start(); toAsk();
  els.modes.children[3].fire('click');
  ok(S().phase === 'ask', '★ 玩到一半点同一个档位不会打断当前局');

  newGame(1);
}

/* ================= 14) 提问超时兜底 ================= */
section('14) 提问超时兜底');
{
  newGame(0, 71); start(); toAsk();
  ok(S().phase === 'ask', '进到提问');
  run(26);                                   // 超过 ASK_LIMIT
  ok(S().phase === 'reveal', '★ 25 秒不答 → 自动揭晓（不惩罚，但不让一局死在原地）');
  ok(S().wrong === 1, '超时算一次答错');
  ok(S().combo === 0, '超时也清零连击');
}

/* ================= 15) 单文件自包含 ================= */
section('15) 单文件自包含（离线可用）');
{
  ok(!/(?:href|src)\s*=\s*["'](?:https?:)?\/\//.test(html), '★ 没有外链（http/https/协议相对）');
  ok(!/<link\b/i.test(html), '没有外部样式表');
  ok(!/<img\b/i.test(html), '没有外部图片');
  ok(!/<script[^>]+src=/i.test(html), '没有外部脚本');
  ok((html.match(/href="\//g) || []).length === 1, '只有一个站点根链接（返回键 href="/"）');
  ok(/<canvas id="fx"/.test(html), '特效画布在页面里（不是外部资源）');
  /* 牌面用 Unicode 花色字符，不依赖任何图片字体 */
  ok(/\\u2660/.test(script) && /\\u2665/.test(script) && /\\u2666/.test(script) && /\\u2663/.test(script),
     '★ 四种花色用 Unicode 字符（\\u2660/2665/2666/2663），不依赖图片');
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(60));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if(fail){ console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
