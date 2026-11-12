/* 自定义集锦真机 CDP 专项：DOM 挂载 / 契约 / 编解码 / 混排配色 / 「自定义」筛选 /
   制作面板精简 / 2s 自动隐藏 / 与播放画面同层。不写 B 站评论区；只在本机临时加一个
   片段再删掉，跑完恢复现场。 */
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
    make: !!q('#sfMake'), mine: !!q('#sfMine'),
    cloudRemoved: !q('#sfCloud'), importRemoved: !q('#sfImport'),
    tools: !!q('.sf-tools'), studio: !!q('#clipsStudio')
  };
  out.api = C ? ['forVideo', 'mineOnlyState', 'setMineOnly', 'localList', 'addLocal',
                 'delLocal', 'encodeShare', 'decodeShare', 'packComment', 'parseComment',
                 'parseGroups', 'loadCloud', 'openStudio']
                 .filter(function (k) { return typeof C[k] !== 'function'; }) : ['(module missing)'];

  if (!C || !V) { out.pass = false; out.error = 'VCNCClips / VCNC 契约缺失'; return out; }

  out.steps.idleMs = window.CHROME_IDLE_MS;
  var mineBefore = C.mineOnlyState();

  // 编解码在真机 WebView 里跑一遍（btoa/atob 的 UTF-8 处理与 Node 不同）
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
      // 文字颜色：自定义行的备注应与默认（官方）行明显不同
      var mn = q('#sfBody .sf-row.src-mine .sf-note');
      var dn = q('#sfBody .sf-row:not(.src-mine):not(.src-cloud):not(.src-other) .sf-note');
      out.steps.color = {
        mine: mn ? getComputedStyle(mn).color : '',
        def: dn ? getComputedStyle(dn).color : ''
      };
      // 制作面板：去掉 ①②③④ 编号 / 步骤文字 / 导入集锦按钮，只留 5 个控件
      C.openStudio('make');
      var s = q('#clipsStudio');
      var heads = '';
      if (s) {
        var hs = s.querySelectorAll('.cs-h');
        for (var i = 0; i < hs.length; i++) heads += hs[i].textContent + '|';
      }
      out.steps.studio = {
        opened: !!(s && !s.hidden),
        hasStart: !!q('#csStart'), hasEnd: !!q('#csEnd'),
        hasChips: !!q('#csChips'), hasNote: !!q('#clipNote'), hasSave: !!q('#csSave'),
        noNumberedHeads: !/[①②③④]/.test(heads),
        noStateText: !q('#csState'),
        noImportButton: !q('#csImport'),
        noImportTextarea: !q('#clipImportInput'),
        noNickInput: !q('#clipNick'), noClearButton: !q('#csClear'),
        hasPublish: !!q('#csPublish')
      };
      if (s) s.hidden = true;
      return wait(50);
    })
    .then(function () {
      // 「自定义」筛选：只看自己创建的片段，索引不变，再点恢复全部
      var totalBefore = document.querySelectorAll('#sfBody .sf-row').length;
      C.setMineOnly(true);
      return wait(150).then(function () {
        var rows = document.querySelectorAll('#sfBody .sf-row');
        var allMine = rows.length > 0;
        for (var i = 0; i < rows.length; i++)
          if (!rows[i].classList.contains('src-mine')) allMine = false;
        out.steps.filter = {
          on: C.mineOnlyState() === true,
          btnOn: !!(q('#sfMine') && q('#sfMine').classList.contains('on')),
          totalBefore: totalBefore, shown: rows.length, allMine: allMine,
          count: (q('#sfCount') || {}).textContent || ''
        };
        C.setMineOnly(false);
        return wait(150);
      }).then(function () {
        out.steps.filterBack = {
          off: C.mineOnlyState() === false,
          rows: document.querySelectorAll('#sfBody .sf-row').length
        };
        C.setMineOnly(mineBefore);   // 恢复用例开始前的全局状态
      });
    })
    .then(function () {
      // 与播放画面同层：切到比赛列表 / 设置页、或登录弹层打开时，面板必须整体退场
      var s = q('#clipsStudio');
      if (!s) { out.steps.layer = { skipped: true }; return; }
      function vis(el) {
        var cs = getComputedStyle(el);
        return { op: Math.round(parseFloat(cs.opacity) * 100) / 100, pe: cs.pointerEvents };
      }
      if (typeof window.showChrome === 'function') window.showChrome();
      C.openStudio('make');
      out.steps.layer = { onPlay: vis(s) };
      return wait(350)
        .then(function () {
          if (typeof window.goPage === 'function') window.goPage(0);
          return wait(400);
        })
        .then(function () {
          out.steps.layer.onList = vis(s);
          if (typeof window.goPage === 'function') window.goPage(1);
          // 登录弹层真实打开会触发 B 站授权轮询，这里只注入 social.js 同步的 class
          document.body.classList.add('soc-modal-open');
          return wait(400);
        })
        .then(function () {
          out.steps.layer.onModal = vis(s);
          document.body.classList.remove('soc-modal-open');
          s.hidden = true;
          return wait(350);
        });
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
      var sd = out.steps.studio, f = out.steps.filter, fb = out.steps.filterBack;
      var v = out.verdict = {
        module: out.hasModule,
        apiComplete: out.api.length === 0,
        buttons: out.buttons.make && out.buttons.mine && out.buttons.cloudRemoved &&
                 out.buttons.importRemoved && out.buttons.tools && out.buttons.studio,
        codec: out.steps.codec.ok,
        comment: out.steps.comment.ok,
        merged: out.steps.merged.mine > 0 && out.steps.merged.hasTest,
        colorClass: out.steps.rows.mine > 0,
        colorDiff: !!out.steps.color.mine && out.steps.color.mine !== out.steps.color.def,
        studio: sd.opened && sd.hasStart && sd.hasEnd && sd.hasChips && sd.hasNote &&
                sd.hasSave && sd.noNumberedHeads && sd.noStateText && sd.noImportButton &&
                sd.noImportTextarea && sd.noNickInput && sd.noClearButton && sd.hasPublish,
        filter: f.on && f.btnOn && f.allMine && f.shown > 0 && f.shown <= f.totalBefore,
        filterBack: fb.off && fb.rows === out.steps.filter.totalBefore,
        idle2s: out.steps.idleMs === 2000,
        layer: !out.steps.layer.skipped &&
               out.steps.layer.onPlay.op === 1 && out.steps.layer.onPlay.pe !== 'none' &&
               out.steps.layer.onList.op === 0 && out.steps.layer.onList.pe === 'none' &&
               out.steps.layer.onModal.op === 0 && out.steps.layer.onModal.pe === 'none',
        restored: out.steps.restored
      };
      out.pass = Object.keys(v).every(function (k) { return v[k] === true; });
      return out;
    });
})()
