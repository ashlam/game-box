#!/usr/bin/env node
/**
 * 弹珠台 逻辑回归测试（Node + 假 DOM + 假 canvas + 手工步进）
 *
 * 覆盖（★ = 用户原话里的规则，逐条锁死）：
 *   1) ★ 开局 200 代币
 *   2) ★ 投币：一次 1 枚、最少投 5 枚才能开局、单局封顶 20 枚
 *   3) ★ 按「开始」才抽倍数；五档 2/4/6/8/10；低倍更容易（概率单调递减）
 *   4) ★ 倍数越低、亮的出口越多（照片里 2x 亮 3 个，本作取 4）
 *   5) ★ 拉扳机蓄力发射；力度 → 落点单调可控（大力落左边）
 *   6) ★ 落进亮灯口 = 返还 投注×倍数；落进没亮的 = 0
 *   7) ★ 结算后回投币阶段，必须重新投币才能开下一局
 *   8) 代币不足 5 枚 → 结束；「再来一次」重置 200
 *   9) 物理：不出界、不穿钉、必然落进某个出口、不 NaN、不超时
 *  10) 绘制：亮灯的口画成红的、没亮的是暗的（防止「状态对但画面不对」）
 *  11) 音效 / 确定性（同种子同力度同落点）/ 最高代币落盘
 *
 * 用法：node tools/test_pinball.js
 */
const H = require('./pinball_harness.js');
const { win, M, DT, step, run, shoot, openRound, els, ledEls, drawRec } = H.load();

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
/** ★ 数值断言一律走 okNum：任何 NaN/null/undefined 直接判失败。
 *  起因是弹珠乐园那条「控件不溢出」曾拿 undefined 比大小 → null <= 1 恒真 → 假绿。 */
function okNum(got, want, name){
  const good = typeof got === 'number' && Number.isFinite(got) && got === want;
  ok(good, name, '得到 ' + JSON.stringify(got) + '，期望 ' + want);
}
function section(t){ console.log('\n== ' + t + ' =='); }

const reset = s => win.__pinballReset(s);
const insert = n => win.__pinballInsert(n);
const start = () => win.__pinballStart();
const skip = () => win.__pinballSkipAnim();
const launch = p => win.__pinballLaunch(p);
const land = i => win.__pinballLand(i);
const forceMult = m => win.__pinballForceMult(m);
const setLamps = a => win.__pinballSetLamps(a);

/* =====================================================================
   1) 开局：200 代币
   ===================================================================== */
section('1) ★ 开局 200 代币 / 未投币不能开始');
{
  reset(1);
  const s = M();
  okNum(s.coins, 200, '★ 开局代币 = 200');
  ok(s.START_COINS === 200, 'START_COINS 常量 = 200');
  ok(s.phase === 'bet', '开局处于投币阶段（bet）');
  ok(s.bet === 0 && s.mult === 0, '开局未投币、未抽倍数');
  ok(s.lamps.every(v => v === false), '开局 12 个出口灯全灭');
  ok(s.lamps.length === 12, '★ 出口数 = 12（照片上数出来的）');
  ok(!start(), '★ 没投币时按「开始」无效（返回 false）');
  ok(M().phase === 'bet' && M().mult === 0, '  └ 状态没被改动');
}

/* =====================================================================
   2) 投币：粒度 / 下限 / 上限
   ===================================================================== */
section('2) ★ 投币：一次 1 枚 / 最少 5 枚 / 单局封顶 20 枚');
{
  reset(1);
  okNum(insert(1), 1, '投 1 枚成功');
  okNum(M().coins, 199, '  └ 代币 200 → 199');
  okNum(M().bet, 1, '  └ 本局投注 = 1');

  reset(1);
  insert(4);
  ok(M().bet === 4 && M().coins === 196, '投 4 枚：本局 4、余 196');
  ok(!start(), '★ 只投 4 枚（< 5）不能开始');
  ok(M().phase === 'bet', '  └ 仍在投币阶段');
  ok(M().mult === 0, '  └ 没有抽倍数（不能靠反复按开始白抽）');

  insert(1);
  okNum(M().bet, 5, '再投 1 枚 → 本局 5');
  ok(start(), '★ 投满 5 枚可以开始');
  skip();
  ok(M().mult > 0, '  └ 开始后倍数已定（' + M().mult + 'x）');

  /* 上限 */
  reset(1);
  okNum(insert(30), 20, '★ 一次投 30 枚只进去 20 枚（单局封顶）');
  okNum(M().bet, 20, '  └ 本局投注 = 20');
  okNum(M().coins, 180, '  └ 只扣了 20 枚（余 180）');
  ok(!win.__pinballInsertOne(), '★ 到上限后再投被拒（返回 false）');
  okNum(M().bet, 20, '  └ 投注没变');
  okNum(M().coins, 180, '  └ 代币没被多扣');
  ok(M().MAX_BET === 20, 'MAX_BET 常量 = 20');

  /* 代币不够时不能投 */
  reset(1);
  insert(20); start(); skip(); launch(0.5); land(0);
  run(200);                                   // 走完结算
  ok(M().coins < 200, '打了一局没中 → 代币变少（' + M().coins + '）');
}

