/* ============================================================
 * renderer-lifecycle.js — 「KV 生命周期」页面控制器
 *
 * 布局（需求文档 image3）：
 *   舞台顶部浮条 = 六阶段流程导航 + 镜头预设
 *   左侧面板    = 场景选择 S1–S5 · Prompt · KV 列表 · 热度 · 访问来源 · 生产机架
 *   中央        = #gllc 三维集群（webgl-cluster.js）
 *   右侧面板    = KV 详情（Block ID / 当前位置 / 目标 / 副本 / 版本 / 热度）
 *                 + Directory 记录 + Controller 组件状态 + 路径图例
 *   底部浮条    = 播放/暂停/单步 · 时间轴 · 阶段名
 *   全局 console 保留 KPI 与事件日志（S1–S6 场景按钮用 CSS 隐藏）
 * ============================================================ */
(function () {
  'use strict';
  var S = window.__SIM__, D = window.DATA, LC = window.LC;
  var STATE = S.STATE;

  var mounted = false, gl = null, timer = null;
  var ui = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* 页面状态 */
  function st() {
    if (!STATE.lc) STATE.lc = { scene: 'S1', step: 0, playing: false };
    return STATE.lc;
  }
  function scene() {
    var s = st();
    for (var i = 0; i < LC.SCENES.length; i++) if (LC.SCENES[i].id === s.scene) return LC.SCENES[i];
    return LC.SCENES[0];
  }
  function curStep() { var sc = scene(); return sc.steps[Math.min(st().step, sc.steps.length - 1)]; }

  /* ── DOM 构建 ── */
  function ensureDom() {
    if (ui.top) return;
    var stage = $('stage');

    /* 复用既有 #gllc（02 集群总览的 3D 切换可能已创建并挂载），避免重复 id 双场景 */
    ui.host = document.getElementById('gllc');
    if (!ui.host) {
      ui.host = document.createElement('div');
      ui.host.id = 'gllc';
      stage.appendChild(ui.host);
    }

    ui.bar = document.createElement('div');
    ui.bar.id = 'lc-bar';
    stage.appendChild(ui.bar);

    gl = window.__GLCLUSTER__;
    if (gl && gl.available && !mounted && !window.__CLUSTER3D_MOUNTED__) {
      gl.mount(ui.host, { onSelect: onPick });
      window.__CLUSTER3D_MOUNTED__ = true;
      mounted = true;
    }
  }

  function onPick(id) {
    if (!id) return;
    if (/^R\d$/.test(id)) {
      STATE.selectedRack = id;
      S.toast('选中 ' + id + ' · ' + (LC && (id === 'R1' || id === 'R3') ? 'CXL + RDMA' : 'RDMA-only'));
    } else {
      S.toast('选中 ' + (id === 'CTRL' ? 'Deployment Controller' : 'RDMA 内存池'));
    }
    renderRight();
  }

  /* ── 顶部：六阶段导航 + 镜头 ── */
  function renderTop() {
    var step = curStep();
    var h = '<div class="lc-stages">';
    LC.STAGES.forEach(function (sg, i) {
      var cur = SG_IDX(step.stage) === i;
      h += '<span class="lc-stage' + (cur ? ' on' : '') + '">' + (i + 1) + ' ' + sg.zh + '</span>';
      if (i < LC.STAGES.length - 1) h += '<i>→</i>';
    });
    h += '</div><div class="lc-cams">';
    [['all', '全景'], ['R1', 'R1'], ['R2', 'R2'], ['R3', 'R3'], ['R4', 'R4'], ['ctrl', '控制器'], ['pool', '内存池']]
      .forEach(function (c) {
        h += '<button type="button" class="mini-btn" data-cam="' + c[0] + '">' + c[1] + '</button>';
      });
    h += '</div>';
    ui.top.innerHTML = h;
    ui.top.querySelectorAll('[data-cam]').forEach(function (b) {
      b.addEventListener('click', function () { if (gl) gl.flyTo(b.dataset.cam); });
    });
  }
  function SG_IDX(id) {
    for (var i = 0; i < LC.STAGES.length; i++) if (LC.STAGES[i].id === id) return i;
    return -1;
  }

  /* ── 左侧：场景 + 业务信息 ── */
  function renderLeft() {
    var s = st(), sc = scene(), step = curStep();
    var h = '<div class="lc-sec"><div class="lc-h">实验场景</div>';
    LC.SCENES.forEach(function (sn) {
      h += '<button type="button" class="lc-scene' + (sn.id === s.scene ? ' on' : '') + '" data-lcsc="' + sn.id + '">' +
        '<b>' + sn.id + ' ' + sn.zh + '</b><span>' + esc(sn.brief) + '</span></button>';
    });
    h += '</div>';

    h += '<div class="lc-sec"><div class="lc-h">业务信息</div>' +
      '<div class="lc-kv"><i>Prompt</i><span>多轮会话 · Decode 读取共享 KV</span></div>' +
      '<div class="lc-kv"><i>KV Block</i><span class="mono">' + sc.kv + '</span></div>' +
      '<div class="lc-kv"><i>热度</i><span class="mono">' + esc(step.dir.hot) + '</span></div>' +
      '<div class="lc-kv"><i>生产机架</i><span>' + esc(step.dir.prod) + '</span></div>' +
      '<div class="lc-kv"><i>当前阶段</i><span class="lc-cur">' +
      LC.STAGES[SG_IDX(step.stage)].zh + ' · 步骤 ' + (s.step + 1) + '/' + sc.steps.length + '</span></div>' +
      '</div>';

    h += '<div class="lc-sec"><div class="lc-h">当前事件</div>' +
      '<ul class="lc-ev">' + step.ev.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' +
      (step.note ? '<p class="lc-note">' + esc(step.note) + '</p>' : '') + '</div>';

    $('left-body').innerHTML = h;
    $('left-kicker').textContent = 'KV LIFECYCLE / ' + s.scene;
    $('left-title').textContent = sc.zh;
    $('left-subtitle').textContent = sc.brief;
    $('left-body').querySelectorAll('[data-lcsc]').forEach(function (b) {
      b.addEventListener('click', function () { goScene(b.dataset.lcsc); });
    });
  }

  /* ── 右侧：KV 详情 + Directory + Controller + 图例 ── */
  function renderRight() {
    var step = curStep(), d = step.dir;
    var h = '<div class="dz-sec"><div class="dz-sec__h"><i class="bar"></i><span class="micro">KV 详情</span></div>' +
      '<dl class="spec">' +
      '<dt>Block ID</dt><dd class="mono">' + esc(d.kv) + '</dd>' +
      '<dt>当前位置</dt><dd>' + esc(d.loc) + '</dd>' +
      '<dt>生产</dt><dd>' + esc(d.prod) + '</dd>' +
      '<dt>存储层</dt><dd>' + esc(d.tier) + '</dd>' +
      '<dt>副本</dt><dd>' + esc(d.rep) + '</dd>' +
      '<dt>版本</dt><dd class="mono">' + esc(d.ver) + '</dd>' +
      '<dt>热度</dt><dd class="mono">' + esc(d.hot) + '</dd>' +
      '<dt>最近访问</dt><dd class="mono">' + esc(d.last) + '</dd>' +
      '</dl></div>';

    h += '<div class="dz-sec"><div class="dz-sec__h"><i class="bar"></i><span class="micro">Controller</span></div>' +
      '<div class="lc-ctrl">' +
      ['Placement Controller', 'Workload Profiler', 'Topology Monitor', 'KV Directory'].map(function (c) {
        var on = step.act && (step.act.ctrlPulse || step.stage === 'decide' || step.stage === 'query');
        return '<span class="lc-chip' + (on ? ' on' : '') + '">' + c + '</span>';
      }).join('') + '</div>' +
      (step.stage === 'collect' ? '<p class="lc-note">五类来源（GPU Runtime · Host Agent · RNIC · Leaf/Spine · MHD）分别上报，Controller 汇总。</p>' : '') +
      '</div>';

    h += '<div class="dz-sec"><div class="dz-sec__h"><i class="bar"></i><span class="micro">路径图例</span></div>' +
      legendRow(LC.PATH.cxl, '本地 CXL 访问') +
      legendRow(LC.PATH.rdma, 'RDMA 跨机架') +
      legendRow(LC.PATH.move, 'KV 迁移') +
      legendRow(LC.PATH.copy, 'KV 复制') +
      legendRow(LC.PATH.idle, '空闲 / 绕开') +
      legendRow(LC.PATH.mon, '信息采集流') +
      '</div>';

    h += '<div class="dz-sec"><div class="dz-sec__h"><i class="bar"></i><span class="micro">采集来源</span></div>' +
      '<ul class="lc-src">' + LC.SOURCES.map(function (ss) {
        return '<li><b>' + ss.zh + '</b><span>' + ss.dim + '</span></li>';
      }).join('') + '</ul></div>';

    $('right-body').innerHTML = h;
    $('right-kicker').textContent = 'KV DOSSIER / ' + d.kv;
    $('right-title').textContent = 'KV 生命周期详情';
    $('right-subtitle').textContent = '目录记录 · 决策组件 · 路径语义';
    $('right-foot-label').textContent = 'STEP ' + (st().step + 1) + ' / ' + scene().steps.length;
  }
  function legendRow(color, txt) {
    return '<div class="legend__row"><i class="legend__sw" style="background:' + color + '"></i>' + txt + '</div>';
  }

  /* ── KPI 条（复用全局 #kpi-strip） ── */
  function renderKpi() {
    var step = curStep(), d = step.dir;
    var el = $('kpi-strip');
    if (!el) return;
    el.innerHTML =
      kpi('STAGE', LC.STAGES[SG_IDX(step.stage)].zh) +
      kpi('KV LOC', d.loc) +
      kpi('HOTNESS', d.hot) +
      kpi('REPLICA', d.rep) +
      kpi('DIR VER', d.ver);
  }
  function kpi(lb, v) {
    return '<div class="kpi-cell"><span class="kpi-label">' + lb + '</span><b class="cxl">' + esc(v) + '</b></div>';
  }

  /* ── 底部：播放 + 时间轴 + 机位（唯一控制栏） ── */
  function renderBar() {
    var s = st(), sc = scene();
    var h = '<div class="lc-transport">' +
      '<button type="button" class="tbtn" id="lc-prev" title="上一步">◀|</button>' +
      '<button type="button" class="tbtn tbtn-play" id="lc-play">' + (s.playing ? '❚❚' : '▶') + '</button>' +
      '<button type="button" class="tbtn" id="lc-next" title="下一步">|▶</button>' +
      '<button type="button" class="text-btn" id="lc-reset">重置</button>' +
      '</div>' +
      '<div class="lc-timeline"><div class="lc-track">';
    sc.steps.forEach(function (stp, i) {
      var cls = i < s.step ? 'done' : i === s.step ? 'cur' : '';
      var si = SG_IDX(stp.stage);
      /* 同一阶段可能拆成多个步骤，加序号避免出现两个一样的「推理生成」 */
      var same = sc.steps.filter(function (x) { return x.stage === stp.stage; });
      var lab = same.length > 1
        ? LC.STAGES[si].zh + ' ' + (same.indexOf(stp) + 1) + '/' + same.length
        : LC.STAGES[si].zh;
      h += '<button type="button" class="lc-tick ' + cls + '" data-i="' + i + '" title="' + esc(stp.ev[0]) + '"><i></i><span>' +
        lab + '</span></button>';
    });
    h += '</div></div>';
    h += '<div class="lc-cams">' +
      [['all', '全景'], ['R1', 'R1'], ['R2', 'R2'], ['R3', 'R3'], ['R4', 'R4'], ['ctrl', '控制器'], ['pool', '内存池']]
        .map(function (c) { return '<button type="button" class="mini-btn" data-cam="' + c[0] + '">' + c[1] + '</button>'; })
        .join('') + '</div>';
    ui.bar.innerHTML = h;

    $('lc-prev').addEventListener('click', function () { pause(); go(Math.max(0, s.step - 1)); });
    ui.bar.querySelectorAll('[data-cam]').forEach(function (b) {
      b.addEventListener('click', function () { if (gl) gl.flyTo(b.dataset.cam); });
    });
    $('lc-next').addEventListener('click', function () { pause(); go(Math.min(sc.steps.length - 1, s.step + 1)); });
    $('lc-play').addEventListener('click', function () { s.playing ? pause() : play(); });
    $('lc-reset').addEventListener('click', function () { pause(); go(0); });
    ui.bar.querySelectorAll('[data-i]').forEach(function (b) {
      b.addEventListener('click', function () { pause(); go(+b.dataset.i); });
    });
  }

  /* ── 步进控制 ── */
  function go(i) {
    var s = st(), sc = scene();
    s.step = Math.max(0, Math.min(sc.steps.length - 1, i));
    var step = curStep();
    if (gl && gl.available) gl.applyStep(step.act, null);
    if (step.cam && gl && gl.available) gl.flyTo(step.cam);
    if (step.ev) step.ev.forEach(function (e) { S.log('[' + s.scene + '·' + (s.step + 1) + '] ' + e); });
    renderAll();
  }
  function goScene(id) {
    var s = st();
    s.scene = id; s.step = 0;
    pause();
    S.log('切换生命周期场景 → ' + id);
    go(0);
  }
  function play() {
    var s = st();
    s.playing = true;
    renderBar();
    clearInterval(timer);
    timer = setInterval(function () {
      var sc = scene();
      if (s.step >= sc.steps.length - 1) { pause(); S.toast('本轮演示完成：' + s.scene); return; }
      go(s.step + 1);
      if (s.playing) renderBar();
    }, 3400);
  }
  function pause() {
    st().playing = false;
    clearInterval(timer);
    if (ui.bar) renderBar();
  }

  function renderAll() {
    ensureDom();
    renderLeft(); renderRight(); renderKpi(); renderBar();
    if (gl && gl.available) {
      gl.toggleLabels(true);
      /* 首屏加载（非切换进入）时也支持 ?cam= 直达机位 */
      try {
        var q = new URLSearchParams(location.search).get('cam');
        if (q && ['all', 'R1', 'R2', 'R3', 'R4', 'ctrl', 'pool'].indexOf(q) >= 0) gl.flyTo(q);
      } catch (e) {}
    }
  }

  /* ── 与 app-controller 的接缝 ── */
  function sync() {
    if (STATE.page !== 'lc') { pause(); return; }
    if (gl && gl.available) gl.resize();
  }

  /* 进入页面时把当前步的画面推给三维 */
  function onEnter() {
    ensureDom();
    if (gl && gl.available) {
      var step = curStep();
      gl.applyStep(step.act, null);
      var cam = step.cam;
      try {
        var q = new URLSearchParams(location.search).get('cam');
        if (q && ['all', 'R1', 'R2', 'R3', 'R4', 'ctrl', 'pool'].indexOf(q) >= 0) cam = q;
      } catch (e) {}
      if (cam) gl.flyTo(cam);
    }
  }

  window.__RENDER_LC__ = {
    renderAll: renderAll,
    sync: sync,
    onEnter: onEnter,
    go: go,
    goScene: goScene,
    curStep: curStep
  };
})();
