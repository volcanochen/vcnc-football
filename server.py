#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B 站集锦自动合成播放器 —— 本地服务（纯标准库，无第三方依赖）

职责：
  /api/resolve?url=<BV或链接>&p=<分P>&qn=<画质>&cookie=<SESSDATA>   解析视频 + 取 DASH 流地址
  /api/media/<token>/<v|a>                                          反向代理 upos 流（补 Referer/UA，透传 Range + 磁盘缓存）
  /api/cache/config?mb=<N>                                          设置缓存上限（默认 200MB）
  /api/cache/stat                                                   缓存占用 / 命中统计
  /api/cache/clear                                                  清空缓存
  /api/social/auth | /qrcode | /poll | /me                           客户端授权 / 扫码兜底 / 账号信息（含大会员）
  /api/social/triple (POST) | /logout (POST)                         一键三连 / 退出登录
  /                                                                 托管 static/ 前端

磁盘缓存在 _cache/media/（已 gitignore）：key 用 bvid|page|qn|v|a，与随机的 token 解耦，
因此关掉进程再打开同一场比赛仍能命中；视频本身不会更新，缓存只需按上限做 LRU 淘汰。

启动：python server.py [--no-open] [--port 8777]
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import social  # B 站账号社交模块（独立模块，纯标准库）

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
PORT = 8777
VERBOSE = os.environ.get("BH_VERBOSE") == "1"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
API_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

QUALITY_NAME = {
    120: "4K 超清", 116: "1080P60", 112: "1080P 高码率", 80: "1080P 高清",
    74: "720P60", 64: "720P 高清", 32: "480P 清晰", 16: "360P 流畅",
    6: "240P 极速", 125: "HDR 真彩", 126: "杜比视界", 127: "8K 超高清",
}

MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]

_lock = threading.Lock()
MEDIA: dict[str, dict] = {}          # token -> {"v": [url...], "a": [url...], "ts": float}
_WBI = {"key": None, "ts": 0.0}
_BUVID = {"cookie": None, "ts": 0.0}
_LAST_COOKIE = {"value": ""}


# --------------------------------------------------------------------------
# B 站风控断路器（与 Android BiliApi 同语义）
#   -352 / -412 / -403 / -509 与 HTTP 412/429 是出口 IP 的滑动窗口限流，
#   不是网络故障。瞬时重试只会把窗口继续加热，所以命中即拉起全局冷却，
#   冷却期内一个包都不发，优先回放「上次成功解析」让本地缓存字节照常可播。
# --------------------------------------------------------------------------
RISK_CODES = (-352, -412, -403, -509)
RISK_COOLDOWN = (0, 30, 60, 120, 300)          # 秒，按连续命中次数阶梯拉长
PLAYURL_RETRY_DELAY = 2.0                       # 风控后唯一的退避重试间隔（测试可置 0）
_RISK = {"until": 0.0, "streak": 0}
_RISK_LOCK = threading.Lock()
_CODE_RE = re.compile(r'"code"\s*:\s*(-?\d+)')


def is_risk_code(code) -> bool:
    return code in RISK_CODES


def mark_risk(why: str = "") -> None:
    with _RISK_LOCK:
        now = time.time()
        if now >= _RISK["until"]:
            _RISK["streak"] = 0
        _RISK["streak"] = min(_RISK["streak"] + 1, len(RISK_COOLDOWN) - 1)
        sec = RISK_COOLDOWN[_RISK["streak"]]
        _RISK["until"] = max(_RISK["until"], now + sec)
    if VERBOSE:
        print(f"[risk] 冷却 +{sec}s ({why})")


def risk_seconds() -> int:
    return max(0, int(_RISK["until"] - time.time() + 0.999))


def risk_blocked() -> bool:
    return risk_seconds() > 0


def note_response(body: str) -> None:
    """在唯一的 HTTP 出口统一识别风控响应。"""
    head = body[:256]
    m = _CODE_RE.search(head)
    if m:
        if int(m.group(1)) in RISK_CODES:
            mark_risk("code=" + m.group(1))
    elif "request was banned" in head:
        mark_risk("banned")


# --------------------------------------------------------------------------
# 解析快照（风控期仍能播）：只存公开流地址，不存任何账号凭证
# --------------------------------------------------------------------------
SNAPSHOT_PATH = os.path.join(ROOT, "_cache", "resolve_snapshot.json")
_SNAP_LOCK = threading.Lock()
_SNAP: dict[str, dict] = {}


def _load_snapshots() -> None:
    global _SNAP
    try:
        with open(SNAPSHOT_PATH, "r", encoding="utf-8") as f:
            _SNAP = json.load(f)
    except Exception:
        _SNAP = {}


_load_snapshots()


def save_snapshot(key: str, out: dict, media: dict) -> None:
    with _SNAP_LOCK:
        s = dict(out)
        s["v"] = list(media["v"])
        s["a"] = list(media["a"])
        s["snapTs"] = time.time()
        _SNAP[key] = s
        if len(_SNAP) > 24:
            _SNAP.pop(min(_SNAP, key=lambda k: _SNAP[k].get("snapTs", 0)), None)
        try:
            os.makedirs(os.path.dirname(SNAPSHOT_PATH), exist_ok=True)
            tmp = SNAPSHOT_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(_SNAP, f, ensure_ascii=False)
            os.replace(tmp, SNAPSHOT_PATH)
        except Exception:
            pass


def restore_resolve(key: str, reason: str):
    s = _SNAP.get(key)
    if not s or not s.get("bvid") or not s.get("v"):
        return None
    token = uuid.uuid4().hex
    with _lock:
        MEDIA[token] = {"v": list(s["v"]), "a": list(s.get("a") or []), "ts": time.time(),
                        "bvid": s["bvid"], "page": s.get("page", 1), "qn": s.get("qn", 80)}
    out = {k: v for k, v in s.items() if k not in ("v", "a", "snapTs")}
    out.update({"token": token, "degraded": True,
                "degradedReason": reason, "retryAfter": risk_seconds()})
    return out


