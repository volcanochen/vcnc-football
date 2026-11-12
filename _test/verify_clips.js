/* 自定义集锦真机 CDP 专项：DOM 挂载 / 契约 / 编解码 / 混排配色 / 面板开合。
   不写 B 站评论区（避免真发评论）；只在本地临时加一个片段再删掉，跑完恢复现场。 */
(function () {
  function q(s) { return document.querySelector(s); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var out = { steps: {} };
  var C = window.VCNCClips, V = window.VCNC;
  var st = V && V.getState ? V.getState() : {};
  var bvid = st.bvid || '';

  out.state = { bvid: bvid, aid: st.aid || '', ready: !!st.ready, page: document.body.getAttribute('data-page') };
  out.hasModule = !!C;
  out.buttons = {
    make: !!q('#sfMake'), cloud: !!q('#sfCloud'), import: !!q('#sfImport'),
    tools: !!q('.sf-tools'), studio: !!q('#clipsStudio')
  };
  out.api = C ? ['forVideo', 'localList', 'addLocal', 'delLocal', 'encodeShare', 'decodeShare',
                 'packComment', 'parseComment', 'parseGroups', 'loadCloud', 'openStudio']
                 .filter(function (k) { return typeof C[k] !== 'function'; }) : ['(module missing)'];

  if (!C || !V) { out.pass = false; out.error = 'VCNCClips / VCNC 契约缺失'; return out; }

  // 编解码在真机 WebView 里跑一遍（btoa/atob 的 UTF-8  Handling 与 Node 不同）
  var code = C.encodeShare(bvid || 'BV1p5xd6hEK2', [{ s: 242, d: 17, u: '验收', n: '进球' }]);
  var dec = C.decodeShare(code);
  out.steps.codec = { code: code.slice(0, 16) + '…', ok: !!(dec && dec.clips[0].n === '进球') };
  var msg = C.packComment(bvid || 'BV1p5xd6hEK2', '验收', [{ s: 242, d: 17, u: '验收', n: '进球' }])[0];
  out.steps.comment = { head: msg.slice(0, 24), ok: !!C.parseComment(msg, bvid || 'BV1p5xd6hEK2') };

  // 本地临时片段 → 混排 → 配色 class → 删除还原
  var before = C.localList(bvid).length;
  // 起点要落在视频时长内，否则 buildSegs 会按「越界片段」跳过
  var testClip = { s: 123, d: 7, u: '验收', n: '__CDP_TMP__', t: 1 };
  C.addLocal(bvid, testClip);
  var merged = C.forVideo(bvid);
  out.steps.merged = {
    total: merged.length,
    mine: merged.filter(function (x) { return x.src === 'mine'; }).length,
    hasTest: merged.some(function (x) { return x.text === '__CDP_TMP__'; })
  };

  return Promise.resolve()
    .then(function () {
      if (V.rebuildClips) V.rebuildClips();
      return wait(500);
    })
    .then(function () {
      var rows = document.querySelectorAll('#sfBody .sf-row');
      out.steps.rows = { total: rows.length, mine: document.querySelectorAll('#sfBody .sf-row.src-mine').length };
      // 面板开合
      C.openStudio('make');
      var s = q('#clipsStudio');
      out.steps.studio = { opened: !!(s && !s.hidden), hasSave: !!q('#csSave'), hasPublish: !!q('#csPublish') };
      if (s) s.hidden = true;
      return wait(50);
    })
    .then(function () {
      // 还原：删掉临时片段并重建，避免污染后续用例
      var list = C.localList(bvid);
      for (var i = 0; i < list.length; i++)
        if (list[i].n === '__CDP_TMP__') C.delLocal(bvid, list[i].id);
      if (V.rebuildClips) V.rebuildClips();
      return wait(300);
    })
    .then(function () {
      out.steps.restored = C.localList(bvid).length === before;
      var v = out.verdict = {
        module: out.hasModule,
        apiComplete: out.api.length === 0,
        buttons: out.buttons.make && out.buttons.cloud && out.buttons.import && out.buttons.tools && out.buttons.studio,
        codec: out.steps.codec.ok,
        comment: out.steps.comment.ok,
        merged: out.steps.merged.mine > 0 && out.steps.merged.hasTest,
        colorClass: out.steps.rows.mine > 0,
        studio: out.steps.studio.opened && out.steps.studio.hasSave && out.steps.studio.hasPublish,
        restored: out.steps.restored
      };
      out.pass = Object.keys(v).every(function (k) { return v[k] === true; });
      return out;
    });
})()
