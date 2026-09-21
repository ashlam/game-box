#!/usr/bin/env python3
"""小游戏盒子网页服务守护（端口 4321）。

正常时完全静默（不推送、零 token）；仅在「服务刚被拉起」或「无法恢复」时输出一行。
由 Hermes cronjob 以 no_agent 模式每 5 分钟调用一次。

路径说明（相对本文件位置推导，不写死）：
  PROJECT —— 项目根（本文件位于 <PROJECT>/ops/）
  ROOT    —— 站点根 = <PROJECT>/web，即 http.server 的 --directory
  LOGDIR  —— 守护/服务日志 = <PROJECT>/ops/logs
             （刻意放在站点根之外，避免串口日志被公开访问）

部署：Hermes cronjob 的 script 参数只接受相对文件名，调度器会把它解析到
      $HERMES_HOME/scripts/（即 /opt/data/profiles/<profile>/scripts/）。
      故本文件需同步复制一份到 $HERMES_HOME/scripts/games_guard.py。
      ⚠️ 工具被拒时的提示语写的是「放到 ~/.hermes/scripts/」，那句话不可信。
"""
import datetime
import os
import subprocess
import sys
import time

PORT = 4321
PROJECT = os.environ.get(
    "GAMEBOX_PROJECT",
    "/volume1/docker/hermes/files/bot_workspace/projects/games-box",
)
ROOT = os.path.join(PROJECT, "web")
LOGDIR = os.path.join(PROJECT, "ops", "logs")
LOG = os.path.join(LOGDIR, "serve.log")
STATE = os.path.join(LOGDIR, ".guard_state")
HEARTBEAT = os.path.join(LOGDIR, "guard_heartbeat.txt")
HEX_PORT = format(PORT, "04X")  # 4321 -> 10E1


def log(msg):
    os.makedirs(LOGDIR, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def alive():
    # 首选 curl 探活（最可靠）
    try:
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3",
             f"http://127.0.0.1:{PORT}/"],
            capture_output=True, text=True, timeout=10)
        if r.stdout.strip() == "200":
            return True
    except Exception as e:
        log(f"health check error: {e}")
    # 兜底：直接看内核 TCP 表里 4321 是否处于 LISTEN(0A)
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path) as f:
                for line in f:
                    parts = line.split()
                    if len(parts) > 3 and parts[1].endswith(":" + HEX_PORT) and parts[3] == "0A":
                        return True
        except Exception:
            pass
    return False


def start_service():
    os.makedirs(LOGDIR, exist_ok=True)
    with open(LOG, "a") as lf:
        p = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(PORT), "--directory", ROOT, "--bind", "0.0.0.0"],
            stdout=lf, stderr=subprocess.STDOUT, start_new_session=True)
    log(f"service not running -> restarted, pid={p.pid}, root={ROOT}")
    return p


def read_state():
    try:
        return open(STATE).read().strip()
    except Exception:
        return ""


def write_state(s):
    os.makedirs(LOGDIR, exist_ok=True)
    with open(STATE, "w") as f:
        f.write(s)


def main():
    # 每次运行都留心跳（便于确认 cron 到底有没有真的执行到这个脚本）
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        with open(HEARTBEAT, "a") as f:
            f.write(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] "
                    f"run pid={os.getpid()} alive={'yes' if alive() else 'no'}\n")
    except Exception:
        pass

    prev = read_state()
    if alive():
        if prev != "up":
            write_state("up")
        return                                   # 一切正常：静默，不打扰用户

    if not os.path.isdir(ROOT):
        if prev != "lost":
            write_state("lost")
            print(f"⚠️ 小游戏盒子打不开了：目录 {ROOT} 不存在（多半是挂载丢失或目录被移动），无法自动恢复。")
        return

    start_service()
    for _ in range(10):
        time.sleep(1)
        if alive():
            write_state("up")
            print(f"🔄 小游戏盒子网页服务（端口 {PORT}）刚刚掉线，已自动拉起，可以继续玩了。")
            return

    if prev != "down":
        write_state("down")
        print(f"⚠️ 小游戏盒子服务（端口 {PORT}）自动拉起失败，日志：{LOG}")


if __name__ == "__main__":
    main()
