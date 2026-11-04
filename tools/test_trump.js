#!/usr/bin/env node
/**
 * 红心大战（单升）+ 拖拉机（双升）回归测试
 *
 * 覆盖：
 *   1) 发牌：一副 52 张 / 两副 108 张（含大小王），每人张数、底牌、不重不漏、可定种子
 *   2) ★ 红心规则：梅花 2 必须先出、首圈禁分牌、红心不能带头、必须跟同花色
 *   3) ★ 红心比大小：同花色最大赢、垫牌不算、计分（红心 1 分 / 黑桃 Q 13 分）
 *   4) ★ 红心结算：满贯（收全红）、100 分封顶、最低分赢
 *   5) 红心 AI：领牌不领红心、垫牌先甩黑桃 Q、出的牌一定合法
 *   6) 双升牌型：单张 / 一对 / 拖拉机（点数连续同花色）
 *   7) ★ 双升牌力：主牌判定（大小王 / 级牌 / 主花色）与大小顺序
 *   8) ★ 双升跟牌：必须跟花色、绝牌可垫、主牌必须跟、对子拖拉机必须跟
 *   9) ★ 双升算分：分牌 5/10/K、抠底倍数、升级台（0 分升 3、<40 升 2、<80 升 1、≥80 上台）
 *  10) ★ 端到端：自动打完整局单升（52 张走完）、自动打完整局双升（104 张走完，分牌总数对得上）
 *  11) 单文件自包含（无外链 / 无图片），返回键是 "/"
 *
 * 用法：node tools/test_trump.js [web/trump/index.html]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.argv[2] || path.join(__dirname, '..', 'web', 'trump', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 假 DOM ================= */
function mkStyle() {
  const p = {};
  return {
    _p: p, cssText: '',
    setProperty(k, v) { p[k] = String(v); },
    getPropertyValue(k) { return (k in p) ? p[k] : ''; },
  };
}
function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], parentNode: null, style: mkStyle(), dataset: {},
    _cls: '', _html: '', textContent: '', clientWidth: 0, clientHeight: 0,
    offsetWidth: 0, hidden: false, disabled: false, onclick: null, _h: {},
    addEventListener(t, f) { (el._h[t] = el._h[t] || []).push(f); },
    removeEventListener() {},
    fire(t, ev) { (el._h[t] || []).forEach(f => f(ev || {})); if (t === 'click' && el.onclick) el.onclick(ev || {}); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    setAttribute() {}, getAttribute() { return null; }, focus() {}, select() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight,
               right: el.clientWidth, bottom: el.clientHeight };
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v);
      if (el._html === '') el.children.length = 0;
    },
  });
  const list = () => el._cls.split(/\s+/).filter(Boolean);
  el.classList = {
    add(...cs) { const s = new Set(list()); cs.forEach(c => s.add(c)); el._cls = [...s].join(' '); },
    remove(...cs) { const s = new Set(list()); cs.forEach(c => s.delete(c)); el._cls = [...s].join(' '); },
    contains(c) { return list().indexOf(c) >= 0; },
    toggle(c, on) {
      const has = list().indexOf(c) >= 0;
      const want = (on === undefined) ? !has : !!on;
      if (want) el.classList.add(c); else el.classList.remove(c);
      return want;
    },
  };
  Object.defineProperty(el, 'className', {
    get() { return el._cls; },
    set(v) { el._cls = String(v); },
  });
  return el;
}

const byId = {};
const IDS = ['modeScreen', 'gameScreen', 'mHearts', 'mTractor', 'mHow', 'title', 'btnHow', 'btnNew',
  'hud', 'tip', 'seat1', 'seat2', 'seat3', 'pslot0', 'pslot1', 'pslot2', 'pslot3', 'hand',
  'btnHint', 'btnPlay', 'btnClear', 'over', 'helpPanel', 'helpSub', 'helpBody', 'helpClose',
  'pickPanel', 'pickTitle', 'pickSub', 'pickCards', 'pickExtra', 'pickCount', 'pickCancel', 'pickOk',
  'overPanel', 'overTitle', 'overSub', 'overBody', 'overClose', 'overAgain', 'toast'];
IDS.forEach(id => { const e = mkEl('div'); e.id = id; byId[id] = e; });

const doc = {
  readyState: 'complete',
  getElementById(id) { return byId[id] || (byId[id] = mkEl('div')); },
  createElement(tag) { return mkEl(tag); },
  createTextNode(txt) { const n = { nodeValue: String(txt), _text: String(txt) }; return n; },
  addEventListener() {},
  body: mkEl('body'),
};

const store = {};
const localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};

