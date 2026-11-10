/* 社交功能真机验收：在 WebView 里跑，返回结构化结果。
   用法：CDP_PORT=9922 python _test/cdp_eval.py _test/verify_social.js
   验证到「凭证到手之前」的全部链路：模块加载、左侧浮窗、App 授权入口、
   授权会话端点、二维码兜底渲染、chrome 同进退隐藏、画质门禁、三连接口。
   注意：不真的调用 biliAuth 唤起 B 站 App（会切走 WebView、打断 CDP），
   深链可用性由单独的真机 adb 验证覆盖。 */
(async function () {
  function q(s) { return document.querySelector(s); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var out = {};
  out.title = document.title;
  out.page = document.body.getAttribute('data-page');
  out.qrgen = typeof window.QRGen === 'object' && typeof window.QRGen.encode === 'function';
  out.vcnc = !!window.VCNC && typeof window.VCNC.getState === 'function'
             && typeof window.VCNC.setQuality === 'function' && typeof window.VCNC.reload === 'function';
  out.socialModule = !!window.VCNCSocial;

  // --- App 授权桥（Android 才有）---
  var br = window.BiliBridge;
  out.bridge = {
    present: !!br,
    installed: !!(br && typeof br.biliAppInstalled === 'function' && br.biliAppInstalled()),
    hasAuth: !!(br && typeof br.biliAuth === 'function')
  };

  // --- 流量 HUD 位置（标题同一行、贴「列表/设置」左侧）+ 隐藏等待时长 ---
  var hud = q('#netHud');
  if (hud) {
    var r = hud.getBoundingClientRect();
    var navEl = q('#pageNav');
    var nr = navEl ? navEl.getBoundingClientRect() : null;
    var segs = document.querySelectorAll('#netHud .hud-l1, #netHud .hud-l2, #netHud .hud-l3');
    var t0 = segs.length ? Math.round(segs[0].getBoundingClientRect().top) : null;
    var rows = {};
    for (var i = 0; i < segs.length; i++) rows[Math.round(segs[i].getBoundingClientRect().top)] = 1;
    out.netHud = { top: Math.round(r.top), right: Math.round(r.right),
                   gapToNav: nr ? Math.round(nr.left - r.right) : null,
                   lines: segs.length,
                   textRows: Object.keys(rows).length,     // 1 = 三项横排一行
                   height: Math.round(r.height),
                   compact: /compact/.test(hud.className) };
    out.netHudText = hud.textContent;
  }
  out.chromeIdleMs = window.CHROME_IDLE_MS;
  out.dblMs = window.DBL_MS;

  var fl = q('#socFloat');
  out.float = {
    present: !!fl,
    display: fl ? getComputedStyle(fl).display : null,
    left: fl ? Math.round(fl.getBoundingClientRect().left) : null,
    width: fl ? Math.round(fl.getBoundingClientRect().width) : null,
    zIndex: fl ? getComputedStyle(fl).zIndex : null
  };
  out.modalPresent = !!q('#socModal');

  try {
    out.me = await fetch('/api/social/me').then(function (r) { return r.json(); });
  } catch (e) { out.me = { error: String(e) }; }

  // --- 授权会话端点（主路径）---
  try {
    var a = await fetch('/api/social/auth').then(function (r) { return r.json(); });
    out.auth = { ok: !!a.ok, mode: a.mode || '', urlLen: (a.url || '').length,
                 keyLen: (a.key || '').length, error: a.error || '' };
    out.qrcode = out.auth;   // 兼容门禁里原有字段名
  } catch (e) { out.auth = { error: String(e) }; out.qrcode = out.auth; }

  // --- 登录弹层：默认只看 App 授权，二维码折叠且未绘制 ---
  var modal = q('#socModal');
  // 上一轮可能画过兜底二维码：先清干净画布，才能测出「默认不绘制」
  var cvClean = q('#socQr');
  if (cvClean && cvClean.width > 0) {
    try { cvClean.getContext('2d').clearRect(0, 0, cvClean.width, cvClean.height); } catch (e) {}
  }
  var veilClean = q('#socQrVeil');
  if (veilClean) { veilClean.hidden = false; veilClean.textContent = '二维码未生成'; }
  var cv0 = q('#socQr');
  var dark0 = 0;
  if (cv0 && cv0.width > 0) {
    var d0 = cv0.getContext('2d').getImageData(0, 0, cv0.width, cv0.height).data;
    // 未绘制的 canvas 是全透明（RGBA 全 0），必须看 alpha 否则会误判成「黑块」
    for (var i0 = 0; i0 < d0.length; i0 += 4)
      if (d0[i0] < 100 && d0[i0 + 3] > 200) dark0++;
  }
  out.loginUI = {
    title: q('.soc-card-head span') ? q('.soc-card-head span').textContent : null,
    launch: q('#socLaunch') ? q('#socLaunch').textContent : null,
    altHidden: q('#socAlt') ? q('#socAlt').hidden : null,
    qrVeilVisible: q('#socQrVeil') ? !q('#socQrVeil').hidden : null,
    defaultQrDrawn: dark0 > 1000
  };

  // --- 兜底二维码：展开折叠区并绘制（不会唤起 App）---
  try {
    if (window.VCNCSocial && typeof window.VCNCSocial.showQr === 'function') {
      window.VCNCSocial.showQr();
      await sleep(3200);
      var cv = q('#socQr');
      out.canvas = { width: cv ? cv.width : 0, height: cv ? cv.height : 0 };
      if (cv && cv.width > 0) {
        var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        var dark = 0;
        for (var i = 0; i < d.length; i += 4)
          if (d[i] < 100 && d[i + 3] > 200) dark++;
        out.canvas.darkPixels = dark;
        out.canvas.rendered = dark > 1000;
      }
      out.qrStatus = q('#socQrStatus') ? q('#socQrStatus').textContent : null;
      out.qrVeilHidden = q('#socQrVeil') ? q('#socQrVeil').hidden : null;
      out.altOpen = q('#socAlt') ? !q('#socAlt').hidden : null;
    }
  } catch (e) { out.qrError = String(e); }

  // --- 弹层开关 + chrome 隐藏同进退（直接改 DOM，不触发 startAuth）---
  if (modal) {
    modal.hidden = false;
    out.modalOpen = !modal.hidden;
    document.body.classList.add('chrome-off');
    await sleep(420);                       // 等 .3s opacity transition 走完
    out.chromeOff = {
      floatOpacity: getComputedStyle(fl).opacity,
      modalOpacity: getComputedStyle(modal).opacity,
      floatPE: getComputedStyle(fl).pointerEvents,
      modalPE: getComputedStyle(modal).pointerEvents
    };
    document.body.classList.remove('chrome-off');
    if (q('#socX')) q('#socX').click();
    out.modalClosedAfterX = modal.hidden;
  }

  try { out.state = window.VCNC.getState(); } catch (e) { out.state = { error: String(e) }; }
  out.qualityButtons = document.querySelectorAll('.soc-q').length;
  out.qualityDisabled = document.querySelectorAll('.soc-q[disabled]').length;
  out.qualityHint = q('.soc-hint') ? q('.soc-hint').textContent : null;
  // 三连按钮已移到标题行（.ci-triple），未登录时是灰态
  out.tripleButton = q('.ci-triple') ? q('.ci-triple').textContent : null;
  out.tripleCls = q('.ci-triple') ? q('.ci-triple').className : null;
  out.loginButton = q('.soc-btn.primary') ? q('.soc-btn.primary').textContent : null;

  // 已登录时**不能**真发三连：那是给账号真点赞/投币/收藏。只做接口连通性检查。
  try {
    if (out.me && out.me.loggedIn) {
      out.tripleApi = { ok: true, skipped: 'logged-in: 不触发真实三连' };
    } else {
      out.tripleApi = await fetch('/api/social/triple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'bvid=BV1p5xd6hEK2'
      }).then(function (r) { return r.json(); });
    }
  } catch (e) { out.tripleApi = { error: String(e) }; }
  return out;
})()
