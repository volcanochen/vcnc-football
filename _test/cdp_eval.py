#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通过 Chrome DevTools Protocol 在真机 WebView 里执行 JS 并取回结果。

用途：折叠屏/外屏这类「截图不可用、点击坐标难算」的场景下，
唯一可靠的验证通道是直接在页面里执行表达式并读回结果。

用法：
  python3 cdp_eval.py <js 文件或 -c "表达式">
默认连 127.0.0.1:9922（需先 adb forward tcp:9922 localabstract:webview_devtools_remote_<pid>）。
"""
import json
import sys
import urllib.request

PORT = 9922

# 沙箱里有 HTTP_PROXY 环境变量，会把 127.0.0.1 的请求也发给代理 → 502。
# CDP 的 /json 接口必须直连，用空 ProxyHandler 强制绕过。
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def find_page():
    with _opener.open("http://127.0.0.1:%d/json" % PORT, timeout=8) as r:
        pages = json.load(r)
    for p in pages:
        if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
            return p["webSocketDebuggerUrl"]
    raise SystemExit("no debuggable page found")


class WS:
    """极简 WebSocket 客户端（只需 text frame，够用且无第三方依赖）。"""

    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, path = rest.split("/", 1)
        path = "/" + path
        host, port = hostport.split(":")
        import socket
        import base64
        import os
        self.s = socket.create_connection((host, int(port)), timeout=15)
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

    def send(self, text):
        data = text.encode()
        mask = os.urandom(4) if False else __import__("os").urandom(4)
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
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            opcode = b0 & 0x0F
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
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                raise SystemExit("closed by peer")

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def evaluate(js, timeout=120):
    ws = WS(find_page())
    try:
        ws.send(json.dumps({
            "id": 1, "method": "Runtime.evaluate",
            "params": {"expression": js, "returnByValue": True,
                       "awaitPromise": True, "userGesture": True},
        }))
        deadline = timeout
        while deadline > 0:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                if "error" in msg:
                    return "PROTOCOL_ERROR: " + json.dumps(msg["error"], ensure_ascii=False)
                r = msg.get("result", {})
                if r.get("exceptionDetails"):
                    d = r["exceptionDetails"]
                    ex = d.get("exception", {}).get("description") or d.get("text")
                    return "JS_ERROR: " + str(ex)
                return r.get("result", {}).get("value")
        return "TIMEOUT"
    finally:
        ws.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    if sys.argv[1] == "-c":
        js = sys.argv[2]
    else:
        with open(sys.argv[1], encoding="utf-8") as f:
            js = f.read()
    out = evaluate(js)
    if isinstance(out, (dict, list)):
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(out)


if __name__ == "__main__":
    main()