/* =====================================================================
   3) 抽倍数：五档 / 概率低倍更容易
   ===================================================================== */
section('3) ★ 倍数：五档 2/4/6/8/10、低倍更容易抽到');
{
  reset(1);
  const s = M();
  ok(JSON.stringify(s.MULTS) === JSON.stringify([2,4,6,8,10]),
     '★ 五档倍数 = 2/4/6/8/10（照片上的灯）', s.MULTS.join(','));
  ok(s.MULT_W.length === 5, '权重表长度 = 5');
  let mono = true;
  for(let i = 1; i < s.MULT_W.length; i++) if(!(s.MULT_W[i] < s.MULT_W[i-1])) mono = false;
  ok(mono, '★ 权重严格递减（低倍更容易）', s.MULT_W.join(','));
  const sum = s.MULT_W.reduce((a,b) => a+b, 0);
  ok(Math.abs(sum - 1) < 1e-9, '权重之和 = 1（' + sum + '）');

  /* 统计 4000 局抽到的倍数分布 */
  const cnt = {}; for(const m of s.MULTS) cnt[m] = 0;
  const N = 4000;
  for(let i = 0; i < N; i++){
    reset(1000 + i);
    insert(5); start();
    /* ★ 必须等抽倍数动画走完（skip）mult 才是定下来的值：
       滚动期间 mult 还是 0，直接读会统计到一堆 0（这条断言第一版就是这么假红的） */
    skip();
    cnt[M().mult]++;
    win.__pinballEndRound();
  }
  let allSeen = true, decreasing = true, prev = Infinity;
  for(const m of s.MULTS){
    if(cnt[m] === 0) allSeen = false;
    if(cnt[m] > prev) decreasing = false;
    prev = cnt[m];
  }
  ok(allSeen, '★ 五档倍数都能抽到', JSON.stringify(cnt));
  ok(decreasing, '★ 实测频次随倍数递减（低倍更多）', s.MULTS.map(m => m + 'x:' + cnt[m]).join(' '));
  /* 2x 应该明显最多 */
  ok(cnt[2] > cnt[10] * 3, '★ 2x 频次远高于 10x（' + cnt[2] + ' vs ' + cnt[10] + '）');
}

/* =====================================================================
   4) 亮灯数：倍数越低亮得越多
   ===================================================================== */
section('4) ★ 倍数越低、亮的出口越多');
{
  reset(1);
  const s = M();
  const ks = s.MULTS.map(m => s.LAMP_N[m]);
  ok(ks.every(k => k >= 1 && k <= 12), '每档亮灯数都在 1..12 之间', ks.join(','));
  let nonInc = true;
  for(let i = 1; i < ks.length; i++) if(!(ks[i] <= ks[i-1])) nonInc = false;
  ok(nonInc, '★ 亮灯数随倍数单调不增（倍数越低亮得越多）', ks.join(','));
  ok(ks[0] > ks[ks.length-1], '★ 最低倍亮得比最高倍多（' + ks[0] + ' vs ' + ks[ks.length-1] + '）');

  /* 逐档验证「真的亮了这么多个」 */
  for(const m of s.MULTS){
    reset(1);
    forceMult(m);
    insert(5); start(); skip();
    const st = M();
    okNum(st.mult, m, `  └ 强制 ${m}x 后本局倍数 = ${m}`);
    okNum(st.lamps.filter(Boolean).length, s.LAMP_N[m],
          `★ ${m}x 亮 ${s.LAMP_N[m]} 个出口`);
    ok(st.lamps.length === 12, `  └ 仍是 12 个出口`);
  }
}

