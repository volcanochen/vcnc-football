/* =========================================================================
   VCNC足球 · 自定义集锦（独立模块，与 feed.js 只通过 window.VCNC 契约交互）

   - 未登录：每个 bvid 一个本地列表，常驻 localStorage
   - 登录：可把整份列表写进该视频的 B 站评论区，并在每次登录时自动读回
   - 他人集锦：从评论区按作者分组，点「载入」才合并进播放列表
   - 分享：VC1.<base64url(JSON)>.<crc8> 纯文本码，微信里复制粘贴即可

   数据格式与微信跳转链路见 docs/CUSTOM_CLIPS.md。
   Chrome 74 红线：不用 ?? / ?. / replaceAll / :is() / flex gap / inset / let / 箭头函数。
   ========================================================================= */
(function (global) {
  'use strict';

  var KEY = 'vcnc.clips.v1';        // { bvid: { nick, list:[clip] } }
  var NICK_KEY = 'vcnc.clips.nick.v1';
  var LOADED_KEY = 'vcnc.clips.loaded.v1';  // { bvid: [groupKey, ...] }
  var PRESETS = ['进球', '射门', '过人', '扑救', '配合', '抢断', '争议', '精彩'];
  var MARK = '【VCNC集锦v1';
  var SHARE_HOST = 'https://volcanochen.github.io/vcnc-football/share/';
  var MAX_COMMENT = 900, MAX_PARTS = 3;

  function $(s, r) { return (r || document).querySelector(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function jget(k, def) { try { var o = JSON.parse(lsGet(k) || 'null'); return o || def; } catch (e) { return def; } }
  function jset(k, o) { lsSet(k, JSON.stringify(o)); }
  function tip(msg) { if (global.toast) global.toast(msg); else if (global.console) console.log(msg); }

  // ---------------------------------------------------------------- 时间 / 编码
  function s2t(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    return h > 0 ? (h + ':' + p2(m) + ':' + p2(s)) : (m + ':' + p2(s));
  }
  function t2s(tok) {
    var p = String(tok || '').trim().split(':');
    if (p.length === 3) return (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]);
    if (p.length === 2) return (+p[0]) * 60 + (+p[1]);
    return parseFloat(p[0]);
  }
  function b64e(str) {
    var s = global.btoa(unescape(encodeURIComponent(str)));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64d(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(global.atob(s)));
  }
  function crc8(str) {
    var c = 0;
    for (var i = 0; i < str.length; i++) {
      c ^= str.charCodeAt(i) & 255;
      for (var b = 0; b < 8; b++) c = (c & 128) ? ((c << 1) ^ 7) & 255 : (c << 1) & 255;
    }
    return ('0' + (c & 255).toString(16)).slice(-2);
  }
  function uid() {
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  function clipKey(c) {
    return [Math.round(c.s), Math.round(c.d), c.u || '', c.n || ''].join('|');
  }
  function cleanClip(o) {
    if (!o) return null;
    var s = Number(o.s), d = Number(o.d);
    if (!isFinite(s) || s < 0 || !isFinite(d) || d <= 0 || d > 3600) return null;
    return {
      id: o.id || uid(),
      s: Math.round(s), d: Math.round(d),
      // 评论数据行用 @用户名 后的空白分词，名字里不能有空白
      u: String(o.u || '').replace(/\s+/g, '').slice(0, 16) || '本机',
      n: String(o.n || '').replace(/[\r\n|]/g, ' ').slice(0, 24),
      t: Number(o.t) || Math.floor(Date.now() / 1000)
    };
  }

  // ---------------------------------------------------------------- 分享码
  function encodeShare(bvid, clips) {
    var arr = [];
    for (var i = 0; i < clips.length; i++) {
      var c = cleanClip(clips[i]);
      if (c) arr.push({ s: c.s, d: c.d, u: c.u, n: c.n });
    }
    if (!arr.length) return '';
    var payload = JSON.stringify({ v: 1, b: bvid, c: arr, t: Math.floor(Date.now() / 1000) });
    var body = b64e(payload);
    return 'VC1.' + body + '.' + crc8(body);
  }
  function extractCode(raw) {
    var m = /VC1\.[A-Za-z0-9\-_]+\.[0-9a-fA-F]{2}/.exec(String(raw || ''));
    return m ? m[0] : '';
  }
  function decodeShare(code) {
    var whole = extractCode(code);
    var m = /^VC1\.([A-Za-z0-9\-_]+)\.([0-9a-fA-F]{2})$/.exec(whole);
    if (!m || crc8(m[1]) !== m[2].toLowerCase()) return null;
    try {
      var j = JSON.parse(b64d(m[1]));
      if (!j || j.v !== 1 || !/^BV[0-9A-Za-z]{10}$/.test(j.b || '')) return null;
      var out = [];
      for (var i = 0; i < (j.c || []).length && i < 60; i++) {
        var c = cleanClip(j.c[i]);
        if (c) out.push(c);
      }
      return out.length ? { bvid: j.b, clips: out } : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- 评论文本
  var lastDropped = 0;   // packComment 因 3 片上限没发出去的片段数
  function headLine(bvid, nick, part, total) {
    return MARK + (total > 1 ? ' ' + part + '/' + total : '') + '】' + bvid + ' @' + nick;
  }
  function packComment(bvid, nick, clips) {
    var lines = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      lines.push(s2t(c.s) + ' ' + c.d + 's @' + (c.u || nick) + ' ' + (c.n || ''));
    }
    // 先按字符数贪心分片（头行长度按最坏情况预留），再回填片序
    var chunks = [], cur = [], len = 0, used = 0;
    for (var k = 0; k < lines.length; k++) {
      var need = lines[k].length + 1;
      if (cur.length && len + need > MAX_COMMENT - 64) {
        chunks.push(cur); used += cur.length;
        cur = []; len = 0;
        if (chunks.length >= MAX_PARTS) break;   // 3 片都满了，剩下的只能留在本地
      }
      cur.push(lines[k]); len += need;
    }
    if (cur.length && chunks.length < MAX_PARTS) { chunks.push(cur); used += cur.length; }
    lastDropped = Math.max(0, lines.length - used);
    var out = [], total = chunks.length;
    for (var q = 0; q < total; q++) {
      var body = headLine(bvid, nick, q + 1, total) + '\n' + chunks[q].join('\n');
      if (body.length > 1000) body = body.slice(0, 1000);
      out.push(body);
    }
    return out;
  }
  function parseComment(text, bvid) {
    var lines = String(text || '').split(/\r?\n/);
    if (!lines.length) return null;
    var h = /^【VCNC集锦v1(?:\s+(\d+)\/(\d+))?】\s*(BV[0-9A-Za-z]{10})\s+@(.+)$/.exec(lines[0].trim());
    if (!h || (bvid && h[3] !== bvid)) return null;
    var clips = [];
    for (var i = 1; i < lines.length; i++) {
      var m = /^(\d+:\d{1,2}(?::\d{1,2})?)\s+(\d+(?:\.\d+)?)s\s+@(\S+)\s*(.*)$/.exec(lines[i].trim());
      if (!m) continue;
      var c = cleanClip({ s: t2s(m[1]), d: Math.round(+m[2]), u: m[3], n: m[4] || '' });
      if (c) clips.push(c);
    }
    return { part: +(h[1] || 1), total: +(h[2] || 1), bvid: h[3], nick: h[4] || '', clips: clips };
  }

  // ---------------------------------------------------------------- 本地存储
  function allLocal() { return jget(KEY, {}); }
  function localList(bvid) {
    if (!bvid) return [];
    var a = allLocal();
    return (a[bvid] && a[bvid].list) || [];
  }
  function saveLocal(bvid, list, nick) {
    var a = allLocal();
    a[bvid] = { nick: nick || (a[bvid] && a[bvid].nick) || getNick(), list: list };
    jset(KEY, a);
  }
  function addLocal(bvid, clip) {
    var c = cleanClip(clip);
    if (!bvid || !c) return false;
    var list = localList(bvid), keys = {};
    for (var i = 0; i < list.length; i++) keys[clipKey(list[i])] = 1;
    if (keys[clipKey(c)]) return false;               // 去重复导入
    list.push(c);
    list.sort(function (x, y) { return x.s - y.s; });
    saveLocal(bvid, list);
    return true;
  }
  function delLocal(bvid, id) {
    var list = localList(bvid), out = [];
    for (var i = 0; i < list.length; i++) if (list[i].id !== id) out.push(list[i]);
    saveLocal(bvid, out);
  }
  function getNick() {
    var n = lsGet(NICK_KEY);
    if (n) return n;
    var me = getMe();
    return (me && me.loggedIn && me.name) ? me.name : '本机';
  }
  function setNick(n) {
    n = String(n || '').trim().slice(0, 16) || '本机';
    lsSet(NICK_KEY, n);
    return n;
  }
  function loadedMap() { return jget(LOADED_KEY, {}); }
  function setLoaded(bvid, key, on) {
    var m = loadedMap(), a = m[bvid] || [], out = [];
    for (var i = 0; i < a.length; i++) if (a[i] !== key) out.push(a[i]);
    if (on) out.push(key);
    m[bvid] = out; jset(LOADED_KEY, m);
  }
  function isLoaded(bvid, key) {
    var a = loadedMap()[bvid] || [];
    for (var i = 0; i < a.length; i++) if (a[i] === key) return true;
    return false;
  }

  // ---------------------------------------------------------------- 契约 / 状态
  function state() {
    try { return (global.VCNC && global.VCNC.getState && global.VCNC.getState()) || {}; }
    catch (e) { return {}; }
  }
  function getMe() {
    try { return (global.VCNCSocial && global.VCNCSocial.getMe && global.VCNCSocial.getMe()) || {}; }
    catch (e) { return {}; }
  }
  function callVCNC(name, arg) {
    try { return global.VCNC && global.VCNC[name] ? global.VCNC[name](arg) : null; }
    catch (e) { return null; }
  }
  function bridge() { return global.BiliBridge || null; }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET' };
    if (opts.body) {
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = opts.body;
    }
    return fetch(path, init).then(function (r) { return r.json(); });
  }
  function form(o) {
    var a = [];
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k))
      a.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k] == null ? '' : o[k]));
    return a.join('&');
  }

  // 云端状态：登录后自动读取；group = { key, mid, user, bvid, rpids, clips }
  // nextAt：B 站评论接口被风控（-412）时退避，避免 2s 轮询把 IP 打进更长的黑名单
  var cloud = { bvid: '', groups: [], mine: null, others: [], busy: false,
                lastKey: '', nextAt: 0, status: '' };
  var lastLogin = null, draft = { start: null, end: null }, studio = null;

  // ---------------------------------------------------------------- 合并进播放序列
  function forVideo(bvid) {
    if (!bvid) return [];
    var out = [], seen = {}, i, c;
    function push(c, src) {
      var k = clipKey(c);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({
        time: s2t(c.s), dur: c.d, text: c.n, src: src,
        user: c.u, cid: c.id, end: ''
      });
    }
    var mine = localList(bvid);
    for (i = 0; i < mine.length; i++) push(mine[i], 'mine');
    if (cloud.bvid === bvid && cloud.mine) {
      var cc = cloud.mine.clips;
      for (i = 0; i < cc.length; i++) push(cc[i], 'cloud');
    }
    if (cloud.bvid === bvid) {
      for (var g = 0; g < cloud.others.length; g++) {
        var gr = cloud.others[g];
        if (!isLoaded(bvid, gr.key)) continue;
        for (i = 0; i < gr.clips.length; i++) push(gr.clips[i], 'other');
      }
    }
    return out;
  }

  function rebuild() { callVCNC('rebuildClips'); renderStudio(); }

  // ---------------------------------------------------------------- 云端读取
  function parseGroups(replies, bvid) {
    var map = {}, order = [];
    for (var i = 0; i < (replies || []).length; i++) {
      var r = replies[i] || {}, p = parseComment(r.text, bvid);
      if (!p || !p.clips.length) continue;
      var key = String(r.mid || r.user || '?') + '|' + p.bvid;
      var g = map[key];
      if (!g) {
        g = { key: key, mid: String(r.mid || ''), user: r.user || p.nick,
              bvid: p.bvid, parts: [], rpids: [], clips: [] };
        map[key] = g; order.push(key);
      }
      g.parts.push({ n: p.part, clips: p.clips });
      g.rpids.push(r.rpid);
    }
    var out = [];
    for (var k = 0; k < order.length; k++) {
      var g2 = map[order[k]];
      g2.parts.sort(function (a, b) { return a.n - b.n; });
      var seen = {}, list = [];
      for (var q = 0; q < g2.parts.length; q++) {
        var cs = g2.parts[q].clips;
        for (var z = 0; z < cs.length; z++) {
          var kk = clipKey(cs[z]);
          if (!seen[kk]) { seen[kk] = 1; list.push(cs[z]); }
        }
      }
      list.sort(function (a, b) { return a.s - b.s; });
      g2.clips = list;
      delete g2.parts;
      out.push(g2);
    }
    return out;
  }
  function fetchReplies(aid, pages) {
    return api('/api/replies?aid=' + encodeURIComponent(aid) +
               '&pages=' + (pages || 3) + '&ps=20');
  }
  function loadCloud(bvid, aid, silent) {
    var me = getMe();
    if (!bvid || !aid || cloud.busy) return;
    if (Date.now() < cloud.nextAt) { renderStudio(); return; }
    var ck = bvid + '|' + aid + '|' + (me.mid || 0);
    if (cloud.lastKey === ck && cloud.groups.length) { renderStudio(); return; }
    cloud.busy = true;
    cloud.status = '正在读取评论区…'; renderStudio();
    fetchReplies(aid).then(function (j) {
      cloud.busy = false;
      if (!j || !j.ok) {
        cloud.status = (j && j.error) || '评论区读取失败';
        cloud.nextAt = Date.now() + 30000; renderStudio(); return;
      }
      if (!j.count) {
        // 0 条可能是评论区真空，也可能是 -412 风控：退避后自动再试，不打扰用户
        cloud.status = '评论区暂时读不到（可能触发 B 站限流），稍后自动重试';
        cloud.nextAt = Date.now() + 30000;
        renderStudio(); return;
      }
      var gs = parseGroups(j.replies, bvid);
      var had = !!(cloud.mine && cloud.mine.clips.length);
      cloud.bvid = bvid; cloud.groups = gs; cloud.mine = null; cloud.others = [];
      for (var i = 0; i < gs.length; i++) {
        var own = me.loggedIn && me.mid && String(me.mid) === gs[i].mid;
        if (own && !cloud.mine) cloud.mine = gs[i];
        else cloud.others.push(gs[i]);
      }
      cloud.lastKey = ck;
      cloud.nextAt = 0;
      cloud.status = '评论区共 ' + (j.count || 0) + ' 条，找到 ' + gs.length + ' 份集锦';
      if (!silent) tip('云端读取完成：' + gs.length + ' 份集锦');
      if (had && (!cloud.mine || !cloud.mine.clips.length))
        tip('云端那份集锦已不在（可能在 B 站被删除），本地列表仍保留');
      rebuild();
    }).catch(function (e) {
      cloud.busy = false; cloud.status = '评论区读取失败：' + e;
      cloud.nextAt = Date.now() + 30000;
      renderStudio();
    });
  }

  // ---------------------------------------------------------------- 云端发布 / 删除
  function publish() {
    var st = state(), bvid = st.bvid, aid = st.aid, me = getMe();
    if (!me.loggedIn) {
      tip('发布到评论区需要先登录 B 站账号');
      try { if (global.VCNCSocial) global.VCNCSocial.openLogin(); } catch (e) {}
      return;
    }
    var list = localList(bvid);
    if (!list.length) { tip('本场还没有自定义片段'); return; }
    var msgs = packComment(bvid, getNick(), list);
    if (!msgs.length) { tip('没有可发布的片段'); return; }
    if (lastDropped) tip('片段太多，评论区最多放 ' + (list.length - lastDropped) + ' 段，其余仍留在本机');
    cloud.busy = true; cloud.status = '正在整理旧评论…'; renderStudio();
    // 先删自己发的旧分片，保证「更新＝替换」，评论区不堆垃圾
    fetchReplies(aid).then(function (j) {
      var old = [], mineMid = String(me.mid || '');
      var reps = (j && j.replies) || [];
      for (var i = 0; i < reps.length; i++) {
        if (String(reps[i].mid || '') !== mineMid) continue;
        if (String(reps[i].text || '').indexOf(MARK) !== 0) continue;
        var p = parseComment(reps[i].text, bvid);
        if (p) old.push(reps[i].rpid);
      }
      var chain = Promise.resolve();
      old.forEach(function (rpid) {
        chain = chain.then(function () {
          return api('/api/clips/delete', { method: 'POST',
            body: form({ oid: aid, bvid: bvid, rpid: rpid }) });
        });
      });
      return chain.then(function () { return old.length; });
    }).then(function (deleted) {
      cloud.status = '已清理旧评论 ' + deleted + ' 条，开始发布…'; renderStudio();
      var chain2 = Promise.resolve(null), n = 0;
      msgs.forEach(function (msg, idx) {
        chain2 = chain2.then(function () {
          return new Promise(function (res) { setTimeout(res, idx ? 1300 : 0); });
        }).then(function () {
          return api('/api/clips/publish', { method: 'POST',
            body: form({ oid: aid, bvid: bvid, message: msg }) });
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || '发布失败');
          n++;
          cloud.status = '已发布 ' + n + '/' + msgs.length; renderStudio();
        });
      });
      return chain2.then(function () { return n; });
    }).then(function (n) {
      cloud.busy = false; cloud.lastKey = '';
      cloud.status = '发布完成：' + n + ' 条评论';
      tip('已把 ' + list.length + ' 个片段发布到评论区');
      renderStudio();
      loadCloud(bvid, aid, true);
    }).catch(function (e) {
      cloud.busy = false;
      cloud.status = '发布失败：' + (e && e.message ? e.message : e);
      tip(cloud.status); renderStudio();
    });
  }

  // ---------------------------------------------------------------- 分享 / 导入
  function shareTextFor(bvid, clips) {
    var code = encodeShare(bvid, clips);
    if (!code) return '';
    var c = clips[0];
    var head = clips.length > 1
      ? ('【VCNC足球 · 自定义集锦】' + clips.length + ' 个片段 · ' + bvid)
      : ('【VCNC足球 · 自定义集锦】「' + (c.n || '片段') + '」' + s2t(c.s) + ' +' + c.d + 's · ' + bvid + ' · @' + c.u);
    // 整场列表的码可能上 KB，微信文本能发但链接会被截断/拦，退化成纯导入码
    var link = code.length <= 900 ? ('\n查看：' + SHARE_HOST + '#d=' + code) : '';
    return head + link +
      '\n—— 微信里若打不开 App，复制下面这串，打开 VCNC足球点「导入集锦」——\n' + code;
  }
  function shareClips(bvid, clips) {
    var txt = shareTextFor(bvid, clips);
    if (!txt) return;
    var b = bridge();
    if (b && b.shareText) { try { b.shareText(txt); return; } catch (e) {} }
    if (b && b.copyText) {
      try { b.copyText(txt); tip('分享内容已复制，去微信粘贴即可'); return; } catch (e) {}
    }
    var ta = $('#clipImportInput');
    if (ta) { ta.value = txt; tip('当前环境没有分享面板，内容已放进输入框'); }
  }
  function doImport(raw, fromLink) {
    var o = decodeShare(raw);
    if (!o) { tip('导入码无效或已损坏'); return false; }
    var st = state();
    if (st.bvid && st.bvid !== o.bvid) {
      // 换场导入：把码带到新页面，由初始化流程落盘，避免重复写入
      try {
        location.href = 'feed.html?bv=' + encodeURIComponent(o.bvid) +
                        '&imp=' + encodeURIComponent(extractCode(raw));
      } catch (e) { tip('跳转失败'); }
      return true;
    }
    var n = 0;
    for (var i = 0; i < o.clips.length; i++) if (addLocal(o.bvid, o.clips[i])) n++;
    tip(n ? ('已导入 ' + n + ' 个片段' + (fromLink ? '（来自分享链接）' : '')) : '这些片段已经在本场列表里了');
    rebuild();
    return true;
  }
  function autoImport() {
    var m = /(?:^|[?&])imp=([^&]+)/.exec(location.search);
    if (!m) return;
    var code = decodeURIComponent(m[1] || '');
    try { doImport(code, true); } catch (e) {}
    try {
      if (global.history && history.replaceState) {
        var q = location.search.replace(/(^|[?&])imp=[^&]*&?/, '$1').replace(/[?&]$/, '');
        history.replaceState(null, '', location.pathname + q + location.hash);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 制作流程
  function nowTime() {
    var t = callVCNC('getTime');
    return (t && isFinite(t.orig)) ? t.orig : null;
  }
  function setStart() {
    var t = nowTime();
    if (t == null) { tip('视频还没准备好'); return; }
    callVCNC('pause');
    draft.start = Math.round(t);
    draft.end = null;
    tip('起点已记下 ' + s2t(draft.start) + '，播放到结束处再点「设终点」');
    renderStudio();
  }
  function setEnd() {
    var t = nowTime();
    if (t == null) { tip('视频还没准备好'); return; }
    if (draft.start == null) { tip('请先设起点'); return; }
    callVCNC('pause');
    var e = Math.round(t);
    if (e <= draft.start) { tip('终点要晚于起点'); return; }
    draft.end = e;
    tip('终点 ' + s2t(e) + '，写个备注就能保存');
    renderStudio();
  }
  function saveClip() {
    if (draft.start == null || draft.end == null) { tip('先设起点和终点'); return; }
    var bvid = state().bvid;
    if (!bvid) { tip('视频还没准备好'); return; }
    var note = ($('#clipNote') && $('#clipNote').value || '').trim().slice(0, 24) || '片段';
    var nick = setNick($('#clipNick') && $('#clipNick').value || '');
    var c = cleanClip({ s: draft.start, d: draft.end - draft.start, u: nick, n: note });
    if (!c) { tip('片段时间无效'); return; }
    if (!addLocal(bvid, c)) { tip('这个片段已经存在了'); return; }
    draft.start = null; draft.end = null;
    var ni = $('#clipNote'); if (ni) ni.value = '';
    tip('已保存 ' + s2t(c.s) + ' +' + c.d + 's「' + c.n + '」');
    rebuild();
  }

  // ---------------------------------------------------------------- 工作室面板
  function buildStudio() {
    if ($('#clipsStudio')) return $('#clipsStudio');
    var box = el('div', 'clip-studio');
    box.id = 'clipsStudio';
    box.hidden = true;
    box.innerHTML =
      '<div class="cs-head"><span>自定义集锦</span><button type="button" class="cs-x" id="csClose">✕</button></div>' +
      '<div class="cs-body">' +
      '  <div class="cs-sec"><div class="cs-h">① 制作片段</div>' +
      '    <div class="cs-state" id="csState">暂停 → 设起点 → 播放 → 暂停 → 设终点 → 写备注</div>' +
      '    <div class="cs-row"><button type="button" class="cs-btn" id="csStart">设起点</button>' +
      '      <button type="button" class="cs-btn" id="csEnd">设终点</button>' +
      '      <button type="button" class="cs-btn ghost" id="csClear">清除</button></div>' +
      '    <div class="cs-chips" id="csChips"></div>' +
      '    <input class="cs-in" id="clipNote" type="text" maxlength="24" placeholder="备注（也可点上面的预设）">' +
      '    <div class="cs-row"><input class="cs-in" id="clipNick" type="text" maxlength="16" placeholder="你的昵称">' +
      '      <button type="button" class="cs-btn primary" id="csSave">保存片段</button></div>' +
      '  </div>' +
      '  <div class="cs-sec"><div class="cs-h">② 本场列表 <span class="cs-sub" id="csCount"></span></div>' +
      '    <div class="cs-list" id="csList"></div></div>' +
      '  <div class="cs-sec"><div class="cs-h">③ 云端 / 他人集锦</div>' +
      '    <div class="cs-cloudstatus" id="csCloudStatus">未登录时只能保存在本机</div>' +
      '    <div class="cs-row"><button type="button" class="cs-btn" id="csPublish">发布到评论区</button>' +
      '      <button type="button" class="cs-btn" id="csReload">重新读取</button></div>' +
      '    <div class="cs-list" id="csOthers"></div>' +
      '    <div class="cs-note">发布＝替换你之前发的那份集锦评论；B 站删掉评论后，云端这份会消失，本机列表仍保留。</div>' +
      '  </div>' +
      '  <div class="cs-sec"><div class="cs-h">④ 分享 / 导入</div>' +
      '    <div class="cs-row"><button type="button" class="cs-btn" id="csShareAll">分享整场</button>' +
      '      <button type="button" class="cs-btn" id="csPaste">从剪贴板导入</button></div>' +
      '    <textarea class="cs-ta" id="clipImportInput" rows="2" placeholder="粘贴 VC1. 开头的导入码"></textarea>' +
      '    <div class="cs-row"><button type="button" class="cs-btn primary" id="csImport">导入集锦</button></div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(box);

    var chips = $('#csChips', box);
    PRESETS.forEach(function (p) {
      var b = el('button', 'cs-chip', p);
      b.type = 'button';
      b.addEventListener('click', function () {
        var ni = $('#clipNote'); if (ni) ni.value = p;
        var all = chips.querySelectorAll('.cs-chip');
        for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      });
      chips.appendChild(b);
    });

    $('#csClose', box).addEventListener('click', function () { box.hidden = true; });
    $('#csStart', box).addEventListener('click', setStart);
    $('#csEnd', box).addEventListener('click', setEnd);
    $('#csClear', box).addEventListener('click', function () {
      draft.start = null; draft.end = null; renderStudio();
    });
    $('#csSave', box).addEventListener('click', saveClip);
    $('#csPublish', box).addEventListener('click', publish);
    $('#csReload', box).addEventListener('click', function () {
      var st = state(); cloud.lastKey = ''; cloud.nextAt = 0;
      loadCloud(st.bvid, st.aid, false);
    });
    $('#csShareAll', box).addEventListener('click', function () {
      var st = state(), l = localList(st.bvid);
      if (!l.length) { tip('本场还没有自定义片段'); return; }
      shareClips(st.bvid, l);
    });
    $('#csPaste', box).addEventListener('click', function () {
      var b = bridge(), v = '';
      if (b && b.getClipboardText) { try { v = b.getClipboardText() || ''; } catch (e) {} }
      if (!v) { tip('请长按输入框粘贴导入码'); return; }
      $('#clipImportInput', box).value = v.trim();
      doImport(v.trim(), false);
    });
    $('#csImport', box).addEventListener('click', function () {
      var v = ($('#clipImportInput', box).value || '').trim();
      if (!v) { tip('先粘贴导入码'); return; }
      doImport(v, false);
    });
    return box;
  }

  function renderStudio() {
    studio = studio || buildStudio();
    if (!studio || studio.hidden) return;
    var st = state(), bvid = st.bvid || '', me = getMe();
    var sEl = $('#csState', studio);
    if (sEl) sEl.textContent = (draft.start == null)
      ? '暂停 → 设起点 → 播放 → 暂停 → 设终点 → 写备注'
      : (draft.end == null ? ('起点 ' + s2t(draft.start) + ' · 播放到结束处点「设终点」')
                           : ('起点 ' + s2t(draft.start) + ' → 终点 ' + s2t(draft.end) +
                              '（' + (draft.end - draft.start) + 's）· 写备注后保存'));
    var ni = $('#clipNick', studio);
    if (ni && document.activeElement !== ni) ni.value = getNick();
    var cn = $('#csCount', studio);
    var list = localList(bvid);
    if (cn) cn.textContent = list.length ? (list.length + ' 段') : '';

    var box = $('#csList', studio);
    box.innerHTML = '';
    if (!list.length) box.appendChild(el('div', 'cs-empty', '本场还没有自定义片段'));
    list.forEach(function (c) {
      var row = el('div', 'cs-item');
      row.appendChild(el('span', 'cs-dot mine', ''));
      var t = el('span', 'cs-t', s2t(c.s) + ' +' + c.d + 's');
      row.appendChild(t);
      row.appendChild(el('span', 'cs-n', c.n));
      row.appendChild(el('span', 'cs-u', '@' + c.u));
      var del = el('button', 'cs-mini', '✕'); del.type = 'button'; del.title = '删除';
      del.addEventListener('click', function () { delLocal(bvid, c.id); rebuild(); });
      row.appendChild(del);
      var sh = el('button', 'cs-mini', '↗'); sh.type = 'button'; sh.title = '分享这个片段';
      sh.addEventListener('click', function () { shareClips(bvid, [c]); });
      row.appendChild(sh);
      box.appendChild(row);
    });

    var st2 = $('#csCloudStatus', studio);
    if (st2) {
      st2.textContent = !me.loggedIn ? '未登录：只能保存在本机（登录后才能发布 / 读取评论区）'
        : (cloud.status || '登录后会自动读取评论区里你的集锦');
    }
    var ob = $('#csOthers', studio);
    ob.innerHTML = '';
    var gs = (cloud.bvid === bvid) ? cloud.others : [];
    if (!gs.length) {
      ob.appendChild(el('div', 'cs-empty', me.loggedIn ? '评论区里还没有发现别人的集锦' : '登录后可载入别人的集锦'));
    }
    gs.forEach(function (g) {
      var row = el('div', 'cs-item');
      row.appendChild(el('span', 'cs-dot other', ''));
      row.appendChild(el('span', 'cs-n', '@' + g.user));
      row.appendChild(el('span', 'cs-u', g.clips.length + ' 段'));
      var b = el('button', 'cs-mini wide', isLoaded(bvid, g.key) ? '已载入 ✓' : '载入');
      b.type = 'button';
      b.addEventListener('click', function () {
        setLoaded(bvid, g.key, !isLoaded(bvid, g.key));
        rebuild();
      });
      row.appendChild(b);
      ob.appendChild(row);
    });
  }

  function openStudio(which) {
    studio = studio || buildStudio();
    studio.hidden = false;
    if (global.showChrome) global.showChrome();
    if (which === 'cloud') {
      var st = state(), me = getMe();
      if (me.loggedIn) loadCloud(st.bvid, st.aid, true);
      else tip('载入别人 / 云端的集锦需要先登录 B 站账号');
    }
    renderStudio();
  }

  // ---------------------------------------------------------------- 启动
  function bindFloatTools() {
    var make = $('#sfMake'), cloudBtn = $('#sfCloud'), imp = $('#sfImport');
    if (make) make.addEventListener('click', function () { openStudio('make'); });
    if (cloudBtn) cloudBtn.addEventListener('click', function () { openStudio('cloud'); });
    if (imp) imp.addEventListener('click', function () { openStudio('import'); });
  }

  function init() {
    buildStudio();
    bindFloatTools();
    autoImport();
    // 登录态 false→true 的那一次自动读云端；换场时若已登录也补读一次
    setInterval(function () {
      var me = getMe(), st = state();
      var logged = !!(me && me.loggedIn);
      if (logged && lastLogin !== true && st.bvid && st.aid) {
        cloud.lastKey = '';
        loadCloud(st.bvid, st.aid, true);
      }
      if (!logged) lastLogin = false;
      lastLogin = logged;
      if (logged && st.bvid && st.aid && cloud.bvid !== st.bvid && !cloud.busy) {
        cloud.lastKey = '';
        loadCloud(st.bvid, st.aid, true);
      }
      renderStudio();
    }, 2000);
  }

  // 给 feed.js 的挂载点：buildSegs() 会把这些伪 matched 项混进官方集锦
  global.VCNCClips = {
    forVideo: forVideo,
    localList: localList,
    addLocal: addLocal,
    delLocal: delLocal,
    getNick: getNick,
    setNick: setNick,
    encodeShare: encodeShare,
    decodeShare: decodeShare,
    packComment: packComment,
    packedDropped: function () { return lastDropped; },
    parseComment: parseComment,
    parseGroups: parseGroups,
    loadCloud: loadCloud,
    openStudio: openStudio,
    cloudState: function () { return cloud; },
    _init: init
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
