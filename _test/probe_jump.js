(function () {
  var c = activeClip();
  if (!c) return 'noclip';
  if (!window.__jprobe) {
    window.__jprobe = true;
    window.__jlog = [];
    var oj = c.jumpTo.bind(c);
    c.jumpTo = function (i, opts) {
      var bak = this.decks[1 - this.activeDeck];
      window.__jlog.push({
        t: Date.now() % 100000, ev: 'jumpTo', i: i, busy: !!this.busy,
        idx: this.idx, user: !!(opts && opts.user), off: opts && opts.seekOffset,
        bakSeg: bak.seg, bakT: +bak.v.currentTime.toFixed(1),
        bakRolling: !!bak.rolling, playing: !!this.playing
      });
      return oj(i, opts);
    };
    var oe = c.onSegmentEnd.bind(c);
    c.onSegmentEnd = function () {
      window.__jlog.push({ t: Date.now() % 100000, ev: 'segEnd', idx: this.idx, busy: !!this.busy });
      return oe();
    };
    var osd = c.showDeck.bind(c);
    c.showDeck = function (k, hard) {
      var d = this.decks[k];
      window.__jlog.push({
        t: Date.now() % 100000, ev: 'showDeck', k: k, seg: d.seg,
        t: +d.v.currentTime.toFixed(1), hard: !!hard
      });
      return osd(k, hard);
    };
  } else { window.__jlog.length = 0; }
  var rows = document.querySelectorAll('#sfBody .sf-row');
  var r0 = rows.length ? rows[0].getBoundingClientRect() : null;
  return JSON.stringify({
    probe: 'ok', idx: c.idx, segs: c.segs.length, playing: c.playing,
    zoomOn: SETTINGS.zoomOn, mode: SETTINGS.mode, busy: !!c.busy,
    dprScale: (window.devicePixelRatio || 1),
    iw: innerWidth, ih: innerHeight,
    rows: rows.length, row0: r0 ? [Math.round(r0.left), Math.round(r0.top), Math.round(r0.width), Math.round(r0.height)] : null
  });
})()
