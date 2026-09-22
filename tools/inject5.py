#!/usr/bin/env python3
"""把 tools/level_sets.json（两套关卡集）注入 sokoban/index.html。

做两件事：
  1) 用生成的 LEVEL_SETS 块替换代码里的 `const LEVEL_SETS = [ /* LEVEL_SETS_PLACEHOLDER */ ];`
  2) （兼容旧版）把遗留的 `const LEVELS = [...]` 整块删掉 —— 上一代是单关卡集写法
"""
import json
import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
PROJECT = TOOLS.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else TOOLS / "level_sets.json"
HTML = PROJECT / "web" / "sokoban" / "index.html"

PLACEHOLDER = r"  const LEVEL_SETS = \[ /\* LEVEL_SETS_PLACEHOLDER \*/ \];"


def js(s):
    return json.dumps(s, ensure_ascii=False)


def build(sets):
    out = ["  const LEVEL_SETS = ["]
    for s in sets:
        out.append("    {")
        out.append(f"      id: {js(s['id'])}, name: {js(s['name'])}, hint: {js(s['hint'])},")
        out.append("      levels: [")
        for l in s["levels"]:
            b = l["best"]
            maps = ", ".join(js(row) for row in l["map"])
            out.append(f"        {{tag: {js(l['tag'])}, name: {js(l['name'])}, "
                       f"best: {{pushes: {b['pushes']}, moves: {b['moves']}, opt: {'true' if b.get('opt') else 'false'}}}, "
                       f"map: [{maps}]}},")
        out.append("      ],")
        out.append("    },")
    out.append("  ];")
    return "\n".join(out)


def main():
    sets = json.loads(SRC.read_text(encoding="utf-8"))
    html = HTML.read_text(encoding="utf-8")

    block = build(sets)
    new, n = re.subn(PLACEHOLDER, lambda m: block, html, count=1)
    if n == 0:
        # 已经注入过：直接替换上一条生成的整块（保证脚本可重复执行）
        new, n = re.subn(r"  const LEVEL_SETS = \[[\s\S]*?\n  \];", lambda m: block, html, count=1)
        if n == 1:
            print("  占位符已不存在，改为替换上一条生成的 LEVEL_SETS 块")
    if n != 1:
        sys.exit(f"注入失败：LEVEL_SETS 占位符匹配 {n} 处")

    # 清掉上一代单关卡集的 LEVELS 数组（若还在）
    new, n2 = re.subn(r"  const LEVELS = \[[\s\S]*?\n  \];\n\n", "", new, count=1)
    if n2:
        print(f"  已移除遗留的旧 LEVELS 数组")

    # 收尾：不该再有对 LEVELS 的裸引用
    leftover = [m.start() for m in re.finditer(r"(?<!_)\bLEVELS\b(?!_)", new)]
    body = new[new.find("<script>"):]
    bad = [m.group(0) for m in re.finditer(r"\bLEVELS\b", body) if new[body.find(m.group(0)):body.find(m.group(0))+7] != "LEVELS"]
    refs = [m.start() for m in re.finditer(r"(?<![_\w])LEVELS(?![_\w])", new)]
    if refs:
        for r in refs[:5]:
            print("  ⚠️ 仍有裸 LEVELS 引用：", new[max(0, r - 60):r + 30].replace("\n", " "))

    HTML.write_text(new, encoding="utf-8")
    print(f"已注入 {len(sets)} 套关卡集 -> {HTML.relative_to(PROJECT)}")
    for s in sets:
        ps = [l["best"]["pushes"] for l in s["levels"]]
        nopt = sum(1 for l in s["levels"] if l["best"]["opt"])
        print(f"  {s['name']:<8} {len(s['levels']):>3} 关  推动 {min(ps)}→{max(ps)}  最优 {nopt}/{len(s['levels'])}")
        for l in s["levels"][:3]:
            print(f"      {l['tag']:<6} 推{l['best']['pushes']:>4} 步{l['best']['moves']:>4} "
                  f"{'最优' if l['best']['opt'] else '参考'}  {l['name']}")
        print("      ...")


if __name__ == "__main__":
    main()
