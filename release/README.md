# release/ · 版本发布目录

每个对外发布的版本在这里留一份**本地归档**，与 GitHub Releases 一一对应。

```
release/
├── README.md                      # 本说明
├── v0.2.5.md / v0.2.4.md / …      # 各版本 Release 说明（GitHub Release 正文直接用它）
├── VCNC-Football-v0.2.5.apk       # 已签名 APK（与 GitHub Release 资产是同一个文件）
└── SHA256SUMS.txt                 # 全部 APK 的校验和
```

## 发布清单

完整命令见 [技术文档 · 发布流程](../docs/TECHNICAL.md#发布流程)，
检查项说明见 [发布门禁](../docs/RELEASE_GATE.md)。顺序不能反：

1. `android/app/src/main/AndroidManifest.xml` 里 `versionCode` +1、`versionName` 改成目标版本；
   同步 `README.md` 的「当前版本」与 `docs/DEVELOPMENT_HISTORY.md` 的发布记录。
2. `bash android/build_apk.sh`，产物在 `android/VCNC-Football.apk`。
3. `cp android/VCNC-Football.apk release/VCNC-Football-<tag>.apk`。
4. 写 `release/<tag>.md`（Release 正文，须含 tag / versionName / versionCode），更新 `SHA256SUMS.txt`：
   ```bash
   cd release && sha256sum VCNC-Football-*.apk > SHA256SUMS.txt && cd ..
   ```
5. **【门禁，不可跳过】** 双机装包、亮屏联网、建好 CDP 转发后执行
   `python scripts/release_gate.py --tag <tag> --devices <serial:port,serial:port>`，
   必须全绿（含双机 19/19 回归与品牌专项验收）才允许继续。
6. `git add -A && git commit && git tag <tag> && git push origin main --tags`。
7. `python scripts/make_release.py --tag <tag>` 创建 / 更新 GitHub Release 并上传 APK。
8. 发布后复核：资产大小与归档一致、应用内检查更新能读到新版本、覆盖安装后品牌资源仍在。

## 注意

- **签名一致性**：`android/keystore.jks` 不入库（见 `.gitignore`）。发布机必须持有同一份私钥，
  否则用户端覆盖安装会失败，应用内更新也会装不上。
- **版本比较**：`UpdateChecker` 用 Release 的 `tag_name` 去掉 `v` 后与本机 `versionName`
  做语义版本比较，且 Release 必须带 `.apk` 资产才会提示更新。tag 必须能解析成 `x.y.z`。
- 不要在 Release 里放 debug 版本或不同签名的 APK。
- 旧版本 APK 建议保留，方便回滚；本目录只收正式发布版，实验构建留在 `android/` 下（已被忽略）。
- **`release/` 里的 APK 必须提交进仓库**：应用内更新的 jsDelivr / GitHub contents 两条回退线路
  直接读仓库文件，漏提交会让「检查到新版本但下载失败」。发布门禁会检查它没被 `.gitignore` 忽略。