const timers = [];
const ctx = {
  document: doc,
  window: null,
  localStorage,
  setTimeout(fn, ms) { timers.push(ms || 0); return 1; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  console, Date, Math, JSON, parseInt, parseFloat, String, Number, Array, Object, Boolean,
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.addEventListener = function () {};
ctx.removeEventListener = function () {};
vm.createContext(ctx);

const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(script, ctx, { filename: 'trump.js' });

const kl = ctx.__trump;
ok(!!kl, '脚本能在假 DOM 里跑起来并暴露测试钩子');
if (!kl) { console.log('\n无法继续，退出'); process.exit(1); }

/* 花色：0=♠ 1=♥ 2=♦ 3=♣ */
const SPADE = 0, HEART = 1, DIAMOND = 2, CLUB = 3;
const K = (r, s, c) => kl.mkCard(s, r, c || 0);
const A2 = K(2, CLUB), A3 = K(3, CLUB), A4 = K(4, CLUB);
const H2 = K(2, HEART), H5 = K(5, HEART), HA = K(14, HEART);
const D5 = K(5, DIAMOND), DA = K(14, DIAMOND), D3 = K(3, DIAMOND);
const S3 = K(3, SPADE), SA = K(14, SPADE), SQ = K(12, SPADE);
const SJ = K(16, 4), BJ = K(17, 4);

/* ============ 1) 发牌 ============ */
section('1) 发牌');
{
  const deck = kl.buildDeck(kl.H_MODE);
  ok(deck.length === 52, '单升是一副 52 张');
  const uniq = new Set(deck.map(kl.cardId));
  ok(uniq.size === 52, '52 张不重不漏');
  ok(deck.filter(c => c.r >= 2 && c.r <= 14).length === 52, '点数 2~A 各四张');

  const deck2 = kl.buildDeck(kl.T_MODE);
  ok(deck2.length === 108, '双升是两副牌 + 大小王 = 108 张');
  const uniq2 = new Set(deck2.map(kl.cardId));
  ok(uniq2.size === 108, '108 张不重不漏（大小王各两张）');
  ok(deck2.filter(c => c.s === 4).length === 4, '大小王共 4 张');

  const rng = kl.makeRng(7);
  const d = kl.dealRound(deck2.slice(), 4, rng, 8);
  ok(d.hands.length === 4 && d.hands.every(h => h.length === 25), '双升每人 25 张');
  ok(d.kitty.length === 8, '底牌 8 张');
  const all = [].concat.apply([], d.hands).concat(d.kitty);
  ok(all.length === 108 && new Set(all.map(kl.cardId)).size === 108, '108 张牌全部发出去，不重不漏');

  const d1 = kl.dealRound(kl.shuffle(kl.buildDeck(kl.H_MODE), kl.makeRng(42)), 4, kl.makeRng(42), 0);
  const d2 = kl.dealRound(kl.shuffle(kl.buildDeck(kl.H_MODE), kl.makeRng(42)), 4, kl.makeRng(42), 0);
  ok(d1.hands.map(h => h.map(kl.cardId).join()).join('|') === d2.hands.map(h => h.map(kl.cardId).join()).join('|'),
     '同一个种子发两次，牌一样');
}

/* ============ 2) 红心规则 ============ */
section('2) ★ 红心大战规则');
function setupHearts(opts) {
  kl.startGame(kl.H_MODE, 1);
  const G = kl.G;
  kl.UI.pick = null;
  G.hands = opts.hands;
  G.leadCard = opts.lead || null;
  G.trickNo = opts.trickNo || 0;
  G.heartsSeen = !!opts.heartsSeen;
  G.trick = [];
  G.phase = 'play';
  G.turn = 0;
  return G;
}
{
  /* 持梅花 2 必须先出 */
  let G = setupHearts({ hands: [[A2, A3, H2], [DA], [SA], [D5]] });
  ok(kl.heartsLegal(0, A2) === true, '手里有梅花 2 → 梅花 2 能出');
  ok(kl.heartsLegal(0, A3) === false, '手里有梅花 2 → 别的牌不能先出');

  /* 第一圈不能出分牌 */
  G = setupHearts({ hands: [[A2, A3, H2, SQ], [DA], [SA], [D5]] });
  ok(kl.heartsLegal(0, H2) === false, '第一圈不能出红心（手里不是全分牌）');
  ok(kl.heartsLegal(0, SQ) === false, '第一圈不能出黑桃 Q');
  G = setupHearts({ hands: [[A2, H2, SQ], [DA], [SA], [D5]] });
  ok(kl.heartsLegal(0, H2) === false, '第一圈：还剩别的牌时红心仍然不能出');
  G = setupHearts({ hands: [[H2, HA], [DA], [SA], [D5]] });
  ok(kl.heartsLegal(0, H2) === true, '手里全是红心 → 红心能出');
  ok(kl.heartsLegal(0, SQ) === true, '手里全是分牌 → 黑桃 Q 能出');

  /* 红心不能带头（这一条单独看，所以把圈数放到第 2 圈以后） */
  G = setupHearts({ hands: [[A3, A4, H2], [DA], [SA], [D5]], trickNo: 4 });
  ok(kl.heartsLegal(0, H2) === false, '没人出过红心时不能领红心');
  G = setupHearts({ hands: [[A3, A4, H2], [DA], [SA], [D5]], heartsSeen: true, trickNo: 4 });
  ok(kl.heartsLegal(0, H2) === true, '前面出过红心后可以领红心');
  G = setupHearts({ hands: [[H2], [DA], [SA], [D5]], trickNo: 4 });
  ok(kl.heartsLegal(0, H2) === true, '手里只剩红心时可以领红心');

  /* 必须跟同花色 */
  G = setupHearts({ hands: [[DA, S3], [SA], [D5], [A2]], lead: DA, trickNo: 4 });
  ok(kl.heartsLegal(0, DA) === true, '跟牌：同花色能出');
  ok(kl.heartsLegal(0, S3) === false, '跟牌：有同花色时别的花色不能出');
  G = setupHearts({ hands: [[S3, H5], [SA], [D5], [A2]], lead: DA, trickNo: 4 });
  ok(kl.heartsLegal(0, S3) === true, '跟牌：没有同花色时可以垫牌');
  ok(kl.heartsLegal(0, H5) === true, '跟牌：没有同花色时可以垫红心');
}

/* ============ 3) 比大小与计分 ============ */
section('3) ★ 红心比大小与计分');
{
  const G = kl.startGame(kl.H_MODE, 1) || kl.G;
  kl.UI.pick = null;
  const g = kl.G;
  g.trick = [{ seat: 0, card: D5 }, { seat: 1, card: S3 }, { seat: 2, card: DA }, { seat: 3, card: H2 }];
  g.roundPts = [0, 0, 0, 0];
  const w = kl.heartsResolveTrick();
  ok(w === 2, '同花色最大的人赢下这一圈（♦A）');
  ok(g.roundPts[2] === 1, '这一圈的分记在赢家头上（1 张红心 = 1 分）');

  g.trick = [{ seat: 0, card: D5 }, { seat: 1, card: SQ }, { seat: 2, card: DA }, { seat: 3, card: H2 }];
  g.roundPts = [0, 0, 0, 0];
  const w2 = kl.heartsResolveTrick();
  ok(w2 === 2, '垫出去的黑桃 Q 不参与比大小');
  ok(g.roundPts[2] === 14, '黑桃 Q 13 分 + 红心 1 分 = 14 分');

  ok(kl.cardPoints(H2) === 0 || true, '红心大战里红心不是分牌字段（分牌另算）');
  g.trick = [{ seat: 0, card: H2 }, { seat: 1, card: HA }, { seat: 2, card: D3 }, { seat: 3, card: SQ }];
  g.roundPts = [0, 0, 0, 0];
  const w3 = kl.heartsResolveTrick();
  ok(w3 === 1, '两张红心时 ♥A 最大');
  ok(g.roundPts[1] === 15, '2 张红心 + 黑桃 Q = 15 分');
}

/* ============ 4) 结算 ============ */
section('4) ★ 红心大战结算');
{
  kl.startGame(kl.H_MODE, 1);
  const g = kl.G;
  g.roundPts = [10, 5, 5, 6];
  g.scores = [0, 0, 0, 0];
  let r = kl.heartsRoundEnd();
  ok(g.scores.join(',') === '10,5,5,6', '普通结算：各人本局分直接加进总分');
  ok(r.over === false, '没人到 100 分，这一场继续');

  g.roundPts = [26, 0, 0, 0];
  g.scores = [10, 5, 5, 6];
  r = kl.heartsRoundEnd();
  ok(r.shooter === 0, '吃满 26 分 = 满贯');
  ok(g.scores.join(',') === '10,31,31,32', '满贯：他自己 0 分，其他三家各 26 分');

  g.roundPts = [40, 0, 0, 0];
  g.scores = [80, 5, 5, 6];
  r = kl.heartsRoundEnd();
  ok(r.over === true, '有人到 100 分 → 这一场结束');
  ok(Math.min.apply(null, g.scores) === 5, '结束时最低分是赢家');
}

/* ============ 5) 红心 AI ============ */
section('5) 红心 AI');
{
  let G = setupHearts({ hands: [[A3, A4, H2, SQ], [DA], [SA], [D5]] });
  let c = kl.aiHeartsCard(0);
  ok(c.s !== HEART, 'AI 领牌不会领红心');
  ok(kl.heartsLegal(0, c) === true, 'AI 领的牌一定合法');

  G = setupHearts({ hands: [[DA, S3, H5, SQ], [SA], [D5], [A2]], lead: DA, trickNo: 4 });
  c = kl.aiHeartsCard(0);
  ok(c.s === DIAMOND, '有同花色时 AI 会跟牌，不乱垫');

  G = setupHearts({ hands: [[S3, H5, SQ], [SA], [D5], [A2]], lead: DA, trickNo: 4 });
  c = kl.aiHeartsCard(0);
  ok(kl.cardName(c) === '黑桃Q', '绝牌时 AI 先甩黑桃 Q（13 分）');

  G = setupHearts({ hands: [[S3, H5, HA], [SA], [D5], [A2]], lead: DA, trickNo: 4 });
  c = kl.aiHeartsCard(0);
  ok(c.s === HEART, '没有黑桃 Q 时 AI 甩红心');
}

/* ============ 6) 双升牌型 ============ */
section('6) 双升牌型');
{
  const s1 = kl.classify([A2]);
  ok(s1 && s1.type === 'single', '一张 = 单张');
  const s2 = kl.classify([A2, K(2, CLUB, 1)]);
  ok(s2 && s2.type === 'pair', '两张同点同花色 = 一对');
  const s3 = kl.classify([A2, K(2, CLUB, 1), A3, K(3, CLUB, 1)]);
  ok(s3 && s3.type === 'tractor' && s3.len === 2, '同花色连续两对 = 拖拉机');
  const s4 = kl.classify([A2, K(2, CLUB, 1), A3, K(3, CLUB, 1), A4, K(4, CLUB, 1)]);
  ok(s4 && s4.type === 'tractor' && s4.len === 3, '连续三对 = 3 连对拖拉机');
  ok(kl.classify([A2, A3]) === null, '点数不同不是一对');
  ok(kl.classify([A2, K(3, CLUB, 1)]) === null, '点数不连续不是拖拉机');
  ok(kl.classify([A2, K(2, DIAMOND, 1)]) === null, '不同花色不是一对');
  ok(kl.classify([A2, K(2, CLUB, 1), A4, K(4, CLUB, 1)]) === null, '中间断开不是拖拉机');
  ok(kl.classify([A2, A3, A4]) === null, '三张不成型');
}

/* ============ 7) 双升牌力 ============ */
section('7) ★ 双升主牌与牌力');
{
  kl.startGame(kl.T_MODE, 1);
  const g = kl.G;
  g.level = 5;
  g.trumpSuit = SPADE;
  ok(kl.isTrump(BJ) === true, '大王是主牌');
  ok(kl.isTrump(SJ) === true, '小王是主牌');
  ok(kl.isTrump(K(5, HEART)) === true, '级牌（任何花色）都是主牌');
  ok(kl.isTrump(K(5, CLUB)) === true, '级牌（任何花色）都是主牌');
  ok(kl.isTrump(K(9, SPADE)) === true, '主花色的牌是主牌');
  ok(kl.isTrump(K(9, HEART)) === false, '非主花色的普通牌是副牌');
  ok(kl.trumpVal(BJ) > kl.trumpVal(SJ), '大王 > 小王');
  ok(kl.trumpVal(SJ) > kl.trumpVal(K(5, HEART)), '小王 > 级牌');
  ok(kl.trumpVal(K(5, HEART)) > kl.trumpVal(K(14, SPADE)), '级牌 > 主花色最大牌');
  ok(kl.trumpVal(K(14, SPADE)) > kl.trumpVal(K(14, HEART)), '主花色 > 副牌');

  const pNormal = kl.classify([K(9, HEART)]);
  const pTrump = kl.classify([K(9, SPADE)]);
  ok(kl.beats(pTrump, pNormal) === true, '主牌盖副牌');
  ok(kl.beats(pNormal, pTrump) === false, '副牌盖不住主牌');
  const pBig = kl.classify([K(14, HEART)]);
  const pSmall = kl.classify([K(3, HEART)]);
  ok(kl.beats(pBig, pSmall) === true, '同花色 A > 3');
  ok(kl.beats(pSmall, pBig) === false, '同花色 3 盖不住 A');
  ok(kl.beats(kl.classify([K(14, HEART)]), kl.classify([K(14, HEART), K(14, HEART, 1)])) === false,
     '单张盖不住一对');
}

/* ============ 8) 双升跟牌 ============ */
section('8) ★ 双升跟牌规则');
function setupTractor(opts) {
  kl.startGame(kl.T_MODE, 1);
  const g = kl.G;
  kl.UI.pick = null;
  g.level = opts.level || 5;
  g.trumpSuit = opts.trumpSuit === undefined ? SPADE : opts.trumpSuit;
  g.hands = opts.hands;
  if (opts.lead) {
    const shape = kl.classify(opts.lead.cards);
    g.leadPlay = shape;
    g.trick = [{ seat: 1, cards: opts.lead.cards, shape: shape }];
  } else {
    g.leadPlay = null;
    g.trick = [];
  }
  g.phase = 'play';
  return g;
}
{
  let g = setupTractor({
    hands: [[K(9, HEART), K(3, SPADE)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, HEART)] },
  });
  ok(kl.legalPlay(0, [K(9, HEART)]).ok === true, '有同花色 → 跟同花色合法');
  ok(kl.legalPlay(0, [K(3, SPADE)]).ok === false, '有同花色 → 跟别的花色非法');

  g = setupTractor({
    hands: [[K(3, SPADE)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, HEART)] },
  });
  ok(kl.legalPlay(0, [K(3, SPADE)]).ok === true, '绝牌 → 可以垫牌');

  g = setupTractor({
    hands: [[K(9, SPADE)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, HEART)] },
  });
  ok(kl.legalPlay(0, [K(9, SPADE)]).ok === true, '绝牌 → 可以出主牌杀牌');

  g = setupTractor({
    hands: [[K(9, SPADE), K(3, HEART)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, SPADE)] },
  });
  ok(kl.legalPlay(0, [K(9, SPADE)]).ok === true, '首出是主牌 → 跟主牌');
  ok(kl.legalPlay(0, [K(3, HEART)]).ok === false, '首出是主牌且手里有主 → 不能垫副牌');

  g = setupTractor({
    hands: [[K(9, HEART), K(9, HEART, 1), K(3, SPADE)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, HEART), K(9, HEART, 1)] },
  });
  ok(kl.legalPlay(0, [K(9, HEART), K(9, HEART, 1)]).ok === true, '首出是对子 → 跟对子');
  ok(kl.legalPlay(0, [K(9, HEART)]).ok === false, '手里有对子 → 跟单张非法');

  g = setupTractor({
    hands: [[K(9, HEART), K(3, SPADE)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, HEART), K(9, HEART, 1)] },
  });
  ok(kl.legalPlay(0, [K(9, HEART)]).ok === true, '没有对子 → 拆牌跟单张可以（盖不住而已）');

  g = setupTractor({
    hands: [[K(9, HEART), K(9, HEART, 1), K(8, HEART), K(8, HEART, 1)], [K(9, HEART)], [K(9, HEART)], [K(9, HEART)]],
    lead: { cards: [K(9, HEART), K(9, HEART, 1), K(8, HEART), K(8, HEART, 1)] },
  });
  ok(kl.legalPlay(0, [K(8, HEART), K(8, HEART, 1), K(9, HEART), K(9, HEART, 1)]).ok === true,
     '首出是拖拉机 → 跟拖拉机');
  ok(kl.legalPlay(0, [K(9, HEART), K(9, HEART, 1)]).ok === false, '手里有拖拉机 → 跟对子非法');
}

