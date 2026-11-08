#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""倒放卡顿诊断：hook seekTo / showDeck，量化 seek 延迟分布与显示步进间隔。

用法：python _test/rev_probe.py [--dur 20]
前置：CDP 转发 9922（_test/cdp.py 默认端口）。
"""
import json
import sys
import time

sys.path.insert(0, "_test")
from cdp import Session

PROBE = """
(function(){
  if (window.__revProbe) return JSON.stringify({already: true});
  var P = window.__revProbe = { seeks: [], shows: [], t0: performance.now() };
  var origSeek = window.seekTo;
  window.seekTo = function(media, t, timeout){
    if (!(media instanceof HTMLVideoElement)) return origSeek(media, t, timeout);
    var st = performance.now();
    return origSeek(media, t, timeout).then(function(r){
      P.seeks.push([st - P.t0, performance.now() - st, +t.toFixed(3)]);
      return r;
    });
  };
  var proto = window.ClipPlayer && ClipPlayer.prototype;
  if (proto) {
    var origShow = proto.showDeck;
    proto.showDeck = function(k, hard){
      P.shows.push(performance.now() - P.t0);
      return origShow.apply(this, arguments);
    };
  }
  return 'armed';
})()
"""

STOP = """
(function(){
  var P = window.__revProbe;
  if (!P) return JSON.stringify({err: 'no probe'});
  function stats(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function(x, y){ return x - y; });
    var sum = 0; for (var i = 0; i < s.length; i++) sum += s[i];
    return { n: s.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(1),
             p90: +s[Math.floor(s.length * 0.9)].toFixed(1),
             max: +s[s.length - 1].toFixed(1), mean: +(sum / s.length).toFixed(1) };
  }
  var gaps = [];
  for (var i = 1; i < P.shows.length; i++) gaps.push(P.shows[i] - P.shows[i - 1]);
  var cur = activeClip();
  return JSON.stringify({
    elapsed: +(performance.now() - P.t0).toFixed(0),
    seekStats: stats(P.seeks.map(function(x){ return x[1]; })),
    seekTargets: P.seeks.slice(-8).map(function(x){ return x[2]; }),
    showCount: P.shows.length,
    showGapStats: stats(gaps),
    rev: { dir: rev.dir, on: rev.on, step: +rev.step.toFixed(4), lat: +rev.lat.toFixed(1) },
    decks: cur ? cur.decks.map(function(d){ return { t: +d.v.currentTime.toFixed(2),
      ready: d.v.readyState, paused: d.v.paused, seg: d.seg, active: d === cur.decks[cur.activeDeck] }; }) : null,
    rawSeeks: P.seeks.slice(0, 40),
    rawShows: P.shows.slice(0, 40)
  });
})()
"""


def main():
    dur = 20
    if "--dur" in sys.argv:
        dur = int(sys.argv[sys.argv.index("--dur") + 1])
    s = Session()
    r = s.evaluate(PROBE)
    print("probe:", r)
    # 确保播放中且倒放
    s.evaluate("""
    (function(){
      var c = activeClip();
      if (!c || c.idx < 0) return;
      rev.dir = -1;
      if (!c.playing) c.togglePlay();
      if (!rev.on) revStartLoop();
    })()
    """)
    print("reverse running, sampling %ds..." % dur)
    time.sleep(dur)
    r = s.evaluate(STOP)
    d = json.loads(r)
    print(json.dumps(d, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
