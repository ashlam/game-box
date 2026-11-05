#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 comfycakes 造「玩到一半」的临时页面，配合 tools/shot.sh 截图。

用法: python tools/shot_comfycakes.py <场景名>
场景: play / good / bad
输出: ops/tmp/cc-<场景名>.html
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'web', 'comfycakes', 'index.html')
OUTDIR = os.path.join(ROOT, 'ops', 'tmp')

FIELD = "['shape','batter','icing','pattern']"

PRELUDE = """
<script>
window.addEventListener('load', function(){
  function run(sec){ window.__cc.tick(Math.round(sec*60), 1/60); }
  function until(p){
    for(var i=0;i<900;i++){
      if(window.__cc.state.phase===p) return true;
      window.__cc.tick(1, 1/60);
    }
    return false;
  }
  function pick(st){
    var c = window.__cc.state.orders[0].cake;
    var f = %s;
    window.__cc.choose(c[f[st]].id);
  }
  function wrong(st){
    var c = window.__cc.state.orders[0].cake;
    var po = window.__cc.state.orders[0].pool[st];
    var f = %s;
    for(var i=0;i<po.length;i++){
      if(po[i].id !== c[f[st]].id){ window.__cc.choose(po[i].id); return; }
    }
  }
  try{
    window.__cc.start();
""" % (FIELD, FIELD)

SCENES = {
    # 停在第 3 台机器前等选择
    'play': """
    until('waiting'); pick(0); run(1.3);
    until('waiting'); pick(1); run(1.3);
    until('waiting');
    run(0.35);
    """,
    # 做完四层、刚交付成功（撒花在飞）
    'good': """
    until('waiting'); pick(0); run(1.2);
    until('waiting'); pick(1); run(1.2);
    until('waiting'); pick(2); run(1.2);
    until('waiting'); pick(3); run(1.2);
    until('result'); run(0.42);
    """,
    # 只剩一条命时做错，出结算页
    'over': """
    until('waiting'); wrong(0); run(1.2);
    until('waiting'); wrong(1); run(1.2);
    until('waiting'); wrong(2); run(1.2);
    until('waiting'); wrong(3); run(1.2);
    until('result'); run(1.7);
    """,
    # 前三层错、最后一层也对不上，逐层打叉
    'bad': """
    until('waiting'); wrong(0); run(1.2);
    until('waiting'); wrong(1); run(1.2);
    until('waiting'); wrong(2); run(1.2);
    until('waiting'); wrong(3); run(1.2);
    until('result'); run(0.95);
    """,
}

TAIL = """
  }catch(e){
    document.title = 'ERR ' + e.message;
    var d = document.createElement('pre');
    d.style.cssText = 'position:fixed;left:0;top:0;z-index:999;background:#f00;color:#fff;font:12px monospace;padding:8px';
    d.textContent = 'ERR: ' + (e && e.stack || e);
    document.body.appendChild(d);
  }
});
</script>
"""


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else 'play'
    body = SCENES.get(name)
    if body is None:
        print('未知场景: ' + name)
        return 2

    with open(SRC, 'r', encoding='utf-8') as f:
        html = f.read()

    inject = PRELUDE + body + TAIL
    idx = html.rfind('</body>')
    if idx < 0:
        print('找不到 </body>')
        return 2
    html = html[:idx] + inject + html[idx:]

    os.makedirs(OUTDIR, exist_ok=True)
    out = os.path.join(OUTDIR, 'cc-%s.html' % name)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
