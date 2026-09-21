#!/usr/bin/env python3
"""导出每关的参考解法，供浏览器端自动重放验收（临时文件，测完删除）。"""
import json

levels = json.load(open("/opt/data/games-tools/final_levels3.json"))
out = [{"no": l["no"], "name": l["name"], "sol": l["sol"], "best": l["best"]} for l in levels]
json.dump(out, open("/opt/data/games/sokoban/_test_solutions.json", "w"), ensure_ascii=False)
total = sum(len(l["sol"]) for l in levels)
print(f"已导出 {len(out)} 关解法，总步数 {total}")
print("最长解法:", max(len(l['sol']) for l in levels))
