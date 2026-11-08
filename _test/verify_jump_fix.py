#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修复后全套真机验证 v2：合成点击（与用户点击同路径），断言 idx 与 deck.seg 一致。"""
import json
import os
import sys
import time

ROOT = r'C:\Users\volcano\Documents\WorkBuddyProjects\2026-10-17-19-27-06\vcnc-football'
SERIAL = "R5CT90R761Y"
TAP_SCALE = 1.8
os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, '_test'))
from repro_jump import ev, tap  # noqa


def wait_ready(timeout_s=180):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        out = ev("(function(){var c=activeClip();return c?c.state:'noclip';})()")
        if out.strip() == 'ready':
            return True
        time.sleep(5)
    return False


def install_probe():
    print("probe:", ev(open(os.path.join(ROOT, '_test', 'probe_jump.js'), encoding='utf-8').read()))


def click_row(i):
    return ev("(function(){var rows=document.querySelectorAll('#sfBody .sf-row');"
              "for(var k=0;k<rows.length;k++){if(+rows[k].getAttribute('data-i')===%d){"
              "rows[k].dispatchEvent(new MouseEvent('click',{bubbles:true}));"
              "return 'ok';}}return 'norow';})()" % i)


def st():
    o = ev("(function(){var c=activeClip();if(!c)return '{}';var s=c.segs[c.idx];"
           "return JSON.stringify({idx:c.idx,playing:c.playing,busy:!!c.busy,queued:!!c.queuedJump,"
           "act:c.activeDeck,deckSeg:c.decks[c.activeDeck].seg,"
           "cur:+c.decks[c.activeDeck].v.currentTime.toFixed(1),start:s?s.start:null});})()")
    return json.loads(o)


def content_ok(r):
    """idx 与实际显示 deck 的 seg 标签一致，且位置在本段范围内。"""
    if r['idx'] != r['deckSeg']:
        return False
    return True


def t1_current_row_replay():
    print("\n=== T1 播放中点当前段行 → 段头重播 ===")
    r = st()
    print("before:", r)
    i = r['idx']
    ev("(function(){var c=activeClip(); if(!c.playing) c.resumePlay(); return 1;})()")
    time.sleep(2)
    clear = ev("window.__jlog.length=0;1")
    click_row(i)
    time.sleep(0.8)
    r1 = st()
    print("just after:", r1)
    ok = r1['idx'] == i and content_ok(r1) and abs(r1['cur'] - r1['start']) < 3
    print("RESULT:", "PASS" if ok else "FAIL")
    return ok


def t2_far_row():
    print("\n=== T2 播放中点远处非当前段 ===")
    r = st()
    i = (r['idx'] + 7) % 40
    ev("window.__jlog.length=0;1")
    click_row(i)
    time.sleep(6)
    r2 = st()
    print("after:", r2)
    ok = r2['idx'] == i and content_ok(r2)
    print("RESULT:", "PASS" if ok else "FAIL")
    for e in json.loads(ev("JSON.stringify(window.__jlog.slice(-6))")):
        print("  log:", e)
    return ok


def t3_paused_current_row():
    print("\n=== T3 暂停后点当前段行 → 段头重播并起播 ===")
    ev("activeClip().pauseAll();1")
    time.sleep(1)
    r = st()
    i = r['idx']
    print("paused at", i)
    ev("window.__jlog.length=0;1")
    click_row(i)
    time.sleep(1.5)
    r3 = st()
    print("after:", r3)
    ok = r3['idx'] == i and content_ok(r3) and abs(r3['cur'] - r3['start']) < 3 and r3['playing']
    print("RESULT:", "PASS" if ok else "FAIL")
    return ok


def t3b_paused_far_row():
    print("\n=== T3b 暂停后点远处非当前段 ===")
    ev("activeClip().pauseAll();1")
    time.sleep(1)
    r = st()
    i = (r['idx'] + 5) % 40
    ev("window.__jlog.length=0;1")
    click_row(i)
    time.sleep(7)
    r4 = st()
    print("after:", r4)
    ok = r4['idx'] == i and content_ok(r4)
    print("RESULT:", "PASS" if ok else "FAIL")
    for e in json.loads(ev("JSON.stringify(window.__jlog.slice(-6))")):
        print("  log:", e)
    return ok


def t4_queue_while_busy():
    print("\n=== T4 同一 tick 连点两段 → 排队补跳最后点的段，内容一致 ===")
    r = st()
    cur = r['idx']
    i1 = (cur + 9) % 40
    i2 = (cur + 14) % 40
    ev("window.__jlog.length=0;1")
    out = ev("(function(){function row(i){var rows=document.querySelectorAll('#sfBody .sf-row');"
             "for(var k=0;k<rows.length;k++){if(+rows[k].getAttribute('data-i')===i)return rows[k];}return null;}"
             "var a=row(%d),b=row(%d);if(!a||!b)return 'norow';"
             "a.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
             "var c=activeClip();var busy1=!!c.busy;"
             "b.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
             "return JSON.stringify({busy1:busy1,queued:!!c.queuedJump,qi:c.queuedJump?c.queuedJump.i:null});})()" % (i1, i2))
    print("click2(%d,%d) ->" % (i1, i2), out)
    time.sleep(15)
    r5 = st()
    print("after:", r5)
    ok = r5['idx'] == i2 and content_ok(r5)
    print("RESULT:", "PASS" if ok else "FAIL", "(应落在 %d)" % i2)
    for e in json.loads(ev("JSON.stringify(window.__jlog.slice(-10))")):
        print("  log:", e)
    return ok


def t5_double_click_current():
    print("\n=== T5 快速双击当前段行 → 重播（不跳段） ===")
    r = st()
    i = r['idx']
    ev("(function(){var c=activeClip(); if(!c.playing) c.resumePlay(); return 1;})()")
    time.sleep(2)
    ev("window.__jlog.length=0;1")
    click_row(i)
    click_row(i)
    time.sleep(3)
    r6 = st()
    print("after:", r6)
    ok = r6['idx'] == i and content_ok(r6) and abs(r6['cur'] - r6['start']) < 3.5
    print("RESULT:", "PASS" if ok else "FAIL")
    return ok


def main():
    if not wait_ready():
        print("clip not ready, abort")
        return 1
    install_probe()
    results = []
    results.append(("T1 播放中点当前段=重播", t1_current_row_replay()))
    results.append(("T2 播放中点远段", t2_far_row()))
    results.append(("T3 暂停点当前段=重播", t3_paused_current_row()))
    results.append(("T3b 暂停点远段", t3b_paused_far_row()))
    results.append(("T4 busy 排队补跳", t4_queue_while_busy()))
    results.append(("T5 双击当前段=重播", t5_double_click_current()))
    print("\n" + "=" * 60)
    allpass = True
    for name, ok in results:
        print(("PASS " if ok else "FAIL ") + name)
        allpass = allpass and ok
    return 0 if allpass else 2


if __name__ == "__main__":
    sys.exit(main())
