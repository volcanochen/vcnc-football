# -*- coding: utf-8 -*-
"""烧录时间码 OCR 原型 —— 与 feed.js 里 calibOCR 的 JS 实现逐步骤一致。
用 10 个已知答案的干净帧验证分割与识别准确率，并产出嵌入 JS 的数字模板。"""
import numpy as np, re, json, sys
from PIL import Image

# 区域与常量（与 JS 一致）
REG_X0 = 0; REG_X1R = 0.22; REG_Y0R = 0.80; REG_Y1R = 1.00
BLUR_R = 10
G_TH = 110        # 绝对亮度阈值
TH_TH = 25        # 顶帽阈值
MIN_W = 9; SPLIT_W = 36; CELL_W = 12; CELL_H = 18
MIN_H = 14; MAX_H = 45

TRUTH = {
    30:   [0,0,0,0,2,9,5,8],
    300:  [0,0,0,4,5,9,4,2],
    600:  [0,0,0,9,5,9,2,4],
    1200: [0,0,1,9,5,8,4,8],
    2400: [0,0,3,9,5,7,3,6],
    2410: [0,0,4,0,0,7,3,4],
    2870: [0,0,4,7,4,7,0,6],
    3600: [0,0,5,9,5,6,2,4],
    4200: [0,1,0,9,5,5,4,8],
    4560: [0,1,1,5,5,5,2,6],
}

def box_blur(a, r):
    """积分图 box blur，与 JS 实现一致"""
    H, W = a.shape
    ii = np.zeros((H+1, W+1), dtype=np.float64)
    ii[1:, 1:] = np.cumsum(np.cumsum(a.astype(np.float64), axis=0), axis=1)
    y1 = np.minimum(np.arange(H) + r + 1, H); y0 = np.maximum(np.arange(H) - r, 0)
    x1 = np.minimum(np.arange(W) + r + 1, W); x0 = np.maximum(np.arange(W) - r, 0)
    s = ii[np.ix_(y1+0, x1+0)] * 0  # placeholder
    s = ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]
    cnt = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return s / np.maximum(cnt, 1)

def norm_cell(cell):
    im = Image.fromarray(np.clip(cell*2, 0, 255).astype(np.uint8))
    im = im.resize((CELL_W, CELL_H), Image.BILINEAR)
    v = np.asarray(im, dtype=np.float64) / 255.0
    v = v - v.mean()
    n = np.sqrt((v*v).sum())
    return v / n if n > 1e-6 else v

def ocr_frame(path, dbg=None):
    im = Image.open(path).convert('L')
    w, h = im.size
    x0 = REG_X0; x1 = int(round(w * REG_X1R)); y0 = int(round(h * REG_Y0R)); y1 = int(round(h * REG_Y1R))
    g = np.asarray(im, dtype=np.float64)[y0:y1, x0:x1]
    blur = box_blur(g, BLUR_R)
    th = g - blur
    mask = (g >= G_TH) & (th >= TH_TH)
    colsum = mask.sum(axis=0)
    # 固定槽位切割：锚定码左边缘（首个强列），节距实测 33.2/13.2（VCNC 烧录模板固定）
    strong = [x for x in range(len(colsum)) if colsum[x] >= 10]
    if not strong: return None, 'no anchor'
    xl = strong[0]
    slots = []
    for k in range(8):
        g0 = xl + [0, 13, 33, 46, 66, 79, 99, 112][k]
        slots.append((g0, g0 + 12))
    if slots[-1][1] >= mask.shape[1]: return None, 'overflow'
    # 每槽须有足够墨水
    for a, b in slots:
        if mask[:, a:b].sum() < 40: return None, 'slot empty %s' % ((a, b),)
    # 行界
    rows = mask[:, slots[0][0]:slots[-1][1]].sum(axis=1)
    ys = np.where(rows >= 2)[0]
    if len(ys) == 0: return None, 'no rows'
    ry0, ry1 = ys.min(), ys.max()+1
    if not (MIN_H <= ry1-ry0 <= MAX_H): return None, 'h=%d' % (ry1-ry0)
    cells = []
    for a, b in slots:
        cells.append(norm_cell(th[ry0:ry1, a:b]))
    return cells, None

# ---- 构建模板（留出法：模板帧 vs 测试帧） ----
all_cells = {}
frames = {}
for t, truth in TRUTH.items():
    path = '_test/frame600.png' if t == 600 else ('_test/clean_%d.png' % t if t in (2410, 2870) else '_test/clean_%d.jpg' % t)
    cells, err = ocr_frame(path)
    if cells is None:
        print('t=%d FAIL: %s' % (t, err)); continue
    frames[t] = (cells, truth)

TPL_FRAMES = [30, 600, 1200, 2400, 4200]
TEST_FRAMES = [t for t in frames if t not in TPL_FRAMES]
templates = {}
for t in TPL_FRAMES:
    cells, truth = frames[t]
    for d, c in zip(truth, cells):
        templates.setdefault(d, []).append(c)
TPL = {d: np.mean(v, axis=0) for d, v in templates.items()}

def corr(a, b):
    d = np.sqrt((a*a).sum() * (b*b).sum())
    return float((a*b).sum() / d) if d > 1e-9 else 0.0

nok = ntot = 0
for t in TEST_FRAMES:
    cells, truth = frames[t]
    got = []
    for c in cells:
        sc = sorted(((corr(c, TPL[d]), d) for d in range(10)), reverse=True)
        got.append((sc[0][1], sc[0][0] - sc[1][0]))
    ok = [g[0] for g in got] == truth
    nok += ok; ntot += 1
    print('t=%-5d %s  got=%s margins=%s' % (t, 'OK ' if ok else 'BAD', [g[0] for g in got], [round(g[1], 3) for g in got]))
print('frame-level: %d/%d' % (nok, ntot))

# 全帧测试（含模板帧，检查自洽）
nok2 = ntot2 = 0
worst_margin = 1.0
for t in frames:
    cells, truth = frames[t]
    got = [max(range(10), key=lambda d: corr(c, TPL[d])) for c in cells]
    ok = got == truth
    nok2 += ok; ntot2 += 1
    if not ok: print('  self-test t=%d BAD got=%s want=%s' % (t, got, truth))
print('all-frames: %d/%d' % (nok2, ntot2))

# ---- 输出嵌入模板（全部样本均值，量化 0-255）----
final = {}
for d in range(10):
    pool = templates.get(d, [])
    if not pool: print('MISSING digit', d); continue
    v = np.mean(pool, axis=0)
    v = v - v.mean(); n = np.sqrt((v*v).sum())
    v = v / n if n > 1e-9 else v
    final[d] = [int(round(x * 127)) for x in (v.ravel() * 1.0)]
js = 'var CALIB_TPL={' + ','.join('"%d":[%s]' % (d, ','.join(str(x) for x in final[d])) for d in sorted(final)) + '};'
open('_test/calib_tpl.js', 'w').write(js)
print('template bytes:', len(js))
print('digits covered:', sorted(final.keys()))
