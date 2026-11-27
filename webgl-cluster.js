/* ============================================================
 * webgl-cluster.js — KV 全生命周期页：四机柜三维集群（霓虹仿真版）
 *
 * 视觉目标（参考数字孪生大屏）：
 *   · 深色反射地面 + 发光网格 + 每个设备下方的彩色辉光盘
 *   · 机柜：暗色机身 + 前置 LED 点阵（CXL=霓虹绿 / RDMA=电光蓝）
 *           + 加色混合描边光框 + 顶部发光条
 *   · 中央控制器：光柱 + 双旋转环 + 线框全息核
 *   · MHD / 内存池：半透明全息壳（线框 + 加色面）
 *   · 流线：加粗发光管 + 端点箭头 + 移动光点（fx 模块负责）
 *
 * 2×2 机架：R1(后左 CXL) R2(后右 RDMA) / R3(前左 CXL) R4(前右 RDMA)
 * 特效见 webgl-cluster-fx.js（applyStep 驱动）
 * ============================================================ */
(function () {
  'use strict';
  if (!window.THREE || !window.__GLUTILS__) { window.__GLCLUSTER__ = { available: false }; return; }

  var THREE = window.THREE;
  var U = window.__GLUTILS__(THREE);

  /* 霓虹语义色：高饱和，形成强色彩冲击 */
  var C = {
    cxl: 0x00ffa8,   /* 本地 CXL / CXL 机架：霓虹绿 */
    rdma: 0x1f74ff,  /* RDMA 跨机架 / RDMA 机架：电光蓝（压低绿通道，防高亮泛白） */
    move: 0xff8c1a,  /* 迁移：警示橙 */
    copy: 0xb46bff,  /* 复制：电紫 */
    idle: 0x27404f,  /* 空闲：冷灰蓝 */
    mon: 0x00e5ff,   /* 采集信息流：亮青 */
    hot: 0xff4d4d,   /* 拥塞：告警红 */
    cyan: 0x00e5ff
  };

  var RACK_POS = { R1: { x: -.98, z: .92 }, R2: { x: .98, z: .92 }, R3: { x: -.98, z: -.92 }, R4: { x: .98, z: -.92 } };
  var CXL_RACKS = { R1: 1, R3: 1 };
  var RW = .62, RD = .86, RH = 2.02, UH = .0445, SPINE_Y = 2.42, CTRL_Y = 1.5, POOL_Y = .28;

  var host = null, renderer = null, scene = null, camera = null, controls = null;
  var root = null, fx = null, clock = null, running = false, envMap = null;
  var raycaster = null, pointer = new THREE.Vector2(), camTween = null;
  var rackBodies = {}, endpoints = {}, links = {}, spineRef = null, ctrlRef = null, poolRef = null;
  var labelEls = [], labelDefs = [], labelLayer = null, selectedId = null, opts = {};
  var dpr = 1, fpsAcc = 0, fpsN = 0, degraded = false, GLOW = null;
  var blinkMats = [], plateMats = [], holoGroups = [], coreRef = null;
  var post = null, ambient = [];
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

  var CTX = {
    THREE: THREE, U: U, C: C, RACK_POS: RACK_POS, CXL_RACKS: CXL_RACKS,
    RW: RW, RD: RD, RH: RH, UH: UH, SPINE_Y: SPINE_Y, CTRL_Y: CTRL_Y, POOL_Y: POOL_Y,
    getScene: function () { return scene; }, getRoot: function () { return root; },
    getFx: function () { return fx; }, getCamera: function () { return camera; },
    getEndpoints: function () { return endpoints; }, getLinks: function () { return links; },
    getRacks: function () { return rackBodies; }, getCtrl: function () { return ctrlRef; },
    glowTex: function () { return GLOW; }, REDUCED: REDUCED, clamp01: clamp01, ease: ease, M: M
  };

  /* ══════════ 程序化贴图：辉光 / 发光网格 / 彩色辉光盘 ══════════ */
  function glowTexture() {
    var cv = document.createElement('canvas'); cv.width = cv.height = 128;
    var x = cv.getContext('2d');
    var g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(64, 64, 64, 0, M.PI * 2); x.fill();
    var t = new THREE.Texture(cv); t.needsUpdate = true; return t;
  }
  function neonGridTexture() {
    var S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var x = cv.getContext('2d');
    x.fillStyle = '#000000'; x.fillRect(0, 0, S, S);
    x.strokeStyle = 'rgba(0,190,255,.85)';
    x.lineWidth = 1.4;
    x.shadowColor = 'rgba(0,229,255,.9)'; x.shadowBlur = 6;
    [0, S / 2].forEach(function (p) {
      x.beginPath(); x.moveTo(p + .5, 0); x.lineTo(p + .5, S); x.stroke();
      x.beginPath(); x.moveTo(0, p + .5); x.lineTo(S, p + .5); x.stroke();
    });
    x.shadowBlur = 0;
    x.strokeStyle = 'rgba(0,120,190,.28)';
    x.lineWidth = .8;
    for (var i = 0; i <= 8; i++) {
      var q = i * S / 8;
      x.beginPath(); x.moveTo(q + .5, 0); x.lineTo(q + .5, S); x.stroke();
      x.beginPath(); x.moveTo(0, q + .5); x.lineTo(S, q + .5); x.stroke();
    }
    var t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(10, 10);
    t.needsUpdate = true;
    return t;
  }
  function plateTexture() {
    var S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var x = cv.getContext('2d');
    var g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,.95)');
    g.addColorStop(.35, 'rgba(255,255,255,.4)');
    g.addColorStop(.75, 'rgba(255,255,255,.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    var t = new THREE.Texture(cv); t.needsUpdate = true; return t;
  }
  var PLATE_TEX = null;

  /* 场景背景：中心微亮的深空径向渐变（线性空间绘制，gamma 由合成 pass 统一还原） */
  function backdropTexture() {
    var cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
    var x = cv.getContext('2d');
    function lin(r, g, b) {
      return 'rgb(' + M.round(255 * M.pow(r / 255, 2.2)) + ',' +
        M.round(255 * M.pow(g / 255, 2.2)) + ',' + M.round(255 * M.pow(b / 255, 2.2)) + ')';
    }
    var g = x.createRadialGradient(256, 210, 40, 256, 230, 340);
    /* 视觉目标色：#0a1a28 → #05101b → #020810 → #010409（sRGB） */
    g.addColorStop(0, lin(10, 26, 40));
    g.addColorStop(.45, lin(5, 16, 27));
    g.addColorStop(.8, lin(2, 8, 16));
    g.addColorStop(1, lin(1, 4, 9));
    x.fillStyle = g; x.fillRect(0, 0, 512, 512);
    var t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  }

  function additive(matOpts) {
    return new THREE.MeshBasicMaterial(Object.assign({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    }, matOpts));
  }
  function glowPlate(color, w, d, y, op) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
      additive({ map: PLATE_TEX, color: color, opacity: op != null ? op : .55 }));
    m.rotation.x = -M.PI / 2;
    m.position.y = y != null ? y : .004;
    plateMats.push(m.material);
    return m;
  }
  function edgeFrame(w, h, d, color, op) {
    var eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d), 1);
    var ls = new THREE.LineSegments(eg, additive({ color: color, opacity: op != null ? op : .6 }));
    ls.raycast = function () {};
    return ls;
  }
  function holoShell(w, h, d, color) {
    var g = new THREE.Group();
    g.add(edgeFrame(w, h, d, color, .9));
    var planeMat = additive({ color: color, opacity: .07, side: THREE.DoubleSide });
    var sides = [
      [w, h, 0, 0, d / 2, 0], [w, h, 0, 0, -d / 2, 0],
      [0, h, d, w / 2, 0, 0], [0, h, d, -w / 2, 0, 0],
      [w, 0, d, 0, h / 2, 0]
    ];
    sides.forEach(function (s) {
      var pw = s[0] || w, ph = s[1] || h, pd = s[2] || d;
      var geo = s[1] === 0 ? new THREE.PlaneGeometry(pw, pd) : new THREE.PlaneGeometry(pw, ph);
      var mesh = new THREE.Mesh(geo, planeMat);
      if (s[1] === 0) mesh.rotation.x = -M.PI / 2;
      else if (s[2] === 0 && s[0] === 0) mesh.rotation.y = M.PI / 2;
      mesh.position.set(s[3], s[4], s[5]);
      mesh.raycast = function () {};
      g.add(mesh);
    });
    holoGroups.push(g);
    return g;
  }

  /* ══════════ 机柜（霓虹版） ══════════ */
  function slimRack(id) {
    var g = new THREE.Group(), pos = RACK_POS[id], cxl = !!CXL_RACKS[id];
    var neon = cxl ? C.cxl : C.rdma;
    var pw = .04, i, u;

    /* 暗色框架 */
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
      var p = U.box(pw, RH, pw, 'frameDark');
      p.position.set(s[0] * (RW / 2 - pw / 2) * .94, RH / 2, s[1] * (RD / 2 - pw / 2) * .94);
      g.add(p);
    });
    var cap = U.box(RW, .04, RD, 'frameDark'); cap.position.y = RH - .02; g.add(cap);
    var base = U.box(RW, .05, RD, 'frameDark'); base.position.y = .025; g.add(base);

    /* 深色玻璃（低透明度，衬托 LED） */
    var back = U.boxE(RW - .02, RH - .1, .006, 'glass', { color: 0x0a2430, opacity: .18 });
    back.position.set(0, RH / 2, -RD / 2 + .01); g.add(back);
    [-1, 1].forEach(function (s) {
      var sd = U.boxE(.006, RH - .1, RD - .02, 'glass', { color: 0x0a2430, opacity: .14 });
      sd.position.set(s * (RW / 2 - .01), RH / 2, 0); g.add(sd);
    });

    /* 机身暗壳 */
    var shell = [], nodeY = {};
    [7, 11, 15, 19].forEach(function (u0, k) {
      var ym = .056 + (u0 - 1) * UH + 2 * UH;
      shell.push({ p: [0, ym, .02] });
      nodeY['N' + (k + 1)] = ym;
    });
    g.add(U.inst(U.geoBox(RW - .14, 4 * UH - .008, RD - .16), 'chip', shell));

    /* 前置 LED 点阵：稳亮 + 闪烁两层（低密度，保留刀片暗色间隙 → 点阵感） */
    var steady = [], blink = [];
    [7, 11, 15, 19].forEach(function (u0) {
      var y0 = .056 + (u0 - 1) * UH;
      for (var r = 0; r < 4; r++) {
        for (var c = 0; c < 9; c++) {
          var item = { p: [-.18 + c * .045, y0 + .016 + r * .0095, RD / 2 - .075] };
          if ((r * 9 + c + u0) % 5 === 0) blink.push(item); else steady.push(item);
        }
      }
    });
    var ledMat = new THREE.MeshStandardMaterial({
      color: 0x06131a, metalness: .2, roughness: .4, emissive: neon, emissiveIntensity: 1.05
    });
    g.add(U.inst(U.geoBox(.015, .0045, .004), ledMat, steady));
    var blinkMat = new THREE.MeshStandardMaterial({
      color: 0x06131a, metalness: .2, roughness: .4, emissive: neon, emissiveIntensity: 1.7
    });
    blinkMat.userData.phase = M.random() * 6;
    blinkMats.push(blinkMat);
    g.add(U.inst(U.geoBox(.016, .005, .004), blinkMat, blink));

    /* 顶部发光条 */
    var topStrip = new THREE.Mesh(new THREE.BoxGeometry(RW - .1, .006, .02),
      new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: neon, emissiveIntensity: 1.0 }));
    topStrip.position.set(0, RH - .005, RD / 2 - .06);
    g.add(topStrip);

    /* 描边光框 + 底部辉光盘 */
    var frame = edgeFrame(RW, RH, RD, neon, .5);
    frame.position.y = RH / 2;
    g.add(frame);
    var plate = glowPlate(neon, RW * 1.9, RD * 1.7, .005, .38);
    g.add(plate);
    /* 部署切换时随 cxlOn 换色的装饰材质：LED 点阵 / 闪烁层 / 顶部条 / 光框 / 辉光盘 */
    g.userData.decoMats = [ledMat, blinkMat, topStrip.material, frame.material, plate.material];

    /* ToR（发光条 + 端口灯） */
    var tor = U.box(RW - .1, .04, RD * .5, 'chip');
    tor.position.set(0, .056 + 40 * UH, 0); g.add(tor);
    var torLed = new THREE.Mesh(new THREE.BoxGeometry(RW - .14, .005, .006),
      new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.rdma, emissiveIntensity: 1.4 }));
    torLed.position.set(0, .056 + 40 * UH + .024, RD * .25 - .02);
    g.add(torLed);

    /* MHD / 空槽盲板：每台机架同时构建 CXL 硬件组与盲板组，
       由 setDeploy 按部署状态切换显隐（带生长动画）——
       这样"增量部署决策"变化时，三维集群与 2D 总览一起变 */
    var mhdY = .056 + 22 * UH + UH / 2;
    var gx = new THREE.Group();          /* CXL 硬件组（MHD + 全息壳 + LED + Switch + 容量条） */
    gx.scale.y = .001; gx.visible = false;
    var gb = new THREE.Group();          /* RDMA-only 盲板组 */
    {
      var mh = U.boxE(RW - .12, 3 * UH - .006, RD - .14, 'mhdUnit', { color: 0x06382c, opacity: .95 });
      mh.userData.mesh.material.emissive.setHex(C.cxl);
      mh.userData.mesh.material.emissiveIntensity = .85;
      mh.position.set(0, mhdY, .04); gx.add(mh);
      var holo = holoShell(RW - .1, 3 * UH + .02, RD - .12, C.cxl);
      holo.position.set(0, mhdY, .04);
      gx.add(holo);
      var ml = [];
      for (i = 0; i < 6; i++) ml.push({ p: [-.16 + i * .064, mhdY - .05, RD / 2 - .07] });
      var mlMat = new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.cxl, emissiveIntensity: 1.6 });
      gx.add(U.inst(U.geoBox(.012, .006, .004), mlMat, ml));

      /* CXL Switch：主机端口汇聚 → MHD */
      var swY = .056 + 26 * UH;
      var sw = U.boxE(RW - .16, 1.6 * UH, RD - .24, 'chip', { color: 0x06382c, opacity: .9 });
      sw.userData.mesh.material.emissive.setHex(C.cxl);
      sw.userData.mesh.material.emissiveIntensity = .5;
      sw.position.set(0, swY, .02); gx.add(sw);
      var swLeds = [];
      for (i = 0; i < 6; i++) swLeds.push({ p: [-.13 + i * .052, swY + .014, RD / 2 - .1] });
      var swLedMat = new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.cxl, emissiveIntensity: 1.6 });
      gx.add(U.inst(U.geoBox(.008, .005, .003), swLedMat, swLeds));

      /* MHD 容量条：R1 约 320/512，R3 约 192/512 */
      var capW = RW - .18;
      var usedR = (id === 'R3') ? .375 : .625;
      var capBg = U.box(capW, .014, .004, 'frameDark');
      capBg.position.set(0, mhdY - 1.16 * UH, RD / 2 - .012); gx.add(capBg);
      var capFill = new THREE.Mesh(new THREE.BoxGeometry(capW * usedR, .014, .006),
        new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.cxl, emissiveIntensity: 1.3 }));
      capFill.position.set(-capW * (1 - usedR) / 2, mhdY - 1.16 * UH, RD / 2 - .009); gx.add(capFill);
      var mhdTag = U.decal('MHD ' + (id === 'R3' ? '192' : '320') + '/512', .24, .032, '#c9fff2', 30);
      mhdTag.position.set(0, mhdY + .062, RD / 2 - .006); gx.add(mhdTag);
      var tagBg = U.box(.27, .046, .003, 'frameDark');
      tagBg.position.set(0, mhdY + .059, RD / 2 - .012); gx.add(tagBg);
    }
    {
      var blk = [];
      for (u = 23; u <= 25; u++) blk.push({ p: [0, .056 + (u - 1) * UH + UH / 2, RD / 2 - .06] });
      gb.add(U.inst(U.geoBox(RW - .13, .032, .006), 'frameDark', blk));
      var dim = new THREE.Mesh(new THREE.BoxGeometry(RW - .16, .004, .006),
        new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.idle, emissiveIntensity: 1.1 }));
      dim.position.set(0, mhdY, RD / 2 - .07);
      gb.add(dim);
    }
    g.add(gx); g.add(gb);
    gx.visible = !!cxl; gx.scale.y = cxl ? 1 : .001;
    gb.visible = !cxl;
    g.userData.cxlParts = gx;
    g.userData.blindParts = gb;
    g.userData.cxlOn = !!cxl;

    /* 其余空 U 盲板（更暗，突出设备） */
    var used = [[7, 22], [23, 25], [40, 41]], blanks = [];
    for (var uu = 2; uu <= 39; uu++) {
      var hit = false;
      for (var k2 = 0; k2 < used.length; k2++) if (uu >= used[k2][0] && uu <= used[k2][1]) { hit = true; break; }
      if (hit) continue;
      blanks.push({ p: [0, .056 + (uu - 1) * UH + UH / 2, RD / 2 - .06] });
    }
    if (blanks.length) g.add(U.inst(U.geoBox(RW - .16, .028, .004), 'hole', blanks));

    /* 机架标签：CXL / RDMA-only 两套，随部署状态切换 */
    var tagC = U.decal(id + ' · CXL+RDMA', .3, .055, '#7dffd0', 28);
    tagC.position.set(0, RH + .1, .26); g.add(tagC);
    var tagR = U.decal(id + ' · RDMA-only', .3, .055, '#8fc4ff', 28);
    tagR.position.set(0, RH + .1, .26); g.add(tagR);
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
    var mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, .008, 7, false),
      additive({ color: C.idle, opacity: .5 }));
    mesh.userData.linkId = id;
    root.add(mesh);
    links[id] = { mesh: mesh, curve: curve, base: C.idle };
  }

  /* ── 常驻光流粒子：管道内持续穿梭的发光光点（环境流量，bloom 下形成光缆感） ── */
  function addAmbient(linkKey, count, color, speed, size) {
    var l = links[linkKey];
    if (!l || !l.curve) return;
    for (var i = 0; i < count; i++) {
      var s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: GLOW, color: color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: .85
      }));
      s.scale.set(size, size, 1);
      root.add(s);
      ambient.push({ sp: s, curve: l.curve, t: i / count, speed: speed });
    }
  }
  function buildAmbientFlows() {
    addAmbient('L13', 4, C.cxl, .055, .10);    /* R1↔R3（两台 CXL 机架）：绿光 */
    addAmbient('L24', 3, C.rdma, .05, .09);    /* R2↔R4：蓝光 */
    addAmbient('L12', 3, C.mon, .045, .08);
    addAmbient('L34', 3, C.mon, .05, .08);
    ['R1', 'R2', 'R3', 'R4'].forEach(function (id) {
      addAmbient('U' + id, 2, CXL_RACKS[id] ? C.cxl : C.rdma, .085, .085);
    });
  }

  function initScene() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    dpr = M.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    /* HDR 泛光管线：场景线性输出、无内置 tonemap —— ACES + gamma 由 webgl-post 合成 pass 统一处理 */
    if (THREE.sRGBEncoding != null && 'outputEncoding' in renderer) renderer.outputEncoding = THREE.LinearEncoding;
    renderer.toneMapping = THREE.NoToneMapping;
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = backdropTexture();
    scene.fog = new THREE.FogExp2(0x000306, .04);
    envMap = U.makeEnv(renderer, { cool: true });
    scene.environment = envMap;
    if ('environmentIntensity' in scene) scene.environmentIntensity = .45;

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

    /* 泛光后处理（零依赖自研，见 vendor/webgl-post.js） */
    post = new window.__GLPOST__(renderer, scene, camera);
    window.__POST__ = post;   /* 调试入口 */
    post.threshold = .85;    /* 小颗粒峰值（闪烁 LED / 光流粒子）起晕 */
    post.strength = .7;
    post.exposure = .5;

    /* 灯光压暗，让自发光主导画面 */
    scene.add(new THREE.HemisphereLight(0x16324a, 0x02060c, .25));
    var key = new THREE.DirectionalLight(0xbfd9ff, .35);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -.0015;
    var sc = key.shadow.camera; sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5; sc.far = 24;
    scene.add(key);
    var warm = new THREE.DirectionalLight(0x9fc8ff, .22); warm.position.set(-6, 3, -5); scene.add(warm);
    var ctl = new THREE.PointLight(C.cyan, 2.0, 9, 2); ctl.position.set(0, CTRL_Y + .3, 0); scene.add(ctl);

    /* 反射地面 + 发光网格 */
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ color: 0x030b14, metalness: .85, roughness: .24 }));
    floor.rotation.x = -M.PI / 2; floor.receiveShadow = true; scene.add(floor);
    var gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(24, 24),
      additive({ map: neonGridTexture(), opacity: .32 }));
    gridMesh.rotation.x = -M.PI / 2; gridMesh.position.y = .002; scene.add(gridMesh);

    root = new THREE.Group(); scene.add(root);
    fx = new THREE.Group(); scene.add(fx);
    raycaster = new THREE.Raycaster();
    clock = new THREE.Clock();
    GLOW = glowTexture();
    PLATE_TEX = plateTexture();

    ['R1', 'R2', 'R3', 'R4'].forEach(function (id) {
      var r = slimRack(id); root.add(r); rackBodies[id] = r;
    });

    /* Spine：发光条 + 端口灯 */
    endpoints.SPINE = new THREE.Vector3(0, SPINE_Y, 0);
    spineRef = new THREE.Group();
    spineRef.add(U.box(1.3, .07, .4, 'chip'));
    var sFrame = edgeFrame(1.3, .07, .4, C.cyan, .7);
    spineRef.add(sFrame);
    var ports = [];
    for (var i = 0; i < 20; i++) ports.push({ p: [-.57 + i * .06, .004, .2] });
    var portMat = new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.rdma, emissiveIntensity: 1.4 });
    spineRef.add(U.inst(U.geoBox(.03, .014, .012), portMat, ports));
    var sLed = [];
    for (i = 0; i < 10; i++) sLed.push({ p: [-.45 + i * .1, -.012, .204] });
    var sLedMat = new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.cxl, emissiveIntensity: 1.6 });
    spineRef.add(U.inst(U.geoBox(.008, .005, .003), sLedMat, sLed));
    spineRef.position.y = SPINE_Y;
    spineRef.userData.pick = { kind: 'node', id: 'SPINE' };
    root.add(spineRef);

    /* Controller：底座辉光 + 光柱 + 双环 + 线框全息核 */
    endpoints.CTRL = new THREE.Vector3(0, CTRL_Y, 0);
    ctrlRef = new THREE.Group();
    ctrlRef.add(new THREE.Mesh(new THREE.CylinderGeometry(.36, .44, .05, 8), U.m('frameDark')));
    ctrlRef.add(glowPlate(C.cyan, 2.4, 2.4, .006, .4));
    var core = U.boxE(.3, .3, .3, 'die', { color: 0x0a2430, opacity: .9 });
    core.position.y = .26; ctrlRef.add(core);
    coreRef = new THREE.Mesh(new THREE.IcosahedronGeometry(.22, 1),
      new THREE.MeshBasicMaterial({ color: C.cyan, wireframe: true, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }));
    coreRef.position.y = .62;
    ctrlRef.add(coreRef);
    var beam = new THREE.Mesh(new THREE.CylinderGeometry(.09, .18, 1.3, 16, 1, true),
      additive({ color: C.cyan, opacity: .16, side: THREE.DoubleSide }));
    beam.position.y = .7; ctrlRef.add(beam);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(.52, .01, 8, 64),
      additive({ color: C.cyan, opacity: .7 }));
    ring.rotation.x = M.PI / 2; ring.position.y = .3; ring.userData.spin = 1; ctrlRef.add(ring);
    var ring2 = new THREE.Mesh(new THREE.TorusGeometry(.66, .008, 8, 64),
      additive({ color: C.cxl, opacity: .45 }));
    ring2.rotation.x = M.PI / 2.3; ring2.position.y = .3; ring2.userData.spin = -.7; ctrlRef.add(ring2);
    ['Placement', 'Profiler', 'Topology', 'Directory'].forEach(function (nm, k) {
      var a = k * M.PI / 2 + M.PI / 4;
      var chip = U.boxE(.14, .05, .09, 'pcbDark', { color: 0x06382c, opacity: .9 });
      chip.userData.mesh.material.emissive.setHex(C.cxl);
      chip.userData.mesh.material.emissiveIntensity = .8;
      chip.position.set(M.cos(a) * .48, .12, M.sin(a) * .48);
      chip.rotation.y = -a; ctrlRef.add(chip);
    });
    ctrlRef.position.set(0, CTRL_Y - .4, 0);
    ctrlRef.userData.pick = { kind: 'node', id: 'CTRL' };
    root.add(ctrlRef);

    /* RDMA 内存池：基座 + 全息壳 */
    endpoints.POOL = new THREE.Vector3(0, POOL_Y + .52, 0);
    poolRef = new THREE.Group();
    poolRef.add(U.box(.5, .5, .34, 'chip'));
    poolRef.add(glowPlate(C.rdma, 1.6, 1.3, .006, .4));
    var pHolo = holoShell(.56, .58, .4, C.rdma);
    pHolo.position.y = .02;
    poolRef.add(pHolo);
    var dram = [];
    for (var r = 0; r < 4; r++) for (var c = 0; c < 8; c++) dram.push({ p: [-.19 + c * .055, -.16 + r * .11, .175] });
    var dramMat = new THREE.MeshStandardMaterial({ color: 0x06131a, emissive: C.rdma, emissiveIntensity: 1.2 });
    poolRef.add(U.inst(U.geoBox(.04, .07, .008), dramMat, dram));
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
        additive({ color: C.rdma, opacity: .35 }));
      root.add(mesh);
      links['U' + id] = { mesh: mesh, curve: curve, base: C.rdma };
    });
    links.L14 = { via: ['UR1', 'UR4'] };
    links.L23 = { via: ['UR2', 'UR3'] };

    buildAmbientFlows();

    /* 压低金属环境反射（白芯来源），让霓虹自发光主导配色 —— 必须在全部物体建完后执行 */
    scene.traverse(function (o) {
      var m = o.material;
      if (!m || m.envMapIntensity == null) return;
      if (m.transparent && m.roughness != null && m.roughness < .3) {
        /* 近镜面玻璃：反射环境灯会形成大片白青色光板 → 强压反射并磨砂化 */
        m.envMapIntensity = Math.min(m.envMapIntensity, .12);
        m.roughness = Math.max(m.roughness, .4);
      } else if (m.envMapIntensity > 1) {
        m.envMapIntensity *= .55;
      }
    });

    wireEvents();
    ensureLabels();
    resize();
  }

  /* ══════════ 标签 ══════════ */
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
      var flip = (id === 'R3' || id === 'R4') ? -1 : 1;   /* 背面机架朝相反方向错开 */
      labelDefs.push({
        id: id + '.MHD', sub: 1, txt: 'CXL MHD ' + (id === 'R3' ? '192' : '320') + '/512',
        dep: { rack: id, on: true }, cxl: 1, ox: 36 * flip, oy: 10,
        p: new THREE.Vector3(pos.x, .056 + 22.5 * UH, pos.z + RD / 2 + .04)
      });
      labelDefs.push({
        id: id + '.SW', sub: 1, txt: 'CXL SWITCH · 2 HOST',
        dep: { rack: id, on: true }, cxl: 1, ox: 36 * flip, oy: -14,
        p: new THREE.Vector3(pos.x, .056 + 26.4 * UH, pos.z + RD / 2 + .04)
      });
      labelDefs.push({
        id: id + '.RDMA', sub: 1, txt: 'NO CXL · RDMA ONLY',
        dep: { rack: id, on: false }, ox: 36 * flip, oy: 8,
        p: new THREE.Vector3(pos.x, .056 + 22.5 * UH, pos.z + RD / 2 + .04)
      });
    });
    /* 中心设备说明标签（对应大屏的空间数字标注） */
    labelDefs.push({
      id: 'CTRL', sub: 1, txt: 'SCHEDULER · 放置 / 迁移 / 复制',
      ox: 0, oy: -6, p: new THREE.Vector3(0, CTRL_Y + .78, 0)
    });
    labelDefs.push({
      id: 'SPINE', sub: 1, txt: 'SPINE · 采集 / 监控',
      ox: -44, oy: -20, p: new THREE.Vector3(0, SPINE_Y + .16, 0)
    });
    labelDefs.push({
      id: 'POOL', sub: 1, txt: 'RDMA POOL · 原生 DRAM 池',
      ox: 44, oy: -20, p: new THREE.Vector3(0, POOL_Y + .92, 0)
    });
    labelEls = labelDefs.map(function (d) {
      var el = document.createElement('div');
      el.className = 'gll-lbl' + (d.sub ? ' gll-lbl--sub' : '') + (d.cxl ? ' cxl' : '');
      el.textContent = d.txt;
      labelLayer.appendChild(el);
      return el;
    });
  }
  var _v3 = new THREE.Vector3();
  function updateLabels() {
    if (!labelLayer || !labelEls.length) return;
    var w = host.clientWidth, h = host.clientHeight;
    /* 副标签只在拉近时显示 —— 全景下十几个亮色标签叠在机柜上部会糊成一片光板 */
    var far = camera.position.distanceTo(controls.target) > 4.2;
    labelDefs.forEach(function (d, i) {
      var el = labelEls[i];
      /* 部署感知标签：机架部署状态不匹配时隐藏 */
      if (d.dep) {
        var g = rackBodies[d.dep.rack];
        var show = g && (g.userData.cxlOn === d.dep.on);
        el.style.display = (show && !far) ? 'block' : 'none';
        if (!show || far) return;
      } else if (d.sub && far) {
        el.style.display = 'none';
        return;
      }
      _v3.copy(d.p).project(camera);
      if (_v3.z > 1) { el.style.opacity = '0'; return; }
      el.style.opacity = '1';
      el.style.left = ((_v3.x + 1) / 2 * w + (d.ox || 0)) + 'px';
      el.style.top = ((-_v3.y + 1) / 2 * h + (d.oy || 0)) + 'px';
      if (d.id === selectedId) el.classList.add('sel'); else el.classList.remove('sel');
    });
  }

  /* ══════════ 交互 ══════════ */
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

  /* ══════════ 相机 ══════════ */
  var CAM = {
    all:  { pos: [5.4, 4.1, 6.2], tgt: [0, 1.05, 0] },
    ctrl: { pos: [2.1, 2.7, 2.6], tgt: [0, 1.35, 0] },
    pool: { pos: [1.5, 1.4, 2.0], tgt: [0, .55, 0] },
    R1:   { pos: [-.2, 2.3, 3.8], tgt: [-.98, 1, .92] },
    R2:   { pos: [2.8, 2.3, 3.6], tgt: [.98, 1, .92] },
    R3:   { pos: [-3.6, 2.3, 2.2], tgt: [-.98, 1, -.92] },
    R4:   { pos: [3.6, 2.3, 2.0], tgt: [.98, 1, -.92] }
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
      l.mesh.material.opacity = on ? .85 : .5;
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
    if (post) post.setSize(w, h, dpr);
  }

  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    var dt = M.min(.05, clock.getDelta()), t = clock.elapsedTime;

    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1.4) {
      if (!degraded && fpsN / fpsAcc < 32 && dpr > 1) {
        degraded = true; dpr = 1; renderer.setPixelRatio(1);
        if (post && host) post.setSize(host.clientWidth, host.clientHeight, 1);
      }
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

    if (!REDUCED) {
      /* LED 闪烁 */
      for (var b = 0; b < blinkMats.length; b++) {
        var bm = blinkMats[b];
        var ph = bm.userData.phase || 0;
        bm.emissiveIntensity = .8 + 1.3 * M.abs(M.sin(t * 2.6 + ph));
      }
      /* 辉光盘呼吸 */
      for (var p = 0; p < plateMats.length; p++) {
        if (plateMats[p].userData.baseOp == null) plateMats[p].userData.baseOp = plateMats[p].opacity;
        plateMats[p].opacity = plateMats[p].userData.baseOp * (.82 + .28 * (.5 + .5 * M.sin(t * 1.7 + p)));
      }
      /* 全息壳微缩放 */
      for (var hg = 0; hg < holoGroups.length; hg++) {
        var s = 1 + .015 * M.sin(t * 2.2 + hg);
        holoGroups[hg].scale.setScalar(s);
      }
      if (coreRef) { coreRef.rotation.y += dt * .8; coreRef.rotation.x += dt * .3; }
      /* 常驻光流粒子：沿链路管道穿梭 */
      for (var a = 0; a < ambient.length; a++) {
        var am = ambient[a];
        am.t += dt * am.speed;
        if (am.t > 1) am.t -= 1;
        am.sp.position.copy(am.curve.getPointAt(am.t));
        am.sp.material.opacity = .45 + .45 * M.abs(M.sin(t * 3.2 + a * 1.7));
      }
    }

    if (ctrlRef) {
      ctrlRef.traverse(function (o) { if (o.userData.spin) o.rotation.z += dt * o.userData.spin; });
      if (ctrlRef.userData.pulseT > 0) {
        ctrlRef.userData.pulseT -= dt;
        ctrlRef.scale.setScalar(1 + .09 * M.sin(t * 9));
      } else ctrlRef.scale.setScalar(1);
    }
    if (window.__GLCLUSTER_FX__) window.__GLCLUSTER_FX__.tick(dt, t);
    Object.keys(links).forEach(function (kk) {
      var l = links[kk];
      if (l.cong && l.mesh) l.mesh.material.opacity = .45 + .4 * M.abs(M.sin(t * 5));
    });

    updateLabels();
    controls.update();
    if (post) post.render(); else renderer.render(scene, camera);
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
       与 2D 总览共用 STATE.deployment —— 决策变化时两个视图一起变（生长/收回动画），
       机架霓虹装饰（LED/光框/辉光盘/标签）随部署状态一起换色。 */
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
        var hex = on ? C.cxl : C.rdma;
        (ud.decoMats || []).forEach(function (mat) {
          if (mat.emissive) mat.emissive.setHex(hex); else mat.color.setHex(hex);
        });
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
    dispose: function () { running = false; if (post) post.dispose(); if (renderer) renderer.dispose(); }
  };
})();
