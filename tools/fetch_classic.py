#!/usr/bin/env python3
"""下载经典仓库番关卡集（原始文本），供难度分析筛选。"""
import os
import urllib.request

DEST = "/opt/data/games-tools/classic"
os.makedirs(DEST, exist_ok=True)

FILES = [
    ("https://raw.githubusercontent.com/Alonso-del-Arte/sokoban-levels/HEAD/sok/ExtremelyEasy.sok", "ExtremelyEasy.sok"),
    ("https://raw.githubusercontent.com/Alonso-del-Arte/sokoban-levels/HEAD/sok/SeeminglyHard.sok", "SeeminglyHard.sok"),
    ("https://raw.githubusercontent.com/Alonso-del-Arte/sokoban-levels/HEAD/sok/Laborious.sok", "Laborious.sok"),
    ("https://raw.githubusercontent.com/Alonso-del-Arte/sokoban-levels/HEAD/sok/Frustratingly%20Difficult.sok", "FrustratinglyDifficult.sok"),
    ("https://raw.githubusercontent.com/Alonso-del-Arte/sokoban-levels/HEAD/sok/IllustrativeLevels.sok", "IllustrativeLevels.sok"),
    ("https://raw.githubusercontent.com/google-deepmind/boxoban-levels/HEAD/hard/000.txt", "boxoban_hard_000.txt"),
    ("https://raw.githubusercontent.com/google-deepmind/boxoban-levels/HEAD/medium/train/000.txt", "boxoban_medium_000.txt"),
]

for url, name in FILES:
    path = os.path.join(DEST, name)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "level-hunter"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        open(path, "wb").write(data)
        text = data.decode("utf-8", "replace")
        # 粗略统计关卡数：以空行分隔的块
        blocks = [b for b in text.split("\n\n") if any(ch in b for ch in "#@$.*+")]
        print(f"✅ {name:28s} {len(data):>7d} bytes  ≈{len(blocks)} 关")
    except Exception as e:
        print(f"❌ {name:28s} 下载失败: {e}")
