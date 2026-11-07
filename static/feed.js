/* =============================================================
   VCNC 足球沉浸场 · feed 前端
   - 只播 VCNC 账号的足球视频（/api/feed 动态流）
   - 短视频式沉浸交互：全屏竖滑、自动连播、极简 chrome
   - 焦点缩放：画布帧差 → 运动质心 → 平滑 transform 追随放大
   - 集锦连播：置顶评论时间戳 → 片段序列，双 deck 预热硬切
     （机制移植自 H-Player app.js，Chrome 74 WebView 兼容）
   ============================================================= */
'use strict';

/* ---------------------- 工具 ---------------------- */
var $ = function (s, r) { return (r || document).querySelector(s); };
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmt(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? (h + ':' + pad2(m) + ':' + pad2(s)) : (m + ':' + pad2(s));
}
function dateStr(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function safeDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

function once(target, evt, timeout) {
  timeout = timeout || 8000;
  return new Promise(function (resolve) {
    var done = false;
    var on = function () {
      if (done) return; done = true;
      target.removeEventListener(evt, on); resolve(true);
    };
    target.addEventListener(evt, on);
    setTimeout(function () {
      if (!done) { done = true; target.removeEventListener(evt, on); resolve(false); }
    }, timeout);
  });
}

function seekTo(media, t, timeout) {
  timeout = timeout || 9000;
  return new Promise(function (resolve) {
    if (!media || media.readyState < 1) return resolve(false);
    var dur = (isFinite(media.duration) && media.duration > 0) ? media.duration : null;
    t = Math.max(0, dur ? Math.min(t, dur - 0.1) : t);
    if (Math.abs(media.currentTime - t) < 0.03) return resolve(true);
    var on = function () { media.removeEventListener('seeked', on); resolve(true); };
    media.addEventListener('seeked', on);
    try { media.currentTime = t; } catch (e) {}
    setTimeout(function () { media.removeEventListener('seeked', on); resolve(false); }, timeout);
  });
}

function waitBuffered(media, need, timeout) {
  timeout = timeout || 15000;
  function covered() {
    try {
      var b = media.buffered;
      for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= media.currentTime + 0.15 && b.end(i) >= media.currentTime + need) return true;
      }
    } catch (e) {}
    return false;
  }
  return new Promise(function (resolve) {
    if (covered()) return resolve(true);
    var t0 = performance.now();
    var iv = setInterval(function () {
      if (covered() || performance.now() - t0 > timeout) { clearInterval(iv); resolve(covered()); }
    }, 90);
  });
}

/** 等一帧可用的解码数据（预读采样用：seek 后 readyState>=2 且不在 seeking） */
function waitSeeked(media, timeout) {
  timeout = timeout || 300;
  return new Promise(function (resolve) {
    var t0 = performance.now();
    var iv = setInterval(function () {
      var ok = false;
      try { ok = media.readyState >= 2 && !media.seeking; } catch (e) {}
      if (ok || performance.now() - t0 > timeout) { clearInterval(iv); resolve(ok); }
    }, 25);
  });
}

async function safePlay(media) {
  if (!media) return false;
  try { await media.play(); return true; }
  catch (e) { console.error('play() rejected:', e && (e.name || e.message)); return false; }
}

function setSrc(media, url) {
  if (media.dataset.src === url) return false;
  media.dataset.src = url;
  media.src = url;
  try { media.load(); } catch (e) {}
  return true;
}

function toSec(tok) {
  tok = String(tok == null ? '' : tok).trim().toLowerCase().replace(/：/g, ':').replace(/[^\d\.:hms]/g, '');
  if (!tok) return null;
  if (tok.indexOf(':') >= 0) {
    var p = tok.split(':').map(parseFloat);
    if (p.some(isNaN)) return null;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0];
  }
  var m = tok.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (m && (m[1] || m[2] || m[3])) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  if (/^\d+(\.\d+)?$/.test(tok)) return parseFloat(tok);
  return null;
}

function diag(msg) {
  try { if (window.BiliBridge && BiliBridge.diag) BiliBridge.diag(msg); } catch (e) {}
  console.log('[feed] ' + msg);
}
function reportDiag(msg) { diag(msg); }
function savePosNow() { var c = activeClip(); if (c) c.savePos(); }
function applyViewportScale() { /* 见文件末尾定义 */ }

/* ---------------------- 设置 ---------------------- */
var SET_KEY = 'vcnc.settings.v1';
var POS_KEY = 'vcnc.pos.v1';
var COOKIE_KEY = 'vcnc.cookie.v1';
var FEED_CACHE_KEY = 'vcnc.feedcache.v1';
var QN = 80;              // 1080P
var PAD_FRONT = 1, PAD_BACK = 2;   // 时间戳前后补时（秒）
var LEAD = 0.35;          // 段末预热提前量

var SETTINGS = { mode: 'hl', cat: 'all', zoom: 1.25, zoomOn: true, split: true, focusBox: false, algoViz: true, brightness: 1, volume: 1, slowRate: 1 };

/* 集锦分类：VCNC 置顶评论的动作码图例（写在视频简介里）：
   g 进球; c 丢球; p 传球; a 助攻传球; m 错失; pnn 穿裆; s 扑救; h 头球; dr 带球; ! 精彩 */
var CAT_LABEL = {
  all: '全部', g: '进球', a: '助攻', m: '错失', s: '扑救',
  dr: '带球过人', pnn: '穿裆', h: '头球', p: '传球', c: '丢球', hot: '精彩'
};
var CODE_WORDS = { g: 1, c: 1, p: 1, a: 1, m: 1, s: 1, h: 1, dr: 1, pnn: 1 };

/** 从评论备注里解析动作标签（如 "M dr m" → {dr,m}；"V g pnn*2" → {g,pnn}） */
function segTags(note) {
  var tags = {};
  var t = String(note == null ? '' : note);
  if (!t) return tags;
  if (/[!！]/.test(t)) tags.hot = 1;                       // ! = 作者标精彩
  if (t.indexOf('进球') >= 0) tags.g = 1;                  // 中文兜底
  if (t.indexOf('助攻') >= 0) tags.a = 1;
  if (/扑救|扑出|封堵/.test(t)) tags.s = 1;
  if (/带球|过人|突破/.test(t)) tags.dr = 1;
  if (t.indexOf('穿裆') >= 0) tags.pnn = 1;
  if (t.indexOf('头球') >= 0) tags.h = 1;
  if (/错失|射失|打偏|中柱|中楣/.test(t)) tags.m = 1;
  var toks = t.split(/[\s,，、;；]+/);
  for (var i = 0; i < toks.length; i++) {
    var w = toks[i].toLowerCase().replace(/\*.*$/, '').replace(/[+＋].*$/, '');
    if (!w) continue;
    if (i === 0 && (w === 'm' || w === 'v')) continue;     // 行首队名标记（M/V），不是动作码
    if (CODE_WORDS[w]) tags[w] = 1;
  }
  return tags;
}

function loadSettings() {
  var raw = safeGet(SET_KEY);
  if (!raw) return;
  try {
    var o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (o.mode === 'hl' || o.mode === 'full') SETTINGS.mode = o.mode;
      if (CAT_LABEL[o.cat]) SETTINGS.cat = o.cat;
      if (o.zoom) SETTINGS.zoom = clamp(+o.zoom, 1.05, 3);
      if (typeof o.zoomOn === 'boolean') SETTINGS.zoomOn = o.zoomOn;
      if (typeof o.split === 'boolean') SETTINGS.split = o.split;
      if (typeof o.focusBox === 'boolean') SETTINGS.focusBox = o.focusBox;
      if (typeof o.algoViz === 'boolean') SETTINGS.algoViz = o.algoViz;
      if (typeof o.brightness === 'number') SETTINGS.brightness = clamp(o.brightness, 0.1, 1);
      if (typeof o.volume === 'number') SETTINGS.volume = clamp(o.volume, 0, 1);
      if (typeof o.slowRate === 'number' && [0.5, 0.25, 0.125, 1].indexOf(o.slowRate) >= 0) SETTINGS.slowRate = o.slowRate;
    }
  } catch (e) {}
}
function saveSettings() { safeSet(SET_KEY, JSON.stringify(SETTINGS)); }

/* 竖屏才分屏（上原画面 / 下跟焦放大镜）；横屏保持全屏沉浸 */
function isSplit() {
  if (!SETTINGS.split) return false;
  return window.innerHeight > window.innerWidth;
}
function applySplit() {
  document.body.classList.toggle('split', isSplit());
  camApply();
  var c = activeClip();
  if (c) c.magSync();
}

/* 登录 Cookie（可选）：B 站对游客请求有 -352 风控，登录态阈值高得多 */
function getUserCookie() { return safeGet(COOKIE_KEY) || ''; }
function cookieParam(sep) { var c = getUserCookie(); return c ? (sep + 'cookie=' + encodeURIComponent(c)) : ''; }

/* ---------------------- 图标 ---------------------- */
var ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 1.5v4.5M12 18v4.5M1.5 12H6M18 12h4.5"/></svg>';
var ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>';
var ICON_SET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h8M17.5 7H20M4 17h2.5M11.5 17H20"/><circle cx="14.5" cy="7" r="2.6" fill="currentColor" stroke="none"/><circle cx="8.5" cy="17" r="2.6" fill="currentColor" stroke="none"/></svg>';
var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/></svg>';

var CLIP_HTML =
  '<div class="stage">' +
    // 竖屏分屏：上半原始画面（不缩放）
    '<div class="mainview">' +
      '<div class="decks"></div>' +
      '<canvas class="algo algo-main"></canvas>' +
      '<div class="focus-box"></div>' +
      '<button class="bigplay" type="button">' + ICON_PLAY + '</button>' +
    '</div>' +
    // 竖屏分屏：下半跟焦放大镜（与主画面同源同步）
    '<div class="magview">' +
      '<video class="mag-v" muted playsinline webkit-playsinline preload="auto"></video>' +
      '<canvas class="algo algo-mag"></canvas>' +
      '<div class="mag-veil"><div class="veil-spin"></div><div class="veil-text">放大镜加载中…</div></div>' +
      '<div class="mag-tag">跟焦放大</div>' +
    '</div>' +
    '<div class="veil"><div class="veil-spin"></div><div class="veil-text"></div><button class="veil-retry" type="button" hidden>重试</button></div>' +
    '<div class="chrome">' +
      '<div class="ch-top">' +
        '<div class="brand">VCNC · 足球沉浸场</div>' +
        '<div class="ch-actions">' +
          '<button class="ic list" type="button" title="比赛列表">' + ICON_LIST + '</button>' +
          '<button class="ic zoom" type="button" title="焦点缩放">' + ICON_ZOOM + '</button>' +
          '<button class="ic set" type="button" title="设置">' + ICON_SET + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="ch-bottom">' +
        '<div class="bar"><div class="bar-fill"></div></div>' +
        '<div class="ctitle"></div>' +
        '<div class="csub"></div>' +
      '</div>' +
    '</div>' +
  '</div>';

/* ---------------------- feed 状态 ---------------------- */
var items = [];
var feedOffset = '';
var feedHasMore = true;
var feedLoading = false;
var active = -1;
var clips = {};
var preloadTimer = null;
var pendingFirstResume = null;

var feedEl = null;
var params = {};

function activeClip() { return active >= 0 ? clips[active] : null; }

/* =============================================================
   ClipPlayer：一场比赛的播放器（双 deck 无缝集锦连播）
   ============================================================= */
function ClipPlayer(item, index) {
  this.item = item;
  this.index = index;
  this.state = 'idle';      // idle | loading | ready | error
  this.error = '';
  this.token = null;
  this.info = null;
  this.videoDuration = 0;
  this.hasAudio = false;
  this.segs = [];
  this.idx = -1;
  this.pendingIdx = -1;
  this.activeDeck = 0;
  this.playing = false;
  this.busy = false;
  this.active = false;
  this.lastSwitchAt = 0;
  this.lastHud = 0;
  this.lastPosSave = 0;
  this.pendingResume = null;
  this.catEmpty = false;      // 本场按当前分类筛完后为空（已回退全部）
  this.catActive = 'all';     // 实际生效的集锦分类
  this.magUrl = '';
  this.magReady = false;
  this.lastMagSync = 0;
  this.tracks = [];           // 预读轨迹：seg 下标 → [{t,x,y,zoom}]
  this.extTracks = null;      // 外部预计算轨迹（PC YOLO 管线）：seg 下标 → [{t,x,y,zoom}]
  this.prereading = null;     // 正在进行的预读 Promise（jumpTo 会等它）
  this.gen = 0;               // 片段序列重建/停止时递增，作废在途预读

  this.el = document.createElement('div');
  this.el.className = 'clip';
  this.el.style.top = (index * 100) + '%';
  this.el.innerHTML = CLIP_HTML;
  feedEl.appendChild(this.el);

  this.stage = $('.stage', this.el);
  this.mainview = $('.mainview', this.el);
  this.magview = $('.magview', this.el);
  this.magV = $('.mag-v', this.el);
  this.magVeil = $('.mag-veil', this.el);
  this.algoMain = $('.algo-main', this.el);
  this.algoMag = $('.algo-mag', this.el);
  this.veil = $('.veil', this.el);
  this.veilText = $('.veil-text', this.el);
  this.veilRetry = $('.veil-retry', this.el);
  this.titleEl = $('.ctitle', this.el);
  this.subEl = $('.csub', this.el);
  this.fillEl = $('.bar-fill', this.el);
  this.bigplay = $('.bigplay', this.el);
  this.focusBox = $('.focus-box', this.el);

  try { this.magV.playsInline = true; this.magV.muted = true; } catch (e) {}

  var pic = item.pic ? (item.pic.indexOf('//') === 0 ? 'https:' + item.pic : item.pic) : '';
  if (pic) {
    this.stage.style.backgroundImage = 'url("' + pic + '")';
    this.stage.style.backgroundSize = 'cover';
    this.stage.style.backgroundPosition = 'center';
  }

  var self = this;
  this.veilRetry.addEventListener('click', function () { self.retry(); });
  $('.ic.list', this.el).addEventListener('click', function () { openVList(); });
  $('.ic.zoom', this.el).addEventListener('click', function () { toggleZoom(); });
  $('.ic.set', this.el).addEventListener('click', function () { openSheet(); });
  this.bigplay.addEventListener('click', function () { self.togglePlay(); });

  this.decks = [];
  var decksLayer = $('.decks', this.el);
  for (var k = 0; k < 2; k++) {
    var d = {};
    d.el = document.createElement('div');
    d.el.className = 'deck';
    d.v = document.createElement('video');
    d.v.playsInline = true; d.v.muted = true; d.v.preload = 'auto';
    d.v.setAttribute('playsinline', '');
    d.v.setAttribute('webkit-playsinline', '');
    d.a = document.createElement('audio');
    d.a.preload = 'auto';
    d.seg = -1; d.ready = false; d.rolling = false; d.everReady = false; d.tracking = false;
    d.el.appendChild(d.v); d.el.appendChild(d.a);
    decksLayer.appendChild(d.el);
    (function (dd) {
      dd.v.addEventListener('error', function () { self.onDeckError(); });
    })(d);
    this.decks.push(d);
  }
  this.render();
}

ClipPlayer.prototype.resolve = async function () {
  if (this.state === 'loading' || this.state === 'ready') return this.state === 'ready';
  this.state = 'loading';
  this.render();
  try {
    var j = await (await fetch('/api/resolve?url=' + encodeURIComponent(this.item.bvid) + '&qn=' + QN + cookieParam('&'))).json();
    if (!j.ok) throw new Error(j.error || '解析失败');
    this.token = j.token;
    this.info = j;
    this.videoDuration = j.duration || 0;
    this.hasAudio = !!(j.audio && j.audio.id);
    this.buildSegs(j.matched || []);
    this.state = 'ready';
    this.error = '';
    diag('resolve ok ' + this.item.bvid + ' segs=' + this.segs.length);
    this.render();
    return true;
  } catch (e) {
    this.state = 'error';
    this.error = (e && e.message) || String(e);
    diag('resolve fail ' + this.item.bvid + ': ' + this.error);
    this.render();
    return false;
  }
};

