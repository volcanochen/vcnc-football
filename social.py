#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VCNC足球 · B 站账号社交模块（独立模块，纯标准库，与 Android 端 BiliSocial.java 同语义）

职责：
  扫码登录（qrcode/generate + qrcode/poll）→ 本地持久化凭证 → 账号信息 / 大会员判定
  → 当前视频一键三连。

安全边界：
  * 凭证只落本机文件 ~/.vcnc-football/social.json，不下发给前端、不写日志、不入库；
  * 三连 / 登出是写操作，路由层用 POST + 同源校验；
  * 登出只清本地凭证，不调 B 站 logout（避免踢掉用户其它设备的登录态）；
  * 所有打印都经过脱敏，绝不打印 SESSDATA / bili_jct 原文。

B 站 2026-08 起 Web 扫码登录改版：登录成功不再把 SESSDATA 拼在返回 URL 上，
而是通过 poll 响应的 Set-Cookie 下发。这里两条路径都兼容（Set-Cookie 优先，
旧版 crossDomain URL 参数兜底，必要时再 GET 一次 SSO URL 取 cookie）。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PASSPORT = "https://passport.bilibili.com"
API = "https://api.bilibili.com"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

# 只用精简头：实测 passport 的登录接口与 feed 一样，带 Origin 会触发风控。
BASE_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.bilibili.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 凭证里需要保留的键（其余如 Expires、Path 等 HTTP 属性一律丢弃）
COOKIE_KEYS = (
    "SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid",
    "bili_ticket", "bili_ticket_expires", "buvid3", "buvid4",
)

METER = None          # server.py 注入 NET_METER，用于把接口字节计入流量统计
_lock = threading.Lock()
_state = {"cookie": "", "refresh_token": "", "login_at": 0, "mid": 0}
_me_cache = {"ts": 0.0, "data": None}
_BUVID = {"value": "", "ts": 0.0}
_loaded = False


# --------------------------------------------------------------------------
# 持久化
# --------------------------------------------------------------------------
def _store_path() -> str:
    d = os.path.join(os.path.expanduser("~"), ".vcnc-football")
    return os.path.join(d, "social.json")


def _load():
    global _loaded
    if _loaded:
        return
    _loaded = True
    p = _store_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            for k in _state:
                if k in d:
                    _state[k] = d[k]
    except Exception:
        pass


def _save():
    p = _store_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
        try:
            os.chmod(p, 0o600)
        except Exception:
            pass
    except Exception as e:
        # 存不下不影响本次会话（内存态仍可用），但不能伪装成成功
        print("[social] 凭证落盘失败: %s" % type(e).__name__)


def _net(n: int):
    if METER is not None:
        try:
            METER.add_network(int(n))
        except Exception:
            pass


