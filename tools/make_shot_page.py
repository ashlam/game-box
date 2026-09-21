#!/usr/bin/env python3
"""生成一个仅用于截图验证的临时页面：
   - 清点动画放慢到每枚 0.9 秒（便于停在"数到一半"截图）
   - 加一个 __forceFinish() 调试触发器（直接把当前局面送进结束演出）
不改动正式页面。"""
import re

src = open('/volume1/docker/hermes/files/bot_workspace/projects/games-box/web/othello/index.html', encoding='utf-8').read()
# 放慢：清点节奏 + 过渡时长（正式值 150ms/枚、1100ms 过渡，截图时拉长更从容）
out, n1 = re.subn(r'const COUNT_STEP_MS = \d+;', 'const COUNT_STEP_MS = 600;  /* 仅测试副本 */', src, count=1)
out, n2 = re.subn(r'const INTRO_MS = \d+;', 'const INTRO_MS = 8000;  /* 仅测试副本 */', out, count=1)
assert n1 == 1 and n2 == 1, '没找到 COUNT_STEP_MS / INTRO_MS'
out2 = out.replace(
    '  // 只读调试钩子（不影响游戏）：控制台 __othello() 可查音效次数 / 电脑延时等',
    '  window.__forceFinish = () => { over = true; render(false); finish(); };   // 仅测试副本\n\n'
    '  // 只读调试钩子（不影响游戏）：控制台 __othello() 可查音效次数 / 电脑延时等'
)
assert out2 != out, '没找到调试钩子锚点'
open('/volume1/docker/hermes/files/bot_workspace/projects/games-box/web/othello/_shot.html', 'w', encoding='utf-8').write(out2)
print('已生成 /volume1/docker/hermes/files/bot_workspace/projects/games-box/web/othello/_shot.html （放慢版 + 强制结束触发器）')
