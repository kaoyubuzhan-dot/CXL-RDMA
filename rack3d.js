/* ============================================================
 * rack3d.js — 03 机架解剖 · 单机架 4 Server + 1 MHD 三维表征
 *
 * 交互（对齐确认过的原型）：
 *   状态 A  全局架构拓扑：ToR 交换机 + 4 台服务器 + 共享 MHD，
 *           橙线 = RDMA 网络链路（Server→ToR），绿线 = CXL 内存直连（Server→MHD），
 *           连线上有流动光点。
 *   状态 B  点击服务器 / MHD → 相机聚焦、外壳半透明、内部器件悬浮爆炸展开，
 *           每个器件挂绿色作用点（点击弹出器件解析卡）。
 *
 * 数据联动：机架 / 节点 / MHD / 部署状态来自模拟器 STATE（选中机架 R1-R4、
 *           CXL 部署与否决定绿线与 MHD 形态、MHD 实时占用进解析卡）。
 *
 * 移植说明：原型基于 three 0.160 ES Module（CSS2DRenderer / RoomEnvironment），
 *           本文件改写为项目 vendored three.js r128 全局环境：
 *           - RoomEnvironment → 复用 __GLUTILS__ 的 makeEnv（冷色调摄影棚环境贴图）
 *           - CSS2DRenderer   → 手动投影标签层（同 webgl-cluster.js 的 gll-lbl 模式）
 * ============================================================ */
