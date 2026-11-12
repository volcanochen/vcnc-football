# 技术文档

> 面向开发者与维护者。应用能干什么、怎么安装使用请看 [README](../README.md)；
> 按时间记录的迭代过程请看 [开发历史](DEVELOPMENT_HISTORY.md)。

---

## 目录结构

```
.
├── README.md                            # 面向用户：解决什么问题 / 特点 / 怎么装怎么用
├── docs/
│   ├── TECHNICAL.md                     # 本文档：架构、构建、接口、测试、限制
│   ├── DEVELOPMENT_HISTORY.md           # 按时间顺序的迭代与真机验证记录
│   └── RELEASE_GATE.md                  # 发布门禁清单、跑法与执行记录
├── static/
│   ├── feed.html / feed.js / feed.css   # 沉浸场前端（WebView 加载）
│   ├── qr.js                            # 纯 JS QR 编码器（byte/ECC M/v1~10，离线无依赖）
│   ├── social.js / social.css           # 左侧账号浮窗、App 授权登录、画质与三连
│   ├── clips.js / clips.css             # 自定义集锦：本地列表、工作室面板、分享码、评论区云同步
│   ├── index.html                      # 默认首页，跳转到 feed.html
│   ├── app-icon.png                    # 设置页品牌图标（与 launcher 图标同源）
│   ├── share-qr.png                    # 最新版下载页二维码
│   └── donate-qr.png                   # 微信收款码（从收款海报裁出白卡片）
├── scripts/
│   ├── gen_brand_assets.py              # 生成 5 档密度 launcher 图标 + 自适应图标
│   ├── gen_share_assets.py              # 生成分享/捐赠二维码
│   ├── release_gate.py                  # 发布门禁（版本/资源/语法/APK/文档/真机）
│   └── make_release.py                  # 创建 GitHub Release 并上传 APK
├── server.py                           # 桌面调试服务器（resolve / feed / media / net / replies / clips + 磁盘缓存）
├── social.py                            # 桌面版 B 站账号模块（与 Android BiliSocial.java 同语义）
├── start.cmd                           # Windows 一键起桌面版
├── share/index.html                     # 微信 H5 中转页（GitHub Pages 静态托管，数据在 URL fragment）
├── _cache/                              # 桌面版视频磁盘缓存（运行时生成，已 gitignore）
├── android/
│   ├── build_apk.sh / build_apk.bat     # 免 Gradle 离线构建（复制 3 张 PNG + 5 个 JS/CSS 模块进 assets）
│   ├── make_apk.py                      # 合并 dex + assets
│   └── app/src/main/
│       ├── AndroidManifest.xml         # 包名 com.vcncfootball，versionCode/Name，
│       │                               #   android:label=@string/app_name、icon=@mipmap/ic_launcher
│       ├── java/com/hplayer/           # 注意：Java 包名仍是 com.hplayer
│       │   ├── MainActivity.java       # WebView、密度/视口、JS 桥（含 openUrl/shareText/copyText）、更新回调
│       │   ├── ProxyServer.java        # 本机 HTTP 服务（静态 + API 代理 + 缓存/流量路由）
│       │   ├── MediaCache.java         # 视频字节磁盘缓存（LRU / 上限 / 命中统计）
│       │   ├── NetMeter.java           # 网络流量计量（真实上游字节 / 速度 / 累计 / 缓存节省）
│       │   ├── BiliApi.java            # feed / wbi 签名 / playurl / 评论
│       │   ├── BiliSocial.java         # 客户端授权(扫码兜底) / nav / 三连 / 凭证持久化
│       │   ├── UpdateChecker.java      # GitHub Releases 检查 + 下载
│       │   └── UpdateProvider.java     # content:// 暴露 APK 给系统安装器
│       ├── assets/www/                 # 构建时由 static/ 复制而来（含 3 张 PNG）
│       └── res/
│           ├── mipmap-*/               # ic_launcher / _background / _foreground（5 档密度）
│           ├── mipmap-anydpi-v26/      # adaptive-icon xml（square / round）
│           ├── values/strings.xml      # 中文名「VCNC足球」（默认）
│           ├── values-zh/strings.xml  # 中文名（防 Android 7+ 语言列表回退到 en）
│           └── values-en/strings.xml  # 英文名「VCNC football」
├── release/                             # 每个版本的发布产物与说明（见 release/README.md）
└── _test/                               # cdp_eval.py（adb + CDP 读 WebView 状态）、
                                         # regression.py（19 用例）、verify_brand_net.js（品牌/流量专项）、
                                         # verify_social.js（真机社交验收）、
                                         # verify_qr_matrix.py（QR 矩阵比对）、
                                         # verify_social_api.py（社交端点冒烟）
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

`release/` 是本地发布目录，详见 `release/README.md`；**发版前必须先过
[发布门禁](RELEASE_GATE.md)`scripts/release_gate.py`**（版本一致性、资源、语法、APK 内容与签名、
文档链接、双机回归），门禁 FAIL 时禁止发布。一次完整发布：

```bash
TAG=v0.3.0   # 本次要发的版本号（改成实际值，UpdateChecker 依赖 vX.Y.Z）
# 1. 改版本号（AndroidManifest.xml 的 versionCode / versionName），同步 README「当前版本」
bash android/build_apk.sh
# 2. 归档产物 + 校验和 + 版本说明
cp android/VCNC-Football.apk release/VCNC-Football-$TAG.apk
#    写 release/$TAG.md，更新 release/SHA256SUMS.txt
cd release && sha256sum VCNC-Football-*.apk > SHA256SUMS.txt && cd ..
# 3. 【门禁】双机装包 + 亮屏联网 + CDP 转发后
python scripts/release_gate.py --tag $TAG \
  --devices R5CT90R761Y:9922,ce061716d822c005017e:9923
