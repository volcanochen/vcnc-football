#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机复现「点 A 段播 A+1」：探针记录 jumpTo/showDeck/segEnd，adb input tap 真实点击。

用法：python repro_jump.py <scenario>
  s1  播放中点非当前段
  s2  暂停后点非当前段
  s3  播放中把当前段 seek 到段尾附近再点别的段（撞段末自动推进）
  s4  连续快速点同一行两次
  s5  切换 集锦/全场 后点段
"""
import json
import subprocess
import sys
import time

SERIAL = "R5CT90R761Y"
TAP_SCALE = 1.8   # CSS px → 物理 px（wm 720x1544, dpr 1.8）


def ev(expr):
    r = subprocess.run(
        [sys.executable, "_test/cdp_eval.py", "-c", expr],
        capture_output=True, text=True, timeout=120)
    out = r.stdout.strip()
    return out


def tap(cx, cy):
    # 点击前强制显示 chrome，否则 tap 落在视频区 = 暂停/继续+唤回，点不到行
    ev("document.body.classList.remove('chrome-off');1")
    time.sleep(0.3)
    subprocess.run(["adb", "-s", SERIAL, "shell", "input", "tap",
                    str(int(cx)), str(int(cy))], timeout=15)


def get_state():
    out = ev("(function(){var c=activeClip();if(!c)return '{}';"
             "return JSON.stringify({idx:c.idx,playing:c.playing,busy:!!c.busy,"
             "act:c.activeDeck,bakSeg:c.decks[1-c.activeDeck].seg,"
             "bakT:+c.decks[1-c.activeDeck].v.currentTime.toFixed(1),"
             "curT:+c.decks[c.activeDeck].v.currentTime.toFixed(1)});})()")
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out}


def visible_rows():
    """返回 [{i, cx, cy}]（CSS 坐标），全部行可见。"""
    out = ev("(function(){var rows=document.querySelectorAll('#sfBody .sf-row');var out=[];"
             "for(var k=0;k<rows.length;k++){var r=rows[k].getBoundingClientRect();"
             "if(r.top>=0&&r.bottom<=innerHeight&&r.left>=0){"
             "out.push({i:+rows[k].getAttribute('data-i'),cx:r.left+r.width/2,cy:r.top+r.height/2});}}"
             "return JSON.stringify(out);})()")
    return json.loads(out)


def read_log(n=40):
    out = ev("(function(){return JSON.stringify((window.__jlog||[]).slice(-%d));})()" % n)
    try:
        return json.loads(out)
    except Exception:
        return [{"raw": out}]


def clear_log():
    ev("window.__jlog.length=0")


def wait_idle(sec):
    time.sleep(sec)


def run_scenario(name):
    print("=" * 70)
    print("SCENARIO", name)
    st = get_state()
    print("before:", st)
    clear_log()

    if name == "s1":
        ev("activeClip().resumePlay(); 1")
        wait_idle(1.5)
        rows = visible_rows()
        tgt = None
        for r in rows:
            if r["i"] != st["idx"] and r["i"] > st["idx"] + 1:
                tgt = r
                break
        if not tgt:
            print("no target row visible", rows)
            return
        print("tap row", tgt["i"], "css", tgt)
        tap(tgt["cx"] * TAP_SCALE, tgt["cy"] * TAP_SCALE)
        wait_idle(5)

    elif name == "s2":
        ev("activeClip().pauseAll(); 1")
        wait_idle(1)
        rows = visible_rows()
        tgt = None
        for r in rows:
            if r["i"] != st["idx"] and r["i"] > st["idx"] + 1:
                tgt = r
                break
        if not tgt:
            print("no target row visible")
            return
        print("tap row", tgt["i"], "while paused")
        tap(tgt["cx"] * TAP_SCALE, tgt["cy"] * TAP_SCALE)
        wait_idle(6)

    elif name == "s3":
        ev("(function(){var c=activeClip();c.resumePlay();var s=c.segs[c.idx];"
           "c.decks[c.activeDeck].v.currentTime=s.start+s.dur-0.25;return 'ok';})()")
        wait_idle(0.4)
        rows = visible_rows()
        tgt = None
        for r in rows:
            if r["i"] > st["idx"] + 1:
                tgt = r
                break
        if not tgt:
            print("no target row visible")
            return
        print("seek to seg end, tap row", tgt["i"], "(race with auto-advance)")
        tap(tgt["cx"] * TAP_SCALE, tgt["cy"] * TAP_SCALE)
        wait_idle(6)

    elif name == "s4":
        ev("activeClip().resumePlay(); 1")
        wait_idle(1.5)
        rows = visible_rows()
        tgt = None
        for r in rows:
            if r["i"] != st["idx"] and r["i"] > st["idx"] + 1:
                tgt = r
                break
        if not tgt:
            print("no target row visible")
            return
        print("double tap row", tgt["i"])
        tap(tgt["cx"] * TAP_SCALE, tgt["cy"] * TAP_SCALE)
        time.sleep(0.18)
        tap(tgt["cx"] * TAP_SCALE, tgt["cy"] * TAP_SCALE)
        wait_idle(7)

    elif name == "s5":
        ev("(function(){var tt=document.getElementById('sfTitle');"
           "tt ? tt.click() : null; return 'clicked';})()")
        wait_idle(6)
        st2 = get_state()
        print("after mode toggle:", st2)
        clear_log()
        rows = visible_rows()
        tgt = None
        for r in rows:
            if r["i"] != st2["idx"] and r["i"] > st2["idx"] + 1:
                tgt = r
                break
        if not tgt:
            print("no target row visible")
            return
        print("tap row", tgt["i"], "after mode switch")
        tap(tgt["cx"] * TAP_SCALE, tgt["cy"] * TAP_SCALE)
        wait_idle(6)

    print("after:", get_state())
    for e in read_log():
        print("  ", e)


if __name__ == "__main__":
    scs = sys.argv[1:] or ["s1"]
    for s in scs:
        run_scenario(s)
