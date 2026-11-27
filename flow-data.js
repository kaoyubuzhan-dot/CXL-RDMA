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

  /* ── 场景：同一套硬件，四种访问分布 → 四种放置决策 ──
   * 对应「先判断访问局部性，再决定放置」框架：
   *   S1 单机架高热度           → 本地 CXL（常态调度）
   *   S2 公共上下文（突发共享） → 跨机架复制到 CXL
   *   S3 生产=访问机架(RDMA-only) → 不部署远端 CXL
   *   S4 多机架均匀             → 保留 RDMA 存储
   * deploy: 本情景最终部署 CXL 的机架（空数组 = 维持全 RDMA）。
   * decision: 本情景的全局决策矩阵（阶段 03 呈现）。
   * ov: 按阶段覆盖默认文案（caption/act/obj/why/res）。
   * 全部数值为教学示意，非实测。 */
  var SCENARIOS = [
    { id: 'S1', zh: '单机架高热度', en: 'RACK-HOT', brief: '集中在同一 Rack · 长期热 → 本地 CXL · 常态调度',
      kv: 'KV-001', prod: 'R1-N1', hot: 82, local: 70, dst: 'R1 / MHD-1', tier: 'CXL MHD',
      peer: 'R2-N1', peerLoc: 30, replica: '—', ver: 'V1', delay: '0.9 µs', load: '48%', occ: '63%',
      r1score: 86, r3score: 64, r3cong: 86,
      deploy: ['R1', 'R3'],
      decision: {
        note: '综合评分 = 局部性 · 历史热度 · 拥塞收益 · 利用率 · 部署成本 加权（示意，非实测）',
        racks: [
          { id: 'R1', locality: 70, hot: 82, cong: 71, util: 63, cost: '低', score: 86, pick: '同批部署',
            why: '访问集中 70% 却全部压在 RDMA 远端路径，本地化收益最大、回收周期最短' },
          { id: 'R3', locality: 42, hot: 76, cong: 86, util: 48, cost: '低', score: 64, pick: '同批部署',
            why: '跨机架共享热度高、Spine 拥塞 86% —— 证据已在阶段 02 采齐，与 R1 并行上线' },
          { id: 'R2', locality: 18, hot: 35, cong: 33, util: 22, cost: '低', score: 31, pick: '暂不部署',
            why: '访问稀疏、热度低，RDMA 远端池已够用，部署闲置率高' },
          { id: 'R4', locality: 12, hot: 22, cong: 29, util: 18, cost: '中', score: 26, pick: '暂不部署',
            why: '无跨机架共享需求，增量成本回收周期长，维持存量架构' }
        ] } },
    { id: 'S2', zh: '公共上下文', en: 'SHARED-BURST', brief: '多机架共享 · 短期突发 → 跨机架复制到 CXL',
      kv: 'KV-002', prod: 'R2-N1', hot: 91, local: 45, dst: 'R1-MHD-1 + R3-MHD-3（副本）', tier: 'CXL MHD 副本',
      peer: 'R3-N2', peerLoc: 38, replica: 'R1-MHD-1 · R3-MHD-3', ver: 'V2', delay: '1.1 µs', load: '91%', occ: '84%',
      r1score: 84, r3score: 78, r3cong: 91,
      deploy: ['R1', 'R3'],
      decision: {
        note: '突发长上下文被多机架同时请求 · 拥塞驱动（示意，非实测）',
        racks: [
          { id: 'R1', locality: 38, hot: 88, cong: 91, util: 63, cost: '低', score: 84, pick: '同批部署',
            why: '突发请求占比高且 Spine 拥塞 91%，本地副本可立即卸载跨机架流量' },
          { id: 'R3', locality: 34, hot: 85, cong: 88, util: 48, cost: '低', score: 78, pick: '同批部署',
            why: '同为突发请求方 —— 副本就近放入本机架 MHD，避免重复占用 Spine' },
          { id: 'R2', locality: 18, hot: 62, cong: 44, util: 22, cost: '低', score: 42, pick: '暂不部署',
            why: '生产机架，持有原件即可；无 CXL 硬件时经 RDMA 读取副本' },
          { id: 'R4', locality: 10, hot: 24, cong: 27, util: 18, cost: '中', score: 30, pick: '暂不部署',
            why: '与该 KV 无明显交集，维持存量架构' }
        ] },
      ov: {
        gen: { res: '突发：同一份长上下文前缀在短时间内被 R1/R2/R3 同时高频请求（示意）' },
        decide: {
          caption: '突发共享 → 全局证据一次采齐，R1+R3 同批部署，副本就近放入各机架 MHD',
          why: '多机架共享热度 88+、Spine 拥塞 91%：R1/R3 评分 {r1score}/{r3score} 并行上线；多方同时读 → 复制优于迁移',
          res: 'T1 执行后，{kv} 以副本形式分别落入 R1-MHD-1 与 R3-MHD-3，原件保留在 RDMA Pool' },
        access: {
          caption: '各机架从本机架 MHD 副本读取：R1/R3 命中 0.9–1.1 µs，R2 经 RDMA 读取副本',
          res: '三个机架的访问被本地副本吸收，Spine 链路压力从 91% 显著回落' },
        migrate: {
          caption: '复制优先：共享 KV 在 R1/R3 MHD 各存一份副本，原件保留（多读场景不宜迁移）',
          res: '副本落位：R1-MHD-1 + R3-MHD-3 · Directory 版本 {ver} 记录多副本映射' },
        evict: { res: '突发结束后副本热度回落：按 LRU 先回收副本，原件下沉 RDMA Pool' }
      } },
    { id: 'S3', zh: '生产 = 访问机架', en: 'PROD-EQ-ACC', brief: '均在 RDMA-only 机架 → 不部署远端 CXL',
      kv: 'KV-003', prod: 'R2-N1', hot: 78, local: 85, dst: 'RDMA Pool-A', tier: 'RDMA 内存池',
      peer: 'R2-N3', peerLoc: 85, replica: '—', ver: 'V3', delay: '4.1 µs', load: '33%', occ: '24%',
      deploy: [],
      decision: {
        note: '生产与访问重合在同一 RDMA-only 机架（示意，非实测）',
        racks: [
          { id: 'R2', locality: 85, hot: 78, cong: 33, util: 22, cost: '—', score: 41, pick: '不部署',
            why: '访问 85% 集中在 R2，但生产=访问重合：数据留在 RDMA Pool 即可，远端 CXL 无收益' },
          { id: 'R1', locality: 8, hot: 24, cong: 40, util: 63, cost: '低', score: 25, pick: '暂不部署',
            why: '几乎不访问该 KV，为它部署 CXL 属于无效投入' },
          { id: 'R3', locality: 5, hot: 18, cong: 30, util: 48, cost: '低', score: 20, pick: '暂不部署',
            why: '同上，无访问收益' },
          { id: 'R4', locality: 4, hot: 12, cong: 29, util: 18, cost: '中', score: 15, pick: '暂不部署',
            why: '无访问、成本中等，维持存量架构' }
        ] },
      ov: {
        gen: { res: '生产与访问都在 R2（RDMA-only 机架）—— 数据没有离开集群远端池的理由' },
        decide: {
          caption: '决策矩阵：访问高度集中但生产=访问重合 → 判定不部署远端 CXL',
          act: 'Placement Controller 汇总四机架画像：访问 85% 集中在 R2，而 R2 是 RDMA-only 机架',
          obj: '全局决策矩阵 · R2 41 / 其余 ≤ 25 · 判定：维持全 RDMA',
          why: '把 KV 放进其他机架的 CXL MHD，只会把"本机架命中"变成"跨机架 RDMA"——远端 CXL 对生产=访问重合的 KV 无收益',
          res: 'T0 维持：全 RDMA 架构不变，{kv} 保留在 RDMA Pool-A · 部署时间轴停在 T0' },
        access: {
          caption: 'R2 节点经 RNIC + Leaf-Spine 访问 RDMA Pool · 4.1 µs —— 本情景的正确路径',
          act: 'R2 各节点经 RNIC 直达远端内存池，访问全部在存量 RDMA 路径完成',
          why: '不部署决策的正确性体现在：没有为无收益的 KV 支付增量硬件成本',
          res: '延迟 4.1 µs（基线水平）—— 宁可接受基线延迟，也不做无效部署' },
        migrate: {
          caption: '无迁移 / 复制：访问局部性 85% 且无跨机架共享，数据原地保留',
          act: '本情景不触发迁移或复制 —— Controller 持续观察访问主体是否漂移',
          obj: '{kv} · 位置不变 · RDMA Pool-A',
          why: '迁移/复制的触发条件是"访问主体变化"或"多机架共享"，本情景两者皆无',
          res: '若未来访问主体漂移到 CXL 机架，将重新进入 03 决策评估' },
        evict: { res: '热度回落 → Directory 标记 invalid，RDMA Pool 容量回收复用' }
      } },
    { id: 'S4', zh: '多机架均匀', en: 'UNIFORM', brief: '无明显主力机架 → 保留 RDMA 存储',
      kv: 'KV-004', prod: 'R3-N2', hot: 52, local: 24, dst: 'RDMA Pool-A', tier: 'RDMA 内存池',
      peer: 'R1-N3', peerLoc: 22, replica: '—', ver: 'V4', delay: '4.1 µs', load: '33%', occ: '24%',
      deploy: [],
      decision: {
        note: '访问均匀散布 · 无明显主力访问机架（示意，非实测）',
        racks: [
          { id: 'R1', locality: 24, hot: 52, cong: 41, util: 63, cost: '低', score: 34, pick: '暂不部署',
            why: '均匀访问下部署只能服务 1/4 请求，收益摊薄、回收周期拉长' },
          { id: 'R2', locality: 26, hot: 48, cong: 33, util: 22, cost: '低', score: 30, pick: '暂不部署',
            why: '同上 —— 无主力机架意味着任何放置都不"就近"' },
          { id: 'R3', locality: 25, hot: 50, cong: 30, util: 48, cost: '低', score: 28, pick: '暂不部署',
            why: 'RDMA Pool 天然全网共享，均匀访问正是它的主场' },
          { id: 'R4', locality: 22, hot: 45, cong: 29, util: 18, cost: '中', score: 22, pick: '暂不部署',
            why: '维持存量架构，观察访问形态是否收敛后再评估' }
        ] },
      ov: {
        gen: { res: '访问主体均匀散布在四个机架（各 ≤ 26%）—— 无明显主力访问机架' },
        decide: {
          caption: '决策矩阵：四机架评分 34/30/28/22 全部低于阈值 → 保留 RDMA 存储',
          act: 'Placement Controller 汇总四机架画像：访问均匀散布，没有任何机架形成局部性热点',
          obj: '全局决策矩阵 · 全部 < 35 · 判定：维持全 RDMA',
          why: '没有主力机架 → 任何机架部署 CXL 都只能服务 1/4 的访问；RDMA Pool 天然全网共享，均匀访问正是它的主场',
          res: 'T0 维持：全 RDMA 架构不变 · 部署时间轴停在 T0' },
        access: {
          caption: '四机架经 Leaf-Spine 均匀访问 RDMA Pool · 4.1 µs · 无热点链路',
          act: '四个机架的访问在 Spine 上均匀分摊（ECMP），链路负载 33% 无拥塞',
          why: '存量 RDMA 架构恰好匹配"均匀访问"的负载形态 —— 这正是它被设计出来的场景',
          res: '全网共享一份数据，避免任何副本一致性开销' },
        migrate: {
          caption: '无迁移 / 复制：均匀访问下任何"就近化"都会制造新的不均匀',
          act: '本情景不触发迁移或复制',
          obj: '{kv} · 全网单一份 · RDMA Pool-A',
          why: '把数据搬向任何一个机架都会让其余三个机架的访问变远',
          res: '保持单一份 + 全网可达，是均匀访问形态下的最优放置' },
        evict: { res: '热度回落 → Directory 标记 invalid，RDMA Pool 容量回收复用' }
      } }
  ];

  /* ── 七阶段 ── */
  var STAGES = [
    {
      id: 'gen', n: '01', zh: '推理生成', en: 'GENERATION',
      caption: '全集群 16 节点并行推理 · 各自产生 KV；本轮跟踪 {prod} 的 {kv}',
      act: '四个机架的推理节点（Prefill/Decode）并行执行推理，各自在 GPU HBM 中生成 KV Block；{kv} 为本轮重点跟踪对象（16 块 / 16 GB 示意）',
      obj: '全集群 16 节点 · GPU HBM · 重点跟踪 {prod} 的 {kv}',
      why: '多轮会话共享同一段 Prompt 前缀，缓存 KV 可避免重复计算；每个推理节点都在持续产生自己的 KV',
      res: '全集群都在持续产生 KV（示意），{kv} 首先出现在 {prod} 的 HBM 中，尚未进入共享存储',
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
      obj: '全局决策矩阵 · R1 {r1score} / R3 {r3score} · 两机架并行上线 CXL Switch + 共享 MHD',
      why: '证据一次采齐就没有分批等待的理由：R1 局部性 {local}% 评分最高；R3 的共享热度与 Spine 拥塞 {r3cong}% 决策时已可见，一并部署',
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

  /* ── 全局部署决策矩阵：已并入各场景的 decision 字段（随情景变化）── */

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
           LEGEND: LEGEND, pick: pick, stage: stage, fill: fill };
})();