# 4. 门禁全绿后，提交、打 tag、推送
git add -A && git commit -m "release: $TAG"
git tag $TAG && git push origin main --tags
# 5. 建 Release 并上传 APK（token 取自 git credential，不落盘）
python scripts/make_release.py --tag $TAG
```

脚本会打印 Release 页面地址；若同名 Release 已存在则复用并覆盖上传资产。
发布后复核见 [发布门禁 · 发布后复核](RELEASE_GATE.md#发布后复核)。

## 已知限制（重要）

- **端侧球检测不可靠**：2026-10-18 同帧对比实验证明，在真实 854×356 低清源上自研背景减除
  球检出率仅约 3%、人 0；YOLO11n 2× 上采样能到球 96%。所以正式效果依赖 **PC 预计算轨迹**。
  轨迹由独立仓库 [`volcanochen/FootballTracking`](https://github.com/volcanochen/FootballTracking)
  产出（YOLO + 颜色/运动/姿态融合 → Viterbi / 锚点跟踪），以 JSON 下发到 `/api/tracks/<bvid>`。
  端侧启发式只是兜底，请勿把它当作最终精度。该仓库后续的 `track_v2` / BallTracer 成果尚未回灌到端侧。
- **B 站风控**：动态 feed 请求**不能带 `Origin` 头**（会触发 -352 或返回空数据）；
  `-352` 是 IP 级滑动窗口限流，靠退避 + 刷新 buvid + 本地缓存兜底，登录 Cookie 可提高配额。
  评论接口 `/x/v2/reply` 的 `ps` 必须 ≤ 20；playurl 需要 wbi 签名。
- **B 站登录/三连是非公开接口**：2026-08 Web 登录已改版一次（SESSDATA 从返回 URL 改到
  `Set-Cookie`），`bilibili://browser` 深链也是未文档化入口，后续仍可能变。双端已对两条
  cookie 路径做兼容；唤起失败会自动回退到复制授权链接 / 二维码 / 手填 Cookie。但真实
  「点确认」与大会员态高画质必须由账号本人在设备上完成，自动化只覆盖到凭证到手之前。
- **老 WebView 兼容红线**：目标是 Android 9 / Chrome 74，前端禁用 `??`、`?.`、
  `replaceAll`、`:is()`、flex `gap`、`inset`、`clamp()`、`aspect-ratio` 等新语法。
- **manifest 必须声明 targetSdkVersion**，否则系统按 targetSdk=1 走屏幕兼容模式，
  UI 放大数倍、CSS 视口异常、点击错位。
- 真机验证主要在 Galaxy Note8 / SM-N9500（Android 9）上完成；`screencap` 偶发抓不到视频层（全黑），
  判断播放状态请用 `_test/cdp_eval.py` 读 WebView 状态 / 采样 canvas 像素，别只看截图。

