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
  var W = 1160, H = 760;

  var L = {
    fabric: { x: 40, y: 26, w: 1080, h: 42 },
    ctrl:   { x: 852, y: 104, w: 276, h: 476 },
    rack:   { y: 104, h: 476, w: 180, xs: [40, 242, 444, 646] },
    pool:   { x: 40, y: 640, w: 786, h: 76 },
    busY:   600
  };
  var NODE_Y = [142, 206, 270, 334], NODE_H = 58, NODE_X = 10, NODE_W = 132;
  var MHD_Y = [404, 472], MHD_H = 64;
  var CTRL_CARDS = [
    { id: 'profiler', zh: 'Workload Profiler', en: '访问局部性 / 热度画像' },
    { id: 'topo',     zh: 'Topology Monitor',  en: '节点 · CXL 可达性' },
    { id: 'place',    zh: 'Placement Controller', en: '候选位置比较 / 决策' },
    { id: 'dir',      zh: 'KV Directory',     en: '逻辑 ID → 物理位置' }
  ];

  var svg = null, host = null, root = {}, onSelect = null;
  var actors = [], raf = null, t0 = 0, timers = [];
  var curSc = null;
  /* CXL 增量部署等级：0=T0 全RDMA · 1=T1 R1部署 · 2=T2 R3部署 · 3=T3 重分配 */
  var deployLv = -1, onDeployCb = null;

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
  function busXOf(i) { return rackX(i) + NODE_X + NODE_W + 12; }

  /* ───────────── 构建静态场景 ───────────── */
  function build() {
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
    for (var i = 0; i <= 20; i++) {
      el('line', { x1: 20 + i * 57, y1: 90, x2: 20 + i * 57, y2: 730, stroke: 'rgba(120,168,189,.07)', 'stroke-width': '.6' }, g);
    }
    for (var j = 0; j <= 13; j++) {
      el('line', { x1: 20, y1: 730 - j * 47, x2: 1140, y2: 730 - j * 47, stroke: 'rgba(120,168,189,.06)', 'stroke-width': '.6' }, g);
    }
  }

  function drawFabric() {
    var f = L.fabric, g = el('g', { class: 'node-fabric', 'data-pick': 'FABRIC' }, root.boxes);
    el('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 2, class: 'fx-bar' }, g);
    for (var i = 0; i < 16; i++) {
      el('rect', { x: f.x + 300 + i * 33, y: f.y + 16, width: 24, height: 10, rx: 1.5, class: 'fx-chip' }, g);
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
        el('rect', { x: x + NODE_X + 84, y: ny + 31, width: 40, height: 18, rx: 1, class: 'fx-hbm', 'data-slot': rk.id + '-' + nd.id }, ng);
        txt('HBM', { x: x + NODE_X + 104, y: ny + 44, class: 'fx-t4', 'text-anchor': 'middle' }, ng);
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
    var deployed = (rk.id === 'R1' && lv >= 1) || (rk.id === 'R3' && lv >= 2);
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
      el('rect', { x: x + NODE_X + 9, y: my + 48, width: 114, height: 5, rx: 2, class: 'fx-bar-bg' }, mg);
      el('rect', {
        x: x + NODE_X + 9, y: my + 48, width: 114 * (mh.used / mh.cap), height: 5, rx: 2,
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
        el('rect', { x: x + NODE_X + 84, y: ny + 11, width: 32, height: 14, rx: 1, class: 'fx-pill fx-pill--cxl' }, g);
        txt('CXL', { x: x + NODE_X + 100, y: ny + 21, class: 'fx-pill-t', 'text-anchor': 'middle' }, g);
      });
      txt('CXL SW · 2 HOST PORT', { x: x + NODE_X, y: MHD_Y[1] + MHD_H + 22, class: 'fx-t4' }, g);
    }
    slot.hw = g;
    if (slot.tag) {
      slot.tag.textContent = cxlOn ? 'CXL + RDMA' : 'RDMA ONLY';
      slot.tag.style.fill = cxlOn ? '' : 'rgba(167,197,215,.4)';
    }
  }

  /* ── 部署等级切换：animate=true 时设备"长出来" ── */
  function setDeployLevel(lv, animate) {
    lv = Math.max(0, Math.min(3, lv));
    if (lv === deployLv && !animate) return;
    deployLv = lv;
    FLOW.RACKS.forEach(function (rk, ri) { applyHardware(rk, ri, lv, animate); });
    if (animate) {
      /* T1 不出卡：决策阶段已有 R1/MHD-1 候选标注卡，避免同位叠卡；
         设备生长动画 + 底部部署时间轴 + 日志已完整表达 T1 事件 */
      if (lv === 2) callout(rackX(2) + 4, 78, 'T2 · Rack 3 部署 CXL', null, '#53e3c4');
      else if (lv === 3) callout(rackX(0) + 4, 78, 'T3 · KV 重分配完成', null, '#a38bf2');
    }
    if (onDeployCb) { try { onDeployCb(lv); } catch (e) {} }
  }
  function deployLevel() { return Math.max(0, deployLv); }

  function drawPool() {
    var p = L.pool;
    var g = el('g', { class: 'pool', 'data-pick': 'POOL' }, root.boxes);
    el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 2, class: 'fx-pool' }, g);
    txt('RDMA  REMOTE  MEMORY  POOL', { x: p.x + 16, y: p.y + 24, class: 'fx-t1' }, g);
    txt('DRAM / 全闪存 · 4 TB · 仅经 RNIC + Leaf-Spine 可达', { x: p.x + 16, y: p.y + 40, class: 'fx-t3' }, g);
    txt('POOL-A', { x: p.x + p.w - 16, y: p.y + 24, class: 'fx-t2', 'text-anchor': 'end' }, g);
    txt('SLA · 4.1 µs', { x: p.x + p.w - 16, y: p.y + 40, class: 'fx-t3', 'text-anchor': 'end' }, g);
    for (var i = 0; i < 14; i++) {
      el('rect', {
        x: p.x + 16 + i * 54, y: p.y + 52, width: 44, height: 12, rx: 1,
        class: 'fx-pool-slot' + (i < 4 ? ' is-used' : '')
      }, g);
    }
  }

  function drawController() {
    var c = L.ctrl, g = el('g', { class: 'ctrl', 'data-pick': 'CTRL' }, root.boxes);
    el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 2, class: 'fx-ctrl-panel' }, g);
    txt('DEPLOYMENT CONTROLLER', { x: c.x + 14, y: c.y + 20, class: 'fx-t2' }, g);
    txt('控制平面 · 仅接收元数据', { x: c.x + 14, y: c.y + 33, class: 'fx-t4' }, g);
    root.ctrlCards = {};
    CTRL_CARDS.forEach(function (cd, i) {
      var cy = c.y + 46 + i * 110;
      var cg = el('g', { class: 'ctrl-card', 'data-card': cd.id }, g);
      el('rect', { x: c.x + 12, y: cy, width: c.w - 24, height: 92, rx: 2, class: 'fx-ctrl-card' }, cg);
      el('rect', { x: c.x + 12, y: cy, width: 2, height: 92, class: 'fx-ctrl-edge' }, cg);
      txt(cd.zh, { x: c.x + 24, y: cy + 26, class: 'fx-ctrl-t' }, cg);
      txt(cd.en, { x: c.x + 24, y: cy + 42, class: 'fx-t4' }, cg);
      var st = txt('IDLE', { x: c.x + 24, y: cy + 74, class: 'fx-ctrl-st' }, cg);
      root.ctrlCards[cd.id] = { g: cg, st: st };
      el('circle', { cx: c.x + 12, cy: cy + 46, r: 2.2, class: 'fx-dot fx-dot--ctl' }, cg);
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
    var c = { kv: '#e6a056', rep: '#a38bf2', ctl: '#e4b66b', cxl: '#53e3c4', rdma: '#5f9fe8' }[kind] || '#e6a056';
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
  function animGen(sc) {
    var p = nodeAnchor(sc.prod.split('-')[0], sc.prod.split('-')[1]);
    hl('.node[data-pick="' + sc.prod + '"] .fx-node', 'is-hot');
    hl('.node[data-pick="' + sc.prod + '"] .fx-hbm', 'is-hot');
    callout(p.x + 34, p.y - 58, sc.prod + ' · GPU HBM', 'Prefill 生成 ' + sc.kv, '#e6a056');
    for (var i = 0; i < 4; i++) {
      (function (i) {
        var sx = p.x + 14 + (i % 2) * 9, sy = p.y + 6 + Math.floor(i / 2) * 9;
        var t = token('kv', { x: sx, y: sy }, { size: 10 });
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

  function animDecide(sc) {
    card('profiler', true, '局部性 ' + sc.local + '%');
    [['R1', 'MHD-1', true], ['R3', 'MHD-3', false]].forEach(function (c, i) {
      later(function () {
        ring(c[0], true);
        card('topo', true, 'CXL 可达');
        var x = rackX(rackIdxOf(c[0]));
        callout(x + 4, L.rack.y - 46, c[0] + ' / ' + c[1],
          c[2] ? '选中 · 本地命中' : '候选 · 跨机架', c[2] ? '#53e3c4' : '#5f9fe8');
      }, 400 + i * 900);
    });
    later(function () {
      ring('R3', false);
      card('place', true, '-> ' + sc.dst);
      var p = nodeAnchor(sc.prod.split('-')[0], sc.prod.split('-')[1]);
      var m = mhdAnchor('R1', 'MHD-1');
      var bx = busXOf(0);
      var t = token('kv', { x: p.x, y: p.y }, { size: 12 });
      move(t, [{ x: p.x, y: p.y }, { x: bx, y: p.y }, { x: bx, y: m.y }, { x: m.x + 26, y: m.y }],
        { dur: 1600, keep: true });
      later(function () { hl('.mhd[data-pick="R1-MHD-1"] .fx-mhd', 'is-hot'); }, 1600);
    }, 2400);
    later(function () { card('place', false, 'PLACED'); }, 4600);
  }

  function animQuery(sc) {
    var n = nodeAnchor('R1', 'N2');
    var c = L.ctrl, x1 = c.x + c.w / 2, y1 = c.y + 46 + 3 * 110 + 46;
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
    callout(n.x - 56, n.y + 62, '逻辑 ID → 物理位置', '返回 ' + sc.dst, '#91e4ff');
  }

  function animAccess(sc) {
    var m = mhdAnchor('R1', 'MHD-1'), n = nodeAnchor('R1', 'N2');
    var bx = busXOf(0);
    var localPts = [{ x: m.x + 26, y: m.y }, { x: bx, y: m.y }, { x: bx, y: n.y }, { x: n.x, y: n.y }];
    pulseLink('lnk-cxl-R1-MHD-1', 'is-flow', 3000);
    pulseLink('lnk-cxl-R1-N2', 'is-flow', 3000);
    var t1 = token('cxl', { x: localPts[0].x, y: localPts[0].y }, { size: 10, label: 'CXL' });
    move(t1, localPts, {
      dur: 1000, onDone: function () { hl('.node[data-pick="R1-N2"] .fx-hbm', 'is-hit', 2600); }
    });

    var src = rackTop(1), dstTop = rackTop(0);
    var rd = [
      { x: src.x, y: src.y },
      { x: src.x, y: L.fabric.y + L.fabric.h + 8 },
      { x: dstTop.x, y: L.fabric.y + L.fabric.h + 8 },
      { x: dstTop.x, y: dstTop.y + 8 },
      { x: bx, y: dstTop.y + 8 },
      { x: bx, y: m.y },
      { x: m.x + 26, y: m.y }
    ];
    pulseLink('lnk-rdma-1', 'is-flow', 3000);
    pulseLink('lnk-rdma-2', 'is-flow', 3000);
    later(function () {
      var t2 = token('rdma', { x: rd[0].x, y: rd[0].y }, { size: 10, label: 'RDMA' });
      move(t2, rd, { dur: 2200 });
    }, 500);
    callout(rackX(1) - 10, L.rack.y + 66, '跨机架访问', 'ToR → Spine → ToR · ' + sc.delay, '#5f9fe8');
  }

  function animMigrate(sc) {
    var a = mhdAnchor('R3', 'MHD-3'), b = mhdAnchor('R1', 'MHD-1');
    var bx3 = busXOf(2), bx1 = busXOf(0);
    var pts = [{ x: a.x + 26, y: a.y }, { x: bx3, y: a.y }, { x: bx3, y: a.y - 56 },
               { x: bx1, y: b.y - 56 }, { x: bx1, y: b.y }, { x: b.x + 26, y: b.y }];
    var t = token('kv', { x: pts[0].x, y: pts[0].y }, { size: 12, label: 'MOVE' });
    move(t, pts, {
      dur: 2000, onDone: function () {
        hl('.mhd[data-pick="R1-MHD-1"] .fx-mhd', 'is-hot', 4000);
        callout(b.x - 46, b.y + 40, '迁移完成', '旧位置释放 · 版本 ' + sc.ver, '#e6a056');
      }
    });
    hl('.mhd[data-pick="R3-MHD-3"] .fx-mhd', 'is-cold', 5000);
    pulseLink('lnk-rdma-1', 'is-flow', 2200);
    pulseLink('lnk-rdma-3', 'is-flow', 2200);

    var s = nodeAnchor('R2', 'N3');
    var cp = [{ x: s.x, y: s.y }, { x: s.x, y: L.fabric.y + L.fabric.h + 8 },
              { x: b.x, y: L.fabric.y + L.fabric.h + 8 }, { x: b.x, y: b.y - 52 },
              { x: b.x + 26, y: b.y - 52 }];
    later(function () {
      var t2 = token('rep', { x: cp[0].x, y: cp[0].y }, { size: 12, label: 'COPY' });
      move(t2, cp, { dur: 1800, keep: true });
    }, 1900);
  }

  function animEvict(sc) {
    var m = mhdAnchor('R1', 'MHD-1');
    var pool = poolAnchor();
    var pts = [{ x: m.x + 26, y: m.y }, { x: m.x + 46, y: m.y }, { x: m.x + 46, y: pool.y - 36 },
               { x: pool.x + 40, y: pool.y - 36 }];
    var t = token('kv', { x: pts[0].x, y: pts[0].y }, { size: 12, label: 'COLD' });
    move(t, pts, {
      dur: 2000, keep: true, onDone: function () {
        callout(L.pool.x + 18, L.pool.y - 40, '下沉完成', 'Directory 标记 invalid', '#5f9fe8');
      }
    });
    later(function () {
      var bar = document.querySelector('[data-bar="R1-MHD-1"]');
      if (bar) { bar.style.transition = 'width 1.2s'; bar.setAttribute('width', 114 * 0.24); }
      card('place', true, 'EVICT -> POOL');
    }, 600);
    later(function () { card('place', false, 'IDLE'); }, 3400);
    pulseLink('lnk-pool', 'is-flow', 2400);
    pulseLink('lnk-rdma-1', 'is-flow', 1200);
  }

  var ANIMS = {
    gen: animGen, collect: animCollect, decide: animDecide, query: animQuery,
    access: animAccess, migrate: animMigrate, evict: animEvict
  };

  function play(stage, sc) {
    clear();
    curSc = sc;
    var idx = parseInt(stage.n, 10) - 1;
    if (isNaN(idx) || idx < 0) idx = 0;
    /* 部署等级对齐阶段起点（后退/跳转时同步降级或升级，不播动画） */
    var startLv = (FLOW.START_LEVEL && FLOW.START_LEVEL[idx] !== undefined) ? FLOW.START_LEVEL[idx] : 3;
    if (deployLv !== startLv) setDeployLevel(startLv, false);
    /* 阶段内增量部署动画：T1 在 03 存储决策触发，T2/T3 在 06 迁移复制触发 */
    if (stage.id === 'decide') {
      later(function () { if (deployLv < 1) setDeployLevel(1, true); }, 1400);
    } else if (stage.id === 'migrate') {
      later(function () { if (deployLv < 2) setDeployLevel(2, true); }, 1500);
      later(function () { if (deployLv < 3) setDeployLevel(3, true); }, 3300);
    }
    var fn = ANIMS[stage.anim.type];
    if (fn) {
      try { fn(sc, stage); } catch (e) { if (window.console) console.warn('[flow] anim error', e); }
    }
  }

  function mount(h, opts) {
    host = h;
    onSelect = (opts && opts.onSelect) || null;
    onDeployCb = (opts && opts.onDeploy) || null;
    build();
    setDeployLevel(0, false);
  }

  function select(id) {
    document.querySelectorAll('.fx-rack').forEach(function (n) { n.classList.remove('is-sel'); });
    if (/^R\d/.test(String(id))) {
      var g = root.racks[String(id).slice(0, 2)];
      if (g) {
        var rc = g.querySelector('.fx-rack');
        if (rc) rc.classList.add('is-sel');
      }
    }
  }

  return {
    mount: mount, play: play, clear: clear, select: select,
    rackIdxOf: rackIdxOf, nodeAnchor: nodeAnchor, mhdAnchor: mhdAnchor,
    setDeployLevel: setDeployLevel, deployLevel: deployLevel
  };
})();
