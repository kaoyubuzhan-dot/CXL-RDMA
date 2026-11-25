/* ============================================================
 * flow-data.js — 「运行流程 / LIVE RUN」数据层
 *
 * 七阶段生命周期（对应 LLM 推理产生 KV 的全过程）：
 *   01 推理生成 02 信息采集 03 存储决策 04 位置查询
 *   05 数据访问 06 迁移复制 07 淘汰回收
 *
 * 每个阶段描述四件事（参考需求文档「发生了什么」）：
 *   act 动作 · obj 对象 · why 原因 · res 结果
 * 以及该阶段独有动画 anim.type 与指标 metrics。
 *
 * 文本支持占位符，由 {kv} {prod} {local} {hot} {dst} {tier} 等在渲染时填充。
 * ============================================================ */
window.FLOW = (function () {
  'use strict';

  /* ── 机架硬件模型：R1/R3 有共享 MHD，R2/R4 纯 RDMA ── */
  var RACKS = [
    { id: 'R1', tag: 'CXL + RDMA', cxl: true,
      nodes: [ { id: 'N1', role: 'Prefill', cxl: true }, { id: 'N2', role: 'Decode', cxl: true },
               { id: 'N3', role: 'Prefill', cxl: false }, { id: 'N4', role: 'Decode', cxl: false } ],
      mhd: [ { id: 'MHD-1', cap: 512, used: 320 }, { id: 'MHD-2', cap: 512, used: 128 } ] },
    { id: 'R2', tag: 'RDMA ONLY', cxl: false,
      nodes: [ { id: 'N1', role: 'Decode', cxl: false }, { id: 'N2', role: 'Decode', cxl: false },
               { id: 'N3', role: 'Prefill', cxl: false }, { id: 'N4', role: 'Decode', cxl: false } ],
      mhd: [] },
    { id: 'R3', tag: 'CXL + RDMA', cxl: true,
      nodes: [ { id: 'N1', role: 'Prefill', cxl: true }, { id: 'N2', role: 'Decode', cxl: true },
               { id: 'N3', role: 'Decode', cxl: false }, { id: 'N4', role: 'Decode', cxl: false } ],
      mhd: [ { id: 'MHD-3', cap: 512, used: 192 }, { id: 'MHD-4', cap: 512, used: 64 } ] },
    { id: 'R4', tag: 'RDMA ONLY', cxl: false,
      nodes: [ { id: 'N1', role: 'Decode', cxl: false }, { id: 'N2', role: 'Prefill', cxl: false },
               { id: 'N3', role: 'Decode', cxl: false }, { id: 'N4', role: 'Decode', cxl: false } ],
      mhd: [] }
  ];

  /* ── 场景：同一套硬件，不同访问分布 → 决策不同 ── */
  var SCENARIOS = [
    { id: 'S1', zh: '正常推理', en: 'STEADY', brief: '多轮会话稳态，访问集中在生产机架',
      kv: 'KV-001', prod: 'R1-N1', hot: 82, local: 70, dst: 'R1 / MHD-1', tier: 'CXL MHD',
      peer: 'R2-N1', peerLoc: 30, replica: '—', ver: 'V1', delay: '0.9 µs', load: '48%', occ: '63%' },
    { id: 'S2', zh: '本地热点', en: 'HOT SPOT', brief: '单节点反复访问，热度飙升',
      kv: 'KV-002', prod: 'R1-N2', hot: 94, local: 88, dst: 'R1 / MHD-1', tier: 'CXL MHD',
      peer: 'R2-N3', peerLoc: 12, replica: '—', ver: 'V2', delay: '0.6 µs', load: '71%', occ: '78%' },
    { id: 'S3', zh: '跨机架共享', en: 'SHARED', brief: '多机架同时高频访问同一前缀',
      kv: 'KV-003', prod: 'R2-N1', hot: 76, local: 42, dst: 'R2 → R1 / MHD-1', tier: 'CXL MHD + 副本',
      peer: 'R3-N2', peerLoc: 38, replica: 'R1 / MHD-1', ver: 'V3', delay: '2.4 µs', load: '86%', occ: '91%' },
    { id: 'S4', zh: '热度衰减', en: 'DECAY', brief: '会话结束，KV 转冷并下沉',
      kv: 'KV-004', prod: 'R3-N1', hot: 18, local: 12, dst: 'RDMA Pool', tier: 'RDMA 内存池',
      peer: 'R1-N3', peerLoc: 8, replica: '—', ver: 'V4', delay: '4.1 µs', load: '33%', occ: '24%' }
  ];

  /* ── 七阶段 ── */
  var STAGES = [
    {
      id: 'gen', n: '01', zh: '推理生成', en: 'GENERATION',
      caption: '{kv} 在 {prod} 的 GPU HBM 中生成，Prefill 完成，进入可复用状态',
      act: '推理引擎完成 {prod} 的 Prefill，在 GPU HBM 中生成 {kv} 的 KV Block（16 块 / 16 GB 示意）',
      obj: '{prod} · GPU HBM · {kv}',
      why: '多轮会话共享同一段 Prompt 前缀，缓存 KV 可避免重复计算、直接复用',
      res: 'HBM 中出现一组 KV Block，标记为 T+0；此时数据尚未进入共享存储',
      metrics: { 延迟: '0.4 µs', 链路: '12%', 占用: '—' },
      anim: { type: 'gen' }
    },
    {
      id: 'collect', n: '02', zh: '信息采集', en: 'TELEMETRY',
      caption: 'T0 基线画像：全 RDMA 架构下，跨机架访问占大头 · 热度与局部性上报 Controller',
      act: '五类来源并行上报：KV 访问计数与热度、访问主体来源机架、KV 大小、RDMA 链路负载、节点与 CXL 连接关系',
      obj: '{kv} 元数据 · RNIC 遥测 · Topology Monitor · T0 基线指标',
      why: '存储决策需要热度、访问局部性、容量与 CXL 可达性四类依据；T0 阶段集群没有任何 CXL 设备',
      res: '基线结论：访问主体集中在生产机架（{local}%），但只能走 RDMA 远端路径，平均延迟 4.1 µs',
      metrics: { 延迟: '—', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'collect' }
    },
    {
      id: 'decide', n: '03', zh: '存储决策', en: 'PLACEMENT',
      caption: 'Controller 综合全网拓扑 / 历史热度 / 拥塞 / 利用率 / 成本 全局评估 → 一次决策，R1+R3 同批部署',
      act: 'Placement Controller 汇总四机架画像（阶段 02 已一次采齐）：局部性、历史热度、拥塞、利用率、成本，加权评分后同时排定 R1 与 R3',
      obj: '全局决策矩阵 · R1 86 / R3 64 · 两机架并行上线 CXL Switch + 共享 MHD',
      why: '证据一次采齐就没有分批等待的理由：R1 局部性 {local}% 评分最高；R3 的共享热度与 Spine 拥塞 86% 决策时已可见，一并部署',
      res: 'T1 执行：R1 与 R3 同时出现 CXL Switch 与共享 MHD，各接入 N1/N2；{kv} 写入 R1-MHD-1',
      metrics: { 延迟: '—', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'decide' }
    },
    {
      id: 'query', n: '04', zh: '位置查询', en: 'DIRECTORY',
      caption: 'Decode 节点发出 {kv} 查询 → KV Directory 返回 {dst}',
      act: '请求节点只持有逻辑 ID，向 KV Directory 发起查询；Directory 检索映射记录并返回物理位置、状态与版本',
      obj: '{kv} · KV Directory · 逻辑地址 / 物理地址分离',
      why: 'KV 会被迁移与复制，逻辑地址必须与物理位置解耦，否则调用方无法跟随数据移动',
      res: '返回 {dst} · Primary · {ver}；请求方据此决定访问路径',
      metrics: { 延迟: '0.2 µs', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'query' }
    },
    {
      id: 'access', n: '05', zh: '数据访问', en: 'DATA ACCESS',
      caption: '增量部署收益可见：本地 CXL 命中 0.9 µs，对比 T0 基线 RDMA 4.1 µs',
      act: '本地：同机架节点经 CXL 从 {dst} 读取 KV；远端：另一机架仍必须走 Leaf-Spine 跨机架 RDMA',
      obj: '{kv} · CXL 链路（T1 新增） · RDMA 链路（存量）',
      why: 'T1 部署后本地访问可省掉跨机架往返：0.9 µs vs 基线 4.1 µs，这就是增量部署的直接收益',
      res: 'KV Block 回填 GPU HBM；未部署 CXL 的 R2/R4 仍走 4.1 µs RDMA —— 评分 31/26 低于阈值，正是决策矩阵的取舍',
      metrics: { 延迟: '{delay}', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'access' }
    },
    {
      id: 'migrate', n: '06', zh: '迁移复制', en: 'MIGRATE / COPY',
      caption: 'T2：硬件已就位，数据开始重分配——热点 KV 迁入本地 MHD、共享 KV 生成副本',
      act: 'A. 迁移：{kv} 从旧位置搬向 {dst}；B. 复制：多机架共享的高频 KV 在对端生成副本',
      obj: '{kv}（原件）· 新副本 · Directory 版本 · T1 新上线的 R1/R3 MHD',
      why: '访问主体迁移时迁移更省容量；多机架共享时复制能避免跨机架往返',
      res: 'T2 完成：热点 KV 迁入 MHD、副本落位，MHD 利用率升至 63%，Directory 版本升至 {ver}',
      metrics: { 延迟: '{delay}', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'migrate' }
    },
    {
      id: 'evict', n: '07', zh: '淘汰回收', en: 'EVICTION',
      caption: '热度持续下降 → KV 转冷，按策略下沉至 RDMA Pool 或淘汰',
      act: 'Controller 周期复核热度与本地访问比例，判定 {kv} 已转冷；按策略迁移至 RDMA 池或直接淘汰',
      obj: '{kv} · 淘汰队列 · Directory 失效标记',
      why: 'MHD 容量有限，冷数据长期占用会挤掉真正的高频 KV',
      res: '位置变为 RDMA Pool 或 invalid，MHD 占用回落，容量可被新 KV 复用',
      metrics: { 延迟: '4.1 µs', 链路: '33%', 占用: '24%' },
      anim: { type: 'evict' }
    }
  ];

  /* ── CXL 增量部署事件时间轴（与 KV 生命周期并行）──
   * T0 全 RDMA 基线 → T1 R1+R3 同批部署 → T2 KV 重分配
   * 证据在阶段 02 一次采齐，阶段 03 一次决策、同批执行——
   * 不存在"等 R3 的需求再出现才部署"的时间差。
   * START_LEVEL[i] = 第 i 个生命周期阶段开始时的部署等级（0-1），
   * T1 在阶段 03 内动画触发；T2 为数据行为，随阶段 06 动画呈现。 */
  var DEP = [
    { id: 'T0', zh: '全 RDMA 基线', brief: '0 / 4 CXL 机架 · 仅存量 RDMA + 远端内存池' },
    { id: 'T1', zh: 'R1+R3 同批部署', brief: '2 / 4 · 全局证据一次采齐、一次决策，两机架并行上线' },
    { id: 'T2', zh: 'KV 重分配', brief: '热点迁入 MHD · 共享 KV 生成副本 · 利用率 63%' }
  ];
  var START_LEVEL = [0, 0, 0, 1, 1, 1, 1];

  /* ── 全局部署决策矩阵（阶段 03 呈现）──
   * Controller 不只看单个机架，而是综合全网证据加权评分：
   * 局部性（访问集中在谁家）· 历史热度（KV 访问统计）· 拥塞（RDMA 链路压力）
   * 利用率（拓扑负载）· 成本（增量部署回收周期）。
   * 数值为教学示意，非实测。 */
  var DEPLOY_DECISION = {
    note: '综合评分 = 局部性 · 历史热度 · 拥塞收益 · 利用率 · 部署成本 加权（示意，非实测）',
    racks: [
      { id: 'R1', locality: 70, hot: 82, cong: 71, util: 63, cost: '低', score: 86,
        pick: '同批部署', why: '访问集中 70% 却全部压在 RDMA 远端路径，本地化收益最大、回收周期最短' },
      { id: 'R3', locality: 42, hot: 76, cong: 86, util: 48, cost: '低', score: 64,
        pick: '同批部署', why: '跨机架共享热度高、Spine 拥塞 86% —— 证据已在阶段 02 采齐，与 R1 并行上线' },
      { id: 'R2', locality: 18, hot: 35, cong: 33, util: 22, cost: '低', score: 31,
        pick: '暂不部署', why: '访问稀疏、热度低，RDMA 远端池已够用，部署闲置率高' },
      { id: 'R4', locality: 12, hot: 22, cong: 29, util: 18, cost: '中', score: 26,
        pick: '暂不部署', why: '无跨机架共享需求，增量成本回收周期长，维持存量架构' }
    ]
  };

  /* ── 图例（与需求文档统一视觉编码一致） ── */
  var LEGEND = [
    { k: 'kv',   c: '#e6a056', t: 'KV Block（橙色方块）' },
    { k: 'rep',  c: '#a38bf2', t: 'KV 副本（紫色方块）' },
    { k: 'cxl',  c: '#53e3c4', t: 'CXL 数据通路（青绿）' },
    { k: 'rdma', c: '#5f9fe8', t: 'RDMA 数据通路（蓝）' },
    { k: 'ctl',  c: '#e4b66b', t: '控制与遥测（黄虚线）' }
  ];

  function pick(id) {
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === id) return SCENARIOS[i];
    return SCENARIOS[0];
  }
  function stage(id) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i];
    return STAGES[0];
  }
  /* 占位符填充 */
  function fill(str, sc) {
    if (str == null) return '';
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return sc && sc[k] !== undefined ? sc[k] : m;
    });
  }

  return { RACKS: RACKS, SCENARIOS: SCENARIOS, STAGES: STAGES, DEP: DEP, START_LEVEL: START_LEVEL,
           DEPLOY_DECISION: DEPLOY_DECISION, LEGEND: LEGEND, pick: pick, stage: stage, fill: fill };
})();
