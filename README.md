# 小游戏盒子（Games Box）

纯静态的网页小游戏合集：手机浏览器打开就能玩，**断网也能玩**。每个游戏都是一个单文件自包含 HTML，零外部依赖。
另附一个最小 WebView 壳工程，可打成离线 APK 装到安卓设备上当原生 App 用。

## 当前 11 个游戏

| 目录 | 名称 | 类型 | 要点 |
|---|---|---|---|
| `othello/` | 黑白棋 | 棋类 · 对 AI | 三档难度，支持悔棋和落子提示 |
| `sokoban/` | 仓库番 | 推箱子 | **72 关两套关卡集**（街机版 48 + 经典集 24），触屏方向键 + 滑动，可撤销，记录最好成绩 |
| `breakout/` | 打砖块 | 动作 | 8 关，拖动挡板、搓球变向，砖块有硬度 |
| `frog/` | 青蛙过河 | 古风 · 蓄力跳 | 按住蓄力松手起跳，落水即止，正中石心加印章 |
| `marble/` | 弹珠乐园 | 蓄力发射 | 撞钉反弹，落桶加球，0 号桶白损失一颗；撞针 4 档弹力、每局随机分布 |
| `racer/` | 火箭车 | 触控赛车 | 生命值 + 护盾连击（详见下节），带**可视化调参页** |
| `klotski/` | 华容道 · 车阵 | 滑块解谜 | 经典「横刀立马」，棋子全是各种车，记录最少步数 |
| `2048/` | 2048 | 数字合并 | 滑动合成 2048，记录最高分 |
| `blockpuzzle/` | 方块消除 | 1010 类 | 10×10 放置消除，三块用完才发新的 |
| `parking/` | 停车场华容道 | 移车出库 | 6×6，车只能沿朝向走，撤销/重置/提示/自动演示 |
| `watersort/` | 倒水分拣 | Water Sort | 试管分色，96 关，撤销/重置/提示/自动演示 |

约定：每个游戏 `web/<名>/index.html` 一份文件搞定，返回键写 `href="/"`，网页版与 APK 版共用同一份
（靠 `sync_assets.py` 改链接前缀）。

## 火箭车：生命值 / 连击护盾 / 大货车

这一版把原来的「3 条命 + 燃油」两套数值**合并成一个生命值**：

- **生命值既是血也是燃料**：随行驶自然消耗，跑得越快掉得越快（停车也慢慢掉）；
  生命归零即结束（撞光 = 撞毁，耗光 = 力竭）。绿星回血，每跑完一段补一次。
- **撞车按车型扣血**：路障 30 < 小车 40 < 卡车 60 < **大货车 80**。大货车最重最慢（橙黑危险条纹 + 「危」字），
  **护盾对它无效**。
- **油箱连击**：吃红/绿星进入喷火后再吃一个 → **阶段 2 护盾**（青色能量罩，撞障碍/小车直接撞飞不扣血，撞完消失）；
  再吃一个 → **阶段 3**（金色护盾，撞飞小车还不掉盾）；之后再吃 → 加速与护盾各延长 1/3 时长。
- **死亡演出**：结束后**不立刻弹窗**——撞毁有子弹时间 + 爆炸 + 残骸翻滚趴窝，力竭/时间到是熄火滑停 + 抛锚双闪，
  0.85 秒后画布浮出大字「撞 毁 了」，演完（撞毁 2.9s / 其余 2.6s）才弹结算；大字出来后可轻点跳过。

### 调参页 `web/racer/editor.html`

不用滑块，全是数字输入框（− / ＋ 步进 + 直接输入），参数存本机 `localStorage`，下次打开游戏自动生效：

- **对象图鉴**：锥桶 / 油桶 / 跑车 / 轿车 / 变道车 / 卡车 / 大货车，每种一张缩略图（照游戏画法重画），
  标注体型与行为，**每种形象的扣血和行驶速度可单独调**（同档形象也能设不同值）。
