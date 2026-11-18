#!/usr/bin/env python3
"""汉诺塔截图：一次截多张，用来看真机上的布局和状态。

为什么要这么绕（本机 Chrome headless 的脾气）：
  · --window-size=390 只决定**图片尺寸**，layout viewport 最小仍是 500px
    → 必须把页面自己锁成 390 宽，否则截出来的图右边被裁掉一截（踩过）
  · 虚拟时间（--virtual-time-budget）不推进 CSS transition / animation，
    截图会停在动画起点 → 副本里注入 *{transition:none!important}，位置立即生效
  · file:// 页面会被缓存，改完代码不清 profile 会截到上一次的旧图

不改动正式页面：所有注入都写进 web/hanoi/_shot.html（临时，跑完删）。
"""
import os, re, subprocess, sys, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'web', 'hanoi', 'index.html')
SHOT_HTML = os.path.join(ROOT, 'web', 'hanoi', '_shot.html')
OUT = os.path.join(ROOT, 'ops', 'shots')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
W, H = 390, 844

src = open(SRC, encoding='utf-8').read()

# 1) 锁宽 390 + 关掉所有过渡（虚拟时间不推进它们）
lock = (
    '<style>\n'
    '  /* 仅截图副本：锁手机宽度 + 关过渡 */\n'
    '  html,body{width:390px!important;max-width:390px!important;overflow:hidden!important}\n'
    '  *{transition:none!important;animation:none!important;will-change:auto!important}\n'
    '  /* fixed 元素按 innerWidth(=500) 定位，锁成 390 才不会被右边裁掉 */\n'
    '  .over,#confetti{left:0!important;right:auto!important;width:390px!important}\n'
    '  #toast{left:195px!important}\n'
    '</style>\n</head>'
)
assert '</head>' in src
out = src.replace('</head>', lock, 1)

# 2) 补两个截图用的内部钩子（正式文件里没有）
anchor = '  window.__hn = function(){'
assert anchor in out
hooks = (
    '  window.__hnSetMoves = function(v){ moves = v; hud(); };\n'
    '  window.__hnRefresh = function(ms){ refresh(ms || 0); };\n'
    '  window.__hnToastKeep = function(m){ toast(m, 60000); };\n'
    '  window.__hnShowOver = function(){ $("over").classList.add("on"); };\n'
    + anchor
)
out = out.replace(anchor, hooks, 1)

