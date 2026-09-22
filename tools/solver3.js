#!/usr/bin/env node
'use strict';
/**
 * 仓库番求解器（JS 版，V8 比 CPython 快一个数量级）。
 *
 * 算法与 tools/solver3.py 一致：
 *   · 死格预判（pull-reachability）：从目标反向拉箱子能到的格子才是活格
 *   · 2x2 冻结块：四格全是墙或箱子 ⇒ 其中非目标箱永久卡死
 *   · A*：h = 盒子到目标的最小代价完美匹配（各目标 BFS 距离 + 匈牙利算法）
 *     weight=1 可采纳 ⇒ 推动数最优；weight>1 加权 ⇒ 快但只是某个解；weight=0 纯贪心
 *
 * ★ 关键实现坑（第一版写错过）：父节点的箱子布局与子节点的箱子布局必须用**两个不同的数组**。
 *   子节点要做区域 BFS（要用新布局做障碍），父节点要判 ahead/stand（要用旧布局）。
 *   共用一个数组会让候选之间互相污染 ⇒ 搜索空间错乱，表现为「求出的解重放失败」或假的 dead。
 *
 * 用法：node tools/solver3.js <关卡文件.txt> [秒数] [weight] [关卡id过滤]
 */
const fs = require('fs');

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIRCH = ['U', 'D', 'L', 'R'];
const BIG = 1e6;

function parseLevel(lines) {
  const W = Math.max(...lines.map(l => l.length));
  const grid = lines.map(l => l.padEnd(W, ' '));
  const H = grid.length;
  const walls = new Uint8Array(H * W);
  const goals = new Uint8Array(H * W);
  const boxes = [];
  let player = -1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const ch = grid[r][c], i = r * W + c;
      if (ch === '#') walls[i] = 1;
      else if (ch === '.') goals[i] = 1;
      else if (ch === '$') boxes.push(i);
      else if (ch === '*') { boxes.push(i); goals[i] = 1; }
      else if (ch === '@') player = i;
      else if (ch === '+') { player = i; goals[i] = 1; }
      else if (ch !== ' ') throw new Error(`非法字符 ${ch} @(${r},${c})`);
    }
  }
  if (player < 0) throw new Error('缺少玩家');
  if (!boxes.length) throw new Error('没有箱子');
  const goalList = [];
  for (let i = 0; i < H * W; i++) if (goals[i]) goalList.push(i);
  if (boxes.length !== goalList.length)
    throw new Error(`箱子数 ${boxes.length} != 目标数 ${goalList.length}`);
  boxes.sort((a, b) => a - b);
  return { H, W, walls, goals, boxes, player, goalList, grid };
}

function pullReachable(L) {
  const { H, W, walls, goalList } = L;
  const alive = new Uint8Array(H * W);
  const stack = [];
  for (const g of goalList) { alive[g] = 1; stack.push(g); }
  while (stack.length) {
    const y = stack.pop(), yr = (y / W) | 0, yc = y % W;
    for (let di = 0; di < 4; di++) {
      const dr = DIRS[di][0], dc = DIRS[di][1];
      const xr = yr - dr, xc = yc - dc;             // 箱子推动前的位置
      const sr = yr - 2 * dr, sc = yc - 2 * dc;     // 当时玩家站的位置
      if (xr < 0 || xr >= H || xc < 0 || xc >= W) continue;
      if (sr < 0 || sr >= H || sc < 0 || sc >= W) continue;
      const x = xr * W + xc, s = sr * W + sc;
      if (walls[x] || walls[s] || alive[x]) continue;
      alive[x] = 1;
      stack.push(x);
    }
  }
  return alive;
}

function bfsDist(L, start) {
  const { H, W, walls } = L;
  const dist = new Int32Array(H * W).fill(-1);
  const q = new Int32Array(H * W);
  let qh = 0, qt = 0;
  dist[start] = 0; q[qt++] = start;
  while (qh < qt) {
    const cur = q[qh++], r = (cur / W) | 0, c = cur % W;
    for (let di = 0; di < 4; di++) {
      const nr = r + DIRS[di][0], nc = c + DIRS[di][1];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const n = nr * W + nc;
      if (walls[n] || dist[n] >= 0) continue;
      dist[n] = dist[cur] + 1;
      q[qt++] = n;
    }
  }
  return dist;
}

function hungarian(cost, n) {
  const INF = Infinity;
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(INF);
    const used = new Uint8Array(n + 1);
    for (;;) {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
      if (p[j0] === 0) break;
    }
    for (;;) {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
      if (j0 === 0) break;
    }
  }
  return -v[0];
}

