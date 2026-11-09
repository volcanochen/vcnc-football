# -*- coding: utf-8 -*-
"""生成设置页「分享与支持」用到的两张二维码图片。

  static/share-qr.png   应用下载页二维码（GitHub Releases latest）
  static/donate-qr.png  微信收款码：从用户给的整张收款海报里裁出白色卡片区域，
                        去掉绿底广告与底部微信支付 logo，只留可扫的码 + 收款人名
"""
import os
import qrcode
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, 'static')
SHARE_URL = 'https://github.com/volcanochen/vcnc-football/releases/latest'
DONATE_SRC = r'C:\_videos\mm_facetoface_collect_qrcode_1794243949337.png'


def white(px, x, y):
    r, g, b = px[x, y][:3]
    return r > 232 and g > 232 and b > 232


def make_share_qr():
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=12, border=3)
    qr.add_data(SHARE_URL)
    qr.make(fit=True)
    img = qr.make_image(fill_color='#10231c', back_color='white').convert('RGB')
    # 统一成 512 方图，方便端侧 CSS 定宽
    img = img.resize((512, 512), Image.LANCZOS)
    canvas = Image.new('RGB', (560, 560), 'white')
    canvas.paste(img, (24, 24))
    canvas.save(os.path.join(STATIC, 'share-qr.png'))
    print('share-qr.png ->', SHARE_URL)


def find_white_card(im):
    """在收款海报里定位白色圆角卡片：横向扫中部、纵向扫靠左空白列。"""
    px = im.load()
    W, H = im.size
    y = int(H * .42)
    xs = [x for x in range(W) if white(px, x, y)]
    left, right = min(xs), max(xs)
    # 靠左边、卡片内且二维码黑块之外的一列
    x = left + int((right - left) * .06)
    ys = [yy for yy in range(H) if white(px, x, yy)]
    # 只取包含 y 的那一段连续区间（底部海报白底也会被扫到）
    runs, start, prev = [], None, None
    for yy in ys:
        if prev is None or yy - prev > 6:
            if start is not None:
                runs.append((start, prev))
            start = yy
        prev = yy
    if start is not None:
        runs.append((start, prev))
    top, bottom = max(runs, key=lambda r: r[1] - r[0])
    return left, top, right, bottom


def make_donate_qr():
    src = Image.open(DONATE_SRC).convert('RGB')
    l, t, r, b = find_white_card(src)
    print('donate card box:', (l, t, r, b))
    card = src.crop((l, t, r + 1, b + 1))
    # 保持完整卡片（含收款人名），统一宽度 480，白底圆角
    w = 480
    h = int(card.height * w / card.width)
    card = card.resize((w, h), Image.LANCZOS)
    out = Image.new('RGB', (w, h), 'white')
    out.paste(card, (0, 0))
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=26, fill=255)
    out.putalpha(mask)
    out.save(os.path.join(STATIC, 'donate-qr.png'))
    print('donate-qr.png:', out.size)


if __name__ == '__main__':
    os.makedirs(STATIC, exist_ok=True)
    make_share_qr()
    make_donate_qr()