## 自动化回归测试

每个功能需求沉淀为 `_test/regression.py` 里的一个用例，改动后跑一遍验证没被破坏——**改功能必改/加用例**。

```bash
# 设备在线 + CDP 转发后：
PID=$(adb -s <serial> shell pidof com.vcncfootball | tr -d '\r\n ')
adb -s <serial> forward tcp:9922 localabstract:webview_devtools_remote_$PID
python _test/regression.py            # 全量（刷新页面从头验证）
python _test/regression.py --no-reload  # 复用当前状态（快）
python _test/regression.py --list     # 用例清单
```

当前 19 个用例：UI 控件齐全、三页切换、返回键三段语义、横屏双指缩放、
**横屏缩放跨 deck 硬切不丢失**（回归：横屏自定义缩放失效）、竖屏分屏缩放、
恢复画面按钮、跟踪球按钮、横滑 seek 落点、倒放方向模型与箭头、暂停恢复、
集锦浮窗与全场/集锦切换、缓存上限接口（**回归：无参读取重置上限**）、设置迁移、时间对齐数学（toStream/toOrig 往返 + 片段映射 + orig 保留）、自动补时取值、时间码自动校准（真机 OCR 拟合或缓存命中，浮窗显示原始时间）、倒放 v5 抓帧引擎（被动预缓存/即时起播/后台补抓/pos 倒退/回正放恢复位置）、chrome 自动隐藏（浮动按钮随进度条淡出、播放键常驻）。
测试在横屏用 `Emulation.setDeviceMetricsOverride` 模拟视口、双指用逻辑级模拟
（直接驱动 startPinch/movePinch）；CDP 触摸注入在 Chrome 74 内核上不可达，不要依赖。

**手势模型（2026-11-11 起）**：单击画面 = 显示/隐藏浮窗，双击 = 播放/暂停。单击动作
延后 `DBL_MS`（260ms）执行，用来确认不是双击，否则双击时浮窗会先闪一下；双击走
`togglePlay(true)`（quiet 参数）跳过 `showChrome()`，避免「双击暂停」把刚收起的浮窗
又弹出来。因为单点即可即时收起，`CHROME_IDLE_MS` 曾放宽到 4500ms；**2026-11-13 按反馈
调回 `2000ms`（2 秒）**，自动隐藏仍只是「亮着不动」的兜底。为避免 2s 让正在操作的面板
突然消失，`hideChromeIdle()` 在 `#clipsStudio` 打开时会每秒复查、不淡出（面板关闭后再计时）。
单击与双击都要在捕获阶段吞掉浏览器随后合成的 click（`tapSynth` 时间+位置配对），
否则会点到刚恢复热区的隐藏控件。

两台设备同时验证时给第二台换一个本地端口即可：
`CDP_PORT=9923 python _test/regression.py`（`cdp.py` / `cdp_eval.py` / `regression.py`
都支持该环境变量，默认 9922；WebView 重启后 socket 名随 PID 变，要先 `pidof` 再 forward）。
本轮另加 `_test/verify_brand_net.js`：一次检查标题、流量 HUD 与设置行、分享区元素、
三张图片是否加载、三个 JS 桥以及 `/api/net/stat` 的返回值，并检查旧的
`#setBack` / `.sheet-foot` 确实不再存在。

社交模块另有三条独立验证线（都不需要真机点确认授权）：
`_test/verify_qr_matrix.py` 把 `qr.js` 的 32 个矩阵与 Python `qrcode` 标准库逐点比对；
`_test/verify_social_api.py` 在本机起 `server.py` 冒烟全部社交端点（凭证重定向到 `_test/out/`，自动清理）；
`_test/verify_top_row.js` 是真机 CDP 的顶部行专项：浮窗头部一行（头像 / 昵称 / 箭头）、
三连按钮挂在 `.ci-row` 内（标题那一行）、紧跟标题字符（间隙 ≤12px、同一水平线）、
HUD 与标题同行且贴页签、三项信息横排一行、播放键比其它键大、
倒放键空隙、收起箭头方向。`_test/verify_social.js` 检查左侧浮窗位置、`QRGen` 与 `VCNC` 契约、
App 授权桥与 `/api/social/auth`、二维码默认不绘制且兜底可实绘、chrome 同进退隐藏、
HUD 贴页签且三项同排一行、非大会员时画质按钮全禁用、三连接口返回（已登录时**不发**真实三连）。
`_test/verify_tap.js` 验证手势语义：单击显示/隐藏浮窗（等待 `DBL_MS` 判定窗口后生效）、
双击播停且**不**唤出浮窗（`togglePlay(true)` 静默路径）、双击后紧接单击仍能收起；
它直接调用页面里的 `onTap`，因为 `adb shell input tap` 两次点击间隔不可控。