/** 置顶评论时间戳 → 片段序列（规则同 H-Player：显式时长优先，否则相邻间隔推断） */
ClipPlayer.prototype.buildSegs = function (matched) {
  var its = [];
  for (var i = 0; i < matched.length; i++) {
    var mm = matched[i];
    var s0 = toSec(mm.time || '');
    if (s0 == null) continue;
    var s1 = (mm.end && String(mm.end).indexOf('+') < 0) ? toSec(mm.end) : null;
    its.push({ m: mm, s0: s0, s1: s1 });
  }
  its.sort(function (a, b) { return a.s0 - b.s0; });
  var segs = [];
  for (var k = 0; k < its.length; k++) {
    var it = its[k];
    var d;
    if (it.m.dur > 0) d = it.m.dur;
    else if (it.s1 != null && it.s1 > it.s0) d = clamp(it.s1 - it.s0, 3, 60);
    else if (k + 1 < its.length && its[k + 1].s0 > it.s0) d = clamp(its[k + 1].s0 - it.s0, 3, 30);
    else d = 10;
    var start = Math.max(0, it.s0 - PAD_FRONT);
    var dur = d + PAD_FRONT + PAD_BACK;
    if (this.videoDuration > 0) {
      if (start >= this.videoDuration - 0.2) continue;
      if (start + dur > this.videoDuration) dur = Math.max(0.6, this.videoDuration - start);
    }
    segs.push({ start: start, dur: dur, note: it.m.text || '', tags: segTags(it.m.text) });
  }
  // 集锦分类筛选（原片模式不筛）；筛完为空则回退全部并提示
  this.catEmpty = false;
  this.catActive = 'all';      // 实际生效的分类（回退全部时为 all）
  if (SETTINGS.mode === 'hl' && SETTINGS.cat !== 'all' && segs.length) {
    var f = [];
    for (var q = 0; q < segs.length; q++) {
      if (segs[q].tags && segs[q].tags[SETTINGS.cat]) f.push(segs[q]);
    }
    if (f.length) { segs = f; this.catActive = SETTINGS.cat; }
    else this.catEmpty = true;
  }
  if (SETTINGS.mode === 'full' || !segs.length) {
    segs = [{ start: 0, dur: this.videoDuration > 0 ? this.videoDuration : 600, note: '', tags: {} }];
  }
  this.segs = segs;
  this.loadExtTracks();       // 异步拉取 PC 预计算轨迹（有则跳过端侧识别）
};

/** 外部预计算轨迹：PC 端 YOLO 管线产出，经 /api/tracks/<bvid>.json 下发。
 *  按 start（±1s 容差）对齐到当前段序列；拉到后填入 extTracks，
 *  prereadTrack 入口优先采用，端侧自研识别退为兜底。 */
ClipPlayer.prototype.loadExtTracks = function () {
  var self = this;
  var bvid = this.item && this.item.bvid;
  if (!bvid || !this.segs.length) return;
  var gen = this.gen;
  fetch('/api/tracks/' + encodeURIComponent(bvid) + '.json').then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (data) {
    if (!data || !data.segs || !data.segs.length || self.gen !== gen) throw 0;
    var map = [];
    for (var k = 0; k < data.segs.length; k++) {
      var s = data.segs[k];
      if (s && s.track && s.track.length) map.push([s.start, s.track]);
    }
    var ext = [], hit = 0;
    for (var j = 0; j < self.segs.length; j++) {
      var sg = self.segs[j];
      var best = null, bestGap = 8;   // 最近邻匹配，容忍评论数据/前置缓冲的 ±8s 漂移
      for (var q = 0; q < map.length; q++) {
        var gap = Math.abs(map[q][0] - sg.start);
        if (gap < bestGap) { bestGap = gap; best = map[q][1]; }
      }
      if (best) { ext[j] = best; hit++; }
    }
    if (hit) {
      self.extTracks = ext;
      // 已有序列里还没轨迹的段直接挂上（正在识别的不抢，其入口会先查 ext）
      if (!self.prereading) {
        for (var m = 0; m < ext.length; m++) {
          if (ext[m] && !self.tracks[m]) self.tracks[m] = ext[m];
        }
      }
      diag('ext tracks ok ' + bvid + ': ' + hit + '/' + self.segs.length + ' segs');
    }
  }).catch(function () { self.extTracks = null; });
};

ClipPlayer.prototype.retry = function () {
  this.stopAll();
  this.state = 'idle';
  this.error = '';
  this.activate();
};

ClipPlayer.prototype.onDeckError = function () {
  if (!this.active || this.state !== 'ready') return;
  this.state = 'error';
  this.error = '视频流中断，请重试';
  this.playing = false;
  this.render();
};

ClipPlayer.prototype.prepare = async function (d, i, lead) {
  var seg = this.segs[i];
  if (!seg || !this.token) return false;
  var t = Math.max(0, seg.start - lead);
  d.seg = i; d.ready = false; d.rolling = false;
  try { d.v.pause(); if (this.hasAudio) d.a.pause(); } catch (e) {}
  setSrc(d.v, '/api/media/' + this.token + '/v?i=0');
  if (this.hasAudio) setSrc(d.a, '/api/media/' + this.token + '/a?i=0');

  if (d.v.readyState < 1) await once(d.v, 'loadedmetadata', 15000);
  if (this.hasAudio && d.a.readyState < 1) await once(d.a, 'loadedmetadata', 15000);
  if (d.v.readyState < 1) {
    diag('prepare-fail rs=' + d.v.readyState + ' net=' + d.v.networkState);
    return false;
  }
  await seekTo(d.v, t);
  if (this.hasAudio) await seekTo(d.a, t);
  await waitBuffered(d.v, Math.min(2.4, Math.max(1.0, seg.dur * 0.5)), 15000);
  if (this.hasAudio) await waitBuffered(d.a, 0.8, 12000);
  d.ready = true;
  d.everReady = true;
  return true;
};

/** 预读识别：对（尚未起播的）deck 视频在段内 seek 步进采样，跑完整算法管线，
 *  产出轨迹 [{t,x,y,zoom}]（t=段内相对秒）。有时间预算，失败返回 null。
 *  只 seek d.v（音轨不动），结束后 seek 回原位，不影响起播位置。 */
ClipPlayer.prototype.prereadTrack = async function (d, i) {
  var seg = this.segs[i];
  var v = d && d.v;
  if (!seg || !v || !cam.ctx || !v.videoWidth || !SETTINGS.zoomOn) return null;
  // 外部预计算轨迹（PC YOLO 管线）优先：直接返回，跳过端侧识别
  var ext = this.extTracks && this.extTracks[i];
  if (ext && ext.length) return ext;
  d.tracking = true;
  var self = this;
  var gen = this.gen;          // 片段序列/停止 会递增：过期就退出，避免写回旧轨迹
  var back = v.currentTime;
  var out = [];
  try {
    var W = FOCUS_CFG.W, H = FOCUS_CFG.H, n = W * H;
    var prevRGB = new Uint8ClampedArray(n * 3);
    var sc = {
      n: n,
      lum: new Float32Array(n), diff: new Float32Array(n),
      mask: new Uint8Array(n), mask2: new Uint8Array(n), wmask: new Uint8Array(n),
      protect: new Uint8Array(n), fg: new Uint8Array(n),
      stack: new Int32Array(n), bg: bgModel(n)
    };
    var hasPrev = false, lastT = -1;
    var span = Math.min(FOCUS_CFG.prereadMaxSec, Math.max(0.2, seg.dur));
    var t0 = performance.now();
    for (var t = 0; t <= span + 1e-6; t += FOCUS_CFG.prereadStep) {
      if (performance.now() - t0 > FOCUS_CFG.prereadBudget) break;
      if (self.gen !== gen || d.seg !== i) break;   // 已被重新准备/停止
      if (!await seekTo(v, seg.start + t, FOCUS_CFG.prereadSeekMs)) continue;
      if (!await waitSeeked(v, 250)) continue;
      var img;
      try { cam.ctx.drawImage(v, 0, 0, W, H); } catch (e) { continue; }
      try { img = cam.ctx.getImageData(0, 0, W, H); } catch (e) { continue; }
      var st = analyzeScene(img.data, prevRGB, sc, W, H, FOCUS_CFG,
        null, performance.now(), FOCUS_CFG.prereadStep, null, hasPrev);
      hasPrev = true;
      var comp = st.compose;
      if (comp && comp.hasBall) {
        if (out.length) {   // 与上一点 EMA，抑制单点跳变
          var p0 = out[out.length - 1];
          comp = { cx: p0.x + (comp.cx - p0.x) * 0.5, cy: p0.y + (comp.cy - p0.y) * 0.5, zoom: comp.zoom };
        }
        out.push({ t: t, x: comp.cx, y: comp.cy, zoom: comp.zoom });
        lastT = t;
      } else if (out.length && t - lastT < 0.75) {
        // 短暂无球：沿用上一点，保持轨迹连续
        out.push({ t: t, x: out[out.length - 1].x, y: out[out.length - 1].y, zoom: out[out.length - 1].zoom });
      }
    }
  } catch (e) {
    out = [];
  }
  if (d.seg === i) { try { await seekTo(v, back, 600); } catch (e) {} }
  d.tracking = false;
  diag('preread seg=' + i + ' pts=' + out.length + '/' + this.segs.length);
  return out.length ? out : null;
};

/** 下一段静音预热起播：段末硬切无黑帧的关键 */
ClipPlayer.prototype.warmDeck = async function (d) {
  if (!d || !d.ready) return false;
  if (d.v.readyState < 3) return false;
  d.rolling = true;
  d.v.muted = true;
  if (this.hasAudio) d.a.muted = true;
  try { await d.v.play(); } catch (e) { return false; }
  if (this.hasAudio) { try { await d.a.play(); } catch (e) {} }
  return true;
};

ClipPlayer.prototype.showDeck = function (k, hard) {
  this.activeDeck = k;
  for (var i = 0; i < this.decks.length; i++) {
    var d = this.decks[i];
    var on = (i === k);
    if (on) {
      if (hard) {
        d.el.style.transition = 'none';
        d.el.style.opacity = '1';
        d.el.classList.add('on');
        void d.el.offsetWidth;
        d.el.style.transition = '';
      } else {
        d.el.classList.add('on');
      }
    } else {
      d.el.classList.remove('on');
    }
    d.v.muted = true;
    d.a.muted = !on || !this.hasAudio;
    try { d.a.volume = SETTINGS.volume; } catch (e) {}
  }
};

ClipPlayer.prototype.startDeck = async function (d) {
  d.rolling = true;
  var base = slowBase();
  try { d.v.playbackRate = base; } catch (e) {}
  if (this.hasAudio) { try { d.a.playbackRate = base; } catch (e) {} }
  try { d.a.volume = SETTINGS.volume; } catch (e) {}
  var ps = [safePlay(d.v)];
  if (this.hasAudio) ps.push(safePlay(d.a));
  await Promise.all(ps);
  if (this.hasAudio && d.v.readyState >= 2 && d.a.readyState >= 2) {
    if (Math.abs(d.a.currentTime - d.v.currentTime) > 0.025) d.a.currentTime = d.v.currentTime;
  }
};

ClipPlayer.prototype.nextIdx = function () {
  if (!this.segs.length) return -1;
  if (this.idx + 1 < this.segs.length) return this.idx + 1;
  return -1;
};

ClipPlayer.prototype.prepareNext = function () {
  var self = this;
  var j = this.nextIdx();
  if (j < 0 || !this.token) { this.pendingIdx = -1; return; }
  var d = this.decks[1 - this.activeDeck];
  this.pendingIdx = j;
  var gen = this.gen;
  var warmLead = Math.min(Math.max(LEAD, 0.6), Math.max(0, this.segs[j].start));
  this.preparing = this.prepare(d, j, warmLead).then(function (ok) {
    if (!ok) return false;
    if (!SETTINGS.zoomOn) { self.warmDeck(d); return true; }
    // 预热段起播前先预读识别：算好了再切，上下起播即有焦点轨迹。
    // 有预算上限，超时/失败都不阻塞起播（退回实时跟焦）。
    self.prereading = self.prereadTrack(d, j).then(function (tr) {
      self.prereading = null;
      if (tr && self.gen === gen) self.tracks[j] = tr;   // 序列已重建则丢弃
      self.warmDeck(d);
      return true;
    }, function () {
      self.prereading = null;
      self.warmDeck(d);
      return true;
    });
    return self.prereading;
  });
};

ClipPlayer.prototype.jumpTo = async function (i, opts) {
  opts = opts || {};
  if (this.busy || i < 0 || i >= this.segs.length || !this.token) return;
  var self = this;

  // ---- 快速路径：已预热，直接硬切 ----
  var d = this.decks[1 - this.activeDeck];
  if (d.seg === i && d.tracking && this.prereading) {
    // 预热段还在预读识别：等它算完再切，保证起播就有焦点轨迹
    this.busy = true;
    try { await this.prereading; } catch (e) {}
    this.busy = false;
  }
  if (d.seg === i && d.ready && !d.tracking && (d.v.readyState >= 2 || d.everReady)) {
    this.busy = true;
    this.idx = i;
    this.pendingIdx = -1;
    this.lastSwitchAt = performance.now();
    this.showDeck(this.decks.indexOf(d), true);
    await this.startDeck(d);
    this.playing = true;
    this.busy = false;
    this.veil.classList.remove('on');
    this.render();
    if (opts.seekOffset && opts.seekOffset > 0.05) {
      var seg0 = this.segs[i];
      var rt0 = seg0.start + opts.seekOffset;
      try { d.v.currentTime = rt0; if (this.hasAudio) d.a.currentTime = rt0; } catch (e) {}
    }
    cam.track = this.tracks[i] || null;
    camCut(opts.seekOffset && opts.seekOffset > 0.05 ? opts.seekOffset : 0);
    this.prepareNext();
    diag('cut fast idx=' + i + '/' + this.segs.length);
    return;
  }

  // ---- 慢路径：真的加载（400ms 后才亮遮罩） ----
  this.busy = true;
  var veilShown = false;
  var veilTimer = setTimeout(function () {
    if (self.busy && !veilShown) {
      self.veilText.textContent = '载入第 ' + (i + 1) + ' 段';
      self.veil.classList.add('on');
      veilShown = true;
    }
  }, 400);
  d.rolling = false;
  var ok = await this.prepare(d, i, 0);
  if (!ok) { await sleep(500); ok = await this.prepare(d, i, 0); }
  clearTimeout(veilTimer);
  if (!ok) {
    this.veil.classList.remove('on');
    this.state = 'error';
    this.error = '准备第 ' + (i + 1) + ' 段失败（网络或接口异常），请重试';
    this.playing = false;
    this.busy = false;
    this.render();
    return;
  }
  // ---- 起播前预读识别：算法先算一段时间，识别好了再上下一起播放 ----
  var track = null;
  if (SETTINGS.zoomOn) {
    this.veilText.textContent = '识别中…';
    this.veil.classList.add('on');
    this.prereading = this.prereadTrack(d, i);
    track = await this.prereading;
    this.prereading = null;
    if (track) this.tracks[i] = track;
  }
  this.idx = i;
  this.pendingIdx = -1;
  this.lastSwitchAt = performance.now();
  this.showDeck(this.decks.indexOf(d));
  await this.startDeck(d);
  this.playing = true;
  this.veil.classList.remove('on');
  this.busy = false;
  this.render();
  if (opts.seekOffset && opts.seekOffset > 0.05) {
    var seg = this.segs[i];
    var rt = seg.start + opts.seekOffset;
    try { d.v.currentTime = rt; if (this.hasAudio) d.a.currentTime = rt; } catch (e) {}
  }
  cam.track = track || null;
  camCut(opts.seekOffset && opts.seekOffset > 0.05 ? opts.seekOffset : 0);
  this.prepareNext();
  diag('cut slow idx=' + i + '/' + this.segs.length);
};

ClipPlayer.prototype.pauseAll = function () {
  this.playing = false;
  for (var i = 0; i < this.decks.length; i++) {
    try { this.decks[i].v.pause(); this.decks[i].a.pause(); } catch (e) {}
  }
  this.render();
};

ClipPlayer.prototype.resumePlay = async function () {
  if (this.idx < 0 || this.state !== 'ready') return;
  this.playing = true;
  var cur = this.decks[this.activeDeck];
  await safePlay(cur.v);
  if (this.hasAudio && !cur.a.muted) await safePlay(cur.a);
  this.render();
};

ClipPlayer.prototype.togglePlay = function () {
  if (this.state !== 'ready' || this.idx < 0) return;
  if (this.playing) this.pauseAll();
  else this.resumePlay();
  showChrome();
};

ClipPlayer.prototype.stopAll = function () {
  this.playing = false;
  this.idx = -1;
  this.pendingIdx = -1;
  this.gen++;
  for (var i = 0; i < this.decks.length; i++) {
    var d = this.decks[i];
    try { d.v.pause(); d.a.pause(); } catch (e) {}
    d.rolling = false; d.ready = false; d.seg = -1;
    d.el.classList.remove('on');
  }
  this.activeDeck = 0;
  this.render();
};

ClipPlayer.prototype.bufferedAhead = function (media) {
  try {
    var b = media.buffered, ct = media.currentTime, best = 0;
    for (var i = 0; i < b.length; i++) {
      if (b.start(i) <= ct + 0.2 && b.end(i) - ct > best) best = b.end(i) - ct;
    }
    return best;
  } catch (e) { return 0; }
};