- **全局参数**：正常上限 / 红星上限 / 红星持续 / 开局时间 / 过关加时 / 生命自然消耗 / 绿星回血 / 每过一段补。
- 底部「换算结果」实时给出各档伤害、「能撞几次」、全速与停车各能撑多久；可一键复制为常数代码。

> 调参键是 `gracer_cfg`。伤害**允许 0**（= 撞了不扣血），所以游戏侧判断用 `>= 0`，不能用「假值跳过」。

## 快速开始

```bash
# 起本地站（推荐：自带 no-store，改完刷新就是新的）
python ops/serve_site.py 4321 web

# 或者
python -m http.server 4321 --directory web --bind 0.0.0.0
```

- 本机：<http://127.0.0.1:4321/>
- 手机：连同一 WiFi 后访问 `http://<本机局域网IP>:4321/`（游戏都是触屏操作，手机体验更完整）
- 自检：`curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4321/` → 期望 `200`

> 站点根必须是 `web/`（游戏内返回键是绝对路由 `href="/"`）。用 `http.server` 的话改完代码要**强刷**，
> 因为它只发 `Last-Modified`，浏览器会按启发式规则缓存 HTML。

## 目录结构

```
games-box/
├── web/                     # 静态站点根（直接被托管）
│   ├── index.html           # 主页索引（卡片式）
│   ├── racer/               # 火箭车：index.html + editor.html（调参页）
│   └── <其余 10 个游戏>/index.html
├── android/
│   ├── project/             # 最小 WebView 工程：AndroidManifest + res/ + src/ + assets/
│   ├── sync_assets.py       # 把 web/ 同步成 assets/ 的离线版（链接改写），构建前自动跑
│   ├── build_apk.sh         # 可重复 APK 构建脚本（aapt2/javac/d8/zipalign/apksigner）
│   └── output/              # 构建中间产物（已 gitignore）
├── tools/                   # 关卡生成 / 求解器 / 验证 / 回归测试（约 80 个脚本）
├── ops/
│   ├── serve_site.py        # 静态站服务（HTML 禁缓存）
│   ├── games_guard.py       # 4321 服务守护（正常时零输出静默）
│   └── logs/                # 守护与访问日志（已 gitignore）
├── private/                 # 签名密钥 + 口令（已 gitignore，需单独备份）
├── releases/                # 已构建好的 APK
└── README.md
```

## 测试

每个游戏都有独立的回归测试（`tools/test_<游戏>.js`），用假 DOM + 假 canvas 把游戏脚本跑起来，
断言规则、边界与整局行为。全部用 Node 直接跑，无第三方依赖：

```bash
node tools/test_racer.js        # 火箭车：265 项
node tools/test_racer_cfg.js    # 火箭车调参链路：67 项
node tools/test_2048.js         # 92 项
node tools/test_blockpuzzle.js  # 96 项
node tools/test_breakout.js     # 23 项
node tools/test_frog.js         # 53 项
node tools/test_klotski.js      # 190 项
node tools/test_marble.js       # 192 项
node tools/test_othello.js      # 黑白棋整局对局 + 计时断言
node tools/test_parking.js      # 停车场华容道：77 项
node tools/test_sokoban.js      # 两套关卡逐关重放解法：30 项
node tools/test_watersort.js    # 倒水分拣：48 项
```

合计 1100+ 项断言，全绿（2026-10-13 实测）。

### 弹珠乐园：撞针弹力与调参实验

撞针分 4 档（`PEG_KINDS`）：软 0.46（灰白）/ 普 0.74（粉）/ 弹 0.94（绿）/ 超弹 1.06（金，>1 会加能量把球顶回上方）。
每局由 `rollPegMix()` 随机抽权重（带主基调 + 上限封顶），再按纵深偏置落到钉阵上。

