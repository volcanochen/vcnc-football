#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社交模块本机端点冒烟（桌面 server.py 通道）。

用法（仓库根目录）：python _test/verify_social_api.py

覆盖：登录态 / 客户端授权申请 / 扫码兜底申请 / 轮询 / 三连 / 跨站拦截 /
手填 Cookie / 登出。
凭证文件被重定向到 _test/out/，不触碰真实用户目录；结束自动清理。
真实扫码与大会员态需要用户本人操作，本脚本不做。
"""
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server
import social

OUT = os.path.join(ROOT, "_test", "out")
os.makedirs(OUT, exist_ok=True)
TEST_STORE = os.path.join(OUT, "social_test.json")

social._store_path = lambda: TEST_STORE
social._loaded = False
social._state.update({"cookie": "", "refresh_token": "", "login_at": 0, "mid": 0})
social._me_cache.update({"ts": 0.0, "data": None})

PORT = 8877
FAILS = []


def req(path, data=None, headers=None):
    url = "http://127.0.0.1:%d%s" % (PORT, path)
    body = urllib.parse.urlencode(data).encode() if data else None
    r = urllib.request.Request(url, data=body, headers=headers or {})
    if body and "Content-Type" not in (headers or {}):
        r.add_header("Content-Type", "application/x-www-form-urlencoded")
    with opener.open(r, timeout=25) as resp:
        return resp.status, json.loads(resp.read().decode())


def expect(label, cond, detail):
    print("[%s] %-30s %s" % ("PASS" if cond else "FAIL", label, detail))
    if not cond:
        FAILS.append(label)


def main():
    global opener
    httpd = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        expect("ping", req("/api/ping")[1].get("ok") is True, "本地服务可用")
        me = req("/api/social/me")[1]
        expect("me（未登录）", me.get("loggedIn") is False and me.get("vip") is False,
               "loggedIn=%s vip=%s" % (me.get("loggedIn"), me.get("vip")))

        au = req("/api/social/auth")[1]
        expect("auth（App 授权）", au.get("ok") is True and au.get("mode") == "app"
               and len(au.get("url", "")) > 80 and len(au.get("key", "")) == 32,
               "mode=%s url=%d 字符 key=%d 位" %
               (au.get("mode"), len(au.get("url", "")), len(au.get("key", ""))))

        qr = req("/api/social/qrcode")[1]
        expect("qrcode", qr.get("ok") is True and len(qr.get("url", "")) > 80
               and len(qr.get("key", "")) == 32,
               "url=%d 字符 key=%d 位" % (len(qr.get("url", "")), len(qr.get("key", ""))))
        if qr.get("ok"):
            poll = req("/api/social/poll?key=" + qr["key"])[1]
            expect("poll", poll.get("ok") is True and poll.get("status") in
                   ("wait", "scanned", "expired", "done", "unknown"),
                   "status=%s" % poll.get("status"))

        t = req("/api/social/triple", {"bvid": "BV1p5xd6hEK2"})[1]
        expect("triple（未登录）", t.get("needLogin") is True, t.get("error", ""))

        try:
            req("/api/social/triple", {"bvid": "BV1p5xd6hEK2"},
                {"Origin": "https://evil.example"})
            expect("跨站 POST 拦截", False, "恶意 Origin 未被拒绝")
        except urllib.error.HTTPError as e:
            expect("跨站 POST 拦截", e.code == 403, "HTTP %d" % e.code)

        m = req("/api/social/manual", {"cookie": "SESSDATA=fake; bili_jct=fake"})[1]
        expect("手填 Cookie", m.get("ok") is True, "已接受并交给 nav 校验")
        me2 = req("/api/social/me?force=1")[1]
        expect("无效凭证识别", me2.get("expired") is True, me2.get("text", ""))

        lo = req("/api/social/logout", {"t": 1})[1]
        expect("logout", lo.get("loggedIn") is False, "仅清本机凭证")
        expect("me（登出后）", req("/api/social/me")[1].get("loggedIn") is False, "恢复匿名")
    finally:
        httpd.shutdown()
        if os.path.isfile(TEST_STORE):
            os.remove(TEST_STORE)
        print("临时凭证已清理：%s" % (not os.path.isfile(TEST_STORE)))
    print("失败 %d 项" % len(FAILS))
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
