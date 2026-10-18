#!/usr/bin/env node
/**
 * 24 点关卡生成器
 *
 * 做法：
 *   1) 从 web/24point/index.html 里抠出 /*<<SOLVER>>* / 之间的求解器（唯一事实来源，避免两份代码漂移）
 *   2) 枚举 4 张牌（A~K，1~13）的全部多重组合 C(13+4-1,4)=1820 种
 *   3) 用求解器算出每种组合「不同解法」的个数，按难度分档
 *   4) 按档位挑选、排序，回填进 index.html 的 LEVELS_BEGIN / LEVELS_END 之间
 *
 * 难度直觉：
 *   - 解法多 = 随便凑凑就能成 → 入门
 *   - 解法少 = 只有一条路 → 大师
 *   - 需要「先除出一个分数」才能凑到 24（如 3 3 8 8 → 8/(3-8/3)）→ 额外加难
 *
 * 用法：node tools/gen_24point_levels.js [--dry]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'web', '24point', 'index.html');
const PER_TIER = 30;

/* ---------- 1) 抠求解器 ---------- */
const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/\/\*<<SOLVER>>\*\/([\s\S]*?)\/\*<<\/SOLVER>>\*\//);
if (!m) { console.error('index.html 里找不到 SOLVER 标记'); process.exit(1); }

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(m[1] + '\n;this.__api = { solveTrees, countSolutions, solveOne, exprStr, canon, leaf, fr, fStr, findLeafStep, TARGET };', ctx);
const A = ctx.__api;

/* ---------- 2) 枚举多重组合 ---------- */
const combos = [];
(function gen(start, picked) {
  if (picked.length === 4) { combos.push(picked.slice()); return; }
  for (let v = start; v <= 13; v++) { picked.push(v); gen(v, picked); picked.pop(); }
})(1, []);

/* ---------- 3) 逐个评估 ---------- */
// 是否「所有解法都必须先造出一个分数」—— 这才是真正难想的那类（3 3 8 8 → 8÷(3−8÷3)）
// 只要存在一条全程整数的路子，就不算：玩家可以走那条。
function needsFraction(nums) {
  const trees = A.solveTrees(nums.map(n => A.leaf(A.fr(n))));
  if (!trees.length) return false;
  return trees.every(t => {
    let frac = false;
    (function walk(n) {
      if (n.k === 0) return;
      if (n.v.d !== 1) frac = true;
      walk(n.a); walk(n.b);
    })(t);
    return frac;
  });
}

const stats = combos.map(nums => {
  const trees = A.solveTrees(nums.map(n => A.leaf(A.fr(n))));
  const uniq = new Set(trees.map(t => A.canon(t)));
  const sum = nums.reduce((a, b) => a + b, 0);
  const hasDup = new Set(nums).size < 4;
  // 最优解的表达式长度：短 = 好想
  let bestLen = Infinity;
  for (const t of trees) bestLen = Math.min(bestLen, A.exprStr(t).length);
  return {
    nums, n: uniq.size, sum, hasDup, bestLen,
    frac: uniq.size ? needsFraction(nums) : false,
    expr: uniq.size ? A.exprStr(A.solveOne(nums)) : null,
  };
});

const solvable = stats.filter(s => s.n > 0);
const dist = {};
for (const s of solvable) dist[s.n] = (dist[s.n] || 0) + 1;
console.log('可解组合：', solvable.length, '/', stats.length);
console.log('解法个数分布：', JSON.stringify(dist));
console.log('需要分数的组合：', solvable.filter(s => s.frac).length);

/* ---------- 4) 分档挑选 ---------- */

// 难度分：解法越少越难；需要分数 +2；牌面有重复略降（重复牌容易凑）
function hardness(s) {
  return (10 - Math.min(s.n, 10)) * 1.0 + (s.frac ? 2.5 : 0) + (s.hasDup ? -0.6 : 0);
}

// 从候选里等距抽 k 个（保证牌面多样，不老是同一批数字）
function spread(list, k) {
  if (list.length <= k) return list.slice();
  const out = [];
  for (let i = 0; i < k; i++) out.push(list[Math.round(i * (list.length - 1) / (k - 1))]);
  return out;
}

function pickTier(pool, k, keyFn) {
  const sorted = pool.slice().sort((a, b) => keyFn(a) - keyFn(b) || (a.nums.join() < b.nums.join() ? -1 : 1));
  return spread(sorted, k);
}
function cmpNums(a, b) { return a.nums.join() < b.nums.join() ? -1 : 1; }

// 入门：解法 >= 5，且全程不用分数，优先无重复牌；解法多的排前面
const easyPool = solvable.filter(s => s.n >= 5 && !s.frac);
const easy = pickTier(easyPool, PER_TIER, s => -s.n + (s.hasDup ? 3 : 0));

// 进阶：解法 2~4，仍然全程整数（要分数的都留给大师）
const midPool = solvable.filter(s => s.n >= 2 && s.n <= 4 && !s.frac);
const mid = pickTier(midPool, PER_TIER, s => s.n);

// 大师：唯一解。先放「走整数路能到」的，再把「必须先造分数」的排在最后压轴
// （3 3 8 8 这种是 24 点最出名的大魔王，放到最后一关）
const FAME = ['3,3,8,8'];
const fracOnes = solvable.filter(s => s.n === 1 && s.frac).sort((a, b) => {
  const fa = FAME.indexOf(a.nums.join(',')) >= 0 ? 1 : 0;
  const fb = FAME.indexOf(b.nums.join(',')) >= 0 ? 1 : 0;
  if (fa !== fb) return fa - fb;
  return a.sum - b.sum || cmpNums(a, b);
});
const plainOnes = solvable.filter(s => s.n === 1 && !s.frac);
const hard = pickTier(plainOnes, PER_TIER - fracOnes.length, s => s.sum + (s.hasDup ? -2 : 0))
  .concat(fracOnes);

function dedupe(list) {
  const seen = new Set();
  return list.filter(s => {
    const k = s.nums.join(',');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const tiers = [dedupe(easy), dedupe(mid), dedupe(hard)];
const names = ['入门', '进阶', '大师'];
tiers.forEach((t, i) => {
  console.log(`\n== ${names[i]}：${t.length} 关 ==`);
  t.forEach((s, k) => {
    console.log(`  ${String(k + 1).padStart(2)}. [${s.nums.map(n => String(n).padStart(2)).join(' ')}]  ` +
                `解法 ${String(s.n).padStart(2)}  ${s.frac ? '需分数 ' : '       '}  ${s.expr}`);
  });
});

/* ---------- 5) 回填 ---------- */
const data = tiers.map(t => t.map(s => s.nums));
const json = JSON.stringify(data);

if (process.argv.includes('--dry')) {
  console.log('\n(--dry：不写回文件)');
  process.exit(0);
}

const re = /(\/\*LEVELS_BEGIN\*\/)[\s\S]*?(\/\*LEVELS_END\*\/)/;
if (!re.test(html)) { console.error('index.html 里找不到 LEVELS 标记'); process.exit(1); }
const out = html.replace(re, `$1${json}$2`);
fs.writeFileSync(HTML, out, 'utf8');
console.log(`\n已写回 ${path.relative(process.cwd(), HTML)}：${data.map(t => t.length).join(' + ')} = ` +
            `${data.reduce((a, t) => a + t.length, 0)} 关`);
