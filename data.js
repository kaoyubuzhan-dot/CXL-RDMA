/* ============================================================
 * CXL-RDMA Cluster Deployment Simulator
 * data.js — 集群配置 / KV 对象 / 场景 / 部署方案（全部为教学示意数据）
 * ============================================================ */
(function (global) {
  'use strict';

  // 复用的双语对象（沿用 MRI 模拟器的 A(zh,en) 思路）
  const A = (zh, en) => ({ zh, en });

  // ---------- 颜色语义 ----------
  const COLORS = {
    cxl: '#53e3c4',        // CXL / 本地访问（青绿）
    cxlDim: 'rgba(83,227,196,.14)',
    rdma: '#5f9fe8',       // RDMA / 远程访问（蓝）
    rdmaDim: 'rgba(95,159,232,.14)',
    hotHigh: '#e6a056',    // 高热度（橙）
    hotMid: '#e3cf7d',     // 中热度（黄）
    hotLow: '#5f9fe8',     // 低热度（蓝）
    shared: '#a38bf2',     // 共享访问边框（紫）
    replica: '#91e4ff',    // 副本（亮青，虚线边框）
    loadLow: '#53e3c4',    // 链路低负载
    loadMid: '#e4b66b',    // 链路中负载
    loadHigh: '#e2685b',   // 链路高负载
    gpu: '#9eb2bf',
    mhd: '#53e3c4',
    accent: '#7dc9df'
  };

  // ---------- 集群拓扑（初始：Rack1/3 部署 CXL，Rack2/4 RDMA-only）----------
  const RACKS = [
    {
      id: 'R1', name: 'Rack 1',
      nodes: [
        { id: 'N1', role: 'Prefill', cxl: true },
        { id: 'N2', role: 'Decode',  cxl: true },
        { id: 'N3', role: 'Prefill', cxl: false },
        { id: 'N4', role: 'Decode',  cxl: false }
      ],
      cxlEnabled: true, mhdId: 'MHD-1', mhdUnits: 1, rdma: true
    },
    {
      id: 'R2', name: 'Rack 2',
      nodes: [
        { id: 'N1', role: 'Prefill', cxl: false },
        { id: 'N2', role: 'Decode',  cxl: false },
        { id: 'N3', role: 'Prefill', cxl: false },
        { id: 'N4', role: 'Decode',  cxl: false }
      ],
      cxlEnabled: false, mhdId: null, mhdUnits: 0, rdma: true
    },
    {
      id: 'R3', name: 'Rack 3',
      nodes: [
        { id: 'N1', role: 'Prefill', cxl: true },
        { id: 'N2', role: 'Decode',  cxl: true },
        { id: 'N3', role: 'Prefill', cxl: false },
        { id: 'N4', role: 'Decode',  cxl: false }
      ],
      cxlEnabled: true, mhdId: 'MHD-3', mhdUnits: 1, rdma: true
    },
    {
      id: 'R4', name: 'Rack 4',
      nodes: [
        { id: 'N1', role: 'Prefill', cxl: false },
        { id: 'N2', role: 'Decode',  cxl: false },
        { id: 'N3', role: 'Prefill', cxl: false },
        { id: 'N4', role: 'Decode',  cxl: false }
      ],
      cxlEnabled: false, mhdId: null, mhdUnits: 0, rdma: true
    }
  ];

  // ---------- MHD（共享 CXL 内存池）----------
  // 接口数与容量是两个独立参数
  const MHDS = {
    'MHD-1': {
      id: 'MHD-1', rackId: 'R1', name: 'Rack 1 · Shared MHD',
      capacityGB: 512, hostInterfaces: 2,
      connectedNodes: ['N1', 'N2'], usedGB: 320, baseUsedGB: 264
    },
    'MHD-3': {
      id: 'MHD-3', rackId: 'R3', name: 'Rack 3 · Shared MHD',
      capacityGB: 512, hostInterfaces: 2,
      connectedNodes: ['N1', 'N2'], usedGB: 192, baseUsedGB: 156
    }
    // baseUsedGB：未在界面逐一可视化的基础 KV 占用，使初始总量对齐设计文档示例（320/192 GB）

  };

  // ---------- RDMA 内存池（跨机架共享）----------
  const RDMA_POOL = {
    id: 'RDMA-Pool', name: 'RDMA Remote Memory Pool',
    capacityGB: 2048, usedGB: 0 // usedGB 由 KV 分布计算
  };

  // ---------- KV Block（10 个，教学示意数据）----------
  // location: hbm(静) / dram / mhd:{id} / rdma
  // replicas: [{ rackId, location }]
  function kv(id, producer, sizeGB, hotness, dist, location, replicas, note) {
    return {
      id, producer, sizeGB, hotness, dist,
      location, replicas: replicas || [], note: note || '',
      copyStatus: replicas && replicas.length ? 'Replica' : 'Original'
    };
  }
  const KVS = [
    kv('KV-001', 'R1', 16, 'high',   { R1: 0.85, R3: 0.15 }, 'mhd:MHD-1', [], '本地热 KV，机架内局部访问'),
    kv('KV-002', 'R2', 24, 'mid',    { R1: 0.40, R2: 0.45, R3: 0.15 }, 'rdma', [], '跨机架访问，保留在 RDMA Pool'),
    kv('KV-003', 'R2', 32, 'high',   { R1: 0.70, R2: 0.30 }, 'rdma', [], '重点场景：共享 KV 复制对象'),
    kv('KV-004', 'R2', 16, 'low',    { R2: 0.60, R4: 0.40 }, 'rdma', [], '低热度，保留 RDMA'),
    kv('KV-005', 'R3', 20, 'high',   { R3: 0.80, R1: 0.20 }, 'mhd:MHD-3', [], 'Rack 3 本地热 KV'),
    kv('KV-006', 'R1', 24, 'mid',    { R1: 0.55, R3: 0.45 }, 'mhd:MHD-1', [], '双机架共享，位于 CXL'),
    kv('KV-007', 'R3', 16, 'mid',    { R3: 0.70, R2: 0.30 }, 'mhd:MHD-3', [], '跨机架访问'),
    kv('KV-008', 'R2', 32, 'low',    { R2: 0.50, R4: 0.50 }, 'rdma', [], 'RDMA-only 机架生产'),
    kv('KV-009', 'R4', 16, 'low',    { R4: 0.75, R2: 0.25 }, 'rdma', [], '无 CXL 机架'),
    kv('KV-010', 'R1', 16, 'high',   { R1: 0.90, R4: 0.10 }, 'mhd:MHD-1', [], '强本地性')
  ];

  // ---------- RDMA 链路（Leaf-Spine，机架两两之间）----------
  const LINKS = [
    { id: 'L12', a: 'R1', b: 'R2', load: 'low' },
    { id: 'L13', a: 'R1', b: 'R3', load: 'low' },
    { id: 'L14', a: 'R1', b: 'R4', load: 'low' },
    { id: 'L23', a: 'R2', b: 'R3', load: 'low' },
    { id: 'L24', a: 'R2', b: 'R4', load: 'low' },
    { id: 'L34', a: 'R3', b: 'R4', load: 'low' }
  ];

  // ---------- 6 个预设场景 ----------
  // 每个场景可覆盖：KV 位置/热度/访问分布、链路负载、说明与操作步骤
  const SCENARIOS = [
    {
      id: 'S1', num: '01', name: '初始 CXL 增量部署', nameEn: 'Incremental CXL Deployment',
      kicker: '架构基线',
      desc: '部分机架部署 CXL，其余保留 RDMA-only。展示"机架级部署决策 ≠ 机架内全部节点接入 CXL"。',
      goal: '理解存量 RDMA 集群中的增量 CXL 部署形态。',
      // 位置/热度/分布覆盖（不填则沿用初始）
      overrides: {},
      links: {},
      steps: [
        '观察 4 个机架：Rack 1/3 部署 MHD，Rack 2/4 为 RDMA-only。',
        '展开 Rack 1：仅 N1/N2 接入共享 MHD，N3/N4 仍走 DRAM + RDMA。'
      ]
    },
    {
      id: 'S2', num: '02', name: '本地热 KV 访问', nameEn: 'Local Hot KV Access',
      kicker: '访问局部性',
      desc: 'KV-001 由 Rack 1 生成并主要被同机架 N2 访问，存储于机架内共享 MHD。',
      goal: '理解机架内局部访问无需跨机架 RDMA。',
      overrides: { 'KV-001': { location: 'mhd:MHD-1', hotness: 'high', dist: { R1: 0.88, R3: 0.12 } } },
      links: {},
      focusKV: 'KV-001',
      steps: [
        '在 KV 视图中选中 KV-001，查看生产位置与访问主体。',
        '切换 Traffic 视图，观察访问路径在 Rack 1 机架内完成。'
      ]
    },
    {
      id: 'S3', num: '03', name: '跨机架共享 KV', nameEn: 'Cross-Rack Shared KV',
      kicker: '热 KV 多机架访问',
      desc: 'KV-003 由 Rack 2 生成，存储在 RDMA Pool；Rack 1 访问 70%，Rack 2 访问 30%。',
      goal: '理解仅凭热度无法决定放置，还需知道访问主体在哪。',
      overrides: { 'KV-003': { location: 'rdma', hotness: 'high', dist: { R1: 0.70, R2: 0.30 }, replicas: [] } },
      links: { L12: 'mid', L24: 'low' },
      focusKV: 'KV-003',
      steps: [
        '选中 KV-003，右侧显示 Rack 1 是高访问主体。',
        'Traffic 视图显示 Rack 1 通过 RDMA 访问，链路负载升高。',
        '系统提示：Rack 1 已有 CXL MHD 且仍有容量 → 具备复制条件。'
      ]
    },
    {
      id: 'S4', num: '04', name: '共享 KV 复制', nameEn: 'Shared KV Replication',
      kicker: '本地副本',
      desc: '将 KV-003 复制到 Rack 1 的 MHD；原始 KV 保留在 RDMA Pool，Rack 1 访问切换为本地 CXL。',
      goal: '理解原创分离、访问路径切换与容量变化。',
      overrides: {
        'KV-003': {
          location: 'rdma', hotness: 'high', dist: { R1: 0.70, R2: 0.30 },
          replicas: [{ rackId: 'R1', location: 'MHD-1' }]
        }
      },
      links: { L12: 'low' },
      focusKV: 'KV-003', autoReplicate: true,
      steps: [
        '点击"复制到 Rack 1 MHD"，观察蓝色箭头从 RDMA Pool 指向 Rack 1。',
        'Rack 1 MHD 出现 KV-003 副本，已用容量 320 → 352 GB。',
        'Rack 1 访问箭头转向本地 MHD；Rack 2 继续访问原始数据。'
      ]
    },
    {
      id: 'S5', num: '05', name: '热度变化与淘汰', nameEn: 'Hotness Shift & Eviction',
      kicker: 'CXL 资源动态释放',
      desc: 'KV-003 访问主体由 Rack 1 转向 Rack 4（无 CXL），局部性消失，可淘汰本地副本。',
      goal: '展示 CXL 资源不是永久被某批 KV 占据。',
      overrides: {
        'KV-003': {
          location: 'rdma', hotness: 'mid', dist: { R1: 0.20, R4: 0.65, R2: 0.15 },
          replicas: [{ rackId: 'R1', location: 'MHD-1' }]
        }
      },
      links: { L14: 'high', L24: 'mid' },
      focusKV: 'KV-003',
      steps: [
        '观察访问分布：Rack 4 升至 65%，Rack 1 降至 20%。',
        'Rack 4 无 CXL MHD，KV-003 失去 Rack 1 局部性。',
        '点击"淘汰副本"：Rack 1 MHD 释放 32 GB，原始 KV 仍在 RDMA Pool。'
      ]
    },
    {
      id: 'S6', num: '06', name: 'RDMA 流量集中', nameEn: 'RDMA Traffic Concentration',
      kicker: '网络负载变化',
      desc: '多个机架同时访问少数 RDMA Pool 中的 KV，相关链路负载升高（示意）。',
      goal: '理解访问流量分布对 KV 放置决策的影响。',
      overrides: {
        'KV-002': { hotness: 'high', dist: { R1: 0.55, R2: 0.20, R3: 0.25 } },
        'KV-008': { hotness: 'high', dist: { R1: 0.45, R4: 0.35, R2: 0.20 } }
      },
      links: { L12: 'high', L13: 'high', L24: 'mid', L34: 'mid' },
      focusKV: 'KV-002',
      steps: [
        'Traffic 视图中多条 RDMA 链路变为黄色/红色（示意负载）。',
        '对比：若将高频共享 KV 复制到访问主体机架 MHD，可缓解远程访问。'
      ]
    }
  ];

  // ---------- 三种部署方案（内置）----------
  const DEPLOY_PLANS = [
    { id: 'A', name: '全量 RDMA', sub: 'Baseline 1', racks: [false, false, false, false],
      desc: '4 个机架均不部署 CXL，全部依赖 RDMA 内存池。' },
    { id: 'B', name: '增量 CXL', sub: '研究重点', racks: [true, false, true, false],
      desc: '仅 Rack 1、Rack 3 部署 MHD，其余保留 RDMA（默认方案）。' },
    { id: 'C', name: '全量 CXL', sub: 'Baseline 2', racks: [true, true, true, true],
      desc: '4 个机架都部署 CXL MHD，同时保留 RDMA 网络。' }
  ];

  // ---------- 可配置的 KV 工作负载模型（教学示意）----------
  // 用户可通过滑块调整，模拟器按此重新推导 KV 分类、热度与访问分布
  const WORKLOAD_DEFAULT = {
    totalGB: 500,        // KV 总容量
    hotRatio: 35,        // 热 KV 比例 %
    localRatio: 70,      // 本地访问比例 %
    crossRatio: 20,      // 跨机架共享访问比例 %
    requestRate: 100     // 访问请求量（相对基准 100）
  };

  // KV 容量档位（MHD 容量配置）
  const MHD_CAPACITY_STEPS = [256, 512, 1024];

  // 拥塞预设：作用在每条链路的流量百分比（0-100）
  const CONGESTION_PRESETS = {
    low:  { label: '低', pct: 22 },
    mid:  { label: '中', pct: 58 },
    high: { label: '高', pct: 92 }
  };

  // ---------- 成本参数（示意，用户可改）----------
  const COST_PARAMS = {
    mhdUnitCost: 45,      // 万元 / 台（示意）
    installCost: 8        // 万元 / 机架（示意）
  };

  // ---------- 性能模型参数（教学示意量级，非实测）----------
  // 硬件配置（机架数 / MHD 台数 / 容量 / 端口 / 节点接入）全部通过这条链路影响指标
  const PERF_MODEL = {
    dramNs: 90,          // 本地 DRAM 命中
    cxlLocalNs: 340,     // 机架内 CXL MHD 命中（load/store）
    cxlRemoteNs: 1150,   // 跨机架访问他机架 CXL 池（RDMA + 池内取数）
    rdmaNs: 2100,        // 远端 RDMA 内存池（网卡 + 协议栈 + 网络）
    sloNs: 1500,         // 单次 KV 访问的 SLO 预算（示意）
    congWeight: 3.4,     // 链路流量对跨机架访问的拥塞放大权重
    poolQueue: 0.35,     // 池利用率超过 70% 后的排队放大
    opCostPerGB: 0.05,   // 跨机架 KV 流量的折算运营代价（万元/GB，示意）
    alpha: 1             // 目标函数中「运行代价」相对「部署成本」的权重
  };

  // 单台 MHD 设备的容量档位 / 单机架最多可挂设备数
  const MHD_UNIT_STEPS = [256, 512, 1024, 2048];
  const MAX_MHD_PER_RACK = 3;

  // 指标说明（所有数值均标注为示意）
  const METRIC_NOTES = {
    cost: '示意模型：C = N_MHD·C_MHD + Σ C_install',
    latency: '示意标签，非真实 RDMA/CXL 测量结果',
    load: '预设链路负载数据，非真实拥塞仿真'
  };

  // ---------- 硬件目录（逻辑示意，非实际设备型号）----------
  // 说明：这些是按功能抽象的设备类别，用于展示硬件形态与 U 位关系，
  // 不代表最终选定的商用型号、真实尺寸或实际布线方案。
  const HW_CATALOG = {
    GPU_SERVER: {
      id:'GPU_SERVER', name:'GPU Server', cn:'GPU 服务器', u:2,
      desc:'4×GPU + CPU + 内存的推理服务器，含 1 个 CXL Host Port 与 1 个 RDMA NIC 端口',
      ports:[{ id:'CXL', label:'CXL Host', type:'cxlHost' }, { id:'NIC', label:'RDMA NIC', type:'rdmaNic' }]
    },
    CXL_SWITCH: {
      id:'CXL_SWITCH', name:'CXL Switch', cn:'CXL 交换机', u:1,
      desc:'连接多台主机与内存设备：Host Port 接主机，Memory Device Port 接 MHD；端口数可配置',
      ports:[] // 端口数量由配置 hostPorts / mdpPorts 动态生成
    },
    SHARED_MHD: {
      id:'SHARED_MHD', name:'Shared CXL MHD', cn:'共享 CXL 内存设备', u:2,
      desc:'多主机共享的 CXL 内存池，容量决定共享池总大小；接口数由设备能力决定',
      ports:[] // 端口数量由 mhdConfig.hostInterfaces 动态生成
    },
    RDMA_TOR: {
      id:'RDMA_TOR', name:'RDMA ToR Switch', cn:'RDMA 机架接入交换机', u:1,
      desc:'机架内 RDMA 接入（Leaf），下联各服务器 NIC，上联 Spine',
      ports:[]
    }
  };

  // ---------- 42U 机柜 U 位布局（逻辑示意）----------
  // 采用"从上往下"U42 → U1 的正面视图约定；每类设备占据一个 U 区间。
  const U_LAYOUT = {
    totalU: 42,
    tor:    { from:42, to:40, label:'RDMA ToR / Leaf' },
    cxlSw:  { from:39, to:37, label:'CXL Switch' },
    server: [ // 4 台服务器，每台 2U
      { node:'N1', from:35, to:34 },
      { node:'N2', from:33, to:32 },
      { node:'N3', from:31, to:30 },
      { node:'N4', from:29, to:28 }
    ],
    mhd:    { from:11, to:9, label:'Shared CXL MHD' },
    spare:  { from:8, to:1,  label:'预留 / PDU' }
  };

  // CXL Switch 默认端口配置（Host Port 数 = 可接主机数，与 MHD 容量相互独立）
  const CXL_SWITCH_DEFAULT = { hostPorts: 4, mdpPorts: 1 };

  // 场景中的端口高亮配色
  const PATH_COLORS = { cxl:COLORS.cxl, rdma:COLORS.rdma, idle:'#3c4b57' };

  global.DATA = {
    A, COLORS, RACKS, MHDS, RDMA_POOL, KVS, LINKS,
    SCENARIOS, DEPLOY_PLANS, COST_PARAMS, METRIC_NOTES,
    WORKLOAD_DEFAULT, MHD_CAPACITY_STEPS, CONGESTION_PRESETS,
    PERF_MODEL, MHD_UNIT_STEPS, MAX_MHD_PER_RACK,
    HW_CATALOG, U_LAYOUT, CXL_SWITCH_DEFAULT, PATH_COLORS
  };
})(window);
