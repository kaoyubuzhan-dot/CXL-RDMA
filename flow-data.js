/* ============================================================
 * flow-data.js — 「运行流程 / LIVE RUN」数据层
 *
 * 八阶段生命周期（对应 LLM 推理产生 KV 的全过程）：
 *   01 推理生成 02 信息采集 03 存储决策 04 局部性判定（核心分叉）
 *   05 位置查询 06 数据访问 07 迁移复制 08 淘汰回收
 *
 * 【前提焊死】离线增量决策已落板：R1/R3 带 CXL-MHD，R2/R4 无 CXL，
 * 底座统一 Leaf-Spine RDMA —— 硬件固定，四情景共享同一份部署矩阵。
 * 情景差异不是"选哪个池"的自由选择，而是由
 * 原生 RDMA 池水位 & 代价阈值在运行时驱动出来的分流：
 *
 *   Cost(X) = 原生 RDMA 链路代价（全局原生 DRAM 池）
 *   Cost(Y) = 跨机架 RDMA 转发代价 + CXL 访存代价（远端 R1/R3 MHD）
 *   仅当原生池过载、Cost(X) 被抬到极高时 Cost(Y) 才反超：
 *     S1 主力自带 CXL → 本地命中（增量部署主收益）
 *     S2 水位未击穿   → 回退原生池，主动无视增量硬件
 *     S3 水位击穿     → 兜底借用远端增量池（S3 不是常态）
 *     S4 长期共享热点 → 复制托管增量池（区别于 S3 单次溢流救急）
 *
 * 每阶段描述：act 动作 · obj 对象 · why 原因 · res 结果
 * 场景新增字段：
 *   place   动画走向：mhd / pool / remote-mhd / copy
 *   pool    原生池水位 { used, cong, note }
 *   jq/jyes/jno/jpick  判定问题与是/否分支（jpick = 本情景走向）
 * 文本占位符 {kv} {prod} {local} {hot} {dst} {tier} 等渲染时填充。
 * 全部数值为教学示意，非实测。
 * ============================================================ */
