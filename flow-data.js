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
      caption: 'Runtime Agent · RNIC · Leaf-Spine · Topology Monitor 分别上报统计，汇总至 Controller',
      act: '五类来源并行上报：KV 访问计数与热度、访问主体来源机架、KV 大小、RDMA 链路负载、节点与 CXL 连接关系',
      obj: '{kv} 元数据 · RNIC 遥测 · Topology Monitor',
      why: '存储决策需要热度、访问局部性、容量与 CXL 可达性四类依据',
      res: 'Controller 收到汇总画像（仅元数据，KV 本体不搬运）：热度 {hot}，本地访问 {local}%',
      metrics: { 延迟: '—', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'collect' }
    },
    {
      id: 'decide', n: '03', zh: '存储决策', en: 'PLACEMENT',
      caption: 'Placement Controller 比较候选位置：本地 MHD / 远端 MHD / RDMA 池 → 选定 {dst}',
      act: 'Workload Profiler 算出访问主体集中在生产机架（{local}%），Placement Controller 逐项比较候选存储位置',
      obj: '{kv} · 候选：R1-MHD-1 / R3-MHD-3 / RDMA Pool',
      why: '本地访问占比 {local}%、目标机架 MHD 尚有余量、相关节点具备 CXL 接入条件',
      res: '选定 {dst} 作为目标位置，Directory 写入「逻辑 ID → 物理位置」映射',
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
      caption: '本地访问走 CXL 链路（青绿），跨机架访问走 Leaf-Spine RDMA（蓝），两条路径分别点亮',
      act: '本地：同机架节点经 CXL 从 {dst} 读取 KV；远端：另一机架经 Leaf-Spine 跨机架访问同一份数据',
      obj: '{kv} · CXL 链路 · RDMA 链路',
      why: '本地 CXL 命中可省掉跨机架往返；远端访问必须经过 ToR → Spine → ToR',
      res: 'KV Block 回填 GPU HBM，链路负载与访问延迟更新（本地 {delay}）',
      metrics: { 延迟: '{delay}', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'access' }
    },
    {
      id: 'migrate', n: '06', zh: '迁移复制', en: 'MIGRATE / COPY',
      caption: '迁移 = 原件移动并释放旧位置；复制 = 原件保留、新增紫色副本',
      act: 'A. 迁移：{kv} 从旧位置搬向 {dst}；B. 复制：高频 KV 在目标机架生成副本',
      obj: '{kv}（原件）· 新副本 · Directory 版本',
      why: '访问主体迁移时迁移更省容量；多机架共享时复制能避免跨机架往返',
      res: 'Directory 版本升至 {ver}，新增副本记录 {replica}，旧位置释放空间',
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

  return { RACKS: RACKS, SCENARIOS: SCENARIOS, STAGES: STAGES, LEGEND: LEGEND,
           pick: pick, stage: stage, fill: fill };
})();
