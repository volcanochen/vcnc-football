#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 aapt2 link 产出的 base.apk 与编译后的 classes.dex、assets 合并成未签名 APK。
   之后由 zipalign + apksigner 完成对齐与签名。

   dex 参数可以是一个 .dex 文件，也可以是一个包含 classes*.dex 的目录（d8 多 dex 场景）。
"""
import glob
import os
import sys
import zipfile


def collect_dex(dex_arg):
    if os.path.isdir(dex_arg):
        files = sorted(glob.glob(os.path.join(dex_arg, "classes*.dex")))
        if not files:
            raise SystemExit("未在目录中找到 classes*.dex: " + dex_arg)
        return files
    if not os.path.isfile(dex_arg):
        raise SystemExit("dex 不存在: " + dex_arg)
    return [dex_arg]


def main():
    if len(sys.argv) != 5:
        print("usage: make_apk.py <base.apk> <classes.dex|dex_dir> <assets_dir> <out.apk>")
        sys.exit(2)
    base, dex_arg, assets_dir, out = sys.argv[1:5]
    dex_files = collect_dex(dex_arg)

    with zipfile.ZipFile(base, "r") as zin, \
         zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            name = item.filename
            if name.startswith("META-INF/"):
                continue
            if name.endswith(".dex"):
                continue
            # 原样复制（保留压缩方式，resources.arsc 等由 zipalign 负责对齐）
            zout.writestr(item, zin.read(name))

        # 注入 classes.dex / classes2.dex ...
        for d in dex_files:
            with open(d, "rb") as f:
                zout.writestr(os.path.basename(d), f.read())

        # 注入 assets/（含 www/index.html, www/app.js, www/style.css）
        if os.path.isdir(assets_dir):
            for root, _, files in os.walk(assets_dir):
                for fn in files:
                    full = os.path.join(root, fn)
                    arcname = "assets/" + os.path.relpath(full, assets_dir).replace(os.sep, "/")
                    with open(full, "rb") as f:
                        zout.writestr(arcname, f.read())

    print("make_apk: wrote", out, "(", len(dex_files), "dex )")


if __name__ == "__main__":
    main()
