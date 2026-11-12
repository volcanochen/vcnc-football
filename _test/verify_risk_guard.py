#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B 站风控韧性回归（纯本地，免真机 / 免网络）。

行为用例：模拟 -352 打在 playurl 上，验证
  1) 成功解析会留下快照，且 view 请求带上了登录 Cookie；
  2) 风控命中后返回「降级回放」结果（新 token 重新登记 MEDIA，地址沿用快照）；
  3) 冷却期内一个上游请求都不发（不会再加热 IP 窗口）；
  4) 没有快照时给出带等待秒数的明确提示，而不是含糊的「解析失败」。
静态用例：Android / 桌面 / 前端三端的契约字符串都在位，防止只改了一端。

用法：python _test/verify_risk_guard.py
输出：`<n> PASS / <m> FAIL`，FAIL>0 时退出码 1。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PASS = 0
FAIL = 0


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] " + name)
    else:
        FAIL += 1
        print("  [FAIL] " + name + (" -> " + str(extra) if extra else ""))


def read(*parts):
    with open(os.path.join(ROOT, *parts), "r", encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- 行为用例
import server  # noqa: E402  （必须先加 sys.path）

TMP = tempfile.mkdtemp(prefix="vcnc_risk_")
server.SNAPSHOT_PATH = os.path.join(TMP, "resolve_snapshot.json")
server._SNAP.clear()
server.MEDIA.clear()
server.PLAYURL_RETRY_DELAY = 0          # 测试里不真的等 2 秒
server._RISK.update({"until": 0.0, "streak": 0})

IK, SK = "i" * 32, "s" * 32             # wbi mixinKey 需要 ik+sk >= 64 字符
BV = "BV1aa411c7mD"
calls = []
play_state = {"code": 0}


class FakeResp:
    """替身 response：只实现 http_json 用到的 read + 上下文管理。"""

    def __init__(self, payload):
        self._body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def fake_urlopen(req, timeout=20):
    """只替掉最底层的 urlopen，让真实的 http_json / note_response 完整跑一遍。"""
    url = req.full_url
    cookie = ""
    for k, v in req.header_items():
        if k.lower() == "cookie":
            cookie = v
    calls.append((url, cookie))
    if "finger/spi" in url:
        return FakeResp({"code": 0, "data": {"b_3": "B3TEST", "b_4": "B4TEST"}})
    if "/x/web-interface/nav" in url:
        return FakeResp({"code": 0, "data": {"wbi_img": {
            "img_url": f"https://i0.hdslb.com/{IK}.png",
            "sub_url": f"https://i0.hdslb.com/{SK}.png"}}})
    if "/x/web-interface/view" in url:
        return FakeResp({"code": 0, "data": {
            "bvid": BV, "aid": 123456, "cid": 789, "title": "测试比赛",
            "owner": {"name": "VCNC"}, "pic": "", "duration": 100,
            "pages": [{"page": 1, "cid": 789, "part": "全场"}]}})
    if "playurl" in url:
        return FakeResp(play_state)
    return FakeResp({"code": 0, "data": {}})


server.urllib.request.urlopen = fake_urlopen

GOOD_PU = {"code": 0, "data": {
    "dash": {"duration": 100,
             "video": [{"id": 32, "codecs": "avc1.64001f", "bandwidth": 1000,
                        "baseUrl": "https://cdn.test/v.m4s",
                        "backupUrl": ["https://cdn2.test/v.m4s"]}],
             "audio": [{"id": 30216, "bandwidth": 100,
                        "baseUrl": "https://cdn.test/a.m4s"}]},
    "accept_quality": [32, 16]}}

print("[1] 正常解析")
play_state = GOOD_PU
r1 = server.resolve(BV, 1, 32, "SESSDATA=abc")
ck("成功返回 ok + token", bool(r1.get("ok")) and bool(r1.get("token")), r1)
ck("view 请求携带登录 Cookie",
   any("/x/web-interface/view" in u and "SESSDATA=abc" in c for u, c in calls))
ck("快照已落盘", os.path.isfile(server.SNAPSHOT_PATH) and len(server._SNAP) == 1)
with open(server.SNAPSHOT_PATH, "r", encoding="utf-8") as sf:
    snap_text = sf.read()
ck("快照只存流地址不含凭证", "SESSDATA" not in snap_text)

print("[2] playurl 命中 -352")
server._RISK.update({"until": 0.0, "streak": 0})
play_state = {"code": -352, "message": "风控校验失败"}
calls.clear()
r2 = server.resolve(BV, 1, 32, "SESSDATA=abc")
ck("返回降级结果而非抛错", bool(r2.get("ok")) and r2.get("degraded") is True, r2)
ck("降级 token 已重新登记 MEDIA", r2.get("token") in server.MEDIA)
ck("沿用快照里的流地址",
   server.MEDIA.get(r2.get("token"), {}).get("v", [])[:1] == ["https://cdn.test/v.m4s"])
ck("降级结果标明等待秒数", r2.get("retryAfter", 0) > 0)
ck("最多只重打一次 playurl",
   len([1 for u, _ in calls if "playurl" in u]) <= 2,
   [u for u, _ in calls])
ck("拉起全局冷却", server.risk_seconds() > 0)

print("[3] 冷却期内再点一次")
calls.clear()
r3 = server.resolve(BV, 1, 32, "SESSDATA=abc")
ck("0 个上游请求", len(calls) == 0, calls)
ck("仍返回可播结果", bool(r3.get("ok")) and r3.get("degraded") is True)
ck("token 重新生成", r3.get("token") != r2.get("token"))

print("[4] 无快照时给明确提示")
server._SNAP.clear()
server._RISK.update({"until": time.time() + 30, "streak": 1})
try:
    server.resolve("BV1bb411c7mD", 1, 32, "")
    ck("无快照应抛错", False)
except RuntimeError as exc:
    ck("错误含风控与等待秒数", "风控" in str(exc) and "秒" in str(exc), exc)

print("[5] 风控响应识别")
server._RISK.update({"until": 0.0, "streak": 0})
server.note_response('{"code":-352,"message":"risk"}')
ck("JSON -352 触发冷却", server.risk_blocked())
server._RISK.update({"until": 0.0, "streak": 0})
server.note_response('{"code":-412,"message":"request was banned"}')
ck("JSON -412 触发冷却", server.risk_blocked())
server._RISK.update({"until": 0.0, "streak": 0})
server.note_response('{"code":0,"data":{}}')
ck("code=0 不误判", not server.risk_blocked())
server._RISK.update({"until": 0.0, "streak": 0})
server.note_response("request was banned")
ck("banned 文案触发冷却", server.risk_blocked())


def raise_412(req, timeout=20):
    raise urllib.error.HTTPError(req.full_url, 412, "Precondition Failed", {}, None)


server.urllib.request.urlopen = raise_412
server._RISK.update({"until": 0.0, "streak": 0})
try:
    server.http_json("https://api.bilibili.com/x/web-interface/nav")
except RuntimeError:
    pass
ck("HTTP 412 触发冷却", server.risk_blocked())
server.urllib.request.urlopen = fake_urlopen
server._RISK.update({"until": 0.0, "streak": 0})

print("[5b] 风控打在 view 阶段（HTTP 412，body 不是 JSON）")
server._SNAP.clear()
server._RISK.update({"until": 0.0, "streak": 0})
play_state = GOOD_PU
server.resolve(BV, 1, 32, "")                    # 先留一份快照


def view_412(req, timeout=20):
    if "/x/web-interface/view" in req.full_url:
        raise urllib.error.HTTPError(req.full_url, 412, "Precondition Failed", {}, None)
    return fake_urlopen(req, timeout=timeout)


server.urllib.request.urlopen = view_412
server._RISK.update({"until": 0.0, "streak": 0})
calls.clear()
try:
    r4 = server.resolve(BV, 1, 32, "")
except Exception as exc:                         # noqa: BLE001
    r4 = {"error": str(exc)}
ck("view 412 也能回放快照", r4.get("ok") is True and r4.get("degraded") is True, r4)
ck("view 412 后不再重打 playurl", not any("playurl" in u for u, _ in calls), calls)
server.urllib.request.urlopen = fake_urlopen

print("[5c] feed 冷却期沿用过期缓存且 0 请求")
server._RISK.update({"until": time.time() + 30, "streak": 1})
server._FEED_CACHE.clear()
stale = {"ok": True, "videos": [{"bvid": BV}], "offset": "", "hasMore": False}
server._FEED_CACHE["first"] = (time.time() - 600, stale)
calls.clear()
r5 = server.space_feed("", "")
ck("沿用超过 5 分钟的旧列表", r5 is stale)
ck("feed 冷却期 0 个上游请求", len(calls) == 0, calls)
server._FEED_CACHE.clear()
server._RISK.update({"until": 0.0, "streak": 0})

# ---------------------------------------------------------------- 静态契约
print("[6] 三端契约")
java = read("android/app/src/main/java/com/hplayer/BiliApi.java")
proxy = read("android/app/src/main/java/com/hplayer/ProxyServer.java")
js = read("static/feed.js")
py = read("server.py")

want_java = {
    "风险码集合": "-412" in java and "RISK_CODES" in java,
    "HTTP 412 拦截": "code == 412" in java,
    "统一响应识别": "noteResponse(body)" in java,
    "解析链路带登录态": "authCookie" in java,
    "playurl 重签": "wbiSign(q)" in java,
    "快照存/取": "saveSnapshot" in java and "restoreResolve" in java,
    "降级统一出口": "static JSONObject degrade(" in java,
    "feed 冷却短路": java.count("riskBlocked()") >= 3,
    "评论延后到 playurl 成功": "if (!riskBlocked()) {" in java,
    "view 重试遇风控即收手": "if (riskBlocked()) throw last;" in java,
    "playurl 冷却期不重打": "if (pa > 0 && riskBlocked()) break;" in java,
    "spi/nav 冷却期不补发": java.count("if (riskBlocked()) throw e1;") == 2,
}
want_rest = {
    "ProxyServer 初始化快照目录": "BiliApi.init(" in proxy,
    "ProxyServer 不重试风控错误": 'msg.contains("风控")' in proxy,
    "前端识别 degraded": "j.degraded" in js and "this.degraded" in js,
    "降级时跳过预取": "if (!this.degraded) prefetchSegBytes(this);" in js,
    "重试按钮冷却": "riskUntil" in js,
    "桌面端同语义": "def degrade(" in py and "def note_response(" in py
                    and "save_snapshot(" in py and "risk_blocked()" in py,
    "桌面 view 阶段也降级": "取视频信息遇到风控" in py,
    "桌面 playurl 冷却期不重打": "if attempt and risk_blocked():" in py,
    "桌面 feed 异常也收手": "别再退避重试加热窗口" in py,
}
for name, ok in list(want_java.items()) + list(want_rest.items()):
    ck(name, ok)

print()
print(f"{PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