/** 把预热 deck 钉在「当前段播到哪、它就该出现在哪」的位置 */
ClipPlayer.prototype.followPreheated = function (ct, curEnd) {
  if (this.pendingIdx < 0 || this.busy) return;
  var d = this.decks[1 - this.activeDeck];
  if (!d || !d.ready || !d.rolling || d.seg !== this.pendingIdx) return;
  var nseg = this.segs[this.pendingIdx];
  if (!nseg) return;
  var curSeg = this.segs[this.idx];
  if (!curSeg) return;
  var intoCur = clamp(ct - curSeg.start, 0, curSeg.dur);
  var target = nseg.start + intoCur;
  var diff = target - d.v.currentTime;
  var remain = curEnd - ct;
  if (remain > 1.2) return;
  if (Math.abs(diff) > 0.28) {
    if (this.bufferedAhead(d.v) < remain + 0.6) {
      try {
        d.v.currentTime = target;
        if (this.hasAudio) d.a.currentTime = target;
      } catch (e) {}
    }
  } else if (Math.abs(diff) > 0.015) {
    var rate = 1 * (1 + clamp(-diff * 0.5, -0.06, 0.06));
    d.v.playbackRate = rate;
    if (this.hasAudio) d.a.playbackRate = rate;
  }
  if (Math.abs(diff) <= 0.015) {
    d.v.playbackRate = 1;
    if (this.hasAudio) d.a.playbackRate = 1;
  }
};

ClipPlayer.prototype.onSegmentEnd = function () {
  if (this.busy || performance.now() - this.lastSwitchAt < 150) return;
  var j = this.nextIdx();
  if (j < 0) {
    // 本场集锦播完：停住不自动跳下一场（调试专注模式）
    this.pauseAll();
    toast('本场播完');
    return;
  }
  this.jumpTo(j, {});
};

ClipPlayer.prototype.syncAudio = function () {
  var now = performance.now();
  if (now - (this.lastSync || 0) < 150) return;
  this.lastSync = now;
  for (var i = 0; i < this.decks.length; i++) {
    var d = this.decks[i];
    if (d.v.readyState < 2 || d.a.readyState < 2) continue;
    if (d.v.paused || d.a.paused) continue;
    var base = (i === this.activeDeck) ? slowBase() : 1;   // 慢动作只作用于正在看的 deck
    var err = d.a.currentTime - d.v.currentTime;
    if (Math.abs(err) > 0.35) {
      d.a.currentTime = d.v.currentTime;
      d.v.playbackRate = base;
      d.a.playbackRate = base;
      continue;
    }
    d.a.playbackRate = base;
    d.v.playbackRate = base * (1 + clamp(err * 0.45, -0.03, 0.03));
  }
};

ClipPlayer.prototype.tick = function (now) {
  if (!this.active) return;
  if (!this.lastMagSync || now - this.lastMagSync > 120) {
    this.lastMagSync = now;
    this.magSync();
  }
  if (this.hasAudio) this.syncAudio();
  if (this.idx >= 0 && now - this.lastPosSave > 2000) {
    this.lastPosSave = now;
    this.savePos();
  }
  if (!this.playing || this.busy || this.idx < 0) return;
  var cur = this.decks[this.activeDeck];
  var seg = this.segs[this.idx];
  if (!seg) return;
  var end = seg.start + seg.dur;
  var ct = cur.v.currentTime;
  this.followPreheated(ct, end);
  if (ct >= end - 0.012) { this.onSegmentEnd(); return; }
  if (now - this.lastHud > 100) { this.lastHud = now; this.hud(ct, end); }
};

ClipPlayer.prototype.hud = function (ct, end) {
  var seg = this.segs[this.idx];
  if (!seg) return;
  var p = clamp((ct - seg.start) / Math.max(0.1, seg.dur), 0, 1);
  this.fillEl.style.width = (p * 100).toFixed(1) + '%';
  var sub = dateStr(this.item.pubdate);
  if (SETTINGS.mode === 'hl' && this.segs.length) sub += ' · 集锦 ' + (this.idx + 1) + '/' + this.segs.length;
  else sub += ' · 原片 ' + fmt(this.videoDuration);
  if (SETTINGS.mode === 'hl' && this.catActive !== 'all' && this.segs.length &&
      this.segs[0].tags && this.segs[0].tags[this.catActive]) {
    sub += ' · ' + (CAT_LABEL[this.catActive] || '');
  }
  this.subEl.textContent = sub;
};

ClipPlayer.prototype.savePos = function () {
  if (this.idx < 0 || !this.active) return;
  var cur = this.decks[this.activeDeck];
  var seg = this.segs[this.idx];
  if (!seg) return;
  var t = cur.v.currentTime - seg.start;
  safeSet(POS_KEY, JSON.stringify({ bvid: this.item.bvid, idx: this.idx, t: Math.max(0, t) }));
};

ClipPlayer.prototype.takeResume = function () {
  var p = null;
  if (this.pendingResume) { p = this.pendingResume; this.pendingResume = null; }
  else {
    var raw = safeGet(POS_KEY);
    if (raw) { try { p = JSON.parse(raw); } catch (e) { p = null; } }
  }
  if (!p || p.bvid !== this.item.bvid) return null;
  safeDel(POS_KEY);
  return { idx: p.idx | 0, t: +p.t || 0 };
};

ClipPlayer.prototype.activate = async function () {
  this.active = true;
  if (this.state === 'idle') {
    var ok = await this.resolve();
    if (!ok) return;
  }
  if (this.state !== 'ready') return;
  if (this.idx < 0) {
    var rs = this.takeResume();
    if (rs && rs.idx < this.segs.length) await this.jumpTo(rs.idx, { seekOffset: rs.t });
    else await this.jumpTo(0);
  } else {
    await this.resumePlay();
  }
};

ClipPlayer.prototype.deactivate = function () {
  if (!this.active) return;
  this.active = false;
  this.savePos();
  this.pauseAll();
  try { this.magV.pause(); } catch (e) {}
};

ClipPlayer.prototype.destroy = function () {
  this.deactivate();
  this.tracks = [];
  this.prereading = null;
  for (var i = 0; i < this.decks.length; i++) {
    var d = this.decks[i];
    try { d.v.removeAttribute('src'); d.v.load(); d.a.removeAttribute('src'); d.a.load(); } catch (e) {}
  }
  try { this.magV.removeAttribute('src'); this.magV.load(); } catch (e) {}
  if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
};

/**
 * 竖屏分屏的「跟焦放大镜」：下半部分用同一路媒体流（第二个 video 元素，
 * 静音）与主画面同步，transform 由 camApply 作用在它上面。
 * 分屏关闭/横屏/非激活时暂停释放解码器。
 */
ClipPlayer.prototype.magSync = function () {
  if (!this.magV) return;
  var usable = isSplit() && this.active && this.state === 'ready' && this.idx >= 0 && this.token;
  if (!usable) {
    this.magVeil.classList.remove('on');
    if (!this.magV.paused) { try { this.magV.pause(); } catch (e) {} }
    return;
  }
  var d = this.decks[this.activeDeck];
  if (!d || !d.ready) { this.magVeil.classList.add('on'); return; }
  var url = '/api/media/' + this.token + '/v?i=0';
  if (this.magUrl !== url) {
    setSrc(this.magV, url);
    this.magUrl = url;
    this.magReady = false;
  }
  if (!this.magReady) {
    if (this.magV.readyState < 1) { this.magVeil.classList.add('on'); return; }
    this.magReady = true;
    try { this.magV.currentTime = d.v.currentTime; } catch (e) {}
    this.magVeil.classList.remove('on');
  }
  if (Math.abs(this.magV.currentTime - d.v.currentTime) > 0.3) {
    try { this.magV.currentTime = d.v.currentTime; } catch (e) {}
  }
  if (d.v.paused) {
    if (!this.magV.paused) { try { this.magV.pause(); } catch (e) {} }
  } else if (this.magV.paused) {
    safePlay(this.magV);
  }
};

ClipPlayer.prototype.render = function () {
  this.titleEl.textContent = this.item.title || '';
  var sub = dateStr(this.item.pubdate);
  if (this.state === 'ready') {
    if (SETTINGS.mode === 'hl' && this.segs.length) sub += ' · 集锦 ' + (this.idx + 1) + '/' + this.segs.length;
    else sub += ' · 原片 ' + fmt(this.videoDuration);
  }
  this.subEl.textContent = sub;

  if (this.state === 'loading') {
    this.veilText.textContent = '加载中…';
    this.veilRetry.hidden = true;
    this.veil.classList.add('on');
  } else if (this.state === 'error') {
    this.veilText.textContent = this.error || '加载失败';
    this.veilRetry.hidden = false;
    this.veil.classList.add('on');
  } else {
    this.veil.classList.remove('on');
  }

  if (this.active && this.state === 'ready' && !this.playing) {
    this.bigplay.classList.add('show');
    this.bigplay.innerHTML = ICON_PLAY;
  } else {
    this.bigplay.classList.remove('show');
  }
  syncPlayIcon();   // 左下角播放/暂停图标与状态同步
};

ClipPlayer.prototype.visibleVideo = function () {
  if (this.idx < 0) return null;
  return this.decks[this.activeDeck].v;
};

/* =============================================================
   焦点缩放引擎 · 子算法模块
   参数全部集中在 FOCUS_CFG（控制台/CDP 可用 __focusTune 在线调优）。

   管线（每个子算法：输入=整体画面，输出=对象+坐标 / 行为 / 画面建议）：
     ① segField      球场分割：绿色 mask + 包围盒
     ② detectGoal    球门识别：白色低饱和「厚带」全局扫描（长度+厚度门槛）
     ③ detectPeople  人员识别：非球场连通域 + 尺寸/纵横比过滤
     ④ bg/fgObjects  背景减除（Wren 式运行高斯）→ 前景物体（连通域+运动能量）
     ⑤ ballCands     足球候选：运动证据为主（小/实心/在草地/高能量），外观仅续跟踪
     ⑥ trackBall     球跟踪：最近邻 + 速度预测 + 连续性加分 + 丢失外推
     ⑦ sceneStep     行为：球速 / 最近的人=持球者 / 球→门预测轨迹
     ⑧ composeScene  组合构图：球+持球者（射门时加球门）→ 中心 + 推荐倍率
     ⑨ cam           平滑相机：目标点 + dt 归一化缓动（位置/缩放分别缓动）
     ⑩ algoDraw      可视化：把发现的对象和行为画在画面上
   预读：prereadTrack 起播前 seek 步进采样 → tracks[i] = [{t,x,y,zoom}]
   ============================================================= */
var FOCUS_CFG = {
  // 分析网格（源视频等比缩小到该分辨率逐细胞处理）
  // 128×72：五人场里的球约 20~80px → 1.5~5 个细胞，比 96×54 更容易形成可检测小物体
  W: 128, H: 72,
  // 帧差 / 运动能量（供人员识别排序与运动量统计）
  diffThresh: 18,          // 帧差超过即「运动细胞」
  // ④ 背景减除（Wren 式运行高斯，Pfinder 经典算法）
  bgK: 2.5,                // 前景阈值 = max(bgK·σ, bgMinDiff)
  bgMinDiff: 22,           // 前景最小色差（滤压缩噪声/光照微变）
  bgInitVar: 120,          // 背景初始方差（σ≈11）
  bgWarmFrames: 8,         // 预热帧数（快速学习率）——预读阶段自然完成
  bgWarmRate: 0.5,         // 预热期学习率（只学非前景：运动物体不被吸进背景）
  bgLearnRate: 0.004,      // 稳定期学习率（只学非前景、非保护细胞）
  bgStaleFrames: 16,       // 连续前景超过此帧数 → 判为陈旧（洞/光照漂移）
  bgStaleRate: 0.25,       // 陈旧前景的吸收速率（约 1 秒清掉一个洞）
  objMinCells: 2,          // 前景物体最小细胞数（滤单细胞噪声）
  // ⑤ 足球候选（低清源：球仅 1~3 细胞 → 运动证据是主判据，外观只用于续跟踪）
  ballMinCells: 2,         // 球：细胞数范围
  ballMaxCells: 12,
  ballAspectMin: 0.4,      // 球：高/宽比范围（近圆）
  ballAspectMax: 2.5,
  ballLumMin: 165,         // 外观路径（白球）亮度门槛
  ballLumMinFg: 120,       // 运动路径亮度门槛（有运动证据即可放宽）
  ballFillMin: 0.5,        // 填充率：球是实心小圆——滤掉球网/栏杆/稀疏结构
  ballRingGreen: 0.45,     // 外环草地占比：球在草地上——滤掉贴身的袜子/鞋
  ballRingR: 2,            // 外环半径（细胞）
  ballMotMin: 45,          // 运动路径的平均帧差能量（球速带来高能量）
  ballIsoR: 3.0,           // 孤立度半径（细胞）
  ballSizeRef: 3,          // 打分参考尺寸（细胞）
  ballWLum: 0.30,          // 候选打分权重：亮度 / 尺寸 / 孤立度 / 运动来源
  ballWSize: 0.25,
  ballWIso: 0.20,
  ballWFg: 0.35,
  ballWhiteCap: 0.45,      // 外观路径打分上限：不能仅凭外观新锁（< ballFreshMin）
  ballMinConf: 0.12,       // 球置信度门限
  ballFreshMin: 0.50,      // 无历史轨迹时的新锁门限（必须带运动证据）
  // ⑥ 跟踪
  trackGate: 0.10,         // 跟踪关联门限（归一化距离）
  trackBonus: 0.45,        // 连续性加分（门限内按距离衰减）
  trackWhiteMs: 1500,      // 纯外观续命时限：超过这么久没有运动证据 → 丢弃
                           // （防锁在中圈弧线/白线等静止亮斑上——它们永远不是前景）
  trackCoastMs: 900,       // 丢失后外推（惯性）时长
  coastDecay: 0.85,        // 每次丢失的置信度衰减
  velEase: 0.35,           // 球速 EMA
  protectR: 2.2,           // 动态物体保护半径：球轨迹邻域不学进背景（静止球才存活）
  // ① 球场分割
  fieldGreenMargin: 16,    // g - max(r,b) 超过即绿
  fieldLumMin: 28, fieldLumMax: 215,
  fieldMinRatio: 0.12,     // 绿色占比低于此 → 放弃分割（特写等），退回全画面
  // ② 球门识别
  goalLuma: 165,           // 白
  goalSatMax: 55,          // 低饱和
  goalMinRunH: 0.25,       // 横向白段最短长度（占宽）
  goalMinRunV: 0.30,       // 纵向白段最短长度（占高）
  goalMinThick: 3,         // 成组最小厚度（细胞）——滤掉薄门线
  goalThickRef: 0.08,      // 厚度参考（占短边），够厚才给满置信度
  goalMinConf: 0.25,       // 球门置信度门限
  goalMemMs: 4000,         // 球门记忆时长（镜头平移后仍能预测球→门）
  // ③ 人员识别
  pMinCells: 5, pMaxCells: 260,     // 球员细胞数范围（128×72 下低清源一人仅 5~110，门限放宽到 5）
  pAspectMin: 0.85, pAspectMax: 7,  // 高/宽比（人竖着长）
  pFillMin: 0.35,                   // 填充率：人是实心块——滤掉球网/栏杆/阴影等稀疏结构
  pBboxPad: 2,                      // 只在球场包围盒外扩几格内找人（排除看台）
  pMax: 14,
  // ⑤ 行为
  shotSpeed: 0.55,         // 球速（归一化/秒）超过 → 射门
  shotHorizon: 1.4,        // 球→门预测轨迹时长（秒）
  leaveR: 0.09,            // 球离持球者脚超过 → 「球离开人往门去」
  velEase: 0.35,           // 速度 EMA
  // ⑥ 构图
  padFrac: 0.10,           // 组合包围盒外扩（占画面比例）
  fitMargin: 0.06,         // 拟合时四边预留
  zoomDead: 0.05,          // 倍率死区（防抖动）
  maxAutoZoom: 2.2,        // 自动构图倍率上限
  // ⑦ 相机 / 实时采样
  sampleMs: 150,           // 实时采样节流
  emaLive: 0.28,           // 实时目标点 EMA
  liveWeight: 0.35,        // 实时采样对预读轨迹的修正权重
  liveFadeMs: 600,         // 实时目标点过期时间
  posEase: 0.12,           // 位置缓动（每 16.7ms 帧的比例）
  zoomEase: 0.10,          // 缩放缓动
  calmMs: 900,             // 无目标多久后开始回中
  calmEase: 0.02,          // 回中缓动
  minMagZoom: 1.25,        // 放大镜最低倍率
  // 预读
  prereadStep: 0.25,       // 预读步进（秒）
  prereadMaxSec: 10,       // 单段预读覆盖时长上限
  prereadBudget: 2600,     // 单段预读时间预算（ms）
  prereadSeekMs: 400       // 预读单点 seek 超时
};

