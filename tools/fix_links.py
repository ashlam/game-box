# -*- coding: utf-8 -*-
"""把站内跳转统一改成「显式文件名」形式。

线上服务器靠 ?sharecode= 认应用，缺了就掉进「链接不完整」页；
本地预览服务器（以及 file://）既没有分享码、又不认 /pairs/ 这种目录地址，
会直接回一个英文 Not Found。所以三件事一起做：
  1. 有分享码（http 线上）→ /pairs/index.html?sharecode=XXX
  2. 没分享码（本地预览 / file://）→ pairs/index.html、../index.html
  3. 静态 href 保持原样，android/sync_assets.py 照旧按 /xxx/ 与 / 做离线改写
"""
import io
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')

CARD_OLD = """(function(){
  var q = location.search, isFile = (location.protocol === 'file:');
  var as = document.querySelectorAll('a.card[href]');
  for(var i = 0; i < as.length; i++){
    var h = as[i].getAttribute('href');
    if(h.charAt(0) !== '/') continue;          /* 静态 href 不变时的守卫 */
    var dir = h.replace(/^\\//, '');            /* "hanoi/" */
    as[i].setAttribute('href', isFile ? dir + 'index.html' : h + q);
  }
})();"""

CARD_NEW = """(function(){
  var q = location.search;
  var isFile = (location.protocol === 'file:');
  /* 本地预览服务器和 file:// 都没有分享码，且都不认 /pairs/ 这种目录地址，
     统一退化成显式文件名 pairs/index.html */
  var local = isFile || !/[?&]sharecode=/.test(q);
  var as = document.querySelectorAll('a.card[href]');
  for(var i = 0; i < as.length; i++){
    var h = as[i].getAttribute('href');
    if(h.charAt(0) !== '/') continue;          /* 静态 href 不变时的守卫 */
    var dir = h.replace(/^\\//, '');            /* "hanoi/" */
    as[i].setAttribute('href', local ? (dir + 'index.html') : (h + 'index.html' + q));
  }
})();"""

BACK_OLD = """(function(){
  var q = location.search, isFile = (location.protocol === 'file:');
  var as = document.getElementsByTagName('a');
  for(var i = 0; i < as.length; i++){
    if(as[i].getAttribute('href') !== '/') continue;
    as[i].setAttribute('href', isFile ? '../index.html' : '/' + q);
  }
})();"""

BACK_NEW = """(function(){
  var q = location.search;
  var isFile = (location.protocol === 'file:');
  /* 本地预览服务器和 file:// 都没有分享码，走相对文件路径才不会 404 */
  var local = isFile || !/[?&]sharecode=/.test(q);
  var as = document.getElementsByTagName('a');
  for(var i = 0; i < as.length; i++){
    if(as[i].getAttribute('href') !== '/') continue;
    as[i].setAttribute('href', local ? '../index.html' : '/index.html' + q);
  }
})();"""


def patch(path, old, new):
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    if new in src:
        return 'skip'
    if old not in src:
        return 'MISS'
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(src.replace(old, new, 1))
    return 'ok'


def main():
    check = '--check' in sys.argv
    rows = []
    index = os.path.join(ROOT, 'index.html')
    rows.append(('index.html', patch(index, CARD_OLD, CARD_NEW)))
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name, 'index.html')
        if not os.path.isfile(p):
            continue
        rows.append((name + '/index.html', patch(p, BACK_OLD, BACK_NEW)))
    bad = [r for r in rows if r[1] != 'ok']
    if check:
        for name, st in rows:
            if st != 'skip':
                print('%-24s %s' % (name, st))
    print('total=%d ok=%d skip=%d miss=%d'
          % (len(rows), sum(1 for r in rows if r[1] == 'ok'),
             sum(1 for r in rows if r[1] == 'skip'),
             sum(1 for r in rows if r[1] == 'MISS')))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