# --------------------------------------------------------------------------
# HTTP 基础
# --------------------------------------------------------------------------
def _request(url: str, data=None, headers=None, timeout: int = 20):
    """返回 (body:str, set_cookie:list[str], status:int)。不抛 HTTPError，统一成状态码。"""
    h = dict(BASE_HEADERS)
    if headers:
        h.update(headers)
    body = b""
    cookies = []
    status = 0
    try:
        req = urllib.request.Request(url, data=data, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            body = resp.read()
            try:
                cookies = resp.headers.get_all("Set-Cookie") or []
            except AttributeError:
                cookies = []
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body = e.read()
            cookies = e.headers.get_all("Set-Cookie") or []
        except Exception:
            body = b""
    _net(len(body))
    return body.decode("utf-8", "replace"), cookies, status


def _json_or_empty(s: str) -> dict:
    try:
        o = json.loads(s)
        return o if isinstance(o, dict) else {}
    except Exception:
        return {}


def _parse_set_cookie(lines) -> dict:
    out = {}
    for line in lines or []:
        first = str(line).split(";", 1)[0].strip()
        if "=" not in first:
            continue
        k, v = first.split("=", 1)
        k = k.strip()
        if k in COOKIE_KEYS and v.strip():
            out[k] = v.strip()
    return out


def buvid_cookie() -> str:
    """游客指纹 cookie；三连接口要求 buvid3 存在且正常，否则触发风控。"""
    with _lock:
        if _BUVID["value"] and time.time() - _BUVID["ts"] < 3600:
            return _BUVID["value"]
    try:
        body, _, _ = _request(API + "/x/frontend/finger/spi", timeout=12)
        d = _json_or_empty(body).get("data") or {}
        v = "buvid3=%s; buvid4=%s" % (d.get("b_3", ""), d.get("b_4", ""))
    except Exception:
        v = ""
    with _lock:
        _BUVID["value"] = v
        _BUVID["ts"] = time.time()
    return v


def user_cookie() -> str:
    """登录凭证字符串。供 /api/resolve、/api/feed 在未显式传 cookie 时兜底使用。"""
    _load()
    with _lock:
        return _state.get("cookie") or ""


def _full_cookie() -> str:
    """API 请求用的完整 Cookie = 游客指纹 + 登录凭证。"""
    parts = [buvid_cookie(), user_cookie()]
    return "; ".join(x for x in parts if x).replace("; ;", ";").strip()


def _cookie_from_dict(d: dict) -> str:
    return "; ".join("%s=%s" % (k, v) for k, v in d.items() if k in COOKIE_KEYS and v)


# --------------------------------------------------------------------------
# 扫码登录
# --------------------------------------------------------------------------
def auth() -> dict:
    """申请「B 站客户端 App 授权登录」会话。

    与扫码登录共用同一套 passport 会话（generate + poll，成功后照样下发
    SESSDATA），区别只在前端怎么把 url 交给用户：App 授权模式不渲染二维码，
    而是经 JS 桥用 ``bilibili://browser?url=...`` 把授权页交给本机 B 站客户端
    内打开，用户在 App 里点「确认」即完成授权。qrcode() 保留作桌面端兜底。
    """
    r = qrcode()
    if r.get("ok"):
        r["mode"] = "app"
    return r


def qrcode() -> dict:
    """申请登录会话。返回 {ok, url, key}；桌面端可把 url 渲染成二维码。"""
    u = (PASSPORT + "/x/passport-login/web/qrcode/generate"
         "?source=main-fe-header&go_url=" + urllib.parse.quote("https://www.bilibili.com/", safe=""))
    body, _, st = _request(u, headers={"Cookie": buvid_cookie()}, timeout=15)
    j = _json_or_empty(body)
    data = j.get("data") or {}
    url, key = data.get("url", ""), data.get("qrcode_key", "")
    if st != 200 or j.get("code") != 0 or not url or not key:
        return {"ok": False, "error": "申请授权失败：%s" % (j.get("message") or "HTTP %s" % st)}
    return {"ok": True, "url": url, "key": key, "ttl": 180}


def poll(key: str) -> dict:
    """轮询一次扫码状态。成功时保存凭证并返回账号信息。"""
    key = (key or "").strip()
    if not key or not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", key):
        return {"ok": False, "error": "授权 key 无效，请重新获取"}
    u = (PASSPORT + "/x/passport-login/web/qrcode/poll?qrcode_key="
         + urllib.parse.quote(key, safe="") + "&source=main-fe-header")
    body, set_cookies, st = _request(u, headers={"Cookie": buvid_cookie()}, timeout=15)
    j = _json_or_empty(body)
    d = j.get("data") or {}
    code = int(d.get("code", j.get("code", -1)) or -1)

    if code == 86101:
        return {"ok": True, "status": "wait", "text": "等待在 B 站 App 中确认"}
    if code == 86090:
        return {"ok": True, "status": "scanned", "text": "已在 App 中打开，请点确认"}
    if code == 86038:
        return {"ok": True, "status": "expired", "text": "授权已失效，请重新获取"}
    if code != 0:
        return {"ok": True, "status": "unknown", "text": d.get("message") or "等待在 B 站 App 中确认"}

    # --- 登录成功：收集凭证 ---
    ck = _parse_set_cookie(set_cookies)
    # 旧版兼容：crossDomain URL 的查询参数里直接带 cookie 键
    sso = d.get("url") or ""
    if sso:
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(sso).query)
            for k in COOKIE_KEYS:
                if k in q and k not in ck:
                    ck[k] = q[k][0]
        except Exception:
            pass
    # 新版（2026-08 起）若只下发 refresh_token 而不给 SESSDATA，访问一次 SSO 地址取 cookie
    if "SESSDATA" not in ck and sso.startswith("https://"):
        try:
            _, more, _ = _request(sso, headers={"Cookie": _full_cookie()}, timeout=15)
            ck.update(_parse_set_cookie(more))
        except Exception:
            pass

    cookie_str = _cookie_from_dict(ck)
    if "SESSDATA=" not in cookie_str:
        return {"ok": False, "error": "登录已确认，但没拿到 SESSDATA，请重新授权登录或在设置里手动填写 Cookie"}

    with _lock:
        _state["cookie"] = cookie_str
        _state["refresh_token"] = d.get("refresh_token") or ""
        _state["login_at"] = int(d.get("timestamp") or time.time() * 1000)
        _state["mid"] = 0
        _me_cache["ts"] = 0.0
    _save()
    invalidate_resolve_cache()
    # 绝不把 cookie 原文写进日志
    print("[social] App 授权登录成功（凭证已存本机）")
    return {"ok": True, "status": "done", "text": "登录成功", "me": me(force=True)}


