/* ============================================================
 * flow-scene.js — 「运行流程」中央硬件场景（SVG + 动画引擎）
 *
 * 场景内容：Leaf-Spine 交换网 / 四机架（含节点与共享 MHD）/
 *           Deployment Controller / RDMA 远端内存池 / 三类链路
 * 视觉编码：KV=橙块 · 副本=紫块 · CXL=青绿 · RDMA=蓝 · 控制=黄虚线
 *
 * 对外 API：
 *   mount(host, {onSelect})   构建 SVG
 *   play(stage, sc)           播放该阶段专属动画
 *   clear()                   清理动画与高亮
 *   select(id)                手动高亮
 * ============================================================ */
window.FLOW_SCENE = (function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var H = 760;
  var W = 1160;

  /* ── 自适应宽度布局：viewBox 宽度贴合宿主容器纵横比（消除左右留白），
     机架 / 节点 / 池 / Fabric 随宽度同步拉伸放大 ── */
  var L = {};
  var NODE_Y = [142, 206, 270, 334], NODE_H = 58, NODE_X = 10, NODE_W = 132;
  var MHD_Y = [404, 472], MHD_H = 64;

  function fitW() {
    var cw = host ? host.clientWidth : 0, ch = host ? host.clientHeight : 0;
    if (cw > 140 && ch > 140) {
      return Math.max(1160, Math.min(2240, Math.round(H * cw / ch)));
    }
    return 1160;
  }
  function computeLayout(w) {
    W = w;
    var M = 40;
    var ctrlW = Math.max(276, Math.min(340, Math.round(w * 0.23)));
    L.fabric = { x: M, y: 26, w: w - M * 2, h: 42 };
    L.ctrl = { x: w - M - ctrlW, y: 104, w: ctrlW, h: 476 };
    var right = L.ctrl.x - 32;
    var rw = Math.min(300, Math.floor((right - M - 42) / 4));
    var gap = (right - M - rw * 4) / 3;
    L.rack = { y: 104, h: 476, w: rw,
      xs: [M, M + rw + gap, M + (rw + gap) * 2, M + (rw + gap) * 3] };
    L.pool = { x: M, y: 640, w: right - M, h: 76 };
    L.busY = 600;
    /* 节点宽度 = 机架宽 - 左右边距（右侧留出 CXL 总线走廊） */
    NODE_W = rw - 48;
  }
  var CTRL_CARDS = [
    { id: 'profiler', zh: 'Workload Profiler', en: '访问局部性 / 热度画像' },
    { id: 'topo',     zh: 'Topology Monitor',  en: '节点 · CXL 可达性' },
    { id: 'place',    zh: 'Placement Controller', en: '候选位置比较 / 决策' },
    { id: 'judge',    zh: 'Locality Judge',    en: '是否存在主力访问机架' },
    { id: 'dir',      zh: 'KV Directory',     en: '逻辑 ID → 物理位置' }
  ];

  var svg = null, host = null, root = {}, onSelect = null;
  var actors = [], raf = null, t0 = 0, timers = [];
  var curSc = null;
  var lastPlay = null, replaying = false;
  /* CXL 增量部署等级：0=T0 全RDMA · 1=T1 R1+R3 同批部署 */
  var deployLv = -1, onDeployCb = null;
  /* 自动模式：Controller 按决策在阶段内自动触发部署；手动模式：等待用户点击部署时间轴 */
  var autoDeploy = true;
  /* 候选否决链路开关（灰虚线 + 叉）：可在底部控制台一键隐藏 */
  var showCand = true;

  function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }

  /* ───────────── 基础工具 ───────────── */
  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function txt(str, attrs, parent) {
    var n = el('text', attrs, parent);
    n.textContent = str;
    return n;
  }
  function rackX(i) { return L.rack.xs[i]; }
  function rackIdxOf(id) {
    for (var i = 0; i < 4; i++) if ('R' + (i + 1) === id) return i;
    return 0;
  }
  function nodeY(i) { return NODE_Y[i]; }

  function nodeAnchor(rackId, nodeId) {
    var ri = rackIdxOf(rackId);
    var ni = parseInt(String(nodeId).replace(/\D/g, ''), 10) - 1;
    if (isNaN(ni) || ni < 0 || ni > 3) ni = 0;
    return { x: rackX(ri) + NODE_X + NODE_W / 2, y: nodeY(ni) + NODE_H / 2 };
  }
  function mhdAnchor(rackId, mhdId) {
    var ri = rackIdxOf(rackId);
    var mi = /2$|4$/.test(String(mhdId)) ? 1 : 0;
    return { x: rackX(ri) + NODE_X + NODE_W / 2, y: MHD_Y[mi] + MHD_H / 2 };
  }
  function rackTop(i) { return { x: rackX(i) + L.rack.w / 2, y: L.rack.y }; }
  function rackBottom(i) { return { x: rackX(i) + L.rack.w / 2, y: L.rack.y + L.rack.h }; }
  function fabricIn(i) { return { x: rackTop(i).x, y: L.fabric.y + L.fabric.h }; }
  function poolAnchor() { return { x: L.pool.x + L.pool.w / 2, y: L.pool.y }; }
  function busXOf(i) { return rackX(i) + L.rack.w - 26; }
  function pth(pts) {
    var d = 'M' + pts[0].x + ',' + pts[0].y;
    for (var i = 1; i < pts.length; i++) d += ' L' + pts[i].x + ',' + pts[i].y;
    return d;
  }
  /* 后台并发负载脉冲点：每个节点常驻微弱脉冲 = 全集群持续推理 */
  function liveDot(x, y, parent) {
    el('circle', { cx: x, cy: y, r: 2.1, class: 'fx-live-dot' }, parent);
  }

  /* ───────────── 构建静态场景 ───────────── */
  function build() {
    computeLayout(fitW());
    svg = el('svg', {
      id: 'flow-svg', viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'xMidYMid meet', 'aria-label': 'CXL-RDMA 集群运行流程'
    });
    host.appendChild(svg);

    root.defs = el('defs', null, svg);
    var f = el('filter', { id: 'flowGlow', x: '-60%', y: '-60%', width: '220%', height: '220%' }, root.defs);
    el('feGaussianBlur', { stdDeviation: '3.4', result: 'b' }, f);
    var m = el('feMerge', null, f);
    el('feMergeNode', { in: 'b' }, m);
    el('feMergeNode', { in: 'SourceGraphic' }, m);

    root.under = el('g', { class: 'fx-under' }, svg);
    root.links = el('g', { class: 'fx-links' }, svg);
    root.boxes = el('g', { class: 'fx-boxes' }, svg);
    root.hl    = el('g', { class: 'fx-hl' }, svg);
    root.toks  = el('g', { class: 'fx-tokens' }, svg);
    root.tags  = el('g', { class: 'fx-tags' }, svg);

    drawBackdrop();
    drawFabric();
    drawPoolLink();
    drawRacks();
    drawPool();
    drawController();
    drawBus();

    svg.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-pick]') : null;
      if (t && onSelect) onSelect(t.getAttribute('data-pick'));
    });
  }

  function drawBackdrop() {
    var g = el('g', { opacity: '.35' }, root.under);
    var cols = Math.ceil((W - 40) / 57);
    for (var i = 0; i <= cols; i++) {
      el('line', { x1: 20 + i * 57, y1: 90, x2: 20 + i * 57, y2: 730, stroke: 'rgba(120,168,189,.07)', 'stroke-width': '.6' }, g);
    }
    for (var j = 0; j <= 13; j++) {
      el('line', { x1: 20, y1: 730 - j * 47, x2: W - 20, y2: 730 - j * 47, stroke: 'rgba(120,168,189,.06)', 'stroke-width': '.6' }, g);
    }
  }

  function drawFabric() {
    var f = L.fabric, g = el('g', { class: 'node-fabric', 'data-pick': 'FABRIC' }, root.boxes);
    el('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 2, class: 'fx-bar' }, g);
    var chipsW = 15 * 33 + 24;
    var chipX0 = f.x + (f.w - chipsW) / 2;
    for (var i = 0; i < 16; i++) {
      el('rect', { x: chipX0 + i * 33, y: f.y + 16, width: 24, height: 10, rx: 1.5, class: 'fx-chip' }, g);
    }
    txt('LEAF–SPINE  FABRIC', { x: f.x + 20, y: f.y + 26, class: 'fx-t1' }, g);
    txt('ROCE V2 · 400G · ECMP · 无阻塞交换', { x: f.x + 20, y: f.y + 38, class: 'fx-t3' }, g);
    txt('SPINE ×2  /  LEAF ×4', { x: f.x + f.w - 20, y: f.y + 26, class: 'fx-t2', 'text-anchor': 'end' }, g);
    txt('16 × 400G DOWNLINK', { x: f.x + f.w - 20, y: f.y + 38, class: 'fx-t3', 'text-anchor': 'end' }, g);

    root.rdmaLinks = [];
    for (var r = 0; r < 4; r++) {
      var tp = rackTop(r), fi = fabricIn(r);
      var p = el('path', {
        id: 'lnk-rdma-' + (r + 1), class: 'fx-link fx-link--rdma',
        d: 'M' + fi.x + ',' + fi.y + ' L' + fi.x + ',' + (fi.y + 10) + ' L' + tp.x + ',' + (tp.y - 10) + ' L' + tp.x + ',' + tp.y
      }, root.links);
      root.rdmaLinks.push(p);
      el('circle', { cx: tp.x, cy: tp.y - 4, r: 2.4, class: 'fx-dot fx-dot--rdma' }, root.links);
    }
  }

  function drawPoolLink() {
    var pl = L.pool;
    var d = 'M' + (pl.x + 2) + ',' + (pl.y + pl.h / 2) + ' L22,' + (pl.y + pl.h / 2) +
            ' L22,' + (L.fabric.y + L.fabric.h / 2) + ' L' + L.fabric.x + ',' + (L.fabric.y + L.fabric.h / 2);
    el('path', { id: 'lnk-pool', class: 'fx-link fx-link--rdma fx-link--dashed', d: d }, root.links);
  }

  function drawRacks() {
    root.racks = {};
    FLOW.RACKS.forEach(function (rk, ri) {
      var x = rackX(ri);
      var g = el('g', { class: 'rack', 'data-id': rk.id }, root.boxes);

      el('rect', { x: x, y: L.rack.y, width: L.rack.w, height: L.rack.h, rx: 2, class: 'fx-rack' }, g);
      el('rect', { x: x, y: L.rack.y, width: L.rack.w, height: 36, rx: 2, class: 'fx-rack-hd' }, g);
      txt(rk.id, { x: x + 12, y: L.rack.y + 24, class: 'fx-rack-id' }, g);
      var tag = txt(rk.tag, { x: x + L.rack.w - 12, y: L.rack.y + 24, class: 'fx-t3 fx-rack-tag', 'text-anchor': 'end' }, g);

      rk.nodes.forEach(function (nd, ni) {
        var ny = nodeY(ni);
        var ng = el('g', { class: 'node', 'data-pick': rk.id + '-' + nd.id }, g);
        el('rect', { x: x + NODE_X, y: ny, width: NODE_W, height: NODE_H, rx: 2, class: 'fx-node' }, ng);
        txt(nd.id, { x: x + NODE_X + 9, y: ny + 23, class: 'fx-node-id' }, ng);
        txt(nd.role, { x: x + NODE_X + 9, y: ny + 40, class: 'fx-t3' }, ng);
        var hbmX = x + NODE_X + NODE_W - 48;
        el('rect', { x: hbmX, y: ny + 31, width: 40, height: 18, rx: 1, class: 'fx-hbm', 'data-slot': rk.id + '-' + nd.id }, ng);
        txt('HBM', { x: hbmX + 20, y: ny + 44, class: 'fx-t4', 'text-anchor': 'middle' }, ng);
        liveDot(x + NODE_X + NODE_W - 6, ny + 8, ng);
      });

      el('circle', { cx: x + L.rack.w / 2, cy: L.rack.y - 4, r: 2.4, class: 'fx-dot fx-dot--rdma' }, g);
      el('rect', {
        x: x - 3, y: L.rack.y - 3, width: L.rack.w + 6, height: L.rack.h + 6, rx: 3,
        class: 'fx-rank', 'data-ring': rk.id
      }, root.hl);

      root.racks[rk.id] = { g: g, tag: tag, hw: null };
    });
  }

  /* ── 按部署等级重建某机架的 CXL 硬件（Switch / MHD / 主机接入 / CXL 总线） ── */
  function applyHardware(rk, ri, lv, animate) {
    var slot = root.racks[rk.id];
    if (!slot) return;
    if (slot.hw && slot.hw.parentNode) slot.hw.parentNode.removeChild(slot.hw);
    var x = rackX(ri);
    var g = el('g', { class: 'fx-hw' + (animate ? ' fx-grow' : '') }, slot.g);
    var deployed = (rk.id === 'R1' || rk.id === 'R3') && lv >= 1;
    var cxlOn = deployed;
    var isR1 = rk.id === 'R1';

    if (!cxlOn) {
      var ph = el('g', { class: 'mhd mhd--empty' }, g);
      el('rect', { x: x + NODE_X, y: MHD_Y[0], width: NODE_W, height: MHD_H * 2 + 8, rx: 2, class: 'fx-mhd-empty' }, ph);
      txt('NO CXL DEVICE', { x: x + NODE_X + NODE_W / 2, y: MHD_Y[0] + MHD_H - 6, class: 'fx-t4', 'text-anchor': 'middle' }, ph);
      txt('纯 RDMA 访问路径', { x: x + NODE_X + NODE_W / 2, y: MHD_Y[0] + MHD_H + 14, class: 'fx-t4', 'text-anchor': 'middle' }, ph);
    } else {
      /* T1/T2 增量上线：先挂一台 MHD，另一槽位虚线预留 */
      var mh = rk.mhd[0];
      var my = MHD_Y[0];
      var mg = el('g', { class: 'mhd', 'data-pick': rk.id + '-' + mh.id }, g);
      el('rect', { x: x + NODE_X, y: my, width: NODE_W, height: MHD_H, rx: 2, class: 'fx-mhd' }, mg);
      txt(mh.id, { x: x + NODE_X + 9, y: my + 20, class: 'fx-mhd-id' }, mg);
      txt(mh.used + ' / ' + mh.cap + ' GB', { x: x + NODE_X + 9, y: my + 36, class: 'fx-t3' }, mg);
      el('rect', { x: x + NODE_X + 9, y: my + 48, width: NODE_W - 18, height: 5, rx: 2, class: 'fx-bar-bg' }, mg);
      el('rect', {
        x: x + NODE_X + 9, y: my + 48, width: (NODE_W - 18) * (mh.used / mh.cap), height: 5, rx: 2,
        class: 'fx-bar-fill', 'data-bar': rk.id + '-' + mh.id
      }, mg);
      txt('MHD', { x: x + NODE_X + NODE_W - 9, y: my + 20, class: 'fx-t4', 'text-anchor': 'end' }, mg);
      var rs = el('g', { class: 'mhd mhd--empty' }, g);
      el('rect', { x: x + NODE_X, y: MHD_Y[1], width: NODE_W, height: MHD_H, rx: 2, class: 'fx-mhd-empty' }, rs);
      txt('RESERVED', { x: x + NODE_X + NODE_W / 2, y: MHD_Y[1] + MHD_H / 2 + 4, class: 'fx-t4', 'text-anchor': 'middle' }, rs);

      /* CXL 总线 + 主机接入链路（N1/N2）+ MHD 链路 */
      var busX = busXOf(ri);
      el('path', {
        d: 'M' + busX + ',' + (nodeY(0) + NODE_H / 2) + ' L' + busX + ',' + (MHD_Y[1] + MHD_H / 2),
        class: 'fx-bus fx-bus--cxl'
      }, g);
      ['N1', 'N2'].forEach(function (nid, ni) {
        var ny = nodeY(ni) + NODE_H / 2;
        el('path', {
          id: 'lnk-cxl-' + rk.id + '-' + nid,
          d: 'M' + (x + NODE_X + NODE_W) + ',' + ny + ' L' + busX + ',' + ny,
          class: 'fx-link fx-link--cxl'
        }, g);
      });
      el('path', {
        id: 'lnk-cxl-' + rk.id + '-' + mh.id,
        d: 'M' + busX + ',' + (my + MHD_H / 2) + ' L' + (x + NODE_X + NODE_W) + ',' + (my + MHD_H / 2),
        class: 'fx-link fx-link--cxl'
      }, g);

      /* 主机接入 CXL 徽标 */
      [0, 1].forEach(function (ni) {
        var ny = nodeY(ni);
        var bxl = x + NODE_X + NODE_W - 46;
        el('rect', { x: bxl, y: ny + 11, width: 32, height: 14, rx: 1, class: 'fx-pill fx-pill--cxl' }, g);
        txt('CXL', { x: bxl + 16, y: ny + 21, class: 'fx-pill-t', 'text-anchor': 'middle' }, g);
      });
      txt('CXL SW · 2 HOST PORT', { x: x + NODE_X, y: MHD_Y[1] + MHD_H + 22, class: 'fx-t4' }, g);
    }
    slot.hw = g;
    if (slot.tag) {
      slot.tag.textContent = cxlOn ? 'CXL + RDMA' : 'RDMA ONLY';
      slot.tag.style.fill = cxlOn ? '' : 'rgba(167,197,215,.4)';
    }
  }

  /* ── 部署等级切换：animate=true 时设备"长出来" ──
     等级 1 = R1+R3 同批部署（决策矩阵一次判定，无分批时间差）。
     不单独出标注卡：决策阶段已有"选中"标注卡，避免同位叠卡；
     设备生长动画 + 底部部署时间轴 + 日志已完整表达 T1 事件。 */
  function setDeployLevel(lv, animate) {
    lv = Math.max(0, Math.min(1, lv));
    if (lv === deployLv && !animate) return;
    deployLv = lv;
    FLOW.RACKS.forEach(function (rk, ri) { applyHardware(rk, ri, lv, animate); });
    if (onDeployCb) { try { onDeployCb(lv); } catch (e) {} }
  }
  function deployLevel() { return Math.max(0, deployLv); }

  function drawPool() {
    var p = L.pool;
    var g = el('g', { class: 'pool', 'data-pick': 'POOL' }, root.boxes);
    root.poolRect = el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 2, class: 'fx-pool' }, g);
    txt('RDMA  REMOTE  MEMORY  POOL', { x: p.x + 16, y: p.y + 24, class: 'fx-t1' }, g);
    txt('DRAM / 全闪存 · 4 TB · 仅经 RNIC + Leaf-Spine 可达', { x: p.x + 16, y: p.y + 40, class: 'fx-t3' }, g);
    txt('POOL-A', { x: p.x + p.w - 16, y: p.y + 24, class: 'fx-t2', 'text-anchor': 'end' }, g);
    txt('SLA · 4.1 µs', { x: p.x + p.w - 16, y: p.y + 40, class: 'fx-t3', 'text-anchor': 'end' }, g);
    root.poolSlots = [];
    var step = (p.w - 32 - 44) / 13;
    for (var i = 0; i < 14; i++) {
      root.poolSlots.push(el('rect', {
        x: p.x + 16 + i * step, y: p.y + 52, width: 44, height: 12, rx: 1,
        class: 'fx-pool-slot' + (i < 4 ? ' is-used' : '')
      }, g));
    }
    /* 原生池水位状态条：位于池下方，不被 03/04 决策浮层遮挡，全程可见 */
    var sg = el('g', { class: 'pool-stat' }, root.boxes);
    el('rect', { x: p.x + 2, y: p.y + p.h + 8, width: p.w - 4, height: 20, rx: 2, class: 'fx-pool-stat-bg' }, sg);
    root.poolStatT = txt('POOL 水位 4/14 · 拥塞 24% · 水位正常（示意）',
      { x: p.x + 14, y: p.y + p.h + 22, class: 'fx-pool-stat' }, sg);
  }

  /* ── 原生 RDMA 池水位状态（S2/S3 核心叙事）：
     拥塞 ≥ 70% 视为过载：池框高亮橙红、状态条变红 —— S3 兜底激活的视觉前提 ── */
  function setPoolState(p) {
    if (!p || !root.poolSlots) return;
    var used = Math.max(0, Math.min(14, p.used | 0));
    var cong = Math.max(0, Math.min(100, p.cong | 0));
    var sat = cong >= 70;
    root.poolSlots.forEach(function (s, i) { s.classList.toggle('is-used', i < used); });
    if (root.poolRect) root.poolRect.classList.toggle('is-sat', sat);
    if (root.poolStatT) {
      root.poolStatT.textContent = 'POOL 水位 ' + used + '/14 · 拥塞 ' + cong + '% · ' + p.note + '（示意）';
      root.poolStatT.setAttribute('fill', sat ? '#f0785a' : '#7c93a4');
    }
  }

  function drawController() {
    var c = L.ctrl, g = el('g', { class: 'ctrl', 'data-pick': 'CTRL' }, root.boxes);
    el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 2, class: 'fx-ctrl-panel' }, g);
    txt('DEPLOYMENT CONTROLLER', { x: c.x + 14, y: c.y + 20, class: 'fx-t2' }, g);
    txt('控制平面 · 仅接收元数据', { x: c.x + 14, y: c.y + 33, class: 'fx-t4' }, g);
    root.ctrlCards = {};
    CTRL_CARDS.forEach(function (cd, i) {
      var cy = c.y + 42 + i * 84;
      var cg = el('g', { class: 'ctrl-card', 'data-card': cd.id }, g);
      el('rect', { x: c.x + 12, y: cy, width: c.w - 24, height: 70, rx: 2, class: 'fx-ctrl-card' }, cg);
      el('rect', { x: c.x + 12, y: cy, width: 2, height: 70, class: 'fx-ctrl-edge' }, cg);
      txt(cd.zh, { x: c.x + 24, y: cy + 22, class: 'fx-ctrl-t' }, cg);
      txt(cd.en, { x: c.x + 24, y: cy + 36, class: 'fx-t4' }, cg);
      var st = txt('IDLE', { x: c.x + 24, y: cy + 56, class: 'fx-ctrl-st' }, cg);
      root.ctrlCards[cd.id] = { g: cg, st: st };
      el('circle', { cx: c.x + 12, cy: cy + 35, r: 2.2, class: 'fx-dot fx-dot--ctl' }, cg);
    });
  }

  function drawBus() {
    var y = L.busY, x0 = rackX(0) + L.rack.w / 2, x1 = L.ctrl.x + L.ctrl.w / 2;
    el('path', { d: 'M' + x0 + ',' + y + ' L' + x1 + ',' + y, class: 'fx-bus fx-bus--ctl' }, root.links);
    root.ctlLinks = [];
    for (var i = 0; i < 4; i++) {
      var b = rackBottom(i);
      root.ctlLinks.push(el('path', {
        id: 'lnk-ctl-' + (i + 1),
        d: 'M' + b.x + ',' + b.y + ' L' + b.x + ',' + y,
        class: 'fx-link fx-link--ctl'
      }, root.links));
    }
    el('path', {
      id: 'lnk-ctl-ctrl',
      d: 'M' + x1 + ',' + y + ' L' + x1 + ',' + (L.ctrl.y + L.ctrl.h),
      class: 'fx-link fx-link--ctl'
    }, root.links);
    txt('CONTROL PLANE · 遥测 / 决策下发（不含 KV 数据）', { x: rackX(0) + 8, y: y + 15, class: 'fx-t4' }, root.links);
  }

  /* ───────────── 动画引擎 ───────────── */
  function easeInOut(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function polyLen(pts) {
    var n = 0;
    for (var i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return n;
  }
  function pointAt(pts, d) {
    var acc = 0;
    for (var i = 1; i < pts.length; i++) {
      var seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (acc + seg >= d || i === pts.length - 1) {
        var r = seg === 0 ? 0 : Math.min(1, (d - acc) / seg);
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * r, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * r };
      }
      acc += seg;
    }
    return pts[pts.length - 1];
  }

  function tick(now) {
    if (!t0) t0 = now;
    var elapsed = now - t0, alive = 0;
    for (var i = 0; i < actors.length; i++) {
      var a = actors[i];
      if (a.done) continue;
      var t = (elapsed - a.delay) / a.dur;
      if (t < 0) { alive++; continue; }
      if (t > 1) t = 1;
      var pt = pointAt(a.pts, polyLen(a.pts) * (a.ease ? easeInOut(t) : t));
      a.el.setAttribute('transform', 'translate(' + pt.x + ',' + pt.y + ')');
      if (t >= 1) {
        a.done = true;
        if (a.onDone) a.onDone();
        if (a.keep) {
          var last = a.pts[a.pts.length - 1];
          a.el.setAttribute('transform', 'translate(' + last.x + ',' + last.y + ')');
        } else if (a.el.parentNode) {
          a.el.parentNode.removeChild(a.el);
        }
      } else alive++;
    }
    raf = alive > 0 ? requestAnimationFrame(tick) : null;
    if (!raf) t0 = 0;
  }
  function schedule() { if (!raf) { t0 = 0; raf = requestAnimationFrame(tick); } }

  function token(kind, at, opts) {
    opts = opts || {};
    var sz = opts.size || 13;
    var g = el('g', { class: 'fx-token fx-token--' + kind });
    var c = { kv: '#e6a056', rep: '#a38bf2', ctl: '#e4b66b', cxl: '#53e3c4', rdma: '#f0785a',
              copy: '#8fc6f2', cand: '#8ca0af' }[kind] || '#e6a056';
    if (opts.gold) { c = '#ffd76b'; g.classList.add('fx-token--gold'); }
    el('rect', { x: -sz / 2, y: -sz / 2, width: sz, height: sz, rx: 2, fill: c, class: 'fx-token-c' }, g);
    if (opts.label) {
      var t = el('text', { x: 0, y: -sz / 2 - 6, class: 'fx-token-l', 'text-anchor': 'middle' }, g);
      t.textContent = opts.label;
    }
    g.setAttribute('transform', 'translate(' + at.x + ',' + at.y + ')');
    root.toks.appendChild(g);
    return { g: g, x: at.x, y: at.y };
  }

  function move(tok, pts, opts) {
    opts = opts || {};
    actors.push({
      el: tok.g, pts: pts, dur: opts.dur || 1200, delay: opts.delay || 0,
      ease: opts.ease !== false, keep: !!opts.keep, onDone: opts.onDone
    });
    schedule();
  }

  function pulse(sel, cls, dur) {
    document.querySelectorAll(sel).forEach(function (n) {
      n.classList.add(cls);
      if (dur) later(function () { n.classList.remove(cls); }, dur);
    });
  }
  function pulseLink(id, cls, dur) { pulse('#' + id, cls, dur); }
  function hl(sel, cls, dur) {
    document.querySelectorAll(sel).forEach(function (n) {
      n.classList.add(cls);
      if (dur) later(function () { n.classList.remove(cls); }, dur);
    });
  }
  function ring(rackId, on) {
    var r = document.querySelector('[data-ring="' + rackId + '"]');
    if (r) r.classList.toggle('is-on', !!on);
  }
  function card(id, on, statusText) {
    var c = root.ctrlCards && root.ctrlCards[id];
    if (!c) return;
    c.g.classList.toggle('is-on', !!on);
    if (statusText !== undefined) c.st.textContent = statusText;
  }

  function clear() {
    timers.forEach(function (id) { clearTimeout(id); });
    timers = [];
    actors.forEach(function (a) { if (a.el && a.el.parentNode) a.el.parentNode.removeChild(a.el); });
    actors = []; t0 = 0;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (root.toks) root.toks.innerHTML = '';
    document.querySelectorAll('.fx-link.is-flow').forEach(function (n) { n.classList.remove('is-flow'); });
    document.querySelectorAll('[data-ring]').forEach(function (n) { n.classList.remove('is-on'); });
    Object.keys(root.ctrlCards || {}).forEach(function (k) { card(k, false, 'IDLE'); });
    document.querySelectorAll('.fx-tags .fx-callout').forEach(function (n) { n.remove(); });
    document.querySelectorAll('.fx-tags .fx-decision').forEach(function (n) { n.remove(); });
    document.querySelectorAll('.fx-tags .fx-candset').forEach(function (n) { n.remove(); });
    document.querySelectorAll('.fx-node.is-hot, .fx-mhd.is-hot, .fx-hbm.is-hot, .fx-hbm.is-hit, .fx-mhd.is-cold, .fx-bar-fill.is-hit')
      .forEach(function (n) { n.classList.remove('is-hot', 'is-hit', 'is-cold'); });
  }

  function callout(x, y, title, sub, color) {
    var CW = 196;
    x = Math.max(20, Math.min(W - CW - 20, x));
    y = Math.max(80, Math.min(H - 60, y));
    var g = el('g', { class: 'fx-callout' }, root.tags);
    el('rect', { x: x, y: y, width: CW, height: sub ? 40 : 26, rx: 2, class: 'fx-callout-box' }, g);
    el('rect', { x: x, y: y, width: 2, height: sub ? 40 : 26, fill: color || '#7dc9df' }, g);
    var t = el('text', { x: x + 10, y: y + 18, class: 'fx-callout-t' }, g);
    t.textContent = title;
    if (sub) {
      var s = el('text', { x: x + 10, y: y + 34, class: 'fx-t4' }, g);
      s.textContent = sub;
    }
    g.setAttribute('opacity', '0');
    requestAnimationFrame(function () { g.style.transition = 'opacity .4s'; g.setAttribute('opacity', '1'); });
    later(function () {
      g.style.transition = 'opacity .5s';
      g.setAttribute('opacity', '0');
      later(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 550);
    }, 4200);
    return g;
  }

  /* ───────────── 各阶段动画 ───────────── */
  /* ── 01 推理生成：全集群 16 节点并行推理（T0 基线同样成立），
        本轮只重点跟踪 prod 节点的那组 KV ── */
  function animGen(sc) {
    FLOW.RACKS.forEach(function (rk, ri) {
      rk.nodes.forEach(function (nd, ni) {
        var a = nodeAnchor(rk.id, nd.id);
        var pick = rk.id + '-' + nd.id;
        var isProd = pick === sc.prod;
        var d0 = 120 + (ri * 4 + ni) * 110;
        later(function () {
          hl('.node[data-pick="' + pick + '"] .fx-hbm', isProd ? 'is-hot' : 'is-hit');
          if (isProd) hl('.node[data-pick="' + pick + '"] .fx-node', 'is-hot');
        }, d0);
        if (!isProd) {
          for (var k = 0; k < 2; k++) {
            (function (k) {
              var sx = a.x + 6 + k * 12, sy = a.y + 4;
              var t = token('kv', { x: sx, y: sy }, { size: 7 });
              move(t, [{ x: sx, y: sy }, { x: sx - 14, y: sy - 16 }],
                { dur: 700, delay: d0 + k * 150, keep: true });
            })(k);
          }
        }
      });
    });
    var p = nodeAnchor(sc.prod.split('-')[0], sc.prod.split('-')[1]);
    callout(p.x + 34, p.y - 58, sc.prod + ' · GPU HBM', '全集群并行推理 · 跟踪 ' + sc.kv, '#e6a056');
    for (var i = 0; i < 4; i++) {
      (function (i) {
        var sx = p.x + 14 + (i % 2) * 9, sy = p.y + 6 + Math.floor(i / 2) * 9;
        var t = token('kv', { x: sx, y: sy }, { size: 10, gold: true });
        move(t, [{ x: sx, y: sy }, { x: p.x - 44, y: p.y - 30 }], { dur: 900, delay: 160 * i, keep: true });
      })(i);
    }
  }

  function animCollect(sc) {
    var c = L.ctrl, x1 = c.x + c.w / 2;
    FLOW.RACKS.forEach(function (rk, i) {
      var b = rackBottom(i);
      var pts = [{ x: b.x, y: b.y }, { x: b.x, y: L.busY }, { x: x1, y: L.busY }, { x: x1, y: c.y + c.h }];
      for (var k = 0; k < 2; k++) {
        (function (k) {
          var t = token('ctl', { x: pts[0].x, y: pts[0].y }, { size: 7 });
          move(t, pts, { dur: 1500, delay: 220 * i + 160 * k });
        })(k);
      }
      pulseLink('lnk-ctl-' + (i + 1), 'is-flow', 2600);
    });
    later(function () { card('topo', true, '拓扑上报'); }, 500);
    later(function () { card('profiler', true, '热度 / 局部性'); }, 1000);
    later(function () { card('dir', true, 'KV 映射'); }, 1500);
    later(function () { card('place', true, '待决策'); }, 2000);
    later(function () { card('place', false, 'READY'); }, 3400);
    callout(L.fabric.x + 20, 630, '遥测通路', '仅元数据上行 · KV 本体不移动', '#e4b66b');
  }

  /* ── 全局部署决策矩阵浮层（阶段 03）：
     四机架 × 局部性/热度/拥塞/利用率/成本 加权评分 → 部署优先级
     数据随场景变化（D = 当前场景的 decision），
     评分 ≥ 60 的机架最终高亮为部署对象。 ── */
  function decisionOverlay(D) {
    if (!D) return;
    var p = L.pool;
    var x = p.x, y = p.y - 30, w = p.w, hh = 112;
    var g = el('g', { class: 'fx-decision' }, root.tags);
    el('rect', { x: x, y: y, width: w, height: hh, rx: 2, class: 'fx-dec-box' }, g);
    el('rect', { x: x, y: y, width: 2, height: hh, fill: '#e4b66b' }, g);
    txt('CXL 增量部署 · 全局决策矩阵', { x: x + 14, y: y + 20, class: 'fx-t2' }, g);
    txt(D.note || '加权评分（示意，非实测）',
      { x: x + w - 14, y: y + 20, class: 'fx-t4', 'text-anchor': 'end', fill: '#8fa6b5' }, g);
    var cw = (w - 28) / D.racks.length;
    D.racks.forEach(function (r, i) {
      var cx = x + 14 + i * cw;
      var col = el('g', { class: 'fx-dec-col', 'data-dec': r.id }, g);
      txt(r.id, { x: cx, y: y + 42, class: 'fx-t2' }, col);
      txt(r.pick, {
        x: cx + 34, y: y + 42, class: 'fx-t4',
        fill: r.score >= 60 ? '#53e3c4' : '#6c8290'
      }, col);
      el('rect', { x: cx, y: y + 50, width: cw - 26, height: 5, rx: 2, class: 'fx-bar-bg' }, col);
      el('rect', { x: cx, y: y + 50, width: (cw - 26) * r.score / 100, height: 5, rx: 2,
        class: 'fx-bar-fill', fill: r.score >= 60 ? 'rgba(83,227,196,.85)' : 'rgba(108,130,144,.55)' }, col);
      txt(String(r.score), { x: cx + cw - 22, y: y + 58, class: 'fx-t4', fill: '#cfe3ee' }, col);
      txt('局部 ' + r.locality + '% · 热度 ' + r.hot, { x: cx, y: y + 74, class: 'fx-dec-f' }, col);
      txt('拥塞 ' + r.cong + '% · 利用 ' + r.util + '% · 成本 ' + r.cost, { x: cx, y: y + 90, class: 'fx-dec-f' }, col);
      later(function () { col.classList.add('is-on'); }, 500 + i * 450);
    });
    /* 达到部署阈值的机架最终高亮 */
    later(function () {
      D.racks.forEach(function (r) {
        if (r.score >= 60) {
          var w0 = g.querySelector('[data-dec="' + r.id + '"]');
          if (w0) w0.classList.add('is-win');
        }
      });
    }, 2400);
  }

  /* 跨机架走廊 y 坐标（Fabric 下沿与机架顶部之间的水平通道） */
  function corridorY() { return L.fabric.y + L.fabric.h + 8; }

  /* ── 03 存储决策：离线增量部署（前提已落板，R1+R3 同批上线）+
     KV 初始放置随情景分派（place: mhd / pool / remote-mhd / copy）── */
  function animDecide(sc) {
    var dep = (sc.deploy && sc.deploy.length) ? sc.deploy : [];
    card('profiler', true, '局部性 ' + sc.local + '%');
    later(function () {
      decisionOverlay(sc.decision);
      card('place', true, '离线决策执行中…');
    }, 200);
    /* T1：R1+R3 同批上线（离线决策矩阵一次判定，无分批时间差） */
    dep.forEach(function (rid, i) {
      var row = (sc.decision && sc.decision.racks.filter(function (r) { return r.id === rid; })[0]) || { score: '?' };
      later(function () {
        ring(rid, true);
        card('topo', true, 'CXL 可达');
        callout(rackX(rackIdxOf(rid)) + 4, 78, rid + ' · 选中 · 评分 ' + row.score, null, '#53e3c4');
      }, 400 + i * 900);
    });
    later(function () { dep.slice(1).forEach(function (rid) { ring(rid, false); }); }, 2200);

    var pp = sc.prod.split('-');
    var p = nodeAnchor(pp[0], pp[1]);
    var rtF = rackTop(rackIdxOf(pp[0]));
    var m1 = mhdAnchor('R1', 'MHD-1'), bx1 = busXOf(0);
    var pool = poolAnchor();
    var place = sc.place || 'mhd';

    if (place === 'pool') {
      /* S2：原生池水位未击穿 → 直写原生池，主动无视 CXL */
      later(function () {
        card('place', true, '-> RDMA Pool');
        var pts = [{ x: p.x, y: p.y }, { x: rtF.x, y: rtF.y }, { x: rtF.x, y: corridorY() },
                   { x: pool.x + 150, y: corridorY() }, { x: pool.x + 150, y: pool.y - 8 }];
        pulseLink('lnk-rdma-' + (rackIdxOf(pp[0]) + 1), 'is-flow', 2600);
        pulseLink('lnk-pool', 'is-flow', 2600);
        var t = token('kv', { x: p.x, y: p.y }, { size: 12 });
        move(t, pts, {
          dur: 1800, keep: true, onDone: function () {
            callout(pool.x + 80, pool.y - 40, sc.kv + ' → RDMA Pool',
              '水位未击穿 · 回退原生池 · 主动无视 CXL', '#5f9fe8');
          }
        });
      }, 2400);
    } else if (place === 'remote-mhd') {
      /* S3：原生池过载 → 兜底写入远端 R1-MHD-1（跨机架 RDMA 传输） */
      later(function () {
        card('place', true, '-> R1-MHD-1（兜底）');
        var pts = [{ x: p.x, y: p.y }, { x: rtF.x, y: rtF.y }, { x: rtF.x, y: corridorY() },
                   { x: rackX(0) + L.rack.w / 2, y: corridorY() },
                   { x: rackX(0) + L.rack.w / 2, y: rackTop(0).y },
                   { x: bx1, y: rackTop(0).y }, { x: bx1, y: m1.y }, { x: m1.x + 26, y: m1.y }];
        pulseLink('lnk-rdma-' + (rackIdxOf(pp[0]) + 1), 'is-flow', 2800);
        var t = token('kv', { x: p.x, y: p.y }, { size: 12, gold: true });
        move(t, pts, {
          dur: 2200, keep: true, onDone: function () {
            hl('.mhd[data-pick="R1-MHD-1"] .fx-mhd', 'is-hot');
            callout(pool.x + 80, pool.y - 40, '原生池过载 · 兜底写入远端 MHD',
              'Cost(X)=7.8µs 击穿 → Cost(Y)=4.9µs 反超', '#f0785a');
          }
        });
      }, 2400);
    } else {
      /* S1（mhd）：KV 写入 R1-MHD-1 · S4（copy）：写入原件 + 复制副本到 R3 */
      later(function () {
        card('place', true, '-> ' + sc.dst);
        var t = token('kv', { x: p.x, y: p.y }, { size: 12, gold: true });
        move(t, [{ x: p.x, y: p.y }, { x: bx1, y: p.y }, { x: bx1, y: m1.y }, { x: m1.x + 26, y: m1.y }],
          { dur: 1600, keep: true });
        later(function () { hl('.mhd[data-pick="R1-MHD-1"] .fx-mhd', 'is-hot'); }, 1600);
      }, 2400);
      if (place === 'copy') {
        later(function () {
          var m3 = mhdAnchor('R3', 'MHD-3'), bx3 = busXOf(2);
          var pts = [{ x: m1.x + 26, y: m1.y }, { x: bx1, y: m1.y }, { x: bx1, y: corridorY() },
                     { x: bx3, y: corridorY() }, { x: bx3, y: m3.y }, { x: m3.x + 26, y: m3.y }];
          var cp = el('path', { d: pth(pts), class: 'fx-copy-path' }, root.toks);
          later(function () { if (cp.parentNode) cp.parentNode.removeChild(cp); }, 3200);
          var t = token('copy', { x: pts[0].x, y: pts[0].y }, { size: 11, label: 'COPY ×1' });
          move(t, pts, { dur: 1700, keep: true, onDone: function () {
            hl('.mhd[data-pick="R3-MHD-3"] .fx-mhd', 'is-hot');
          } });
        }, 3200);
      }
    }
    later(function () { card('place', false, 'PLACED'); }, 4900);
  }

  /* ── 04 局部性判定（核心分叉点）：
     信令汇聚 → Locality Judge 判定 → 分支图高亮本情景走向 ── */
  function animLocality(sc) {
    var c = L.ctrl, x1 = c.x + c.w / 2;
    FLOW.RACKS.forEach(function (rk, i) {
      var b = rackBottom(i);
      var pts = [{ x: b.x, y: b.y }, { x: b.x, y: L.busY }, { x: x1, y: L.busY }, { x: x1, y: c.y + c.h }];
      var t = token('ctl', { x: pts[0].x, y: pts[0].y }, { size: 7 });
      move(t, pts, { dur: 1300, delay: 150 * i });
      pulseLink('lnk-ctl-' + (i + 1), 'is-flow', 2000);
    });
    later(function () { card('judge', true, '判定中…'); }, 400);
    later(function () { localityOverlay(sc); }, 700);
    later(function () { card('judge', true, sc.verdict); }, 1500);
  }

  function localityOverlay(sc) {
    var p = L.pool;
    var x = p.x, y = p.y - 30, w = p.w, hh = 112;
    var g = el('g', { class: 'fx-decision' }, root.tags);
    el('rect', { x: x, y: y, width: w, height: hh, rx: 2, class: 'fx-dec-box' }, g);
    el('rect', { x: x, y: y, width: 2, height: hh, fill: '#a38bf2' }, g);
    txt('局部性判定 · LOCALITY JUDGE', { x: x + 14, y: y + 20, class: 'fx-t2' }, g);
    txt('原生池水位 × 访问局部性 · 双重判定', { x: x + w - 14, y: y + 20, class: 'fx-t4', 'text-anchor': 'end', fill: '#8fa6b5' }, g);
    var qy = y + 32, qh = 34, qx = x + 16, qw = 300;
    el('rect', { x: qx, y: qy, width: qw, height: qh, rx: 2, class: 'fx-branch-q' }, g);
    txt(sc.jq || '主力访问机架是否自带 CXL 增量池？', { x: qx + 12, y: qy + 22, class: 'fx-t3' }, g);
    /* 分支：是 / 否，本情景走向（jpick）高亮 —— 判定文本随情景数据驱动 */
    var byY = qy, bnY = qy + 38, bx0 = qx + qw + 44, bw = w - (bx0 - x) - 16;
    var yesTxt = sc.jyes || ('是 · ' + sc.verdict);
    var noTxt = sc.jno || '否 · 回退原生 RDMA Pool';
    var isYes = sc.jpick !== 'no';
    el('path', { d: 'M' + (qx + qw) + ',' + (qy + qh / 2) + ' C' + (qx + qw + 28) + ',' + (qy + qh / 2) +
      ' ' + (qx + qw + 28) + ',' + (byY + 15) + ' ' + bx0 + ',' + (byY + 15),
      class: 'fx-branch-link' + (isYes ? ' is-act' : '') }, g);
    el('path', { d: 'M' + (qx + qw) + ',' + (qy + qh / 2) + ' C' + (qx + qw + 28) + ',' + (qy + qh / 2) +
      ' ' + (qx + qw + 28) + ',' + (bnY + 15) + ' ' + bx0 + ',' + (bnY + 15),
      class: 'fx-branch-link' + (!isYes ? ' is-act' : '') }, g);
    var by = el('g', { class: 'fx-branch' + (isYes ? ' is-act' : '') }, g);
    el('rect', { x: bx0, y: byY, width: bw, height: 30, rx: 2, class: 'fx-branch-b' }, by);
    txt(yesTxt, { x: bx0 + 12, y: byY + 20, class: 'fx-t4' }, by);
    var bn = el('g', { class: 'fx-branch' + (!isYes ? ' is-act' : '') }, g);
    el('rect', { x: bx0, y: bnY, width: bw, height: 30, rx: 2, class: 'fx-branch-b' }, bn);
    txt(noTxt, { x: bx0 + 12, y: bnY + 20, class: 'fx-t4' }, bn);
    txt('判定依据：' + sc.vdWhy, { x: x + 16, y: y + 106, class: 'fx-dec-f' }, g);
  }

  function animQuery(sc) {
    /* 查询发起方随情景（S1 为主力 R1；S2/S3 为溢流发起方 R2；S4 为 R1） */
    var pp = sc.prod.split('-');
    var n = nodeAnchor(pp[0], pp[1]);
    var c = L.ctrl, x1 = c.x + c.w / 2, y1 = c.y + 42 + 4 * 84 + 35;
    var q = [{ x: n.x, y: n.y }, { x: n.x, y: n.y - 42 }, { x: x1, y: n.y - 42 }, { x: x1, y: y1 }];
    var t1 = token('ctl', { x: q[0].x, y: q[0].y }, { size: 8, label: 'QUERY' });
    move(t1, q, {
      dur: 1100, onDone: function () {
        card('dir', true, sc.kv + ' -> ' + sc.dst);
        var back = q.slice().reverse();
        var t2 = token('cxl', { x: q[q.length - 1].x, y: q[q.length - 1].y }, { size: 8, label: 'HIT' });
        move(t2, back, { dur: 1100 });
      }
    });
    later(function () { card('dir', false, sc.ver || 'V1'); }, 3200);
    later(function () { drawCandidates(sc); }, 600);
    callout(rackX(rackIdxOf(pp[0])) - 10, L.rack.y - 26, '候选评估 · KV Directory + Cost Evaluator',
      '算收益，不是有硬件就选', '#91e4ff');
  }

  /* ── 候选评估链路：选中 = 主色实线；被放弃 = 灰虚线 + 叉（可开关） ── */
  function drawCandidates(sc) {
    if (!showCand || !sc.cands) return;
    var g = el('g', { class: 'fx-candset' }, root.tags);
    var pp = sc.prod.split('-');
    var from = nodeAnchor(pp[0], pp[1]);
    var rtF = rackTop(rackIdxOf(pp[0]));
    var corridor = L.fabric.y + L.fabric.h + 10;
    sc.cands.forEach(function (cd, i) {
      later(function () {
        var pts, mid, col;
        if (cd.to === 'POOL') {
          var pool = poolAnchor();
          pts = [{ x: from.x, y: from.y }, { x: rtF.x, y: rtF.y }, { x: rtF.x, y: corridor },
                 { x: pool.x + 150, y: corridor }, { x: pool.x + 150, y: pool.y - 8 }];
          mid = pointAt(pts, polyLen(pts) * .5);
          col = cd.ok ? '#f0785a' : null;
        } else if (/^R\d-X$/.test(cd.to)) {
          /* 抽象"远端 MHD"候选：指向目标机架顶部 */
          var ri = rackIdxOf(cd.to.slice(0, 2));
          var rt = rackTop(ri);
          pts = [{ x: from.x, y: from.y }, { x: rtF.x, y: rtF.y }, { x: rtF.x, y: corridor },
                 { x: rt.x, y: corridor }, { x: rt.x, y: rt.y }];
          mid = pointAt(pts, polyLen(pts) * .55);
          col = null;
        } else {
          var parts = cd.to.split('-');
          var ri2 = rackIdxOf(parts[0]), mid2 = parts[1];
          var sameRack = parts[0] === pp[0];
          if (sameRack) {
            var m = mhdAnchor(parts[0], mid2), bx = busXOf(ri2);
            pts = [{ x: from.x + 40, y: from.y }, { x: bx, y: from.y }, { x: bx, y: m.y }, { x: m.x + 26, y: m.y }];
            mid = pointAt(pts, polyLen(pts) * .45);
          } else {
            var rt2 = rackTop(ri2);
            pts = [{ x: from.x, y: from.y }, { x: rtF.x, y: rtF.y }, { x: rtF.x, y: corridor },
                   { x: rt2.x, y: corridor }, { x: rt2.x, y: rt2.y }];
            mid = pointAt(pts, polyLen(pts) * .55);
          }
          col = cd.ok ? '#53e3c4' : null;
        }
        el('path', { d: pth(pts), class: cd.ok ? 'fx-cand-acc' : 'fx-cand-rej',
          stroke: col || undefined }, g);
        if (cd.ok) {
          txt('✓ ' + cd.t + ' · 选中',
            { x: mid.x + 12, y: mid.y < 140 ? mid.y + 16 : mid.y - 10, class: 'fx-cand-lb fx-cand-lb--ok' }, g);
        } else {
          el('path', { d: 'M' + (mid.x - 6) + ',' + (mid.y - 6) + ' L' + (mid.x + 6) + ',' + (mid.y + 6) +
            ' M' + (mid.x - 6) + ',' + (mid.y + 6) + ' L' + (mid.x + 6) + ',' + (mid.y - 6), class: 'fx-cand-x' }, g);
          /* 短标签 + 按序错高，避免走廊区互相叠压；完整原因见右侧面板与 hover */
          var rjy = mid.y < 140 ? mid.y + 16 + (i % 2) * 14 : mid.y - 10;
          if (mid.x > W - 240) {
            txt('✕ ' + cd.t + ' · 放弃',
              { x: mid.x - 12, y: rjy, class: 'fx-cand-lb', 'text-anchor': 'end' }, g);
          } else {
            txt('✕ ' + cd.t + ' · 放弃',
              { x: mid.x + 12, y: rjy, class: 'fx-cand-lb' }, g);
          }
        }
      }, 250 + i * 700);
    });
  }

  function animAccess(sc) {
    var place = sc.place || 'mhd';
    var pp = sc.prod.split('-');
    var rkId0 = pp[0], ri0 = rackIdxOf(rkId0);
    var p0 = nodeAnchor(rkId0, pp[1]);
    var rt0 = rackTop(ri0);
    var pool0 = poolAnchor();
    var m1 = mhdAnchor('R1', 'MHD-1'), bx1 = busXOf(0);

    /* S2 回退原生池：纯 RDMA 访问 —— 水位未击穿时这就是最优路径 */
    if (place === 'pool') {
      pulseLink('lnk-rdma-' + (ri0 + 1), 'is-flow', 3200);
      pulseLink('lnk-pool', 'is-flow', 3200);
      var pts0 = [{ x: p0.x, y: p0.y }, { x: rt0.x, y: rt0.y }, { x: rt0.x, y: corridorY() },
                  { x: pool0.x + 160, y: corridorY() }, { x: pool0.x + 160, y: pool0.y - 8 }];
      var t0 = token('rdma', { x: pts0[0].x, y: pts0[0].y }, { size: 10, label: 'RDMA' });
      move(t0, pts0, {
        dur: 2200, onDone: function () {
          callout(pool0.x + 90, pool0.y - 40, 'RDMA 命中 · ' + sc.delay,
            '水位未击穿 · 回退原生池 · 增量硬件在场但不参与', '#f0785a');
        }
      });
      return;
    }

    /* S3 兜底借用：跨机架 RDMA 读远端 R1-MHD-1 —— 叠加代价仍优于过载原生池 */
    if (place === 'remote-mhd') {
      pulseLink('lnk-rdma-' + (ri0 + 1), 'is-flow', 3400);
      pulseLink('lnk-rdma-1', 'is-flow', 3400);
      var pts3 = [{ x: p0.x, y: p0.y }, { x: rt0.x, y: rt0.y }, { x: rt0.x, y: corridorY() },
                  { x: rackX(0) + L.rack.w / 2, y: corridorY() },
                  { x: rackX(0) + L.rack.w / 2, y: rackTop(0).y },
                  { x: bx1, y: rackTop(0).y }, { x: bx1, y: m1.y }, { x: m1.x + 26, y: m1.y }];
      var t3 = token('rdma', { x: pts3[0].x, y: pts3[0].y }, { size: 10, label: 'RDMA' });
      move(t3, pts3, {
        dur: 2400, onDone: function () {
          hl('.mhd[data-pick="R1-MHD-1"] .fx-mhd', 'is-hot', 2600);
          callout(rackX(0) - 10, L.rack.y - 26, '跨机架命中远端 MHD · ' + sc.delay,
            '兜底代价：转发 + 访存叠加 · 仍优于过载原生池 7.8 µs', '#f0785a');
        }
      });
      return;
    }

    /* S4 长期共享（copy）：两段式 ——
       第一步：一次性跨机架复制分发（浅蓝虚线，前置开销）
       第二步：R1/R3 并发读全部走机架内 CXL + R2/R4 偶发远端读对照 */
    if (place === 'copy') {
      [['R1', 'MHD-1', 0, 300], ['R3', 'MHD-3', 2, 1000]].forEach(function (cfg) {
        var rid = cfg[0], mid = cfg[1], ri = cfg[2], dl = cfg[3];
        var m2 = mhdAnchor(rid, mid), bx2 = busXOf(ri);
        var pts = [{ x: pool0.x + 150, y: pool0.y - 16 }, { x: rackX(ri) + L.rack.w / 2, y: pool0.y - 16 },
                   { x: bx2, y: m2.y }, { x: m2.x + 26, y: m2.y }];
        later(function () {
          var cp = el('path', { d: pth(pts), class: 'fx-copy-path' }, root.toks);
          later(function () { if (cp.parentNode) cp.parentNode.removeChild(cp); }, 3600);
          var t = token('copy', { x: pts[0].x, y: pts[0].y }, { size: 11, label: 'COPY ×1' });
          move(t, pts, {
            dur: 1600, keep: true, onDone: function () {
              hl('.mhd[data-pick="' + rid + '-' + mid + '"] .fx-mhd', 'is-hot', 3400);
            }
          });
        }, dl);
      });
      later(function () {
        callout(L.pool.x + 90, L.pool.y - 40, '第一步 · 一次复制分发完成', '全域托管 → 大部分读走机架内 CXL', '#8fc6f2');
      }, 2100);
      later(function () {
        [['R1', 'MHD-1'], ['R3', 'MHD-3']].forEach(function (cfg) {
          var rid = cfg[0], mid = cfg[1], ri = rackIdxOf(rid), bx2 = busXOf(ri);
          var m2 = mhdAnchor(rid, mid);
          ['N1', 'N2'].forEach(function (nid, k) {
            var n2 = nodeAnchor(rid, nid);
            later(function () {
              pulseLink('lnk-cxl-' + rid + '-' + mid, 'is-flow', 2000);
              pulseLink('lnk-cxl-' + rid + '-' + nid, 'is-flow', 2000);
              var pts = [{ x: m2.x + 26, y: m2.y }, { x: bx2, y: m2.y }, { x: bx2, y: n2.y }, { x: n2.x, y: n2.y }];
              var t = token('cxl', { x: pts[0].x, y: pts[0].y }, { size: 9 });
              move(t, pts, { dur: 900, onDone: function () {
                hl('.node[data-pick="' + rid + '-' + nid + '"] .fx-hbm', 'is-hit', 1600);
              } });
            }, k * 280);
          });
        });
        callout(rackX(0) - 6, L.rack.y - 26, '第二步 · 海量并发读 · 机架内命中',
          'R1/R3 各自读本机副本 · 不再占用 Spine', '#53e3c4');
      }, 2900);
      /* 对照：R2/R4 偶发经 RDMA 远端读 R1 副本 */
      var srcC = rackTop(1);
      var rdC = [
        { x: srcC.x, y: srcC.y },
        { x: srcC.x, y: corridorY() },
        { x: rackX(0) + L.rack.w / 2, y: corridorY() },
        { x: rackX(0) + L.rack.w / 2, y: rackTop(0).y },
        { x: bx1, y: rackTop(0).y },
        { x: bx1, y: m1.y },
        { x: m1.x + 26, y: m1.y }
      ];
      pulseLink('lnk-rdma-2', 'is-flow', 3000);
      later(function () {
        var t2 = token('rdma', { x: rdC[0].x, y: rdC[0].y }, { size: 10, label: 'RDMA' });
        move(t2, rdC, { dur: 2200 });
      }, 4300);
      later(function () {
        callout(rackX(1) - 10, L.rack.y - 26, '对照 · R2/R4 持续跨机架读',
          '无 CXL 机架经 RDMA 拉取 · Spine 拥塞动态游走', '#f0785a');
      }, 4400);
      return;
    }

    /* S1 本地命中：R1 多路并发读（兑现机架内 CXL 原生低延迟） */
    [['N1', 0], ['N2', 260], ['N1', 520], ['N2', 780]].forEach(function (cfg) {
      var nid = cfg[0], dl = cfg[1];
      later(function () {
        var n2 = nodeAnchor('R1', nid);
        pulseLink('lnk-cxl-R1-MHD-1', 'is-flow', 2200);
        pulseLink('lnk-cxl-R1-' + nid, 'is-flow', 2200);
        var pts = [{ x: m1.x + 26, y: m1.y }, { x: bx1, y: m1.y }, { x: bx1, y: n2.y }, { x: n2.x, y: n2.y }];
        var t1 = token('cxl', { x: pts[0].x, y: pts[0].y }, { size: 10, label: dl === 0 ? 'CXL' : null });
        move(t1, pts, { dur: 950, onDone: function () {
          hl('.node[data-pick="R1-' + nid + '"] .fx-hbm', 'is-hit', 1800);
        } });
      }, dl);
    });
    later(function () {
      callout(rackX(0) - 6, L.rack.y - 26, '本地命中 · ' + sc.delay,
        '大量读请求全部走机架内 CXL · 核心收益', '#53e3c4');
    }, 400);

    /* 对照：未部署 CXL 的 R2 仍须跨机架 RDMA（橙红） */
    var src = rackTop(1);
    var rd = [
      { x: src.x, y: src.y },
      { x: src.x, y: corridorY() },
      { x: rackX(0) + L.rack.w / 2, y: corridorY() },
      { x: rackX(0) + L.rack.w / 2, y: rackTop(0).y },
      { x: bx1, y: rackTop(0).y },
      { x: bx1, y: m1.y },
      { x: m1.x + 26, y: m1.y }
    ];
    pulseLink('lnk-rdma-2', 'is-flow', 3000);
    later(function () {
      var t2 = token('rdma', { x: rd[0].x, y: rd[0].y }, { size: 10, label: 'RDMA' });
      move(t2, rd, { dur: 2200 });
    }, 1200);
    callout(rackX(1) - 10, L.rack.y - 26, '对照 · R2 仍走 RDMA', 'ToR → Spine → ToR · 4.1 µs', '#f0785a');
  }

  function animMigrate(sc) {
    var place = sc.place || 'mhd';
    var pool = poolAnchor();
    var m = mhdAnchor('R1', 'MHD-1');
    var bx1 = busXOf(0);

    /* S2：水位未击穿 → 无迁移 / 无复制，数据留在原生池 */
    if (place === 'pool') {
      later(function () {
        card('place', true, 'HOLD');
        callout(pool.x + 80, pool.y - 40, '数据原地保留 · 原生池',
          '无迁移 · 无副本 · 水位未击穿不碰 CXL', '#5f9fe8');
      }, 600);
      later(function () { card('place', false, 'IDLE'); }, 3800);
      return;
    }

    /* S4（copy）：原件保留在 RDMA Pool，复制两份到 R1/R3 MHD（多读场景复制优于迁移） */
    if (place === 'copy') {
      callout(pool.x + 80, pool.y - 40, '复制 × 2', '长期托管：副本分别落入 R1 / R3 MHD', '#a38bf2');
      [['R1', 'MHD-1', 300, 0], ['R3', 'MHD-3', 1500, 2]].forEach(function (cfg) {
        var rid = cfg[0], mid = cfg[1], dl = cfg[2], ri = cfg[3];
        var m2 = mhdAnchor(rid, mid);
        var bx = busXOf(ri);
        var flowPts = [{ x: pool.x + 150, y: pool.y - 20 }, { x: rackX(ri) + L.rack.w / 2, y: pool.y - 20 }];
        later(function () {
          var cp = el('path', { d: pth(flowPts), class: 'fx-copy-path' }, root.toks);
          later(function () { if (cp.parentNode) cp.parentNode.removeChild(cp); }, 3000);
        }, dl);
        later(function () {
          pulseLink('lnk-cxl-' + rid + '-' + mid, 'is-flow', 2200);
          var pts = [{ x: pool.x + 150, y: pool.y - 20 }, { x: rackX(ri) + L.rack.w / 2, y: pool.y - 20 },
                     { x: bx, y: m2.y }, { x: m2.x + 26, y: m2.y }];
          var t = token('rep', { x: pts[0].x, y: pts[0].y }, { size: 12, label: 'COPY' });
          move(t, pts, {
            dur: 2000, keep: true, onDone: function () {
              hl('.mhd[data-pick="' + rid + '-' + mid + '"] .fx-mhd', 'is-hot', 3600);
            }
          });
        }, dl);
      });
      return;
    }

    /* 迁移路径：RDMA Pool → 目标 MHD
       S1（mhd）：热点就近迁入本机架 MHD · S3（remote-mhd）：单次溢流兜底迁入远端 MHD */
    var pts = [{ x: pool.x + 150, y: pool.y - 20 }, { x: rackX(0) + L.rack.w / 2, y: pool.y - 20 },
               { x: bx1, y: m.y }, { x: m.x + 26, y: m.y }];
    var t = token('kv', { x: pts[0].x, y: pts[0].y }, { size: 12, label: 'MOVE' });
    move(t, pts, {
      dur: 2000, onDone: function () {
        hl('.mhd[data-pick="R1-MHD-1"] .fx-mhd', 'is-hot', 4000);
        if (place === 'remote-mhd') {
          callout(m.x - 30, m.y + 40, '兜底迁移完成',
            '单次溢流 → 迁移而非复制 · 原生池压力缓释 · 版本 ' + sc.ver, '#f0785a');
        } else {
          callout(m.x - 30, m.y + 40, '迁移完成', '热点就近 · 旧位置释放 · 版本 ' + sc.ver, '#e6a056');
        }
      }
    });
    pulseLink('lnk-rdma-1', 'is-flow', 2200);
    later(function () { pulseLink('lnk-cxl-R1-MHD-1', 'is-flow', 1800); }, 1900);
  }

  function animEvict(sc) {
    var place = sc.place || 'mhd';
    var pool = poolAnchor();

    /* S2：KV 一直在 RDMA Pool，直接标记 invalid 回收 */
    if (place === 'pool') {
      var t = token('kv', { x: pool.x + 160, y: pool.y - 12 }, { size: 12, label: 'COLD' });
      later(function () { t.g.style.transition = 'opacity .9s'; t.g.setAttribute('opacity', '0'); }, 1200);
      later(function () {
        callout(pool.x + 80, pool.y - 40, '淘汰完成', 'Directory 标记 invalid · 原生池容量回收复用', '#5f9fe8');
      }, 900);
      card('place', true, 'EVICT');
      later(function () { card('place', false, 'IDLE'); }, 3400);
      return;
    }

    /* 冷 KV 从 MHD 下沉 / 迁回 RDMA Pool
       S3（remote-mhd）：原生池水位回落 → 迁回原生池，增量池让位
       S4（copy）：复用热度回落 → 先回收副本，原件下沉 */
    var m = mhdAnchor('R1', 'MHD-1');
    var pts = [{ x: m.x + 26, y: m.y }, { x: m.x + 46, y: m.y }, { x: m.x + 46, y: pool.y - 36 },
               { x: pool.x + 40, y: pool.y - 36 }];
    var t2 = token('kv', { x: pts[0].x, y: pts[0].y }, { size: 12, label: 'COLD' });
    move(t2, pts, {
      dur: 2000, keep: true, onDone: function () {
        if (place === 'remote-mhd') {
          callout(L.pool.x + 18, L.pool.y - 40, '迁回原生池',
            '原生池水位回落 · 增量池容量让位新兜底请求', '#5f9fe8');
        } else if (place === 'copy') {
          callout(L.pool.x + 18, L.pool.y - 40, '副本回收 · 原件下沉',
            '先回收 R3 副本 · 原件下沉 RDMA Pool', '#5f9fe8');
        } else {
          callout(L.pool.x + 18, L.pool.y - 40, '下沉完成', 'Directory 标记 invalid', '#5f9fe8');
        }
      }
    });
    later(function () {
      var bar = document.querySelector('[data-bar="R1-MHD-1"]');
      if (bar) { bar.style.transition = 'width 1.2s'; bar.setAttribute('width', (NODE_W - 18) * 0.24); }
      card('place', true, 'EVICT -> POOL');
    }, 600);
    later(function () { card('place', false, 'IDLE'); }, 3400);
    pulseLink('lnk-pool', 'is-flow', 2400);
    pulseLink('lnk-rdma-1', 'is-flow', 1200);
  }

  var ANIMS = {
    gen: animGen, collect: animCollect, decide: animDecide, locality: animLocality,
    query: animQuery, access: animAccess, migrate: animMigrate, evict: animEvict
  };

  function play(stage, sc, isReplay) {
    clear();
    lastPlay = { stage: stage, sc: sc };
    replaying = !!isReplay;
    curSc = sc;
    var idx = parseInt(stage.n, 10) - 1;
    if (isNaN(idx) || idx < 0) idx = 0;
    /* 原生 RDMA 池水位随情景同步（S2 余量充足 / S3 过载 —— 兜底判定的视觉前提） */
    setPoolState(sc && sc.pool);
    /* 部署等级对齐阶段起点：部署是离线一次性决策（前提已落板），
       四情景共享同一硬件前提，按 START_LEVEL 前进 */
    var deploying = !!(sc && sc.deploy && sc.deploy.length);
    var startLv = deploying ? ((FLOW.START_LEVEL && FLOW.START_LEVEL[idx] !== undefined) ? FLOW.START_LEVEL[idx] : 0) : 0;
    if (deployLv !== startLv) setDeployLevel(startLv, false);
    /* 自动模式：T1（R1+R3 同批）在 03 存储决策内动画触发；
       手动模式：交由用户点击底部部署时间轴触发。
       T2（KV 重分配）为数据行为，由 07 阶段动画呈现，无硬件变化。 */
    if (autoDeploy && deploying && stage.id === 'decide') {
      later(function () { if (deployLv < 1) setDeployLevel(1, true); }, 1400);
    }
    /* 部署型场景进入 06：点亮部署时间轴 T2（KV 重分配） */
    if (stage.id === 'migrate' && deploying && onDeployCb && !replaying) {
      later(function () { onDeployCb(2); }, 2200);
    }
    var fn = ANIMS[stage.anim.type];
    if (fn) {
      try { fn(sc, stage); } catch (e) { if (window.console) console.warn('[flow] anim error', e); }
    }
  }

  /* ── 自适应重排：宿主尺寸变化（窗口缩放 / 页面切换）→
     按 newW 重建场景并重放当前阶段，始终铺满舞台不留白 ── */
  function rebuild() {
    if (!host) return;
    clear();
    if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
    root = {};
    build();
    var lv = Math.max(0, deployLv);
    deployLv = -1;                 // 强制重建硬件（新 SVG 里没有任何 CXL 部件）
    setDeployLevel(lv, false);
    if (lastPlay) play(lastPlay.stage, lastPlay.sc, true);
  }

  var refitTimer = null;
  function maybeRefit() {
    if (!host || host.clientWidth < 140 || host.clientHeight < 140) return;
    var nw = fitW();
    if (Math.abs(nw - W) < 30) return;
    if (refitTimer) clearTimeout(refitTimer);
    refitTimer = setTimeout(function () { refitTimer = null; rebuild(); }, 200);
  }
  function watchResize() {
    if (window.ResizeObserver) {
      try { new ResizeObserver(maybeRefit).observe(host); } catch (e) { window.addEventListener('resize', maybeRefit); }
    } else {
      window.addEventListener('resize', maybeRefit);
    }
  }

  function mount(h, opts) {
    host = h;
    onSelect = (opts && opts.onSelect) || null;
    onDeployCb = (opts && opts.onDeploy) || null;
    watchResize();
    build();
    setDeployLevel(0, false);
  }

  function select(id) {
    document.querySelectorAll('.fx-rack').forEach(function (n) { n.classList.remove('is-sel'); });
    if (/^R\d/.test(String(id))) {
      var slot = root.racks[String(id).slice(0, 2)];
      if (slot && slot.g) {
        var rc = slot.g.querySelector('.fx-rack');
        if (rc) rc.classList.add('is-sel');
      }
    }
  }

  return {
    mount: mount, play: play, clear: clear, select: select,
    rackIdxOf: rackIdxOf, nodeAnchor: nodeAnchor, mhdAnchor: mhdAnchor,
    setDeployLevel: setDeployLevel, deployLevel: deployLevel,
    setAutoDeploy: function (on) { autoDeploy = !!on; },
    setShowCand: function (on) { showCand = !!on; },
    _refit: function () { maybeRefit(); }
  };
})();
