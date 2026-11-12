/* 自定义集锦编解码免设备回归：Node 里用最小 DOM 桩加载 static/clips.js。
   用法：node _test/verify_clips_codec.js
   覆盖：分享码往返/篡改、评论文本往返/分片、按 mid 分组、本地增删去重、混排来源。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'static/clips.js'), 'utf8');

const store = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
const win = {
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  console,
  setTimeout, clearTimeout, Promise, fetch: () => Promise.reject(new Error('no net')),
  toast: () => {},
  history: null,
  location: { search: '', pathname: '/feed.html', hash: '' },
  VCNC: { getState: () => ({ bvid: 'BV1p5xd6hEK2', aid: '123456' }) },
  VCNCSocial: { getMe: () => ({ loggedIn: false, mid: 0, name: '' }) }
};
const doc = {
  readyState: 'loading',
  addEventListener: () => {},
  querySelector: () => null,
  createElement: () => ({ className: '', style: {}, appendChild() {}, addEventListener() {},
                          setAttribute() {}, querySelectorAll: () => [] }),
  body: { appendChild() {} },
  activeElement: null
};
const ctx = vm.createContext({
  window: win, document: doc, localStorage, location: win.location,
  console, setTimeout, clearTimeout, Promise, fetch: win.fetch,
  encodeURIComponent, decodeURIComponent, escape, unescape,
  Math, Date, JSON, isFinite, parseFloat, parseInt, RegExp, String, Number, Object, Array, Error
});
vm.runInContext(src, ctx, { filename: 'clips.js' });
const C = win.VCNCClips;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}

const BV = 'BV1p5xd6hEK2';
const clips = [
  { s: 242, d: 17, u: '阿飞', n: '进球' },
  { s: 750, d: 22, u: '阿飞', n: '过人' }
];

// 1) 分享码：中文 UTF-8 往返
const code = C.encodeShare(BV, clips);
const dec = C.decodeShare(code);
ok('分享码格式 VC1.b64.crc8', /^VC1\.[A-Za-z0-9\-_]+\.[0-9a-f]{2}$/.test(code), code);
ok('分享码往返片段数', dec && dec.clips.length === 2, dec);
ok('分享码往返中文备注/用户名', dec && dec.clips[0].n === '进球' && dec.clips[0].u === '阿飞', dec);
ok('分享码含视频号', dec && dec.bvid === BV, dec);
ok('篡改分享码被拒', C.decodeShare(code.slice(0, -3) + 'fff') === null);
ok('半截分享码被拒', C.decodeShare(code.slice(0, 20)) === null);
ok('能从分享文本里挑出码', C.decodeShare('前缀文字\n' + code + '\n后缀') !== null);

// 2) 评论文本：形状、往返、分片
const msgs = C.packComment(BV, '阿飞', clips);
ok('生成 1 条评论', msgs.length === 1, msgs.length);
ok('评论头带固定标记', msgs[0].indexOf('【VCNC集锦v1】' + BV) === 0, msgs[0].slice(0, 40));
ok('评论行含时间戳+时长+用户名+备注',
   /0?:?4:02 17s @阿飞 进球/.test(msgs[0]) || /4:02 17s @阿飞 进球/.test(msgs[0]), msgs[0]);
const pc = C.parseComment(msgs[0], BV);
ok('评论解析出 2 段', pc && pc.clips.length === 2, pc);
ok('评论解析时间正确', pc && pc.clips[0].s === 242 && pc.clips[0].d === 17, pc);
ok('非本场评论不认', C.parseComment(msgs[0], 'BV0000000000') === null);
ok('普通评论不认', C.parseComment('0:04:02 17s @阿飞 进球', BV) === null);
const many = [];
for (let i = 0; i < 90; i++) many.push({ s: i * 30, d: 20, u: '阿飞', n: '片段' + i });
const parts = C.packComment(BV, '阿飞', many);
ok('超长列表自动分片且 <=3', parts.length > 1 && parts.length <= 3, parts.length);
ok('每片不超 1000 字', parts.every(p => p.length <= 1000), parts.map(p => p.length));
let packed = 0;
parts.forEach(p => { const x = C.parseComment(p, BV); if (x) packed += x.clips.length; });
ok('分片后片段无丢失', packed === 90 && C.packedDropped() === 0, { packed, dropped: C.packedDropped() });
ok('分片头带片序', parts.every(p => /【VCNC集锦v1 \d+\/\d+】/.test(p)));

// 3) 按作者分组 + 分片拼接
const replies = parts.map((p, i) => ({ rpid: 100 + i, mid: '4321', user: '阿飞', text: p }));
replies.push({ rpid: 200, mid: '9999', user: '别人', text: C.packComment(BV, '别人', [clips[0]])[0] });
replies.push({ rpid: 300, mid: '8888', user: '路人', text: '完全无关的普通评论' });
const groups = C.parseGroups(replies, BV);
ok('按 mid 分出 2 组', groups.length === 2, groups.length);
const own = groups.filter(g => g.mid === '4321')[0];
ok('分片被拼接成完整列表', own && own.clips.length === packed, own && own.clips.length);
ok('分片 rpid 全部保留', own && own.rpids.length === parts.length, own && own.rpids);

// 4) 本地存储：每视频一个列表、去重、删除
C.addLocal(BV, clips[0]);
C.addLocal(BV, clips[1]);
C.addLocal(BV, clips[0]);                     // 重复
C.addLocal('BVAAAAAAAAAA', { s: 5, d: 9, u: '本机', n: '别的场' });
ok('本场 2 段（重复被挡）', C.localList(BV).length === 2, C.localList(BV).length);
ok('另一个视频独立 1 段', C.localList('BVAAAAAAAAAA').length === 1);
const id = C.localList(BV)[0].id;
C.delLocal(BV, id);
ok('删除生效且其它视频不受影响',
   C.localList(BV).length === 1 && C.localList('BVAAAAAAAAAA').length === 1);

// 5) 混排来源标记
C.addLocal(BV, clips[0]);
const merged = C.forVideo(BV);
ok('混排返回伪 matched 项', merged.length >= 2, merged.length);
ok('本地项带 src=mine 与显式 dur', merged.some(x => x.src === 'mine' && x.dur === 17), merged);
ok('时间列用 m:ss 且不带 end', merged.every(x => /^\d+:\d{2}(:\d{2})?$/.test(x.time) && x.end === ''));

// 6) 行内编辑 updateLocal：改时间/时长/备注，id 不变、按起点重排
const l0 = C.localList(BV);
const eid = l0[l0.length - 1].id;
ok('updateLocal 改起点/时长/备注',
   C.updateLocal(BV, eid, { s: 500, d: 9, n: '改过的进球' }) &&
   (() => { const e = C.localList(BV).find(x => x.id === eid);
            return e && e.s === 500 && e.d === 9 && e.n === '改过的进球'; })());
ok('updateLocal 非法值被拒（时长 0）', C.updateLocal(BV, eid, { d: 0 }) === false);
ok('updateLocal 不存在的 id 返回 false', C.updateLocal(BV, 'nope', { s: 1 }) === false);
// 改回去，别影响后面用例
C.updateLocal(BV, eid, { s: clips[1].s, d: clips[1].d, n: clips[1].n });

// 7) 发布记录（增量发布依据）：markPublished / pubSet
ok('初始 pubSet 为空', Object.keys(C.pubSet(BV)).length === 0);
C.markPublished(BV, [{ s: 242 }, { s: 750 }]);
ok('markPublished 记录起点', C.pubSet(BV)['242'] === 1 && C.pubSet(BV)['750'] === 1,
   C.pubSet(BV));
ok('pubSet 按秒取整匹配（浮点也能命中）', C.pubSet(BV)['242'] === 1);
C.markPublished(BV, [{ s: 242 }]);               // 重复发布不重复记录
ok('重复 markPublished 不重复记录',
   Object.keys(C.pubSet(BV)).length === 2 && C.pubSet(BV)['242'] === 1);
const otherSet = C.pubSet('BVAAAAAAAAAA');
ok('发布记录按视频隔离', Object.keys(otherSet).length === 0);
C.markPublished('BVAAAAAAAAAA', [{ s: 5 }]);
ok('其它视频记录独立生效', C.pubSet('BVAAAAAAAAAA')['5'] === 1);

console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