class Solver {
  constructor(L) {
    this.L = L;
    const { H, W } = L;
    this.N = H * W;
    this.alive = pullReachable(L);
    this.gdist = L.goalList.map(g => bfsDist(L, g));
    this.minGoalDist = new Int32Array(this.N).fill(BIG);
    for (let i = 0; i < this.N; i++) {
      if (L.walls[i]) continue;
      let m = BIG;
      for (const d of this.gdist) if (d[i] >= 0 && d[i] < m) m = d[i];
      this.minGoalDist[i] = m;
    }
    this.goalsKey = L.goalList.slice().sort((a, b) => a - b).join(',');
    this.hcache = new Map();
    // ★ 两套箱子布局数组：父节点判定用 curBox，子节点区域 BFS 用 nxtBox
    this.curBox = new Uint8Array(this.N);
    this.nxtBox = new Uint8Array(this.N);
    this.bset = new Uint8Array(this.N);
    this.stampA = new Int32Array(this.N);
    this.stampB = new Int32Array(this.N);
    this.smarkA = 0;
    this.smarkB = 0;
    this.curStamp = this.stampA;
    this.curMark = 0;
    this.rq = new Int32Array(this.N);
    this.hstack = [];
    this.nbsBuf = [];
  }

  static fill(arr, boxes) { arr.fill(0); for (let i = 0; i < boxes.length; i++) arr[boxes[i]] = 1; }

