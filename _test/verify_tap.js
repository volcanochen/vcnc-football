/* 手势语义的真机验收：单击＝显示/隐藏浮窗，双击＝播放/暂停。
   用法：CDP_PORT=9922 python _test/cdp_eval.py _test/verify_tap.js
   直接调用页面里的 onTap（与 pointerup 调的是同一个函数），因为 adb tap 的两次
   点击间隔不可控（判定窗口只有 DBL_MS），而脚本能精确控制。 */
(function () {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function off() { return document.body.classList.contains('chrome-off'); }
  function cur() { return window.activeClip(); }
  function playing() { var c = cur(); return !!(c && c.playing); }
  var fake = { clientX: 200, clientY: 500, target: document.body };
  var out = { idleMs: window.CHROME_IDLE_MS, dblMs: window.DBL_MS, steps: {} };

  window.showChrome();
  var c0 = cur();
  out.hasClip = !!c0;
  out.ready = !!(c0 && c0.state === 'ready' && c0.idx >= 0);
  // 上一轮可能停在场末（「本场播完停住」），先跳到中间一段，免得用段尾做播放态判断
  if (out.ready && !c0.playing) c0.jumpTo(3);

  // 起播是异步的（要 seek + 缓冲），先等它真的在播，否则双击前后都是 false 会误判
  function waitPlaying(n) {
    if (playing()) return Promise.resolve(true);
    if (n <= 0) return Promise.resolve(false);
    var c = cur();
    if (c && c.state === 'ready' && c.idx >= 0 && !c.playing) c.jumpTo(c.idx);
    return wait(500).then(function () { return waitPlaying(n - 1); });
  }
  return wait(250).then(function () { return waitPlaying(8); }).then(function (ok) {
    out.playingReady = ok;
    out.steps.start = { chromeOff: off(), playing: playing() };
    window.onTap(fake);                      // ① 单击：可见 → 收起
    return wait(450);
  }).then(function () {
    out.steps.singleHides = off();
    window.onTap(fake);                      // ② 单击：隐藏 → 唤出
    return wait(450);
  }).then(function () {
    out.steps.singleShows = !off();
    out.steps.playingBeforeDouble = playing();
    window.onTap(fake);                      // ③ 双击：播放翻转，浮窗不动
    return wait(90).then(function () { window.onTap(fake); });
  }).then(function () {
    return wait(450);
  }).then(function () {
    out.steps.doubleKeepsChrome = off() === out.steps.start.chromeOff;
    out.steps.doubleTogglesPlay = playing() !== out.steps.playingBeforeDouble;
    window.onTap(fake);                      // ④ 双击后紧接单击：仍能收起（tapLast 已复位）
    return wait(450);
  }).then(function () {
    out.steps.singleAfterDouble = off();
    // ⑤ 浮窗藏着的状态下双击：不能把浮窗带出来（togglePlay 走静默路径）
    out.steps.playingBeforeQuietDouble = playing();
    window.onTap(fake);
    return wait(90).then(function () { window.onTap(fake); });
  }).then(function () {
    return wait(450);
  }).then(function () {
    out.steps.quietDoubleKeepsHidden = off() === true;
    out.steps.quietDoubleToggles = playing() !== out.steps.playingBeforeQuietDouble;
    window.onTap(fake);                      // 还原：再单击回可见
    return wait(450);
  }).then(function () {
    out.steps.restoredVisible = !off();
    var s = out.steps;
    out.verdict = {
      singleHides: s.singleHides === true,
      singleShows: s.singleShows === true,
      doubleKeepsChrome: s.doubleKeepsChrome === true,
      doubleTogglesPlay: s.doubleTogglesPlay === true,
      singleAfterDouble: s.singleAfterDouble === true,
      quietDoubleKeepsHidden: s.quietDoubleKeepsHidden === true
    };
    out.pass = out.verdict.singleHides && out.verdict.singleShows &&
               out.verdict.doubleKeepsChrome && (!out.ready || out.verdict.doubleTogglesPlay) &&
               out.verdict.singleAfterDouble && out.verdict.quietDoubleKeepsHidden;
    return out;
  });
})()
