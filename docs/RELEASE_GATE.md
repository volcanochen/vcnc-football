# 发布门禁

> 面向维护者：一个版本从「改完代码」到「按发布按钮」之间必须跨过的检查线。
> 用户说明见 [README](../README.md)，构建与发布步骤见 [技术文档](TECHNICAL.md)，
> 每次迭代与验证结论见 [开发历史](DEVELOPMENT_HISTORY.md)。

**原则：门禁没过，不发版。** 本应用靠 GitHub Releases 做应用内更新，一个坏 APK 会推给所有已装用户，
而自签名 APK 无法撤回；所以宁可多跑一遍，也不能靠「看着没问题」发布。

---

## 门禁清单

由 [`scripts/release_gate.py`](../scripts/release_gate.py) 自动执行，任一项 FAIL 即退出码 1。

| 组 | 检查项 | 为什么必须查 |
|---|---|---|
| 版本一致性 | tag 格式 `vX.Y.Z`、tag 与 manifest `versionName` 一致、tag 未被占用 | `UpdateChecker` 靠 tag 做语义版本比较，格式错会不提示更新 |
| 版本一致性 | `versionCode` 比上一个 tag 严格递增 | 否则系统拒绝覆盖安装 |
| 版本一致性 | README「当前版本」、`release/<tag>.md` 的 tag/版本码 | 用户看到的版本号必须和实际 APK 一致 |
| 版本一致性 | `release/<tag>.apk` 与构建产物字节一致、`SHA256SUMS.txt` 校验和匹配 | 应用内更新的 CDN 回退源读的是仓库 `release/` 里的 APK |
| 版本一致性 | 归档 APK 没有被 `.gitignore` 忽略、私钥未入库 | 漏提交 APK = 备用下载源 404；私钥入库 = 签名失守 |
| 源码 | 4 个 JS（`feed.js` / `qr.js` / `social.js` / `clips.js`）`node --check`、10 个 Python 文件 AST 编译 | 语法错误在 WebView 里是白屏，构建脚本不会报 |
| 源码 | Chrome 74 红线（`??` `?.` `replaceAll` `:is()` flex `gap` `inset` `clamp()` `aspect-ratio`）零命中，覆盖 4 个 JS + 3 个 CSS | 目标机型 Note8 是 Chrome 74，用了就直接崩；`clips.css` 初稿的 `min()` 也是同类红线 |
| 源码 | `feed.html` 的 11 个本地 `src` / `href` 引用都存在 | 二维码/图标/脚本缺一个会让页面缺块或模块加载失败 |
| 源码 | 社交模块 5 个文件齐全（`social.py` / `qr.js` / `social.js` / `social.css` / `BiliSocial.java`） | 漏文件会让账号浮窗静默不工作 |
| 源码 | App 授权主路径 11 项齐全（JS 桥检测/唤起、`<queries>` 包可见性、`bilibili://browser` 深链、`/api/social/auth`、二维码默认折叠、浮窗同进退隐藏、HUD 与标题同行靠右且信息未精简、三连按钮在标题行、隐藏时长 2~8s、单击显隐/双击播停） | 唤起链路断一节，登录就退化成假功能 |
| 源码 | **集锦编解码回归** `_test/verify_clips_codec.js` ≥25 项 + `_test/verify_share_page.js` ≥10 项全绿 | 分享码 / 评论文本 / 微信 H5 中转页是三处独立实现，纯 Node 免真机就能挡住篡改、分片、mid 分组、去重与两份解码器漂移 |
| 源码 | **集锦模块文件** 7 个（`clips.js` / `clips.css` / `CUSTOM_CLIPS.md` / `share/index.html` / 三个验收脚本）+ `vcncfootball://import` 深链 + `getClipboardText()` 桥 + `CLIP_CODE` 解析齐全 | 导入链路任一节缺失，朋友分享的集锦就进不来 |
| 源码 | **风控韧性回归** `_test/verify_risk_guard.py` ≥40 项全绿（模拟 -352 / HTTP 412 / view 阶段受限 / feed 冷却期，含三端静态契约） | 断路器、快照降级、冷却期 0 请求任一节退化，风控时就会重新变成「加载失败」白屏 |
| 资源 | 5 档密度 × 4 张 launcher 图 + 2 个自适应图标 XML + 3 张分享图齐全 | 缺某档在对应 DPI 设备上会回退成模糊图标 |
| 资源 | `values` / `values-zh` / `values-en` 三套名称 + manifest 用 `@string/app_name` | 少 `values-zh` 会让中文系统回退到英文（真机踩过） |
| 资源 | `build_apk.sh` 与 `build_apk.bat` 都复制 3 张 PNG + 社交 3 个 + 集锦 2 个文件 | 两条构建链产物必须一致 |
| APK | zip 内 `assets/www/` 12 个文件齐全 | 前端资源漏拷，装上去是空壳 |
| APK | `aapt2 dump badging`：包名 / 版本 / 中英标签 / 图标 | 名称、图标、版本号最终以 APK 为准 |
| APK | `apksigner verify` 通过 | 签名不一致用户装不上更新 |
| 文档 | 6 份文档（含 `CUSTOM_CLIPS.md`）的相对链接全部有效 | 拆文档后最容易留下死链 |
| 接口 | Android `ProxyServer` 与桌面 `server.py` 都有 2 条流量 + 7 条社交 + 1 条评论读取 + 2 条集锦写入端点；前端 4 个控件 id 齐全 | 两端行为要对齐，桌面调试不能是哑实现；评论写操作必须 POST + 同源 |
| 真机（可选） | 每台设备 `_test/regression.py` 全量 20/20 | 防回归，改功能必跑（2026-11-13 起含 seek-fast 非线性快拖） |
| 真机（可选） | 每台设备 `_test/verify_brand_net.js` 全绿 | 品牌 / 分享区 / 流量接口专项验收 |
| 真机（可选） | 每台设备 `_test/verify_social.js` 全绿 | 左侧浮窗、App 授权桥与端点、二维码默认不显示且兜底可实绘、同进退隐藏、HUD 贴页签且三项同排一行、三连按钮在标题行且未登录为灰、画质档位人人可点（含游客态）、三连接口（已登录时不发真实三连） |
| 真机（可选） | 每台设备 `_test/verify_top_row.js` 全绿 | 顶行排布专项：头像/昵称/箭头同一行、三连紧跟标题（同一行、间隙 ≤12px）、HUD 同行贴页签且只占一行、播放键更大、倒放键留空隙、收起箭头朝左 |
| 真机（可选） | 每台设备 `_test/verify_tap.js` 全绿 | 手势语义：单击显示/隐藏浮窗、双击播停且不唤出浮窗、双击后单击仍生效 |
| 真机（可选） | 每台设备 `_test/verify_clips.js` 全绿 | 自定义集锦：契约与 `＋制作 / 自定义` 工具行齐全（旧云端/导入按钮确已移除）、真机 WebView 中文 `btoa/atob` 分享码往返、临时片段混排且整行文字与官方行不同色、制作面板只留五个控件且无编号步骤/导入按钮、`增量/全量发布` 两按钮齐全且旧 `csPublish` 已移除、分享按钮是 SVG 图标、点行文字进入行内编辑且可取消、筛选开启时 `nextIdx()` 只指向 `mine` 段、`自定义` 筛选后只剩 `src-mine` 行且能恢复、`CHROME_IDLE_MS=2000`、切列表页 / 注入登录弹层 class 时面板 `opacity=0 + pointer-events=none` 且回播放页恢复、临时片段可删且恢复 |

