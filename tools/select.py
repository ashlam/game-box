#!/usr/bin/env python3
"""从候选池里挑选难度递增的 11 关，加上入门关，输出最终关卡表。"""
import json

pool = json.load(open('/volume1/docker/hermes/files/bot_workspace/projects/games-box/tools/pool2.json'))
TUTORIAL = ["#####", "#@$.#", "#####"]
TARGETS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 15]   # 想要的推动数阶梯（递增）

chosen = [{"lines": TUTORIAL, "boxes": 1, "pushes": 1, "src": "tutorial"}]
used = set()
last = 1
for t in TARGETS:
    if t <= last:
        continue
    cands = [c for c in pool
             if c["pushes"] >= t and c["pushes"] > last and tuple(c["lines"]) not in used]
    if not cands:
        break                      # 池子里没有更难的了，就到此为止（不降级凑数）
    # 同难度优先箱子多、尺寸大的（更像正经谜题）
    cands.sort(key=lambda c: (c["pushes"], -c["boxes"], -len(c["lines"])))
    pick = cands[0]
    used.add(tuple(pick["lines"]))
    last = pick["pushes"]
    pick = dict(pick); pick["src"] = "generated"
    chosen.append(pick)

json.dump(chosen, open('/volume1/docker/hermes/files/bot_workspace/projects/games-box/tools/final_levels.json', 'w'), ensure_ascii=False, indent=1)
print(f"选出 {len(chosen)} 关")
for i, c in enumerate(chosen, 1):
    print(f"  第{i:2d}关  箱子{c['boxes']}  最短推动{c['pushes']}  {len(c['lines'])}x{max(len(x) for x in c['lines'])}  {c['src']}")