  boxDead(boxes) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!this.L.goals[b] && !this.alive[b]) return true;
    }
    return false;
  }

  frozen2x2(boxes) {
    const { W, H, walls, goals } = this.L;
    const bset = this.bset;
    Solver.fill(bset, boxes);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i], r = (b / W) | 0, c = b % W;
      for (let dr = -1; dr <= 0; dr++) {
        for (let dc = -1; dc <= 0; dc++) {
          const r0 = r + dr, c0 = c + dc;
          if (r0 < 0 || c0 < 0 || r0 + 1 >= H || c0 + 1 >= W) continue;
          const q0 = r0 * W + c0, q1 = q0 + 1, q2 = q0 + W, q3 = q2 + 1;
          let allBlocked = true, badBox = false;
          for (const x of [q0, q1, q2, q3]) {
            if (bset[x]) { if (!goals[x]) badBox = true; }
            else if (!walls[x]) { allBlocked = false; break; }
          }
          if (allBlocked && badBox) return true;
        }
      }
    }
    return false;
  }

  heuristic(key, boxes) {
    const hit = this.hcache.get(key);
    if (hit !== undefined) return hit;
    let val;
    const n = boxes.length;
    if (n === 1) {
      val = this.minGoalDist[boxes[0]];
    } else {
      const cost = [];
      for (let i = 0; i < n; i++) {
        const b = boxes[i], row = new Array(n);
        for (let j = 0; j < n; j++) { const d = this.gdist[j][b]; row[j] = d < 0 ? BIG : d; }
        cost.push(row);
      }
      val = hungarian(cost, n);
    }
    this.hcache.set(key, val);
    return val;
  }

  /** 从 start 出发（blockArr 为障碍）的连通分量最小值；stampArr 是时间戳数组 */
  regionMin(start, blockArr, stampArr) {
    const { H, W, walls } = this.L;
    const mark = (stampArr === this.stampA ? ++this.smarkA : ++this.smarkB);
    const q = this.rq;
    let qh = 0, qt = 0;
    q[qt++] = start; stampArr[start] = mark;
    let min = start;
    while (qh < qt) {
      const cur = q[qh++], r = (cur / W) | 0, c = cur % W;
      if (cur < min) min = cur;
      for (let di = 0; di < 4; di++) {
        const nr = r + DIRS[di][0], nc = c + DIRS[di][1];
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        const n = nr * W + nc;
        if (walls[n] || blockArr[n] || stampArr[n] === mark) continue;
        stampArr[n] = mark;
        q[qt++] = n;
      }
    }
    this.lastMark = mark;
    this.lastStamp = stampArr;
    return min;
  }

  regionContains(cell) { return this.curStamp[cell] === this.curMark; }

  solve(opts) {
    // ★ maxStates 是内存闸门：每个状态在 bestG/parent 两个 Map 里各留一份，
    //   实测 ~4e6 状态就会把 Node 默认堆（≈2GB）打爆。默认压到 1.2e6，
    //   要啃更深的盘面就配 --max-old-space-size 并显式调大这个值。
    const { timeBudget = 0, maxStates = 1_200_000, weight = 1 } = opts || {};
    const t0 = Date.now();
    const L = this.L;
    const boxes0 = L.boxes.slice();
    const isSolved = bs => bs.join(',') === this.goalsKey;
    if (isSolved(boxes0)) return { status: 'ok', pushes: 0, chain: [], states: 0, secs: 0 };
    if (this.boxDead(boxes0) || this.frozen2x2(boxes0))
      return { status: 'dead', states: 0, secs: 0 };
    Solver.fill(this.curBox, boxes0);
    const h0 = this.heuristic(boxes0.join(','), boxes0);
    if (h0 >= BIG) return { status: 'dead', states: 0, secs: 0 };

    const F = (g, h) => (weight <= 0 ? h : g + weight * h);
    const startKey = boxes0.join(',') + '|' + this.regionMin(L.player, this.curBox, this.stampA);

    const heap = [];
    const less = (a, b) => (a.f !== b.f ? a.f < b.f : a.g < b.g);
    const push = node => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (less(heap[i], heap[p])) { const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; }
        else break;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l], heap[m])) m = l;
          if (r < heap.length && less(heap[r], heap[m])) m = r;
          if (m === i) break;
          const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
        }
      }
      return top;
    };

    const bestG = new Map([[startKey, 0]]);
    const parent = new Map([[startKey, null]]);
    push({ f: F(0, h0), g: 0, boxes: boxes0, player: L.player, key: startKey });
    let n = 0, goalKey = null, goalG = 0;
    const { W } = L;
    const nbs = this.nbsBuf;

    while (heap.length) {
      const cur = pop();
      const knownG = bestG.get(cur.key);
      if (knownG === undefined || knownG < cur.g) continue;
      if (++n > maxStates) return { status: 'timeout', states: n, secs: (Date.now() - t0) / 1000 };
      if (timeBudget && (n & 255) === 0 && (Date.now() - t0) / 1000 > timeBudget)
        return { status: 'timeout', states: n, secs: (Date.now() - t0) / 1000 };

      const boxes = cur.boxes;
      // ★ 最优性要求「目标态被弹出」而不是「刚生成」就返回：
      //   h 是可采纳且一致的（一次推动最多改变 h 一个单位），所以弹出时的 g 才是最优推动数。
      if (boxes.length === L.goalList.length && boxes.join(',') === this.goalsKey) {
        goalKey = cur.key; goalG = cur.g; break;
      }
      Solver.fill(this.curBox, boxes);                       // 父布局
      this.regionMin(cur.player, this.curBox, this.stampA);  // 父区域
      this.curStamp = this.stampA;
      this.curMark = this.lastMark;

      outer:
      for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi], br = (b / W) | 0, bc = b % W;
        for (let di = 0; di < 4; di++) {
          const dr = DIRS[di][0], dc = DIRS[di][1];
          const ar = br + dr, ac = bc + dc;
          if (ar < 0 || ar >= L.H || ac < 0 || ac >= W) continue;
          const ahead = ar * W + ac;
          if (L.walls[ahead] || this.curBox[ahead]) continue;     // ← 用父布局
          const sr = br - dr, sc = bc - dc;
          if (sr < 0 || sr >= L.H || sc < 0 || sc >= W) continue;
          if (!this.regionContains(sr * W + sc)) continue;        // ← 父区域

          // 新箱子布局：把第 bi 个箱子换成 ahead，然后排一次序（箱子数 ≤12，代价可忽略）
          nbs.length = 0;
          for (let k = 0; k < boxes.length; k++) nbs.push(k === bi ? ahead : boxes[k]);
          nbs.sort((x, y) => x - y);

          if (this.boxDead(nbs) || this.frozen2x2(nbs)) continue;
          Solver.fill(this.nxtBox, nbs);
          const rmin = this.regionMin(b, this.nxtBox, this.stampB); // ← 子布局 + 独立时间戳
          const nkey = nbs.join(',') + '|' + rmin;
          const ng = cur.g + 1;
          const prev = bestG.get(nkey);
          if (prev !== undefined && prev <= ng) continue;
          bestG.set(nkey, ng);
          parent.set(nkey, { key: cur.key, from: b, to: ahead });

          const hh = this.heuristic(nbs.join(','), nbs);
          if (hh >= BIG) continue;
          push({ f: F(ng, hh), g: ng, boxes: nbs.slice(), player: b, key: nkey });
        }
      }
      if (goalKey) break;
    }
    if (goalKey === null) return { status: 'dead', states: n, secs: (Date.now() - t0) / 1000 };

    const chain = [];
    let k = goalKey;
    while (parent.get(k)) {
      const e = parent.get(k);
      chain.push([e.from, e.to]);
      k = e.key;
    }
    chain.reverse();
    return { status: 'ok', pushes: goalG, chain, states: n, secs: (Date.now() - t0) / 1000 };
  }
}