免设备的五条独立回归线（改社交 / 集锦 / 解析链路时建议先跑）：

```bash
python _test/verify_qr_matrix.py     # QR 矩阵与标准库逐点比对（需 node + Python qrcode 库，仅测试用）
python _test/verify_social_api.py    # 桌面端点冒烟（含集锦空内容/未登录/非法 rpid/跨站 403），不发真实评论
node _test/verify_clips_codec.js     # 分享码 + 评论文本编解码 36 项（含行内编辑/发布记录），纯 Node 免真机
node _test/verify_share_page.js      # 微信 H5 中转页解码 11 项（正常码/查询串/篡改/缺码/中文）
python _test/verify_risk_guard.py   # 风控断路器 + 快照降级 44 项，替身 urlopen 不发真实请求
```

> **未发版时的预期 FAIL**：只要 `android/VCNC-Football.apk` 已含新改动但还没升版本归档，
> 「APK 归档一致」必然 FAIL（`release/VCNC-Football-<tag>.apk` 还是上一版）。这是门禁在正确工作，
> **不是**可以绕过或手工改校验和的理由；只有走完升版本 → 归档 → 更新 `SHA256SUMS.txt` 才能转绿。
>
> 另一个常见「假警报」：源码已经 commit 到 `main`、HEAD 越过已发布的 tag 之后，再用旧 tag
> （如 `--tag v0.3.0`）跑门禁做开发自检，「tag 未占用」也会 FAIL（`tag 已存在且不在 HEAD`）。
> 该检查是为「发布后从 tag 幂等复核」设计的，源码继续前进时本来就不该过；此时应看
> 其余静态检查与真机检查，别把这两项当成代码回归。真正发新版时要用新 tag 全量重跑。

真机部分之外都是纯静态检查，不需要设备；`--devices` 才跑真机。

---

## 怎么跑

发布前依次完成（顺序不能反，门禁校验的是「已经准备好的发布物」）：