`scripts/release_gate.py` 把上述回归与专项验收接成发布门禁，另做版本一致性、
资源完整性、语法与 Chrome 74 红线、APK 内容/包名/标签/签名、文档链接、
两端流量与社交接口对齐等静态检查；清单与执行记录见 [发布门禁](RELEASE_GATE.md)。

**v0.3.0 门禁实测**：SM-S9080（S22U，端口 9922）与 SM-N9500（Note8，端口 9923）
两台设备标准回归各 19/19，`verify_social.js` / `verify_top_row.js` / `verify_tap.js`
三条专项双机全绿（含物理 `input tap` 的单击隐藏、双击暂停实测）。真机两个老坑照旧：
S22U 曾因 WiFi 被关导致 offline，`svc wifi enable` 恢复后重跑；Note8 熄屏 Doze 需
`KEYCODE_WAKEUP` + `KEYCODE_MENU` 亮屏解锁，否则视口 0×0 会让用例大面积假失败。

> v0.2.5 的记录见 git 历史：品牌化 + 分享区 + 流量计量批次，双机 19/19 + `verify_brand_net.js` 全绿。

---

## 品牌资源：图标 / 名称 / 二维码

**命名**：中文 `VCNC足球`（`res/values/strings.xml`），英文 `VCNC football`（`res/values-en/strings.xml`）。
manifest 用 `@string/app_name` 引用而非硬编码，系统按语言自动切换；前端 `feed.html` / `index.html` 的 `<title>` 同步为中文名。

> **多语言回退坑（真机实测）**：Android 7+ 按用户的「语言偏好列表」逐个匹配资源。两台真机
> `persist.sys.locale=zh-Hans-CN`、WebView `navigator.language=zh-CN`，但列表第二项是 `en-US`；
> 只放 `values/`（默认中文）+ `values-en/`（英文）时，zh 这一级没有专门资源，系统会继续回退到
> 第二语言 en，于是桌面图标显示英文名。因此额外提供 `values-zh/strings.xml` 让中文环境第一优先级命中，
> 纯英文环境仍走 `values-en`，其它语言用默认中文。`aapt2 dump resources` 可核对三个配置的取值。

**图标设计**（`scripts/gen_brand_assets.py`，纯 Pillow，无外部素材）：深墨绿→草绿对角渐变 + 斜向草坪条纹 = 球场；
中央白色足球按截角二十面体投影画五边形与缝线，并用逐像素光照做球面体积；四角青色取景框 = 「自动跟焦 / 沉浸场」。
不放文字，因为 48px 下必然糊。生成物：

- `mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png`：48/72/96/144/192 px 圆角方图（旧 launcher 用）
- 同目录 `ic_launcher_background.png` / `ic_launcher_foreground.png`：108/162/216/324/432 px，
  前景内容缩到中间 66% 安全区，避免自适应图标裁掉足球或取景框
- `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`：Android 8+ 自适应图标
- `static/app-icon.png`：512px，设置页与 README 用

重生成：`python scripts/gen_brand_assets.py`（需要 Pillow）。构建脚本会把 `static/` 下的
`app-icon.png`、`share-qr.png`、`donate-qr.png` 一起复制进 `assets/www/`。

**二维码**（`scripts/gen_share_assets.py`，需要 `qrcode` + Pillow）：
`share-qr.png` 编码 `https://github.com/volcanochen/vcnc-football/releases/latest`（永远指向最新版）；
`donate-qr.png` 从收款海报里自动检测白色圆角卡片边界并裁出，去掉绿色广告底与底部 logo，
只留可扫的码 + 收款人名。资源是静态 PNG，运行时不联网、不依赖任何二维码服务。

## 设置页「分享与支持」与 JS 桥

