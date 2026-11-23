/* ============================================================
 * renderer-extra.js — 两个新增视图
 *   renderCluster3D : 集群总览的等轴测三维拓扑（Spine/Leaf + 4 机架 + 流量）
 *   renderPipeline  : 推理管线硬件视图（GPU/HBM/DDR5/CXL 卡/NIC + Prefill→KV→Decode）
 * 形态、尺寸、时延、吞吐均为教学示意，非实测。
 * ============================================================ */
(function () {
  'use strict';
  const S = window.__SIM__;
  const { STATE, D, getRack, mhdForRack, mhdUnitsForRack, rackCapacity, rackUsed,
    computeMetrics, fmtNs, loadColor, loadName, nodeConnected } = S;
  const { RACKS, LINKS } = D;
  const C = D.COLORS;

  /* ---------- 画布级样式 ---------- */
  function defs() {
    return `<defs>
      <linearGradient id="ex-metal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1c2d3a"/><stop offset=".5" stop-color="#101d27"/><stop offset="1" stop-color="#0a141c"/>
      </linearGradient>
      <linearGradient id="ex-top" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#2b4351"/><stop offset="1" stop-color="#172832"/>
      </linearGradient>
      <linearGradient id="ex-side" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#152530"/><stop offset="1" stop-color="#0b151d"/>
      </linearGradient>
      <linearGradient id="ex-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="rgba(83,227,196,.14)"/><stop offset="1" stop-color="rgba(95,159,232,.05)"/>
      </linearGradient>
      <filter id="ex-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <style>
        .ex-token{offset-rotate:0deg;animation-name:exTravel;animation-timing-function:linear;animation-iteration-count:infinite;pointer-events:none}
        @keyframes exTravel{from{offset-distance:0%}to{offset-distance:100%}}
        .ex-flow{fill:none;stroke-linecap:round;stroke-dasharray:9 7;animation:exDash 1.2s linear infinite}
        @keyframes exDash{to{stroke-dashoffset:-32}}
        .ex-beat{animation:exBeat 1.6s ease-in-out infinite}
        @keyframes exBeat{0%,100%{opacity:.28}50%{opacity:1}}
        .ex-stage{animation:exStage 5s ease-in-out infinite}
        @keyframes exStage{0%,100%{opacity:.30}8%,24%{opacity:1}44%{opacity:.30}}
        .ex-hbm{animation:exHbm 6s ease-in-out infinite}
        @keyframes exHbm{0%{opacity:.35}50%{opacity:.95}100%{opacity:.35}}
      </style>
    </defs>`;
  }

  function txt(x, y, str, cls, style) {
    return `<text x="${x}" y="${y}" class="${cls || 'ex-cn'}" ${style || ''}>${str}</text>`;
  }
  function mono(x, y, str, size, fill, anchor, weight) {
    return `<text x="${x}" y="${y}" style="font-family:'SFMono-Regular',Consolas,monospace;font-size:${Math.max(size || 11, 10.6)}px;fill:${fill || '#9db0bd'};letter-spacing:.06em${anchor ? ';text-anchor:' + anchor : ''}${weight ? ';font-weight:' + weight : ''}">${str}</text>`;
  }
  function cn(x, y, str, size, fill, anchor) {
    return `<text x="${x}" y="${y}" style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:${Math.max(size || 12, 11.6)}px;fill:${fill || '#c8d6de'}${anchor ? ';text-anchor:' + anchor : ''}">${str}</text>`;
  }
  /* 等轴测立方体：正面 + 顶面 + 右侧面 */
  function iso(x, y, w, h, d, o) {
    const o0 = o || {};
    const fF = o0.front || 'url(#ex-metal)', fT = o0.top || 'url(#ex-top)', fS = o0.side || 'url(#ex-side)';
    const st = o0.stroke || 'rgba(167,197,215,.30)', sw = o0.sw || 1;
    return `<path d="M${x} ${y} h${w} v${h} h${-w} z" fill="${fF}" stroke="${st}" stroke-width="${sw}"/>`
      + `<path d="M${x} ${y} l${d} ${-d} h${w} l${-d} ${d} z" fill="${fT}" stroke="${st}" stroke-width="${sw}" opacity="${o0.topOp || 1}"/>`
      + `<path d="M${x + w} ${y} l${d} ${-d} v${h} l${-d} ${d} z" fill="${fS}" stroke="${st}" stroke-width="${sw}" opacity="${o0.sideOp || 1}"/>`;
  }
  function token(path, color, r, dur, delay) {
    return `<circle class="ex-token" r="${r || 3.6}" fill="${color}" opacity=".95" filter="url(#ex-glow)"
      style="offset-path:path('${path}');animation-duration:${dur || 3}s;animation-delay:${delay || 0}s"/>`;
  }
  function bar(x, y, w, h, pct, color, track) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${track || 'rgba(167,197,215,.10)'}"/>`
      + (pct > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(2, w * Math.min(1, pct))}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '');
  }

  /* ============================================================
   * ① 集群三维拓扑
   * ============================================================ */
  function renderCluster3D() {
    const m = computeMetrics();
    const RW = 148, RH = 196, RD = 26, RY = 336;
    const xs = RACKS.map((_, i) => 118 + i * (RW + 68));
    let s = defs();

    /* 标题 */
    s += mono(30, 58, 'VIEW 01 · CLUSTER / ISO', 11, '#7fa0b3', null, 500)
      + cn(30, 78, '机架内 CXL 共享池', 14, '#7f94a2');

    /* 控制器（离线规划层）*/
    const cx0 = 868, cy0 = 92;
    s += iso(cx0, cy0, 300, 54, 16, { front: 'url(#ex-glass)', top: 'url(#ex-top)' })
      + cn(cx0 + 14, cy0 + 20, 'OFFLINE PLANNER · 部署控制器', 12, '#9fd9cc')
      + mono(cx0 + 14, cy0 + 40, '拓扑选址 / 容量档位 / 慢周期重规划', 9.5, '#82a3b0')
      + txt(cx0 + 286, cy0 + 20, '◷', 'ex-mono', 'style="font-size:12px;fill:#8fd8cc;text-anchor:end"');

    /* Spine 交换机 */
    const spX = 356, spY = 158, spW = 470, spH = 40, spD = 26;
    s += iso(spX, spY, spW, spH, spD, { front: 'url(#ex-metal)', top: 'url(#ex-top)', stroke: 'rgba(125,201,223,.42)' });
    s += cn(spX + 16, spY + 17, 'SPINE / LEAF · RDMA FABRIC', 12, '#bcd8f5')
      + mono(spX + 16, spY + 32, '400G · 存量集群交换机 · 上行全互通', 9.5, '#82a3b0');
    // 端口颗粒
    for (let k = 0; k < 16; k++) {
      s += `<rect x="${spX + 300 + k * 9}" y="${spY + 12}" width="5" height="16" rx="1" fill="rgba(95,159,232,${.25 + (k % 3 === 0 ? .3 : 0)})"/>`;
    }
    // 控制器 → Spine 控制面
    s += `<path d="M${cx0 + 30} ${cy0 + 54} Q${cx0 - 40} ${spY + 10} ${spX + spW - 30} ${spY + 10}" fill="none" stroke="rgba(83,227,196,.5)" stroke-width="1.2" stroke-dasharray="5 4"/>`;

    /* 每机架的跨架流量占比（按链路流量汇总） */
    const share = {};
    RACKS.forEach(r => { share[r.id] = 0; });
    LINKS.forEach(l => { const p = STATE.linkFlow[l.id] || 22; share[l.a] = (share[l.a] || 0) + p / 2; share[l.b] = (share[l.b] || 0) + p / 2; });

    /* 机架 */
    RACKS.forEach((r, i) => {
      const x = xs[i], on = STATE.deployment[r.id];
      const cap = rackCapacity(r.id), used = rackUsed(r.id);
      const units = mhdUnitsForRack(r.id);
      const col = on ? C.cxl : 'rgba(167,197,215,.26)';
      let g = `<g class="rack-box" data-rack="${r.id}" style="cursor:pointer">`;
      // 落影
      g += `<ellipse cx="${x + RW / 2 + RD / 2}" cy="${RY + RH + 12}" rx="${RW / 2 + RD / 2 + 6}" ry="9" fill="rgba(0,0,0,.45)"/>`;
      g += iso(x, RY, RW, RH, RD, { stroke: col, sw: on ? 1.4 : 1 });
      // 顶面 U 位标 + 光环
      g += mono(x + RD + 8, RY - RD - 6, '42U', 9, '#6c8290');
      // 内部：4 节点 + MHD
      for (let k = 0; k < 4; k++) {
        const ny = RY + 22 + k * 30;
        g += `<rect x="${x + 10}" y="${ny}" width="${RW - 20}" height="22" rx="2" fill="rgba(16,30,40,.86)" stroke="rgba(167,197,215,.16)"/>`;
        g += mono(x + 15, ny + 14, 'N' + (k + 1), 9, '#8fb8dd');
        g += `<rect x="${x + 34}" y="${ny + 6}" width="34" height="10" rx="2" fill="${r.nodes[k].role === 'Prefill' ? 'rgba(95,159,232,.22)' : 'rgba(167,120,226,.22)'}" stroke="${r.nodes[k].role === 'Prefill' ? 'rgba(95,159,232,.5)' : 'rgba(167,120,226,.5)'}"/>`
          + cn(x + 51, ny + 14, r.nodes[k].role === 'Prefill' ? 'P' : 'D', 8.5, r.nodes[k].role === 'Prefill' ? '#bcd8f5' : '#e3d5f5', 'middle');
        g += `<circle class="ex-beat" cx="${x + RW - 62}" cy="${ny + 11}" r="2.6" fill="${nodeConnected(r.id, r.nodes[k].id) ? C.cxl : 'rgba(167,197,215,.5)'}" style="animation-delay:${k * .35}s"/>`;
        g += mono(x + RW - 12, ny + 14, nodeConnected(r.id, r.nodes[k].id) ? 'CXL' : 'RDMA', 8, nodeConnected(r.id, r.nodes[k].id) ? '#8fd8cc' : '#8fb8dd', 'end');
      }
      // MHD 槽位
      const my = RY + 22 + 4 * 30;
      if (on && units.length) {
        g += `<rect x="${x + 10}" y="${my + 4}" width="${RW - 20}" height="26" rx="2" fill="rgba(83,227,196,.10)" stroke="rgba(83,227,196,.55)"/>`;
        g += cn(x + 16, my + 21, `MHD × ${units.length}`, 10, '#9fd9cc')
          + mono(x + RW - 14, my + 21, `${used}/${cap}G`, 9, '#8fd8cc', 'end');
        // 容量条
        g += bar(x + 10, my + 33, RW - 20, 4, cap ? used / cap : 0, C.cxl);
        // 机内 CXL：MHD → 节点 的短光纤
        g += `<path class="ex-flow" d="M${x + 16} ${my + 4} L${x + 16} ${RY + 22 + 3 * 30 + 32}" stroke="${C.cxl}" stroke-width="1.2" opacity=".65"/>`;
      } else {
        g += `<rect x="${x + 10}" y="${my + 4}" width="${RW - 20}" height="26" rx="2" fill="rgba(124,148,163,.05)" stroke="rgba(167,197,215,.2)" stroke-dasharray="5 4"/>`;
        g += cn(x + RW / 2, my + 21, 'RDMA-ONLY', 10, '#6c8290', 'middle');
        g += bar(x + 10, my + 33, RW - 20, 4, 0, C.cxl);
      }
      // 底部标签
      g += cn(x + 2, RY + RH + 34, `RACK ${r.id.slice(1)} · ${on ? 'CXL + RDMA' : 'RDMA-only'}`, 13, on ? '#9fd9cc' : '#9db0bd');
      g += mono(x + 2, RY + RH + 51, `${units.length} MHD · ${cap} GB · ${r.nodes.length} NODES`, 9, '#7f94a2');
      g += `</g>`;
      s += g;

      // 上行链路：Spine → 机架
      const px = xs[i] + RW / 2, py = RY - RD - 2;
      const d = `M${spX + 60 + i * 110} ${spY + spH} Q${spX + 60 + i * 110} ${py - 60} ${px} ${py}`;
      const lw = 1.2 + share[r.id] / 30;
      s += `<path d="${d}" fill="none" stroke="${C.rdma}" stroke-width="${lw}" opacity=".55"/>`;
      s += token(d, '#eafff9', 3.2, 3.4, i * .5);
    });

    /* 机架间跨架流量：底部弧线（只给纹理与颜色，标注放在右侧卡片） */
    const baseY = RY + RH + 78;
    LINKS.forEach((l, li) => {
      const ia = RACKS.findIndex(r => r.id === l.a), ib = RACKS.findIndex(r => r.id === l.b);
      const pct = STATE.linkFlow[l.id] || 22, col = loadColor(pct);
      const x1 = xs[ia] + RW / 2, x2 = xs[ib] + RW / 2;
      const lift = 10 + li * 7;
      const d = `M${x1} ${baseY} Q${(x1 + x2) / 2} ${baseY + lift * 2.4} ${x2} ${baseY}`;
      s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${+(1 + pct / 34).toFixed(1)}" opacity="${.22 + pct / 160}"/>`;
      s += token(d, col, 2.4, 4, li * .4);
    });

    /* 右侧：流量与本地化卡片 */
    const qx = 952, qy = 300, qw = 226, qh = 250;
    s += `<rect x="${qx}" y="${qy}" width="${qw}" height="${qh}" rx="6" fill="rgba(7,15,21,.86)" stroke="rgba(167,197,215,.24)"/>`
      + `<rect x="${qx}" y="${qy}" width="4" height="${qh}" fill="${C.rdma}"/>`
      + cn(qx + 14, qy + 24, 'LINK LOAD / 跨架流量', 12, '#a9cbf0')
      + mono(qx + qw - 14, qy + 24, 'RDMA', 9, '#7f94a2', 'end');
    LINKS.forEach((l, li) => {
      const yy = qy + 48 + li * 24, pct = STATE.linkFlow[l.id] || 22, col = loadColor(pct);
      s += mono(qx + 14, yy, l.id, 9.5, '#9db0bd')
        + bar(qx + 44, yy - 8, 130, 7, pct / 100, col)
        + mono(qx + qw - 12, yy, pct + '%', 9, col, 'end');
    });
    s += `<line x1="${qx + 12}" y1="${qy + 196}" x2="${qx + qw - 12}" y2="${qy + 196}" stroke="rgba(167,197,215,.18)"/>`
      + mono(qx + 14, qy + 214, `本地命中 ${Math.round((m.localRate || 0) * 100)}%`, 10, '#9fd9cc')
      + mono(qx + 14, qy + 232, `跨架访问 ${Math.round((m.crossRate || 0) * 100)}%`, 10, '#a9cbf0');

    /* 图例 */
    const lgY = 682;
    s += `<line x1="30" y1="${lgY}" x2="66" y2="${lgY}" stroke="${C.cxl}" stroke-width="2"/>`
      + cn(74, lgY + 4, '机架内 CXL', 10, '#9fd9cc')
      + `<line x1="168" y1="${lgY}" x2="204" y2="${lgY}" stroke="${C.rdma}" stroke-width="2" stroke-dasharray="4 4"/>`
      + cn(212, lgY + 4, 'RDMA 上行 / 跨架', 10, '#a9cbf0')
      + `<circle cx="352" cy="${lgY - 1}" r="3.4" fill="#eafff9" filter="url(#ex-glow)"/>`
      + cn(360, lgY + 4, 'KV 数据光点', 10, '#dfeaf0');
    return s;
  }

  /* ===== KV 生命周期分步讲解：模块级状态 ===== */
  let PSTEP = 0;
  let PAUTO = 0;
  let pipeTimer = null;
  const PIPE_STEPS = [
    {
      n: '01', name: '请求到达',
      title: '请求进入 GPU',
      line1: '多轮对话先做前缀命中检查：',
      line2: '命中哪一段 KV，决定后面读 HBM 还是 CXL。',
      big: '63%', bigSub: '本地命中率',
      hint: '命中率高 → 跨架 RDMA 少。',
      focus: ['gpu']
    },
    {
      n: '02', name: 'Prefill 计算',
      title: 'GPU 算出 KV 块',
      line1: '整段 prompt 一次算完，KV 先写进 HBM。',
      line2: '这一步吃算力、不吃带宽（compute-bound）。',
      big: '86%', bigSub: 'GPU 算力占用',
      hint: 'Prefill 越久，TTFT 越长，首字越慢。',
      focus: ['gpu', 'hbm']
    },
    {
      n: '03', name: 'KV 下沉',
      title: 'KV 存进 CXL 共享池',
      line1: 'HBM 装不下的 KV 经 CXL 卡下沉，',
      line2: '落到机架内 MHD，同架任何节点都能读。',
      big: '340 ns', bigSub: '机架内读 CXL',
      hint: '比跨架 RDMA 快 6 倍：2.10 µs → 340 ns。',
      focus: ['hbm', 'cxl', 'mhd']
    },
    {
      n: '04', name: 'Decode 逐 token',
      title: '每个 token 读回 KV',
      line1: 'Decode 不再算新东西，只把 KV 反复读出来，',
      line2: '所以它吃带宽、不吃算力（memory-bound）。',
      big: '24.6 ms', bigSub: 'TPOT · 每 token',
      hint: 'KV 读占 47%，CXL 决定吐字速度。',
      focus: ['cxl', 'mhd', 'gpu']
    }
  ];

  (function () {
    try {
      const q = new URLSearchParams(location.search);
      const st = parseInt(q.get('step'), 10);
      if (st >= 1 && st <= PIPE_STEPS.length) PSTEP = st - 1;
    } catch (_) {}
  })();

  function pipeRender() {
    if (window.__RENDER_HW__) window.__RENDER_HW__.renderHardware();
    if (window.__ZOOM__) { window.__ZOOM__.setBase([26, 84, 1152, 628]); window.__ZOOM__.apply(); }
    bindPipeOnce();
  }

  function bindPipeOnce() {
    const el = document.getElementById('canvas');
    if (!el || el.__pipeBound) return;
    el.__pipeBound = true;
    el.addEventListener('click', function (e) {
      const t = (e.target && e.target.closest) ? e.target.closest('[data-story]') : null;
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      const act = t.getAttribute('data-story');
      if (act === 'prev') PSTEP = Math.max(0, PSTEP - 1);
      else if (act === 'next') PSTEP = Math.min(PIPE_STEPS.length - 1, PSTEP + 1);
      else if (act === 'play') { PAUTO = PAUTO ? 0 : 1; pipeTick(); pipeRender(); return; }
      else if (act.indexOf('step') === 0) PSTEP = Math.min(PIPE_STEPS.length - 1, parseInt(act.slice(4), 10) || 0);
      PAUTO = 0;
      pipeTick();
      pipeRender();
    }, true);
  }

  function pipeTick() {
    if (pipeTimer) { clearInterval(pipeTimer); pipeTimer = null; }
    if (!PAUTO) return;
    pipeTimer = setInterval(function () {
      if (PSTEP >= PIPE_STEPS.length - 1) { PAUTO = 0; pipeTick(); pipeRender(); return; }
      PSTEP += 1;
      pipeRender();
    }, 8000);
  }

  /* ============================================================
   * ② 推理管线：分步讲解（一步一屏，字少字大，动画慢）
   * ============================================================ */
  function renderPipeline() {
    const step = PIPE_STEPS[Math.min(PSTEP, PIPE_STEPS.length - 1)];
    const on = function (k) { return step.focus.indexOf(k) >= 0; };
    const dim = function (k) { return on(k) ? 1 : 0.26; };
    let s = defs();

    /* ---------- 顶部 ---------- */
    s += mono(28, 50, 'KV LIFECYCLE / 单节点硬件', 12, '#7fa0b3')
      + cn(28, 78, 'KV 在哪产生 · 在哪被读', 20, '#c8d6de');

    /* ---------- 机内托盘 + 四块硬件 ---------- */
    const gpu = { x: 48, y: 150, w: 196, h: 152 };
    const hbm = { x: 286, y: 150, w: 194, h: 96 };
    const cxlk = { x: 286, y: 316, w: 194, h: 86 };
    const nic = { x: 48, y: 316, w: 196, h: 86 };

    s += iso(24, 104, 480, 356, 22, { front: 'rgba(13,24,32,.96)', top: 'rgba(26,41,52,.9)' });
    s += mono(46, 130, 'GPU SERVER · 1 NODE', 11, '#6f8a99');

    /* GPU */
    const gAct = on('gpu');
    s += iso(gpu.x, gpu.y, gpu.w, gpu.h, 12, {
      front: 'rgba(22,36,48,.96)', stroke: gAct ? 'rgba(95,159,232,.92)' : 'rgba(167,197,215,.2)', sw: gAct ? 1.8 : 1
    });
    s += `<g opacity="${gAct ? 1 : .5}">`
      + cn(gpu.x + 18, gpu.y + 42, 'GPU', 28, '#dfeaf0')
      + mono(gpu.x + 18, gpu.y + 66, '', 10.5, '#7fa0b3')
      + `</g>`;
    for (let i = 0; i < 12; i++) {
      const bx = gpu.x + 18 + (i % 6) * 28, by = gpu.y + 84 + Math.floor(i / 6) * 26;
      s += `<rect class="${gAct ? 'ex-beat' : ''}" x="${bx}" y="${by}" width="22" height="16" rx="2"
        fill="rgba(95,159,232,${gAct ? .5 : .13})" stroke="rgba(95,159,232,.3)" style="animation-delay:${(i * .22).toFixed(2)}s"/>`;
    }

    /* HBM */
    const hAct = on('hbm');
    s += `<g opacity="${dim('hbm')}">`
      + iso(hbm.x, hbm.y, hbm.w, hbm.h, 10, {
        front: 'rgba(20,34,46,.96)', stroke: hAct ? 'rgba(83,227,196,.92)' : 'rgba(167,197,215,.2)', sw: hAct ? 1.8 : 1
      })
      + cn(hbm.x + 18, hbm.y + 38, 'HBM', 24, '#dfeaf0')
      + mono(hbm.x + 18, hbm.y + 62, '80 GB', 16, '#8fd8cc')
      + `</g>`;
    s += `<g opacity="${dim('hbm')}">` + bar(hbm.x + 18, hbm.y + 72, hbm.w - 36, 7, .72, C.cxl) + '</g>';

    /* CXL 卡 */
    const cAct = on('cxl');
    s += `<g opacity="${dim('cxl')}">`
      + iso(cxlk.x, cxlk.y, cxlk.w, cxlk.h, 10, {
        front: 'rgba(20,42,39,.96)', stroke: cAct ? 'rgba(83,227,196,.95)' : 'rgba(167,197,215,.2)', sw: cAct ? 1.8 : 1
      })
      + cn(cxlk.x + 18, cxlk.y + 38, 'CXL 卡', 22, cAct ? '#9fd9cc' : '#a8bcc8')
      + mono(cxlk.x + 18, cxlk.y + 62, '', 10.5, '#8fd8cc')
      + `</g>`;

    /* RNIC */
    s += `<g opacity=".55">`
      + iso(nic.x, nic.y, nic.w, nic.h, 10, { front: 'rgba(18,28,42,.92)' })
      + cn(nic.x + 18, nic.y + 38, 'RNIC', 20, '#bcd8f5')
      + mono(nic.x + 18, nic.y + 60, '200G', 15, '#8fb8dd')
      + `</g>`;

    /* ---------- 机外共享池 ---------- */
    const mhd = { x: 556, y: 262, w: 224, h: 130 };
    const mAct = on('mhd');
    s += `<g opacity="${dim('mhd')}">`
      + iso(mhd.x, mhd.y, mhd.w, mhd.h, 16, {
        front: mAct ? 'rgba(83,227,196,.17)' : 'rgba(83,227,196,.06)',
        stroke: mAct ? 'rgba(83,227,196,.95)' : 'rgba(83,227,196,.3)', sw: mAct ? 1.8 : 1.2
      })
      + cn(mhd.x + 18, mhd.y + 42, 'MHD 共享池', 22, '#9fd9cc')
      + cn(mhd.x + 18, mhd.y + 74, '512 GB', 26, '#dfeaf0')
      + `</g>`;
    s += `<g opacity="${dim('mhd')}">` + bar(mhd.x + 18, mhd.y + 92, mhd.w - 36, 8, .63, C.cxl)
      + mono(mhd.x + 18, mhd.y + 116, '63%', 13, '#8fd8cc') + '</g>';

    const far = { x: 556, y: 418, w: 224, h: 92 };
    s += `<g opacity="${step.n === '01' || step.n === '04' ? .85 : .4}">`
      + iso(far.x, far.y, far.w, far.h, 16, { front: 'rgba(95,159,232,.10)', stroke: 'rgba(95,159,232,.5)', sw: 1.2 })
      + cn(far.x + 18, far.y + 36, '远端 KV', 17, '#bcd8f5')
      + cn(far.x + 18, far.y + 64, '2.10 µs', 20, '#a9cbf0')
      + `</g>`;

    /* ---------- 路由（只画必要三条） ---------- */
    const pGH = `M${gpu.x + gpu.w + 2} ${gpu.y + 74} L${hbm.x - 4} ${hbm.y + 62}`;
    const pHC = `M${hbm.x + 74} ${hbm.y + hbm.h + 2} L${hbm.x + 74} ${cxlk.y - 2}`;
    const pCM = `M${cxlk.x + cxlk.w + 2} ${cxlk.y + cxlk.h / 2} L${mhd.x - 4} ${cxlk.y + cxlk.h / 2}`;
    const pNF = `M${nic.x + 120} ${nic.y + nic.h + 2} L${nic.x + 120} ${nic.y + nic.h + 56} L${far.x - 4} ${nic.y + nic.h + 56}`;

    s += `<path d="${pGH}" fill="none" stroke="rgba(95,159,232,${on('gpu') && on('hbm') ? .9 : .14})" stroke-width="2"/>`;
    s += `<path class="ex-flow" style="animation-duration:3.4s" d="${pHC}" stroke="rgba(83,227,196,${cAct ? .9 : .14})" stroke-width="2"/>`;
    s += `<path d="${pCM}" fill="none" stroke="rgba(83,227,196,${mAct || cAct ? .9 : .16})" stroke-width="2.2"/>`;
    s += `<path class="ex-flow" style="animation-duration:4.2s" d="${pNF}" stroke="rgba(95,159,232,${step.n === '01' ? .5 : .14})" stroke-width="1.4" stroke-dasharray="9 7"/>`;

    /* 时延大字：只标在当前路径旁 */
    if (cAct) s += cn((cxlk.x + cxlk.w + mhd.x) / 2, cxlk.y + cxlk.h / 2 - 12, '340 ns', 16, '#9fd9cc', 'middle');

    /* ---------- 慢速光点：一步一条路径，6 秒走完 ---------- */
    if (step.n === '02') s += token(pGH, '#eafff9', 5.5, 6, 0);
    if (step.n === '03') s += token(`M${hbm.x + 74} ${hbm.y + hbm.h + 2} L${hbm.x + 74} ${cxlk.y - 2} L${cxlk.x + cxlk.w + 2} ${cxlk.y + cxlk.h / 2} L${mhd.x - 4} ${cxlk.y + cxlk.h / 2}`, '#eafff9', 5.5, 6, 0);
    if (step.n === '04') s += token(`M${mhd.x - 4} ${cxlk.y + cxlk.h / 2} L${cxlk.x + cxlk.w + 2} ${cxlk.y + cxlk.h / 2} L${hbm.x + 74} ${cxlk.y - 2} L${hbm.x + 74} ${hbm.y + hbm.h + 2}`, '#eafff9', 5.5, 6, 0);

    /* ---------- 右侧大字讲解卡 ---------- */
    const cx = 800, cy = 104, cw = 374, ch = 356;
    s += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="12" fill="rgba(9,18,25,.93)" stroke="rgba(167,197,215,.2)"/>`
      + `<rect x="${cx}" y="${cy}" width="5" height="${ch}" rx="2.5" fill="${C.cxl}"/>`
      + mono(cx + 28, cy + 36, 'STEP ' + step.n + ' / 04 · ' + step.name, 12, '#7fa0b3');
    s += cn(cx + 28, cy + 88, step.title, 28, '#f1f7fa');
    s += cn(cx + 28, cy + 132, step.line1, 16, '#a9bcc8');
    s += mono(cx + 28, cy + 224, step.big, 42, '#9fd9cc', null, '600');
    s += mono(cx + 244, cy + 218, step.bigSub, 13, '#7f94a2');
    s += cn(cx + 28, cy + 300, step.hint, 15, '#9db0bd');

    /* ---------- 底部：分步按钮 ---------- */
    const by = 560;
    s += mono(28, by - 16, 'STEPS / 分步演示 · 点一步看一步', 11, '#7fa0b3');
    PIPE_STEPS.forEach(function (st, i) {
      const x = 28 + i * 180, w = 168, h = 58, act = i === PSTEP;
      s += `<g data-story="step${i}" style="cursor:pointer">`
        + `<rect x="${x}" y="${by}" width="${w}" height="${h}" rx="8"
          fill="${act ? 'rgba(83,227,196,.16)' : 'rgba(12,23,31,.94)'}"
          stroke="${act ? 'rgba(83,227,196,.9)' : 'rgba(167,197,215,.22)'}" stroke-width="${act ? 1.8 : 1}"/>`
        + cn(x + 14, by + 27, st.n + '  ' + st.name, 14, act ? '#dffaf3' : '#a9bcc8')
        + mono(x + 14, by + 47, act ? '正在讲解' : 'STEP ' + (i + 1), 10, act ? '#8fd8cc' : '#6c8290')
        + `</g>`;
    });

    const nx = 28 + 4 * 180 + 6, ny = by + 6;
    s += `<g data-story="prev" style="cursor:pointer" opacity="${PSTEP === 0 ? .35 : 1}">
      <rect x="${nx}" y="${ny}" width="104" height="46" rx="8" fill="rgba(12,23,31,.94)" stroke="rgba(167,197,215,.28)"/>
      ${cn(nx + 16, ny + 30, '◀ 上一步', 13, '#c8d6de')}</g>`;
    s += `<g data-story="next" style="cursor:pointer" opacity="${PSTEP === PIPE_STEPS.length - 1 ? .35 : 1}">
      <rect x="${nx + 112}" y="${ny}" width="104" height="46" rx="8" fill="rgba(83,227,196,.14)" stroke="rgba(83,227,196,.6)"/>
      ${cn(nx + 128, ny + 30, '下一步 ▶', 13, '#dffaf3')}</g>`;
    s += `<g data-story="play" style="cursor:pointer">
      <rect x="${nx + 224}" y="${ny}" width="118" height="46" rx="8" fill="rgba(12,23,31,.94)" stroke="rgba(167,197,215,.28)"/>
      ${cn(nx + 238, ny + 30, PAUTO ? '❚❚ 暂停' : '▶ 自动 8s', 13, '#c8d6de')}</g>`;
    s += mono(nx + 356, ny + 30, (PSTEP + 1) + ' / 04', 13, '#7f94a2');

    bindPipeOnce();
    return s;
  }

  window.__EXTRA__ = { renderCluster3D, renderPipeline };
})();
