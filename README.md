# 小游戏盒子（Games Box）

纯静态的网页小游戏合集：手机浏览器打开就能玩。三个游戏（黑白棋「奥赛罗」、推箱子「仓库番」、打砖块）都是单文件自包含、零外部依赖、断网可玩。另附一个最小 WebView 壳工程，可打成离线 APK 装到安卓设备上。

- 项目根：`/volume1/docker/hermes/files/bot_workspace/projects/games-box`
- 服务端口：`4321`
- 手机访问：`http://192.168.101.42:4321/`（手机需与 NAS 同一 WiFi）

## 目录结构

```
games-box/
├── web/                     # 静态站点根（http.server 直接托管的就是这里）
│   ├── index.html           # 主页索引（卡片式）
│   ├── othello/index.html   # 黑白棋（单文件，含 AI / 音效 / 逐枚清点比分）
│   ├── sokoban/index.html   # 仓库番（经典关卡集，含最优解参考）
│   └── breakout/index.html  # 打砖块（8 关，触屏拖动挡板，砖块有硬度）
├── android/
│   ├── project/             # 最小 WebView 工程：AndroidManifest + res/ + src/ + assets/
│   ├── sync_assets.py       # 把 web/ 同步成 assets/ 的离线版（链接改写），构建前自动跑
│   ├── build_apk.sh         # 可重复 APK 构建脚本（aapt2/javac/d8/zipalign/apksigner）
│   └── output/              # 构建中间产物（已 gitignore）
├── tools/                   # 关卡生成/验证/难度筛选、黑白棋 fuzz 与整局测试
├── ops/
│   ├── games_guard.py       # 4321 服务守护脚本（cron no_agent，正常时静默）
│   └── logs/                # 守护与访问日志（已 gitignore）
├── private/                 # 签名密钥 + 口令（已 gitignore，需单独备份）
├── releases/                # 已构建好的 APK
└── README.md
```

## 启动 / 访问网页服务

```bash
python3 -m http.server 4321 --directory <项目根>/web --bind 0.0.0.0
```

自检：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4321/       # 期望 200
```

> 起后台服务必须用工具的 `background=True`，不要写 `cmd &` / `nohup` —— 容器里复合命令加 `&` 会把调用卡死。

## 常驻守护（进程挂了 / 容器重建后自动拉起）

`ops/games_guard.py` 每 5 分钟被 Hermes cronjob（`no_agent` 模式）调用一次：

- 服务正常 → **零输出、静默**，不打扰用户；
- 服务掉线 → 自动拉起，并推一条「已自动拉起」；
- 站点目录丢失 → 推一条无法恢复的告警。

部署要点（踩过的坑，照做）：

1. cronjob 的 `script` 只接受**相对文件名**，调度器把它解析到 `$HERMES_HOME/scripts/`（= `/opt/data/profiles/<profile>/scripts/`）。
   → 改完 `ops/games_guard.py` 后要同步复制一份到那里：
   ```bash
   cp ops/games_guard.py "$HERMES_HOME/scripts/games_guard.py"
   ```
   ⚠️ cronjob 工具报错时提示的「放到 `~/.hermes/scripts/`」**是错的**，照做会每 5 分钟收到一条 `Script not found` 告警。
2. 验证不能只看 `last_status`（脚本找不到时它照样显示 `ok`）。可信证据：
   - `cron/output/<job_id>/<时间>.md` 里 `**Status:**` 是 `silent (empty output)` / `ok`，而不是 `script failed`；
   - `ops/logs/guard_heartbeat.txt` 每次运行 +1 行。
3. 手动测一遍：直接跑脚本应**无输出**；`kill` 掉服务再跑，应打印「已自动拉起」且 `curl` 恢复 200。

## APK 构建（离线安装包）

```bash
bash android/build_apk.sh              # 构建 + 签名 + 校验 + 同步 releases/
bash android/build_apk.sh --genkey     # 密钥丢失时先生成一把新的
```

- 工具链默认在 `/opt/data/android-build/tools`（JDK 17 + build-tools 35.0.0 + android-35 平台），
  用 `ANDROID_BASE` 可覆盖。**不需要 Android Studio、gradle 或 sudo**。
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

> 静态校验通过 ≠ 真机验收。最终仍需在设备上**飞行模式**启动，验证主页、两个游戏、触控、音效与进度保存。

## tools/ 说明

`tools/` 是开发/校验脚手架（关卡集下载、解验证、难度筛选、注入 HTML、黑白棋整局 fuzz 与虚拟时钟测试）。
迁移时已把其中写死的旧绝对路径（`/opt/data/games-tools`、`/opt/data/games`）**统一改成本项目内的 `tools/` 与 `web/`**，
所以在项目根下直接跑即可，例如：

```bash
python3 tools/verify_by_solution.py     # 重放官方解法，验证关卡集可解性
python3 tools/select4.py                # 按难度下限重新选关（丢掉 <14 推的消遣关）-> final_levels4.json
python3 tools/inject4.py                # 把关卡表注入 sokoban/index.html（顺带换代存档键）
node   tools/test_sokoban.js            # 仓库番：逐关重放官方解法，断言通关且步数/推动数吻合
node   tools/test_othello.js            # 黑白棋整局对局 + 计时断言
node   tools/test_breakout.js           # 打砖块：完美挡板能否打通 8 关 / 边界不变量 / 计分一致性 / 音效
node   tools/hunt_stall.js              # 卡死猎手
```

> 注意：这些脚本里引用到的 `classic_analysis.json` / `final_levels2.json` 等属于**中间产物**，库中本就没有，
> 需先跑上游步骤生成。游戏本体（`web/`、`android/`）不依赖 `tools/`。

## 加新游戏时要动的地方

1. 新建 `web/<游戏名>/index.html`（单文件自包含、零外部依赖，返回键写 `href="/"`）。
2. 在 `web/index.html` 的卡片列表里加一张卡（`href="/<游戏名>/"`）。
3. 跑 `python3 android/sync_assets.py` 同步离线资源 —— **网页版和 APK 版的链接写法不同**
   （网页版 `/othello/`，离线版 `othello/index.html`），这一步不跑，新游戏就会「网页上有、APK 里没有」。
   `build_apk.sh` 已内置这一步，打 APK 时会自动同步。

## 手机直接下载安装包

`web/小游戏盒子离线版.apk` 就是最新构建的离线包，手机浏览器打开
`http://192.168.101.42:4321/小游戏盒子离线版.apk` 即可下载安装（需允许「安装未知来源应用」）。

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
| `/opt/data/profiles/deepseek-profile/scripts/games_guard.py` | `ops/games_guard.py`（并同步回 `$HERMES_HOME/scripts/`） |