设置页底部原「▶ 回到播放 + 说明文字」已删除，改为：品牌卡、下载二维码、一键分享 / 复制链接、
下载链接、VCNC B 站空间、GitHub 主页、GitHub Issues、B 站私信、微信打赏码。
返回入口移到设置页顶部 `.set-head` 的「‹ 播放」（`#setBackTop`），仍走 `goPage(1)`；系统返回键三段语义不变。

链接不能直接在 WebView 里 `location.href` 跳走（会离开本地页面且回不来），因此新增三个 `@JavascriptInterface`：

| 方法 | 作用 |
|---|---|
| `openUrl(String)` | `ACTION_VIEW` 交给系统浏览器 |
| `shareText(String)` | `ACTION_SEND` + `createChooser` 调系统分享面板 |
| `copyText(String)` | 写系统剪贴板并 Toast |

桌面调试版没有 `BiliBridge`，`nativeOpen` / `nativeShare` / `nativeCopy` 自动退回
`window.open` / `execCommand('copy')`。联系方式按用户选择只放公开渠道（GitHub Issues + B 站私信），
不写私人邮箱/微信号。

## 网络流量计量

**口径**：只统计真正从网络下载的字节；WebView 与 `127.0.0.1` 代理之间的回环流量、
命中磁盘缓存后从本地文件读出的字节都不计入。后者单独记为「缓存已省」，让用户直观看到缓存的价值。

埋点都汇到 `NetMeter.addNetwork` / `addSaved` 这一个入口：

| 位置 | 计入 |
|---|---|
| `BiliApi.httpGetString` | feed / 评论 / playurl / wbi 等接口响应体 |
| `MediaCache.Response.writeTo` | 视频音频流：`fromCache` → saved，否则 → network |
| `MediaCache.prefetchRange` | 后台集锦预取 |
| `ProxyServer.writeProxied` | 上游不给 206 时的透传兜底 |

`NetMeter.java`：`AtomicLong` 维护本次 / 累计 / 缓存节省；累计写 `SharedPreferences("netmeter")`，
每 5 秒或每 1MB 节流落盘，`onDestroy` 强制 flush；速率按两次 `/api/net/stat` 采样之间的增量算瞬时值
再做指数平滑（上升 α=0.65、下降 α=0.35，<1KB/s 直接归零），并通过 `ConnectivityManager`
返回 `wifi` / `mobile` / `offline`。

接口：

- `GET /api/net/stat` → `{ok, speed, session, total, sessionSaved, saved, network, ts}`（`speed` 单位 B/s）
- `GET /api/net/reset` → 清零累计口径后返回同一结构；**只清统计，不删缓存文件**

前端 `initNetMeter()` 每 1.2s 轮询一次，渲染两处：

- 播放页 `#netHud`：与标题**同一行**、靠右贴住「列表 / 设置」页签，竖排三行
  `↓ 速率 / 本次 / 累计`（随 chrome 一起淡出）。`network === "mobile"` 时加 `.mobile`
  变橙并写明「移动」
- 设置页「网络流量」行：当前速度 / 本次 / 累计 / 缓存已省，附「清零」按钮与口径说明

桌面 `server.py` 有同语义的纯 Python `NetMeter`（在 `http_json*`、媒体上游转发、缓存命中三处埋点），
区别是不跨进程持久化、`network` 恒为 `desktop`。

> 仍遵守 Chrome 74 兼容红线：新增前端代码只用 `var` / `function` / `fetch().then`，
> 不用 `??`、`?.`、`:is()`、flex `gap` 等。流量 HUD 用 `position:absolute` 而非 `inset`。

### 顶部那一行怎么排的（2026-11-11 起）

播放页顶行现在同时塞了四样东西：**标题 / 三连按钮 / 流量 HUD / 列表·设置页签**
（「播放」页签在当前页隐藏，所以 `#pageNav` 实测只占 116px）。

- `.chinfo` 改成 flex 行：标题块 `.ci-main`（`min-width:0` + `text-overflow:ellipsis`）
  与三连按钮 `.ci-triple`（`social.js` 注入，`pointer-events:auto` 单独放开）。
- 位置不写死：`feed.js` 的 `layoutTopRow()` 每次 `renderNet` 时按 `#pageNav`、
  `#netHud` 的**实测宽度**反算 `right`（HUD = 页签宽 + 18，`.chinfo` = 再让出 HUD 宽 + 8），
  `resize` 时重算。
