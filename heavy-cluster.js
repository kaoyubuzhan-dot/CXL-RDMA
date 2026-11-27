/* ============================================================
 * heavy-cluster.js — 02 集群总览 · 重型三维场景
 *
 * 按「大气磅礴」改造方案实现，但不引入 ES Module 与后处理：
 *   全局 THREE + 假泛光（发光 sprite + ACES 色调映射）
 *   · 34° 长焦镜头、镜面地板、FogExp2 深邃雾效
 *   · 4 台宽体重型机柜（承重底座 / 发光地脚 / 密集刀片 / 玻璃门）
 *   · 中央全息调度枢纽（八角底座 + 反向旋转陀螺环 + 雷达波纹）
 *   · 顶部重型跨接交换桥架
 *   · 双层法兰玻璃粗管道 + 高速流光粒子（替代单根细线）
 *   · 三色对撞：电光蓝（计算）/ 翡翠绿（CXL 池）/ 琥珀橙（迁移）
 *
 * API：HEAVY_CLUSTER.mount(el, {onRack}) / .unmount() / .available
 * ============================================================ */
window.HEAVY_CLUSTER = (function () {
  'use strict';

  var THREE = window.THREE;
  if (!THREE) {
    return { available: false, mount: function () {}, unmount: function () {} };
  }

  var host = null, renderer = null, scene = null, camera = null, controls = null;
  var clock = null, running = false, rafId = 0, inited = false;
  var racks = [], pipelines = [], clickable = [], labelEls = [], labelDefs = [];
  var labelLayer = null, hub = null, radar = null, onRackCb = null;
  var raycaster, pointer = new THREE.Vector2(), glowTex = null, envTex = null;
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var COL = { blue: 0x00a8ff, green: 0x00ff9d, orange: 0xff7b00, cyan: 0x00f0ff };

  /* ── 工具 ── */
  function glowTexture() {
    if (glowTex) return glowTex;
    var cv = document.createElement('canvas'); cv.width = cv.height = 128;
    var x = cv.getContext('2d');
    var g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(.35, 'rgba(255,255,255,.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(64, 64, 64, 0, Math.PI * 2); x.fill();
    glowTex = new THREE.Texture(cv); glowTex.needsUpdate = true;
    return glowTex;
  }
  function glowSprite(color, size, opacity) {
    var m = new THREE.SpriteMaterial({
      map: glowTexture(), color: color, transparent: true,
      opacity: opacity == null ? .75 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var s = new THREE.Sprite(m);
    s.scale.set(size, size, 1);
    return s;
  }

  /* ── 初始化 ── */
  function init() {
    if (inited) return;
    inited = true;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030711);
    scene.fog = new THREE.FogExp2(0x030711, 0.022);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    host.appendChild(renderer.domElement);

    camera = new THREE.PerspectiveCamera(34, 1, .1, 260);
    camera.position.set(15.0, 15.5, 17.0);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduced;
    controls.dampingFactor = .05;
    controls.maxPolarAngle = Math.PI / 2.12;
    controls.target.set(0, 1.9, 0);
    controls.minDistance = 6;
    controls.maxDistance = 40;

    /* 环境反射：有内置工具就用它生成，否则退化为纯灯光 */
    try {
      if (window.__GLUTILS__) {
        var U = window.__GLUTILS__(THREE);
        envTex = U.makeEnv(renderer);
        scene.environment = envTex;
        if ('environmentIntensity' in scene) scene.environmentIntensity = .55;
      }
    } catch (e) { envTex = null; }

    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();

    buildEnvironment();
    buildHub();
    buildRacksAndBridge();
    buildPipelines();
    ensureLabels();
    wireEvents();
  }

  /* ── 地板 / 雾 / 远景 ── */
  function buildEnvironment() {
    scene.add(new THREE.AmbientLight(0x1e293b, 1.05));

    var key = new THREE.DirectionalLight(0x38bdf8, 1.55);
    key.position.set(12, 22, 14);
    scene.add(key);

    var fill = new THREE.DirectionalLight(0xff7b00, .28);
    fill.position.set(-14, 8, -10);
    scene.add(fill);

    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x050b16, roughness: .18, metalness: .88 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = false;
    scene.add(floor);

    var grid = new THREE.GridHelper(140, 90, 0x0c4a6e, 0x081a30);
    grid.position.y = .012;
    grid.material.transparent = true;
    grid.material.opacity = .26;
    scene.add(grid);

    /* 远景机柜剪影：拉出纵深，避免背景空旷 */
    var bgMat = new THREE.MeshBasicMaterial({ color: 0x081222, transparent: true, opacity: .75 });
    for (var i = -4; i <= 4; i++) {
      if (Math.abs(i) < 2) continue;
      var h = 4.6 + (Math.abs(i) % 3) * 1.2;
      var sil = new THREE.Mesh(new THREE.BoxGeometry(2.4, h, 2.0), bgMat);
      sil.position.set(i * 4.6, h / 2, -13.5);
      scene.add(sil);
    }
  }

  /* ── 中央全息调度枢纽 ── */
  function buildHub() {
    hub = new THREE.Group();
    scene.add(hub);

    var base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.75, 2.05, .45, 8),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: .9, roughness: .26 })
    );
    base.position.y = .22;
    hub.add(base);

    var baseRing = new THREE.Mesh(
      new THREE.RingGeometry(1.85, 1.98, 48),
      new THREE.MeshBasicMaterial({ color: COL.cyan, side: THREE.DoubleSide })
    );
    baseRing.rotation.x = -Math.PI / 2;
    baseRing.position.y = .46;
    hub.add(baseRing);

    var core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(.95, 2),
      new THREE.MeshBasicMaterial({ color: COL.cyan, wireframe: true, transparent: true, opacity: .72 })
    );
    core.position.y = 2.1;

    var inner = new THREE.Mesh(
      new THREE.SphereGeometry(.5, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    inner.position.y = 2.1;

    var ring1 = new THREE.Mesh(
      new THREE.TorusGeometry(1.3, .032, 12, 64),
      new THREE.MeshBasicMaterial({ color: COL.green })
    );
    ring1.position.y = 2.1;

    var ring2 = new THREE.Mesh(
      new THREE.TorusGeometry(1.5, .024, 12, 64),
      new THREE.MeshBasicMaterial({ color: COL.blue })
    );
    ring2.position.y = 2.1;
    ring2.rotation.x = Math.PI / 3;

    hub.add(core, inner, ring1, ring2);
    hub.userData = { core: core, inner: inner, ring1: ring1, ring2: ring2 };

    /* 假泛光：枢纽整体挂一枚加色光晕 */
    var halo = glowSprite(0x38bdf8, 6.4, .5);
    halo.position.y = 2.1;
    hub.add(halo);

    /* 地面雷达波纹 */
    radar = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 2.34, 64),
      new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: .55, side: THREE.DoubleSide })
    );
    radar.rotation.x = -Math.PI / 2;
    radar.position.y = .02;
    scene.add(radar);
  }

  /* ── 四台重型机柜 + 顶部桥架 ── */
  function buildRacksAndBridge() {
    var cfg = [
      { id: 'R1', name: 'R1 · 计算节点 A', sub: 'LLM 推理集群 · 电光蓝', pos: [-3.8, 0, 3.2], color: COL.blue, pool: false },
      { id: 'R2', name: 'R2 · 计算节点 B', sub: 'LLM 推理集群 · 电光蓝', pos: [3.8, 0, -3.2], color: COL.blue, pool: false },
      { id: 'R3', name: 'R3 · 迁移热点', sub: 'RDMA KV 迁移中 · 琥珀橙', pos: [-3.8, 0, -3.2], color: COL.orange, pool: false },
      { id: 'R4', name: 'R4 · CXL MHD 池', sub: '8 TB 共享内存仓 · 翡翠绿', pos: [3.8, 0, 3.2], color: COL.green, pool: true }
    ];

    cfg.forEach(function (c) {
      var g = new THREE.Group();
      g.position.set(c.pos[0], c.pos[1], c.pos[2]);
      scene.add(g);

      /* 承重底座 + 发光地脚 */
      var plinth = new THREE.Mesh(
        new THREE.BoxGeometry(2.35, .35, 2.35),
        new THREE.MeshStandardMaterial({ color: 0x0b1220, metalness: .9, roughness: .3 })
      );
      plinth.position.y = .175; g.add(plinth);

      var underGlow = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, .06, 2.4),
        new THREE.MeshBasicMaterial({ color: c.color })
      );
      underGlow.position.y = .04; g.add(underGlow);

      /* 柜体：半透明钢化玻璃 */
      var bodyGeo = new THREE.BoxGeometry(2.15, 4.3, 2.15);
      var body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
        color: 0x09111e, metalness: .82, roughness: .24,
        transparent: true, opacity: c.pool ? .42 : .6
      }));
      body.position.y = 2.5;
      body.userData.rackId = c.id;
      clickable.push(body);
      g.add(body);

      var edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(bodyGeo),
        new THREE.LineBasicMaterial({ color: c.color, transparent: true, opacity: .85 })
      );
      edges.position.y = 2.5; g.add(edges);

      /* 密集刀片 / 内存模组 */
      var blades = [], layers = c.pool ? 7 : 10;
      var bGeo = new THREE.BoxGeometry(1.78, c.pool ? .28 : .18, 1.82);
      for (var i = 0; i < layers; i++) {
        var m = new THREE.Mesh(bGeo, new THREE.MeshStandardMaterial({
          color: 0x0f172a, emissive: c.color, emissiveIntensity: c.pool ? 1.3 : .95,
          metalness: .6, roughness: .35
        }));
        m.position.y = .78 + i * (3.6 / layers);
        g.add(m); blades.push(m);
      }

      var pl = new THREE.PointLight(c.color, 5.2, 11);
      pl.position.set(0, 2.2, 0); g.add(pl);

      var halo = glowSprite(c.color, 5.2, .34);
      halo.position.set(0, 4.35, 0); g.add(halo);

      racks.push({ id: c.id, group: g, blades: blades, color: c.color, pool: c.pool, phase: Math.random() * 6 });

      /* 顶部标签锚点 */
      labelDefs.push({ id: c.id, p: new THREE.Vector3(c.pos[0], 5.05, c.pos[2]), txt: c.name, sub: c.sub, color: c.color });
    });

    /* 重型跨接交换桥架 */
    var beam = new THREE.Mesh(
      new THREE.BoxGeometry(9.6, .36, 1.3),
      new THREE.MeshStandardMaterial({ color: 0x111c2e, metalness: .9, roughness: .26 })
    );
    beam.position.set(0, 5.35, 0); scene.add(beam);

    var neon = new THREE.Mesh(
      new THREE.BoxGeometry(9.4, .06, 1.34),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    neon.position.set(0, 5.19, 0); scene.add(neon);

    var beamGlow = glowSprite(0x38bdf8, 9.6, .22);
    beamGlow.position.set(0, 5.2, 0); scene.add(beamGlow);
  }

  /* ── 双层法兰玻璃管道 + 流光粒子 ── */
  function buildPipelines() {
    var cfg = [
      { pts: [[-3.8, .35, 2.1], [-2.2, .25, 1.6], [-1.3, .45, .8]], c: COL.blue, r: .14, sp: .012 },
      { pts: [[3.8, .35, -2.1], [2.2, .25, -1.6], [1.3, .45, -.8]], c: COL.blue, r: .14, sp: .012 },
      { pts: [[-3.8, .35, -2.1], [-2.2, .25, -1.6], [-1.3, .45, -.8]], c: COL.orange, r: .16, sp: .018 },
      { pts: [[1.3, .45, .8], [2.2, .25, 1.6], [3.8, .35, 2.1]], c: COL.green, r: .18, sp: .02 },
      { pts: [[-3.8, 4.65, 3.2], [-3.8, 5.2, .4]], c: COL.blue, r: .09, sp: .015 },
      { pts: [[-3.8, 4.65, -3.2], [-3.8, 5.2, -.4]], c: COL.orange, r: .09, sp: .015 },
      { pts: [[3.8, 4.65, -3.2], [3.8, 5.2, -.4]], c: COL.blue, r: .09, sp: .015 },
      { pts: [[3.8, 4.65, 3.2], [3.8, 5.2, .4]], c: COL.green, r: .09, sp: .015 }
    ];

    cfg.forEach(function (c) {
      var curve = new THREE.CatmullRomCurve3(c.pts.map(function (p) {
        return new THREE.Vector3(p[0], p[1], p[2]);
      }));

      var outer = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 40, c.r, 14, false),
        new THREE.MeshStandardMaterial({
          color: c.c, metalness: .1, roughness: .12,
          transparent: true, opacity: .26, side: THREE.DoubleSide,
          emissive: c.c, emissiveIntensity: .25
        })
      );
      scene.add(outer);

      var core = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 40, c.r * .46, 10, false),
        new THREE.MeshBasicMaterial({ color: c.c })
      );
      scene.add(core);

      /* 法兰接头 */
      [0, .5, 1].forEach(function (t) {
        var pos = curve.getPointAt(t);
        var fl = new THREE.Mesh(
          new THREE.CylinderGeometry(c.r * 1.5, c.r * 1.5, .18, 14),
          new THREE.MeshStandardMaterial({ color: 0x334155, metalness: .9, roughness: .26 })
        );
        fl.position.copy(pos);
        fl.rotation.x = Math.PI / 2;
        scene.add(fl);
      });

      /* 管口光晕 */
      [0, 1].forEach(function (t) {
        var s = glowSprite(c.c, c.r * 7, .5);
        s.position.copy(curve.getPointAt(t));
        scene.add(s);
      });

      /* 高速流光粒子 */
      var parts = [], pGeo = new THREE.SphereGeometry(c.r * .62, 8, 8);
      var pMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      for (var i = 0; i < 8; i++) {
        var m = new THREE.Mesh(pGeo, pMat);
        scene.add(m);
        parts.push({ mesh: m, t: i / 8 });
      }
      pipelines.push({ curve: curve, particles: parts, speed: c.sp });
    });
  }

  /* ── DOM 标签 ── */
  function ensureLabels() {
    if (labelLayer || !host) return;
    labelLayer = document.createElement('div');
    labelLayer.className = 'hv-labels';
    host.appendChild(labelLayer);
    labelDefs.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'hv-lbl';
      el.style.borderColor = '#' + ('000000' + d.color.toString(16)).slice(-6);
      el.innerHTML = '<b>' + d.txt + '</b><i>' + d.sub + '</i>';
      labelLayer.appendChild(el);
      labelEls.push(el);
    });
  }

  var _v = new THREE.Vector3();
  function updateLabels() {
    if (!labelLayer || !labelEls.length || !host) return;
    var w = host.clientWidth, h = host.clientHeight;
    labelDefs.forEach(function (d, i) {
      _v.copy(d.p).project(camera);
      var el = labelEls[i];
      if (_v.z > 1) { el.style.opacity = '0'; return; }
      el.style.opacity = '1';
      el.style.left = ((_v.x + 1) / 2 * w) + 'px';
      el.style.top = ((-_v.y + 1) / 2 * h) + 'px';
    });
  }

  /* ── 交互 ── */
  function wireEvents() {
    var dom = renderer.domElement;
    dom.addEventListener('click', function (e) {
      var rect = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      var hits = raycaster.intersectObjects(clickable, false);
      if (hits.length && hits[0].object.userData.rackId && onRackCb) {
        onRackCb(hits[0].object.userData.rackId);
      }
    });
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!renderer || !host) return;
    var w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ── 渲染循环 ── */
  function animate() {
    if (!running) return;
    rafId = requestAnimationFrame(animate);
    var dt = Math.min(.05, clock.getDelta());
    var t = clock.elapsedTime;

    var hd = hub && hub.userData;
    if (hd) {
      hd.core.rotation.y = t * .65;
      hd.inner.scale.setScalar(1 + Math.sin(t * 3.5) * .08);
      hd.ring1.rotation.z = t * .9;
      hd.ring2.rotation.y = -t * .7;
    }
    if (radar) {
      var k = (t * .35) % 1;
      radar.scale.setScalar(1 + k * 3.2);
      radar.material.opacity = .5 * (1 - k);
    }

    racks.forEach(function (r) {
      var freq = r.color === COL.orange ? 7.5 : 3.2;
      for (var i = 0; i < r.blades.length; i++) {
        var p = Math.sin(t * freq + i * .65 + r.phase);
        r.blades[i].material.emissiveIntensity = (r.pool ? 1.2 : .85) + p * .4;
      }
    });

    pipelines.forEach(function (pipe) {
      for (var i = 0; i < pipe.particles.length; i++) {
        var pt = pipe.particles[i];
        pt.t = (pt.t + pipe.speed) % 1;
        pt.mesh.position.copy(pipe.curve.getPointAt(pt.t));
      }
    });

    controls.update();
    renderer.render(scene, camera);
    updateLabels();
  }

  /* ── 对外 ── */
  function mount(el, opts) {
    if (!THREE) return false;
    host = el;
    onRackCb = (opts && opts.onRack) || onRackCb;
    init();
    resize();
    ensureLabels();
    if (labelLayer) labelLayer.style.display = '';
    if (!running) { running = true; clock.start(); animate(); }
    return true;
  }

  function unmount() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (labelLayer) labelLayer.style.display = 'none';
  }

  function setView(name) {
    if (!camera || !controls) return;
    var P = {
      iso: [[15.0, 15.5, 17.0], [0, 1.9, 0]],
      front: [[0, 7.0, 22], [0, 2.0, 0]],
      low: [[16.0, 3.4, 18.0], [0, 1.6, 0]],
      top: [[0.1, 18, 0.1], [0, 1.2, 0]]
    }[name] || [[11.5, 7.6, 13.5], [0, 1.8, 0]];
    camera.position.set(P[0][0], P[0][1], P[0][2]);
    controls.target.set(P[1][0], P[1][1], P[1][2]);
    controls.update();
  }

  return {
    available: true,
    mount: mount,
    unmount: unmount,
    resize: resize,
    setView: setView,
    isRunning: function () { return running; }
  };
})();
