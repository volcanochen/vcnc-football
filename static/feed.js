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

/** 带超时的 fetch：本地代理偶发不响应时不必干等浏览器默认超时（修冷启动偶发卡住） */
function fetchTimeout(url, ms) {
  if (typeof AbortController !== 'undefined') {
    var ac = new AbortController();
    var t = setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms || 15000);
    return fetch(url, { signal: ac.signal }).then(
      function (r) { clearTimeout(t); return r; },
      function (e) { clearTimeout(t); throw e; }
    );
  }
  return fetch(url);
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
var LEAD = 0.35;          // 段末预热提前量
var PAD_MIN = 0, PAD_MAX = 15, PAD_STEP = 0.5;

/* 折叠屏 / 超高像素大屏（N6 展开 2480x2248）同时解码两路视频会把合成器压死：
   音频照走、画面冻住。这类设备只保留 1 路正在播的视频，备用 deck 预载到段首后
   保持暂停，段末硬切时 startDeck() 再 play()（首帧已解码，仍无黑帧）。
   判据：物理像素面积 > 420 万（N6≈557 万，Note8≈240 万）。 */
var LOW_DECK_MODE = (function () {
  var d = window.devicePixelRatio || 1;
  return (window.innerWidth * d) * (window.innerHeight * d) > 4200000;
})();

/* padFront / padBack：时间戳前后各多播的秒数（评论时间不准时调大）
   zoomOn：是否让算法自动跟焦；关＝按「缩放倍率」完整显示，镜头不动（默认关）
   cat：集锦筛选串，留空＝全部；目前按备注字符字面匹配
   fit：画面填充方式，contain=完整不裁切（默认）/ cover=铺满会裁切
   segFloat：播放页左侧集锦浮窗是否显示
   cacheMb：本地视频缓存上限（MB），真实额度由 /api/cache/config 下发给本地代理 */
var SETTINGS = {
  mode: 'hl', cat: '', padFront: 1, padBack: 2,
  zoom: 1, zoomOn: false, split: true, focusBox: false,
  algoViz: true, brightness: 1, volume: 1, slowRate: 1,
  fit: 'contain', segFloat: true, cacheMb: 600
};

function normPad(v, dflt) {
  v = +v;
  if (!isFinite(v)) return dflt;
  return clamp(Math.round(v / PAD_STEP) * PAD_STEP, PAD_MIN, PAD_MAX);
}

/* ---------------------- 集锦分类（当前：按字符字面筛选） ----------------------
   置顶评论里每个时间戳后面跟的是备注原文（如 "17s V g pnn*2"、"M dr m !"）。
   现阶段不做语义猜测：把用户输入的字符当作子串去匹配备注，任一命中即保留。
   后续拿到「字符 → 含义」清单后，只需在 catTerms() 里把语义词展开成对应字符，
   buildSegs 的筛选流程不用改。 */
function catTerms(q) {
  // 区分大小写：置顶评论里 "M"/"V" 是队名标记，"m"/"v" 另有含义，不能混
  q = String(q == null ? '' : q).trim();
  if (!q || q === 'all' || q === '全部') return [];
  var raw = q.split(/[\s,，、;；|]+/), out = [];
  for (var i = 0; i < raw.length; i++) {
    var t = raw[i];
    if (t && out.indexOf(t) < 0) out.push(t);
  }
  return out;
}
function catMatch(note, terms) {
  if (!terms.length) return true;
  var n = String(note == null ? '' : note);
  for (var i = 0; i < terms.length; i++) {
    if (n.indexOf(terms[i]) >= 0) return true;
  }
  return false;
}
/** 拆出备注里的候选字符（供设置页展示可点的 chip） */
function noteTokenList(note) {
  var raw = String(note == null ? '' : note).split(/[\s,，、;；:：()（）\[\]【】]+/);
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var w = raw[i].replace(/^\*/, '').replace(/\*.*$/, '').replace(/\+.*$/, '').trim();
    if (!w || w.length > 8) continue;
    if (/^\d+(\.\d+)?$/.test(w)) continue;        // 纯数字
    if (/^\d+(\.\d+)?s$/.test(w)) continue;       // 时长 17s
    if (/^\d{1,2}:\d{1,2}/.test(w)) continue;     // 时间戳残留
    if (out.indexOf(w) < 0) out.push(w);
  }
  return out;
}

function loadSettings() {
  var raw = safeGet(SET_KEY);
  if (!raw) return;
  try {
    var o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      // 没有 fit 字段 = 0.2.2 及更早的设置。新版默认要求「完整显示 + 全部集锦」，
      // 旧配置里的自动跟焦、倍率、动作码筛选会让画面被放大裁切、浮窗只剩筛后片段，
      // 所以升级时一次性回落到完整显示全部。用户之后改任一设置即写入 fit，不再重置。
      var legacy = !(o.fit === 'cover' || o.fit === 'contain');
      if (o.mode === 'hl' || o.mode === 'full') SETTINGS.mode = o.mode;
      // 集锦筛选、缩放倍率、自动跟焦都是「本次取景/临时筛选」，不跨启动恢复：
      // 用户要求每次打开默认就是「完整显示全部画面 + 全部集锦」。
      // 真正的内容偏好（补时、画面填充方式、分屏、浮窗等）仍持久化。
      if (typeof o.padFront === 'number') SETTINGS.padFront = normPad(o.padFront, 1);
      if (typeof o.padBack === 'number') SETTINGS.padBack = normPad(o.padBack, 2);
      if (typeof o.split === 'boolean') SETTINGS.split = o.split;
      if (typeof o.focusBox === 'boolean') SETTINGS.focusBox = o.focusBox;
      if (typeof o.algoViz === 'boolean') SETTINGS.algoViz = o.algoViz;
      if (typeof o.brightness === 'number') SETTINGS.brightness = clamp(o.brightness, 0.1, 1);
      if (typeof o.volume === 'number') SETTINGS.volume = clamp(o.volume, 0, 1);
      if (typeof o.slowRate === 'number' && [0.5, 0.25, 0.125, 1].indexOf(o.slowRate) >= 0) SETTINGS.slowRate = o.slowRate;
      if (o.fit === 'cover' || o.fit === 'contain') SETTINGS.fit = o.fit;
      if (typeof o.segFloat === 'boolean') SETTINGS.segFloat = o.segFloat;
      // 2026-11-08 默认放大到 600MB：旧存档里小于 600 的值一律按 600 处理
      if (typeof o.cacheMb === 'number' && o.cacheMb >= 600 && CACHE_MB_OPTIONS.indexOf(o.cacheMb) >= 0) SETTINGS.cacheMb = o.cacheMb;
      if (legacy) {
        SETTINGS.cat = '';
        SETTINGS.zoom = 1;
        SETTINGS.zoomOn = false;
        SETTINGS.fit = 'contain';
        SETTINGS.segFloat = true;
      }
    }
  } catch (e) {}
}
function saveSettings() { safeSet(SET_KEY, JSON.stringify(SETTINGS)); }

/** 画面填充：把 object-fit 写进每个 deck 的 video（inline 优先于 CSS 兜底）。
 *  源视频约 2.4:1，contain 会上下留黑边但完整；cover 铺满屏幕会裁掉两侧。 */
function applyFit() {
  var fit = (SETTINGS.fit === 'cover') ? 'cover' : 'contain';
  document.body.setAttribute('data-fit', fit);
  for (var k in clips) {
    if (!clips.hasOwnProperty(k) || !clips[k] || !clips[k].decks) continue;
    for (var i = 0; i < clips[k].decks.length; i++) {
      clips[k].decks[i].v.style.objectFit = fit;
    }
  }
  var c = activeClip();
  if (c) { camApply(); algoDraw(c); }
}
/** 集锦浮窗显隐（设置项） */
function applySegFloatVis() {
  document.body.classList.toggle('segfloat-off', !SETTINGS.segFloat);
  if (SETTINGS.segFloat) renderSegFloat();
}

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
/** 倒放时播放键显示的左向三角 */
var ICON_PLAY_REV = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5.5v13L5 12z"/></svg>';

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
        '<div class="bar"><div class="bar-fill"></div><div class="bar-knob"></div><div class="bar-tip"><b></b><span></span></div></div>' +
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
var pagerEl = null;
var params = {};

/* 三页横向容器：0=比赛列表 / 1=播放 / 2=设置
   viewportScale 由 applyViewportScaleReal 写入，用于把手势的屏幕 px 换算成
   被 scale() 缩放后的内容 px（窄视口下 #appWrap 会被整体缩放） */
