#!/usr/bin/env python3
"""给数织生成一组核对用的截图（390×844，手机尺寸）。

为什么不用系统 Chrome：这台机器上 `/c/Program Files/.../chrome.exe` 会被
单实例机制接管、`--version` 都卡住。playwright 自带的 chromium 是干净的，
而且支持 `--window-size`（老版 Chrome headless 会忽略它，视口固定 500 宽）。

做法：复制一份页面到 ops/_tmp/，在 </body> 前插两段东西
  1) `*{transition:none!important;animation:none!important}`
     —— 虚拟时间下 CSS 动画不推进，不关掉就会截到「动画第一帧」
  2) 一段按场景摆弄局面的脚本（调 window.__nono 的调试接口）
**改完 web/ 一定要重跑本脚本**，否则截的是旧副本。

用法：python3 tools/shot_nonogram.py
产物：ops/shots/nono-<场景>.png
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'web', 'nonogram', 'index.html')
TMP = os.path.join(ROOT, 'ops', '_tmp')
OUT = os.path.join(ROOT, 'ops', 'shots')
CH = r'C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1124\chrome-win\chrome.exe'

W, H = 390, 844

COMMON = "document.getElementById('help').hidden = true;\n"

CASES = {
    # ---- 选关页：15 个关卡的排布、星级显示 ----
    'menu': COMMON,

    # ---- 5×5 空盘：最小尺寸下字够不够大 ----
    'play5': COMMON + """
__nono.start(0);
""",

    # ---- 5×5 涂到一半：能看到填色、叉、行提示变暗 ----
    'half5': COMMON + """
__nono.start(3);            // 小星星
var L = __nono.LEVELS()[3], n = L.n;
for (var r = 0; r < 3; r++) {
  for (var c = 0; c < n; c++) {
    if (L.ans[r][c]) __nono.setCell(r * n + c, 1);
  }
}
__nono.setMode('cross');
__nono.setCell(3 * n + 0, 2);
__nono.setCell(3 * n + 4, 2);
__nono.setMode('fill');
""",

    # ---- 10×10 玩到一半：主体体验 ----
    'play10': COMMON + """
__nono.start(5);            // 房子
var L = __nono.LEVELS()[5], n = L.n;
for (var r = 0; r < 6; r++) {
  for (var c = 0; c < n; c++) {
    if (L.ans[r][c]) __nono.setCell(r * n + c, 1);
  }
}
__nono.setMode('cross');
for (var c = 0; c < n; c++) {
  if (!L.ans[6][c]) __nono.setCell(6 * n + c, 2);
}
__nono.setMode('fill');
""",

    # ---- 15×15 空盘：最大网格，验证格子还点得中 ----
    'play15': COMMON + """
__nono.start(13);           // 火箭
""",

    # ---- 通关：整幅图变彩色。结算面板要藏掉，不然盖住画 ----
    'win': COMMON + """
__nono.start(5);            // 房子
__nono.fillAll();
setTimeout(function(){ document.getElementById('win').hidden = true; }, 900);
""",

    # ---- 结算面板 ----
    'result': COMMON + """
__nono.start(5);
__nono.fillAll();
""",

    # ---- 玩法说明（带 3×3 示意图）----
    'help': """
document.getElementById('help').hidden = false;
""",
}


def build(case):
    src = open(SRC, encoding='utf-8').read()
    code = CASES[case]
    inject = (
        "<style>*{transition:none!important;animation:none!important}"
        # Chrome 在 Windows 上有最小窗口宽度（约 500），--window-size=390 会被撑成 484，
        # 于是「手机布局」全按 484 算。锁死 body 宽度才能真正复现 390 宽的手机。
        "html{background:#0f1115}"
        "body{width:390px;margin:0 auto}"
        "</style>\n"
        "<script>\nwindow.addEventListener('load', function(){\n"
        "  setTimeout(function(){\n"
        "    try{ __nono.start; }catch(e){}\n"
        + code +
        "  }, 40);\n});\n</script>\n"
    )
    assert '</body>' in src
    out = src.replace('</body>', inject + '</body>')
    path = os.path.join(TMP, 'nono_%s.html' % case)
    open(path, 'w', encoding='utf-8').write(out)
    return path


def shot(case):
    path = build(case)
    png = os.path.join(OUT, 'nono-%s.png' % case)
    url = 'file:///' + path.replace(os.sep, '/')
    if not os.path.isdir(TMP):
        os.makedirs(TMP)
    cmd = [
        CH, '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + os.path.join(TMP, 'cprof'),
        '--window-size=%d,%d' % (W + 120, H),
        '--virtual-time-budget=6000',
        '--screenshot=' + png.replace(os.sep, '/'),
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if not os.path.exists(png):
        print(r.stdout[-800:])
        print(r.stderr[-800:])
        raise SystemExit('截图失败：' + case)

    # 截出来是窗口宽度，裁掉两侧，只留 390 宽的手机视野
    from PIL import Image
    im = Image.open(png)
    if im.width > W:
        left = (im.width - W) // 2
        im.crop((left, 0, left + W, min(H, im.height))).save(png)
    return png


def main():
    for d in (TMP, OUT):
        if not os.path.isdir(d):
            os.makedirs(d)
    if not os.path.exists(CH):
        raise SystemExit('找不到 chromium：' + CH)
    names = sys.argv[1:] or list(CASES)
    for c in names:
        if c not in CASES:
            print('跳过未知场景：' + c)
            continue
        p = shot(c)
        print('  %-30s %8d bytes' % (os.path.basename(p), os.path.getsize(p)))


if __name__ == '__main__':
    main()
