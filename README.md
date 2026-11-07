# VCNC 足球沉浸场（VCNC-Football）

只刷 **VCNC**（B 站 mid `432185343`，五人制足球实况 / 集锦）的 Android 沉浸式播放器。
打开就是一条竖滑的比赛流，当前比赛的集锦自动无缝连播，镜头自动跟随球与持球人放大。

> **版本 v0.2.2**（试验版，未上架应用商店）。2026-11-07 从 `volcanochen/H-Player` 的
> `vcnc-football` 分支拆出，改为本仓库独立维护。主工程 H-Player 是通用 B 站集锦播放器，
> 两者互不依赖。

## 它解决什么

普通播放器看 11 分钟的低清全场录像，球只有 3~8 px，手机上基本找不着。本项目做两件事：

1. **只播集锦**：从置顶评论里解析 `0:04:02 17s 动作名` 这类时间戳，拼成时间轴，双 deck 预热硬切连播。
2. **把镜头怼到球上**：起播前预读一段算出焦点轨迹，播放时用平滑缓动追随放大，竖屏时上半屏保留完整画面、下半屏显示放大镜。

## 主要功能

| 模块 | 说明 |
|---|---|
| 比赛流 | UP 主动态接口 `x/polymer/web-dynamic/v1/feed/space` 拉 feed，标题/简介过足球关键词（剔除该账号的科技类投稿），竖滑切场、上拉加载更多 |
| 集锦连播 | 置顶评论时间戳 → 片段序列（前后各补 1~2s），双 `<video>` + 视频/音频分离代理，段末硬切无加载圈 |
| 集锦分类 | 按动作码筛选：进球 g / 助攻 a / 错失 m / 扑救 s / 带球过人 dr / 穿裆 pnn / 头球 h / 传球 p / 丢球 c / 精彩 !；也可切「原片」 |
| 焦点镜头 | 64×36 离屏 canvas 帧差 → 球场分割 / 球门 / 人员 / 候选球 → 持球者 + 球→门行为预测 → 组合构图 → 指数平滑的 `translate() scale()` 追随（1.15×~2× 可调，可关） |
| 外部轨迹 | 优先读取 `/api/tracks/<bvid>.json`（PC 预计算的高质量轨迹），取不到才走端侧识别兜底 |
| 竖屏分屏 | 上窗原始比例 + 焦点框/球圈/时间码，下窗跟焦放大；双指捏合缩放、双指拖动临时移焦，松手 1s 恢复自动 |
| 算法可视化 | 把识别出的球 / 人 / 门 / 持球者 / 组合框 / 预测轨迹画在画面上，方便调参 |
| 播放控制 | 左下角播放/暂停 + `0.5×` / `0.25×` / `0.125×` 慢动作；本场播完停住不自动跳场；左半屏上下滑调亮度、右半屏调音量 |
| 续播与兜底 | 冷启动按 localStorage 回到上次那场比赛的片段与进度；feed 本地缓存应对断网 / 风控；设置里可填 `SESSDATA` 提高接口配额 |
| **应用内更新** | 设置 → 「检查更新」→ 读本仓库 GitHub Releases → 显示版本与更新说明 → 下载 APK → 调系统安装器升级（v0.2.0 新增，v0.2.1 起多源回退，v0.2.2 起直达安装器） |

## 目录结构

```
.
├── static/
│   ├── feed.html / feed.js / feed.css   # 沉浸场前端（WebView 加载）
│   └── index.html                      # 默认首页，跳转到 feed.html
├── server.py                           # 桌面调试服务器（/api/feed、/api/resolve、/api/media 代理）
├── start.cmd                           # Windows 一键起桌面版
├── android/
│   ├── build_apk.sh / build_apk.bat     # 免 Gradle 离线构建
│   ├── make_apk.py                      # 合并 dex + assets
│   └── app/src/main/
│       ├── AndroidManifest.xml         # 包名 com.vcncfootball，versionCode/Name
│       ├── java/com/hplayer/           # 注意：Java 包名仍是 com.hplayer
│       │   ├── MainActivity.java       # WebView、密度/视口、JS 桥、更新回调
│       │   ├── ProxyServer.java        # 本机 HTTP 服务（静态 + API 代理）
│       │   ├── BiliApi.java            # feed / wbi 签名 / playurl / 评论
│       │   ├── UpdateChecker.java      # GitHub Releases 检查 + 下载
│       │   └── UpdateProvider.java     # content:// 暴露 APK 给系统安装器
│       └── res/
├── scripts/make_release.py              # 创建 GitHub Release 并上传 APK
├── release/                             # 每个版本的发布产物与说明（见 release/README.md）
└── _test/cdp_eval.py                    # adb + Chrome DevTools 读 WebView 内部状态
```