`tools/bench_marble_pegs.js` 是用来调这套参数的实验台（每档几百发真实物理）：

```bash
node tools/bench_marble_pegs.js 600                                  # 内置对照表
node tools/bench_marble_pegs.js 600 "旧版|0,1,0,0|0" "随机|-|-"       # mix 写 - = 用游戏自己 roll 的
```

实测（600 发/档，无道具、炮口 0°）：球待在「上半场」的绝对时长 **1.98s → 2.39s（+21%）**，
弹回上方次数 1.32 → 1.56，撞钉数 30 → 46；代价是 0.7% 的球会打到 14s 兜底。

> 测试脚本直接读 `web/**/index.html` 里的内联 `<script>`，所以**改完游戏不用额外构建**，跑测试即可。

## 仓库番的两套关卡集

游戏内「选关」面板顶部可切换，**两套进度分开存**（`sokoban_cleared_v5:<setId>`）：

| 关卡集 | 关数 | 来源 | 难度（推动数） |
|---|---|---|---|
| 经典集 | 24 | 经典关卡集（ExtremelyEasy / IllustrativeLevels / SeeminglyHard / FrustratinglyDifficult），已剔除 <14 推的开局消遣关 | 12 → 91 |
| 街机版 | 48 | **《Sokoban Deluxe》(倉庫番Deluxe, Namco, 1990, Namco System 1 街机基板)** 原版 55 关 | 6 → 84 |

街机版关卡数据：`tools/classic/Deluxe.txt`（源自 github.com/borgar/borgar.net）。原版 55 关中
`3-9 / 5-1 / 5-3` 三关的转录数据箱子数与目标数对不上（必然无解），已剔除；`5-4 / 5-7 / 5-10 / 5-11`
在求解预算内未搜到解，也先不进游戏。

### ⚠️ 一个重要发现：`.sok` 文件附带的解并不是最优解

经典集原来的「参考最优」取自关卡文件里附带的解。用可采纳 A* 重算后发现**那些解普遍不是最优**：

| 关卡 | `.sok` 声明 | 真最优 |
|---|---|---|
| 经典集第 1 关 | 14 推 | **12 推** |
| 经典集第 8 关 | 19 推 | **15 推** |
| 经典集第 18 关 | 40 推 | **14 推** |

（用独立的 Python 裸规则重放器逐个复核过，新解全部合法。）所以游戏里现在按 `best.opt` 区分标注：
`true` 显示「（推动数最优）」，`false` 显示「（参考解，未证最优）」。

**`best.pushes` 的可信来源是 `tools/solver3.js`**：h 用「盒子→目标最小代价完美匹配」（各目标 BFS 距离
+ 匈牙利算法）作可采纳启发式，且剪枝只用「死格」与「2x2 冻结块」两种充分条件，
所以 weight=1 时给出的是**推动数最优**；另外终止条件必须是「目标态被弹出」而不是「刚生成就返回」，
否则可能提前收工拿到次优解。

## APK 构建（离线安装包）

```bash
bash android/build_apk.sh              # 构建 + 签名 + 校验 + 同步 releases/
bash android/build_apk.sh --genkey     # 密钥丢失时先生成一把新的
```

- 工具链路径用环境变量 `ANDROID_BASE` 指定（默认 `/opt/data/android-build/tools`：
  JDK 17 + build-tools 35.0.0 + android-35 平台）。**不需要 Android Studio、gradle 或 sudo**。
- 签名口令来自环境变量 `GAMEBOX_KS_PASS` / `GAMEBOX_KEY_PASS`，否则读 `private/keystore.pass`。
  这两个文件都在 `private/`（已 gitignore）。
- 脚本流程：`aapt2 compile` → `aapt2 link` → `javac` → `d8` → 把 `classes.dex` 装回 APK →
  `zipalign -P 16 4` → `apksigner sign` → `apksigner verify` / `zipalign -c` / `aapt2 dump badging`。
