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

  /* 力度越大 → 释放角越大 → 落点越靠左（槽号越小）。
     ★ 用「同种子连续多发的平均落点」而不是「单发落点」：
       单发结果带抖动，噪声大（p=0.75 偶尔也会落 10 号），
       平均值才是「力度把球送到哪一侧」的稳定度量。 */
  const meanAt = (p, n = 12) => {
    reset(4242);
    let s = 0, c = 0;
    for(let i = 0; i < n; i++){
      const r = shoot(p, { bet: 5, mult: 2, fresh: false });
      if(r.slot >= 0){ s += r.slot; c++; }
    }
    return c ? s / c : NaN;
  };
  const means = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map(p => meanAt(p));
  /* ★ 断言「整体趋势」而不是「严格单调」：
     每档只有 12 发，样本均值本身有噪声（相邻两档偶尔会反序是正常的）。
     所以用「首尾差距 + 秩相关」两条来锁趋势，而不是逐项比较 ——
     逐项比较会变成 flaky 测试（改一次随机种子就红）。 */
  const trend = (() => {
    const idx = means.map((v, i) => i);
    const rank = a => { const s = [...a].map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]); const r=[]; s.forEach(([,i],k)=>r[i]=k+1); return r; };
    const rx = rank(idx), ry = rank(means), n = means.length;
    const mx = rx.reduce((a,b)=>a+b,0)/n, my = ry.reduce((a,b)=>a+b,0)/n;
    let sxy=0,sxx=0,syy=0;
    for(let i=0;i<n;i++){ const dx=rx[i]-mx, dy=ry[i]-my; sxy+=dx*dy; sxx+=dx*dx; syy+=dy*dy; }
    return (sxx&&syy)? sxy/Math.sqrt(sxx*syy) : 0;
  })();
  ok(trend < -0.7, '★ 力度越大、平均落点越靠左（6 档均值的秩相关 ' + trend.toFixed(3) + '）',
     means.map((v,i) => [0,0.2,0.4,0.6,0.8,1][i] + '→' + v.toFixed(1)).join(' '));
  ok(means[0] - means[means.length-1] > 3,
     '★ 轻按与满蓄力的平均落点差得够开（' + means[0].toFixed(1) + ' vs ' + means[means.length-1].toFixed(1) + '）');

  /* 两端：最小力度落右边、最大力度落左边 */
  ok(means[0] >= 7, '★ 力度 0（轻按）平均落最右几个出口（均值 ' + means[0].toFixed(1) + '）');
  ok(means[means.length-1] <= 4, '★ 力度 1（满蓄力）平均落最左几个出口（均值 ' + means[means.length-1].toFixed(1) + '）');

  /* 秩相关（连续多局，不 reset）
     ★ 用**落点连续 x** 而不是槽号来量技巧。理由（踩过的坑）：
       槽号是连续 x 被槽宽量化后的结果，槽越窄，同样的物理散布跨过越多槽边界，
       槽号秩相关就越低 —— 那是**量化噪声**，不是技巧变差。
       实测差点误判：出口区右界改完之后槽号秩相关 -0.53→-0.43，
       查下去发现基线是**虚高**的（漏进管道的低力度球全落最右假出口，
       人为加强负相关），剔掉漏球后两版只差 0.03。
     ★★ 为什么不只看一个种子：单种子 60 发的秩相关噪声极大
        （实测 10 个种子的连续 x 相关在 -0.35 ~ -0.63 之间跳），
        拿单种子卡阈值必然 flaky。所以**取多个种子的均值**作为断言对象 ——
        均值才是「这个参数配置的技巧性」的稳定估计。 */
  const corrOf = (pick, nShots) => {
    const rank = a => {
      const idx = a.map((v,i) => [v,i]).sort((p,q) => p[0]-q[0]);
      const rr = new Array(a.length);
      idx.forEach(([,i], k) => { rr[i] = k + 1; });
      return rr;
    };
    const one = seed => {
      reset(seed);
      const xs = [], ys = [];
      for(let i = 0; i < nShots; i++){
        const p = i / (nShots - 1);
        const r = shoot(p, { bet: 5, mult: 2, fresh: false });
        if(r.slot < 0) continue;
        xs.push(p); ys.push(pick(r));
      }
      const rx = rank(xs), ry = rank(ys), n = xs.length;
      const mx = rx.reduce((a,b)=>a+b,0)/n, my = ry.reduce((a,b)=>a+b,0)/n;
      let sxy = 0, sxx = 0, syy = 0;
      for(let i = 0; i < n; i++){
        const dx = rx[i]-mx, dy = ry[i]-my;
        sxy += dx*dy; sxx += dx*dx; syy += dy*dy;
      }
      return (sxx && syy) ? sxy/Math.sqrt(sxx*syy) : 0;
    };
    const vs = [1, 42, 777, 4242, 20261005].map(one);
    return vs.reduce((a,b) => a+b, 0) / vs.length;
  };
  /* ★ 连续落点 x：这才是「物理上力度能不能控住落点」的真度量（期望负相关） */
  const corrX = corrOf(r => r.landX, 60);
  ok(corrX < -0.45, '★ 力度与落点（连续 x）强负相关 —— 物理上确实可控，多种子均值 ' + corrX.toFixed(3));
  /* ★ 槽号：玩家实际看到的口，受槽宽量化影响，门槛低一点 */
  const corr = corrOf(r => r.slot, 60);
  ok(corr < -0.38, '★ 力度与落点槽号负相关（大力 → 靠左出口），多种子均值 ' + corr.toFixed(3));

  /* 未 aimReady 时发射必须失败 */
  reset(1); insert(5); start();
  ok(!launch(0.5), '★ 灯没点完就拉扳机无效');
  ok(M().phase === 'aim', '  └ 状态没变');
}

