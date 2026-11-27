/* ============================================================
 * CXL-RDMA Simulator — app.js
 * 状态管理 / 动态硬件模型（每机架 N 个 MHD）/ 性能-成本推导 / 交互 / 动画
 * ============================================================ */
(function () {
  'use strict';

  const D = window.DATA;
  const { COLORS: C, RACKS, MHDS, RDMA_POOL, KVS, LINKS,
          SCENARIOS, DEPLOY_PLANS, COST_PARAMS, WORKLOAD_DEFAULT,
          CONGESTION_PRESETS, CXL_SWITCH_DEFAULT,
          PERF_MODEL, MAX_MHD_PER_RACK, MHD_UNIT_STEPS } = D;

  // ---------- 图标/颜色工具 ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const hotColor = h => ({ high:C.hotHigh, mid:C.hotMid, low:C.hotLow }[h] || C.hotLow);
  const loadColor = l => ({ low:C.loadLow, mid:C.loadMid, high:C.loadHigh }[l] || C.loadLow);
  const loadName = l => ({ low:'低负载', mid:'中负载', high:'高负载' }[l] || '低负载');

  // i18n 极简词典
  const I18N = {
    zh: {
      pOverview:'集群总览', pRack:'机架解剖', pKv:'KV 资源', pTraffic:'网络与访问', pCompare:'方案对比',
      leftDeploy:'机架与部署', leftDeploySub:'切换机架 CXL 部署 · 调整 MHD 设备数量与容量',
      leftKv:'KV Block 列表', leftKvSub:'点击 KV 查看生产位置、访问主体与存储位置',
      leftRack:'机架解剖', leftRackSub:'选择机架查看内部 MHD 与节点连接',
      leftTraffic:'场景与链路', leftTrafficSub:'切换拥塞场景 · 查看 RDMA 链路负载',
      leftCompare:'部署方案', leftCompareSub:'对比三种部署形态的成本与能力',
      rightStatus:'系统状态', rightStatusSub:'部署 · 容量 · KV · 网络指标',
      rightDossier:'KV 画像', rightDossierSub:'生产位置 · 访问分布 · 副本状态',
      clickRack:'点击机架查看内部结构 · 点击 KV 查看访问画像',
      clickKv:'点击 KV Block 查看访问画像与复制操作'
    },
    en: {
      pOverview:'Overview', pRack:'Rack Anatomy', pKv:'KV Explorer', pTraffic:'Traffic & Access', pCompare:'Compare',
      leftDeploy:'Racks & Deployment', leftDeploySub:'Toggle CXL deployment · tune MHD units and capacity',
      leftKv:'KV Blocks', leftKvSub:'Select a KV to inspect producer, accessors and location',
      leftRack:'Rack Anatomy', leftRackSub:'Select a rack to view MHD and node connectivity',
      leftTraffic:'Scenarios & Links', leftTrafficSub:'Switch congestion scenarios · view RDMA link load',
      leftCompare:'Deployment Plans', leftCompareSub:'Compare cost and capability of three strategies',
      rightStatus:'System Status', rightStatusSub:'Deployment · capacity · KV · network metrics',
      rightDossier:'KV Dossier', rightDossierSub:'Producer · access distribution · replica status',
      clickRack:'Click a rack for internals · click a KV for its access profile',
      clickKv:'Click a KV Block to view profile and replication actions'
    }
  };
  const t = k => (I18N[STATE.lang] || I18N.zh)[k] || k;

  // ---------- 全局状态 ----------
  const STATE = {
    lang: 'zh',
    page: 'run',                   // run | overview | rack | kv | traffic | lc | compare
    scenario: 'S1',
    selectedRack: 'R1',
    selectedKV: null,
    selectedLink: null,
    comparePlan: 'B',
    showLabels: true,
    // ---- 硬件拓扑工作台 ----
    hwView: 'dissect', oview: '3d',
    hwSelected: null,
    activePort: null,
    pathHighlight: null,
    rot3d: 0,
    switchCfg: {},                 // rackId -> {hostPorts, mdpPorts}
    cxlLinks: {},                  // rackId -> [{node, hostPort, mdpPort, mhdId}]
    playing: false,
    step: 0,
    deployment: {},                // rackId -> boolean
    rackUnits: {},                 // rackId -> [mhdId...]（每机架可挂多台共享内存设备）
    mhdConfig: {},                 // mhdId -> {id, rackId, capacityGB, hostInterfaces, baseUsedGB}
    kvRuntime: {},
    links: {},                     // linkId -> 负载等级
    linkFlow: {},                  // linkId -> 流量百分比
    nodeConfig: {},                // rackId -> {N1:bool ...}
    workload: {},
    congestion: 'low',
    customPlan: null,
    logs: [],
    anim: { active:false, type:null, from:null, to:null, progress:0, kvId:null }
  };

  // ============================================================
  // 一、动态硬件模型：机架内 MHD 设备（1..MAX_MHD_PER_RACK 台）
  // ============================================================
  function rackNum(rid) { return rid.replace('R', ''); }

  // 新建一台 MHD（同一机架内可多台，各自独立容量与接口）
  function createUnit(rid, opt) {
    const units = STATE.rackUnits[rid] || (STATE.rackUnits[rid] = []);
    if (units.length >= MAX_MHD_PER_RACK) return null;
    const n = rackNum(rid);
    let id = units.length === 0 ? 'MHD-' + n : 'MHD-' + n + String.fromCharCode(65 + units.length);
    if (STATE.mhdConfig[id]) { // 防御性去重
      let k = 2; while (STATE.mhdConfig['MHD-' + n + 'X' + k]) k++;
      id = 'MHD-' + n + 'X' + k;
    }
    const seed = MHDS[id];
    STATE.mhdConfig[id] = {
      id,
      rackId: rid,
      capacityGB: (opt && opt.capacityGB) || (seed ? seed.capacityGB : 512),
      hostInterfaces: (opt && opt.hostInterfaces) || (seed ? seed.hostInterfaces : 2),
      baseUsedGB: seed ? (seed.baseUsedGB || 0) : 0
    };
    units.push(id);
    syncRackMeta(rid);
    return id;
  }

  function removeUnit(rid, mhdId) {
    const units = STATE.rackUnits[rid] || [];
    if (!units.includes(mhdId)) return;
    STATE.rackUnits[rid] = units.filter(x => x !== mhdId);
    // 该设备上的 KV：原始退还 RDMA Pool，副本删除
    KVS.forEach(k => {
      const rt = STATE.kvRuntime[k.id];
      if (rt.location === 'mhd:' + mhdId) rt.location = 'rdma';
      rt.replicas = rt.replicas.filter(r => r.location !== mhdId);
    });
    STATE.cxlLinks[rid] = (STATE.cxlLinks[rid] || []).filter(l => l.mhdId !== mhdId);
    delete STATE.mhdConfig[mhdId];
    syncRackMeta(rid);
  }

  // 保证机架至少有 n 台设备（开启 CXL 时调用）
  function ensureRackUnits(rid, n) {
    if (!STATE.rackUnits[rid]) STATE.rackUnits[rid] = [];
    while (STATE.rackUnits[rid].length < n) { if (!createUnit(rid)) break; }
    syncRackMeta(rid);
  }

  // 回写 DATA.RACKS 的 mhdId 兼容字段（其余模块仍可读）
  function syncRackMeta(rid) {
    const r = RACKS.find(x => x.id === rid);
    if (!r) return;
    const units = STATE.rackUnits[rid] || [];
    r.mhdId = units.length ? units[0] : null;
    r.mhdUnits = units.length;
  }

  function mhdUnitsForRack(rid) {
    if (!STATE.deployment[rid]) return [];
    return (STATE.rackUnits[rid] || []).map(id => getMhd(id)).filter(Boolean);
  }
  function unitIdsForRack(rid) { return STATE.deployment[rid] ? (STATE.rackUnits[rid] || []) : []; }
  function unitsCount(rid) { return unitIdsForRack(rid).length; }

  // ---------- 初始化状态 ----------
  function initState() {
    STATE.deployment = {};
    STATE.nodeConfig = {};
    STATE.rackUnits = {};
    STATE.mhdConfig = {};
    RACKS.forEach(r => {
      STATE.deployment[r.id] = r.cxlEnabled;
      STATE.nodeConfig[r.id] = {};
      r.nodes.forEach(n => STATE.nodeConfig[r.id][n.id] = !!(n.cxl && r.cxlEnabled));
      STATE.rackUnits[r.id] = [];
      const nUnits = r.cxlEnabled ? (r.mhdUnits !== undefined ? r.mhdUnits : 1) : 0;
      for (let i = 0; i < nUnits; i++) createUnit(r.id);
      syncRackMeta(r.id);
    });
    STATE.kvRuntime = {};
    KVS.forEach(k => STATE.kvRuntime[k.id] = {
      location: k.location, hotness: k.hotness,
      dist: Object.assign({}, k.dist),
      replicas: k.replicas.map(x => Object.assign({}, x))
    });
    STATE.linkFlow = {};
    const pctOf = { low:22, mid:58, high:92 };
    LINKS.forEach(l => STATE.linkFlow[l.id] = pctOf[l.load] !== undefined ? pctOf[l.load] : 22);
    STATE.links = {};
    LINKS.forEach(l => STATE.links[l.id] = l.load);
    STATE.congestion = 'low';
    STATE.workload = Object.assign({}, WORKLOAD_DEFAULT);
    STATE.switchCfg = {};
    RACKS.forEach(r => STATE.switchCfg[r.id] = Object.assign({}, CXL_SWITCH_DEFAULT));
    initCxlLinks();
    STATE.activePort = null;
    STATE.pathHighlight = null;
    STATE.rot3d = 0;
  }

  // ============================================================
  // 二、物理连接：节点 → CXL Switch Host Port → MHD 设备
  // 约束：Switch Host Port 数（可接主机数）× 各设备接口数（可挂主机数）
  // ============================================================
  function initCxlLinks() {
    RACKS.forEach(r => {
      const links = [];
      if (STATE.deployment[r.id]) {
        const sw = STATE.switchCfg[r.id] || CXL_SWITCH_DEFAULT;
        const units = STATE.rackUnits[r.id] || [];
        const wantNodes = r.nodes.filter(n => STATE.nodeConfig[r.id] && STATE.nodeConfig[r.id][n.id]);
        if (units.length) {
          const load = {};
          units.forEach(u => load[u] = 0);
          let port = 1;
          wantNodes.forEach((n, i) => {
            if (links.length >= sw.hostPorts) return;
            // 轮转分配到有空闲接口的设备
            let picked = null;
            for (let k = 0; k < units.length; k++) {
              const u = units[(i + k) % units.length];
              const cap = (STATE.mhdConfig[u] || {}).hostInterfaces || 1;
              if (load[u] < cap) { picked = u; break; }
            }
            if (!picked) return;
            load[picked]++;
            links.push({ node: n.id, hostPort: 'H' + port, mdpPort: 'M1', mhdId: picked });
            port++;
          });
        }
      }
      STATE.cxlLinks[r.id] = links;
      (STATE.rackUnits[r.id] || []).forEach(id => syncMhdNodes(id));
    });
  }
  function usedHostPorts(rid) { return (STATE.cxlLinks[rid] || []).length; }
  function hostPortCapacity(rid) { return (STATE.switchCfg[rid] || CXL_SWITCH_DEFAULT).hostPorts; }
  function nodeHasCxlLink(rid, nid) {
    const links = STATE.cxlLinks[rid] || [];
    return nid ? links.some(l => l.node === nid) : links.length > 0;
  }
  function mhdReachableHosts(mhdId) {
    const hosts = [];
    Object.keys(STATE.cxlLinks).forEach(rid => {
      (STATE.cxlLinks[rid] || []).forEach(l => { if (l.mhdId === mhdId) hosts.push(rid + '/' + l.node); });
    });
    return hosts;
  }
  function syncMhdNodes(mhdId) {
    const m = STATE.mhdConfig[mhdId];
    if (!m) return;
    const hosts = [];
    Object.keys(STATE.cxlLinks || {}).forEach(rid => {
      (STATE.cxlLinks[rid] || []).forEach(l => { if (l.mhdId === mhdId) hosts.push(rid + '/' + l.node); });
    });
    m.connectedNodes = hosts;
  }

  // 由流量百分比派生负载等级
  function loadFromFlow(pct) {
    if (pct >= 75) return 'high';
    if (pct >= 45) return 'mid';
    return 'low';
  }
  function syncLinkLoads() {
    LINKS.forEach(l => STATE.links[l.id] = loadFromFlow(STATE.linkFlow[l.id]));
  }
  function nodeConnected(rackId, nodeId) {
    return !!(STATE.deployment[rackId] && STATE.nodeConfig[rackId] && STATE.nodeConfig[rackId][nodeId]
      && nodeHasCxlLink(rackId, nodeId));
  }
  function connectedNodeCount(rackId) { return (STATE.cxlLinks[rackId] || []).length; }

  // ============================================================
  // 三、容量与派生统计
  // ============================================================
  function getKV(id) {
    const base = KVS.find(k => k.id === id);
    const rt = STATE.kvRuntime[id];
    return base ? Object.assign({}, base, rt) : null;
  }
  function getRack(id) { return RACKS.find(r => r.id === id); }
  function getMhd(id) {
    const cfg = STATE.mhdConfig[id];
    if (!cfg) return null;
    return Object.assign({}, MHDS[id] || {}, cfg);
  }
  // 机架主设备（兼容旧接口：返回第一台）
  function mhdForRack(rackId) {
    const ids = unitIdsForRack(rackId);
    return ids.length ? getMhd(ids[0]) : null;
  }
  function rackCapacity(rackId) {
    return mhdUnitsForRack(rackId).reduce((a, m) => a + m.capacityGB, 0);
  }
  function rackUsed(rackId) {
    return mhdUnitsForRack(rackId).reduce((a, m) => a + computeMhdUsed(m.id), 0);
  }
  function mhdRackOf(mhdId) { return (STATE.mhdConfig[mhdId] || {}).rackId || null; }

  function computeMhdUsed(mhdId) {
    let used = (STATE.mhdConfig[mhdId] && STATE.mhdConfig[mhdId].baseUsedGB) || 0;
    KVS.forEach(k => {
      const rt = STATE.kvRuntime[k.id];
      if (rt.location === 'mhd:' + mhdId) used += k.sizeGB;
      rt.replicas.forEach(rep => { if (rep.location === mhdId) used += k.sizeGB; });
    });
    return used;
  }
  function rdmaUsed() {
    let used = 0;
    KVS.forEach(k => {
      if (STATE.kvRuntime[k.id].location === 'rdma') used += k.sizeGB;
    });
    return used;
  }
  function cxlStats() {
    let count = 0, total = 0, used = 0, interfaces = 0, units = 0;
    RACKS.forEach(r => {
      if (!STATE.deployment[r.id]) return;
      count++;
      mhdUnitsForRack(r.id).forEach(m => {
        total += m.capacityGB; used += computeMhdUsed(m.id); interfaces += m.hostInterfaces; units++;
      });
    });
    return { count, total, used, interfaces, units, util: total ? Math.round(used / total * 100) : 0 };
  }
  function localKVCount() {
    let n = 0;
    KVS.forEach(k => {
      const rt = STATE.kvRuntime[k.id];
      const topRack = Object.keys(rt.dist).reduce((a, b) => rt.dist[a] >= rt.dist[b] ? a : b);
      const locRack = rt.location.startsWith('mhd:') ? mhdRackOf(rt.location.split(':')[1]) : null;
      if (locRack === topRack) n++;
    });
    return n;
  }

  // ============================================================
  // 四、性能 / 成本模型（硬件变化 → 指标变化）
  // 说明：绝对数值为教学示意量级（ns 级访问时延、万元级成本），非实测
  // ============================================================
  const PM = PERF_MODEL || {
    dramNs: 90, cxlLocalNs: 340, cxlRemoteNs: 1150, rdmaNs: 2100,
    sloNs: (window.__DATA__ && window.__DATA__.PERF_MODEL ? window.__DATA__.PERF_MODEL.sloNs : 1500), congWeight: 3.4, opCostPerGB: 0.05, alpha: 1, poolQueue: .35
  };

  function linkPct(a, b) {
    if (a === b) return 0;
    const l = LINKS.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    return l ? (STATE.linkFlow[l.id] || 22) : 22;
  }
  // 跨机架链路的拥塞放大系数（流量越高，实际访问代价越高）
  function congFactor(a, b) {
    if (!a || !b || a === b) return 1;
    const p = linkPct(a, b) / 100;
    return 1 + p * p * PM.congWeight;
  }
  // 池内排队系数（利用率越高越慢）
  function poolQueue(used, cap) {
    if (!cap) return 1;
    const u = Math.min(1.25, used / cap);
    // 利用率越高，池内排队/换入越慢（平滑单调，容量一变时延就变）
    return 1 + Math.pow(u, 2.2) * PM.poolQueue * 3.2;
  }
  // 单次 KV 访问时延（按访问者机架）
  function accessLatency(k, rt, accessorRack) {
    const rep = rt.replicas.find(r => r.rackId === accessorRack);
    if (rep) {
      const mid = rep.location.startsWith('mhd:') ? rep.location.split(':')[1] : rep.location;
      const m = STATE.mhdConfig[mid];
      return PM.cxlLocalNs * poolQueue(computeMhdUsed(mid), m ? m.capacityGB : 0);
    }
    if (rt.location === 'rdma') return PM.rdmaNs * congFactor(k.producer, accessorRack);
    const mid = rt.location.split(':')[1];
    const m = STATE.mhdConfig[mid];
    const locRack = m ? m.rackId : null;
    const q = poolQueue(computeMhdUsed(mid), m ? m.capacityGB : 0);
    if (locRack === accessorRack) {
      return nodeHasCxlLink(accessorRack) ? PM.cxlLocalNs * q : PM.dramNs;
    }
    return PM.cxlRemoteNs * q * congFactor(locRack, accessorRack);
  }
  function accessIsLocal(rt, accessorRack) {
    if (rt.replicas.some(r => r.rackId === accessorRack)) return true;
    if (rt.location.startsWith('mhd:')) return mhdRackOf(rt.location.split(':')[1]) === accessorRack;
    return false;
  }

  function computeMetrics() {
    const w = STATE.workload || WORKLOAD_DEFAULT;
    const rate = (w.requestRate || 100) / 100;
    const s = cxlStats();
    // —— 三个硬件因子：配置一动，指标必动 ——
    // 分母只算"已部署 CXL 的机架内的节点"：跨机架 RDMA 的代价已在 ① 机架覆盖体现，避免重复惩罚
    const nodesScope = RACKS.reduce((a, r) => a + (STATE.deployment[r.id] ? r.nodes.length : 0), 0);
    const nodesCxl = RACKS.reduce((a, r) => a + (STATE.deployment[r.id] ? connectedNodeCount(r.id) : 0), 0);
    const coverage = RACKS.length ? s.count / RACKS.length : 0;                            // ① 机架覆盖
    const reach = nodesScope ? nodesCxl / nodesScope : 0;                                  // ② 端口可达
    const hotGB = Math.max(1, Math.round((w.totalGB || 240) * (w.hotRatio || 60) / 100));   // ③ 热 KV 总量
    // 想进池的不止热 KV：还有被跨机架反复访问的"温" KV，合计约 1.35 × 热 KV
    const absorbDemand = Math.max(1, Math.round(hotGB * 1.35));
    // ③ 容量吸收：cap/(cap+demand) —— 渐近饱和，扩容始终有效但不会一步到 100%
    const serveRatio = s.total / (s.total + absorbDemand);
    // 三个因子用"覆盖×可达"的几何均值（线性相乘会把可用性压得过狠），再乘容量吸收
    const reachCap = Math.sqrt(Math.max(0, coverage) * Math.max(0, reach));
    // 即便全量 CXL，仍有一部分 KV 因跨机架一致性、冷缺失、容量抖动回 RDMA，故上限 0.85
    const localCap = Math.min(0.85, serveRatio * reachCap);
    const latLocal = PM.cxlLocalNs * poolQueue(s.used, s.total);
    let latSum = 0, shareSum = 0, sloSum = 0, localSum = 0, crossGB = 0;
    const samples = [];
    KVS.forEach(k => {
      const rt = STATE.kvRuntime[k.id];
      const total = Object.values(rt.dist).reduce((a, b) => a + b, 0) || 1;
      Object.keys(rt.dist).forEach(rk => {
        const share = rt.dist[rk] / total;
        if (share <= 0.001) return;
        const isLocal = accessIsLocal(rt, rk);
        const hotAdd = rt.hotness === 'high' ? 0.06 : 0;
        let lat;
        if (isLocal) {
          lat = accessLatency(k, rt, rk) * (1 + hotAdd);
          localSum += share;
        } else {
          // 未放置的 KV：按硬件能力上限被本地池吸收，其余仍走 RDMA
          const latR = PM.rdmaNs * congFactor(k.producer, rk);
          lat = (localCap * latLocal + (1 - localCap) * latR) * (1 + hotAdd);
          localSum += share * localCap;
          crossGB += share * k.sizeGB * rate * (1 - localCap);
        }
        latSum += lat * share; shareSum += share;
        if (lat <= PM.sloNs) sloSum += share;
        samples.push({ share, lat });
      });
    });
    const avgNs = shareSum ? latSum / shareSum : 0;
    samples.sort((a, b) => a.lat - b.lat);
    let acc = 0, p95 = avgNs;
    for (const sm of samples) { acc += sm.share; if (acc >= shareSum * 0.95) { p95 = sm.lat; break; } }

    const deployCost = s.units * COST_PARAMS.mhdUnitCost + s.count * COST_PARAMS.installCost;
    const opCost = crossGB * PM.opCostPerGB;
    const objective = deployCost + (PM.alpha || 1) * opCost;
    return {
      avgNs, p95Ns: p95, sloRate: shareSum ? sloSum / shareSum : 0,
      localRate: shareSum ? Math.min(1, localSum / shareSum) : 0,
      crossGB: Math.round(crossGB),
      rdmaKV: rdmaUsed(),
      units: s.units, racks: s.count, capacity: s.total, used: s.used, util: s.util,
      coverage, reach, serveRatio, localCap, reachCap, absorbDemand, hotGB, nodesCxl, nodesScope,
      deployCost: Math.round(deployCost * 10) / 10,
      opCost: Math.round(opCost * 10) / 10,
      objective: Math.round(objective * 10) / 10,
      alpha: PM.alpha || 1, latCount: samples.length
    };
  }
  function fmtNs(ns) { return ns >= 1000 ? (ns / 1000).toFixed(2) + ' µs' : Math.round(ns) + ' ns'; }

  // ============================================================
  // 五、KV 工作负载派生
  // ============================================================
  function workloadDerived() {
    const w = STATE.workload;
    const total = w.totalGB || 0;
    const hotGB = Math.round(total * (w.hotRatio / 100));
    const coldGB = total - hotGB;
    let local = 0, shared = 0, burst = 0;
    KVS.forEach(k => {
      const rt = STATE.kvRuntime[k.id];
      const top = Object.keys(rt.dist).reduce((a, b) => rt.dist[a] >= rt.dist[b] ? a : b);
      if (top === k.producer) local++;
      if (Object.values(rt.dist).filter(v => v >= 0.15).length >= 2) shared++;
      if (rt.hotness === 'high' && rt.location === 'rdma') burst++;
    });
    const traffic = Math.round((w.requestRate / 100) * (1 - w.localRatio / 100) * 100);
    return { total, hotGB, coldGB, local, shared, burst, traffic };
  }
  function applyWorkloadToKV() {
    const w = STATE.workload;
    const sorted = KVS.slice().sort((a, b) => b.sizeGB - a.sizeGB);
    sorted.forEach((k, i) => {
      const rt = STATE.kvRuntime[k.id];
      const rank = i / sorted.length;
      rt.hotness = rank < (w.hotRatio / 100) ? 'high' : (rank < (w.hotRatio / 100) + 0.35 ? 'mid' : 'low');
      const others = RACKS.map(r => r.id).filter(r => r !== k.producer);
      const crossShare = w.crossRatio / 100;
      const localShare = w.localRatio / 100;
      const dist = {};
      dist[k.producer] = localShare;
      if (others.length) {
        dist[others[0]] = Math.min(1 - localShare, crossShare);
        const rest = Math.max(0, 1 - localShare - (dist[others[0]] || 0));
        if (others[1]) dist[others[1]] = rest;
        else dist[k.producer] += rest;
      }
      const sum = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
      Object.keys(dist).forEach(rk => dist[rk] = +(dist[rk] / sum).toFixed(2));
      rt.dist = dist;
    });
  }

  // ============================================================
  // 六、容量收敛：容量不足时把 KV 逐出到 RDMA（硬件变化 → KV 位置变化）
  // ============================================================
  function enforceCapacity() {
    let moved = 0;
    (STATE.rackUnits ? Object.keys(STATE.rackUnits) : []).forEach(rid => {
      (STATE.rackUnits[rid] || []).forEach(mid => {
        const m = STATE.mhdConfig[mid]; if (!m) return;
        let guard = 0;
        while (computeMhdUsed(mid) > m.capacityGB && guard++ < 40) {
          // 优先淘汰最冷的副本，其次最冷的原始 KV
          let victim = null, kind = null;
          KVS.forEach(k => {
            const rt = STATE.kvRuntime[k.id];
            const rank = { low:0, mid:1, high:2 }[rt.hotness] || 0;
            const repIdx = rt.replicas.findIndex(r => r.location === mid);
            if (repIdx >= 0) { if (!victim || rank < victim.rank) { victim = { k, repIdx }; kind = 'rep'; } }
            else if (rt.location === 'mhd:' + mid) { if (!victim || rank < victim.rank) { victim = { k, rank }; kind = 'kv'; } }
          });
          if (!victim) break;
          if (kind === 'rep') STATE.kvRuntime[victim.k.id].replicas.splice(victim.repIdx, 1);
          else STATE.kvRuntime[victim.k.id].location = 'rdma';
          moved++;
        }
      });
    });
    if (moved) log(`容量收敛：${moved} 个 KV 被退到 RDMA Pool`, true);
    return moved;
  }

  // ---------- 日志 ----------
  function log(msg, hl) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12:false });
    STATE.logs.unshift({ ts, msg, hl: !!hl });
    STATE.logs = STATE.logs.slice(0, 6);
    if (window.__RENDER_PANELS__ && window.__RENDER_PANELS__.renderLog) {
      window.__RENDER_PANELS__.renderLog();
    }
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  window.__SIM__ = { STATE, D, $, $$, esc, hotColor, loadColor, loadName, t,
    initState, getKV, getRack, getMhd, mhdForRack, mhdUnitsForRack, unitIdsForRack, unitsCount,
    rackCapacity, rackUsed, mhdRackOf, computeMhdUsed, rdmaUsed,
    cxlStats, localKVCount, loadFromFlow, syncLinkLoads, nodeConnected,
    connectedNodeCount, syncMhdNodes, workloadDerived, applyWorkloadToKV,
    initCxlLinks, usedHostPorts, hostPortCapacity, nodeHasCxlLink, mhdReachableHosts,
    createUnit, removeUnit, ensureRackUnits, syncRackMeta,
    computeMetrics, accessLatency, fmtNs, enforceCapacity,
    log, toast };
})();
