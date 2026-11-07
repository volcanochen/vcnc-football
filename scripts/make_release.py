#!/usr/bin/env python3
"""把 release/ 里的版本发布到 GitHub Releases。

- Release 正文取自 release/<tag>.md
- 上传 release/VCNC-Football-<tag>.apk 作为资产
- GitHub token 从 git credential 动态读取（脚本与命令行里都不出现明文）
- 同名 tag 的 Release 已存在时复用并覆盖同名资产，可重复运行

用法：
    python scripts/make_release.py                 # 版本从 AndroidManifest.xml 读
    python scripts/make_release.py --tag v0.2.0
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "volcanochen/vcnc-football"
API = "https://api.github.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_token():
    """复用 git 凭据助手拿 GitHub PAT，避免明文落盘。"""
    try:
        p = subprocess.run(
            ["git", "credential", "fill"],
            input=b"protocol=https\nhost=github.com\n",
            capture_output=True, timeout=30,
        )
        for line in p.stdout.decode("utf-8", "ignore").splitlines():
            if line.startswith("password="):
                return line[len("password="):].strip()
    except Exception as e:
        print("get_token failed:", e, file=sys.stderr)
    return os.environ.get("GH_TOKEN", "") or os.environ.get("GITHUB_TOKEN", "")


def call(method, url, data=None, binary=False, allow=None):
    token = get_token()
    if not token:
        sys.exit("ERROR: 拿不到 GitHub token（请配置 git credential / GH_TOKEN）")
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "VCNC-Football-Release",
    }
    body = None
    if data is not None:
        if binary:
            body = data
            headers["Content-Type"] = "application/vnd.android.package-archive"
        else:
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read().decode("utf-8", "ignore")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if allow and e.code in allow:
            return {"__status__": e.code}
        print("HTTP", e.code, e.reason, url, file=sys.stderr)
        print(e.read().decode("utf-8", "ignore")[:800], file=sys.stderr)
        sys.exit(1)


def manifest_version():
    path = os.path.join(ROOT, "android/app/src/main/AndroidManifest.xml")
    m = re.search(r'android:versionName="([^"]+)"', open(path, encoding="utf-8").read())
    if not m:
        sys.exit("ERROR: 读不到 versionName：" + path)
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", help="版本 tag，如 v0.2.0；缺省从 AndroidManifest.xml 推导")
    args = ap.parse_args()
    tag = args.tag or ("v" + manifest_version())
    if not re.match(r"^v\d+\.\d+\.\d+", tag):
        sys.exit("ERROR: tag 必须是 v数字.数字.数字 形式，UpdateChecker 依赖它比较版本：" + tag)

    notes_path = os.path.join(ROOT, "release", tag + ".md")
    apk_name = "VCNC-Football-" + tag + ".apk"
    apk_path = os.path.join(ROOT, "release", apk_name)
    for p in (notes_path, apk_path):
        if not os.path.isfile(p):
            sys.exit("ERROR: 缺少文件：" + p)
    notes = open(notes_path, encoding="utf-8").read()

    # 复用已有 Release，避免重复运行报 422
    rel = call("GET", f"{API}/repos/{REPO}/releases/tags/{tag}", allow=(404,))
    if rel.get("__status__") == 404:
        print("创建 Release", tag, "...")
        rel = call("POST", f"{API}/repos/{REPO}/releases", {
            "tag_name": tag,
            "name": "VCNC 足球沉浸场 " + tag,
            "body": notes,
            "draft": False,
            "prerelease": False,
        })
    else:
        print("复用已有 Release", tag, "，更新正文 ...")
        call("PATCH", f"{API}/repos/{REPO}/releases/{rel['id']}", {"body": notes})

    # 同名资产先删，覆盖上传
    for a in rel.get("assets", []) or []:
        if a.get("name") == apk_name:
            print("删除同名旧资产", apk_name)
            call("DELETE", f"{API}/repos/{REPO}/releases/assets/{a['id']}")
            break

    blob = open(apk_path, "rb").read()
    upload_url = rel.get("upload_url", f"{API}/repos/{REPO}/releases/{rel['id']}/assets").split("{")[0]
    print("上传资产", apk_name, f"({len(blob)} bytes) ...")
    asset = call("POST", upload_url + "?name=" + apk_name, data=blob, binary=True)
    print("  资产:", asset.get("name"), asset.get("size"), "bytes")
    print("  下载:", asset.get("browser_download_url"))
    print("DONE:", rel.get("html_url"))


if __name__ == "__main__":
    main()