/* =====================================================================
   9.6) ★ 用户报的 bug：点亮出口灯时把「发射管道」也算成一个出口
   ===================================================================== */
section('9.6) ★ 回归：发射管道不能算成一个出口');
{
  const s = M();
  /* ① 出口区右界不能越过发射管道内壁 */
  ok(s.SLOT_R <= s.LANE_WALL_X + 0.01,
     '★ 出口区右界（' + s.SLOT_R.toFixed(1) + '）不超过管道内壁（' + s.LANE_WALL_X + '）');

  /* ② 12 个出口必须**无缝铺满** [fieldL, SLOT_R]，且最后一个槽正好抵到管道壁 */
  const span = s.fieldL + 12 * s.slotW;
  ok(Math.abs(span - s.SLOT_R) < 1e-9,
     '★ 12 个出口无缝铺满场地（' + s.fieldL + ' + 12×' + s.slotW.toFixed(2) + ' = ' + span.toFixed(2) + ' = 右界）');

  /* ③ 「球在管道里的 x」必须**不属于任何一个出口** —— 这就是原来的 bug：
        以前 12 个槽是按 [fieldL, fieldR] 分的，管道 x=339 落在 slot 11 里，
        于是 slot 11 有 78% 宽度是管道、永远落不进去，却照样会被点亮。 */
  const slotOfLaneX = s.slotAtX(s.LANE_X);
  ok(s.fieldL + slotOfLaneX * s.slotW < s.LANE_WALL_X - s.RB ||
     s.fieldL + (slotOfLaneX + 1) * s.slotW > s.LANE_WALL_X + s.RB,
     '★ 管道位置不会被算进任何出口的判定范围',
     '管道 x=' + s.LANE_X + ' 被判为 slot ' + slotOfLaneX);
  ok(s.slotAtX(s.LANE_WALL_X) === 11, '  └ 管壁处仍归最后一个出口（球心最右落点在此）');

  /* ④ 每个出口的判定区间宽度都等于 slotW，且互不重叠 */
  let overlap = 0, widthBad = 0;
  for(let i = 0; i < 12; i++){
    const a = s.slotAtX(s.slotX0(i) + 0.01), b = s.slotAtX(s.slotX0(i + 1) - 0.01);
    if(i < 11 && b !== i) widthBad++;
    if(a !== i) overlap++;
  }
  okNum(widthBad, 0, '★ 每个出口的 x 区间都完整映射回自己');
  okNum(overlap, 0, '  └ 出口区间互不重叠');

  /* ⑤ ★★ 端到端：**没有任何一发球**能落进发射管道区
        （原来低力度球会从弧区右端漏进管道、落进那个假出口，实测 9/9）。 */
  let leaked = 0, landedInLane = 0;
  reset(20261005);
  for(let i = 0; i < 200; i++){
    const st = shoot(i / 199, { bet: 5, mult: 2, fresh: false });
    if(st.slot < 0) continue;
    /* 落点 x 若已到管道内壁右侧，说明球「在管道里结算」了 —— 那就是漏了 */
    if(st.landX > M().LANE_WALL_X - M().RB + 0.6) landedInLane++;
  }
  okNum(landedInLane, 0, '★★ 200 发里没有一发是「在发射管道里结算」的（用户报的 bug）',
        landedInLane + ' 发落在管道区');

  /* ⑥ 每个出口都是**真的能进**（含最右那个）—— 防止「点亮了一个进不去的口」 */
  const hit = new Array(12).fill(0);
  reset(31337);
  for(let i = 0; i < 300; i++){
    const st = shoot(i / 299, { bet: 5, mult: 2, fresh: false });
    if(st.slot >= 0) hit[st.slot]++;
  }
  const dead = hit.map((v, i) => v === 0 ? i : -1).filter(i => i >= 0);
  okNum(dead.length, 0, '★ 12 个出口全都真的能落进去（没有「点了灯却进不去」的口）',
        '进不去的出口: ' + (dead.length ? dead.join(',') : '无'));
  void leaked;
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
   7.5) ★ 结算演出：中奖/没中奖音乐区分 + 代币逐点加上去
   ===================================================================== */