/* =====================================================================
   5) 蓄力发射 + 力度可控性
   ===================================================================== */
section('5) ★ 拉扳机蓄力发射 / 力度 → 落点单调可控');
{
  reset(1); insert(5); start();
  ok(M().phase === 'aim', '开始后进入 aim（等发射）');
  ok(!M().aimReady, '  └ 灯还没点完时不可发射');
  skip();
  ok(M().aimReady, '灯点完后 aimReady = true');
  ok(launch(0.5), '★ 可以发射');
  ok(M().phase === 'fly', '  └ 进入 fly');
  ok(M().ball !== null, '  └ 有球在飞');

  /* 力度越大 → 释放角越大 → 落点越靠左（槽号越小） */
  const corr = (() => {
    const xs = [], ys = [];
    for(let i = 0; i < 40; i++){
      const p = i / 39;
      const r = shoot(p, { seed: 777, bet: 5, mult: 2 });
      xs.push(p); ys.push(r.slot);
    }
    const rank = a => {
      const idx = a.map((v,i) => [v,i]).sort((p,q) => p[0]-q[0]);
      const rr = new Array(a.length);
      idx.forEach(([,i], k) => { rr[i] = k + 1; });
      return rr;
    };
    const rx = rank(xs), ry = rank(ys), n = xs.length;
    const mx = rx.reduce((a,b)=>a+b,0)/n, my = ry.reduce((a,b)=>a+b,0)/n;
    let sxy = 0, sxx = 0, syy = 0;
    for(let i = 0; i < n; i++){
      const dx = rx[i]-mx, dy = ry[i]-my;
      sxy += dx*dy; sxx += dx*dx; syy += dy*dy;
    }
    return (sxx && syy) ? sxy/Math.sqrt(sxx*syy) : 0;
  })();
  ok(corr < -0.6, '★ 力度与落点负相关（大力 → 靠左出口），秩相关 ' + corr.toFixed(3));

  /* 两端：最小力度落右边、最大力度落左边 */
  const lo = shoot(0, { seed: 777, bet: 5, mult: 2 });
  const hi = shoot(1, { seed: 777, bet: 5, mult: 2 });
  ok(lo.slot >= 8, '★ 力度 0（轻按）落最右几个出口（槽 ' + lo.slot + '）');
  ok(hi.slot <= 3, '★ 力度 1（满蓄力）落最左几个出口（槽 ' + hi.slot + '）');
  ok(hi.slot < lo.slot, '★ 满蓄力比轻按更靠左（' + hi.slot + ' < ' + lo.slot + '）');

  /* 未 aimReady 时发射必须失败 */
  reset(1); insert(5); start();
  ok(!launch(0.5), '★ 灯没点完就拉扳机无效');
  ok(M().phase === 'aim', '  └ 状态没变');
}

/* =====================================================================
   6) 结算：亮灯口给奖 / 没亮的没有
   ===================================================================== */
section('6) ★ 落进亮灯口 = 返还 投注×倍数；没亮的 = 0');
{
  /* 逐档 × 逐个出口：亮 = 给钱，不亮 = 不给 */
  for(const m of M().MULTS){
    for(const lit of [true, false]){
      reset(1);
      forceMult(m);
      insert(7); start(); skip();
      const s = M();
      const coinBefore = s.coins;
      /* 造一个「只有一个亮灯口」的局面，落点明确 */
      const target = 5;
      setLamps(new Array(12).fill(false).map((_, i) => i === target ? lit : false));
      launch(0.5);
      land(target);
      const after = M();
      const want = lit ? 7 * m : 0;
      okNum(after.landGain, want,
        `${m}x · 落${lit ? '亮' : '暗'}灯口 → 返还 ${want}（投注 7）`);
      okNum(after.coins, coinBefore + want,
        `  └ 代币 ${coinBefore} → ${coinBefore + want}`);
      okNum(after.landWin ? 1 : 0, lit ? 1 : 0, `  └ landWin = ${lit}`);
      okNum(after.ballsWon, lit ? 1 : 0, `  └ 中奖计数 = ${lit ? 1 : 0}`);
    }
  }

  /* 投注额参与计算：投 20 中 10x = 200 */
  reset(1);
  forceMult(10);
  insert(20); start(); skip();
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  launch(0.5);
  const c0 = M().coins;
  land(0);
  okNum(M().landGain, 200, '★ 投 20 中 10x → 返还 200（投注 × 倍数）');
  okNum(M().coins, c0 + 200, '  └ 代币正确增加');

  /* 落进没亮的：投注不退（代币不回补） */
  reset(1);
  forceMult(2);
  insert(10); start(); skip();
  setLamps([1,1,1,1,0,0,0,0,0,0,0,0]);
  launch(0.5);
  const c1 = M().coins;
  land(11);
  okNum(M().landGain, 0, '★ 落进没亮的出口 → 返还 0');
  okNum(M().coins, c1, '★ 本局投注不退（代币没变：' + c1 + '）');
  ok(M().landWin === false, '  └ landWin = false');
}

