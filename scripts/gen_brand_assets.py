# -*- coding: utf-8 -*-
"""生成 VCNC足球 的 launcher 图标与设置页用图标（纯 Pillow，无外部素材）。

设计语言：
  - 深墨绿 -> 草绿对角渐变 + 斜向草坪条纹 = 五人制球场
  - 中央白色足球（截角二十面体投影简化图案）+ 立体明暗 = 内容主体
  - 四角青色取景框 = 「自动跟焦 / 沉浸场」的产品特征
  - 不放文字：launcher 图标在 48px 下文字必然糊，品牌名交给系统标签

产出：
  android/app/src/main/res/mipmap-*/ic_launcher.png          旧版方形图标
  android/app/src/main/res/mipmap-*/ic_launcher_{background,foreground}.png
  android/app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml  Android 8+ 自适应图标
  static/app-icon.png                                          设置页 / 文档用 512px 图标
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
STATIC = os.path.join(ROOT, 'static')
S = 1024                      # 超采样画布，最后统一 LANCZOS 缩小
GREEN_DARK = (6, 40, 32)
GREEN_LIGHT = (20, 166, 108)
CYAN = (0, 213, 255)
INK = (17, 46, 54)


def lerp(a, b, t):
    return a + (b - a) * t


def make_background(size):
    """绿茵渐变 + 斜向草坪条纹 + 中心柔光。"""
    img = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / float(size - 1)
        # 对角方向再叠一点横向变化，避免纯线性太平
        r = int(lerp(GREEN_DARK[0], GREEN_LIGHT[0], t * .82))
        g = int(lerp(GREEN_DARK[1], GREEN_LIGHT[1], t))
        b = int(lerp(GREEN_DARK[2], GREEN_LIGHT[2], t * .9))
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))

    stripes = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stripes)
    band = size / 7.0
    for i in range(-2, 10):
        x0 = i * band * 2
        sd.polygon([(x0, 0), (x0 + band, 0),
                    (x0 + band + size * .42, size), (x0 + size * .42, size)],
                   fill=(255, 255, 255, 16))
    img = Image.alpha_composite(img, stripes)

    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([size * .13, size * .09, size * .87, size * .85],
               fill=(150, 255, 205, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(size * .085))
    return Image.alpha_composite(img, glow)


def shaded_ball(size, cx, cy, R):
    """带光照的白色球体（返回 RGBA 图层，圆外透明）。"""
    D = int(R * 2) + 2
    ball = Image.new('RGBA', (D, D), (0, 0, 0, 0))
    px = ball.load()
    for y in range(D):
        for x in range(D):
            dx = (x - R) / R
            dy = (y - R) / R
            rr = math.sqrt(dx * dx + dy * dy)
            if rr > 1.0:
                continue
            # 光来自左上：dx/dy 越小越亮；边缘明显压暗，做出球面体积感
            light = 1.0 - (dx * .42 + dy * .52)
            edge = max(0.0, (rr - .52) / .48)
            v = 246 + 12 * light - 78 * (edge ** 1.7)
            v = int(max(120, min(255, v)))
            px[x, y] = (v, min(255, v + 3), min(255, v + 2), 255)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    layer.alpha_composite(ball, (int(cx - R - 1), int(cy - R - 1)))
    return layer


def pentagon(cx, cy, r, rot):
    return [(cx + r * math.cos(rot + k * 2 * math.pi / 5),
             cy + r * math.sin(rot + k * 2 * math.pi / 5)) for k in range(5)]


def ball_pattern(size, cx, cy, R):
    """足球的经典深色五边形 + 缝线，裁剪进球面。"""
    pat = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(pat)
    seam = (60, 88, 92, 255)
    lw = max(2, int(R * .022))

    # 中央五边形
    d.polygon(pentagon(cx, cy, R * .285, -math.pi / 2), fill=INK)

    for k in range(5):
        th = -math.pi / 2 + k * 2 * math.pi / 5
        # 外围五边形：一个顶点朝向球心
        ox, oy = cx + R * .685 * math.cos(th), cy + R * .685 * math.sin(th)
        d.polygon(pentagon(ox, oy, R * .175, th + math.pi), fill=INK)
        # 中央五边形顶点 -> 外围五边形朝向球心的顶点
        d.line([(cx + R * .285 * math.cos(th), cy + R * .285 * math.sin(th)),
                (cx + R * .51 * math.cos(th), cy + R * .51 * math.sin(th))],
               fill=seam, width=lw)
        # 外围五边形外侧再向外延两条缝线，补出六边形网格感
        for sgn in (-1, 1):
            a = th + sgn * 2 * math.pi / 5
            d.line([(ox + R * .175 * math.cos(a), oy + R * .175 * math.sin(a)),
                    (cx + R * .93 * math.cos(a), cy + R * .93 * math.sin(a))],
                   fill=seam, width=lw)

    # 球面外的图案裁掉
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    pat.putalpha(Image.composite(pat.getchannel('A'),
                                 Image.new('L', (size, size), 0), mask))
    return pat


def focus_brackets(size, m, L, width, color):
    """四角取景框：先画青色发光底，再画白色实线。"""
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    solid = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    s = ImageDraw.Draw(solid)
    corners = [
        [(m, m + L), (m, m), (m + L, m)],
        [(size - m - L, m), (size - m, m), (size - m, m + L)],
        [(m, size - m - L), (m, size - m), (m + L, size - m)],
        [(size - m - L, size - m), (size - m, size - m), (size - m, size - m - L)],
    ]
    for pts in corners:
        g.line(pts, fill=color + (110,), width=int(width * 2.4), joint='curve')
        s.line(pts, fill=(255, 255, 255, 245), width=width, joint='curve')
        for p in (pts[0], pts[-1]):
            s.ellipse([p[0] - width / 2, p[1] - width / 2,
                       p[0] + width / 2, p[1] + width / 2],
                      fill=(255, 255, 255, 245))
    glow = glow.filter(ImageFilter.GaussianBlur(size * .012))
    return Image.alpha_composite(glow, solid)


def artwork(size, scale=1.0, brackets=True):
    """完整图形层（透明底）：足球阴影 -> 球面 -> 图案 -> 高光 -> 取景框。"""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    cx = cy = size / 2.0
    R = size * .30 * scale

    # 落影
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        [cx - R * .96, cy - R * .70, cx + R * .96, cy + R * 1.12],
        fill=(0, 20, 14, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * .035))
    layer = Image.alpha_composite(layer, shadow)

    layer = Image.alpha_composite(layer, shaded_ball(size, cx, cy, R))
    layer = Image.alpha_composite(layer, ball_pattern(size, cx, cy, R))

    # 左上高光（小块柔光），让球不是纯平贴纸
    hi = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hi).ellipse(
        [cx - R * .78, cy - R * .86, cx - R * .05, cy - R * .18],
        fill=(255, 255, 255, 62))
    hi = hi.filter(ImageFilter.GaussianBlur(size * .022))
    layer = Image.alpha_composite(layer, hi)

    if brackets:
        layer = Image.alpha_composite(layer, focus_brackets(
            size, size * .085, size * .175, max(2, int(size * .017)), CYAN))
    return layer


def rounded(img, radius_ratio):
    size = img.size[0]
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    out = img.copy()
    out.putalpha(mask)
    return out


def save_variants():
    bg = make_background(S)
    art = artwork(S, scale=1.0, brackets=True)
    square = rounded(Image.alpha_composite(bg, art), .22)
    # roundIcon 在所有密度都要有兜底：否则 API<26 设备解析不到 v26 限定的 xml
    circle = rounded(Image.alpha_composite(bg, art), .5)

    # 自适应图标：背景铺满 108dp，前景内容缩到中间安全区（避免被裁）
    fg = artwork(S, scale=.66, brackets=True)

    densities = [
        ('mdpi', 48, 108), ('hdpi', 72, 162), ('xhdpi', 96, 216),
        ('xxhdpi', 144, 324), ('xxxhdpi', 192, 432),
    ]
    for name, icon_px, adaptive_px in densities:
        out = os.path.join(RES, 'mipmap-' + name)
        os.makedirs(out, exist_ok=True)
        square.resize((icon_px, icon_px), Image.LANCZOS).save(
            os.path.join(out, 'ic_launcher.png'))
        circle.resize((icon_px, icon_px), Image.LANCZOS).save(
            os.path.join(out, 'ic_launcher_round.png'))
        bg.resize((adaptive_px, adaptive_px), Image.LANCZOS).save(
            os.path.join(out, 'ic_launcher_background.png'))
        fg.resize((adaptive_px, adaptive_px), Image.LANCZOS).save(
            os.path.join(out, 'ic_launcher_foreground.png'))
        print('mipmap-%s: %d / %d px' % (name, icon_px, adaptive_px))

    v26 = os.path.join(RES, 'mipmap-anydpi-v26')
    os.makedirs(v26, exist_ok=True)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@mipmap/ic_launcher_background" />\n'
           '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
           '</adaptive-icon>\n')
    for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        with open(os.path.join(v26, f), 'w', encoding='utf-8') as fh:
            fh.write(xml)

    os.makedirs(STATIC, exist_ok=True)
    square.resize((512, 512), Image.LANCZOS).save(os.path.join(STATIC, 'app-icon.png'))
    print('static/app-icon.png: 512 px')
    print('done')


if __name__ == '__main__':
    save_variants()