window.FLOW = (function () {
  'use strict';

  /* ── 机架硬件模型：R1/R3 有共享 MHD，R2/R4 纯 RDMA（前提固定） ── */
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

  /* ── 离线增量决策矩阵（前提已落板，四情景共享） ──
   * 部署是离线一次性决策：全网长期负载证据一次采齐、一次决策、
   * R1+R3 同批上线；不随单个 KV 变化。运行时走哪个池由 04 判定。 */
  var OFFLINE_DEC = {
    note: '离线增量决策（前提已落板）· 全网长期画像 · 示意，非实测',
    racks: [
      { id: 'R1', locality: 70, hot: 82, cong: 71, util: 63, cost: '低', score: 86, pick: '同批部署',
        why: '跨机架访问占大头、本地化收益最大 · 增量成本回收周期最短' },
      { id: 'R3', locality: 42, hot: 76, cong: 86, util: 48, cost: '低', score: 64, pick: '同批部署',
        why: '共享热度高、Spine 拥塞 86% 决策时已可见 · 与 R1 并行上线' },
      { id: 'R2', locality: 18, hot: 35, cong: 33, util: 22, cost: '低', score: 31, pick: '暂不部署',
        why: '长期画像热度 / 局部性低 · 维持存量 RDMA 底座，增量预算集中投放 R1/R3' },
      { id: 'R4', locality: 12, hot: 22, cong: 29, util: 18, cost: '中', score: 26, pick: '暂不部署',
        why: '同上 · 观察负载形态是否收敛后再评估' }
    ] };

  /* ── 四情景：硬件固定，差异全部在运行时由水位判定驱动 ── */
  var SCENARIOS = [
    { id: 'S1', zh: '热点原生命中', en: 'LOCAL-HIT',
      brief: '访问源 R1/R3（自带 CXL）· 历史热点就近命中本地 MHD',
      kv: 'KV-001', prod: 'R1-N1', hot: 82, local: 70, dst: 'R1 / MHD-1', tier: 'CXL MHD（本地增量池）',
      replica: '—', ver: 'V1', delay: '0.9 µs', load: '48%', occ: '63%',
      r1score: 86, r3score: 64, r3cong: 86,
      place: 'mhd', pool: { used: 6, cong: 42, note: '水位正常' },
      jq: '主力访问机架是否自带 CXL 增量池？',
      jyes: '是 · 主力自带增量池 → 本地 MHD 就近命中（本情景）',
      jno: '否 · RDMA-only 机架 → 进入溢流代价评估（S2 / S3 走向）',
      jpick: 'yes',
      verdict: '是 · 主力 R1/R3（自带 CXL）',
      vdWhy: '请求分布 70% 落在 R1/R3 · 热度周期长期稳定 · 主力机架自带增量池 → 本地命中零转发',
      mx: { rica: '0.9 µs', naive: '4.3 µs', gain: '-67%', cap: '12%', xr: '0.3 GB/s',
        basis: '主力机架自带 CXL → 本地放置收益最大；朴素策略强行远端化只会白占容量（示意，非实测）' },
      cands: [
        { id: 'A', t: '本地 CXL', to: 'R1-MHD-1', ok: true, why: '主力机架 · 本地命中' },
        { id: 'C', t: '远端 MHD', to: 'R3', ok: false, why: '跨机架叠加 · 收益衰减' },
        { id: 'D', t: 'RDMA Pool', to: 'POOL', ok: false, why: '水位正常 · 延迟仍高于本地 CXL' }
      ],
      deploy: ['R1', 'R3'],
      decision: OFFLINE_DEC,
      ov: {
        locality: {
          caption: '主力 R1/R3 自带 CXL 增量池 → 判定：本地 MHD 就近命中',
          res: 'S1 走向：增量部署设计瞄准的主收益场景 —— 访问不离开主力机架'
        }
      } },
    { id: 'S2', zh: '轻度溢流 · 回退原生池', en: 'NATIVE-FALLBACK',
      brief: 'R2/R4 溢流 · 原生池余量充足 → 主动无视 CXL，回退底座',
      kv: 'KV-002', prod: 'R2-N1', hot: 66, local: 12, dst: 'RDMA Pool-A（原生池）', tier: '原生 DRAM RDMA 池',
      replica: '—', ver: 'V2', delay: '4.1 µs', load: '35%', occ: '0%',
      r1score: 86, r3score: 64, r3cong: 86,
      place: 'pool', pool: { used: 8, cong: 35, note: '余量充足' },
      jq: '原生 RDMA 池水位是否击穿代价阈值？',
      jyes: '是 · 水位击穿 → 兜底借用远端增量池（S3 走向）',
      jno: '否 · 余量充足 → 回退原生池，主动无视 CXL（本情景）',
      jpick: 'no',
      verdict: '是 · 主力 R2（RDMA-only）· 水位未击穿',
      vdWhy: 'Cost(X)=4.1µs vs Cost(Y)=5.6µs · 原生池水位 57% 拥塞 35% —— 有 CXL 但不值得用',
      mx: { rica: '4.1 µs', naive: '5.6 µs', gain: '-27%', cap: '0%', xr: '0 GB/s',
        basis: '远端 MHD = 跨机架转发 + 远端访存叠加，比原生池更慢 → 调度器主动无视增量硬件（示意，非实测）',
        fn: '* 朴素策略 = 无视原生池水位，一律推远端 CXL · 示意，非实测' },
      cands: [
        { id: 'A', t: '原生 RDMA Pool', to: 'POOL', ok: true, why: '水位 57% · 余量充足 · 4.1 µs' },
        { id: 'C', t: '远端 R1 MHD', to: 'R1-X', ok: false, why: '转发 + 访存叠加 · 5.6 µs 更慢' },
        { id: 'B', t: '复制到 CXL', to: 'R3', ok: false, why: '单源溢流 · 无共享收益' }
      ],
      deploy: ['R1', 'R3'],
      decision: OFFLINE_DEC,
      ov: {
        locality: {
          caption: '主力 R2 无 CXL 硬件 · Cost(Y)=5.6µs > Cost(X)=4.1µs → 判定：回退原生池',
          res: 'S2 走向：增量硬件摆在那里，但系统主动无视它 —— 原生底座足够'
        },
        decide: {
          caption: '离线增量决策已落板（硬件固定）· 本情景 KV 直写原生池',
          why: '部署是离线一次性决策，不随单个 KV 变化；运行时走哪个池由 04 判定的水位与代价决定',
          res: 'T1 执行后硬件就位，但 {kv} 直写 RDMA Pool-A，不碰 CXL'
        },
        access: {
          caption: 'R2 经 RDMA 访问原生池 · 4.1 µs —— 水位未击穿时这就是最优路径',
          res: '增量硬件在场但不参与：不新增跨机架转发，原生池余量吸收溢流'
        },
        migrate: {
          caption: '无迁移 / 无复制：溢流 KV 留在原生池',
          res: '只有原生体系排队延迟击穿阈值，把 KV 搬进远端 MHD 这笔投资才划算'
        },
        evict: { res: '热度回落 → Directory 标记 invalid，原生池容量回收复用' }
      } },
    { id: 'S3', zh: '原生池过载 · 增量兜底', en: 'OVERLOAD-BAILOUT',
      brief: 'R2/R4 溢流 · 原生池耗尽拥塞爆炸 → Cost(Y) 反超，借用增量池',
      kv: 'KV-003', prod: 'R2-N1', hot: 74, local: 12, dst: 'R1 / MHD-1（远端增量池）', tier: 'CXL MHD（过载兜底）',
      replica: '—', ver: 'V3', delay: '4.9 µs', load: '88%', occ: '61%',
      r1score: 86, r3score: 64, r3cong: 86,
      place: 'remote-mhd', pool: { used: 13, cong: 88, note: '过载' },
      jq: '原生 RDMA 池水位是否击穿代价阈值？',
      jyes: '是 · Cost(X)=7.8µs 爆炸 → 借增量池兜底（本情景）',
      jno: '否 · 余量充足 → 回退原生池（S2 走向）',
      jpick: 'yes',
      verdict: '是 · 主力 R2（RDMA-only）· 原生池过载',
      vdWhy: '原生池水位 93% 拥塞 88% · Cost(X)=7.8µs 击穿阈值 → Cost(Y)=4.9µs 反超，兜底激活',
      mx: { rica: '4.9 µs', naive: '7.8 µs', gain: '-37%', cap: '9%', xr: '一次性 16 GB',
        basis: '原生池排队延迟爆炸抬升 Cost(X) → 远端 MHD 叠加开销后依然更优；增量池是过载兜底而非优先选项（示意，非实测）',
        fn: '* 朴素策略 = 无视水位，硬挤过载的原生池 · 示意，非实测' },
      cands: [
        { id: 'C', t: '远端 R1 MHD', to: 'R1-MHD-1', ok: true, why: 'Cost(Y)=4.9µs < Cost(X)=7.8µs' },
        { id: 'A', t: '原生 RDMA Pool', to: 'POOL', ok: false, why: '水位 93% · 排队 7.8 µs 击穿阈值' },
        { id: 'B', t: '复制到 CXL', to: 'R3', ok: false, why: '单次溢流 · 迁移即可，无需副本' }
      ],
      deploy: ['R1', 'R3'],
      decision: OFFLINE_DEC,
      ov: {
        locality: {
          caption: '主力 R2 无 CXL · 原生池水位 93% 拥塞 88% → 判定：兜底借用远端增量池',
          res: 'S3 走向：不是"想蹭 CXL"，是原生体系扛不住 —— 增量池做兜底加速'
        },
        decide: {
          caption: '离线增量决策已落板（硬件固定）· 本情景 KV 兜底写入远端增量池',
          res: 'Cost(X)=7.8µs 击穿阈值 → {kv} 经跨机架 RDMA 写入 R1-MHD-1'
        },
        access: {
          caption: 'R2 经 Leaf-Spine RDMA 跨机架读取 R1-MHD-1 · 4.9 µs',
          why: '跨机架转发 + 远端访存叠加的兜底代价，仍优于挤爆的原生池（7.8 µs）',
          res: '延迟 4.9 µs —— 劣于 S1 本地 0.9 µs，但优于过载原生池；增量池只是兜底'
        },
        migrate: {
          caption: '单次溢流 → 迁移而非复制：{kv} 迁入 R1-MHD-1，原生池压力缓释',
          res: '迁移完成后原生池水位回落；若过载持续，长期托管将演化成 S4 形态'
        },
        evict: { res: '原生池水位回落 → {kv} 迁回 RDMA Pool，增量池容量让位给新的兜底请求' }
      } },
    { id: 'S4', zh: '多机架长期共享热点', en: 'SHARED-HOTSPOT',
      brief: 'R1–R4 持续并发读同一 KV · 长期托管增量池，复制分发',
      kv: 'KV-004', prod: 'R1-N1', hot: 93, local: 55, dst: 'R1-MHD-1 + R3-MHD-3（副本）', tier: 'CXL MHD（长期托管）',
      replica: 'R1-MHD-1 · R3-MHD-3', ver: 'V4', delay: '1.1 µs', load: '62%', occ: '78%',
      r1score: 86, r3score: 64, r3cong: 86,
      place: 'copy', pool: { used: 9, cong: 58, note: '中度' },
      jq: '是否为跨机架长期共享热点？',
      jyes: '是 · 复用周期长 → 一次复制分发，长期托管增量池（本情景）',
      jno: '否 · 单次溢流 → 按原生池水位判定（S2 / S3 走向）',
      jpick: 'yes',
      verdict: '是 · 多机架长期共享热点',
      vdWhy: 'R1/R3 与 R2/R4 持续并发读 · 复用周期长 · 与 S3 单次溢流兜底不同：关心反复访问的平均收益',
      mx: { rica: '1.1 µs', naive: '4.3 µs', gain: '-74%', cap: '18%', xr: '一次性 32 GB',
        basis: '长期共享热点 → 一次复制分发，R1/R3 本地命中吸收大部分读流量；R2/R4 偶发远端读 · 复用收益随时间累积（示意，非实测）' },
      cands: [
        { id: 'A', t: '副本 → R1 CXL', to: 'R1-MHD-1', ok: true, why: 'R1 持续请求 · 副本落地' },
        { id: 'B', t: '副本 → R3 CXL', to: 'R3-MHD-3', ok: true, why: 'R3 持续请求 · 副本落地' },
        { id: 'C', t: '原生 RDMA Pool', to: 'POOL', ok: false, why: '跨机架读风暴 · 持续压 Spine' }
      ],
      deploy: ['R1', 'R3'],
      decision: OFFLINE_DEC,
      ov: {
        locality: {
          caption: 'R1–R4 持续并发请求同一 KV · 复用周期长 → 判定：长期共享热点',
          res: 'S4 走向：不是单次溢流救急（S3），而是长期托管 —— 复制分发到增量池'
        },
        gen: { res: '长期共享：同一段多轮会话前缀被 R1–R4 持续并发请求（示意）' },
        decide: {
          caption: '离线增量决策已落板（硬件固定）· 本情景 KV 复制托管增量池',
          res: '{kv} 原件落入 R1-MHD-1，并复制副本至 R3-MHD-3'
        },
        access: {
          caption: 'R1/R3 本机架命中副本 0.9–1.1 µs · R2/R4 偶发经 RDMA 远端读',
          res: '大部分读被机架内 CXL 吸收，Spine 只承载偶发远端读'
        },
        migrate: {
          caption: '复制优先：共享 KV 在 R1/R3 MHD 各存一份副本，原件保留（多读场景不宜迁移）',
          res: '副本落位：R1-MHD-1 + R3-MHD-3 · Directory 版本 {ver} 记录多副本映射'
        },
        evict: { res: '复用热度回落 → 先回收副本，原件下沉 RDMA Pool' }
      } }
  ];

  /* ── 八阶段 ── */
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
      id: 'decide', n: '03', zh: '存储决策', en: 'PROVISIONING',
      caption: '离线增量决策（前提已落板）：全网证据一次采齐 → R1+R3 同批部署 · 硬件固定',
      act: 'Placement Controller 汇总四机架长期画像（阶段 02 已一次采齐）：局部性、历史热度、拥塞、利用率、成本，加权评分后同时排定 R1 与 R3',
      obj: '离线部署矩阵 · R1 {r1score} / R3 {r3score} · 两机架并行上线 CXL Switch + 共享 MHD',
      why: '部署是离线一次性决策，不随单个 KV 变化；运行时走哪个池，由 04 判定的水位与代价决定',
      res: 'T1 执行：R1 与 R3 同时上线 CXL Switch 与共享 MHD，各接入 N1/N2 —— 硬件前提就此焊死',
      metrics: { 延迟: '—', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'decide' }
    },
    {
      id: 'locality', n: '04', zh: '局部性判定', en: 'LOCALITY JUDGE',
      caption: '运行时核心分叉：主力在哪 · 原生池水位是否击穿阈值？→ 判定：{verdict}',
      act: 'Locality Judge 结合请求分布与原生 RDMA 池水位，回答两个问题：访问主力在哪、Cost(X)（原生池）与 Cost(Y)（远端 MHD）谁更低',
      obj: '{kv} · 请求分布 · 原生池水位 · Cost(X)/Cost(Y) → 判定：{verdict}',
      why: '{vdWhy}',
      res: '所有运行时放置从这一判定点分流：S1 本地命中 / S2 回退原生 / S3 兜底借用 / S4 复制托管',
      metrics: { 延迟: '—', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'locality' }
    },
    {
      id: 'query', n: '05', zh: '位置查询', en: 'DIRECTORY',
      caption: 'Decode 节点发出 {kv} 查询 → KV Directory 返回 {dst}',
      act: '请求节点只持有逻辑 ID，向 KV Directory 发起查询；Directory 检索映射记录并返回物理位置、状态与版本',
      obj: '{kv} · KV Directory · 逻辑地址 / 物理地址分离',
      why: 'KV 会被迁移与复制，逻辑地址必须与物理位置解耦，否则调用方无法跟随数据移动',
      res: '返回 {dst} · Primary · {ver}；请求方据此决定访问路径',
      metrics: { 延迟: '0.2 µs', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'query' }
    },
    {
      id: 'access', n: '06', zh: '数据访问', en: 'DATA ACCESS',
      caption: '增量部署主收益：本地 CXL 命中 0.9 µs，对比 T0 基线 RDMA 4.1 µs',
      act: '本地：同机架节点经 CXL 从 {dst} 读取 KV；对照：未部署 CXL 的机架节点必须走 Leaf-Spine 跨机架 RDMA',
      obj: '{kv} · CXL 链路（T1 新增） · RDMA 链路（存量）',
      why: '主力自带增量池 → 本地访问省掉跨机架往返：0.9 µs vs 基线 4.1 µs',
      res: 'KV Block 回填 GPU HBM；对照机架仍走 4.1 µs RDMA —— 水位驱动判定保证每笔放置都在当下最优池',
      metrics: { 延迟: '{delay}', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'access' }
    },
    {
      id: 'migrate', n: '07', zh: '迁移复制', en: 'MIGRATE / COPY',
      caption: 'T2：硬件已就位，数据开始重分配——热点迁入本地 MHD、共享 KV 生成副本',
      act: 'A. 迁移：{kv} 从旧位置搬向 {dst}；B. 复制：多机架共享的高频 KV 在对端生成副本',
      obj: '{kv}（原件）· 新副本 · Directory 版本 · T1 新上线的 R1/R3 MHD',
      why: '访问主体迁移时迁移更省容量；多机架共享时复制能避免跨机架往返',
      res: 'T2 完成：热点 KV 迁入 MHD、副本落位，MHD 利用率升至 63%，Directory 版本升至 {ver}',
      metrics: { 延迟: '{delay}', 链路: '{load}', 占用: '{occ}' },
      anim: { type: 'migrate' }
    },
    {
      id: 'evict', n: '08', zh: '淘汰回收', en: 'EVICTION',
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
   * 部署是离线一次性决策（前提已落板）：四情景共享同一硬件前提。
   * START_LEVEL[i] = 第 i 个生命周期阶段开始时的部署等级（0-1），
   * T1 在阶段 03 内动画触发；T2 为数据行为，随阶段 07 动画呈现。 */
  var DEP = [
    { id: 'T0', zh: '全 RDMA 基线', brief: '0 / 4 CXL 机架 · 仅存量 RDMA + 远端内存池' },
    { id: 'T1', zh: 'R1+R3 同批部署', brief: '2 / 4 · 离线决策已落板 · 两机架并行上线' },
    { id: 'T2', zh: 'KV 重分配', brief: '热点迁入 MHD · 共享 KV 生成副本 · 利用率 63%' }
  ];
  var START_LEVEL = [0, 0, 0, 1, 1, 1, 1, 1];

  /* ── 图例（全局视觉语义规范：源 KV / 副本 / CXL 通路 / 复制分发流 / RDMA / 否决候选 / 信令） ── */
  var LEGEND = [
    { k: 'kv',   c: '#e6a056', t: 'KV Block（橙）· 金色 = 本轮跟踪 KV' },
    { k: 'rep',  c: '#a38bf2', t: 'KV 副本（紫）' },
    { k: 'copy', c: '#8fc6f2', t: '复制分发流（浅蓝虚线 · 一次性准备）' },
    { k: 'cxl',  c: '#53e3c4', t: '机架内 CXL 访问流（青绿粗实线）' },
    { k: 'rdma', c: '#f0785a', t: 'RDMA 访问流（橙红粗实线）' },
    { k: 'cand', c: '#8ca0af', t: '候选否决链路（灰虚线 + 叉）' },
    { k: 'ctl',  c: '#e4b66b', t: '控制面信令（黄细虚线）' }
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