> **包名与 Java 包名不一致**：manifest 是 `com.vcncfootball`，Java 类仍在 `com.hplayer`，
> 所以 manifest 里组件必须写全限定名，aapt2 生成的 `R.java` 路径按 manifest 包名走。

## 构建 APK

免 Gradle，纯 Android SDK 命令行工具链：`aapt2 → javac → d8 → make_apk.py → zipalign → apksigner`。

需要 JDK 17（Android Studio 自带 jbr 即可）、SDK `build-tools/37.0.0`、`platforms/android-34`、Python 3。
路径都可用环境变量覆盖：

```bash
bash android/build_apk.sh                 # Git Bash / Linux / macOS
# 或 Windows: android\build_apk.bat
# 换机器：ANDROID_SDK=/path/to/sdk JBR=$JAVA_HOME PY=python3 bash android/build_apk.sh
```

产物 `android/VCNC-Football.apk`（约 130 KB）。首次构建会在 `android/keystore.jks` 生成自签名密钥；
**私钥已被 .gitignore 排除，绝不提交**。谁发布 Release 就必须持有同一份 keystore，
否则签名不同，用户无法覆盖升级（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。

真机安装：

```bash
adb install -r android/VCNC-Football.apk
adb shell am start -n com.vcncfootball/com.hplayer.MainActivity
```

桌面调试（`http://127.0.0.1:8777/`，注意放的是 `feed.html` 那一套）：

```bash
python server.py     # 或双击 start.cmd
```

## 应用内更新怎么工作

1. 前端点「检查更新」→ `BiliBridge.checkUpdate()`。
2. `UpdateChecker` 子线程 GET
   `https://api.github.com/repos/volcanochen/vcnc-football/releases/latest`，
   手写提取 `tag_name` / `body` / `assets[].browser_download_url`（不依赖 org.json）。
3. 按语义版本 `major.minor.patch` 比较 Release 版本与本机 `versionName`，且必须存在 `.apk` 资产才提示更新。
4. 点「下载并安装」→ 下载到 `getFilesDir()/updates/`，经 `UpdateProvider` 以
   `content://com.vcncfootball.update/VCNC-Football.apk` 交给系统安装器。
   Android 8+ 首次需要用户在系统设置里允许本应用「安装未知应用」。

**下载走多源回退**（v0.2.1 修复）：真机实测有网络能访问 `api.github.com` 却连不上
`github.com:443`，导致「检查成功、下载必失败」。因此按
`browser_download_url` → jsDelivr CDN（3 个域名）→ `api.github.com` 的 contents 接口（base64）
顺序尝试，任一成功即用；写入前校验 APK 的 zip `PK` 头，避免把错误页当安装包。
后两类源都读仓库 `release/` 下的同名 APK，所以**发布时必须把 APK 一起提交进仓库**。
安装意图（v0.2.2）显式指向系统「软件包安装程序」，避免装了文件管理器的设备弹出
「打开方式」让用户误选第三方程序导致安装不发生。

因此**发布新版本时必须同时做三件事**：改 `AndroidManifest.xml` 的 `versionCode` / `versionName`、
把带版本号的 APK 放进 `release/`、创建同名 tag 的 Release 并上传该 APK。

## 发布流程

`release/` 是本地发布目录，详见 `release/README.md`。一次完整发布：

