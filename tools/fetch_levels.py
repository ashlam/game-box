#!/usr/bin/env python3
"""找经典仓库番关卡集：列出候选仓库与其关卡文件。"""
import json
import urllib.request

def api(url):
    req = urllib.request.Request(url, headers={"User-Agent": "level-hunter", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)

print("=== 仓库搜索: microban ===")
for r in api("https://api.github.com/search/repositories?q=microban&per_page=8")["items"]:
    print(f"  {r['full_name']:45s} ★{r['stargazers_count']:<5d} {(r['description'] or '')[:70]}")

print("\n=== 仓库搜索: sokoban level collection xsb ===")
for r in api("https://api.github.com/search/repositories?q=sokoban+levels+in:name,description&per_page=12")["items"]:
    print(f"  {r['full_name']:45s} ★{r['stargazers_count']:<5d} {(r['description'] or '')[:70]}")

for repo in ["Alonso-del-Arte/sokoban-levels", "google-deepmind/boxoban-levels"]:
    print(f"\n=== {repo} 文件列表 ===")
    try:
        tree = api(f"https://api.github.com/repos/{repo}/git/trees/HEAD?recursive=1")
        for n in tree.get("tree", []):
            p = n["path"]
            if n["type"] == "blob" and not p.startswith(".") and any(
                    p.lower().endswith(e) for e in (".sok", ".xsb", ".txt", ".slc", ".json", ".md")):
                print(f"  {p}  ({n.get('size', 0)} bytes)")
    except Exception as e:
        print("  获取失败:", e)