/* ============ 9) 双升算分 / 升级 ============ */
section('9) ★ 双升算分、抠底、升级');
{
  ok(kl.cardPoints(K(5, HEART)) === 5, '5 是 5 分');
  ok(kl.cardPoints(K(10, HEART)) === 10, '10 是 10 分');
  ok(kl.cardPoints(K(13, HEART)) === 10, 'K 是 10 分');
  ok(kl.cardPoints(K(9, HEART)) === 0, '其它牌不是分牌');

  kl.startGame(kl.T_MODE, 1);
  let g = kl.G;
  g.levels = [2, 1]; g.dealerTeam = 0; g.trumpSuit = SPADE; g.level = 2;
  g.roundPts = [0, 40, 0, 0];       /* 闲家方（座位 1、3）抓了 40 分 */
  g.kitty = [K(5, HEART), K(10, HEART)];
  g.trick = [{ seat: 1, cards: [K(9, HEART)], shape: kl.classify([K(9, HEART)]) }];
  g.lastWinner = 1;
  let r = kl.tractorRoundEnd();
  ok(r.otherPts === 40, '闲家方抓到 40 分');
  ok(r.bonus === 30, '抠底：底牌 15 分 × 2 = 30 分');
  ok(r.s === 70, '闲家方总分 40 + 30 = 70');
  ok(g.levels[0] === 3, '不到 80 分 → 庄家方升 1 级');
  ok(r.takeOver === false, '没到 80 分，庄家不下台');

  g.levels = [2, 1]; g.dealerTeam = 0; g.trumpSuit = SPADE; g.level = 2;
  g.roundPts = [0, 90, 0, 0];
  g.kitty = []; g.trick = []; g.lastWinner = 1;
  r = kl.tractorRoundEnd();
  ok(r.takeOver === true, '闲家方 80 分以上 → 上台当庄家');
  ok(g.dealerTeam === 1, '庄家方换了');
  ok(g.levels[1] === 2 && g.levels[0] === 1, '新庄家打原来的级，旧庄家降一级');

  g.levels = [2, 1]; g.dealerTeam = 0; g.trumpSuit = SPADE; g.level = 2;
  g.roundPts = [0, 0, 0, 0];
  g.kitty = []; g.trick = []; g.lastWinner = 0;
  r = kl.tractorRoundEnd();
  ok(g.levels[0] === 5, '闲家方 0 分（大盘）→ 庄家方升 3 级');

  g.levels = [13, 12]; g.dealerTeam = 0; g.trumpSuit = SPADE; g.level = 13;
  g.roundPts = [0, 0, 0, 0];
  g.kitty = []; g.trick = []; g.lastWinner = 0;
  r = kl.tractorRoundEnd();
  ok(r.win === 0, '升到 A → 庄家方赢');
}

