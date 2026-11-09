#!/usr/bin/env node
/**
 * 数织关卡校验器
 *
 * 存在的理由：数织最伤人的失败不是「难」，而是**推到最后发现有两个解**，
 * 或者某一步必须靠猜。手画的像素图极容易不唯一（尤其是 10×10 以上），
 * 而这种事肉眼完全看不出来 —— 只有把它当约束满足问题跑一遍才知道。
 *
 * 所以每次改关卡都跑：
 *     node tools/solve_nonogram.js
 *
 * 判定标准（两道都过才算合格）：
 *   1. unique  —— 解唯一。多解 = 玩家会画出另一幅画，白玩
 *   2. logic   —— 只靠「单行/单列推理 + 传播」就能全部推完，中途不需要试错
 *
 * 关卡图案不在这里重复维护，直接从 web/nonogram/index.html 里抽
 * `var LEVELS = [...]`，保证校验的就是线上跑的那份数据。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'web', 'nonogram', 'index.html');

/* ------------------------------------------------------------ 抽取关卡 */
function extractLevels(src){
  const key = 'var LEVELS = [';
  const at = src.indexOf(key);
  if(at < 0) throw new Error('没找到 `var LEVELS = [`');
  let i = at + key.length - 1;   // 指向 '['
  let depth = 0, inStr = false, quote = '', esc = false;
  for(; i < src.length; i++){
    const ch = src[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(ch === '\\'){ esc = true; continue; }
      if(ch === quote) inStr = false;
      continue;
    }
    if(ch === '"' || ch === "'" || ch === '`'){ inStr = true; quote = ch; continue; }
    if(ch === '[') depth++;
    else if(ch === ']'){
      depth--;
      if(depth === 0) break;
    }
  }
  if(depth !== 0) throw new Error('LEVELS 数组没闭合');
  const text = src.slice(at + key.length - 1, i + 1);
  return Function('"use strict";return (' + text + ');')();
}

/* ------------------------------------------------------------ 线索 */
function clueOf(vals){
  const out = []; let run = 0;
  for(const v of vals){ if(v){ run++; } else if(run){ out.push(run); run = 0; } }
  if(run) out.push(run);
  return out.length ? out : [0];
}

/* ------------------------------------------------------------ 单行枚举
 * 把「长度为 n 的一行 + 线索 runs + 当前已知状态」能摆出的所有方案列出来。
 * 状态：0 未知 / 1 必填 / 2 必空。
 * 15 格最多几万种摆法，直接枚举足够快，逻辑也看得懂。
 */
function enumLine(n, runs, state, cb){
  const cells = new Array(n).fill(0);

  function go(pos, ri){
    if(ri === runs.length){
      for(let i = pos; i < n; i++){
        if(state[i] === 1) return;      // 尾巴上还有必须填的格，摆不下
        cells[i] = 2;
      }
      cb(cells);
      return;
    }

    // 剩下的（含 run 之间的至少一个空格）至少要占多少
    let need = runs.length - ri - 1;
    for(let k = ri; k < runs.length; k++) need += runs[k];

    for(let start = pos; start + need <= n; start++){
      if(state[start] === 2) continue;   // 这格已定空，run 不能从这开始

      let ok = true;
      for(let i = pos; i < start; i++){
        if(state[i] === 1){ ok = false; break; }
      }
      if(!ok) break;                     // 再往后都会跨过这个必填格

      for(let i = start; i < start + runs[ri]; i++){
        if(state[i] === 2){ ok = false; break; }
      }
      if(!ok) continue;

      for(let i = pos; i < start; i++) cells[i] = 2;
      for(let i = start; i < start + runs[ri]; i++) cells[i] = 1;

      if(ri + 1 < runs.length){
        if(start + runs[ri] >= n) break;
        if(state[start + runs[ri]] === 1) continue;   // 需要一个空格，但那里必须填
        cells[start + runs[ri]] = 2;
        go(start + runs[ri] + 1, ri + 1);
      }else{
        go(start + runs[ri], ri + 1);
      }

      for(let i = pos; i < start; i++) cells[i] = 0;  // 回滚间隙
    }
  }

  go(0, 0);
}

