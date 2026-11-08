#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用 CDP 客户端模块：执行 JS / 发送任意 CDP 命令。

回归测试与真机实验共用。用法：
  from cdp import evaluate, cmd
  evaluate("1+1")                       # -> 2
  cmd("Input.dispatchTouchEvent", {...})  # 发送原始 CDP 命令

必须先 adb forward tcp:9922 localabstract:webview_devtools_remote_<pid>。
可用环境变量 CDP_PORT 覆盖默认端口 9922。
"""
import json
import os
import urllib.request

PORT = int(os.environ.get("CDP_PORT", "9922"))

# 沙箱 HTTP_PROXY 会吞 127.0.0.1 请求 → 502，必须直连
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_page_url = [None]


def find_page(refresh=False):
    if _page_url[0] and not refresh:
        return _page_url[0]
    with _opener.open("http://127.0.0.1:%d/json" % PORT, timeout=8) as r:
        pages = json.load(r)
    for p in pages:
        if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
            _page_url[0] = p["webSocketDebuggerUrl"]
            return _page_url[0]
    raise SystemExit("no debuggable page found")


class WS:
    """极简 WebSocket 客户端（text frame，无第三方依赖）。"""

    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, path = rest.split("/", 1)
        path = "/" + path
        host, port = hostport.split(":")
        import socket
        import base64
        self.s = socket.create_connection((host, int(port)), timeout=90)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
        )
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = self.s.recv(4096)
            if not d:
                raise SystemExit("handshake failed")
            buf += d
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self._id = 0

    def _send_frame(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        hdr = bytearray([0x81])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += n.to_bytes(2, "big")
        else:
            hdr.append(0x80 | 127)
            hdr += n.to_bytes(8, "big")
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.s.sendall(bytes(hdr) + masked)

    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                raise SystemExit("connection closed")
            self.buf = self.buf + d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            masked = b1 & 0x80
            ln = b1 & 0x7F
            if ln == 126:
                ln = int.from_bytes(self._read(2), "big")
            elif ln == 127:
                ln = int.from_bytes(self._read(8), "big")
            mask = self._read(4) if masked else None
            payload = self._read(ln)
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            op = b0 & 0x0F
            if op == 0x1:
                return payload.decode("utf-8", "replace")
            if op == 0x8:
                raise SystemExit("closed by peer")
            # 0x9 ping → pong，其他帧忽略
            if op == 0x9:
                try:
                    self._send_frame.__self__  # noqa
                except Exception:
                    pass

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


class Session:
    """一次 CDP 会话：可连续发多条命令/求值。"""

    def __init__(self):
        self.ws = WS(find_page())

    def close(self):
        self.ws.close()

    def _roundtrip(self, obj, timeout_s=120):
        import time
        self._next_id = getattr(self, "_next_id", 0) + 1
        mid = self._next_id
        obj["id"] = mid
        self.ws._send_frame(json.dumps(obj))
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    return {"__cdp_error__": msg["error"]}
                r = msg.get("result", {})
                if r.get("exceptionDetails"):
                    d = r["exceptionDetails"]
                    ex = d.get("exception", {}).get("description") or d.get("text")
                    return {"__js_error__": str(ex)}
                return r.get("result", {}).get("value")
        return {"__timeout__": True}

    def evaluate(self, js, timeout_s=120):
        return self._roundtrip({
            "method": "Runtime.evaluate",
            "params": {"expression": js, "returnByValue": True,
                       "awaitPromise": True, "userGesture": True},
        }, timeout_s)

    def cmd(self, method, params=None, timeout_s=120):
        return self._roundtrip({"method": method, "params": params or {}}, timeout_s)


def evaluate(js, timeout_s=120):
    """一次性连接执行 JS，返回值（可能带 __js_error__ 等包装）。"""
    s = Session()
    try:
        return s.evaluate(js, timeout_s)
    finally:
        s.close()


def cmd(method, params=None, timeout_s=120):
    s = Session()
    try:
        return s.cmd(method, params, timeout_s)
    finally:
        s.close()
