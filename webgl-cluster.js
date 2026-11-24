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
    var g = new THREE.Group(), pos = RACK_POS[id], cxl = !!CXL_RACKS[id], pw = .04, i, k;

    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
      var p = U.box(pw, RH, pw, 'frame');
      p.position.set(s[0] * (RW / 2 - pw / 2) * .94, RH / 2, s[1] * (RD / 2 - pw / 2) * .94);
      g.add(p);
    });
    var cap = U.boxE(RW, .04, RD, 'frame', { color: 0x7fa2b5, opacity: .55 }); cap.position.y = RH - .02; g.add(cap);
    var base = U.boxE(RW, .05, RD, 'frameDark', { color: 0x6f93a6, opacity: .5 }); base.position.y = .025; g.add(base);
    var back = U.boxE(RW - .02, RH - .1, .006, 'glass', { color: 0x63a8bd, opacity: .22 });
    back.position.set(0, RH / 2, -RD / 2 + .01); g.add(back);
    [-1, 1].forEach(function (s) {
      var sd = U.boxE(.006, RH - .1, RD - .02, 'glass', { color: 0x63a8bd, opacity: .18 });
      sd.position.set(s * (RW / 2 - .01), RH / 2, 0); g.add(sd);
    });

    /* 4 台 4U 服务器 + 前面板 + LED */
    var shell = [], bays = [], leds = [], nodeY = {};
    [7, 11, 15, 19].forEach(function (u, i) {
      var ym = .056 + (u - 1) * UH + 2 * UH;
      shell.push({ p: [0, ym, .04] });
      nodeY['N' + (i + 1)] = ym;
      for (var b = 0; b < 10; b++) bays.push({ p: [-.16 + b * .0355, ym + .008, RD / 2 - .045] });
      leds.push({ p: [.215, ym + .006, RD / 2 - .042] });
    });
    g.add(U.inst(U.geoBox(RW - .12, 4 * UH - .006, RD - .1), 'chassis', shell));
    g.add(U.inst(U.geoBox(.03, .02, .006), 'tray', bays));
    g.add(U.inst(U.geoBox(.008, .006, .003), 'ledGreen', leds));

    /* ToR */
    var tor = U.boxE(RW - .1, .04, RD * .5, 'switchBody', { color: 0x5f9fe8, opacity: .55 });
    tor.position.set(0, .056 + 40 * UH, 0); g.add(tor);

    /* MHD / 空槽盲板 */
    var mhdY = .056 + 22 * UH + UH / 2;
    if (cxl) {
      var mh = U.boxE(RW - .12, 3 * UH - .006, RD - .14, 'mhdUnit', { color: 0x53e3c4, opacity: .92 });
      mh.userData.mesh.material.emissive.setHex(C.cxl);
      mh.userData.mesh.material.emissiveIntensity = .6;
      mh.position.set(0, mhdY, .04); g.add(mh);
      var ml = [];
      for (i = 0; i < 4; i++) ml.push({ p: [-.14 + i * .07, mhdY, RD / 2 - .042] });
      g.add(U.inst(U.geoBox(.01, .006, .003), 'ledCxl', ml));
    } else {
      var blk = [];
      for (var u = 23; u <= 25; u++) blk.push({ p: [0, .056 + (u - 1) * UH + UH / 2, RD / 2 - .05] });
      g.add(U.inst(U.geoBox(RW - .13, .032, .006), 'frameDark', blk));
    }

    /* 其余空 U 盲板 */
    var used = [[7, 22], [23, 25], [40, 41]], blanks = [];
    for (var uu = 2; uu <= 39; uu++) {
      var hit = false;
      for (k = 0; k < used.length; k++) if (uu >= used[k][0] && uu <= used[k][1]) { hit = true; break; }
      if (hit) continue;
      blanks.push({ p: [0, .056 + (uu - 1) * UH + UH / 2, RD / 2 - .05] });
    }
    if (blanks.length) g.add(U.inst(U.geoBox(RW - .14, .03, .005), 'frameDark', blanks));

    var tag = U.decal(id + ' · ' + (cxl ? 'CXL+RDMA' : 'RDMA-only'), .3, .055, cxl ? '#7ff0d3' : '#8fb9c6', 28);
    tag.position.set(0, RH + .1, .26); g.add(tag);

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
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050b10, .048);
    envMap = U.makeEnv(renderer);
    scene.environment = envMap;
    if ('environmentIntensity' in scene) scene.environmentIntensity = .6;

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

    scene.add(new THREE.HemisphereLight(0x2a4a5c, 0x04080c, .7));
    var key = new THREE.DirectionalLight(0xcfe9ff, 1.8);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -.0015;
    var sc = key.shadow.camera; sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5; sc.far = 24;
    scene.add(key);
    var warm = new THREE.DirectionalLight(C.move, .38); warm.position.set(-6, 3, -5); scene.add(warm);
    var ctl = new THREE.PointLight(C.cyan, 2.2, 7, 2); ctl.position.set(0, CTRL_Y + .2, 0); scene.add(ctl);

    var floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: 0x04090d, metalness: .3, roughness: .85 }));
    floor.rotation.x = -M.PI / 2; floor.receiveShadow = true; scene.add(floor);
    var sheen = new THREE.Mesh(new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: U.floorTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .5 }));
    sheen.rotation.x = -M.PI / 2; sheen.position.y = .001; scene.add(sheen);
    var grid = new THREE.GridHelper(16, 32, 0x1c4050, 0x0b1922);
    grid.position.y = .002; grid.material.transparent = true; grid.material.opacity = .3; scene.add(grid);

    root = new THREE.Group(); scene.add(root);
    fx = new THREE.Group(); scene.add(fx);
    raycaster = new THREE.Raycaster();
    clock = new THREE.Clock();
    GLOW = glowTexture();

    ['R1', 'R2', 'R3', 'R4'].forEach(function (id) {
      var r = slimRack(id); root.add(r); rackBodies[id] = r;
    });

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
    labelEls = labelDefs.map(function (d) {
      var el = document.createElement('div');
      el.className = 'gll-lbl'; el.textContent = d.txt;
      labelLayer.appendChild(el);
      return el;
    });
  }
  var _v3 = new THREE.Vector3();
  function updateLabels() {
    if (!labelLayer || !labelEls.length) return;
    var w = host.clientWidth, h = host.clientHeight;
    labelDefs.forEach(function (d, i) {
      _v3.copy(d.p).project(camera);
      var el = labelEls[i];
      if (_v3.z > 1) { el.style.opacity = '0'; return; }
      el.style.opacity = '1';
      el.style.left = ((_v3.x + 1) / 2 * w) + 'px';
      el.style.top = ((-_v3.y + 1) / 2 * h) + 'px';
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
    R1:   { pos: [-2.9, 2.6, 3.9], tgt: [-.98, 1.05, .92] },
    R2:   { pos: [2.9, 2.6, 3.9], tgt: [.98, 1.05, .92] },
    R3:   { pos: [-2.9, 2.6, -3.9], tgt: [-.98, 1.05, -.92] },
    R4:   { pos: [2.9, 2.6, -3.9], tgt: [.98, 1.05, -.92] }
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
    flyTo: flyTo,
    select: function (id) { selectedId = id; },
    setCong: setCong,
    toggleLabels: function (on) { if (labelLayer) labelLayer.style.display = on ? 'block' : 'none'; },
    resize: resize,
    dispose: function () { running = false; if (renderer) renderer.dispose(); }
  };
})();
