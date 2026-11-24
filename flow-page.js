/* ============================================================
 * flow-page.js — 「运行流程 / LIVE RUN」页面控制器
 *
 * 布局（对齐参考站点与需求文档）：
 *   左：场景选择 + 七阶段流程控制器（stepper）
 *   中：flow-scene 硬件场景 + 底部控制台（播放 / 时间轴 / 指标 / 字幕）
 *   右：对象详情 + 「发生了什么」（动作/对象/原因/结果）+ 路径图例
 * ============================================================ */
window.__RENDER_FLOW__ = (function () {
  'use strict';

  var F = window.FLOW, S = window.__SIM__, STATE = S.STATE;
  var scene = window.FLOW_SCENE;
  var mounted = false, timer = null, ui = {}, logs = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function st() {
    if (!STATE.flow) STATE.flow = { scenario: 'S1', stage: 0, playing: false, view: '3d' };
    if (!STATE.flow.view) STATE.flow.view = '3d';
    return STATE.flow;
  }
  function sc() { return F.pick(st().scenario); }
  function stage() { return F.STAGES[Math.min(st().stage, F.STAGES.length - 1)]; }

  /* ───────── DOM ───────── */
  function ensureDom() {
    if (mounted) return;
    var hostEl = $('stage');
    ui.host = document.createElement('div');
    ui.host.id = 'flow-host';
    hostEl.appendChild(ui.host);

    ui.deck = document.createElement('div');
    ui.deck.id = 'flow-deck';
    hostEl.appendChild(ui.deck);

    scene.mount(ui.host, { onSelect: onPick });
    mounted = true;
  }

  function onPick(id) {
    var parts = String(id).split('-');
    scene.select(id);
    if (id === 'CTRL') { S.toast('Deployment Controller · 控制平面（仅元数据）'); }
    else if (id === 'FABRIC') { S.toast('Leaf-Spine 交换网 · 400G RoCE v2 · ECMP'); }
    else if (/^R\d-(MHD|\d)/.test(id)) {
      var rk = parts[0], nd = parts.slice(1).join('-');
      S.toast(rk + ' · ' + (/^MHD/.test(nd) ? '共享 CXL 内存设备 ' + nd : '节点 ' + nd));
      if (/^MHD/.test(nd)) STATE.selMhd = rk + '/' + nd; else STATE.selNode = rk + '/' + nd;
    } else if (/^R\d$/.test(id)) {
      STATE.selectedRack = id;
      S.toast('选中机架 ' + id);
    }
    renderRight();
  }

  /* ───────── 左栏：场景 + 七阶段 ───────── */
  function renderLeft() {
    var s = st(), cur = stage();
    var h = '';

    h += '<div class="fl-sec"><div class="fl-sec-h"><span>实验场景</span><i>SCENARIO</i></div>';
    F.SCENARIOS.forEach(function (sn) {
      h += '<button type="button" class="fl-scn' + (sn.id === s.scenario ? ' is-on' : '') + '" data-scn="' + sn.id + '">' +
        '<span class="fl-scn-k">' + sn.id + '</span>' +
        '<span class="fl-scn-t"><b>' + sn.zh + '</b><em>' + esc(sn.brief) + '</em></span>' +
        '<span class="fl-scn-en">' + sn.en + '</span></button>';
    });
    h += '</div>';

    h += '<div class="fl-sec fl-sec--flow"><div class="fl-sec-h"><span>生命周期流程</span><i>7 STAGES</i></div>' +
      '<div class="fl-steps">';
    F.STAGES.forEach(function (sg, i) {
      var cls = i < s.stage ? 'is-done' : i === s.stage ? 'is-cur' : '';
      h += '<button type="button" class="fl-step ' + cls + '" data-step="' + i + '">' +
        '<span class="fl-step-n">' + sg.n + '</span>' +
        '<span class="fl-step-c"><b>' + sg.zh + '</b><em>' + sg.en + '</em></span>' +
        '<span class="fl-step-d"></span></button>';
      if (i < F.STAGES.length - 1) h += '<span class="fl-step-line"></span>';
    });
    h += '</div></div>';

    /* 底部：本轮进度 */
    var pct = Math.round(((s.stage + 1) / F.STAGES.length) * 100);
    h += '<div class="fl-prog"><div class="fl-prog-h"><span>本轮进度</span><b>' +
      cur.n + ' / 07</b></div><div class="fl-prog-bar"><i style="width:' + pct + '%"></i></div></div>';

    $('left-body').innerHTML = h;
    $('left-kicker').textContent = 'LIVE RUN / ' + s.scenario;
    $('left-title').textContent = '运行流程';
    $('left-subtitle').textContent = '同一套硬件 · 七个阶段 · 数据在哪、为什么这样放';
    $('left-foot').innerHTML = '<span class="chip">LIVE · 演示</span><span>' + sc().kv + ' · ' + cur.zh + '</span>';

    $('left-body').querySelectorAll('[data-scn]').forEach(function (b) {
      b.addEventListener('click', function () { setScenario(b.getAttribute('data-scn')); });
    });
    $('left-body').querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () { pause(); go(+b.getAttribute('data-step')); });
    });
  }

  /* ───────── 右栏：对象详情 + 发生了什么 ───────── */
  function renderRight() {
    var s = sc(), sg = stage();
    var h = '';

    h += '<div class="fl-card"><div class="fl-card-h"><i class="fl-bar"></i><span>对象详情</span><b>' + esc(s.kv) + '</b></div>' +
      '<dl class="fl-spec">' +
      spec('生产节点', s.prod) +
      spec('数据层', s.tier) +
      spec('当前位置', s.dst) +
      spec('副本', s.replica) +
      spec('目录版本', s.ver) +
      spec('访问延迟', s.delay) +
      '</dl>' +
      '<div class="fl-meter"><span>热度</span><div class="fl-meter-bar"><i style="width:' + s.hot + '%"></i></div><b>' + s.hot + '</b></div>' +
      '<div class="fl-meter"><span>本地访问</span><div class="fl-meter-bar fl-meter-bar--cxl"><i style="width:' + s.local + '%"></i></div><b>' + s.local + '%</b></div>' +
      '</div>';

    h += '<div class="fl-card fl-card--what"><div class="fl-card-h"><i class="fl-bar"></i><span>发生了什么</span><b>' + sg.n + '</b></div>' +
      what('动作', F.fill(sg.act, s), 'act') +
      what('对象', F.fill(sg.obj, s), 'obj') +
      what('原因', F.fill(sg.why, s), 'why') +
      what('结果', F.fill(sg.res, s), 'res') +
      '</div>';

    h += '<div class="fl-card"><div class="fl-card-h"><i class="fl-bar"></i><span>路径图例</span><b>ENCODING</b></div>' +
      '<div class="fl-legend">' + F.LEGEND.map(function (l) {
        return '<span class="fl-lg"><i style="background:' + l.c + '"></i>' + l.t + '</span>';
      }).join('') + '</div></div>';

    $('right-body').innerHTML = h;
    $('right-kicker').textContent = 'KV DOSSIER / ' + s.kv;
    $('right-title').textContent = '对象详情';
    $('right-subtitle').textContent = sg.zh + ' · ' + sg.en;
    $('right-foot-label').textContent = 'STAGE ' + sg.n + ' / 07';
    $('clear-sel') && ($('clear-sel').textContent = '清除选择');
  }
  function spec(k, v) { return '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>'; }
  function what(k, v, cls) {
    return '<div class="fl-what fl-what--' + cls + '"><span>' + k + '</span><p>' + esc(v) + '</p></div>';
  }

  /* ───────── 底部控制台 ───────── */
  function renderDeck(afterRender) {
    var s = st(), sg = stage(), cur = sc();
    if (!ui.deck) return;
    var h = '';
    h += '<div class="fl-deck-top">';
    h += '<div class="fl-transport">' +
      '<button type="button" class="fl-btn" data-act="reset" title="回到第一阶段">⏮</button>' +
      '<button type="button" class="fl-btn" data-act="prev" title="上一阶段">◀</button>' +
      '<button type="button" class="fl-btn fl-btn--play' + (s.playing ? ' is-playing' : '') + '" data-act="play" title="播放 / 暂停">' +
        (s.playing ? '❚❚' : '▶') + '</button>' +
      '<button type="button" class="fl-btn" data-act="next" title="下一阶段">▶</button>' +
      '<button type="button" class="fl-btn" data-act="end" title="跳到最后">⏭</button>' +
      '<button type="button" class="fl-btn fl-btn--view" data-act="view" title="切换三维 / 原理示意">' +
        (st().view === 'svg' ? '2D' : '3D') + '</button>' +
      '</div>';
    h += '<div class="fl-ticks">';
    F.STAGES.forEach(function (x, i) {
      var cls = i < s.stage ? 'is-done' : i === s.stage ? 'is-cur' : '';
      h += '<button type="button" class="fl-tick ' + cls + '" data-tick="' + i + '">' +
        '<i></i><span>' + x.n + '</span><em>' + x.zh + '</em></button>';
    });
    h += '</div>';
    h += '</div>';

    h += '<div class="fl-deck-bot">' +
      '<div class="fl-caption"><span class="fl-cap-tag">当前动画</span><p>' +
        esc(F.fill(sg.caption, cur)) + '</p></div>' +
      '<div class="fl-kpis">' +
        kpi('延迟', cur.delay) + kpi('链路', cur.load) + kpi('MHD', cur.occ) +
      '</div>' +
      '<div class="fl-log" id="fl-log">' + (logs.length ? esc(logs[logs.length - 1]) : 'READY · 等待播放') + '</div>' +
      '</div>';

    ui.deck.innerHTML = h;

    ui.deck.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-act');
        if (a === 'play') { s.playing ? pause() : play(); }
        else if (a === 'prev') { pause(); go(Math.max(0, s.stage - 1)); }
        else if (a === 'next') { pause(); go(Math.min(6, s.stage + 1)); }
        else if (a === 'reset') { pause(); go(0); }
        else if (a === 'end') { pause(); go(6); }
        else if (a === 'view') { toggleView(); }
      });
    });
    ui.deck.querySelectorAll('[data-tick]').forEach(function (b) {
      b.addEventListener('click', function () { pause(); go(+b.getAttribute('data-tick')); });
    });
  }
  function kpi(k, v) { return '<div class="fl-kpi"><span>' + k + '</span><b>' + esc(v) + '</b></div>'; }

  function pushLog(msg) {
    logs.push(msg);
    if (logs.length > 40) logs.shift();
    var l = $('fl-log');
    if (l) l.textContent = msg;
  }

  /* ───────── 舞台播放：优先三维，失败回落 SVG ───────── */
  function setMode(is3d) {
    if (ui.host) ui.host.classList.toggle('is-3d', !!is3d);
    var app = $('app');
    if (app) app.classList.toggle('flow-3d', !!is3d);
  }
  function playStage(sg, cur) {
    var want3d = st().view !== 'svg';
    var can3d = want3d && window.FLOW_3D && window.FLOW_3D.available();
    /* 先让容器可见，WebGL 容器为 display:none 时尺寸为 0，会导致画布与镜头都不对 */
    setMode(!!can3d);
    if (can3d) {
      var ok = false;
      try { ok = window.FLOW_3D.play(sg, cur); } catch (e) { ok = false; }
      if (ok) {
        requestAnimationFrame(function () {
          try { window.FLOW_3D.resize(); } catch (e) {}
        });
        return;
      }
      setMode(false);
    }
    scene.play(sg, cur);
  }
  function toggleView() {
    var s = st();
    s.view = (s.view === 'svg') ? '3d' : 'svg';
    pushLog('切换视图 → ' + (s.view === 'svg' ? '原理示意（2D）' : '三维硬件'));
    pause();
    go(s.stage);
  }

  /* ───────── 阶段切换 ───────── */
  function go(i) {
    var s = st();
    s.stage = Math.max(0, Math.min(F.STAGES.length - 1, i));
    var sg = stage(), cur = sc();
    playStage(sg, cur);
    if (sg.id === 'access') scene.select('R1');
    pushLog(sg.n + ' ' + sg.zh + ' · ' + F.fill(sg.caption, cur).slice(0, 46) + '…');
    if (window.__SIM__ && S.log) { try { S.log('[FLOW ' + sg.n + '] ' + sg.zh); } catch (e) {} }
    renderLeft(); renderRight(); renderDeck();
    if (s.playing) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (!st().playing) return;
        if (st().stage >= F.STAGES.length - 1) { pause(); pushLog('本轮演示完成 · 可切换场景重放'); renderDeck(); return; }
        go(st().stage + 1);
      }, 4600);
    }
  }
  function play() {
    var s = st();
    s.playing = true;
    if (s.stage >= F.STAGES.length - 1) s.stage = 0;
    renderDeck();
    go(s.stage);
  }
  function pause() {
    st().playing = false;
    clearTimeout(timer); timer = null;
    if (ui.deck) renderDeck();
  }
  function setScenario(id) {
    var s = st();
    s.scenario = id; s.stage = 0;
    pause();
    pushLog('切换场景 → ' + F.pick(id).zh);
    if (S.loadScenario) { try { S.loadScenario(id, true); } catch (e) {} }
    renderLeft(); go(0);
  }

  /* ───────── 接缝 ───────── */
  var urlDone = false;
  function initFromUrl() {
    if (urlDone) return;
    urlDone = true;
    try {
      var p = new URLSearchParams(location.search);
      var v = p.get('stage');
      if (!v) return;
      var idx = -1;
      for (var i = 0; i < F.STAGES.length; i++) if (F.STAGES[i].id === v) idx = i;
      if (idx < 0 && /^\d+$/.test(v)) idx = Math.max(0, Math.min(6, parseInt(v, 10) - 1));
      if (idx >= 0) st().stage = idx;
      var sid = p.get('flowsc');
      if (sid) st().scenario = sid;
      var vw = p.get('view');
      if (vw === 'svg' || vw === '2d') st().view = 'svg';
      else if (vw === '3d') st().view = '3d';
      if (p.get('play') === '1') st().playing = true;
    } catch (e) {}
  }

  function renderAll() {
    ensureDom();
    initFromUrl();
    renderLeft(); renderRight(); renderDeck();
    playStage(stage(), sc());
    if (st().playing) play();
  }
  function onEnter() {
    ensureDom();
    playStage(stage(), sc());
    if (window.FLOW_3D) { try { window.FLOW_3D.resize(); } catch (e) {} }
    renderDeck();
  }
  function sync() { if (ui.host) ui.host.classList.toggle('is-live', st().playing); }

  return { renderAll: renderAll, onEnter: onEnter, sync: sync, go: go, play: play, pause: pause,
           setScenario: setScenario };
})();