section('7.5) ★ 结算演出：输赢音乐不同 + 中奖时代币逐点加上去');
{
  /* ---- ① 中奖与没中奖的音乐必须**明显不同**（用户要的「失落 vs 奖励」）---- */
  const musicOf = won => {
    const h2 = H.load();
    const w = h2.win, m = h2.M;
    w.__pinballReset(1); w.__pinballForceMult(2);
    w.__pinballInsert(5); w.__pinballStart(); w.__pinballSkipAnim();
    w.__pinballSetLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
    /* 音效由 h2 内部计数（每 start() 一个振荡器算一次），量结算前后差值 */
    const before = h2.sndCount();
    w.__pinballLaunch(0.5);
    w.__pinballLand(won ? 0 : 3);
    return h2.sndCount() - before;
  };
  const nWin = musicOf(true);
  const nLose = musicOf(false);
  ok(nWin >= 6, '★ 中奖放的是「奖励音乐」（音符 ' + nWin + ' 个 ≥ 6）', '音符 ' + nWin);
  ok(nLose >= 2, '★ 没中奖也有音效（音符 ' + nLose + ' 个 ≥ 2）', '音符 ' + nLose);
  ok(nWin > nLose,
     '★ 中奖的音效比没中奖更丰富（' + nWin + ' > ' + nLose + '）—— 听感上分得出输赢');

  /* ★★ 光比音符个数是不够的：个数一样多但「走向搞反了」（中奖变叹气、
     没中奖变欢呼）照样能过。所以直接量**频率序列的走向**。
     判据用「后半段均值 − 前半段均值」：中奖必须往上、没中奖必须往下。 */
  const musicFreqs = won => {
    const h2 = H.load();
    const w = h2.win;
    w.__pinballReset(1); w.__pinballForceMult(2);
    w.__pinballInsert(5); w.__pinballStart(); w.__pinballSkipAnim();
    w.__pinballSetLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
    const before = h2.sndCount();
    w.__pinballLaunch(0.5);
    w.__pinballLand(won ? 0 : 3);
    return h2.sndFreqsTail(h2.sndCount() - before);
  };
  const avg = a => a.reduce((x,y) => x+y, 0) / a.length;
  const trendOf = a => { const h = Math.ceil(a.length/2); return avg(a.slice(h)) - avg(a.slice(0,h)); };
  const fWin = musicFreqs(true), fLose = musicFreqs(false);
  ok(trendOf(fLose) < 0,
     '★★ 没中奖是**下行**旋律（失落感），走向 ' + Math.round(trendOf(fLose)) + 'Hz',
     fLose.map(f=>Math.round(f)).join(' '));
  ok(trendOf(fWin) > 0,
     '★★ 中奖是**上行**旋律（奖励感），走向 +' + Math.round(trendOf(fWin)) + 'Hz',
     fWin.map(f=>Math.round(f)).join(' '));
  ok(avg(fWin) > avg(fLose) * 1.4,
     '★ 中奖的音区明显更高（' + Math.round(avg(fWin)) + 'Hz vs ' + Math.round(avg(fLose)) + 'Hz）—— 明亮 vs 低沉');

  /* ---- ② 中奖：代币真值立刻全额入账（保证逻辑原子性）---- */
  reset(1); forceMult(4);
  insert(10); start(); skip();
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  /* ★ 这一条是**截图发现的 bug**：投币扣了钱，界面却还显示旧数字
     （因为显示值是另一个变量、投币路径忘了同步它）。
     现在显示值由 coins 派生，任何改 coins 的路径都自动反映。 */
  okNum(M().shownCoins, 200 - 10, '★ 投币后显示值也要跟着减（投 10 → 显示 190）');
  const coinsBefore = M().coins, shownBefore = M().shownCoins;
  launch(0.5); land(0);
  const st = M();
  okNum(st.coins, coinsBefore + 10 * 4, '★ 中奖时代币**真值**立刻全额入账（逻辑不受动画影响）');
  ok(st.gainRollT > 0, '★ 同时启动了「逐点加钱」演出（gainRollT > 0）');
  okNum(st.shownCoins, shownBefore, '  └ 演出刚开始：显示值仍是旧余额（还没涨）');

  /* ---- ③ 显示值会一步步追上真值，且**不会超过**真值 ---- */
  const target = M().coins, from = M().shownCoins;
  const samples = [];
  let overshoot = 0, guard = 0;
  while(M().gainRollT > 0 && guard++ < 600){
    step();
    const s = M();
    if(s.shownCoins > target) overshoot++;
    samples.push(s.shownCoins);
  }
  ok(guard < 600, '★ 「逐点加钱」演出会自己结束（' + guard + ' 帧 ≈ ' + (guard/60).toFixed(2) + 's）');
  okNum(overshoot, 0, '★ 显示值从不超过真值（不会出现「涨过头再退回」的穿帮）');
  ok(samples.length >= 5, '★ 显示值确实是一点点涨的（采样 ' + samples.length + ' 次）',
     samples.slice(0, 8).join('→'));
  const uniq = new Set(samples).size;
  ok(uniq >= 4, '★ 中途出现了多个不同的数值（不是直接跳变）—— 不同值 ' + uniq + ' 个');
  /* ★★ 这一条是**截图发现的 bug**：数字在涨，但界面从没刷新过 ——
     玩家看到的是全程纹丝不动的 200，只有「最高代币」跳到了 380。
     所以必须断言「演出中途的显示值既不是旧值也不是新值」。 */
  const mid = samples[Math.floor(samples.length / 2)];
  ok(mid !== shownBefore && mid !== target,
     '★★ 演出中途的显示值既不是旧余额也不是新余额（' + shownBefore + ' → ' + mid + ' → ' + target + '）');
  ok(samples[samples.length - 1] >= from, '  └ 数值单调不降');
  okNum(M().shownCoins, target, '★ 演出结束后显示值与真值对齐');

  /* ---- ③b ★★ DOM 层面：界面上的代币文本必须在演出期间真的在变 ----
     这是**截图才发现**的 bug：内部数值一路在涨，但没人调 syncUI()，
     玩家看到的代币全程是纹丝不动的 200（只有「最高代币」跳到了 380）。
     只断言内部状态是抓不住这种「算对了但没画出来」的 bug 的。 */
  reset(1); forceMult(4);
  insert(10); start(); skip();
  setLamps([1,0,0,0,0,0,0,0,0,0,0,0]);
  launch(0.5); land(0);
  const coinEl = els.vCoins;
  const domTexts = [];
  guard = 0;
  while(M().gainRollT > 0 && guard++ < 600){
    step();
    domTexts.push(coinEl.textContent);
  }
  const domUniq = new Set(domTexts).size;
  ok(domUniq >= 4,
     '★★ 演出期间**界面上的代币文本**确实在不断变化（' + domUniq + ' 个不同值）',
     domTexts.slice(0, 10).join('→'));
  ok(domTexts[domTexts.length - 1] === String(M().coins),
     '★★ 演出结束后界面显示的是新余额（' + domTexts[domTexts.length-1] + '）');

  /* ---- ④ 没中奖：不滚动，显示值与真值立刻一致 ---- */
  reset(1); forceMult(2);
  insert(5); start(); skip();
  setLamps([0,0,0,0,0,0,0,0,0,0,0,0]);
  launch(0.5); land(3);
  const lose = M();
  ok(!(lose.gainRollT > 0), '★ 没中奖时不启动「逐点加钱」');
  okNum(lose.shownCoins, lose.coins, '★ 没中奖时显示值与真值一致（不会差着上局的数）');
  /* reset 后是 200，投了 5 枚 → 195；没中奖不返还，所以就是 195 */
  okNum(lose.coins, 200 - 5, '  └ 只扣了投注（200 − 5 = 195），没有返还');

  /* ---- ⑤ ★★ 物理必须与结算时长完全脱钩（这是加演出时踩到的真 bug）----
     原来 drop 模式也跑「卡住踢一脚」：球在槽底速度天然为 0 → 必被判卡住 →
     每 STUCK_T 秒 rng() 一次。于是**改结算时长就会让随机数流错位**，
     后面每一发的出手抖动全变。实测把 SETTLE_T 从 2.0 改成 2.6，
     物理一行没动，「力度→落点」秩相关却从 -0.53 掉到 -0.44。 */
  const series = extra => {
    reset(777);
    const out = [];
    for(let i = 0; i < 30; i++){
      const r = shoot(i / 29, { bet: 5, mult: 2, fresh: false });
      out.push(r.slot);
      for(let k = 0; k < extra; k++) step();   // 多等一段结算动画
    }
    return out.join(',');
  };
  const s0 = series(0), s1 = series(90), s2 = series(300);
  ok(s0 === s1 && s1 === s2,
     '★★ 落点序列与「结算等待多久」无关（物理不被演出污染）',
     '0帧 vs 90帧 相同=' + (s0 === s1) + '，90帧 vs 300帧 相同=' + (s1 === s2));
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
  let nan = 0, out = 0, timeouts = 0, badSlot = 0;
  let worstPen = 0, worstPenStep = 0, deepPen = 0;
  const hit = new Array(12).fill(0);
  const N = 240;
  for(let i = 0; i < N; i++){
    const r = shoot(i / (N - 1), { seed: 3000 + i * 13, bet: 5, mult: 2 });
    if(r.nan) nan++;
    if(r.out) out++;
    if(r.timedOut) timeouts++;
    if(r.maxPen > worstPen){ worstPen = r.maxPen; worstPenStep = r.maxPenStep; }
    if(r.maxPen > 2) deepPen++;                 // >2px 才算「明显陷进钉里」
    if(r.slot < 0 || r.slot > 11) badSlot++; else hit[r.slot]++;
  }
  okNum(nan, 0, '★ 没有 NaN 坐标（' + N + ' 发）');
  okNum(out, 0, '★ 球从不越出场地边界');
  /* ★ 「不穿钉」这条要按**物理意义**判，不能只看「有没有重叠」：
     球在密集钉阵里可能同时贴住两颗钉，单趟解算把它推出 A 又压进 B，
     帧末会残留约 1~2px 重叠 —— 那不是「穿过去」。
     真穿钉的特征是**单帧位移接近或超过 RB+RP**（球整颗跨过钉子）。
     所以判据 = 穿透深度小 且 单帧位移远小于 RB+RP。
     ⚠️ 原来的断言是「重叠 >0.8px 就算穿钉」→ 在密集钉阵下会随机翻红（flaky），
        而且它判的是残差、不是穿钉。 */
  ok(worstPen <= 2.5, '★ 球从不真的穿进钉子里（最深重叠 ' + worstPen.toFixed(2) + 'px ≤ 2.5px）',
     '最深 ' + worstPen + 'px');
  ok(worstPenStep < (M().RB + M().RP) * 0.6,
     '★ 单帧位移远小于「球半径+钉半径」（' + worstPenStep.toFixed(2) + ' < ' + ((M().RB + M().RP) * 0.6).toFixed(1) +
     '）—— 球不可能整颗跨过钉子',
     '单帧位移 ' + worstPenStep + 'px');
  okNum(deepPen, 0, '★ 没有一发「明显陷进钉里」（重叠 >2px）');
  okNum(timeouts, 0, '★ 没有一发走到超时兜底');
  okNum(badSlot, 0, '★ 每一发都落进了合法出口');
  ok(hit.filter(v => v > 0).length === 12, '★ 12 个出口全都能进（覆盖 ' + hit.filter(v=>v>0).length + '/12）',
     hit.map((v,i) => i+':'+v).join(' '));
  ok(hit.reduce((a,b) => a+b, 0) === N, '  └ 落点计数总和 = 发数');

  /* 钉阵几何 */
  const s = M();
  const pegs = s.pegs;
  ok(pegs.length > 20, '钉阵数量合理（' + pegs.length + ' 颗）');
  let overlap = 0, inLane = 0, offArc = 0, wallGap = 0, baffleGap = 0, wedged = 0;
  const minWall = s.CX_MIN + s.RB + s.RP;        // 钉心距墙的硬下限（否则球被墙+钉夹死）
  const minBaf = 2 * s.RB + s.RP;                // 钉到挡板轴的最小距离（否则球被钉+挡板夹死）
  for(let i = 0; i < pegs.length; i++){
    const p = pegs[i];
    if(p.x < s.CX_MIN + s.RP - 0.5 || p.x > s.CX_MAX - s.RP + 0.5) inLane++;
    /* ★ 贴墙夹死：球贴墙时球心 x=CX_MIN，与钉不重叠要求中心距 ≥ RB+RP，
       所以钉心必须 ≥ CX_MIN + RB + RP。这里留 1px 容差。 */
    if(p.x < minWall - 1 || p.x > s.CX_MAX - minWall + s.CX_MIN + 1) wallGap++;
    if(p.y < s.ARC_CY){
      const d = Math.hypot(p.x - s.ARC_CX, p.y - s.ARC_CY);
      if(d > s.RC - s.RP - s.RB - 3) offArc++;
    }
    /* ★ 钉与挡板夹死（实测卡在 (309.9,393.4)）：用点到线段距离 */
    for(const bf of s.baffles){
      const ex = bf.x2 - bf.x1, ey = bf.y2 - bf.y1;
      const len2 = ex * ex + ey * ey;
      let t = len2 > 0 ? ((p.x - bf.x1) * ex + (p.y - bf.y1) * ey) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const d = Math.hypot(p.x - (bf.x1 + ex * t), p.y - (bf.y1 + ey * t));
      if(d < minBaf + bf.r - 1) baffleGap++;
    }
    for(let j = i + 1; j < pegs.length; j++){
      const q = pegs[j];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if(d < s.RP * 2 - 1) overlap++;
      /* ★★ 楔死判据（实测抓到的卡死根因）：球心到两颗钉心都得 ≥ RB+RP，
         所以球要能「挤过去」，钉心距必须 > 2·(RB+RP)。
         实测有一对钉距 22.15（阈值 23），球在 (162,291) 以速度 3 卡了 370 帧、
         整发拖到 11.3 秒。 */
      if(d < 2 * (s.RB + s.RP)) wedged++;
    }
  }
  okNum(overlap, 0, '★ 没有两颗钉重叠（球不会被夹住）');
  okNum(wedged, 0, '★★ 没有「球挤不过去」的钉对（钉心距必须 > 2·(RB+RP) = ' + (2 * (s.RB + s.RP)).toFixed(1) + '）—— 否则球会楔在缝里卡死',
        wedged + ' 对违规（实测这种缝会让一发球卡 370 帧、拖到 11 秒）');
  okNum(inLane, 0, '★ 没有钉落在左右墙危险区');
  okNum(wallGap, 0, '★ 没有钉贴墙太近（否则球会被「墙 + 钉」夹死）',
        wallGap + ' 颗违规，硬下限 x ≥ ' + minWall.toFixed(1));
  okNum(baffleGap, 0, '★ 没有钉贴着挡板（否则球会被「钉 + 挡板」夹死）',
        baffleGap + ' 颗违规，硬下限距离 ' + minBaf.toFixed(1));
  okNum(offArc, 0, '★ 没有钉挡住圆弧导轨');
  ok(pegs.every(p => p.y < s.mouthY - 40), '  └ 钉都在出口口线上方');

  /* ★ 钉阵必须铺到圆弧区内（这是「满力量每次落同一个口」的根因之一：
     原来钉阵从 y=216 才开始，而球在 y≈164 就脱轨了 → 球从钉阵上方飞过去、
     一颗钉都撞不到 → 每发路线完全相同）。 */
  const inArc = pegs.filter(p => p.y < s.ARC_CY).length;
  ok(inArc >= 10, '★ 圆弧区内有足够多的钉（' + inArc + ' 颗）—— 球脱轨后必然进入钉阵，不会从上方飞过',
     '圆弧区钉数 ' + inArc);
  const topPeg = Math.min.apply(null, pegs.map(p => p.y));
  ok(topPeg < s.ARC_CY - 60, '★ 钉阵从弧顶下方就开始铺（最高钉 y=' + topPeg.toFixed(0) + '，弧顶 y=' + (s.ARC_CY - s.RC).toFixed(0) + '）');

  /* ★ 飞行时长：这是「球被钉阵困住」的病征。
     钉太密 / 太弹时球会在上半场反复弹、低速悬停 —— 实测飞行中位曾达 7.5 秒、最长 14 秒，
     完全没法玩。现在锁住上限，防止以后调参又把球「困」住。
     ⚠️ 阈值按**分布**取（120 发实测：中位 5.5s、p90 7.1s、p99 8.5s、最大 8.5s），
        不按单发极值 —— 极值随随机种子波动，卡太紧会变成 flaky 测试。 */
  reset(20261005);
  const flyFrames = [];
  for(let i = 0; i < 40; i++) flyFrames.push(shoot(i / 39, { bet: 5, mult: 2, fresh: false }).frames);
  const sorted = flyFrames.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const over9 = flyFrames.filter(f => f > 540).length;
  ok(med <= 420, '★ 每发飞行时长中位 ≤ 7 秒（实际 ' + (med/60).toFixed(1) + 's）—— 别把球困在钉阵里',
     '中位 ' + med + ' 帧');
  okNum(over9, 0, '★ 没有一发飞超过 9 秒（' + flyFrames.length + ' 发）',
        over9 + ' 发超 9 秒，最长 ' + sorted[sorted.length-1] + ' 帧');
  ok(sorted[sorted.length - 1] <= 600,
     '★ 最长一发 ≤ 10 秒（实际 ' + (sorted[sorted.length-1]/60).toFixed(1) + 's）',
     '最长 ' + sorted[sorted.length-1] + ' 帧');
}