```bash
# 1. 升版本：AndroidManifest.xml 的 versionCode +1 / versionName
# 2. 同步所有文档（README 当前版本、release/<tag>.md、开发历史、技术文档）
# 3. 构建
bash android/build_apk.sh
# 4. 归档
cp android/VCNC-Football.apk release/VCNC-Football-v0.3.0.apk
cd release && sha256sum VCNC-Football-*.apk > SHA256SUMS.txt && cd ..
# 5. 双机装包 + 亮屏联网 + 建 CDP 转发
for pair in "R5CT90R761Y:9922" "ce061716d822c005017e:9923"; do
  s=${pair%%:*}; p=${pair##*:}
  adb -s $s install -r android/VCNC-Football.apk
  adb -s $s shell input keyevent 224          # 唤醒
  adb -s $s shell input keyevent 82           # 解锁
  adb -s $s shell am start -n com.vcncfootball/com.hplayer.MainActivity
  PID=$(adb -s $s shell pidof com.vcncfootball | tr -d '\r\n ')
  adb -s $s forward tcp:$p localabstract:webview_devtools_remote_$PID
done
# 6. 跑门禁（含真机）
python scripts/release_gate.py --tag v0.3.0 \
  --devices R5CT90R761Y:9922,ce061716d822c005017e:9923
```

真机门禁前的两个已知坑（都会表现为回归大面积失败，不是代码问题）：

- **设备熄屏 / Doze**：WebView 视口会变成 0×0、视频暂停。先 `KEYCODE_WAKEUP` + `KEYCODE_MENU` 亮屏解锁。
- **WiFi 被关**：`fatal` 面板会顶住播放器，用例全挂。先 `svc wifi enable`，再在列表里点「重试」。

只看静态检查时省略 `--devices`：

```bash
python scripts/release_gate.py --tag v0.3.0
```

FAIL 时脚本会列出具体项；修完**从头重跑全部检查**，不要只补跑失败的那一项
（改文档/重建 APK 可能破坏前面已通过的项）。通过后才能执行
[发布流程](TECHNICAL.md#发布流程)：commit → tag → push → `make_release.py`。

---

## 发布后复核

Release 建好后还要确认三件事（脚本管不到线上状态）；门禁脚本允许在
tag 已打、且 tag 正好指向当前 HEAD 时重跑（发布后复核模式），
`versionCode` 递增也会自动跳过当前 tag 再比较上一版：

1. Release 正文与 `release/<tag>.md` 一致，资产里有且只有一个 `.apk`，大小与归档一致。
2. 应用内「设置 → 软件更新 → 检查更新」能读到新版本，且下载安装链路走通（官方资产失败时 CDN 回退）。
3. 覆盖安装后中文桌面名、图标、设置页分享区、流量 HUD 都还在（升级不丢资源）。

---

## 执行记录

| 版本 | 日期 | 静态门禁 | 真机门禁 | 备注 |
|---|---|---|---|---|
| **未发版**（自定义集锦，源码 tag 仍 v0.3.0） | 2026-11-12 | **23/24**（唯一 FAIL＝「APK 归档一致」，`android/VCNC-Football.apk` 已含集锦而归档仍是 v0.3.0，属未升版本的预期结果） | **全 PASS**：S22U 19/19 + Note8 19/19；两台的品牌/分享/流量、社交、手势、**集锦**四条专项全绿；合计 **33/34** | 自定义集锦批次。新增静态检查「集锦编解码回归 27 + H5 页 11 项」「集锦模块文件 7 个」，每台真机新增「集锦验收」；`_test/out/gate_clips_final.log` 留档。免设备另跑 `_test/verify_clips_codec.js` 27/27、`_test/verify_share_page.js` 11/11、`_test/verify_social_api.py` 0 失败；GitHub Pages 中转页 `https://volcanochen.github.io/vcnc-football/share/` 已构建到同批 commit 并返回 200；S22U 真机 `vcncfootball://import` 深链成功导入。**未升版本、未归档、未打 tag、未发 Release**，因此门禁按设计输出「禁止发布」 |
| v0.3.0 | 2026-11-11 | **静态全 PASS** | **全 PASS**（S22U 19/19 + Note8 19/19，社交 / 顶行 / 手势三条专项双机全绿） | B 站账号社交模块 + 顶行重排 + 新手势批次；归档 APK versionCode 8、sha256 见 SHA256SUMS.txt |
| v0.4.0 | 2026-11-13 | **静态全 PASS**（25 项，含风控韧性回归 44、集锦编解码 36 + H5 页 11、画质开放契约） | **全 PASS**（S22U 20/20 + Note8 20/20，品牌/分享/流量、社交、手势、集锦四条专项双机全绿；合计 **35/35**） | 自定义集锦 + 非线性快拖 + 画质开放 + 风控韧性批次；归档 APK versionCode 9、sha256 `1b467b09…` 见 SHA256SUMS.txt |
| v0.2.5 | 2026-11-10 | **20/20 PASS** | **4/4 PASS**（S22U 19/19 + Note8 19/19，两台专项验收全绿） | 总计 **24/24 PASS**。品牌化 + 分享区 + 流量计量批次；归档 APK sha256 `5943bb4704c7c0fa…`，V3 签名、三语言标签与自适应图标核对通过 |

首次静态跑出现过 1 项 FAIL：`aapt2 dump badging` 的标签实际带单引号、
图标是 `res/mipmap-anydpi-v26/ic_launcher.xml`，门禁期望值写错；修正门禁后**从头重跑全部检查**，
没有只补跑失败项。这也是「修完必须全量重跑」这条规则第一次被实际用上。