- **设备端 WebView 设了 `setMinimumFontSize(12)`**（`MainActivity`），任何 <12px 的
  CSS 字号在真机上都按 12px 渲染——宽度必须按 12px 估算，写 9px/10px 只会让渐变失效、
  布局算错。HUD 因此改成竖排三行（宽 ~70px）而不是一行长字符串（同样内容要 156px，
  会把标题挤成 0 宽）。
- 标题过长时会被省略号截断。为了让截断后仍看得出是哪一场，`ClipPlayer.render()` 在
  **显示时**去掉开头的 `[实况录像+集锦]` 这类分类标签（副标题里已有「集锦」），
  完整标题写进 `title` 属性；`VCNC.getState().title` 仍是原始完整标题。

---

## 自定义集锦模块

数据格式、评论区协议、分享码与微信跳转的完整设计见 [自定义集锦方案](CUSTOM_CLIPS.md)，这里只记工程接线。

| 层 | 落点 |
|---|---|
| 本地持久化 | `clips.js` → `localStorage['vcnc.clips.v1']`，`{ bvid: { nick, list:[clip] } }`，未登录也能用 |
| 播放序列 | `feed.js: ClipPlayer.buildSegs()` 开头把 `VCNCClips.forVideo(bvid)` 返回的伪 matched 项 `concat` 进官方时间戳，共用排序 / 截断 / 连播调度；自定义片段带 `src / user / cid`，且**不吃自动补时**（用户框的是精确起止） |
| 时间轴 | 制作时 `VCNC.getTime().orig`（`toOrig(currentTime)`）落盘，和置顶评论同一条原始录像时钟；播放时 `toStream()` 换回，校准改动不会让片段漂移 |
| 浮窗 | `renderSegFloat()` 给行加 `.src-mine / .src-cloud / .src-other`，整行文字换色 + 左侧色条 + 淡底，与官方白/灰区分；`.sf-tools` 两个按钮：`＋制作` 打开 `#clipsStudio`，`自定义` 调 `VCNCClips.setMineOnly()` 只过滤**显示**（`segs` 与 `data-i` 不变，点行跳段不错位）。`inChrome()` 与 `body.chrome-off` 都把面板算进去 |
| 同层显隐 | 工作面板**与播放画面同层**：`body:not([data-page="1"]) #clipsStudio`（比赛列表 / 设置页时退场，`goPage()` 同步 `data-page`）+ `body.soc-modal-open #clipsStudio`（登录弹层开着时退场，`social.js` 开关弹层时同步该 class），两条规则都是 `opacity:0 + pointer-events:none`，不与 `.clip-studio[hidden]` 的 display 冲突；切回播放页 / 关掉弹层即恢复原状 |
| 制作面板 | 只有起点 / 终点 / 预设备注 / 自定义文字框 / 保存五个控件；无编号标题、无步骤说明，起点终点用按钮点亮态反馈，区间写在保存按钮 `title`。昵称不再单独输入，取 `getNick()`；「导入集锦」按钮与 textarea 已删，导入统一走「从剪贴板导入」+ `?imp=` 深链自动导入 |
| 评论区读写 | 两端 `/api/replies`（GET）、`/api/clips/publish`、`/api/clips/delete`（POST + 同源校验）；`BiliSocial.java` / `social.py` 各用 `x/v2/reply/add|del`，前端统一解析 `【VCNC集锦v1】` 格式 |
| 自动读回 | `clips.js` 2s 轮询 `VCNCSocial.getMe()`，登录态 false→true 或换场时拉一次；`-412` / 空结果按 30s 退避，防止把 IP 打进更长的黑名单 |
| 分享导入 | `VC1.<base64url>.<crc8>`；`shareText` 桥发微信，H5 中转页 `share/index.html` 试 `vcncfootball://import?b=&d=`，微信拦下就用 `getClipboardText()` 桥 + 粘贴兜底；`MainActivity.handleIntent` 把码写成 `feed.html?imp=` |

`_test/verify_clips_codec.js` 是免设备编解码回归（Node + 最小 DOM 桩，27 项）；
`_test/verify_share_page.js` 把微信中转页的内联脚本放进同一类 DOM 桩执行（11 项），
防止 H5 页独立实现的 `crc8` / `base64url` 与 App 内 `clips.js` 漂移；
`_test/verify_clips.js` 是真机 CDP 专项（DOM / 契约 / 混排配色 / 面板精简 / 「自定义」筛选 /
2s 自动隐藏 / 与播放画面同层，跑完自动删掉临时片段）。
三条线里前两条已并入发布门禁的「集锦编解码回归」，第三条是每台真机的「集锦验收」。