/** 平滑相机：x/y/zoom 是显示值（缓动中），tx/ty/tz 是目标值 */
var cam = {
  x: 0.5, y: 0.5, tx: 0.5, ty: 0.5,
  zoom: 1, tz: 1,
  manual: false,               // 双指临时接管，松手 1 秒后恢复自动
  track: null,                 // 预读轨迹 [{t,x,y,zoom}]（t=段内相对秒）
  live: null, liveAt: 0,       // 实时目标点（与轨迹混合）
  canvas: null, ctx: null,
  prevRGB: null, scratch: null, hasPrev: false,
  goalMem: null, goalMemAt: 0,     // 球门跨帧记忆
  lastSample: 0, lastMove: 0, lastFrame: 0,
  lx: -1, ly: -1, lz: -1       // 已写入 transform 的值（跳过无变化写入）
};
var scene = null;              // 最近一次分析结果（对象+坐标+行为）
var sceneAt = 0;

function camInit() {
  cam.canvas = document.createElement('canvas');
  cam.canvas.width = FOCUS_CFG.W;
  cam.canvas.height = FOCUS_CFG.H;
  try { cam.ctx = cam.canvas.getContext('2d'); } catch (e) {}
  var n = FOCUS_CFG.W * FOCUS_CFG.H;
  if (!cam.prevRGB || cam.prevRGB.length !== n * 3) cam.prevRGB = new Uint8ClampedArray(n * 3);
}

/** 分析用缓冲（lum/diff/mask/连通域栈/背景模型），懒分配 */
function camScratch() {
  var n = FOCUS_CFG.W * FOCUS_CFG.H;
  if (cam.scratch && cam.scratch.n === n) return cam.scratch;
  cam.scratch = {
    n: n,
    lum: new Float32Array(n), diff: new Float32Array(n),
    mask: new Uint8Array(n), mask2: new Uint8Array(n), wmask: new Uint8Array(n),
    protect: new Uint8Array(n), fg: new Uint8Array(n),
    stack: new Int32Array(n), bg: bgModel(n)
  };
  return cam.scratch;
}

/** 双指是否临时接管焦点（true=手动，false=恢复自动跟焦） */
function camManual(on) {
  cam.manual = !!on;
  cam.lastMove = performance.now();
}

/** transform 作用视口：分屏时是放大镜，全屏时是主画面 */
function camViewport() {
  var c = activeClip();
  if (c && isSplit() && c.magview) {
    return { w: c.magview.clientWidth || 1, h: c.magview.clientHeight || 1 };
  }
  if (c) {
    var v = c.visibleVideo();
    if (v) return { w: v.clientWidth || 1, h: v.clientHeight || 1 };
  }
  return { w: window.innerWidth || 1, h: window.innerHeight || 1 };
}

/* ---------- 帧间运动（供 analyzeScene 与预读共用） ----------
   亮度差 ∪ 色度差（减 6 的压缩噪声偏置）取大：
   同亮度的球衣/草皮互换（红衣 vs 绿草亮度接近）也能被发现。
   wantDiff=false 时只更新基准缓冲不出运动（硬切后第一帧用），
   基准缓冲始终被更新，避免第二帧拿着上一个画面的残影做差。 */
function frameMotion(px, prevRGB, lum, diff, n, wantDiff) {
  for (var i = 0; i < n; i++) {
    var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    lum[i] = r * 0.299 + g * 0.587 + b * 0.114;
    var j = i * 3;
    if (wantDiff && prevRGB) {
      var pr = prevRGB[j], pg = prevRGB[j + 1], pb = prevRGB[j + 2];
      var dl = Math.abs(lum[i] - (pr * 0.299 + pg * 0.587 + pb * 0.114));
      var dr = Math.abs(r - pr), dg = Math.abs(g - pg), db = Math.abs(b - pb);
      var mx = dr > dg ? dr : dg;
      if (db > mx) mx = db;
      diff[i] = Math.max(dl, mx > 6 ? mx - 6 : 0);
    } else {
      diff[i] = 0;
    }
    if (prevRGB) { prevRGB[j] = r; prevRGB[j + 1] = g; prevRGB[j + 2] = b; }
  }
}

/* ---------- ① 球场分割 ----------
   输入整帧 RGBA；输出绿色 mask + 包围盒 + 占比。
   夜场/柔光下草地饱和度低，阈值放宽；占比过低（特写）则放弃分割。 */
function segField(px, w, h, cfg, mask) {
  var n = w * h, cnt = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = y * w + x;
      var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      var lum = r * 0.299 + g * 0.587 + b * 0.114;
      var isF = (g - (r > b ? r : b) > cfg.fieldGreenMargin) &&
                lum > cfg.fieldLumMin && lum < cfg.fieldLumMax;
      mask[i] = isF ? 1 : 0;
      if (isF) {
        cnt++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  var ratio = cnt / n;
  if (ratio < cfg.fieldMinRatio || x1 < 0) return { ok: false, mask: null, ratio: ratio };
  return { ok: true, mask: mask, x0: x0, y0: y0, x1: x1, y1: y1, ratio: ratio };
}

/* ---------- ② 球门识别 ----------
   白色低饱和的「厚带」：逐行/逐列找最长白色连续段（门框+网是一大块亮区），
   连续多行/列成组且有厚度才算球门——薄薄一条门线、小白点、记分牌都会被
   长度/厚度门槛滤掉。输出归一化坐标的球门对象。 */
function detectGoal(px, w, h, cfg) {
  function isWhite(i) {
    var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    return (r * 0.299 + g * 0.587 + b * 0.114) > cfg.goalLuma && (mx - mn) < cfg.goalSatMax;
  }
  var best = null;
  // 横向带：逐行最长白段 ≥ 0.25w，连续 ≥3 行成组
  var minRunH = Math.max(4, Math.round(w * cfg.goalMinRunH));
  var rowRuns = [];
  for (var y = 0; y < h; y++) {
    var run = 0, rs = 0, bl = 0, bs = 0;
    for (var x = 0; x < w; x++) {
      if (isWhite(y * w + x)) {
        if (run === 0) rs = x;
        run++;
        if (run > bl) { bl = run; bs = rs; }
      } else run = 0;
    }
    rowRuns.push(bl >= minRunH ? { s: bs, l: bl } : null);
  }
  var i = 0;
  while (i < h) {
    if (!rowRuns[i]) { i++; continue; }
    var j = i;
    while (j + 1 < h && rowRuns[j + 1]) j++;
    var thick = j - i + 1;
    if (thick >= cfg.goalMinThick) {
      var x0 = 1e9, x1 = -1;
      for (var k = i; k <= j; k++) {
        if (rowRuns[k].s < x0) x0 = rowRuns[k].s;
        if (rowRuns[k].s + rowRuns[k].l - 1 > x1) x1 = rowRuns[k].s + rowRuns[k].l - 1;
      }
      var conf = (x1 - x0 + 1) / w * Math.min(1, thick / (h * cfg.goalThickRef));
      if (conf >= cfg.goalMinConf && (!best || conf > best.conf)) {
        best = {
          side: 'h', conf: conf,
          x: x0 / (w - 1), y: i / (h - 1),
          w: (x1 - x0 + 1) / (w - 1), h: (j - i + 1) / (h - 1)
        };
      }
    }
    i = j + 1;
  }
  // 纵向带（侧面机位/龙门朝侧面）：逐列最长白段 ≥ 0.3h
  var minRunV = Math.max(4, Math.round(h * cfg.goalMinRunV));
  var colRuns = [];
  for (var x2 = 0; x2 < w; x2++) {
    var run2 = 0, rs2 = 0, bl2 = 0, bs2 = 0;
    for (var y2 = 0; y2 < h; y2++) {
      if (isWhite(y2 * w + x2)) {
        if (run2 === 0) rs2 = y2;
        run2++;
        if (run2 > bl2) { bl2 = run2; bs2 = rs2; }
      } else run2 = 0;
    }
    colRuns.push(bl2 >= minRunV ? { s: bs2, l: bl2 } : null);
  }
  var m = 0;
  while (m < w) {
    if (!colRuns[m]) { m++; continue; }
    var n2 = m;
    while (n2 + 1 < w && colRuns[n2 + 1]) n2++;
    var thick2 = n2 - m + 1;
    if (thick2 >= cfg.goalMinThick) {
      var y0 = 1e9, y1 = -1;
      for (var k2 = m; k2 <= n2; k2++) {
        if (colRuns[k2].s < y0) y0 = colRuns[k2].s;
        if (colRuns[k2].s + colRuns[k2].l - 1 > y1) y1 = colRuns[k2].s + colRuns[k2].l - 1;
      }
      var conf2 = (y1 - y0 + 1) / h * Math.min(1, thick2 / (w * cfg.goalThickRef));
      if (conf2 >= cfg.goalMinConf && (!best || conf2 > best.conf)) {
        best = {
          side: 'v', conf: conf2,
          x: m / (w - 1), y: y0 / (h - 1),
          w: (n2 - m + 1) / (w - 1), h: (y1 - y0 + 1) / (h - 1)
        };
      }
    }
    m = n2 + 1;
  }
  return best;
}

/* ---------- ③ 人员识别 ----------
   非球场 + 球场包围盒内（排除看台/广告牌）→ 连通域 → 合并上下断开的同一部件
   → 按细胞数与高宽比过滤（球太小、看台/广告牌太大/太宽都会被滤掉）。
   输出每人：中心、包围盒、脚底位置（归一化）、运动细胞数。 */
function detectPeople(px, field, diff, w, h, cfg, mask, stack) {
  var n = w * h, i;
  if (!field.ok || !field.mask) return [];
  for (i = 0; i < n; i++) mask[i] = field.mask[i] ? 0 : 1;
  // 只在球场包围盒（外扩 pBboxPad 格）内找人：看台/广告牌在草皮区之外
  var pad = cfg.pBboxPad;
  var bx0 = Math.max(0, field.x0 - pad), by0 = Math.max(0, field.y0 - pad);
  var bx1 = Math.min(w - 1, field.x1 + pad), by1 = Math.min(h - 1, field.y1 + pad);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) mask[y * w + x] = 0;
    }
  }
  var comps = [];
  for (var start = 0; start < n; start++) {
    if (!mask[start]) continue;
    var sp = 0;
    stack[sp++] = start; mask[start] = 0;
    var x0 = w, y0 = h, x1 = -1, y1 = -1, cells = 0, motion = 0;
    while (sp > 0) {
      var idx = stack[--sp];
      var px2 = idx % w, py = (idx / w) | 0;
      cells++;
      if (diff[idx] > cfg.diffThresh) motion++;
      if (px2 < x0) x0 = px2;
      if (px2 > x1) x1 = px2;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (px2 > 0 && mask[idx - 1]) { mask[idx - 1] = 0; stack[sp++] = idx - 1; }
      if (px2 < w - 1 && mask[idx + 1]) { mask[idx + 1] = 0; stack[sp++] = idx + 1; }
      if (py > 0 && mask[idx - w]) { mask[idx - w] = 0; stack[sp++] = idx - w; }
      if (py < h - 1 && mask[idx + w]) { mask[idx + w] = 0; stack[sp++] = idx + w; }
    }
    comps.push({ x0: x0, y0: y0, x1: x1, y1: y1, cells: cells, motion: motion });
  }
  // 合并：只合「上下断开、横向重叠」的部件（同一球员的头/身/腿）；
  // 左右并排的球员不合并，结果不超过单人尺寸上限
  function mergePass() {
    for (var a = 0; a < comps.length; a++) {
      for (var b = a + 1; b < comps.length; b++) {
        var A = comps[a], B = comps[b];
        if (A.cells + B.cells > cfg.pMaxCells) continue;
        var xOver = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
        var minW = Math.min(A.x1 - A.x0, B.x1 - B.x0) + 1;
        if (xOver < minW * 0.5) continue;
        var vGap = Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1);
        if (vGap > 2) continue;
        A.x0 = Math.min(A.x0, B.x0); A.x1 = Math.max(A.x1, B.x1);
        A.y0 = Math.min(A.y0, B.y0); A.y1 = Math.max(A.y1, B.y1);
        A.cells += B.cells; A.motion += B.motion;
        comps.splice(b, 1);
        return true;
      }
    }
    return false;
  }
  while (mergePass()) {}
  var out = [];
  for (i = 0; i < comps.length; i++) {
    var c = comps[i];
    var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (c.cells < cfg.pMinCells || c.cells > cfg.pMaxCells) continue;
    var asp = bh / bw;
    if (asp < cfg.pAspectMin || asp > cfg.pAspectMax) continue;
    if (c.cells / (bw * bh) < cfg.pFillMin) continue;   // 稀疏结构（球网/栏杆/阴影）不是人
    var cx = (c.x0 + c.x1) / 2 / (w - 1), cy = (c.y0 + c.y1) / 2 / (h - 1);
    out.push({
      cx: cx, cy: cy,
      x: c.x0 / (w - 1), y: c.y0 / (h - 1), w: bw / (w - 1), h: bh / (h - 1),
      feetX: cx, feetY: c.y1 / (h - 1),
      cells: c.cells, motion: c.motion
    });
  }
  // 运动的球员排在前面（跟焦关心活跃者）
  out.sort(function (p, q) {
    if (q.motion !== p.motion) return q.motion - p.motion;
    return q.cells - p.cells;
  });
  if (out.length > cfg.pMax) out.length = cfg.pMax;
  return out;
}

/* ---------- ④ 背景模型（Wren 式运行高斯，Pfinder 经典背景减除） ----------
   每细胞维护 RGB 三通道均值/方差；前景 = 任通道 |Δ| > max(bgK·σ, bgMinDiff)。
   预热期（前 bgWarmFrames 帧）快速学习整帧；稳定期只学「非前景且非动态
   物体保护」的细胞——跑动中的球员不会被吸进背景。 */
function bgModel(n) {
  return {
    muR: new Float32Array(n), muG: new Float32Array(n), muB: new Float32Array(n),
    vR: new Float32Array(n), vG: new Float32Array(n), vB: new Float32Array(n),
    age: new Uint16Array(n),   // 连续前景帧数（陈旧前景 → 慢吸收，清理「洞」/光照漂移）
    frames: 0
  };
}
function bgReset(bg) { if (bg) { bg.frames = 0; bg.age.fill(0); } }

/** 更新背景并输出前景掩码（fg: 0/1，就地）。protect: 动态物体保护（1=不学）。
 *  学习规则：
 *  - 只学「非前景」的细胞（预热期也只学静止背景）→ 运动物体从第 1 帧起保持前景；
 *  - 连续前景超过 bgStaleFrames 的细胞按 bgStaleRate 慢吸收
 *    → 球走后留下的「洞」几秒内被清掉，镜头平移后背景重新收敛；
 *  - protect 优先于一切 → 被跟踪的球即使停住也永远是前景（死球不掉锁）。 */
function bgUpdate(bg, px, cfg, fg, protect) {
  var n = fg.length;
  var warm = bg.frames < cfg.bgWarmFrames;
  var rate = warm ? cfg.bgWarmRate : cfg.bgLearnRate;
  var k = cfg.bgK, minD = cfg.bgMinDiff, iv = cfg.bgInitVar;
  var staleFrames = cfg.bgStaleFrames, staleRate = cfg.bgStaleRate;
  var first = (bg.frames === 0);
  var muR = bg.muR, muG = bg.muG, muB = bg.muB;
  var vR = bg.vR, vG = bg.vG, vB = bg.vB;
  var age = bg.age;
  for (var i = 0; i < n; i++) {
    var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (first) {
      muR[i] = r; muG[i] = g; muB[i] = b;
      vR[i] = iv; vG[i] = iv; vB[i] = iv;
      fg[i] = 0;
      continue;
    }
    var dr = r - muR[i], dg = g - muG[i], db = b - muB[i];
    var tR = Math.sqrt(vR[i]) * k; if (tR < minD) tR = minD;
    var tG = Math.sqrt(vG[i]) * k; if (tG < minD) tG = minD;
    var tB = Math.sqrt(vB[i]) * k; if (tB < minD) tB = minD;
    var isF = (dr > tR || dr < -tR || dg > tG || dg < -tG || db > tB || db < -tB) ? 1 : 0;
    fg[i] = isF;
    if (isF) { if (age[i] < 60000) age[i]++; } else age[i] = 0;
    var stale = age[i] > staleFrames;
    if (!protect[i] && (!isF || stale)) {
      var lr = stale ? staleRate : rate;
      muR[i] += dr * lr; muG[i] += dg * lr; muB[i] += db * lr;
      vR[i] += (dr * dr - vR[i]) * lr;
      vG[i] += (dg * dg - vG[i]) * lr;
      vB[i] += (db * db - vB[i]) * lr;
    }
  }
  bg.frames++;
}

/** 动态物体保护：上一帧球轨迹的邻域标记为「不学进背景」。
 *  否则球一旦静止（停球/摆球）就会被背景吸收、从此消失。 */
