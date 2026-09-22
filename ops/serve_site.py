#!/usr/bin/env python3
"""小游戏盒子静态站服务（端口 4321）。

与 `python3 -m http.server` 的唯一区别：**给 HTML 加 no-store**。

起因（2026-09-22）：手机浏览器缓存了旧版 sokoban 页面，用户刷新后仍看到「24 关、开局很简单」
的旧版，反复反馈「感觉没什么变化」。`http.server` 只发 `Last-Modified`，浏览器会按启发式规则
自行缓存 HTML —— 服务器上明明是新版，用户却看不到。
这里显式禁掉 HTML 缓存；图片等静态资源仍允许短缓存，免得每次重下。

用法：serve_site.py <port> <directory>
"""
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHTML(SimpleHTTPRequestHandler):
    def end_headers(self):
        p = self.path.split("?")[0]
        if p.endswith("/") or p.endswith(".html"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass          # 静默：访问日志没必要写（守护脚本自己有日志）


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4321
    directory = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    handler = functools.partial(NoCacheHTML, directory=directory)
    srv = ThreadingHTTPServer(("0.0.0.0", port), handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
