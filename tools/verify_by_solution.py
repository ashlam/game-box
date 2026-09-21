#!/usr/bin/env python3
"""解析经典关卡集（YASC .sok 格式）：每关的棋盘 + 官方记录解法 + 标题。
重放官方解法证明可解，并拿到「最少步数/推动数」难度数据。
规则与游戏内 JS 一致：越界=墙。"""
import json
import os
import re
import sys

DIRS = {'U': (-1, 0), 'D': (1, 0), 'L': (0, -1), 'R': (0, 1)}
BOARD_CHARS = set(" #.$*@+")
MOVE_CHARS = set("UDLRudlr")
SOL_RE = re.compile(r'^\s*(?:best\s+)?solution\s*[:\s]\s*(\d+)\s*/\s*(\d+)\s*$', re.I)
KEY_RE = re.compile(r'^\s*[A-Z][A-Za-z ]{2,20}:\s')


def parse_state(lines):
    w = max(len(l) for l in lines)
    g = [l.ljust(w) for l in lines]
    H, W = len(g), w
    walls, goals, boxes, player = set(), set(), set(), None
    for r in range(H):
        for c in range(W):
            ch = g[r][c]
            if ch == '#': walls.add((r, c))
            elif ch == '.': goals.add((r, c))
            elif ch == '$': boxes.add((r, c))
            elif ch == '*': boxes.add((r, c)); goals.add((r, c))
            elif ch == '@': player = (r, c)
            elif ch == '+': player = (r, c); goals.add((r, c))
    return H, W, walls, goals, set(boxes), player


def replay(lines, moves):
    H, W, walls, goals, boxes, player = parse_state(lines)
    if player is None or not boxes:
        return False, 0, 0, "棋盘缺玩家/箱子"
    pushes = 0
    for mv in moves:
        dr, dc = DIRS[mv.upper()]
        n = (player[0] + dr, player[1] + dc)
        if not (0 <= n[0] < H and 0 <= n[1] < W) or n in walls:
            return False, pushes, 0, "撞墙"
        if n in boxes:
            b2 = (n[0] + dr, n[1] + dc)
            if not (0 <= b2[0] < H and 0 <= b2[1] < W) or b2 in walls or b2 in boxes:
                return False, pushes, 0, "箱子推不动"
            boxes.discard(n); boxes.add(b2)
            pushes += 1
        player = n
    n_moves = len(moves)
    return boxes == goals, pushes, n_moves, "ok" if boxes == goals else "走完解法但箱子未全部归位"


def is_board(line):
    return line.strip() != "" and all(ch in BOARD_CHARS for ch in line) and any(ch in line for ch in "#$*@.")


def parse_file(path):
    lines = [l.rstrip("\r\n") for l in open(path, encoding="utf-8", errors="replace").read().splitlines()]
    # 找所有棋盘段
    boards = []
    i = 0
    while i < len(lines):
        if is_board(lines[i]):
            j = i
            while j < len(lines) and is_board(lines[j]):
                j += 1
            boards.append((i, j - 1))
            i = j
        else:
            i += 1

    out = []
    for idx, (s, e) in enumerate(boards, 1):
        board = lines[s:e + 1]
        if not any('@' in l or '+' in l for l in board):
            continue
        if not any('$' in l or '*' in l for l in board):
            continue
        nxt = boards[idx][0] if idx < len(boards) else len(lines)
        window = lines[e + 1:nxt]
        # 标题：棋盘前最近的一条非注释、非键值对文本行
        title = None
        for k in range(s - 1, max(0, s - 40), -1):
            t = lines[k].strip()
            if not t or t.startswith("::") or KEY_RE.match(t) or t.startswith("=="):
                continue
            title = t
            break
        # 解法：Solution a/b 行的后续连续方向字母行（可能是折行的多行）；或窗口里裸的方向字母行
        def run_from(k):
            """从 k 行起，收集连续的方向字母行。"""
            parts = []
            while k < len(window):
                t = window[k].strip()
                if t and set(t) <= MOVE_CHARS:
                    parts.append(t); k += 1
                else:
                    break
            return "".join(parts) if parts else None

        cands = []
        for k, l in enumerate(window):
            t = l.strip()
            m = SOL_RE.match(t.rstrip(") ").split("(")[0].strip()) or SOL_RE.match(t)
            if m:
                mv = run_from(k + 1)
                if mv:
                    cands.append((mv, int(m.group(1)), int(m.group(2))))
            elif t and set(t) <= MOVE_CHARS and len(t) >= 2:
                if k > 0 and window[k - 1].strip() and set(window[k - 1].strip()) <= MOVE_CHARS:
                    continue                      # 已作为折行的一部分收集过
                mv = run_from(k)
                if mv:
                    cands.append((mv, None, None))
        rec = {"i": idx, "title": title, "lines": board,
               "boxes": sum(l.count('$') + l.count('*') for l in board),
               "h": len(board), "w": max(len(l) for l in board),
               "declared": [{"moves": a, "pushes": b} for _, a, b in cands if a]}
        best = None
        for mv, a, b in cands:
            ok, pushes, moves, why = replay(board, mv)
            if ok:
                best = {"pushes": pushes, "moves": moves, "declared": f"{a}/{b}" if a else None,
                        "moves_str": mv}
                break
        rec["solvable"] = best is not None
        rec["sol"] = best
        rec["why"] = None if best else (why if cands else "文件未附解法")
        out.append(rec)
    return out


def main():
    out = {}
    for fname in sorted(os.listdir("/opt/data/games-tools/classic")):
        if not fname.endswith(".sok"):
            continue
        recs = parse_file(f"/opt/data/games-tools/classic/{fname}")
        ok = [r for r in recs if r["solvable"]]
        ps = [r["sol"]["pushes"] for r in ok]
        print(f"{fname:32s} 关 {len(recs):>3d}  验证可解 {len(ok):>3d}  推动数 {sorted(ps)}")
        for r in recs:
            if not r["solvable"]:
                print(f"    ⚠️ #{r['i']} {r['title']} -> {r['why']}（附带解法 {len(r['declared'])} 条）")
        out[fname] = recs
    json.dump(out, open("/opt/data/games-tools/classic_solutions.json", "w"), ensure_ascii=False)
    print("\n已写出 classic_solutions.json")


if __name__ == "__main__":
    main()
