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
│   ├── index.html                      # 默认首页，跳转到 feed.html
│   ├── app-icon.png                    # 设置页品牌图标（与 launcher 图标同源）
│   ├── share-qr.png                    # 最新版下载页二维码
│   └── donate-qr.png                   # 微信收款码（从收款海报裁出白卡片）
├── scripts/
│   ├── gen_brand_assets.py              # 生成 5 档密度 launcher 图标 + 自适应图标
│   ├── gen_share_assets.py              # 生成分享/捐赠二维码
│   ├── release_gate.py                  # 发布门禁（版本/资源/语法/APK/文档/真机）
│   └── make_release.py                  # 创建 GitHub Release 并上传 APK
├── server.py                           # 桌面调试服务器（/api/feed、/api/resolve、/api/media、/api/net/stat + 磁盘缓存）
├── start.cmd                           # Windows 一键起桌面版
├── _cache/                              # 桌面版视频磁盘缓存（运行时生成，已 gitignore）
├── android/
│   ├── build_apk.sh / build_apk.bat     # 免 Gradle 离线构建（同时把 3 张 PNG 复制进 assets）
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
                                         # regression.py（19 用例）、verify_brand_net.js（品牌/流量专项）
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
TAG=v0.2.5   # 本次要发的版本号（改成实际值，UpdateChecker 依赖 vX.Y.Z）
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

两台设备同时验证时给第二台换一个本地端口即可：
`CDP_PORT=9923 python _test/regression.py`（`cdp.py` / `cdp_eval.py` / `regression.py`
都支持该环境变量，默认 9922；WebView 重启后 socket 名随 PID 变，要先 `pidof` 再 forward）。
本轮另加 `_test/verify_brand_net.js`：一次检查标题、流量 HUD 与设置行、分享区元素、
三张图片是否加载、三个 JS 桥以及 `/api/net/stat` 的返回值，并检查旧的
`#setBack` / `.sheet-foot` 确实不再存在。

`scripts/release_gate.py` 把上述回归与专项验收接成发布门禁，另做版本一致性、
资源完整性、语法与 Chrome 74 红线、APK 内容/包名/标签/签名、文档链接、
两端流量接口对齐等静态检查；清单与执行记录见 [发布门禁](RELEASE_GATE.md)。

**v0.2.5 门禁实测**：SM-S9080（S22U，端口 9922）与 SM-N9500（Note8，端口 9923）
两台设备标准回归各 19/19，`verify_brand_net.js` 双机全绿；期间 S22U WiFi 被关导致
首次验收 offline，`svc wifi enable` 恢复后重跑通过；Note8 熄屏 Doze 需
`KEYCODE_WAKEUP` + `KEYCODE_MENU` 亮屏解锁，否则视口 0×0 会让用例大面积假失败。

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

- 播放页左上角 `#netHud` 常驻小胶囊（不随 chrome 自动隐藏）：`↓ 当前网速 · 本次已用`；
  `network === "mobile"` 时加 `.mobile` 变橙并写明「移动数据」
- 设置页「网络流量」行：当前速度 / 本次 / 累计 / 缓存已省，附「清零」按钮与口径说明

桌面 `server.py` 有同语义的纯 Python `NetMeter`（在 `http_json*`、媒体上游转发、缓存命中三处埋点），
区别是不跨进程持久化、`network` 恒为 `desktop`。

> 仍遵守 Chrome 74 兼容红线：新增前端代码只用 `var` / `function` / `fetch().then`，
> 不用 `??`、`?.`、`:is()`、flex `gap` 等。流量 HUD 用 `position:absolute` 而非 `inset`。