window.__RACK3D__ = (function () {
  'use strict';
  if (!window.THREE || !window.__GLUTILS__) {
    return { available: false, show: function () {}, sync: function () {}, resize: function () {} };
  }
  var U = window.__GLUTILS__(THREE);
  var S = window.__SIM__;
  var STATE = S.STATE;

  /* ───────────── 器件作用点数据库（原型 HOTSPOT_DATA 原样保留 + 模拟器实时行） ───────────── */
  var HOTSPOT_DATA = {
    'hbm': {
      tag: '计算节点 · 算力近存作用点',
      title: 'HBM3e 高带宽显存堆栈',
      role: '作用点：存放当前推理 Token 的超热 KV Cache',
      desc: '与 GPU/XPU 封装在同一硅中介层上，承担最密集的 Attention 矩阵读写，避免高频计算停顿。',
      specs: [['带宽', '4.8 TB/s'], ['延迟', '< 15 ns'], ['KV 状态', 'Hot (瞬时活跃)']]
    },
    'dram': {
      tag: '计算节点 · 本地主存作用点',
      title: 'DDR5 RDIMM 内存阵列',
      role: '作用点：本地一级 KV 溢出缓冲池',
      desc: '当单机 HBM 容量达到上限时，通过 PCIe/NVLink 将次热 KV 换出至本地 DRAM，维持单机上下文窗口。',
      specs: [['带宽', '307 GB/s'], ['延迟', '~ 85 ns'], ['KV 状态', 'Warm (本地缓冲)']]
    },
    'coldplate': {
      tag: '散热子系统 · 液冷模块',
      title: '全覆盖紫铜微水道液冷头 (Copper Cold Plate)',
      role: '作用点：带走 XPU 与 HBM 的千瓦级瞬时热负荷',
      desc: '紧贴高功耗 XPU 与 HBM 封装顶部，内部微米级铲齿结构带走千瓦级瞬时热负荷，通过防漏快拆编织水管连接机柜分水器。',
      specs: [['材质工艺', 'C11000 无氧紫铜'], ['解热能力', '1200W TDP'], ['管路接口', 'UQD 快拆接头']]
    },
    'nic': {
      tag: '计算节点 · 网络互联作用点',
      title: '400G RDMA 智能网卡 (SmartNIC)',
      role: '作用点：跨节点网络传输与冷数据迁移出口',
      desc: '向上连接机架顶部 ToR 交换机，负责不同服务器之间的分布式推理同步，以及向远端存储迁移冷 KV。',
      specs: [['速率', '400 Gbps RoCEv2'], ['延迟', '~ 1.2 μs'], ['接触对象', '顶部 ToR 交换机']]
    },
    'cxl-port': {
      tag: '计算节点 · 池化直连接口',
      title: 'CXL 3.0 Root Port / MCIO 接口',
      role: '作用点：与共享 MHD 建立硬件级内存语义接触',
      desc: '向下通过高速 PCIe/CXL 物理总线直连机架底部的共享 MHD，无需经过网卡序列化即可直接访问共享内存。',
      specs: [['总线', 'PCIe 5.0 / CXL 3.0'], ['延迟', '~ 220 ns'], ['接触对象', '底部共享 MHD']]
    },
    'cxl-switch': {
      tag: '共享 MHD · 核心调度作用点',
      title: 'CXL 3.0 多主机交换芯片 (Switch ASIC)',
      role: '作用点：实现 4 台服务器对共享内存池的并发一致性访问',
      desc: '负责仲裁 4 台计算服务器的内存读写请求，维护硬件级缓存一致性（CXL.mem），消除多机数据拷贝。',
      specs: [['连接主机数', '4× Servers 并发'], ['交换带宽', '256 GB/s'], ['一致性粒度', '64B Cacheline']]
    },
    'e3s-pool': {
      tag: '共享 MHD · 大容量池化介质',
      title: 'E3.S CXL Type-3 内存扩展模组阵',
      role: '作用点：提供 TB 级共享 KV Cache 池化容量',
      desc: '4 台服务器共享的全局 KV 蓄水池，支持按需动态分配容量切片，大幅降低单机配置冗余 DRAM 的硬件成本。',
      specs: [['总池化容量', '8 TB 共享池'], ['利用率提升', '+42% 内存效率'], ['支持特性', '热插拔 / 动态切片']]
    },
    'rdma-only': {
      tag: '机架部署状态',
      title: '未部署 CXL · 纯 RDMA 机架',
      role: '作用点：全部访存经 RDMA 远端内存池',
      desc: '该机架当前无 CXL MHD 增量设备：所有节点只能经 RDMA 网卡 + Leaf-Spine 访问远端原生内存池，无法享受机架内 CXL 低时延。',
      specs: [['CXL 设备', '无'], ['访存路径', 'RNIC → ToR → RDMA Pool'], ['增量部署', '可在 02 总览一键部署']]
    }
  };

  /* ───────────── 模块状态 ───────────── */
  var host = null, renderer = null, scene = null, camera = null, controls = null;
  var labelLayer = null, root = null;
  var nodes = {}, clickableMeshes = [], labelDefs = [], flowParticles = [], topologyLines = null;
  var rackId = null, activeDissectId = null, raf = null;
  var running = false, clock = null;
  var camTargetPos = null, lookTargetPos = null, defaultCamPos = null, defaultTarget = null;
  var detailOpen = null;
  var raycaster = null, pointer = new THREE.Vector2(), downXY = null;

  /* ───────────── 初始化（挂载一次） ───────────── */
  function mount(h) {
    host = h;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050a14);

    camera = new THREE.PerspectiveCamera(40, 1.6, 0.1, 150);
    defaultCamPos = new THREE.Vector3(0, 7.5, 14.5);
    defaultTarget = new THREE.Vector3(0, 1.8, 0);
    camera.position.copy(defaultCamPos);
    camTargetPos = defaultCamPos.clone();
    lookTargetPos = defaultTarget.clone();

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.domElement.style.display = 'block';
    host.appendChild(renderer.domElement);

    /* 金属反射环境：复用项目 makeEnv（冷色调摄影棚模式替代 RoomEnvironment） */
    try { scene.environment = U.makeEnv(renderer, { cool: true }); } catch (e) {}

    /* 标签层（手动投影，替代 CSS2DRenderer） */
    labelLayer = document.createElement('div');
    labelLayer.className = 'rk3-labels';
    host.appendChild(labelLayer);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(defaultTarget);

    /* 三点布光 */
    var key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(8, 14, 10);
    scene.add(key);
    scene.add(new THREE.AmbientLight(0x1e293b, 1.2));
    var rim = new THREE.DirectionalLight(0x38bdf8, 0.9);
    rim.position.set(-8, 6, -6);
    scene.add(rim);

    raycaster = new THREE.Raycaster();
    clock = new THREE.Clock();

    buildDom();
    wireEvents();
  }

  /* ───────────── DOM：工具栏 / 提示条 / 解析卡 ───────────── */
  function buildDom() {
    var bar = document.createElement('div');
    bar.className = 'rk3-toolbar';
    bar.innerHTML =
      '<div class="rk3-modes">' +
        '<button type="button" class="rk3-btn rk3-exit is-on">返回全局拓扑</button>' +
        '<button type="button" class="rk3-btn" data-sw="physical">U 位图解</button>' +
      '</div>' +
      '<div class="rk3-racks">' +
        ['R1', 'R2', 'R3', 'R4'].map(function (r) {
          return '<button type="button" class="rk3-chip" data-rk="' + r + '">' + r + '</button>';
        }).join('') +
      '</div>';
    host.appendChild(bar);

    var hint = document.createElement('div');
    hint.className = 'rk3-hint';
    hint.textContent = '点击服务器 / 共享 MHD 进入悬浮解剖 · 点击绿色作用点查看器件解析（示意，非实测）';
    host.appendChild(hint);

    var card = document.createElement('div');
    card.className = 'rk3-detail';
    card.innerHTML =
      '<div class="rk3-detail-head"><span class="rk3-tag" id="rk3-dtag">硬件作用点</span>' +
      '<button type="button" class="rk3-x" data-close>✕</button></div>' +
      '<div class="rk3-title" id="rk3-dtitle"></div>' +
      '<div class="rk3-role" id="rk3-drole"></div>' +
      '<p class="rk3-desc" id="rk3-ddesc"></p>' +
      '<table class="rk3-table" id="rk3-dspecs"></table>';
    host.appendChild(card);

    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('rk3-exit')) { exitDissect(); }
      else if (b.getAttribute('data-sw') === 'physical') {
        if (window.__APP__ && window.__APP__.switchHWView) window.__APP__.switchHWView('physical');
      }
      else if (b.getAttribute('data-rk')) {
        STATE.selectedRack = b.getAttribute('data-rk');
        sync(STATE.selectedRack);
        if (window.__RENDER_PANELS__) window.__RENDER_PANELS__.renderRight();
      }
    });
    card.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeDetail();
    });
  }

  function rackData() {
    return S.getRack ? S.getRack(rackId) : null;
  }
  function deployed() { return !!(rackId && STATE.deployment[rackId]); }

  /* ───────────── 场景构建（按机架重建） ───────────── */
  function clearScene() {
    if (root && root.parent) scene.remove(root);
    root = new THREE.Group();
    scene.add(root);
    nodes = {}; clickableMeshes = []; labelDefs = []; flowParticles = [];
    activeDissectId = null;
    if (labelLayer) labelLayer.innerHTML = '';
    closeDetail();
    camTargetPos.copy(defaultCamPos);
    lookTargetPos.copy(defaultTarget);
  }

  function build() {
    clearScene();
    var rd = rackData();
    if (!rd) return;
    var deployed_ = deployed();

    /* 半透明机架边界框 */
    var boundary = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(11.5, 6.2, 5.2)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22 }));
    boundary.position.set(0, 2.8, 0);
    root.add(boundary);

    /* 顶部 ToR 交换机 */
    var tor = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.45, 1.4),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.25 }));
    tor.position.set(0, 5.2, -0.8);
    root.add(tor);
    addBadge(tor, 'ToR 400G RDMA 交换机', '4 台服务器网络通信 · 冷 KV 迁移', [0, 0.55, 0], false);

    /* 4 台计算节点（真实节点 ID / 角色） */
    var xs = [-3.6, -1.2, 1.2, 3.6];
    rd.nodes.forEach(function (nd, i) { createComputeNode(nd, xs[i]); });

    /* 底部共享 MHD（部署状态驱动形态） */
    createSharedMHD();

    /* 全局接触拓扑连线 + 流动光点 */
    topologyLines = new THREE.Group();
    root.add(topologyLines);
    rd.nodes.forEach(function (nd, i) {
      var x = xs[i];
      /* 向上：Server → ToR（RDMA 网络链路 · 橙） */
      addConnection([x, 3.3, -0.4], [x * 0.85, 4.3, -0.7], [-2.4 + i * 1.6, 5.0, -0.8], 0xf97316, 0.008);
      /* 向下：Server → 共享 MHD（CXL 内存直连 · 绿，仅已接入节点） */
      if (deployed_ && S.nodeConnected(rackId, nd.id)) {
        addConnection([x, 2.1, 0.2], [x * 0.75, 1.45, 0.2], [-1.8 + i * 1.2, 0.98, 0.2], 0x00ff9d, 0.014);
      }
    });

    syncRackChips();
  }

  function createComputeNode(nd, x) {
    var id = rackId + '-' + nd.id;
    var group = new THREE.Group();
    group.position.set(x, 2.7, 0);
    root.add(group);

    var shellMat = new THREE.MeshStandardMaterial({
      color: 0x17253b, metalness: 0.8, roughness: 0.25, transparent: true, opacity: 0.95 });
    var shell = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.15, 2.1), shellMat);
    shell.userData.nodeId = id;
    clickableMeshes.push(shell);
    group.add(shell);

    var led = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
    led.position.set(0, 0.35, 1.06);
    group.add(led);

    addBadge(group, nd.id + ' · ' + nd.role, '点击解剖内部器件', [0, -0.95, 0], false);

    var parts = [], pins = [];
    var cxlOn = deployed() && S.nodeConnected(rackId, nd.id);

    /* HBM 显存 */
    var hbm = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x0284c7, emissive: 0x0369a1, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.2 }));
    group.add(hbm);
    parts.push({ mesh: hbm, base: [0, 0, 0.2], exp: [0, 1.45, 0.3] });
    pins.push(createPin(hbm, 'HBM3e 显存作用点', 'hbm', [0.4, 0.1, 0]));

    /* DDR5 DRAM */
    var dram = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.22, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x047857, emissiveIntensity: 0.4, metalness: 0.7, roughness: 0.25 }));
    group.add(dram);
    parts.push({ mesh: dram, base: [0, 0, -0.35], exp: [-0.45, 0.95, -0.3] });
    pins.push(createPin(dram, 'DDR5 DRAM 作用点', 'dram', [-0.55, 0.15, 0]));

    /* RDMA 智能网卡 */
    var nic = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.24, 0.55),
      new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xc2410c, emissiveIntensity: 0.4, metalness: 0.8, roughness: 0.25 }));
    group.add(nic);
    parts.push({ mesh: nic, base: [0.35, 0.2, -0.5], exp: [0.55, 1.15, -0.5] });
    pins.push(createPin(nic, 'RDMA 网卡作用点', 'nic', [0.35, 0.15, 0]));

    /* CXL 池化直连接口（仅已接入 CXL 的节点） */
    if (cxlOn) {
      var cxlPort = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.45),
        new THREE.MeshStandardMaterial({ color: 0x00ff9d, emissive: 0x059669, emissiveIntensity: 0.5 }));
      group.add(cxlPort);
      parts.push({ mesh: cxlPort, base: [0, -0.25, 0], exp: [0, 0.45, 0.4] });
      pins.push(createPin(cxlPort, 'CXL 直连接口作用点', 'cxl-port', [0.4, 0, 0.25]));
    }

    /* 紫铜液冷头 + 编织水管（悬浮最高层 · 对应参考图铜制水冷效果） */
    var cooling = new THREE.Group();
    var copperMat = new THREE.MeshStandardMaterial({ color: 0xd97742, metalness: 0.92, roughness: 0.22 });
    var pipeMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.75, metalness: 0.2 });
    [-0.35, 0.35].forEach(function (xo) {
      var plate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.48), copperMat);
      plate.position.set(xo, 0.05, 0);
      cooling.add(plate);
      var curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(xo, 0.09, 0.12),
        new THREE.Vector3(xo + 0.14, 0.16, 0.55),
        new THREE.Vector3(xo + 0.26, 0.05, 0.9)]);
      cooling.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.028, 8, false), pipeMat));
    });
    group.add(cooling);
    parts.push({ mesh: cooling, base: [0, 0.1, 0], exp: [0, 1.0, 0.15] });
    pins.push(createPin(cooling, '紫铜液冷头作用点', 'coldplate', [0.5, 0.1, 0]));

    parts.forEach(function (p) { p.mesh.visible = false; });
    pins.forEach(function (h) { setVisiblePin(h, false); });
    nodes[id] = { group: group, shell: shell, shellMat: shellMat, parts: parts, pins: pins,
                  progress: 0, target: 0, label: nd.id + ' · ' + nd.role };
  }

  function createSharedMHD() {
    var id = rackId + '-MHD';
    var dep = deployed();
    var group = new THREE.Group();
    group.position.set(0, 0.55, 0.2);
    root.add(group);

    var shellMat = new THREE.MeshStandardMaterial({
      color: dep ? 0x0b2e26 : 0x232d38, metalness: 0.85, roughness: 0.2, transparent: true, opacity: 0.92 });
    var shell = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.85, 2.3), shellMat);
    shell.userData.nodeId = id;
    clickableMeshes.push(shell);
    group.add(shell);

    if (dep) {
      var edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(5.65, 0.88, 2.34)),
        new THREE.LineBasicMaterial({ color: 0x00ff9d }));
      group.add(edge);
    }
    addBadge(group,
      dep ? '共享 CXL MHD 内存池' : '无 CXL MHD · RDMA-only',
      dep ? '4 台服务器硬件级共享 · 点击解剖' : '全部访存走 RDMA 远端池',
      [0, -0.75, 0], true);

    var parts = [], pins = [];
    if (dep) {
      /* CXL 3.0 交换芯片 */
      var sw = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.6, metalness: 0.8, roughness: 0.15 }));
      group.add(sw);
      parts.push({ mesh: sw, base: [0, 0, 0], exp: [0, 1.45, 0] });
      pins.push(createPin(sw, 'CXL 3.0 交换芯片作用点', 'cxl-switch', [0.55, 0.1, 0]));

      /* E3.S 池化内存模组阵列 */
      var e3s = new THREE.Group();
      for (var i = 0; i < 8; i++) {
        var mod = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.32, 0.95),
          new THREE.MeshStandardMaterial({ color: 0x00ff9d, emissive: 0x059669, emissiveIntensity: 0.45, metalness: 0.75, roughness: 0.2 }));
        mod.position.set(-1.9 + i * 0.54, 0, 0.2);
        e3s.add(mod);
      }
      group.add(e3s);
      parts.push({ mesh: e3s, base: [0, 0, 0], exp: [0, 0.85, 0] });
      pins.push(createPin(e3s, 'E3.S 共享内存池作用点', 'e3s-pool', [2.15, 0.2, 0.2]));
    }
    parts.forEach(function (p) { p.mesh.visible = false; });
    pins.forEach(function (h) { setVisiblePin(h, false); });
    nodes[id] = { group: group, shell: shell, shellMat: shellMat, parts: parts, pins: pins,
                  progress: 0, target: 0, label: dep ? '共享 MHD' : 'RDMA-only', isMhd: true };
  }

  /* ───────────── 连线 + 流动光点 ───────────── */
  function addConnection(p1, p2, p3, colorHex, speed) {
    var curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(p1[0], p1[1], p1[2]),
      new THREE.Vector3(p2[0], p2[1], p2[2]),
      new THREE.Vector3(p3[0], p3[1], p3[2])]);
    var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.035, 8, false),
      new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.45 }));
    topologyLines.add(tube);
    var dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    topologyLines.add(dot);
    flowParticles.push({ dot: dot, curve: curve, t: Math.random(), speed: speed });
  }

  /* ───────────── 标签与作用点（手动投影） ───────────── */
  function addBadge(parentObj, title, sub, offset, isMhd) {
    var el = document.createElement('div');
    el.className = 'rk3-badge' + (isMhd ? ' rk3-badge--mhd' : '');
    el.innerHTML = '<strong></strong><span></span>';
    el.firstChild.textContent = title;
    el.lastChild.textContent = sub;
    labelLayer.appendChild(el);
    var wp = new THREE.Vector3();
    labelDefs.push({
      el: el,
      pos: function () {
        parentObj.updateWorldMatrix(true, false);
        return wp.set(offset[0], offset[1], offset[2]).applyMatrix4(parentObj.matrixWorld);
      }
    });
  }

  function createPin(parentObj, text, key, offset) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'rk3-pin';
    el.innerHTML = '<i class="rk3-dot"></i><span></span>';
    el.querySelector('span').textContent = text;
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      openDetail(key);
    });
    labelLayer.appendChild(el);
    var wp = new THREE.Vector3();
    var def = {
      el: el, pin: true, key: key,
      pos: function () {
        parentObj.updateWorldMatrix(true, false);
        return wp.set(offset[0], offset[1], offset[2]).applyMatrix4(parentObj.matrixWorld);
      }
    };
    labelDefs.push(def);
    return def;
  }
  function setVisiblePin(def, on) { def._on = !!on; }

  var _v3 = null;
  function updateLabels() {
    if (!_v3) _v3 = new THREE.Vector3();
    var w = host.clientWidth, h = host.clientHeight;
    labelDefs.forEach(function (d) {
      if (d.pin && !d._on) { d.el.style.display = 'none'; return; }
      var p = d.pos();
      _v3.copy(p).project(camera);
      if (_v3.z > 1) { d.el.style.display = 'none'; return; }
      d.el.style.display = 'flex';
      d.el.style.left = ((_v3.x + 1) / 2 * w) + 'px';
      d.el.style.top = ((-_v3.y + 1) / 2 * h) + 'px';
    });
  }

  /* ───────────── 解析卡 ───────────── */
  function openDetail(key) {
    var d = HOTSPOT_DATA[key];
    if (!d) return;
    var specs = d.specs.slice();
    /* 模拟器实时数据行（示意） */
    if (key === 'e3s-pool' || key === 'cxl-switch') {
      var units = S.mhdUnitsForRack(rackId);
      var cap = units.reduce(function (a, m) { return a + m.capacityGB; }, 0);
      var used = units.reduce(function (a, m) { return a + S.computeMhdUsed(m.id); }, 0);
      if (key === 'e3s-pool' && cap) specs.push(['当前占用', used + ' / ' + cap + ' GB（示意）']);
      if (key === 'cxl-switch') {
        var conn = S.getRack(rackId).nodes.filter(function (n) { return S.nodeConnected(rackId, n.id); }).length;
        specs.push(['本机架接入', conn + ' / 4 节点（示意）']);
      }
    }
    document.getElementById('rk3-dtag').textContent = d.tag;
    document.getElementById('rk3-dtitle').textContent = d.title;
    document.getElementById('rk3-drole').textContent = d.role;
    document.getElementById('rk3-ddesc').textContent = d.desc;
    document.getElementById('rk3-dspecs').innerHTML = specs.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>';
    }).join('');
    host.querySelector('.rk3-detail').classList.add('show');
    detailOpen = key;
  }
  function closeDetail() {
    var c = host && host.querySelector('.rk3-detail');
    if (c) c.classList.remove('show');
    detailOpen = null;
  }

  /* ───────────── 状态切换：全局拓扑 ↔ 悬浮解剖 ───────────── */
  function dissectNode(id) {
    var n = nodes[id];
    if (!n) return;
    if (n.isMhd && !deployed()) {
      openDetail('rdma-only');
      return;
    }
    activeDissectId = id;
    Object.keys(nodes).forEach(function (k) {
      var m = nodes[k];
      var cur = k === id;
      m.target = cur ? 1 : 0;
      m.shellMat.opacity = cur ? 0.18 : 0.15;
      m.parts.forEach(function (p) { p.mesh.visible = cur; });
      m.pins.forEach(function (h) { setVisiblePin(h, cur); });
    });
    if (topologyLines) topologyLines.visible = false;
    var f = n.group.position;
    lookTargetPos.set(f.x, f.y + 0.8, f.z);
    camTargetPos.set(f.x + 2.2, f.y + 2.6, f.z + 4.8);
    var ex = host.querySelector('.rk3-exit');
    if (ex) ex.classList.remove('is-on');
    var hint = host.querySelector('.rk3-hint');
    if (hint) hint.textContent = (n.label) + ' 悬浮解剖中 · 点击绿色作用点查看器件解析（示意，非实测）';
  }

  function exitDissect() {
    activeDissectId = null;
    closeDetail();
    Object.keys(nodes).forEach(function (k) {
      var m = nodes[k];
      m.target = 0;
      m.shellMat.opacity = 0.94;
      m.parts.forEach(function (p) { p.mesh.visible = false; });
      m.pins.forEach(function (h) { setVisiblePin(h, false); });
    });
    if (topologyLines) topologyLines.visible = true;
    camTargetPos.copy(defaultCamPos);
    lookTargetPos.copy(defaultTarget);
    var ex = host.querySelector('.rk3-exit');
    if (ex) ex.classList.add('is-on');
    var hint = host.querySelector('.rk3-hint');
    if (hint) hint.textContent = '点击服务器 / 共享 MHD 进入悬浮解剖 · 点击绿色作用点查看器件解析（示意，非实测）';
  }

  function syncRackChips() {
    host.querySelectorAll('.rk3-chip').forEach(function (c) {
      c.classList.toggle('is-on', c.getAttribute('data-rk') === rackId);
    });
  }

  /* ───────────── 拾取（区分点击与拖拽） ───────────── */
  function wireEvents() {
    var dom = renderer.domElement;
    dom.addEventListener('pointerdown', function (e) { downXY = [e.clientX, e.clientY]; });
    dom.addEventListener('pointerup', function (e) {
      if (!downXY) return;
      var dx = e.clientX - downXY[0], dy = e.clientY - downXY[1];
      downXY = null;
      if (Math.hypot(dx, dy) > 6) return;   // 拖拽视角不算点击
      var r = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      var hits = raycaster.intersectObjects(clickableMeshes, false);
      if (hits.length && hits[0].object.userData.nodeId) dissectNode(hits[0].object.userData.nodeId);
    });
  }

  /* ───────────── 渲染循环（仅可见时渲染） ───────────── */
  function tick() {
    raf = running ? requestAnimationFrame(tick) : null;
    if (!running || !host || host.clientWidth < 10) return;
    var t = clock.getElapsedTime();
    camera.position.lerp(camTargetPos, 0.08);
    controls.target.lerp(lookTargetPos, 0.08);
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      n.progress += (n.target - n.progress) * 0.08;
      if (n.progress > 0.01) {
        n.parts.forEach(function (p, idx) {
          var fo = n.target === 1 ? Math.sin(t * 2.5 + idx) * 0.04 : 0;
          p.mesh.position.set(
            p.base[0] + (p.exp[0] - p.base[0]) * n.progress,
            p.base[1] + (p.exp[1] - p.base[1]) * n.progress + fo,
            p.base[2] + (p.exp[2] - p.base[2]) * n.progress);
        });
      }
    });
    if (topologyLines && topologyLines.visible) {
      flowParticles.forEach(function (fp) {
        fp.t = (fp.t + fp.speed) % 1;
        fp.dot.position.copy(fp.curve.getPointAt(fp.t));
      });
    }
    controls.update();
    renderer.render(scene, camera);
    updateLabels();
  }

  /* ───────────── 对外 API ───────────── */
  function resize() {
    if (!host || !renderer) return;
    var w = host.clientWidth, h = host.clientHeight;
    if (w < 10 || h < 10) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }
  function show(on) {
    if (!host) return;
    running = !!on;
    if (on) {
      resize();
      if (!raf) tick();
    } else {
      closeDetail();
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }
  }
  /* 数据同步：机架或部署状态变化 → 重建场景；否则保持当前解剖状态不打断 */
  var lastKey = null;
  function stateKey() {
    var rd = rackData();
    if (!rd) return rackId || '';
    return rackId + '|' + (deployed() ? '1' : '0') + '|' +
      rd.nodes.map(function (n) { return S.nodeConnected(rackId, n.id) ? 1 : 0; }).join('');
  }
  function sync(rid) {
    if (!host) return;
    var needBuild = (!rid || rid !== rackId);
    rackId = rid || 'R1';
    var k = stateKey();
    if (!needBuild && k !== lastKey) needBuild = true;   // 同机架部署 / 端口接入变化
    if (needBuild) { build(); lastKey = stateKey(); }
  }

  return {
    available: true,
    mount: mount,
    show: show,
    sync: sync,
    resize: resize,
    exitDissect: exitDissect,
    dissectNode: dissectNode
  };
})();
