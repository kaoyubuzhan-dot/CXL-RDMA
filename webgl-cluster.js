/* ============================================================
 * webgl-cluster.js — KV 全生命周期页：四机柜三维集群
 *
 * 2×2 机架：R1(后左 CXL) R2(后右 RDMA) / R3(前左 CXL) R4(前右 RDMA)
 * 中央：Deployment Controller（平台+光柱+组件环）· RDMA 内存池设备
 * 上方：Spine/Leaf 悬浮；ToR→Spine 上行
 * 地面链路：L12 / L34 / L13 / L24（L14/L23 经 Spine 中转）
 * 特效见 webgl-cluster-fx.js（applyStep 驱动）
 * ============================================================ */
(function () {
  'use strict';
  if (!window.THREE || !window.__GLUTILS__) { window.__GLCLUSTER__ = { available: false }; return; }

  var THREE = window.THREE;
  var U = window.__GLUTILS__(THREE);
  var C = { cxl: 0x53e3c4, rdma: 0x5f9fe8, move: 0xe6a056, copy: 0xa38bf2, idle: 0x3c4b57, mon: 0x7dc9df, hot: 0xff6b6b, cyan: 0x91e4ff };
  var RACK_POS = { R1: { x: -.98, z: .92 }, R2: { x: .98, z: .92 }, R3: { x: -.98, z: -.92 }, R4: { x: .98, z: -.92 } };
  var CXL_RACKS = { R1: 1, R3: 1 };
  var RW = .62, RD = .86, RH = 2.02, UH = .0445, SPINE_Y = 2.42, CTRL_Y = 1.5, POOL_Y = .28;

  var host = null, renderer = null, scene = null, camera = null, controls = null;
  var root = null, fx = null, clock = null, running = false, envMap = null;
  var raycaster = null, pointer = new THREE.Vector2(), camTween = null;
  var rackBodies = {}, endpoints = {}, links = {}, spineRef = null, ctrlRef = null, poolRef = null;
  var labelEls = [], labelDefs = [], labelLayer = null, selectedId = null, opts = {};
  var dpr = 1, fpsAcc = 0, fpsN = 0, degraded = false, GLOW = null;
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var M = Math;
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var ease = function (t) { return t < .5 ? 4 * t * t * t : 1 - M.pow(-2 * t + 2, 3) / 2; };

  /* ── 部署切换补间：CXL 硬件组 scale.y 从机柜底部长出来 / 收回去 ── */
  var tweens = [];
  function addTween(dur, set, done) {
    tweens.push({ t: 0, dur: Math.max(.01, dur), set: set, done: done });
  }
  function tickTweens(dt) {
    for (var i = tweens.length - 1; i >= 0; i--) {
      var tw = tweens[i];
      tw.t += dt / tw.dur;
      var k = clamp01(tw.t);
      tw.set(ease(k));
      if (k >= 1) { tweens.splice(i, 1); if (tw.done) tw.done(); }
    }
  }

  /* ── 共享给 fx 模块的上下文 ── */
  var CTX = {
    THREE: THREE, U: U, C: C, RACK_POS: RACK_POS, CXL_RACKS: CXL_RACKS,
    RW: RW, RD: RD, RH: RH, UH: UH, SPINE_Y: SPINE_Y, CTRL_Y: CTRL_Y, POOL_Y: POOL_Y,
    getScene: function () { return scene; }, getRoot: function () { return root; },
    getFx: function () { return fx; }, getCamera: function () { return camera; },
    getEndpoints: function () { return endpoints; }, getLinks: function () { return links; },
    getRacks: function () { return rackBodies; }, getCtrl: function () { return ctrlRef; },
    glowTex: function () { return GLOW; }, REDUCED: REDUCED, clamp01: clamp01, ease: ease, M: M
  };

  function glowTexture() {
    var cv = document.createElement('canvas'); cv.width = cv.height = 128;
    var x = cv.getContext('2d');
    var g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(64, 64, 64, 0, M.PI * 2); x.fill();
    var t = new THREE.Texture(cv); t.needsUpdate = true; return t;
  }

  function slimRack(id) {
    var g = new THREE.Group(), pos = RACK_POS[id], cxl = !!CXL_RACKS[id], pw = .042, i, k;

    /* 4 根重型冷轧钢 C 型角立柱（工业级数据中心机柜机架立柱） */
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
      var col = new THREE.Group();
      var p = U.box(pw, RH, pw, 'frameDark');
      p.position.set(0, RH / 2, 0);
      col.add(p);
      // 立柱安装方孔冲压饰条
      var holes = [];
      for (var u = 0; u < 28; u++) {
        holes.push({ p: [s[0] > 0 ? -pw * .35 : pw * .35, .08 + u * (RH - .16) / 28, pw * .48] });
      }
      col.add(U.inst(U.geoBox(.008, .012, .003), 'hole', holes));
      col.position.set(s[0] * (RW / 2 - pw / 2) * .96, 0, s[1] * (RD / 2 - pw / 2) * .96);
      g.add(col);
    });

    /* 机柜顶盖与走线口 */
    var cap = U.boxE(RW + .02, .036, RD + .02, 'frame', { color: 0x222d36, opacity: 1 });
    cap.position.y = RH - .018; g.add(cap);
    // 顶部走线开孔毛刷口
    var topCut = U.box(RW * .6, .01, .06, 'hole');
    topCut.position.set(0, RH - .001, -RD * .25); g.add(topCut);

    /* 机柜重型承重底座与地脚 */
    var base = U.boxE(RW + .02, .055, RD + .02, 'frameDark', { color: 0x11171d, opacity: 1 });
    base.position.y = .0275; g.add(base);
    var feet = [];
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
      feet.push({ p: [s[0] * (RW / 2 - .03), .01, s[1] * (RD / 2 - .03)] });
    });
    g.add(U.inst(U.geoCyl(.022, .02, 12), 'steel', feet));

    /* 侧面实体防静电冷轧钢侧护板（带内凹冲压肋条与锁扣凹槽，彻底去除廉价塑料玻璃感） */
    [-1, 1].forEach(function (s) {
      var sideGroup = new THREE.Group();
      var panel = U.boxE(.008, RH - .1, RD - .03, 'frameDark', { color: 0x141b22, opacity: 1 });
      panel.position.set(0, RH / 2, 0);
      sideGroup.add(panel);
      // 侧板内凹加强筋与锁扣
      var rib = U.box(.003, RH * .7, RD * .55, 'chassis');
      rib.position.set(s * .005, RH / 2, 0);
      sideGroup.add(rib);
      var lock = U.box(.01, .06, .03, 'steel');
      lock.position.set(s * .006, RH / 2, RD * .3);
      sideGroup.add(lock);
      sideGroup.position.set(s * (RW / 2 - .004), 0, 0);
      g.add(sideGroup);
    });

    /* 背面蜂窝散热冲孔护网 */
    var back = U.boxE(RW - .03, RH - .1, .006, 'mesh', { color: 0x121a22, opacity: .88 });
    back.position.set(0, RH / 2, -RD / 2 + .008); g.add(back);

    /* 4 台 4U 高性能 GPU 服务器 + 真实前面板 + 硬盘抽屉托架 + 耳挂 + LED */
    var shell = [], bays = [], baysGold = [], leds = [], ears = [], nodeY = {};
    [7, 11, 15, 19].forEach(function (u, i) {
      var ym = .056 + (u - 1) * UH + 2 * UH;
      shell.push({ p: [0, ym, .02] });
      nodeY['N' + (i + 1)] = ym;
      // 左右 19" 挂耳片
      ears.push({ p: [-(RW / 2 - .022), ym, RD / 2 - .028] });
      ears.push({ p: [RW / 2 - .022, ym, RD / 2 - .028] });
      // 12 块 2.5 寸热插拔托架
      for (var b = 0; b < 12; b++) {
        var bx = -.18 + b * .031;
        bays.push({ p: [bx, ym + .005, RD / 2 - .038] });
        baysGold.push({ p: [bx, ym - .024, RD / 2 - .035] });
      }
      // 状态指示灯
      leds.push({ p: [.215, ym + .018, RD / 2 - .036] });
      leds.push({ p: [.215, ym + .002, RD / 2 - .036] });
    });
    g.add(U.inst(U.geoBox(RW - .08, 4 * UH - .008, RD - .08), 'chassis', shell));
    g.add(U.inst(U.geoBox(.018, 4 * UH - .01, .012), 'steel', ears));
    g.add(U.inst(U.geoBox(.027, 4 * UH * .55, .008), 'tray', bays));
    g.add(U.inst(U.geoBox(.024, .005, .005), 'goldBright', baysGold));
    g.add(U.inst(U.geoBox(.007, .005, .003), 'ledGreen', leds));

    /* ToR 交换机（带前面板 400G QSFP-DD 端口屏蔽笼） */
    var tor = U.boxE(RW - .06, .042, RD * .55, 'switchBody', { color: 0x1d3345, opacity: 1 });
    tor.position.set(0, .056 + 40 * UH, 0); g.add(tor);
    var torPorts = [];
    for (i = 0; i < 16; i++) torPorts.push({ p: [-.18 + i * .024, .056 + 40 * UH, RD * .275 + .002] });
    g.add(U.inst(U.geoBox(.016, .012, .008), 'shield', torPorts));

    /* MHD / 空槽盲板：每台机架同时构建 CXL 硬件组与盲板组，
       由 setDeploy 按部署状态切换显隐（带平滑生长动画） */
    var mhdY = .056 + 22 * UH + UH / 2;
    var gx = new THREE.Group();          // CXL 硬件组（MHD + Switch + 连线 + 容量条 + 标签）
    gx.scale.y = .001; gx.visible = false;
    var gb = new THREE.Group();          // RDMA-only 通风盲板组
    if (true) {
      // 共享 CXL-MHD 内存池单元机箱（极具科技感的阳极氧化青绿拉丝）
      var mh = U.boxE(RW - .08, 3 * UH - .006, RD - .1, 'mhdUnit', { color: 0x0f4239, opacity: 1 });
      mh.userData.mesh.material.emissive.setHex(0x063028);
      mh.userData.mesh.material.emissiveIntensity = .55;
      mh.position.set(0, mhdY, .02); gx.add(mh);

      // 3 个热插拔内存抽屉面板与把手
      var drawers = [], handles = [];
      for (i = 0; i < 3; i++) {
        var dx = -.14 + i * .14;
        drawers.push({ p: [dx, mhdY, RD / 2 - .038] });
        handles.push({ p: [dx, mhdY, RD / 2 - .032] });
      }
      gx.add(U.inst(U.geoBox(.12, 3 * UH * .75, .008), 'mhdFrame', drawers));
      gx.add(U.inst(U.geoBox(.06, .012, .01), 'steel', handles));

      var ml = [];
      for (i = 0; i < 6; i++) ml.push({ p: [-.16 + i * .064, mhdY - .032, RD / 2 - .035] });
      gx.add(U.inst(U.geoBox(.009, .006, .003), 'ledCxl', ml));

      /* CXL Switch：1U 高速低延迟交换机 */
      var swY = .056 + 26 * UH;
      var sw = U.boxE(RW - .09, 1.6 * UH, RD - .2, 'switchBody', { color: 0x113b33, opacity: 1 });
      sw.position.set(0, swY, .01); gx.add(sw);
      var swPorts = [], swLeds = [];
      for (i = 0; i < 8; i++) {
        swPorts.push({ p: [-.16 + i * .046, swY, RD / 2 - .09] });
        swLeds.push({ p: [-.16 + i * .046, swY + .018, RD / 2 - .088] });
      }
      gx.add(U.inst(U.geoBox(.024, .014, .01), 'shield', swPorts));
      gx.add(U.inst(U.geoBox(.007, .005, .003), 'ledCxl', swLeds));

      /* 主机端口高速连线：MHD ↔ CXL Switch（真实 DAC 线缆弧度） */
      var cables = [];
      for (i = 0; i < 4; i++) cables.push({ p: [-.12 + i * .08, .056 + 24.55 * UH, .28] });
      gx.add(U.inst(U.geoBox(.014, 1.02 * UH, .014), 'ledCxl', cables));

      /* MHD 容量条：R1 约 320/512，R3 约 192/512 */
      var capW = RW - .18;
      var usedR = (id === 'R3') ? .375 : .625;
      var capBg = U.box(capW, .016, .006, 'frameDark');
      capBg.position.set(0, mhdY - 1.16 * UH, RD / 2 - .012); gx.add(capBg);
      var capFill = U.box(capW * usedR, .016, .008, 'ledCxl');
      capFill.position.set(-capW * (1 - usedR) / 2, mhdY - 1.16 * UH, RD / 2 - .009); gx.add(capFill);
      var mhdTag = U.decal('MHD ' + (id === 'R3' ? '192' : '320') + '/512 GB', .24, .034, '#85ffdf', 30);
      mhdTag.position.set(0, mhdY + .065, RD / 2 - .006); gx.add(mhdTag);
      var tagBg = U.box(.28, .048, .003, 'frameDark');
      tagBg.position.set(0, mhdY + .062, RD / 2 - .012); gx.add(tagBg);
    }
    {
      // 纯 RDMA 机架的工业通风盲板
      var blk = [];
      for (var u = 23; u <= 25; u++) blk.push({ p: [0, .056 + (u - 1) * UH + UH / 2, RD / 2 - .042] });
      gb.add(U.inst(U.geoBox(RW - .09, .034, .008), 'blank', blk));
    }
    g.add(gx); g.add(gb);
    gx.visible = !!cxl; gx.scale.y = cxl ? 1 : .001;
    g.userData.cxlParts = gx;
    g.userData.blindParts = gb;
    g.userData.cxlOn = !!cxl;

    /* 其余空 U 盲板 */
    var used = [[7, 22], [23, 25], [40, 41]], blanks = [];
    for (var uu = 2; uu <= 39; uu++) {
      var hit = false;
      for (k = 0; k < used.length; k++) if (uu >= used[k][0] && uu <= used[k][1]) { hit = true; break; }
      if (hit) continue;
      blanks.push({ p: [0, .056 + (uu - 1) * UH + UH / 2, RD / 2 - .042] });
    }
    if (blanks.length) g.add(U.inst(U.geoBox(RW - .1, .032, .006), 'blank', blanks));

    /* 机架顶部金属技术标签：CXL+RDMA / RDMA-only 两套 */
    var tagC = U.decal(id + ' · CXL + RDMA', .34, .06, '#64ffd8', 28);
    tagC.position.set(0, RH + .12, .26); g.add(tagC);
    var tagR = U.decal(id + ' · RDMA ONLY', .34, .06, '#93c5fd', 28);
    tagR.position.set(0, RH + .12, .26); g.add(tagR);
    tagC.visible = !!cxl; tagR.visible = !cxl;
    g.userData.tagC = tagC; g.userData.tagR = tagR;

    g.position.set(pos.x, 0, pos.z);
    g.userData.pick = { kind: 'rack', id: id };

    endpoints[id] = {
      TOR: new THREE.Vector3(pos.x, .056 + 40 * UH, pos.z),
      MHD: new THREE.Vector3(pos.x, cxl ? mhdY : .5, pos.z + .2)
    };
    Object.keys(nodeY).forEach(function (n) { endpoints[id][n] = new THREE.Vector3(pos.x, nodeY[n], pos.z + .2); });
    return g;
  }

  function groundLink(id, a, b, off) {
    var A = RACK_POS[a], B = RACK_POS[b];
    var curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(A.x + off.x * .5, .02, A.z + off.z * .5),
      new THREE.Vector3((A.x + B.x) / 2 + off.x, .02, (A.z + B.z) / 2 + off.z),
      new THREE.Vector3(B.x + off.x * .5, .02, B.z + off.z * .5)
    ], false, 'catmullrom', .5);
    var mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, .006, 6, false),
      new THREE.MeshBasicMaterial({ color: C.idle, transparent: true, opacity: .5, depthWrite: false }));
    mesh.userData.linkId = id;
    root.add(mesh);
    links[id] = { mesh: mesh, curve: curve, base: C.idle };
  }

  function initScene() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    dpr = M.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.sRGBEncoding != null && 'outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04080c, .042);
    envMap = U.makeEnv(renderer);
    scene.environment = envMap;
    if ('environmentIntensity' in scene) scene.environmentIntensity = .85;

    camera = new THREE.PerspectiveCamera(34, 1, .05, 80);
    camera.position.set(5.4, 4.1, 6.2);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.05, 0);
    controls.enableDamping = !REDUCED;
    controls.dampingFactor = .07;
    controls.minDistance = 1.6;
    controls.maxDistance = 28;
    controls.maxPolarAngle = M.PI * .49;
    controls.update();

    scene.add(new THREE.HemisphereLight(0x35586c, 0x05090e, .85));
    // 机房主冷白条形吸顶灯光阵列
    var key = new THREE.DirectionalLight(0xdff0ff, 2.4);
    key.position.set(3.8, 8.5, 4.8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -.0015;
    var sc = key.shadow.camera; sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5; sc.far = 24;
    scene.add(key);
    var keyBack = new THREE.DirectionalLight(0x9fc8e8, 1.2);
    keyBack.position.set(-4.5, 7.5, -4.5);
    scene.add(keyBack);

    var warm = new THREE.DirectionalLight(C.move, .45); warm.position.set(-6, 3, -5); scene.add(warm);
    var ctl = new THREE.PointLight(C.cyan, 2.5, 8, 2); ctl.position.set(0, CTRL_Y + .2, 0); scene.add(ctl);

    /* 真实数据中心 600mm 防静电高架地坪系统 */
    var floorMat = new THREE.MeshStandardMaterial({
      map: U.TEX.floorTile,
      roughness: .45,
      metalness: .42,
      envMapIntensity: 1.2
    });
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), floorMat);
    floor.rotation.x = -M.PI / 2; floor.receiveShadow = true; scene.add(floor);

    var sheen = new THREE.Mesh(new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ map: U.floorTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .55 }));
    sheen.rotation.x = -M.PI / 2; sheen.position.y = .001; scene.add(sheen);

    root = new THREE.Group(); scene.add(root);
    fx = new THREE.Group(); scene.add(fx);
    raycaster = new THREE.Raycaster();
    clock = new THREE.Clock();
    GLOW = glowTexture();

    ['R1', 'R2', 'R3', 'R4'].forEach(function (id) {
      var r = slimRack(id); root.add(r); rackBodies[id] = r;
    });

    /* 数据中心机房高架走线槽道与桥架系统（Fiber Cable Runway & Trays） */
    var trayGroup = new THREE.Group();
    var trayY = RH + .14;
    // 横向连接 R1-R2 与 R3-R4 的走线桥架（双通道）
    [RACK_POS.R1.z, RACK_POS.R3.z].forEach(function (z) {
      // 黄色光纤走线槽底板与护边
      var tBase = U.boxE(2.8, .014, .2, 'frameDark', { color: 0xd49b28, opacity: .95 });
      tBase.position.set(0, trayY, z - .15);
      trayGroup.add(tBase);
      // 金属吊架立杆
      [-1.35, 0, 1.35].forEach(function (tx) {
        var hanger = U.box(.016, .35, .016, 'steel');
        hanger.position.set(tx, trayY + .175, z - .15);
        trayGroup.add(hanger);
      });
    });
    // 纵向连接 R1-R3 与 R2-R4 的光纤通道
    [RACK_POS.R1.x, RACK_POS.R2.x].forEach(function (x) {
      var tCross = U.boxE(.2, .014, 2.4, 'frameDark', { color: 0xd49b28, opacity: .95 });
      tCross.position.set(x, trayY + .01, 0);
      trayGroup.add(tCross);
    });
    root.add(trayGroup);

    /* Spine */
    endpoints.SPINE = new THREE.Vector3(0, SPINE_Y, 0);
    spineRef = new THREE.Group();
    spineRef.add(U.boxE(1.3, .07, .4, 'switchBody', { color: 0x8fd8ff, opacity: .5 }));
    var ports = [];
    for (var i = 0; i < 20; i++) ports.push({ p: [-.57 + i * .06, .004, .2] });
    spineRef.add(U.inst(U.geoBox(.03, .014, .012), 'shield', ports));
    var sl = [];
    for (i = 0; i < 10; i++) sl.push({ p: [-.45 + i * .1, -.012, .204] });
    spineRef.add(U.inst(U.geoBox(.008, .005, .003), 'ledGreen', sl));
    spineRef.position.y = SPINE_Y;
    spineRef.userData.pick = { kind: 'node', id: 'SPINE' };
    root.add(spineRef);

    /* Controller */
    endpoints.CTRL = new THREE.Vector3(0, CTRL_Y, 0);
    ctrlRef = new THREE.Group();
    ctrlRef.add(new THREE.Mesh(new THREE.CylinderGeometry(.36, .44, .05, 8), U.m('frame')));
    var core = U.boxE(.3, .3, .3, 'die', { color: 0x35485c, opacity: .85 });
    core.position.y = .26; ctrlRef.add(core);
    var beam = new THREE.Mesh(new THREE.CylinderGeometry(.07, .15, 1.0, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: .15, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = .55; ctrlRef.add(beam);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(.52, .008, 8, 64),
      new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = M.PI / 2; ring.position.y = .3; ring.userData.spin = 1; ctrlRef.add(ring);
    var ring2 = new THREE.Mesh(new THREE.TorusGeometry(.64, .006, 8, 64),
      new THREE.MeshBasicMaterial({ color: C.cxl, transparent: true, opacity: .32, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring2.rotation.x = M.PI / 2.3; ring2.position.y = .3; ring2.userData.spin = -.7; ctrlRef.add(ring2);
    ['Placement', 'Profiler', 'Topology', 'Directory'].forEach(function (nm, i) {
      var a = i * M.PI / 2 + M.PI / 4;
      var chip = U.boxE(.14, .05, .09, 'pcbDark', { color: 0x2a6f5c, opacity: .85 });
      chip.position.set(M.cos(a) * .48, .12, M.sin(a) * .48);
      chip.rotation.y = -a; ctrlRef.add(chip);
    });
    ctrlRef.position.set(0, CTRL_Y - .4, 0);
    ctrlRef.userData.pick = { kind: 'node', id: 'CTRL' };
    root.add(ctrlRef);

    /* RDMA 内存池 */
    endpoints.POOL = new THREE.Vector3(0, POOL_Y + .52, 0);
    poolRef = new THREE.Group();
    poolRef.add(U.boxE(.5, .5, .34, 'switchBody', { color: 0x5f9fe8, opacity: .5 }));
    var dram = [];
    for (var r = 0; r < 4; r++) for (var c = 0; c < 8; c++) dram.push({ p: [-.19 + c * .055, -.16 + r * .11, .175] });
    poolRef.add(U.inst(U.geoBox(.04, .07, .008), 'chip', dram));
    poolRef.position.set(0, POOL_Y + .27, 0);
    poolRef.userData.pick = { kind: 'node', id: 'POOL' };
    root.add(poolRef);

    /* 链路 */
    groundLink('L12', 'R1', 'R2', { x: 0, z: .66 });
    groundLink('L34', 'R3', 'R4', { x: 0, z: -.66 });
    groundLink('L13', 'R1', 'R3', { x: -.74, z: 0 });
    groundLink('L24', 'R2', 'R4', { x: .74, z: 0 });
    ['R1', 'R2', 'R3', 'R4'].forEach(function (id) {
      var P0 = RACK_POS[id];
      var curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(P0.x, .056 + 40 * UH, P0.z),
        new THREE.Vector3(P0.x * .7, SPINE_Y - .2, P0.z * .7),
        new THREE.Vector3(0, SPINE_Y - .06, 0)
      ], false, 'catmullrom', .4);
      var mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, .005, 6, false),
        new THREE.MeshBasicMaterial({ color: C.rdma, transparent: true, opacity: .32, depthWrite: false }));
      root.add(mesh);
      links['U' + id] = { mesh: mesh, curve: curve, base: C.rdma };
    });
    links.L14 = { via: ['UR1', 'UR4'] };
    links.L23 = { via: ['UR2', 'UR3'] };

    wireEvents();
    ensureLabels();
    resize();
  }

  /* ── 标签 ── */
  function ensureLabels() {
    if (labelLayer) return;
    labelLayer = document.createElement('div');
    labelLayer.className = 'gll-labels';
    host.appendChild(labelLayer);
    labelDefs = ['R1', 'R2', 'R3', 'R4'].map(function (id) {
      return { id: id, p: new THREE.Vector3(RACK_POS[id].x, RH + .16, RACK_POS[id].z), txt: id };
    });
    /* CXL 部件标注：随部署状态显隐 —— dep = { rack, on } 表示
       该机架部署 CXL（on=true）或未部署（on=false）时才显示 */
    ['R1', 'R2', 'R3', 'R4'].forEach(function (id) {
      var pos = RACK_POS[id];
      var flip = (id === 'R3' || id === 'R4') ? -1 : 1;   /* 背面机架朝相反方向错开，避免压在一起 */
      labelDefs.push({
        id: id + '.MHD', sub: 1, txt: 'MHD ' + (id === 'R3' ? '192' : '320') + '/512 GB',
        dep: { rack: id, on: true }, ox: 34 * flip, oy: 10,
        p: new THREE.Vector3(pos.x, .056 + 22.5 * UH, pos.z + RD / 2 + .04)
      });
      labelDefs.push({
        id: id + '.SW', sub: 1, txt: 'CXL SWITCH · 2 HOST',
        dep: { rack: id, on: true }, ox: 34 * flip, oy: -14,
        p: new THREE.Vector3(pos.x, .056 + 26.4 * UH, pos.z + RD / 2 + .04)
      });
      labelDefs.push({
        id: id + '.RDMA', sub: 1, txt: 'NO CXL · RDMA ONLY',
        dep: { rack: id, on: false }, ox: 34 * flip, oy: 8,
        p: new THREE.Vector3(pos.x, .056 + 22.5 * UH, pos.z + RD / 2 + .04)
      });
    });
    labelEls = labelDefs.map(function (d) {
      var el = document.createElement('div');
      el.className = 'gll-lbl' + (d.sub ? ' gll-lbl--sub' : '');
      el.textContent = d.txt;
      labelLayer.appendChild(el);
      return el;
    });
  }
  var _v3 = new THREE.Vector3();
  function updateLabels() {
    if (!labelLayer || !labelEls.length) return;
    var w = host.clientWidth, h = host.clientHeight;
    labelDefs.forEach(function (d, i) {
      var el = labelEls[i];
      /* 部署感知标签：MHD/SW 标注仅在已部署时显示，NO-CXL 标注仅在未部署时显示 */
      if (d.dep) {
        var rk = rackBodies[d.dep.rack];
        var on = !!(rk && rk.userData && rk.userData.cxlOn);
        if (on !== d.dep.on) { el.style.display = 'none'; return; }
        el.style.display = '';
      }
      _v3.copy(d.p).project(camera);
      if (_v3.z > 1) { el.style.opacity = '0'; return; }
      el.style.opacity = '1';
      /* ox/oy 为像素级微调：背面机架透视压缩后标注会挤在一起，用它拉开 */
      el.style.left = ((_v3.x + 1) / 2 * w + (d.ox || 0)) + 'px';
      el.style.top = ((-_v3.y + 1) / 2 * h + (d.oy || 0)) + 'px';
      if (d.id === selectedId) el.classList.add('sel'); else el.classList.remove('sel');
    });
  }

  /* ── 交互 ── */
  function wireEvents() {
    var dom = renderer.domElement;
    dom.addEventListener('pointermove', function (e) {
      var r = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    });
    dom.addEventListener('pointerup', function () {
      if (!raycaster || !root) return;
      raycaster.setFromCamera(pointer, camera);
      var groups = Object.keys(rackBodies).map(function (k) { return rackBodies[k]; }).concat([spineRef, ctrlRef, poolRef]);
      var hits = raycaster.intersectObjects(groups, true), id = null;
      for (var i = 0; i < hits.length && !id; i++) {
        var o = hits[i].object;
        while (o) { if (o.userData && o.userData.pick) { id = o.userData.pick.id; break; } o = o.parent; }
      }
      selectedId = id;
      if (opts.onSelect) opts.onSelect(id);
    });
  }

  /* ── 相机预设 ──
   * 机架占地：x ∈ ±[.67,1.29]，z ∈ ±[.49,1.35]，高 2.02。
   * 旧 preset 里 pool/ctrl 的射线会穿过前排机架（相机几乎贴到机架背面），
   * 这里统一退到环外并抬高视点：pool 走 x 轴通道，ctrl 用高角度俯瞰中心。
   */
  var CAM = {
    all:  { pos: [5.4, 4.1, 6.2], tgt: [0, 1.05, 0] },
    ctrl: { pos: [3.6, 4.2, 3.6], tgt: [0, 1.45, 0] },
    pool: { pos: [4.4, 2.0, 0], tgt: [0, .55, 0] },
    R1:   { pos: [-4.6, 3.4, 5.0], tgt: [-.98, 1.0, .92] },
    R2:   { pos: [4.6, 3.4, 5.0], tgt: [.98, 1.0, .92] },
    R3:   { pos: [-4.6, 3.4, -5.0], tgt: [-.98, 1.0, -.92] },
    R4:   { pos: [4.6, 3.4, -5.0], tgt: [.98, 1.0, -.92] }
  };
  function flyTo(k) {
    var c = CAM[k] || CAM.all;
    camTween = {
      t: 0, dur: REDUCED ? .02 : 1.1,
      p0: camera.position.clone(), p1: new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]),
      t0: controls.target.clone(), t1: new THREE.Vector3(c.tgt[0], c.tgt[1], c.tgt[2])
    };
  }

  function setCong(ids) {
    Object.keys(links).forEach(function (k) {
      var l = links[k];
      if (!l.mesh) return;
      var on = ids && ids.indexOf(k) >= 0;
      l.mesh.material.color.setHex(on ? C.hot : l.base);
      l.mesh.material.opacity = on ? .8 : .5;
      l.cong = !!on;
    });
  }

  function resize() {
    if (!renderer || !host) return;
    var w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    var dt = M.min(.05, clock.getDelta()), t = clock.elapsedTime;

    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1.4) {
      if (!degraded && fpsN / fpsAcc < 32 && dpr > 1) { degraded = true; dpr = 1; renderer.setPixelRatio(1); }
      fpsAcc = 0; fpsN = 0;
    }

    if (camTween) {
      camTween.t += dt / M.max(.02, camTween.dur);
      var k = camTween.t >= 1 ? 1 : ease(camTween.t);
      camera.position.lerpVectors(camTween.p0, camTween.p1, k);
      controls.target.lerpVectors(camTween.t0, camTween.t1, k);
      if (camTween.t >= 1) camTween = null;
    }
    tickTweens(dt);

    if (ctrlRef) {
      ctrlRef.traverse(function (o) {
        if (o.userData.spin) o.rotation.z += dt * o.userData.spin;
      });
      if (ctrlRef.userData.pulseT > 0) {
        ctrlRef.userData.pulseT -= dt;
        ctrlRef.scale.setScalar(1 + .09 * M.sin(t * 9));
      } else ctrlRef.scale.setScalar(1);
    }
    if (window.__GLCLUSTER_FX__) window.__GLCLUSTER_FX__.tick(dt, t);
    Object.keys(links).forEach(function (k) {
      var l = links[k];
      if (l.cong && l.mesh) l.mesh.material.opacity = .45 + .4 * M.abs(M.sin(t * 5));
    });

    updateLabels();
    controls.update();
    renderer.render(scene, camera);
  }

  window.__GLCLUSTER__ = {
    available: true,
    ctx: CTX,
    mount: function (el, o) {
      host = el; opts = o || {};
      initScene();
      resize();
      if (window.__GLCLUSTER_FX__) window.__GLCLUSTER_FX__.init(CTX);
      flyTo('all');
      running = true;
      animate();
    },
    applyStep: function (act, done) {
      setCong([]);
      if (window.__GLCLUSTER_FX__) window.__GLCLUSTER_FX__.applyStep(act, done);
      else if (done) done();
    },
    /* 部署状态同步：ids = 已部署 CXL 的机架 id 数组。
       与 2D 总览共用 STATE.deployment —— 决策变化时两个视图一起变（生长/收回动画）。 */
    setDeploy: function (ids, animate) {
      var target = {};
      (ids || []).forEach(function (id) { target[id] = 1; });
      Object.keys(rackBodies).forEach(function (id) {
        var g = rackBodies[id], ud = g.userData;
        if (!ud.cxlParts) return;
        var on = !!target[id];
        if (ud.cxlOn === on) return;
        ud.cxlOn = on;
        var parts = ud.cxlParts, blind = ud.blindParts;
        if (ud.tagC && ud.tagR) { ud.tagC.visible = on; ud.tagR.visible = !on; }
        if (!animate || REDUCED) {
          parts.visible = on; parts.scale.y = on ? 1 : .001;
          if (blind) blind.visible = !on;
          return;
        }
        if (on) {
          parts.visible = true; parts.scale.y = .001;
          if (blind) blind.visible = false;
          addTween(.7, function (k) { parts.scale.y = M.max(.001, k); });
        } else {
          if (blind) blind.visible = true;
          addTween(.5, function (k) { parts.scale.y = M.max(.001, 1 - k); },
            function () { if (!ud.cxlOn) parts.visible = false; });
        }
      });
    },
    deployState: function () {
      return Object.keys(rackBodies).filter(function (id) {
        return rackBodies[id].userData && rackBodies[id].userData.cxlOn;
      });
    },
    flyTo: flyTo,
    select: function (id) { selectedId = id; },
    setCong: setCong,
    toggleLabels: function (on) { if (labelLayer) labelLayer.style.display = on ? 'block' : 'none'; },
    resize: resize,
    dispose: function () { running = false; if (renderer) renderer.dispose(); }
  };
})();