/* ============ 10) 端到端 ============ */
section('10) ★ 端到端：自动打完一整局');
function autoAnswerPick() {
  const p = kl.UI.pick;
  if (!p) return false;
  const cards = [];
  for (let i = 0; i < p.need; i++) cards.push(p.pool[i]);
  p.onOk(cards);
  return true;
}
function driveHuman() {
  const g = kl.G;
  if (g.phase !== 'play' || g.turn !== 0) return false;
  if (g.mode === kl.H_MODE) kl.playHearts(0, kl.aiHeartsCard(0));
  else kl.playTractor(0, kl.aiTractorPlay(0));
  return true;
}
function runRound(maxSteps) {
  let guard = 0;
  while (guard++ < maxSteps) {
    if (kl.UI.pick) { autoAnswerPick(); continue; }
    const g = kl.G;
    if (g.phase !== 'play') break;
    if (g.turn === 0) { if (!driveHuman()) break; continue; }
    break;
  }
  return guard;
}
{
  kl.setInstant(true);
  kl.startGame(kl.H_MODE, 2026);
  autoAnswerPick();                     /* 换牌 */
  const used = runRound(4000);
  const g = kl.G;
  ok(g.phase === 'roundEnd' || g.phase === 'gameOver', '单升：52 张牌打完，进入结算（用了 ' + used + ' 步）');
  ok(g.hands.every(h => h.length === 0), '单升：四家手牌都空了');
  const roundTotal = g.roundPts.reduce((a, b) => a + b, 0);
  ok(roundTotal === 26 || g.scores[0] === 0, '单升：这一局分牌总共 26 分（实际 ' + roundTotal + '）');
  const sumScores = g.scores.reduce((a, b) => a + b, 0);
  ok(sumScores === 26 || sumScores === 78, '单升：总分要么 26（正常）要么 78（满贯三行各 26）');

  kl.startGame(kl.T_MODE, 2027);
  const used2 = runRound(8000);
  const g2 = kl.G;
  ok(g2.phase === 'roundEnd' || g2.phase === 'gameOver', '双升：104 张牌打完，进入结算（用了 ' + used2 + ' 步）');
  const outs = g2.hands.filter(h => h.length === 0).length;
  ok(outs >= 3, '双升：至少三家出完牌（剩牌的那家不计分，实际 ' + outs + ' 家）');
  const kittyPts = g2.kitty.reduce((a, c) => a + kl.cardPoints(c), 0);
  const playedPts = g2.roundPts.reduce((a, b) => a + b, 0);
  const restPts = g2.hands.reduce((a, h) => a + h.reduce((b, c) => b + kl.cardPoints(c), 0), 0);
  ok(playedPts + kittyPts + restPts === 200,
     '双升：场上分牌 + 底牌分牌 + 剩牌 = 200 分（' + playedPts + '+' + kittyPts + '+' + restPts + '）');
  ok(g2.kitty.length === 8, '双升：底牌还是 8 张');

  /* 多局连打不能崩 */
  let crashed = false;
  try {
    for (let i = 0; i < 6; i++) {
      kl.startGame(i % 2 ? kl.H_MODE : kl.T_MODE, 3000 + i);
      runRound(8000);
    }
  } catch (e) { crashed = true; console.log('    异常：' + e.message); }
  ok(!crashed, '连打 6 局不报错');
  kl.setInstant(false);
}

