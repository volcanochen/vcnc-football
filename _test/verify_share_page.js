/* 免设备回归：微信 H5 中转页 share/index.html 的解码链路。
 *
 * 中转页把分享码的 crc8 / base64url 解码又实现了一遍（不能引用 App 内的 clips.js），
 * 两份实现一旦漂移，就会出现「App 里能导入、微信点开却说链接损坏」。
 * 这里把内联脚本放进最小 DOM stub 里执行，验证正常码、查询串兜底、篡改拒绝、
 * 缺码拒绝、中文备注可解。只在 Node 里跑，不进 APK，允许用 Node API。
 *
 * 用法：node _test/verify_share_page.js
 */
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'share', 'index.html'), 'utf8');
var m = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.log('FAIL 找不到 share/index.html 的内联脚本'); process.exit(1); }
var src = m[1];

var IDS = ['ok', 'bad', 'title', 'clips', 'code', 'hint', 'openApp', 'openBrowser',
           'copy', 'errMsg', 'wxSlot', '__body'];
function makeDom(hash, search) {
  var els = {};
  function el(id) {
    if (els[id]) return els[id];
    return els[id] = {
      id: id, style: {}, textContent: '', value: '', className: '', children: [],
      appendChild: function (c) { this.children.push(c); },
      setAttribute: function (k, v) { this[k] = v; },
      addEventListener: function (t, f) { (this.ev || (this.ev = {}))[t] = f; },
      select: function () {}, setSelectionRange: function () {}
    };
  }
  IDS.forEach(el);
  var doc = {
    hidden: false, title: '', body: el('__body'),
    getElementById: el,
    createElement: function () { return el('__new' + Math.random()); },
    addEventListener: function () {}, execCommand: function () { return true; }
  };
  return {
    els: els,
    sandbox: {
      document: doc,
      window: { addEventListener: function () {} },
      navigator: {},
      location: { hash: hash || '', search: search || '' },
      setTimeout: function () { return 0; },
      Date: Date, Math: Math, JSON: JSON, console: console,
      atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
      escape: global.escape, decodeURIComponent: decodeURIComponent,
      encodeURIComponent: encodeURIComponent, String: String, RegExp: RegExp
    }
  };
}

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// 与 static/clips.js 完全同构的编码侧（防止测试自己把错误算法也复刻进去）
function crc8(s) {
  var c = 0;
  for (var i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) & 255;
    for (var b = 0; b < 8; b++) c = (c & 128) ? ((c << 1) ^ 7) & 255 : (c << 1) & 255;
  }
  return ('0' + (c & 255).toString(16)).slice(-2);
}
function b64e(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function code(payload) {
  var b = b64e(JSON.stringify(payload));
  return 'VC1.' + b + '.' + crc8(b);
}

var good = code({
  v: 1, b: 'BV1p5xd6hEK2',
  c: [{ s: 242, d: 17, u: '阿飞', n: '进球' },
      { s: 750, d: 22, u: '阿飞', n: '过人' }],
  t: 1762950000
});

// 1. 正常 fragment 码
var ctx = makeDom('#d=' + good);
vm.runInNewContext(src, ctx.sandbox);
ok('fragment 正常码 → 不进错误态', ctx.els.bad.style.display !== 'block');
ok('fragment 正常码 → 标题含片段数', /2 段集锦/.test(ctx.els.title.textContent), ctx.els.title.textContent);
ok('fragment 正常码 → 导入码回填', ctx.els.code.value === good);
ok('fragment 正常码 → 渲染 2 条片段', ctx.els.clips.children.length === 2,
   String(ctx.els.clips.children.length));

// 2. 查询串兜底 ?d=
ctx = makeDom('', '?d=' + good);
vm.runInNewContext(src, ctx.sandbox);
ok('?d= 兜底路径', ctx.els.bad.style.display !== 'block' && ctx.els.code.value === good);

// 3. 篡改 crc 必须拒绝
var tampered = good.slice(0, -2) + (good.slice(-2) === 'ff' ? '00' : 'ff');
ctx = makeDom('#d=' + tampered);
vm.runInNewContext(src, ctx.sandbox);
ok('篡改 crc → 错误态', ctx.els.bad.style.display === 'block');

// 4. 缺码 / 乱码一律拒绝
var bads = ['', '#d=', '#d=hello', '#d=VC1.!!!.zz'];
for (var i = 0; i < bads.length; i++) {
  ctx = makeDom(bads[i]);
  vm.runInNewContext(src, ctx.sandbox);
  ok('无效码拒绝 ' + (bads[i] || '(空)'), ctx.els.bad.style.display === 'block');
}

// 5. 中文备注经 escape/decodeURIComponent 应能完整解回
ctx = makeDom('#d=' + good);
vm.runInNewContext(src, ctx.sandbox);
ok('中文备注可解', ctx.els.clips.children.length === 2);

console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