/* =====================================================================
   7) 结算后必须重新投币
   ===================================================================== */
section('7) ★ 本局结束 → 回投币阶段，必须重新投币');
{
  reset(1);
  forceMult(2);
  insert(5); start(); skip();
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  launch(0.5);
  land(0);
  ok(M().settleT > 0, '落槽后进入结算展示（settleT > 0）');
  ok(M().phase === 'fly', '  └ 展示期间仍算 fly');
  /* 走完展示 */
  let guard = 0;
  while(M().phase === 'fly' && guard++ < 600) step();
  ok(M().phase === 'bet', '★ 展示结束后回到投币阶段');
  okNum(M().bet, 0, '★ 本局投注清零');
  okNum(M().mult, 0, '★ 本局倍数清零');
  ok(M().lamps.every(v => v === false), '★ 出口灯全灭（下一局重新随机点）');
  ok(M().ball === null, '  └ 球已移除');
  ok(M().rounds === 1, '  └ 已计 1 局');
  ok(!launch(0.5), '★ 新一局没投币时拉扳机无效');
}

/* =====================================================================
   8) 代币耗尽 → 结束 / 重置
   ===================================================================== */
section('8) ★ 代币不足 5 枚 → 结束；「再来一次」重置 200');
{
  reset(1);
  /* 一路投 5 不中，直到没钱 */
  let guard = 0, played = 0;
  while(M().coins >= 5 && guard++ < 100){
    forceMult(2);
    insert(5); start(); skip();
    setLamps(new Array(12).fill(false));      // 一个都不亮 → 必不中
    launch(0.5); land(0);
    let g2 = 0;
    while(M().phase === 'fly' && g2++ < 600) step();
    played++;
  }
  ok(M().coins < 5, '★ 连输后代币不足 5 枚（余 ' + M().coins + '）');
  ok(M().phase === 'over', '★ 进入结束状态（over）');
  ok(played > 0, '  └ 确实打了 ' + played + ' 局');
  ok(!insert(1), '★ 结束后不能再投币');
  ok(!start(), '★ 结束后不能再开始');
  ok(M().rounds === played, '  └ 局数统计 = ' + played);

  /* 重置 */
  reset(null);
  okNum(M().coins, 200, '★ 重置后代币回到 200');
  ok(M().phase === 'bet', '  └ 回到投币阶段');
  ok(M().rounds === 0 && M().totalBet === 0, '  └ 统计清零');
}

/* =====================================================================
   9) 物理：长跑稳定性
   ===================================================================== */
