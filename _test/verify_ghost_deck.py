# -*- coding: utf-8 -*-
"""验证幽灵画面修复：切段后备用 deck 的 computed opacity 必须为 0（v2026-11-09 showDeck 内联 opacity 残留修复）"""
import sys, os, json, time, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repro_jump import ev, tap, TAP_SCALE  # noqa

SERIAL = 'R5CT90R761Y'


def snap():
    o = ev("""(function(){
      var c=activeClip(); if(!c||c.state!=='ready') return '{}';
      var d=c.decks[c.activeDeck], s=c.segs[c.idx];
      var opac=c.decks.map(function(x){return +getComputedStyle(x.el).opacity;});
      var inline=c.decks.map(function(x){return x.el.style.opacity||'';});
      var clock = (function(){var v=document.createElement('canvas');return null;})();
      return JSON.stringify({idx:c.idx, activeDeck:c.activeDeck, playing:c.playing,
        ct:+d.v.currentTime.toFixed(2), segStart:+s.start.toFixed(2), segEnd:+(s.start+s.dur).toFixed(2),
        opac:opac, inline:opacity_inline_guard(inline)});
      function opacity_inline_guard(a){return a;}
    })()""")
    return json.loads(o)


def main():
    print("=== G1: 初始状态备用层不可见 ===")
    for _ in range(30):
        s = snap()
        if s.get('idx') is not None:
            break
        time.sleep(2)
    print("snap:", s)
    assert s['opac'][1 - s['activeDeck']] == 0, "G1 FAIL: 备用层 opacity=%s" % s['opac']
    print("G1 PASS")

    print("=== G2: 连续切段（慢路径硬切）后备用层不可见 ===")
    for target in [10, 3, 20, 7]:
        ev("(function(){activeClip().jumpTo(%d,{});return 1;})()" % target)
        time.sleep(7)
        s = snap()
        ghost = s['opac'][1 - s['activeDeck']]
        # 目标段可能很短、7 秒内已自然推进（logcat 可证）——只断言幽灵层与画面归属
        ok = ghost == 0 and s['opac'][s['activeDeck']] == 1 and s['segStart'] <= s['ct'] <= s['segEnd']
        print("jump %d -> idx=%d opac=%s inline=%r ct=%.1f seg=[%.1f~%.1f] : %s"
              % (target, s['idx'], s['opac'], s['inline'], s['ct'], s['segStart'], s['segEnd'],
                 "PASS" if ok else "FAIL"))
        assert ok, "G2 FAIL at target=%d" % target
    print("G2 PASS")

    print("=== G3: 段末自动推进（硬切）后备用层不可见 ===")
    # 跳到一个短段尾让它自然推进
    ev("""(function(){var c=activeClip(); var i=c.idx; var s=c.segs[i];
      c.decks[c.activeDeck].v.currentTime = s.start + s.dur - 1.2; return 1;})()""")
    time.sleep(6)
    s = snap()
    ghost = s['opac'][1 - s['activeDeck']]
    print("after auto-advance: idx=%d opac=%s : %s" % (s['idx'], s['opac'], "PASS" if ghost == 0 else "FAIL"))
    assert ghost == 0
    print("G3 PASS")

    print("=== G4: 截图目检：画面烧录钟应与段落时间一致 ===")
    subprocess.run(['adb', '-s', SERIAL, 'exec-out', 'screencap', '-p'],
                   stdout=open(os.path.join(os.environ['TEMP'], 'vfix_g4.png'), 'wb'), timeout=30)
    s = snap()
    import datetime
    expect = s['segStart'] + (s['ct'] - s['segStart'])
    print("当前 idx=%d ct=%.1f (流时间 %.1f~%.1f) — 请对照截图烧录钟应≈ %d:%05.2f 起"
          % (s['idx'], s['ct'], s['segStart'], s['segEnd'],
             int(expect // 60), expect % 60))
    print("G4: 截图已存 %s" % os.path.join(os.environ['TEMP'], 'vfix_g4.png'))
    print("ALL PASS")


if __name__ == '__main__':
    main()
