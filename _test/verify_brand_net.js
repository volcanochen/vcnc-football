/* 品牌化 / 分享区 / 流量计量 真机验收：在 WebView 里跑，返回结构化结果。
   用法：CDP_PORT=9922 python _test/cdp_eval.py _test/verify_brand_net.js
*/
(async function () {
  function q(s) { return document.querySelector(s); }
  var imgs = ['.share-logo', '.share-qr', '.donate-qr'].map(function (s) {
    var e = q(s);
    return { sel: s, present: !!e, loaded: !!(e && e.complete && e.naturalWidth > 0),
             w: e ? e.naturalWidth : 0 };
  });
  var stat = null;
  try {
    stat = await fetch('/api/net/stat').then(function (r) { return r.json(); });
  } catch (e) { stat = { error: String(e) }; }
  return {
    title: document.title,
    page: document.body.getAttribute('data-page'),
    netHudText: q('#netHud') ? q('#netHud').textContent : null,
    netHudVisible: q('#netHud') ? getComputedStyle(q('#netHud')).display : null,
    netStatText: q('#netStat') ? q('#netStat').textContent : null,
    shareLinks: document.querySelectorAll('.share-link').length,
    shareButtons: !!q('#shareAppBtn') && !!q('#copyDownloadBtn'),
    netReset: !!q('#netReset'),
    setBackTop: !!q('#setBackTop'),
    oldSetBack: !!q('#setBack'),
    oldSheetFoot: !!q('.sheet-foot'),
    imgs: imgs,
    netApi: stat,
    bridge: {
      openUrl: !!(window.BiliBridge && BiliBridge.openUrl),
      shareText: !!(window.BiliBridge && BiliBridge.shareText),
      copyText: !!(window.BiliBridge && BiliBridge.copyText)
    }
  };
})()
