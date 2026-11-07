# release/ · 版本发布目录

每个对外发布的版本在这里留一份**本地归档**，与 GitHub Releases 一一对应。

```
release/
├── README.md                      # 本说明
├── v0.2.0.md                      # 该版本的 Release 说明（GitHub Release 正文直接用它）
├── VCNC-Football-v0.2.0.apk       # 已签名 APK（与 GitHub Release 资产是同一个文件）
└── SHA256SUMS.txt                 # APK 校验和
```

## 发布清单

1. `android/app/src/main/AndroidManifest.xml` 里 `versionCode` +1、`versionName` 改成目标版本。
2. `bash android/build_apk.sh`，产物在 `android/VCNC-Football.apk`。
3. `cp android/VCNC-Football.apk release/VCNC-Football-<tag>.apk`。
4. 写 `release/<tag>.md`（Release 正文），更新 `SHA256SUMS.txt`：
   ```bash
   cd release && sha256sum VCNC-Football-*.apk > SHA256SUMS.txt
   ```
5. `git add -A && git commit && git tag <tag> && git push origin main --tags`。
6. `python scripts/make_release.py --tag <tag>` 创建 / 更新 GitHub Release 并上传 APK。

## 注意

- **签名一致性**：`android/keystore.jks` 不入库（见 `.gitignore`）。发布机必须持有同一份私钥，
  否则用户端覆盖安装会失败，应用内更新也会装不上。
- **版本比较**：`UpdateChecker` 用 Release 的 `tag_name` 去掉 `v` 后与本机 `versionName`
  做语义版本比较，且 Release 必须带 `.apk` 资产才会提示更新。tag 必须能解析成 `x.y.z`。
- 不要在 Release 里放 debug 版本或不同签名的 APK。
- 旧版本 APK 建议保留，方便回滚；本目录只收正式发布版，实验构建留在 `android/` 下（已被忽略）。
