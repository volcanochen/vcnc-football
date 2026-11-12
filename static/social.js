/* =============================================================
   social.js · B 站账号社交功能（相对独立的模块）
   -------------------------------------------------------------
   播放页左侧浮窗：账号信息 / 大会员标识 / 画质切换 / 当前视频一键三连。
   登录默认走「本机 B 站客户端 App 授权」：passport 会话（generate + poll）
   与扫码同源，但授权页 URL 不渲染成二维码，而是经 JS 桥用
   bilibili://browser?url= 交给 B 站 App 内打开，用户点「确认」即完成。
   二维码折叠在「其他登录方式」里作桌面/无客户端兜底，手填 Cookie 同理。
   凭证只保存在本地代理，前端从不接触 SESSDATA。

   与 feed.js 的耦合只有一处契约：window.VCNC
     getState()      -> {bvid, title, qn, quality, qualityList, ready}
     setQuality(qn)  -> 保存进度并按新画质重载
     reload()        -> 保存进度并重载（登录态变化后重新取流）
   契约缺失时本模块自动降级为只读，不会抛错。

   Chrome 74 兼容：ES5 语法、无 ?. / ?? / replaceAll / 新 CSS 特性。
   ============================================================= */
(function (global) {
  'use strict';

  var QN_KEY = 'vcnc.qn.v1';
  var TRIPLE_KEY = 'vcnc.triple.v1';
  var FOLD_KEY = 'vcnc.social.fold.v1';
  var COOKIE_KEY = 'vcnc.cookie.v1';

  /* 基础画质档：360P~1080P 不需要大会员，任何登录态都可请求。
     B 站 accept_quality 对游客只返回低档，前端固定并上这几档，
     保证「切换画质」任何时候都能点到 1080P（游客请求高档时 B 站
     自动下发可见的最高档，登录后同档位即生效）。 */
  var BASE_QNS = [
    { qn: 80, name: '1080P' },
    { qn: 64, name: '720P' },
    { qn: 32, name: '480P' },
    { qn: 16, name: '360P' }
  ];
  var QN_NAMES = { 6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '1080P60',
                   80: '1080P', 112: '1080P 高码率', 116: '1080P60', 120: '4K' };

  function $(s, r) { return (r || document).querySelector(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function tip(msg) {
    if (typeof global.toast === 'function') { try { global.toast(msg); return; } catch (e) {} }
    stateText = msg;
    stateClass = 'soc-state';
    lastSig = '';
    render(true);
  }

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
    var parts = [];
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k))
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k] == null ? '' : o[k]));
    return parts.join('&');
  }

  function getState() {
    try {
      if (global.VCNC && typeof global.VCNC.getState === 'function')
        return global.VCNC.getState() || {};
    } catch (e) {}
    return {};
  }
  function callVCNC(name, arg) {
    try {
      if (global.VCNC && typeof global.VCNC[name] === 'function')
        return global.VCNC[name](arg);
    } catch (e) {}
    return false;
  }

  function tripleMap() {
    try { return JSON.parse(lsGet(TRIPLE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function isTripled(bvid) {
    if (!bvid) return false;
    var m = tripleMap();
    return !!m[bvid];
  }
  function markTripled(bvid) {
    if (!bvid) return;
    var m = tripleMap();
    m[bvid] = Date.now();
    // 只保留最近 200 条，避免 localStorage 无限增长
    var keys = Object.keys(m);
    if (keys.length > 200) {
      keys.sort(function (a, b) { return (m[a] || 0) - (m[b] || 0); });
      for (var i = 0; i < keys.length - 200; i++) delete m[keys[i]];
    }
    lsSet(TRIPLE_KEY, JSON.stringify(m));
  }

  var me = { loggedIn: false, vip: false, name: '', face: '', level: 0, coins: 0, mid: 0 };
  var lastSig = '';
  var stateText = '';
  var stateClass = 'soc-state';
  var busy = false;

  // ---------------------------------------------------------------- DOM
  var floatEl = null, bodyEl = null, modalEl = null, qrCanvas = null;
  var qrVeil = null, statusEl = null, ckInput = null;
  var authTimer = null, authUrl = '', authKey = '', authPolls = 0, authDeadline = 0;
  var appLaunched = false, qrDrawn = false;

  function buildDOM() {
    var host = $('#appWrap') || document.body;

    floatEl = el('div', 'soc-float');
    floatEl.id = 'socFloat';
    // 浮窗 = 一行头部（头像 + 用户名 + 收起箭头）+ 画质列表；
    // 三连按钮不在这里，它挂在标题行、紧跟标题文字（见 renderTripleTop）
    floatEl.innerHTML =
      '<div class="soc-head">' +
        '<span class="soc-av" id="socAv">' +
          '<img class="soc-av-i" id="socAvI" alt="" referrerpolicy="no-referrer">' +
          '<span class="soc-av-t" id="socAvT">?</span>' +
        '</span>' +
        '<span class="soc-nm" id="socNm">未登录</span>' +
        '<button class="soc-fold" id="socFold" type="button" title="收起 / 展开">‹</button>' +
      '</div>' +
      '<div class="soc-body" id="socBody"></div>';
    host.appendChild(floatEl);
    bodyEl = $('#socBody', floatEl);

    modalEl = el('div', 'soc-modal');
    modalEl.id = 'socModal';
    modalEl.hidden = true;
    modalEl.innerHTML =
      '<div class="soc-card">' +
        '<div class="soc-card-head"><span>登录 B 站账号</span>' +
        '<button class="soc-x" id="socX" type="button" title="关闭">×</button></div>' +
        '<div class="soc-app-logo">bilibili</div>' +
        '<div class="soc-app-lead">用本机 B 站客户端授权登录</div>' +
        '<div class="soc-status" id="socQrStatus">正在准备…</div>' +
        '<button class="soc-btn primary big" id="socLaunch" type="button">打开 B 站 App 授权</button>' +
        '<div class="soc-tips">点开后 B 站 App 会显示授权页，点「确认」即可，无需扫码；' +
        '切回本应用会自动完成登录。凭证只存本机，不上传、不影响其它设备。</div>' +
        '<button class="soc-refresh" id="socAltToggle" type="button">其他登录方式 ›</button>' +
        '<div class="soc-alt" id="socAlt" hidden>' +
          '<div class="soc-alt-row">' +
            '<button id="socCopy" type="button">复制授权链接</button>' +
            '<button id="socQrShow" type="button">显示二维码</button>' +
          '</div>' +
          '<div class="soc-qr-wrap"><canvas id="socQr"></canvas>' +
          '<div class="soc-qr-veil" id="socQrVeil">二维码未生成</div></div>' +
          '<button class="soc-refresh" id="socRefresh" type="button">重新获取授权</button>' +
        '</div>' +
        '<div class="soc-manual">' +
          '<div class="soc-manual-t">或从浏览器复制 SESSDATA 与 bili_jct 粘贴：</div>' +
          '<div class="soc-manual-row"><input id="socCk" type="text" spellcheck="false" ' +
          'placeholder="SESSDATA=…; bili_jct=…">' +
          '<button id="socCkGo" type="button">保存</button></div>' +
        '</div>' +
      '</div>';
    host.appendChild(modalEl);

    qrCanvas = $('#socQr', modalEl);
    qrVeil = $('#socQrVeil', modalEl);
    statusEl = $('#socQrStatus', modalEl);
    ckInput = $('#socCk', modalEl);

    function stopTouch(e) { e.stopPropagation(); }
    [floatEl, modalEl].forEach(function (n) {
      n.addEventListener('touchstart', stopTouch, false);
      n.addEventListener('touchmove', stopTouch, false);
      n.addEventListener('touchend', stopTouch, false);
      n.addEventListener('pointerdown', stopTouch, false);
    });

    var foldBtn = $('#socFold', floatEl);
    // 收起按钮箭头统一朝左：展开时点它「‹」向左收起，收起后「›」向右展开
    if (lsGet(FOLD_KEY) === '1') { floatEl.classList.add('fold'); foldBtn.textContent = '›'; }
    else foldBtn.textContent = '‹';
    foldBtn.addEventListener('click', function () {
      var fold = floatEl.classList.toggle('fold');
      lsSet(FOLD_KEY, fold ? '1' : '0');
      foldBtn.textContent = fold ? '›' : '‹';
      lastSig = '';
      render();
    });
    // 未登录时点头像/用户名直接进登录流程，浮窗里就不用再放一个登录按钮
    $('#socNm', floatEl).addEventListener('click', function () {
      if (!me.loggedIn) openLogin();
    });
    $('#socAv', floatEl).addEventListener('click', function () {
      if (!me.loggedIn) openLogin();
    });
    $('#socX', modalEl).addEventListener('click', closeLogin);
    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) closeLogin();
    });
    $('#socLaunch', modalEl).addEventListener('click', launchApp);
    $('#socAltToggle', modalEl).addEventListener('click', function () {
      var a = $('#socAlt', modalEl);
      a.hidden = !a.hidden;
      $('#socAltToggle', modalEl).textContent = a.hidden ? '其他登录方式 ›' : '收起其他方式 ‹';
    });
    $('#socCopy', modalEl).addEventListener('click', copyAuthUrl);
    $('#socQrShow', modalEl).addEventListener('click', showQr);
    $('#socRefresh', modalEl).addEventListener('click', startAuth);
    $('#socCkGo', modalEl).addEventListener('click', function () {
      var v = (ckInput.value || '').trim();
      if (!v) { setStatus('请先粘贴 Cookie', 'bad'); return; }
      saveManual(v, false);
    });
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'soc-status' + (cls ? ' ' + cls : '');
  }

  // ---------------------------------------------------------------- 渲染
  function makeBtn(cls, text, disabled, fn) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (disabled) b.disabled = true;
    if (fn) b.addEventListener('click', fn);
    return b;
  }

  /* 画质按钮文案：B 站名字带「1080P 高清」这种后缀，两列 60px 放不下，
     去掉与分辨率重复的通用后缀，只留 1080P60 / 1080P / 720P 这类编码 */
  function qName(item) {
    var n = (item && item.name) || String((item && item.qn) || '');
    n = n.replace(/\s*(高清|超清|清晰|流畅|蓝光|杜比视界)\s*$/g, '');
    return n || String((item && item.qn) || '');
  }

  function render(force) {
    if (!bodyEl) return;
    var st = getState();
    var done = isTripled(st.bvid);
    // 头部与标题行按钮先刷新：播放器 DOM 是异步建出来的，三连按钮可能
    // 第一轮还没挂上，不放在签名判定之后，否则后面签名不变就再也补不回来了
    renderHead();
    renderTripleTop(done);
    var sig = [me.loggedIn, me.vip, me.name, me.face, st.bvid, st.qn, st.quality,
               JSON.stringify(st.qualityList || []), done, busy, stateText, stateClass].join('|');
    if (!force && sig === lastSig) return;
    lastSig = sig;

    bodyEl.innerHTML = '';

    // 画质（始终显示、人人可点：基础档不需要大会员；列表 = B 站
    // accept_quality ∪ 基础档位 ∪ 当前请求档，保证高档位不被藏掉）
    var qsBox = el('div', 'soc-qs');
    var list = (st.qualityList || []).slice();
    var seen = {};
    list.forEach(function (it) { seen[parseInt(it.qn, 10)] = 1; });
    BASE_QNS.forEach(function (b) {
      if (!seen[b.qn]) { list.push({ qn: b.qn, name: b.name }); seen[b.qn] = 1; }
    });
    var curQn = parseInt(st.qn, 10);
    if (curQn && !seen[curQn]) {
      list.push({ qn: curQn, name: QN_NAMES[curQn] || ('QN ' + curQn) });
      seen[curQn] = 1;
    }
    // 高亮跟随实际播放画质：B 站对无权限档位静默降级（如游客点 1080P
    // 实际拿到 480P），高亮落在真实档位上，比停在请求档更诚实
    var shownQn = parseInt(st.quality, 10) || curQn;
    if (shownQn && !seen[shownQn]) {
      list.push({ qn: shownQn, name: QN_NAMES[shownQn] || ('QN ' + shownQn) });
      seen[shownQn] = 1;
    }
    list.sort(function (a, b) { return parseInt(b.qn, 10) - parseInt(a.qn, 10); });
    list.forEach(function (item) {
      var qn = parseInt(item.qn, 10);
      var on = (qn === shownQn);
      var b = makeBtn('soc-q' + (on ? ' on' : ''), qName(item), false, function () {
        if (on) { tip('已经是 ' + qName(item)); return; }
        lsSet(QN_KEY, String(qn));
        tip('正在切换到 ' + qName(item) + '…');
        setTimeout(function () { callVCNC('setQuality', qn); }, 120);
      });
      qsBox.appendChild(b);
    });
    bodyEl.appendChild(qsBox);

    if (stateText) bodyEl.appendChild(el('div', stateClass, stateText));
  }

  /* 浮窗头部：头像 + 用户名 + 收起箭头（同一行） */
  function renderHead() {
    var nm = $('#socNm', floatEl), avT = $('#socAvT', floatEl), avI = $('#socAvI', floatEl);
    var who = $('#socWho');
    if (who) {
      who.textContent = me.loggedIn ? ((me.name || ('UID ' + me.mid)) + (me.vip ? '（大会员）' : ''))
                                    : '未登录';
    }
    if (!nm || !avT) return;
    var logged = !!me.loggedIn;
    nm.textContent = logged ? (me.name || ('UID ' + me.mid)) : '未登录';
    nm.className = 'soc-nm' + (logged ? '' : ' guest');
    nm.title = logged ? (me.vip ? 'B 站大会员' : '已登录 B 站') : '点击登录 / 授权';
    avT.textContent = logged && me.name ? me.name.slice(0, 1) : '?';
    var av = $('#socAv', floatEl);
    if (av) {
      var cls = 'soc-av' + (me.vip ? ' vip' : '');
      if (av.className !== cls) av.className = cls;
    }
    if (avI) {
      var want = logged ? (me.face || '') : '';
      if (want) {
        if (avI.getAttribute('src') !== want) {
          avI.onerror = function () { avI.style.display = 'none'; };
          avI.style.display = 'block';
          avI.setAttribute('src', want);
        }
      } else {
        avI.removeAttribute('src');
        avI.style.display = 'none';
      }
    }
  }

  /* 标题行三连按钮：紧跟标题文字，未登录灰、登录后激活、点过显示「已三连」；
     换视频时状态跟着当前 bvid 走（localStorage 里按 bvid 记）。 */
  var tripleBtn = null;
  function ensureTripleBtn() {
    if (tripleBtn && tripleBtn.parentNode) return tripleBtn;
    // 挂在 .ci-row（标题那一行的 flex 容器）里才会紧贴标题字符；老版本无此节点时退回 .chinfo
    var host = $('.ci-row') || $('.chinfo');
    if (!host) return null;
    var b = el('button', 'ci-triple dim', '三连');
    b.type = 'button';
    b.id = 'socTripleTop';
    b.addEventListener('click', function () {
      var st = getState();
      if (!me.loggedIn) { openLogin(); return; }
      if (!st.bvid) { tip('视频还没载入，稍等一下'); return; }
      if (isTripled(st.bvid)) { tip('这个视频已经三连过了'); return; }
      doTriple(st.bvid);
    });
    host.appendChild(b);
    tripleBtn = b;
    return b;
  }
  function renderTripleTop(done) {
    var b = ensureTripleBtn();
    if (!b) return;
    var cls = 'ci-triple', txt = '三连', title;
    if (busy) { cls += ' busy'; txt = '…'; }
    else if (done) { cls += ' done'; txt = '已三连'; }
    else if (me.loggedIn) { cls += ' on'; }
    else { cls += ' dim'; }
    if (b.className !== cls) b.className = cls;
    if (b.textContent !== txt) b.textContent = txt;
    title = done ? '这个视频已经三连过了（点赞 + 投币 + 收藏）'
                 : (me.loggedIn ? '给当前视频一键三连（点赞 + 投币 + 收藏）'
                                : '登录后即可给 VCNC 三连');
    if (b.title !== title) b.title = title;
    b.setAttribute('aria-pressed', done ? 'true' : 'false');
  }

  function refreshMe(force) {
    return api('/api/social/me' + (force ? '?force=1' : ''))
      .then(function (j) {
        if (!j || !j.ok) return;
        me = j;
        lastSig = '';
        render(true);
      })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- 登录
  /* 主路径：本机 B 站客户端 App 授权。passport 会话与扫码同源（generate + poll），
     区别只在把授权页 URL 经 JS 桥交给 B 站 App 内打开，用户点「确认」即可。
     二维码仅作为桌面/无客户端时的折叠兜底，默认不显示、不绘制。 */
  function openLogin() {
    if (!modalEl) return;
    modalEl.hidden = false;
    // 同步给全页样式：弹层盖满时自定义集锦面板要整体退场（clips.css）
    document.body.classList.add('soc-modal-open');
    // 弹层跟着 chrome 一起隐藏，打开时先点亮并重置计时
    if (typeof global.showChrome === 'function') global.showChrome();
    startAuth();
  }
  function closeLogin() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.body.classList.remove('soc-modal-open');
    stopPoll();
    authKey = '';
  }
  function stopPoll() {
    if (authTimer) { clearInterval(authTimer); authTimer = null; }
  }
  function openAlt() {
    var a = modalEl && $('#socAlt', modalEl);
    if (a && a.hidden) {
      a.hidden = false;
      var t = $('#socAltToggle', modalEl);
      if (t) t.textContent = '收起其他方式 ‹';
    }
  }

  function startAuth() {
    stopPoll();
    authUrl = ''; authKey = ''; authPolls = 0; appLaunched = false; qrDrawn = false;
    if (qrVeil) { qrVeil.hidden = false; qrVeil.textContent = '二维码未生成'; }
    var launch = $('#socLaunch', modalEl);
    if (launch) launch.disabled = true;
    setStatus('正在向 B 站申请授权…', '');
    api('/api/social/auth').then(function (j) {
      if (!j || !j.ok) {
        if (qrVeil) qrVeil.textContent = '获取失败';
        setStatus(j && j.error ? j.error : '授权申请失败，请重试', 'bad');
        openAlt();
        return;
      }
      authUrl = j.url; authKey = j.key;
      authDeadline = Date.now() + (parseInt(j.ttl, 10) || 180) * 1000;
      if (launch) launch.disabled = false;
      if (qrVeil) qrVeil.textContent = '点「显示二维码」生成';
      launchApp();
      stopPoll();
      authTimer = setInterval(pollAuth, 1500);
      pollAuth();
    }).catch(function (e) {
      if (qrVeil) qrVeil.textContent = '网络失败';
      setStatus('无法连接本地服务：' + (e && e.message ? e.message : e), 'bad');
      openAlt();
    });
  }

  function launchApp() {
    if (!authUrl) { startAuth(); return; }
    var bridge = global.BiliBridge;
    if (bridge && typeof bridge.biliAppInstalled === 'function' &&
        typeof bridge.biliAuth === 'function' && bridge.biliAppInstalled()) {
      var r = '';
      try { r = bridge.biliAuth(authUrl); } catch (e) { r = 'failed'; }
      if (r === 'ok' || r === 'ok-https') {
        appLaunched = true;
        setStatus('已打开 B 站 App，请在授权页点「确认」', '');
        return;
      }
      setStatus('唤起 B 站 App 失败，请用「其他登录方式」', 'bad');
    } else {
      setStatus('未检测到 B 站客户端，请用「其他登录方式」', 'bad');
    }
    openAlt();
  }

  function copyAuthUrl() {
    if (!authUrl) { setStatus('授权尚未就绪', 'bad'); return; }
    if (global.BiliBridge && typeof global.BiliBridge.copyText === 'function') {
      global.BiliBridge.copyText(authUrl);
      setStatus('已复制授权链接，可粘贴到 B 站 App 内打开', '');
      return;
    }
    // 桌面调试版：临时 textarea + execCommand（Chrome 74 可用）
    var ta = document.createElement('textarea');
    ta.value = authUrl;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    setStatus(ok ? '已复制授权链接' : '复制失败，请改用二维码', ok ? '' : 'bad');
  }

  function drawQr() {
    try {
      var q = global.QRGen.draw(qrCanvas, authUrl, { scale: 4, border: 2 });
      qrCanvas.style.width = (q.size + 4) * 4 + 'px';
      qrCanvas.style.height = (q.size + 4) * 4 + 'px';
      qrDrawn = true;
      if (qrVeil) qrVeil.hidden = true;
      setStatus('二维码已生成（可选兜底）', '');
    } catch (e) {
      if (qrVeil) qrVeil.textContent = '二维码渲染失败';
      setStatus('二维码渲染失败：' + (e && e.message ? e.message : e), 'bad');
    }
  }
  function showQr() {
    // 用户可能跳过主路径直接点「显示二维码」：此时自己申请一次会话
    if (!authUrl) {
      setStatus('正在获取授权…', '');
      api('/api/social/auth').then(function (j) {
        if (!j || !j.ok) { setStatus(j && j.error ? j.error : '获取授权失败', 'bad'); return; }
        authUrl = j.url;
        drawQr();
      }).catch(function (e) {
        setStatus('获取授权失败：' + (e && e.message ? e.message : e), 'bad');
      });
      return;
    }
    drawQr();
  }

  function pollAuth() {
    if (!authKey || !authTimer) return;
    authPolls++;
    if (authPolls > 135 || Date.now() > authDeadline) {
      stopPoll();
      setStatus('授权已过期，点「重新获取授权」重试', 'bad');
      return;
    }
    api('/api/social/poll?key=' + encodeURIComponent(authKey)).then(function (j) {
      if (!j || !j.ok) {
        setStatus(j && j.error ? j.error : '轮询失败', 'bad');
        return;
      }
      if (j.status === 'wait') {
        setStatus(appLaunched ? '请在 B 站 App 里点「确认」…'
                              : '等待在 B 站 App 中确认…', '');
        return;
      }
      if (j.status === 'scanned') { setStatus('已在 App 中打开，请点「确认」', ''); return; }
      if (j.status === 'expired') {
        stopPoll();
        setStatus('授权已失效，点「重新获取授权」重试', 'bad');
        return;
      }
      if (j.status === 'unknown') { setStatus(j.text || '等待确认…', ''); return; }
      if (j.status === 'done') {
        stopPoll();
        setStatus('登录成功，正在刷新画质…', 'ok');
        if (j.me) { me = j.me; lastSig = ''; render(true); }
        lsDel(COOKIE_KEY);          // 清掉旧的手填 Cookie，统一由本地代理托管凭证
        setTimeout(function () {
          closeLogin();
          tip('登录成功' + (me.vip ? '（大会员，画质已解锁）' : ''));
          refreshMe(true);
          callVCNC('reload');       // 重新取流，playurl 才会返回大会员画质
        }, 700);
      }
    }).catch(function () { /* 弱网丢一次轮询无所谓，下一轮继续 */ });
  }

  function saveManual(v, silent) {
    api('/api/social/manual', { method: 'POST', body: form({ cookie: v }) })
      .then(function (j) {
        if (!j || !j.ok) {
          setStatus(j && j.error ? j.error : '保存失败', 'bad');
          if (silent) tip('Cookie 未同步：' + (j && j.error ? j.error : '失败'));
          return;
        }
        me = j.me || me;
        lastSig = '';
        render(true);
        // 弹层手填时清掉旧的手填值；设置页手填（silent）时保留，输入框才不会「看起来没保存」
        if (!silent) lsDel(COOKIE_KEY);
        if (!silent) {
          setStatus('Cookie 已保存，正在刷新画质…', 'ok');
          setTimeout(function () {
            closeLogin();
            tip('登录成功' + (me.vip ? '（大会员，画质已解锁）' : ''));
            refreshMe(true);
            callVCNC('reload');
          }, 600);
        }
      })
      .catch(function (e) { setStatus('保存失败：' + (e && e.message ? e.message : e), 'bad'); });
  }

  // ---------------------------------------------------------------- 操作
  function doTriple(bvid) {
    if (busy || !bvid) return;
    busy = true;
    stateText = '正在三连…'; stateClass = 'soc-state'; lastSig = ''; render(true);
    api('/api/social/triple', { method: 'POST', body: form({ bvid: bvid }) })
      .then(function (j) {
        busy = false;
        if (!j || !j.ok) {
          stateText = j && j.error ? j.error : '三连失败';
          stateClass = 'soc-state bad';
          tip(stateText);
          if (j && j.needLogin) { refreshMe(true); openLogin(); }
          lastSig = ''; render(true);
          return;
        }
        markTripled(bvid);
        var parts = [];
        parts.push('点赞' + (j.like ? '✓' : '—'));
        parts.push('投币' + (j.coin ? '✓' : '—'));
        parts.push('收藏' + (j.fav ? '✓' : '—'));
        stateText = parts.join(' · ');
        stateClass = 'soc-state ok';
        tip('三连成功，谢谢支持 VCNC！');
        lastSig = ''; render(true);
      })
      .catch(function (e) {
        busy = false;
        stateText = '网络错误：' + (e && e.message ? e.message : e);
        stateClass = 'soc-state bad';
        lastSig = ''; render(true);
      });
  }

  function doLogout() {
    api('/api/social/logout', { method: 'POST', body: form({ t: Date.now() }) })
      .then(function () {
        me = { loggedIn: false, vip: false, name: '', face: '', level: 0, coins: 0, mid: 0 };
        stateText = ''; lastSig = ''; render(true);
        // 保留画质选择：基础档未登录也可用，重新取流即可
        tip('已退出登录（B 站其它设备不受影响）');
        callVCNC('reload');
      })
      .catch(function () { tip('退出登录失败'); });
  }

  // ---------------------------------------------------------------- 启动
  function init() {
    buildDOM();
    // 设置页的「退出登录」：浮窗里不再放退出入口（保持极简），换账号在这里
    var lo = $('#socLogout');
    if (lo) lo.addEventListener('click', function () {
      if (!me.loggedIn) { tip('当前未登录'); return; }
      doLogout();
    });
    refreshMe(false);
    render(true);
    setInterval(function () { render(false); }, 1500);   // 切场 / 解析完成时同步画质与三连状态
    // 从 B 站 App 授权完切回来时立刻补一次轮询，不必干等下一个 1.5s
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && authKey && authTimer) pollAuth();
    });
  }

  global.VCNCSocial = {
    refreshMe: refreshMe,
    openLogin: openLogin,
    /** 自定义集锦用它判断登录态 / 取 mid 区分「我的」与「别人的」评论 */
    getMe: function () { return me; },
    /** 验收脚本用：展开兜底区并绘制二维码，检查自研 QR 编码器仍可用 */
    showQr: function () { openAlt(); showQr(); },
    /** 设置页旧的手填 Cookie 输入框保存时同步到后端，避免两套凭证不一致 */
    syncManual: function (v) {
      if (!v || !v.trim()) return;
      saveManual(v.trim(), true);
    }
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
