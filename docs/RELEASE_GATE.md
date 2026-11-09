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
| 源码 | `node --check static/feed.js`、7 个 Python 文件 AST 编译 | 语法错误在 WebView 里是白屏，构建脚本不会报 |
| 源码 | Chrome 74 红线（`??` `?.` `replaceAll` `:is()` flex `gap` `inset` `clamp()` `aspect-ratio`）零命中 | 目标机型 Note8 是 Chrome 74，用了就直接崩 |
| 源码 | `feed.html` 的本地图片引用都存在 | 二维码/图标缺一张会让设置页空白块 |
| 资源 | 5 档密度 × 4 张 launcher 图 + 2 个自适应图标 XML + 3 张分享图齐全 | 缺某档在对应 DPI 设备上会回退成模糊图标 |
| 资源 | `values` / `values-zh` / `values-en` 三套名称 + manifest 用 `@string/app_name` | 少 `values-zh` 会让中文系统回退到英文（真机踩过） |
| 资源 | `build_apk.sh` 与 `build_apk.bat` 都复制 3 张 PNG | 两条构建链产物必须一致 |
| APK | zip 内 `assets/www/` 7 个文件齐全 | 前端资源漏拷，装上去是空壳 |
| APK | `aapt2 dump badging`：包名 / 版本 / 中英标签 / 图标 | 名称、图标、版本号最终以 APK 为准 |
| APK | `apksigner verify` 通过 | 签名不一致用户装不上更新 |
| 文档 | 5 份文档的相对链接全部有效 | 拆文档后最容易留下死链 |
| 接口 | Android `ProxyServer` 与桌面 `server.py` 都有 `/api/net/stat`、`/api/net/reset`；前端 4 个控件 id 齐全 | 两端行为要对齐，桌面调试不能是哑实现 |
| 真机（可选） | 每台设备 `_test/regression.py` 全量 19/19 | 防回归，改功能必跑 |
| 真机（可选） | 每台设备 `_test/verify_brand_net.js` 全绿 | 品牌 / 分享区 / 流量接口专项验收 |

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
cp android/VCNC-Football.apk release/VCNC-Football-v0.2.5.apk
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
python scripts/release_gate.py --tag v0.2.5 \
  --devices R5CT90R761Y:9922,ce061716d822c005017e:9923
```

真机门禁前的两个已知坑（都会表现为回归大面积失败，不是代码问题）：

- **设备熄屏 / Doze**：WebView 视口会变成 0×0、视频暂停。先 `KEYCODE_WAKEUP` + `KEYCODE_MENU` 亮屏解锁。
- **WiFi 被关**：`fatal` 面板会顶住播放器，用例全挂。先 `svc wifi enable`，再在列表里点「重试」。

只看静态检查时省略 `--devices`：

```bash
python scripts/release_gate.py --tag v0.2.5
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
| v0.2.5 | 2026-11-10 | **20/20 PASS** | **4/4 PASS**（S22U 19/19 + Note8 19/19，两台专项验收全绿） | 总计 **24/24 PASS**。品牌化 + 分享区 + 流量计量批次；归档 APK sha256 `5943bb4704c7c0fa…`，V3 签名、三语言标签与自适应图标核对通过 |

首次静态跑出现过 1 项 FAIL：`aapt2 dump badging` 的标签实际带单引号、
图标是 `res/mipmap-anydpi-v26/ic_launcher.xml`，门禁期望值写错；修正门禁后**从头重跑全部检查**，
没有只补跑失败项。这也是「修完必须全量重跑」这条规则第一次被实际用上。