# 3) 场景脚本：按 URL 的 hash 跑不同局面
#    另外每 30ms 把盘的 transform 位置「烘焙」成 left/bottom ——
#    无头模式在虚拟时间下不提交 transform 的合成层（改 background 会变、改 transform 不变），
#    只有转成 paint 属性才能被截到。
SCENE = r'''
<script>
(function(){
  var S = (location.hash || '').slice(1);
  function step(path){
    for (var i = 0; i < path.length; i++) window.__hnApply(path[i][0], path[i][1]);
    window.__hnSetMoves(path.length);
    window.__hnRefresh(0);
  }
  function taps(list){
    for (var i = 0; i < list.length; i++) window.__hnTap(list[i]);
  }
  /* 3 个盘的最优 7 步（左 → 右） */
  var S3 = [[0,2],[0,1],[2,1],[0,2],[1,0],[1,2],[0,2]];

  function run(){
    if (S === 'half') {
      window.__hnNew(5);
      step([[0,2],[0,1],[2,1],[0,2],[1,0],[1,2],[0,2]]);
    } else if (S === 'hold') {
      window.__hnNew(4);
      step([[0,1],[0,2],[1,2]]);      /* 右柱 2,1；左柱 4,3 */
      window.__hnTap(0);              /* 拿起 3 号盘 → 悬浮 + 左柱高亮 */
    } else if (S === 'bad') {
      window.__hnNew(4);
      step([[0,1],[0,2],[1,2]]);      /* 右柱 2,1 */
      window.__hnTap(0);              /* 拿起 3 号 */
      /* 延后一拍再点：红框只亮 900ms，太早会被虚拟时间走掉 */
      setTimeout(function(){ window.__hnTap(2); }, 700);   /* 想压在 1 号上 → 拒绝 */
    } else if (S === 'eight') {
      window.__hnNew(8);
    } else if (S === 'hint') {
      window.__hnNew(4);
      step([[0,1]]);
      window.__hnHint();
    } else if (S === 'win') {
      window.__hnNew(3);
      taps([0,2, 0,1, 2,1, 0,2, 1,0, 1,2, 0,2]);
    } else if (S === 'undo') {
      window.__hnNew(5);
      step([[0,1],[0,2],[1,2],[0,1]]);
    }
  }
  /* 等 boot（newGame + 60ms 后的第二次 layout）跑完再改场景 */
  setTimeout(run, 150);
  /* 强制回流：无头虚拟时间下，最后一次 DOM 改动不一定会被绘制出来 */
  setTimeout(function(){ void document.body.offsetWidth; }, 400);
  /* 强制回流：无头虚拟时间下，最后一次 DOM 改动不一定会被绘制出来 */
  setTimeout(function(){ void document.body.offsetWidth; }, 400);
  /* win 的面板是延迟 700ms 才弹的，这里提前打开，免得虚拟时间预算不够 */
  if (S === 'win') setTimeout(function(){ window.__hnShowOver(); }, 900);
  setTimeout(function(){
    var st = window.__hn(), ds = document.querySelectorAll('.disk');
    var d2 = ds[2], bb = document.getElementById('board');
    document.title = 'DBG k=' + d2.dataset.k + ' left=' + d2.style.left + ' bottom=' + d2.style.bottom +
      ' board=' + bb.clientWidth + 'x' + bb.clientHeight +
      ' | held=' + (st.held ? st.held.disk : '-') + ' rowH=' + st.rowH;
  }, 600);
  setTimeout(function(){
    var st = window.__hn(), ds = document.querySelectorAll('.disk');
    var d2 = ds[2], bb = document.getElementById('board');
    document.title = 'DBG k=' + d2.dataset.k + ' left=' + d2.style.left + ' bottom=' + d2.style.bottom +
      ' board=' + bb.clientWidth + 'x' + bb.clientHeight +
      ' | held=' + (st.held ? st.held.disk : '-') + ' rowH=' + st.rowH;
  }, 600);
})();
</script>
</body>
'''

out = out.replace('</body>', SCENE, 1)
open(SHOT_HTML, 'w', encoding='utf-8').write(out)

SCENES = [a for a in sys.argv[1:] if not a.startswith('--')] or ['init', 'half', 'hold', 'bad', 'hint', 'eight', 'win', 'undo']
os.makedirs(OUT, exist_ok=True)

for s in SCENES:
    png = os.path.join(OUT, 'hanoi-%s.png' % s)
    profile = os.path.join(ROOT, 'ops', '_tmp', 'chrome-hanoi-%s' % s)
    shutil.rmtree(profile, ignore_errors=True)          # 共用 profile 会带进上一场的存档
    url = 'file:///' + SHOT_HTML.replace('\\', '/') + '#' + s
    cmd = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
           '--window-size=%d,%d' % (W, H),
           '--user-data-dir=' + profile,
           '--virtual-time-budget=1500',
           '--screenshot=' + png, url]
    r = subprocess.run(cmd, capture_output=True, text=True)
    ok = os.path.exists(png)
    print(('  ok  ' if ok else '  FAIL ') + s + ' → ' + png)
    if not ok:
        print(r.stdout[-500:], r.stderr[-500:])

shutil.rmtree(os.path.join(ROOT, 'ops', '_tmp'), ignore_errors=True)
if '--keep' not in sys.argv:
    os.remove(SHOT_HTML)
else:
    print('kept: ' + SHOT_HTML)
print('done')
