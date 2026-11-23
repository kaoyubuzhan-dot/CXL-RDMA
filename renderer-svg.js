/* ============================================================
 * renderer-svg.js — 中央 SVG 主视图（集群拓扑 / 机架内部 / 流量）
 * ============================================================ */
(function () {
  'use strict';
  const S = window.__SIM__;
  const { STATE, $, $$, esc, hotColor, loadColor, getKV, getRack, getMhd,
          mhdForRack, computeMhdUsed, cxlStats, nodeConnected, connectedNodeCount } = S;
  const C = S.D.COLORS;
  const KVS = S.D.KVS, RACKS = S.D.RACKS, LINKS = S.D.LINKS;

  // 芯片图标
  function chip(x, y, s, active, label) {
    const col = active ? C.cxl : '#7c94a3';
    let pins = '';
    for (let i = 1; i <= 3; i++) {
      const o = s / 4 * i;
      pins += `<line x1="${x+o}" y1="${y-3}" x2="${x+o}" y2="${y}" stroke="${col}" stroke-width="1" opacity=".7"/>`;
      pins += `<line x1="${x+o}" y1="${y+s}" x2="${x+o}" y2="${y+s+3}" stroke="${col}" stroke-width="1" opacity=".7"/>`;
      pins += `<line x1="${x-3}" y1="${y+o}" x2="${x}" y2="${y+o}" stroke="${col}" stroke-width="1" opacity=".7"/>`;
      pins += `<line x1="${x+s}" y1="${y+o}" x2="${x+s+3}" y2="${y+o}" stroke="${col}" stroke-width="1" opacity=".7"/>`;
    }
    return `<g>${pins}<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="2" fill="${active?'rgba(83,227,196,.10)':'rgba(124,148,163,.08)'}" stroke="${col}" stroke-width="1.3"/>
      <rect x="${x+s*.28}" y="${y+s*.28}" width="${s*.44}" height="${s*.44}" fill="none" stroke="${col}" stroke-width="1" opacity=".7"/>
      ${label?`<text x="${x+s/2}" y="${y+s+15}" text-anchor="middle" class="svg-label" font-size="15" fill="${col}">${label}</text>`:''}</g>`;
  }

  // 箭头 marker 定义
  function defs() {
    return `<defs>
      <marker id="ar-cxl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${C.cxl}"/></marker>
      <marker id="ar-rdma" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${C.rdma}"/></marker>
      <marker id="ar-pink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#e2a8c8"/></marker>
      <marker id="ar-load" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#c8d5de"/></marker>
      <linearGradient id="fabricGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(95,159,232,.04)"/><stop offset=".5" stop-color="rgba(95,159,232,.18)"/><stop offset="1" stop-color="rgba(95,159,232,.04)"/></linearGradient>
      <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;
  }

  // 顶部 Controller + Fabric
  function controllerFabric() {
    return `<g class="ctrl">
      <rect x="400" y="18" width="400" height="50" rx="24" fill="rgba(163,139,242,.07)" stroke="rgba(163,139,242,.5)" stroke-width="1.2"/>
      <text x="600" y="33" text-anchor="middle" class="svg-label" font-size="16" fill="#c9b9f5" letter-spacing="1">DEPLOYMENT CONTROLLER</text>
      <rect x="426" y="39" width="160" height="21" rx="10" fill="rgba(163,139,242,.05)" stroke="rgba(163,139,242,.3)"/>
      <text x="506" y="53" text-anchor="middle" class="svg-cn" font-size="12">拓扑监控 Topology Monitor</text>
      <rect x="614" y="39" width="160" height="21" rx="10" fill="rgba(163,139,242,.05)" stroke="rgba(163,139,242,.3)"/>
      <text x="694" y="53" text-anchor="middle" class="svg-cn" font-size="12">负载画像 Workload Profiler</text>
      <path d="M600 68 L600 92" stroke="#c9b9f5" stroke-width="1" stroke-dasharray="3 3" opacity=".6" marker-end="url(#ar-pink)"/>
      <ellipse cx="600" cy="112" rx="500" ry="26" fill="url(#fabricGrad)" stroke="rgba(95,159,232,.35)" stroke-width="1"/>
      <text x="600" y="117" text-anchor="middle" class="svg-label" font-size="20" fill="#a9cbef" letter-spacing="2">RDMA LEAF–SPINE FABRIC</text>
    </g>`;
  }

  // 单个机架（overview / traffic 用）
  function rackGroup(r, idx) {
    const x = 34 + idx * 292, y = 176, w = 258, h = 352;
    const cxl = STATE.deployment[r.id];
    const mhd = mhdForRack(r.id);
    const used = mhd ? computeMhdUsed(mhd.id) : 0;
    const sel = STATE.selectedRack === r.id;
    const stroke = sel ? (cxl ? C.cxl : C.accent) : 'rgba(167,197,215,.35)';
    let nodes = '';
    r.nodes.forEach((n, i) => {
      const nx = x + 14 + i * 61;
      const ny = y + 78;
      const nActive = nodeConnected(r.id, n.id);
      nodes += `<g class="node-box" data-node="${r.id}-${n.id}">
        <rect x="${nx}" y="${ny}" width="52" height="66" rx="3" fill="${nActive?'rgba(83,227,196,.05)':'rgba(124,148,163,.04)'}" stroke="${nActive?'rgba(83,227,196,.45)':'rgba(167,197,215,.22)'}" stroke-width="1"/>
        ${chip(nx+17, ny+8, 18, nActive)}
        <text x="${nx+26}" y="${ny+50}" text-anchor="middle" class="svg-label" font-size="14" fill="${nActive?C.cxl:'#9db0bd'}">${n.id}</text>
        <text x="${nx+26}" y="${ny+61}" text-anchor="middle" class="svg-label" font-size="11" fill="#8095a3">${n.role}</text>
      </g>`;
    });
    let mhdBox = '';
    const units = S.mhdUnitsForRack(r.id);
    const capTotal = S.rackCapacity(r.id), usedTotal = S.rackUsed(r.id);
    if (cxl && units.length === 1) {
      const m0 = units[0];
      const pct = Math.min(100, Math.round(usedTotal / m0.capacityGB * 100));
      mhdBox = `<g>
        <path d="M${x+140} ${y+152} L${x+140} ${y+176}" stroke="${C.cxl}" stroke-width="1.2" stroke-dasharray="3 2" opacity=".7"/>
        <rect x="${x+56}" y="${y+176}" width="168" height="60" rx="3" fill="rgba(83,227,196,.08)" stroke="${C.cxl}" stroke-width="1.2"/>
        <text x="${x+140}" y="${y+194}" text-anchor="middle" class="svg-label" font-size="12" fill="${C.cxl}" letter-spacing=".5">SHARED MHD · ${m0.id}</text>
        <text x="${x+140}" y="${y+208}" text-anchor="middle" class="svg-cn" font-size="11" fill="#bfe9df">${m0.capacityGB} GB · ${m0.hostInterfaces} 接口 · 已用 ${usedTotal} GB</text>
        <rect x="${x+70}" y="${y+215}" width="140" height="4" fill="rgba(167,197,215,.12)"/>
        <rect x="${x+70}" y="${y+215}" width="${140*pct/100}" height="4" fill="${C.cxl}"/>
        <text x="${x+140}" y="${y+231}" text-anchor="middle" class="svg-label" font-size="11" fill="${C.cxl}">已接入 ${connectedNodeCount(r.id)}/${m0.hostInterfaces} 节点</text>
      </g>`;
    } else if (cxl && units.length > 1) {
      // 多台 MHD：台数、单台容量与利用率逐台可见
      const rows = units.map((m, k) => {
        const ry = y + 205 + k * 11;
        const pp = m.capacityGB ? Math.round(computeMhdUsed(m.id) / m.capacityGB * 100) : 0;
        return `<text x="${x+64}" y="${ry}" class="svg-label" font-size="10" fill="${C.cxl}">${m.id}</text>`
          + `<rect x="${x+116}" y="${ry-6}" width="62" height="4" fill="rgba(167,197,215,.12)"/>`
          + `<rect x="${x+116}" y="${ry-6}" width="${62*Math.min(100, pp)/100}" height="4" fill="${C.cxl}"/>`
          + `<text x="${x+216}" y="${ry}" text-anchor="end" class="svg-label" font-size="10" fill="#bfe9df">${m.capacityGB}G</text>`;
      }).join('');
      mhdBox = `<g>
        <path d="M${x+140} ${y+152} L${x+140} ${y+176}" stroke="${C.cxl}" stroke-width="1.2" stroke-dasharray="3 2" opacity=".7"/>
        <rect x="${x+56}" y="${y+176}" width="168" height="60" rx="3" fill="rgba(83,227,196,.08)" stroke="${C.cxl}" stroke-width="1.2"/>
        <text x="${x+64}" y="${y+191}" class="svg-label" font-size="11" fill="${C.cxl}">MHD × ${units.length} · ${capTotal} GB</text>
        ${rows}
      </g>`;
    } else {
      mhdBox = `<rect x="${x+56}" y="${y+176}" width="168" height="52" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.15)" stroke-dasharray="4 3"/>
        <text x="${x+140}" y="${y+207}" text-anchor="middle" class="svg-cn" font-size="12" fill="#6c8290">无 CXL MHD · RDMA-only</text>`;
    }
    return `<g class="rack-box" data-rack="${r.id}">
      <path d="M600 138 Q600 ${y-16} ${x+w/2} ${y-6}" fill="none" stroke="#e2a8c8" stroke-width="1.2" opacity=".45" marker-end="url(#ar-pink)"/>
      <rect class="rack-rect" x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${sel?'rgba(125,201,223,.035)':'rgba(10,20,28,.5)'}" stroke="${stroke}" stroke-width="${sel?1.8:1.2}"/>
      <rect x="${x}" y="${y}" width="${w}" height="30" rx="4" fill="${cxl?'rgba(83,227,196,.06)':'rgba(95,159,232,.05)'}" stroke="none"/>
      <text x="${x+12}" y="${y+20}" class="svg-cn" font-size="18" fill="#eef4f7">${r.name}</text>
      <text x="${x+w-12}" y="${y+20}" text-anchor="end" class="svg-label" font-size="12" fill="${cxl?C.cxl:C.rdma}">${cxl?'CXL + RDMA':'RDMA-only'}</text>
      ${nodes}
      <text x="${x+14}" y="${y+162}" class="svg-label" font-size="12" fill="#6c8290">${cxl?'仅已连接节点可访问 MHD':'全部节点走 DRAM + RDMA'}</text>
      ${mhdBox}
      <rect x="${x+20}" y="${y+258}" width="${w-40}" height="34" rx="3" fill="rgba(95,159,232,.06)" stroke="rgba(95,159,232,.3)"/>
      <text x="${x+w/2}" y="${y+279}" text-anchor="middle" class="svg-label" font-size="12" fill="#a9cbef">RDMA NIC · 4 节点全接入</text>
      <text x="${x+14}" y="${y+330}" class="svg-label" font-size="13" fill="#6c8290">4 GPU NODES · ${connectedNodeCount(r.id)} CXL LINK</text>
    </g>`;
  }

  // 机架间 RDMA 链路（overview / traffic）——按距离分层绘制，线宽/颜色随流量变化
  function interLinks() {
    const baseY = 552;
    const xs = RACKS.map((_, i) => 34 + i * 292 + 129);
    let s = '';
    LINKS.forEach((l, li) => {
      const ia = RACKS.findIndex(r => r.id === l.a), ib = RACKS.findIndex(r => r.id === l.b);
      const x1 = xs[ia], x2 = xs[ib];
      const load = STATE.links[l.id];
      const col = loadColor(load);
      const isHot = load !== 'low';
      const pct = STATE.linkFlow[l.id] || 22;
      const width = +(1.2 + pct/30).toFixed(1); // 流量越大线越粗（示意）
      // 用不同高度的分层弧线避免 6 条链路重叠；向下弯，避免侵入机架主体
      const lift = 6 + li * 8;
      const d = `M${x1} ${baseY} Q${(x1+x2)/2} ${baseY + lift*2.2} ${x2} ${baseY}`;
      s += `<path d="${d}" fill="none" class="link-line" stroke="${col}" stroke-width="${width}" opacity="${0.28+pct/150}" ${isHot?'stroke-dasharray="6 4"':''} marker-end="url(#ar-load)"/>
        <text x="${(x1+x2)/2}" y="${baseY + lift*1.35 + 3}" text-anchor="middle" class="svg-label" font-size="11" fill="${col}">${l.id} ${pct}%</text>`;
    });
    RACKS.forEach((r, i) => {
      s += `<line x1="${xs[i]}" y1="${baseY-8}" x2="${xs[i]}" y2="${baseY+8}" stroke="rgba(167,197,215,.35)" stroke-width="1"/>`;
      s += `<text x="${xs[i]}" y="${baseY+22}" text-anchor="middle" class="svg-label" font-size="13" fill="#6c8290">${r.id}</text>`;
    });
    s += `<text x="600" y="${baseY+108}" text-anchor="middle" class="svg-cn" font-size="15" fill="#6c8290">机架间 RDMA 链路（线宽/颜色随流量与拥塞变化 · 示意）</text>`;
    return `<g class="inter-links">${s}</g>`;
  }

  // 访问路径动画（traffic 页）——集中绘制在机架区域（y 340~548），避免被下方面板遮挡
  function accessPaths() {
    const sel = STATE.selectedKV ? getKV(STATE.selectedKV) : null;
    if (!sel) {
      return `<text x="600" y="360" text-anchor="middle" class="svg-cn" font-size="17" fill="#6c8290">在 KV 资源页选择一个 KV，再回到此页查看其跨机架访问路径</text>`;
    }
    const xs = {}; RACKS.forEach((r,i)=> xs[r.id] = 34 + i*292 + 129);
    const locRack = sel.location.startsWith('mhd:') ? getMhd(sel.location.split(':')[1]).rackId : null;
    const hubY = 528; // 链路汇聚带（机架内 RDMA Network 行下方）
    let paths = '';
    // 存储位置标记（RDMA Pool）
    if (sel.location === 'rdma') {
      paths += `<g><rect x="500" y="500" width="200" height="26" rx="3" fill="rgba(95,159,232,.14)" stroke="${C.rdma}"/>
        <text x="600" y="517" text-anchor="middle" class="svg-cn" font-size="15" fill="#bcd8f5">${sel.id} @ RDMA Pool</text></g>`;
    }
    // 访问主体路径（从汇聚带向上指向各机架底部）
    Object.keys(sel.dist).forEach((rk) => {
      const pct = Math.round(sel.dist[rk] * 100);
      if (pct < 5) return;
      const ax = xs[rk];
      const local = (locRack === rk);
      const color = local ? C.cxl : C.rdma;
      const d = local
        ? `M${ax} ${hubY} L${ax} 470`
        : `M600 ${hubY} Q${(600+ax)/2} ${hubY-30} ${ax} 470`;
      paths += `<path d="${d}" class="link-flow flow-anim" stroke="${color}" stroke-dasharray="7 5" opacity="${0.4+pct/150}" marker-end="url(#ar-${local?'cxl':'rdma'})"/>`;
      paths += `<text x="${ax}" y="464" text-anchor="middle" class="svg-label" font-size="15" fill="${color}">${rk} ${pct}% ${local?'本地':'RDMA'}</text>`;
    });
    // 副本路径（虚线亮青）
    sel.replicas.forEach((rep) => {
      const rx = xs[rep.rackId];
      paths += `<path d="M600 ${hubY-14} Q${rx} ${hubY-40} ${rx} 478" class="link-flow flow-anim" stroke="${C.replica}" stroke-dasharray="3 4" opacity=".95" marker-end="url(#ar-cxl)"/>`;
      paths += `<text x="${rx}" y="490" text-anchor="middle" class="svg-label" font-size="13" fill="${C.replica}">REPLICA</text>`;
    });
    return paths;
  }

  // ---------- 页面渲染入口 ----------
  function renderCanvas() {
    const canvas = $('#canvas');
    if (!canvas) return;
    // kv / compare 页由 HTML 覆盖层独占中央区域，不渲染 SVG 底图（避免半透明重叠）
    if (STATE.page === 'kv' || STATE.page === 'compare') {
      canvas.innerHTML = '';
      return;
    }
    let html = defs();
    if (STATE.page === 'overview') {
      if (STATE.oview === '3d' && window.__EXTRA__) {
        html += window.__EXTRA__.renderCluster3D();
      } else {
        html += controllerFabric();
        RACKS.forEach((r, i) => html += rackGroup(r, i));
        html += interLinks();
      }
    } else if (STATE.page === 'traffic') {
      html += controllerFabric();
      RACKS.forEach((r, i) => html += rackGroup(r, i));
      html += interLinks();
      html += accessPaths();
    } else if (STATE.page === 'rack') {
      html += rackInternals();
    }
    canvas.innerHTML = html;
    bindCanvasEvents();
  }

  // 机架硬件结构解剖（具象化：立体机柜 / 服务器托盘 / GPU+HBM / DDR5 / CXL 卡 / RNIC / 共享 MHD / Leaf 交换机）
  function rackInternals() {
    const r = getRack(STATE.selectedRack) || RACKS[0];
    const other = RACKS.find(x => x.id !== r.id && STATE.deployment[x.id] !== STATE.deployment[r.id]) || RACKS[1];
    const CC = C.cxl, RR = C.rdma;

    // GPU 封装：中央 die + 四周 4 颗 HBM 堆叠（对应真实 2.5D 封装形态）
    function gpuPkg(gx, gy) {
      let hbm = '';
      [[-16,3],[40,3],[-16,21],[40,21]].forEach(([hx, hy]) => {
        hbm += `<rect x="${gx+hx}" y="${gy+hy}" width="13" height="9" rx="1" fill="rgba(95,159,232,.14)" stroke="#a9cbef" stroke-width=".8"/>`
          + `<text x="${gx+hx+6.5}" y="${gy+hy+7}" text-anchor="middle" font-size="8" fill="#a9cbef" font-family="monospace">HBM</text>`;
      });
      return `<g>${hbm}
        <rect x="${gx}" y="${gy}" width="34" height="30" rx="2" fill="rgba(95,159,232,.16)" stroke="${RR}" stroke-width="1.3"/>
        <rect x="${gx+5}" y="${gy+5}" width="24" height="20" fill="none" stroke="${RR}" stroke-width=".8" opacity=".65"/>
        <text x="${gx+17}" y="${gy+18}" text-anchor="middle" font-size="12" fill="#cfe4fa" font-family="monospace">GPU</text></g>`;
    }

    // 服务器托盘：前缘面板（型号/角色/把手/指示灯）+ 可见 PCB 上的板卡与芯片
    function tray(n, connected, x, y, rackId) {
      const w = 404;
      const roleCol = n.role === 'Prefill' ? '#cfe6f5' : '#e3d5f5';
      let s = `<g class="node-box" data-node="${rackId}-${n.id}">
        <rect x="${x}" y="${y}" width="${w}" height="17" rx="2" fill="rgba(143,167,181,.10)" stroke="rgba(143,167,181,.38)"/>
        <rect x="${x+6}" y="${y+4}" width="15" height="9" rx="1" fill="rgba(143,167,181,.2)" stroke="${C.gpu}" stroke-width=".7"/>
        <rect x="${x+w-21}" y="${y+4}" width="15" height="9" rx="1" fill="rgba(143,167,181,.2)" stroke="${C.gpu}" stroke-width=".7"/>
        <text x="${x+28}" y="${y+12.5}" class="svg-label" font-size="15" fill="#dbe7ee">${n.id}</text>
        <text x="${x+52}" y="${y+12.5}" class="svg-cn" font-size="14" fill="${roleCol}">${n.role}</text>
        <circle cx="${x+w-48}" cy="${y+8.5}" r="2.3" fill="${connected?CC:'#345'}" ${connected?'filter="url(#glow)"':''}/>
        <circle cx="${x+w-38}" cy="${y+8.5}" r="2.3" fill="${RR}" opacity=".8"/>
        <rect x="${x+4}" y="${y+19}" width="${w-8}" height="49" rx="2" fill="#0e2621" stroke="rgba(83,227,196,.2)" stroke-width="1"/>`;
      const px = x + 20, py = y + 24;
      s += gpuPkg(px, py);
      s += `<text x="${px+18}" y="${py+40}" text-anchor="middle" font-size="9" fill="#8aa0ae" font-family="monospace">GPU+HBM</text>`;
      for (let i = 0; i < 3; i++) {
        const dx0 = px + 92 + i * 11;
        s += `<rect x="${dx0}" y="${py+2}" width="6" height="34" rx="1" fill="rgba(138,160,174,.13)" stroke="#8aa0ae" stroke-width=".8"/>`
          + `<rect x="${dx0+1}" y="${py+5}" width="4" height="3" fill="#8aa0ae" opacity=".55"/>`;
      }
      s += `<text x="${px+108}" y="${py+42}" text-anchor="middle" font-size="9" fill="#8aa0ae" font-family="monospace">DDR5</text>`;
      const cx = px + 142;
      if (connected) {
        s += `<rect x="${cx}" y="${py}" width="72" height="38" rx="2" fill="rgba(83,227,196,.10)" stroke="${CC}" stroke-width="1.4"/>`
          + `<rect x="${cx+5}" y="${py+5}" width="18" height="13" rx="1" fill="rgba(83,227,196,.18)" stroke="${CC}" stroke-width=".8"/>`
          + `<text x="${cx+14}" y="${py+15}" text-anchor="middle" font-size="9" fill="#bff5e8" font-family="monospace">CTRL</text>`
          + `<rect x="${cx+28}" y="${py+5}" width="15" height="13" rx="1" fill="rgba(83,227,196,.07)" stroke="${CC}" stroke-width=".7"/>`
          + `<rect x="${cx+47}" y="${py+5}" width="15" height="13" rx="1" fill="rgba(83,227,196,.07)" stroke="${CC}" stroke-width=".7"/>`
          + `<text x="${cx+36}" y="${py+32}" text-anchor="middle" font-size="11" fill="${CC}" font-family="monospace">CXL 2.0</text>`;
      } else {
        s += `<rect x="${cx}" y="${py}" width="72" height="38" rx="2" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.2)" stroke-width="1" stroke-dasharray="3 2"/>`
          + `<text x="${cx+36}" y="${py+22}" text-anchor="middle" font-size="11" fill="#6c8290" font-family="monospace">NO CXL</text>`;
      }
      const rx0 = px + 238;
      s += `<rect x="${rx0}" y="${py+3}" width="42" height="29" rx="2" fill="rgba(95,159,232,.10)" stroke="${RR}" stroke-width="1.1"/>`
        + `<rect x="${rx0+5}" y="${py+8}" width="12" height="9" rx="1" fill="rgba(95,159,232,.2)" stroke="${RR}" stroke-width=".7"/>`
        + `<rect x="${rx0+22}" y="${py+8}" width="12" height="9" rx="1" fill="rgba(95,159,232,.2)" stroke="${RR}" stroke-width=".7"/>`
        + `<text x="${rx0+21}" y="${py+27}" text-anchor="middle" font-size="11" fill="#cfe4fa" font-family="monospace">RNIC</text></g>`;
      return s;
    }

    function leafSwitch(x, y) {
      let ports = '';
      for (let i = 0; i < 12; i++) {
        ports += `<rect x="${x+150+i*19}" y="${y+8}" width="12" height="10" rx="1" fill="rgba(95,159,232,.16)" stroke="rgba(95,159,232,.55)" stroke-width=".7"/>`;
      }
      return `<g><rect x="${x+4}" y="${y}" width="404" height="26" rx="2" fill="rgba(95,159,232,.07)" stroke="rgba(95,159,232,.42)"/>`
        + `<text x="${x+14}" y="${y+17}" class="svg-label" font-size="14" fill="#a9cbef">LEAF SW</text>`
        + `<text x="${x+66}" y="${y+17}" class="svg-cn" font-size="13" fill="#8aa0ae">200G x 32</text>${ports}</g>`;
    }

    // 共享 MHD 设备：容量条 + DRAM 颗粒阵列
    function mhdUnit(m, connCount, x, y) {
      const pct = Math.min(100, Math.round(computeMhdUsed(m.id) / m.capacityGB * 100));
      let grains = '';
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 8; col++) {
          grains += `<rect x="${x+196+col*24}" y="${y+12+row*17}" width="17" height="13" rx="1" fill="rgba(83,227,196,.09)" stroke="rgba(83,227,196,.5)" stroke-width=".7"/>`;
        }
      }
      return `<g><rect x="${x+4}" y="${y}" width="404" height="50" rx="3" fill="rgba(83,227,196,.07)" stroke="${CC}" stroke-width="1.4"/>`
        + `<text x="${x+14}" y="${y+19}" class="svg-label" font-size="15" fill="${CC}">SHARED CXL MHD</text>`
        + `<text x="${x+14}" y="${y+36}" class="svg-cn" font-size="16" fill="#dff7f0">${m.capacityGB} GB · ${connCount} 节点共享 · ${m.hostInterfaces} IF</text>`
        + `<rect x="${x+14}" y="${y+43}" width="150" height="4" fill="rgba(167,197,215,.12)"/>`
        + `<rect x="${x+14}" y="${y+43}" width="${150*pct/100}" height="4" fill="${CC}"/>`
        + `<text x="${x+172}" y="${y+47}" font-size="11" fill="${CC}" font-family="monospace">${pct}%</text>${grains}</g>`;
    }

    // 多台 MHD 汇总：逐台列出容量/利用率，右上角给合计容量与接入节点数
    function mhdMulti(units, connCount, x, y) {
      const cap = units.reduce((a, m) => a + m.capacityGB, 0);
      const used = units.reduce((a, m) => a + computeMhdUsed(m.id), 0);
      const pct = cap ? Math.min(100, Math.round(used / cap * 100)) : 0;
      let rows = '';
      units.forEach((m, k) => {
        const ry = y + 31 + k * 9;
        const pp = m.capacityGB ? Math.round(computeMhdUsed(m.id) / m.capacityGB * 100) : 0;
        rows += `<text x="${x+14}" y="${ry}" font-size="9.5" fill="#bfe9df" font-family="monospace">${m.id}</text>`
          + `<text x="${x+74}" y="${ry}" font-size="9.5" fill="#dff7f0" font-family="monospace">${m.capacityGB} GB · ${m.hostInterfaces} IF</text>`
          + `<rect x="${x+186}" y="${ry-6}" width="86" height="4" fill="rgba(167,197,215,.12)"/>`
          + `<rect x="${x+186}" y="${ry-6}" width="${86 * Math.min(100, pp) / 100}" height="4" fill="${CC}"/>`
          + `<text x="${x+278}" y="${ry}" font-size="9.5" fill="${CC}" font-family="monospace">${pp}%</text>`;
      });
      const barW = 60;
      return `<g><rect x="${x+4}" y="${y}" width="404" height="50" rx="3" fill="rgba(83,227,196,.07)" stroke="${CC}" stroke-width="1.4"/>`
        + `<text x="${x+14}" y="${y+15}" class="svg-label" font-size="13" fill="${CC}">SHARED CXL MHD × ${units.length}</text>`
        + `<text x="${x+400}" y="${y+15}" text-anchor="end" class="svg-cn" font-size="12" fill="#dff7f0">合计 ${cap} GB · ${connCount} 节点共享</text>`
        + rows
        + `<rect x="${x+320}" y="${y+30}" width="${barW}" height="5" fill="rgba(167,197,215,.12)"/>`
        + `<rect x="${x+320}" y="${y+30}" width="${barW * pct / 100}" height="5" fill="${CC}"/>`
        + `<text x="${x+392}" y="${y+44}" text-anchor="end" font-size="10" fill="#9fd9cc" font-family="monospace">池利用率 ${pct}%</text></g>`;
    }

    function pdu(x, y) {
      return `<g><rect x="${x+4}" y="${y}" width="404" height="34" rx="2" fill="rgba(143,167,181,.05)" stroke="rgba(143,167,181,.2)"/>`
        + `<text x="${x+14}" y="${y+21}" class="svg-label" font-size="13" fill="#6c8290">PDU / POWER · CABLE MANAGEMENT</text>`
        + `<text x="${x+400}" y="${y+21}" text-anchor="end" class="svg-label" font-size="13" fill="#6c8290">42U CABINET</text></g>`;
    }

    function drawRack(rr, ox, oy, isMain) {
      const c = STATE.deployment[rr.id];
      const m = mhdForRack(rr.id);
      const units = S.mhdUnitsForRack(rr.id);
      const W = 412, H = 460, DX = 40, DY = 24;
      const x = ox, y = oy;
      let s = `<g class="rack-box" data-rack="${rr.id}">`;
      // 立体机柜：顶面 + 右侧面 + 正面（浅透视）
      s += `<polygon points="${x},${y} ${x+W},${y} ${x+W+DX},${y-DY} ${x+DX},${y-DY}" fill="rgba(143,167,181,.06)" stroke="rgba(143,167,181,.24)"/>`;
      s += `<polygon points="${x+W},${y} ${x+W+DX},${y-DY} ${x+W+DX},${y+H-DY} ${x+W},${y+H}" fill="rgba(143,167,181,.045)" stroke="rgba(143,167,181,.2)"/>`;
      s += `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="3" fill="rgba(6,14,20,.78)" stroke="${isMain?(c?CC:'rgba(143,167,181,.45)'):'rgba(143,167,181,.25)'}" stroke-width="${isMain?1.7:1.1}"/>`;
      for (let u = 0; u < 19; u++) {
        s += `<line x1="${x+2}" y1="${y+10+u*22}" x2="${x+9}" y2="${y+10+u*22}" stroke="rgba(143,167,181,.16)" stroke-width=".8"/>`;
      }
      s += leafSwitch(x, y+6);
      rr.nodes.forEach((n, i) => { s += tray(n, nodeConnected(rr.id, n.id), x+4, y+40+i*78, rr.id); });
      if (c && units.length) {
        const conn = rr.nodes.filter(n => nodeConnected(rr.id, n.id));
        // 背板走线：从接入托盘右端绕到右侧走线槽再向下汇入 MHD，不穿过其他托盘正面
        conn.forEach((n, k) => {
          const idx = rr.nodes.findIndex(z => z.id === n.id);
          const ly = y + 110 + idx * 78;
          const lx = x + 384 + k * 6;
          s += `<path d="M${x+372} ${ly} L${lx} ${ly} L${lx} ${y+352}" fill="none" stroke="${CC}" stroke-width="1.4" stroke-dasharray="4 3" opacity=".72" marker-end="url(#ar-cxl)"/>`;
        });
        s += units.length === 1
          ? mhdUnit(units[0], conn.length, x+4, y+352)
          : mhdMulti(units, conn.length, x+4, y+352);
      } else {
        s += `<rect x="${x+8}" y="${y+352}" width="${W-16}" height="50" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.16)" stroke-dasharray="4 3"/>`
          + `<text x="${x+W/2}" y="${y+382}" text-anchor="middle" class="svg-cn" font-size="16" fill="#6c8290">无本地 CXL MHD · 内存访问全部经 RDMA 远程池</text>`;
      }
      s += pdu(x, y+412);
      s += `<text x="${x}" y="${y-36}" class="svg-cn" font-size="${isMain?22:18}" fill="#eef4f7">${rr.name}</text>`
        + `<text x="${x+W}" y="${y-36}" text-anchor="end" class="svg-label" font-size="${isMain?16:14}" fill="${c?CC:RR}">${c?'CXL + RDMA':'RDMA-ONLY'}</text>`
        + `<text x="${x}" y="${y-18}" class="svg-label" font-size="13" fill="#6c8290">${isMain?'SELECTED RACK · HARDWARE STRUCTURE':'COMPARISON · OPPOSITE DEPLOYMENT'}</text>`;
      return s + `</g>`;
    }

    let html = `<text x="40" y="46" class="svg-label" font-size="17" fill="#6c8290" letter-spacing="1.6">RACK ANATOMY / HARDWARE STRUCTURE</text>`
      + `<text x="1160" y="46" text-anchor="end" class="svg-cn" font-size="15" fill="#6c8290">点击机架切换主视图 · 结构为概念示意</text>`;
    html += drawRack(r, 60, 150, true);
    html += drawRack(other, 680, 150, false);
    // 硬件图例
    const legend = [[RR,'GPU + HBM 封装'], ['#8aa0ae','DDR5 内存条'], [CC,'CXL 2.0 卡 / 共享 MHD'], ['#7fb4e8','RNIC 网卡'], ['#5f9fe8','Leaf 交换机 / RDMA']];
    let lx = 60;
    html += `<g><line x1="60" y1="632" x2="1140" y2="632" stroke="rgba(167,197,215,.12)"/>`;
    legend.forEach(([col, label]) => {
      html += `<rect x="${lx}" y="650" width="11" height="11" rx="2" fill="${col}" opacity=".75"/>`
        + `<text x="${lx+17}" y="660" class="svg-cn" font-size="15" fill="#9db0bd">${label}</text>`;
      lx += 220;
    });
    html += `<text x="1140" y="690" text-anchor="end" class="svg-cn" font-size="15" fill="#6c8290">教学示意 · 硬件结构为概念简化，非厂商 CAD / 非实测</text></g>`;
    return html;
  }

  function bindCanvasEvents() {
    $$('.rack-box').forEach(g => {
      g.addEventListener('click', () => {
        S.STATE.selectedRack = g.getAttribute('data-rack');
        S.STATE.selectedKV = null;
        S.log('选中机架 ' + S.STATE.selectedRack, true);
        window.__APP__.render();
      });
    });
    $$('.node-box').forEach(g => {
      g.addEventListener('click', e => {
        e.stopPropagation();
        const id = g.getAttribute('data-node');
        toastNode(id);
      });
    });
  }
  function toastNode(id) {
    const [rk] = id.split('-');
    S.toast(id.replace('-', ' / ') + (STATE.deployment[rk] ? ' · 可查看机架部署' : ' · RDMA-only 节点'));
  }

  window.__RENDER_SVG__ = { renderCanvas, chip, rackInternals };
})();