- 产物：`android/output/小游戏盒子离线版.apk`，并同步到 `releases/`（版本化副本 + 最新副本）。

### 已知坑（脚本里已规避）

| 现象 | 原因 / 处理 |
|---|---|
| `aapt2 compile --dir` 报 `Is a directory` | 逐文件 `compile`，不要传 `--dir` 指向已有输出目录 |
| `d8` 报 `Unsupported source file type` | 不能传 class **目录**，用 argfile 传显式 `.class` 列表 |
| `aapt2 link` 资源覆盖报错 | 加 `--auto-add-overlay` |
| `onConsoleMessage` 编译不过 | API 35 要求返回 `boolean`，不是 `void` |
| 断网装好后白屏 | assets 里必须是相对链接（`othello/index.html`、`../index.html`），不能写站点根 `/othello/` |
| 网页有、APK 没有 | 加新游戏后忘了跑 `sync_assets.py` |

> 静态校验通过 ≠ 真机验收。最终仍需在设备上**飞行模式**启动，验证主页、各游戏、触控、音效与进度保存。

## 加新游戏时要动的地方

1. 新建 `web/<游戏名>/index.html`（单文件自包含、零外部依赖，返回键写 `href="/"`）。
2. 在 `web/index.html` 的卡片列表里加一张卡（`href="/<游戏名>/"`）。
3. 跑 `python android/sync_assets.py` 同步离线资源 —— **网页版和 APK 版的链接写法不同**
   （网页版 `/othello/`，离线版 `othello/index.html`），这一步不跑，新游戏就会「网页上有、APK 里没有」。
   `build_apk.sh` 已内置这一步，打 APK 时会自动同步。
4. 顺手补一个 `tools/test_<游戏名>.js`（照现有测试抄骨架：假 DOM + 假 canvas + 断言）。

## Git 工作流

- `master` 是主干；**一个功能/一个游戏一条 `feat/*` 分支**，做完合回 `master`。
- 远程：`git@github.com:ashlam/game-box.git`（origin）。

```bash
git switch -c feat/xxx
# ... 改完跑测试 ...
node tools/test_xxx.js
python android/sync_assets.py        # 动了 web/ 就同步离线资源
git add -A && git commit -m "feat(xxx): ..."
git switch master && git merge --no-ff feat/xxx
git push origin master
```

## 常驻守护（服务挂了自动拉起）

`ops/games_guard.py` 被 cron 每 5 分钟调用一次：服务正常 → **零输出静默**；服务掉线 → 自动拉起并留一条记录；
站点目录丢失 → 告警。手动验证：直接跑脚本应**无输出**；`kill` 掉服务再跑，应恢复 200。

> 历史上它部署在 NAS 的 Hermes cronjob（`no_agent` 模式）下，路径与 IP 都写死在旧环境里；
> 现在脚本本身不依赖那些路径，换环境只要保证「能读到 `web/` 并起在 4321」即可。

## 手机直接下载安装包

`web/小游戏盒子离线版.apk` 是最新构建的离线包，手机浏览器打开
`http://<本机局域网IP>:4321/小游戏盒子离线版.apk` 即可下载安装（需允许「安装未知来源应用」）。

## 备份提醒

`private/gamebox-release.jks` 是签名身份，**丢了就无法再覆盖安装升级**（只能卸载重装）。它已被 gitignore，请单独备份该目录。

## 迁移说明

本项目由旧的开发目录迁移而来，旧位置**保留未删**，作为回退副本：

| 旧路径 | 新路径 |
|---|---|
| `/opt/data/games/` | `web/` |
| `/opt/data/games-tools/` | `tools/` |
| `/opt/data/android-build/project/` | `android/project/` |
| `/opt/data/android-build/output/gamebox-offline.apk` | `releases/小游戏盒子离线版.apk` |
| `/opt/data/android-build/output/gamebox-release.jks` | `private/gamebox-release.jks` |
