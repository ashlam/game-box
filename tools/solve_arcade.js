#!/usr/bin/env node
'use strict';
/**
 * 批量求解 Sokoban Deluxe（街机版 55 关），产出 tools/arcade_solutions.json。
 *
 * 每关三级策略：
 *   1) weight=1（可采纳 A*）预算内求出 ⇒ **推动数最优**，optimal=true
 *   2) 超时则退到 weight=3 加权 A* ⇒ 只保证「找到解」，optimal=false
 *   3) 还超时则记 failed（该关不入库）
 * 箱子/目标数对不上的关卡（dump 转录错误）直接记 invalid 并跳过。
 *
 * 用法：node tools/solve_arcade.js [最优预算秒] [加权预算秒]
 */
const fs = require('fs');
const path = require('path');
const { solveLevel, splitLevels } = require('./solver3.js');

const TOOLS = __dirname;
const SRC = path.join(TOOLS, 'classic', 'Deluxe.txt');
const OUT = path.join(TOOLS, 'arcade_solutions.json');

const WORLD = {
  1: '初心者向け', 2: '経験者向け', 3: '慣れた人向け', 4: '自信家向け', 5: '中毒患者向け',
};

const bOpt = parseFloat(process.argv[2] || '45');
const bW = parseFloat(process.argv[3] || '45');
const only = (process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean);
const maxStates = parseInt(process.argv[5] || '1200000', 10);   // 内存闸门（见 solver3.js）

const levels = splitLevels(fs.readFileSync(SRC, 'utf8'));
let prev = [];
if (only.length && fs.existsSync(OUT)) {
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { prev = []; }
}
const out = [];
let n = 0;
for (const lv of levels) {
  n++;
  const id = lv.name.split(/\s+/)[0];
  if (only.length && !only.includes(id)) continue;
  const wid = parseInt(id.split('-')[0], 10);
  const rec = {
    no: n, id, world: WORLD[wid] || '', map: lv.rows,
    h: lv.rows.length, w: Math.max(...lv.rows.map(r => r.length)),
  };
  const t0 = Date.now();
  let r = null, err = null;
  try {
    r = solveLevel(lv.rows, { timeBudget: bOpt, weight: 1, maxStates });
    if (r.status !== 'ok') {
      const r2 = solveLevel(lv.rows, { timeBudget: bW, weight: 3, maxStates });
      if (r2.status === 'ok') r = r2;
      else r = r2;   // 保留后一次的状态（timeout/dead）
    }
  } catch (e) { err = e.message; }

  if (err) { rec.status = 'invalid'; rec.err = err; }
  else {
    rec.status = r.status;
    if (r.status === 'ok') {
      rec.pushes = r.pushes; rec.moves = r.moves; rec.sol = r.sol;
      rec.optimal = !!r.optimal; rec.states = r.states;
    }
  }
  rec.secs = (Date.now() - t0) / 1000;
  out.push(rec);
  const boxes = lv.rows.join('').split('').filter(c => c === '$' || c === '*').length;
  console.log(`${id}\t${rec.status}\t推=${rec.pushes ?? '-'}\t步=${rec.moves ?? '-'}`
    + `\t${rec.optimal ? '最优' : (rec.status === 'ok' ? '加权解' : '')}`
    + `\t箱=${boxes}\t${rec.h}x${rec.w}\t${rec.secs.toFixed(2)}s${err ? '\t' + err : ''}`);
}

// 只补算指定关卡时：与已有结果合并（其余保持原样）
const final = only.length
  ? prev.map(r => out.find(x => x.id === r.id) || r)
  : out;
const fresh = only.length ? out.filter(x => !prev.some(r => r.id === x.id)) : [];
const all = final.concat(fresh);
all.sort((a, b) => a.no - b.no);

fs.writeFileSync(OUT, JSON.stringify(all, null, 1), 'utf8');
const vals = only.length ? out : all;
const ok = vals.filter(r => r.status === 'ok');
const opt = ok.filter(r => r.optimal);
console.log(`\n汇总：共 ${out.length} 关 | 解出 ${ok.length}（其中最优 ${opt.length}）`
  + ` | 无效 ${out.filter(r => r.status === 'invalid').length}`
  + ` | 未解出 ${out.filter(r => r.status === 'timeout' || r.status === 'dead').length}`);
console.log(`已写入 ${path.relative(process.cwd(), OUT)}`);