def degrade(key: str, message: str) -> dict:
    snap = restore_resolve(key, message)
    if snap is not None:
        return snap
    sec = risk_seconds()
    if sec > 0:
        raise RuntimeError(f"B 站接口风控中，请 {sec} 秒后再试"
                           "（可切换 WiFi/蜂窝换出口 IP，或填写 SESSDATA 提高配额）")
    raise RuntimeError(message)


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def http_json(url: str, cookie: str = "", timeout: int = 20) -> dict:
    headers = dict(API_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (412, 429):
            mark_risk(f"HTTP {exc.code}")
            raise RuntimeError(f"B 站风控 HTTP {exc.code}") from exc
        raise
    NET_METER.add_network(len(body))
    text = body.decode("utf-8", "replace")
    note_response(text)
    return json.loads(text)


def http_json_no_origin(url: str, cookie: str = "", timeout: int = 20) -> dict:
    """feed 专用：实测动态接口带 Origin 头会触发风控（-352 或空数据），去掉后正常。"""
    headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (412, 429):
            mark_risk(f"HTTP {exc.code}")
            raise RuntimeError(f"B 站风控 HTTP {exc.code}") from exc
        raise
    NET_METER.add_network(len(body))
    text = body.decode("utf-8", "replace")
    note_response(text)
    return json.loads(text)


def mixin_key(orig: str) -> str:
    return "".join(orig[i] for i in MIXIN_TAB)[:32]


def wbi_keys() -> tuple[str, str]:
    with _lock:
        if _WBI["key"] and time.time() - _WBI["ts"] < 3600:
            return _WBI["key"]
    nav = http_json("https://api.bilibili.com/x/web-interface/nav")
    img = nav.get("data", {}).get("wbi_img", {})
    ik = img.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
    sk = img.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
    if not ik or not sk:
        raise RuntimeError("获取 wbi 密钥失败")
    with _lock:
        _WBI["key"] = (ik, sk)
        _WBI["ts"] = time.time()
    return ik, sk


def wbi_sign(params: dict) -> str:
    ik, sk = wbi_keys()
    mk = mixin_key(ik + sk)
    params = dict(params, wts=int(time.time()))
    pairs = sorted(params.items())
    clean = [(k, "".join(c for c in str(v) if c not in "!'()*")) for k, v in pairs]
    query = urllib.parse.urlencode(clean)
    params["w_rid"] = hashlib.md5((query + mk).encode()).hexdigest()
    return urllib.parse.urlencode(params)


def buvid_cookie() -> str:
    """拿一份游客指纹 cookie，降低风控概率。"""
    with _lock:
        if _BUVID["cookie"] and time.time() - _BUVID["ts"] < 3600:
            return _BUVID["cookie"]
    try:
        d = http_json("https://api.bilibili.com/x/frontend/finger/spi").get("data", {})
        ck = f"buvid3={d.get('b_3','')}; buvid4={d.get('b_4','')}"
    except Exception:
        ck = ""
    with _lock:
        _BUVID["cookie"] = ck
        _BUVID["ts"] = time.time()
    return ck


def parse_target(raw: str) -> tuple[str, int]:
    """从链接或裸 ID 中解析出 BV 号与分P。"""
    raw = (raw or "").strip()
    page = 1
    m = re.search(r"[?&]p=(\d+)", raw)
    if m:
        page = max(1, int(m.group(1)))
    m = re.search(r"(BV[0-9A-Za-z]{10})", raw)
    if m:
        return m.group(1), page
    m = re.search(r"av(\d+)", raw, re.I)
    if m:
        return "av" + m.group(1), page
    raise ValueError("没识别出 BV 号，请粘贴完整视频链接或 BV 号")


def pick_stream(streams: list, want_qn: int, prefer_avc: bool = True):
    if not streams:
        return None
    cands = [s for s in streams if s.get("id", 0) <= want_qn] or streams
    if prefer_avc:
        avc = [s for s in cands if str(s.get("codecs", "")).startswith("avc1")]
        if avc:
            cands = avc
    best = max(s.get("id", 0) for s in cands)
    same = [s for s in cands if s.get("id", 0) == best]
    if prefer_avc:
        for s in same:
            if str(s.get("codecs", "")).startswith("avc1"):
                return s
    return max(same, key=lambda s: s.get("bandwidth", 0))


def pick_audio(audios: list):
    if not audios:
        return None
    # 排除杜比 / FLAC：浏览器解码支持不稳定
    ok = [a for a in audios if a.get("id") not in (30250, 30251)] or audios
    return max(ok, key=lambda a: a.get("bandwidth", 0))


def urls_of(stream: dict) -> list:
    out = []
    if not stream:
        return out
    for key in ("baseUrl", "base_url"):
        if stream.get(key):
            out.append(stream[key])
    for key in ("backupUrl", "backup_url"):
        for u in stream.get(key) or []:
            if u not in out:
                out.append(u)
    return out


RANGE_CAP = 3 * 1024 * 1024          # 单次回传上限：避免为一个 seek 拖下整个文件


def bounded_range(rng: str | None) -> str:
    """把浏览器的 Range 收敛成 <= RANGE_CAP 的有界区间。"""
    m = re.match(r"bytes=(\d+)-(\d*)", (rng or "").strip())
    if not m:
        return f"bytes=0-{RANGE_CAP - 1}"
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else start + RANGE_CAP - 1
    return f"bytes={start}-{min(end, start + RANGE_CAP - 1)}"


# --------------------------------------------------------------------------
# 本地媒体磁盘缓存（与 Android MediaCache 同语义，桌面调试时行为一致）
#   key = bvid|page|qn|kind，与每次 resolve 都会变的 token 解耦；
#   一条缓存 = 一个 [start,end] 字节区间，命中只要求覆盖请求起点（206 回实际有的那段）；
#   被 seek 打断时把已下载的连续前缀也落盘；未命中仍只发一次上游请求，不增加 CDN 请求数。
# --------------------------------------------------------------------------
CACHE_DIR = os.path.join(ROOT, "_cache", "media")
CACHE_CONFIG = os.path.join(ROOT, "_cache", "config.json")
CACHE_DEFAULT_MB, CACHE_MIN_MB, CACHE_MAX_MB = 600, 50, 2048
CACHE_STATS = {"hits": 0, "misses": 0}


class NetMeter:
    """桌面调试版流量计量：与 Android NetMeter 同语义，只记真实上游字节。

    区别：桌面版不跨进程持久化（重启 server.py 归零），网络类型恒为 desktop。
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.session = 0
        self.total = 0
        self.session_saved = 0
        self.saved = 0
        self.last_bytes = 0
        self.last_t = time.time()
        self.speed = 0.0

    def add_network(self, n):
        with self.lock:
            self.session += n
            self.total += n

    def add_saved(self, n):
        with self.lock:
            self.session_saved += n
            self.saved += n

    def stat(self):
        with self.lock:
            now = time.time()
            dt = now - self.last_t
            inst = max(0.0, (self.session - self.last_bytes) / dt) if dt > 0.05 else 0.0
            a = 0.65 if inst > self.speed else 0.35
            self.speed = self.speed * (1 - a) + inst * a
            if self.speed < 1024:
                self.speed = 0.0
            self.last_bytes = self.session
            self.last_t = now
            return {"ok": True, "speed": int(self.speed), "session": self.session,
                    "total": self.total, "sessionSaved": self.session_saved,
                    "saved": self.saved, "network": "desktop", "ts": int(now * 1000)}

    def reset(self):
        with self.lock:
            self.session = self.total = 0
            self.session_saved = self.saved = 0
            self.last_bytes = 0
            self.speed = 0.0
            self.last_t = time.time()


NET_METER = NetMeter()
# 账号接口的上游字节也计入「真实流量」，两端语义一致
social.METER = NET_METER


def cache_limit_mb() -> int:
    try:
        with open(CACHE_CONFIG, "r", encoding="utf-8") as f:
            v = int(json.load(f).get("limit_mb", CACHE_DEFAULT_MB))
        if CACHE_MIN_MB <= v <= CACHE_MAX_MB:
            return v
    except Exception:
        pass
    return CACHE_DEFAULT_MB


def cache_set_limit(mb) -> int:
    v = max(CACHE_MIN_MB, min(CACHE_MAX_MB, int(mb)))
    os.makedirs(os.path.dirname(CACHE_CONFIG), exist_ok=True)
    with open(CACHE_CONFIG, "w", encoding="utf-8") as f:
        json.dump({"limit_mb": v}, f)
    cache_trim()
    return v


def cache_key_dir(key: str, create: bool = False) -> str:
    d = os.path.join(CACHE_DIR, hashlib.md5(key.encode("utf-8")).hexdigest()[:20])
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def media_cache_key(entry: dict, kind: str):
    bv = entry.get("bvid")
    if not bv:
        return None
    return "%s|%s|%s|%s" % (bv, entry.get("page", 1), entry.get("qn", 80), kind)


def cache_bounded(rng):
    """与 bounded_range 同源，返回 (start, end) 闭区间供缓存条目标识使用。"""
    m = re.match(r"bytes=(\d+)-(\d+)", bounded_range(rng))
    return int(m.group(1)), int(m.group(2))


def cache_find(key: str, s: int, e: int):
    """找一条覆盖起点 s 的条目，返回 (文件, 条目起点, 实际可提供的末端)。

    播放器常请求 3MB 却读一小段就断开，所以不要求完整覆盖请求；206 响应只回
    Content-Range 里真实可用的那一段，播放器会自己接着请求后续字节。
    """
    d = cache_key_dir(key)
    if not os.path.isdir(d):
        return None
    best = None
    for n in os.listdir(d):
        m = re.fullmatch(r"(\d+)_(\d+)\.bin", n)
        if not m:
            continue
        s0, e0 = int(m.group(1)), int(m.group(2))
        p = os.path.join(d, n)
        if s0 > s or e0 < s:
            continue
        try:
            if os.path.getsize(p) != e0 - s0 + 1:
                continue
        except OSError:
            continue
        avail_end = min(e0, e)
        if avail_end < s:
            continue
        if best is None or avail_end > best[2]:
            best = (p, s0, avail_end)
    return best


def cache_meta(key: str, name: str, default=""):
    try:
        with open(os.path.join(cache_key_dir(key), name), "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return default


def cache_set_meta(key: str, name: str, val, only_once=False):
    d = cache_key_dir(key, create=True)
    p = os.path.join(d, name)
    if only_once and os.path.isfile(p) and os.path.getsize(p) > 0:
        return
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(str(val))
    except OSError:
        pass


def cache_commit(key: str, s: int, e: int, total: int, tmp: str, written: int):
    if written != e - s + 1:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return
    d = cache_key_dir(key, create=True)
    dst = os.path.join(d, "%d_%d.bin" % (s, e))
    names = os.listdir(d)
    for n in names:
        m = re.fullmatch(r"(\d+)_(\d+)\.bin", n)
        if m and int(m.group(1)) <= s and int(m.group(2)) >= e:
            try:
                if os.path.getsize(os.path.join(d, n)) == int(m.group(2)) - int(m.group(1)) + 1:
                    os.remove(tmp)
                    return
            except OSError:
                pass
    for n in names:
        m = re.fullmatch(r"(\d+)_(\d+)\.bin", n)
        if m and n != os.path.basename(dst) and int(m.group(1)) >= s and int(m.group(2)) <= e:
            try:
                os.remove(os.path.join(d, n))
            except OSError:
                pass
    try:
        os.replace(tmp, dst)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return
    if total:
        cache_set_meta(key, "total", total)
    cache_trim()


def cache_files():
    out = []
    for root, _dirs, names in os.walk(CACHE_DIR):
        for n in names:
            if n.endswith(".bin"):
                p = os.path.join(root, n)
                try:
                    out.append((os.path.getmtime(p), os.path.getsize(p), p))
                except OSError:
                    pass
    return out


# ---- 集锦片段预取（与 APK 端 /api/cache/prefetch 同语义） ----
PREFETCH_CHUNK = 4 * 1024 * 1024      # 一块 = 一条缓存条目
PREFETCH_MAX_CHUNKS = 400             # 单次请求块数上限，防止把整个视频拖下来
_prefetch_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="prefetch")


def cache_prefetch_range(key: str, s: int, e: int, urls: list[str]) -> int:
    """主动预取一个字节区间：已有条目覆盖就跳过(0)，否则拉上游完整落盘；失败 -1。"""
    if not key or e < s:
        return 0
    if cache_find(key, s, e):
        return 0
    headers = {
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Range": "bytes=%d-%d" % (s, e),
    }
    if _LAST_COOKIE["value"]:
        headers["Cookie"] = _LAST_COOKIE["value"]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers=headers)
            upstream = urllib.request.urlopen(req, timeout=30)
        except Exception:  # noqa: BLE001
            continue
        with upstream:
            cr = upstream.headers.get("Content-Range") or ""
            cm = re.search(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", cr)
            if upstream.status != 206 or not cm or int(cm.group(1)) != s:
                return -1
            actual_end, total = int(cm.group(2)), 0 if cm.group(3) == "*" else int(cm.group(3))
            ctype = upstream.headers.get("Content-Type") or ""
            if ctype.startswith("video/") or ctype.startswith("audio/"):
                cache_set_meta(key, "ctype", ctype, only_once=True)
            d = cache_key_dir(key, create=True)
            tmp = os.path.join(d, "%d.tmp" % time.time_ns())
            written = 0
            try:
                with open(tmp, "wb") as f:
                    while written < actual_end - s + 1:
                        b = upstream.read(min(65536, actual_end - s + 1 - written))
                        if not b:
                            break
                        f.write(b)
                        NET_METER.add_network(len(b))
                        written += len(b)
            except OSError:
                pass
            if written <= 0:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                return -1
            cache_commit(key, s, s + written - 1, total, tmp, written)
            return written
    return -1


def cache_trim():
    files = cache_files()
    used = sum(x[1] for x in files)
    limit = cache_limit_mb() * 1024 * 1024
    if used <= limit:
        return
    for _mt, sz, p in sorted(files):
        if used <= limit * 0.9:
            break
        try:
            os.remove(p)
            used -= sz
        except OSError:
            pass


def cache_clear():
    for root, dirs, names in os.walk(CACHE_DIR, topdown=False):
        for n in names:
            try:
                os.remove(os.path.join(root, n))
            except OSError:
                pass
        for n in dirs:
            try:
                os.rmdir(os.path.join(root, n))
            except OSError:
                pass
    CACHE_STATS["hits"] = 0
    CACHE_STATS["misses"] = 0


def cache_stat() -> dict:
    files = cache_files()
    used = sum(x[1] for x in files)
    limit = cache_limit_mb() * 1024 * 1024
    videos = 0
    if os.path.isdir(CACHE_DIR):
        videos = sum(1 for n in os.listdir(CACHE_DIR)
                     if os.path.isdir(os.path.join(CACHE_DIR, n)))
    h, m = CACHE_STATS["hits"], CACHE_STATS["misses"]
    return {
        "ok": True,
        "limitMb": cache_limit_mb(),
        "limitBytes": limit,
        "usedBytes": used,
        "usedMb": round(used / 1048576, 1),
        "entries": len(files),
        "videos": videos,
        "hits": h,
        "misses": m,
        "hitRate": round(h * 100 / (h + m), 1) if (h + m) else 0,
    }


# --------------------------------------------------------------------------
# 解析视频
# --------------------------------------------------------------------------
def resolve(raw_target: str, page: int, qn: int, cookie_user: str) -> dict:
    bvid, bvid_page = parse_target(raw_target)
    if page <= 1:
        page = bvid_page
    key = f"{bvid.lower()}|{qn}|{page}"

    # 冷却期内一个包都不发：有快照就降级回放，没有就给明确等待时间
    if risk_blocked():
        return degrade(key, "风控冷却中")

    # 旧版只有 playurl 带登录 Cookie，view 是纯游客请求；整条链路共用一份凭证
    auth_cookie = " ".join(x for x in [(_BUVID.get("cookie") or ""), (cookie_user or "").strip()] if x)
    try:
        if bvid.lower().startswith("av"):
            view = http_json(f"https://api.bilibili.com/x/web-interface/view?aid={bvid[2:]}",
                             cookie=auth_cookie)
        else:
            view = http_json(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
                             cookie=auth_cookie)
    except Exception as exc:                       # noqa: BLE001
        # HTTP 412 / 429 会在这里抛（body 不是 JSON），view 阶段也要能回放快照
        if risk_blocked():
            return degrade(key, f"取视频信息遇到风控：{exc}")
        raise
    if view.get("code") != 0:
        msg = f"取视频信息失败：{view.get('message')}（code {view.get('code')}）"
        if is_risk_code(view.get("code")) or risk_blocked():
            return degrade(key, msg)
        raise RuntimeError(msg)
    v = view["data"]

    pages = v.get("pages") or []
    page = min(page, max(1, len(pages))) if pages else 1
    cid = pages[page - 1]["cid"] if pages else v["cid"]
    part = pages[page - 1].get("part", "") if pages else ""

    cookie = " ".join(x for x in [buvid_cookie(), (cookie_user or "").strip()] if x)
    _LAST_COOKIE["value"] = cookie

    params = {"bvid": v["bvid"], "cid": cid, "qn": qn, "fnver": 0,
              "fnval": 4048, "fourk": 1}
    pu = None
    for attempt in range(2):
        if attempt and risk_blocked():
            break     # 第一枪已命中风控：冷却期内一包不发，刷新 buvid 也救不了 IP 级限流
        if attempt:
            # 退避 + 刷新 buvid + 重新签名（wts 是签名的一部分，复用旧签名必失败）
            time.sleep(PLAYURL_RETRY_DELAY)
            ck = " ".join(x for x in [fresh_buvid_cookie(), (cookie_user or "").strip()] if x)
        else:
            ck = cookie
        try:
            pu = http_json("https://api.bilibili.com/x/player/wbi/playurl?" + wbi_sign(params),
                           cookie=ck)
        except Exception as exc:                       # noqa: BLE001
            if risk_blocked():
                break
            if attempt:
                raise RuntimeError(f"取播放地址失败：{exc}") from exc
            continue
        if pu.get("code") == 0 or not is_risk_code(pu.get("code")):
            break
        # -352 命中后断路器已拉起，最多再退避刷指纹试一次，不继续加热窗口
    if pu is None or pu.get("code") != 0:
        msg = "取播放地址失败：" + (str(pu.get("message")) if pu else "接口被风控拦截")
        if pu is None or is_risk_code(pu.get("code")) or risk_blocked():
            return degrade(key, msg)
        raise RuntimeError(msg)
    data = pu["data"]
    dash = data.get("dash")
    if not dash:
        raise RuntimeError("该视频未返回 DASH 流（可能是番剧/直播/付费内容）")

    vs = pick_stream(dash.get("video") or [], qn)
    as_ = pick_audio(dash.get("audio") or [])
    if not vs:
        raise RuntimeError("没有可用的视频流")

    token = uuid.uuid4().hex
    media = {
        "v": urls_of(vs), "a": urls_of(as_), "ts": time.time(),
        "bvid": v["bvid"], "page": page, "qn": qn,
    }
    with _lock:
        MEDIA[token] = media
        # 清理 2 小时前的旧 token
        for k in [k for k, val in MEDIA.items() if time.time() - val["ts"] > 7200]:
            MEDIA.pop(k, None)

    out = {
        "ok": True,
        "token": token,
        "bvid": v["bvid"],
        "aid": v["aid"],
        "cid": cid,
        "title": v["title"],
        "owner": (v.get("owner") or {}).get("name", ""),
        "pic": v.get("pic", ""),
        "duration": float(dash.get("duration") or v.get("duration") or 0),
        "page": page,
        "pages": [{"index": p.get("page"), "cid": p.get("cid"), "part": p.get("part")} for p in pages],
        "quality": vs.get("id"),
        "qualityName": QUALITY_NAME.get(vs.get("id"), str(vs.get("id"))),
        "qualityList": [{"qn": q, "name": QUALITY_NAME.get(q, str(q))} for q in (data.get("accept_quality") or [])],
        "video": {"id": vs.get("id"), "codecs": vs.get("codecs"),
                  "width": vs.get("width"), "height": vs.get("height"),
                  "bandwidth": vs.get("bandwidth")},
        "audio": {"id": (as_ or {}).get("id"), "bandwidth": (as_ or {}).get("bandwidth")},
        "loggedIn": bool(re.search(r"SESSDATA=[^;]+", cookie_user or "")),
    }
    save_snapshot(key, out, media)   # 风控降级回放的素材（跨进程重启仍有效）
    return out


def fresh_buvid_cookie() -> str:
    """强制刷新 buvid cookie（-352 风控时旧 cookie 可能已失效）。"""
    try:
        d = http_json("https://api.bilibili.com/x/frontend/finger/spi").get("data", {})
        ck = f"buvid3={d.get('b_3','')}; buvid4={d.get('b_4','')}"
        with _lock:
            _BUVID["cookie"] = ck
            _BUVID["ts"] = time.time()
        return ck
    except Exception:
        return buvid_cookie()


# --------------------------------------------------------------------------
# 空间动态 feed（VCNC 足球账号）
# --------------------------------------------------------------------------
FEED_MID = 432185343
_FEED_CACHE: dict[str, tuple[float, dict]] = {}

# 标题/简介命中视为足球内容；账号也发科技类视频，需要过滤
FOOTBALL_IN = [
    "实况", "集锦", "五人场", "七人场", "八人场", "十一人", "足球", "比赛", "训练",
    "联赛", "杯赛", "友谊赛", "约战", "进球", "扑救", "门将", "球场", "对抗", "射门",
    "过人", "角球", "点球", "红牌", "乌龙", "逆转", "绝杀", "十佳球", "周最佳", "年度",
    "赛季", "欧冠", "世界杯", "欧洲杯", "英超", "西甲", "意甲", "德甲", "法甲", "中超",
    "足协杯", "亚洲杯", "世预赛", "奥运会", "足球场", "看球",
]
FOOTBALL_OUT = [
    "科技", "电脑", "软件", "硬件", "手机", "评测", "开箱", "编程", "代码",
    "路由器", "NAS", "磁盘", "硬盘", "CPU", "显卡", "内存", "显示器", "键盘",
    "鼠标", "笔记本", "科学", "拆机", "装机",
]


def _is_football(title: str, desc: str) -> bool:
    t = (title or "") + " " + (desc or "")
    if any(k in t for k in FOOTBALL_OUT):
        return False
    return any(k in t for k in FOOTBALL_IN)


def space_feed(offset: str, user_cookie: str = "") -> dict:
    """拉取 VCNC 的空间动态（投稿视频流）。

    走 x/polymer/web-dynamic/v1/feed/space：带 buvid cookie 即可，无需 wbi 签名
    （space/wbi/arc/search 已加风控 dm 参数，实测 -352 / 412）。
    offset 为空表示第一页；data.offset 是下一页游标。
    对 -352：刷新 buvid + 指数退避重试（4 次尝试）；同一 offset 5 分钟缓存。
    """
    off = (offset or "").strip()
    key = off or "first"
    hit = _FEED_CACHE.get(key)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    # 冷却期内不再发请求：沿用上一轮成功结果（哪怕超过 5 分钟），否则快速失败让前端用本地缓存
    if risk_blocked():
        if hit:
            return hit[1]
        raise RuntimeError(f"动态接口风控冷却中，请 {risk_seconds()} 秒后再试（比赛列表已用本地缓存）")
    last: Exception | None = None
    for attempt in range(4):
        try:
            if attempt:
                time.sleep({0: 0, 1: 1, 2: 3, 3: 6}.get(attempt, 6))
            url = ("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
                   f"?host_mid={FEED_MID}&platform=web&features=itemOpusStyle")
            if off:
                url += "&offset=" + urllib.parse.quote(off)
            cookie = fresh_buvid_cookie() if attempt else buvid_cookie()
            cookie = (cookie + " " + (user_cookie or "").strip()).strip()
            d = http_json_no_origin(url, cookie=cookie)
            if is_risk_code(d.get("code")):
                last = RuntimeError(f"动态接口风控 {d.get('code')}")
                if risk_blocked():
                    break          # 断路器已拉起，继续退避重试只会加热 IP 窗口
                continue
            if d.get("code") != 0 or "data" not in d:
                raise RuntimeError(f"动态接口失败：{d.get('message')}")
            data = d["data"]
            all_v, football = [], []
            for it in data.get("items") or []:
                mod = (it.get("modules") or {})
                md = mod.get("module_dynamic") or {}
                major = md.get("major") or {}
                if major.get("type") != "MAJOR_TYPE_ARCHIVE":
                    continue
                arc = major.get("archive") or {}
                bvid = arc.get("bvid") or ""
                if not bvid:
                    continue
                ma = mod.get("module_author") or {}
                o = {
                    "bvid": bvid,
                    "aid": arc.get("aid"),
                    "title": arc.get("title", ""),
                    "pic": arc.get("cover", ""),   # 协议相对地址，前端补 https:
                    "duration": arc.get("duration_text", ""),
                    "pubdate": ma.get("pub_ts", 0),
                    "desc": arc.get("desc", ""),
                }
                all_v.append(o)
                if _is_football(o["title"], o["desc"]):
                    football.append(o)
            # 过滤后为空但原始有内容时不过滤（账号以足球为主，避免误杀）
            use = football if football else all_v
            if not use:
                # 账号有 454 个视频，返回空只可能是软风控，按失败处理走上层重试
                last = RuntimeError("动态接口返回为空（疑似软风控）")
                continue
            out = {
                "ok": True,
                "videos": use,
                "offset": data.get("offset", ""),
                "hasMore": bool(data.get("has_more")),
                "filtered": bool(football) and len(football) < len(all_v),
            }
            if len(_FEED_CACHE) > 32:
                _FEED_CACHE.clear()
            _FEED_CACHE[key] = (time.time(), out)
            return out
        except Exception as exc:  # noqa: BLE001
            last = exc
            if risk_blocked():
                break             # HTTP 412 等已在出口拉起冷却，别再退避重试加热窗口
    if risk_blocked():
        if hit:
            return hit[1]         # 冷却期优先沿用上一轮成功结果（哪怕超过 5 分钟）
        raise RuntimeError(f"动态接口风控冷却中，请 {risk_seconds()} 秒后再试"
                           "（比赛列表已用本地缓存）")
    raise last or RuntimeError("动态接口风控中（-352），请稍后重试或填写登录 Cookie")


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
}


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """浏览器中途放弃连接是常态（seek / 预缓冲完成），不要刷栈。"""
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "H-Player/1.0"

    def log_message(self, fmt, *args):
        if "/api/media/" not in self.path:
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------------- 路由 ----------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/resolve":
                self.handle_resolve(qs)
            elif path == "/api/feed":
                self.handle_feed(qs)
            elif path.startswith("/api/media/"):
                self.handle_media(path, qs)
            elif path == "/api/cache/config":
                # 只有显式带 mb 才写；无参读取不得重置上限（回归测试抓到）
                raw = (qs.get("mb") or [""])[0]
                if raw.strip():
                    try:
                        cache_set_limit(int(raw))
                    except (TypeError, ValueError):
                        pass
                self.send_json(cache_stat())
            elif path == "/api/cache/stat":
                self.send_json(cache_stat())
            elif path == "/api/cache/clear":
                cache_clear()
                self.send_json(cache_stat())
            elif path == "/api/cache/prefetch":
                self.handle_cache_prefetch(qs)
            elif path == "/api/net/stat":
                self.send_json(NET_METER.stat())
            elif path == "/api/net/reset":
                NET_METER.reset()
                self.send_json(NET_METER.stat())
            elif path == "/api/social/auth":
                self.send_json(social.auth())
            elif path == "/api/social/qrcode":
                self.send_json(social.qrcode())
            elif path == "/api/social/poll":
                self.send_json(social.poll((qs.get("key") or [""])[0]))
            elif path == "/api/social/me":
                self.send_json(social.me(force=(qs.get("force") or [""])[0] == "1"))
            elif path == "/api/replies":
                self.handle_replies(qs)
            elif path == "/api/ping":
                self.send_json({"ok": True, "t": time.time()})
            else:
                self.handle_static(path)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                self.send_json({"ok": False, "error": str(exc)}, status=500)
            except Exception:
                pass

    def do_POST(self):
        """只有账号类写操作走 POST：三连、登出。带同源校验。"""
        path = urllib.parse.urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            n = 0
        raw = self.rfile.read(min(max(n, 0), 64 * 1024)).decode("utf-8", "replace") if n else ""
        qs = urllib.parse.parse_qs(raw)
        try:
            if not self._same_origin():
                self.send_json({"ok": False, "error": "拒绝跨站请求"}, 403)
                return
            if path == "/api/social/triple":
                self.send_json(social.triple((qs.get("bvid") or [""])[0]))
            elif path == "/api/clips/publish":
                self.send_json(social.clips_publish(
                    (qs.get("oid") or [""])[0], (qs.get("bvid") or [""])[0],
                    (qs.get("message") or [""])[0]))
            elif path == "/api/clips/delete":
                self.send_json(social.clips_delete(
                    (qs.get("oid") or [""])[0], (qs.get("bvid") or [""])[0],
                    (qs.get("rpid") or [""])[0]))
            elif path == "/api/social/manual":
                self.send_json(social.set_manual_cookie((qs.get("cookie") or [""])[0]))
            elif path == "/api/social/logout":
                self.send_json(social.logout())
            else:
                self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, 500)

    def _same_origin(self) -> bool:
        """本地代理监听 127.0.0.1，第三方网页也能发请求过来；写操作必须挡跨域。"""
        for name in ("Origin", "Referer"):
            v = (self.headers.get(name) or "").strip()
            if not v or v.lower() == "null":
                continue
            host = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", "", v).split("/")[0].split("?")[0]
            host = re.sub(r":\d+$", "", host)
            if host not in ("127.0.0.1", "localhost"):
                return False
        return True

    # ---------------- 接口 ----------------
    def handle_replies(self, qs):
        """原始评论列表（自定义集锦的云端载体）。与 Android BiliApi.fetchReplies 同语义。"""
        aid = (qs.get("aid") or [""])[0]
        try:
            pages = max(1, min(15, int((qs.get("pages") or ["5"])[0])))
        except (TypeError, ValueError):
            pages = 5
        ps = min(20, max(1, int((qs.get("ps") or ["20"])[0] or 20)))
        if not aid.isdigit():
            self.send_json({"ok": False, "error": "缺少 aid"})
            return
        cookie = (qs.get("cookie") or [""])[0] or social.user_cookie()
        rows = []
        for pn in range(1, pages + 1):
            url = ("https://api.bilibili.com/x/v2/reply?type=1&oid=" + aid
                   + "&pn=" + str(pn) + "&ps=" + str(ps)
                   + "&sort=2&web_location=1315875")
            try:
                j = http_json(url, cookie=cookie, timeout=15)
            except Exception as exc:  # noqa: BLE001
                break
            if j.get("code") != 0:
                break
            replies = ((j.get("data") or {}).get("replies")) or []
            if not replies:
                break
            for r in replies:
                c = r.get("content") or {}
                m = r.get("member") or {}
                rows.append({
                    "rpid": r.get("rpid") or 0,
                    "user": m.get("uname") or "",
                    "mid": m.get("mid") or "",
                    "time": r.get("ctime") or 0,
                    "text": c.get("message") or "",
                })
            if len(replies) < ps:
                break
        self.send_json({"ok": True, "count": len(rows), "replies": rows})

    def handle_resolve(self, qs):
        raw = (qs.get("url") or [""])[0]
        page = int((qs.get("p") or ["1"])[0] or 1)
        qn = int((qs.get("qn") or ["80"])[0] or 80)
        # 手填 Cookie 优先；否则自动套用扫码登录凭证（大会员画质需要）
        cookie = (qs.get("cookie") or [""])[0] or social.user_cookie()
        if not raw.strip():
            self.send_json({"ok": False, "error": "请填写视频链接或 BV 号"}, 400)
            return
        try:
            self.send_json(resolve(raw, page, qn, cookie))
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, 200)

    def handle_cache_prefetch(self, qs):
        """GET /api/cache/prefetch?token=..&kind=v&i=0&ranges=1-2,3-4（字节区间）
        后台逐块落盘，立即返回排队摘要。"""
        token = (qs.get("token") or [""])[0]
        kind = "a" if (qs.get("kind") or [""])[0] == "a" else "v"
        try:
            idx = int((qs.get("i") or ["0"])[0] or 0)
        except (TypeError, ValueError):
            idx = 0
        ranges_raw = (qs.get("ranges") or [""])[0]
        entry = MEDIA.get(token)
        if not entry or not ranges_raw:
            self.send_json({"ok": True, "queued": 0, "bytes": 0})
            return
        key = media_cache_key(entry, kind)
        urls = (entry.get(kind) or [])[idx:] + (entry.get(kind) or [])[:idx]
        ranges: list[tuple[int, int]] = []
        for part in ranges_raw.split(","):
            mm = re.fullmatch(r"(\d+)-(\d+)", part.strip())
            if not mm:
                continue
            a, b = int(mm.group(1)), int(mm.group(2))
            if b >= a and b - a < 512 * 1024 * 1024:
                ranges.append((a, b))
        if not key or not urls or not ranges:
            self.send_json({"ok": True, "queued": 0, "bytes": 0})
            return
        planned, chunks = 0, 0
        for a, b in ranges:
            s = a
            while s <= b:
                e = min(b, s + PREFETCH_CHUNK - 1)
                planned += e - s + 1
                chunks += 1
                if chunks >= PREFETCH_MAX_CHUNKS:
                    break
                s += PREFETCH_CHUNK
            if chunks >= PREFETCH_MAX_CHUNKS:
                break
        fkey, franges, furls = key, ranges, urls

        def work():
            written, done = 0, 0
            for a, b in franges:
                s = a
                while s <= b:
                    e = min(b, s + PREFETCH_CHUNK - 1)
                    n = cache_prefetch_range(fkey, s, e, furls)
                    if n > 0:
                        written += n
                    done += 1
                    if done >= PREFETCH_MAX_CHUNKS:
                        return
                    s += PREFETCH_CHUNK
            if VERBOSE:
                sys.stderr.write("[cache] prefetch %s written=%.1fMB / planned %.1fMB\n" % (
                    kind, written / 1048576, planned / 1048576))

        _prefetch_pool.submit(work)
        self.send_json({"ok": True, "queued": chunks, "bytes": planned})

    def handle_feed(self, qs):
        offset = (qs.get("offset") or [""])[0]
        cookie = (qs.get("cookie") or [""])[0] or social.user_cookie()
        try:
            self.send_json(space_feed(offset, cookie))
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, 200)

    def handle_media(self, path, qs):
        parts = [p for p in path.split("/") if p]
        # ['api','media',token,kind]
        if len(parts) < 4:
            self.send_json({"ok": False, "error": "bad media path"}, 400)
            return
        token, kind = parts[2], parts[3]
        entry = MEDIA.get(token)
        if not entry:
            self.send_json({"ok": False, "error": "token 已失效，请重新解析视频"}, 404)
            return
        idx = int((qs.get("i") or ["0"])[0] or 0)
        urls = entry.get(kind) or []
        if not urls:
            self.send_json({"ok": False, "error": "该视频没有音频流"}, 404)
            return
        urls = urls[idx:] + urls[:idx]

        rng = self.headers.get("Range")
        # 浏览器 seek 时发的是开区间 "bytes=N-"，统一收敛成 <=3MB 的有界区间
        s, e = cache_bounded(rng)
        headers = {
            "User-Agent": UA,
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept": "*/*",
            "Accept-Encoding": "identity",
            "Range": "bytes=%d-%d" % (s, e),
        }
        if _LAST_COOKIE["value"]:
            headers["Cookie"] = _LAST_COOKIE["value"]
        key = media_cache_key(entry, kind)

        # ---- 纯本地命中：一个字节都不用去 B 站拿 ----
        if key:
            hit = cache_find(key, s, e)
            if hit:
                fp, s0, hit_end = hit
                length = hit_end - s + 1
                total_sz = cache_meta(key, "total", "") or "*"
                ctype = cache_meta(key, "ctype", "")
                if not (ctype.startswith("video/") or ctype.startswith("audio/")):
                    ctype = "video/mp4" if kind == "v" else "audio/mp4"
                self.send_response(206)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", "bytes %d-%d/%s" % (s, hit_end, total_sz))
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                CACHE_STATS["hits"] += 1
                try:
                    with open(fp, "rb") as cf:
                        cf.seek(s - s0)
                        left = length
                        while left > 0:
                            b = cf.read(min(65536, left))
                            if not b:
                                break
                            self.wfile.write(b)
                            NET_METER.add_saved(len(b))
                            left -= len(b)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                if VERBOSE:
                    sys.stderr.write("[media] CACHE HIT %s bytes=%d-%d\n" % (kind, s, e))
                return
            CACHE_STATS["misses"] += 1

        last_err = None
        for url in urls:
            t0 = time.time()
            try:
                req = urllib.request.Request(url, headers=headers)
                upstream = urllib.request.urlopen(req, timeout=30)
            except urllib.error.HTTPError as exc:
                last_err = f"HTTP {exc.code}"
                continue
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
                continue
            with upstream:
                status = upstream.status
                cr = upstream.headers.get("Content-Range") or ""
                cm = re.search(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", cr)
                total_len = 0 if (not cm or cm.group(3) == "*") else int(cm.group(3))
                cacheable = bool(key) and status == 206 and bool(cm) and int(cm.group(1)) == s
                ctype = upstream.headers.get("Content-Type") or ""
                if not (ctype.startswith("video/") or ctype.startswith("audio/")):
                    ctype = "video/mp4" if kind == "v" else "audio/mp4"

                # 未命中：边转发边写临时文件，写满或 seek 打断后按已下载前缀原子落盘
                tmp, fout = None, None
                if cacheable:
                    try:
                        d = cache_key_dir(key, create=True)
                        tmp = os.path.join(d, "%d.tmp" % time.time_ns())
                        fout = open(tmp, "wb")
                        cache_set_meta(key, "ctype", ctype, only_once=True)
                    except OSError:
                        tmp, fout, cacheable = None, None, False

                self.send_response(status if status in (200, 206) else 200)
                self._cors()
                self.send_header("Content-Type", ctype)
                for h in ("Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"):
                    hv = upstream.headers.get(h)
                    if hv:
                        self.send_header(h, hv)
                if not upstream.headers.get("Accept-Ranges"):
                    self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                total = 0
                aborted = False
                try:
                    while True:
                        chunk = upstream.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        NET_METER.add_network(len(chunk))
                        if fout:
                            fout.write(chunk)
                        total += len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    aborted = True
                if fout:
                    fout.close()
                if tmp:
                    if total > 0:
                        # 读了多少就存多少：播放器 seek 打断时保留已下载的连续前缀
                        cache_commit(key, s, s + total - 1, total_len, tmp, total)
                    else:
                        try:
                            os.remove(tmp)
                        except OSError:
                            pass
            if VERBOSE:
                sys.stderr.write("[media] %s client=%s up=%s cr=%s bytes=%d %.0fms%s\n" % (
                    kind, rng or "-", status, upstream.headers.get("Content-Range", "-"),
                    total, (time.time() - t0) * 1000, " ABORTED" if aborted else ""))
            if aborted:
                return
            return
        self.send_json({"ok": False, "error": f"流地址不可用（{last_err}）"}, 502)

    def handle_static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_json({"ok": False, "error": "not found"}, 404)
            return
        with open(full, "rb") as fh:
            body = fh.read()
        ext = os.path.splitext(full)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ---------------- 小工具 ----------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)


def main():
    global PORT, VERBOSE
    args = sys.argv[1:]
    if "--verbose" in args:
        VERBOSE = True
    if "--port" in args:
        PORT = int(args[args.index("--port") + 1])
    httpd = None
    for p in range(PORT, PORT + 6):
        try:
            httpd = QuietServer(("127.0.0.1", p), Handler)
            PORT = p
            break
        except OSError:
            continue
    if httpd is None:
        print(f"端口 {PORT}~{PORT + 5} 都被占用，请先关掉旧的窗口。")
        return
    url = f"http://127.0.0.1:{PORT}/"
    print("=" * 56)
    print("  B 站集锦合成播放器已启动")
    print(f"  地址：{url}")
    print("  关闭：在本窗口按 Ctrl+C")
    print("=" * 56)
    if "--no-open" not in args:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