---

## B 站账号社交模块

**这是一个刻意做成「相对独立」的功能**：播放链路（双 deck / 片段调度 / 倒放 / 手势）零改动，
只通过 `feed.js` 暴露的 `window.VCNC` 契约与它交互。契约缺失时 `social.js` 自动降级为只读，
不会抛错；桌面调试版与 APK 共用同一份前端。

| 层 | Android | 桌面 | 前端 |
|---|---|---|---|
| 路由（controller） | `ProxyServer.route` | `Handler.do_GET` / `do_POST` | `social.js` 的 `api()` |
| 业务（service） | `BiliSocial.java` | `social.py` | 浮窗渲染 / 轮询状态机 |
| 存储 | `files/social.json`（应用私有目录） | `~/.vcnc-football/social.json` | 只存画质档位、三连记录、折叠态，不存凭证 |
| 二维码 | — | — | `qr.js`（本地编码，不联网，仅兜底） |
| 客户端唤起 | `MainActivity.BiliBridge.biliAuth` + Manifest `<queries>` | — | `BiliBridge.biliAppInstalled()` |

### 端点（两端同语义）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/social/auth` | 申请**客户端 App 授权**会话，返回 `{ok, url, key, ttl, mode:'app'}` |
| GET | `/api/social/qrcode` | 同一会话的兼容别名 / 桌面二维码兜底，返回 `{ok, url, key, ttl}` |
| GET | `/api/social/poll?key=…` | 轮询一次授权状态：`wait` / `scanned` / `expired` / `done`；成功时持久化凭证并返回 `me` |
| GET | `/api/social/me[?force=1]` | `x/web-interface/nav`：账号信息与大会员判定，缓存 30s |
| POST | `/api/social/triple` | 一键三连，body `bvid=…` |
| POST | `/api/social/manual` | 手填 Cookie 兜底，body `cookie=…` |
| POST | `/api/social/logout` | 只清本机凭证 |

写操作一律 POST + `Origin` / `Referer` 同源校验（本地代理监听 `127.0.0.1`，第三方网页
否则可以用跨站请求触发三连）。`ProxyServer` 为此补了 POST body 解析；`server.py` 补了 `do_POST`。

### 客户端 App 授权登录（默认路径）

1. 前端点「登录 / 授权」→ 自动调 `/api/social/auth`，拿到 `{ok, url, key, ttl, mode:'app'}`。
2. `MainActivity.BiliBridge.biliAppInstalled()` 通过 Manifest `<queries>` 里声明的包名检查本机
   B 站客户端（`tv.danmaku.bili` / HD / 国际版）。已安装则 `biliAuth(url)` 用官方
   `bilibili://browser?url=<encoded>` 深链把授权页交给 App 内 WebView 打开。**必须
   `setPackage`**：本应用自己也声明了 `bilibili://` intent-filter，不指定包名会弹选择器甚至自跳转。
   真机实测打开 `tv.danmaku.bili/.ui.webview.MWebActivity`，页面含账号卡片与「确认」按钮，
   用户点一下即可，**全程不需要相机扫码**。未安装 / 唤起失败时自动展开「其他登录方式」，
   可复制授权链接，或用 `qr.js` 把同一 URL 画成二维码（桌面调试版默认走这一支）。
3. 前端每 1.5s 调 `/api/social/poll`（最多 180s）；从 B 站 App 切回时 `visibilitychange`
   立即补一次轮询。二维码与 App 授权**共用同一个 passport 会话**，poll 成功后同样拿
   `SESSDATA` / `bili_jct`。
4. **B 站 2026-08 起登录改版**：成功时不再把 `SESSDATA` 拼在返回 URL 上，而是由 poll
   响应的 `Set-Cookie` 下发。双端以 Set-Cookie 为主路径，兼容旧版 crossDomain URL 参数，
   两条都没拿到时再 GET 一次 SSO 地址。