```bash
# 1. 改版本号（AndroidManifest.xml），构建
bash android/build_apk.sh
# 2. 归档产物 + 校验和 + 版本说明
cp android/VCNC-Football.apk release/VCNC-Football-v0.2.2.apk
#    写 release/v0.2.2.md，更新 release/SHA256SUMS.txt
# 3. 提交、打 tag、推送
git add -A && git commit -m "release: v0.2.2"
git tag v0.2.2 && git push origin main --tags
# 4. 建 Release 并上传 APK（token 取自 git credential，不落盘）
python scripts/make_release.py --tag v0.2.2
```

脚本会打印 Release 页面地址；若同名 Release 已存在则复用并覆盖上传资产。

## 已知限制（重要）

- **端侧球检测不可靠**：2026-10-18 同帧对比实验证明，在真实 854×356 低清源上自研背景减除
  球检出率仅约 3%、人 0；YOLO11n 2× 上采样能到球 96%。所以正式效果依赖 **PC 预计算轨迹**。
  轨迹由独立仓库 [`volcanochen/FootballTracking`](https://github.com/volcanochen/FootballTracking)
  产出（YOLO + 颜色/运动/姿态融合 → Viterbi / 锚点跟踪），以 JSON 下发到 `/api/tracks/<bvid>`。
  端侧启发式只是兜底，请勿把它当作最终精度。该仓库后续的 `track_v2` / BallTracer 成果尚未回灌到端侧。
- **B 站风控**：动态 feed 请求**不能带 `Origin` 头**（会触发 -352 或返回空数据）；
  `-352` 是 IP 级滑动窗口限流，靠退避 + 刷新 buvid + 本地缓存兜底，登录 Cookie 可提高配额。
  评论接口 `/x/v2/reply` 的 `ps` 必须 ≤ 20；playurl 需要 wbi 签名。
- **老 WebView 兼容红线**：目标是 Android 9 / Chrome 74，前端禁用 `??`、`?.`、
  `replaceAll`、`:is()`、flex `gap`、`inset`、`clamp()`、`aspect-ratio` 等新语法。
- **manifest 必须声明 targetSdkVersion**，否则系统按 targetSdk=1 走屏幕兼容模式，
  UI 放大数倍、CSS 视口异常、点击错位。
- 真机验证主要在 Galaxy Note8 / SM-N9500（Android 9）上完成；`screencap` 偶发抓不到视频层（全黑），
  判断播放状态请用 `_test/cdp_eval.py` 读 WebView 状态 / 采样 canvas 像素，别只看截图。

## 开发历史（摘要）

| 时间 | 事件 |
|---|---|
| 2026-10-17 | 从 H-Player `main` 切出 `vcnc-football` 分支，做出沉浸式 feed + 焦点缩放试验版 |
| 2026-10-18 | 球检测三次推翻：自研背景减除 → PC 预计算；「青色小球」→ 实为固定光源；Viterbi 全局寻优 → 锚点局部跟踪（LOO 25/29 = 86%）；检测/微调工作剥离为 FootballTracking 仓库 |
| 2026-10-18 03:54 | 分支末次提交 `6da69d7`：播放器 UI 四项 + 轨迹时序/颜色融合 |
| 2026-11-07 | 重新构建 APK 并在 Note8 真机验证（feed 11 场、双 deck 正常解码、分屏放大镜/球圈/控制条工作） |
| 2026-11-07 | 拆出本仓库独立维护，接入 GitHub Releases 应用内更新，发布 v0.2.0 |
| 2026-11-07 | 真机发现 `github.com:443` 不可达导致「能检查、不能下载」，改为多源回退 + APK 魔数校验，发布 v0.2.1 |
| 2026-11-07 | 真机升级时「打开方式」可能误选第三方文件管理器，改为显式指定系统安装器，发布 v0.2.2 |

原始 3 个提交的历史仍保留在 `volcanochen/H-Player` 本地 `vcnc-football` 分支；
本仓库为干净起点，不带实验视频与标注数据（原分支历史里有 222 MB 视频，超过 GitHub 单文件限制）。

## 免责声明

仅供个人学习研究使用。视频内容版权归哔哩哔哩及原作者所有，请勿用于任何商业用途。
