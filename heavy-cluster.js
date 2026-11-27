/* ============================================================
 * heavy-cluster.js — 02 集群总览 · 重型三维集群（v2 语义修正）
 *
 * 机架只有两种身份：
 *   R1 / R3 = CXL + RDMA（增量部署：GPU 服务器 + CXL Switch + 共享 MHD）
 *   R2 / R4 = RDMA only（存量机架：GPU 服务器 + 本地 DRAM）
 *
 * S1–S4 是【运行场景】，不是机架角色；切换场景只改变数据/信息怎么流动：
 *   S1 本地 CXL 优势        R1 柜内 GPU → MHD（青绿）
 *   S2 突发 KV → 原生 RDMA  R2 ↔ R4 共享本地 DRAM（蓝）
 *   S3 原生池过载 → 兜底    R2/R4 溢出到 R1/R3 的 MHD（橙）
 *   S4 全域长上下文 → 复制  R1/R3 的 KV 复制到全部机架（紫）
 *
 * 交互：点击机架先出信息卡（不直接跳转），卡上按钮才进 03 机架解剖。
 * 复用全局 THREE + OrbitControls，不引入 ES Module / 后处理。
 * ============================================================ */
window.HEAVY_CLUSTER = (function () {
  'use strict';

  var THREE = window.THREE;
  if (!THREE) return { available: false, mount: function () {}, unmount: function () {} };

  var C = {
    cxl: 0x53e3c4, rdma: 0x5f9fe8, move: 0xe6a056, copy: 0xa38bf2,
    ctl: 0xe4b66b, cyan: 0x91e4ff
  };

  var host = null, renderer = null, scene = null, camera = null, controls = null;
  var clock = null, running = false, rafId = 0, inited = false;
  var racks = [], rackMap = {}, clickable = [], labelEls = [], labelDefs = [];
  var labelLayer = null, hub = null, radar = null, flowGroup = null, ctlGroup = null;
  var onJumpCb = null, raycaster, pointer = new THREE.Vector2(), glowTex = null;
  var scenario = 'S1', selected = null;
  var ui = {};

  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var SCEN = {
    S1: { tag: '本地 CXL 优势', desc: 'KV 生产与消费都在同一机架内，走柜内 CXL 直连 MHD，完全绕开 RDMA 网络。', racks: ['R1'] },
    S2: { tag: '突发 KV → 原生 RDMA', desc: '访问突发、KV 需求超过本地容量时，直接用存量 RDMA 共享各机架本地 DRAM。', racks: ['R2', 'R4'] },
    S3: { tag: '原生池过载 → CXL 兜底', desc: 'R2/R4 的原生内存池放不下，溢出部分兜底写入 R1/R3 的共享 MHD。', racks: ['R2', 'R4', 'R1', 'R3'] },
    S4: { tag: '全域长上下文 → 迁移复制', desc: '长上下文被所有机架共用；初始落在 CXL 节点，随后复制到其它机架就近访问。', racks: ['R1', 'R3', 'R2', 'R4'] }
  };

  var RACK_DEF = [
    { id: 'R1', cxl: true, pos: [-3.9, 0, 3.3] },
    { id: 'R2', cxl: false, pos: [3.9, 0, 3.3] },
    { id: 'R3', cxl: true, pos: [-3.9, 0, -3.3] },
    { id: 'R4', cxl: false, pos: [3.9, 0, -3.3] }
  ];

  /* ── 光晕贴图 ── */
  function glowTexture() {
    if (glowTex) return glowTex;
    var cv = document.createElement('canvas'); cv.width = cv.height = 128;
    var x = cv.getContext('2d');
    var g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(.32, 'rgba(255,255,255,.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(64, 64, 64, 0, Math.PI * 2); x.fill();
    glowTex = new THREE.Texture(cv); glowTex.needsUpdate = true;
    return glowTex;
  }
  function glowSprite(color, size, opacity) {
    var s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: color, transparent: true,
      opacity: opacity == null ? .6 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    s.scale.set(size, size, 1);
    return s;
  }

  /* ── 初始化 ── */
  function init() {
    if (inited) return;
    inited = true;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030711);
    scene.fog = new THREE.FogExp2(0x030711, 0.018);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.16;
    host.appendChild(renderer.domElement);

    camera = new THREE.PerspectiveCamera(34, 1, .1, 260);
    camera.position.set(11.5, 17.5, 13.5);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = .05;
    controls.maxPolarAngle = Math.PI / 2.02;
    controls.minDistance = 8;
    controls.maxDistance = 42;
    controls.target.set(0, 1.6, 0);

    try {
      if (window.__GLUTILS__) {
        var U = window.__GLUTILS__(THREE);
        scene.environment = U.makeEnv(renderer);
        if ('environmentIntensity' in scene) scene.environmentIntensity = .5;
      }
    } catch (e) {}

    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();
    flowGroup = new THREE.Group(); scene.add(flowGroup);
    ctlGroup = new THREE.Group(); scene.add(ctlGroup);

    /* ?hs=S3 直达某个运行场景 */
    try {
      var q = new URLSearchParams(location.search).get('hs');
      if (q && SCEN[q]) scenario = q;
    } catch (e) {}

    buildEnvironment();
    buildHub();
    buildRacks();
    buildControlLinks();
    ensureLabels();
    buildUI();
    wireEvents();
    applyScenario(scenario, true);
  }

  /* ── 环境 ── */
  function buildEnvironment() {
    scene.add(new THREE.AmbientLight(0x1e293b, 1.1));
    var key = new THREE.DirectionalLight(0x38bdf8, 1.5);
    key.position.set(12, 22, 14); scene.add(key);
    var warm = new THREE.DirectionalLight(0xe6a056, .25);
    warm.position.set(-14, 9, -10); scene.add(warm);

    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x050b16, roughness: .2, metalness: .86 })
    );
    floor.rotation.x = -Math.PI / 2; scene.add(floor);

    var grid = new THREE.GridHelper(140, 90, 0x0c4a6e, 0x081a30);
    grid.position.y = .012;
    grid.material.transparent = true; grid.material.opacity = .24;
    scene.add(grid);

    var bgMat = new THREE.MeshBasicMaterial({ color: 0x081222, transparent: true, opacity: .72 });
    for (var i = -4; i <= 4; i++) {
      if (Math.abs(i) < 2) continue;
      var h = 4.4 + (Math.abs(i) % 3) * 1.1;
      var sil = new THREE.Mesh(new THREE.BoxGeometry(2.3, h, 2.0), bgMat);
      sil.position.set(i * 4.6, h / 2, -13.5);
      scene.add(sil);
    }
  }

  /* ── 中央调度器 ── */
  function buildHub() {
    hub = new THREE.Group(); scene.add(hub);

    var base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.8, .4, 8),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: .9, roughness: .26 })
    );
    base.position.y = .2; hub.add(base);

    var ring = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 1.72, 48),
      new THREE.MeshBasicMaterial({ color: C.cyan, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = .42; hub.add(ring);

    var core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(.8, 1),
      new THREE.MeshBasicMaterial({ color: C.cyan, wireframe: true, transparent: true, opacity: .8 })
    );
    core.position.y = 1.75;

    var inner = new THREE.Mesh(
      new THREE.SphereGeometry(.4, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    inner.position.y = 1.75;

    var r1 = new THREE.Mesh(new THREE.TorusGeometry(1.05, .028, 10, 56),
      new THREE.MeshBasicMaterial({ color: C.cxl }));
    r1.position.y = 1.75;
    var r2 = new THREE.Mesh(new THREE.TorusGeometry(1.22, .022, 10, 56),
      new THREE.MeshBasicMaterial({ color: C.rdma }));
    r2.position.y = 1.75; r2.rotation.x = Math.PI / 3;

    hub.add(core, inner, r1, r2);
    hub.userData = { core: core, inner: inner, r1: r1, r2: r2 };

    var halo = glowSprite(C.cyan, 5.2, .45);
    halo.position.y = 1.75; hub.add(halo);

    radar = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.02, 64),
      new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: .5, side: THREE.DoubleSide })
    );
    radar.rotation.x = -Math.PI / 2; radar.position.y = .02; scene.add(radar);
  }

  /* ── 四台机柜 ── */
  function buildRacks() {
    RACK_DEF.forEach(function (def) {
      var g = new THREE.Group();
      g.position.set(def.pos[0], 0, def.pos[2]);
      scene.add(g);

      var accent = def.cxl ? C.cxl : C.rdma;

      var plinth = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, .3, 2.0),
        new THREE.MeshStandardMaterial({ color: 0x0b1220, metalness: .9, roughness: .3 })
      );
      plinth.position.y = .15; g.add(plinth);

      var foot = new THREE.Mesh(new THREE.BoxGeometry(2.04, .05, 2.04),
        new THREE.MeshBasicMaterial({ color: accent }));
      foot.position.y = .035; g.add(foot);

      var bodyGeo = new THREE.BoxGeometry(1.9, 3.9, 1.9);
      var body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
        color: 0x0a1420, metalness: .8, roughness: .26,
        transparent: true, opacity: def.cxl ? .64 : .76
      }));
      body.position.y = 2.25;
      body.userData.rackId = def.id;
      clickable.push(body);
      g.add(body);

      var edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(bodyGeo),
        new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: .9 })
      );
      edges.position.y = 2.25; g.add(edges);

      /* 4 台 4U 服务器 */
      var servers = [];
      for (var s = 0; s < 4; s++) {
        var sy = .78 + s * .78;
        var sv = new THREE.Group();
        sv.position.set(0, sy, 0);

        var chassis = new THREE.Mesh(
          new THREE.BoxGeometry(1.6, .62, 1.5),
          new THREE.MeshStandardMaterial({ color: 0x101c2a, metalness: .78, roughness: .34 })
        );
        sv.add(chassis);

        for (var b = 0; b < 6; b++) {
          var bay = new THREE.Mesh(
            new THREE.BoxGeometry(.2, .34, .03),
            new THREE.MeshStandardMaterial({ color: 0x16283a, metalness: .6, roughness: .5 })
          );
          bay.position.set(-.62 + b * .25, 0, .74);
          sv.add(bay);
        }

        var led = new THREE.Mesh(new THREE.BoxGeometry(.5, .035, .03),
          new THREE.MeshBasicMaterial({ color: accent }));
        led.position.set(.48, .22, .74);
        sv.add(led);

        g.add(sv);
        servers.push({ group: sv, led: led });
      }

      /* CXL 器件 */
      if (def.cxl) {
        var swY = .78 + 4 * .78 + .12;
        var sw = new THREE.Mesh(
          new THREE.BoxGeometry(1.55, .3, .9),
          new THREE.MeshStandardMaterial({ color: 0x123035, metalness: .7, roughness: .34,
            emissive: C.cxl, emissiveIntensity: .35 })
        );
        sw.position.set(0, swY, -.1); g.add(sw);

        var mhd = new THREE.Mesh(
          new THREE.BoxGeometry(1.55, .34, 1.1),
          new THREE.MeshStandardMaterial({ color: 0x0e2a28, metalness: .6, roughness: .3,
            emissive: C.cxl, emissiveIntensity: .45 })
        );
        mhd.position.set(0, swY + .48, -.1); g.add(mhd);

        var mhdGlow = glowSprite(C.cxl, 2.2, .38);
        mhdGlow.position.set(0, swY + .48, .4); g.add(mhdGlow);
      }

      var pl = new THREE.PointLight(accent, 3.6, 9);
      pl.position.set(0, 2.0, .6); g.add(pl);

      racks.push({ id: def.id, cxl: def.cxl, group: g, servers: servers, accent: accent,
        phase: Math.random() * 6 });
      rackMap[def.id] = g;

      labelDefs.push({
        id: def.id,
        p: new THREE.Vector3(def.pos[0], 4.35, def.pos[2]),
        title: def.id + (def.cxl ? ' · CXL + RDMA' : ' · RDMA ONLY'),
        sub: def.cxl ? '4× GPU 服务器 + CXL Switch + 共享 MHD' : '4× GPU 服务器 · 无 CXL 器件',
        color: accent
      });
    });
  }

  /* ── 控制面 ── */
  function buildControlLinks() {
    RACK_DEF.forEach(function (def) {
      var from = new THREE.Vector3(0, 1.9, 0);
      var to = new THREE.Vector3(def.pos[0] * .62, 4.1, def.pos[2] * .62);
      var curve = new THREE.CatmullRomCurve3([
        from,
        new THREE.Vector3(from.x + (to.x - from.x) * .5, 3.4, 0),
        to
      ]);
      var tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, .022, 8, false),
        new THREE.MeshBasicMaterial({ color: C.ctl, transparent: true, opacity: .45 })
      );
      ctlGroup.add(tube);
    });
  }

  /* ── 数据流 ── */
  function clearFlows() {
    while (flowGroup.children.length) {
      var c = flowGroup.children.pop();
      c.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }

  function tube(points, color, radius, opacity) {
    var curve = new THREE.CatmullRomCurve3(points.map(function (p) {
      return new THREE.Vector3(p[0], p[1], p[2]);
    }));
    var group = new THREE.Group();

    var outer = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 36, radius, 12, false),
      new THREE.MeshStandardMaterial({
        color: color, metalness: .1, roughness: .14, transparent: true,
        opacity: opacity == null ? .3 : opacity, emissive: color, emissiveIntensity: .3,
        side: THREE.DoubleSide
      })
    );
    var core = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 36, radius * .45, 8, false),
      new THREE.MeshBasicMaterial({ color: color })
    );
    group.add(outer, core);

    [0, 1].forEach(function (t) {
      var fl = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 1.5, radius * 1.5, .14, 12),
        new THREE.MeshStandardMaterial({ color: 0x334155, metalness: .9, roughness: .28 })
      );
      fl.position.copy(curve.getPointAt(t));
      group.add(fl);
    });

    var parts = [], pGeo = new THREE.SphereGeometry(radius * .6, 8, 8);
    var pMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (var i = 0; i < 6; i++) {
      var m = new THREE.Mesh(pGeo, pMat);
      group.add(m);
      parts.push({ mesh: m, t: i / 6 });
    }

    group.userData.flow = { curve: curve, particles: parts, speed: .012 + radius * .03 };
    flowGroup.add(group);
    return group;
  }

  function rackPt(id, kind) {
    var g = rackMap[id];
    if (!g) return new THREE.Vector3();
    var p = g.position;
    if (kind === 'mhd') return new THREE.Vector3(p.x, 4.1, p.z + .3);
    return new THREE.Vector3(p.x, 1.3, p.z + .55);
  }

  function applyScenario(id, silent) {
    scenario = SCEN[id] ? id : 'S1';
    clearFlows();

    var R1 = rackPt('R1'), R2 = rackPt('R2'), R3 = rackPt('R3'), R4 = rackPt('R4');

    if (scenario === 'S1') {
      tube([[R1.x, 1.5, R1.z + .72], [R1.x, 2.7, R1.z + .56], [R1.x, 3.95, R1.z + .35]], C.cxl, .1);
    } else if (scenario === 'S2') {
      tube([[R2.x, .55, R2.z - .7], [R2.x, .3, 1.2], [0, .3, .35], [R4.x, .3, -1.2], [R4.x, .55, R4.z + .7]], C.rdma, .12);
    } else if (scenario === 'S3') {
      tube([[R2.x, .6, R2.z - .6], [R2.x, .32, .6], [R1.x, .32, .6], [R1.x, 1.3, R1.z + .5], [R1.x, 3.6, R1.z + .35]], C.move, .11);
      tube([[R4.x, .6, R4.z + .6], [R4.x, .32, -.6], [R3.x, .32, -.6], [R3.x, 1.3, R3.z + .5], [R3.x, 3.6, R3.z + .35]], C.move, .11);
    } else {
      tube([[R1.x, 3.95, R1.z + .3], [R1.x, 4.7, 0], [R2.x, 4.7, 0], [R2.x, 3.6, R2.z + .3]], C.copy, .1);
      tube([[R3.x, 3.95, R3.z + .3], [R3.x, 4.7, 0], [R4.x, 4.7, 0], [R4.x, 3.6, R4.z + .3]], C.copy, .1);
      tube([[R1.x, 4.2, R1.z], [0, 4.9, 0], [R3.x, 4.2, R3.z]], C.copy, .08);
    }

    var act = SCEN[scenario].racks;
    racks.forEach(function (r) {
      var on = act.indexOf(r.id) >= 0;
      r.group.traverse(function (o) {
        if (o.isPointLight) o.intensity = on ? 4.4 : 1.3;
      });
      r.servers.forEach(function (s) {
        s.led.material.opacity = on ? 1 : .45;
        s.led.material.transparent = true;
      });
    });

    if (!silent) updateUI();
  }

  /* ── 标签 ── */
  function ensureLabels() {
    if (labelLayer || !host) return;
    labelLayer = document.createElement('div');
    labelLayer.className = 'hv-labels';
    host.appendChild(labelLayer);
    labelDefs.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'hv-lbl';
      el.style.borderColor = '#' + ('000000' + d.color.toString(16)).slice(-6);
      el.innerHTML = '<b>' + d.title + '</b><i>' + d.sub + '</i>';
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

  /* ── 舞台 UI ── */
  function buildUI() {
    var wrap = document.createElement('div');
    wrap.className = 'hv-ui';

    var tabs = document.createElement('div');
    tabs.className = 'hv-tabs';
    Object.keys(SCEN).forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hv-tab' + (k === scenario ? ' is-on' : '');
      b.setAttribute('data-scen', k);
      b.innerHTML = '<b>' + k + '</b><span>' + SCEN[k].tag + '</span>';
      b.addEventListener('click', function () { applyScenario(k); });
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    var cap = document.createElement('div');
    cap.className = 'hv-cap';
    wrap.appendChild(cap);

    var card = document.createElement('div');
    card.className = 'hv-card';
    card.innerHTML = '<div class="hv-card-h"><b id="hv-card-id">R1</b><span id="hv-card-tag">CXL + RDMA</span></div>' +
      '<ul id="hv-card-list"></ul>' +
      '<button type="button" class="hv-jump" id="hv-jump">打开 03 机架解剖 →</button>';
    wrap.appendChild(card);

    host.appendChild(wrap);
    ui.wrap = wrap; ui.cap = cap; ui.card = card;
    ui.cardId = card.querySelector('#hv-card-id');
    ui.cardTag = card.querySelector('#hv-card-tag');
    ui.cardList = card.querySelector('#hv-card-list');
    card.querySelector('#hv-jump').addEventListener('click', function () {
      if (selected && onJumpCb) onJumpCb(selected);
    });
    updateUI();
  }

  function updateUI() {
    if (!ui.cap) return;
    var s = SCEN[scenario];
    ui.cap.innerHTML = '<b>S' + (Object.keys(SCEN).indexOf(scenario) + 1) + ' · ' + s.tag + '</b><span>' + s.desc + '</span>';
    ui.wrap.querySelectorAll('.hv-tab').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-scen') === scenario);
    });
  }

  function showCard(id) {
    selected = id;
    var r = racks.filter(function (x) { return x.id === id; })[0];
    if (!r || !ui.card) return;
    ui.cardId.textContent = id;
    ui.cardTag.textContent = r.cxl ? 'CXL + RDMA · 增量部署' : 'RDMA ONLY · 存量机架';
    ui.cardTag.style.color = r.cxl ? '#53e3c4' : '#5f9fe8';
    var rows = r.cxl
      ? ['4 × GPU 服务器（4U）', '1 × CXL Switch（2 主机口）', '1 × 共享 MHD（池化内存）', '上行 RDMA 400G ×2']
      : ['4 × GPU 服务器（4U）', '本地 DRAM 池（RDMA 共享）', '无 CXL 器件', '上行 RDMA 400G ×2'];
    ui.cardList.innerHTML = rows.map(function (t) { return '<li>' + t + '</li>'; }).join('');
    ui.card.classList.add('is-on');
  }

  /* ── 交互 ── */
  function wireEvents() {
    var dom = renderer.domElement;
    dom.addEventListener('pointerdown', function (e) {
      var rect = dom.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      var hits = raycaster.intersectObjects(clickable, false);
      if (hits.length && hits[0].object.userData.rackId) showCard(hits[0].object.userData.rackId);
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

  /* ── 循环 ── */
  function animate() {
    if (!running) return;
    rafId = requestAnimationFrame(animate);
    clock.getDelta();
    var t = clock.elapsedTime;

    if (hub && hub.userData) {
      hub.userData.core.rotation.y = t * .6;
      hub.userData.inner.scale.setScalar(1 + Math.sin(t * 3.2) * .07);
      hub.userData.r1.rotation.z = t * .85;
      hub.userData.r2.rotation.y = -t * .65;
    }
    if (radar) {
      var k = (t * .32) % 1;
      radar.scale.setScalar(1 + k * 3.0);
      radar.material.opacity = .45 * (1 - k);
    }

    var act = SCEN[scenario].racks;
    racks.forEach(function (r) {
      var on = act.indexOf(r.id) >= 0;
      for (var i = 0; i < r.servers.length; i++) {
        var p = Math.sin(t * (on ? 3.4 : 1.2) + i * .8 + r.phase);
        r.servers[i].led.scale.y = .5 + .5 * (p * .5 + .5);
        r.servers[i].led.material.color.setHex(r.accent);
      }
    });

    flowGroup.children.forEach(function (g) {
      var f = g.userData.flow;
      if (!f) return;
      f.particles.forEach(function (p) {
        p.t = (p.t + f.speed) % 1;
        p.mesh.position.copy(f.curve.getPointAt(p.t));
      });
    });

    controls.update();
    renderer.render(scene, camera);
    updateLabels();
  }

  /* ── 对外 ── */
  function mount(el, opts) {
    host = el;
    onJumpCb = (opts && opts.onJump) || onJumpCb;
    init();
    resize();
    if (labelLayer) labelLayer.style.display = '';
    if (ui.wrap) ui.wrap.style.display = '';
    if (!running) { running = true; clock.start(); animate(); }
    return true;
  }
  function unmount() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (labelLayer) labelLayer.style.display = 'none';
    if (ui.wrap) ui.wrap.style.display = 'none';
  }
  function setScenario(id) { if (SCEN[id]) applyScenario(id); }

  return {
    available: true, mount: mount, unmount: unmount, resize: resize,
    setScenario: setScenario, isRunning: function () { return running; }
  };
})();