def invalidate_resolve_cache():
    """登录态变化后，旧的匿名 playurl 解析结果不能再用（否则拿不到大会员画质）。

    桌面版每次 /api/resolve 都实时请求 B 站，没有内存解析缓存，这里无需处理；
    Android 端 BiliSocial 会清 BiliApi.RESOLVE_CACHE / FEED_CACHE（见同名方法）。
    保留此钩子是为了两端语义一致。
    """
    return None


# --------------------------------------------------------------------------
# 账号信息
# --------------------------------------------------------------------------
def me(force: bool = False) -> dict:
    """GET x/web-interface/nav：账号信息 + 大会员判定。缓存 30s。"""
    _load()
    cookie = user_cookie()
    if not cookie:
        return {"ok": True, "loggedIn": False, "vip": False,
                "mid": 0, "name": "", "face": "", "level": 0, "coins": 0}
    if not force and _me_cache["data"] and time.time() - _me_cache["ts"] < 30:
        return dict(_me_cache["data"])
    body, _, st = _request(API + "/x/web-interface/nav",
                           headers={"Cookie": _full_cookie()}, timeout=15)
    j = _json_or_empty(body)
    d = j.get("data") or {}
    logged = bool(d.get("isLogin")) and st == 200 and j.get("code") == 0
    if not logged:
        out = {"ok": True, "loggedIn": False, "vip": False, "mid": 0,
               "name": "", "face": "", "level": 0, "coins": 0,
               "expired": True, "text": "登录已过期，请重新授权登录"}
    else:
        vip_status = int(d.get("vipStatus") or (d.get("vip") or {}).get("status") or 0)
        vip_type = int(d.get("vipType") or (d.get("vip") or {}).get("type") or 0)
        face = d.get("face") or ""
        if face.startswith("//"):
            face = "https:" + face
        elif face.startswith("http://"):
            face = "https://" + face[7:]
        level = 0
        try:
            level = int((d.get("level_info") or {}).get("current_level") or 0)
        except Exception:
            pass
        try:
            coins = float(d.get("money") or 0)
        except Exception:
            coins = 0
        out = {
            "ok": True, "loggedIn": True,
            "vip": vip_status == 1 and vip_type > 0,
            "vipType": vip_type,
            "vipDue": int(d.get("vipDueDate") or 0),
            "mid": int(d.get("mid") or 0),
            "name": d.get("uname") or "",
            "face": face,
            "level": level,
            "coins": coins,
            "text": "",
        }
        with _lock:
            _state["mid"] = out["mid"]
    with _lock:
        _me_cache["data"] = dict(out)
        _me_cache["ts"] = time.time()
    return out


