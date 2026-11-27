/* ============================================================
 * app-controller.js — 场景加载 / KV 操作动画 / 播放 / 初始化
 * ============================================================ */
(function () {
  'use strict';
  const S = window.__SIM__;
  const { STATE, D, $, $$, t, getKV, getMhd, mhdForRack, computeMhdUsed, log, toast } = S;
  const { RACKS, KVS, LINKS, SCENARIOS, DEPLOY_PLANS } = D;
  const C = D.COLORS;
  const { nodeConnected, connectedNodeCount, syncMhdNodes, syncLinkLoads,
          workloadDerived, applyWorkloadToKV } = S;

  const APP = {};

  // ---------- 全量渲染 ----------
  APP.render = function () {
    // 页面类名（用于布局差异，如 traffic 页分析面板分栏）
    $('#app').setAttribute('data-page', STATE.page);
    // 页面 tab
    $$('.page-tab').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-page') === STATE.page));
    $$('[data-i18n]').forEach(el => el.textContent = t(el.getAttribute('data-i18n')));
    // 语言按钮
    $$('.lang-btn').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-lang') === STATE.lang));
    // 「运行流程」页：自带舞台与左右面板，不经过 SVG / WebGL 渲染器
    if (STATE.page === 'run' && window.__RENDER_FLOW__) {
      // 先收起机架解剖三维等"靠行内样式挂显隐"的浮层（GLUI/GLA 只在本函数末尾
      // 同步，而这里提前 return 会跳过它们）—— 否则从 03 三维视图直接切 01
      // 会出现两层页面重合
      if (window.__GLUI__) { try { window.__GLUI__.sync(); } catch (e) {} }
      if (window.__GLA__) { try { window.__GLA__.sync(); } catch (e) {} }
      window.__RENDER_FLOW__.renderAll();
      return;
    }
    // 场景状态栏
    updateStageHeader();
    updateScenarioLabel();
    // 各区域
    if (STATE.page === 'lc' && window.__RENDER_LC__) {
      window.__RENDER_LC__.renderAll();
    } else {
      window.__RENDER_PANELS__.renderLeft();
      window.__RENDER_PANELS__.renderRight();
    }
    window.__RENDER_PANELS__.renderConsole();
    if (!(STATE.page === 'lc' && window.__RENDER_LC__)) window.__RENDER_PANELS__.renderScenarioUI();
    window.__RENDER_PANELS__.renderDist();
    window.__RENDER_PANELS__.renderAnalysis();
    // rack 页委托给硬件拓扑工作台（三种视角）；其余页用原 SVG 渲染器
    if (STATE.page === 'rack') {
      window.__RENDER_HW__.renderHardware();
    } else if (STATE.page === 'lc' && window.__RENDER_LC__) {
      window.__RENDER_LC__.sync();
    } else {
      window.__RENDER_SVG__.renderCanvas();
    }
    // traffic 页聚焦视图，避免 SVG 内容在分栏后被压得过小
    const canvas = $('#canvas');
    if (canvas) {
      // 每个视图给一个贴合内容的默认视窗，等价于默认放大一档，小屏也能看清标注
      let vb = [0, 0, 1200, 720];
      if (STATE.page === 'traffic') vb = [90, 130, 1020, 560];
      else if (STATE.page === 'rack' && STATE.hwView === 'pipeline') vb = [26, 84, 1152, 628];
      else if (STATE.page === 'overview' && STATE.oview === '3d') vb = [22, 46, 1164, 652];
      if (window.__ZOOM__) { window.__ZOOM__.setBase(vb); window.__ZOOM__.apply(); }
      else canvas.setAttribute('viewBox', vb.join(' '));
    }
    // 硬件视角切换按钮状态
    $$('[data-hwview]').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-hwview') === STATE.hwView));
    // 3D 集群部署同步：部署状态变化时 WebGL 侧一起变（生长/收回动画，未挂载时为空操作）
    syncCluster3d(true);
    // 三维视图交给 WebGL 场景（不可用时回落 SVG）
    if (window.__GLUI__) { try { window.__GLUI__.sync(); } catch (e) {} }
    if (window.__GLA__) { try { window.__GLA__.sync(); } catch (e) {} }
  };

  APP.renderRightOnly = function () {
    window.__RENDER_PANELS__.renderRight();
    window.__RENDER_PANELS__.renderConsole();
  };

  // ---------- 02 集群总览 · 2D/3D 切换（原 06 三维建模合并入口） ----------
  // 确保三维集群容器存在并挂载（与 lc 页共用 #gllc 与 __GLCLUSTER__ 单例）
  function ensureCluster3d() {
    if (!window.__GLCLUSTER__ || !window.__GLCLUSTER__.available) {
      toast('WebGL 不可用 · 回落 2D 视图');
      return null;
    }
    let host = document.getElementById('gllc');
    if (!host) {
      host = document.createElement('div');
      host.id = 'gllc';
      $('#stage').insertBefore(host, $('#stage-hint'));
    }
    if (!window.__CLUSTER3D_MOUNTED__) {
      window.__GLCLUSTER__.mount(host, { onSelect: id => { if (id) toast('选中 ' + id); } });
      window.__CLUSTER3D_MOUNTED__ = true;
      syncCluster3d(false);   // 首次挂载即时对齐当前部署状态（无动画）
    }
    return host;
  }
  // 部署状态 → 3D 集群：APP.render 统一调用，部署变化时 3D 侧播放生长/收回动画
  function syncCluster3d(animate) {
    if (!window.__CLUSTER3D_MOUNTED__ || !window.__GLCLUSTER__ || !window.__GLCLUSTER__.available) return;
    const ids = RACKS.filter(r => STATE.deployment[r.id]).map(r => r.id);
    window.__GLCLUSTER__.setDeploy(ids, animate !== false);
  }
  APP.toggleOverview3d = function (force) {
    if (typeof force === 'boolean') STATE.view3d = force;
    else STATE.view3d = !STATE.view3d;
    const app = $('#app');
    app.setAttribute('data-v3d', STATE.view3d ? '1' : '0');
    const btn = $('#view3d-btn');
    if (btn) {
      btn.classList.toggle('is-active', !!STATE.view3d);
      btn.textContent = STATE.view3d ? '返回 2D' : '三维';
    }
    if (!STATE.view3d) { log('集群总览 → 2D 平面拓扑', true); return; }
    const host = ensureCluster3d();
    if (!host) {
      app.setAttribute('data-v3d', '0'); STATE.view3d = false;
      if (btn) { btn.classList.remove('is-active'); btn.textContent = '三维'; }
      return;
    }
    // 入场动画：淡入 + 轻微上移（CSS is-entering）
    host.classList.remove('is-entering');
    void host.offsetWidth;
    host.classList.add('is-entering');
    setTimeout(() => host.classList.remove('is-entering'), 950);
    window.__GLCLUSTER__.resize();
    log('集群总览 → WebGL 三维视图（与 2D 同步联动）', true);
  };

  function updateStageHeader() {
    const st = S.cxlStats();
    const m = S.computeMetrics();
    const map = {
      overview: ['CLUSTER TOPOLOGY · LEAF-SPINE RDMA', `4 RACKS · ${st.count} CXL RACKS · ${st.units} MHD · AVG ${S.fmtNs(m.avgNs)}`],
      rack: ['HARDWARE TOPOLOGY · ' + ({physical:'PHYSICAL RACK',network:'LEAF-SPINE',threeD:'ISOMETRIC',pipeline:'INFERENCE PIPELINE'}[STATE.hwView]||'PHYSICAL RACK'),
             STATE.selectedRack + ' · ' + ({physical:'U位 / 端口 / CXL连接',network:'RDMA + 机架内CXL',threeD:'4 RACKS · 可旋转',pipeline:'GPU/HBM · KV 生命周期'}[STATE.hwView]||'')],
      kv: ['KV CACHE DISTRIBUTION', 'CXL MHD vs RDMA POOL · 示意'],
      traffic: ['RDMA ACCESS PATHS · LINK LOAD', 'SCENARIO ' + STATE.scenario],
      compare: ['DEPLOYMENT COMPARISON', 'A / B / C 方案对比']
    };
    const mm = map[STATE.page] || map.overview;
    $('#stage-state-text').textContent = mm[0];
    $('#stage-state-detail').textContent = mm[1];
    $('#stage-hint').textContent = (STATE.page === 'kv') ? t('clickKv') : t('clickRack');
  }

  // ---------- 页面切换 ----------
  APP.switchPage = function (page) {
    STATE.page = page;
    // 进入 KV 页或 Traffic 页且未选中 KV 时，默认选中当前场景焦点 KV（或 KV-003），
    // 以便右侧立即展示画像、Traffic 页立即显示访问路径——这是本模拟器的核心展示点
    if ((page === 'kv' || page === 'traffic') && !STATE.selectedKV) {
      const sc = SCENARIOS.find(s=>s.id===STATE.scenario);
      STATE.selectedKV = (sc && sc.focusKV) || 'KV-003';
    }
    log('切换页面 → ' + page);
    APP.render();
    if (page === 'lc' && window.__RENDER_LC__) window.__RENDER_LC__.onEnter();
    if (page === 'run' && window.__RENDER_FLOW__) window.__RENDER_FLOW__.onEnter();
    if (page !== 'run' && window.__RENDER_FLOW__) window.__RENDER_FLOW__.pause();
  };

  // ---------- 场景加载 ----------
  APP.loadScenario = function (sid, silent) {
    const sc = SCENARIOS.find(s => s.id === sid);
    if (!sc) return;
    STATE.scenario = sid;
    STATE.step = SCENARIOS.indexOf(sc);

    // 重置运行时数据到初始，再应用场景覆盖
    S.initState();
    Object.keys(sc.overrides).forEach(kid => {
      const ov = sc.overrides[kid];
      if (!STATE.kvRuntime[kid]) return;
      if (ov.location !== undefined) STATE.kvRuntime[kid].location = ov.location;
      if (ov.hotness !== undefined) STATE.kvRuntime[kid].hotness = ov.hotness;
      if (ov.dist !== undefined) STATE.kvRuntime[kid].dist = Object.assign({}, ov.dist);
      if (ov.replicas !== undefined) STATE.kvRuntime[kid].replicas = ov.replicas.map(r=>Object.assign({},r));
    });
    Object.keys(sc.links).forEach(lid => { STATE.links[lid] = sc.links[lid]; STATE.linkFlow[lid] = {low:22,mid:58,high:92}[sc.links[lid]]; });
    syncLinkLoads();
    // 重建物理 CXL 连接（场景加载后同步物理层）
    S.initCxlLinks();
    // S4：默认展示复制后的结果（预置副本）；若通过界面点击进入（非 silent），
    // 则先清空副本、播放复制动画，演示"复制前→后"的完整过程。
    if (sc.autoReplicate && !silent) {
      STATE.kvRuntime['KV-003'].replicas = [];
    }
    if (sc.focusKV) STATE.selectedKV = sc.focusKV;
    if (!silent) log(`载入场景 ${sid} · ${sc.name}`, true);
    APP.render();
    if (sc.autoReplicate && !silent) {
      const kv = getKV('KV-003');
      const target = RACKS.find(r => STATE.deployment[r.id] && (kv.dist[r.id]||0)>=0.3 && unitWithSpace(r.id, kv.sizeGB));
      if (kv && kv.replicas.length === 0 && target) {
        setTimeout(()=> APP.animateReplication(kv, target, unitWithSpace(target.id, kv.sizeGB)), 700);
      }
    }
  };

  // ============================================================
  // 交互式配置层：任何配置变更都统一走 commit() 触发三处同步刷新
  // （中间架构图 / 右侧档案 / 底部 KPI 随 APP.render 一起更新）
  // ============================================================
  function commit(msg) {
    if (msg) S.log(msg, true);
    STATE.scenario = 'CUSTOM'; // 用户自定义后标记场景为自定义
    updateScenarioLabel();
    // 任何配置变更都从 nodeConfig 重建物理连接，保证"配置层↔物理层"始终一致
    S.initCxlLinks();
    APP.render();
  }
  function updateScenarioLabel() {
    const custom = STATE.scenario === 'CUSTOM';
    const sc = SCENARIOS.find(s => s.id === STATE.scenario);
    const label = custom ? 'CUSTOM · 自定义配置' : `${STATE.scenario} · ${sc ? sc.name : ''}`;
    const q = $('#scenario-quick-label'); if (q) q.textContent = label;
    $$('.sc-chip').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-sc') === STATE.scenario));
  }

  // 机架级 CXL 部署开关（开启时自动创建 1 台共享 MHD 设备）
  APP.toggleRack = function (rid) {
    STATE.deployment[rid] = !STATE.deployment[rid];
    if (STATE.deployment[rid]) {
      S.ensureRackUnits(rid, 1);
      const nSlots = Math.min(S.hostPortCapacity(rid), 2);
      const rack = RACKS.find(r => r.id === rid);
      rack.nodes.slice(0, nSlots).forEach(n => { STATE.nodeConfig[rid][n.id] = true; });
    } else {
      const rack = RACKS.find(r => r.id === rid);
      rack.nodes.forEach(n => { STATE.nodeConfig[rid][n.id] = false; });
    }
    commit(`${rid} CXL 部署 → ${STATE.deployment[rid] ? '开启' : '关闭'}（设备 ${S.unitsCount(rid)} 台）`);
  };

  // 节点 CXL 接入开关（受 Host Port 与设备接口数上限约束）
  APP.toggleNode = function (rid, nid) {
    const rack = RACKS.find(r=>r.id===rid);
    const mhd = mhdForRack(rid);
    if (!mhd) { toast('该机架未部署 CXL MHD'); return; }
    if (!STATE.nodeConfig[rid]) STATE.nodeConfig[rid] = {};
    const next = !STATE.nodeConfig[rid][nid];
    STATE.nodeConfig[rid][nid] = next;
    S.initCxlLinks();
    commit(`${rid} · ${nid} ${next?'接入':'断开'} CXL MHD`);
    if (next && !S.nodeHasCxlLink(rid, nid)) {
      toast(`已登记接入意图，但 Host Port / 设备接口不足 —— 请增加端口或设备`);
    }
  };

  // 单台 MHD 的接口数（降低时会裁剪超出上限的连接）
  APP.setUnitIfaces = function (mhdId, n) {
    const m = STATE.mhdConfig[mhdId]; if (!m) return;
    m.hostInterfaces = n;
    S.initCxlLinks();
    commit(`${mhdId} 接口数 → ${n}（机架已接入 ${S.connectedNodeCount(m.rackId)} 节点）`);
  };

  // 单台 MHD 的容量（缩容会触发 KV 逐出回 RDMA，指标随之变化）
  APP.setUnitCapacity = function (mhdId, gb) {
    const m = STATE.mhdConfig[mhdId]; if (!m) return;
    m.capacityGB = gb;
    const evicted = S.enforceCapacity();
    S.initCxlLinks();
    commit(`${mhdId} 容量 → ${gb} GB · 已用 ${S.computeMhdUsed(mhdId)} GB${evicted?' · 逐出 '+evicted+' 份':''}`);
  };

  // 增删 MHD 设备（每机架最多 MAX_MHD_PER_RACK 台）
  APP.addUnit = function (rid) {
    const before = S.unitsCount(rid);
    const id = S.createUnit(rid);
    if (!id) { toast(`该机架已达设备上限（${D.MAX_MHD_PER_RACK} 台）`); return; }
    S.initCxlLinks();
    commit(`在 ${rid} 增加 1 台 MHD（${id}）· 设备 ${before} → ${S.unitsCount(rid)} 台`);
    toast(`${rid} 新增 ${id} · 共享池容量 +${STATE.mhdConfig[id].capacityGB} GB`);
  };
  APP.removeUnit = function (rid, mhdId) {
    if (!STATE.mhdConfig[mhdId]) return;
    S.removeUnit(rid, mhdId);
    if (S.unitsCount(rid) === 0) {
      STATE.deployment[rid] = false;
      toast(`${rid} 已无 MHD 设备，CXL 子系统移除`);
    }
    S.initCxlLinks();
    commit(`移除 ${mhdId} · 机架剩余 ${S.unitsCount(rid)} 台设备`);
  };

  // KV 工作负载单项修改：改值后重新推导 KV 热度与访问分布
  APP.setWorkload = function (key, value) {
    STATE.workload[key] = value;
    applyWorkloadToKV();
    const names = { totalGB:'KV总容量', hotRatio:'热KV比例', localRatio:'本地访问比例',
                    crossRatio:'跨机架共享比例', requestRate:'访问请求量' };
    commit(`工作负载 ${names[key]||key} → ${value}${key==='totalGB'?' GB':'%'}`);
  };

  // 拥塞预设：一键设置所有链路流量百分比
  APP.setCongestion = function (level) {
    if (!D.CONGESTION_PRESETS[level]) return;
    STATE.congestion = level;
    LINKS.forEach(l => STATE.linkFlow[l.id] = D.CONGESTION_PRESETS[level].pct);
    syncLinkLoads();
    commit(`网络拥塞预设 → ${D.CONGESTION_PRESETS[level].label}负载`);
  };

  // 单条链路流量百分比
  APP.setLinkFlow = function (lid, pct) {
    STATE.linkFlow[lid] = +pct;
    STATE.congestion = 'custom';
    syncLinkLoads();
    commit(`链路 ${lid} 流量 → ${pct}%`);
  };

  // 应用部署方案 A/B/C（重建部署、节点、MHD 配置）
  APP.applyPlan = function (planId) {
    const p = DEPLOY_PLANS.find(x=>x.id===planId); if (!p) return;
    p.racks.forEach((on, i) => {
      const r = RACKS[i];
      STATE.deployment[r.id] = on;
      STATE.nodeConfig[r.id] = {};
      r.nodes.forEach(n => STATE.nodeConfig[r.id][n.id] = on && !!n.cxl);
      if (on) S.ensureRackUnits(r.id, 1);
    });
    S.initCxlLinks();
    commit(`应用方案 ${p.id} · ${p.name}`);
  };

  // 保存当前配置为自定义方案（用于对比页展示）
  APP.savePlan = function () {
    const s = cxlStatsSafe();
    STATE.customPlan = {
      name: '自定义方案',
      racks: RACKS.map(r=>STATE.deployment[r.id]),
      nodes: RACKS.reduce((a,r)=>a+connectedNodeCount(r.id),0),
      total: s.total, used: s.used, util: s.util,
      workload: Object.assign({}, STATE.workload),
      derived: workloadDerived(),
      ts: new Date().toLocaleTimeString('zh-CN',{hour12:false})
    };
    commit('已保存当前配置为自定义方案');
    toast('已保存 · 可在方案对比页查看');
  };

  function cxlStatsSafe() { return S.cxlStats(); }

  // ============================================================
  // 硬件拓扑工作台：视角切换 / 端口级连接 / 路径高亮 / 端口配置
  // ============================================================
  APP.switchHWView = function (view) {
    if (!['physical','network','threeD','pipeline'].includes(view)) return;
    STATE.hwView = view;
    STATE.activePort = null;
    STATE.pathHighlight = null;
    log('硬件视图 → ' + {physical:'机架物理视图',network:'网络拓扑视图',threeD:'集群三维视图',pipeline:'推理管线视图'}[view], true);
    APP.render();
  };
  APP.rotate3D = function (delta) {
    STATE.rot3d = ((STATE.rot3d||0) + delta + 360) % 360;
    if (STATE.hwView === 'threeD') window.__RENDER_HW__.renderHardware();
  };

  // 硬件库拖入/点选部署：将某类设备部署到当前机架
  // CXL Switch 与 Shared MHD 作为一个 CXL 子系统整体部署（对应机架的 CXL 部署开关）
  APP.deployHardware = function (type, rid) {
    rid = rid || STATE.selectedRack;
    if (!rid) { toast('请先选择一个机架'); return; }
    if (type === 'CXL_SUBSYSTEM') {
      if (STATE.deployment[rid] && S.unitsCount(rid)) { toast(`${rid} 已部署 CXL Switch + ${S.unitsCount(rid)} 台 MHD`); return; }
      STATE.deployment[rid] = true;
      S.ensureRackUnits(rid, 1);
      const nSlots = Math.min(S.hostPortCapacity(rid), 2, RACKS.find(r=>r.id===rid).nodes.length);
      RACKS.find(r=>r.id===rid).nodes.slice(0,nSlots).forEach(n => { STATE.nodeConfig[rid][n.id] = true; });
      S.initCxlLinks();
      commit(`部署 CXL 子系统到 ${rid}（CXL Switch + 1 台共享 MHD，接入 ${nSlots} 台主机）`);
      toast(`${rid} 已加入 CXL Switch + 共享 MHD`);
    } else if (type === 'GPU_SERVER') {
      toast('本示意中每个机架固定 4 台 GPU 服务器；节点级 CXL 接入请在物理视图点端口');
    } else if (type === 'RDMA_TOR') {
      toast('RDMA ToR 为存量集群固有设备，默认已部署');
    }
  };
  // 移除当前机架的 CXL 子系统（含其下所有 MHD 设备）
  APP.removeHardware = function (rid) {
    rid = rid || STATE.selectedRack;
    if (!rid) return;
    if (!STATE.deployment[rid]) { toast(`${rid} 未部署 CXL`); return; }
    const n = S.unitsCount(rid);
    STATE.deployment[rid] = false;
    RACKS.find(r=>r.id===rid).nodes.forEach(n => { STATE.nodeConfig[rid][n.id] = false; });
    STATE.cxlLinks[rid] = [];
    commit(`从 ${rid} 移除 CXL Switch + ${n} 台 MHD（恢复 RDMA-only）`);
    toast(`${rid} 已恢复 RDMA-only`);
  };

  // 端口点击：两步建立 CXL 物理连接（服务器 C 口 → Switch H 口）
  // 也支持点击已连接端口断开、点击 MDP/MHD 口给出说明。
  APP.hwPortClick = function (key) {
    const rid = STATE.selectedRack;
    if (!rid) { toast('请先选择一个机架'); return; }
    const parts = key.split(':');
    const dev = parts[0];        // CXL | NIC | H1 | M1 | MHD1
    const side = parts[1];       // src | dst
    const id = parts[2];         // N1 (仅 src)

    // 服务器 CXL 源端口
    if (dev === 'CXL' && side === 'src') {
      const existing = (STATE.cxlLinks[rid]||[]).find(l => l.node === id);
      if (existing) {
        // 再次点击 → 断开
        STATE.cxlLinks[rid] = STATE.cxlLinks[rid].filter(l => l.node !== id);
        STATE.nodeConfig[rid][id] = false;
        S.initCxlLinks();
        STATE.activePort = null;
        commit(`${rid} · ${id} 断开 CXL 物理连接（释放 Host Port ${existing.hostPort}）`);
        return;
      }
      STATE.activePort = { key, rid, node:id, dev:'CXL' };
      toast(`已选 ${id} 的 CXL Host Port · 请点击 CXL Switch 的空闲 H 口`);
      APP.render();
      return;
    }
    // NIC 源端口：提示默认接入
    if (dev === 'NIC') { toast('RDMA NIC 默认全部接入机架 ToR（存量集群）'); return; }
    // 未选中源端口时点目标口
    if (!STATE.activePort || STATE.activePort.rid !== rid) { toast('请先点击服务器的 C 口选择连接起点'); return; }
    // Switch Host Port (H1..Hn)
    if (/^H\d+$/.test(dev)) {
      const hp = dev;
      const used = (STATE.cxlLinks[rid]||[]).find(l => l.hostPort === hp);
      if (used) { toast(`Host Port ${hp} 已被 ${used.node} 占用`); return; }
      const cap = S.hostPortCapacity(rid), cnt = S.usedHostPorts(rid);
      if (cnt >= cap) { toast(`Host Port 已满（${cnt}/${cap}），请增加端口数或断开其他连接`); return; }
      // 选一台仍有空闲接口的 MHD 设备（优先占用最少的那台）
      const units = S.unitIdsForRack(rid);
      if (!units.length) { toast('该机架未部署 MHD 设备'); return; }
      let target = null;
      units.forEach(u => {
        const m = STATE.mhdConfig[u];
        const load = (STATE.cxlLinks[rid] || []).filter(l => l.mhdId === u).length;
        if (load < m.hostInterfaces && (!target || load < target.load)) target = { id:u, load };
      });
      if (!target) { toast('所有 MHD 设备接口已占满，请增加设备或调大接口数'); return; }
      STATE.cxlLinks[rid].push({ node:STATE.activePort.node, hostPort:hp, mdpPort:'M1', mhdId:target.id });
      STATE.nodeConfig[rid][STATE.activePort.node] = true;
      S.syncMhdNodes(target.id);
      const node = STATE.activePort.node;
      STATE.activePort = null;
      commit(`${rid} · ${node} → Switch ${hp} → MDP M1 → ${target.id}（共享内存池）`);
      return;
    }
    // MDP / MHD 接口：共享总线的说明
    if (dev === 'M1' || /^MHD\d$/.test(dev)) {
      toast('MDP 与 MHD 接口为共享总线：所有 Host Port 经 CXL Switch 汇聚至此共享同一内存池');
    }
  };

  // 重置端口连接为默认（N1/N2 接入共享 MHD）
  APP.resetLinks = function (rid) {
    rid = rid || STATE.selectedRack;
    const r = RACKS.find(x=>x.id===rid); if (!r) return;
    r.nodes.forEach(n => { STATE.nodeConfig[rid][n.id] = !!n.cxl; });
    STATE.cxlLinks[rid] = [];
    S.initCxlLinks();
    commit(`${rid} 端口连接重置为默认（N1/N2 共享接入）`);
    toast('已恢复默认端口连接');
  };

  // 路径高亮：点击服务器 → 高亮其 RDMA 路径（NIC→ToR→Spine）
  APP.hwHighlightRDMA = function (rid, nodeId) {
    if (!RACKS.find(r=>r.id===rid)) return;
    STATE.pathHighlight = { type:'rdma', rackId:rid, nodeId };
    STATE.selectedRack = rid;
    log(`高亮 ${rid}/${nodeId} 的 RDMA 访问路径`, true);
    APP.render();
    toast(`${rid}/${nodeId} → ToR → Spine（RDMA 远程访问路径已高亮）`);
  };
  // 点击 MHD → 高亮所有能访问它的主机
  APP.hwHighlightMHD = function (mhdId) {
    const hosts = S.mhdReachableHosts(mhdId);
    STATE.pathHighlight = { type:'cxl', mhdId };
    log(`高亮可访问 ${mhdId} 的 ${hosts.length} 台主机`, true);
    APP.render();
    toast(hosts.length ? `共享 MHD 可访问主机：${hosts.join('、')}` : '该 MHD 尚无主机接入');
  };

  // CXL Switch Host Port 数配置（与 MHD 容量相互独立）
  // 增加端口 → 自动把更多节点接入；减少端口 → 只保留前 n 条连接
  APP.setSwitchPorts = function (rid, n) {
    if (!STATE.switchCfg[rid]) return;
    n = Math.max(1, Math.min(6, +n));
    const prev = STATE.switchCfg[rid].hostPorts;
    STATE.switchCfg[rid].hostPorts = n;
    const rack = RACKS.find(r => r.id === rid);
    if (n > prev) {
      const linked = new Set((STATE.cxlLinks[rid] || []).map(l => l.node));
      let need = n - linked.size;
      rack.nodes.forEach(nd => {
        if (need > 0 && !linked.has(nd.id)) { STATE.nodeConfig[rid][nd.id] = true; need--; }
      });
    } else if (n < prev) {
      const keep = new Set((STATE.cxlLinks[rid] || []).slice(0, n).map(l => l.node));
      rack.nodes.forEach(nd => { STATE.nodeConfig[rid][nd.id] = keep.has(nd.id); });
    }
    S.initCxlLinks();
    const conn = S.connectedNodeCount(rid);
    commit(`${rid} CXL Switch Host Port → ${n}（当前接入 ${conn} 台主机）`);
    if (conn < n) {
      const ifa = S.mhdUnitsForRack(rid).reduce((a, m) => a + (m.hostInterfaces || 1), 0);
      toast(`端口 ${n} 已开，但受设备接口数限制（合计 ${ifa} 个口）仅能接入 ${conn} 台主机：请增加 MHD 台数或提高单台接口数`);
    }
  };

  // ---------- KV 操作 ----------
  // 在指定机架里找一台仍有空间的 MHD 设备
  function unitWithSpace(rid, sizeGB) {
    const units = S.mhdUnitsForRack(rid);
    return units.find(m => (m.capacityGB - S.computeMhdUsed(m.id)) >= sizeGB) || null;
  }
  APP.handleAction = function (act, payload) {
    const id = STATE.selectedKV;
    const k = getKV(id);
    if (!k) { toast('请先选择一个 KV Block'); return; }

    if (act === 'replicate') {
      // payload 为指定目标机架；否则自动挑选访问主体机架
      const target = payload ? RACKS.find(r=>r.id===payload)
        : RACKS.find(r => STATE.deployment[r.id] && (k.dist[r.id]||0) >= 0.3 && unitWithSpace(r.id, k.sizeGB));
      if (!target) { toast('没有满足条件的 CXL 目标机架（部署+容量+访问主体）'); return; }
      const unit = unitWithSpace(target.id, k.sizeGB);
      if (!unit) { toast('目标机架所有 MHD 设备容量不足'); return; }
      if (k.replicas.some(rep=>rep.rackId===target.id)) { toast('该机架已有此 KV 副本'); return; }
      APP.animateReplication(k, target, unit);
    } else if (act === 'migrate') {
      // 迁移：原始 KV 从 RDMA 移到 CXL（原创移动，不在 RDMA 保留）
      const target = payload ? RACKS.find(r=>r.id===payload)
        : RACKS.find(r => STATE.deployment[r.id] && unitWithSpace(r.id, k.sizeGB));
      if (!target) { toast('没有可迁移的 CXL 目标（需部署+容量充足）'); return; }
      const unit = unitWithSpace(target.id, k.sizeGB);
      if (!unit) { toast('目标机架所有 MHD 设备容量不足'); return; }
      APP.animateMigrate(k, target, unit);
    } else if (act === 'evict') {
      APP.animateEviction(k);
    } else if (act === 'setHotness') {
      STATE.kvRuntime[id].hotness = payload;
      commit(`${id} 热度 → ${{high:'高',mid:'中',low:'低'}[payload]}`);
    } else if (act === 'trace') {
      STATE.page = 'traffic';
      log('追踪 ' + id + ' 的访问路径', true);
      APP.render();
      toast('已切换到 Traffic 页查看访问路径');
    }
  };

  // 复制动画：RDMA Pool → 目标机架 MHD
  APP.animateReplication = function (k, target, unit) {
    const mhd = unit || mhdForRack(target.id);
    if (STATE.anim.active) { toast('动画进行中…'); return; }
    STATE.anim = { active:true, type:'replicate', kvId:k.id, target:target.id, progress:0 };
    log(`复制 ${k.id} → ${target.name} MHD（${k.sizeGB} GB）`, true);
    toast(`复制中：${k.id} → ${target.name} · 原始保留`);

    const duration = 1400;
    const start = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - start) / duration);
      STATE.anim.progress = p;
      drawAnimOverlay(k, target, p, 'replicate');
      if (p < 1) { requestAnimationFrame(frame); }
      else {
        // 提交状态：KV 保留在 RDMA，增加副本
        const rt = STATE.kvRuntime[k.id];
        rt.replicas.push({ rackId:target.id, location:mhd.id });
        STATE.anim.active = false;
        clearAnimOverlay();
        log(`副本已写入 ${mhd.id} · 已用 ${computeMhdUsed(mhd.id)} GB`, true);
        toast(`${k.id} 副本已就位 · ${target.name} 访问切至本地 CXL`);
        APP.render();
      }
    }
    requestAnimationFrame(frame);
  };

  // 迁移动画：RDMA Pool → 目标机架 MHD，原始从 RDMA 移除（原创移动）
  APP.animateMigrate = function (k, target, unit) {
    const mhd = unit || mhdForRack(target.id);
    if (STATE.anim.active) { toast('动画进行中…'); return; }
    STATE.anim = { active:true, type:'migrate', kvId:k.id, target:target.id, progress:0 };
    log(`迁移 ${k.id} RDMA → ${target.name} MHD（原创移动，${k.sizeGB} GB）`, true);
    toast(`迁移中：${k.id} → ${target.name} · 原始不再保留`);

    const duration = 1400, start = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - start) / duration);
      STATE.anim.progress = p;
      drawAnimOverlay(k, target, p, 'migrate');
      if (p < 1) { requestAnimationFrame(frame); }
      else {
        const rt = STATE.kvRuntime[k.id];
        rt.location = 'mhd:' + mhd.id;
        rt.replicas = []; // 迁移后无异地副本
        STATE.anim.active = false;
        clearAnimOverlay();
        log(`${k.id} 迁移完成 · ${mhd.id} 已用 ${computeMhdUsed(mhd.id)} GB`, true);
        toast(`${k.id} 已迁入 ${target.name} MHD · 本地 CXL 访问`);
        APP.render();
      }
    }
    requestAnimationFrame(frame);
  };

  // 淘汰动画：移除副本
  APP.animateEviction = function (k) {
    if (STATE.anim.active) { toast('动画进行中…'); return; }
    const rep = k.replicas[0];
    if (!rep) { toast('没有可淘汰的副本'); return; }
    const target = getRackByMhd(rep.location);
    STATE.anim = { active:true, type:'evict', kvId:k.id, target:target?target.id:'R1', progress:0 };
    log(`淘汰 ${k.id} 在 ${rep.rackId} 的副本`, true);
    toast(`淘汰副本：${k.id} @ ${rep.rackId}`);
    const duration = 1000, start = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - start)/duration);
      STATE.anim.progress = p;
      drawAnimOverlay(k, target||{id:'R1',name:rep.rackId}, p, 'evict');
      if (p < 1) requestAnimationFrame(frame);
      else {
        const rt = STATE.kvRuntime[k.id];
        rt.replicas = [];
        STATE.anim.active = false;
        clearAnimOverlay();
        S.log(`MHD 容量释放 ${k.sizeGB} GB · 原始 KV 仍在 RDMA Pool`, true);
        toast('副本已淘汰 · 容量释放');
        APP.render();
      }
    }
    requestAnimationFrame(frame);
  };

  function getRackByMhd(mhdId) {
    const rid = S.mhdRackOf(mhdId);
    return rid ? (RACKS.find(r => r.id === rid) || null) : null;
  }

  // 动画覆盖层（直接绘制到 SVG）
  function drawAnimOverlay(k, target, p, type) {
    const svg = $('#canvas');
    if (!svg) return;
    let layer = $('#anim-layer');
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg','g');
      layer.id = 'anim-layer';
      svg.appendChild(layer);
    }
    const idx = RACKS.findIndex(r=>r.id===target.id);
    const tx = 34 + (idx>=0?idx:0)*292 + 129;
    const fromX = 600, fromY = 512, toY = 330;
    const curX = fromX + (tx-fromX)*p, curY = fromY + (toY-fromY)*p;
    const col = type==='replicate' ? C.replica : (type==='migrate' ? C.cxl : C.hotHigh);
    const trail = (type==='replicate'||type==='migrate')
      ? `<path d="M${fromX} ${fromY} Q${tx} 470 ${tx} ${toY}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="5 5" opacity=".55"/>`
      : `<path d="M${tx} ${toY} Q${tx} 470 ${fromX} ${fromY}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="5 5" opacity=".55"/>`;
    const label = type==='replicate' ? 'RDMA → CXL 本地副本写入'
      : type==='migrate' ? 'RDMA → CXL 迁移（原创移动）' : '淘汰副本 → 释放 MHD 容量';
    layer.innerHTML = trail +
      `<circle cx="${curX}" cy="${curY}" r="12" fill="rgba(6,16,20,.9)" stroke="${col}" stroke-width="2" filter="url(#glow)"/>` +
      `<text x="${curX}" y="${curY+3}" text-anchor="middle" font-size="7" fill="${col}" font-family="monospace">${k.id.replace('KV-','')}</text>` +
      `<text x="600" y="552" text-anchor="middle" font-size="11" fill="${col}" font-family="sans-serif">${label} · ${Math.round(p*100)}%</text>`;
  }
  function clearAnimOverlay() {
    const l = $('#anim-layer'); if (l) l.remove();
  }

  // ---------- 播放控制 ----------
  let playTimer = null;
  APP.togglePlay = function () {
    STATE.playing = !STATE.playing;
    $('#play-btn').classList.toggle('playing', STATE.playing);
    if (STATE.playing) {
      log('开始场景演示（自动推进）');
      playTimer = setInterval(()=>{
        const next = (STATE.step + 1) % SCENARIOS.length;
        APP.loadScenario(SCENARIOS[next].id);
      }, 3600);
    } else {
      clearInterval(playTimer);
      log('暂停场景演示');
    }
  };
  APP.step = function (dir) {
    const next = (STATE.step + dir + SCENARIOS.length) % SCENARIOS.length;
    APP.loadScenario(SCENARIOS[next].id);
  };
  APP.reset = function () {
    STATE.playing = false;
    clearInterval(playTimer);
    $('#play-btn').classList.remove('playing');
    STATE.comparePlan = 'B';
    APP.loadScenario('S1');
    toast('已恢复初始部署');
  };

  // ---------- 说明弹窗 ----------
  APP.showHelp = function () {
    $('#modal-body').innerHTML = `
      <h3>模拟器定位</h3>
      <p>面向多轮 LLM 推理的存量 RDMA 集群 CXL 增量部署可视化模拟器。核心是把<b>机架级部署决策</b>与 <b>KV Cache 工作负载特征</b>联系起来。</p>
      <h3>围绕三个研究问题</h3>
      <ul>
        <li>哪些机架需要增量部署 CXL？→ 部署配置与成本对比</li>
        <li>哪些 KV 应放入 CXL？→ 热度、访问主体、局部性、容量</li>
        <li>哪些 KV 应复制到其他机架 CXL？→ 共享访问、跨机架复制、路径切换</li>
      </ul>
      <h3>硬件拓扑工作台（机架解剖页，三种视角）</h3>
      <ul>
        <li><b>01 机架物理视图</b>：按 U 位摆放 ToR / CXL Switch / GPU 服务器 / 共享 MHD，显示端口。</li>
        <li><b>端口级连接</b>：点服务器右侧 <b>C 口</b> → 点 CXL Switch 空闲 <b>H 口</b> 建立连接；再点 C 口断开。<b>Host Port 数</b>决定可接主机数，<b>MHD 容量</b>独立配置 —— N1/N2 通过 Switch 共享同一 MHD，而非各自独占。</li>
        <li><b>02 网络拓扑视图</b>：Leaf-Spine 全景 + 机架内 CXL 连接；点服务器高亮 RDMA 路径，点 MHD 高亮可访问主机。</li>
        <li><b>03 集群三维视图</b>：4 机架等轴测布局，可旋转、点击机架进入物理视图。</li>
        <li>从硬件库可一键部署/移除 CXL 子系统（CXL Switch + 共享 MHD）。</li>
      </ul>
      <h3>交互式配置（其余页面）</h3>
      <ul>
        <li>左侧①区：逐个机架开关 CXL 部署、勾选接入节点、调 MHD 容量与接口。</li>
        <li>左侧②区：调 KV 总容量、热度、本地/跨机架比例 —— 即时重算。</li>
        <li>左侧③区 / 网络页：拥塞预设或单链路流量 —— 链路颜色/线宽变化。</li>
        <li>KV 画像：复制（原创保留）/ 迁移（原创移动）/ 淘汰 / 热度切换。</li>
        <li>方案对比：A/B/C 动态矩阵，可应用方案、保存自定义方案 D。</li>
      </ul>
      <p>任何配置改动后，<b>硬件视图 / 架构图、右侧档案、底部 KPI 会同步刷新</b>。</p>
      <h3>五个页面</h3>
      <p><code>01 集群总览</code> 拓扑与部署 · <code>02 机架解剖</code> 硬件拓扑工作台（物理/网络/三维） · <code>03 KV 资源</code> KV 画像与分布 · <code>04 网络与访问</code> RDMA 路径与链路负载 · <code>05 方案对比</code> 动态对比矩阵</p>
      <h3>重要说明</h3>
      <p>设备形态、U 位、端口与连接均为<b>逻辑示意</b>，不代表选定型号、真实尺寸或实际布线。所有容量、成本、时延、链路负载均为<b>教学示意值，非实测结果</b>。</p>
      <p style="color:var(--warn)">⚠ 场线与性能数值均不构成真实系统性能承诺。</p>`;
    $('#modal-root').hidden = false;
  };

  // ---------- 事件绑定 ----------
  function bindGlobal() {
    $$('.page-tab').forEach(b => b.addEventListener('click', ()=> APP.switchPage(b.getAttribute('data-page'))));
    $$('.lang-btn').forEach(b => b.addEventListener('click', ()=>{
      STATE.lang = b.getAttribute('data-lang');
      document.documentElement.lang = STATE.lang;
      APP.render();
      toast(STATE.lang==='zh'?'已切换中文':'Switched to English');
    }));
    $('#help-btn').addEventListener('click', APP.showHelp);
    $$('[data-close]').forEach(b => b.addEventListener('click', ()=> $('#modal-root').hidden = true));
    $('#clear-sel').addEventListener('click', ()=>{
      STATE.selectedKV = null; STATE.selectedRack = null; STATE.selectedLink = null;
      APP.render();
    });
    $('#labels-btn').addEventListener('click', e=>{
      STATE.showLabels = !STATE.showLabels;
      e.currentTarget.setAttribute('aria-pressed', STATE.showLabels);
      $$('.svg-label,.svg-cn').forEach(t=>t.style.display = STATE.showLabels?'':'none');
    });
    $('#fit-btn').addEventListener('click', ()=> toast('视图已复位'));
    // 硬件视角切换 / 三维旋转 / 硬件库部署 / 移除
    $$('[data-hwview]').forEach(b => b.addEventListener('click', ()=> APP.switchHWView(b.getAttribute('data-hwview'))));
    // 02 集群总览 · 2D/3D 切换按钮（逻辑见 IIFE 顶层的 toggleOverview3d）
    const v3btn = $('#view3d-btn');
    if (v3btn) v3btn.addEventListener('click', () => APP.toggleOverview3d());
  const ovBtn = $('#oview-btn');
  if (ovBtn) {
    ovBtn.textContent = STATE.oview === '3d' ? '立体' : '平面';
    ovBtn.addEventListener('click', () => {
      STATE.oview = STATE.oview === '3d' ? '2d' : '3d';
      ovBtn.textContent = STATE.oview === '3d' ? '立体' : '平面';
      log('集群总览 → ' + (STATE.oview === '3d' ? '三维等轴测' : '平面拓扑'), true);
      APP.render();
    });
  }
    const rotL = $('#rot-left'), rotR = $('#rot-right');
    if (rotL) rotL.addEventListener('click', ()=> APP.rotate3D(-30));
    if (rotR) rotR.addEventListener('click', ()=> APP.rotate3D(30));
    $$('[data-deploy-hw]').forEach(b => b.addEventListener('click', ()=> APP.deployHardware(b.getAttribute('data-deploy-hw'))));
    const rmHw = $('#remove-hw'); if (rmHw) rmHw.addEventListener('click', ()=> APP.removeHardware());
    $('#play-btn').addEventListener('click', APP.togglePlay);
    $('#step-fwd').addEventListener('click', ()=> APP.step(1));
    $('#step-back').addEventListener('click', ()=> APP.step(-1));
    $('#reset-btn').addEventListener('click', APP.reset);
    const range = $('#timeline-range');
    range.addEventListener('input', ()=>{
      const s = SCENARIOS[+range.value];
      if (s) APP.loadScenario(s.id);
    });
    document.addEventListener('keydown', e=>{
      if (e.key === 'Escape') $('#modal-root').hidden = true;
      if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault(); APP.togglePlay();
      }
    });
  }

  // ---------- 启动 ----------
  function boot() {
    S.initState();
    STATE._openRacks = { R1:true };
    bindGlobal();
    // 支持 URL 参数指定初始页面/场景/KV，便于分享与测试
    const params = new URLSearchParams(location.search);
    const p = params.get('page');
    if (p && ['run','overview','rack','kv','traffic','lc','compare'].includes(p)) STATE.page = p;
    if (p === 'lc' && window.__RENDER_LC__) { const lcs = params.get('lcsc'); if (lcs) STATE.lc = { scene: lcs, step: 0, playing: false }; }
    const hv = params.get('hwview');
    if (hv && ['physical','network','threeD','pipeline'].includes(hv)) STATE.hwView = hv;
    const ov = params.get('oview');
    if (ov === '2d' || ov === '3d') STATE.oview = ov;
    const want3d = params.get('v3d') === '1';
    const sc = params.get('sc');
    APP.loadScenario(sc && SCENARIOS.some(s=>s.id===sc) ? sc : 'S1', true);
    // 可选参数（演示/测试用）：?cxl=R1,R2&units=3 —— 直接指定哪些机架部署 CXL、每机架几台 MHD
    const cxlList = params.get('cxl');
    if (cxlList !== null) {
      const want = new Set(cxlList.split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
      const un = Math.max(1, Math.min(3, parseInt(params.get('units') || '1', 10) || 1));
      RACKS.forEach(r => {
        STATE.deployment[r.id] = want.has(r.id);
        if (STATE.deployment[r.id]) {
          S.ensureRackUnits(r.id, un);
          // 与手动勾选一致：按开关端口数默认接入前几台主机
          const slots = Math.min(S.hostPortCapacity(r.id), 2);
          r.nodes.slice(0, slots).forEach(nd => { STATE.nodeConfig[r.id][nd.id] = true; });
        } else STATE.rackUnits[r.id] = [];
        S.syncRackMeta(r.id);
      });
      S.initCxlLinks();
      S.enforceCapacity();
      APP.render();     // 参数改写了部署，必须重绘（loadScenario 已经渲染过一次旧状态）
    }
    const kvp = params.get('kv');
    if (kvp && KVS.some(k=>k.id===kvp)) STATE.selectedKV = kvp;
    if ((STATE.page === 'kv' || STATE.page === 'traffic') && !STATE.selectedKV) {
      const sc = SCENARIOS.find(s=>s.id===STATE.scenario);
      STATE.selectedKV = (sc && sc.focusKV) || 'KV-003';
    }
    if (STATE.page === 'kv' || STATE.page === 'traffic') APP.render();
    if (want3d && STATE.page === 'overview') APP.toggleOverview3d(true);
    const _st = S.cxlStats();
    log(`模拟器就绪 · 4 Racks · 16 Nodes · ${_st.count} CXL Racks · ${_st.units} MHD`);
  }

  window.__APP__ = APP;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
