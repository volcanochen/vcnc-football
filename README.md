# VCNC 足球沉浸场（VCNC-Football）

只刷 **VCNC**（B 站 mid `432185343`，五人制足球实况 / 集锦）的 Android 沉浸式播放器。
打开就是一条竖滑的比赛流，当前比赛的集锦自动无缝连播，镜头自动跟随球与持球人放大。

> **版本 v0.2.3**（试验版，未上架应用商店）。2026-11-07 从 `volcanochen/H-Player` 的
> `vcnc-football` 分支拆出，改为本仓库独立维护。主工程 H-Player 是通用 B 站集锦播放器，
> 两者互不依赖。

## 它解决什么

普通播放器看 11 分钟的低清全场录像，球只有 3~8 px，手机上基本找不着。本项目做两件事：

1. **只播集锦**：从置顶评论里解析 `0:04:02 17s 动作名` 这类时间戳，拼成时间轴，双 deck 预热硬切连播。
2. **把镜头怼到球上**：起播前预读一段算出焦点轨迹，播放时用平滑缓动追随放大，竖屏时上半屏保留完整画面、下半屏显示放大镜。

## 主要功能

| 模块 | 说明 |
|---|---|
| 比赛流 | UP 主动态接口 `x/polymer/web-dynamic/v1/feed/space` 拉 feed，标题/简介过足球关键词（剔除该账号的科技类投稿），列表点选切场；**只加载第一页**，需要更多点列表底部的「加载更多」，不再滚到底自动翻页 |
| **页面切换** | 「比赛列表 / 播放 / 设置」是三个独立全屏页。**不做顶部 tab**（省 46px）：播放页右上角只有「列表 / 设置」两个浮动半透明按钮，点进去后用列表页的 `▶` 或设置页底部的「回到播放」返回；已移除左右滑动切页；设置页整页可纵向滚动，播放页竖滑仍是亮度/音量 |
| **画面填充** | 源视频约 2.4:1 超宽画幅，默认「完整」= `object-fit: contain` 按比例显示全部、上下留黑边**不裁切**；可切「铺满」=`cover` 填满屏幕但会裁掉两侧（旧版默认行为）。倍率 >1 / 自动跟焦会主动放大取景，同样会裁切 |
| **集锦浮窗** | 播放页靠左半透明浮窗列出本场**全部**片段（序号 / 时间码 / 备注），点行即跳到该片段、当前段高亮并自动滚到可见；浮窗高度随屏幕自适应，显示不下在浮窗内上下滑动；左上角 `‹` 可收成小把手；设置里可关闭 |
| **大屏兼容** | 折叠屏等超高像素屏（物理像素 > 420 万，如 N6 展开 2480×2248）自动进入单路解码模式：备用 deck 只预载到段首并保持暂停，段末硬切时再起播，避免「音频继续、画面冻住」；同时无缩放时不给 video 留恒等 `transform` / `will-change` 合成层 |
| **单段循环** | 入口只在左下角播放控件的「锁」：点一下把**当前片段**设为循环，播完自动回到段首重播（复用双 deck 停在段首硬切，无黑帧；未就绪时 seek 回段首兜底）。再点「解」、点浮窗其他行、换场或改筛选即恢复正常连播。浮窗行内不再带锁按钮，只显示序号/时间码/备注 |
| **长列表性能** | 播放列表用虚拟滚动：只渲染视口 ±3 行并循环复用约 20 个 DOM 节点，事件委托；离屏时挂起跟焦分析与放大镜解码 |
| 集锦连播 | 置顶评论时间戳 → 片段序列，双 `<video>` + 视频/音频分离代理，段末硬切无加载圈 |
| **前后补时** | 设置里可调「前置补时 / 后置补时」（0~15s、步长 0.5s，默认 1s / 2s）：评论时间不准、动作被切头切尾时调大；过大时自动截断前一段避免相邻片段重叠 |
| **集锦分类（字符筛选）** | 当前按置顶评论备注里的**字符字面**筛选：输入任意字符（如 `g`、`pnn`、`!`、`进球`）只播备注含该字符的片段，空格分隔多个字符 = 任一命中，留空 = 全部；**区分大小写**（备注里 `M`/`V` 是队名标记，与 `m`/`v` 不同）；下方自动统计本场出现的字符做快捷 chip，并显示「命中 N / 共 M 段」。语义含义表待补，届时只替换匹配规则；也可切「原片」 |
| 焦点镜头 | 64×36 离屏 canvas 帧差 → 球场分割 / 球门 / 人员 / 候选球 → 持球者 + 球→门行为预测 → 组合构图 → 指数平滑的 `translate() scale()` 追随（1.00×~3× 可调，可关；1.00× = 不放大不裁切） |
| 外部轨迹 | 优先读取 `/api/tracks/<bvid>.json`（PC 预计算的高质量轨迹），取不到才走端侧识别兜底 |
| **自定义缩放** | 双指捏合 = 纯自定义缩放：自动关闭「自动跟焦」，保持用户设定的倍率与画面中心，双指拖动可平移，**松手不恢复跟踪**；要恢复请打开设置里的「自动跟焦」或点画面放大镜图标 |
| 竖屏分屏 | 上窗原始比例 + 焦点框/球圈/时间码，下窗放大视图；分屏时缩放作用在下窗，全屏时作用在主画面 |
| 算法可视化 | 把识别出的球 / 人 / 门 / 持球者 / 组合框 / 预测轨迹画在画面上，方便调参 |
| 播放控制 | 左下角播放/暂停 + `0.5×` / `0.25×` / `0.125×` 慢动作；本场播完停住不自动跳场；左半屏上下滑调亮度、右半屏调音量 |
| 续播与兜底 | 冷启动按 localStorage 回到上次那场比赛的片段与进度；feed 本地缓存应对断网 / 风控；设置里可填 `SESSDATA` 提高接口配额 |
| **视频缓存** | 播放过的视频/音频字节落盘到 App 专属目录，关掉再开同一场直接从磁盘读、**不再重复下载**；解析成功还会**预取本场全部集锦片段**（只缓存集锦，不缓存整场）；key 用 `bvid+分P+清晰度+流类型`，与每次随机的 token 解耦；设置里可选 200M / **600M（默认）** / 1G / 2G 上限，实时显示占用与命中数，可一键清空；超出上限按 LRU 淘汰 |
| **应用内更新** | 设置 → 「检查更新」→ 读本仓库 GitHub Releases → 显示版本与更新说明 → 下载 APK → 调系统安装器升级（v0.2.0 新增，v0.2.1 起多源回退，v0.2.2 起直达安装器） |

