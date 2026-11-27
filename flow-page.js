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
    if (!STATE.flow) STATE.flow = { scenario: 'S1', stage: 0, playing: false, mode: 'auto',
      showCand: true, showMx: true };
    return STATE.flow;
  }
  function sc() { return F.pick(st().scenario); }
  function stage() { return F.STAGES[Math.min(st().stage, F.STAGES.length - 1)]; }
  /* 场景级文案覆盖：sc.ov[stageId][field] 优先于默认 STAGES 文案 */
  function stx(sg, s, field) {
    var ov = s && s.ov && s.ov[sg.id] && s.ov[sg.id][field];
    return ov !== undefined ? ov : sg[field];
  }

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

    scene.mount(ui.host, { onSelect: onPick, onDeploy: onDeployLv });
    if (scene.setShowCand) scene.setShowCand(st().showCand !== false);
    mounted = true;
  }

  /* ── 部署等级变化（T0→T3）：只刷新部署时间轴，不打断动画 ── */
  function onDeployLv(lv) {
    syncDepStrip(lv);
    var d = F.DEP && F.DEP[lv];
    if (d) pushLog('部署时间轴 → ' + d.id + ' ' + d.zh + ' · ' + d.brief);
  }
  function syncDepStrip(lv) {
    var strip = document.getElementById('fl-dep-strip');
    if (!strip) return;
    var s = st();
    var act1 = s.mode === 'manual' && lv < 1 && s.stage >= 2;
    strip.querySelectorAll('[data-dep]').forEach(function (n) {
      var i = +n.getAttribute('data-dep');
      n.classList.toggle('is-done', lv > i);
      n.classList.toggle('is-cur', lv === i);
      n.classList.toggle('is-act', i === 1 && act1);
    });
    var cnt = strip.querySelector('.fl-dep-cnt');
    if (cnt) {
      var cur = sc();
      cnt.textContent = (lv >= 1 ? 2 : 0) + ' / 4 机架' +
        (!(cur.deploy && cur.deploy.length) ? ' · 本情景维持全 RDMA' : '');
    }
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

    h += '<div class="fl-sec"><div class="fl-sec-h"><span>实验场景</span><i>SCENARIO</i></div>' +
      '<div class="fl-scn-hint">核心入口：这批 KV 有没有明确的主力访问机架？</div>';
    F.SCENARIOS.forEach(function (sn) {
      h += '<button type="button" class="fl-scn' + (sn.id === s.scenario ? ' is-on' : '') + '" data-scn="' + sn.id + '">' +
        '<span class="fl-scn-k">' + sn.id + '</span>' +
        '<span class="fl-scn-t"><b>' + sn.zh + '</b><em>' + esc(sn.brief) + '</em></span>' +
        '<span class="fl-scn-en">' + sn.en + '</span></button>';
    });
    h += '</div>';

    h += '<div class="fl-sec fl-sec--flow"><div class="fl-sec-h"><span>生命周期流程</span><i>8 STAGES</i></div>' +
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

    var tot = String(F.STAGES.length).replace(/^(\d)$/, '0$1');
    var pct = Math.round(((s.stage + 1) / F.STAGES.length) * 100);
    h += '<div class="fl-prog"><div class="fl-prog-h"><span>本轮进度</span><b>' +
      cur.n + ' / ' + tot + '</b></div><div class="fl-prog-bar"><i style="width:' + pct + '%"></i></div></div>';

    $('left-body').innerHTML = h;
    $('left-kicker').textContent = 'LIVE RUN / ' + s.scenario;
    $('left-title').textContent = '运行流程';
    $('left-subtitle').textContent = '同一套硬件 · 八个阶段 · 数据在哪、为什么这样放';
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
    var tot = String(F.STAGES.length).replace(/^(\d)$/, '0$1');
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
      what('动作', F.fill(stx(sg, s, 'act'), s), 'act') +
      what('对象', F.fill(stx(sg, s, 'obj'), s), 'obj') +
      what('原因', F.fill(stx(sg, s, 'why'), s), 'why') +
      what('结果', F.fill(stx(sg, s, 'res'), s), 'res') +
      '</div>';

    /* 局部性判定卡（阶段 04 核心分叉点） */
    if (sg.id === 'locality') {
      h += '<div class="fl-card"><div class="fl-card-h"><i class="fl-bar"></i><span>局部性判定</span><b>核心分叉</b></div>' +
        what('判定', F.fill(stx(sg, s, 'caption'), s), 'act') +
        what('依据', F.fill(stx(sg, s, 'why'), s), 'why') +
        what('分流', F.fill(stx(sg, s, 'res'), s), 'res') +
        '</div>';
    }

    /* 策略对比面板：RICA vs 朴素远端 CXL（可开关，hover 看判定依据） */
    if (s.mx && st().showMx) {
      var mx = s.mx;
      h += '<div class="fl-card"><div class="fl-card-h"><i class="fl-bar"></i><span>策略对比</span><b>RICA vs 朴素</b></div>' +
        '<dl class="fl-spec">' +
        spec('RICA 延迟', mx.rica) +
        spec('朴素策略*', mx.naive) +
        spec('收益', mx.gain) +
        spec('CXL 容量占用', mx.cap) +
        spec('跨机架流量', mx.xr) +
        '</dl>' +
        '<div class="fl-mx-note" title="' + esc(mx.basis) + '">判定依据：' + esc(mx.basis) + '</div>' +
        '<div class="fl-mx-fn">* 朴素策略 = 不看局部性，一律推远端 CXL · 示意，非实测</div></div>';
    }

    /* 阶段 03：呈现全局部署决策依据（随场景变化：S1/S2 部署 R1+R3，S3/S4 维持全 RDMA） */
    if (sg.id === 'decide' && s.decision) {
      var D = s.decision;
      h += '<div class="fl-card"><div class="fl-card-h"><i class="fl-bar"></i><span>全局部署决策</span><b>评分</b></div>' +
        '<div class="fl-dec-note">' + esc(D.note || '局部性 · 历史热度 · 拥塞 · 利用率 · 成本 加权 · 示意非实测') + '</div>' +
        D.racks.map(function (r) {
          return '<div class="fl-dec-row' + (r.score >= 60 ? ' is-pick' : '') + '">' +
            '<b>' + r.id + '</b>' +
            '<div class="fl-dec-bar"><i style="width:' + r.score + '%"></i></div>' +
            '<em>' + r.score + '</em>' +
            '<span>' + r.pick + '</span>' +
            '<p>' + esc(r.why) + '</p></div>';
        }).join('') + '</div>';
    }

    h += '<div class="fl-card"><div class="fl-card-h"><i class="fl-bar"></i><span>路径图例</span><b>ENCODING</b></div>' +
      '<div class="fl-legend">' + F.LEGEND.map(function (l) {
        return '<span class="fl-lg"><i style="background:' + l.c + '"></i>' + l.t + '</span>';
      }).join('') + '</div></div>';

    $('right-body').innerHTML = h;
    $('right-kicker').textContent = 'KV DOSSIER / ' + s.kv;
    $('right-title').textContent = '对象详情';
    $('right-subtitle').textContent = sg.zh + ' · ' + sg.en;
    $('right-foot-label').textContent = 'STAGE ' + sg.n + ' / ' + tot;
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
      '</div>';
    h += '<div class="fl-tgls">' +
      '<button type="button" class="fl-tgl' + (st().showCand ? ' is-on' : '') + '" data-tgl="cand" ' +
      'title="显示被评估但放弃的候选链路（灰虚线 + 叉）；关闭后画面更干净">候选链路</button>' +
      '<button type="button" class="fl-tgl' + (st().showMx ? ' is-on' : '') + '" data-tgl="mx" ' +
      'title="显示右侧 RICA vs 朴素策略对比面板">指标面板</button>' +
      '</div>';
    h += '<div class="fl-ticks">';
    F.STAGES.forEach(function (x, i) {
      var cls = i < s.stage ? 'is-done' : i === s.stage ? 'is-cur' : '';
      h += '<button type="button" class="fl-tick ' + cls + '" data-tick="' + i + '">' +
        '<i></i><span>' + x.n + '</span><em>' + x.zh + '</em></button>';
    });
    h += '</div>';
    h += '</div>';

    /* 并行时间轴：CXL 增量部署（T0→T3，与上方 KV 生命周期对齐）
       手动模式下 T1/T2 变为可点击按钮，由用户决定何时从全量 RDMA 跳转到增量 */
    var lv = scene.deployLevel ? scene.deployLevel() : 1;
    var mode = st().mode || 'auto';
    var idx = st().stage;
    var act1 = mode === 'manual' && lv < 1 && idx >= 2;
    var deploying = !!(cur.deploy && cur.deploy.length);
    h += '<div class="fl-dep" id="fl-dep-strip">';
    h += '<span class="fl-dep-h">CXL 增量部署</span><span class="fl-dep-cnt">' + (lv >= 1 ? 2 : 0) + ' / 4 机架' +
      (deploying ? '' : ' · 本情景维持全 RDMA') + '</span>';
    h += '<span class="fl-dep-mode"><button type="button" class="fl-dep-mb' + (mode === 'auto' ? ' is-on' : '') +
      '" data-depmode="auto" title="Controller 按决策矩阵自动部署">自动</button>' +
      '<button type="button" class="fl-dep-mb' + (mode === 'manual' ? ' is-on' : '') +
      '" data-depmode="manual" title="由你点击 T1 决定何时增量部署">手动</button></span>';
    h += F.DEP.map(function (d, i) {
      var cls = lv > i ? 'is-done' : lv === i ? 'is-cur' : '';
      if (i === 1 && act1) cls += ' is-act';
      return '<button type="button" class="fl-dep-t ' + cls + '" data-dep="' + i +
        '" title="' + esc(d.brief) + (i === 1 && act1 ? ' · 点击执行部署' : '') + '">' +
        '<b>' + d.id + '</b><span>' + esc(d.zh) + '</span></button>' +
        (i < F.DEP.length - 1 ? '<i class="fl-dep-line"></i>' : '');
    }).join('');
    h += '</div>';

    h += '<div class="fl-deck-bot">' +
      '<div class="fl-caption"><span class="fl-cap-tag">当前动画</span><p>' +
        esc(F.fill(stx(sg, cur, 'caption'), cur)) + '</p></div>' +
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
        else if (a === 'next') { pause(); go(Math.min(F.STAGES.length - 1, s.stage + 1)); }
        else if (a === 'reset') { pause(); go(0); }
        else if (a === 'end') { pause(); go(F.STAGES.length - 1); }
      });
    });
    ui.deck.querySelectorAll('[data-tgl]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-tgl');
        var st0 = st();
        if (k === 'cand') {
          st0.showCand = !(st0.showCand !== false);
          if (scene.setShowCand) scene.setShowCand(st0.showCand);
          pushLog(st0.showCand ? '显示候选否决链路（灰虚线 + 叉）' : '隐藏候选链路 · 画面精简');
        } else if (k === 'mx') {
          st0.showMx = !st0.showMx;
          pushLog(st0.showMx ? '显示策略对比面板' : '隐藏策略对比面板');
          renderRight();
        }
        renderDeck();
      });
    });
    ui.deck.querySelectorAll('[data-tick]').forEach(function (b) {
      b.addEventListener('click', function () { pause(); go(+b.getAttribute('data-tick')); });
    });
    ui.deck.querySelectorAll('[data-depmode]').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-depmode')); });
    });
    ui.deck.querySelectorAll('[data-dep]').forEach(function (b) {
      b.addEventListener('click', function () { onDepClick(+b.getAttribute('data-dep')); });
    });
  }

  /* ── 部署模式：自动（Controller 决策驱动）/ 手动（用户点击 T1/T2 触发跳转） ── */
  function setMode(m) {
    var s = st();
    if (s.mode === m) return;
    s.mode = m;
    if (scene.setAutoDeploy) scene.setAutoDeploy(m === 'auto');
    pushLog(m === 'auto' ? '切换自动模式：Controller 按全局决策自动部署'
                         : '切换手动模式：请在部署时间轴点击 T1 / T2 执行增量部署');
    renderDeck();
  }
  function onDepClick(i) {
    var s = st();
    var lv = scene.deployLevel ? scene.deployLevel() : 1;
    var cur = sc();
    if (!cur.deploy || !cur.deploy.length) {
      S.toast('本情景（' + cur.zh + '）的决策为「不部署远端 CXL」—— 维持全 RDMA，见 03 决策矩阵');
      return;
    }
    if (s.mode !== 'manual') { S.toast('自动模式下由 Controller 按决策矩阵部署，可切换为手动模式亲自操作'); return; }
    if (i === 1 && lv < 1) {
      if (s.stage < 2) { S.toast('请先运行到 03 存储决策，查看全局评估依据'); return; }
      doDeploy(1);
    } else if (i === 2) {
      S.toast('T2 是 KV 数据重分配，硬件不变，随 06 迁移复制阶段自动执行');
    } else if (i <= lv) {
      S.toast('T' + i + ' 已完成');
    } else {
      S.toast('请先完成前置部署');
    }
  }
  function doDeploy(i) {
    scene.setDeployLevel(i, true);
    pushLog('手动部署执行 → T' + i + '（R1+R3 同批上线）');
    scheduleNext();
  }
  function scheduleNext() {
    var s = st();
    if (!s.playing) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!st().playing) return;
      if (st().stage >= F.STAGES.length - 1) { pause(); pushLog('本轮演示完成 · 可切换场景重放'); renderDeck(); return; }
      go(st().stage + 1);
    }, 4600);
  }
  function kpi(k, v) { return '<div class="fl-kpi"><span>' + k + '</span><b>' + esc(v) + '</b></div>'; }

  function pushLog(msg) {
    logs.push(msg);
    if (logs.length > 40) logs.shift();
    var l = $('fl-log');
    if (l) l.textContent = msg;
  }

  /* ───────── 舞台播放（二维原理视图） ───────── */
  function playStage(sg, cur) { scene.play(sg, cur); }

  /* ───────── 阶段切换 ───────── */
  function go(i) {
    var s = st();
    s.stage = Math.max(0, Math.min(F.STAGES.length - 1, i));
    var sg = stage(), cur = sc();
    playStage(sg, cur);
    if (sg.id === 'access') scene.select('R1');
    pushLog(sg.n + ' ' + sg.zh + ' · ' + F.fill(stx(sg, cur, 'caption'), cur).slice(0, 46) + '…');
    if (window.__SIM__ && S.log) { try { S.log('[FLOW ' + sg.n + '] ' + sg.zh); } catch (e) {} }
    renderLeft(); renderRight(); renderDeck();
    if (s.playing) {
      var lv = scene.deployLevel ? scene.deployLevel() : 1;
      var block = s.mode === 'manual' && sg.id === 'decide' && lv < 1 &&
        !!(cur.deploy && cur.deploy.length);
      if (block) {
        pushLog('手动模式：请在底部部署时间轴点击 T1 执行增量部署后继续');
        renderDeck();
      } else {
        scheduleNext();
      }
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
      if (idx < 0 && /^\d+$/.test(v)) idx = Math.max(0, Math.min(F.STAGES.length - 1, parseInt(v, 10) - 1));
      if (idx >= 0) st().stage = idx;
      var sid = p.get('flowsc');
      if (sid) st().scenario = sid;
      if (p.get('mode') === 'manual') st().mode = 'manual';
      if (p.get('play') === '1') st().playing = true;
    } catch (e) {}
  }

  function renderAll() {
    ensureDom();
    initFromUrl();
    if (scene.setAutoDeploy) scene.setAutoDeploy(st().mode !== 'manual');
    renderLeft(); renderRight(); renderDeck();
    playStage(stage(), sc());
    if (st().playing) play();
  }
  function onEnter() {
    ensureDom();
    playStage(stage(), sc());
    renderDeck();
  }
  function sync() { if (ui.host) ui.host.classList.toggle('is-live', st().playing); }

  return { renderAll: renderAll, onEnter: onEnter, sync: sync, go: go, play: play, pause: pause,
           setScenario: setScenario };
})();
