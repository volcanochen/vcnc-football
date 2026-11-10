/* 顶部行 + 播放控件的真机验收（返回结构化结果）。
   用法：CDP_PORT=9922 python _test/cdp_eval.py _test/verify_top_row.js
   覆盖：① 账号浮窗头部一行（头像 + 用户名 + 收起箭头）
        ② 三连按钮挂在标题行、紧跟标题文字，未登录为灰态
        ③ 播放键比其它键大、倒放键与播放键拉开距离
        ④ 流量 HUD 与标题同一行、靠右贴「列表/设置」，信息未精简（本次 + 累计）
        ⑤ 收起箭头朝左（展开时 ‹，收起后 ›）
   不点击三连按钮：未登录时它会走 openLogin → 唤起 B 站 App，打断 CDP。
*/
(function () {
  function q(s) { return document.querySelector(s); }
  // 冷启动要先拉 feed/playurl，播放页的 .ctitle / 三连按钮才存在；先等就绪再量
  function ready() { return !!q('.ctitle') && !!q('#socTripleTop'); }
  function poll(n) {
    if (ready()) return Promise.resolve(true);
    if (n <= 0) return Promise.resolve(false);
    return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return poll(n - 1); });
  }
  return poll(60).then(function (ok) {
    if (!ok) return { notReady: true, hint: '页面还没加载出播放页元素' };
    return run();
  });

  function run() {
  function box(s) {
    var e = q(s); if (!e) return null;
    var b = e.getBoundingClientRect();
    return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top),
             bt: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
  }
  function cs(s, p) { var e = q(s); return e ? getComputedStyle(e)[p] : null; }

  var fold = q('#socFold');
  var avatar = q('#socAv'), name = q('#socNm');
  var ab = box('#socAv'), nb = box('#socNm'), fb = box('#socFold');

  var arrowExpanded = fold ? fold.textContent : null;
  var arrowCollapsed = arrowExpanded;
  if (fold) {
    fold.click();
    arrowCollapsed = fold.textContent;
    fold.click();                       // 还原展开
    arrowExpanded = fold.textContent;
  }

  var title = box('.ctitle'), triple = box('#socTripleTop');
  var hud = box('#netHud'), nav = box('#pageNav'), info = box('.chinfo');
  // chrome 隐藏时除播放键外的按钮宽度都会被收起（width:0），量不到真实尺寸
  if (document.body.classList.contains('chrome-off') && typeof window.showChrome === 'function') {
    window.showChrome();
  }
  var play = box('#btnPlay'), rev = box('#btnRev'), loop = box('#btnLoop'), slow = box('.cbtn.slow');

  return {
    vw: window.innerWidth,
    // ① 浮窗头部
    head: {
      avatarPresent: !!avatar,
      nameText: name ? name.textContent : null,
      sameRow: !!(ab && nb && Math.abs((ab.t + ab.bt) / 2 - (nb.t + nb.bt) / 2) <= 3),
      avatarLeftOfName: !!(ab && nb && ab.r <= nb.l),
      foldRightOfName: !!(nb && fb && fb.l >= nb.r - 1),
      foldOnSameRow: !!(fb && nb && Math.abs((fb.t + fb.bt) / 2 - (nb.t + nb.bt) / 2) <= 3)
    },
    // ⑤ 收起箭头
    arrow: { expanded: arrowExpanded, collapsed: arrowCollapsed },
    // ② 标题行三连按钮：在标题那一行、紧贴标题字符后面（不推开到最右）
    tripleTop: {
      present: !!triple,
      inChinfo: !!(triple && info && triple.l >= info.l && triple.r <= info.r + 1),
      inTitleRow: !!q('#socTripleTop') && !!q('#socTripleTop').parentNode &&
                  q('#socTripleTop').parentNode.className === 'ci-row',
      text: q('#socTripleTop') ? q('#socTripleTop').textContent : null,
      cls: q('#socTripleTop') ? q('#socTripleTop').className : null,
      afterTitle: !!(title && triple && triple.l >= title.l),
      gapFromTitleEnd: (title && triple) ? triple.l - title.r : null,
      gapOk: !!(title && triple && (triple.l - title.r) >= 2 && (triple.l - title.r) <= 12),
      sameRowAsTitle: !!(title && triple &&
                        Math.abs((title.t + title.bt) / 2 - (triple.t + triple.bt) / 2) <= 6),
      titleVisibleWidth: title ? title.w : null
    },
    // ④ 流量 HUD：与标题同一行、贴页签左侧、三项信息横排一行
    hud: {
      present: !!hud,
      sameRowAsTitle: !!(hud && title && Math.abs(hud.t - title.t) <= 8),
      rightOfTitleEnd: !!(hud && title && hud.l >= title.r - 2),
      gapToNav: (hud && nav) ? nav.l - hud.r : null,
      oneLine: (function () {
        var sp = document.querySelectorAll('#netHud .hud-l1, #netHud .hud-l2, #netHud .hud-l3');
        if (!sp.length) return false;
        var t0 = Math.round(sp[0].getBoundingClientRect().top);
        for (var i = 1; i < sp.length; i++) {
          if (Math.abs(Math.round(sp[i].getBoundingClientRect().top) - t0) > 2) return false;
        }
        return true;
      })(),
      singleRowHeight: hud ? hud.h : null,
      compact: !!(q('#netHud') && /compact/.test(q('#netHud').className)),
      text: q('#netHud') ? q('#netHud').textContent : null,
      hasSessionAndTotal: !!(q('#netHud') && /本次/.test(q('#netHud').textContent)
                             && /累计/.test(q('#netHud').textContent)),
      // 紧凑档也必须还是三个数字（本次/累计 只藏标签，不丢数值）
      hasThreeNumbers: !!(q('#netHud') &&
                          (q('#netHud').textContent.match(/[0-9.]+[BKMG]/g) || []).length >= 3),
      box: hud
    },
    title: title,
    nav: nav,
    // ③ 播放控件
    ctl: {
      playW: play ? play.w : null, playH: play ? play.h : null,
      otherW: loop ? loop.w : null, otherH: loop ? loop.h : null,
      slowW: slow ? slow.w : null,
      gapPlayRev: (play && rev) ? rev.l - play.r : null,
      barHeight: box('#cornerCtl') ? box('#cornerCtl').h : null
    },
    // 设置页退出入口
    settingsLogout: {
      whoPresent: !!q('#socWho'), who: q('#socWho') ? q('#socWho').textContent : null,
      btnPresent: !!q('#socLogout')
    }
  };
  }
})()