## 目录结构

```
.
├── static/
│   ├── feed.html / feed.js / feed.css   # 沉浸场前端（WebView 加载）
│   └── index.html                      # 默认首页，跳转到 feed.html
├── server.py                           # 桌面调试服务器（/api/feed、/api/resolve、/api/media + 磁盘缓存）
├── start.cmd                           # Windows 一键起桌面版
├── _cache/                              # 桌面版视频磁盘缓存（运行时生成，已 gitignore）
├── android/
│   ├── build_apk.sh / build_apk.bat     # 免 Gradle 离线构建
│   ├── make_apk.py                      # 合并 dex + assets
│   └── app/src/main/
│       ├── AndroidManifest.xml         # 包名 com.vcncfootball，versionCode/Name
│       ├── java/com/hplayer/           # 注意：Java 包名仍是 com.hplayer
│       │   ├── MainActivity.java       # WebView、密度/视口、JS 桥、更新回调
│       │   ├── ProxyServer.java        # 本机 HTTP 服务（静态 + API 代理 + 缓存路由）
│       │   ├── MediaCache.java         # 视频字节磁盘缓存（LRU / 上限 / 命中统计）
│       │   ├── BiliApi.java            # feed / wbi 签名 / playurl / 评论
│       │   ├── UpdateChecker.java      # GitHub Releases 检查 + 下载
│       │   └── UpdateProvider.java     # content:// 暴露 APK 给系统安装器
│       └── res/
├── scripts/make_release.py              # 创建 GitHub Release 并上传 APK
├── release/                             # 每个版本的发布产物与说明（见 release/README.md）
└── _test/                               # cdp_eval.py（adb + CDP 读 WebView 状态）、真机升级验证截图
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

## 视频缓存怎么工作

这些比赛视频发布后不会再变，所以缓存只做「永久有效 + 按容量 LRU 淘汰」，不做 TTL 过期。

- **落点**：唯一的取流入口是本机代理 `/api/media/<token>/<v|a>?i=0`，缓存就做在这一层。
  Android 在 `MediaCache.java`，桌面调试版在 `server.py` 里是同语义实现，两边行为一致。
- **key 与 token 解耦**：`token` 每次 `/api/resolve` 都是新的 UUID，WebView 自带的 HTTP 缓存
  因此永远 miss。缓存 key 改成 `bvid|page|qn|v|a`，**关掉 App 再打开同一场比赛仍能命中**。
- **粒度**：沿用单次最多 3MB 的有界 Range，一条缓存 = 一个 `[start,end]` 字节区间文件。
  真机日志显示播放器每次 seek 都发**起点不同**的 3MB 请求，而且经常读一小段就断开，
  所以按「必须完整覆盖请求」判定几乎永远不命中。实际实现是：
  ① 被断开时把已下载的**连续前缀**也存成 `[start, start+written-1]`，不整条丢弃；
  ② 命中只要求某条目覆盖请求起点，206 只回它实际拥有的那一段（`Content-Range` 写真实范围，
  HTTP 允许），播放器会自己接着请求后续字节。N6 实测强杀重启后 `hits=9 / misses=0`、
  缓存占用零增长、logcat 无任何上游媒体请求。
- **不增加上游请求**：未命中时仍只向 B 站发一次请求，边转发边写临时文件，写满（或被 seek
  打断时按已下载前缀）才原子落盘。
- **淘汰**：按最后访问时间 LRU，超限后删到 90% 留余量，避免卡在阈值上反复抖动。
  额度存 Android `SharedPreferences` / 桌面 `_cache/config.json`，设置页启动时通过
  `/api/cache/config?mb=N` 下发，因此重启后仍然生效。
- **接口**：`/api/cache/stat`（占用 / 条目数 / 命中与未命中次数）、`/api/cache/clear`（一键清空）、
  `/api/cache/prefetch`（集锦预取，见下）。设置页「缓存占用」直接显示这些数字，
  命中数可以直观看出重开后是否真的没走网。
- **集锦预取**：解析成功后前端把本场**全部集锦片段**的时间区间按时长线性映射成字节区间
  （两端各留 2MB 余量），通过 `/api/cache/prefetch?token=..&kind=v|a&ranges=..` 交给本地代理
  在后台单线程逐块（4MB/块）落盘。**只缓存集锦片段，不缓存整场**；片段合计通常只有几十 MB。
  预取与播放共用同一份缓存条目，二次进入同一场 / 断网重放直接命中。

**默认 600MB 的依据**：实测一场 `01:17:01` 的比赛，视频流 `179,003,883 B`（170.7 MiB）、
音频流 `37,869,181 B`（36.1 MiB），整场合计约 **217 MB / 207 MiB**。一场的全部集锦片段
（37 段）按字节估算只有约 30~60MB，600MB 足够同时留住近十场常用比赛的片段数据；
偶尔想完整离线保存一整场也放得下（217MB × 2 场）。设置页提供 200M / **600M（默认）** / 1G / 2G 四档。

> 缓存目录：Android 在 `Android/data/com.vcncfootball/files/mediacache/`（App 专属外部存储，
> 卸载即清理）；桌面在仓库 `_cache/media/`，已加入 `.gitignore`，不会把几百 MB 视频字节提交进 Git。

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
cp android/VCNC-Football.apk release/VCNC-Football-v0.2.3.apk
#    写 release/v0.2.3.md，更新 release/SHA256SUMS.txt
# 3. 提交、打 tag、推送
git add -A && git commit -m "release: v0.2.3"
git tag v0.2.3 && git push origin main --tags
# 4. 建 Release 并上传 APK（token 取自 git credential，不落盘）
python scripts/make_release.py --tag v0.2.3
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
| 2026-11-07 | 三页横向滑动 + 虚拟列表 + 离屏停算（已随 v0.2.3 发布，真机压测 3021 条仅 20 个 DOM 行） |
| 2026-11-08 | 设置页去掉多余标题栏；新增前置/后置补时配置；集锦分类改为按备注字符真实筛选（候选字符 + 命中计数）；双指缩放改为纯自定义缩放、不再回弹到自动跟焦 |
| 2026-11-08 | 修复全屏下 `object-fit: cover` 裁掉两侧画面（新增「画面填充」设置，默认完整不裁切）；新增靠左半透明集锦浮窗（片段跳转 + 当前段高亮）与「锁」单片段循环（双 deck 无缝重播） |
| 2026-11-08 | N6（OPPO PLP110 折叠屏）部署验证后按反馈改 5 项：大屏单路解码修「只有声音画面不动」；浮窗列出全部片段且高度随屏幕；默认完整显示（含旧设置迁移）；比赛列表改手动「加载更多」（失败可重试）；取消左右滑动切页 |
| 2026-11-08 | 再按反馈改 3 项：冷启动误弹「没识别到 B 站链接」（`MainActivity` 分享兜底改为只在真收到 B 站分享内容且解析失败时提示）；去掉顶部 tab 改播放页右上角两个浮动半透明按钮；浮窗每行去掉「锁」、单段循环入口统一到左下角播放控件（已随 v0.2.3 发布） |
| 2026-11-08 | 新增视频/音频字节磁盘缓存：`/api/media` 层按 `bvid\|page\|qn\|kind` 落盘、区间覆盖命中、LRU 淘汰，关掉 App 再开同一场不再重复下载；设置页可调上限（100M / **200M 默认** / 500M / 1G）、看占用与命中数、一键清空；Android `MediaCache.java` 与桌面 `server.py` 同语义实现（已随 v0.2.3 发布） |
| 2026-11-08 | 缓存按反馈调整：默认上限 **200M → 600M**（档位改为 200M/600M/1G/2G）；新增**集锦预取**——解析成功后把本场全部集锦片段的字节区间经 `/api/cache/prefetch` 后台落盘，只缓存集锦不缓存整场（已随 v0.2.3 发布） |
| 2026-11-08 | 返回键重做：设置/列表页按返回回播放页；播放页第一次 Toast「再按一次退出」、两秒内再按才退出。播放页新增**单指横滑快进/回退**（拖满一屏 = ±90 秒，120ms 节流**跟手预览**，居中 OSD 显示增量与目标时间，段内边界钳制）。播放键左侧新增 **◀▶ 方向切换按钮**：按一下翻转播放方向，播放键箭头随之 ▶ 正放 / ◀ 倒放（不是 on/off 开关，暂停中也可换向）；倒放逐帧回退 currentTime、音频静音，慢动作三档同样生效，段首回绕到段尾；**调度按解码节奏驱动**——seeked 事件确认上一帧解码完成才发下一步（120ms 超时兜底），新旧 WebView（Chrome 74 红线到最新）同一条平滑路径，不空转 seek 不堆积；真机 Note8 / SM-S9080 双机验证（已随 v0.2.3 发布） |
| 2026-11-08 | 发布 **v0.2.3**（versionCode 5）：磁盘缓存 600M 默认 + 集锦预取、返回键三段语义、横滑 seek、倒放（多速率生效、seeked 驱动新旧内核通吃）、UI 浮动按钮重构 |
| 2026-11-08 | 真机反馈修复批次（12 项，**本地改动，尚未升版本/发布**）：横滑回退卡死修复（拖动期整体暂停预览 + tick 卡死看门狗轻推/重备）｜seek 改进度条指示（去居中 OSD，气泡显示增量/目标时间）｜冷启动偶发卡住自动重试（resolve 超时重试 + prepare 元数据换 URL 重试）｜控制条新增「跟」跟踪球按钮｜双指取景 cover→contain（全画面任意位置可达）｜「恢复画面」浮动按钮｜倒放引擎 v2 双 deck 乒乓流水（修 S9080 卡顿抖动鬼畜，S9080 实测步距均匀约 0.9× 实时）｜暂停恢复卡住看门狗覆盖｜集锦浮窗改右侧窄条 118px｜去底部提示字｜浮窗标题变集锦/全场切换按钮｜收起钮加大。Note8（Chrome 74）+ SM-S9080 双机 CDP 验证 |

原始 3 个提交的历史仍保留在 `volcanochen/H-Player` 本地 `vcnc-football` 分支；
本仓库为干净起点，不带实验视频与标注数据（原分支历史里有 222 MB 视频，超过 GitHub 单文件限制）。

## 免责声明

仅供个人学习研究使用。视频内容版权归哔哩哔哩及原作者所有，请勿用于任何商业用途。
