#!/usr/bin/env node
/**
 * AI 搜索崩溃 fuzz 测试（跑的是游戏文件里的真实代码文本）
 *   1) 从 othello/index.html 抽出「常量+状态变量」和「规则+AI 搜索」两段纯函数代码
 *   2) 随机对局造出大量近终局局面（45~59 手，跳过/终局密集）
 *   3) 对每个局面在多个难度深度上调用 aiPick，捕获任何异常（如爆栈）
 * 用法：
 *   node core_fuzz.js /tmp/othello_old.html 300   # 旧版对照：应当崩（证明测试有敏感度）
 *   node core_fuzz.js                             # 当前文件：应当 0 失败
 */
const fs = require('fs');
const vm = require('vm');

const HTML = process.argv[2] || '/opt/data/games/othello/index.html';
const ROUNDS = parseInt(process.argv[3] || '300', 10);
const DEPTHS = [4, 6];

const src = fs.readFileSync(HTML, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const constsStart = src.indexOf('const HUMAN = 1, AI = 2;');
const audioStart = src.indexOf('/* ---------- 音效');
const rulesStart = src.indexOf('/* ---------- 规则');
const fitStart = src.indexOf('/* ---------- 尺寸自适应');
if ([constsStart, audioStart, rulesStart, fitStart].some(x => x < 0)) {
  console.error('抽取失败：段落标记找不到'); process.exit(2);
}
const part1 = src.slice(constsStart, audioStart);      // HUMAN/AI、DIRS、W、状态变量（含 depth）
const part2 = src.slice(rulesStart, fitStart);         // 规则 + AI 搜索（纯函数）
const core = part1 + '\n' + part2 +
  '\nglobalThis.api = { fresh, flips, legalMoves, place, counts, evaluate, negamax, aiPick };\n' +
  'globalThis.setDepth = d => { depth = d; };\n';

const sandbox = { Math, JSON, console, isNaN, parseInt };
vm.createContext(sandbox);
vm.runInContext(core, sandbox, { filename: 'core-extract.js' });
const api = sandbox.api;

function boardStr(bd) {
  return bd.map(row => row.map(v => v === 0 ? '·' : v === 1 ? 'B' : 'W').join(' ')).join('\n');
}

let games = 0, calls = 0, failures = 0;
const samples = [];
for (let g = 0; g < ROUNDS; g++) {
  let bd = api.fresh(), turn = 1, plies = 0;
  const target = 45 + Math.floor(Math.random() * 15);          // 45~59 手：残局
  while (plies < target) {
    const mv = api.legalMoves(bd, turn);
    if (!mv.length) {
      if (!api.legalMoves(bd, 3 - turn).length) break;         // 双方都无子可下 ⇒ 终局
      turn = 3 - turn; continue;
    }
    const [r, c] = mv[Math.floor(Math.random() * mv.length)];
    bd = api.place(bd, r, c, turn);
    turn = 3 - turn; plies++;
  }
  games++;
  const empties = bd.flat().filter(v => v === 0).length;
  const aiMoves = api.legalMoves(bd, 2).length, humanMoves = api.legalMoves(bd, 1).length;
  for (const p of [1, 2]) {
    for (const d of DEPTHS) {
      calls++;
      try {
        sandbox.setDepth(d);
        const mv = api.aiPick(bd, p);
        if (mv && bd[mv[0]][mv[1]] !== 0) throw new Error('返回了非法落点');
      } catch (e) {
        failures++;
        if (samples.length < 3) samples.push({
          game: g + 1, plies, empties, aiMoves, humanMoves, searchDepth: d, player: p,
          err: e.constructor.name + ': ' + e.message, board: boardStr(bd),
        });
      }
    }
  }
}

console.log(JSON.stringify({
  file: HTML, games, aiCalls: calls, failures,
  verdict: failures === 0 ? 'PASS：搜索从未抛异常' : 'FAIL：搜索崩溃（bug 复现）',
  samples,
}, null, 1));
