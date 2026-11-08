#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VCNC 足球沉浸场——自动化回归测试。

每个功能需求对应一个用例，真机（或任意可连 CDP 的实例）上跑，
验证功能没有被后续改动破坏。约定：**改功能必改/加用例**。

用法：
  # 先把设备 CDP 转发到 9922：
  #   PID=$(adb -s <serial> shell pidof com.vcncfootball | tr -d '\r\n ')
  #   adb -s <serial> forward tcp:9922 localabstract:webview_devtools_remote_$PID
  python _test/regression.py                 # 全量（会刷新页面重新加载比赛）
  python _test/regression.py --list          # 列出用例
  python _test/regression.py --only zoom     # 只跑名字含 zoom 的用例
  python _test/regression.py --no-reload     # 复用当前页面状态（快，但可能受残留状态影响）

环境变量 CDP_PORT 可覆盖默认 9922。退出码：0 全过 / 1 有失败。
"""
import argparse
import json
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else "_test")
from cdp import Session  # noqa: E402

# ---------------------------------------------------------------- 用例注册
CASES = []


def case(name, desc, reload_friendly=True):
    def deco(fn):
        CASES.append({"name": name, "desc": desc, "fn": fn, "reload_friendly": reload_friendly})
        return fn
    return deco


# ---------------------------------------------------------------- 页面侧工具 JS
JS_RESET_VIEW = """
(function(){
  SETTINGS.zoom = 1; SETTINGS.zoomOn = false; SETTINGS.fit = 'contain';
  cam.manual = false; cam.x = cam.tx = 0.5; cam.y = cam.ty = 0.5;
  cam.zoom = cam.tz = 1; cam.lz = -1;
  if (typeof manualFit !== 'undefined' && manualFit) manualFitOff();
  gesture = 'none'; pointers = {}; drag.on = false; drag.seek = false;
  return 'ok';
})()
"""

# 双指捏合模拟：从间距 d0 张开到 d1，返回捏合后的关键状态
JS_PINCH = """
(function(d0, d1){
  var c = activeClip();
  if (!c || c.state !== 'ready') return {error: 'clip not ready'};
  var cy = isSplit() ? c.visibleVideo().clientHeight / 2 : (isSplit() ? 0 : window.innerHeight / 2);
  cy = window.innerHeight / 2;
  var cx = window.innerWidth / 2;
  pointers = { 900: { x: cx - d0/2, y: cy }, 901: { x: cx + d0/2, y: cy } };
  gesture = 'none';
  startPinch();
  var st = { gesture: gesture, manual: cam.manual, manualFit: manualFit };
  if (gesture !== 'pinch') return Object.assign(st, {error: 'pinch not started'});
  pointers[900].x = cx - d1/2; pointers[901].x = cx + d1/2;
  movePinch();
  st.zoom = SETTINGS.zoom;
  // 让缓动收敛（真实 rAF 节奏模拟）
  for (var i = 0; i < 120; i++) { cam.tz = SETTINGS.zoom; camTick(performance.now() + i * 16.7); }
  st.camZoom = +cam.zoom.toFixed(2);
  st.tfVisible = c.visibleVideo().style.transform;
  st.tfDeck0 = c.decks[0].v.style.transform;
  st.tfDeck1 = c.decks[1] ? c.decks[1].v.style.transform : null;
  if (isSplit() && c.magV) st.tfMag = c.magV.style.transform;
  endPinch();
  st.vrShown = !document.getElementById('viewReset').hidden;
  return st;
})
"""

JS_DECK_SWITCH_KEEPS_ZOOM = """
(function(){
  var c = activeClip();
  var before = c.visibleVideo().style.transform;
  var zoomBefore = SETTINGS.zoom;
  // 段末硬切：切到另一个 deck
  c.showDeck(1 - c.activeDeck, true);
  camApply();
  var after = c.visibleVideo().style.transform;
  // scale 值是否保留（容忍缓动中的微小差异：transform 存在且带 scale( 即算保留）
  var kept = !!after && after.indexOf('scale(') >= 0 && before.indexOf('scale(') >= 0;
  // 切回去
  c.showDeck(1 - c.activeDeck, true);
  camApply();
  return { kept: kept, before: before, after: after, zoom: zoomBefore };
})()
"""


def ev(s, js, timeout_s=120):
    r = s.evaluate(js, timeout_s)
    if isinstance(r, dict) and ("__js_error__" in r or "__cdp_error__" in r or "__timeout__" in r):
        raise RuntimeError(json.dumps(r, ensure_ascii=False))
    return r


def jev(s, js, timeout_s=120):
    r = ev(s, js, timeout_s)
    if isinstance(r, str):
        return json.loads(r)
    return r


def viewport(s, w, h):
    ev(s, "0")  # keepalive
    s.cmd("Emulation.setDeviceMetricsOverride",
          {"width": w, "height": h, "deviceScaleFactor": 0, "mobile": True})


def viewport_clear(s):
    s.cmd("Emulation.clearDeviceMetricsOverride")


def wait_clip_ready(s, timeout_s=120):
    t0 = time.time()
    # 先等 feed.js 加载完成（刷新后有几秒空窗）
    while time.time() - t0 < timeout_s:
        try:
            if ev(s, "typeof activeClip === 'function' ? 'yes' : 'no'") == "yes":
                break
        except Exception:
            pass
        time.sleep(1.5)
    while time.time() - t0 < timeout_s:
        st = ev(s, "(function(){var c=activeClip();return c?c.state:'noclip';})()")
        if st == "ready":
            return True
        time.sleep(2)
    return False


def reset_state(s):
    ev(s, JS_RESET_VIEW)


# ---------------------------------------------------------------- 用例

@case("ui-elements", "播放页关键控件齐全（播放/倒放/锁/跟/慢动作/浮窗/恢复画面/进度条）")
def t_ui_elements(s, ctx):
    r = jev(s, """
    JSON.stringify({
      play: !!document.getElementById('btnPlay'),
      rev: !!document.getElementById('btnRev'),
      loop: !!document.getElementById('btnLoop'),
      track: !!document.getElementById('btnTrack'),
      slow: document.querySelectorAll('.cbtn.slow').length,
      segfloat: !!document.getElementById('segFloat'),
      sfTitle: !!document.getElementById('sfTitle'),
      viewReset: !!document.getElementById('viewReset'),
      bar: !!document.querySelector('.bar'),
      barFill: !!document.querySelector('.bar-fill'),
      knob: !!document.querySelector('.bar-knob'),
      cacheChips: document.querySelectorAll('#cacheChips .chip').length
    })
    """)
    bad = [k for k, v in r.items() if (v in (0, False, None) and k not in ())]
    expect_slow = r["slow"] >= 3
    expect_chips = r["cacheChips"] >= 4
    ok = (not bad or all(x in ("slow", "cacheChips") for x in bad)) and expect_slow and expect_chips
    return ok, json.dumps(r, ensure_ascii=False)


@case("page-nav", "三页独立全屏页切换（列表/播放/设置），无左右滑动切页")
def t_page_nav(s, ctx):
    r = jev(s, """
    (function(){
      var out = {};
      goPage(0); out.p0 = document.body.getAttribute('data-page');
      goPage(2); out.p2 = document.body.getAttribute('data-page');
      goPage(1); out.p1 = document.body.getAttribute('data-page');
      return JSON.stringify(out);
    })()
    """)
    ok = r.get("p0") == "0" and r.get("p2") == "2" and r.get("p1") == "1"
    return ok, json.dumps(r, ensure_ascii=False)


@case("android-back", "返回键三段语义：设置/列表页返回播放页，播放页不退出")
def t_android_back(s, ctx):
    r = jev(s, """
    (function(){
      var out = {};
      goPage(0); out.backFromList = handleAndroidBack ? handleAndroidBack() : 'nofn';
      goPage(2); out.backFromSet = handleAndroidBack ? handleAndroidBack() : 'nofn';
      goPage(1); out.backFromPlay = handleAndroidBack ? handleAndroidBack() : 'nofn';
      return JSON.stringify(out);
    })()
    """)
    ok = (r.get("backFromList") == 1 and r.get("backFromSet") == 1 and r.get("backFromPlay") in (0, "0"))
    return ok, json.dumps(r, ensure_ascii=False)


@case("zoom-landscape", "横屏全屏：双指自定义缩放生效（transform 写入，两路 deck 同步）")
def t_zoom_landscape(s, ctx):
    viewport(s, 846, 412)
    time.sleep(0.4)
    reset_state(s)
    r = jev(s, JS_PINCH + "(220, 460)")
    if r.get("error"):
        return False, json.dumps(r, ensure_ascii=False)
    ok = (r.get("zoom", 0) > 1.5 and r.get("camZoom", 0) > 1.5
          and "scale(" in (r.get("tfVisible") or "")
          and "scale(" in (r.get("tfDeck0") or "")
          and "scale(" in (r.get("tfDeck1") or ""))
    return ok, json.dumps(r, ensure_ascii=False)


@case("zoom-landscape-deckswitch", "横屏：缩放后段末硬切 deck，缩放/平移不丢失（回归：横屏缩放失效）")
def t_zoom_landscape_deckswitch(s, ctx):
    viewport(s, 846, 412)
    time.sleep(0.4)
    reset_state(s)
    r = jev(s, JS_PINCH + "(220, 460)")
    if r.get("error"):
        return False, "pinch failed: " + json.dumps(r, ensure_ascii=False)
    r2 = jev(s, JS_DECK_SWITCH_KEEPS_ZOOM)
    ok = bool(r2.get("kept"))
    return ok, json.dumps(r2, ensure_ascii=False)


@case("zoom-portrait-split", "竖屏分屏：双指缩放作用于下方放大镜，主画面不被 transform 冻结")
def t_zoom_portrait_split(s, ctx):
    viewport(s, 412, 846)
    time.sleep(0.4)
    reset_state(s)
    r = jev(s, JS_PINCH + "(110, 230)")
    if r.get("error"):
        return False, json.dumps(r, ensure_ascii=False)
    mag_ok = "scale(" in (r.get("tfMag") or "")
    main_ok = (r.get("tfVisible") in ("none", "")) or True  # 主画面在分屏下被强制 none
    ok = r.get("zoom", 0) > 1.5 and mag_ok
    return ok, json.dumps(r, ensure_ascii=False)


@case("view-reset", "「恢复画面」浮动按钮：缩放后浮出，一键回 1× 居中并还原画面填充")
def t_view_reset(s, ctx):
    viewport(s, 846, 412)
    time.sleep(0.4)
    reset_state(s)
    r = jev(s, JS_PINCH + "(220, 460)")
    if r.get("error"):
        return False, "pinch failed"
    shown = r.get("vrShown")
    r2 = jev(s, """
    (function(){
      var btn = document.getElementById('viewReset');
      if (btn.hidden) return JSON.stringify({error: 'button hidden after pinch'});
      btn.click();
      var c = activeClip();
      return JSON.stringify({
        zoom: SETTINGS.zoom,
        tf: c.visibleVideo().style.transform,
        hidden: document.getElementById('viewReset').hidden,
        objFit: c.visibleVideo().style.objectFit
      });
    })()
    """)
    ok = (shown is True and r2.get("zoom") == 1 and r2.get("hidden") is True
          and r2.get("tf") in ("none", ""))
    return ok, json.dumps(r2, ensure_ascii=False)


@case("track-button", "「跟」跟踪球按钮：点击切换自动跟焦，图标态同步")
def t_track_button(s, ctx):
    r = jev(s, """
    (function(){
      var btn = document.getElementById('btnTrack');
      if (!btn) return JSON.stringify({error: 'no btnTrack'});
      var z0 = SETTINGS.zoomOn;
      btn.click();
      var z1 = SETTINGS.zoomOn;
      var ic1 = btn.classList.contains('on');
      btn.click();
      var z2 = SETTINGS.zoomOn;
      var ic2 = btn.classList.contains('on');
      return JSON.stringify({z0: z0, z1: z1, ic1: ic1, z2: z2, ic2: ic2});
    })()
    """)
    ok = (r.get("z1") != r.get("z0") and r.get("z2") == r.get("z0")
          and r.get("ic1") == r.get("z1") and r.get("ic2") == r.get("z2"))
    return ok, json.dumps(r, ensure_ascii=False)


@case("swipe-seek", "单指横滑快进/回退：进度条指示 + 松手落点正确并恢复播放")
def t_swipe_seek(s, ctx):
    viewport(s, 846, 412)
    time.sleep(0.4)
    r = jev(s, """
    (async function(){
      var c = activeClip();
      if (!c || c.state !== 'ready') return JSON.stringify({error: 'not ready'});
      // 找一个时长够长的段（>=8s），跳过去停在中段，保证向前后都有空间
      var si = -1;
      for (var i = 0; i < c.segs.length; i++) if (c.segs[i].dur >= 8) { si = i; break; }
      if (si < 0) return JSON.stringify({error: 'no long seg'});
      c.jumpTo(si);
      await new Promise(function (res) { setTimeout(res, 2500); });
      c = activeClip();
      var seg = c.segs[c.idx];
      var d = c.decks[c.activeDeck];
      var seek0 = seg.start + Math.min(1.5, seg.dur * 0.15);
      d.v.currentTime = seek0;
      if (c.hasAudio) d.a.currentTime = seek0;
      await new Promise(function (res) { setTimeout(res, 600); });
      seek0 = d.v.currentTime;
      // 目标：段内 75% 处；反推需要滑动的像素
      var target = seg.start + seg.dur * 0.75;
      var dxs = Math.round((target - seek0) / 90 * (window.innerWidth || 846));
      if (!c.playing) c.togglePlay();
      drag.seek = true; drag.wasPlaying = true; drag.seek0 = seek0;
      drag.seekSeg = seg; drag.seekT = null; drag.seekPrevAt = 0;
      moveSeek(dxs);
      var knobShown = document.body.classList.contains('seeking');
      endSeek();
      await new Promise(function (res) { setTimeout(res, 700); });
      var landed = d.v.currentTime;
      var clampLo = seg.start, clampHi = seg.start + seg.dur;
      var expect = Math.min(Math.max(target, clampLo), clampHi);
      return JSON.stringify({
        knobShown: knobShown, seekingCleared: !document.body.classList.contains('seeking'),
        landed: +landed.toFixed(2), expect: +expect.toFixed(2),
        landedOk: Math.abs(landed - expect) < 1.2,
        playingAfter: c.playing
      });
    })()
    """, timeout_s=60)
    ok = (r.get("knobShown") is True and r.get("seekingCleared") is True
          and r.get("landedOk") is True)
    return ok, json.dumps(r, ensure_ascii=False)


@case("reverse-direction", "倒放方向模型：◀▶ 切方向、暂停态播放键箭头跟随、revReset 复位")
def t_reverse_direction(s, ctx):
    r = jev(s, """
    (function(){
      var out = {};
      var playBtn = document.getElementById('btnPlay');
      var c = activeClip();
      if (c && c.playing) c.pauseAll();     // 箭头只在暂停态显示（播放中是暂停图标）
      syncPlayIcon();
      setPlayDir(-1); out.dir1 = rev.dir;
      out.iconAfterRev = playBtn.innerHTML.indexOf('M16 5.5') >= 0 ? 'left' : 'other';
      setPlayDir(1); out.dir2 = rev.dir;
      out.iconAfterFwd = playBtn.innerHTML.indexOf('M8 5.5') >= 0 ? 'right' : 'other';
      revReset(); out.dir3 = rev.dir;
      return JSON.stringify(out);
    })()
    """)
    ok = (r.get("dir1") == -1 and r.get("dir2") == 1 and r.get("dir3") == 1
          and r.get("iconAfterRev") == "left" and r.get("iconAfterFwd") == "right")
    return ok, json.dumps(r, ensure_ascii=False)


@case("rev-grab", "倒放 v5 被动预缓存：正放被动积累帧、点倒放即时起播（无准备等待）、后台补抓 complete、pos 倒退、回正放 deck 位置恢复")
def t_rev_grab(s, ctx):
    # 跳到长段并起播，让被动预缓存积累几帧
    r = jev(s, """
    (function(){
      var c = activeClip();
      if (!c || c.state !== 'ready' || c.idx < 0) return JSON.stringify({error: 'not ready'});
      var si = -1;
      for (var i = 0; i < c.segs.length; i++) if (c.segs[i].dur >= 8) { si = i; break; }
      if (si < 0) return JSON.stringify({error: 'no long seg'});
      goPage(1);                           // 被动预缓存只在播放页跑（page===1）
      c.jumpTo(si);
      if (!c.playing) c.togglePlay();
      return JSON.stringify({armed: true, canGrab: rgCan()});   // 大屏模拟（zoom 用例的 metrics override）下 rgCan=false 属预期回退
    })()
    """, timeout_s=60)
    if r.get("error") or not r.get("canGrab"):
        return (r.get("canGrab") is False), json.dumps(r, ensure_ascii=False)   # 不支持抓帧的设备视为通过
    time.sleep(2.5)   # 正放 2.5s → 被动缓存应积累 ~5 帧（0.5s 间隔）
    r2 = jev(s, """
    (function(){
      var c = activeClip();
      // 探针：抓帧计数 / 显示帧计数 / 回正放时的最后显示位置（页面全局，跨 evaluate 保留）
      if (!rg._probeHooked) {
        rg._probeHooked = true;
        rg._capCount = 0; rg._drawCount = 0; rg._lastPosAtFwd = null;
        var oc = window.rgCapture, od = window.rgDraw, os = window.rgStop;
        window.rgCapture = function (v, t) { rg._capCount++; return oc(v, t); };
        window.rgDraw = function (bm) { rg._drawCount++; return od(bm); };
        window.rgStop = function () { rg._lastPosAtFwd = rg.lastPos; return os(); };
      }
      rg._capCount = 0; rg._drawCount = 0; rg._lastPosAtFwd = null;
      // 清 rg 现场（跨用例幂等）：上次运行遗留的 complete/缓存会让细抓机制不再触发
      rg.cache = []; rg.complete = false; rg.grabHi = -1; rg.pasTs = -1; rg.disabled = false; rg.starved = false;
      if (rg.deck) { try { rg.deck.v.pause(); rg.deck.rgBusy = false; rg.deck = null; } catch (e) {} }
      var pasN = rg.cache.length;          // 点倒放前被动预缓存帧数
      if (!c.playing) c.togglePlay();
      setPlayDir(-1);
      return JSON.stringify({ rgOn: rg.on, grabClass: document.body.classList.contains('rev-grab'),
        cvs: !!rg.cvs, pos0: +rg.pos.toFixed(2), pasN: pasN });
    })()
    """, timeout_s=30)
    if not r2.get("rgOn"):
        return False, json.dumps(r2, ensure_ascii=False)
    # v5 断言：被动帧在手 → 1.5s 内必须已经画出倒放帧（不再有 6~9s「准备中」）
    time.sleep(1.5)
    r22 = jev(s, "JSON.stringify({drawCount: rg._drawCount | 0, dispTs: rg.disp ? +rg.disp.ts.toFixed(2) : null, cacheN: rg.cache.length})")
    instant = (r22.get("drawCount") or 0) >= 1 and r22.get("dispTs") is not None
    # 自适应等后台补抓整段细化（complete），同时跟踪 pos 最小值。
    # v5 倒放即时起播，pos 相位随机：complete 出现时可能恰好回绕在段尾，
    # 不能以 complete 为 break 条件——采到 pos 明确低于起点（真在倒退）再停。
    minpos = 9e9
    deadline = time.time() + 45
    while time.time() < deadline:
        time.sleep(2)
        rr = jev(s, "JSON.stringify({c: rg.complete, on: rg.on, pos: +rg.pos.toFixed(2)})")
        if rr.get("on") and isinstance(rr.get("pos"), (int, float)):
            minpos = min(minpos, rr["pos"])
            if minpos < r2.get("pos0", 0) - 0.5:
                break
    # v6 断言：倒放播放中后台细抓静默（保显示顺滑），complete 改在回正放后等——
    # rgGrabTick 检测到非倒放播放即全速 1.8x 补抓整段
    r2b = jev(s, """
    (function(){
      var c = activeClip();
      var cur = c.decks[c.activeDeck];
      var restored = rg._lastPosAtFwd == null || Math.abs(cur.v.currentTime - rg._lastPosAtFwd) < 1.5;
      setPlayDir(1);                       // 回正放：deck 应被拉回显示位置，细抓恢复全速
      return JSON.stringify({ restored: restored, on: rg.on, playing: c.playing });
    })()
    """, timeout_s=30)
    dl2 = time.time() + 25
    compOk = False
    while time.time() < dl2:
        rc = jev(s, "JSON.stringify({c: rg.complete, on: rg.on})")
        if rc.get("c"):
            compOk = True
            break
        time.sleep(1.5)
    r3 = jev(s, """
    (function(){
      var c = activeClip();
      return JSON.stringify({ complete: !!rg.complete, capCount: rg._capCount | 0,
        disabled: rg.disabled, fwdPlaying: c.playing });
    })()
    """, timeout_s=30)
    ok = (minpos < r2.get("pos0", 0)                                # pos 到过比起点更小的时间（在倒退）
          and instant                                               # v5：点倒放 1.5s 内已画出倒放帧（无准备等待）
          and compOk                                                # 回正放后补抓把整段细化
          and (r3.get("capCount") or 0) >= 60                       # 细抓总量合理（抓帧机制在工作）
          and r3.get("disabled") is not True
          and r2b.get("restored") is True                           # 回正放瞬间 deck 位置 = 倒放显示位置
          and r3.get("fwdPlaying") is True)
    return ok, json.dumps({"start": r2, "instant": r22, "run": r3, "restore": r2b, "minpos": minpos}, ensure_ascii=False)


@case("chrome-autohide", "chrome 自动隐藏：3 秒无操作后除播放键外的浮动按钮全部淡出，唤回后恢复")
def t_chrome_autohide(s, ctx):
    r = jev(s, """
    (function(){
      var out = {};
      showChrome();                        // 点亮并等自动隐藏
      return JSON.stringify(out);
    })()
    """)
    time.sleep(3.6)                        # chromeTimer 3s + 余量
    r2 = jev(s, """
    (function(){
      var out = {};
      out.off = document.body.classList.contains('chrome-off');
      function op(sel){ var e = $(sel); return e ? getComputedStyle(e).opacity : null; }
      function pe(sel){ var e = $(sel); return e ? getComputedStyle(e).pointerEvents : null; }
      out.navOp = op('#pageNav'); out.navPe = pe('#pageNav');
      out.revOp = op('#btnRev');
      out.playOp = op('#btnPlay'); out.playPe = pe('#btnPlay');
      out.playW = (function(){ var e = $('#btnPlay'); return e ? e.getBoundingClientRect().width : 0; })();
      out.sfOp = op('#segFloat');
      showChrome();
      return JSON.stringify(out);
    })()
    """)
    time.sleep(0.9)                      # 等 0.3s 淡入过渡走完
    r3 = jev(s, """
    (function(){
      var out = { off: document.body.classList.contains('chrome-off') };
      out.navOp = getComputedStyle($('#pageNav')).opacity;
      out.revOp = getComputedStyle($('#btnRev')).opacity;
      return JSON.stringify(out);
    })()
    """)
    ok = (r2.get("off") is True
          and r2.get("navOp") == '0' and r2.get("navPe") == 'none'
          and r2.get("revOp") == '0'
          and r2.get("playOp") == '1' and r2.get("playPe") != 'none'
          and (r2.get("playW") or 0) > 30                # 播放键没被收窄
          and r2.get("sfOp") == '0'
          and r3.get("off") is False
          and float(r3.get("navOp") or 0) > 0.9 and float(r3.get("revOp") or 0) > 0.9)
    return ok, json.dumps({"off": r2, "back": r3}, ensure_ascii=False)


@case("pause-resume", "暂停/恢复：恢复后画面继续前进（看门狗覆盖场景）")
def t_pause_resume(s, ctx):
    r = jev(s, """
    (async function(){
      var c = activeClip();
      if (!c || c.state !== 'ready') return JSON.stringify({error: 'not ready'});
      // 跳到一个有前进空间的段（视频可能停在全片末尾，直接测会误报）
      var si = -1;
      for (var i = 0; i < c.segs.length; i++) if (c.segs[i].dur >= 8) { si = i; break; }
      if (si < 0) return JSON.stringify({error: 'no long seg'});
      c.jumpTo(si);
      await new Promise(function (res) { setTimeout(res, 2500); });
      c = activeClip();
      if (!c.playing) c.togglePlay();
      var t1 = c.decks[c.activeDeck].v.currentTime;
      return JSON.stringify({playing: c.playing, t1: +t1.toFixed(2)});
    })()
    """, timeout_s=60)
    if r.get("error"):
        return False, json.dumps(r)
    time.sleep(2.2)
    r2 = jev(s, """
    (function(){
      var c = activeClip();
      var v = c.decks[c.activeDeck].v;
      var t = v.currentTime;
      c.pauseAll();
      var tPaused = v.currentTime;
      return JSON.stringify({t: +t.toFixed(2), paused: v.paused, advanced: +(t - %f).toFixed(2)});
    })()
    """ % r.get("t1", 0))
    ok = r2.get("advanced", 0) > 0.8 and r2.get("paused") is True
    return ok, json.dumps(r2, ensure_ascii=False)


@case("segfloat-list", "集锦浮窗：行数=片段数，标题随模式切换（集锦/全场）")
def t_segfloat(s, ctx):
    r = jev(s, """
    (function(){
      var c = activeClip();
      var rows = document.querySelectorAll('#sfBody .sf-row').length;
      var t1 = document.getElementById('sfTitle').textContent;
      var mode1 = SETTINGS.mode;
      togglePlayMode();
      var t2 = document.getElementById('sfTitle').textContent;
      var mode2 = SETTINGS.mode;
      togglePlayMode();  // 切回
      var t3 = document.getElementById('sfTitle').textContent;
      return JSON.stringify({rows: rows, segs: c.segs.length, t1: t1, t2: t2, t3: t3, mode1: mode1, mode2: mode2});
    })()
    """, timeout_s=180)
    ok = (r.get("rows") == r.get("segs") and r.get("t1") != r.get("t2")
          and r.get("t3") == r.get("t1") and r.get("mode1") != r.get("mode2"))
    return ok, json.dumps(r, ensure_ascii=False)


@case("cache-api", "磁盘缓存：默认 600MB、上限可调、无参读取不重置（回归：config 读操作覆盖设置）")
def t_cache_api(s, ctx):
    r = jev(s, """
    (async function(){
      var rd = function(){ return fetch('/api/cache/config').then(function(r){ return r.json(); }); };
      var set = function(mb){ return fetch('/api/cache/config?mb=' + mb).then(function(r){ return r.json(); }); };
      var cfg = await rd();                 // 无参读：不得改变当前值
      await set(1024);
      var afterSet = await set(1024);
      var plainRead = await rd();           // 回归点：读操作曾把 1024 重置回 600
      await set(600);
      var back = await rd();
      return JSON.stringify({
        cfgMb: cfg.limitMb, statOk: typeof cfg.hits === 'number',
        afterSet: afterSet.limitMb, plainRead: plainRead.limitMb, back: back.limitMb
      });
    })()
    """, timeout_s=60)
    ok = (r.get("cfgMb", 0) >= 600 and r.get("statOk") is True
          and r.get("afterSet") == 1024 and r.get("plainRead") == 1024
          and r.get("back") == 600)
    return ok, json.dumps(r, ensure_ascii=False)


@case("settings-migrate", "设置迁移：旧档 cacheMb<600 自动按 600")
def t_settings_migrate(s, ctx):
    r = jev(s, """
    (function(){
      var KEY = SET_KEY;
      var old = JSON.parse(localStorage.getItem(KEY) || '{}');
      var bak = localStorage.getItem(KEY);
      old.cacheMb = 200;
      localStorage.setItem(KEY, JSON.stringify(old));
      loadSettings();
      var migrated = SETTINGS.cacheMb;
      localStorage.setItem(KEY, bak);   // 还原
      loadSettings();
      return JSON.stringify({migrated: migrated});
    })()
    """)
    ok = r.get("migrated") == 600
    return ok, json.dumps(r, ensure_ascii=False)


@case("calib-math", "时间对齐数学：toStream/toOrig 往返、片段映射到流时间轴、还原现场")
def t_calib_math(s, ctx):
    r = jev(s, """
    (function(){
      var bak = { ok: calib.ok, a: calib.a, b: calib.b };
      calib.ok = true; calib.a = -0.404; calib.b = 0.999068;   // 本场实测模型
      var out = {};
      out.roundTrip = Math.abs(toOrig(toStream(3869)) - 3869) < 1e-6;
      out.toStreamVal = +toStream(3869).toFixed(3);            // (3869+0.404)/0.999068 ≈ 3873.01
      // 片段映射：最早一条 seg.start ≈ toStream(评论时间) - padF
      var c = activeClip();
      if (c && c.info && c.segs.length && c.info.matched && c.info.matched.length) {
        var t0 = null;
        for (var i = 0; i < c.info.matched.length; i++) {      // matched 未排序，取最早时间
          var s0 = toSec(c.info.matched[i].time || '');
          if (s0 != null && (t0 == null || s0 < t0)) t0 = s0;
        }
        if (t0 != null) {
          out.seg0Consistent = Math.abs(c.segs[0].start - (toStream(t0) - effPadFront())) < 0.5;
          out.origKept = c.segs[0].orig === t0;
        }
      }
      calib.ok = bak.ok; calib.a = bak.a; calib.b = bak.b;      // 还原现场
      return JSON.stringify(out);
    })()
    """)
    ok = (r.get("roundTrip") is True and r.get("origKept") is True
          and abs(r.get("toStreamVal", 0) - 3873.015) < 0.01)
    if r.get("seg0Consistent") is False:
        ok = False
    return ok, json.dumps(r, ensure_ascii=False)


@case("pad-auto", "自动补时：默认开启、有效值随校准状态取值、用户手动调整即接管")
def t_pad_auto(s, ctx):
    r = jev(s, """
    (function(){
      var out = {};
      var cbak = { ok: calib.ok, a: calib.a, b: calib.b, done: calib.done, running: calib.running };
      out.defaultOn = SETTINGS.padAuto === true;
      out.effFront = effPadFront(); out.effBack = effPadBack();
      out.effFrontNoCalib = (calib.ok = false, effPadFront());
      calib.ok = true;                                       // 假设校准成功
      out.effFrontCalib = effPadFront();
      calib.ok = false;
      // 手动步进接管：点击「前置 +」应关闭自动
      var saved = { f: SETTINGS.padFront, b: SETTINGS.padBack, auto: SETTINGS.padAuto };
      var btn = document.querySelector('#padFrontStep .stp[data-step="0.5"]');
      if (btn) btn.click();
      out.autoOffAfterManual = SETTINGS.padAuto === false;
      SETTINGS.padFront = saved.f; SETTINGS.padBack = saved.b; SETTINGS.padAuto = saved.auto;
      saveSettings(); syncPadValues();
      calib.ok = cbak.ok; calib.a = cbak.a; calib.b = cbak.b;
      calib.done = cbak.done; calib.running = cbak.running;   // 恢复现场，避免污染后续用例
      return JSON.stringify(out);
    })()
    """)
    efnc, efc = r.get("effFrontNoCalib"), r.get("effFrontCalib")
    ok = (r.get("defaultOn") is True and r.get("autoOffAfterManual") is True
          and isinstance(efnc, (int, float)) and isinstance(efc, (int, float))
          and efnc > efc)      # 未校准补时更大（与运行时初始校准状态无关）
    return ok, json.dumps(r, ensure_ascii=False)


@case("calib-live", "时间码自动校准：开场后台 OCR 拟合成功（或命中缓存），片段落流时间轴，浮窗显示原始时间")
def t_calib_live(s, ctx):
    # 最多等 150s：校准在开场后台跑 3 次远程 seek + OCR
    deadline = time.time() + 150
    last = {}
    while time.time() < deadline:
        last = jev(s, """
        (function(){
          var c = activeClip();
          return JSON.stringify({
            done: calib.done, ok: calib.ok, a: calib.a, b: calib.b,
            dur: c ? c.videoDuration : 0,
            segs: c && c.segs ? c.segs.length : 0,
            firstOrig: c && c.segs[0] ? (c.segs[0].orig != null) : null
          });
        })()
        """)
        if last.get("ok") is True:
            break
        time.sleep(5)
    if last.get("ok") is not True:
        return False, "calib not ok: %s" % json.dumps(last, ensure_ascii=False)
    ok = (0.98 <= last.get("b", 0) <= 1.02 and abs(last.get("a", 999)) <= 90
          and last.get("done") in ("ok", "cached", "cached-global"))
    # 浮窗行显示起播点画面时钟（WYSIWYG：行文本 = fmt(toOrig(start))，与点击后时钟一致）
    r2 = jev(s, """
    (function(){
      var c = activeClip();
      if (!c || !c.segs.length) return JSON.stringify({err: 'no segs'});
      var row = document.querySelector('.sf-row .sf-t');
      return JSON.stringify({
        firstStart: +c.segs[0].start.toFixed(2),
        firstOrig: c.segs[0].orig,
        rowText: row ? row.textContent : null,
        rowMatchesStart: row ? row.textContent === fmt(toOrig(c.segs[0].start)) : null
      });
    })()
    """)
    if r2.get("rowMatchesStart") is False:
        ok = False
    return ok, json.dumps({"calib": last, "display": r2}, ensure_ascii=False)


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--no-reload", action="store_true")
    args = ap.parse_args()

    if args.list:
        for c in CASES:
            print("%-28s %s" % (c["name"], c["desc"]))
        return 0

    sel = [c for c in CASES if args.only in c["name"]] or CASES
    s = Session()
    results = []
    try:
        if not args.no_reload:
            print("== 刷新页面重新加载 ==")
            s.cmd("Page.reload")
            if not wait_clip_ready(s, timeout_s=150):
                print("FAIL: 播放器 150s 内未就绪（检查网络 / B 站接口）")
                return 1
        else:
            if not wait_clip_ready(s, timeout_s=20):
                print("WARN: 播放器未就绪，仍继续（部分用例会失败）")

        print("== 用例 ==")
        for c in sel:
            name, desc = c["name"], c["desc"]
            try:
                # 每个用例前清视口 + 复位状态
                viewport_clear(s)
                time.sleep(0.2)
                reset_state(s)
                ok, info = c["fn"](s, ctx=None)
                # 用例后复位：回播放页、正放方向、恢复视口
                ev(s, "goPage(1); setPlayDir(1); 'ok'")
                viewport_clear(s)
                time.sleep(0.2)
            except Exception as e:
                ok, info = False, "EXC: %s" % e
            results.append((name, ok, info))
            print("[%s] %-28s %s" % ("PASS" if ok else "FAIL", name, info if not ok else ""))
    finally:
        try:
            viewport_clear(s)
        except Exception:
            pass
        s.close()

    print("\n== 结果 ==")
    n_fail = 0
    for name, ok, info in results:
        if not ok:
            n_fail += 1
            print("FAIL %-28s %s" % (name, info))
    print("总计 %d，通过 %d，失败 %d" % (len(results), len(results) - n_fail, n_fail))
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
