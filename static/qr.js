/* =============================================================
   qr.js · 极简 QR Code 编码器（byte mode / ECC M / version 1~10）
   -------------------------------------------------------------
   为什么自研：APK 完全离线运行，WebView 不能依赖任何 CDN；B 站登录二维码
   的 URL 每次都不同，也不能预生成图片。这里只实现登录场景真正需要的子集：
     - 字节模式（UTF-8），纠错等级 M，版本 1~10（最长 213 字节）
     - 自动选择掩模；也允许强制掩模，便于与标准库做矩阵级交叉验证
   实测 B 站登录 URL 约 145 字节 → version 8 / ECC M，覆盖范围内。

   Chrome 74 兼容：只用 ES5 语法与 Canvas 2D，无新 API、无第三方依赖。
   算法遵循 ISO/IEC 18004（RS 纠错 / 块交织 / 功能图形 / 掩模评分）。
   ============================================================= */
(function (global) {
  'use strict';

  // ---------------------------------------------------------- GF(256)
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;       // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsDivisor(degree) {
    var res = new Uint8Array(degree);
    res[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return res;
  }

  function rsRemainder(data, divisor) {
    var res = new Uint8Array(divisor.length);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      for (var k = 0; k < res.length - 1; k++) res[k] = res[k + 1];
      res[res.length - 1] = 0;
      for (var j = 0; j < res.length; j++) res[j] ^= gfMul(divisor[j], factor);
    }
    var out = [];
    for (var n = 0; n < res.length; n++) out.push(res[n]);
    return out;
  }

  // ---------------------------------------------------------- 版本参数（ECC M, v1~10）
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS    = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var TOTAL_CW      = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  var MAX_VERSION = 10;

  function dataCodewords(v) {
    return TOTAL_CW[v] - ECC_PER_BLOCK[v] * NUM_BLOCKS[v];
  }

  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                   0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
        } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function BitBuf() { this.bits = []; }
  BitBuf.prototype.append = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function chooseVersion(nBytes) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      var header = 4 + (v <= 9 ? 8 : 16);
      if (header + nBytes * 8 <= dataCodewords(v) * 8) return v;
    }
    return -1;
  }

  /** 数据码字：模式/长度头 + 内容 + 终止符 + 补位 + 交替填充字节 */
  function makeData(bytes, version) {
    var bb = new BitBuf();
    bb.append(4, 4);                                      // 0100 = byte mode
    bb.append(bytes.length, version <= 9 ? 8 : 16);        // 字符数
    for (var i = 0; i < bytes.length; i++) bb.append(bytes[i], 8);
    var cap = dataCodewords(version) * 8;
    bb.append(0, Math.min(4, Math.max(0, cap - bb.bits.length)));
    bb.append(0, (8 - bb.bits.length % 8) % 8);
    var pad = [0xEC, 0x11], pi = 0;
    while (bb.bits.length < cap) bb.append(pad[pi++ % 2], 8);
    var out = [];
    for (var k = 0; k < bb.bits.length; k += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[k + j];
      out.push(b);
    }
    return out;
  }

  /** 分块 + RS 纠错 + 交织：先交织所有数据码字，再交织所有纠错码字 */
  function addEcc(data, version) {
    var nb = NUM_BLOCKS[version], eccLen = ECC_PER_BLOCK[version];
    var raw = TOTAL_CW[version];
    var shortTotal = Math.floor(raw / nb);
    var shortBlocks = nb - (raw % nb);
    var shortData = shortTotal - eccLen;
    var div = rsDivisor(eccLen);
    var blocks = [];
    var k = 0;
    for (var i = 0; i < nb; i++) {
      var datLen = shortData + (i >= shortBlocks ? 1 : 0);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      blocks.push({ d: dat, e: rsRemainder(dat, div) });
    }
    var out = [];
    var maxData = shortData + 1;
    for (var col = 0; col < maxData; col++)
      for (var bi = 0; bi < nb; bi++)
        if (col < blocks[bi].d.length) out.push(blocks[bi].d[col]);
    for (var ec = 0; ec < eccLen; ec++)
      for (var bj = 0; bj < nb; bj++) out.push(blocks[bj].e[ec]);
    return out;
  }

  // ---------------------------------------------------------- 矩阵与功能图形
  function Matrix(size) {
    this.size = size;
    this.m = [];
    this.fn = [];
    for (var y = 0; y < size; y++) {
      var row = [], frow = [];
      for (var x = 0; x < size; x++) { row.push(false); frow.push(false); }
      this.m.push(row); this.fn.push(frow);
    }
  }
  Matrix.prototype.setFn = function (x, y, dark) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.m[y][x] = !!dark;
    this.fn[y][x] = true;
  };

  function alignPositions(version) {
    if (version === 1) return [];
    var size = version * 4 + 17;
    var num = Math.floor(version / 7) + 2;
    var step = Math.floor((size - 13) / (num * 2 - 2)) * 2;
    var res = [6];
    var pos = size - 7;
    while (res.length < num) {
      res.splice(1, 0, pos);
      pos -= step;
    }
    return res;
  }

  function drawFinder(m, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        m.setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlign(m, cx, cy) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        m.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  function formatBits(mask) {
    var data = mask;                         // ECC M 的 formatBits = 00
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function drawFormat(m, mask) {
    var bits = formatBits(mask), size = m.size;
    function bit(i) { return ((bits >>> i) & 1) === 1; }
    for (var i = 0; i <= 5; i++) m.setFn(8, i, bit(i));
    m.setFn(8, 7, bit(6));
    m.setFn(8, 8, bit(7));
    m.setFn(7, 8, bit(8));
    for (var j = 9; j < 15; j++) m.setFn(14 - j, 8, bit(j));
    for (var a = 0; a < 8; a++) m.setFn(size - 1 - a, 8, bit(a));
    for (var b = 8; b < 15; b++) m.setFn(8, size - 15 + b, bit(b));
    m.setFn(8, size - 8, true);            // 固定黑点
  }

  function drawVersion(m, version) {
    if (version < 7) return;
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1F25);
    var bits = (version << 12) | rem;
    var size = m.size;
    for (var k = 0; k < 18; k++) {
      var on = ((bits >>> k) & 1) === 1;
      var a = size - 11 + (k % 3), b = Math.floor(k / 3);
      m.setFn(a, b, on);
      m.setFn(b, a, on);
    }
  }

  function drawFunctionPatterns(m, version) {
    var size = m.size, i;
    for (i = 0; i < size; i++) {
      m.setFn(6, i, i % 2 === 0);
      m.setFn(i, 6, i % 2 === 0);
    }
    drawFinder(m, 3, 3);
    drawFinder(m, size - 4, 3);
    drawFinder(m, 3, size - 4);
    var ap = alignPositions(version), n = ap.length;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
        drawAlign(m, ap[b], ap[a]);
      }
    }
    drawFormat(m, 0);           // 先用 mask 0 占位，选完掩模再重画
    drawVersion(m, version);
  }

  function drawCodewords(m, data) {
    var size = m.size, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!m.fn[y][x] && i < data.length * 8) {
            m.m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
    return false;
  }

  function applyMask(m, mask) {
    for (var y = 0; y < m.size; y++)
      for (var x = 0; x < m.size; x++)
        if (!m.fn[y][x] && maskBit(mask, x, y)) m.m[y][x] = !m.m[y][x];
  }

  /** 标准掩模评分：连续同色 / 2x2 同色 / 类似定位图形 / 深色比例 */
  function penalty(m) {
    var size = m.size, score = 0, x, y, i;
    function runScore(get) {
      var s = 0;
      for (var line = 0; line < size; line++) {
        var run = 1;
        for (var p = 1; p < size; p++) {
          if (get(line, p) === get(line, p - 1)) {
            run++;
            if (run === 5) s += 3;
            else if (run > 5) s += 1;
          } else run = 1;
        }
      }
      return s;
    }
    score += runScore(function (l, p) { return m.m[l][p]; });           // 行
    score += runScore(function (l, p) { return m.m[p][l]; });           // 列
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var v = m.m[y][x];
        if (v === m.m[y][x + 1] && v === m.m[y + 1][x] && v === m.m[y + 1][x + 1]) score += 3;
      }
    }
    var PAT = [true, false, true, true, true, false, true, false, false, false, false];
    var PAT2 = [false, false, false, false, true, false, true, true, true, false, true];
    function hasPat(get, len, pat) {
      for (var s = 0; s + 11 <= len; s++) {
        var ok = true;
        for (var k = 0; k < 11; k++) if (get(s + k) !== pat[k]) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    }
    for (y = 0; y < size; y++) {
      (function (yy) {
        if (hasPat(function (p) { return m.m[yy][p]; }, size, PAT)) score += 40;
        if (hasPat(function (p) { return m.m[yy][p]; }, size, PAT2)) score += 40;
        if (hasPat(function (p) { return m.m[p][yy]; }, size, PAT)) score += 40;
        if (hasPat(function (p) { return m.m[p][yy]; }, size, PAT2)) score += 40;
      })(y);
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m.m[y][x]) dark++;
    var total = size * size;
    var k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
    score += k * 10;
    return score;
  }

  // ---------------------------------------------------------- 对外接口
  function encode(text, opts) {
    opts = opts || {};
    var bytes = utf8Bytes(String(text == null ? '' : text));
    var version = chooseVersion(bytes.length);
    if (version < 0) throw new Error('QR 内容过长（最多 213 字节）');
    var data = addEcc(makeData(bytes, version), version);
    var size = version * 4 + 17;

    var base = new Matrix(size);
    drawFunctionPatterns(base, version);
    drawCodewords(base, data);

    var best = null, bestScore = Infinity, bestMask = 0;
    var forced = (typeof opts.mask === 'number' && opts.mask >= 0 && opts.mask <= 7) ? opts.mask : -1;
    for (var mk = 0; mk < 8; mk++) {
      if (forced >= 0 && mk !== forced) continue;
      var m = new Matrix(size);
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) { m.m[y][x] = base.m[y][x]; m.fn[y][x] = base.fn[y][x]; }
      }
      applyMask(m, mk);
      drawFormat(m, mk);
      var s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; bestMask = mk; }
    }
    return { size: size, version: version, mask: bestMask, modules: best.m };
  }

  function draw(canvas, text, opts) {
    opts = opts || {};
    var q = encode(text, opts);
    var border = typeof opts.border === 'number' ? opts.border : 4;
    var scale = Math.max(1, opts.scale || 4);
    var dim = (q.size + border * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    var c = canvas.getContext('2d');
    c.fillStyle = opts.light || '#ffffff';
    c.fillRect(0, 0, dim, dim);
    c.fillStyle = opts.dark || '#101820';
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size; x++) {
        if (q.modules[y][x]) c.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
    return q;
  }

  global.QRGen = { encode: encode, draw: draw };
})(typeof window !== 'undefined' ? window : this);