/** 一行能推出的结论：返回 {ok, force[]}，force = 0 未知 / 1 必填 / 2 必空 */
function lineForce(n, runs, state){
  const can1 = new Array(n).fill(false);
  const can0 = new Array(n).fill(false);
  let count = 0;

  enumLine(n, runs, state, (cells) => {
    count++;
    for(let i = 0; i < n; i++){
      if(cells[i] === 1) can1[i] = true;
      else can0[i] = true;
    }
  });

  if(!count) return { ok:false, force:null };
  const force = new Array(n).fill(0);
  for(let i = 0; i < n; i++){
    if(can1[i] && !can0[i]) force[i] = 1;
    else if(!can1[i] && can0[i]) force[i] = 2;
  }
  return { ok:true, force, count };
}

/* ------------------------------------------------------------ 传播 */
function propagate(state, rows, cols, n, m){
  let changed = true, guard = 0;
  while(changed){
    changed = false;
    if(++guard > 400) break;   // 理论上不会，兜底防死循环

    for(let r = 0; r < n; r++){
      const line = state[r];
      const res = lineForce(m, rows[r], line);
      if(!res.ok) return false;
      for(let c = 0; c < m; c++){
        if(line[c] === 0 && res.force[c]){
          line[c] = res.force[c];
          changed = true;
        }else if(line[c] !== 0 && res.force[c] && line[c] !== res.force[c]){
          return false;   // 与已知矛盾
        }
      }
    }

    for(let c = 0; c < m; c++){
      const line = new Array(n);
      for(let r = 0; r < n; r++) line[r] = state[r][c];
      const res = lineForce(n, cols[c], line);
      if(!res.ok) return false;
      for(let r = 0; r < n; r++){
        if(line[r] === 0 && res.force[r]){
          state[r][c] = res.force[r];
          changed = true;
        }else if(line[r] !== 0 && res.force[r] && line[r] !== res.force[r]){
          return false;
        }
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------ 计数 */
function countSolutions(state, rows, cols, n, m, limit, budget){
  if(budget.nodes++ > budget.max) throw new Error('搜索超时');
  if(!propagate(state, rows, cols, n, m)) return 0;

  let best = -1, bestOpts = 99;
  for(let r = 0; r < n; r++){
    for(let c = 0; c < m; c++){
      if(state[r][c] === 0){
        // 启发式：挑「该行已知信息最多」的那个未知格 —— 简单起见就取第一个
        if(best < 0){ best = r * m + c; }
      }
    }
    if(best >= 0) break;
  }
  if(best < 0) return 1;   // 全定 → 一个解

  const r0 = (best / m) | 0, c0 = best % m;
  let total = 0;
  for(const guess of [1, 2]){
    const copy = state.map(row => row.slice());
    copy[r0][c0] = guess;
    total += countSolutions(copy, rows, cols, n, m, limit, budget);
    if(total >= limit) return total;
  }
  return total;
}

/* ------------------------------------------------------------ 单关分析 */
function analyze(L){
  const n = L.n;
  if(!Array.isArray(L.art) || L.art.length !== n) throw new Error('art 行数不对');
  const ans = [];
  for(let r = 0; r < n; r++){
    const row = L.art[r];
    if(typeof row !== 'string' || row.length !== n){
      throw new Error('第 ' + (r + 1) + ' 行长度不是 ' + n + '：' + JSON.stringify(row));
    }
    if(/[^#.]/.test(row)) throw new Error('第 ' + (r + 1) + ' 行有非法字符：' + row);
    ans.push([...row].map(ch => ch === '#' ? 1 : 0));
  }
  const rows = ans.map(r => clueOf(r.map(v => v === 1)));
  const cols = [];
  for(let c = 0; c < n; c++) cols.push(clueOf(ans.map(r => r[c] === 1)));

  // 1) 纯逻辑：从全未知开始传播，能否全部填满
  const start = Array.from({ length: n }, () => new Array(n).fill(0));
  const logicOk = propagate(start, rows, cols, n, n);
  let known = 0;
  if(logicOk) for(const row of start) for(const v of row) if(v) known++;

  // 2) 唯一性
  let sols;
  try{
    sols = countSolutions(
      Array.from({ length: n }, () => new Array(n).fill(0)),
      rows, cols, n, n, 2, { nodes:0, max: 60000 }
    );
  }catch(e){ sols = -1; }

  // 3) 自检：用答案当状态，lineForce 不能报矛盾（说明线索算对了）
  let selfOk = true;
  for(let r = 0; r < n; r++){
    const res = lineForce(n, rows[r], ans[r].map(v => v === 1 ? 1 : 2));
    if(!res.ok) selfOk = false;
  }

  return {
    name: L.name || '(无名)', n, rows, cols, sols, logicOk, known,
    total: n * n, selfOk,
    filled: ans.reduce((a, r) => a + r.filter(Boolean).length, 0)
  };
}

/* ------------------------------------------------------------ 输出 */
function show(L, r){
  const n = L.n;
  console.log('\n  ┌' + '─'.repeat(n * 2 + 1) + '┐');
  L.art.forEach((row, i) => {
    const cells = [...row].map(ch => ch === '#' ? '██' : '  ').join('');
    const cl = r.rows[i].join(' ');
    console.log(String(i + 1).padStart(2, ' ') + '│ ' + cells + ' │ ' + cl);
  });
  console.log('  └' + '─'.repeat(n * 2 + 1) + '┘');
  console.log('     ' + r.cols.map(c => c[0]).map(v => String(v).padStart(2, ' ')).join(' '));
}

function main(){
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--show') || argv.includes('-v');
  const src = fs.readFileSync(HTML, 'utf8');
  const levels = extractLevels(src);

  console.log('数织关卡校验 · ' + levels.length + ' 关');
  console.log('（unique = 只有一种解；logic = 只靠单行推理就能推完，不用猜）\n');

  let bad = 0;
  const lines = [];
  levels.forEach((L, i) => {
    let r;
    try{
      r = analyze(L);
    }catch(e){
      bad++;
      console.log('  ✗ 第 ' + (i + 1) + ' 关 ' + (L.name || '') + ' —— ' + e.message);
      return;
    }

    const unique = r.sols === 1;
    const logic  = r.logicOk && r.known === r.total;
    const ok = unique && logic && r.selfOk;
    if(!ok) bad++;

    const mark = ok ? '✓' : '✗';
    let why = [];
    if(!r.selfOk) why.push('线索自检失败');
    if(!unique) why.push(r.sols < 0 ? '解数未知（搜索超时）' : ('有 ' + r.sols + ' 个解'));
    if(!logic) why.push('传播后仍有 ' + (r.total - r.known) + ' 格推不出来');

    lines.push('  ' + mark + ' ' + String(i + 1).padStart(2, ' ') + '. ' +
      (r.n + '×' + r.n).padEnd(7) + r.name.padEnd(7) +
      ' 涂 ' + String(r.filled).padStart(3) + ' 格' +
      '  行线索≤' + Math.max(...r.rows.map(a => a.length)) +
      '  列线索≤' + Math.max(...r.cols.map(a => a.length)) +
      (why.length ? '  ← ' + why.join('；') : ''));

    if(verbose) show(L, r);
  });

  console.log(lines.join('\n'));
  console.log('\n' + (bad ? '✗ ' + bad + ' 关不合格' : '✓ 全部 ' + levels.length + ' 关合格'));

  /* 尺寸/线索长度的统计，用来决定界面上留多少空间 */
  const stats = {};
  levels.forEach(L => {
    const r = analyze(L);
    stats[r.n] = stats[r.n] || { maxRow: 0, maxCol: 0, count: 0 };
    stats[r.n].count++;
    stats[r.n].maxRow = Math.max(stats[r.n].maxRow, ...r.rows.map(a => a.length));
    stats[r.n].maxCol = Math.max(stats[r.n].maxCol, ...r.cols.map(a => a.length));
  });
  console.log('\n线索区最大格数（界面按这个留位置）：');
  Object.keys(stats).forEach(k => {
    console.log('  ' + k + '×' + k + '  ×' + stats[k].count + ' 关 → 行最多 ' +
      stats[k].maxRow + ' 个数字，列最多 ' + stats[k].maxCol + ' 个');
  });

  process.exit(bad ? 1 : 0);
}

if(require.main === module) main();

module.exports = { analyze, extractLevels, clueOf, lineForce, propagate, enumLine };