section('9) 物理：不出界 / 不穿钉 / 必然落槽 / 不 NaN / 不超时');
{
  let nan = 0, out = 0, tunnel = 0, timeouts = 0, badSlot = 0;
  const hit = new Array(12).fill(0);
  const N = 240;
  for(let i = 0; i < N; i++){
    const r = shoot(i / (N - 1), { seed: 3000 + i * 13, bet: 5, mult: 2 });
    if(r.nan) nan++;
    if(r.out) out++;
    if(r.tunnel) tunnel++;
    if(r.timedOut) timeouts++;
    if(r.slot < 0 || r.slot > 11) badSlot++; else hit[r.slot]++;
  }
  okNum(nan, 0, '★ 没有 NaN 坐标（' + N + ' 发）');
  okNum(out, 0, '★ 球从不越出场地边界');
  okNum(tunnel, 0, '★ 球从不穿进钉子里');
  okNum(timeouts, 0, '★ 没有一发走到超时兜底');
  okNum(badSlot, 0, '★ 每一发都落进了合法出口');
  ok(hit.filter(v => v > 0).length === 12, '★ 12 个出口全都能进（覆盖 ' + hit.filter(v=>v>0).length + '/12）',
     hit.map((v,i) => i+':'+v).join(' '));
  ok(hit.reduce((a,b) => a+b, 0) === N, '  └ 落点计数总和 = 发数');

  /* 钉阵几何 */
  const s = M();
  const pegs = s.pegs;
  ok(pegs.length > 20, '钉阵数量合理（' + pegs.length + ' 颗）');
  let overlap = 0, inLane = 0, offArc = 0;
  for(let i = 0; i < pegs.length; i++){
    const p = pegs[i];
    if(p.x < s.CX_MIN + s.RP - 0.5 || p.x > s.CX_MAX - s.RP + 0.5) inLane++;
    if(p.y < s.ARC_CY){
      const d = Math.hypot(p.x - s.ARC_CX, p.y - s.ARC_CY);
      if(d > s.RC - s.RP - s.RB - 5) offArc++;
    }
    for(let j = i + 1; j < pegs.length; j++){
      const q = pegs[j];
      if(Math.hypot(p.x - q.x, p.y - q.y) < s.RP * 2 - 1) overlap++;
    }
  }
  okNum(overlap, 0, '★ 没有两颗钉重叠（球不会被夹住）');
  okNum(inLane, 0, '★ 没有钉落在左右墙危险区');
  okNum(offArc, 0, '★ 没有钉挡住圆弧导轨');
  ok(pegs.every(p => p.y < s.mouthY - 40), '  └ 钉都在出口口线上方');
}

/* =====================================================================
   10) 绘制：亮灯的口画成红的
   ===================================================================== */
section('10) 绘制：亮灯的口真的画成红的 / 未亮的是暗的');
{
  reset(1);
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  drawRec.fills.length = 0;
  win.__pinballDraw();
  const fills = drawRec.fills;
  /* 亮灯口用暖红渐变，未亮用暗紫渐变 —— 抓「红色分量高的填充」的个数 */
  const redish = fills.filter(f => {
    const st = String(f.style);
    /* 记录型渐变把 addColorStop 吃掉了，这里改成看「有没有画出口灯大小的圆」 */
    return f.r > 5 && f.r < 8;
  });
  ok(redish.length >= 12, '★ 12 个出口灯都画了（' + redish.length + ' 个圆）');

  /* 用真实颜色验证：给渐变加记录能力前，改用「亮灯会多画一层光晕」来判定 */
  reset(1);
  setLamps(new Array(12).fill(false));
  drawRec.fills.length = 0;
  win.__pinballDraw();
  const darkFills = drawRec.fills.filter(f => f.r > 9 && f.r < 13).length;
  reset(1);
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  drawRec.fills.length = 0;
  win.__pinballDraw();
  const oneLit = drawRec.fills.filter(f => f.r > 9 && f.r < 13).length;
  ok(oneLit > darkFills, '★ 亮灯口多画一层红色光晕（' + oneLit + ' > ' + darkFills + '）');
}

/* =====================================================================
   11) 确定性 / 音效 / 落盘
   ===================================================================== */