function bgProtect(protect, bt, w, h, cfg) {
  var n = w * h;
  for (var i = 0; i < n; i++) protect[i] = 0;
  if (!bt || bt.conf <= 0) return;
  var r = Math.ceil(cfg.protectR);
  var cx = Math.round(bt.x * (w - 1)), cy = Math.round(bt.y * (h - 1));
  var r2 = cfg.protectR * cfg.protectR;
  for (var y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= h) continue;
    for (var x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= w) continue;
      var dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) protect[y * w + x] = 1;
    }
  }
}

/* ---------- ④ 前景物体（连通域） ----------
   输入 bgUpdate 的前景掩码（就地消耗）+ 帧差能量；
   输出物体列表（细胞数 + 包围盒 + 运动能量和）。 */
function fgObjects(fg, diff, w, h, cfg, stack) {
  var n = w * h, comps = [];
  for (var start = 0; start < n; start++) {
    if (!fg[start]) continue;
    var sp = 0;
    stack[sp++] = start; fg[start] = 0;
    var x0 = w, y0 = h, x1 = -1, y1 = -1, cells = 0, mot = 0;
    while (sp > 0) {
      var idx = stack[--sp];
      var cx = idx % w, cy = (idx / w) | 0;
      cells++;
      mot += diff[idx];
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
      if (cx > 0 && fg[idx - 1]) { fg[idx - 1] = 0; stack[sp++] = idx - 1; }
      if (cx < w - 1 && fg[idx + 1]) { fg[idx + 1] = 0; stack[sp++] = idx + 1; }
      if (cy > 0 && fg[idx - w]) { fg[idx - w] = 0; stack[sp++] = idx - w; }
      if (cy < h - 1 && fg[idx + w]) { fg[idx + w] = 0; stack[sp++] = idx + w; }
    }
    if (cells >= cfg.objMinCells) {
      comps.push({ x0: x0, y0: y0, x1: x1, y1: y1, cells: cells, mot: mot });
      if (comps.length > 400) break;   // 安全上限（镜头剧变时的噪声爆发）
    }
  }
  return comps;
}

/* ---------- ⑤ 足球候选 ----------
   低清源（854×356）里球只有 1~3 个细胞，白袜/球网/白线/鞋都是亮斑——
   所以运动证据是主判据，外观只用于「续跟踪」：
   ① 前景物体：小 + 实心（填充率）+ 在草地上（外环草地占比）+ 高运动能量；
   ② 球场内亮斑（外观）：条件更严，且打分封顶低于新锁门限——
      只能给已有轨迹续命（球停了），不能仅凭亮斑新锁。
   同一位置的多来源打分合并，按分数排序。 */
function ballCandidates(px, lum, diff, objs, field, w, h, cfg, wmask, stack) {
  var out = [];
  var margin = Math.round(w * 0.03);
  function inField(c) {
    if (!field.ok) return true;
    return c.x0 >= field.x0 - margin && c.x1 <= field.x1 + margin &&
           c.y0 >= field.y0 - margin && c.y1 <= field.y1 + margin;
  }
  /** 外环草地占比：球在草地上；贴身袜子/鞋的外环是人（非绿） */
  function ringGreen(c) {
    if (!field.ok || !field.mask) return 1;
    var r = cfg.ballRingR;
    var x0 = c.x0 - r, x1 = c.x1 + r, y0 = c.y0 - r, y1 = c.y1 + r;
    var tot = 0, grn = 0;
    for (var y = y0; y <= y1; y++) {
      if (y < 0 || y >= h) continue;
      for (var x = x0; x <= x1; x++) {
        if (x < 0 || x >= w) continue;
        if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) continue;
        tot++;
        if (field.mask[y * w + x]) grn++;
      }
    }
    return tot ? grn / tot : 1;
  }
  function nearCount(c) {   // 包围盒间距 ≤ ballIsoR 的其他物体数
    var cnt = 0;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (o === c) continue;
      var gx = Math.max(0, Math.max(o.x0 - c.x1, c.x0 - o.x1));
      var gy = Math.max(0, Math.max(o.y0 - c.y1, c.y0 - o.y1));
      if (Math.sqrt(gx * gx + gy * gy) <= cfg.ballIsoR) cnt++;
    }
    return cnt;
  }
  function meanLum(c) {
    var s = 0, cnt = 0;
    for (var y = c.y0; y <= c.y1; y++) {
      for (var x = c.x0; x <= c.x1; x++) { s += lum[y * w + x]; cnt++; }
    }
    return s / cnt;
  }
  function push(c, src) {
    var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (c.cells < cfg.ballMinCells || c.cells > cfg.ballMaxCells) return;
    var asp = bh / bw;
    if (asp < cfg.ballAspectMin || asp > cfg.ballAspectMax) return;
    if (!inField(c)) return;
    if (c.cells / (bw * bh) < cfg.ballFillMin) return;      // 实心小圆（滤网/栏）
    var lm = meanLum(c);
    if (lm < (src === 'fg' ? cfg.ballLumMinFg : cfg.ballLumMin)) return;
    if (ringGreen(c) < cfg.ballRingGreen) return;           // 在草地上（滤贴身白袜）
    var nc = nearCount(c);
    var lumN = Math.min(1, lm / 235);
    var sizeFit = 1 - Math.min(1, Math.abs(c.cells - cfg.ballSizeRef) / cfg.ballSizeRef);
    var iso = 1 / (1 + nc);
    var s = cfg.ballWLum * lumN + cfg.ballWSize * sizeFit + cfg.ballWIso * iso;
    if (src === 'fg') {
      if (c.mot / c.cells < cfg.ballMotMin) return;         // 运动能量不足（微光/噪声）
      s += cfg.ballWFg;
    } else {
      s = Math.min(s, cfg.ballWhiteCap);                    // 仅凭外观不许新锁
    }
    out.push({
      x: (c.x0 + c.x1) / 2 / (w - 1), y: (c.y0 + c.y1) / 2 / (h - 1),
      score: Math.min(1, s), src: src, cells: c.cells,
      bx: c.x0 / (w - 1), by: c.y0 / (h - 1), bw: bw / (w - 1), bh: bh / (h - 1)
    });
  }
  // ① 前景物体（运动证据）
  for (var i = 0; i < objs.length; i++) push(objs[i], 'fg');
  // ② 球场内亮斑（外观，续跟踪用）：亮细胞 → 连通域
  if (field.ok) {
    var bx0 = Math.max(0, field.x0 - margin), by0 = Math.max(0, field.y0 - margin);
    var bx1 = Math.min(w - 1, field.x1 + margin), by1 = Math.min(h - 1, field.y1 + margin);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i2 = y * w + x;
        var inside = x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
        wmask[i2] = (inside && lum[i2] >= cfg.ballLumMin) ? 1 : 0;
      }
    }
    for (var s2 = 0; s2 < w * h; s2++) {
      if (!wmask[s2]) continue;
      var sp = 0;
      stack[sp++] = s2; wmask[s2] = 0;
      var x0 = w, y0 = h, x1 = -1, y1 = -1, cells = 0;
      while (sp > 0) {
        var idx = stack[--sp];
        var cx = idx % w, cy = (idx / w) | 0;
        cells++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        if (cx > 0 && wmask[idx - 1]) { wmask[idx - 1] = 0; stack[sp++] = idx - 1; }
        if (cx < w - 1 && wmask[idx + 1]) { wmask[idx + 1] = 0; stack[sp++] = idx + 1; }
        if (cy > 0 && wmask[idx - w]) { wmask[idx - w] = 0; stack[sp++] = idx - w; }
        if (cy < h - 1 && wmask[idx + w]) { wmask[idx + w] = 0; stack[sp++] = idx + w; }
      }
      push({ x0: x0, y0: y0, x1: x1, y1: y1, cells: cells }, 'white');
    }
  }
  // 合并同一位置的多来源（<2 细胞距离）：运动球=前景+亮斑双来源，天然高分
  var merged = [];
  for (var a = 0; a < out.length; a++) {
    var A = out[a];
    var dup = false;
    for (var b = 0; b < merged.length; b++) {
      var B = merged[b];
      if (Math.abs(A.x - B.x) * w < 2 && Math.abs(A.y - B.y) * h < 2) {
        B.score = Math.min(1, B.score + A.score);
        if (A.src === 'fg') B.src = 'fg';
        dup = true;
        break;
      }
    }
    if (!dup) merged.push(A);
  }
  merged.sort(function (p, q) { return q.score - p.score; });
  return merged;
}

/* ---------- ⑥ 球跟踪 ----------
   最近邻 + 速度预测 + 门限内连续性加分；丢失则按速度外推（惯性），
   超过 trackCoastMs（自最后一次真实检测起算）才判定丢失。
   无历史轨迹时按 fresh 门限新锁，防袜子/白线标记点误锁。
   输出平滑后的球轨迹点（含速度）。seenAt = 最后一次真实检测的时间。 */
function trackBall(prev, cands, now, dt, cfg) {
  function none(miss, seenAt) {
    return {
      x: prev ? prev.x : 0.5, y: prev ? prev.y : 0.5, vx: 0, vy: 0,
      conf: 0, at: now, seenAt: seenAt, miss: miss, coast: false
    };
  }
  if (!cands.length) {
    if (prev && prev.conf > 0 && now - prev.seenAt < cfg.trackCoastMs) {
      return {
        x: prev.x + prev.vx * dt, y: prev.y + prev.vy * dt,
        vx: prev.vx, vy: prev.vy,
        conf: prev.conf * cfg.coastDecay, at: now, seenAt: prev.seenAt,
        miss: (prev.miss || 0) + 1, coast: true
      };
    }
    return none((prev ? prev.miss || 0 : 0) + 1, prev ? prev.seenAt : now);
  }
  var live = !!(prev && prev.conf > 0);
  var px_ = live ? prev.x + prev.vx * dt : 0, py_ = live ? prev.y + prev.vy * dt : 0;
  var best = null, bestS = -1;
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    var s = c.score;
    if (live) {
      var d = Math.sqrt((c.x - px_) * (c.x - px_) + (c.y - py_) * (c.y - py_));
      if (d < cfg.trackGate) s += cfg.trackBonus * (1 - d / cfg.trackGate);
    }
    if (s > bestS) { bestS = s; best = c; }
  }
  if (!live && bestS < cfg.ballFreshMin) return none(0, prev ? prev.seenAt : now);
  // 纯外观续命时限：弧线/白线等静止亮斑永远不是前景，靠连续性加分也续不久
  if (live && best.src !== 'fg' && now - (prev.fgAt || 0) > cfg.trackWhiteMs) {
    return none((prev.miss || 0) + 1, prev.seenAt);
  }
  var vx = 0, vy = 0;
  if (live && dt > 0.001) {
    vx = prev.vx + ((best.x - prev.x) / dt - prev.vx) * cfg.velEase;
    vy = prev.vy + ((best.y - prev.y) / dt - prev.vy) * cfg.velEase;
  }
  return {
    x: best.x, y: best.y, vx: vx, vy: vy,
    conf: Math.min(1, bestS), at: now, seenAt: now,
    fgAt: best.src === 'fg' ? now : (prev ? prev.fgAt || 0 : 0),
    miss: 0, coast: false,
    cells: best.cells, src: best.src
  };
}

/* ---------- ⑦ 跟踪与行为 ----------
   球速（来自 trackBall 的 EMA）；离球最近的人=持球者；
   球→门预测轨迹（交点数据）；球速过阈值且方向朝门 → 射门；
   方向朝门但速度不够 → 提前布阵。 */
function sceneStep(ballR, people, goal, prev, dt, cfg, now) {
  var st = {
    ball: null, people: people, goal: goal, owner: null,
    shot: false, shotSoon: false, leave: false, traj: null, hit: null
  };
  if (ballR && ballR.conf >= cfg.ballMinConf) {
    var b = { x: ballR.x, y: ballR.y, vx: ballR.vx || 0, vy: ballR.vy || 0, conf: ballR.conf, coast: !!ballR.coast };
    if (!b.vx && !b.vy && prev && prev.ball && dt > 0.001) {
      // 兜底：调用方没给跟踪器速度时用 EMA 估速
      b.vx = prev.ball.vx + ((ballR.x - prev.ball.x) / dt - prev.ball.vx) * cfg.velEase;
      b.vy = prev.ball.vy + ((ballR.y - prev.ball.y) / dt - prev.ball.vy) * cfg.velEase;
    }
    st.ball = b;
  }
  if (st.ball && people.length) {
    var bd = 1e9, bi = -1;
    for (var p = 0; p < people.length; p++) {
      var dx = people[p].feetX - st.ball.x, dy = people[p].feetY - st.ball.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; bi = p; }
    }
    if (bi >= 0 && bd < 0.36) st.owner = people[bi];
  }
  if (st.ball && goal) {
    var sp = Math.sqrt(st.ball.vx * st.ball.vx + st.ball.vy * st.ball.vy);
    if (sp > 0.05) {
      var pts = [], hit = null;
      var steps = Math.ceil(cfg.shotHorizon / 0.08);
      for (var s = 1; s <= steps; s++) {
        var t = s * 0.08;
        var qx = st.ball.x + st.ball.vx * t, qy = st.ball.y + st.ball.vy * t;
        if (qx < -0.05 || qx > 1.05 || qy < -0.05 || qy > 1.05) break;
        pts.push({ t: t, x: qx, y: qy });
        if (qx >= goal.x && qx <= goal.x + goal.w &&
            qy >= goal.y && qy <= goal.y + goal.h) { hit = { x: qx, y: qy, t: t }; break; }
      }
      if (pts.length) st.traj = pts;
      st.hit = hit;
      if (hit) {
        st.shot = sp > cfg.shotSpeed;
        st.shotSoon = !st.shot;   // 方向已朝门但球速未起 → 提前把球人门装入画面
      }
      if ((st.shot || st.shotSoon) && st.owner) {
        var off = Math.abs(st.ball.x - st.owner.feetX) + Math.abs(st.ball.y - st.owner.feetY);
        st.leave = off > cfg.leaveR;
      }
    }
  }
  return st;
}

/* ---------- ⑥ 组合构图 ----------
   把「球 + 持球者」（射门/将射门时再加球门）组成一个对象：
   输出组合中心（画面持续对准它）+ 推荐倍率。
   装得下 → 可以放大盯局部；要缩小才装得下 → 倍率降到 1（不缩放/全景）。 */
function composeScene(st, cfg) {
  var box = null;
  function add(nx, ny) {
    if (!box) { box = { x0: nx, y0: ny, x1: nx, y1: ny }; return; }
    if (nx < box.x0) box.x0 = nx;
    if (nx > box.x1) box.x1 = nx;
    if (ny < box.y0) box.y0 = ny;
    if (ny > box.y1) box.y1 = ny;
  }
  if (st.ball) add(st.ball.x, st.ball.y);
  if (st.owner) { add(st.owner.feetX, st.owner.feetY); add(st.owner.cx, st.owner.cy); }
  if ((st.shot || st.shotSoon) && st.goal) {
    add(st.goal.x, st.goal.y);
    add(st.goal.x + st.goal.w, st.goal.y + st.goal.h);
  }
  if (!box) return null;
  var pad = cfg.padFrac;
  box.x0 = clamp(box.x0 - pad, 0, 1); box.y0 = clamp(box.y0 - pad, 0, 1);
  box.x1 = clamp(box.x1 + pad, 0, 1); box.y1 = clamp(box.y1 + pad, 0, 1);
  var bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  var m = cfg.fitMargin;
  var sFit = Math.min(1 / Math.max(1e-3, bw + 2 * m), 1 / Math.max(1e-3, bh + 2 * m));
  return {
    cx: clamp((box.x0 + box.x1) / 2, 0, 1),
    cy: clamp((box.y0 + box.y1) / 2, 0, 1),
    box: box,
    zoom: clamp(sFit, 1, cfg.maxAutoZoom),
    sFit: sFit,
    zoomOut: sFit < 0.98,     // 需要缩小（全景都装不下组合）
    hasBall: !!st.ball
  };
}

/* ---------- 统一入口：两帧 → 完整场景 ----------
   输入整帧 RGBA + 基准 RGB 缓冲（prevRGB，会被就地更新）+ 分析缓冲 sc
   （含背景模型 bg / 前景掩码 fg / 亮斑掩码 wmask / 动态保护 protect）；
   输出全部子算法结果（对象+坐标+行为+画面建议）。
   wantDiff=false = 硬切后第一帧（只建基准不出运动）。
   prevGoal：上一帧的球门（本帧没检测到时沿用，镜头平移中预测不断档）。 */
