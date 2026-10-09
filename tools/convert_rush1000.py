#!/usr/bin/env python3
"""把 Fogleman rush1000.txt 转成本游戏的关卡数据

来源: https://www.michaelfogleman.com/static/rush/rush1000.txt
格式: <最少步数> <36字符盘面> <编号>
      盘面行主序 6x6，o=空，x=墙，A=目标车（经典约定：目标车横放在第 3 行、出口在右边第 3 行）
转换: 顺时针旋转 90°  →  出口变成「底部第 4 列」、目标车变成「竖直、朝下」
过滤: ① 不含墙 x　② 目标车 A 正好 2 格　③ 所有车只有 2/3 格　④ 长 3 的车 ≤ 5 辆
"""
import json, sys, pathlib

N = 6
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rush1000.txt'
BANDS = [('star1', '1 星', 1, 20, 29, 16),
         ('star2', '2 星', 2, 30, 37, 16),
         ('star3', '3 星', 3, 38, 999, 16)]
COLORS = ['#3b82f6','#22d3ee','#f59e0b','#ef4444','#a78bfa','#34d399','#e879f9','#fb7185',
          '#84cc16','#06b6d4','#f97316','#8b5cf6','#14b8a6','#eab308','#ec4899','#60a5fa']

def parse_board(s):
    """返回 [(letter, r, c)] 每格一个"""
    cells = []
    for i, ch in enumerate(s):
        if ch in ('o', 'x'): continue
        cells.append((ch, i // N, i % N))
    return cells

def cars_of(cells):
    """把同字母的格子合成车：返回 [{letter,r,c,len,dir}]"""
    by = {}
    for ch, r, c in cells:
        by.setdefault(ch, []).append((r, c))
    out = []
    for ch, cs in by.items():
        rs = [r for r, _ in cs]; col = [c for _, c in cs]
        r0, c0 = min(rs), min(col)
        h = (max(rs) - r0 + 1) == 1
        ln = (max(col) - c0 + 1) if h else (max(rs) - r0 + 1)
        out.append({'letter': ch, 'r': r0, 'c': c0, 'len': ln, 'dir': 'h' if h else 'v'})
    return out

def rot90cw(car):
    """顺时针 90°: 每格 (r,c) -> (c, N-1-r)；横车变竖车，新车左上角 = (c, N-1-r)"""
    return {'letter': car['letter'],
            'r': car['c'], 'c': N - 1 - car['r'],
            'len': car['len'],
            'dir': 'v' if car['dir'] == 'h' else 'h'}

def main():
    lines = pathlib.Path(SRC).read_text().strip().split('\n')
    bands = {b[0]: [] for b in BANDS}
    stats = {'total': 0, 'hasWall': 0, 'goalLen': 0, 'badLen': 0, 'tooMany3': 0, 'notAligned': 0, 'noBand': 0, 'ok': 0}
    movesAll = []
    for line in lines:
        parts = line.split()
        if len(parts) < 3: continue
        moves = int(parts[0]); board = parts[1]; no = parts[2]
        stats['total'] += 1
        movesAll.append(moves)
        if 'x' in board: stats['hasWall'] += 1; continue
        cars = cars_of(parse_board(board))
        goal = [c for c in cars if c['letter'] == 'A']
        if not goal or goal[0]['len'] != 2: stats['goalLen'] += 1; continue
        if any(c['len'] not in (2, 3) for c in cars): stats['badLen'] += 1; continue
        if len([c for c in cars if c['len'] == 3 and c['letter'] != 'A']) > 5: stats['tooMany3'] += 1; continue
        band = None
        for bid, name, stars, lo, hi, cnt in BANDS:
            if lo <= moves <= hi: band = (bid, name, stars, lo, hi, cnt); break
        if not band: stats['noBand'] += 1; continue
        # 旋转 + 出库方向校验：目标车必须在第 4 列、竖直、朝下
        rot = [rot90cw(c) for c in cars]
        g = [c for c in rot if c['letter'] == 'A'][0]
        if not (g['dir'] == 'v' and g['c'] == 3 and g['r'] + g['len'] <= N):
            stats['notAligned'] += 1; continue
        stats['ok'] += 1
        ci = 0
        out_cars = []
        for c in sorted(rot, key=lambda x: (x['letter'] != 'A', x['letter'])):
            isP = c['letter'] == 'A'
            out_cars.append({'r': c['r'], 'c': c['c'], 'len': c['len'], 'dir': c['dir'],
                             'color': '#111827' if isP else COLORS[ci % len(COLORS)], 'police': isP})
            if not isP: ci += 1
        bands[band[0]].append({'min': moves, 'src': no, 'cars': out_cars})
    sets = []
    for bid, name, stars, lo, hi, cnt in BANDS:
        got = bands[bid]
        # 每档按步数从易到难取前 cnt 关（并去重盘面）
        seen = set(); picked = []
        for g in sorted(got, key=lambda x: x['min']):
            sig = json.dumps(g['cars'], sort_keys=True)
            if sig in seen: continue
            seen.add(sig); picked.append(g)
            if len(picked) >= cnt: break
        levels = [{'id': i + 1, 'stars': stars, 'min': g['min'], 'mobile': len(g['cars']),
                   'src': g['src'], 'cars': g['cars']} for i, g in enumerate(picked)]
        sets.append({'id': bid, 'name': name, 'stars': stars, 'levels': levels})
        print('  %s: 可用池 %d → 取 %d 关 · 步数 %s' %
              (name, len(got), len(levels), '/'.join(str(l['min']) for l in levels)))
    print('过滤统计:', stats)
    print('步数范围: %d ~ %d' % (min(movesAll), max(movesAll)))
    import collections
    c = collections.Counter(movesAll)
    print('步数分布(前 12 档):', sorted(c.items(), reverse=True)[:12])
    out = {'n': N, 'exitEdge': 'bottom', 'exitCol': 3, 'policeLen': 2, 'source': 'michaelfogleman.com/static/rush/rush1000.txt', 'sets': sets}
    p = pathlib.Path(__file__).resolve().parent / 'parking_levels.json'
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print('已写入', p, '· 总计 %d 关' % sum(len(s['levels']) for s in sets))

main()