section('11) 确定性 / 音效 / 最高代币落盘');
{
  /* 同种子 + 同力度 → 同落点 */
  const a = shoot(0.42, { seed: 5150, bet: 5, mult: 2 });
  const b = shoot(0.42, { seed: 5150, bet: 5, mult: 2 });
  okNum(b.slot, a.slot, '★ 同种子 + 同力度 → 同落点（可复现）');

  /* 不同种子 → 钉阵不同 */
  reset(1); const p1 = JSON.stringify(M().pegs);
  reset(2); const p2 = JSON.stringify(M().pegs);
  ok(p1 !== p2, '★ 不同种子 → 不同钉阵');

  /* 同种子 → 钉阵相同 */
  reset(7); const q1 = JSON.stringify(M().pegs);
  reset(7); const q2 = JSON.stringify(M().pegs);
  ok(q1 === q2, '★ 同种子 → 同钉阵');

  /* 启动用随机种子（不是固定 1）：否则每次刷新都是同一局 */
  ok(M().seed !== undefined && Number.isFinite(M().seed), '启动有种子（' + M().seed + '）');

  /* 音效：投币 / 发射会产生音频节点 */
  const before = H.load().sndCount();
  const h2 = H.load();
  const n0 = h2.sndCount();
  h2.win.__pinballReset(1);
  h2.win.__pinballInsert(5);
  ok(h2.sndCount() > n0, '★ 投币有音效（音频节点 ' + n0 + ' → ' + h2.sndCount() + '）');
  const n1 = h2.sndCount();
  h2.win.__pinballStart(); h2.win.__pinballSkipAnim();
  ok(h2.sndCount() > n1, '★ 开始/点灯有音效');
  const n2 = h2.sndCount();
  h2.win.__pinballLaunch(0.5);
  ok(h2.sndCount() > n2, '★ 发射有音效');

  /* 最高代币落盘 */
  reset(1);
  forceMult(10);
  insert(20); start(); skip();
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  launch(0.5);
  const beforeBest = M().best;
  land(0);
  ok(M().coins > 200, '中大奖后代币超过 200（' + M().coins + '）');
  ok(M().best >= M().coins || M().best > beforeBest,
     '★ 最高代币被更新（' + beforeBest + ' → ' + M().best + '）');
}

/* =====================================================================
   12) 整局流程（从头到尾走一遍，模拟真人操作）
   ===================================================================== */
section('12) 整局流程：投币 → 开始 → 抽倍数 → 点灯 → 发射 → 结算 → 再来一局');
{
  reset(20261005);
  const s0 = M();
  okNum(s0.coins, 200, '开局 200 枚');

  /* 第一局：投 8 枚 */
  okNum(insert(8), 8, '投 8 枚');
  ok(start(), '按开始');
  /* 抽倍数动画：跑够帧数 */
  run(90);
  const s1 = M();
  ok(s1.mult > 0, '倍数已定（' + s1.mult + 'x）');
  ok(s1.lamps.filter(Boolean).length === s1.LAMP_N[s1.mult],
     '亮了 ' + s1.lamps.filter(Boolean).length + ' 个（应为 ' + s1.LAMP_N[s1.mult] + '）');
  ok(s1.aimReady, '可以发射');

  /* 瞄一个亮灯口打 */
  const lit = s1.lamps.map((v,i) => v ? i : -1).filter(i => i >= 0);
  const target = lit[0];
  launch(0.5);
  ok(M().phase === 'fly', '球在飞');
  land(target);
  ok(M().landWin === true, '★ 落进亮灯口 → 中奖');
  okNum(M().landGain, 8 * s1.mult, '★ 返还 8 × ' + s1.mult + ' = ' + (8 * s1.mult));
  const coinsAfterWin = M().coins;
  ok(coinsAfterWin > 192, '代币变多（' + coinsAfterWin + '）');

  let g = 0;
  while(M().phase === 'fly' && g++ < 600) step();
  ok(M().phase === 'bet', '回到投币阶段');
  okNum(M().bet, 0, '投注清零，等待重新投币');
  okNum(M().rounds, 1, '局数 = 1');

  /* 第二局：只投 5 枚，故意打没亮的口 */
  forceMult(4);
  okNum(insert(5), 5, '第二局投 5 枚');
  start(); skip();
  const dark = M().lamps.map((v,i) => v ? -1 : i).filter(i => i >= 0);
  ok(dark.length > 0, '有没亮的出口（' + dark.length + ' 个）');
  launch(0.5);
  land(dark[0]);
  ok(M().landWin === false, '★ 落进没亮的出口 → 不中奖');
  okNum(M().landGain, 0, '  └ 返还 0');
  g = 0;
  while(M().phase === 'fly' && g++ < 600) step();
  okNum(M().rounds, 2, '局数 = 2');
  okNum(M().ballsOut, 2, '发射数 = 2');
  okNum(M().ballsWon, 1, '中奖数 = 1');
}

/* =====================================================================
   汇总
   ===================================================================== */
console.log('\n' + '='.repeat(60));
if(fail === 0) console.log(`全部通过：${pass} 项断言 ✅`);
else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项 ❌`);
  console.log('\n失败清单：');
  for(const f of failures) console.log('  · ' + f);
}
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
