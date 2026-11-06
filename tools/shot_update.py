#!/usr/bin/env python3
"""给「检查更新」面板截图（仅用于肉眼核对样式，不改动正式页面）。

做法：把 web/index.html 复制到 ops/tmp/upd/ 下，在 </footer> 后面插一段假的
window.GamesBoxNative，再模拟点一下按钮，让面板停在某个状态，然后 Chrome 截图。

为什么要假接口：网页版根本没有 GamesBoxNative，不注入的话整块是 hidden 的，
截出来什么都没有。这里只桩住四个 I/O 方法，界面渲染跑的还是正式代码。

用法：python3 tools/shot_update.py
产物：ops/shots/upd-{found,latest,progress,ready,error,idle}.png
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web" / "index.html"
OUT = ROOT / "ops" / "tmp" / "upd"
SHOTS = ROOT / "ops" / "shots"

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")

INFO = ("{versionCode:41, versionName:'1.41', "
        "source:'http://192.168.1.10:4321/update.json', canInstall:true, sdk:34}")

FOUND_CALL = """
      window.__gboxUpdate({type:'found', current:41, remote:48, versionName:'1.48',
        size:6930432,
        notes:['新增「贪吃蛇」和「数独」两个游戏',
               '纸牌接龙：撤销之后分数没退回来，已修',
               '管理游戏里可以一键把藏起来的都放回去'],
        url:'http://192.168.1.10:4321/gamesbox-latest.apk'});
"""

WEB_OUT = 'http://192.168.1.10:4321/update.json'

STUB = """<script>
/* 仅截图用的假接口：真实 App 里这些方法由 Updater.java 提供 */
window.GamesBoxNative = {
  info: function(){ return JSON.stringify(%(info)s); },
  source: function(){ return %(src)r; },
  setSource: function(v){},
  cleanup: function(){},
  check: function(){ %(check)s },
  download: %(download)s,
  install: function(){},
  cancelDownload: function(){},
  openInBrowser: function(){}
};
/* 截图只看更新面板，收掉 21 张游戏卡，免得图长到没法看 */
try{ document.getElementById('grid').style.display = 'none'; }catch(e){}
setTimeout(function(){ document.getElementById('updBtn').click(); }, 40);
%(extra)s
</script>
"""

FRAME = """<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#0f1115">
<iframe src="%(name)s.html" style="width:400px;height:900px;border:0;display:block"
        scrolling="no"></iframe>
</body></html>
"""

NOOP = "function(){}"

FOUND = "setTimeout(function(){ " + FOUND_CALL + " }, 60);"
LATEST = ("setTimeout(function(){ window.__gboxUpdate({type:'latest', current:41, "
          "remote:41, versionName:'1.41', notes:[]}); }, 60);")
ERROR = ("setTimeout(function(){ window.__gboxUpdate({type:'error', "
         "message:'连不上更新源（地址写错了，或者不在同一个局域网）'}); }, 60);")

# 下载中：先拿到 found，再自动点「下载并安装」，进度一路涨到 62% 停住
PROGRESS_CHECK = FOUND
PROGRESS_DOWNLOAD = """function(){
    var i = 0;
    var t = setInterval(function(){
      i += 6;
      if(i > 62){ clearInterval(t); return; }
      window.__gboxUpdate({type:'progress', percent:i, got:i*69304, total:6930432});
    }, 70);
  }"""
PROGRESS_EXTRA = ("setTimeout(function(){ var b = document.querySelector('[data-act=download]');"
                  " if(b) b.click(); }, 220);")

READY_CHECK = FOUND
READY_DOWNLOAD = ("function(){ setTimeout(function(){ window.__gboxUpdate("
                  "{type:'ready', size:6930432}); }, 60); }")
READY_EXTRA = ("setTimeout(function(){ var b = document.querySelector('[data-act=download]');"
               " if(b) b.click(); }, 220);")

CASES = {
    "idle":     dict(check=NOOP, download=NOOP, extra=""),          # 不点按钮之前的样子
    "found":    dict(check=FOUND, download=NOOP, extra=""),
    "latest":   dict(check=LATEST, download=NOOP, extra=""),
    "error":    dict(check=ERROR, download=NOOP, extra=""),
    "progress": dict(check=PROGRESS_CHECK, download=PROGRESS_DOWNLOAD, extra=PROGRESS_EXTRA),
    "ready":    dict(check=READY_CHECK, download=READY_DOWNLOAD, extra=READY_EXTRA),
}


def build(name, cfg):
    html = WEB.read_text(encoding="utf-8")
    stub = STUB % dict(info=INFO, src=WEB_OUT, check=cfg["check"],
                       download=cfg["download"], extra=cfg["extra"])
    assert "</footer>" in html, "index.html 里找不到 </footer>"
    html = html.replace("</footer>", "</footer>\n" + stub, 1)
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / (name + ".html")
    p.write_text(html, encoding="utf-8")
    # 这台机器的 Chrome 会忽略 --window-size 的宽度（布局视口固定 500），
    # 所以套一层 400px 宽的 iframe，让它按手机宽度排版。
    f = OUT / (name + "_frame.html")
    f.write_text(FRAME % dict(name=name), encoding="utf-8")
    return f


def shoot(page, png):
    cmd = [str(CHROME), "--headless=new", "--disable-gpu", "--hide-scrollbars",
           "--force-device-scale-factor=2", "--window-size=400,900",
           "--virtual-time-budget=4000",
           "--screenshot=" + str(png), page.as_uri()]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stderr or "").strip()[-300:]


def main():
    if not CHROME.exists():
        print("找不到 Chrome: " + str(CHROME), file=sys.stderr)
        return 1
    SHOTS.mkdir(parents=True, exist_ok=True)

    wanted = sys.argv[1:] or list(CASES)
    bad = 0
    for name in wanted:
        if name not in CASES:
            print("未知状态: " + name, file=sys.stderr)
            return 2
        page = build(name, CASES[name])
        png = SHOTS / ("upd-" + name + ".png")
        code, err = shoot(page, png)
        if code != 0 or not png.exists():
            print("✗ %s 截图失败 %s" % (name, err))
            bad += 1
        else:
            print("✓ %s  %.0f KB" % (png.relative_to(ROOT), png.stat().st_size / 1024))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