5. 拿到凭证后清 `RESOLVE_CACHE` / `FEED_CACHE`（否则旧的匿名 playurl 结果会被复用），
   返回 `me`，前端 `VCNC.reload()` 保存进度后重载页面重新取流。

> 不走开放平台 OAuth2：那需要申请 `client_id` / `secret`，且换回的 `access_token` 只能访问
> 开放接口，拿不到 `SESSDATA`，三连与大会员 playurl 都用不了。本方案复用 Web 登录会话；
> B 站 H5 授权页标题仍写着「哔哩哔哩扫码登录」，那只是固定文案，操作上无需扫码。

**大会员画质**：`/api/resolve` 与 `/api/feed` 在未显式传 `cookie` 时自动使用
`BiliSocial.userCookie()` / `social.user_cookie()`，所以登录后 playurl 自然返回
`accept_quality` 里的高码率档位；`qn` 持久化在 `vcnc.qn.v1`，切换画质走
`VCNC.setQuality(qn)` → 保存进度 → reload。媒体缓存 key 含 `qn`，不同档位不会串流。
前端仅在 `me.vip === true`（`nav` 的 `vipStatus===1 && vipType>0`）时启用画质按钮。
> 真机游客态实测：请求 `qn=80`，B 站实际只给 `quality=32`（480P）——这正是画质门禁必须绑定登录态的原因。

**三连**：`POST https://api.bilibili.com/x/web-interface/archive/like/triple`，
form `bvid` + `csrf`（取 Cookie 里的 `bili_jct`），Cookie 必须含 `buvid3`（否则触发风控）。
`bvid` 来自 `VCNC.getState()`，即**当前正在播放的那场 VCNC 视频**。前端按 bvid 记录「已三连」，
避免重复点击；`-101` / `-111` 映射为「登录过期，请重新授权登录」，`65006` 映射为「已经三连过啦」。

### 安全边界

- 凭证只落应用私有目录 / 用户目录，**不下发前端、不写日志**（日志只打印状态）、不入库；
  所有 API 响应都不含 `SESSDATA` / `bili_jct` 原文。
- 登出不调用 B 站 `/web/logout`，避免踢掉用户其它设备。
- 三连 / 登出 / 手填走 POST + 同源校验；`url` / `key` 等参数在后端做白名单校验
  （`key` 必须匹配 `[A-Za-z0-9_-]{16,64}`，`bvid` 必须匹配 `BV[0-9A-Za-z]{10}`）。
- 头像直接由 `<img referrerpolicy="no-referrer">` 加载，失败回退成昵称首字，不新增二进制代理路由。

### 为什么自研 QR 编码器

APK 离线运行，WebView 不能依赖 CDN；B 站登录 URL 每次都不同（实测 145 字节），
也不能预生成图片。`static/qr.js` 只实现登录场景需要的子集：
**byte mode / ECC M / version 1~10**（最长 213 字节，145 字节落在 version 8），
GF(256) Reed–Solomon、块交织、功能图形、8 种掩模自动评分，全部 ES5 + Canvas 2D。
`_test/verify_qr_matrix.py` 把 4 组文本 × 8 种掩模（共 32 个矩阵）与 Python
`qrcode` 标准库逐点比对，实测 **0 差异**；`_test/verify_social.js` 在真机上验证
canvas 实际渲染出 212×212、约 1.9 万深色像素的可扫图形。

### 验证

```bash
python _test/verify_qr_matrix.py     # QR 矩阵 32/32 与标准库一致（需 node + Python qrcode 库，仅测试用）
python _test/verify_social_api.py    # 桌面端点冒烟：登录/轮询/三连/跨站/手填/登出，凭证重定向到 _test/out/
# 真机（CDP 转发就绪后）：
CDP_PORT=9923 python _test/cdp_eval.py _test/verify_social.js
```

`scripts/release_gate.py` 已把 3 个新 JS 纳入 `node --check` 与 Chrome 74 红线、
把 `social.py` 与两个新验证脚本纳入 AST 编译、把 10 个 `assets/www` 文件纳入 APK 内容检查，
双机门禁另加 `_test/verify_social.js` 专项验收（浮窗位置、二维码渲染、画质门禁、三连接口）。

**未覆盖**：真实扫码确认、大会员态下的高画质切换与真实三连，必须由账号本人在设备上完成；
自动化只验证到「凭证到手之前」的全部链路与未登录态门禁。

