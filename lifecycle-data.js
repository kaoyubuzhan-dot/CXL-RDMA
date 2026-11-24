/* ============================================================
 * lifecycle-data.js — KV 全生命周期页面：纯数据剧本
 *
 * 需求来源《LLM 推理产生 KV》：
 *   六阶段 = 推理生成 → 信息采集 → 存储决策 → 位置查询 → 数据访问 → 迁移复制
 *   五场景 = S1 正常推理 / S2 本地热点 / S3 跨机架共享热点 /
 *            S4 访问主体变化 / S5 RDMA 网络拥塞
 *   采集来源 = GPU Runtime · Host Agent · RNIC · Leaf/Spine 遥测 · CXL MHD
 *              （由五个来源分别上报不同维度，Controller 汇总）
 *
 * 一步 = 一帧剧本。step.act 描述三维视觉动作，
 * ev=事件日志，note=Controller 决策语句，dir=KV Directory 快照。
 * 端点：R{n}.N{i} 服务器 / R{n}.MHD / R{n}.TOR / POOL / SPINE / CTRL
 * 全部为教学示意数据，非实测。
 * ============================================================ */
(function (global) {
  'use strict';

  const STAGES = [
    { id: 'gen',      zh: '推理生成', en: 'GENERATE' },
    { id: 'collect',  zh: '信息采集', en: 'COLLECT' },
    { id: 'decide',   zh: '存储决策', en: 'DECIDE' },
    { id: 'query',    zh: '位置查询', en: 'QUERY' },
    { id: 'access',   zh: '数据访问', en: 'ACCESS' },
    { id: 'relocate', zh: '迁移复制', en: 'RELOCATE' }
  ];

  /* 路径配色（沿用需求文档语义） */
  const PATH = {
    cxl:  '#53e3c4',   /* 青绿 = 本地 CXL 访问 */
    rdma: '#5f9fe8',   /* 蓝   = RDMA 跨机架 */
    move: '#e6a056',   /* 橙   = KV 迁移 */
    copy: '#a38bf2',   /* 紫   = KV 复制 */
    idle: '#3c4b57',   /* 灰   = 空闲 */
    mon:  '#7dc9df'    /* 采集信息流 */
  };

  /* 五类采集来源（文档表：谁提供什么维度） */
  const SOURCES = [
    { id: 'gpu',  zh: 'GPU / LLM Runtime', dim: 'KV Block ID · 大小 · 访问频率 · 请求关联' },
    { id: 'host', zh: 'Host Agent',        dim: 'CPU / DRAM 使用量 · CXL 容量与占用' },
    { id: 'rnic', zh: 'RNIC',              dim: 'RDMA 带宽 · 吞吐 · 队列 · 错误计数' },
    { id: 'leaf', zh: 'Leaf / Spine 遥测', dim: '端口利用率 · 队列长度 · 丢包 · 拥塞标记' },
    { id: 'mhd',  zh: 'CXL MHD',           dim: '容量 · 端口连接 · 内存使用' }
  ];

  /* 快捷构造 */
  function P(k, a, b, w) { return { k: k, a: a, b: b, w: w || 1 }; }
  function MK(kv, at, o) { return Object.assign({ kv: kv, at: at }, o || {}); }

  const SCENES = [
    /* ─────────────── S1 正常推理：KV 产生并分配 ─────────────── */
    {
      id: 'S1', zh: '正常推理', en: 'Steady Inference', kv: 'KV-001',
      brief: 'KV 产生并分配，观察初始存储位置：本地热点直接进本机架 MHD。',
      steps: [
        { stage: 'gen', cam: 'R1',
          act: { mk: [MK('KV-001', 'R1.N1', { pulse: 1 })], paths: [], noteKv: 'KV-001' },
          ev: ['用户 Prompt 到达 Rack 1 · N1（Prefill）', 'KV-001 生成中：16 Block × 1 GB，暂存 GPU HBM'],
          note: 'Prefill 处理输入 Prompt，KV 按 Block/Page 组织并分配唯一 Block ID。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · GPU HBM', tier: 'HBM', rep: '—', ver: 'V0', hot: '—', last: 'T+0' } },

        { stage: 'gen', cam: 'R1',
          act: { mk: [MK('KV-001', 'R1.N1')], paths: [P('cxl', 'R1.N1', 'R1.MHD')] },
          ev: ['KV-001 生成完成 16 GB，Decode 继续追加', 'KV Block 元数据已生成 → 交推理框架 KV Cache Manager'],
          note: 'KV 首先由 GPU HBM 中的 KV Cache 管理机制管理，Decode 追加写入。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · GPU HBM', tier: 'HBM', rep: '—', ver: 'V1', hot: '—', last: 'T+0' } },

        { stage: 'collect', cam: 'ctrl',
          act: { mk: [MK('KV-001', 'R1.N1')], mon: 'all' },
          ev: ['GPU Runtime ↑ KV-001 访问频率 4.2 次/请求', 'Host Agent ↑ R1 DRAM 占用 71% · MHD-1 剩余 192 GB',
               'RNIC ↑ R1↔Spine 吞吐 38% · 无错误', 'Leaf/Spine ↑ 队列长度正常 · 无 ECN', 'CXL MHD ↑ 端口 2/2 在线'],
          note: '五类来源分别上报不同维度，由 Controller（Workload Profiler + Topology Monitor）汇总。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · GPU HBM', tier: 'HBM', rep: '—', ver: 'V1', hot: '82', last: 'T+0' } },

        { stage: 'decide', cam: 'ctrl',
          act: { mk: [MK('KV-001', 'R1.N1')], mon: 'all', ctrlPulse: 1 },
          ev: ['Workload Profiler：热度 82 · 访问主体 R1 占 85% → 本地热点',
               'Placement Controller 评分 Score=αH+βL+γB−δC−ηQ → R1 最高',
               '决策 A（本地 CXL 放置）：写入 MHD-1'],
          note: '长期高热度 + 访问集中在本机架 + MHD 有容量 → 进本机架共享 MHD。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · GPU HBM', tier: 'HBM', rep: '—', ver: 'V1', hot: '82', last: 'T+0' } },

        { stage: 'decide', cam: 'R1',
          act: { mkMove: { kv: 'KV-001', from: 'R1.N1', to: 'R1.MHD' }, paths: [P('cxl', 'R1.N1', 'R1.MHD', 2)] },
          ev: ['KV-001 16 GB 下沉 → Rack 1 Shared MHD', 'MHD-1 占用 320 → 336 GB'],
          note: '写入走机架内 CXL 链路（load/store 语义），不占用 RDMA 网络。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: '—', ver: 'V1', hot: '82', last: 'T+1' } },

        { stage: 'query', cam: 'ctrl',
          act: { mk: [MK('KV-001', 'R1.MHD', { pulse: 1 })], ctrlPulse: 1 },
          ev: ['KV Directory 更新：KV-001 → Rack 1 / MHD-1（V1 · 16 GB）', 'Decode 节点查询 KV-001 位置 → 命中目录'],
          note: 'Directory 是逻辑位置目录，不存数据本身；迁移先写目标、确认成功，再更新目录、最后回收旧数据。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: '—', ver: 'V1', hot: '82', last: 'T+1' } },

        { stage: 'access', cam: 'R1',
          act: { mk: [MK('KV-001', 'R1.MHD')], paths: [P('cxl', 'R1.MHD', 'R1.N2', 2), P('rdma', 'R1.MHD', 'SPINE', .5), P('rdma', 'SPINE', 'R3.N1', .5)], linkHL: 'L13' },
          ev: ['R1 · N2 Decode 读取 KV-001 → 本地 CXL（约 340 ns）', 'R3 少量访问（15%）经 RDMA 读取 R1 的 MHD（约 1150 ns）'],
          note: '本地访问高亮青绿；少量外部访问走 RDMA 读他机架 CXL 池，无需复制。',
          dir: { kv: 'KV-001', prod: 'R1 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: '—', ver: 'V1', hot: '82', last: 'T+2' } }
      ]
    },

    /* ─────────────── S2 本地热点：KV 迁入 Rack 1 MHD ─────────────── */
    {
      id: 'S2', zh: '本地热点', en: 'Local Hotness Surge', kv: 'KV-002',
      brief: 'Rack 1 访问热度升高 → KV-002 从 RDMA 池迁移进 MHD-1。',
      steps: [
        { stage: 'gen', cam: 'pool',
          act: { mk: [MK('KV-002', 'POOL')], paths: [P('rdma', 'POOL', 'SPINE', .6)] },
          ev: ['KV-002（R2 生产 · 24 GB）当前位于 RDMA 远端内存池', '初始访问分布：R1 40% · R2 45% · R3 15%'],
          note: '冷 / 无局部性 KV 留在 RDMA 远端池，不占用稀缺 CXL 容量。',
          dir: { kv: 'KV-002', prod: 'R2 / N2', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '58', last: 'T+4' } },

        { stage: 'collect', cam: 'ctrl',
          act: { mk: [MK('KV-002', 'POOL')], mon: ['R1'] },
          ev: ['GPU Runtime ↑ KV-002 访问频率 ×3.4（新会话集中命中）', 'Workload Profiler 热度 58 → 88 · 分布 R1 68% · R2 24% · R3 8%',
               'Host Agent ↑ R1 本地 DRAM 吃紧，KV 换入压力大'],
          note: '热度与访问主体同时变化：Profiler 回答"多热、谁在访问"，Topology Monitor 回答"访问方在哪、链路如何"。',
          dir: { kv: 'KV-002', prod: 'R2 / N2', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '88', last: 'T+6' } },

        { stage: 'decide', cam: 'ctrl',
          act: { mk: [MK('KV-002', 'POOL')], ctrlPulse: 1, mon: ['R1'] },
          ev: ['评分对比：目标 R1（H88 · L68 · 收益高 · 容量 192 GB · 链路空闲）胜出', '决策 D→A：从 RDMA 池迁移到 Rack 1 / MHD-1'],
          note: '热度足够高且集中在 R1，MHD-1 容量充足 → 迁移比"继续远程访问"收益大。',
          dir: { kv: 'KV-002', prod: 'R2 / N2', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '88', last: 'T+6' } },

        { stage: 'relocate', cam: 'all',
          act: { mkMove: { kv: 'KV-002', from: 'POOL', to: 'R1.MHD' }, paths: [P('move', 'POOL', 'SPINE', 2), P('move', 'SPINE', 'R1.MHD', 2)] },
          ev: ['迁移中：24 GB 经 RDMA 写入目标 MHD-1（先写目标）', 'MHD-1 占用 336 → 360 GB'],
          note: '橙色 = 迁移路径：RDMA 传输 → 写入目标机架 MHD，迁移期间旧位置仍可读。',
          dir: { kv: 'KV-002', prod: 'R2 / N2', loc: '迁移中 → MHD-1', tier: 'CXL MHD', rep: '—', ver: 'V2', hot: '88', last: 'T+7' } },

        { stage: 'query', cam: 'ctrl',
          act: { mk: [MK('KV-002', 'R1.MHD', { pulse: 1 })], ctrlPulse: 1 },
          ev: ['目标写入确认成功 → 目录切换：KV-002 = Rack 1 / MHD-1（V2）', 'RDMA 池旧数据回收，释放 24 GB'],
          note: '顺序不可颠倒：确认目标写入 → 更新目录有效位置 → 回收旧数据。',
          dir: { kv: 'KV-002', prod: 'R2 / N2', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: '—', ver: 'V2', hot: '88', last: 'T+7' } },

        { stage: 'access', cam: 'R1',
          act: { mk: [MK('KV-002', 'R1.MHD')], paths: [P('cxl', 'R1.MHD', 'R1.N1', 2), P('cxl', 'R1.MHD', 'R1.N2', 1.2), P('rdma', 'R2.N1', 'SPINE', .6), P('rdma', 'SPINE', 'R1.MHD', .6)], linkHL: 'L12' },
          ev: ['R1 访问切为本地 CXL（约 340 ns），迁移前为 RDMA 约 2100 ns', 'R2 剩余 24% 访问经 RDMA 读 R1 的 MHD（约 1150 ns）'],
          note: '决策收益兑现：主访问路径时延降约 6 倍，链路负载同步下降。',
          dir: { kv: 'KV-002', prod: 'R2 / N2', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: '—', ver: 'V2', hot: '88', last: 'T+8' } }
      ]
    },

    /* ─────────────── S3 跨机架共享热点：复制 ─────────────── */
    {
      id: 'S3', zh: '跨机架共享热点', en: 'Shared Hot Replication', kv: 'KV-003',
      brief: 'R1、R2 同时高频访问 → 复制副本到 Rack 1 MHD，原创分离。',
      steps: [
        { stage: 'gen', cam: 'R2',
          act: { mk: [MK('KV-003', 'R2.N1', { pulse: 1 })] },
          ev: ['用户 Prompt → Rack 2 · N1 Prefill', 'KV-003 生成：32 Block × 1 GB，暂存 HBM'],
          note: '生产者机架 = Rack 2；此时还不知道谁会访问它。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R2 · GPU HBM', tier: 'HBM', rep: '—', ver: 'V0', hot: '—', last: 'T+0' } },

        { stage: 'gen', cam: 'pool',
          act: { mkMove: { kv: 'KV-003', from: 'R2.N1', to: 'POOL' }, paths: [P('rdma', 'R2.N1', 'SPINE'), P('rdma', 'SPINE', 'POOL')] },
          ev: ['R2 无 CXL（RDMA-only）→ KV-003 下沉 RDMA 远端池', '访问画像建立中：R1 62% · R2 30% · 其他 8%'],
          note: 'RDMA-only 机架生产的 KV 默认进远端池，等待访问分布形成后再决策。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '71', last: 'T+2' } },

        { stage: 'collect', cam: 'ctrl',
          act: { mk: [MK('KV-003', 'POOL')], mon: ['R1', 'R2', 'SPINE'] },
          ev: ['GPU Runtime ↑ KV-003 热度 85，Rack 1 会话成主力（70%）', 'RNIC ↑ R1↔R2 方向流量持续走高', 'Leaf 遥测 ↑ 链路 L12 负载 58%（中）'],
          note: '网络指标（流量、队列）由 RNIC 与交换机提供；"谁在访问 KV"仍由推理框架上报，两者不混用。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '85', last: 'T+6' } },

        { stage: 'decide', cam: 'ctrl',
          act: { mk: [MK('KV-003', 'POOL')], ctrlPulse: 1, mon: ['R1', 'R2'] },
          ev: ['Workload Profiler：多机架共享热点（R1 70% · R2 30%）', '收益估算：R1 本地化节省 ≈ 1150 ns × 70% 访问 > 32 GB 传输 + 容量成本', '决策 C（跨机架复制）：复制一份到 Rack 1 / MHD-1，原位置保留'],
          note: '复制 ≠ 迁移：收益超过传输与容量成本才复制；原位置保留副本供 R2 继续访问。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '85', last: 'T+6' } },

        { stage: 'relocate', cam: 'all',
          act: { mkCopy: { kv: 'KV-003', from: 'POOL', to: 'R1.MHD' }, paths: [P('copy', 'POOL', 'SPINE', 2), P('copy', 'SPINE', 'R1.MHD', 2)] },
          ev: ['复制中：32 GB 经 RDMA 写入 MHD-1（紫色路径）', 'MHD-1 占用 360 → 392 GB · 剩余 120 GB'],
          note: '紫色 = 复制：RDMA 网络传输 → 写入目标机架 MHD；原 RDMA 池数据保持可读。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'RDMA Pool', tier: 'RDMA', rep: '写入中 R1', ver: 'V2', hot: '85', last: 'T+7' } },

        { stage: 'query', cam: 'ctrl',
          act: { mk: [MK('KV-003', 'R1.MHD', { pulse: 1 }), MK('KV-003', 'POOL')], ctrlPulse: 1 },
          ev: ['副本写入确认 → 目录：当前 = MHD-1（副本）· 原始 = RDMA Pool', '版本 V2 · 有效副本 2 · 访问权限 R1/R2'],
          note: 'Directory 同时记录当前位置与副本：查询方按"就近 + 有效"选择副本。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V2', hot: '85', last: 'T+7' } },

        { stage: 'access', cam: 'all',
          act: { mk: [MK('KV-003', 'R1.MHD'), MK('KV-003', 'POOL')], paths: [P('cxl', 'R1.MHD', 'R1.N1', 2), P('cxl', 'R1.MHD', 'R1.N2', 1.2), P('rdma', 'R2.N1', 'POOL', .8), P('rdma', 'R2.N2', 'POOL', .8)], linkHL: 'L12-down' },
          ev: ['Rack 1 后续访问 → 本地 CXL 读 MHD-1 副本（青绿）', 'Rack 2 仍经 RDMA 访问原始副本（蓝）· L12 链路负载回落'],
          note: '这就是论文里的共享热点 KV 复制场景：一次复制，两条路径长期共存。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V2', hot: '85', last: 'T+8' } }
      ]
    },

    /* ─────────────── S4 访问主体变化：迁移与重新放置 ─────────────── */
    {
      id: 'S4', zh: '访问主体变化', en: 'Access Shift & Re-placement', kv: 'KV-003',
      brief: '访问主力转向 Rack 3 → 副本从 MHD-1 迁移到 MHD-3，旧副本淘汰。',
      steps: [
        { stage: 'collect', cam: 'ctrl',
          act: { mk: [MK('KV-003', 'R1.MHD'), MK('KV-003', 'POOL')], mon: ['R3', 'R1'] },
          ev: ['GPU Runtime ↑ 新会话上线：KV-003 访问分布 R3 60% · R1 20% · R2 20%', 'Workload Profiler：热度 85 → 62 · 最近访问 T+12',
               'Host Agent ↑ R3 MHD-3 剩余 320 GB · 端口 2/2'],
          note: '访问主体发生变化是动态反馈的触发条件：目录里记录的"当前最优位置"可能已经过期。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V2', hot: '62', last: 'T+12' } },

        { stage: 'decide', cam: 'ctrl',
          act: { mk: [MK('KV-003', 'R1.MHD'), MK('KV-003', 'POOL')], ctrlPulse: 1, mon: ['R3'] },
          ev: ['评分：目标 R3（L60 · 容量足 · 链路 L13/L23 低负载）> 维持 R1（L 仅 20）', '决策 D（迁移）：MHD-1 副本迁至 MHD-3，不做复制（热度中等，两份副本成本 > 收益）'],
          note: '热度下降一档时选迁移而不是再复制——评分模型同时惩罚容量占用 δC。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R1 · MHD-1', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V2', hot: '62', last: 'T+12' } },

        { stage: 'relocate', cam: 'all',
          act: { mkMove: { kv: 'KV-003', from: 'R1.MHD', to: 'R3.MHD' }, paths: [P('move', 'R1.MHD', 'SPINE', 2), P('move', 'SPINE', 'R3.MHD', 2)] },
          ev: ['迁移中：32 GB MHD-1 → Spine → MHD-3（先写目标）', 'MHD-3 占用 192 → 224 GB'],
          note: '橙色跨机架迁移：源副本在目标确认前保持可读，访问不中断。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: '迁移中 → MHD-3', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V3', hot: '62', last: 'T+13' } },

        { stage: 'query', cam: 'ctrl',
          act: { mk: [MK('KV-003', 'R3.MHD', { pulse: 1 }), MK('KV-003', 'POOL')], ctrlPulse: 1 },
          ev: ['目录切换：KV-003 = Rack 3 / MHD-3（V3）', '目录确认后回收：MHD-1 淘汰 KV-003 副本，392 → 360 GB'],
          note: '先切目录、再回收旧数据；MHD-1 的 32 GB 重新可用——CXL 容量不是永久被占。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R3 · MHD-3', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V3', hot: '62', last: 'T+13' } },

        { stage: 'access', cam: 'R3',
          act: { mk: [MK('KV-003', 'R3.MHD')], paths: [P('cxl', 'R3.MHD', 'R3.N1', 2), P('cxl', 'R3.MHD', 'R3.N2', 1.2), P('rdma', 'R1.N2', 'SPINE', .5), P('rdma', 'SPINE', 'R3.MHD', .5)] },
          ev: ['Rack 3 本地 CXL 读取（约 340 ns）', 'R1 残余 20% 访问经 RDMA 读 MHD-3（约 1150 ns）'],
          note: '闭环完成：热度变化 → 采集 → 决策 → 迁移 → 目录更新 → 访问路径随之切换。',
          dir: { kv: 'KV-003', prod: 'R2 / N1', loc: 'R3 · MHD-3', tier: 'CXL MHD', rep: 'RDMA Pool（原始）', ver: 'V3', hot: '62', last: 'T+14' } }
      ]
    },

    /* ─────────────── S5 RDMA 网络拥塞：拥塞感知决策 ─────────────── */
    {
      id: 'S5', zh: 'RDMA 网络拥塞', en: 'RDMA Congestion', kv: 'KV-008',
      brief: '链路队列升高 → 拥塞代价进入评分，决策改为"迁移缓行 + 绕行"。',
      steps: [
        { stage: 'collect', cam: 'ctrl',
          act: { mk: [MK('KV-008', 'POOL')], mon: ['SPINE'], cong: ['L24', 'L14'] },
          ev: ['Leaf/Spine 遥测 ↑ L24（R2–R4）队列 82% · ECN 标记出现', 'RNIC ↑ R2/R4 出向重传计数上升 · 吞吐 91%',
               'Topology Monitor：L24 / L14 标记为 high'],
          note: '拥塞信号只来自交换机遥测与网卡计数——这是网络维度的输入，与 KV 元数据并行汇聚。',
          dir: { kv: 'KV-008', prod: 'R2 / N3', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '55', last: 'T+20' } },

        { stage: 'gen', cam: 'pool',
          act: { mk: [MK('KV-008', 'POOL'), MK('KV-009', 'POOL')], paths: [P('rdma', 'POOL', 'SPINE', 1.6), P('rdma', 'SPINE', 'R2.N3', 1.2), P('rdma', 'SPINE', 'R4.N1', 1.2, 'idle')], cong: ['L24'] },
          ev: ['KV-008（R2/R4 各 50% · 32 GB）与 KV-009（R4 为主）同时远程读取', '拥塞路径上访问时延 2.1 → 3.1 ms（排队分量上升）'],
          note: 'Rack 4 是 RDMA-only：没有本地 CXL 落点，访问只能长期走网络——正好暴露网络容量问题。',
          dir: { kv: 'KV-008', prod: 'R2 / N3', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '55', last: 'T+20' } },

        { stage: 'decide', cam: 'ctrl',
          act: { mk: [MK('KV-008', 'POOL')], ctrlPulse: 1, cong: ['L24', 'L14'] },
          ev: ['评分：目标 R4 不可行（无 MHD）· 复制 R1 需新增跨架流量（拥塞期 ηQ 惩罚大）', '决策：本轮维持 RDMA 放置 + 绕行调度；新批次 KV 预留 R1 容量'],
          note: 'ηQ（拥塞代价）改变评分排序后，"不动作"本身就是最优决策——模拟器要能展示这种否决。',
          dir: { kv: 'KV-008', prod: 'R2 / N3', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '55', last: 'T+20' } },

        { stage: 'access', cam: 'all',
          act: { mk: [MK('KV-008', 'POOL')], paths: [P('rdma', 'POOL', 'SPINE', 1.4), P('rdma', 'SPINE', 'R2.N3', 1.1), P('rdma', 'SPINE', 'R4.N1', 1.1), P('idle', 'R2.TOR', 'R4.TOR', .5)] },
          ev: ['流量从拥塞直连改经 Spine 双跳绕行（避开 L24 段）', 'L24 队列 82% → 54% · 访问时延回落至 2.6 ms'],
          note: '灰色 = 空闲/被绕开的链路；绕行使平均时延略升，但拥塞段恢复，整体排队代价下降。',
          dir: { kv: 'KV-008', prod: 'R2 / N3', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '55', last: 'T+21' } },

        { stage: 'relocate', cam: 'ctrl',
          act: { mk: [MK('KV-008', 'POOL')], mon: ['R1', 'SPINE'], ctrlPulse: 1 },
          ev: ['监控热度：维持 55 · 未达 CXL 复制阈值', '预案挂载：若 R1 访问占比 > 40% 且 L12 空闲 → 自动复制 MHD-1（352/512 GB 预留完成）',
               '本轮结束：决策 = 放置不变 + 路径绕行 + 预案待命'],
          note: '动态反馈不止"迁 or 不迁"，还包括为下一次变化提前准备：目录、容量、路由都是可调变量。',
          dir: { kv: 'KV-008', prod: 'R2 / N3', loc: 'RDMA Pool', tier: 'RDMA', rep: '—', ver: 'V1', hot: '55', last: 'T+22' } }
      ]
    }
  ];

  global.LC = { STAGES: STAGES, PATH: PATH, SOURCES: SOURCES, SCENES: SCENES };
})(window);