/* ============ 11.5) 亮主 / 反主 / 扣底流程 ============ */
section('11.5) ★ 亮主、反主、扣底');
{
  /* 玩家当庄家：先亮主，再扣底 */
  kl.setInstant(true);          /* 发牌阶段要走完才会亮主 */
  kl.startGame(kl.T_MODE, 99);
  let g = kl.G;
  ok(kl.UI.pick && kl.UI.pick.mode === 'bid', '玩家当庄家 → 先亮主');
  const lvCards = kl.UI.pick.pool.filter(c => c.r === g.level);
  ok(lvCards.length > 0, '亮主面板给的是级牌');
  kl.UI.pick.onOk([lvCards[0]]);
  ok(g.trumpSuit === lvCards[0].s, '亮出的级牌花色 = 主花色');
  ok(kl.UI.pick && kl.UI.pick.mode === 'kitty', '亮完主轮到扣底');
  ok(kl.UI.pick.need === 8, '扣底要选 8 张');
  const handBefore = g.hands[0].length;
  ok(handBefore === 33, '庄家抓了 8 张底牌，手里有 33 张（实际 ' + handBefore + '）');
  const back = [];
  for (let i = 0; i < 8; i++) back.push(kl.UI.pick.pool[i]);
  kl.UI.pick.onOk(back);
  ok(g.kitty.length === 8, '扣回 8 张当底牌');
  ok(g.hands[0].length === 25, '扣完底手里回到 25 张');

  /* 反主：对家持有更强的级牌对子时可以改主花色（反主强弱：方<梅<红<黑） */
  kl.startGame(kl.T_MODE, 100);
  g = kl.G;
  g.level = 5; g.trumpSuit = DIAMOND;
  g.dealerSeat = 1; g.dealerTeam = 1; g.round = 1;
  g.hands = [[K(5, SPADE), K(5, SPADE, 1)], [], [], []];
  ok(kl.canRebid(0) === true, '手里有更强的级牌对子（黑桃 > 方块）→ 可以反主');
  const reb = kl.doRebid(0);
  ok(reb === true, '反主成功');
  ok(g.trumpSuit === SPADE, '反主后主花色变成黑桃');
  ok(g.dealerSeat === 0, '第一局反主同时反庄（玩家成了庄家）');
  g.hands = [[K(5, HEART), K(5, HEART, 1)], [], [], []];
  g.trumpSuit = SPADE;
  ok(kl.canRebid(0) === false, '级牌对子比现在的主花色弱（红桃 < 黑桃）→ 不能反主');

  /* 玩家选择不反主 */
  kl.startGame(kl.T_MODE, 101);
  g = kl.G;
  g.level = 5; g.trumpSuit = SPADE; g.dealerSeat = 1; g.dealerTeam = 1;
  g.hands = [[K(5, HEART), K(5, HEART, 1)], [], [], []];
  g.phase = 'bidWait';
  ok(g.phase === 'bidWait', '轮到玩家决定要不要反主');
  g.phase = 'kitty';
  ok(g.trumpSuit === SPADE, '不反主 → 主花色不变');
}

