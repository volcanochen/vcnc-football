#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B 站集锦自动合成播放器 —— 本地服务（纯标准库，无第三方依赖）

职责：
  /api/resolve?url=<BV或链接>&p=<分P>&qn=<画质>&cookie=<SESSDATA>   解析视频 + 取 DASH 流地址
  /api/media/<token>/<v|a>                                          反向代理 upos 流（补 Referer/UA，透传 Range）
  /                                                                 托管 static/ 前端

启动：python server.py [--no-open] [--port 8777]
"""
from __future__ import annotations

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
# 基础工具
# --------------------------------------------------------------------------
def http_json(url: str, cookie: str = "", timeout: int = 20) -> dict:
    headers = dict(API_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def http_json_no_origin(url: str, cookie: str = "", timeout: int = 20) -> dict:
    """feed 专用：实测动态接口带 Origin 头会触发风控（-352 或空数据），去掉后正常。"""
    headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


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
# 解析视频
# --------------------------------------------------------------------------
def resolve(raw_target: str, page: int, qn: int, cookie_user: str) -> dict:
    bvid, bvid_page = parse_target(raw_target)
    if page <= 1:
        page = bvid_page

    if bvid.lower().startswith("av"):
        view = http_json(f"https://api.bilibili.com/x/web-interface/view?aid={bvid[2:]}")
    else:
        view = http_json(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
    if view.get("code") != 0:
        raise RuntimeError(f"取视频信息失败：{view.get('message')}（code {view.get('code')}）")
    v = view["data"]

    pages = v.get("pages") or []
    page = min(page, max(1, len(pages))) if pages else 1
    cid = pages[page - 1]["cid"] if pages else v["cid"]
    part = pages[page - 1].get("part", "") if pages else ""

    cookie = " ".join(x for x in [buvid_cookie(), cookie_user.strip()] if x)
    _LAST_COOKIE["value"] = cookie

    query = wbi_sign({
        "bvid": v["bvid"], "cid": cid, "qn": qn, "fnver": 0,
        "fnval": 4048, "fourk": 1,
    })
    pu = http_json("https://api.bilibili.com/x/player/wbi/playurl?" + query, cookie=cookie)
    if pu.get("code") != 0:
        raise RuntimeError(f"取播放地址失败：{pu.get('message')}（code {pu.get('code')}）")
    data = pu["data"]
    dash = data.get("dash")
    if not dash:
        raise RuntimeError("该视频未返回 DASH 流（可能是番剧/直播/付费内容）")

    vs = pick_stream(dash.get("video") or [], qn)
    as_ = pick_audio(dash.get("audio") or [])
    if not vs:
        raise RuntimeError("没有可用的视频流")

    token = uuid.uuid4().hex
    with _lock:
        MEDIA[token] = {"v": urls_of(vs), "a": urls_of(as_), "ts": time.time()}
        # 清理 2 小时前的旧 token
        for k in [k for k, val in MEDIA.items() if time.time() - val["ts"] > 7200]:
            MEDIA.pop(k, None)

    return {
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
            if d.get("code") == -352:
                last = RuntimeError("动态接口风控 -352")
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

    # ---------------- 接口 ----------------
    def handle_resolve(self, qs):
        raw = (qs.get("url") or [""])[0]
        page = int((qs.get("p") or ["1"])[0] or 1)
        qn = int((qs.get("qn") or ["80"])[0] or 80)
        cookie = (qs.get("cookie") or [""])[0]
        if not raw.strip():
            self.send_json({"ok": False, "error": "请填写视频链接或 BV 号"}, 400)
            return
        try:
            self.send_json(resolve(raw, page, qn, cookie))
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, 200)

    def handle_feed(self, qs):
        offset = (qs.get("offset") or [""])[0]
        cookie = (qs.get("cookie") or [""])[0]
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
        headers = {
            "User-Agent": UA,
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept": "*/*",
            "Accept-Encoding": "identity",
        }
        if _LAST_COOKIE["value"]:
            headers["Cookie"] = _LAST_COOKIE["value"]

        # 关键：浏览器 seek 时发的是开区间 "bytes=N-"，照转等于把整个文件拖下来。
        # 这里统一收敛成有界块（默认 3MB），让每次 seek 只取真正需要的一段。
        up_range = bounded_range(rng)
        headers["Range"] = up_range

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
                self.send_response(status if status in (200, 206) else 200)
                self._cors()
                ctype = upstream.headers.get("Content-Type") or ""
                if not (ctype.startswith("video/") or ctype.startswith("audio/")):
                    ctype = "video/mp4" if kind == "v" else "audio/mp4"
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
                        total += len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    aborted = True
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