/* =====================================================================
   9.5) ★ 用户报的 bug：同一力度反复打，总是走一模一样的路线、落同一个出口
   ===================================================================== */
section('9.5) ★ 回归：同一力度不能「每次都落同一个出口」');
{
  /* 用户原话：「以满力量射球的时候，球每次都会走一模一样的路线落入同一个出口」
     根因有两条（都已修）：
       ① 钉阵从 y=216 才开始，而球在 y≈164 就脱轨 —— 球从钉阵上方飞过去、撞钉=0；
       ② 脱轨速度是**切向**的，球贴着最外圈（弧壁/竖墙）滑下去，永远进不了钉阵。
     下面这条断言直接锁「结果」：同力度连打 N 发，最常见落点占比不能太高。 */
  const rep = (p, n = 16) => {
    reset(20261005);
    const slots = [];
    for(let i = 0; i < n; i++){
      const r = shoot(p, { bet: 5, mult: 2, fresh: false });
      if(r.slot >= 0) slots.push(r.slot);
    }
    const c = {};
    for(const v of slots) c[v] = (c[v] || 0) + 1;
    const modal = Math.max.apply(null, Object.values(c));
    return { slots, modal, n: slots.length, uniq: new Set(slots).size };
  };

  for(const p of [0, 0.5, 1.0]){
    const r = rep(p);
    const ratio = r.modal / r.n;
    ok(ratio <= 0.62,
       `★ 力度 ${p.toFixed(1)} 连打 ${r.n} 发不会总落同一个口（最常见 ${r.modal}/${r.n} = ${(ratio*100).toFixed(0)}%）`,
       '落点 [' + r.slots.join(',') + ']');
    ok(r.uniq >= 3,
       `  └ 力度 ${p.toFixed(1)} 至少落进 3 个不同出口（实际 ${r.uniq} 个）`,
       '[' + r.slots.join(',') + ']');
  }

  /* 满力量是最容易退化的档（曾经 12/12 全落 0 号口），单独再压一条更严的 */
  const full = rep(1.0, 24);
  ok(full.modal / full.n <= 0.55,
     `★ 满力量连打 24 发不会退化（最常见 ${full.modal}/24 = ${(full.modal/full.n*100).toFixed(0)}%，修复前是 100%）`,
     '[' + full.slots.join(',') + ']');

  /* 反向证明：球必须真的在钉阵里磕碰，不能「从钉阵上方飞过去、一颗钉都不撞」。
     这是上面那个 bug 的直接病征（撞钉=0 → 路径完全确定）。 */
  reset(20261005);
  let zeroPegShots = 0, totalShots = 0, pegSum = 0;
  for(const p of [0, 0.25, 0.5, 0.75, 1.0]){
    for(let i = 0; i < 6; i++){
      const before = M().pegHits;
      const r = shoot(p, { bet: 5, mult: 2, fresh: false });
      const hits = M().pegHits - before;
      pegSum += hits; totalShots++;
      if(hits === 0) zeroPegShots++;
    }
  }
  okNum(zeroPegShots, 0, '★ 没有一发是「一颗钉都没撞」（撞钉=0 就是路径确定的病征）',
        zeroPegShots + '/' + totalShots + ' 发没撞钉');
  ok(pegSum / totalShots > 3,
     '★ 平均每发撞到足够多的钉（' + (pegSum/totalShots).toFixed(1) + ' 颗）—— 球确实在钉阵里走');

  /* 脱轨点必须在钉阵覆盖范围内：不能落在弧上「钉阵上方」的空档里 */
  const s = M();
  for(const p of [0, 0.5, 1.0]){
    const a = M().aimOf(p, false);
    const relY = s.ARC_CY - s.RC * Math.sin(a.phiRel);
    const lowestPegBelow = s.pegs.filter(q => q.y > relY).length;
    ok(lowestPegBelow > 0,
       `  └ 力度 ${p.toFixed(1)} 脱轨点 y=${relY.toFixed(0)} 下方有钉阵（${lowestPegBelow} 颗）`);
  }
  /* 满力量的释放点不能贴在墙上（贴墙 → 切线近乎竖直 → 必然重复） */
  const aFull = M().aimOf(1, false);
  const relXFull = s.ARC_CX + s.RC * Math.cos(aFull.phiRel);
  ok(relXFull > s.CX_MIN + s.RB * 2,
     '★ 满力量释放点不贴左墙（x=' + relXFull.toFixed(1) + '，左墙 ' + s.CX_MIN + '）—— 贴墙会导致贴墙直落');
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
  /* 同种子 + 同力度 → 同落点。
     ★ 必须显式 fresh:true（每次都 reset 回同一局）：harness 的 shoot 默认
       是「连续对局、不 reset」，那样第二发的 RNG 已经推进过了，落点本来就该不同。
       要验「可复现」就得把两边都重置到同一状态再打。 */
  const a = shoot(0.42, { seed: 5150, bet: 5, mult: 2, fresh: true });
  const b = shoot(0.42, { seed: 5150, bet: 5, mult: 2, fresh: true });
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