def set_manual_cookie(raw: str) -> dict:
    """手填 Cookie 兜底：只有一台手机、不方便扫码时用。

    与扫码登录共用同一份凭证存储，所以手填后三连 / 大会员画质一样可用。
    """
    ck = {}
    for part in (raw or "").split(";"):
        p = part.strip()
        if "=" not in p:
            continue
        k, v = p.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in COOKIE_KEYS and v:
            ck[k] = v
    cookie_str = _cookie_from_dict(ck)
    if "SESSDATA=" not in cookie_str:
        return {"ok": False, "error": "Cookie 里至少要包含 SESSDATA=…"}
    if "bili_jct=" not in cookie_str:
        return {"ok": False, "error": "三连还需要 bili_jct=…，请一并粘贴"}
    with _lock:
        _state["cookie"] = cookie_str
        _state["refresh_token"] = ""
        _state["login_at"] = int(time.time() * 1000)
        _state["mid"] = 0
        _me_cache["data"] = None
        _me_cache["ts"] = 0.0
    _save()
    invalidate_resolve_cache()
    print("[social] 已保存手填 Cookie（凭证只存本机）")
    return {"ok": True, "me": me(force=True)}


def logout() -> dict:
    """只清本地凭证，不调用 B 站 logout。"""
    with _lock:
        _state["cookie"] = ""
        _state["refresh_token"] = ""
        _state["login_at"] = 0
        _state["mid"] = 0
        _me_cache["data"] = None
        _me_cache["ts"] = 0.0
    try:
        p = _store_path()
        if os.path.isfile(p):
            os.remove(p)
    except Exception:
        pass
    invalidate_resolve_cache()
    print("[social] 已退出登录（仅清本机凭证）")
    return {"ok": True, "loggedIn": False, "vip": False}


# --------------------------------------------------------------------------
# 三连
# --------------------------------------------------------------------------
def triple(bvid: str) -> dict:
    """一键三连（点赞 + 投币 + 收藏到默认收藏夹）。"""
    bvid = (bvid or "").strip()
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
        return {"ok": False, "error": "视频号无效"}
    cookie = user_cookie()
    if not cookie:
        return {"ok": False, "error": "请先登录 B 站账号", "needLogin": True}
    csrf = ""
    for part in cookie.split(";"):
        p = part.strip()
        if p.startswith("bili_jct="):
            csrf = p.split("=", 1)[1]
            break
    if not csrf:
        return {"ok": False, "error": "登录凭证缺少 bili_jct，请重新授权登录", "needLogin": True}

    post = urllib.parse.urlencode({"bvid": bvid, "csrf": csrf}).encode()
    headers = {
        "Cookie": _full_cookie(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://www.bilibili.com/video/" + bvid,
        "Origin": "https://www.bilibili.com",
    }
    body, _, st = _request(API + "/x/web-interface/archive/like/triple",
                           data=post, headers=headers, timeout=15)
    j = _json_or_empty(body)
    code = int(j.get("code", -1) or -1)
    if code != 0:
        msg = j.get("message") or "HTTP %s" % st
        if code == -101:
            msg = "登录已过期，请重新授权登录"
        elif code == -111:
            msg = "CSRF 校验失败，请重新授权登录"
        elif code == 65006 or code == 65005:
            msg = "已经三连过啦"
        return {"ok": False, "error": msg, "code": code,
                "needLogin": code in (-101, -111)}
    data = j.get("data") or {}
    return {
        "ok": True,
        "like": bool(data.get("like")),
        "coin": bool(data.get("coin")),
        "fav": bool(data.get("fav")),
        "multiply": int(data.get("multiply") or 0),
        "text": "已三连：点赞 + 投币 + 收藏",
    }