/** 推动序列 → 完整按键串（每步先最短路径走到箱后，再推） */
function movesFromPushes(L, chain, startPlayer) {
  const { H, W, walls } = L;
  const boxAt = new Uint8Array(H * W);
  Solver.fill(boxAt, L.boxes);
  let p = startPlayer === undefined ? L.player : startPlayer;
  const out = [];
  const prev = new Int32Array(H * W);
  const pd = new Int8Array(H * W);

  function bfsPath(src, dst) {
    if (src === dst) return [];
    prev.fill(-2);
    const q = new Int32Array(H * W);
    let qh = 0, qt = 0;
    q[qt++] = src; prev[src] = -1;
    while (qh < qt) {
      const cur = q[qh++], r = (cur / W) | 0, c = cur % W;
      for (let di = 0; di < 4; di++) {
        const nr = r + DIRS[di][0], nc = c + DIRS[di][1];
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        const nb = nr * W + nc;
        if (prev[nb] !== -2 || walls[nb] || boxAt[nb]) continue;
        prev[nb] = cur; pd[nb] = di;
        if (nb === dst) {
          const path = [];
          let x = nb;
          while (prev[x] !== -1) { path.push(DIRCH[pd[x]]); x = prev[x]; }
          return path.reverse();
        }
        q[qt++] = nb;
      }
    }
    return null;
  }

  for (const [from, to] of chain) {
    const fr = (from / W) | 0, fc = from % W, tr = (to / W) | 0, tc = to % W;
    const dr = tr - fr, dc = tc - fc;
    const stand = (fr - dr) * W + (fc - dc);
    const path = bfsPath(p, stand);
    if (path === null) return null;
    out.push(...path);
    for (let di = 0; di < 4; di++) if (DIRS[di][0] === dr && DIRS[di][1] === dc) { out.push(DIRCH[di]); break; }
    boxAt[from] = 0; boxAt[to] = 1;
    p = from;
  }
  return out.join('');
}

function solveLevel(lines, opts) {
  const L = parseLevel(lines);
  const s = new Solver(L);
  const r = s.solve(opts);
  if (r.status !== 'ok') return r;
  const sol = movesFromPushes(L, r.chain);
  if (sol === null) return { status: 'replay-failed', pushes: r.pushes, states: r.states, secs: r.secs };
  return { status: 'ok', pushes: r.pushes, moves: sol.length, sol,
           states: r.states, secs: r.secs, optimal: (opts && opts.weight === 1) };
}

function splitLevels(raw) {
  const out = [];
  for (const blk of raw.split(/\n\s*---\s*\n/)) {
    if (!blk.trim()) continue;
    const lines = blk.split('\n').map(l => l.replace(/\r$/, ''));
    const nameLine = lines.find(l => l.trim().startsWith(';'));
    const name = nameLine ? nameLine.replace(/^[;\s]+/, '').trim() : '?';
    const rows = lines.filter(l => l.trim() && !l.trim().startsWith(';') && /^[# .$*@+]+$/.test(l.trim()));
    if (rows.length) out.push({ name, rows });
  }
  return out;
}

module.exports = { parseLevel, Solver, solveLevel, splitLevels, movesFromPushes };

if (require.main === module) {
  const file = process.argv[2];
  const budget = parseFloat(process.argv[3] || '60');
  const weight = process.argv[4] === undefined ? 1 : parseFloat(process.argv[4]);
  const filter = process.argv[5];
  const levels = splitLevels(fs.readFileSync(file, 'utf8'));
  for (const lv of levels) {
    const id = lv.name.split(/\s+/)[0];
    if (filter && id !== filter) continue;
    let r;
    const t0 = Date.now();
    try { r = solveLevel(lv.rows, { timeBudget: budget, weight }); }
    catch (e) { console.log(`${id}\tERROR\t${e.message}`); continue; }
    console.log(`${id}\t${r.status}\t推=${r.pushes ?? '-'}\t步=${r.moves ?? '-'}\t状态=${r.states}\t${((Date.now() - t0) / 1000).toFixed(2)}s` + (r.optimal ? '\t最优' : ''));
  }
}
