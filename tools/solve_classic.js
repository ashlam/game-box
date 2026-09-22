#!/usr/bin/env node
'use strict';
/**
 * 用 solver3.js 重算「经典集」24 关的真正最优，产出 tools/classic_optima.json。
 *
 * 为什么要重算：这批关卡原来的参考值取自 .sok 文件里附带的解，实测**不是最优**
 * （第 18 关声明 40 推，真最优 14 推；第 1 关声明 14 推，真最优 12 推）。
 * 游戏里把它标成「参考最优」是错的，这里用可采纳 A* 求出可信的下界。
 *
 * 每关：先 weight=1 求最优；超时则退到 weight=3 拿一条合法参考解。
 * 用法：node tools/solve_classic.js [最优预算秒] [加权预算秒]
 */
const fs = require('fs');
const path = require('path');
const { solveLevel } = require('./solver3.js');

const TOOLS = __dirname;
const SRC = path.join(TOOLS, 'final_levels4.json');
const OUT = path.join(TOOLS, 'classic_optima.json');

const bOpt = parseFloat(process.argv[2] || '120');
const bW = parseFloat(process.argv[3] || '45');
const maxStates = parseInt(process.argv[4] || '1200000', 10);

const levels = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const res = {};
if (fs.existsSync(OUT)) {                 // 断点续跑：已算好的不重算
  try { Object.assign(res, JSON.parse(fs.readFileSync(OUT, 'utf8'))); } catch (e) {}
}
const only = (process.argv[5] || '').split(',').map(s => s.trim()).filter(Boolean);
for (const lv of levels) {
  if (only.length && !only.includes(String(lv.no))) continue;
  if (res[String(lv.no)] && res[String(lv.no)].status === 'ok') {
    console.log(`${String(lv.no).padStart(2)} 已有结果，跳过`);
    continue;
  }
  const t0 = Date.now();
  let r = solveLevel(lv.map, { timeBudget: bOpt, weight: 1, maxStates });
  if (r.status !== 'ok') {
    const r2 = solveLevel(lv.map, { timeBudget: bW, weight: 3, maxStates });
    if (r2.status === 'ok') r = r2; else r = r2;
  }
  res[String(lv.no)] = { status: r.status, pushes: r.pushes, moves: r.moves, sol: r.sol,
                         optimal: !!r.optimal, states: r.states, secs: (Date.now() - t0) / 1000 };
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1), 'utf8');   // ★ 逐关落盘
  const tag = r.status === 'ok' ? (r.optimal ? '最优' : '参考解') : r.status;
  console.log(`${String(lv.no).padStart(2)} 原声明 ${String(lv.best.pushes).padStart(3)}推/${String(lv.best.moves).padStart(3)}步`
    + `   重算 ${String(r.pushes ?? '-').padStart(4)}推/${String(r.moves ?? '-').padStart(4)}步   ${tag}   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const vals = Object.values(res);
console.log(`\n汇总：最优 ${vals.filter(v => v.optimal).length} / 参考解 ${vals.filter(v => v.status === 'ok' && !v.optimal).length}`
  + ` / 未解出 ${vals.filter(v => v.status !== 'ok').length}`);
console.log(`已写入 ${path.relative(process.cwd(), OUT)}`);
