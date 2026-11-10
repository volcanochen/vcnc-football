#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QR 编码器矩阵级回归：把 qr.js 的输出与 Python qrcode 标准库逐点比对。

用法（仓库根目录）：python _test/verify_qr_matrix.py
依赖：node（生成矩阵）、Python qrcode 库（仅测试用，运行时不依赖）。

覆盖 byte mode / ECC M / version 1~10 / 全部 8 种掩模，
含 B 站登录 URL 长度（145 字节 → version 8）与 UTF-8 中文。
"""
import json
import os
import subprocess
import sys
import tempfile
import qrcode
from qrcode.constants import ERROR_CORRECT_M
from qrcode.util import QRData, MODE_8BIT_BYTE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [
    "hello",
    "VCNC足球 扫码登录",
    "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close"
    "&qrcode_key=8587cf8106a0b863c46d6bab913537f6&from=main-fe-header",
    "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close"
    "&qrcode_key=abcdef0123456789abcdef0123456789&from=main-fe-header&x=1234567890",
]

NODE_SRC = r"""
global.window = global;
require(%s);
var out = [];
for (var c = 0; c < CASES.length; c++) {
  for (var m = 0; m < 8; m++) {
    var q = QRGen.encode(CASES[c], {mask: m});
    out.push({text: CASES[c], version: q.version, mask: m, size: q.size, modules: q.modules});
  }
}
require('fs').writeFileSync(OUT, JSON.stringify(out));
"""


def main():
    fd, out_path = tempfile.mkstemp(suffix=".json", prefix="vcnc_qr_")
    os.close(fd)
    try:
        js = ("var CASES = %s; var OUT = %s;" %
              (json.dumps(CASES), json.dumps(out_path))) + NODE_SRC % json.dumps(
                  os.path.join(ROOT, "static", "qr.js").replace("\\", "/"))
        p = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True)
        if p.returncode != 0:
            print("FAIL node 生成矩阵:", p.stderr.strip())
            return 1
        cases = json.load(open(out_path, encoding="utf-8"))
        bad = []
        for c in cases:
            q = qrcode.QRCode(version=c["version"], error_correction=ERROR_CORRECT_M,
                              box_size=1, border=0, mask_pattern=c["mask"])
            q.add_data(QRData(c["text"], mode=MODE_8BIT_BYTE))
            q.make(fit=False)
            ref = q.get_matrix()
            diff = sum(1 for y in range(c["size"]) for x in range(c["size"])
                       if bool(ref[y][x]) != bool(c["modules"][y][x]))
            if diff:
                bad.append((c["version"], c["mask"], diff))
        print("QR 矩阵比对：%d 个样本，不一致 %d 个" % (len(cases), len(bad)))
        for b in bad[:10]:
            print("  MISMATCH version=%d mask=%d diff=%d" % b)
        return 0 if not bad else 1
    finally:
        if os.path.isfile(out_path):
            os.remove(out_path)


if __name__ == "__main__":
    sys.exit(main())
