#!/usr/bin/env python3
"""VCNC足球 发布门禁：一次跑完版本一致性、资源、语法、APK、文档与真机回归检查。

用法（在仓库根目录）：
    python scripts/release_gate.py --tag v0.2.5
    python scripts/release_gate.py --tag v0.2.5 --devices R5CT90R761Y:9922,ce061716d822c005017e:9923

前置条件（脚本会自己检查文件，但不会自己构建/归档）：
    1. AndroidManifest.xml 已升到目标版本
    2. bash android/build_apk.sh 已成功
    3. APK 已复制为 release/VCNC-Football-<tag>.apk，SHA256SUMS.txt 已更新
    4. release/<tag>.md 已写好，README 的「当前版本」已同步
    5. 若带 --devices：两台设备已装该 APK、已亮屏联网、CDP 转发已按端口建好

任一项 FAIL 即以退出码 1 结束，禁止发布。清单说明见 docs/RELEASE_GATE.md。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "android/app/src/main/AndroidManifest.xml")
APK = os.path.join(ROOT, "android/VCNC-Football.apk")
SDK = os.environ.get("ANDROID_SDK", "C:/Users/volcano/AppData/Local/Android/Sdk")
BT = os.environ.get("BT", SDK + "/build-tools/37.0.0")
AAPT2 = os.path.join(BT, "aapt2.exe")
APKSIGNER = os.path.join(BT, "lib/apksigner.jar")
JBR = os.environ.get("JBR", "C:/Program Files/Android/Android Studio/jbr")
JAVA = os.path.join(JBR, "bin/java.exe")

RESULTS = []


def rel(*parts):
    return os.path.join(ROOT, *parts)


def read(path, binary=False):
    mode = "rb" if binary else "r"
    kw = {} if binary else {"encoding": "utf-8"}
    with open(path, mode, **kw) as f:
        return f.read()


def run(cmd, env=None, timeout=180):
    e = dict(os.environ)
    if env:
        e.update(env)
    try:
        p = subprocess.run(cmd, cwd=ROOT, env=e, capture_output=True,
                           timeout=timeout, shell=isinstance(cmd, str))
        return p.returncode, (p.stdout + p.stderr).decode("utf-8", "replace")
    except Exception as ex:
        return 1, "EXCEPTION: " + str(ex)


def check(name, fn):
    try:
        ok, info = fn()
        RESULTS.append((name, bool(ok), str(info)))
        print("[%s] %-30s %s" % ("PASS" if ok else "FAIL", name, info))
    except Exception as ex:
        RESULTS.append((name, False, "EXCEPTION: " + str(ex)))
        print("[FAIL] %-30s EXCEPTION: %s" % (name, ex))


def manifest_ver():
    s = read(MANIFEST)
    n = re.search(r'android:versionName="([^"]+)"', s)
    c = re.search(r'android:versionCode="(\d+)"', s)
    if not (n and c):
        raise RuntimeError("manifest 缺 versionName / versionCode")
    return n.group(1), int(c.group(1))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", help="如 v0.2.5；缺省取 manifest 的 versionName")
    ap.add_argument("--devices", default="", help="serial:port,serial:port；带真机回归")
    args = ap.parse_args()

    ver, code = manifest_ver()
    tag = args.tag or ("v" + ver)
    apk_name = "VCNC-Football-" + tag + ".apk"
    arch = rel("release", apk_name)
    notes = rel("release", tag + ".md")
    print("========== VCNC足球 发布门禁 %s (versionCode %d) ==========" % (tag, code))

    # --- 版本一致性 ---
    def c_tag():
        if not re.match(r"^v\d+\.\d+\.\d+$", tag):
            return False, "tag 格式不对（UpdateChecker 依赖 x.y.z）：" + tag
        return ("v" + ver) == tag, "manifest versionName=%s / tag=%s" % (ver, tag)

    def c_tag_free():
        rc, out = run(["git", "tag", "-l", tag])
        if out.strip() == "":
            return True, "同名 tag 尚未被占用"
        # 发布后复核模式：tag 存在但正好指向当前 HEAD 是允许的（幂等重跑）
        _, head = run(["git", "rev-parse", "HEAD"])
        _, tagged = run(["git", "rev-list", "-n", "1", tag])
        ok = head.strip() == tagged.strip() and head.strip() != ""
        return ok, "tag 已存在且指向 HEAD（发布后复核）" if ok else "tag 已存在且不在 HEAD: " + out.strip()

    def c_code():
        rc, out = run(["git", "tag", "--sort=-version:refname"])
        prev = [t for t in out.split() if re.match(r"^v\d+\.\d+\.\d+$", t) and t != tag]
        if not prev:
            return True, "无历史 tag，跳过递增校验"
        rc2, old = run(["git", "show", prev[0] + ":android/app/src/main/AndroidManifest.xml"])
        m = re.search(r'android:versionCode="(\d+)"', old)
        if not m:
            return False, "读不到上一版 versionCode：" + prev[0]
        oldc = int(m.group(1))
        return code > oldc, "上一版 %s=%d → 本次 %d" % (prev[0], oldc, code)

    def c_readme():
        s = read(rel("README.md"))
        m = re.search(r"当前版本 \*\*(v[\d.]+)\*\*", s)
        return bool(m) and m.group(1) == tag, "README 当前版本=" + (m.group(1) if m else "缺失")

    def c_notes():
        if not os.path.isfile(notes):
            return False, "缺少 release/" + tag + ".md"
        s = read(notes)
        ok = ("versionCode %d" % code) in s and ver in s and tag in s
        return ok, "含 tag / versionName / versionCode"

    def c_archive():
        if not os.path.isfile(arch):
            return False, "缺少 " + apk_name
        a, b = sha256(APK), sha256(arch)
        return a == b, "与 android/VCNC-Football.apk 字节一致 sha256=" + a[:16] + "…"

    def c_sums():
        p = rel("release", "SHA256SUMS.txt")
        if not os.path.isfile(p):
            return False, "缺少 SHA256SUMS.txt"
        want = sha256(arch)
        for line in read(p).splitlines():
            if line.rstrip("* ").endswith(apk_name) or line.endswith(apk_name):
                got = line.split()[0].lstrip("*")
                return got.lower() == want, "校验和匹配 " + got[:16] + "…"
        return False, "SHA256SUMS.txt 里没有 " + apk_name

    def c_tracked():
        rc, out = run(["git", "check-ignore", "release/" + apk_name])
        ignored = out.strip() != ""
        rc2, out2 = run(["git", "ls-files"])
        secrets = [f for f in out2.splitlines() if f.endswith((".jks", ".keystore", ".p12"))]
        return not ignored and not secrets, "APK 未被忽略 / 私钥未被跟踪" if not (ignored or secrets) else \
            "APK 被忽略=%s 私钥=%s" % (ignored, secrets)

    check("tag / manifest 版本一致", c_tag)
    check("tag 未占用", c_tag_free)
    check("versionCode 递增", c_code)
    check("README 当前版本", c_readme)
    check("release 说明", c_notes)
    check("APK 归档一致", c_archive)
    check("SHA256SUMS", c_sums)
    check("gitignore / 私钥", c_tracked)

    # --- 源码语法与兼容红线 ---
    def c_js():
        bad = []
        for f in ("static/feed.js", "static/qr.js", "static/social.js", "static/clips.js"):
            rc, out = run(["node", "--check", f])
            if rc != 0:
                bad.append(f + ": " + out.strip()[:120])
        return not bad, "node --check 4 个 JS 文件" if not bad else "; ".join(bad)

    def c_py():
        files = ["server.py", "social.py", "scripts/make_release.py", "scripts/gen_brand_assets.py",
                 "scripts/gen_share_assets.py", "scripts/release_gate.py",
                 "_test/regression.py", "_test/cdp_eval.py",
                 "_test/verify_qr_matrix.py", "_test/verify_social_api.py",
                 "_test/verify_risk_guard.py"]
        bad = []
        for f in files:
            try:
                compile(read(rel(f)), f, "exec")
            except SyntaxError as e:
                bad.append("%s:%s" % (f, e.lineno))
        return not bad, "Python AST 编译 %d 个文件" % len(files) if not bad else "语法错误 " + ",".join(bad)

    def c_redline():
        js = "\n".join(read(rel("static", f)) for f in ("feed.js", "qr.js", "social.js", "clips.js"))
        css = "\n".join(read(rel("static", f)) for f in ("feed.css", "social.css", "clips.css"))
        # 先剥掉注释，避免文档性文字误报
        js_n = re.sub(r"/\*.*?\*/|//[^\n]*", "", js, flags=re.S)
        css_n = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        rules = [(js_n, r"\?\?", "JS ?? 空值合并"),
                 (js_n, r"\?\.", "JS ?. 可选链"),
                 (js_n, r"\.replaceAll\(", "JS replaceAll"),
                 (css_n, r":is\(", "CSS :is()"),
                 (css_n, r"(?<![-\w])gap\s*:", "CSS flex gap"),
                 (css_n, r"(?<![-\w])inset\s*:", "CSS inset"),
                 (css_n, r"(?<![-\w])clamp\(", "CSS clamp()"),
                 (css_n, r"aspect-ratio\s*:", "CSS aspect-ratio")]
        hits = ["%s×%d" % (label, len(re.findall(pat, txt))) for txt, pat, label in rules if re.search(pat, txt)]
        return not hits, "Chrome 74 兼容红线 0 命中" if not hits else "命中 " + ", ".join(hits)

    def c_html_refs():
        html = read(rel("static/feed.html"))
        # img/script/link 的本地引用都要真实存在（社交模块新增 3 个静态文件）
        refs = re.findall(r'(?:src|href)=["\']([^"\']+)["\']', html)
        miss = [s for s in refs if not s.startswith(("http", "data:"))
                and not os.path.isfile(rel("static", s))]
        return not miss, "%d 个静态引用均存在" % len(refs) if not miss else "缺 " + ",".join(miss)

    check("JS 语法", c_js)
    check("Python 语法", c_py)
    check("Chrome 74 兼容红线", c_redline)
    check("HTML 静态引用", c_html_refs)

    # --- 品牌与多语言资源 ---
    def c_icons():
        miss = []
        for d in ("mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"):
            for f in ("ic_launcher.png", "ic_launcher_round.png",
                      "ic_launcher_background.png", "ic_launcher_foreground.png"):
                if not os.path.isfile(rel("android/app/src/main/res", d, f)):
                    miss.append(d + "/" + f)
        for f in ("ic_launcher.xml", "ic_launcher_round.xml"):
            if not os.path.isfile(rel("android/app/src/main/res/mipmap-anydpi-v26", f)):
                miss.append("anydpi-v26/" + f)
        for f in ("app-icon.png", "share-qr.png", "donate-qr.png"):
            if not os.path.isfile(rel("static", f)):
                miss.append("static/" + f)
        return not miss, "5 档 × 4 图 + 自适应 XML×2 + 3 张分享图齐全" if not miss else "缺 " + ",".join(miss)

    def c_labels():
        zh = read(rel("android/app/src/main/res/values/strings.xml"))
        zhe = read(rel("android/app/src/main/res/values-en/strings.xml"))
        zhz = read(rel("android/app/src/main/res/values-zh/strings.xml"))
        ok = ("VCNC足球" in zh and "VCNC football" in zhe and "VCNC足球" in zhz
              and '@string/app_name' in read(MANIFEST))
        return ok, "values / values-zh / values-en 三套名称 + manifest 引用"

    def c_build_copy():
        sh = read(rel("android/build_apk.sh"))
        bat = read(rel("android/build_apk.bat"))
        ok = all(("static/" + f in sh or f in sh) and f in bat
                 for f in ("app-icon.png", "share-qr.png", "donate-qr.png",
                           "qr.js", "social.js", "social.css", "clips.js", "clips.css"))
        return ok, "两个构建脚本都复制 3 张 PNG + 社交 3 个 + 集锦 2 个文件"

    check("图标 / 二维码资源", c_icons)
    check("中英文名称资源", c_labels)
    check("构建脚本资源复制", c_build_copy)

    # --- APK 内容与签名 ---
    def c_apk_assets():
        want = ["assets/www/" + f for f in ("index.html", "feed.html", "feed.js", "feed.css",
                                            "qr.js", "social.js", "social.css", "clips.js", "clips.css",
                                            "app-icon.png", "share-qr.png", "donate-qr.png")]
        with zipfile.ZipFile(APK) as z:
            names = set(z.namelist())
        miss = [w for w in want if w not in names]
        return not miss, "assets/www %d 个文件齐全" % len(want) if not miss else "缺 " + ",".join(miss)

    def c_badging():
        if not os.path.isfile(AAPT2):
            return False, "找不到 aapt2：" + AAPT2
        rc, out = run([AAPT2, "dump", "badging", APK])
        need = {"包名": "package: name='com.vcncfootball'",
                "版本": "versionName='%s'" % ver,
                "版本码": "versionCode='%d'" % code,
                "中文名(默认)": "application-label:'VCNC足球'",
                "中文名(zh)": "application-label-zh:'VCNC足球'",
                "英文名(en)": "application-label-en:'VCNC football'",
                "图标": "res/mipmap-anydpi-v26/ic_launcher.xml"}
        bad = [k for k, v in need.items() if v not in out]
        return not bad, "包名/版本/三语言标签/自适应图标齐全" if not bad else "缺 " + ",".join(bad)

    def c_sign():
        if not (os.path.isfile(APKSIGNER) and os.path.isfile(JAVA)):
            return False, "找不到 apksigner 或 java"
        rc, out = run([JAVA, "-jar", APKSIGNER, "verify", "--verbose", APK])
        ok = rc == 0 and "Verifies" in out
        v3 = "v3 scheme (APK Signature Scheme v3): true" in out
        return ok, "签名校验通过（v3=%s）" % v3

    check("APK assets", c_apk_assets)
    check("APK badging", c_badging)
    check("APK 签名", c_sign)

    # --- 文档与接口对齐 ---
    def c_links():
        docs = ["README.md", "docs/TECHNICAL.md", "docs/DEVELOPMENT_HISTORY.md",
                "docs/RELEASE_GATE.md", "docs/CUSTOM_CLIPS.md", "release/README.md"]
        miss = []
        for d in docs:
            p = rel(d)
            if not os.path.isfile(p):
                miss.append(d + "(缺文件)")
                continue
            for link in re.findall(r"\]\(([^)]+)\)", read(p)):
                if link.startswith(("http", "#", "mailto:")):
                    continue
                target = link.split("#")[0]
                if target and not os.path.isfile(os.path.normpath(os.path.join(os.path.dirname(p), target))):
                    miss.append(d + "→" + link)
        return not miss, "6 份文档相对链接全部有效" if not miss else "失效 " + ",".join(miss[:5])

    def c_api_parity():
        java = read(rel("android/app/src/main/java/com/hplayer/ProxyServer.java"))
        py = read(rel("server.py"))
        html = read(rel("static/feed.html"))
        routes = ("/api/net/stat", "/api/net/reset",
                  "/api/social/auth", "/api/social/qrcode", "/api/social/poll",
                  "/api/social/me", "/api/social/triple", "/api/social/logout",
                  "/api/social/manual",
                  "/api/replies", "/api/clips/publish", "/api/clips/delete")
        pairs = [(r, java, py) for r in routes]
        bad = [r for r, a, b in pairs if r not in a or r not in b]
        extra = [x for x in ("netHud", "netStat", "netReset", "setBackTop")
                 if x not in html]
        return not bad and not extra, "两端流量+社交+集锦接口对齐 + 前端 4 个控件齐全" if not (bad or extra) else \
            "缺 " + ",".join(bad + extra)

    def c_social_files():
        want = ("social.py", "static/qr.js", "static/social.js", "static/social.css",
                "android/app/src/main/java/com/hplayer/BiliSocial.java")
        miss = [f for f in want if not os.path.isfile(rel(f))]
        return not miss, "社交模块 5 个文件齐全" if not miss else "缺 " + ",".join(miss)

    def c_app_auth():
        """App 授权主路径：桥接、包可见性、深链、默认不显示二维码。"""
        java = read(rel("android/app/src/main/java/com/hplayer/MainActivity.java"))
        manifest = read(rel("android/app/src/main/AndroidManifest.xml"))
        js = read(rel("static/social.js"))
        css = read(rel("static/feed.css"))
        feedjs = read(rel("static/feed.js"))
        want = {
            "JS 桥检测客户端": "biliAppInstalled" in java,
            "JS 桥唤起授权": "bilibili://browser?url=" in java and "setPackage(pkg)" in java,
            "包可见性 queries": "<queries>" in manifest and "tv.danmaku.bili" in manifest,
            "默认 App 授权端点": "'/api/social/auth'" in js,
            "二维码折叠兜底": "id=\"socAlt\" hidden" in js or "'socAlt' hidden" in js,
            "浮窗随 chrome 隐藏": "body.chrome-off .soc-modal" in read(rel("static/social.css")),
            "HUD 与标题同一行靠右": bool(re.search(r"\.net-hud\s*\{[^}]*top:\s*10px[^}]*right:", css))
                                     and "layoutTopRow" in feedjs,
            "HUD 三项横排一行": ".hud-l3" in css and "累计" in feedjs
                               and re.search(r"\.net-hud \.hud-l2\s*::before", css),
            "三连按钮在标题行": ".ci-triple" in read(rel("static/social.css"))
                                and "renderTripleTop" in js,
            # 单击即可即时收起后，自动隐藏放宽到 4500ms（原 1800ms），下限挡住误删
            "隐藏等待时长合理": bool(re.search(r"CHROME_IDLE_MS\s*=\s*(\d+)", feedjs))
                              and 2000 <= int(re.search(r"CHROME_IDLE_MS\s*=\s*(\d+)", feedjs).group(1)) <= 8000,
            "单击显隐/双击播停": "DBL_MS" in feedjs and "toggleChrome" in feedjs
                               and "togglePlay(true)" in feedjs,
        }
        bad = [k for k, v in want.items() if not v]
        return not bad, "App 授权主路径 %d 项齐全" % len(want) if not bad else "缺 " + ",".join(bad)

    def c_clips_codec():
        """分享码 / 评论文本 / 微信 H5 中转页三处编解码，纯 Node 免真机。"""
        rc, out = run(["node", "_test/verify_clips_codec.js"], timeout=120)
        m = re.search(r"(\d+) PASS / (\d+) FAIL", out)
        ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) >= 25
        if not ok:
            return False, "编解码回归失败：" + out.strip()[-160:]
        # 中转页独立实现了一份 crc8/base64url，漂移会让微信里点开变成「链接损坏」
        rc2, out2 = run(["node", "_test/verify_share_page.js"], timeout=120)
        m2 = re.search(r"(\d+) PASS / (\d+) FAIL", out2)
        ok2 = rc2 == 0 and m2 and int(m2.group(2)) == 0 and int(m2.group(1)) >= 10
        if not ok2:
            return False, "H5 中转页回归失败：" + out2.strip()[-160:]
        return True, "%s 项编解码 + %s 项 H5 页回归全绿" % (m.group(1), m2.group(1))

    def c_clips_files():
        want = ("static/clips.js", "static/clips.css", "docs/CUSTOM_CLIPS.md",
                "share/index.html", "_test/verify_clips.js", "_test/verify_clips_codec.js",
                "_test/verify_share_page.js")
        miss = [f for f in want if not os.path.isfile(rel(f))]
        java = read(rel("android/app/src/main/java/com/hplayer/MainActivity.java"))
        manifest = read(rel("android/app/src/main/AndroidManifest.xml"))
        bad = [] if not miss else miss[:]
        if "getClipboardText" not in java: bad.append("剪贴板桥")
        if 'android:scheme="vcncfootball"' not in manifest: bad.append("导入深链")
        if "CLIP_CODE" not in java: bad.append("导入码解析")
        return not bad, "自定义集锦 7 个文件 + 深链/剪贴板齐全" if not bad else "缺 " + ",".join(bad)

    def c_risk_guard():
        """风控断路器 + 解析快照降级：桌面端行为模拟 + 三端静态契约，免真机。"""
        rc, out = run([sys.executable, "_test/verify_risk_guard.py"], timeout=120)
        m = re.search(r"(\d+) PASS / (\d+) FAIL", out)
        ok = rc == 0 and m and int(m.group(2)) == 0 and int(m.group(1)) >= 40
        return (bool(ok), "风控韧性回归 %s 项全绿" % (m.group(1) if m else "?")
                if ok else "风控韧性回归失败：" + out.strip()[-200:])

    check("集锦编解码回归", c_clips_codec)
    check("集锦模块文件", c_clips_files)
    check("风控韧性回归", c_risk_guard)
    check("文档相对链接", c_links)
    check("流量 / 社交接口两端对齐", c_api_parity)
    check("社交模块文件", c_social_files)
    check("App 授权主路径", c_app_auth)

    # --- 真机回归（可选） ---
    if args.devices:
        for pair in args.devices.split(","):
            pair = pair.strip()
            if not pair:
                continue
            serial, port = pair.split(":", 1)
            env = {"CDP_PORT": port}

            def c_reg(s=serial, p=port, e=env):
                rc, out = run([sys.executable, "_test/regression.py"], env=e, timeout=600)
                m = re.search(r"总计 (\d+)，通过 (\d+)，失败 (\d+)", out)
                ok = rc == 0 and m and int(m.group(1)) == int(m.group(2)) and int(m.group(3)) == 0
                detail = m.group(0) if m else out.strip()[-200:]
                return ok, "%s %s" % (s, detail)

            def c_probe(s=serial, p=port, e=env):
                rc, out = run([sys.executable, "_test/cdp_eval.py", "_test/verify_brand_net.js"],
                              env=e, timeout=180)
                try:
                    j = json.loads(out[out.index("{"):])
                except Exception:
                    return False, "%s 返回不是 JSON: %s" % (s, out.strip()[-160:])
                bad = []
                if "VCNC足球" not in (j.get("title") or ""):
                    bad.append("title")
                if not j.get("netHudText") or j.get("netHudVisible") == "none":
                    bad.append("netHud")
                if not j.get("netStatText") or not j.get("netReset"):
                    bad.append("netStat/reset")
                if j.get("shareLinks", 0) < 5 or not j.get("shareButtons"):
                    bad.append("shareLinks/buttons")
                if not j.get("setBackTop") or j.get("oldSetBack") or j.get("oldSheetFoot"):
                    bad.append("返回入口/旧底部残留")
                if not all(i.get("loaded") for i in j.get("imgs", [])):
                    bad.append("3 张图片加载")
                if not (j.get("netApi") or {}).get("ok"):
                    bad.append("/api/net/stat")
                if not all((j.get("bridge") or {}).get(k) for k in ("openUrl", "shareText", "copyText")):
                    bad.append("JS 桥")
                return not bad, "%s 品牌/分享/流量全绿" % s if not bad else "%s 缺 " % s + ",".join(bad)

            def c_social(s=serial, p=port, e=env):
                rc, out = run([sys.executable, "_test/cdp_eval.py", "_test/verify_social.js"],
                              env=e, timeout=180)
                try:
                    j = json.loads(out[out.index("{"):])
                except Exception:
                    return False, "%s 返回不是 JSON: %s" % (s, out.strip()[-160:])
                bad = []
                for k in ("qrgen", "vcnc", "socialModule", "modalPresent"):
                    if not j.get(k):
                        bad.append(k)
                fl = j.get("float") or {}
                if not fl.get("present") or fl.get("display") != "flex" or fl.get("left") != 0:
                    bad.append("左侧浮窗")
                if not (j.get("qrcode") or {}).get("ok") or not (j.get("canvas") or {}).get("rendered"):
                    bad.append("二维码兜底渲染")
                au = j.get("auth") or {}
                if not au.get("ok") or au.get("mode") != "app":
                    bad.append("App 授权端点")
                brd = j.get("bridge") or {}
                if not brd.get("present") or not brd.get("hasAuth"):
                    bad.append("客户端唤起桥")
                lu = j.get("loginUI") or {}
                if not lu.get("launch") or not lu.get("altHidden") or lu.get("defaultQrDrawn"):
                    bad.append("默认 App 授权 UI")
                co = j.get("chromeOff") or {}
                if co.get("floatOpacity") != "0" or co.get("modalOpacity") != "0":
                    bad.append("登录界面同进退隐藏")
                nh = j.get("netHud") or {}
                # 顶行排布：HUD 贴「列表/设置」左侧（间隙 0~20px），三项信息横排一行
                if not (nh.get("gapToNav") is not None and 0 <= nh.get("gapToNav") <= 20):
                    bad.append("流量 HUD 贴页签")
                if nh.get("lines") != 3 or nh.get("textRows") != 1:
                    bad.append("流量信息不在同一行")
                if "本次" not in (j.get("netHudText") or "") or "累计" not in (j.get("netHudText") or ""):
                    bad.append("流量信息被精简")
                # 三连按钮在标题行，且处于三态之一：dim 未登录 / on 可点 / done 已三连
                # （旧断言只接受 dim，已登录且该视频点过的设备会误报）
                if not (j.get("tripleButton") and
                        any(k in (j.get("tripleCls") or "") for k in ("dim", "on", "done"))):
                    bad.append("三连按钮不在标题行/状态异常")
                if not (2000 <= (j.get("chromeIdleMs") or 0) <= 8000):
                    bad.append("隐藏等待时长")
                if not (150 <= (j.get("dblMs") or 0) <= 400):
                    bad.append("双击判定窗口")
                if not (j.get("state") or {}).get("bvid") or (j.get("qualityButtons") or 0) < 1:
                    bad.append("画质契约")
                # 画质档位人人可点：基础档 360P~1080P 不需要大会员，
                # 列表 = accept_quality ∪ 基础四档，按钮一律不禁用
                if not ((j.get("qualityButtons") or 0) >= 4):
                    bad.append("画质基础档缺失")
                if j.get("qualityDisabled") != 0:
                    bad.append("画质按钮被禁用（应为人人可点）")
                ta = j.get("tripleApi") or {}
                if "ok" not in ta:
                    bad.append("三连接口无响应")
                elif not ta.get("ok") and not ta.get("needLogin"):
                    bad.append("三连接口异常:" + str(ta.get("error", ""))[:40])
                return not bad, "%s 社交模块全绿" % s if not bad else "%s 缺 " % s + ",".join(bad)

            def c_tap(s=serial, p=port, e=env):
                rc, out = run([sys.executable, "_test/cdp_eval.py", "_test/verify_tap.js"],
                              env=e, timeout=240)
                try:
                    j = json.loads(out[out.index("{"):])
                except Exception:
                    return False, "%s 返回不是 JSON: %s" % (s, out.strip()[-160:])
                if j.get("pass") is True:
                    return True, "%s 单击显隐/双击播停全绿" % s
                v = j.get("verdict") or {}
                bad = [k for k in v if not v[k]]
                return False, "%s 手势未过: %s" % (s, ",".join(bad) or "无 verdict")

            check("回归 %s" % serial, c_reg)
            check("专项验收 %s" % serial, c_probe)
            check("社交验收 %s" % serial, c_social)
            def c_clips(s=serial, p=port, e=env):
                rc, out = run([sys.executable, "_test/cdp_eval.py", "_test/verify_clips.js"],
                              env=e, timeout=240)
                try:
                    j = json.loads(out[out.index("{"):])
                except Exception:
                    return False, "%s 返回不是 JSON: %s" % (s, out.strip()[-160:])
                if j.get("pass") is True:
                    return True, "%s 自定义集锦全绿" % s
                v = j.get("verdict") or {}
                bad = [k for k in v if not v[k]]
                return False, "%s 集锦未过: %s" % (s, ",".join(bad) or str(j.get("error", "无 verdict")))

            check("手势验收 %s" % serial, c_tap)
            check("集锦验收 %s" % serial, c_clips)

    n_fail = sum(1 for _, ok, _ in RESULTS if not ok)
    print("=" * 62)
    print("门禁结果：%d 项检查，通过 %d，失败 %d" % (len(RESULTS), len(RESULTS) - n_fail, n_fail))
    if n_fail:
        for name, ok, info in RESULTS:
            if not ok:
                print("  FAIL %s：%s" % (name, info))
        print("禁止发布。")
        return 1
    print("门禁通过，可以发布 %s。" % tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