var page = 1;
var viewportScale = 1;

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
  this.catEmpty = false;      // 本场按当前字符筛完后为空（已回退全部）
  this.catActive = '';        // 实际生效的筛选串（空=全部）
  this.segTotal = 0;          // 筛选前的片段总数
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
  this.knobEl = $('.bar-knob', this.el);
  this.tipEl = $('.bar-tip', this.el);
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
    d.v.style.objectFit = (SETTINGS.fit === 'cover') ? 'cover' : 'contain';
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
    // 解析请求：超时 15s + 失败静默重试一次（冷启动偶发卡住的主因就在这一步）
    var j = null, lastErr = null;
    for (var att = 0; att < 2; att++) {
      try {
        j = await (await fetchTimeout('/api/resolve?url=' + encodeURIComponent(this.item.bvid) + '&qn=' + QN + cookieParam('&'), 15000)).json();
        break;
      } catch (e2) {
        lastErr = e2;
        diag('resolve fetch retry' + att + ': ' + (e2 && (e2.name || e2.message)));
        if (att === 0) await sleep(900);
      }
    }
    if (!j) throw lastErr || new Error('解析失败');
    if (!j.ok) throw new Error(j.error || '解析失败');
    this.token = j.token;
    this.info = j;
    this.videoDuration = j.duration || 0;
    this.hasAudio = !!(j.audio && j.audio.id);
    this.buildSegs(j.matched || []);
    this.state = 'ready';
    this.error = '';
    if (page === 2) { renderCatTokens(); updateCatCount(); }   // 设置页开着时刷新候选/命中数
    renderSegFloat(true);
    diag('resolve ok ' + this.item.bvid + ' segs=' + this.segs.length);
    this.render();
    prefetchSegBytes(this);          // 后台预取本场全部集锦片段的字节区间
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
    var start = Math.max(0, it.s0 - SETTINGS.padFront);
    var dur = d + SETTINGS.padFront + SETTINGS.padBack;
    if (this.videoDuration > 0) {
      if (start >= this.videoDuration - 0.2) continue;
      if (start + dur > this.videoDuration) dur = Math.max(0.6, this.videoDuration - start);
    }
    segs.push({ start: start, dur: dur, note: it.m.text || '' });
  }
  this.segTotal = segs.length;               // 筛选前的片段总数（设置页显示命中数）
  // 集锦分类：按备注字符字面筛选（原片模式不筛）；筛完为空则回退全部并提示
  this.catEmpty = false;
  this.catActive = '';                       // 实际生效的筛选串（回退全部时为空）
  var terms = catTerms(SETTINGS.cat);
  if (SETTINGS.mode === 'hl' && terms.length && segs.length) {
    var f = [];
    for (var q = 0; q < segs.length; q++) {
      if (catMatch(segs[q].note, terms)) f.push(segs[q]);
    }
    if (f.length) { segs = f; this.catActive = terms.join(' '); }
    else this.catEmpty = true;
  }
  if (SETTINGS.mode === 'full' || !segs.length) {
    segs = [{ start: 0, dur: this.videoDuration > 0 ? this.videoDuration : 600, note: '' }];
  }
  // 大补时可能让相邻片段重叠：截断前一段，保证时间轴单调（后段自带前置补时，不会漏内容）
  for (var z = 0; z + 1 < segs.length; z++) {
    var maxEnd = segs[z + 1].start - 0.05;
    if (segs[z].start + segs[z].dur > maxEnd) {
      segs[z].dur = Math.max(0.6, maxEnd - segs[z].start);
    }
  }
  this.segs = segs;
  if (loopIdx >= 0) clearLoop(false, true);   // 序列重建后旧下标失效
  renderSegFloat(true);
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
      // 最近邻匹配：容忍评论数据漂移 + 用户自定义前置补时带来的起点偏移
      var best = null, bestGap = 8 + SETTINGS.padFront;
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

  if (d.v.readyState < 1 && !await once(d.v, 'loadedmetadata', 9000)) {
    // 元数据迟迟不来：换带随机参数的 URL 重试一次（绕开本地代理偶发的卡死响应）
    diag('prepare v-meta slow, retry with cache-bust rs=' + d.v.readyState);
    setSrc(d.v, '/api/media/' + this.token + '/v?i=0&r=' + Math.random().toString(36).slice(2));
    if (!await once(d.v, 'loadedmetadata', 9000)) {
      diag('prepare-fail rs=' + d.v.readyState + ' net=' + d.v.networkState);
      return false;
    }
  }
  if (this.hasAudio && d.a.readyState < 1 && !await once(d.a, 'loadedmetadata', 8000)) return false;
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
  var looping = loopFor(this);
  // 单段循环时「下一段」就是当前段：备用 deck 备到段首待命，段末硬切重播
  var j = looping ? this.idx : this.nextIdx();
  if (j < 0 || !this.token) { this.pendingIdx = -1; return; }
  var d = this.decks[1 - this.activeDeck];
  this.pendingIdx = j;
  var gen = this.gen;
  var warmLead = (looping || LOW_DECK_MODE) ? 0 : Math.min(Math.max(LEAD, 0.6), Math.max(0, this.segs[j].start));
  this.preparing = this.prepare(d, j, warmLead).then(function (ok) {
    if (!ok) return false;
    if (LOW_DECK_MODE) {
      // 大屏低解码模式：备用 deck 已预载到段首，保持暂停不播。
      // 段末 jumpTo 快路径会 showDeck(硬切) + startDeck(play)，首帧已在，无黑帧。
      d.rolling = false;
      try { d.v.pause(); if (self.hasAudio) d.a.pause(); } catch (e) {}
      return true;
    }
    if (loopFor(self) && self.pendingIdx === j) {
      // 循环专用：不能提前起播，否则备用 deck 会一路播到段末，切过去就跳过了开头
      d.rolling = false;
      try { d.v.pause(); d.a.pause(); } catch (e) {}
      return true;
    }
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
  revReset();                           // 切段回正向，避免跟双 deck 硬切打架
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
  revStopLoop();                       // 停倒放步进，但保留方向（播放键再按继续倒）
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
  else if (rev.dir < 0) {
    // 按当前（倒放）方向恢复：deck 保持暂停，重新启动倒放步进
    this.playing = true;
    this.render();
    revStartLoop();
  } else this.resumePlay();
  showChrome();
};

ClipPlayer.prototype.stopAll = function () {
  this.playing = false;
  this.idx = -1;
  this.pendingIdx = -1;
  this.gen++;
  revReset();
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
  if (LOW_DECK_MODE) return;     // 备用 deck 没在播，不需要钉时间轴
  if (loopFor(this)) return;      // 循环时备用 deck 必须停在段首，不能跟随段内进度
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
  if (loopFor(this)) { this.loopCurrent(); return; }
  var j = this.nextIdx();
  if (j < 0) {
    // 本场集锦播完：停住不自动跳下一场（调试专注模式）
    this.pauseAll();
    toast('本场播完');
    return;
  }
  this.jumpTo(j, {});
};

/** 单段循环：备用 deck 已停在段首 → 走 jumpTo 快路径硬切（无黑帧）；
 *  还没备好（刚锁定/网络慢）→ 直接把当前 deck seek 回段首兜底，不中断播放。 */
ClipPlayer.prototype.loopCurrent = function () {
  var i = this.idx, seg = this.segs[i];
  if (!seg) return;
  this.lastSwitchAt = performance.now();
  var d = this.decks[1 - this.activeDeck];
  if (d.seg === i && d.ready && !d.tracking && !d.rolling &&
      (d.v.readyState >= 2 || d.everReady)) {
    this.jumpTo(i);
    return;
  }
  var cur = this.decks[this.activeDeck];
  try { cur.v.currentTime = seg.start; } catch (e) {}
  if (this.hasAudio) { try { cur.a.currentTime = seg.start; } catch (e) {} }
  cam.track = this.tracks[i] || null;
  camCut(0);
  this.prepareNext();
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
  // 放大镜是第二路视频解码：离屏时不做同步，省一路解码开销
  if (page === 1 && (!this.lastMagSync || now - this.lastMagSync > 120)) {
    this.lastMagSync = now;
    this.magSync();
  }
  if (this.hasAudio) this.syncAudio();
  if (this.idx >= 0 && now - this.lastPosSave > 2000) {
    this.lastPosSave = now;
    this.savePos();
  }
  if (!this.playing || this.busy || this.idx < 0) return;
  if (rev.dir < 0) return;   // 倒放中：时间轴由 revStep 乒乓流水驱动，段末判断 / 预热跟随全跳过
  var cur = this.decks[this.activeDeck];
  var seg = this.segs[this.idx];
  if (!seg) return;
  // 卡死看门狗：状态上是「在播」，但解码器停住（元素被内部暂停 / readyState 掉底）
  // → 先轻推 currentTime 强制重新出帧；反复推不活 → 重新准备本段。修两类真机问题：
  //    ① 横滑回退后画面冻住  ② 暂停后继续播放画面不动
  if (cur.v.paused || cur.v.readyState < 2) {
    if (!this.stallSince) {
      this.stallSince = now;
    } else if (now - this.stallSince > 1500) {
      this.stallSince = now;
      this.stallTries = (this.stallTries || 0) + 1;
      if (this.stallTries <= 3) {
        diag('stall nudge #' + this.stallTries + ' idx=' + this.idx +
          ' rs=' + cur.v.readyState + ' paused=' + cur.v.paused);
        try { cur.v.currentTime = Math.max(seg.start, cur.v.currentTime + 0.02); } catch (e) {}
        safePlay(cur.v);
        if (this.hasAudio) safePlay(cur.a);
      } else {
        this.stallTries = 0;
        diag('stall re-prepare idx=' + this.idx);
        this.jumpTo(this.idx, { seekOffset: clamp(cur.v.currentTime - seg.start, 0, seg.dur) });
        return;
      }
    }
  } else { this.stallSince = 0; this.stallTries = 0; }
  var end = seg.start + seg.dur;
  var ct = cur.v.currentTime;
  this.followPreheated(ct, end);
  if (ct >= end - 0.012) { this.onSegmentEnd(); return; }
  if (now - this.lastHud > 100) { this.lastHud = now; this.hud(ct, end); }
};

ClipPlayer.prototype.hud = function (ct, end) {
  if (page !== 1) return;
  syncSegFloatActive();          // 当前段高亮 / 锁定态（有状态守卫，不随帧改 DOM）
  var seg = this.segs[this.idx];
  if (!seg) return;
  var p = clamp((ct - seg.start) / Math.max(0.1, seg.dur), 0, 1);
  this.fillEl.style.width = (p * 100).toFixed(1) + '%';
  var sub = dateStr(this.item.pubdate);
  if (SETTINGS.mode === 'hl' && this.segs.length) sub += ' · 集锦 ' + (this.idx + 1) + '/' + this.segs.length;
  else sub += ' · 原片 ' + fmt(this.videoDuration);
  if (SETTINGS.mode === 'hl' && this.catActive) {
    sub += ' · 筛选「' + this.catActive + '」';
  }
  if (loopFor(this)) sub += ' · 单段循环';
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
  syncSegFloatActive();   // 跳段后立刻高亮浮窗当前行（不必等下一次 hud）
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
  manual: false,               // 自定义缩放接管：不跑识别、不自动回中、松手也不恢复
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

/** 是否由用户自定义缩放接管（true=固定倍率+固定中心，false=自动跟焦） */
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
  // 自定义缩放：切段不动镜头，保持用户设定的倍率与画面中心
  if (!SETTINGS.zoomOn || cam.manual) {
    cam.tx = cam.x; cam.ty = cam.y;
    cam.tz = SETTINGS.zoom;
    cam.zoom = SETTINGS.zoom;
    cam.lastMove = performance.now();
    camApply();
    return;
  }
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
  // 目标倍率：关掉自动跟焦=用户自定义固定倍率（不跑识别、不跟随）；
  // 自动构图=算法推荐（1~上限），算法无意见时回落到用户偏好倍率
  var cap = Math.max(SETTINGS.zoom, FOCUS_CFG.maxAutoZoom);
  if (!SETTINGS.zoomOn || cam.manual) cam.tz = SETTINGS.zoom;
  else {
    var az = camAutoZoom(now, c);
    cam.tz = (az == null) ? SETTINGS.zoom : clamp(az, 1, cap);
    if (isSplit()) cam.tz = Math.max(cam.tz, FOCUS_CFG.minMagZoom);
  }
  // 目标位置：预读轨迹插值 + 实时采样按 liveWeight 修正（仅自动跟焦时）
  var live = SETTINGS.zoomOn && !cam.manual && c && c.playing && !c.busy && c.idx >= 0;
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
  updateViewReset();
  var s = cam.zoom;
  var v, w, h, ov;
  if (split) {
    v = c.magV; ov = c.algoMag;
    w = c.magview.clientWidth || 1;
    h = c.magview.clientHeight || 1;
    var mv = c.visibleVideo();
    // 无缩放时不要留 transform：合成层会让部分折叠屏的视频画面冻结
    if (mv) mv.style.transform = 'none';
    if (c.algoMain) c.algoMain.style.transform = 'none';
  } else {
    v = c.visibleVideo();
    ov = c.algoMain;
    if (!v) return;
    w = v.clientWidth || 1;
    h = v.clientHeight || 1;
  }
  if (!v) return;
  // contain 时视频内容比容器小（有黑边）：平移/放大必须按「实际内容尺寸」算，
  // 否则 s=1.x 时会把黑边当成画面推来推去，甚至露出新的黑边。
  // 实际内容尺寸：contain（或双指接管期）= 完整画面内接于容器；
  // cover 布满容器，但被裁掉的源画面内容永远渲染不出来——双指接管时已先切 contain
  var cw = w, ch = h;
  var fitNow = manualFit ? 'contain'
    : (split ? (v.style.objectFit || 'cover')
             : (SETTINGS.fit === 'cover' ? 'cover' : 'contain'));
  if (fitNow === 'contain' && v.videoWidth && v.videoHeight) {
    var vr = v.videoWidth / v.videoHeight, br = w / Math.max(1, h);
    if (vr > br) ch = w / vr; else cw = h * vr;
  }
  var tx = 0, ty = 0;
  if (s > 1.001) {
    var limX = Math.max(0, (cw * s - w) / 2), limY = Math.max(0, (ch * s - h) / 2);
    tx = clamp(-(cam.x - 0.5) * cw * s, -limX, limX);
    ty = clamp(-(cam.y - 0.5) * ch * s, -limY, limY);
  }
  // 纯 1.00× 且无平移时写 none，避免无谓的 GPU 合成层（大屏视频冻结的常见诱因）
  var tf = (s <= 1.0005 && Math.abs(tx) < 0.05 && Math.abs(ty) < 0.05)
    ? 'none'
    : 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
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
  var fit = (SETTINGS.fit === 'cover') ? 'cover' : 'contain';
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
  if (loopIdx >= 0 && loopBvid !== (items[i] && items[i].bvid)) clearLoop(false, true);
  renderSegFloat();
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
  // 不再因为切换比赛就自动翻页：列表只在用户点「加载更多」时追加
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
    // 风控(-352)/网络失败不清除 hasMore：保留「加载更多」入口，稍后可重试。
    // 早期版本在这里置 false，按钮会永久消失，用户只能重启应用。
    toast('翻页失败：' + (e.message || e) + '（稍后再点「加载更多」重试）');
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
   三页控制器：0 比赛列表 / 1 播放 / 2 设置
   横向位移用内容 px（窄视口下 #appWrap 被 scale() 缩放，见 viewportScale）
   ============================================================ */
function pageWidth() {
  var w = $('#appWrap');
  return (w && w.clientWidth) || window.innerWidth || 400;
}
function pageTransform(dx) {
  if (!pagerEl) return;
  var base = (1 - page) * pageWidth();
  pagerEl.style.transform = 'translateX(' + (base + (dx || 0)) + 'px)';
}
function goPage(p, anim) {
  p = clamp(p | 0, 0, 2);
  var prev = page;
  page = p;
  document.body.setAttribute('data-page', String(p));
  var tabs = document.querySelectorAll('.ptab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('on', +tabs[i].getAttribute('data-page') === p);
  }
  if (pagerEl) {
    if (anim === false) pagerEl.classList.add('dragging');
    else pagerEl.classList.remove('dragging');
  }
  pageTransform(0);
  if (anim === false && pagerEl) {
    void pagerEl.offsetWidth;               // 强制回流，避免首帧带过渡
    pagerEl.classList.remove('dragging');
  }
  // 离屏时挂起放大镜那一路视频解码，回来再续上（漂移由 magSync 修正）
  var c = activeClip();
  if (p !== 1) {
    if (c && c.magV) { try { c.magV.pause(); } catch (e) {} }
  } else if (prev !== 1) {
    if (c && c.magV && isSplit() && c.state === 'ready') {
      try { c.magV.play(); } catch (e) {}
    }
    showChrome();
  }
  if (p === 0) renderVList(false);   // 打开列表不自动补页
  if (p === 1) { renderSegFloat(); syncSegFloatActive(); }
  if (p === 2) syncSettingsUI();
}
function bindPages() {
  pagerEl = $('#pager');
  var tabs = document.querySelectorAll('.ptab');
  for (var i = 0; i < tabs.length; i++) {
    (function (b) {
      b.addEventListener('click', function () { goPage(+b.getAttribute('data-page')); });
    })(tabs[i]);
  }
  var vl = $('#vlistClose');
  if (vl) vl.addEventListener('click', function () { goPage(1); });
  var sb = $('#setBack');
  if (sb) sb.addEventListener('click', function () { goPage(1); });
  var body = $('#vlistBody');
  if (body) {
    body.addEventListener('scroll', function () {
      if (vlistRaf) return;
      vlistRaf = requestAnimationFrame(function () {
        vlistRaf = 0;
        renderVListWindow(false);   // 滚到底也不自动翻页，只点「加载更多」
      });
    }, { passive: true });
  }
  var canvas = $('#vlistCanvas');
  if (canvas) {
    // 事件委托：整张列表只有一个监听器，行数再多也不增加绑定
    canvas.addEventListener('click', function (e) {
      // 横向切页结束后浏览器仍可能补一个 click，别误触发选片
      if (tpage.swiped && Date.now() - tpage.endAt < 400) return;
      var row = (e.target && e.target.closest) ? e.target.closest('.vrow') : null;
      if (!row || row.style.display === 'none') return;
      var pos = +row.getAttribute('data-pos');
      var realIdx = vlistMap[pos];
      if (realIdx == null || isNaN(realIdx)) return;
      goPage(1);
      if (realIdx !== active) switchTo(realIdx);
    });
  }
  var more = $('#vlistMore');
  if (more) more.addEventListener('click', function () { requestVListMore(); });

  /* 三页只通过顶部标签（或列表页的 ▶ 返回按钮）切换。
     用户明确要求「不要左右滑动就切换」：横滑一律忽略；
     纵向手势（亮度/音量、列表原生滚动）保持原样。 */
  pageTransform(0);
}

/* ============================================================
   集锦浮窗（本场片段跳转）+ 单片段循环
   loopIdx 是片段下标，绑定到 loopBvid 这场比赛；换场/序列重建会自动解除。
   ============================================================ */
var loopIdx = -1;          // -1 = 恢复正常顺序连播
var loopBvid = '';
var sfSegsFor = null;      // 已渲染的 segs 数组引用（数组换了才重画 DOM）
var sfLastIdx = -2, sfLastBvid = '', sfLastLoop = -2;

function loopFor(c) {
  return !!(c && loopIdx >= 0 && loopIdx === c.idx &&
            loopBvid === (c.item && c.item.bvid));
}

/** 重建浮窗行（segs 引用变化 或 force 时才动 DOM） */
function renderSegFloat(force) {
  var box = $('#sfBody');
  if (!box) return;
  var c = activeClip();
  var segs = (c && c.segs && c.segs.length) ? c.segs : null;
  if (!force && segs === sfSegsFor) return;
  sfSegsFor = segs;
  box.innerHTML = '';
  if (!segs || !segs.length) {
    var e = document.createElement('div');
    e.className = 'sf-empty';
    e.textContent = '尚未载入集锦';
    box.appendChild(e);
  } else {
    for (var i = 0; i < segs.length; i++) {
      var row = document.createElement('div');
      row.className = 'sf-row';
      row.setAttribute('data-i', String(i));
      var no = document.createElement('span');
      no.className = 'sf-no';
      no.textContent = (i + 1) < 10 ? '0' + (i + 1) : '' + (i + 1);
      var t = document.createElement('span');
      t.className = 'sf-t';
      t.textContent = fmt(segs[i].start);
      var note = document.createElement('span');
      note.className = 'sf-note';
      note.textContent = String(segs[i].note == null ? '' : segs[i].note)
        .replace(/\s+/g, ' ').slice(0, 10);
      // 每行只显示序号/时间/备注：单段循环入口统一放左下角播放控件 #btnLoop
      row.appendChild(no); row.appendChild(t); row.appendChild(note);
      box.appendChild(row);
    }
  }
  var cnt = $('#sfCount');
  if (cnt) {
    var total = (c && c.segTotal) || (segs ? segs.length : 0);
    cnt.textContent = !segs ? '—'
      : (total > segs.length ? (segs.length + '/' + total + ' 段') : (segs.length + ' 段'));
  }
  var tt = $('#sfTitle');
  if (tt) tt.textContent = SETTINGS.mode === 'full' ? '全场' : '集锦';
  sfLastIdx = -2;
  syncSegFloatActive();
}

/** 集锦浮窗标题点击：集锦连播 ↔ 全场录像 */
function togglePlayMode() {
  SETTINGS.mode = (SETTINGS.mode === 'hl') ? 'full' : 'hl';
  saveSettings();
  syncSettingsUI();
  var tt = $('#sfTitle');
  if (tt) tt.textContent = SETTINGS.mode === 'full' ? '全场' : '集锦';
  rebuildActiveSegs(SETTINGS.mode === 'full' ? '切换全场录像' : '切换集锦连播');
}

/** 当前段高亮 + 锁定态 + 自动滚动到可见；有状态守卫，不随帧重复改 DOM */
function syncSegFloatActive() {
  if (page !== 1) return;
  var c = activeClip();
  var bv = (c && c.item && c.item.bvid) || '';
  var idx = c ? c.idx : -1;
  if (sfLastIdx === idx && sfLastBvid === bv && sfLastLoop === loopIdx) return;
  sfLastIdx = idx; sfLastBvid = bv; sfLastLoop = loopIdx;
  var rows = document.querySelectorAll('#sfBody .sf-row');
  var cur = null;
  for (var i = 0; i < rows.length; i++) {
    var n = +rows[i].getAttribute('data-i');
    var on = (n === idx), lp = (loopIdx >= 0 && n === loopIdx);
    rows[i].classList.toggle('on', on);
    rows[i].classList.toggle('loop', lp);   // 循环中的段保留橙色底，但行内没有按钮
    if (on) cur = rows[i];
  }
  if (cur) {
    var body = $('#sfBody');
    var top = cur.offsetTop, bot = top + cur.offsetHeight;
    var rh = cur.offsetHeight || 30;
    // 对齐到整行，避免列表顶部/底部露出半行文字
    if (top < body.scrollTop) body.scrollTop = Math.max(0, Math.floor(top / rh) * rh);
    else if (bot > body.scrollTop + body.clientHeight) {
      body.scrollTop = Math.ceil((bot - body.clientHeight) / rh) * rh;
    }
  }
  var st = $('#sfState');
  if (st) st.textContent = loopIdx >= 0 ? ('循环第 ' + (loopIdx + 1) + ' 段') : '点行跳转片段';
  var lb = $('#btnLoop');
  if (lb) {
    var locked = loopIdx >= 0 && loopBvid === bv;
    lb.classList.toggle('on', locked);
    lb.textContent = locked ? '解' : '锁';
    lb.title = locked ? '解除单段循环' : '锁定当前片段循环播放';
  }
}

/** 锁定/解锁某一段；锁定时若不在该段就先跳过去 */
function setLoopSeg(i, on) {
  var c = activeClip();
  if (!c || c.state !== 'ready' || i < 0 || i >= c.segs.length) return;
  if (!on || loopIdx === i) { clearLoop(true); return; }
  loopIdx = i;
  loopBvid = c.item.bvid;
  diag('loop seg ' + (i + 1) + '/' + c.segs.length);
  if (c.idx !== i) c.jumpTo(i);
  else c.prepareNext();     // 就地锁定：立刻把备用 deck 备到段首
  toast('单段循环 · 第 ' + (i + 1) + ' 段');
  syncSegFloatActive();
  showChrome();
}

function clearLoop(notify, quiet) {
  if (loopIdx < 0) return;
  loopIdx = -1;
  loopBvid = '';
  // quiet：换场 / 片段序列重建时只清状态，别去预热带起一次多余加载
  if (!quiet) {
    var c = activeClip();
    if (c && c.state === 'ready' && c.idx >= 0) c.prepareNext();
  }
  if (notify) toast('已解除单段循环');
  syncSegFloatActive();
}

function bindSegFloat() {
  var body = $('#sfBody');
  if (body) {
    body.addEventListener('click', function (e) {
      var tg = e.target;
      var c = activeClip();
      if (!c || c.state !== 'ready') return;
      var row = (tg && tg.closest) ? tg.closest('.sf-row') : null;
      if (!row) return;
      var j = +row.getAttribute('data-i');
      if (loopIdx >= 0 && j !== loopIdx) clearLoop(false);
      if (j !== c.idx) c.jumpTo(j);
      showChrome();
    });
  }
  var fold = $('#sfFold');
  if (fold) {
    fold.addEventListener('click', function () {
      var el = $('#segFloat');
      el.classList.toggle('fold');
      // 浮窗在右侧：展开态箭头指右（收过去），收起态箭头指左（拉出来）
      fold.textContent = el.classList.contains('fold') ? '‹' : '›';
    });
  }
  // 标题「集锦/全场」= 播放内容切换按钮
  var sfT = $('#sfTitle');
  if (sfT) sfT.addEventListener('click', togglePlayMode);
  // 单段循环唯一入口：左下角播放控件的「锁 / 解」
  var lb = $('#btnLoop');
  if (lb) lb.addEventListener('click', function () {
    var c = activeClip();
    if (!c || c.state !== 'ready' || c.idx < 0) { toast('片段载入后再锁定'); return; }
    var bv = (c.item && c.item.bvid) || '';
    if (loopIdx >= 0 && loopBvid === bv) clearLoop(true);
    else setLoopSeg(c.idx, true);
    showChrome();
  });
}

/* 兼容旧入口：顶部工具栏图标 / 键盘 Escape 仍走这些函数 */
function vListOpen() { return page === 0; }
function openVList() { goPage(0); }
function closeVList() { if (page === 0) goPage(1); }

// ---------- 系统返回键（MainActivity.onBackPressed 经 evaluateJavascript 调进来） ----------
// 返回 1 = 已消费（设置/列表页 → 回播放页）；返回 0 = 没消费（Java 走「再按一次退出」）
function handleAndroidBack() {
  if (page !== 1) { goPage(1); return 1; }
  return 0;
}

/* =============================================================
   第 0 页：比赛列表（虚拟滚动）
   只渲染视口 ±3 行并循环复用节点；数百条列表也只维护约 20 个 DOM 行
   ============================================================ */
var VROW_H = 58;
var vlistMap = [];        // 行号 → items 下标（避免 indexOf 的 O(n²) 与整表复制）
var vlistPool = [];       // 复用的 .vrow 节点
var vlistRaf = 0;
var vlistWinStart = -1, vlistWinEnd = -1;
var vlistLoadingMore = false;

/** 标题清理：「[实况录像+集锦] 五人场 20261011」→「五人场 2026-10-11」 */
function videoLabel(it) {
  var t = String(it.title || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  t = t.replace(/(\d{4})(\d{2})(\d{2})/, function (m, y, mo, d) { return y + '-' + mo + '-' + d; });
  return t || it.bvid;
}

/** 只保留集锦系列；一条都没有时不过滤。只存下标，不复制对象数组 */
function buildVListMap() {
  vlistMap.length = 0;
  for (var i = 0; i < items.length; i++) {
    if (items[i].hl !== false) vlistMap.push(i);
  }
  if (!vlistMap.length) {
    for (var j = 0; j < items.length; j++) vlistMap.push(j);
  }
}

function makeVRow() {
  var row = document.createElement('div');
  row.className = 'vrow';
  row.innerHTML = '<div class="vrow-idx"></div>' +
    '<div class="vrow-main"><div class="vrow-t"></div><div class="vrow-s"></div></div>' +
    '<div class="vrow-badge">集锦</div>' +
    '<div class="vrow-play"></div>';
  row._idx = $('.vrow-idx', row);
  row._t = $('.vrow-t', row);
  row._s = $('.vrow-s', row);
  row._badge = $('.vrow-badge', row);
  return row;
}

function fillVRow(row, pos) {
  var realIdx = vlistMap[pos];
  var it = items[realIdx];
  if (!it) return;
  row.setAttribute('data-pos', String(pos));
  row.className = 'vrow' + (realIdx === active ? ' on' : '');
  row._idx.textContent = String(pos + 1);
  row._t.textContent = videoLabel(it);
  var sub = (it.duration ? it.duration + ' · ' : '') + dateStr(it.pubdate);
  var c = clips[realIdx];
  if (c && c.state === 'ready' && c.segs.length && SETTINGS.mode === 'hl') {
    sub += ' · 集锦 ' + c.segs.length + ' 段';
  }
  row._s.textContent = sub;
  row._badge.style.display = (it.hl === false) ? 'none' : '';
}

function renderVListWindow(force) {
  var body = $('#vlistBody'), canvas = $('#vlistCanvas');
  if (!body || !canvas) return;
  var total = vlistMap.length;
  var vh = body.clientHeight || 600;
  var st = body.scrollTop;
  var start = Math.max(0, Math.floor(st / VROW_H) - 3);
  var end = Math.min(total, Math.ceil((st + vh) / VROW_H) + 3);
  if (!force && start === vlistWinStart && end === vlistWinEnd) return;
  vlistWinStart = start; vlistWinEnd = end;
  var need = Math.max(0, end - start);
  while (vlistPool.length < need) {
    var r = makeVRow();
    canvas.appendChild(r);
    vlistPool.push(r);
  }
  for (var i = 0; i < vlistPool.length; i++) {
    var row = vlistPool[i], pos = start + i;
    if (i >= need) { row.style.display = 'none'; continue; }
    row.style.display = '';
    row.style.top = (pos * VROW_H) + 'px';
    fillVRow(row, pos);
  }
}

/** keepScroll=true：翻页追加数据时不打断用户当前滚动位置 */
function renderVList(keepScroll) {
  var body = $('#vlistBody'), canvas = $('#vlistCanvas');
  if (!body || !canvas) return;
  var oldTop = body.scrollTop;
  buildVListMap();
  var total = vlistMap.length;
  canvas.style.height = (total * VROW_H) + 'px';
  var cnt = $('#vlistCount');
  if (cnt) cnt.textContent = total + ' 场';
  var foot = $('#vlistFoot');
  if (foot) foot.hidden = !feedHasMore;
  var more = $('#vlistMore');
  if (more && !vlistLoadingMore) more.textContent = '加载更多（已 ' + items.length + ' 场）';
  vlistWinStart = -1; vlistWinEnd = -1;
  if (keepScroll) {
    body.scrollTop = oldTop;
  } else {
    var ai = vlistMap.indexOf(active);
    if (ai > 0) {
      body.scrollTop = Math.max(0, ai * VROW_H - Math.floor(body.clientHeight / 2) + Math.floor(VROW_H / 2));
    }
  }
  renderVListWindow(true);
}

/* 列表不自动翻页：打开列表、滚动到底、切换比赛都不追加，
   只有点底部的「加载更多」才走 requestVListMore()。 */
function requestVListMore() {
  if (!feedHasMore || feedLoading || vlistLoadingMore) return;
  vlistLoadingMore = true;
  var foot = $('#vlistFoot');
  if (foot) foot.hidden = false;
  var more = $('#vlistMore');
  if (more) more.textContent = '加载中…';
  loadMore().then(function (ok) {
    vlistLoadingMore = false;
    renderVList(true);          // 失败也保留 hasMore，底部按钮继续可见
    if (ok === false && more) more.textContent = '加载失败，点此重试';
  }, function () {
    vlistLoadingMore = false;
    if (more) more.textContent = '加载失败，点此重试';
    if (foot) foot.hidden = false;
  });
}

/* =============================================================
   手势：竖滑切换 / 点按显隐 chrome / 滚轮与键盘（桌面调试）
   ============================================================= */
var drag = { on: false, y0: 0, y: 0, t0: 0, moved: false, vy: 0 };
var pointers = {};            // pointerId -> {x, y}（活跃指针）
var gesture = 'none';         // none | swipe | pinch
/* 已取消横向切页：这里保留 tpage 仅为兼容列表点击的补发 click 判定 */
var tpage = { on: false, x0: 0, y0: 0, axis: null, dx: 0, vx: 0, t0: 0, swiped: false, endAt: 0 };
var pinch = { d0: 0, mx0: 0, my0: 0, zoom0: 1, fx0: 0.5, fy0: 0.5, vw: 1, vh: 1, moved: false, turnedOff: false };
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

/** 第二根手指落下 → 自定义缩放（固定倍率 + 可平移），彻底关掉自动跟焦 */
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
  pinch.zoom0 = Math.max(1, SETTINGS.zoom);
  pinch.fx0 = cam.x; pinch.fy0 = cam.y;
  pinch.vw = vp.w; pinch.vh = vp.h;
  pinch.moved = false;
  pinch.turnedOff = !!SETTINGS.zoomOn;
  if (SETTINGS.zoomOn) {
    SETTINGS.zoomOn = false;       // 捏合 = 我要自己定倍率，不要球跟踪
    saveSettings();
  }
  camManual(true);                 // 持续接管，不再定时恢复
  manualFitOn();                   // cover 裁掉的两侧也要能到达：接管期间切 contain
  syncZoomIcons();
  var sw = $('#autoSw');
  if (sw) sw.classList.remove('on');
}

function movePinch() {
  var d = pinchDist();
  var c = pinchCenter();
  if (d < 1 || !c) return;
  // 捏合 → 固定倍率（1~3×），写入设置但保持 zoomOn=false
  var z = clamp(pinch.zoom0 * (d / pinch.d0), 1, 3);
  SETTINGS.zoom = Math.round(z * 100) / 100;
  saveSettings();
  syncZoomChips();
  // 双指拖动 → 平移画面中心（不跟球，纯粹自定义取景）
  var dx = c.x - pinch.mx0, dy = c.y - pinch.my0;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pinch.moved = true;
  if (pinch.moved) {
    var s = Math.max(1, SETTINGS.zoom);
    cam.tx = clamp(pinch.fx0 - dx / (pinch.vw * s), 0, 1);
    cam.ty = clamp(pinch.fy0 - dy / (pinch.vh * s), 0, 1);
  }
  camApply();
}

/** 手指离开：倍率与画面中心原样保留，不恢复自动跟踪；浮出「恢复画面」按钮 */
function endPinch() {
  gesture = 'none';
  camManual(true);
  updateViewReset();
  if (pinch.turnedOff) {
    toast('自定义缩放 ' + SETTINGS.zoom.toFixed(2) + '× · 已停跟踪（设置里可开回自动跟焦）');
    pinch.turnedOff = false;
  }
}

/* ---------- 用户自助取景：cover→contain 切换 + 恢复画面按钮 ----------
   object-fit: cover 的元素，被裁掉的源画面内容永远渲染不出来，怎么平移都到不了；
   双指接管期间把取景用的 video 切到 contain，全画面任意位置就都可达了。
   「恢复画面」一键回到 1.00× 居中并还原 object-fit（所有模式通用）。 */
var manualFit = false;      // 双指接管期间 cover→contain
var vrShown = false;        // 恢复按钮当前显隐（防每帧写 DOM）
function manualFitOn() {
  manualFit = true;
  var c = activeClip();
  if (!c) return;
  if (isSplit() && c.magV) c.magV.style.objectFit = 'contain';
  else for (var i = 0; i < c.decks.length; i++) c.decks[i].v.style.objectFit = 'contain';
}
function manualFitOff() {
  if (!manualFit) return;
  manualFit = false;
  var c = activeClip();
  if (c && c.magV) c.magV.style.objectFit = 'cover';
  applyFit();               // 主画面的 object-fit 回「画面填充」设置（内部会 camApply）
}
/** 用户调整过取景（缩放/平移/切换 contain）→ 浮出「恢复画面」 */
function updateViewReset() {
  var touched = cam.manual && (SETTINGS.zoom > 1.001 ||
    Math.abs(cam.x - 0.5) > 0.004 || Math.abs(cam.y - 0.5) > 0.004 || manualFit);
  if (touched === vrShown) return;
  vrShown = touched;
  var b = $('#viewReset');
  if (b) b.hidden = !touched;
}
function resetView() {
  SETTINGS.zoom = 1;
  saveSettings();
  syncZoomChips();
  cam.x = cam.tx = 0.5;
  cam.y = cam.ty = 0.5;
  cam.zoom = cam.tz = 1;
  cam.lx = -1; cam.ly = -1; cam.lz = -1;   // 强制下一帧重写 transform
  manualFitOff();
  camManual(!SETTINGS.zoomOn);   // 开着跟踪球就交还算法；否则固定 1× 居中
  camApply();
  updateViewReset();
  toast('画面已恢复');
}

/** 横向跟手位移：dxs 是屏幕 px，换算成被 scale 过的内容 px；边缘加阻尼 */
function movePage(dxs) {
  var dx = dxs / (viewportScale || 1);
  if ((page === 0 && dx > 0) || (page === 2 && dx < 0)) dx *= 0.3;
  drag.dx = dx;
  drag.vx = dx / Math.max(1, performance.now() - drag.t0);
  pageTransform(dx);
}
function endPageDrag(dxs) {
  var dx = dxs / (viewportScale || 1);
  var threshold = Math.min(pageWidth() * 0.22, 90);
  var fast = Math.abs(drag.vx || 0) > 0.5;
  var target = page;
  if (dx < -threshold || (fast && dx < -30)) target = page + 1;
  else if (dx > threshold || (fast && dx > 30)) target = page - 1;
  goPage(clamp(target, 0, 2));
}

function bindGestures() {
  var hit = pagerEl || feedEl;
  hit.addEventListener('pointerdown', function (e) {
    if (gesture === 'pinch') return;
    // 集锦浮窗：点行/点锁/列表滚动都不参与播放页的亮度、音量、单击暂停手势
    if (e.target && e.target.closest && e.target.closest('#segFloat')) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (countPointers() >= 2) {
      if (page === 1 && active >= 0) startPinch();
      else { gesture = 'none'; drag.on = false; }
      return;
    }
    gesture = 'swipe';
    drag.on = true;
    drag.ptype = e.pointerType || 'mouse';
    drag.inFeed = (page === 1 && active >= 0);
    drag.x0 = e.clientX; drag.y0 = e.clientY;
    drag.y = 0; drag.dx = 0; drag.vx = 0; drag.axis = null; drag.mode = null;
    drag.seek = false; drag.seekT = null; drag.seekSeg = null;
    drag.bright0 = SETTINGS.brightness; drag.vol0 = SETTINGS.volume;
    drag.wasPlaying = false;
    drag.moved = false; drag.t0 = performance.now(); drag.vy = 0;
    if (drag.inFeed) feedEl.style.transition = 'none';
  });
  window.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in pointers)) return;
    pointers[e.pointerId].x = e.clientX;
    pointers[e.pointerId].y = e.clientY;
    if (gesture === 'pinch') { movePinch(); return; }
    // 触摸的横向切页由 touchmove 负责（指针事件会被浏览器 pointercancel 掐断）
    if (gesture === 'page') {
      if (drag.ptype !== 'touch') movePage(e.clientX - drag.x0);
      return;
    }
    if (!drag.on) return;
    var dxs = e.clientX - drag.x0;
    var dys = e.clientY - drag.y0;
    if (!drag.axis) {
      if (Math.abs(dxs) < 12 && Math.abs(dys) < 12) return;
      // 横向占优：播放页 → 单指横滑快进/回退；其他情况放弃手势（不误调亮度/音量）
      if (Math.abs(dxs) > Math.abs(dys) * 1.2 && Math.abs(dxs) >= 12) {
        var cs = drag.inFeed ? activeClip() : null;
        if (cs && cs.state === 'ready' && cs.idx >= 0 && cs.segs[cs.idx]) {
          drag.axis = 'x';
          drag.seek = true;
          drag.wasPlaying = cs.playing;   // 拖动期间整体暂停预览（对暂停元素 seek 更稳），松手恢复
          if (cs.playing) cs.pauseAll();
          drag.seekT = null;
          drag.seekPrevAt = 0;
          drag.seek0 = cs.decks[cs.activeDeck].v.currentTime;
          drag.seekSeg = cs.segs[cs.idx];
          moveSeek(0);
        } else {
          drag.on = false;
          drag.axis = 'x';
        }
        return;
      }
      if (Math.abs(dys) >= 10) drag.axis = 'y';
      else return;
    }
    if (drag.seek) { moveSeek(dxs); return; }
    if (!drag.inFeed) return;   // 侧页纵向滚动交给原生，JS 不插手
    var dy = dys;
    if (!drag.moved) {
      drag.moved = true;
      // 左右半屏分派：左＝亮度，右＝音量
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
    if (!drag.on && gesture !== 'page') return;
    var axis = drag.axis;
    var wasMode = drag.mode;
    var inFeed = drag.inFeed;
    var moved = drag.moved;
    var ptype = drag.ptype;
    var dy = drag.y, vy = drag.vy;
    drag.on = false; drag.axis = null; drag.mode = null;
    gesture = 'none';
    if (axis === 'x') {
      if (drag.seek) { endSeek(); return; }
      if (ptype !== 'touch') endPageDrag(e.clientX - drag.x0);
      return;   // 触摸交给随后的 touchend 收尾
    }
    if (!inFeed) {   // 侧页：点击与纵向滚动都由页面自身处理
      if (pagerEl) pagerEl.classList.remove('dragging');
      pageTransform(0);
      return;
    }
    if (feedEl) feedEl.style.transition = '';
    if (wasMode) {   // 亮度/音量滑动结束：落盘并复位
      saveSettings();
      feedTransform(active, true);
      return;
    }
    if (!moved) { onTap(e); return; }
    var h = feedEl.clientHeight || window.innerHeight;
    var fast = Math.abs(vy) > 0.55;
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
    var wasPageDrag = (gesture === 'page');
    var inFeed = drag.inFeed;
    var ptype = drag.ptype;
    if (drag.seek) { cancelSeek(); }
    drag.on = false; drag.mode = null; drag.axis = null;
    gesture = 'none';
    // 触摸的 pointercancel 只是浏览器接管纵向滚动，横向切页仍由 touchmove 继续
    if (wasPageDrag && ptype !== 'touch') { goPage(page); return; }
    if (inFeed && !wasPageDrag) feedTransform(active, true);
  });

  feedEl.addEventListener('wheel', function (e) {
    if (page !== 1) return;
    if (Math.abs(e.deltaY) < 12) return;
    var now = performance.now();
    if (now - lastWheel < 600) return;
    lastWheel = now;
    if (e.deltaY > 0) nextVideo(); else prevVideo();
  }, { passive: true });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSheet(); closeVList(); return; }
    if (e.key === 'ArrowLeft') { goPage(page - 1); return; }
    if (e.key === 'ArrowRight') { goPage(page + 1); return; }
    if (page !== 1) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') nextVideo();
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') prevVideo();
    else if (e.key === ' ') {
      e.preventDefault();
      var c = activeClip();
      if (c) c.togglePlay();
    }
  });

  document.addEventListener('visibilitychange', function () {
    var c = activeClip();
    if (!c) return;
    if (document.hidden) c.pauseAll();
    else if (c.state === 'ready' && c.idx >= 0) c.togglePlay();   // 按当前方向（含倒放）恢复
  });
}

