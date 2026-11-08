(function () {
  return JSON.stringify({
    log: (window.__jlog || []).slice(-30),
    idx: activeClip() ? activeClip().idx : null,
    playing: activeClip() ? activeClip().playing : null,
    curT: activeClip() ? +activeClip().decks[activeClip().activeDeck].v.currentTime.toFixed(1) : null,
    activeDeck: activeClip() ? activeClip().activeDeck : null,
    bakSeg: activeClip() ? activeClip().decks[1 - activeClip().activeDeck].seg : null,
    bakT: activeClip() ? +activeClip().decks[1 - activeClip().activeDeck].v.currentTime.toFixed(1) : null
  });
})()
