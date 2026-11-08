# -*- coding: utf-8 -*-
"""S22U 真机验证：隐藏态点击不透传 + 点当前段重播不跳段（2026-11-09 修复）"""
import sys, os, json, subprocess, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repro_jump import ev, read_log, clear_log  # noqa

SERIAL = 'R5CT90R761Y'


def tap(css_x, css_y):
    subprocess.run(['adb', '-s', SERIAL, 'shell', 'input', 'tap',
                    str(int(css_x * 1.8)), str(int(css_y * 1.8))], timeout=15)


def st():
    o = ev("(function(){var c=activeClip();if(!c)return '{}';var d=c.decks[c.activeDeck],s=c.segs[c.idx];"
           "return JSON.stringify({idx:c.idx,playing:c.playing,ct:+d.v.currentTime.toFixed(1),"
           "start:s?s.start:null,end:s?+(s.start+s.dur).toFixed(1):null,rate:d.v.playbackRate,"
           "dir:rev.dir,zoomOn:SETTINGS.zoomOn,chromeOff:document.body.classList.contains('chrome-off')});})()")
    return json.loads(o)


def click_row(i):
    return ev("(function(){var rows=document.querySelectorAll('#sfBody .sf-row');"
              "for(var k=0;k<rows.length;k++){if(+rows[k].getAttribute('data-i')===%d){"
              "rows[k].scrollIntoView({block:'center'});"
              "setTimeout(function(){var rs=document.querySelectorAll('#sfBody .sf-row');"
              "for(var m=0;m<rs.length;m++){if(+rs[m].getAttribute('data-i')===%d){"
              "rs[m].dispatchEvent(new MouseEvent('click',{bubbles:true}));}}},80);"
              "return 'clicked %d';}}return 'norow';})()" % (i, i, i))


def hide():
    ev("(function(){document.body.classList.add('chrome-off');window._evlog=[];return 1;})()")
    time.sleep(0.35)


print("=== H 系列：隐藏态真实点击不透传 ===")
s0 = st()
print("before:", s0)
ev("(function(){var c=activeClip(); c.jumpTo(20,{}); return 1;})()")
time.sleep(6)
ev("(function(){var c=activeClip(); if(!c.playing) c.resumePlay(); return 1;})()")
time.sleep(1.0)
s0 = st()
print("before:", s0)

ev("showChrome();1")
time.sleep(0.5)
ev("(function(){window._evlog=[];return 1;})()")
rects = json.loads(ev("""(function(){
  function r(sel){var el=document.querySelector(sel); if(!el) return null; var b=el.getBoundingClientRect();
    return [Math.round((b.left+b.right)/2), Math.round((b.top+b.bottom)/2)];}
  var rows=[];
  document.querySelectorAll('#sfBody .sf-row').forEach(function(el){var b=el.getBoundingClientRect();
    if(b.top>=50&&b.bottom<=290) rows.push({i:+el.getAttribute('data-i'), c:[Math.round((b.left+b.right)/2), Math.round((b.top+b.bottom)/2)]});});
  return JSON.stringify({btnRev:r('#btnRev'), btnTrack:r('#btnTrack'), slow:r('#cornerCtl .slow'),
    pageNav:r('#pageNav .set'), row2:(rows[2]||{}).c, row2i:(rows[2]||{}).i});
})()"""))
print("rects:", rects)

hides = [('btnRev位置', rects['btnRev']), ('btnTrack位置', rects['btnTrack']),
         ('slow位置', rects['slow']), ('pageNav设置位置', rects['pageNav'])]
if rects.get('row2'):
    hides.append(('segFloat行(idx=%s)位置' % rects['row2i'], rects['row2']))

ok_all = True
for name, pos in hides:
    if not pos:
        continue
    hide()
    tap(pos[0], pos[1])
    time.sleep(1.3)
    s1 = st()
    ev("(function(){var l=window._evlog||[];window._evlog=[];return 1;})()")
    # 期望：只 toggle 播放态 + chrome 唤回；dir/zoomOn/rate/idx 全不变
    changed = []
    if s1['dir'] != s0['dir']:
        changed.append('dir!')
    if s1['zoomOn'] != s0['zoomOn']:
        changed.append('zoomOn!')
    if abs(s1['rate'] - s0['rate']) > 0.01:
        changed.append('rate!')
    if s1['idx'] != s0['idx']:
        changed.append('idx!')
    ok = not changed
    ok_all = ok_all and ok
    print("  tap %-24s -> %s  chromeOff=%s  %s" % (
        name, 'playing' if s1['playing'] else 'paused', s1['chromeOff'],
        "PASS" if ok else "FAIL " + ','.join(changed)))

print("=== H 结果:", "ALL PASS" if ok_all else "有 FAIL", "===")

print("=== R1：段尾点当前段行重播（logcat 实证的真凶场景） ===")
s = st()
i = s['idx']
# 把当前段播到接近段尾
ev("(function(){var c=activeClip();var d=c.decks[c.activeDeck],s=c.segs[c.idx];"
   "try{d.v.currentTime=s.start+s.dur-0.8; if(c.hasAudio)d.a.currentTime=s.start+s.dur-0.8;}catch(e){}"
   "if(!c.playing)c.resumePlay(); return 1;})()")
time.sleep(1.0)
s1 = st()
print("seek to near end:", s1)
clear_log()
r = click_row(i)
print("click current row ->", r)
time.sleep(1.0)
s2 = st()
print("just after:", s2)
r1 = abs(s2['ct'] - s2['start']) < 3 and s2['idx'] == i
print("RESULT R1a(回段头):", "PASS" if r1 else "FAIL")
time.sleep(4)
s3 = st()
r2 = s3['idx'] == i and abs(s3['ct'] - s3['start']) < 8
print("after 4s: idx=%s ct=%.1f (start=%.1f)" % (s3['idx'], s3['ct'], s3['start']))
print("RESULT R1b(未跳段):", "PASS" if r2 else "FAIL")
for e in read_log(10):
    print("   diag:", e)

print("=== R2：段中点当前段行重播 ===")
ev("(function(){var c=activeClip();if(!c.playing)c.resumePlay();return 1;})()")
time.sleep(1.5)
clear_log()
r = click_row(i)
print("click current row ->", r)
time.sleep(1.0)
s4 = st()
print("after:", s4)
print("RESULT R2:", "PASS" if (s4['idx'] == i and abs(s4['ct'] - s4['start']) < 3) else "FAIL")

print("=== R3：点非当前段 ===")
i2 = (s4['idx'] + 5) % 49
clear_log()
r = click_row(i2)
print("click row %d ->" % i2, r)
time.sleep(8)
s5 = st()
print("after:", s5)
print("RESULT R3:", "PASS" if s5['idx'] == i2 else "FAIL")
