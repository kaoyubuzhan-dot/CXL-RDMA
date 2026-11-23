/* ============================================================
 * renderer-panels.js — 左右侧栏 / KV 分布 / 分析面板 / 底栏 KPI
 * ============================================================ */
(function () {
  'use strict';
  const S = window.__SIM__;
  const { STATE, D, $, $$, esc, hotColor, loadColor, loadName, t,
          getKV, getRack, getMhd, mhdForRack, computeMhdUsed,
          rdmaUsed, cxlStats, localKVCount } = S;
  const { RACKS, KVS, LINKS, SCENARIOS, DEPLOY_PLANS, COST_PARAMS } = D;
  const C = D.COLORS;

  // ---------- 左侧面板 ----------
  function renderLeft() {
    const page = STATE.page;
    let kicker = '', title = '', subtitle = '', body = '';

    if (page === 'overview' || page === 'rack') {
      kicker = 'DEPLOYMENT / 04 RACKS';
      title = t('leftDeploy'); subtitle = '配置驱动 · 硬件视图 / 档案 / 指标实时联动';
      body = sectionTitle('① 机架与 CXL 部署') + RACKS.map(r => rackCard(r)).join('') + deploySummary()
           + sectionTitle('② 性能与成本（模型估算）') + perfPanel()
           + sectionTitle('③ KV 工作负载') + workloadPanel()
           + sectionTitle('④ 网络流量') + networkPanel()
           + (page === 'rack' ? hardwareLibrary() : '');
    } else if (page === 'kv') {
      kicker = 'KV BLOCK / ' + String(KVS.length).padStart(2,'0');
      title = t('leftKv'); subtitle = t('leftKvSub');
      body = KVS.map(k => kvListItem(k)).join('') + kvLegends();
    } else if (page === 'traffic') {
      kicker = 'LINKS / 06';
      title = t('leftTraffic'); subtitle = '调节拥塞 · 观察链路与访问路径变化';
      body = sectionTitle('① 拥塞与流量配置') + networkPanel() + sectionTitle('② 链路状态') + linkList() + loadLegends();
    } else if (page === 'compare') {
      kicker = 'DEPLOY PLANS / 03';
      title = t('leftCompare'); subtitle = t('leftCompareSub');
      body = planList();
    }
    $('#left-kicker').textContent = kicker;
    $('#left-title').textContent = title;
    $('#left-subtitle').textContent = subtitle;
    $('#left-body').innerHTML = body;
    bindLeft();
  }

  function rackCard(r) {
    const cxl = STATE.deployment[r.id];
    const open = STATE._openRacks && STATE._openRacks[r.id];
    const sel = STATE.selectedRack === r.id;
    const units = S.mhdUnitsForRack(r.id);
    const capTotal = S.rackCapacity(r.id);
    const usedTotal = S.rackUsed(r.id);
    const connected = S.connectedNodeCount(r.id);
    let body = '';
    if (open) {
      const unitRows = units.map(m => {
        const used = computeMhdUsed(m.id);
        const pct = m.capacityGB ? Math.min(100, Math.round(used / m.capacityGB * 100)) : 0;
        const over = used > m.capacityGB;
        return `<div class="unit-block">
          <div class="unit-line">
            <b class="unit-id">${m.id}</b>
            <span class="unit-cap">${m.capacityGB >= 1024 ? (m.capacityGB/1024)+' TB' : m.capacityGB+' GB'}</span>
            <span class="unit-used" style="color:${over?'var(--warn)':'var(--deep)'}">${used} / ${m.capacityGB} GB · ${m.hostInterfaces} 口</span>
            <button type="button" class="unit-del" data-unit-del="${r.id}|${m.id}" title="移除该设备">✕</button>
          </div>
          <div class="unit-bar"><i style="width:${pct}%;background:${over?'var(--warn)':'var(--cxl)'}"></i></div>
          <div class="unit-ctl">
            <label>容量</label>
            <input class="mini-range" type="range" min="128" max="2048" step="128" value="${m.capacityGB}" data-unit-cap="${m.id}" aria-label="${m.id} 容量"/>
            <label>接口</label>
            <input class="mini-range" type="range" min="1" max="4" step="1" value="${m.hostInterfaces}" data-unit-iface="${m.id}" aria-label="${m.id} 接口数"/>
          </div>
        </div>`;
      }).join('');
      body = `<div class="rack-card__body">
        <div class="toggle-row"><span class="toggle-label">部署 CXL 子系统</span><button type="button" class="switch ${cxl?'on':''}" data-toggle-rack="${r.id}" aria-label="切换CXL部署"></button></div>
        ${cxl ? `
          <div class="field-row unit-head"><span>MHD 设备 <b>${units.length}</b> / ${D.MAX_MHD_PER_RACK} 台</span>
            <button type="button" class="unit-add" data-unit-add="${r.id}" ${units.length>=D.MAX_MHD_PER_RACK?'disabled':''}>＋ 新增设备</button></div>
          ${unitRows}
          <div class="field-row"><span>共享池合计</span><span class="val">${capTotal} GB · 已用 ${usedTotal} GB（${capTotal?Math.round(usedTotal/capTotal*100):0}%）</span></div>
        ` : `<div class="field-row"><span style="color:var(--deep)">未部署 · 该机架全部走 RDMA</span></div>`}
        <div class="field-row" style="margin-top:9px"><span>接入 MHD 节点</span><span class="val">${cxl?`${connected} / ${r.nodes.length}`:'—'}</span></div>
        <div class="node-picks">${r.nodes.map(n => {
          const on = S.nodeConnected(r.id, n.id);
          return `<button type="button" class="node-pick ${on?'on':''}" data-nodepick="${r.id}-${n.id}" ${cxl?'':'disabled'}>
            <span class="np-box">${on?'✓':''}</span><span class="np-name">${n.id}</span><span class="np-role">${n.role}</span><span class="np-tag">${on?'CXL':'RDMA'}</span>
          </button>`;
        }).join('')}</div>
      </div>`;
    }
    return `<div class="rack-card ${cxl?'is-cxl':''} ${sel?'is-active':''} ${open?'is-open':''}" data-card="${r.id}">
      <div class="rack-card__head" data-head="${r.id}">
        <span class="rack-card__idx">${r.id.replace('R','R0')}</span>
        <span class="rack-card__name">${r.name}</span>
        <span class="rack-card__tag">${cxl?'CXL+RDMA':'RDMA'}</span>
        <span class="rack-card__chev">▶</span>
      </div>
      <div class="rack-card__meta"><span>NODES <b>4</b></span><span>MHD <b>${units.length}</b></span><span>CXL <b>${cxl?connected:0}</b></span>${units.length?`<span>USED <b>${usedTotal}G</b></span>`:''}</div>
      ${body}
    </div>`;
  }

  function deploySummary() {
    const s = cxlStats();
    return `<div class="note-box" style="margin-top:14px">
      <b>已部署 CXL 机架 ${s.count} / 4 · MHD 设备 ${s.units} 台</b><br/>
      CXL 总容量 ${s.total} GB · 设备接口 ${s.interfaces} 个 · 已用 ${s.used} GB（${s.util}%）<br/>
      <span style="color:var(--deep)">机架级部署 ≠ 机架内全部节点接入 CXL；容量/设备数变化会直接改变下方指标</span>
    </div>`;
  }

  // 性能与成本面板：硬件配置（机架/设备/容量/端口/接入）→ 指标变化
  function perfPanel() {
    const m = S.computeMetrics();
    const rows = [
      ['平均 KV 访问时延', S.fmtNs(m.avgNs), 'cxl', Math.min(100, m.avgNs / 2400 * 100)],
      ['P95 时延', S.fmtNs(m.p95Ns), '', Math.min(100, m.p95Ns / 2400 * 100)],
      ['SLO 达标率', Math.round(m.sloRate * 100) + '%', m.sloRate >= .8 ? 'cxl' : 'warn', m.sloRate * 100],
      ['本地命中率', Math.round(m.localRate * 100) + '%', 'cxl', m.localRate * 100],
      ['① 机架覆盖', Math.round(m.coverage * 100) + '%', m.coverage >= .5 ? 'cxl' : 'warn', m.coverage * 100],
      ['② 端口可达', Math.round(m.reach * 100) + '%', m.reach >= .5 ? 'cxl' : 'warn', m.reach * 100],
      ['③ 容量吸收', Math.round(m.serveRatio * 100) + '% <i style="font-style:normal;color:var(--soft);font-size:9px">cap/(cap+' + (m.absorbDemand || 0) + 'GB)</i>', m.serveRatio >= .8 ? 'cxl' : 'warn', m.serveRatio * 100],
      ['跨机架 KV 流量', m.crossGB + ' GB', 'rdma', Math.min(100, m.crossGB / 200 * 100)],
      ['CXL 利用率', m.util + '%', m.util > 85 ? 'warn' : '', Math.min(100, m.util)]
    ];
    return `<div class="cfg-panel">
      ${rows.map(r => `<div class="perf-row">
        <span class="perf-k">${r[0]}</span>
        <span class="perf-track"><i class="${r[2]}" style="width:${r[3]}%"></i></span>
        <b class="perf-v ${r[2]}">${r[1]}</b></div>`).join('')}
      <div class="perf-cost">
        <div><span>部署成本</span><b>${m.deployCost} 万元</b><small>${m.units} 台 × ${COST_PARAMS.mhdUnitCost} + ${m.racks} 机架 × ${COST_PARAMS.installCost}</small></div>
        <div><span>运行代价</span><b class="rdma">${m.opCost} 万元</b><small>跨机架 KV 流量 × ${D.PERF_MODEL.opCostPerGB} 万元/GB</small></div>
        <div><span>目标值 J = C + α·O</span><b class="cxl">${m.objective}</b><small>α = ${m.alpha}（成本与运行代价的权衡）</small></div>
      </div>
      <div class="cfg-hint">模型估算：<b>加机架 / 加设备 / 扩容量 / 多接主机 → 时延与跨机架流量下降、成本与利用率上升</b>。数值为教学示意，非实测。</div>
    </div>`;
  }

  function sectionTitle(txt) {
    return `<div class="cfg-section-title">${txt}</div>`;
  }

  // 硬件库（逻辑示意）：可点选部署到当前机架；形态为抽象图标
  function hardwareLibrary() {
    const rid = STATE.selectedRack || 'R1';
    const rack = getRack(rid);
    const deployed = STATE.deployment[rid];
    const sw = STATE.switchCfg[rid] || D.CXL_SWITCH_DEFAULT;
    return `<div class="cfg-section-title">⑤ 硬件库 / 拖拽部署</div>
      <div class="hwlib" id="hwlib">
        <div class="hwlib-item" draggable="true" data-drag-hw="GPU_SERVER">
          <span class="hwlib-ico gpu">▦</span><span class="hwlib-txt"><b>GPU Server</b><small>GPU 服务器 · 2U · 计算节点</small></span>
        </div>
        <div class="hwlib-item" draggable="true" data-drag-hw="CXL_SUBSYSTEM">
          <span class="hwlib-ico cxl">◈</span><span class="hwlib-txt"><b>CXL Switch + MHD</b><small>CXL 交换机 + 共享内存 · 2U</small></span>
        </div>
        <div class="hwlib-item" draggable="true" data-drag-hw="RDMA_TOR">
          <span class="hwlib-ico rdma">▤</span><span class="hwlib-txt"><b>RDMA ToR</b><small>机架接入交换机 · Leaf</small></span>
        </div>
      </div>
      <div class="hwlib-target" id="hwlib-target" data-drop-rack="${rid}">
        拖入目标：<b>${rack.name}</b> · ${deployed?'已部署 CXL':'RDMA-only'}
        <button type="button" class="hwlib-btn" data-deploy-hw="CXL_SUBSYSTEM">＋部署 CXL 子系统</button>
        <button type="button" class="hwlib-btn ghost" id="remove-hw">－移除</button>
      </div>
      <div class="cfg-panel" style="margin-top:10px">
        <div class="cfg-row"><span>CXL Switch Host Port</span><b>${sw.hostPorts} 口</b></div>
        <input class="mini-range" type="range" min="1" max="6" step="1" value="${sw.hostPorts}" data-swports="${rid}" aria-label="Host Port 数"/>
        <div class="cfg-hint">Host Port 决定可接主机数（当前机架 ${S.usedHostPorts(rid)} 台已接）；与 MHD 容量相互独立。</div>
      </div>`;
  }

  // KV 工作负载配置面板（滑块驱动 KV 分类/热度/访问分布即时重算）
  function workloadPanel() {
    const w = STATE.workload, d = S.workloadDerived();
    return `<div class="cfg-panel">
      <div class="cfg-row"><span>KV 总容量</span><b>${w.totalGB} GB</b></div>
      <input class="mini-range" type="range" min="100" max="1000" step="50" value="${w.totalGB}" data-wl="totalGB"/>
      <div class="cfg-row"><span>热 KV 比例</span><b>${w.hotRatio}%</b></div>
      <input class="mini-range" type="range" min="10" max="80" step="5" value="${w.hotRatio}" data-wl="hotRatio"/>
      <div class="cfg-row"><span>本地访问比例</span><b>${w.localRatio}%</b></div>
      <input class="mini-range" type="range" min="20" max="95" step="5" value="${w.localRatio}" data-wl="localRatio"/>
      <div class="cfg-row"><span>跨机架共享比例</span><b>${w.crossRatio}%</b></div>
      <input class="mini-range" type="range" min="0" max="60" step="5" value="${w.crossRatio}" data-wl="crossRatio"/>
      <div class="cfg-row"><span>访问请求量</span><b>${w.requestRate}%</b></div>
      <input class="mini-range" type="range" min="20" max="200" step="10" value="${w.requestRate}" data-wl="requestRate"/>
      <div class="cfg-calc">
        <span>热 KV <b style="color:${C.hotHigh}">${d.hotGB} GB</b></span>
        <span>冷 KV <b style="color:${C.hotLow}">${d.coldGB} GB</b></span>
        <span>本地主体 <b>${d.local}</b></span>
        <span>共享 <b>${d.shared}</b></span>
        <span>高热留 RDMA <b class="warn">${d.burst}</b></span>
        <span>RDMA 流量指数 <b class="rdma">${d.traffic}</b></span>
      </div>
      <div class="cfg-hint">比例联动为即时计算，非真实系统测量结果（示意）。</div>
    </div>`;
  }

  // 网络流量配置：拥塞预设 + 单链路流量滑块
  function networkPanel() {
    const presets = D.CONGESTION_PRESETS;
    const pctBtns = ['low','mid','high'].map(k =>
      `<button type="button" class="seg ${STATE.congestion===k?'on':''}" data-congestion="${k}">${presets[k].label}</button>`).join('');
    const linkRows = LINKS.map(l => {
      const pct = STATE.linkFlow[l.id], load = STATE.links[l.id];
      return `<div class="cfg-row"><span>${l.a}–${l.b} <i style="color:${loadColor(load)}">●</i></span><b>${pct}%</b></div>
        <input class="mini-range" type="range" min="0" max="100" step="1" value="${pct}" data-flow="${l.id}"/>`;
    }).join('');
    return `<div class="cfg-panel">
      <div class="cfg-row"><span>拥塞预设</span><span class="seg-group">${pctBtns}</span></div>
      ${linkRows}
      <div class="cfg-hint">线宽/颜色随流量变化；预设与单链路滑块均可调（示意）。</div>
    </div>`;
  }

  function kvListItem(k) {
    const rt = getKV(k.id);
    const active = STATE.selectedKV === k.id;
    const loc = rt.location === 'rdma' ? 'RDMA Pool'
      : (getMhd(rt.location.split(':')[1]) || {}).name;
    const hasRep = rt.replicas.length > 0;
    return `<div class="kv-item ${active?'is-active':''}" data-kv="${k.id}">
      <span class="kv-item__dot" style="background:${hotColor(rt.hotness)}"></span>
      <span class="kv-item__main"><b>${k.id}</b><span>生产 ${rt.producer} · ${k.sizeGB} GB · ${hotName(rt.hotness)}</span></span>
      <span class="kv-item__loc ${hasRep?'replica':''}">${esc(loc||'')}${hasRep?'<br/>↳ 有副本':''}</span>
    </div>`;
  }
  function hotName(h){ return {high:'高热度',mid:'中热度',low:'低热度'}[h]||h; }

  function kvLegends() {
    return `<div class="legends">
      <span><i style="background:${C.hotHigh}"></i>高热度</span>
      <span><i style="background:${C.hotMid}"></i>中热度</span>
      <span><i style="background:${C.hotLow}"></i>低热度</span>
      <span><i class="sq" style="border:1px solid ${C.shared}"></i>共享访问</span>
      <span><i class="dash"></i>副本</span>
    </div>
    <div class="note-box" style="margin-top:10px">颜色表示热度，边框表示共享/副本状态；<b>两个维度独立</b>，不混为一谈。</div>`;
  }

  function linkList() {
    return LINKS.map(l => {
      const load = STATE.links[l.id];
      const sel = STATE.selectedLink === l.id;
      return `<div class="node-mini ${sel?'cxl':''}" data-link="${l.id}" style="cursor:pointer">
        <span class="ndot" style="background:${loadColor(load)}"></span>
        <span class="nname" style="width:auto">${l.a}–${l.b}</span>
        <span class="nrole">Link ${l.id}</span>
        <span class="nconn" style="color:${loadColor(load)}">${loadName(load)}</span>
      </div>`;
    }).join('');
  }
  function loadLegends(){
    return `<div class="legends">
      <span><i style="background:${C.loadLow}"></i>低负载</span>
      <span><i style="background:${C.loadMid}"></i>中负载</span>
      <span><i style="background:${C.loadHigh}"></i>高负载</span>
    </div><div class="note-box" style="margin-top:10px">链路颜色由<b>预设场景</b>驱动，非真实拥塞仿真。</div>`;
  }

  function planList() {
    const presets = DEPLOY_PLANS.map(p => `
      <button type="button" class="action-btn plan-btn ${STATE.comparePlan===p.id?'primary':''}" data-plan="${p.id}">
        <b>方案 ${p.id} · ${p.sub}</b><span class="plan-name">${p.name}</span>
      </button>`).join('');
    const custom = STATE.customPlan ? `
      <button type="button" class="action-btn plan-btn" data-plan="D">
        <b>方案 D · 自定义保存</b><span class="plan-name">${STATE.customPlan.ts}</span>
      </button>` : '';
    return `<div class="cfg-hint" style="margin-bottom:6px">选择方案查看对比 ↓ · 点击"应用"写回集群配置</div>
      ${presets}${custom}
      <button type="button" class="action-btn" data-apply-plan="${STATE.comparePlan==='D'?'B':STATE.comparePlan}" style="margin-top:10px">
        ↳ 应用方案 ${STATE.comparePlan}<b>把该方案的机架部署写回当前配置</b></button>
      <button type="button" class="action-btn" data-save-plan>
        ⤓ 保存当前配置为方案 D<b>保存机架/节点/MHD/KV负载当前状态</b></button>
      <div class="note-box" style="margin-top:10px">全量 CXL 依然<b>保留 RDMA 网络</b>；全量 CXL 不等于所有 KV 自动进入 CXL。</div>`;
  }

  // ---------- 右侧面板 ----------
  function renderRight() {
    let kicker = 'SYSTEM STATUS', title = t('rightStatus'), subtitle = t('rightStatusSub'), body = '';
    if (STATE.page === 'kv' && STATE.selectedKV) {
      kicker = 'KV DOSSIER'; title = t('rightDossier'); subtitle = t('rightDossierSub');
      body = kvDossier(STATE.selectedKV);
    } else if (STATE.selectedKV) {
      kicker = 'KV DOSSIER'; title = t('rightDossier'); subtitle = t('rightDossierSub');
      body = kvDossier(STATE.selectedKV);
    } else if (STATE.selectedRack && (STATE.page === 'overview' || STATE.page === 'rack')) {
      kicker = 'RACK / ' + STATE.selectedRack; title = '机架技术档案'; subtitle = '部署 · 节点 · 容量';
      body = rackDossier(STATE.selectedRack);
    } else if (STATE.selectedLink && STATE.page === 'traffic') {
      kicker = 'LINK / ' + STATE.selectedLink; title = '链路状态'; subtitle = '负载 · 两端机架';
      body = linkDossier(STATE.selectedLink);
    } else {
      body = systemDossier();
    }
    $('#right-kicker').textContent = kicker;
    $('#right-title').textContent = title;
    $('#right-subtitle').textContent = subtitle;
    $('#right-body').innerHTML = body;
    $('#right-foot-label').textContent = STATE.selectedKV ? ('SELECTED / ' + STATE.selectedKV)
      : (STATE.selectedRack && (STATE.page==='overview'||STATE.page==='rack') ? 'SELECTED / '+STATE.selectedRack : 'SELECTED / NONE');
    bindRight();
  }

  function systemDossier() {
    const s = cxlStats();
    const m = S.computeMetrics();
    const rdma = rdmaUsed();
    const loads = Object.values(STATE.links);
    const high = loads.filter(l=>l==='high').length, mid = loads.filter(l=>l==='mid').length;
    return `<div class="empty-dossier"><div class="big">CXL<span>·</span>RDMA</div>
      <p>选择一个机架或 KV Block<br/>查看部署状态、访问画像与操作</p></div>
      <div class="detail-section"><h4>全局指标 GLOBAL</h4>
        <div class="metric-line"><span>已部署 CXL 机架</span><b class="cxl">${s.count} / 4</b></div>
        <div class="metric-line"><span>MHD 设备 / 总容量</span><b class="cxl">${s.units} 台 · ${s.total} GB</b></div>
        <div class="metric-line"><span>CXL 容量利用率</span><b class="cxl">${s.util}%</b></div>
        <div class="metric-line"><span>CXL 已用 / 总量</span><b>${s.used} / ${s.total} GB</b></div>
        <div class="metric-line"><span>RDMA Pool KV 占用</span><b class="rdma">${rdma} GB</b></div>
        <div class="metric-line"><span>KV 本地访问比例</span><b class="cxl">${Math.round(localKVCount()/KVS.length*100)}%</b></div>
        <div class="metric-line"><span>高/中负载链路</span><b class="warn">${high} / ${mid}</b></div>
      </div>
      <div class="detail-section"><h4>性能与成本 ESTIMATE</h4>
        <div class="metric-line"><span>平均 KV 访问时延</span><b class="cxl">${S.fmtNs(m.avgNs)}</b></div>
        <div class="metric-line"><span>P95 访问时延</span><b>${S.fmtNs(m.p95Ns)}</b></div>
        <div class="metric-line"><span>SLO 达标率</span><b class="${m.sloRate>=.8?'cxl':'warn'}">${Math.round(m.sloRate*100)}%</b></div>
        <div class="metric-line"><span>跨机架 KV 流量</span><b class="rdma">${m.crossGB} GB</b></div>
        <div class="metric-line"><span>部署成本 / 运行代价</span><b class="warn">${m.deployCost} / ${m.opCost} 万</b></div>
        <div class="metric-line"><span>目标值 C + α·O</span><b class="cxl">${m.objective}</b></div>
      </div>
      <div class="note-box">指标由<b>当前硬件配置 + KV 工作负载 + 链路流量</b>实时推算；数值为教学示意，非实测。</div>`;
  }

  function rackDossier(rid) {
    const r = getRack(rid), cxl = STATE.deployment[rid];
    const units = S.mhdUnitsForRack(rid);
    const cap = S.rackCapacity(rid), used = S.rackUsed(rid);
    return `<div class="detail-section">
      <div class="kv-title" style="font-size:16px">${r.name}</div>
      <div class="kv-sub">${cxl?'CXL + RDMA 混合机架':'RDMA-only 机架'}</div>
      <div class="info-grid">
        <div class="info-cell"><div class="k">GPU NODES</div><div class="v mono">4</div></div>
        <div class="info-cell"><div class="k">CXL NODES</div><div class="v mono" style="color:${cxl?C.cxl:'inherit'}">${cxl?S.connectedNodeCount(rid):0}</div></div>
        <div class="info-cell"><div class="k">MHD UNITS</div><div class="v mono">${units.length}</div></div>
        <div class="info-cell"><div class="k">RDMA</div><div class="v mono" style="color:${C.rdma}">已接入</div></div>
      </div></div>
      <div class="detail-section"><h4>节点连接 NODES</h4>
        ${r.nodes.map(n=>`<div class="metric-line"><span>${n.id} · ${n.role}</span><b style="font-size:10px;color:${S.nodeConnected(rid,n.id)?C.cxl:'var(--deep)'}">${S.nodeConnected(rid,n.id)?'CXL 接入':'RDMA'}</b></div>`).join('')}
      </div>
      ${units.length?`<div class="detail-section"><h4>共享内存设备 MHD UNITS</h4>
        <div class="metric-line"><span>合计容量 / 已用</span><b class="cxl">${cap} GB · ${used} GB（${cap?Math.round(used/cap*100):0}%）</b></div>
        ${units.map(m=>{
          const u = computeMhdUsed(m.id);
          const over = u > m.capacityGB;
          return `<div class="metric-line"><span>${m.id}</span><b style="font-size:10px;color:${over?'var(--warn)':C.cxl}">${m.capacityGB} GB · ${m.hostInterfaces} 口 · 用 ${u} GB</b></div>`;
        }).join('')}
      </div>`:''}
      ${portDossier(rid)}
      <div class="note-box">设备/U位/端口为<b>逻辑示意</b>。机架内多台 MHD 经 CXL Switch 汇聚为<b>一个共享内存池</b>，非各自独占。</div>`;
  }

  // 右侧端口档案：Host Port 占用 + 物理连接清单 + 可访问主机
  function portDossier(rid) {
    const cxl = STATE.deployment[rid];
    const sw = STATE.switchCfg[rid] || D.CXL_SWITCH_DEFAULT;
    const links = STATE.cxlLinks[rid] || [];
    const usedHost = S.usedHostPorts(rid);
    const units = S.unitIdsForRack(rid);
    const reach = [...new Set(units.flatMap(u => S.mhdReachableHosts(u)))];
    let hostRows = '';
    for (let i=1; i<=sw.hostPorts; i++) {
      const occ = links.find(l=>l.hostPort==='H'+i);
      hostRows += `<div class="metric-line"><span>Host Port H${i}</span><b style="font-size:10px;color:${occ?C.cxl:'var(--deep)'}">${occ?occ.node+' · 已占用':'空闲'}</b></div>`;
    }
    let linkRows = links.length ? links.map(l=>
      `<div class="metric-line"><span>${l.node}</span><b style="font-size:9px;color:${C.cxl}">${l.hostPort}→M1→${l.mhdId}</b></div>`).join('')
      : `<div class="metric-line"><span>物理连接</span><b style="font-size:10px;color:var(--deep)">未建立</b></div>`;
    return `<div class="detail-section"><h4>端口映射 PORT MAPPING</h4>
      <div class="metric-line"><span>CXL Switch Host Port</span><b class="cxl">${usedHost} / ${sw.hostPorts}</b></div>
      ${hostRows}
      <div style="height:6px"></div>
      <h4>物理连接 CXL LINKS</h4>${linkRows}
      <div class="metric-line"><span>共享池可访问</span><b style="font-size:10px">${reach.length} 台</b></div>
      <div class="metric-line"><span>RDMA ToR</span><b style="font-size:10px;color:${C.rdma}">4 台 NIC 接入</b></div>
      ${units.length?`<div class="metric-line"><span>设备分配</span><b style="font-size:9px;color:${C.cxl}">${units.map(u=>u+'×'+links.filter(l=>l.mhdId===u).length).join(' · ')}</b></div>`:''}
      ${cxl?`<button type="button" class="action-btn" id="reset-links" data-rid="${rid}" style="margin-top:8px">
        ⟲ 重置为 N1/N2 默认连接<b>清空手动端口连接，恢复默认共享接入</b></button>`:''}
    </div>`;
  }

  function kvDossier(id) {
    const k = getKV(id);
    if (!k) return '';
    const loc = k.location === 'rdma' ? 'RDMA Pool' : (getMhd(k.location.split(':')[1])||{}).name;
    const total = Object.values(k.dist).reduce((a,b)=>a+b,0) || 1;
    const colors = [C.cxl, C.rdma, C.shared, C.hotMid];
    let distBars = '<div class="dist-bar">';
    let distItems = '';
    Object.keys(k.dist).forEach((rk,i)=>{
      const p = Math.round(k.dist[rk]/total*100);
      distBars += `<i style="width:${p}%;background:${colors[i%colors.length]}"></i>`;
    });
    distBars += '</div>';
    Object.keys(k.dist).forEach((rk,i)=>{
      const p = Math.round(k.dist[rk]/total*100);
      distItems += `<div class="dist-item"><span><i style="background:${colors[i%colors.length]}"></i>${rk}</span><span>${p}%</span></div>`;
    });

    // 淘汰操作可用性判断
    const canEvict = k.replicas.length > 0;

    // 可作为放置/复制/迁移目标的机架（已部署 CXL + 容量足够 + 至少接入 1 节点）
    const eligible = RACKS.filter(r => {
      const m = mhdForRack(r.id);
      return STATE.deployment[r.id] && m && S.connectedNodeCount(r.id) > 0 &&
        (m.capacityGB - computeMhdUsed(m.id)) >= k.sizeGB;
    });
    const targetBtns = eligible.length
      ? eligible.map(r=>`<button type="button" class="seg" data-act="replicate" data-payload="${r.id}">复制到 ${r.name}</button>`).join('')
      : `<span class="cfg-hint">暂无满足条件的机架（需部署 CXL + 有节点接入 + 容量充足）</span>`;
    const migrateBtns = eligible.length
      ? eligible.map(r=>`<button type="button" class="seg" data-act="migrate" data-payload="${r.id}">迁移到 ${r.name}</button>`).join('')
      : '';
    const hotSegs = ['high','mid','low'].map(h=>
      `<button type="button" class="seg ${k.hotness===h?'on':''}" data-act="setHotness" data-payload="${h}">${{high:'热',mid:'中',low:'冷'}[h]}</button>`).join('');

    return `<div class="detail-section">
      <h4>KV BLOCK</h4>
      <div class="kv-title">${k.id}</div>
      <div class="kv-sub">${esc(k.note||'KV Cache Block')} · ${STATE.scenario==='CUSTOM'?'自定义':STATE.scenario} 场景</div>
      <div class="info-grid">
        <div class="info-cell"><div class="k">PRODUCER</div><div class="v mono">${k.producer}</div></div>
        <div class="info-cell"><div class="k">SIZE</div><div class="v mono">${k.sizeGB} GB</div></div>
        <div class="info-cell"><div class="k">LOCATION</div><div class="v" style="font-size:10px">${esc(loc)}</div></div>
        <div class="info-cell"><div class="k">STATUS</div><div class="v" style="font-size:10px">${k.replicas.length?'Replica':'Original'}</div></div>
      </div>
      <div class="cfg-row" style="margin-top:8px"><span>热度 HOTNESS</span><span class="seg-group">${hotSegs}</span></div>
    </div>
    <div class="detail-section"><h4>访问分布 ACCESS</h4>${distBars}${distItems}</div>
    ${k.replicas.length?`<div class="detail-section"><h4>副本 REPLICAS</h4>
      ${k.replicas.map(rep=>`<div class="metric-line"><span>${rep.rackId} · ${rep.location}</span><b style="color:${C.replica};font-size:10px">REPLICA</b></div>`).join('')}
    </div>`:''}
    <div class="detail-section"><h4>复制 REPLICATE（原创保留）</h4>
      <div class="seg-wrap">${targetBtns}</div>
    </div>
    <div class="detail-section"><h4>迁移 MIGRATE（原创移动）</h4>
      <div class="seg-wrap">${migrateBtns||'<span class="cfg-hint">无可迁移目标</span>'}</div>
    </div>
    <div class="detail-section"><h4>其他操作 ACTIONS</h4>
      <button class="action-btn" data-act="evict" ${canEvict?'':'disabled'}>
        ⟲ 淘汰副本<b>释放 MHD 容量 · 原始 KV 保留在 RDMA Pool</b></button>
      <button class="action-btn" data-act="trace">
        ◎ 在 Traffic 页追踪访问路径<b>查看 RDMA / CXL 访问与副本路径动画</b></button>
    </div>
    <div class="note-box">热度、容量与访问分布均为<b>预设示意数据</b>；复制保留原始，迁移移动原始。</div>`;
  }

  function linkDossier(lid) {
    const l = LINKS.find(x=>x.id===lid), load = STATE.links[lid];
    return `<div class="detail-section"><h4>LINK</h4>
      <div class="kv-title" style="font-size:16px">${l.a} — ${l.b}</div>
      <div class="kv-sub">Leaf-Spine RDMA Fabric 机架间链路</div>
      <div class="info-grid">
        <div class="info-cell"><div class="k">SOURCE</div><div class="v mono">${l.a}</div></div>
        <div class="info-cell"><div class="k">DEST</div><div class="v mono">${l.b}</div></div>
        <div class="info-cell"><div class="k">CAPACITY</div><div class="v mono">200 Gbps</div></div>
        <div class="info-cell"><div class="k">LOAD</div><div class="v" style="color:${loadColor(load)}">${loadName(load)}</div></div>
      </div></div>
      <div class="note-box">链路负载由<b>场景预设</b>给定，颜色仅为示意。</div>`;
  }

  // ---------- KV 分布视图 ----------
  function renderDist() {
    const el = $('#dist-view');
    if (STATE.page !== 'kv') { el.hidden = true; return; }
    el.hidden = false;
    const deployed = RACKS.filter(r=>STATE.deployment[r.id]);
    const pools = deployed.flatMap(r => S.mhdUnitsForRack(r.id).map(m => {
      const kvs = KVS.filter(k => {
        const rt = getKV(k.id);
        return rt.location === 'mhd:'+m.id || rt.replicas.some(rep=>rep.location===m.id);
      });
      const used = computeMhdUsed(m.id);
      return poolCard(r.id+' · '+m.id, 'cxl', `${used} / ${m.capacityGB} GB`, kvs, m.id, used, m.capacityGB);
    }));
    const rdmaKvs = KVS.filter(k => getKV(k.id).location === 'rdma');
    pools.push(poolCard('RDMA Remote Memory Pool', 'rdma', `${rdmaUsed()} / ${RDMA_POOL_CAP} GB`, rdmaKvs, 'RDMA', rdmaUsed(), RDMA_POOL_CAP));
    // 两列布局
    el.innerHTML = `<div class="pool-grid">${pools.join('')}</div>
      <div class="note-box" style="margin-top:12px">KV 分布示意：具体位置和容量由当前场景决定；<b>副本与原始分别计数</b>。</div>`;
    $$('.kv-chip', el).forEach(c => c.addEventListener('click', ()=>{
      STATE.selectedKV = c.getAttribute('data-kv');
      S.log('选中 KV ' + STATE.selectedKV, true);
      window.__APP__.render();
    }));
  }
  const RDMA_POOL_CAP = D.RDMA_POOL.capacityGB;

  function poolCard(title, cls, cap, kvs, poolId, used, total) {
    const pct = Math.min(100, Math.round(used/total*100));
    return `<div class="pool-card ${cls}">
      <div class="pool-card__head"><b>${title}</b><span>${cls==='cxl'?'CXL MHD':'RDMA'}</span></div>
      <div class="pool-card__cap">已用 ${cap}</div>
      <div class="pool-card__bar"><i style="width:${pct}%"></i></div>
      <div class="kv-chips">${kvs.length?kvs.map(k=>{
        const rt = getKV(k.id);
        const isRep = rt.replicas.some(rep=> poolId!=='RDMA' && rep.location===poolId);
        return `<span class="kv-chip ${isRep?'replica':''}" data-kv="${k.id}"><i style="background:${hotColor(rt.hotness)}"></i>${k.id}</span>`;
      }).join(''):'<span class="empty-tip">（空）</span>'}</div>
    </div>`;
  }

  // ---------- 分析面板（Traffic / Compare）----------
  function renderAnalysis() {
    const el = $('#analysis');
    if (STATE.page !== 'traffic' && STATE.page !== 'compare') { el.hidden = true; return; }
    el.hidden = false;
    if (STATE.page === 'traffic') {
      const sc = SCENARIOS.find(s=>s.id===STATE.scenario);
      const loads = LINKS.map(l=>({id:l.id,load:STATE.links[l.id]}));
      const steps = sc ? sc.steps.map(s=>`<li>${esc(s)}</li>`).join('')
        : `<li>当前为自定义配置：在左侧调节拥塞预设或单链路流量，观察链路颜色/线宽变化。</li><li>选中一个 KV 查看其跨机架访问路径随配置更新。</li>`;
      el.innerHTML = `<div class="analysis-grid">
        <div class="panel-card"><h3>场景：${sc?sc.name:'自定义配置'}</h3><p class="cap">${sc?sc.num+' / '+sc.kicker:'CUSTOM / 实时调节'}</p>
          <p style="font-size:10px;line-height:1.7;color:var(--soft);margin:0 0 10px">${sc?esc(sc.desc):'用户通过配置面板改变部署、负载与网络流量，系统状态与可视化实时联动。'}</p>
          <div class="note-box"><b>展示目的：</b>${sc?esc(sc.goal):'观察配置变化对链路负载与 KV 访问路径的影响。'}</div>
          <h4 style="margin:14px 0 4px;font-family:var(--mono);font-size:9px;color:var(--accent)">演示步骤 SCENARIO STEPS</h4>
          <ol class="step-list">${steps}</ol>
        </div>
        <div class="panel-card"><h3>RDMA 链路负载</h3><p class="cap">预设数据 · 非真实拥塞仿真</p>
          ${loads.map(l=>`<div class="bar-row"><span>${l.id} · ${LINKS.find(x=>x.id===l.id).a}–${LINKS.find(x=>x.id===l.id).b}</span>
            <span class="bar-track"><i style="width:${{low:25,mid:62,high:92}[l.load]}%;background:${loadColor(l.load)}"></i></span>
            <span class="bar-val" style="color:${loadColor(l.load)}">${loadName(l.load)}</span></div>`).join('')}
          <div class="note-box">多机架同时访问某批 KV → 相关链路负载升高（示意）。</div>
        </div>
      </div>`;
    } else {
      // 动态方案指标：基于当前 KV 工作负载派生，模型估算（示意，非实测）
      const d = S.workloadDerived();
      const plans = planMetrics();
      const selected = plans.find(x=>x.id===STATE.comparePlan) || plans[1];
      const rows = [
        ['CXL 部署机架数', ...plans.map(p=>String(p.racks))],
        ['MHD 总容量 (GB)', ...plans.map(p=>String(p.capacity))],
        ['硬件+安装成本 (万元)', ...plans.map(p=>String(p.cost))],
        ['CXL 容量利用率', ...plans.map(p=>p.util+'%')],
        ['KV 本地访问率', ...plans.map(p=>p.local+'%')],
        ['RDMA 流量指数', ...plans.map(p=>String(p.traffic))],
        ['迁移/复制开销 (示意)', ...plans.map(p=>String(p.migrateCost))],
        ['估算访问延迟 (相对)', ...plans.map(p=>p.latency)],
        ['综合得分 (越高越好)', ...plans.map(p=>String(p.score))]
      ];
      el.innerHTML = `<div class="analysis-grid" style="grid-template-columns:1.45fr 1fr">
        <div class="panel-card"><h3>方案对比矩阵</h3><p class="cap">A 全量 RDMA · B 增量 CXL · C 全量 CXL · D 自定义（动态估算）</p>
          <table class="cmp-table"><thead><tr><th>指标</th>${plans.map(p=>`<th class="${p.id===STATE.comparePlan?'hl':''}">${p.id} ${p.name}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r=>`<tr><td class="metric">${r[0]}</td>${r.slice(1).map((v,i)=>`<td class="${plans[i].id===STATE.comparePlan?'hl':''}">${v}</td>`).join('')}</tr>`).join('')}</tbody></table>
          <div class="note-box">全部指标为<b>模型估算/示意值</b>，非真实测试结果。CXL 不等于所有 KV 自动进入 CXL。</div>
        </div>
        <div class="panel-card"><h3>成本与收益（示意）</h3><p class="cap">当前选中：方案 ${selected.id} · ${selected.name}</p>
          ${costCompare()}
          <div class="field-row" style="margin-top:12px"><span>MHD 单价（万元）</span><span class="val">${COST_PARAMS.mhdUnitCost}</span></div>
          <div class="field-row"><span>机架安装（万元）</span><span class="val">${COST_PARAMS.installCost}</span></div>
          <div class="field-row"><span>KV 总容量（GB）</span><span class="val">${d.total} · 热 ${d.hotRatio||STATE.workload.hotRatio}%</span></div>
          <div class="note-box">综合得分 = 本地访问收益 − 成本/开销加权（<b>示意模型</b>）。点左侧"应用方案"可把配置写回集群。</div>
        </div>
      </div>`;
    }
  }

  // 计算各方案动态指标（模型估算，标注示意）
  function planMetrics() {
    const d = S.workloadDerived();
    const w = STATE.workload;
    const list = DEPLOY_PLANS.map(p => ({ id:p.id, name:p.name, racks:p.racks.filter(Boolean).length,
      capacity:p.racks.filter(Boolean).length*512 }));
    if (STATE.customPlan) list.push({ id:'D', name:'自定义', racks:STATE.customPlan.racks.filter(Boolean).length,
      capacity:STATE.customPlan.total });
    return list.map(p => {
      const cost = p.racks * (COST_PARAMS.mhdUnitCost + COST_PARAMS.installCost);
      // 本地访问率：随 CXL 机架数递增（示意模型，上限受 workload.localRatio 约束）
      const local = p.racks === 0 ? Math.round(w.localRatio*0.35)
        : Math.min(95, Math.round(w.localRatio * (0.55 + 0.15*p.racks)));
      const traffic = Math.round((w.requestRate/100) * (100-local) * 1.2);
      const migrateCost = Math.round((d.shared * (p.racks>0?0.8:0.2)) + (4-p.racks)*2);
      const latency = (100 - local*0.55 + traffic*0.03).toFixed(1);
      const util = p.racks ? Math.min(100, Math.round(100*w.totalGB/(p.capacity||512)/p.racks)) : 0;
      const score = Math.round(local*0.6 - cost*0.25 - migrateCost*0.15 + 20);
      return Object.assign(p, { cost, local, traffic, migrateCost, latency, util, score });
    });
  }

  function costCompare() {
    return planMetrics().map(p => {
      const max = 4*(COST_PARAMS.mhdUnitCost+COST_PARAMS.installCost);
      const pct = Math.min(100, Math.round(p.cost/max*100));
      return `<div class="bar-row"><span>方案 ${p.id} · ${p.name}</span>
        <span class="bar-track"><i style="width:${pct}%;background:${p.id==='B'?C.cxl:C.rdma}"></i></span>
        <span class="bar-val">${p.cost}</span></div>`;
    }).join('');
  }

  // ---------- 侧栏事件绑定 ----------
  function bindLeft() {
    $$('[data-head]').forEach(h => h.addEventListener('click', ()=>{
      const id = h.getAttribute('data-head');
      STATE._openRacks = STATE._openRacks || {};
      STATE._openRacks[id] = !STATE._openRacks[id];
      STATE.selectedRack = id; STATE.selectedKV = null;
      window.__APP__.render();
    }));
    $$('[data-toggle-rack]').forEach(b => b.addEventListener('click', e=>{
      e.stopPropagation();
      window.__APP__.toggleRack(b.getAttribute('data-toggle-rack'));
    }));
    $$('[data-nodepick]').forEach(b => b.addEventListener('click', e=>{
      e.stopPropagation();
      const [rid, nid] = b.getAttribute('data-nodepick').split('-');
      window.__APP__.toggleNode(rid, nid);
    }));
    $$('[data-unit-cap]').forEach(i => i.addEventListener('change', ()=>{
      window.__APP__.setUnitCapacity(i.getAttribute('data-unit-cap'), +i.value);
    }));
    $$('[data-unit-iface]').forEach(i => i.addEventListener('change', ()=>{
      window.__APP__.setUnitIfaces(i.getAttribute('data-unit-iface'), +i.value);
    }));
    $$('[data-unit-add]').forEach(b => b.addEventListener('click', e=>{
      e.stopPropagation();
      window.__APP__.addUnit(b.getAttribute('data-unit-add'));
    }));
    $$('[data-unit-del]').forEach(b => b.addEventListener('click', e=>{
      e.stopPropagation();
      const [rid, mid] = b.getAttribute('data-unit-del').split('|');
      window.__APP__.removeUnit(rid, mid);
    }));
    // KV 工作负载 / 单链路流量用 change（松手后提交），避免拖动中 DOM 重建中断
    $$('[data-wl]').forEach(i => i.addEventListener('change', ()=>{
      window.__APP__.setWorkload(i.getAttribute('data-wl'), +i.value);
    }));
    $$('[data-flow]').forEach(i => i.addEventListener('change', ()=>{
      window.__APP__.setLinkFlow(i.getAttribute('data-flow'), +i.value);
    }));
    $$('[data-congestion]').forEach(b => b.addEventListener('click', ()=>{
      window.__APP__.setCongestion(b.getAttribute('data-congestion'));
    }));
    // 硬件库：拖拽 + 点击部署
    $$('[data-drag-hw]').forEach(item => {
      item.addEventListener('click', ()=> window.__APP__.deployHardware(item.getAttribute('data-drag-hw')));
      item.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/hw', item.getAttribute('data-drag-hw'));
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
    const dropTarget = $('#hwlib-target');
    if (dropTarget) {
      dropTarget.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='copy'; dropTarget.classList.add('drag-over'); });
      dropTarget.addEventListener('dragleave', ()=> dropTarget.classList.remove('drag-over'));
      dropTarget.addEventListener('drop', e => {
        e.preventDefault(); dropTarget.classList.remove('drag-over');
        const type = e.dataTransfer.getData('text/hw');
        if (type) window.__APP__.deployHardware(type, dropTarget.getAttribute('data-drop-rack'));
      });
    }
    $$('[data-swports]').forEach(i => i.addEventListener('change', ()=>{
      window.__APP__.setSwitchPorts(i.getAttribute('data-swports'), +i.value);
    }));
    $$('[data-apply-plan]').forEach(b => b.addEventListener('click', ()=>{
      window.__APP__.applyPlan(b.getAttribute('data-apply-plan'));
    }));
    $$('[data-save-plan]').forEach(b => b.addEventListener('click', ()=>{
      window.__APP__.savePlan();
    }));
    $$('[data-kv]').forEach(k => k.addEventListener('click', ()=>{
      STATE.selectedKV = k.getAttribute('data-kv'); STATE.selectedRack = null;
      S.log('选中 KV ' + STATE.selectedKV, true);
      window.__APP__.render();
    }));
    $$('[data-link]').forEach(l => l.addEventListener('click', ()=>{
      STATE.selectedLink = l.getAttribute('data-link');
      window.__APP__.render();
    }));
    $$('[data-plan]').forEach(p => p.addEventListener('click', ()=>{
      STATE.comparePlan = p.getAttribute('data-plan');
      window.__APP__.render();
    }));
  }

  function bindRight() {
    $$('[data-act]').forEach(b => b.addEventListener('click', ()=>{
      const act = b.getAttribute('data-act');
      const payload = b.getAttribute('data-payload');
      window.__APP__.handleAction(act, payload);
    }));
    const resetLinks = $('#reset-links');
    if (resetLinks) resetLinks.addEventListener('click', ()=>{
      window.__APP__.resetLinks(resetLinks.getAttribute('data-rid'));
    });
  }

  // ---------- 底部 KPI / 日志 ----------
  function renderConsole() {
    if (STATE.page === 'lc') { renderLog(); return; }   // lc 页 KPI 由生命周期面板接管
    const s = cxlStats(), m = S.computeMetrics();
    const kpis = [
      ['CXL RACKS', `${s.count}<small> /4</small>`, 'cxl'],
      ['MHD UNITS', `${s.units}<small> 台</small>`, 'cxl'],
      ['CXL CAP.', `${s.total}<small> GB</small>`, ''],
      ['AVG LATENCY', `${S.fmtNs(m.avgNs).replace(' ','')}<small> </small>`, 'cxl'],
      ['SLO HIT', `${Math.round(m.sloRate*100)}<small> %</small>`, m.sloRate>=.8?'cxl':'warn'],
      ['DEPLOY COST', `${m.deployCost}<small> 万</small>`, 'warn']
    ];
    $('#kpi-strip').innerHTML = kpis.map(k=>`<div class="kpi-cell"><span class="kpi-label">${k[0]}</span><b class="${k[2]}">${k[1]}</b></div>`).join('');
    renderLog();
  }
  function renderLog() {
    const el = $('#event-log');
    if (!el) return;
    el.innerHTML = STATE.logs.map(l=>`<div><span class="ts">${l.ts}</span> <span class="ev ${l.hl?'hl':''}">${esc(l.msg)}</span></div>`).join('')
      || '<div><span class="ts">系统就绪 · 等待操作</span></div>';
  }

  // ---------- 场景条 / 时间轴 ----------
  function renderScenarioUI() {
    $('#scenario-chips').innerHTML = SCENARIOS.map(s=>`<button type="button" class="sc-chip ${s.id===STATE.scenario?'is-active':''}" data-sc="${s.id}"><i>${s.num}</i>${s.name}</button>`).join('');
    const idx = SCENARIOS.findIndex(s=>s.id===STATE.scenario);
    const range = $('#timeline-range'); range.value = idx < 0 ? 0 : idx;
    $('#timeline-value').textContent = idx < 0 ? '自定义' : STATE.scenario;
    $('#scenario-quick-label').textContent = idx < 0 ? 'CUSTOM · 自定义配置' : `${STATE.scenario} · ${SCENARIOS[idx].name}`;
    $$('[data-sc]').forEach(b=>b.addEventListener('click',()=> window.__APP__.loadScenario(b.getAttribute('data-sc'))));
  }

  window.__RENDER_PANELS__ = { renderLeft, renderRight, renderDist, renderAnalysis, renderConsole, renderScenarioUI, renderLog };
})();