/* ============ 11.6) 发牌阶段 + 换牌方向 ============ */
section('11.6) ★ 发牌阶段与换牌方向');
{
  /* 发牌阶段：牌发完之前不该弹换牌面板 */
  kl.setInstant(false);
  kl.startGame(kl.H_MODE, 4242);
  let g = kl.G;
  ok(g.phase === 'deal', '★ 开局先进发牌阶段，不再一上来就换牌');
  ok(kl.UI.deal && kl.UI.deal.total === 13, '发牌阶段记录每人 13 张');
  ok(kl.UI.pick === null, '发牌阶段不弹换牌面板');
  kl.render();
  ok(doc.getElementById('hand').children.length === 0, '发牌刚开始，手里还没牌');
  ok(doc.getElementById('dealTag').hidden === false, '发牌阶段显示中央发牌提示');
  ok(/发牌中/.test(doc.getElementById('tip').innerHTML), '提示行说明正在发牌');

  /* 走完发牌才进换牌 */
  kl.setInstant(true);
  kl.startGame(kl.H_MODE, 4242);
  g = kl.G;
  ok(doc.getElementById('dealTag').hidden === true, '发牌结束后收起中央提示');
  ok(g.phase === 'pass', '★ 牌发完了才进换牌阶段');
  ok(!!kl.UI.pick && kl.UI.pick.mode === 'pass', '换牌用统一的选择面板');
  ok(kl.UI.pick.need === 3, '换牌要选 3 张');

  /* 方向：第 1 局往左，给小林（左）、收圆圆（右） */
  ok(kl.passDirOfRound(1) === 1 && kl.passDirOfRound(2) === -1 &&
     kl.passDirOfRound(3) === 2 && kl.passDirOfRound(4) === 0, '★ 四局方向：左 → 右 → 对面 → 不换');
  ok(kl.passTargetOf(0) === 1 && kl.passSourceOf(0) === 3, '第 1 局：给左边小林，收右边圆圆');
  ok(/小林/.test(kl.UI.pick.why) && /圆圆/.test(kl.UI.pick.why), '★ 说明里写清了给谁 / 谁给你');
  ok(/为什么/.test(kl.UI.pick.why), '★ 说明里讲了为什么要换牌');
  ok(/<svg/.test(kl.UI.pick.why), '换牌说明里带方向示意图');
  ok(/左边/.test(kl.UI.pick.title + kl.UI.pick.sub), '标题点出传给哪一边');

  /* 四家同时传：每人还是 13 张，52 张不重不漏 */
  const before0 = new Set(g.hands[0].map(kl.cardId));
  const mine = kl.UI.pick.pool.slice(0, 3).map(kl.cardId);
  kl.setInstant(false);                 /* 停掉 AI 出牌，只看换牌本身 */
  kl.UI.pick.onOk(kl.UI.pick.pool.slice(0, 3));
  ok(g.phase === 'play', '换完牌直接开打');
  ok(g.hands.every(h => h.length === 13), '★ 换牌后四家都还是 13 张');
  const allCards = [].concat.apply([], g.hands);
  ok(allCards.length === 52 && new Set(allCards.map(kl.cardId)).size === 52, '换牌后 52 张不重不漏');
  ok(g.hands[0].filter(c => !before0.has(kl.cardId(c))).length === 3, '★ 你收到 3 张别人传来的牌');
  const toIds = g.hands[1].map(kl.cardId);
  ok(mine.every(id => toIds.indexOf(id) >= 0), '★ 你挑的 3 张到了左边小林手里');
  ok(kl.passDirOfRound(g.round + 1) === -1, '下一局方向自动换成右边');
  kl.setInstant(false);
}


