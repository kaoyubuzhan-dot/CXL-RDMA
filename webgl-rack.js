/* ============================================================
 * webgl-rack.js — 真 3D（Three.js）机架解剖场景
 *
 * 建模与展示语言参考 SmartNIC Lab：
 *   · 手绘 canvas → PMREM 环境贴图：零外部资源拿到金属高光
 *   · ACESFilmic 色调映射 + 指数雾 + CSS 氛围层（网格/辉光/暗角/噪点）
 *   · 零件级细节由 webgl-parts.js 提供（主板走线 / 散热鳍片 / DIMM /
 *     端口笼 / 螺丝孔阵列 / LED / 丝印），重复件走 InstancedMesh
 *   · 高亮不再全局改透明度，改用可复用的 24° 描边包围盒 + 四角准星呼吸
 *   · 拆解按 order 交错（stagger），层层剥开而非整体平移
 *   · 标注做投影防重叠与引线；剖切用固定剖切面，避免 shader 反复重编译
 *
 * 数据仍来自 window.__SIM__ 的 STATE（与左侧面板实时联动）
 * ============================================================ */
(function () {
  'use strict';
  if (!window.THREE) { window.__GL3D__ = { available: false, sync: function () {} }; return; }

  const S = window.__SIM__;
  const THREE = window.THREE;

  const C = { cxl: 0x53e3c4, rdma: 0x5f9fe8, cyan: 0x91e4ff, amber: 0xe6a056 };
  const TUNE = {
    W: .62, D: .86, H: 2.02,
    explodeK: .62,   // 拆解位移全局系数，避免撑出视口
    stagger: .22,    // 各层启动时间差
    maxDpr: 2,
    pickPx: 4
  };
  const FIT_PAD = 1.34;  // 取景留边：避免模型被画布边缘与顶部工具条裁切

  if (!window.__GLUTILS__ || !window.__GLPARTS__) { window.__GL3D__ = { available: false, sync: function () {} }; return; }
  const U = window.__GLUTILS__(THREE);
  const P = window.__GLPARTS__(THREE, { U: U, C: C, TUNE: TUNE });

  let host = null, renderer = null, scene = null, camera = null, controls = null;
  let root = null, rackShell = null, cableGroup = null, spineGroup = null, mhdGroupRef = null;
  let raycaster = null, pointer = new THREE.Vector2(), clock = null;
  let running = false, mode = 'shell', step = 1, presetName = 'iso';
  let explode = 0, explodeTarget = 0, sectionK = .55;
  let camTween = null, tooltip = null, reticle = null;
  let lastRid = null, lastSig = '';
  let parts = [], pulses = [], exploders = [], glassPanels = [], treeNodes = [];
  let srvHosts = [], swRef = null, torRef = null, doorMeshes = [], blankPanels = [];
  let selectedId = null, hoveredId = null;
  let hlBox = null, hlBoxHover = null;
  let labelAnchors = [], labelLayer = null, labelEls = [], labelLead = null, labelLines = [];
  let fitR = 1.7, fitCenter = new THREE.Vector3(0, 1.2, 0);
  let envMap = null, glowMats = [], tintList = [];
  let userMoved = false;
  let dpr = 1, fpsAcc = 0, fpsN = 0, degraded = false;

  const M = Math;
  const EMPTY = [];
  const clamp01 = function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); };
  const EASE = { inOutCubic: function (t) { return t < .5 ? 4 * t * t * t : 1 - M.pow(-2 * t + 2, 3) / 2; } };
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ══════════════════════════════════════════════════════════
     场景初始化
     ══════════════════════════════════════════════════════════ */
  function initScene() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    dpr = M.min(TUNE.maxDpr, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.sRGBEncoding != null && 'outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.localClippingEnabled = true;
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060c11, .082);

    camera = new THREE.PerspectiveCamera(30, 1, .05, 60);
    camera.position.set(3.7, 2.7, 4.6);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.15, 0);
    controls.enableDamping = !REDUCED;
    controls.dampingFactor = .06;
    controls.rotateSpeed = .55;
    controls.zoomSpeed = .8;
    controls.minDistance = .28;
    controls.maxDistance = 22;
    controls.maxPolarAngle = M.PI * .93;
    controls.update();
    controls.addEventListener('start', function () { userMoved = true; });

    /* 环境反射：升级后的专业数据中心条形光源 HDR 环境贴图 */
    envMap = U.makeEnv(renderer);
    scene.environment = envMap;
    if ('environmentIntensity' in scene) scene.environmentIntensity = .82;

    scene.add(new THREE.HemisphereLight(0x355468, 0x05090e, .78));
    const key = new THREE.DirectionalLight(0xdcf0ff, 2.6);
    key.position.set(3.6, 5.8, 3.8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = .5; key.shadow.camera.far = 16;
    key.shadow.camera.left = -3.2; key.shadow.camera.right = 3.2;
    key.shadow.camera.top = 4.4; key.shadow.camera.bottom = -1;
    key.shadow.bias = -.0015;
    scene.add(key);
    const keyBack = new THREE.DirectionalLight(0x8ebcd8, 1.2);
    keyBack.position.set(-3.8, 4.2, -3.2);
    scene.add(keyBack);

    const warm = new THREE.DirectionalLight(C.amber, .45);
    warm.position.set(-4.2, 2.6, -3.6); scene.add(warm);
    const rimA = new THREE.PointLight(C.cxl, 1.3, 6, 2); rimA.position.set(-1.5, 1.5, 1.4); scene.add(rimA);
    const rimB = new THREE.PointLight(C.rdma, .9, 6, 2); rimB.position.set(1.8, 2.3, -1.2); scene.add(rimB);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 64),
      new THREE.MeshStandardMaterial({
        color: 0x050b0f,
        metalness: .45,
        roughness: .52,
        transparent: true,
        opacity: .96,
        envMapIntensity: 1.1
      })
    );
    floor.rotation.x = -M.PI / 2; floor.position.y = -.002; floor.receiveShadow = true;
    scene.add(floor);

    const sheen = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: U.floorTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .5 })
    );
    sheen.rotation.x = -M.PI / 2; sheen.position.y = .001; scene.add(sheen);

    const grid = new THREE.GridHelper(6, 24, 0x1d4150, 0x0c1c25);
    grid.position.y = .002; grid.material.transparent = true; grid.material.opacity = .32;
    scene.add(grid);

    /* 高亮：一枚可复用的 24° 描边单位盒（不引入 OutlinePass） */
    const unitEdge = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1), 24);
    hlBox = new THREE.LineSegments(unitEdge, new THREE.LineBasicMaterial({
      color: C.cyan, transparent: true, opacity: .9, depthTest: false, depthWrite: false
    }));
    hlBox.visible = false; hlBox.renderOrder = 999; scene.add(hlBox);
    hlBoxHover = new THREE.LineSegments(unitEdge, new THREE.LineBasicMaterial({
      color: C.cxl, transparent: true, opacity: .38, depthTest: false, depthWrite: false
    }));
    hlBoxHover.visible = false; hlBoxHover.renderOrder = 998; scene.add(hlBoxHover);

    raycaster = new THREE.Raycaster();
    clock = new THREE.Clock();

    buildTooltip();
    buildReticle();
    addNoise();
    wireEvents();
    resize();
  }

  /* ══════════════════════════════════════════════════════════
     覆盖层：气泡 / 准星 / 噪点 / 标注引线
     ══════════════════════════════════════════════════════════ */
  function buildTooltip() {
    tooltip = document.createElement('div');
    tooltip.className = 'gl3d-tip';
    host.appendChild(tooltip);
  }
  function buildReticle() {
    reticle = document.createElement('div');
    reticle.className = 'gl3d-reticle';
    reticle.innerHTML = '<i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>';
    host.appendChild(reticle);
  }
  function addNoise() {
    const n = document.createElement('div');
    n.className = 'gl3d-noise';
    host.appendChild(n);
  }
  function ensureLabelLayer() {
    if (labelLayer) return;
    labelLayer = document.createElement('div');
    labelLayer.className = 'gl3d-labels';
    host.appendChild(labelLayer);
    labelLead = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    labelLead.setAttribute('class', 'gl3d-leads');
    host.appendChild(labelLead);
  }
  function buildLabels() {
    ensureLabelLayer();
    labelLayer.innerHTML = '';
    labelEls = labelAnchors.map(function (a, i) {
      const el = document.createElement('div');
      el.className = 'gl3d-lbl2';
      el.innerHTML = '<b>0' + pad2(i + 1) + '</b>' + esc(a.text);
      labelLayer.appendChild(el);
      return el;
    });
    labelLead.innerHTML = labelAnchors.map(function () { return '<line x1="0" y1="0" x2="0" y2="0"/>'; }).join('');
    labelLines = Array.prototype.slice.call(labelLead.querySelectorAll('line'));
  }

  const _v3 = new THREE.Vector3();
  function updateLabels() {
    if (!labelEls.length || !labelLayer) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;

    const rows = [];
    labelAnchors.forEach(function (a, i) {
      _v3.copy(a.p).project(camera);
      rows.push({
        el: labelEls[i], ln: labelLines[i],
        x: (_v3.x + 1) / 2 * w, y: (-_v3.y + 1) / 2 * h,
        vis: _v3.z < 1 && _v3.z > -1,
        on: step > 0 && stepFocus(a.kind)
      });
    });
    /* 右侧标签列：按投影 y 排序后逐个下推，防止叠字 */
    const vis = rows.filter(function (r) { return r.vis; }).sort(function (a, b) { return a.y - b.y; });
    let lastY = -1e4;
    vis.forEach(function (r) { r.ly = M.max(r.y, lastY + 19); lastY = r.ly; });

    rows.forEach(function (r) {
      const el = r.el, ln = r.ln;
      if (!el || !ln) return;
      el.classList.toggle('on', r.on);
      if (!r.vis) { el.style.opacity = '0'; ln.style.opacity = '0'; return; }
      el.style.opacity = r.on ? '1' : '.42';
      el.style.top = (r.ly / h * 100).toFixed(2) + '%';
      const box = el.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      ln.style.opacity = r.on ? '.6' : '.18';
      ln.setAttribute('x1', r.x.toFixed(1)); ln.setAttribute('y1', r.y.toFixed(1));
      ln.setAttribute('x2', (box.left - hostBox.left - 6).toFixed(1));
      ln.setAttribute('y2', (box.top - hostBox.top + box.height / 2).toFixed(1));
    });
  }

  function stepFocus(kind) {
    const cfg = STEPS[step - 1] || STEPS[0];
    return cfg.focus.indexOf(kind) >= 0;
  }

  /* ══════════════════════════════════════════════════════════
     装配
     ══════════════════════════════════════════════════════════ */
  function clearGroup(g) {
    if (!g) return;
    g.traverse(function (o) {
      const geo = o.geometry;
      if (geo && !(geo.userData && geo.userData.keep)) geo.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(function (mm) { mm.dispose(); });
        else o.material.dispose();
      }
    });
    scene.remove(g);
  }

  /** 带档案的 Mesh / InstancedMesh 参与拾取；装饰性实例件不入列表，保证跟手 */
  function addPick(list) {
    (list || []).forEach(function (mm) {
      if (mm && mm.isMesh && mm.userData && mm.userData.meta) parts.push(mm);
    });
  }

  function build(rid) {
    if (root) clearGroup(root);
    parts = []; pulses = []; exploders = []; glassPanels = [];
    srvHosts = []; doorMeshes = []; blankPanels = []; treeNodes = [];
    glowMats = []; tintList = [];
    root = new THREE.Group();
    scene.add(root);

    const st = S.STATE;
    const units = (st.rackUnits && st.rackUnits[rid]) || [];
    const cfg = st.mhdConfig || {};
    const nodeCfg = (st.nodeConfig && st.nodeConfig[rid]) || {};
    const r = S.getRack(rid);
    const deployed = !!(st.deployment && st.deployment[rid]);
    const W = TUNE.W, D = TUNE.D, Hh = TUNE.H;

    /* ---------- 机柜骨架 ---------- */
    const rk = P.rack({
      W: W, D: D, H: Hh, name: (r && r.name) || rid,
      occupied: [
        [P.uY(7), P.uY(22) + P.UH],        // U7–U22：4 台 4U GPU 主机
        [P.uY(23), P.uY(24) + P.UH],       // U23–U24：2U CXL Switch（紧邻主机）
        [P.uY(26), P.uY(28) + P.UH],       // U26–U28：3U 共享 MHD 池
        [P.uY(32), P.uY(32) + P.UH],       // U32：1U RDMA ToR（置顶）
        [.134, .186]                        // 底部铭牌
      ]
    });
    rackShell = rk.group;
    root.add(rackShell);
    glassPanels = rk.glass;
    rackShell.traverse(function (o) {
      if (o.userData.door) doorMeshes.push(o);
      if (o.userData.blank) blankPanels.push(o);
    });

    /* ---------- GPU 服务器 ×4（4U，U7 起逐台叠放） ---------- */
    const SRV_U0 = 7;
    const srvY = [0, 1, 2, 3].map(function (i) { return P.uY(SRV_U0 + 4 * i) + 2 * P.UH; });
    const torY = P.uY(32) + P.UH / 2;
    const swY = P.uY(23) + P.UH;
    const mhdY = P.uY(26) + 1.5 * P.UH;
    const nodes = (r && r.nodes) || [];
    nodes.forEach(function (n, i) {
      const cxlOn = !!nodeCfg[n.id];
      const sv = P.server({
        cxlOn: cxlOn, nid: n.id, idx: i,
        meta: {
          name: n.id + ' · ' + (n.role === 'Prefill' ? 'Prefill 写 KV' : 'Decode 读 KV'),
          detail: cxlOn ? 'CXL 接入（C 口）· RDMA 备用' : '仅 RDMA', kind: 'server', id: n.id
        },
        gpuMeta: { name: n.id + ' · GPU 模组 ×4', detail: 'H100 · 80 GB HBM · 生成 KV', kind: 'gpu' }
      });
      sv.group.position.set(0, srvY[i], 0);
      sv.group.userData.baseY = srvY[i];
      sv.group.userData.nid = n.id;
      sv.group.userData.role = n.role;
      sv.group.userData.cxlOn = cxlOn;
      sv.group.userData.gpus = sv.gpus;
      sv.group.userData.rnic = sv.rnic;
      sv.group.userData.shell = sv.shellMesh;
      root.add(sv.group);
      srvHosts.push(sv.group);
      addPick(sv.parts);
      sv.exploders.forEach(function (e) { e.home = e.obj.position.clone(); exploders.push(e); });
    });

    /* ---------- CXL Switch ---------- */
    const swP = P.cxlSwitch({
      hostUsed: hostUsedCount(rid, st),
      meta: { name: 'CXL Switch', detail: 'Host 端口汇聚 → MDP M1 → MHD', kind: 'switch' }
    });
    swP.group.position.set(0, swY, 0);
    swP.group.rotation.y = M.PI;   // 端口朝后（真实布线侧）
    swP.group.userData.basePos = swP.group.position.clone();
    swP.group.userData.kind = 'switch';
    root.add(swP.group);
    swRef = swP.group;
    addPick(swP.parts);
    swP.exploders.forEach(function (e) { e.home = e.obj.position.clone(); exploders.push(e); });
    exploders.push({ obj: swP.group, home: swP.group.position.clone(), dir: [-.34, .12, -.06], dist: .34, order: .34 });

    /* ---------- 共享 MHD 池 ---------- */
    const mh = P.mhdPool({
      units: units,
      capOf: function (k) { return ((cfg[units[k]] || {}).capacityGB || 512) + ' GB'; },
      meta: {
        name: 'SHARED MHD',
        detail: units.length
          ? units.length + ' 台 · ' + units.reduce(function (a, id) { return a + ((cfg[id] || {}).capacityGB || 0); }, 0) + ' GB'
          : '未部署',
        kind: 'mhd'
      }
    });
    mh.group.position.set(0, mhdY, 0);
    mh.group.userData.basePos = mh.group.position.clone();
    mh.group.userData.kind = 'mhd';
    root.add(mh.group);
    mhdGroupRef = mh.group;
    addPick(mh.parts);
    mh.modules.forEach(function (mod, k) {
      exploders.push({ obj: mod, home: mod.position.clone(), dir: [0, .3, 1], dist: .1 + k * .022, order: .56 + k * .04 });
      if (mod.userData.pulse && mod.userData.pulse.material) glowMats.push(mod.userData.pulse.material);
    });
    exploders.push({ obj: mh.group, home: mh.group.position.clone(), dir: [.32, .14, -.18], dist: .38, order: .3 });

    /* ---------- RDMA ToR ---------- */
    const torP = P.switchBox({
      h: P.UH, d: .42, ports: 16, edge: C.rdma, label: 'RDMA ToR 400G', labelColor: '#9ec7dd',
      portsName: 'QSFP-DD 端口 ×16', portsDetail: '400G · 上行 Spine / 跨机架 KV',
      meta: { name: 'RDMA ToR', detail: '400G · 上行 Spine / 跨机架 KV', kind: 'tor' }
    });
    torP.group.position.set(0, torY, 0);
    torP.group.rotation.y = M.PI;   // 端口朝后
    torP.group.userData.basePos = torP.group.position.clone();
    torP.group.userData.kind = 'tor';
    root.add(torP.group);
    torRef = torP.group;
    addPick(torP.parts);
    exploders.push({ obj: torP.group, home: torP.group.position.clone(), dir: [0, 1, 0], dist: .22, order: .26 });

    /* ---------- 线缆 + 扎带（后部理线，真实布线侧） ---------- */
    cableGroup = new THREE.Group();
    root.add(cableGroup);
    const PORT_C = -.13, PORT_R = -.075, PORT_Z = -(P.SRV_D / 2) - .008;
    srvHosts.forEach(function (g, i) {
      const y = g.userData.baseY;
      /* 交换机端口世界坐标（机箱转了 180°，local x 取反） */
      const cxlX = .175 - i * .05;
      const torX = .1875 - i * .025;
      if (g.userData.cxlOn && deployed) {
        const cc = P.cable([
          [PORT_C, y, PORT_Z], [-.19, y, -.40], [-.27, y + (swY - y) * .3, -.43],
          [-.30, y + (swY - y) * .68, -.41], [-.16, swY + .03, -.31],
          [cxlX * .5, swY + .006, -.25], [cxlX, swY + .004, -.212]
        ], C.cxl, .0042, { group: 'cxl', opacity: .68 });
        cableGroup.add(cc);
        cableGroup.add(P.straps(cc.userData.cable.curve, 2));
      }
      const cr = P.cable([
        [PORT_R, y, PORT_Z], [-.01, y, -.40], [.18, y + .06, -.43],
        [.31, y + (torY - y) * .55, -.42], [.28, torY - .05, -.33],
        [torX * .7, torY - .01, -.26], [torX, torY + .002, -.212]
      ], C.rdma, .0036, { group: 'rdma', opacity: .42 });
      cableGroup.add(cr);
    });
    if (units.length && deployed) {
      const cm = P.cable([
        [-.1, swY + .004, -.214], [-.16, swY + .04, -.28], [-.14, (swY + mhdY) / 2, -.31],
        [-.06, mhdY - .03, -.28], [-.02, mhdY, -.246]
      ], C.cxl, .005, { group: 'cxl', opacity: .7 });
      cableGroup.add(cm);
      cableGroup.add(P.straps(cm.userData.cable.curve, 1));
    }
    cableGroup.add(P.cable([
      [0, torY + .012, -.214], [.08, torY + .08, -.36], [.2, 2.02, -.46],
      [.2, 2.2, -.3], [.1, 2.3, -.06]
    ], C.rdma, .0038, { group: 'rdma', opacity: .44 }));

    /* ---------- Spine Fabric ---------- */
    spineGroup = new THREE.Group();
    spineGroup.position.set(0, 2.34, -.02);
    spineGroup.userData.basePos = spineGroup.position.clone();
    spineGroup.userData.kind = 'spine';
    root.add(spineGroup);
    const sp = P.switchBox({
      h: P.UH, d: .42, ports: 24, edge: 0x8fd8ff, label: 'SPINE / LEAF · 400G', labelColor: '#9fd8f0',
      portsName: 'Spine 上行端口 ×24', portsDetail: '存量 400G 集群 Fabric',
      meta: { name: 'Spine / Leaf · RDMA Fabric', detail: '存量 400G 集群交换机', kind: 'spine' }
    });
    spineGroup.add(sp.group);
    addPick(sp.parts);
    exploders.push({ obj: spineGroup, home: spineGroup.position.clone(), dir: [0, 1, 0], dist: .6, order: .18 });

    /* ---------- 机架丝印牌 ---------- */
    const tag = U.decal(((r && r.name) || rid) + '  ·  CXL + RDMA', .3, .05, '#7ff0d3', 34);
    tag.position.set(0, .16, D / 2 + .02);
    root.add(tag);

    /* ---------- 剖切绑定：所有材质共享同一剖切数组 ---------- */
    U.bindClip(root);

    /* ---------- 数据流光点 ---------- */
    cableGroup.children.forEach(function (mm) {
      if (!mm.userData.cable) return;
      for (let k = 0; k < 2; k++) {
        const s = glowSprite(mm.userData.cable.color, .03);
        s.userData = { curve: mm.userData.cable.curve, t: M.random(), speed: .2, group: mm.userData.cable.group };
        root.add(s);
        pulses.push(s);
      }
    });

    collectGlow();
    buildTree();
    computeFit();
    /* 镜头特写目标：对准真实安装高度 */
    LAY.gpu = srvY[1] || srvY[0] || .7;
    LAY.switch = swY;
    LAY.mhd = mhdY;
    LAY.tor = torY;
    applyMode();
    applyExplode(explode);
    lastRid = rid;

    labelAnchors = [
      { text: 'GPU 主机 ×4 · 4U', kind: 'server', p: new THREE.Vector3(0, srvY[0], D / 2 + .03) },
      { text: 'CXL Switch', kind: 'switch', p: new THREE.Vector3(0, swY, D / 2 + .03) },
      {
        text: units.length
          ? ('MHD · ' + units.reduce(function (a, id) { return a + ((cfg[id] || {}).capacityGB || 0); }, 0) + ' GB')
          : 'MHD · 未部署',
        kind: 'mhd', p: new THREE.Vector3(0, mhdY, D / 2 + .03)
      },
      { text: 'RDMA ToR', kind: 'tor', p: new THREE.Vector3(0, torY, D / 2 + .03) },
      { text: 'Spine 400G', kind: 'spine', p: new THREE.Vector3(.3, 2.34, 0) }
    ];
    buildLabels();
    applyStep(step || 1, true);
  }

  function hostUsedCount(rid, st) {
    const sw = st.switchCfg && st.switchCfg[rid];
    if (sw && sw.hostPorts != null) return sw.hostPorts;
    const nodeCfg = (st.nodeConfig && st.nodeConfig[rid]) || {};
    return Object.keys(nodeCfg).filter(function (k) { return nodeCfg[k]; }).length;
  }

  /* 收集需要呼吸发光的材质，避免每帧遍历整棵树 */
  function collectGlow() {
    root.traverse(function (o) {
      const mm = o.material;
      if (!mm || !mm.emissive || o.isSprite) return;
      if (mm.emissiveIntensity > .8 && glowMats.indexOf(mm) < 0) glowMats.push(mm);
    });
  }

  function glowSprite(color, size) {
    const mat = new THREE.SpriteMaterial({
      map: GLOW, color: color, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: .8
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(size, size, 1);
    return s;
  }
  function glowTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const x = cv.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(.28, 'rgba(255,255,255,.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(64, 64, 64, 0, M.PI * 2); x.fill();
    const t = new THREE.Texture(cv); t.needsUpdate = true; return t;
  }
  const GLOW = glowTexture();

  /* ══════════════════════════════════════════════════════════
     显示模式与剖切
     ══════════════════════════════════════════════════════════ */
  function shellOpacity() {
    if (mode === 'shell') return .1;
    if (mode === 'cut') return .3;
    if (mode === 'explode') return .06;
    return .9;
  }

  function setSection(k) {
    sectionK = clamp01(k);
    U.planes[0].constant = -.32 + sectionK * .64;
  }

  /* 未选部件 = 整体剖；选了部件 = 只剖该部件（局部剖切） */
  function applyClipScope() {
    if (!root) return;
    const cutting = (mode === 'cut' || mode === 'explode');
    if (!cutting) U.clipOff();
    const node = selectedId ? partById(selectedId) : null;
    root.traverse(function (o) {
      if (!o.material || o.isSprite) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach(function (mm) {
        let want;
        if (!cutting) want = null;
        else if (!node) want = U.clipArr;
        else want = isDescendant(node.obj, o) ? U.clipArr : null;
        setPlanes(mm, want);
      });
    });
  }
  function setPlanes(mat, arr) {
    const cur = mat.clippingPlanes;
    if (cur === arr) return;
    if (!arr && Array.isArray(cur) && cur.length === 0) return;
    mat.clippingPlanes = arr || EMPTY;
    mat.needsUpdate = true;
  }

  function applyMode() {
    if (!root) return;
    if (mode === 'cut') setSection(sectionK || .55); else U.clipOff();

    const op = shellOpacity();
    glassPanels.forEach(function (p) {
      if (!p.material) return;
      p.material.opacity = op;
      p.material.transparent = op < .95;
      p.material.depthWrite = op > .5;
    });
    doorMeshes.forEach(function (dm) { dm.visible = (mode === 'solid'); });
    blankPanels.forEach(function (o) { o.visible = explode < .2; });

    const rdmaOn = mode !== 'cxl';
    if (cableGroup) cableGroup.children.forEach(function (mm) {
      if (mm.userData.cable && mm.userData.cable.group === 'rdma') mm.visible = rdmaOn;
    });
    if (spineGroup) spineGroup.visible = rdmaOn;

    applyClipScope();
    refreshTint();
    refreshPulses();
  }

  /* ══════════════════════════════════════════════════════════
     分级拆解：各层按 order 交错启动
     ══════════════════════════════════════════════════════════ */
  function applyExplode(k) {
    if (!root) return;
    const tt = clamp01(k);

    exploders.forEach(function (e) {
      if (!e.obj || !e.home || !e.dir || !e.dist) return;
      const lo = (e.order || 0) * TUNE.stagger;
      const local = clamp01((tt - lo) / M.max(.1, 1 - TUNE.stagger));
      const amt = EASE.inOutCubic(local) * e.dist * TUNE.explodeK;
      e.obj.position.set(
        e.home.x + e.dir[0] * amt,
        e.home.y + e.dir[1] * amt,
        e.home.z + e.dir[2] * amt
      );
    });

    const e1 = EASE.inOutCubic(clamp01(tt / .4));
    glassPanels.forEach(function (p) {
      p.position.copy(p.userData.home).addScaledVector(p.userData.dir, e1 * .46);
    });

    if (cableGroup) cableGroup.visible = tt < .3;
    blankPanels.forEach(function (o) { o.visible = tt < .2; });

    srvHosts.forEach(function (g, i) {
      const spread = clamp01(tt / .35);
      g.position.set(0, g.userData.baseY + i * .012 * clamp01(tt / .3), (i - 1.5) * .3 * spread);
      const mm = g.userData.shell && g.userData.shell.material;
      if (mm) {
        const b = baseOf(mm);
        const eS = clamp01((tt - .12) / .5);
        mm.transparent = eS > .04 || b.opacity < 1;
        mm.opacity = b.opacity * (1 - .82 * eS);
      }
    });

    refreshTint();
    refreshPulses();
  }

  /* ══════════════════════════════════════════════════════════
     装配树
     ══════════════════════════════════════════════════════════ */
  function buildTree() {
    treeNodes = [];
    srvHosts.forEach(function (g, i) {
      const nid = g.userData.nid || ('N' + (i + 1));
      treeNodes.push({
        id: 'srv' + i, name: 'GPU 服务器 ' + nid,
        sub: (g.userData.role || '') + ' · ' + (g.userData.cxlOn ? 'CXL 接入' : '仅 RDMA'),
        cat: 'compute', level: (nid === 'N1' || nid === 'N2') ? 'A' : 'B', obj: g
      });
      if (g.userData.gpus && g.userData.gpus.length) {
        treeNodes.push({ id: 'srv' + i + 'gpu', name: nid + ' · GPU 模组 ×4', sub: 'H100 · 80 GB · 生成 KV', cat: 'compute', level: 'A', obj: g.userData.gpus[0] });
      }
      if (g.userData.rnic) {
        treeNodes.push({ id: 'srv' + i + 'rnic', name: nid + ' · CXL / RDMA 网卡', sub: '1×CXL + 1×200G RDMA', cat: 'compute', level: 'A', obj: g.userData.rnic });
      }
    });
    if (swRef) treeNodes.push({ id: 'switch', name: 'CXL Switch', sub: 'Host 口 → MDP M1', cat: 'cxl', level: 'A', obj: swRef });
    if (mhdGroupRef) treeNodes.push({ id: 'mhd', name: '共享 MHD 池', sub: '机架内 CXL 共享池', cat: 'cxl', level: 'A', obj: mhdGroupRef });
    if (mhdGroupRef) {
      let k = 0;
      mhdGroupRef.children.forEach(function (ch) {
        if (ch.userData && ch.userData.homeX != null && k < 3) {
          treeNodes.push({ id: 'mhd' + k, name: 'MHD 抽屉 ' + (k + 1), sub: '热插 · CXL 内存设备', cat: 'cxl', level: 'A', obj: ch });
          k++;
        }
      });
    }
    if (torRef) treeNodes.push({ id: 'tor', name: 'RDMA ToR', sub: '400G · 跨机架', cat: 'net', level: 'A', obj: torRef });
    if (spineGroup) treeNodes.push({ id: 'spine', name: 'Spine / Leaf', sub: '存量 400G 集群', cat: 'net', level: 'B', obj: spineGroup });
    if (rackShell) treeNodes.push({ id: 'shell', name: '机柜框架 / 侧板', sub: '2.02 m · 42U', cat: 'frame', level: 'A', obj: rackShell });
  }

  /* ══════════════════════════════════════════════════════════
     镜头
     ══════════════════════════════════════════════════════════ */
  const PRESETS = {
    iso: { dir: [1.35, .58, 1.72], zoom: .95, tgt: null },
    front: { dir: [0, .10, 1], zoom: .74, tgt: null },
    side: { dir: [1, .10, .02], zoom: .74, tgt: null },
    top: { dir: [.02, 1, .30], zoom: .84, tgt: null },
    gpu: { dir: [.78, .42, 1.15], zoom: .34, key: 'gpu' },
    switch: { dir: [.92, .40, .95], zoom: .30, key: 'switch' },
    mhd: { dir: [.88, .44, .92], zoom: .30, key: 'mhd' },
    tor: { dir: [.88, .44, .92], zoom: .30, key: 'tor' }
  };
  /* 每次装配后写入，镜头预设据此对准真实安装高度 */
  const LAY = { gpu: .7, switch: 1.08, mhd: 1.24, tor: 1.46 };

  function fitDistance() {
    const hv = camera.fov * M.PI / 360;
    const hh = M.atan(M.tan(hv) * (camera.aspect || 1));
    return fitR * FIT_PAD / M.sin(M.min(hv, hh));
  }
  function computeFit() {
    if (!root) return;
    const bb = new THREE.Box3().setFromObject(root);
    if (bb.isEmpty()) return;
    const sph = bb.getBoundingSphere(new THREE.Sphere());
    fitR = M.max(.9, sph.radius);
    fitCenter.copy(sph.center);
    fitCenter.x = 0;              // 后部走线会把包围球中心带偏，取景锁定机柜中轴
    fitCenter.z = 0;
    fitCenter.y = 1.12;
  }
  function presetCamera(name, instant) {
    const p = PRESETS[name] || PRESETS.iso;
    const tgt = p.key ? new THREE.Vector3(0, LAY[p.key] || 1, .04)
      : (p.tgt ? new THREE.Vector3(p.tgt[0], p.tgt[1], p.tgt[2]) : fitCenter.clone());
    const dir = new THREE.Vector3(p.dir[0], p.dir[1], p.dir[2]).normalize();
    const pos = tgt.clone().addScaledVector(dir, fitDistance() * p.zoom);
    if (instant || REDUCED) {
      camera.position.copy(pos); controls.target.copy(tgt); controls.update(); camTween = null;
    } else {
      camTween = { t: 0, dur: 1.05, p0: camera.position.clone(), p1: pos, t0: controls.target.clone(), t1: tgt };
    }
  }
  function flyTo(name) { presetName = name || 'iso'; userMoved = false; presetCamera(presetName, false); }

  /* ══════════════════════════════════════════════════════════
     步骤 / 着色
     ══════════════════════════════════════════════════════════ */
  const STEPS = [
    { id: 1, name: '请求到达', focus: ['server', 'tor'], path: 'rdma', dir: -1 },
    { id: 2, name: 'Prefill 计算', focus: ['server', 'gpu'], path: 'none', dir: 1 },
    { id: 3, name: 'KV 下沉 CXL', focus: ['server', 'switch', 'mhd'], path: 'cxl', dir: 1 },
    { id: 4, name: 'Decode 读回', focus: ['mhd', 'switch', 'server'], path: 'cxl', dir: -1 }
  ];

  function applyStep(nStep, quiet) {
    step = nStep || 1;
    if (!root) return;
    refreshTint();
    refreshPulses();
    updateLabels();
    if (quiet) return;
    if (step === 1) flyTo('iso');
    else if (step === 2) flyTo('gpu');
    else if (step === 3) flyTo('switch');
    else flyTo('mhd');
  }

  function kindOf(o) {
    if (o.userData && o.userData.meta && o.userData.meta.kind) return o.userData.meta.kind;
    let p = o;
    while (p) {
      if (p.userData && p.userData.kind) return p.userData.kind;
      if (p.userData && p.userData.nid) return 'server';
      p = p.parent;
    }
    return '';
  }

  function baseOf(mm) {
    if (!mm.userData) mm.userData = {};
    if (!mm.userData.__base) {
      mm.userData.__base = {
        color: mm.color ? mm.color.clone() : null,
        emissiveIntensity: mm.emissiveIntensity != null ? mm.emissiveIntensity : 0,
        opacity: mm.opacity != null ? mm.opacity : 1,
        envMapIntensity: mm.envMapIntensity != null ? mm.envMapIntensity : 1
      };
    }
    return mm.userData.__base;
  }

  /* 只在状态变化时重算着色，不在渲染循环里遍历场景 */
  function refreshTint() {
    if (!root) return;
    if (!tintList.length) {
      root.traverse(function (o) {
        const mm = o.material;
        if (!mm || mm.isSprite || Array.isArray(mm) || o.userData.isEdge) return;
        tintList.push({ mat: mm, obj: o, kind: kindOf(o) });
      });
    }
    const selNode = selectedId ? partById(selectedId) : null;
    tintList.forEach(function (e) {
      const mm = e.mat, b = baseOf(mm);
      let hot = stepFocus(e.kind);
      if (selNode && isDescendant(selNode.obj, e.obj)) hot = true;
      if (mm.color && b.color) {
        mm.color.copy(b.color);
        if (!hot) mm.color.multiplyScalar(.6);
      }
      if (mm.emissive) mm.emissiveIntensity = hot ? M.max(.45, b.emissiveIntensity) : M.min(.1, b.emissiveIntensity);
      mm.envMapIntensity = hot ? 1.2 : .42;
    });
    applySelectionBox();
  }

  function refreshPulses() {
    const cfg = STEPS[step - 1] || STEPS[0];
    const cablesOn = explode < .3;
    pulses.forEach(function (s) {
      const g = s.userData.group;
      const want = cablesOn && (cfg.path === 'cxl' ? g === 'cxl' : (cfg.path === 'rdma' ? g === 'rdma' : false));
      s.visible = !!want;
      s.userData.dir = cfg.dir;
      s.userData.speed = .34;
    });
  }

  function applySelectionBox() {
    if (hlBox) hlBox.visible = !!selectedId;
    if (reticle && !selectedId) reticle.style.opacity = '0';
    if (hlBoxHover) hlBoxHover.visible = !!(hoveredId && hoveredId !== selectedId);
  }

  const _box = new THREE.Box3();
  function updateHighlight(now) {
    if (hlBox && hlBox.visible) {
      const node = partById(selectedId);
      if (!node || !_box.setFromObject(node.obj) || _box.isEmpty()) hlBox.visible = false;
      else {
        const sph = _box.getBoundingSphere(new THREE.Sphere());
        const sz = M.max(.02, sph.radius * 2) * 1.04;
        hlBox.position.copy(sph.center);
        hlBox.scale.set(sz, sz, sz);
        hlBox.material.opacity = .6 + .3 * M.sin(now / 330);
        positionReticle(sph.center, sph.radius);
      }
    }
    if (hlBoxHover && hlBoxHover.visible) {
      const node = partById(hoveredId);
      if (!node || !_box.setFromObject(node.obj) || _box.isEmpty()) { hlBoxHover.visible = false; return; }
      const sph = _box.getBoundingSphere(new THREE.Sphere());
      const sz = M.max(.02, sph.radius * 2) * 1.03;
      hlBoxHover.position.copy(sph.center);
      hlBoxHover.scale.set(sz, sz, sz);
    }
  }
  function positionReticle(center, radius) {
    if (!reticle || !host) return;
    _v3.copy(center).project(camera);
    const w = host.clientWidth, h = host.clientHeight;
    const dist = M.max(.05, camera.position.distanceTo(controls.target));
    const pxPerUnit = h / (2 * M.tan(camera.fov * M.PI / 360) * dist);
    const rpx = M.max(20, M.min(w * .3, radius * 2.2 * pxPerUnit));
    reticle.style.left = (((_v3.x + 1) / 2 * w) - rpx) + 'px';
    reticle.style.top = (((-_v3.y + 1) / 2 * h) - rpx) + 'px';
    reticle.style.width = (rpx * 2) + 'px';
    reticle.style.height = (rpx * 2) + 'px';
    reticle.style.opacity = _v3.z < 1 ? '1' : '0';
  }

  /* ══════════════════════════════════════════════════════════
     交互
     ══════════════════════════════════════════════════════════ */
  function wireEvents() {
    const dom = renderer.domElement;
    let downPt = null, moved = 0;

    dom.addEventListener('pointermove', function (e) {
      const r = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      if (downPt) {
        moved = M.max(moved, M.abs(e.clientX - downPt.x) + M.abs(e.clientY - downPt.y));
        return;
      }
      const hit = pick(e);
      if (hit) {
        const meta = hit.object.userData.meta;
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX - r.left + 14) + 'px';
        tooltip.style.top = (e.clientY - r.top + 10) + 'px';
        tooltip.innerHTML = '<b>' + esc(meta.name) + '</b><span>' + esc(meta.detail || '') + '</span>';
        dom.style.cursor = 'pointer';
        setHover(treeIdOf(meta));
      } else {
        tooltip.style.display = 'none';
        dom.style.cursor = 'grab';
        setHover(null);
      }
    });
    dom.addEventListener('pointerleave', function () { tooltip.style.display = 'none'; setHover(null); });
    dom.addEventListener('pointerdown', function (e) { downPt = { x: e.clientX, y: e.clientY }; moved = 0; });
    dom.addEventListener('pointerup', function (e) {
      const click = downPt && moved < TUNE.pickPx;
      downPt = null;
      if (!click) return;
      const hit = pick(e);
      if (hit) {
        const id = treeIdOf(hit.object.userData.meta);
        if (id) selectPart(id);
      } else {
        clearSelection();
      }
      if (window.__GLA__ && window.__GLA__.syncSelection) window.__GLA__.syncSelection(selectedId);
    });
  }

  function pick(e) {
    if (!raycaster || !parts.length) return null;
    const r = renderer.domElement.getBoundingClientRect();
    if (e) {
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    }
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(parts, false);
    const cutting = (mode === 'cut' || mode === 'explode') && U.planes[0].constant < U.CLIP_OFF / 2;
    for (let i = 0; i < hits.length; i++) {
      const o = hits[i].object;
      if (!o.userData.meta || o.visible === false) continue;
      if (cutting) {
        const node = selectedId ? partById(selectedId) : null;
        const clipped = node ? isDescendant(node.obj, o) : true;
        if (clipped && hits[i].point && hits[i].point.x > U.planes[0].constant) continue;
      }
      return hits[i];
    }
    return null;
  }

  function treeIdOf(meta) {
    if (!meta) return null;
    const name = meta.name || '';
    let mm = /^N(\d)/.exec(meta.id || name);
    if (mm) {
      const i = M.max(0, M.min(3, (+mm[1]) - 1));
      if (/GPU/.test(name)) return 'srv' + i + 'gpu';
      if (/网卡/.test(name)) return 'srv' + i + 'rnic';
      return 'srv' + i;
    }
    mm = /^MHD-(\d)/.exec(name);
    if (mm) {
      const id = 'mhd' + ((+mm[1]) - 1);
      return treeIndexOf(id) >= 0 ? id : 'mhd';
    }
    if (/SHARED MHD|MHD 抽屉|空槽位|上行端口/.test(name)) return 'mhd';
    if (/CXL Switch|Host 端口|散热鳍片|交换主控/.test(name)) return 'switch';
    if (/ToR|QSFP-DD/.test(name)) return 'tor';
    if (/Spine|Leaf/.test(name)) return 'spine';
    if (/前面板|后面板|上盖|电源|主板|DIMM|CPU|风扇/.test(name)) {
      const n2 = /^N(\d)/.exec(name);
      if (n2) return 'srv' + M.max(0, M.min(3, (+n2[1]) - 1));
    }
    return null;
  }
  function treeIndexOf(id) {
    for (let i = 0; i < treeNodes.length; i++) if (treeNodes[i].id === id) return i;
    return -1;
  }

  function setHover(id) {
    if (selectedId || hoveredId === id) return;
    hoveredId = id;
    applySelectionBox();
  }

  function selectPart(id) {
    if (!partById(id)) return;
    selectedId = id;
    hoveredId = null;
    applyClipScope();
    refreshTint();
    focusPart(partById(id));
  }
  function partById(id) {
    for (let i = 0; i < treeNodes.length; i++) if (treeNodes[i].id === id) return treeNodes[i];
    return null;
  }
  function focusPart(node) {
    if (!node || !_box.setFromObject(node.obj) || _box.isEmpty()) return;
    const sph = _box.getBoundingSphere(new THREE.Sphere());
    const tgt = sph.center.clone();
    const hv = camera.fov * M.PI / 360;
    const hh = M.atan(M.tan(hv) * (camera.aspect || 1));
    const dist = M.max(.24, sph.radius * 2.2 / M.sin(M.min(hv, hh)));
    const dir = camera.position.clone().sub(controls.target).normalize();
    const p1 = tgt.clone().addScaledVector(dir, dist);
    if (REDUCED) { camera.position.copy(p1); controls.target.copy(tgt); controls.update(); camTween = null; return; }
    camTween = { t: 0, dur: 1.0, p0: camera.position.clone(), p1: p1, t0: controls.target.clone(), t1: tgt };
  }
  function clearSelection() {
    selectedId = null;
    applyClipScope();
    refreshTint();
  }

  /* ══════════════════════════════════════════════════════════
     渲染循环
     ══════════════════════════════════════════════════════════ */
  const STILL = /(?:^|[?&])still=1/.test(location.search);
  let frameN = 0;

  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    if (STILL && frameN++ > 40) { renderer.render(scene, camera); return; }

    const dt = M.min(.05, clock.getDelta());
    const t = clock.elapsedTime;

    /* 帧率兜底：持续偏低就降 dpr，保证低配设备也顺 */
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1.2) {
      const fps = fpsN / fpsAcc;
      if (!degraded && fps < 34 && dpr > 1) { degraded = true; dpr = 1; renderer.setPixelRatio(1); }
      fpsAcc = 0; fpsN = 0;
    }

    if (camTween) {
      camTween.t += dt / M.max(.001, camTween.dur);
      const k = camTween.t >= 1 ? 1 : EASE.inOutCubic(camTween.t);
      camera.position.lerpVectors(camTween.p0, camTween.p1, k);
      controls.target.lerpVectors(camTween.t0, camTween.t1, k);
      if (camTween.t >= 1) camTween = null;
    }

    if (M.abs(explode - explodeTarget) > .002) {
      explode += (explodeTarget - explode) * M.min(1, dt * 5.2);
      applyExplode(explode);
    }

    updateLabels();
    updateHighlight(t * 1000);

    if (!REDUCED) {
      for (let i = 0; i < pulses.length; i++) {
        const s = pulses[i];
        if (!s.visible) continue;
        const u = s.userData;
        u.t += dt * u.speed * (u.dir < 0 ? -1 : 1);
        if (u.t > 1) u.t -= 1;
        if (u.t < 0) u.t += 1;
        s.position.copy(u.curve.getPointAt(clamp01(u.t)));
      }
      const breathe = .55 + .6 * (.5 + .5 * M.sin(t * 2.3));
      for (let i = 0; i < glowMats.length; i++) {
        const mm = glowMats[i];
        if (mm && mm.emissive) mm.emissiveIntensity = baseOf(mm).emissiveIntensity * breathe;
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }

  function resize() {
    if (!renderer || !host) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const prev = camera.aspect;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    /* 没手动动过镜头时，按当前预设重新取景，避免模型被裁切 */
    if (!userMoved && M.abs(prev - camera.aspect) > .02) {
      computeFit();
      presetCamera(presetName, true);
    }
  }

  /* ══════════════════════════════════════════════════════════
     对外 API（与 webgl-ui.js / webgl-assembly.js 兼容）
     ══════════════════════════════════════════════════════════ */
  function sig(rid) {
    const st = S.STATE;
    return rid + '|' + ((st.rackUnits && st.rackUnits[rid]) || []).join(',') + '|' +
      ((st.nodeConfig && st.nodeConfig[rid]) ? Object.keys(st.nodeConfig[rid]).filter(function (k) { return st.nodeConfig[rid][k]; }).join(',') : '') +
      '|' + (st.deployment && st.deployment[rid] ? 1 : 0);
  }

  const API = {
    available: true,
    parts: function () {
      return treeNodes.map(function (n) { return { id: n.id, name: n.name, sub: n.sub, cat: n.cat, level: n.level }; });
    },
    select: function (id) { selectPart(id); },
    hover: function (id) {
      if (!id) { hoveredId = null; applySelectionBox(); return; }
      if (!selectedId && partById(id)) setHover(id);
    },
    clear: clearSelection,
    explode: function (k) { explode = clamp01(k); explodeTarget = explode; applyExplode(explode); },
    section: function (k) { setSection(k); applyMode(); },
    srcSelected: function () { return selectedId; },
    mount: function (el) {
      host = el;
      initScene();
      const rid = S.STATE.selectedRack || 'R1';
      build(rid);
      lastSig = sig(rid);
      presetCamera('iso', true);
      applyStep(1, true);
      resize();
      running = true;
      animate();
    },
    sync: function () {
      if (!host) return;
      const rid = S.STATE.selectedRack || 'R1';
      const s2 = sig(rid);
      if (s2 !== lastSig || rid !== lastRid) { build(rid); lastSig = s2; }
      resize();
    },
    setMode: function (m2) {
      mode = m2;
      explodeTarget = (m2 === 'explode') ? 1 : 0;
      if (!root) return;
      applyMode();
      if (m2 === 'explode') applyExplode(explode);
    },
    setPreset: flyTo,
    setStep: function (n) { applyStep(n, false); },
    dolly: function (f) {
      if (!camera) return;
      userMoved = true;
      const d = camera.position.distanceTo(controls.target);
      const nd = M.max(.28, M.min(20, d * f));
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, nd);
      camTween = null;
    },
    orbit: function (ang) {
      if (!camera) return;
      const p = camera.position.clone().sub(controls.target);
      const c = M.cos(ang), s2 = M.sin(ang);
      camera.position.set(controls.target.x + (p.x * c - p.z * s2), camera.position.y, controls.target.z + (p.x * s2 + p.z * c));
      camTween = null;
    },
    toggleLabels: function (on) {
      if (labelLayer) labelLayer.style.display = on ? 'block' : 'none';
      if (labelLead) labelLead.style.display = on ? 'block' : 'none';
    },
    resize: resize,
    dispose: function () { running = false; if (renderer) renderer.dispose(); }
  };

  function isDescendant(parent, child) {
    let p = child;
    while (p) { if (p === parent) return true; p = p.parent; }
    return false;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  window.__GL3D__ = API;
})();