function analyzeScene(px, prevRGB, sc, w, h, cfg, prevScene, now, dt, prevGoal, wantDiff) {
  var n = w * h;
  frameMotion(px, prevRGB, sc.lum, sc.diff, n, wantDiff !== false);
  // 动态物体保护：上一帧球轨迹邻域不学进背景（静止球才不会被吸收消失）
  bgProtect(sc.protect, prevScene && prevScene.ballTrack, w, h, cfg);
  bgUpdate(sc.bg, px, cfg, sc.fg, sc.protect);
  var field = segField(px, w, h, cfg, sc.mask);
  var goal = detectGoal(px, w, h, cfg) || prevGoal || null;
  var people = detectPeople(px, field, sc.diff, w, h, cfg, sc.mask2, sc.stack);
  var objs = fgObjects(sc.fg, sc.diff, w, h, cfg, sc.stack);
  var cands = ballCandidates(px, sc.lum, sc.diff, objs, field, w, h, cfg, sc.wmask, sc.stack);
  var bt = trackBall(prevScene && prevScene.ballTrack, cands, now, dt, cfg);
  var st = sceneStep(bt, people, goal, prevScene, dt, cfg, now);
  st.field = field.ok
    ? { x: field.x0 / (w - 1), y: field.y0 / (h - 1), w: (field.x1 - field.x0) / (w - 1), h: (field.y1 - field.y0) / (h - 1), ratio: field.ratio }
    : null;
  st.goalFresh = !!goal && goal !== prevGoal;   // 本帧新检测到（非沿用记忆）
  st.ballTrack = bt;
  st.compose = composeScene(st, cfg);
  st.at = now;
  return st;
}

/** 实时采样（6.7Hz）：跑完整管线，产出 scene 与实时目标点 */
function camSampleLive(now) {
  if (!SETTINGS.zoomOn || cam.manual) return;
  var c = activeClip();
  if (!c || !c.playing || c.busy || c.idx < 0) return;
  var v = c.visibleVideo();
  if (!v || v.readyState < 2 || !v.videoWidth) return;
  if (now - cam.lastSample < FOCUS_CFG.sampleMs) return;
  cam.lastSample = now;
  var img;
  try { cam.ctx.drawImage(v, 0, 0, FOCUS_CFG.W, FOCUS_CFG.H); } catch (e) { return; }
  try { img = cam.ctx.getImageData(0, 0, FOCUS_CFG.W, FOCUS_CFG.H); } catch (e) { return; }
  var n = FOCUS_CFG.W * FOCUS_CFG.H;
  if (!cam.prevRGB || cam.prevRGB.length !== n * 3) cam.prevRGB = new Uint8ClampedArray(n * 3);
  var sc = camScratch();
  var dt = scene ? clamp((now - sceneAt) / 1000, 0.016, 0.5) : 0.1;
  // 球门记忆：本帧没检测到但不久前检测到 → 沿用（镜头平移中预测不断档）
  var memGoal = (cam.goalMem && now - cam.goalMemAt < FOCUS_CFG.goalMemMs) ? cam.goalMem : null;
  // 硬切后第一帧只重建基准帧（不出 diff），避免把质心拉飞
  scene = analyzeScene(img.data, cam.prevRGB, sc,
    FOCUS_CFG.W, FOCUS_CFG.H, FOCUS_CFG, scene, now, dt, memGoal, cam.hasPrev);
  cam.hasPrev = true;
  sceneAt = now;
  if (scene.goal) { cam.goalMem = scene.goal; cam.goalMemAt = now; }
  var comp = scene.compose;
  if (comp && comp.hasBall) {
    if (!cam.live) cam.live = { x: comp.cx, y: comp.cy };
    else {
      cam.live.x += (comp.cx - cam.live.x) * FOCUS_CFG.emaLive;
      cam.live.y += (comp.cy - cam.live.y) * FOCUS_CFG.emaLive;
    }
    cam.liveAt = now;
  }
  algoDraw(c);
}

/* ---------- ⑦ 平滑相机 ---------- */

/** 轨迹插值：t 为段内相对秒；超出轨迹末端 0.5s 交还实时采样（返回 null） */
function camTrackAt(t) {
  var tr = cam.track;
  if (!tr || !tr.length) return null;
  if (t <= tr[0].t) return tr[0];
  var last = tr[tr.length - 1];
  if (t > last.t + 0.5) return null;
  for (var i = 1; i < tr.length; i++) {
    if (tr[i].t >= t) {
      var a = tr[i - 1], b = tr[i];
      var k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      var z = null;
      if (a.zoom != null && b.zoom != null) z = a.zoom + (b.zoom - a.zoom) * k;
      else if (b.zoom != null) z = b.zoom;
      else if (a.zoom != null) z = a.zoom;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, zoom: z };
    }
  }
  return last;
}

/** 自动构图倍率：实时场景优先，其次预读轨迹；都没有 → null（用用户偏好） */
function camAutoZoom(now, c) {
  if (!SETTINGS.zoomOn || cam.manual) return null;
  if (scene && scene.compose && now - sceneAt < 900) return scene.compose.zoom;
  if (cam.track && c && c.playing && c.idx >= 0) {
    var seg = c.segs[c.idx], v = c.visibleVideo();
    if (seg && v) {
      var tp = camTrackAt(v.currentTime - seg.start);
      if (tp && tp.zoom != null) return tp.zoom;
    }
  }
  return null;
}

/** 换段/换场：丢弃上一帧避免硬切大 diff；有预读轨迹则直接落到轨迹起点 */
function camCut(t0) {
  cam.hasPrev = false;   // 下一帧只重建基准，不出 diff
  bgReset(cam.scratch && cam.scratch.bg);   // 换场：背景模型重新预热
  cam.live = null;
  cam.goalMem = null;    // 换场后球门需重新识别
  var p = (cam.track && cam.track.length) ? camTrackAt(t0 || 0) : null;
  if (!p && cam.track && cam.track.length && (t0 || 0) <= cam.track[0].t) p = cam.track[0];
  cam.x = cam.tx = p ? clamp(p.x, 0, 1) : 0.5;
  cam.y = cam.ty = p ? clamp(p.y, 0, 1) : 0.5;
  cam.lastMove = performance.now();
  camApply();
}

/** 每帧：合成目标点（预读轨迹 + 实时修正）→ dt 归一化缓动 → 落 transform */
function camTick(now) {
  var dt = cam.lastFrame ? clamp(now - cam.lastFrame, 0, 100) : 16.7;
  cam.lastFrame = now;
  var c = activeClip();
  // 目标倍率：手动接管=用户倍率；自动构图=算法推荐（1~上限）；
  // 算法无意见时回落到用户偏好倍率
  var cap = Math.max(SETTINGS.zoom, FOCUS_CFG.maxAutoZoom);
  if (!SETTINGS.zoomOn) cam.tz = isSplit() ? FOCUS_CFG.minMagZoom : 1;
  else if (cam.manual) cam.tz = SETTINGS.zoom;
  else {
    var az = camAutoZoom(now, c);
    cam.tz = (az == null) ? SETTINGS.zoom : clamp(az, 1, cap);
    if (isSplit()) cam.tz = Math.max(cam.tz, FOCUS_CFG.minMagZoom);
  }
  // 目标位置：预读轨迹插值 + 实时采样按 liveWeight 修正
  var live = !cam.manual && c && c.playing && !c.busy && c.idx >= 0;
  if (live) {
    var tgt = null;
    var seg = c.segs[c.idx], v = c.visibleVideo();
    var tp = (cam.track && seg && v) ? camTrackAt(v.currentTime - seg.start) : null;
    var lp = (cam.live && now - cam.liveAt < FOCUS_CFG.liveFadeMs) ? cam.live : null;
    if (tp && lp) {
      tgt = {
        x: tp.x + (lp.x - tp.x) * FOCUS_CFG.liveWeight,
        y: tp.y + (lp.y - tp.y) * FOCUS_CFG.liveWeight
      };
    } else if (tp) tgt = tp;
    else if (lp) tgt = lp;
    if (tgt) {
      cam.tx = clamp(tgt.x, 0, 1);
      cam.ty = clamp(tgt.y, 0, 1);
      cam.lastMove = now;
    } else if (now - cam.lastMove > FOCUS_CFG.calmMs) {
      // 长时间没有球/组合：缓慢回中，避免镜头僵住
      cam.tx = 0.5; cam.ty = 0.5;
    }
  }
  // dt 归一化指数缓动：掉帧时同样时间到达，动画才平滑
  var ease = (now - cam.lastMove > FOCUS_CFG.calmMs) ? FOCUS_CFG.calmEase : FOCUS_CFG.posEase;
  var k = 1 - Math.pow(1 - ease, dt / 16.7);
  cam.x += (cam.tx - cam.x) * k;
  cam.y += (cam.ty - cam.y) * k;
  var kz = 1 - Math.pow(1 - FOCUS_CFG.zoomEase, dt / 16.7);
  cam.zoom += (cam.tz - cam.zoom) * kz;
  camApply();
}

/** 把焦点映射为 scale + translate（保持不露黑边）。
 *  分屏（竖屏）：作用在放大镜上，主画面保持原始尺寸；
 *  全屏（横屏）：作用在主画面上。算法可视化画布跟随同一 transform。 */
function camApply() {
  var c = activeClip();
  if (!c) return;
  var split = isSplit();
  var s = cam.zoom;
  var v, w, h, ov;
  if (split) {
    v = c.magV; ov = c.algoMag;
    w = c.magview.clientWidth || 1;
    h = c.magview.clientHeight || 1;
    var mv = c.visibleVideo();
    if (mv) mv.style.transform = 'translate(0px,0px) scale(1)';
    if (c.algoMain) c.algoMain.style.transform = 'translate(0px,0px) scale(1)';
  } else {
    v = c.visibleVideo();
    ov = c.algoMain;
    if (!v) return;
    w = v.clientWidth || 1;
    h = v.clientHeight || 1;
  }
  if (!v) return;
  var tx = 0, ty = 0;
  if (s > 1.001) {
    var limX = (s - 1) / 2 * w, limY = (s - 1) / 2 * h;
    tx = clamp(-(cam.x - 0.5) * w * s, -limX, limX);
    ty = clamp(-(cam.y - 0.5) * h * s, -limY, limY);
  }
  var tf = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
  if (Math.abs(s - cam.lz) > 0.0008 || Math.abs(cam.x - cam.lx) > 0.0004 || Math.abs(cam.y - cam.ly) > 0.0004) {
    v.style.transform = tf;
    if (ov) ov.style.transform = tf;
    cam.lx = cam.x; cam.ly = cam.y; cam.lz = s;
  }
  // 焦点框：显示质心在「未缩放画面」中的位置（画在主画面上）
  var box = c.focusBox;
  if (box) {
    if (SETTINGS.zoomOn && SETTINGS.focusBox && s > 1.001) {
      box.style.display = 'block';
      box.style.left = (50 + (cam.x - 0.5) * 100) + '%';
      box.style.top = (50 + (cam.y - 0.5) * 100) + '%';
    } else {
      box.style.display = 'none';
    }
  }
}

/* ---------- ⑧ 可视化：把发现的对象和行为画在画面上 ---------- */
function algoDraw(c) {
  if (!c) return;
  var st = (SETTINGS.algoViz && SETTINGS.zoomOn && scene) ? scene : null;
  var fit = isSplit() ? 'contain' : 'cover';
  drawSceneOn(c.algoMain, c.mainview, c.visibleVideo(), st, fit, true);
  if (isSplit()) {
    drawSceneOn(c.algoMag, c.magview, c.magV, st, 'cover', false);
  }
}

/** 在指定画布上按 object-fit 映射绘制场景对象（归一化坐标 → 画布像素） */
function drawSceneOn(canvas, box, video, st, fit, detail) {
  if (!canvas) return;
  var bw = box.clientWidth || 0, bh = box.clientHeight || 0;
  if (!bw || !bh) return;
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, bw, bh);
  if (!st || !video) return;
  var vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  var sc = fit === 'contain' ? Math.min(bw / vw, bh / vh) : Math.max(bw / vw, bh / vh);
  var dw = vw * sc, dh = vh * sc, ox = (bw - dw) / 2, oy = (bh - dh) / 2;
  function X(nx) { return ox + nx * dw; }
  function Y(ny) { return oy + ny * dh; }
  function label(text, nx, ny, color) {
    var fs = Math.max(11, Math.round(bh / 30));
    ctx.font = '600 ' + fs + 'px sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(text, X(nx), Y(ny));
    ctx.fillStyle = color;
    ctx.fillText(text, X(nx), Y(ny));
  }
  // 球场包围盒
  if (st.field) {
    ctx.strokeStyle = 'rgba(80,220,120,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(X(st.field.x), Y(st.field.y), st.field.w * dw, st.field.h * dh);
  }
  // 球门（记忆中的球门画暗一点，表示是沿用的）
  if (st.goal) {
    ctx.strokeStyle = st.goalFresh === false ? 'rgba(255,213,74,.45)' : '#ffd54a';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(st.goal.x), Y(st.goal.y), st.goal.w * dw, st.goal.h * dh);
    if (detail) label('球门', st.goal.x, Math.max(0.05, st.goal.y - 0.01), '#ffd54a');
  }
  // 人群
  if (st.people) {
    ctx.strokeStyle = 'rgba(90,200,255,.8)';
    ctx.lineWidth = 1;
    for (var i = 0; i < st.people.length; i++) {
      var p = st.people[i];
      ctx.strokeRect(X(p.x), Y(p.y), p.w * dw, p.h * dh);
    }
  }
  // 持球者（离球最近的人）
  if (st.owner) {
    ctx.strokeStyle = '#ff9430';
    ctx.lineWidth = 3;
    ctx.strokeRect(X(st.owner.x), Y(st.owner.y), st.owner.w * dw, st.owner.h * dh);
    if (detail) label('持球', st.owner.x, Math.max(0.05, st.owner.y - 0.01), '#ff9430');
  }
  // 球 → 门 预测轨迹与交点
  if (st.ball && st.traj && st.traj.length) {
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(st.ball.x), Y(st.ball.y));
    for (var q = 0; q < st.traj.length; q++) ctx.lineTo(X(st.traj[q].x), Y(st.traj[q].y));
    ctx.stroke();
  }
  if (st.hit) {
    ctx.fillStyle = '#ff4fd8';
    ctx.beginPath();
    ctx.arc(X(st.hit.x), Y(st.hit.y), Math.max(3, dw * 0.008), 0, 6.2832);
    ctx.fill();
    if (detail) label('交点', st.hit.x, st.hit.y, '#ff8fe8');
  }
  // 球（coast=跟踪器外推中的惯性位置，画虚线淡圈）
  if (st.ball) {
    var bcoast = !!st.ball.coast;
    ctx.strokeStyle = bcoast ? 'rgba(255,255,255,.5)' : '#fff';
    ctx.lineWidth = 2;
    if (bcoast) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(X(st.ball.x), Y(st.ball.y), Math.max(4, dw * 0.012), 0, 6.2832);
    ctx.stroke();
    ctx.setLineDash([]);
    if (detail) label(bcoast ? '球·推' : '球', st.ball.x, Math.max(0.05, st.ball.y - 0.02), '#fff');
  }
  // 组合包围盒（持续对准的对象）
  if (st.compose) {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(st.compose.box.x0), Y(st.compose.box.y0),
      (st.compose.box.x1 - st.compose.box.x0) * dw,
      (st.compose.box.y1 - st.compose.box.y0) * dh);
    ctx.setLineDash([]);
  }
  // 行为/画面决策
  if (detail) {
    var parts = [];
    if (st.ball) parts.push('球');
    if (st.owner) parts.push('持球');
    if (st.goal) parts.push('门');
    if (st.compose) {
      parts.push(st.compose.zoomOut ? '缩小·全景' : st.compose.zoom.toFixed(2) + '×');
    }
    if (st.shot) parts.push('射门!');
    else if (st.shotSoon) parts.push('球→门');
    else if (st.leave) parts.push('球离人');
    label(parts.join(' · '), 0.02, 0.055, '#fff');
  }
}

/* ---------- 调优入口（控制台 / CDP） ---------- */
var FOCUS_DEFAULT = JSON.parse(JSON.stringify(FOCUS_CFG));
window.__focusTune = function (patch) {
  if (!patch) return JSON.parse(JSON.stringify(FOCUS_CFG));
  if (patch === 'reset') {
    for (var k in FOCUS_DEFAULT) if (FOCUS_DEFAULT.hasOwnProperty(k)) FOCUS_CFG[k] = FOCUS_DEFAULT[k];
    return JSON.parse(JSON.stringify(FOCUS_CFG));
  }
  for (var k2 in patch) {
    if (FOCUS_DEFAULT.hasOwnProperty(k2)) FOCUS_CFG[k2] = patch[k2];
  }
  return JSON.parse(JSON.stringify(FOCUS_CFG));
};
/** 当前识别结果（对象+坐标+行为+画面建议+轨迹），供调试/验收读取 */
window.__algoState = function () {
  return {
    scene: scene,
    cam: { x: cam.x, y: cam.y, tx: cam.tx, ty: cam.ty, zoom: cam.zoom, tz: cam.tz, manual: cam.manual, track: cam.track ? cam.track.length : 0 },
    cfg: JSON.parse(JSON.stringify(FOCUS_CFG))
  };
};