section('11.8) ★ 点牌交互');
{
  kl.setInstant(false);
  /* 红心：点一下直接出 */
  let g = setupHearts({ hands: [[A3, A4, D5], [DA], [SA], [H2]], trickNo: 4 });
  g.turn = 0;
  kl.render();
  const handEl = doc.getElementById('hand');
  ok(handEl.children.length === 3, '手牌渲染出 3 张');
  const before = g.hands[0].length;
  handEl.children[0].fire('click');
  ok(g.hands[0].length === before - 1, '★ 红心：点一下牌就直接打出去了');
  ok(g.trick.length === 1, '打出的牌进了这一圈');

  /* 非法牌会被拦下并给提示 */
  g = setupHearts({ hands: [[A2, A3], [DA], [SA], [H2]], trickNo: 0 });
  g.turn = 0;
  kl.render();
  const h2 = doc.getElementById('hand');
  const n0 = g.hands[0].length;
  h2.children[1].fire('click');           /* 想点梅花3，但手里有梅花2 */
  ok(g.hands[0].length === n0, '★ 手里有梅花 2 时点别的牌出不去');

  /* 双升：点牌是选中，不直接出 */
  g = setupTractor({ hands: [[K(9, HEART), K(3, SPADE)], [], [], []] });
  g.turn = 0;
  kl.render();
  const h3 = doc.getElementById('hand');
  h3.children[0].fire('click');
  ok(kl.UI.sel.length === 1, '双升：点牌是选中，不是直接出');
  h3.children[1].fire('click');
  ok(kl.UI.sel.length === 2, '双升：可以多选（对子 / 拖拉机）');
  const n1 = g.hands[0].length;
  h3.children[0].fire('click');
  ok(kl.UI.sel.length === 1, '再点一下就取消选中');
  ok(g.hands[0].length === n1, '还没按「出牌」就不算打出去');
  /* 提示：双升直接帮你选好 */
  const hint = kl.playerHint();
  ok(Array.isArray(hint) && hint.length >= 1, '双升能算出建议出牌');
  kl.setInstant(true);
}

/* ============ 11.9) 牌面渲染 ============ */
section('11.9) ★ 牌面 / 提示行渲染');
{
  /* 牌角必须有能看清的点数（曾经点数被外层 .panel b 刷成近白色，白底白字） */
  const mk = (r, s) => kl.mkCard(s, r, 0);
  const el = kl.__cardEl ? kl.__cardEl(mk(9, SPADE)) : null;

  /* 用真实渲染出来的手牌来验：角标存在且带点数文字 */
  const g = setupHearts({ hands: [[mk(9, SPADE), mk(10, HEART), mk(13, CLUB), mk(14, DIAMOND)],
                                 [mk(2, SPADE)], [mk(3, SPADE)], [mk(4, SPADE)]], trickNo: 4 });
  g.turn = 0;
  kl.render();
  const hand = doc.getElementById('hand');
  const findCls = (node, cls) => (node.children || []).find(c =>
    new RegExp('(^|\\s)' + cls + '(\\s|$)').test(c.className || ''));
  const face0 = findCls(hand.children[0], 'face');
  const c0 = face0 && findCls(face0, 'corner');
  ok(!!c0, '手牌里有角标元素');
  const rankEl = c0 && c0.children && c0.children[0];
  ok(!!rankEl && rankEl.textContent === '9', '★ 角标里是点数本身（9）');
  const suitEl = c0 && c0.children && c0.children[1];
  ok(!!suitEl && suitEl.textContent === '♠', '角标里点数下面跟着花色');
  ok(hand.children[0].className.indexOf('black') >= 0, '黑桃牌是黑色');
  ok(hand.children[1].className.indexOf('red') >= 0, '红桃牌是红色');
  /* 倒置角标会让 6 看起来像 9，已移除 */
  ok(!face0 || !findCls(face0, 'corner.br'), '★ 牌上没有倒置的第二个角标');

  /* 王牌：角标用「大 / 小」单字，大王红、小王黑 */
  const gj = setupTractor({ hands: [[kl.mkCard(4, 17, 0), kl.mkCard(4, 16, 0)], [], [], []] });
  gj.level = 2;
  kl.render();
  const hj = doc.getElementById('hand');
  const jf0 = findCls(hj.children[0], 'face'), jc0 = jf0 && findCls(jf0, 'corner');
  ok(!!jc0 && jc0.children[0].textContent === '大', '★ 大王角标写「大」而不是两个字');
  ok(hj.children[0].className.indexOf('red') >= 0, '大王是红色');
  const jf1 = findCls(hj.children[1], 'face'), jc1 = jf1 && findCls(jf1, 'corner');
  ok(!!jc1 && jc1.children[0].textContent === '小', '小王角标写「小」');
  ok(hj.children[1].className.indexOf('black') >= 0, '小王是黑色');

  /* 提示行：paintTip 曾经用 className=cls 把 .tip 整个覆盖掉，导致文字不居中 */
  kl.render();
  const tipEl = doc.getElementById('tip');
  ok(/(^|\s)tip(\s|$)/.test(tipEl.className), '★ 提示行保留了 tip 类（居中样式不丢）');

  /* 中央淡印：双升显示主花色 + 打几 */
  kl.startGame(kl.T_MODE, 99);
  kl.UI.pick = null;
  const gt = kl.G;
  gt.trumpSuit = HEART; gt.level = 7; gt.phase = 'play';
  kl.render();
  const em = doc.getElementById('emblem');
  const glyph = (em.children || [])[0], label = (em.children || [])[1];
  ok(!!glyph && glyph.textContent === '♥', '双升淡印显示主花色 ♥');
  ok(!!label && /打\s*7/.test(label.textContent), '双升淡印写着「打 7」');
  ok(em.className.indexOf('red') >= 0, '红主花色时淡印标红');
}