function onTap(e) {
  if (e && e.target && e.target.closest) {
    if (e.target.closest('button, .sheet, .fallback, .sheet-mask, #segFloat')) return;
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
/** 左下角播放/暂停图标与状态同步（render 里带守卫调用）：
 *  播放中 → 暂停图标；暂停时按方向显示 ▶（正放）或 ◀（倒放） */
function syncPlayIcon() {
  var b = $('#btnPlay'), c = activeClip();
  if (!b) return;
  var playing = !!(c && c.playing);
  var key = playing ? 'pause' : (rev.dir < 0 ? 'rev' : 'play');
  if (b._lastIcon === key) return;
  b._lastIcon = key;
  b.innerHTML = playing ? ICON_PAUSE : (rev.dir < 0 ? ICON_PLAY_REV : ICON_PLAY);
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
  var br = $('#btnRev');
  if (br) br.addEventListener('click', function () {
    setPlayDir(-rev.dir);               // 不是开关：按一下把播放方向翻过来
  });
  var bt = $('#btnTrack');              // 跟踪球：算法自动追球取景（横屏/竖屏都生效）
  if (bt) bt.addEventListener('click', function () {
    setAutoFocus(!SETTINGS.zoomOn);
  });
  var vr2 = $('#viewReset');            // 恢复画面：回 1× 居中 + 还原画面填充
  if (vr2) vr2.addEventListener('click', resetView);
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

/* ---------- 单指横滑快进 / 回退（播放页） ----------
   拖动期间整体暂停（对暂停的元素 seek 稳得多，修真机「回退后画面冻住」），
   预览帧照常跟手；时间变化不弹居中 OSD，直接显示在底部进度条上（圆点 + 气泡）。 */
var SEEK_SPAN = 90;        // 拖满一屏宽 = ±90 秒
function moveSeek(dxs) {
  var seg = drag.seekSeg;
  if (!seg || !drag.seek) return;
  var w = window.innerWidth || 1;
  var target = clamp(drag.seek0 + dxs / w * SEEK_SPAN, seg.start, seg.start + seg.dur);
  drag.seekT = target;
  // 跟手预览：节流 120ms，只 seek 视频（音频松手再对齐），拖动中就能看到画面在走
  var now = performance.now();
  if (now - (drag.seekPrevAt || 0) > 120) {
    drag.seekPrevAt = now;
    var cp = activeClip();
    if (cp && cp.state === 'ready') {
      try { cp.decks[cp.activeDeck].v.currentTime = target; } catch (e) {}
    }
  }
  seekBarShow(target);
}
function endSeek() {
  var seg = drag.seekSeg, t0 = drag.seek0, t1 = drag.seekT;
  var wasPlaying = drag.wasPlaying;
  drag.wasPlaying = false;
  drag.seek = false;
  drag.seekT = null;
  drag.seekSeg = null;
  seekBarHide();
  var c = activeClip();
  if (!c || c.state !== 'ready' || c.idx < 0 || t1 == null || seg == null) {
    restoreAfterSeek(c, wasPlaying);
    return;
  }
  var moved = Math.abs(t1 - t0) >= 0.3;
  if (moved) {
    var cur = c.decks[c.activeDeck];
    try { cur.v.currentTime = t1; } catch (e) {}
    if (c.hasAudio) { try { cur.a.currentTime = t1; } catch (e) {} }
  }
  cam.track = c.tracks[c.idx] || null;
  camCut(t1 - seg.start);
  restoreAfterSeek(c, wasPlaying);
  showChrome();
}
/** 拖动被打断（pointercancel）：停在最后预览位置并恢复播放状态 */
function cancelSeek() {
  var t1 = drag.seekT, wasPlaying = drag.wasPlaying;
  drag.wasPlaying = false;
  drag.seek = false; drag.seekT = null; drag.seekSeg = null;
  seekBarHide();
  var c = activeClip();
  if (c && c.state === 'ready' && t1 != null && c.idx >= 0) {
    var cur = c.decks[c.activeDeck];
    try { cur.v.currentTime = t1; } catch (e) {}
    if (c.hasAudio) { try { cur.a.currentTime = t1; } catch (e) {} }
    cam.track = c.tracks[c.idx] || null;
  }
  restoreAfterSeek(c, wasPlaying);
}
/** 拖动结束/取消：恢复拖动前的播放状态（正放 → resumePlay，倒放 → 重启步进循环） */
function restoreAfterSeek(c, wasPlaying) {
  if (!wasPlaying || !c || c.state !== 'ready' || c.idx < 0) return;
  if (rev.dir < 0) {
    c.playing = true;
    c.render();
    rev.last = performance.now();
    revStartLoop();
  } else c.resumePlay();
}
/** 进度条 seek 指示：强制显示 chrome，进度条放大，圆点 + 气泡（增量/目标时间） */
function seekBarShow(target) {
  var c = activeClip();
  var seg = drag.seekSeg;
  if (!c || !seg) return;
  document.body.classList.add('seeking');
  var p = clamp((target - seg.start) / Math.max(0.1, seg.dur), 0, 1);
  c.fillEl.style.width = (p * 100).toFixed(2) + '%';
  if (c.knobEl) {
    c.knobEl.style.left = (p * 100).toFixed(2) + '%';
    c.knobEl.style.display = 'block';
  }
  if (c.tipEl) {
    var delta = target - drag.seek0;
    var sign = delta >= 0 ? '+' : '−';
    var b = c.tipEl.querySelector('b'), sp = c.tipEl.querySelector('span');
    if (b) b.textContent = sign + Math.abs(delta).toFixed(1) + 's';
    if (sp) sp.textContent = fmt(target);
    c.tipEl.style.left = (clamp(p, 0.1, 0.9) * 100).toFixed(2) + '%';
    c.tipEl.style.display = 'block';
  }
}
function seekBarHide() {
  document.body.classList.remove('seeking');
  var c = activeClip();
  if (c) {
    if (c.knobEl) c.knobEl.style.display = 'none';
    if (c.tipEl) c.tipEl.style.display = 'none';
  }
}

/* ---------- 播放方向：正放 ▶ / 倒放 ◀ ----------
   ◀▶ 按钮不是 on/off 开关：按一下就把「播放方向」翻过来，播放键的箭头随之换向
   （▶=正放，◀=倒放）。播放键本身仍是播放/暂停，恢复播放时按当前方向走。
   浏览器无法反向解码音频，倒放时静音（暂停音轨），视频逐帧回退 currentTime。

   【倒放引擎 v2 —— 双 deck 乒乓流水，修 S9080「卡顿抖动鬼畜」】
   单 deck 逐帧回退 = 每步「seek → 解码 → 显示」串行，seek 延迟的抖动直接变成
   节奏忽快忽慢（鬼畜）。v2 让两个 deck 同源交替：
     显示 deck 停在第 N 帧时，备用 deck 已经在 seek 第 N-1 步的位置；
   备用 seeked 一到 → 硬切显示备用，原显示 deck 转身去 seek 更前一步。
   显示端永远有一帧现成画面，seek 延迟被流水线吃掉，步距均匀不抖。
   步长自适应：实测 seek 延迟 EMA × 目标速率（慢动作档）= 每步回退秒数，
   钳制在 [1/60, 1/12] 秒——快机子步距细更顺滑，慢机子保速度不跳帧过头。 */
var rev = { dir: 1, on: false, last: 0, step: 0.08, lat: 80 };   // dir: 1=正放 -1=倒放

function revStartLoop() {
  if (rev.on) return;
  rev.on = true;
  rev.last = performance.now();
  rev.lat = 80;
  rev.step = 0.08;
  revStep();
}
function revStopLoop() { rev.on = false; }

/** 备用 deck 同源化：倒放全程用同一个媒体 URL（整段视频本就一个 src），
 *  通常只需把 seg 标签改到当前段并保持暂停；源不一致时重设 src。 */
function revPrimeStandby(c) {
  var nxt = c.decks[1 - c.activeDeck];
  var url = '/api/media/' + c.token + '/v?i=0';
  if (!(nxt.seg === c.idx && nxt.v.dataset.src === url && nxt.everReady)) {
    setSrc(nxt.v, url);
    nxt.everReady = true;
  }
  nxt.seg = c.idx;
  nxt.rolling = false;
  try { nxt.v.pause(); } catch (e) {}
  return nxt;
}

/** 乒乓步进：在备用 deck 上 seek 到下一帧位 → seeked 到达即硬切显示 →
 *  原显示 deck 退位，成为下一步的 seek 工人。循环由自身尾部驱动。 */
async function revStep() {
  if (!rev.on || rev.dir >= 0) { rev.on = false; return; }
  var c = activeClip();
  if (!c || c.state !== 'ready' || c.idx < 0) { rev.on = false; return; }
  if (!c.playing) { setTimeout(revStep, 100); return; }   // 暂停中待命，恢复后继续
  var seg = c.segs[c.idx];
  if (!seg) { revReset(); return; }
  var end = seg.start + seg.dur;
  var idx0 = c.idx;
  var cur = c.decks[c.activeDeck];
  var nxt = revPrimeStandby(c);
  var tNext = cur.v.currentTime - rev.step;
  if (tNext <= seg.start + 0.05) tNext = end - 0.1;       // 段首回绕到段尾
  var st = performance.now();
  await seekTo(nxt.v, tNext, 600);
  if (!rev.on || rev.dir >= 0) return;                     // 中途换向/停止
  if (c.idx !== idx0 || c.segs[c.idx] !== seg) return;     // 中途切段/序列重建
  var lat = performance.now() - st;
  if (lat < 10) await new Promise(function (r) { requestAnimationFrame(r); });   // 同帧秒回：让出一帧再切
  if (!rev.on || rev.dir >= 0 || c.idx !== idx0) return;
  rev.lat = rev.lat * 0.7 + Math.min(600, lat) * 0.3;
  var rate = slowBase();
  rev.step = clamp(rev.lat / 1000 * rate, 1 / 60, Math.max(1 / 24, rate / 12));
  // 硬切显示备用 deck（seeked 帧已就绪），原显示 deck 退位当下一步的 seek 工人
  c.showDeck(1 - c.activeDeck, true);
  try { cur.v.pause(); } catch (e) {}
  try { nxt.v.pause(); } catch (e) {}    // 停帧显示：暂停的元素同样渲染 seeked 帧
  nxt.rolling = false;
  c.hud(nxt.v.currentTime, end);
  rev.last = performance.now();
  revStep();
}

/** 回到正向（切段 / 换场 / 停止时用）：停循环 + 复位方向与图标 */
function revReset() {
  revStopLoop();
  if (rev.dir !== 1) {
    rev.dir = 1;
    var b = $('#btnRev');
    if (b) b.classList.remove('on');
    syncPlayIcon();
  }
}

/** 切换播放方向。播放中立即生效；暂停中只换方向，下次按播放键按新方向走 */
function setPlayDir(d) {
  var c = activeClip();
  if (!c || c.state !== 'ready' || c.idx < 0) return;
  if (rev.dir === d) return;
  rev.dir = d;
  var b = $('#btnRev');
  if (b) b.classList.toggle('on', d < 0);
  syncPlayIcon();
  if (c.playing) {
    if (d < 0) {
      // 正放 → 倒放：全部 deck 暂停（音频静音），视频交给逐帧回退
      for (var i = 0; i < c.decks.length; i++) {
        try { c.decks[i].v.pause(); } catch (e) {}
        if (c.hasAudio) { try { c.decks[i].a.pause(); } catch (e) {} }
      }
      revStartLoop();
      toast('倒放 ' + slowBase() + '×（音频静音）· 慢动作档同样生效');
    } else {
      revStopLoop();
      c.resumePlay();
      toast('正向播放');
    }
  } else {
    revStopLoop();
    toast(d < 0 ? '方向：倒放（按播放键开始）' : '方向：正放');
  }
  showChrome();
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
function sheetOpen() { return page === 2; }
function openSheet() { goPage(2); }
function closeSheet() { if (page === 2) goPage(1); }

function syncZoomChips() {
  var chips = $('#zoomChips') ? $('#zoomChips').children : [];
  for (var j = 0; j < chips.length; j++) {
    chips[j].classList.toggle('on', Math.abs(parseFloat(chips[j].getAttribute('data-zoom')) - SETTINGS.zoom) < 0.001);
  }
}
function syncPadValues() {
  var a = $('#padFrontVal'), b = $('#padBackVal');
  if (a) a.textContent = SETTINGS.padFront.toFixed(1) + 's';
  if (b) b.textContent = SETTINGS.padBack.toFixed(1) + 's';
}
function syncCatChips() {
  var els = document.querySelectorAll('.cat-chip');
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle('on', (els[i].getAttribute('data-cat') || '') === SETTINGS.cat);
  }
}
/* ---------------------- 本地视频缓存（额度 / 占用 / 清空） ----------------------
   额度存在前端 localStorage，但真正生效的是本地代理的 SharedPreferences：
   init() 把 SETTINGS.cacheMb 推给 /api/cache/config，因此进程重启后仍然有效。
   命中率统计的是「本次启动以来」的 /api/media 请求，能直观看出重开是否真的没走网。 */
var CACHE_MB_OPTIONS = [200, 600, 1024, 2048];

function cacheMbLabel(mb) { return mb >= 1024 ? (mb / 1024) + ' GB' : mb + ' MB'; }

function renderCacheStat(j) {
  var el = $('#cacheStat');
  if (!el) return;
  if (!j || !j.ok) { el.textContent = '缓存状态不可用'; return; }
  var pct = j.limitBytes ? Math.round(j.usedBytes / j.limitBytes * 100) : 0;
  var lim = j.limitMb >= 1024 ? (j.limitMb / 1024) + ' GB' : j.limitMb + ' MB';
  // 窄屏（412px）下这行要能一行放下，别把 "200 MB" 从中间折行
  el.innerHTML = '已用 <b>' + j.usedMb + '</b>/' + lim + ' · ' + pct + '% · '
    + j.entries + ' 块 · 命中 ' + j.hits + '/' + (j.hits + j.misses);
}

function refreshCacheStat() {
  fetch('/api/cache/stat').then(function (r) { return r.json(); })
    .then(renderCacheStat)
    .catch(function () { renderCacheStat(null); });
}

function pushCacheConfig() {
  return fetch('/api/cache/config?mb=' + SETTINGS.cacheMb)
    .then(function (r) { return r.json(); })
    .then(renderCacheStat)
    .catch(function () { renderCacheStat(null); });
}

function syncCacheChips() {
  var box = $('#cacheChips');
  if (!box) return;
  var bs = box.children;
  for (var i = 0; i < bs.length; i++) {
    bs[i].classList.toggle('on', +bs[i].getAttribute('data-mb') === SETTINGS.cacheMb);
  }
}

/* ---------------------- 集锦片段预取 ----------------------
   视频源不会更新，把本场全部集锦片段对应的字节区间提前写进磁盘缓存，
   二次进入同一场 / 断网重放都直接命中。只缓存集锦，不缓存整场。
   时长→字节的映射是线性的（progressive MP4 近似），两端各留 2MB 余量吸收误差。 */
var prefetchDone = {};        // token -> true，防重复排队

function probeTotalBytes(token, kind) {
  return fetch('/api/media/' + token + '/' + kind + '?i=0', { headers: { Range: 'bytes=0-0' } })
    .then(function (r) {
      var m = (r.headers.get('Content-Range') || '').match(/bytes\s+\d+-\d+\/(\d+)/);
      return m ? +m[1] : 0;
    })
    .catch(function () { return 0; });
}

function prefetchSegBytes(c) {
  if (!c || !c.token || !c.segs.length || !c.videoDuration) return;
  if (prefetchDone[c.token]) return;
  prefetchDone[c.token] = true;
  var dur = c.videoDuration;
  Promise.all([probeTotalBytes(c.token, 'v'), probeTotalBytes(c.token, 'a')])
    .then(function (ts) {
      var PAD = 512 * 1024;        // 线性映射误差余量；再大会在几十段上翻倍浪费
      for (var ki = 0; ki < 2; ki++) {
        var kind = ki === 0 ? 'v' : 'a';
        var total = ts[ki];
        if (!total) continue;
        var rs = [];
        for (var i = 0; i < c.segs.length; i++) {
          var sg = c.segs[i];
          var b0 = Math.max(0, Math.floor(sg.start / dur * total) - PAD);
          var b1 = Math.min(total - 1, Math.ceil((sg.start + sg.dur) / dur * total) + PAD);
          if (b1 > b0) rs.push([b0, b1]);
        }
        // 按起点排序后合并重叠 / 相邻（间隙 < 1MB）的区间：集锦段常常首尾相接，
        // 不合并的话每段两端的余量会互相重复，几十段能白拉上百 MB
        rs.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [];
        for (var k = 0; k < rs.length; k++) {
          var m = merged[merged.length - 1];
          if (m && rs[k][0] <= m[1] + 1048576) { if (rs[k][1] > m[1]) m[1] = rs[k][1]; }
          else merged.push([rs[k][0], rs[k][1]]);
        }
        var strs = [];
        for (var j = 0; j < merged.length; j++) strs.push(merged[j][0] + '-' + merged[j][1]);
        if (strs.length) {
          fetch('/api/cache/prefetch?token=' + c.token + '&kind=' + kind
            + '&i=0&ranges=' + strs.join(',')).catch(function () {});
        }
      }
      diag('prefetch queued segs=' + c.segs.length);
    });
}

function syncSettingsUI() {
  var segBtns = $('#modeSeg').children;
  for (var i = 0; i < segBtns.length; i++) {
    segBtns[i].classList.toggle('on', segBtns[i].getAttribute('data-mode') === SETTINGS.mode);
  }
  var fitBtns = $('#fitSeg') ? $('#fitSeg').children : [];
  for (var f = 0; f < fitBtns.length; f++) {
    fitBtns[f].classList.toggle('on', fitBtns[f].getAttribute('data-fit') === SETTINGS.fit);
  }
  var sfSw = $('#segFloatSw');
  if (sfSw) sfSw.classList.toggle('on', SETTINGS.segFloat);
  var ci = $('#catInput');
  if (ci && document.activeElement !== ci) ci.value = SETTINGS.cat;
  syncPadValues();
  syncZoomChips();
  syncCatChips();
  var autoSw = $('#autoSw');
  if (autoSw) autoSw.classList.toggle('on', SETTINGS.zoomOn);
  var splitSw = $('#splitSw');
  if (splitSw) splitSw.classList.toggle('on', SETTINGS.split);
  $('#focusSw').classList.toggle('on', SETTINGS.focusBox);
  var algoSw = $('#algoSw');
  if (algoSw) algoSw.classList.toggle('on', SETTINGS.algoViz);
  renderCatTokens();
  updateCatCount();
  syncZoomIcons();
  syncCacheChips();
  refreshCacheStat();
}

function syncZoomIcons() {
  var els = document.querySelectorAll('.ic.zoom');
  for (var i = 0; i < els.length; i++) els[i].classList.toggle('on', SETTINGS.zoomOn);
  var bt = $('#btnTrack');
  if (bt) bt.classList.toggle('on', SETTINGS.zoomOn);
}

/** 自动跟焦总开关：关＝自定义固定缩放（倍率/中心都听用户的，完全不跟踪） */
function setAutoFocus(on) {
  SETTINGS.zoomOn = !!on;
  camManual(!SETTINGS.zoomOn);
  saveSettings();
  syncZoomIcons();
  var autoSw = $('#autoSw');
  if (autoSw) autoSw.classList.toggle('on', SETTINGS.zoomOn);
  camApply();
  var c = activeClip();
  if (c) algoDraw(c);   // 关：清空标注；开：下一帧采样即绘制
  toast(SETTINGS.zoomOn ? '跟踪球开 · 算法自动追球取景' : '跟踪球关 · 固定取景');
  showChrome();
}
function toggleZoom() { setAutoFocus(!SETTINGS.zoomOn); }

/* ---------------------- 集锦分类 UI（字符候选 + 命中数） ---------------------- */
var catTokensFor = null;      // 「bvid:是否已解析」签名，避免重复建 DOM
function renderCatTokens() {
  var box = $('#catTokens');
  if (!box) return;
  var c = activeClip();
  var matched = (c && c.info && c.info.matched) || null;
  var sig = ((c && c.item && c.item.bvid) || '') + ':' + (matched ? '1' : '0');
  if (sig === catTokensFor) return;
  catTokensFor = sig;
  box.innerHTML = '';
  var all = document.createElement('button');
  all.type = 'button'; all.className = 'cat-chip'; all.setAttribute('data-cat', '');
  all.textContent = '全部';
  box.appendChild(all);
  if (!matched || !matched.length) return;
  var counts = Object.create(null), list = [], k;
  for (var i = 0; i < matched.length; i++) {
    var toks = noteTokenList(matched[i] && matched[i].text);
    for (var j = 0; j < toks.length; j++) {
      var w = toks[j];
      if (counts[w]) counts[w]++; else counts[w] = 1;
    }
  }
  for (k in counts) if (Object.prototype.hasOwnProperty.call(counts, k)) list.push([k, counts[k]]);
  list.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
  var n = Math.min(14, list.length);
  for (var q = 0; q < n; q++) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'cat-chip';
    b.setAttribute('data-cat', list[q][0]);
    b.appendChild(document.createTextNode(list[q][0]));
    var num = document.createElement('b');
    num.textContent = String(list[q][1]);
    b.appendChild(num);
    box.appendChild(b);
  }
  syncCatChips();
}
function updateCatCount() {
  var el = $('#catCount');
  if (!el) return;
  var c = activeClip();
  if (!c || c.state !== 'ready') { el.textContent = '尚未载入比赛'; return; }
  var total = c.segTotal || c.segs.length;
  if (SETTINGS.mode === 'full') { el.textContent = '原片模式 · 不筛选'; return; }
  if (c.catEmpty) {
    el.textContent = '没有匹配「' + catTerms(SETTINGS.cat).join(' ') + '」的片段，已显示全部 ' + total + ' 段';
    return;
  }
  el.textContent = c.catActive
    ? '命中 ' + c.segs.length + ' / ' + total + ' 段 · 筛选「' + c.catActive + '」'
    : '全部 ' + total + ' 段 · 未筛选';
}

/* ---------------------- 片段序列重建（分类 / 补时 / 模式共用） ---------------------- */
var catApplyTimer = null, segRebuildTimer = null;
function rebuildActiveSegs(msg) {
  var c = activeClip();
  if (!c || c.state !== 'ready') {
    updateCatCount();
    toast(msg);
    return;
  }
  c.buildSegs((c.info && c.info.matched) || []);
  c.tracks = [];        // 片段序列重建，旧轨迹作废
  c.stopAll();
  c.activate();
  updateCatCount();
  syncCatChips();
  if (c.catEmpty) toast('本场没有匹配的集锦，已显示全部');
  else toast(msg + (c.segs.length ? '（' + c.segs.length + ' 段）' : ''));
  showChrome();
}
function applyCatToActive() {
  clearTimeout(catApplyTimer); catApplyTimer = null;
  var q = catTerms(SETTINGS.cat).join(' ');
  rebuildActiveSegs(q ? '集锦筛选「' + q + '」' : '集锦分类：全部');
}
function setCatFilter(raw, immediate) {
  var q = String(raw == null ? '' : raw).trim().slice(0, 40);
  if (q && SETTINGS.mode === 'full') SETTINGS.mode = 'hl';
  SETTINGS.cat = q;
  saveSettings();
  // 显式应用（按钮/回车/候选 chip）时同步输入框；输入过程中不改写，避免打断打字
  var ci = $('#catInput');
  if (immediate && ci && ci.value !== q) ci.value = q;
  syncCatChips();
  clearTimeout(catApplyTimer);
  if (immediate) applyCatToActive();
  else catApplyTimer = setTimeout(applyCatToActive, 600);
}
function scheduleSegRebuild(msg) {
  clearTimeout(segRebuildTimer);
  segRebuildTimer = setTimeout(function () { segRebuildTimer = null; rebuildActiveSegs(msg); }, 550);
}
function padMsg() {
  return '补时 前 ' + SETTINGS.padFront + 's / 后 ' + SETTINGS.padBack + 's';
}
function bindPadStepper(id, key) {
  var box = $(id);
  if (!box) return;
  var btns = box.querySelectorAll('.stp');
  for (var i = 0; i < btns.length; i++) {
    (function (b) {
      b.addEventListener('click', function () {
        var dflt = key === 'padFront' ? 1 : 2;
        SETTINGS[key] = normPad(SETTINGS[key] + parseFloat(b.getAttribute('data-step')), dflt);
        saveSettings();
        syncPadValues();
        scheduleSegRebuild(padMsg());
      });
    })(btns[i]);
  }
}

function bindSettings() {
  // 画面填充：完整（contain，不裁切）/ 铺满（cover，会裁掉两侧）
  var fitBtns = $('#fitSeg').children;
  for (var f = 0; f < fitBtns.length; f++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-fit');
        if (v === SETTINGS.fit) return;
        SETTINGS.fit = v;
        saveSettings();
        applyFit();
        syncSettingsUI();
        toast(v === 'contain' ? '画面填充：完整（不裁切，留黑边）' : '画面填充：铺满（会裁掉两侧）');
      });
    })(fitBtns[f]);
  }
  // 一键回到「完整显示全部画面 + 全部集锦」
  var rv = $('#resetViewBtn');
  if (rv) rv.addEventListener('click', function () {
    SETTINGS.fit = 'contain';
    SETTINGS.zoom = 1;
    SETTINGS.zoomOn = false;
    SETTINGS.cat = '';
    cam.zoom = 1; cam.tz = 1;
    cam.x = cam.tx = 0.5; cam.y = cam.ty = 0.5;
    camManual(false);
    saveSettings();
    syncSettingsUI();
    applyFit();
    applyCatToActive();     // 清空筛选后重建片段序列与浮窗
    toast('已恢复：完整画面 + 全部集锦');
  });
  var sfSw = $('#segFloatSw');
  if (sfSw) {
    sfSw.addEventListener('click', function () {
      SETTINGS.segFloat = !SETTINGS.segFloat;
      saveSettings();
      applySegFloatVis();
      syncSettingsUI();
      toast(SETTINGS.segFloat ? '集锦浮窗 开' : '集锦浮窗 关');
    });
  }
  var segBtns = $('#modeSeg').children;
  for (var i = 0; i < segBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-mode');
        if (m === SETTINGS.mode) return;
        SETTINGS.mode = m;
        saveSettings();
        syncSettingsUI();
        rebuildActiveSegs(m === 'hl' ? '集锦连播' : '原片播放');
      });
    })(segBtns[i]);
  }
  var chips = $('#zoomChips').children;
  for (var j = 0; j < chips.length; j++) {
    (function (chip) {
      chip.addEventListener('click', function () {
        SETTINGS.zoom = parseFloat(chip.getAttribute('data-zoom'));
        saveSettings();      // 不碰 zoomOn：自定义缩放模式下改倍率也不会偷偷恢复跟踪
        syncZoomChips();
        camApply();
        toast('缩放 ' + SETTINGS.zoom.toFixed(2) + '×' + (SETTINGS.zoomOn ? '（自动构图回落值）' : '（自定义固定）'));
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
  var autoSw = $('#autoSw');
  if (autoSw) autoSw.addEventListener('click', function () { setAutoFocus(!SETTINGS.zoomOn); });

  // 集锦分类：字符输入（即时防抖）+ 显式筛选 + 候选字符 chip
  var catInput = $('#catInput');
  if (catInput) {
    catInput.addEventListener('input', function () { setCatFilter(catInput.value, false); });
    catInput.addEventListener('change', function () { setCatFilter(catInput.value, true); });
    catInput.addEventListener('keydown', function (e) {
      if (e.keyCode === 13 || e.key === 'Enter') {
        e.preventDefault();
        try { catInput.blur(); } catch (err) {}
        setCatFilter(catInput.value, true);
      }
    });
  }
  var catApply = $('#catApply');
  if (catApply) catApply.addEventListener('click', function () {
    var raw = catInput ? catInput.value : SETTINGS.cat;
    setCatFilter(raw, true);
  });
  var catBox = $('#catTokens');
  if (catBox) catBox.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.cat-chip') : null;
    if (!b) return;
    var v = b.getAttribute('data-cat') || '';
    if (catInput) catInput.value = v;
    setCatFilter(v, true);
  });

  bindPadStepper('#padFrontStep', 'padFront');
  bindPadStepper('#padBackStep', 'padBack');

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
  // 视频缓存：切换额度时立刻下发给本地代理，清空后刷新占用
  var cacheBox = $('#cacheChips');
  if (cacheBox) cacheBox.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (!b) return;
    var mb = parseInt(b.getAttribute('data-mb'), 10);
    if (!mb || mb === SETTINGS.cacheMb) return;
    SETTINGS.cacheMb = mb;
    saveSettings();
    syncCacheChips();
    pushCacheConfig();
    toast('缓存上限：' + cacheMbLabel(mb));
  });
  var cacheClear = $('#cacheClear');
  if (cacheClear) cacheClear.addEventListener('click', function () {
    fetch('/api/cache/clear').then(function (r) { return r.json(); })
      .then(renderCacheStat)
      .catch(function () { renderCacheStat(null); });
    toast('视频缓存已清空');
  });

  var ck = $('#cookieInput');
  if (ck) ck.value = getUserCookie();
  $('#cookieSave').addEventListener('click', function () {
    var v = (ck.value || '').trim();
    safeSet(COOKIE_KEY, v);
    toast(v ? 'Cookie 已保存' : 'Cookie 已清除');
  });
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
    viewportScale = 1;
    w.style.transform = '';
    w.style.width = '';
    w.style.height = '';
    return;
  }
  var scale = Math.max(0.72, cssW / natural);
  viewportScale = scale;
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
  if (c) c.tick(now);   // 播放推进（段末硬切 / 音画同步）离开播放页也继续
  // 跟焦分析是纯画面工作：离屏时整段停掉，把 CPU 让给列表滚动/页面动画
  if (page === 1) {
    camSampleLive(now);   // 实时采样（6.7Hz）→ scene
    camTick(now);         // 平滑相机：轨迹/实时混合 + 缓动 + 落 transform
  }
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
  camManual(!SETTINGS.zoomOn);   // 上次是自定义缩放 → 启动后继续保持，不自动跟焦
  bindPages();
  bindGestures();
  bindSettings();
  bindCornerCtl();
  applyBrightness();
  applyVolume();
  applySlowRate();
  bindFallback();
  bindSegFloat();
  syncSettingsUI();
  pushCacheConfig();      // 把缓存额度同步给本地代理（Java 侧持久化，跨启动生效）
  applyFit();
  applySegFloatVis();
  applyViewportScale = applyViewportScaleReal;
  applyViewportScale();
  applySplit();
  syncZoomIcons();
  window.addEventListener('resize', function () {
    applyViewportScale();
    if (active >= 0) feedTransform(active, false);
    pageTransform(0);       // 页宽变了，重新落横向位移
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
