/* ============================================================
 * renderer-hardware.js — 硬件拓扑工作台（三种视角）
 *   physical : 机架正面 U 位硬件视图（服务器/CXL Switch/MHD/ToR + 端口 + 连接）
 *   network  : Leaf-Spine 网络拓扑 + 机架内 CXL/RDMA 连接 + 路径高亮
 *   threeD   : 剖切式等轴测机架（设备本体 / 内部构件 / 引线标注 / 光纤走线）
 * 所有设备形态与 U 位均为逻辑示意，非实际型号/尺寸/布线。
 * ============================================================ */
(function () {
  'use strict';
  const S = window.__SIM__;
  const { STATE, D, $, $$, esc, getRack, mhdForRack, computeMhdUsed } = S;
  const { RACKS, U_LAYOUT, CXL_SWITCH_DEFAULT, PATH_COLORS } = D;
  const C = D.COLORS;

  /* ---------- 画布级样式与滤镜：放大字号 + 金属/玻璃质感 ---------- */
  function defs() {
    return `<defs>
      <linearGradient id="hw-metal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1b2c38"/><stop offset=".45" stop-color="#101e28"/><stop offset="1" stop-color="#0a141c"/>
      </linearGradient>
      <linearGradient id="hw-metal2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#243745"/><stop offset="1" stop-color="#0d1821"/>
      </linearGradient>
      <linearGradient id="hw-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="rgba(83,227,196,.13)"/><stop offset="1" stop-color="rgba(95,159,232,.05)"/>
      </linearGradient>
      <linearGradient id="hw-top" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#2c4453"/><stop offset="1" stop-color="#172936"/>
      </linearGradient>
      <linearGradient id="hw-side" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#12222d"/><stop offset="1" stop-color="#08121a"/>
      </linearGradient>
      <linearGradient id="hw-cxl" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="rgba(83,227,196,.30)"/><stop offset="1" stop-color="rgba(83,227,196,.07)"/>
      </linearGradient>
      <linearGradient id="hw-cavity" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0a1720"/><stop offset=".5" stop-color="#060f16"/><stop offset="1" stop-color="#04090e"/>
      </linearGradient>
      <radialGradient id="hw-floor" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="rgba(83,227,196,.16)"/><stop offset="1" stop-color="rgba(83,227,196,0)"/>
      </radialGradient>
      <filter id="hw-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="hw-shadow" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity=".65"/>
      </filter>
      <pattern id="hw-vent" width="7" height="7" patternUnits="userSpaceOnUse">
        <rect width="7" height="7" fill="none"/><rect x="1" y="1" width="3" height="5" rx=".6" fill="rgba(167,197,215,.16)"/>
      </pattern>
      <style>
        .hw-h1{font:500 27px "PingFang SC","Microsoft YaHei",sans-serif;fill:#eef4f7}
        .hw-h2{font:500 20px "PingFang SC","Microsoft YaHei",sans-serif;fill:#dbe7ee}
        .hw-body{font:15px "PingFang SC","Microsoft YaHei",sans-serif;fill:#a9bdc9}
        .hw-mono{font:15px "SFMono-Regular",Consolas,monospace;fill:#c7d5de}
        .hw-micro{font:12px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em;fill:#8095a3}
        .hw-tag{font:13px "PingFang SC","Microsoft YaHei",sans-serif;fill:#8095a3}
        .hw-num{font:500 22px "SFMono-Regular",Consolas,monospace;fill:${C.cxl}}
        .hw-flow{fill:none;stroke-linecap:round;stroke-dasharray:8 7;animation:hwDash 1.1s linear infinite}
        @keyframes hwDash{to{stroke-dashoffset:-30}}
        .hw-token{offset-rotate:0deg;animation-name:hwTravel;animation-timing-function:linear;animation-iteration-count:infinite;pointer-events:none}
        @keyframes hwTravel{from{offset-distance:0%}to{offset-distance:100%}}
        .hw-led{animation:hwPulse 2.4s ease-in-out infinite}
        @keyframes hwPulse{0%,100%{opacity:.35}50%{opacity:1}}
        .hw-beat{animation:hwBeat 1.5s ease-in-out infinite}
        .hw-stage{animation:hwStage 4.2s ease-in-out infinite}
        @keyframes hwStage{0%,100%{opacity:.26}10%,26%{opacity:1}46%{opacity:.26}}
        @keyframes hwBeat{0%,100%{opacity:.22}50%{opacity:.95}}
        .hw-dev{transition:filter .18s ease}
        .hw-dev:hover{filter:brightness(1.12)}
        .hw-port{cursor:pointer}
        .hw-port:hover circle:first-of-type{filter:url(#hw-glow)}
      </style>
    </defs>`;
  }

  /* ---------- 通用原语 ---------- */
  function txt(x, y, str, cls, extra) {
    return `<text x="${x}" y="${y}" class="${cls}" ${extra || ''}>${str}</text>`;
  }
  function isActivePort(key) {
    const a = STATE.activePort;
    return !!(a && a.key === key);
  }
  // 端口圆点（放大到可点击尺寸，label 使用等宽字体）
  function port(cx, cy, key, label, color, on, active) {
    const ring = active
      ? `<circle cx="${cx}" cy="${cy}" r="12" fill="none" stroke="#fff" stroke-width="1.6" opacity=".95" filter="url(#hw-glow)"/>`
      : '';
    return `<g class="hw-port" data-port="${esc(key)}">
      ${ring}
      <circle cx="${cx}" cy="${cy}" r="8.5" fill="#07121a" stroke="${color}" stroke-width="${on ? 2 : 1.3}" ${on ? 'filter="url(#hw-glow)"' : ''}/>
      <circle cx="${cx}" cy="${cy}" r="3" fill="${on ? color : '#354853'}"/>
      ${txt(cx, cy + 4, esc(label), 'hw-micro', `text-anchor="middle" style="font-size:10px;fill:${color}"`)}
    </g>`;
  }
  // 等轴测外框（顶 / 侧 / 正面）
  function isoBox(x, y, w, h, d, stroke, frontFill, topFill, sideFill) {
    return `<path d="M${x} ${y} L${x + w} ${y} L${x + w + d} ${y - d} L${x + d} ${y - d} Z"
        fill="${topFill || 'url(#hw-top)'}" stroke="${stroke}" stroke-width="1.2"/>`
      + `<path d="M${x + w} ${y} L${x + w + d} ${y - d} L${x + w + d} ${y + h - d} L${x + w} ${y + h} Z"
        fill="${sideFill || 'url(#hw-side)'}" stroke="${stroke}" stroke-width="1.2"/>`
      + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${frontFill || 'url(#hw-metal)'}" stroke="${stroke}" stroke-width="1.6"/>`;
  }
  // 发光走线（底层光晕 + 上层流动虚线）
  function flow(d, color, w, opacity) {
    return `<path d="${d}" class="hw-path" fill="none" stroke="${color}" stroke-width="${w + 4}" opacity="${(opacity || .8) * .16}" filter="url(#hw-glow)"/>`
      + `<path d="${d}" class="hw-path" fill="none" stroke="${color}" stroke-width="${w}" opacity="${opacity || .8}"/>`
      + `<path d="${d}" class="hw-flow" fill="none" stroke="#eafff9" stroke-width="1.6" opacity=".75"/>`;
  }
  // 标注卡片（参考 MRI 的浮动技术标签 + 引线锚点）
  function callout(x, y, w, h, num, title, lines, color, ax, ay, fromRight) {
    const edgeX = fromRight ? x : x + w;
    const midY = y + h / 2;
    let body = '';
    lines.forEach((ln, i) => { body += txt(x + 16, y + 62 + i * 22, ln, 'hw-tag', `style="font-size:15px"`); });
    return `<g class="hw-callout">
      <path d="M${edgeX} ${midY} C${edgeX + (fromRight ? -70 : 70)} ${midY} ${ax + (fromRight ? 70 : -70)} ${ay} ${ax} ${ay}"
        fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="4 5" opacity=".55"/>
      <circle cx="${ax}" cy="${ay}" r="7" fill="none" stroke="${color}" stroke-width="1.4" opacity=".9"/>
      <circle cx="${ax}" cy="${ay}" r="2.6" fill="${color}"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="rgba(7,15,21,.90)" stroke="rgba(167,197,215,.26)" stroke-width="1"/>
      <rect x="${x}" y="${y}" width="4" height="${h}" fill="${color}"/>
      <circle cx="${x + 22}" cy="${y + 25}" r="12" fill="rgba(83,227,196,.10)" stroke="${color}" stroke-width="1"/>
      ${txt(x + 22, y + 30, num, 'hw-num', `text-anchor="middle" style="font-size:14px;fill:${color}"`)}
      ${txt(x + 44, y + 31, title, 'hw-h2', `style="font-size:17px;fill:${color}"`)}
      ${body}
    </g>`;
  }

  /* ============================================================
   * 视角①：42U 机架正面（放大字号 + 设备深度）
   * ============================================================ */
  function uRuler(x, y, h) {
    let s = '';
    for (let u = 42; u >= 1; u--) {
      const yy = y + (42 - u) / 42 * h, major = u % 5 === 0 || u === 42;
      s += `<line x1="${x}" y1="${yy}" x2="${x + (major ? 11 : 6)}" y2="${yy}" stroke="rgba(167,197,215,${major ? .38 : .18})" stroke-width="1"/>`;
      if (major) s += txt(x - 5, yy + 4, 'U' + u, 'hw-micro', `text-anchor="end" style="font-size:12px"`);
    }
    return s;
  }
  function serverFace(x, y, w, h, node, connected, hi) {
    const col = hi ? C.cxl : 'rgba(167,197,215,.34)';
    const cw = (w - 96) / 4;
    let gpu = '';
    for (let i = 0; i < 4; i++) {
      gpu += `<rect x="${x + 70 + i * cw}" y="${y + h / 2 - 9}" width="${cw - 6}" height="18" rx="2" fill="rgba(95,159,232,.12)" stroke="rgba(95,159,232,.38)" stroke-width="1"/>`
        + txt(x + 70 + i * cw + (cw - 6) / 2, y + h / 2 + 5, 'GPU', 'hw-micro', `text-anchor="middle" style="font-size:10px;fill:#8fb8dd"`);
    }
    const cKey = 'CXL:src:' + node.id, nKey = 'NIC:src:' + node.id;
    return `<g class="hw-dev hw-server" data-dev="server:${node.rackId}:${node.id}">
      ${isoBox(x, y, w, h, 8, col, connected ? 'rgba(83,227,196,.08)' : 'url(#hw-metal)', 'url(#hw-top)', 'url(#hw-side)')}
      <rect x="${x + 6}" y="${y + 5}" width="4" height="${h - 10}" rx="2" fill="rgba(167,197,215,.28)"/>
      <rect x="${x + w - 10}" y="${y + 5}" width="4" height="${h - 10}" rx="2" fill="rgba(167,197,215,.28)"/>
      ${txt(x + 16, y + h / 2 - 1, node.id, 'hw-h2', `style="font-size:17px;fill:#dbe7ee"`)}
      ${txt(x + 16, y + h / 2 + 16, node.role, 'hw-tag', `style="font-size:12px;fill:${node.role === 'Prefill' ? '#cfe6f5' : '#e3d5f5'}"`)}
      ${gpu}
      ${port(x + w + 13, y + h / 2 - 11, cKey, 'C', connected ? C.cxl : '#465864', connected, isActivePort(cKey))}
      ${port(x + w + 13, y + h / 2 + 12, nKey, 'R', C.rdma, true, false)}
    </g>`;
  }
  function cxlSwitchFace(x, y, w, h, rid) {
    const sw = STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT;
    const used = S.usedHostPorts(rid);
    let ports = '';
    for (let i = 1; i <= sw.hostPorts; i++) {
      const occupied = (STATE.cxlLinks[rid] || []).some(l => l.hostPort === 'H' + i);
      const key = 'H' + i + ':dst';
      ports += port(x + 52 + (i - 1) * 34, y + h - 18, key, 'H', occupied ? C.cxl : '#465864', occupied, isActivePort(key));
    }
    const mKey = 'M1:dst';
    ports += port(x + w - 26, y + h - 18, mKey, 'M', C.cxl, true, isActivePort(mKey));
    return `<g class="hw-dev hw-cxlsw" data-dev="cxlsw:${rid}">
      ${isoBox(x, y, w, h, 8, C.cxl, 'url(#hw-cxl)')}
      ${txt(x + 14, y + 20, 'CXL SWITCH', 'hw-h2', `style="font-size:16px;fill:${C.cxl};letter-spacing:.06em"`)}
      ${txt(x + 14, y + 40, `Host ${used}/${sw.hostPorts}  ·  MDP M1`, 'hw-tag', `style="font-size:13px;fill:#9fd9cc"`)}
      <rect x="${x + 14}" y="${y + h - 38}" width="${w - 50}" height="3" fill="rgba(167,197,215,.12)"/>
      ${ports}
    </g>`;
  }
  function mhdFace(x, y, w, h, mhd, rid) {
    const pct = Math.min(100, Math.round(computeMhdUsed(mhd.id) / mhd.capacityGB * 100));
    let grains = '';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) {
      grains += `<rect x="${x + 18 + c * ((w - 60) / 10)}" y="${y + 34 + r * 9}" width="${(w - 60) / 10 - 4}" height="6.5" rx="1" fill="rgba(83,227,196,.16)" stroke="rgba(83,227,196,.45)" stroke-width=".8"/>`;
    }
    let ports = '';
    for (let i = 1; i <= mhd.hostInterfaces; i++) {
      const key = 'MHD' + i + ':dst';
      const occupied = (STATE.cxlLinks[rid] || []).length > 0;
      ports += port(x + w + 13, y + 22 + (i - 1) * 24, key, 'I', occupied ? C.cxl : '#465864', occupied, isActivePort(key));
    }
    return `<g class="hw-dev hw-mhd" data-dev="mhd:${mhd.id}">
      ${isoBox(x, y, w, h, 8, C.cxl, 'rgba(83,227,196,.08)')}
      ${txt(x + 14, y + 20, 'SHARED CXL MHD', 'hw-h2', `style="font-size:16px;fill:${C.cxl}"`)}
      ${txt(x + w - 14, y + 20, mhd.capacityGB + ' GB', 'hw-mono', `text-anchor="end" style="font-size:14px;fill:#dff7f0"`)}
      ${grains}
      <rect x="${x + 18}" y="${y + h - 14}" width="${w - 48}" height="5" fill="rgba(167,197,215,.12)"/>
      <rect x="${x + 18}" y="${y + h - 14}" width="${(w - 48) * pct / 100}" height="5" fill="${C.cxl}"/>
      ${ports}
    </g>`;
  }
  // 多台 MHD 的紧凑平铺：台数、单台容量、利用率都直接可见（硬件增改即所见）
  function mhdTile(x, y, w, h, m, iso) {
    const used = computeMhdUsed(m.id);
    const pct = m.capacityGB ? Math.min(100, Math.round(used / m.capacityGB * 100)) : 0;
    const over = used > m.capacityGB;
    const col = over ? '#e8a34d' : C.cxl;
    const ultra = h < 26;            // 极窄（3 台挤在 58px 内）：只留一行 编号 + 容量
    const compact = h < 42;
    const grains = Math.max(2, Math.min(16, Math.round(m.capacityGB / 128)));
    const grainsW = w - 24;
    let g = iso
      ? isoBox(x, y, w, h, Math.min(14, Math.max(4, h / 3)), col, 'rgba(83,227,196,.07)')
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="rgba(83,227,196,.06)" stroke="${col}" stroke-width="1.3"/>`;
    if (ultra) {
      g += txt(x + 10, y + h / 2 + 4, m.id, 'hw-mono', `style="font-size:12px;fill:${col}"`)
        + txt(x + w - 12, y + h / 2 + 4, `${m.capacityGB} GB · ${pct}%`, 'hw-mono',
          `text-anchor="end" style="font-size:11px;fill:#dff7f0"`);
      return `<g class="hw-dev hw-mhd" data-dev="mhd:${m.id}" style="cursor:pointer">${g}</g>`;
    }
    const ty = y + (compact ? 14 : 19);
    g += txt(x + 10, ty, m.id, 'hw-mono', `style="font-size:${compact ? 12 : 14}px;fill:${col}"`);
    g += txt(x + w - 12, ty, `${m.capacityGB} GB · ${m.hostInterfaces} 口`, 'hw-mono',
      `text-anchor="end" style="font-size:${compact ? 11 : 13}px;fill:#dff7f0"`);
    // 容量颗粒：数量随容量档位变化（128GB → 2 格，2048GB → 16 格）
    if (h >= 36) {
      const gw = grainsW / grains;
      for (let i = 0; i < grains; i++) {
        g += `<rect x="${x + 12 + i * gw}" y="${ty + 5}" width="${Math.max(1, gw - 2)}" height="5" rx="1"
          fill="rgba(83,227,196,.22)" stroke="rgba(83,227,196,.42)" stroke-width=".6"/>`;
      }
    }
    // 利用率条
    const by = y + h - (compact ? 5 : 9);
    g += `<rect x="${x + 10}" y="${by}" width="${w - 22}" height="3" fill="rgba(167,197,215,.14)"/>`
      + `<rect x="${x + 10}" y="${by}" width="${(w - 22) * pct / 100}" height="3" fill="${col}"/>`;
    if (!compact) g += txt(x + w - 12, by - 4, `${used}/${m.capacityGB} GB`, 'hw-micro',
      `text-anchor="end" style="font-size:11px;fill:#9fd9cc"`);
    return `<g class="hw-dev hw-mhd" data-dev="mhd:${m.id}" style="cursor:pointer">${g}</g>`;
  }
  // 竖排（机架内 U 位堆叠）
  function mhdStack(x, y, w, h, units, iso) {
    const gap = 5, th = (h - gap * (units.length - 1)) / units.length;
    return units.map((m, i) => mhdTile(x, y + i * (th + gap), w, th, m, iso)).join('');
  }
  // 横排（等轴测机架内的设备层）
  function mhdSlabs(x, y, w, h, units) {
    const gap = 6, tw = (w - gap * (units.length - 1)) / units.length;
    return units.map((m, i) => mhdTile(x + i * (tw + gap), y, tw, h, m, true)).join('');
  }
  function torFace(x, y, w, h, rid) {
    let leds = '';
    for (let i = 0; i < 10; i++) leds += `<rect x="${x + 20 + i * ((w - 60) / 10)}" y="${y + h / 2 - 4}" width="${(w - 60) / 10 - 4}" height="8" rx="1" fill="rgba(95,159,232,.22)" stroke="rgba(95,159,232,.55)" stroke-width=".8"/>`;
    return `<g class="hw-dev hw-tor" data-dev="tor:${rid}">
      ${isoBox(x, y, w, h, 8, 'rgba(95,159,232,.6)', 'rgba(95,159,232,.08)')}
      ${txt(x + 12, y + 18, 'RDMA ToR / LEAF', 'hw-h2', `style="font-size:14px;fill:#a9cbef"`)}
      ${leds}
    </g>`;
  }
  function cxlConnLines(x, y, w, h, rid) {
    const sw = STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT;
    const swY = y + (42 - U_LAYOUT.cxlSw.from) / 42 * h;
    const swH = Math.max((U_LAYOUT.cxlSw.from - U_LAYOUT.cxlSw.to + 1) / 42 * h, 40);
    const mhdY = y + (42 - U_LAYOUT.mhd.from) / 42 * h;
    let s = '';
    (STATE.cxlLinks[rid] || []).forEach(l => {
      const n = U_LAYOUT.server.find(sv => sv.node === l.node); if (!n) return;
      const ny = y + (42 - n.from) / 42 * h, nh = Math.max((n.from - n.to + 1) / 42 * h, 30);
      const hx = x + 52 + (parseInt(l.hostPort.slice(1)) - 1) * 34;
      s += flow(`M${x + w + 14} ${ny + nh / 2 - 11} C${x + w + 62} ${ny + nh / 2 - 11} ${hx + 22} ${swY + swH - 18} ${hx} ${swY + swH - 18}`, C.cxl, 1.8, .85);
    });
    if ((STATE.cxlLinks[rid] || []).length) {
      s += flow(`M${x + w - 26} ${swY + swH - 18} C${x + w + 70} ${swY + swH + 40} ${x + w + 20} ${mhdY + 22} ${x + w + 14} ${mhdY + 22}`, C.cxl, 2.2, .9);
    }
    return s;
  }
  function rdmaConnLines(x, y, w, h, rid) {
    const torY = y + (42 - U_LAYOUT.tor.from) / 42 * h, torH = (U_LAYOUT.tor.from - U_LAYOUT.tor.to + 1) / 42 * h;
    let s = '';
    U_LAYOUT.server.forEach(n => {
      const ny = y + (42 - n.from) / 42 * h, nh = Math.max((n.from - n.to + 1) / 42 * h, 30);
      s += `<path d="M${x + w + 14} ${ny + nh / 2 + 12} C${x + w + 46} ${ny + nh / 2 + 12} ${x + w + 46} ${torY + torH} ${x + w - 36} ${torY + torH}" fill="none" stroke="rgba(95,159,232,.5)" stroke-width="1.4" stroke-dasharray="5 5"/>`;
    });
    return s;
  }
  function physicalSide(x, y, cxl, mhd, rid) {
    const sw = STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT, used = S.usedHostPorts(rid);
    const units = S.mhdUnitsForRack(rid);
    const reach = [...new Set(units.flatMap(u => S.mhdReachableHosts(u.id)))];
    const links = STATE.cxlLinks[rid] || [];
    const cap = S.rackCapacity(rid), usedCap = S.rackUsed(rid);
    const w = 480;
    let s = `<g><rect x="${x}" y="${y}" width="${w}" height="420" rx="5" fill="rgba(9,18,24,.72)" stroke="rgba(167,197,215,.24)"/>`
      + txt(x + 18, y + 32, 'CXL 物理连接 / PORT MAPPING', 'hw-h2', `style="font-size:17px;fill:${C.cxl}"`)
      + `<line x1="${x + 18}" y1="${y + 44}" x2="${x + w - 18}" y2="${y + 44}" stroke="rgba(167,197,215,.16)"/>`
      + txt(x + 18, y + 74, 'Host Port 数（决定可接主机数）', 'hw-body', `style="font-size:14px"`)
      + txt(x + w - 18, y + 74, used + ' / ' + sw.hostPorts, 'hw-num', `text-anchor="end" style="font-size:19px"`)
      + `<rect x="${x + 18}" y="${y + 84}" width="${w - 36}" height="5" fill="rgba(167,197,215,.12)"/>`
      + `<rect x="${x + 18}" y="${y + 84}" width="${(w - 36) * Math.min(1, used / sw.hostPorts)}" height="5" fill="${C.cxl}"/>`
      + txt(x + 18, y + 120, `MHD 设备 ${units.length} 台 · 共享池容量`, 'hw-body', `style="font-size:14px"`)
      + txt(x + w - 18, y + 120, units.length ? `${usedCap} / ${cap} GB` : '—', 'hw-mono', `text-anchor="end" style="font-size:14px;fill:${C.cxl}"`)
      + txt(x + 18, y + 152, `共享访问主机：${reach.length} 台 —— 同一机架内多台 MHD 汇聚为一个共享池`, 'hw-tag', `style="font-size:13px;fill:#8aa0ae"`)
      + txt(x + 18, y + 178, 'RDMA ToR：4 台服务器 NIC 默认全部接入（存量集群）', 'hw-tag', `style="font-size:13px;fill:${C.rdma}"`)
      + `<line x1="${x + 18}" y1="${y + 196}" x2="${x + w - 18}" y2="${y + 196}" stroke="rgba(167,197,215,.16)"/>`
      + txt(x + 18, y + 224, '端口级连接清单', 'hw-body', `style="font-size:14px;fill:#dbe7ee"`);
    if (!links.length) {
      s += txt(x + 18, y + 254, '尚未建立 CXL 物理连接 —— 点击下方端口开始：', 'hw-tag', `style="font-size:13px;fill:#8aa0ae"`)
        + txt(x + 18, y + 280, '① 点服务器右侧 C 口  ② 点 CXL Switch 空闲 H 口', 'hw-tag', `style="font-size:13px;fill:#8aa0ae"`);
    } else {
      links.forEach((l, i) => {
        const yy = y + 254 + i * 24;
        s += txt(x + 18, yy, l.node, 'hw-mono', `style="font-size:14px;fill:#cfe4fa"`)
          + txt(x + 120, yy, l.hostPort, 'hw-mono', `style="font-size:14px;fill:${C.cxl}"`)
          + txt(x + 200, yy, '→', 'hw-body', `style="font-size:14px;fill:#6c8290"`)
          + txt(x + 246, yy, l.mdpPort, 'hw-mono', `style="font-size:14px;fill:${C.cxl}"`)
          + txt(x + 320, yy, '→', 'hw-body', `style="font-size:14px;fill:#6c8290"`)
          + txt(x + 366, yy, l.mhdId, 'hw-mono', `style="font-size:14px;fill:${C.cxl}"`);
      });
    }
    s += `<line x1="${x + 18}" y1="${y + 330}" x2="${x + w - 18}" y2="${y + 330}" stroke="rgba(167,197,215,.16)"/>`
      + txt(x + 18, y + 358, '操作提示', 'hw-body', `style="font-size:14px;fill:#dbe7ee"`)
      + txt(x + 18, y + 384, '· 点服务器 C 口 → 点 H 口：建立 CXL 接入', 'hw-tag', `style="font-size:13px;fill:#8aa0ae"`)
      + txt(x + 18, y + 408, '· 点已连接的 C 口：断开该节点 CXL 接入', 'hw-tag', `style="font-size:13px;fill:#8aa0ae"`)
      + `</g>`;
    return s;
  }
  function renderPhysical() {
    const r = getRack(STATE.selectedRack) || RACKS[0];
    const rid = r.id, cxl = STATE.deployment[rid], mhd = mhdForRack(rid);
    const x = 130, y = 88, w = 420, h = 540, u2y = u => y + (42 - u) / 42 * h;
    let s = defs()
      + txt(36, 48, 'VIEW 01 / PHYSICAL RACK FRONT · ' + r.name, 'hw-micro', `style="font-size:15px;fill:#6c8290;letter-spacing:.1em"`)
      + txt(1164, 48, 'U 位与设备形态为逻辑示意 · 非实际尺寸/型号', 'hw-tag', `text-anchor="end" style="font-size:13px;fill:#6c8290"`);
    s += `<rect x="${x - 20}" y="${y - 18}" width="${w + 44}" height="${h + 36}" rx="7" fill="rgba(10,20,28,.66)" stroke="rgba(167,197,215,.3)" stroke-width="1.6"/>`
      + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(6,14,20,.72)" stroke="rgba(167,197,215,.2)"/>`
      + uRuler(x - 16, y, h);
    s += txt(x + w + 24, y - 30, cxl ? 'CXL + RDMA' : 'RDMA-ONLY', 'hw-mono', `text-anchor="end" style="font-size:14px;fill:${cxl ? C.cxl : C.rdma}"`);
    const torY = u2y(U_LAYOUT.tor.from), torH = Math.max((U_LAYOUT.tor.from - U_LAYOUT.tor.to + 1) / 42 * h, 34);
    s += torFace(x + 18, torY, w - 62, torH, rid);
    const swY = u2y(U_LAYOUT.cxlSw.from), swH = Math.max((U_LAYOUT.cxlSw.from - U_LAYOUT.cxlSw.to + 1) / 42 * h, 46);
    if (cxl) s += cxlSwitchFace(x + 18, swY, w - 62, swH, rid);
    else s += `<rect x="${x + 18}" y="${swY}" width="${w - 62}" height="${swH}" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.18)" stroke-dasharray="5 4"/>`
      + txt(x + 18 + (w - 62) / 2, swY + 28, '无 CXL Switch · RDMA-only', 'hw-tag', `text-anchor="middle" style="font-size:14px;fill:#6c8290"`);
    U_LAYOUT.server.forEach(n => {
      const ny = u2y(n.from), nh = Math.max((n.from - n.to + 1) / 42 * h, 34);
      const node = { rackId: rid, id: n.node, role: r.nodes.find(z => z.id === n.node).role };
      const hi = STATE.pathHighlight && STATE.pathHighlight.nodeId === n.node && STATE.pathHighlight.rackId === rid;
      s += serverFace(x + 18, ny, w - 62, nh, node, S.nodeConnected(rid, n.node), hi);
    });
    const mhdY = u2y(U_LAYOUT.mhd.from), mhdH = Math.max((U_LAYOUT.mhd.from - U_LAYOUT.mhd.to + 1) / 42 * h, 58);
    const units = S.mhdUnitsForRack(rid);
    if (cxl && units.length === 1) s += mhdFace(x + 18, mhdY, w - 62, mhdH, units[0], rid);
    else if (cxl && units.length > 1) s += mhdStack(x + 18, mhdY, w - 62, mhdH, units, false);
    else if (!cxl || !units.length) s += `<rect x="${x + 18}" y="${mhdY}" width="${w - 62}" height="${mhdH}" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.18)" stroke-dasharray="5 4"/>`
      + txt(x + 18 + (w - 62) / 2, mhdY + 32, '无共享 MHD', 'hw-tag', `text-anchor="middle" style="font-size:14px;fill:#6c8290"`);
    const spY = u2y(U_LAYOUT.spare.from), spH = (U_LAYOUT.spare.from - U_LAYOUT.spare.to + 1) / 42 * h;
    s += `<rect x="${x + 18}" y="${spY}" width="${w - 62}" height="${spH}" rx="3" fill="rgba(124,148,163,.025)" stroke="rgba(167,197,215,.14)"/>`
      + txt(x + 18 + (w - 62) / 2, spY + spH / 2 + 5, '预留 U8–U1 / PDU', 'hw-micro', `text-anchor="middle" style="font-size:13px;fill:#556873"`);
    s += rdmaConnLines(x + 18, y, w - 62, h, rid);
    if (cxl) s += cxlConnLines(x + 18, y, w - 62, h, rid);
    s += physicalSide(x + w + 78, y + 20, cxl, mhd, rid);
    return s;
  }

  /* ============================================================
   * 视角②：Leaf–Spine 网络拓扑（放大 + 设备细节）
   * ============================================================ */
  function renderNetwork() {
    let s = defs()
      + txt(36, 48, 'VIEW 02 / RDMA LEAF–SPINE + IN-RACK CXL', 'hw-micro', `style="font-size:15px;fill:#6c8290;letter-spacing:.1em"`)
      + txt(1164, 48, '点击服务器高亮 RDMA 路径 · 点击 MHD 高亮可访问主机', 'hw-tag', `text-anchor="end" style="font-size:13px;fill:#6c8290"`);
    const spineY = 82;
    s += `<rect x="450" y="${spineY}" width="300" height="46" rx="22" fill="rgba(95,159,232,.12)" stroke="${C.rdma}" stroke-width="1.6" filter="url(#hw-shadow)"/>`
      + txt(600, spineY + 29, 'SPINE SWITCHES', 'hw-h2', `text-anchor="middle" style="font-size:18px;fill:#bcd8f5;letter-spacing:.08em"`);
    const cols = [165, 455, 745, 1035];
    RACKS.forEach((r, i) => {
      const cx = cols[i], rid = r.id, cxl = STATE.deployment[rid], mhd = mhdForRack(rid);
      const leafY = 202;
      s += `<path d="M${cx} ${leafY} Q${cx} 140 600 ${spineY + 46}" fill="none" stroke="rgba(95,159,232,.5)" stroke-width="2"/>`;
      s += `<rect x="${cx - 112}" y="${leafY - 30}" width="224" height="500" rx="6" fill="rgba(10,20,28,.58)" stroke="${cxl ? C.cxl : 'rgba(167,197,215,.28)'}" stroke-width="1.4"/>`
        + txt(cx - 100, leafY - 8, r.name, 'hw-h2', `style="font-size:16px;fill:#eef4f7"`)
        + txt(cx + 100, leafY - 8, cxl ? 'CXL+RDMA' : 'RDMA', 'hw-micro', `text-anchor="end" style="font-size:12px;fill:${cxl ? C.cxl : C.rdma}"`);
      s += `<rect x="${cx - 78}" y="${leafY}" width="156" height="34" rx="3" fill="rgba(95,159,232,.1)" stroke="${C.rdma}" stroke-width="1.4"/>`
        + txt(cx, leafY + 23, 'ToR / Leaf', 'hw-mono', `text-anchor="middle" style="font-size:14px;fill:#bcd8f5"`);
      const sy = 258;
      r.nodes.forEach((n, k) => {
        const yy = sy + k * 60;
        const conn = S.nodeConnected(rid, n.id);
        const hi = STATE.pathHighlight && STATE.pathHighlight.rackId === rid && STATE.pathHighlight.nodeId === n.id;
        s += `<path d="M${cx} ${leafY + 34} L${cx} ${yy + 18}" stroke="${hi ? C.cxl : 'rgba(95,159,232,.36)'}" stroke-width="${hi ? 2.6 : 1.4}" ${hi ? 'stroke-dasharray="6 4"' : ''}/>`;
        s += `<g class="hw-dev hw-server" data-dev="server:${rid}:${n.id}" style="cursor:pointer">`
          + `<rect x="${cx - 70}" y="${yy}" width="140" height="36" rx="3" fill="${hi ? 'rgba(83,227,196,.14)' : 'url(#hw-metal)'}" stroke="${hi ? C.cxl : 'rgba(167,197,215,.32)'}" stroke-width="${hi ? 2 : 1.2}"/>`
          + `<rect x="${cx - 64}" y="${yy + 6}" width="58" height="24" fill="url(#hw-vent)"/>`
          + txt(cx + 62, yy + 17, n.id, 'hw-mono', `text-anchor="end" style="font-size:14px;fill:#dbe7ee"`)
          + txt(cx + 62, yy + 31, n.role, 'hw-tag', `text-anchor="end" style="font-size:11px;fill:#8aa0ae"`)
          + txt(cx - 60, yy + 32, conn ? 'CXL' : 'RDMA', 'hw-micro', `style="font-size:11px;fill:${conn ? C.cxl : C.rdma}"`)
          + `</g>`;
      });
      if (cxl && mhd) {
        const swY = sy + 4 * 60 + 18;
        const links = STATE.cxlLinks[rid] || [];
        links.forEach(l => {
          const k = r.nodes.findIndex(z => z.id === l.node);
          const yy = sy + k * 60 + 34;
          s += `<path d="M${cx - 36} ${yy} Q${cx - 100} ${yy + 26} ${cx - 36} ${swY}" fill="none" stroke="${C.cxl}" stroke-width="1.6" stroke-dasharray="5 4" opacity=".8"/>`;
        });
        const mhY = swY + 78;
        const units = S.mhdUnitsForRack(rid);
        const cap = S.rackCapacity(rid);
        s += `<rect x="${cx - 78}" y="${swY}" width="156" height="34" rx="3" fill="url(#hw-cxl)" stroke="${C.cxl}" stroke-width="1.4"/>`
          + txt(cx, swY + 23, `CXL Switch · ${links.length}/${(STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT).hostPorts} HP`, 'hw-mono', `text-anchor="middle" style="font-size:13px;fill:#bfe9df"`);
        s += `<path d="M${cx} ${swY + 34} L${cx} ${mhY}" stroke="${C.cxl}" stroke-width="2.2" opacity=".85"/>`;
        const hiMhd = STATE.pathHighlight && units.some(u => u.id === STATE.pathHighlight.mhdId);
        const first = units[0] ? units[0].id : '';
        s += `<g class="hw-dev hw-mhd" data-dev="mhd:${first}" style="cursor:pointer">`
          + `<rect x="${cx - 78}" y="${mhY}" width="156" height="60" rx="3" fill="${hiMhd ? 'rgba(83,227,196,.2)' : 'rgba(83,227,196,.08)'}" stroke="${C.cxl}" stroke-width="${hiMhd ? 2.4 : 1.4}"/>`
          + txt(cx, mhY + 17, `MHD × ${units.length} · ${cap} GB`, 'hw-mono', `text-anchor="middle" style="font-size:13px;fill:${C.cxl}"`);
        units.forEach((u, k) => {
          const uu = computeMhdUsed(u.id), pp = u.capacityGB ? Math.round(uu / u.capacityGB * 100) : 0;
          const ry = mhY + 28 + k * 11;
          s += txt(cx - 66, ry, u.id, 'hw-micro', `style="font-size:10px;fill:#bfe9df"`)
            + `<rect x="${cx - 8}" y="${ry - 6}" width="52" height="4" fill="rgba(167,197,215,.14)"/>`
            + `<rect x="${cx - 8}" y="${ry - 6}" width="${52 * Math.min(100, pp) / 100}" height="4" fill="${C.cxl}"/>`
            + txt(cx + 72, ry, u.capacityGB + 'G', 'hw-micro', `text-anchor="end" style="font-size:10px;fill:#bfe9df"`);
        });
        s += `</g>`;
      } else {
        s += `<rect x="${cx - 78}" y="${sy + 4 * 60 + 18}" width="156" height="48" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.18)" stroke-dasharray="5 4"/>`
          + txt(cx, sy + 4 * 60 + 48, '无 CXL Switch / MHD', 'hw-tag', `text-anchor="middle" style="font-size:13px;fill:#6c8290"`);
      }
    });
    return s;
  }

  /* ============================================================
   * 视角③：剖切式等轴测机架（主视觉）
   * ============================================================ */
  function heroServer(x, y, w, h, node, connected, hi) {
    const col = hi ? C.cxl : (connected ? 'rgba(83,227,196,.62)' : 'rgba(167,197,215,.34)');
    const cKey = 'CXL:src:' + node.id, nKey = 'NIC:src:' + node.id;
    const gpuW = (w - 190) / 4;
    let gpu = '';
    for (let i = 0; i < 4; i++) {
      gpu += `<rect x="${x + 122 + i * gpuW}" y="${y + 10}" width="${gpuW - 6}" height="${h - 20}" rx="2" fill="rgba(95,159,232,.14)" stroke="rgba(95,159,232,.42)" stroke-width="1"/>`
        + `<rect x="${x + 125 + i * gpuW}" y="${y + 14}" width="${gpuW - 12}" height="5" fill="rgba(95,159,232,.28)"/>`
        + `<rect x="${x + 125 + i * gpuW}" y="${y + h - 19}" width="${gpuW - 12}" height="4" fill="rgba(95,159,232,.20)"/>`
        + txt(x + 122 + i * gpuW + (gpuW - 6) / 2, y + h / 2 + 5, 'GPU', 'hw-micro', `text-anchor="middle" style="font-size:11px;fill:#8fb8dd"`);
    }
    return `<g class="hw-dev hw-server" data-dev="server:${node.rackId}:${node.id}">
      ${isoBox(x, y, w, h, 18, col, connected ? 'rgba(83,227,196,.10)' : 'url(#hw-metal2)')}
      <rect x="${x + 8}" y="${y + 6}" width="5" height="${h - 12}" rx="2" fill="rgba(167,197,215,.26)"/>
      <rect x="${x + w - 13}" y="${y + 6}" width="5" height="${h - 12}" rx="2" fill="rgba(167,197,215,.26)"/>
      ${txt(x + 22, y + h / 2 - 3, node.id, 'hw-h1', `style="font-size:21px;fill:#eaf3f8"`)}
      ${txt(x + 22, y + h / 2 + 17, node.role, 'hw-tag', `style="font-size:12px;fill:${node.role === 'Prefill' ? '#cfe6f5' : '#e3d5f5'}"`)}
      <rect x="${x + 94}" y="${y + 8}" width="22" height="${h - 16}" fill="url(#hw-vent)"/>
      ${gpu}
      <circle cx="${x + w - 36}" cy="${y + 9}" r="3" fill="${connected ? C.cxl : '#546673'}"/>
      ${port(x + w + 22, y + h / 2 - 11, cKey, 'C', connected ? C.cxl : '#465864', connected, isActivePort(cKey))}
      ${port(x + w + 22, y + h / 2 + 12, nKey, 'R', C.rdma, true, false)}
    </g>`;
  }
  function heroSwitch(x, y, w, h, rid) {
    const sw = STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT;
    const used = S.usedHostPorts(rid);
    let ports = '';
    for (let i = 1; i <= sw.hostPorts; i++) {
      const occupied = (STATE.cxlLinks[rid] || []).some(l => l.hostPort === 'H' + i);
      const key = 'H' + i + ':dst';
      ports += port(x + 54 + (i - 1) * 42, y + h - 10, key, 'H', occupied ? C.cxl : '#465864', occupied, isActivePort(key));
    }
    ports += port(x + w - 26, y + h - 10, 'M1:dst', 'M', C.cxl, true, isActivePort('M1:dst'));
    return `<g class="hw-dev hw-cxlsw" data-dev="cxlsw:${rid}">
      ${isoBox(x, y, w, h, 18, C.cxl, 'url(#hw-cxl)')}
      ${txt(x + 18, y + 20, 'CXL SWITCH', 'hw-h2', `style="font-size:17px;fill:${C.cxl};letter-spacing:.06em"`)}
      ${txt(x + 18, y + 36, `Host ${used}/${sw.hostPorts}  ·  MDP M1`, 'hw-tag', `style="font-size:13px;fill:#9fd9cc"`)}
      ${ports}
    </g>`;
  }
  function heroMhd(x, y, w, h, mhd, rid) {
    const pct = Math.min(100, Math.round(computeMhdUsed(mhd.id) / mhd.capacityGB * 100));
    let dimms = '';
    for (let i = 0; i < 12; i++) {
      const dx = x + 20 + i * ((w - 56) / 12);
      dimms += `<rect x="${dx}" y="${y + 30}" width="${(w - 56) / 12 - 4}" height="24" rx="1" fill="rgba(83,227,196,.18)" stroke="rgba(83,227,196,.5)" stroke-width="1"/>`
        + `<rect x="${dx + 2}" y="${y + 34}" width="${(w - 56) / 12 - 8}" height="4" fill="rgba(83,227,196,.45)"/>`
        + `<rect x="${dx + 2}" y="${y + 47}" width="${(w - 56) / 12 - 8}" height="4" fill="rgba(83,227,196,.3)"/>`;
    }
    return `<g class="hw-dev hw-mhd" data-dev="mhd:${mhd.id}">
      ${isoBox(x, y, w, h, 18, C.cxl, 'rgba(83,227,196,.10)')}
      ${txt(x + 18, y + 20, 'SHARED CXL MHD', 'hw-h2', `style="font-size:16px;fill:${C.cxl}"`)}
      ${txt(x + w - 18, y + 20, mhd.capacityGB + ' GB', 'hw-mono', `text-anchor="end" style="font-size:14px;fill:#dff7f0"`)}
      ${dimms}
      <rect x="${x + 20}" y="${y + h - 10}" width="${w - 56}" height="4" fill="rgba(167,197,215,.14)"/>
      <rect x="${x + 20}" y="${y + h - 10}" width="${(w - 56) * pct / 100}" height="4" fill="${C.cxl}"/>
      ${port(x + w + 22, y + h / 2, 'MHD1:dst', 'I', C.cxl, (STATE.cxlLinks[rid] || []).length > 0, isActivePort('MHD1:dst'))}
    </g>`;
  }
  /* ============================================================
   * 视角③ 3D 剖切专用构件：器件化底盘 + 运行态数据流（可暂停）
   * 说明：形态为逻辑示意，非厂商 CAD；时延数字取自 PERF_MODEL（示意量级）
   * ============================================================ */
  const PM3 = D.PERF_MODEL || { cxlLocalNs: 340, rdmaNs: 2100 };
  function ns3(v) {
    if (!v && v !== 0) return '—';
    return v >= 1000 ? (v / 1000).toFixed(2) + ' µs' : Math.round(v) + ' ns';
  }
  // 小号可点击端口（3D 里省空间，保留 data-port 供原有交互复用）
  function miniPort(cx, cy, key, color, on) {
    const active = isActivePort(key);
    return `<g class="hw-port" data-port="${esc(key)}" style="cursor:pointer">
      ${active ? `<circle cx="${cx}" cy="${cy}" r="9.5" fill="none" stroke="#ffffff" stroke-width="1.3" opacity=".85"/>` : ''}
      <circle cx="${cx}" cy="${cy}" r="5.6" fill="#06111a" stroke="${on ? color : '#3a4c58'}" stroke-width="${on ? 1.8 : 1.1}" ${on ? 'filter="url(#hw-glow)"' : ''}/>
      <circle cx="${cx}" cy="${cy}" r="2.2" fill="${on ? color : '#2f3f4a'}"/>
    </g>`;
  }
  function led3(x, y, on, color) {
    return `<g class="${on ? 'hw-led' : ''}">
      <circle cx="${x}" cy="${y}" r="4.8" fill="${on ? color : '#22323d'}" opacity=".28" filter="url(#hw-glow)"/>
      <circle cx="${x}" cy="${y}" r="2.3" fill="${on ? color : '#33454f'}"/></g>`;
  }
  // 数据流动光点（CSS offset-path 驱动，随"暂停"一起停）
  function token(d, color, dur, delay, r) {
    return `<circle r="${r || 3.6}" fill="${color}" opacity=".95" filter="url(#hw-glow)" class="hw-token"
      style="offset-path:path('${d}');animation-duration:${dur}s;animation-delay:${delay || 0}s"/>`;
  }
  // GPU 服务器：抽屉式 2U 机箱 + 角色徽标 + GPU 阵列呼吸 + C/R 双端口
  function srv3d(x, y, w, h, n, connected, hi, rid, idx) {
    const col = hi ? C.cxl : (connected ? 'rgba(83,227,196,.55)' : 'rgba(167,197,215,.30)');
    const cKey = 'CXL:src:' + n.id, nKey = 'NIC:src:' + n.id;
    const pw = Math.round((w - 116) / 4);
    let gpu = '';
    for (let i = 0; i < 4; i++) {
      const gx = x + 108 + i * pw;
      gpu += `<rect x="${gx}" y="${y + 12}" width="${pw - 5}" height="${h - 22}" rx="2" fill="rgba(95,159,232,.10)" stroke="rgba(95,159,232,.34)" stroke-width=".9"/>`
        + `<rect class="hw-beat" x="${gx + 3}" y="${y + 15}" width="${(pw - 11) * .62}" height="3" rx="1.5" fill="rgba(143,184,221,.55)" style="animation-delay:${(idx * 0.18 + i * 0.12).toFixed(2)}s"/>`
        + txt(gx + (pw - 5) / 2, y + h / 2 + 4, 'GPU', 'hw-micro', `text-anchor="middle" style="font-size:8px;fill:#7fa6c9"`);
    }
    return `<g class="hw-dev hw-server" data-dev="server:${rid}:${n.id}" style="cursor:pointer">
      ${isoBox(x, y, w, h, 9, col, connected ? 'rgba(83,227,196,.07)' : 'url(#hw-metal2)')}
      <rect x="${x + 5}" y="${y + 4}" width="${w - 10}" height="${h - 8}" rx="2" fill="rgba(5,12,18,.50)" stroke="rgba(167,197,215,.10)"/>
      ${led3(x + 14, y + h / 2, true, connected ? C.cxl : '#e6a056')}
      ${txt(x + 26, y + h / 2 + 1, n.id, 'hw-h2', `style="font-size:15px;fill:#e3edf3"`)}
      <rect x="${x + 60}" y="${y + 9}" width="46" height="14" rx="2" fill="${n.role === 'Prefill' ? 'rgba(95,159,232,.18)' : 'rgba(163,139,242,.18)'}" stroke="${n.role === 'Prefill' ? 'rgba(95,159,232,.6)' : 'rgba(163,139,242,.6)'}" stroke-width=".8"/>
      ${txt(x + 83, y + 19, n.role === 'Prefill' ? 'PREFILL' : 'DECODE', 'hw-micro', `text-anchor="middle" style="font-size:7.5px;letter-spacing:.12em;fill:${n.role === 'Prefill' ? '#bcd8f5' : '#cfc4f7'}"`)}
      ${gpu}
      ${miniPort(x + w + 14, y + h / 2 - 9, cKey, C.cxl, connected)}
      ${miniPort(x + w + 14, y + h / 2 + 9, nKey, C.rdma, true)}
    </g>`;
  }
  // CXL Switch：端口矩阵 + 常亮/呼吸 LED
  function switch3d(x, y, w, h, rid) {
    const sw = STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT;
    const used = S.usedHostPorts(rid);
    const links = STATE.cxlLinks[rid] || [];
    let ports = '';
    for (let i = 1; i <= sw.hostPorts; i++) {
      const on = links.some(l => l.hostPort === 'H' + i);
      ports += miniPort(x + 34 + (i - 1) * 20, y + h - 13, 'H' + i + ':dst', C.cxl, on);
    }
    return `<g class="hw-dev hw-cxlsw" data-dev="cxlsw:${rid}">
      ${isoBox(x, y, w, h, 10, C.cxl, 'url(#hw-cxl)')}
      ${txt(x + 14, y + 19, 'CXL SWITCH', 'hw-h2', `style="font-size:14px;fill:${C.cxl};letter-spacing:.08em"`)}
      ${txt(x + 14, y + 33, `Host ${used}/${sw.hostPorts} · MDP M1 · 共享总线`, 'hw-tag', `style="font-size:10px;fill:#9fd9cc"`)}
      <rect x="${x + 14}" y="${y + h - 34}" width="${w - 42}" height="3" fill="rgba(167,197,215,.10)"/>
      ${ports}
      ${miniPort(x + w + 16, y + h / 2, 'M1:dst', C.cxl, !!links.length)}
    </g>`;
  }
  // Shared MHD：单台详版 / 多台堆叠（容量颗粒 + 利用率 + 热态）
  function mhd3d(x, y, w, h, units, rid) {
    let s = '';
    if (units.length === 1) {
      const m = units[0];
      const used = computeMhdUsed(m.id), ratio = m.capacityGB ? used / m.capacityGB : 0;
      const cells = Math.max(10, Math.min(16, Math.round(m.capacityGB / 128)));
      const litCells = Math.round(cells * Math.min(1, ratio));
      const hot = ratio > .8;
      let dimm = '';
      for (let i = 0; i < cells; i++) {
        const dx = x + 16 + i * ((w - 48) / cells);
        const on = i < litCells;
        dimm += `<rect x="${dx}" y="${y + 40}" width="${(w - 48) / cells - 3.5}" height="${h - 62}" rx="1.5"
            fill="${on ? (hot ? 'rgba(230,160,86,.34)' : 'rgba(83,227,196,.30)') : 'rgba(167,197,215,.06)'}"
            stroke="${on ? (hot ? '#e6a056' : C.cxl) : 'rgba(167,197,215,.20)'}" stroke-width=".8"/>`
          + (on ? `<rect class="hw-beat" x="${dx + 2}" y="${y + 44}" width="${(w - 48) / cells - 7.5}" height="2.6" fill="${hot ? '#e6a056' : C.cxl}" opacity=".9" style="animation-delay:${(i * 0.1).toFixed(2)}s"/>` : '');
      }
      s += `<g class="hw-dev hw-mhd" data-dev="mhd:${m.id}" style="cursor:pointer">
        ${isoBox(x, y, w, h, 14, C.cxl, 'rgba(83,227,196,.09)')}
        ${txt(x + 16, y + 18, 'SHARED CXL MHD', 'hw-h2', `style="font-size:13px;fill:${C.cxl};letter-spacing:.08em"`)}
        ${txt(x + 16, y + 32, `${m.id} · ${used} / ${m.capacityGB} GB（${Math.round(ratio * 100)}%）`, 'hw-mono', `style="font-size:10px;fill:#cdeee6"`)}
        ${txt(x + w - 14, y + 18, m.capacityGB + ' GB', 'hw-mono', `text-anchor="end" style="font-size:12px;fill:#dff7f0"`)}
        ${dimm}
        <rect x="${x + 16}" y="${y + h - 14}" width="${w - 46}" height="4" rx="2" fill="rgba(167,197,215,.12)"/>
        <rect x="${x + 16}" y="${y + h - 14}" width="${(w - 46) * Math.min(1, ratio)}" height="4" rx="2" fill="${hot ? '#e6a056' : C.cxl}"/>
        ${(() => { let p = ''; for (let i = 1; i <= (m.hostInterfaces || 2); i++) p += miniPort(x + w + 14, y + 22 + (i - 1) * 18, 'MHD' + i + ':dst', C.cxl, true); return p; })()}
      </g>`;
    } else {
      const rowH = Math.max(15, Math.floor((h - 10) / units.length));
      s += `<g class="hw-dev hw-mhd" data-dev="mhd:${units[0].id}" style="cursor:pointer">`;
      units.forEach((m, i) => {
        const ry = y + i * (rowH + 1);
        const used = computeMhdUsed(m.id), ratio = m.capacityGB ? used / m.capacityGB : 0;
        const hot = ratio > .8;
        s += `${isoBox(x, ry, w, rowH, 8, hot ? '#e6a056' : C.cxl, 'rgba(83,227,196,.07)')}
          ${led3(x + 11, ry + rowH / 2, true, hot ? '#e6a056' : C.cxl)}
          ${txt(x + 20, ry + rowH / 2 + 3.5, m.id, 'hw-mono', `style="font-size:9.5px;fill:#dff7f0"`)}
          ${txt(x + 74, ry + rowH / 2 + 3.5, `${m.capacityGB}G`, 'hw-mono', `style="font-size:9px;fill:#9fd9cc"`)}
          <rect x="${x + 108}" y="${ry + rowH / 2 - 3}" width="${w - 132}" height="6" rx="3" fill="rgba(167,197,215,.10)"/>
          <rect x="${x + 108}" y="${ry + rowH / 2 - 3}" width="${(w - 132) * Math.min(1, ratio)}" height="6" rx="3" fill="${hot ? '#e6a056' : C.cxl}"/>
          ${txt(x + w - 8, ry + rowH / 2 + 3.5, Math.round(ratio * 100) + '%', 'hw-mono', `text-anchor="end" style="font-size:9px;fill:${hot ? '#f0c08a' : '#bfeee2'}"`)}`;
      });
      s += `</g>`;
    }
    return s;
  }
  // ToR：Leaf 交换机 + 12 口阵列 + 上行
  function tor3d(x, y, w, h) {
    let p = '';
    for (let i = 0; i < 12; i++) {
      const px = x + 74 + i * ((w - 96) / 12);
      p += `<rect class="${i % 3 === 0 ? 'hw-led' : ''}" x="${px}" y="${y + 10}" width="${(w - 96) / 12 - 4}" height="${h - 20}" rx="1.5"
        fill="rgba(95,159,232,${i % 3 === 0 ? .28 : .12})" stroke="rgba(95,159,232,.45)" stroke-width=".7" style="animation-delay:${(i * 0.15).toFixed(2)}s"/>`;
    }
    return `<g class="hw-dev hw-tor" data-dev="tor">
      ${isoBox(x, y, w, h, 12, 'rgba(95,159,232,.55)', 'url(#hw-metal2)')}
      ${txt(x + 14, y + h / 2 + 4, 'ToR', 'hw-h2', `style="font-size:12px;fill:#cfe0f5"`)}
      ${txt(x + 44, y + h / 2 + 4, '400G LEAF', 'hw-micro', `style="font-size:8px;fill:#8fb8dd"`)}
      ${p}
    </g>`;
  }

  /* ---------- 视角③：等轴测剖切机柜 + 运行态数据流 ---------- */
  function renderThreeD() {
    const r = getRack(STATE.selectedRack) || RACKS[0];
    const rid = r.id, cxl = STATE.deployment[rid];
    const units = S.mhdUnitsForRack(rid);
    const sw = STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT;
    const links = STATE.cxlLinks[rid] || [];
    const used = S.usedHostPorts(rid);
    const capTotal = S.rackCapacity(rid), usedTotal = S.rackUsed(rid);
    const tilt = Math.sin((STATE.rot3d || 0) * Math.PI / 180) * 5;

    /* ---- 几何基准（画布 1200 × 720） ---- */
    const RX = 368, RY = 142, RW = 396, RH = 446, RD = 54;
    const inX = RX + 16, devW = RW - 66;
    const px = inX + devW + 14;              // 器件端口列
    const cxlX = RX + RW + 16, rdmaX = RX + RW + 40;
    const torY = RY + 18, torH = 26;
    const swX = inX, swY = RY + 52, swH = 54, swW = devW;
    const srvY = [RY + 116, RY + 168, RY + 220, RY + 272];
    const mhdY = RY + 322, mhH = 74, mhW = devW;
    const pduY = RY + 404;

    let s = defs()
      + txt(30, 42, 'VIEW 03 / RUNNING CUTAWAY · ' + r.name, 'hw-micro', `style="font-size:13px;fill:#7d93a2;letter-spacing:.12em"`)
      ;

    // 运行态指示（呼吸点）
    s += `<g class="hw-led"><circle cx="606" cy="38" r="5" fill="${C.cxl}" opacity=".9" filter="url(#hw-glow)"/></g>`
      + txt(618, 42, 'LIVE · KV 读写数据流', 'hw-micro', `style="font-size:10px;fill:${C.cxl};letter-spacing:.12em"`);

    /* ---- 地面透视网格 + 机柜落影（营造纵深） ---- */
    s += `<g opacity=".20">`;
    for (let i = 0; i < 14; i++) s += `<line x1="${56 + i * 82}" y1="626" x2="${56 + i * 82 + 150}" y2="512" stroke="#2f4c5c" stroke-width=".7"/>`;
    for (let i = 0; i < 9; i++) s += `<line x1="56" y1="${626 - i * 14}" x2="1160" y2="${626 - i * 14}" stroke="#2f4c5c" stroke-width=".55"/>`;
    s += `</g>`;
    s += `<ellipse cx="${RX + RW / 2 + RD / 2}" cy="${RY + RH + 22}" rx="${RW / 2 + 96}" ry="24" fill="url(#hw-floor)"/>`;

    /* ---- 顶面 Spine Fabric ---- */
    s += `<g class="hw-dev"><rect x="494" y="56" width="212" height="26" rx="13" fill="rgba(95,159,232,.10)" stroke="${C.rdma}" stroke-width="1.3"/>`
      + txt(600, 74, 'RDMA SPINE FABRIC', 'hw-mono', `text-anchor="middle" style="font-size:12px;fill:#c3dcf6;letter-spacing:.08em"`)
      + `<circle cx="510" cy="69" r="3.6" fill="${C.rdma}" class="hw-led"/></g>`;

    s += `<g transform="rotate(${tilt.toFixed(2)},600,368)">`;

    /* ---- 机柜本体：外壳 / 内腔 / U 标尺 / 理线槽 ---- */
    s += `<rect x="${RX - 12}" y="${RY - 12}" width="${RW + RD + 26}" height="${RH + 26}" rx="10" fill="rgba(3,8,13,.68)" filter="url(#hw-shadow)"/>`;
    s += isoBox(RX, RY, RW, RH, RD, cxl ? C.cxl : C.rdma, 'url(#hw-glass)', 'url(#hw-top)', 'url(#hw-side)');
    // 内腔
    s += `<rect x="${inX - 4}" y="${RY + 8}" width="${devW + 24}" height="${RH - 16}" rx="3" fill="url(#hw-cavity)" stroke="rgba(167,197,215,.10)"/>`;
    // U 标尺（每 4U 一格，带微标签）
    for (let u = 42; u >= 2; u -= 2) {
      const yy = RY + 10 + (42 - u) / 42 * (RH - 20);
      s += `<line x1="${inX - 4}" y1="${yy}" x2="${inX + 2}" y2="${yy}" stroke="rgba(167,197,215,${u % 6 === 0 ? .34 : .14})" stroke-width="1"/>`;
    }
    // 右侧理线槽
    s += `<rect x="${RX + RW + 6}" y="${RY + 12}" width="${RD - 14}" height="${RH - 24}" rx="3" fill="rgba(6,14,20,.5)" stroke="rgba(167,197,215,.14)"/>`;
    for (let k = 0; k < 10; k++) {
      const yy = RY + 40 + k * 40;
      s += `<path d="M${RX + RW + 12} ${yy} q6 8 14 0" fill="none" stroke="rgba(167,197,215,.16)" stroke-width="1"/>`;
    }
    // 四角高亮（帮观众认机柜轮廓）
    const cxlCol = cxl ? C.cxl : C.rdma;
    s += `<path d="M${RX} ${RY + 26} L${RX} ${RY} L${RX + 26} ${RY}" fill="none" stroke="${cxlCol}" stroke-width="2.2"/>`
      + `<path d="M${RX + RW} ${RY + RH - 26} L${RX + RW} ${RY + RH} L${RX + RW - 26} ${RY + RH}" fill="none" stroke="${cxlCol}" stroke-width="2.2"/>`
      + txt(RX - 6, RY - 16, '42U · RACK ' + rid.slice(1), 'hw-micro', `style="font-size:11px;fill:${cxlCol};letter-spacing:.1em"`)
      + txt(RX + RW + RD - 6, RY - RD - 8, 'CUTAWAY / ISO', 'hw-micro', `text-anchor="end" style="font-size:10px;fill:#6c8290"`);

    /* ---- ToR ---- */
    s += tor3d(inX, torY, devW, torH);
    s += `<path d="M${600} ${torY - 2} L600 84" fill="none" stroke="${C.rdma}" stroke-width="1.6" stroke-dasharray="4 4" opacity=".7"/>`;
    s += token(`M600 ${torY} L600 84`, C.rdma, 2.0, 0, 3.0);

    /* ---- CXL Switch ---- */
    if (cxl) {
      s += switch3d(swX, swY, swW, swH, rid);
      // Switch → MHD 的 MDP 总线
      const smx = swX + swW + 16, smy = swY + swH / 2;
      const mhx = mhW + inX + 14, mhy = mhdY + Math.min(mhH - 20, 26);
      s += flow(`M${smx} ${smy} C${smx + 30} ${smy} ${smx + 30} ${mhy} ${mhx} ${mhy}`, C.cxl, 2, .9);
      s += token(`M${smx} ${smy} C${smx + 30} ${smy} ${smx + 30} ${mhy} ${mhx} ${mhy}`, '#eafff9', 2.2, 0, 3.2);
      s += txt(smx + 5, smy - 11, 'MDP', 'hw-micro', `style="font-size:9px;fill:#8fd8cc"`);
    } else {
      s += `<rect x="${swX}" y="${swY}" width="${swW}" height="${swH}" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.16)" stroke-dasharray="6 5"/>`
        + txt(swX + swW / 2, swY + swH / 2 + 4, '无 CXL Switch · RDMA-ONLY', 'hw-tag', `text-anchor="middle" style="font-size:12px;fill:#6c8290"`);
    }

    /* ---- 4 台 GPU 服务器 + 背板式 CXL/RDMA 走线（两条竖总线 + 水平支线） ---- */
    const cxlBusX = RX + RW + 20, rdmaBusX = RX + RW + 44;
    const busBotY = srvY[3] + 26;
    // RDMA 总线：ToR 右侧 → 下引到 N4
    const rdmaBus = `M${inX + devW - 30} ${torY + torH} Q${rdmaBusX} ${torY + torH + 10} ${rdmaBusX} ${torY + torH + 34} L${rdmaBusX} ${busBotY + 6}`;
    s += `<path d="${rdmaBus}" fill="none" stroke="rgba(95,159,232,.42)" stroke-width="1.3" stroke-dasharray="4 4"/>`;
    s += token(rdmaBus, C.rdma, 4.0, 0, 3.0);
    // CXL 总线：Switch MDP → 竖向下引到 N4
    let cxlBus = '';
    if (cxl && links.length) {
      const smx = swX + swW + 16, smy = swY + swH / 2;
      cxlBus = `M${smx} ${smy} L${cxlBusX} ${smy} L${cxlBusX} ${busBotY}`;
      s += flow(cxlBus, C.cxl, 1.9, .95);
      s += token(cxlBus, '#eafff9', 3.0, 0, 3.2);
    }
    r.nodes.forEach((n, k) => {
      const sy = srvY[k];
      const hi = STATE.pathHighlight && STATE.pathHighlight.nodeId === n.id && STATE.pathHighlight.rackId === rid;
      s += srv3d(inX, sy, devW, 38, { rackId: rid, id: n.id, role: n.role }, S.nodeConnected(rid, n.id), hi, rid, k);
      const link = links.find(l => l.node === n.id);
      // RDMA 支线（R 口 → 蓝色总线）
      const rdStub = `M${px} ${sy + 27} L${rdmaBusX - 3} ${sy + 27}`;
      s += `<path d="${rdStub}" fill="none" stroke="${hi ? C.rdma : 'rgba(95,159,232,.30)'}" stroke-width="${hi ? 2 : 1.1}" stroke-dasharray="3 3"/>`
        + `<circle cx="${rdmaBusX - 3}" cy="${sy + 27}" r="2.4" fill="rgba(95,159,232,.75)"/>`;
      if (hi) s += token(rdStub, C.rdma, 1.8, 0, 2.8);
      // CXL 支线（C 口 → 青色总线）
      if (link) {
        const cxStub = `M${px} ${sy + 10} L${cxlBusX - 3} ${sy + 10}`;
        s += flow(cxStub, C.cxl, 1.8, .9)
          + `<circle cx="${cxlBusX - 3}" cy="${sy + 10}" r="2.6" fill="${C.cxl}" opacity=".9"/>`;
      }
    });
    // 一写一读两条全长路径（多轮复用的因果可视化）
    if (cxl && units.length) {
      const smx = swX + swW + 16, smy = swY + swH / 2;
      const mhx = mhW + inX + 14, mhy = mhdY + Math.min(mhH - 20, 26);
      const kk = Math.max(0, r.nodes.findIndex(n => links.some(l => l.node === n.id)));
      const kd = Math.max(0, r.nodes.findIndex((n, i) => i > kk && links.some(l => l.node === n.id)));
      const syW = srvY[kk] + 10, syR = srvY[kd] + 10;
      const wr = `M${px} ${syW} L${cxlBusX} ${syW} L${cxlBusX} ${smy} L${smx} ${smy} C${smx + 30} ${smy} ${smx + 30} ${mhy} ${mhx} ${mhy}`;
      const rd = `M${mhx} ${mhy} C${smx + 30} ${mhy} ${smx + 30} ${smy} ${smx} ${smy} L${cxlBusX} ${smy} L${cxlBusX} ${syR} L${px} ${syR}`;
      s += `<path d="${wr}" fill="none" stroke="${C.cxl}" stroke-width="1.1" opacity=".34"/>`
        + `<path d="${rd}" fill="none" stroke="${C.cxl}" stroke-width="1.1" opacity=".22"/>`
        + token(wr, '#eafff9', 4.6, 0, 3.4) + token(wr, C.cxl, 3.2, -1.5, 3.4)
        + token(rd, '#bfe8ff', 4.2, 0, 3.8) + token(rd, C.cxl, 3.0, -1.7, 3.8)
    }
    if (cxl && links.length) {
      const lx = RX + RW + 52, ly = srvY[0] - 2;
      s += `<rect x="${lx - 11}" y="${ly - 8}" width="3" height="3" rx="1.2" fill="${C.cxl}"/>`
        + txt(lx, ly, `KV 读命中 ${ns3(PM3.cxlLocalNs)}`, 'hw-micro', `style="font-size:8.5px;fill:${C.cxl}"`)
        + `<rect x="${lx - 11}" y="${ly + 12}" width="3" height="3" rx="1.2" fill="${C.rdma}"/>`
        + txt(lx, ly + 20, `跨机架 ${ns3(PM3.rdmaNs)}`, 'hw-micro', `style="font-size:8.5px;fill:#8fb8dd"`);
    }
        /* ---- Shared MHD ---- */
    if (cxl && units.length) {
      s += mhd3d(inX, mhdY, mhW, mhH, units, rid);
      // 命中率标注
      const m = S.computeMetrics();
      s += txt(inX + 8, mhdY + mhH + 14, `命中率 ${Math.round((m.localRate || 0) * 100)}% · 合计 ${capTotal} GB / 已用 ${usedTotal} GB`, 'hw-micro', `style="font-size:9.5px;fill:#8fd8cc"`);
    } else {
      s += `<rect x="${inX}" y="${mhdY}" width="${mhW}" height="${mhH}" rx="3" fill="rgba(124,148,163,.03)" stroke="rgba(167,197,215,.16)" stroke-dasharray="6 5"/>`
        + txt(inX + mhW / 2, mhdY + mhH / 2 + 2, '无共享 MHD · KV 全走 RDMA', 'hw-tag', `text-anchor="middle" style="font-size:12px;fill:#6c8290"`);
    }

    /* ---- PDU ---- */
    s += isoBox(inX, pduY, devW, 22, 6, 'rgba(167,197,215,.22)', 'url(#hw-metal)');
    s += `</g>`;

    /* ---- 引线标注 ---- */
    s += callout(28, 112, 246, 94, '01', 'GPU SERVER', [
      `N1–N4 · Prefill / Decode`
    ], C.rdma, inX + 150, srvY[1] + 19, false);
    s += callout(28, 250, 246, 94, '02', 'CXL SWITCH', [
      `Host ${used}/${sw.hostPorts} · MDP M1`
    ], C.cxl, swX + 120, swY + swH - 12, false);
    s += callout(28, 388, 246, 94, '03', 'SHARED MHD', [
      units.length ? `${units.length} 台 · ${capTotal} GB` : '未部署'
    ], C.cxl, inX + 130, mhdY + 30, false);
    s += callout(930, 112, 240, 94, '04', 'RDMA ToR', [
      '400G · 跨机架 KV'
    ], C.rdma, RX + RW + 6, torY + torH / 2, true);

    /* ---- 图例 ---- */
    const lgY = 618;
    s += `<g class="hw-legend">`
      + `<line x1="30" y1="${lgY}" x2="70" y2="${lgY}" stroke="${C.cxl}" stroke-width="2"/>`
      + txt(78, lgY + 4, 'CXL 机架内路径', 'hw-tag', `style="font-size:10px;fill:#9fd9cc"`)
      + `<line x1="188" y1="${lgY}" x2="228" y2="${lgY}" stroke="${C.rdma}" stroke-width="2" stroke-dasharray="4 4"/>`
      + txt(236, lgY + 4, 'RDMA 跨机架路径', 'hw-tag', `style="font-size:10px;fill:#a9cbf0"`)
      + `<circle cx="356" cy="${lgY - 1}" r="3.8" fill="#eafff9" filter="url(#hw-glow)"/>`
      + txt(368, lgY + 4, 'KV 读写数据光点', 'hw-tag', `style="font-size:10px;fill:#dfeaf0"`)
      + `</g>`;

    /* ---- 机架切换器 ---- */
    s += `<rect x="430" y="662" width="340" height="38" rx="5" fill="rgba(7,15,21,.84)" stroke="rgba(167,197,215,.20)"/>`;
    RACKS.forEach((rk, i) => {
      const bx = 442 + i * 82, on = rk.id === rid;
      s += `<g class="rack-switch" data-rack-switch="${rk.id}" style="cursor:pointer">`
        + `<rect x="${bx}" y="671" width="76" height="21" rx="3" fill="${on ? 'rgba(83,227,196,.16)' : 'rgba(167,197,215,.04)'}" stroke="${on ? C.cxl : 'rgba(167,197,215,.20)'}"/>`
        + txt(bx + 38, 685, rk.id, 'hw-mono', `text-anchor="middle" style="font-size:11px;fill:${on ? C.cxl : '#9db0bd'}"`)
        + `</g>`;
    });
    s += txt(1170, 685, `ISO VIEW · ROTATE ${(STATE.rot3d || 0)}°`, 'hw-micro', `text-anchor="end" style="font-size:10px;fill:#6c8290"`);
    return s;
  }

  /* ---------- 主入口与事件绑定 ---------- */
  function renderHardware() {
    const svg = $('#canvas'); if (!svg) return;
    let html = '';
    if (STATE.hwView === 'network') html = renderNetwork();
    else if (STATE.hwView === 'threeD') html = renderThreeD();
    else if (STATE.hwView === 'pipeline' && window.__EXTRA__) html = window.__EXTRA__.renderPipeline();
    else html = renderPhysical();
    svg.innerHTML = html;
    bindEvents();
  }
  function bindEvents() {
    $$('.hw-port').forEach(g => g.addEventListener('click', e => {
      e.stopPropagation();
      if (window.__APP__ && window.__APP__.hwPortClick) window.__APP__.hwPortClick(g.getAttribute('data-port'));
    }));
    $$('.hw-server[data-dev]').forEach(g => g.addEventListener('click', e => {
      const parts = g.getAttribute('data-dev').split(':');
      if (window.__APP__ && window.__APP__.hwHighlightRDMA) window.__APP__.hwHighlightRDMA(parts[1], parts[2]);
    }));
    $$('.hw-mhd[data-dev]').forEach(g => g.addEventListener('click', e => {
      const mhdId = g.getAttribute('data-dev').split(':')[1];
      if (window.__APP__ && window.__APP__.hwHighlightMHD) window.__APP__.hwHighlightMHD(mhdId);
    }));
    $$('.rack-switch[data-rack-switch]').forEach(g => g.addEventListener('click', e => {
      e.stopPropagation();
      const rid = g.getAttribute('data-rack-switch');
      if (!rid) return;
      STATE.selectedRack = rid;
      if (window.__APP__) window.__APP__.render();
    }));
    $$('.rack-box[data-rack]').forEach(g => g.addEventListener('click', e => {
      const rid = g.getAttribute('data-rack');
      if (rid && window.__APP__ && window.__APP__.switchHWView) {
        STATE.selectedRack = rid;
        window.__APP__.switchHWView('physical');
      }
    }));
  }

  window.__RENDER_HW__ = { renderHardware, renderPhysical, renderNetwork, renderThreeD };
})();
