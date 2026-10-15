#!/usr/bin/env node
/**
 * 弹珠台 经济性实验台
 *
 * 回答两个问题：
 *   1) **投注额会不会被玩家无限放大？** 落进亮灯口是「返还 投注×倍数」，
 *      倍数 ≥ 2，所以理论上「投得越多赚得越多」—— 必须有约束，
 *      否则玩家一局就把代币刷爆、游戏失去意义。
 *   2) **200 枚代币能撑多久？** 太短（3 局就没）没意思，太长（永远玩不完）没紧张感。
 *
 * 玩家模型（三档技术，靠「瞄准亮灯口」的命中率区分）：
 *   · 新手  aim=0.30 —— 大概知道往哪打，但力度控制不稳
 *   · 熟手  aim=0.65 —— 多数时候能打到想打的出口
 *   · 高手  aim=0.90 —— 指哪打哪
 * 另外扫「每局投多少」：最小 5、一路加到 50，看会不会滚雪球。
 *
 * 用法：
 *   node tools/bench_pinball.js --econ
 *   node tools/bench_pinball.js --econ --rounds 300
 */
const H = require('./pinball_harness.js');

const argv = process.argv.slice(2);
const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? parseFloat(argv[i + 1]) : d; };
const ROUNDS = num('--rounds', 200);

/* ---------------- 一个「会瞄准的玩家」打一发 ----------------
   给定本局亮灯的出口集合，玩家按 aim 概率「打中想打的那个」，
   没打中就在「其它出口」里均匀落一个（模拟力度失误）。
   为了不依赖真实物理跑几千局（太慢），这里直接调 __pinballLand 指定落点 —— 
   落点分布已经由 bench_pinball 的物理实验单独验证过（覆盖 12/12、可控）。 */
function playRound(win, M, { aim, bet, pick }) {
  win.__pinballForceMult(0);            // 0 = 不强制，用游戏自己抽
  win.__pinballInsert(bet);
  if (!win.__pinballStart()) return null;
  win.__pinballSkipAnim();
  const s = M();
  const lit = s.lamps.map((v, i) => v ? i : -1).filter(i => i >= 0);
  if (!lit.length) return null;
  /* ★ 必须先真的发一颗球：__pinballLand 是把「正在飞的球」按到指定出口，
     没有球就没得结算（游戏里也不存在「没发射就落槽」）。 */
  if (!win.__pinballLaunch(0.5)) return null;
  let target;
  if (Math.random() < aim) target = pick(lit, s);
  else {
    const others = [];
    for (let i = 0; i < s.N_SLOT; i++) if (!s.lamps[i]) others.push(i);
    target = others.length ? others[Math.floor(Math.random() * others.length)]
                           : lit[Math.floor(Math.random() * lit.length)];
  }
  win.__pinballLand(target);
  const after = M();
  /* 结算展示走完 → 收局 */
  let guard = 0;
  while (M().phase === 'fly' && guard++ < 400) win.__pinballStep(1 / 60);
  return { lit: lit.length, mult: after.mult, won: after.landWin, gain: after.landGain,
           bet, coins: M().coins, target };
}

function simulate({ aim = 0.65, bet = 5, pick = (lit) => lit[0], rounds = ROUNDS, seedBase = 1 } = {}) {
  const h = H.load();
  const win = h.win, M = h.M;
  win.__pinballReset(seedBase);
  let minCoins = win.__pinball().coins, bust = -1, played = 0;
  let totalBet = 0, totalWon = 0, hits = 0;
  for (let r = 0; r < rounds; r++) {
    const s = M();
    if (s.phase === 'over' || s.coins < s.MIN_BET) { bust = played; break; }
    const stake = Math.min(bet, s.coins);
    const res = playRound(win, M, { aim, bet: stake, pick });
    played++;
    if (!res) break;
    totalBet += stake; totalWon += res.gain;
    if (res.won) hits++;
    minCoins = Math.min(minCoins, M().coins);
  }
  return { played, bust, coins: M().coins, totalBet, totalWon, hits,
           hitRate: played ? hits / played : 0, minCoins };
}

/* ---------------- 主流程 ---------------- */
console.log('=== 弹珠台 经济性实验台 ===');
console.log(`（每档 ${ROUNDS} 局上限，初始 200 枚，最少投 5 枚）\n`);

const PICKS = {
  '打最亮的口(按倍数挑最值)': (lit, s) => {
    /* 亮灯口都一样给 bet×mult，所以随便挑一个亮的即可 */
    return lit[0];
  },
};

console.log('技术档 × 每局投注 —— 结果：玩了几局 / 是否破产 / 期末代币 / 中奖率');
console.log('─'.repeat(88));
const header = '技术'.padEnd(8) + ['投5','投10','投20','投50'].map(x => x.padStart(19)).join('');
console.log(header);
for (const [name, aim] of [['新手', 0.30], ['熟手', 0.65], ['高手', 0.90]]) {
  let row = name.padEnd(8);
  for (const bet of [5, 10, 20, 50]) {
    const r = simulate({ aim, bet, pick: PICKS['打最亮的口(按倍数挑最值)'], rounds: ROUNDS, seedBase: 12345 });
    const tag = r.bust >= 0 ? `破产@${r.bust}` : `撑满${r.played}`;
    row += `${tag} ${String(r.coins).padStart(6)}枚 ${(r.hitRate * 100).toFixed(0)}%`.padStart(19);
  }
  console.log(row);
}

console.log('\n（「破产@N」= 第 N 局后代币不足 5 枚；「撑满N」= 打完 N 局还有钱）');
console.log('  ⚠️ 如果「投50」也能撑满且期末代币暴涨 → 说明投注上限失控，需要加约束');

/* 单局期望收益（理论值，用来解释上面的现象） */
console.log('\n=== 单局期望（理论） ===');
const h = H.load();
const s0 = h.M();
const { MULTS, MULT_W, LAMP_N, N_SLOT } = s0;
let ev = 0, detail = [];
for (let i = 0; i < MULTS.length; i++) {
  const m = MULTS[i], w = MULT_W[i], k = LAMP_N[m];
  const p = k / N_SLOT;                       // 瞎打时的命中率
  const ret = w * (p * m + (1 - p) * 0);      // 期望返还倍数
  ev += ret;
  detail.push(`${m}x(w=${w},亮${k}) 命中率${(p*100).toFixed(0)}% → 期望返还 ${ret.toFixed(3)}`);
}
for (const d of detail) console.log('  ' + d);
console.log(`\n  综合：每投 1 枚期望返还 ${ev.toFixed(3)} 枚（瞎打）`);
console.log(`  ${ev < 1 ? '✅ 期望 < 1：瞎打会慢慢亏，符合街机设计' : '❌ 期望 ≥ 1：瞎打也不亏，游戏没难度'}`);
console.log('  ★ 会瞄准的玩家命中率高于 k/12，所以「技术」能把这个数拉到 1 以上 —— 这正是技巧的价值。');