/* =============================================================
   feed 骨架：clip 窗口管理 / 切换 / 翻页
   ============================================================= */
function buildClip(item, i) {
  return new ClipPlayer(item, i);
}

/** 只保留 [center-1, center, center+1] 三个 clip，其余销毁释放解码器 */
function ensureRange(center) {
  var i, k;
  for (i = center - 1; i <= center + 1; i++) {
    if (i < 0 || i >= items.length) continue;
    if (!clips[i]) clips[i] = buildClip(items[i], i);
  }
  for (k in clips) {
    if (!clips.hasOwnProperty(k)) continue;
    var idx = +k;
    if (idx < center - 1 || idx > center + 1) {
      clips[k].destroy();
      delete clips[k];
    }
  }
  // 预加载下一场：延迟起跑，避免连续快切时并发打接口
  var nxt = clips[center + 1];
  clearTimeout(preloadTimer);
  if (nxt && nxt.state === 'idle') {
    preloadTimer = setTimeout(function () { nxt.resolve(); }, 1200);
  }
}

function feedTransform(i, anim) {
  var h = feedEl.clientHeight || window.innerHeight;
  feedEl.style.transition = anim ? 'transform .26s ease' : 'none';
  feedEl.style.transform = 'translateY(' + (-i * h) + 'px)';
}

function switchTo(i) {
  if (i < 0 || i >= items.length) return;
  var old = active;
  active = i;
  ensureRange(i);
  feedTransform(i, true);
  if (clips[old] && old !== i) clips[old].deactivate();
  if (pendingFirstResume && clips[0] && i === 0) {
    clips[0].pendingResume = pendingFirstResume;
    pendingFirstResume = null;
  }
  var c = clips[i];
  if (c) c.activate();
  hideHint();
  loadMoreIfNeeded(i);
  showChrome();
  diag('switch to ' + i + ' ' + (items[i] ? items[i].bvid : ''));
}

function nextVideo() {
  if (active + 1 < items.length) { switchTo(active + 1); return; }
  if (feedHasMore) {
    loadMore().then(function () {
      if (active + 1 < items.length) switchTo(active + 1);
      else wrapTo(0);
    });
    return;
  }
  wrapTo(0);
}

function prevVideo() {
  if (active - 1 >= 0) switchTo(active - 1);
  else { feedTransform(active, true); toast('已经是第一场了'); }
}

function wrapTo(i) {
  switchTo(i);
  toast('看完了，回到第一场');
}

function loadMoreIfNeeded(i) {
  if (feedLoading || !feedHasMore) return;
  if (items.length - i > 2) return;
  loadMore();
}

async function loadMore() {
  if (feedLoading || !feedHasMore) return false;
  feedLoading = true;
  try {
    var j = await (await fetch('/api/feed?offset=' + encodeURIComponent(feedOffset) + cookieParam('&'))).json();
    if (!j.ok) throw new Error(j.error || '翻页失败');
    var vs = j.videos || [];
    for (var i = 0; i < vs.length; i++) items.push(vs[i]);
    feedOffset = j.offset || '';
    feedHasMore = !!j.hasMore && !!feedOffset;
    saveFeedCache();
    return true;
  } catch (e) {
    feedHasMore = false;
    toast('翻页失败：' + (e.message || e));
    return false;
  } finally {
    feedLoading = false;
  }
}

/* feed 本地缓存：接口被风控时用最近一次成功的列表兜底（视频本身仍需联网） */
function saveFeedCache() {
  if (!items.length) return;
  safeSet(FEED_CACHE_KEY, JSON.stringify({
    items: items.slice(0, 60), offset: feedOffset, hasMore: feedHasMore, ts: Date.now()
  }));
}
function restoreFeedCache() {
  var raw = safeGet(FEED_CACHE_KEY);
  if (!raw) return false;
  try {
    var o = JSON.parse(raw);
    if (!o || !o.items || !o.items.length) return false;
    if (Date.now() - (o.ts || 0) > 24 * 3600 * 1000) return false;
    items = o.items;
    feedOffset = o.offset || '';
    feedHasMore = !!o.hasMore;
    return true;
  } catch (e) { return false; }
}

async function loadFirstPage() {
  var lastErr = null;
  for (var t = 0; t < 2; t++) {
    try {
      var j = await (await fetch('/api/feed' + cookieParam('?'))).json();
      if (!j.ok) throw new Error(j.error || '视频流加载失败');
      items = j.videos || [];
      feedOffset = j.offset || '';
      feedHasMore = !!j.hasMore && !!feedOffset;
      saveFeedCache();
      return items.length;
    } catch (e) {
      lastErr = e;
      diag('loadFirstPage try' + t + ' fail: ' + (e && e.message));
      if (t === 0) { toast('视频流加载中，重试…'); await sleep(6000); }
    }
  }
  // 接口持续风控：用本地缓存的列表先顶上（24 小时内有效）
  if (restoreFeedCache()) {
    toast('接口受限，使用缓存的视频流');
    diag('feed fallback to local cache, items=' + items.length);
    return items.length;
  }
  throw lastErr;
}

/* =============================================================
   视频列表：只列 VCNC 集锦系列，点选切换
   ============================================================ */
function vListOpen() { return $('#vlist').classList.contains('open'); }

function openVList() {
  closeSheet();
  $('#vlistMask').classList.add('open');
  $('#vlist').classList.add('open');
  renderVList();
  showChrome();
  ensureVListCount(30);   // 首屏 10 条太短，后台多翻几页
}
function closeVList() {
  $('#vlistMask').classList.remove('open');
  $('#vlist').classList.remove('open');
}

/** 标题清理：「[实况录像+集锦] 五人场 20261011」→「五人场 2026-10-11」 */
function videoLabel(it) {
  var t = String(it.title || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  t = t.replace(/(\d{4})(\d{2})(\d{2})/, function (m, y, mo, d) { return y + '-' + mo + '-' + d; });
  return t || it.bvid;
}

/** 只保留集锦系列（标题带「集锦」）；一条都没有时不过滤 */
function vlistItems() {
  var f = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].hl !== false) f.push(items[i]);
  }
  return f.length ? f : items.slice();
}

function renderVList() {
  var body = $('#vlistBody');
  if (!body) return;
  var list = vlistItems();
  body.innerHTML = '';
  for (var i = 0; i < list.length; i++) {
    (function (it, pos) {
      var realIdx = items.indexOf(it);
      var row = document.createElement('div');
      row.className = 'vrow' + (realIdx === active ? ' on' : '');
      var sub = (it.duration ? it.duration + ' · ' : '') + dateStr(it.pubdate);
      var c = clips[realIdx];
      if (c && c.state === 'ready' && c.segs.length && SETTINGS.mode === 'hl') {
        sub += ' · 集锦 ' + c.segs.length + ' 段';
      }
      row.innerHTML = '<div class="vrow-idx">' + (pos + 1) + '</div>' +
        '<div class="vrow-main"><div class="vrow-t"></div><div class="vrow-s"></div></div>' +
        (it.hl === false ? '' : '<div class="vrow-badge">集锦</div>') +
        '<div class="vrow-play"></div>';
      $('.vrow-t', row).textContent = videoLabel(it);
      $('.vrow-s', row).textContent = sub;
      row.addEventListener('click', function () {
        closeVList();
        if (realIdx !== active) switchTo(realIdx);
      });
      body.appendChild(row);
      if (realIdx === active) {
        setTimeout(function () {
          try { row.scrollIntoView({ block: 'center' }); }
          catch (e) { try { row.scrollIntoView(); } catch (e2) {} }
        }, 80);
      }
    })(list[i], i);
  }
  $('#vlistFoot').hidden = !feedHasMore;
}

async function ensureVListCount(n) {
  var guard = 0;
  while (items.length < n && feedHasMore && !feedLoading && guard < 8) {
    guard++;
    await loadMore();
    renderVList();
    if (!feedHasMore) break;
  }
  renderVList();
}

/* =============================================================
   手势：竖滑切换 / 点按显隐 chrome / 滚轮与键盘（桌面调试）
   ============================================================= */
var drag = { on: false, y0: 0, y: 0, t0: 0, moved: false, vy: 0 };
var pointers = {};            // pointerId -> {x, y}（活跃指针）
var gesture = 'none';         // none | swipe | pinch
var pinch = { d0: 0, mx0: 0, my0: 0, zoom0: 1, fx0: 0.5, fy0: 0.5, vw: 1, vh: 1, moved: false };
var focusManualTimer = null;
var lastWheel = 0;

function countPointers() {
  var n = 0;
  for (var k in pointers) if (pointers.hasOwnProperty(k)) n++;
  return n;
}
function pinchCenter() {
  var x = 0, y = 0, n = 0;
  for (var k in pointers) {
    if (!pointers.hasOwnProperty(k)) continue;
    x += pointers[k].x; y += pointers[k].y; n++;
  }
  return n ? { x: x / n, y: y / n, n: n } : null;
}
function pinchDist() {
  var ks = [], k;
  for (k in pointers) if (pointers.hasOwnProperty(k)) ks.push(k);
  if (ks.length < 2) return 0;
  var a = pointers[ks[0]], b = pointers[ks[1]];
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 第二根手指落下 → 进入捏合/平移，取消竖滑 */
function startPinch() {
  gesture = 'pinch';
  drag.on = false;
  feedEl.style.transition = '';
  feedTransform(active, true);
  var d = pinchDist();
  var c = pinchCenter();
  if (d < 1 || !c) { gesture = 'none'; return; }
  var vp = camViewport();
  pinch.d0 = d;
  pinch.mx0 = c.x; pinch.my0 = c.y;
  pinch.zoom0 = Math.max(1.05, SETTINGS.zoom);
  pinch.fx0 = cam.x; pinch.fy0 = cam.y;
  pinch.vw = vp.w; pinch.vh = vp.h;
  pinch.moved = false;
  camManual(true);
}

function movePinch() {
  var d = pinchDist();
  var c = pinchCenter();
  if (d < 1 || !c) return;
  // 捏合 → 缩放（1~3 倍）
  var z = clamp(pinch.zoom0 * (d / pinch.d0), 1, 3);
  SETTINGS.zoom = Math.round(z * 100) / 100;
  SETTINGS.zoomOn = true;
  saveSettings();
  syncSettingsUI();
  // 双指拖动 → 临时平移焦点（画面内容跟手，相机缓动追随）
  var dx = c.x - pinch.mx0, dy = c.y - pinch.my0;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pinch.moved = true;
  if (pinch.moved) {
    var s = Math.max(1, SETTINGS.zoom);
    cam.tx = clamp(pinch.fx0 - dx / (pinch.vw * s), 0, 1);
    cam.ty = clamp(pinch.fy0 - dy / (pinch.vh * s), 0, 1);
  }
  camApply();
}

/** 手指离开：1 秒后恢复自动跟焦 */
function endPinch() {
  gesture = 'none';
  clearTimeout(focusManualTimer);
  focusManualTimer = setTimeout(function () {
    camManual(false);
    camApply();
  }, 1000);
}

function bindGestures() {
  feedEl.addEventListener('pointerdown', function (e) {
    if (sheetOpen() || vListOpen() || active < 0) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (gesture === 'pinch') return;
    if (countPointers() >= 2) { startPinch(); return; }
    gesture = 'swipe';
    drag.on = true; drag.y0 = e.clientY; drag.y = 0;
    drag.x0 = e.clientX; drag.mode = null;
    drag.bright0 = SETTINGS.brightness; drag.vol0 = SETTINGS.volume;
    drag.moved = false; drag.t0 = performance.now(); drag.vy = 0;
    feedEl.style.transition = 'none';
  });
  window.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in pointers)) return;
    pointers[e.pointerId].x = e.clientX;
    pointers[e.pointerId].y = e.clientY;
    if (gesture === 'pinch') { movePinch(); return; }
    if (!drag.on) return;
    var dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dy) <= 10) return;
      drag.moved = true;
      // 左右半屏分派：左＝亮度，右＝音量；都不再触发切视频拖动
      var half = (window.innerWidth || 1) / 2;
      drag.mode = drag.x0 < half ? 'bright' : 'vol';
    }
    if (drag.mode) { slideAdjust(drag.mode, dy); return; }
    drag.y = dy;
    drag.vy = dy / Math.max(1, performance.now() - drag.t0);
    var h = feedEl.clientHeight || window.innerHeight;
    var atEdge = (active === 0 && dy > 0) ||
                 (active === items.length - 1 && dy < 0 && !feedHasMore);
    var eff = atEdge ? dy * 0.35 : dy;
    feedEl.style.transform = 'translateY(' + (-active * h + eff) + 'px)';
  });
  window.addEventListener('pointerup', function (e) {
    if (!(e.pointerId in pointers)) return;
    delete pointers[e.pointerId];
    if (gesture === 'pinch') {
      if (countPointers() >= 2) { movePinch(); return; }
      endPinch();
      return;
    }
    if (!drag.on) return;
    drag.on = false;
    var wasMode = drag.mode;
    drag.mode = null;
    gesture = 'none';
    if (wasMode) {   // 亮度/音量滑动结束：落盘并复位
      saveSettings();
      feedTransform(active, true);
      return;
    }
    if (!drag.moved) { onTap(e); return; }
    var h = feedEl.clientHeight || window.innerHeight;
    var dy = drag.y;
    var fast = Math.abs(drag.vy) > 0.55;
    feedEl.style.transition = '';
    if (dy < 0 && (Math.abs(dy) > h * 0.22 || fast)) nextVideo();
    else if (dy > 0 && (Math.abs(dy) > h * 0.22 || fast)) prevVideo();
    else feedTransform(active, true);
  });
  window.addEventListener('pointercancel', function (e) {
    if (e && e.pointerId != null) {
      if (!(e.pointerId in pointers)) return;
      delete pointers[e.pointerId];
    }
    if (gesture === 'pinch') { endPinch(); return; }
    if (!drag.on) return;
    drag.on = false;
    drag.mode = null;
    gesture = 'none';
    feedTransform(active, true);
  });

  feedEl.addEventListener('wheel', function (e) {
    if (sheetOpen()) return;
    if (Math.abs(e.deltaY) < 12) return;
    var now = performance.now();
    if (now - lastWheel < 600) return;
    lastWheel = now;
    if (e.deltaY > 0) nextVideo(); else prevVideo();
  }, { passive: true });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'PageDown') nextVideo();
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') prevVideo();
    else if (e.key === ' ') {
      e.preventDefault();
      var c = activeClip();
      if (c) c.togglePlay();
    } else if (e.key === 'Escape') closeSheet();
  });

  document.addEventListener('visibilitychange', function () {
    var c = activeClip();
    if (!c) return;
    if (document.hidden) c.pauseAll();
    else if (c.state === 'ready' && c.idx >= 0) c.resumePlay();
  });
}

function onTap(e) {
  if (e && e.target && e.target.closest) {
    if (e.target.closest('button, .sheet, .fallback, .sheet-mask')) return;
  }
  var c = activeClip();
  if (c && c.state === 'ready' && c.idx >= 0) {
    c.togglePlay();
    flashPlayBtn();
  }
  if (document.body.classList.contains('chrome-off')) showChrome();
}

/* ---------- 单击播放/暂停：左下角图标反馈 ---------- */
var flashTimer = null;
function flashPlayBtn() {
  var b = $('#btnPlay');
  if (!b) return;
  b.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () { b.classList.remove('flash'); }, 450);
}
/** 左下角播放/暂停图标与状态同步（render 里带守卫调用） */
function syncPlayIcon() {
  var b = $('#btnPlay'), c = activeClip();
  if (!b) return;
  var playing = !!(c && c.playing);
  if (b._lastPlay === playing) return;
  b._lastPlay = playing;
  b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}