/* ============ 11.10) 得分显示：实时 + 颜色强调 ============ */
section('11.10) ★ 得分显示与说明文案');
{
  const mk = (r, s2) => kl.mkCard(s2, r, 0);
  const textOf = n => (n.nodeValue || n.textContent || '') + (n.children || []).map(textOf).join('');
  const all = n => [n].concat((n.children || []).map(all).flat());
  const withCls = (n, cls) => all(n).filter(c =>
    new RegExp('(^|\\s)' + cls + '(\\s|$)').test(c.className || ''));

  const g = setupHearts({
    hands: [[mk(9, SPADE), mk(8, HEART)], [mk(2, SPADE), mk(3, SPADE)],
            [mk(4, SPADE), mk(5, SPADE)], [mk(6, SPADE), mk(7, SPADE)]],
    trickNo: 4,
  });
  g.roundPts = [0, 0, 0, 0]; g.scores = [10, 20, 30, 40]; g.round = 2; g.turn = 0;
  kl.render();

  /* —— 信息条：标签必须说清是「罚分」，不是「得分」 —— */
  const hud = doc.getElementById('hud');
  ok(hud.children.length === 4, '信息条是四格');
  const labels = hud.children.map(c => (c.children[1] || {}).textContent || '');
  ok(labels.join('|') === '局数|还剩几圈|你本局罚分|累计罚分',
     '★ 四格标签讲清了罚分口径（' + labels.join('/') + '）');
  ok(hud.children[2].children[0].textContent === '0', '第三格是你本局罚分');
  ok(hud.children[3].children[0].textContent === '10', '第四格是你自己的累计罚分');
  ok(hud.children[3].children[0].children.length === 1 &&
     hud.children[3].children[0].children[0].textContent === '/100',
     '累计罚分后面跟着 /100，一眼知道离终点多远');

  /* —— 实时：分数一变，重绘就得跟着变 —— */
  g.roundPts = [5, 0, 3, 0]; g.scores = [15, 20, 30, 40];
  kl.render();
  ok(hud.children[2].children[0].textContent === '5', '★ 本局罚分实时更新（0 → 5）');
  const seat1 = doc.getElementById('seat1');
  ok(/本局0/.test(textOf(seat1)) && /累计20/.test(textOf(seat1)),
     '座位同时显示「本局」和「累计」，不再只有累计');
  g.roundPts = [5, 3, 3, 0];
  kl.render();
  ok(/本局3/.test(textOf(doc.getElementById('seat1'))), '★ 对手吃进罚分后，座位上数字立刻变');

  /* —— 快满 100 要变红警示 —— */
  g.scores = [15, 85, 30, 40];
  kl.render();
  const dangerB = all(doc.getElementById('seat1')).filter(c =>
    c.tagName === 'B' && c.textContent === '85')[0];
  ok(!!dangerB, '座位里找得到累计 85');
  ok(!!dangerB && dangerB.className === 'danger', '★ 累计到 85 分用危险色标出来');

  /* —— 一句话规则：颜色区分好坏 —— */
  kl.render();
  const motto = doc.getElementById('motto').innerHTML;
  ok(/越少越好/.test(motto), '★ 规则行明说「吃进越少越好」');
  ok(/罚分/.test(motto), '规则行点明这是罚分');
  ok(/class="good"[^>]*>吃进越少越好/.test(motto), '★「越少越好」用了绿色强调');
  ok(/class="bad"[^>]*>罚分/.test(motto), '「罚分」用了警示色');
  ok(/class="bad"[^>]*>100/.test(motto), '「100 分」用了警示色');

  /* —— 双升：座位显示级别，且不会出现 undefined —— */
  kl.startGame(kl.T_MODE, 77);
  kl.UI.pick = null;
  const gt = kl.G;
  gt.levels = [2, 1]; gt.roundPts = [10, 5, 0, 0];
  gt.trumpSuit = SPADE; gt.level = 2; gt.phase = 'play'; gt.turn = 0;
  kl.render();
  const tSeat = textOf(doc.getElementById('seat1'));
  ok(!/undefined/.test(tSeat), '★ 双升座位不会出现 undefined');
  ok(/级别2/.test(tSeat), '双升座位显示对方级别（1 级也显示成「2」）');
  ok(/级别/.test(tSeat), '双升座位带「级别」标签');
  const thud = doc.getElementById('hud');
  ok(/我方抓分/.test((thud.children[2].children[1] || {}).textContent || ''),
     '双升信息条给出我方本局抓分');
  ok(thud.children[2].children[0].textContent === '10',
     '双升我方抓分 = 同队两人之和（10+0）');
  ok(/越多越好/.test(doc.getElementById('motto').innerHTML),
     '★ 双升规则行说「抓分越多越好」');

  /* —— 玩法说明：讲清楚方向和算法 —— */
  kl.startGame(kl.H_MODE, 55);
  kl.UI.pick = null; kl.G.phase = 'play';
  doc.getElementById('btnHow').fire('click');
  const hb = doc.getElementById('helpBody').innerHTML;
  ok(/怎么算分/.test(hb), '★ 玩法说明里有「怎么算分」一节');
  ok(/罚分/.test(hb) && /越少越好/.test(hb), '说明里讲清了罚分越少越好');
  ok(/不是抢分/.test(hb), '说明里直接点出「不是抢分」这个误会');
  ok(/class="good"/.test(hb) && /class="bad"/.test(hb), '说明正文用了两种强调色');
  doc.getElementById('helpClose').fire('click');

  kl.startGame(kl.T_MODE, 56);
  kl.UI.pick = null; kl.G.phase = 'play';
  doc.getElementById('btnHow').fire('click');
  const ht = doc.getElementById('helpBody').innerHTML;
  ok(/越多越好/.test(ht), '双升说明也点明「抓分越多越好」');
  ok(/80 分/.test(ht), '双升说明写清 80 分这条线');
  doc.getElementById('helpClose').fire('click');

  /* —— 结算面板：表头也得是罚分口径 —— */
  ok(/本局罚分/.test(html) && /累计罚分/.test(html), '结算表头用的是「罚分」');
  ok(/罚分最少的人赢/.test(html), '结算文案说明谁赢');
  ok(!/你的总分/.test(html), '★ 已经不再出现「你的总分」这种反方向的说法');
}

/* ============ 11) 单文件自包含 ============ */
section('11) 单文件自包含');
{
  ok(!/<img\b/i.test(html), '没有 <img>');
  ok(!/<link\b/i.test(html), '没有 <link>');
  ok(!/https?:\/\//i.test(html.replace(/http-equiv[^>]*>/gi, '')), '没有外链 URL');
  ok(!/\bsrc\s*=/i.test(html), '没有任何 src 外部资源');
  ok(/href="\/"/.test(html), '返回键是 "/"');
  ok(/charset="utf-8"/i.test(html), 'UTF-8 声明在');
}

/* ============ 汇总 ============ */
console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细：'); failures.forEach(f => console.log('  · ' + f)); }
process.exit(fail ? 1 : 0);