/* ---------- 左下角控制条绑定（播放/暂停 + 慢动作三档） ---------- */
function bindCornerCtl() {
  var bp = $('#btnPlay');
  if (!bp) return;
  bp.innerHTML = ICON_PAUSE;
  bp.addEventListener('click', function () {
    var c = activeClip();
    if (c) c.togglePlay();
    flashPlayBtn();
  });
  var slows = document.querySelectorAll('#cornerCtl .slow');
  for (var i = 0; i < slows.length; i++) {
    (function (b) {
      b.addEventListener('click', function () {
        var r = parseFloat(b.getAttribute('data-rate'));
        SETTINGS.slowRate = (Math.abs(SETTINGS.slowRate - r) < 1e-6) ? 1 : r;   // 再点同档恢复常速
        saveSettings();
        applySlowRate();
        toast(SETTINGS.slowRate === 1 ? '常速播放' : ('慢动作 ' + SETTINGS.slowRate + '×'));
      });
    })(slows[i]);
  }
  syncSlowButtons();
}
function syncSlowButtons() {
  var slows = document.querySelectorAll('#cornerCtl .slow');
  for (var i = 0; i < slows.length; i++) {
    var r = parseFloat(slows[i].getAttribute('data-rate'));
    if (Math.abs(SETTINGS.slowRate - r) < 1e-6) slows[i].classList.add('on');
    else slows[i].classList.remove('on');
  }
}
/** 慢动作基准：当前生效的 playbackRate（1=常速） */
function slowBase() { return SETTINGS.slowRate || 1; }
/** 对当前 clip 两个 deck 全部应用慢动作速率 */
function applySlowRate() {
  var c = activeClip();
  if (!c) return;
  var base = slowBase();
  for (var i = 0; i < c.decks.length; i++) {
    try { c.decks[i].v.playbackRate = base; } catch (e) {}
    if (c.hasAudio) { try { c.decks[i].a.playbackRate = base; } catch (e) {} }
  }
  syncSlowButtons();
}

/* ---------- 左滑亮度 / 右滑音量 ---------- */
function applyBrightness() {
  var m = $('#brightMask');
  if (m) m.style.opacity = String((1 - SETTINGS.brightness) * 0.8);
}
function applyVolume() {
  var c = activeClip();
  if (!c) return;
  for (var i = 0; i < c.decks.length; i++) {
    try { c.decks[i].a.volume = SETTINGS.volume; } catch (e) {}
  }
}
var osdTimer = null;
function showOsd(label, frac) {
  var o = $('#swipeOsd');
  if (!o) return;
  var fill = o.querySelector('.osd-fill');
  var val = o.querySelector('.osd-val');
  if (fill) fill.style.height = Math.round(clamp(frac, 0, 1) * 100) + '%';
  if (val) val.textContent = label;
  o.hidden = false;
  o.classList.add('on');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(function () { o.classList.remove('on'); }, 900);
}
/** 半屏竖滑调节：mode='bright' 左半屏 / 'vol' 右半屏；dy 向上为负 → 增大 */
function slideAdjust(mode, dy) {
  var h = window.innerHeight || 1;
  var delta = -dy / h;
  if (mode === 'bright') {
    SETTINGS.brightness = clamp(drag.bright0 + delta, 0.1, 1);
    applyBrightness();
    showOsd('亮度 ' + Math.round(SETTINGS.brightness * 100) + '%', (SETTINGS.brightness - 0.1) / 0.9);
  } else {
    SETTINGS.volume = clamp(drag.vol0 + delta, 0, 1);
    applyVolume();
    showOsd('音量 ' + Math.round(SETTINGS.volume * 100) + '%', SETTINGS.volume);
  }
}

/* =============================================================
   chrome / toast / hint
   ============================================================= */
var chromeTimer = null;
function showChrome() {
  document.body.classList.remove('chrome-off');
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(function () { document.body.classList.add('chrome-off'); }, 3000);
}

var toastTimer = null;
function toast(msg) {
  var t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
}

function hideHint() { var h = $('#hint'); if (h) h.classList.add('off'); }
function showHintIfFirst() {
  var h = $('#hint');
  if (!h) return;
  if (safeGet('vcnc.hinted')) { h.classList.add('off'); return; }
  safeSet('vcnc.hinted', '1');
  setTimeout(hideHint, 4200);
}

/* =============================================================
   设置面板
   ============================================================= */
function sheetOpen() { return $('#sheet').classList.contains('open'); }
function openSheet() {
  $('#sheetMask').classList.add('open');
  $('#sheet').classList.add('open');
  syncSettingsUI();
}
function closeSheet() {
  $('#sheetMask').classList.remove('open');
  $('#sheet').classList.remove('open');
}

function syncSettingsUI() {
  var segBtns = $('#modeSeg').children;
  for (var i = 0; i < segBtns.length; i++) {
    segBtns[i].classList.toggle('on', segBtns[i].getAttribute('data-mode') === SETTINGS.mode);
  }
  var catSel = $('#catSel');
  if (catSel) catSel.value = SETTINGS.cat;
  var chips = $('#zoomChips').children;
  for (var j = 0; j < chips.length; j++) {
    chips[j].classList.toggle('on', Math.abs(parseFloat(chips[j].getAttribute('data-zoom')) - SETTINGS.zoom) < 0.001);
  }
  var splitSw = $('#splitSw');
  if (splitSw) splitSw.classList.toggle('on', SETTINGS.split);
  $('#focusSw').classList.toggle('on', SETTINGS.focusBox);
  var algoSw = $('#algoSw');
  if (algoSw) algoSw.classList.toggle('on', SETTINGS.algoViz);
  syncZoomIcons();
}

function syncZoomIcons() {
  var els = document.querySelectorAll('.ic.zoom');
  for (var i = 0; i < els.length; i++) els[i].classList.toggle('on', SETTINGS.zoomOn);
}

function toggleZoom() {
  SETTINGS.zoomOn = !SETTINGS.zoomOn;
  saveSettings();
  syncZoomIcons();
  camApply();
  var c = activeClip();
  if (c) algoDraw(c);   // 关：清空标注；开：下一帧采样即绘制
  toast(SETTINGS.zoomOn ? '焦点缩放开 · 自动构图' : '焦点缩放关');
  showChrome();
}

function bindSettings() {
  $('#sheetMask').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#vlistMask').addEventListener('click', closeVList);
  $('#vlistClose').addEventListener('click', closeVList);
  var segBtns = $('#modeSeg').children;
  for (var i = 0; i < segBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-mode');
        if (m === SETTINGS.mode) return;
        SETTINGS.mode = m;
        saveSettings();
        syncSettingsUI();
        var c = activeClip();
        if (c && c.state === 'ready') {
          c.buildSegs((c.info && c.info.matched) || []);
          c.tracks = [];
          c.stopAll();
          c.activate();
          toast(m === 'hl' ? '集锦连播' : '原片播放');
        }
      });
    })(segBtns[i]);
  }
  var chips = $('#zoomChips').children;
  for (var j = 0; j < chips.length; j++) {
    (function (chip) {
      chip.addEventListener('click', function () {
        SETTINGS.zoom = parseFloat(chip.getAttribute('data-zoom'));
        SETTINGS.zoomOn = true;
        saveSettings();
        syncSettingsUI();
        camApply();
      });
    })(chips[j]);
  }
  $('#focusSw').addEventListener('click', function () {
    SETTINGS.focusBox = !SETTINGS.focusBox;
    saveSettings();
    syncSettingsUI();
    camApply();
  });
  var algoSw = $('#algoSw');
  if (algoSw) {
    algoSw.addEventListener('click', function () {
      SETTINGS.algoViz = !SETTINGS.algoViz;
      saveSettings();
      syncSettingsUI();
      var c = activeClip();
      if (c) algoDraw(c);   // 立刻刷新/清空可视化
    });
  }
  // 集锦分类：按置顶评论动作码筛选（g/a/m/s/dr/pnn/h/p/c/!）
  var catSel = $('#catSel');
  if (catSel) {
    catSel.addEventListener('change', function () {
      var v = catSel.value;
      if (!CAT_LABEL[v]) v = 'all';
      // 原片模式下选分类 → 自动切回集锦连播
      if (SETTINGS.mode === 'full' && v !== 'all') SETTINGS.mode = 'hl';
      if (v !== SETTINGS.cat) {
        SETTINGS.cat = v;
        saveSettings();
      }
      syncSettingsUI();
      applyCatToActive();   // 即使值没变也重新应用，保证当前片段序列与设置一致
    });
  }
  // 竖屏分屏（上原画面 / 下跟焦放大镜）
  var splitSw = $('#splitSw');
  if (splitSw) {
    splitSw.addEventListener('click', function () {
      SETTINGS.split = !SETTINGS.split;
      saveSettings();
      syncSettingsUI();
      applySplit();
      toast(SETTINGS.split ? '竖屏分屏放大镜 开' : '竖屏分屏放大镜 关');
    });
  }
  var ck = $('#cookieInput');
  if (ck) ck.value = getUserCookie();
  $('#cookieSave').addEventListener('click', function () {
    var v = (ck.value || '').trim();
    safeSet(COOKIE_KEY, v);
    toast(v ? 'Cookie 已保存' : 'Cookie 已清除');
  });
}

/** 分类变化：重建当前比赛的片段序列并重新起播 */
function applyCatToActive() {
  var label = CAT_LABEL[SETTINGS.cat] || '全部';
  var c = activeClip();
  if (!c || c.state !== 'ready') {
    toast('集锦分类：' + label);
    return;
  }
  c.buildSegs((c.info && c.info.matched) || []);
  c.tracks = [];        // 片段序列重建，旧轨迹作废
  c.stopAll();
  c.activate();
  if (c.catEmpty) toast('本场没有「' + label + '」集锦，已显示全部');
  else toast('集锦分类：' + label + '（' + c.segs.length + ' 段）');
  showChrome();
}

/* =============================================================
   分享兜底（系统没透传链接时）
   ============================================================= */
function showShareFallback(raw) {
  $('#fbRaw').textContent = raw ? ('收到的分享内容：' + raw) : '收到的分享内容为空';
  $('#fallback').hidden = false;
  try { $('#fbInput').focus(); } catch (e) {}
}
function bindFallback() {
  $('#fbClose').addEventListener('click', function () { $('#fallback').hidden = true; });
  $('#fbGo').addEventListener('click', function () {
    var v = ($('#fbInput').value || '').trim();
    if (!v) { toast('先粘贴 BV 号或链接'); return; }
    // 交给 /api/resolve 解析（BV / av / 完整 URL / b23.tv 短链都认）
    location.href = 'feed.html?bv=' + encodeURIComponent(v);
  });
}

/* =============================================================
   视口缩放（系统「显示大小」放大导致 CSS 视口过窄时整体放大）
   ============================================================= */
function applyViewportScaleReal() {
  var cssW = window.innerWidth;
  if (cssW < 40) return;
  var natural = 400;
  var w = $('#appWrap');
  if (!w) return;
  if (cssW >= natural - 20) {
    w.style.transform = '';
    w.style.width = '';
    w.style.height = '';
    return;
  }
  var scale = Math.max(0.72, cssW / natural);
  w.style.width = natural + 'px';
  w.style.height = (window.innerHeight / scale) + 'px';
  w.style.transform = 'scale(' + scale + ')';
  w.style.transformOrigin = 'top left';
}

/* =============================================================
   主循环 & 启动
   ============================================================= */
function tick(now) {
  requestAnimationFrame(tick);
  var c = activeClip();
  if (c) c.tick(now);
  camSampleLive(now);   // 实时采样（6.7Hz）→ scene
  camTick(now);         // 平滑相机：轨迹/实时混合 + 缓动 + 落 transform
}

function parseParams() {
  var o = {};
  var q = window.location.search.replace(/^\?/, '');
  if (!q) return o;
  var pairs = q.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i].split('=');
    if (kv.length === 2) o[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1].replace(/\+/g, ' '));
  }
  return o;
}

function showFatal(msg) {
  $('#fatalMsg').textContent = msg;
  $('#fatal').hidden = false;
}

async function init() {
  loadSettings();
  params = parseParams();
  feedEl = $('#feed');
  camInit();
  bindGestures();
  bindSettings();
  bindCornerCtl();
  applyBrightness();
  applyVolume();
  applySlowRate();
  bindFallback();
  applyViewportScale = applyViewportScaleReal;
  applyViewportScale();
  applySplit();
  syncZoomIcons();
  window.addEventListener('resize', function () {
    applyViewportScale();
    if (active >= 0) feedTransform(active, false);
    applySplit();
  });

  try {
    await loadFirstPage();
  } catch (e) {
    showFatal((e && e.message) || '视频流加载失败');
    return;
  }

  // 分享进来的单条视频插到最前（去重）
  if (params.bv) {
    var exists = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].bvid === params.bv) { exists = true; break; }
    }
    if (!exists) {
      items.unshift({
        bvid: params.bv, title: params.title || params.bv,
        pic: '', duration: '', pubdate: 0, desc: '', shared: true
      });
    }
  }
  if (!items.length) { showFatal('VCNC 暂无可播放的视频'); return; }

  // 冷启动续播：上次看到哪条就从哪条开始（bvid 能在当前 feed 里找到才生效；
  // 分享进来的视频优先，固定在 feed 首条）
  var resumeAt = -1;
  if (!params.bv) {
    var rawPos = safeGet(POS_KEY);
    if (rawPos) {
      try {
        var sp = JSON.parse(rawPos);
        if (sp && sp.bvid) {
          for (var ri = 0; ri < items.length; ri++) {
            if (items[ri].bvid === sp.bvid) { resumeAt = ri; break; }
          }
        }
      } catch (e) {}
    }
  }
  if (resumeAt < 0) resumeAt = 0;

  if (params.ridx !== undefined && params.rt !== undefined) {
    pendingFirstResume = { idx: parseInt(params.ridx, 10) || 0, t: parseFloat(params.rt) || 0 };
    resumeAt = 0;
  }

  switchTo(resumeAt);
  showHintIfFirst();
  requestAnimationFrame(tick);
  diag('init ok items=' + items.length + ' hasMore=' + feedHasMore + ' resumeAt=' + resumeAt);
}

$('#fatalRetry').addEventListener('click', function () { location.reload(); });

/* ---------------------- 软件更新（GitHub Releases） ----------------------
   Java 侧 UpdateChecker 在子线程里检查/下载，再通过 evaluateJavascript 调用
   下面挂在 window 上的全局回调（UI 线程执行）。桌面调试时没有 BiliBridge，
   只给出提示，不报错。
   ----------------------------------------------------------------------- */
(function () {
  var curVerEl = $('#curVer'), btnCheck = $('#btnCheckUpdate'), btnDo = $('#btnDoUpdate');
  var statusEl = $('#updateStatus'), notesEl = $('#updateNotes');
  var progEl = $('#updateProgress'), actionsEl = $('#updateActions');
  function bridge() {
    return (window.BiliBridge && typeof window.BiliBridge.checkUpdate === 'function')
      ? window.BiliBridge : null;
  }
  function hideAll() {
    if (actionsEl) actionsEl.hidden = true;
    if (progEl) progEl.hidden = true;
    if (notesEl) notesEl.hidden = true;
  }
  function ver() {
    var b = bridge();
    if (!b || !b.getVersionName) return;
    try { curVerEl.textContent = b.getVersionName() || '—'; } catch (e) { curVerEl.textContent = '—'; }
  }
  if (btnCheck) btnCheck.addEventListener('click', function () {
    hideAll();
    var b = bridge();
    if (!b) { statusEl.textContent = '更新功能只在 Android 应用内可用'; return; }
    statusEl.textContent = '正在检查更新…';
    try { b.checkUpdate(); } catch (e) { statusEl.textContent = '检查失败：' + e; }
  });
  if (btnDo) btnDo.addEventListener('click', function () {
    var b = bridge();
    if (!b) return;
    statusEl.textContent = '正在下载…';
    if (progEl) { progEl.value = 0; progEl.hidden = false; }
    try { b.startUpdate(); } catch (e) { statusEl.textContent = '下载失败：' + e; }
  });

  window.onUpdateChecked = function (j) {
    if (!j) return;
    if (curVerEl && j.curVersion) curVerEl.textContent = j.curVersion;
    hideAll();
    if (j.hasUpdate) {
      statusEl.textContent = '发现新版本 ' + (j.latestVersion || '') +
        '（当前 ' + (j.curVersion || '') + '）';
      if (notesEl && j.notes) { notesEl.textContent = String(j.notes).slice(0, 700); notesEl.hidden = false; }
      if (actionsEl) actionsEl.hidden = false;
    } else if (j.apkAvailable === false) {
      statusEl.textContent = '最新版本未附带 APK，请稍后再试';
    } else if (j.latestVersion && j.latestVersion !== j.curVersion) {
      statusEl.textContent = '已是最新版 ' + (j.latestVersion || j.curVersion || '');
    } else {
      statusEl.textContent = '已是最新版本 ' + (j.curVersion || '');
    }
  };
  window.onUpdateProgress = function (pct) {
    if (!progEl) return;
    if (pct < 0) { progEl.hidden = true; return; }
    progEl.hidden = false;
    progEl.value = pct;
    statusEl.textContent = '下载中… ' + pct + '%';
  };
  window.onUpdateError = function (msg) {
    if (statusEl) statusEl.textContent = '更新失败：' + (msg || '');
    if (progEl) progEl.hidden = true;
  };
  window.onUpdateInstalled = function () {
    if (statusEl) statusEl.textContent = '已启动安装，请按系统提示完成升级';
    if (progEl) progEl.hidden = true;
    if (actionsEl) actionsEl.hidden = true;
  };
  ver();
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { init(); });
} else {
  init();
}
