/* ============================================================
 * webgl-util.js — 渲染质感基座（材质库 / 程序化贴图 / 实例化）
 *
 * 手法参考 SmartNIC Lab：
 *   1) 手绘 canvas → EquirectangularReflectionMapping → PMREM，
 *      零外部资源拿到金属高光（旧版 THREE 兼容写法）
 *   2) 程序化 PCB 走线 + 过孔贴图、拉丝金属贴图（repeat + 各向异性）
 *   3) 24° 阈值 EdgesGeometry 描边 + BackSide 内衬（剖切不露空腔）
 *   4) InstancedMesh 承载螺丝 / 鳍片 / 触点 / LED 等重复件
 *   5) 剖切平面固定 2 张、关闭时 constant 推到极远，避免 shader 重编译
 *
 * 依赖由 webgl-rack.js 注入：window.__GLUTILS__(THREE) -> { U, MAT, makeEnv }
 * ============================================================ */
(function () {
  'use strict';

  window.__GLUTILS__ = function (THREE) {
    const SRGB = THREE.sRGBEncoding;

    /* ══════════════════════════════════════════════════════════
       程序化贴图
       ══════════════════════════════════════════════════════════ */
    function lcg(seed) {
      let s = seed >>> 0;
      return function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    }

    function texFrom(canvas, srgb) {
      const t = new THREE.CanvasTexture(canvas);
      if (srgb && SRGB != null) t.encoding = SRGB;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    }

    /** PCB：深色基材 + 直角走线 + 过孔环 + 丝印框（做成可平铺） */
    function pcbTexture(dark, seed) {
      const S = 512;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      x.fillStyle = dark ? '#071a14' : '#0a2419';
      x.fillRect(0, 0, S, S);

      /* 基材织纹 */
      x.globalAlpha = .05;
      for (let i = 0; i < S; i += 4) {
        x.fillStyle = i % 8 ? '#1d3d2c' : '#03100b';
        x.fillRect(0, i, S, 2);
        x.fillRect(i, 0, 2, S);
      }
      x.globalAlpha = 1;

      /* 走线（直角折线，随机层色） */
      const rnd = lcg(seed || 20261108);
      const layers = ['#124b39', '#15624a', '#1a7a5c', '#0f3c2e'];
      x.lineWidth = 2;
      x.lineCap = 'square';
      for (let i = 0; i < 210; i++) {
        let px = Math.floor(rnd() * S / 8) * 8;
        let py = Math.floor(rnd() * S / 8) * 8;
        x.strokeStyle = layers[(rnd() * layers.length) | 0];
        x.beginPath();
        x.moveTo(px, py);
        const segs = 2 + ((rnd() * 3) | 0);
        for (let s = 0; s < segs; s++) {
          if (s % 2 === 0) px += (rnd() > .5 ? 1 : -1) * (8 + ((rnd() * 6) | 0) * 8);
          else py += (rnd() > .5 ? 1 : -1) * (8 + ((rnd() * 6) | 0) * 8);
          x.lineTo(px, py);
        }
        x.stroke();
      }

      /* 过孔环 */
      for (let i = 0; i < 150; i++) {
        const vx = Math.floor(rnd() * S / 8) * 8;
        const vy = Math.floor(rnd() * S / 8) * 8;
        x.strokeStyle = 'rgba(214,168,86,.72)';
        x.lineWidth = 1.4;
        x.beginPath(); x.arc(vx, vy, 3.1, 0, Math.PI * 2); x.stroke();
        x.fillStyle = '#03100b';
        x.beginPath(); x.arc(vx, vy, 1.4, 0, Math.PI * 2); x.fill();
      }

      /* 丝印：元件位号框 */
      x.strokeStyle = 'rgba(214,232,228,.5)';
      x.lineWidth = 1.6;
      for (let i = 0; i < 22; i++) {
        const rx = (rnd() * (S - 60)) | 0, ry = (rnd() * (S - 40)) | 0;
        x.strokeRect(rx, ry, 16 + ((rnd() * 44) | 0), 10 + ((rnd() * 18) | 0));
      }
      x.fillStyle = 'rgba(224,240,236,.42)';
      x.font = '11px monospace';
      for (let i = 0; i < 16; i++) {
        x.fillText('U' + (1 + ((rnd() * 40) | 0)), (rnd() * (S - 20)) | 0, (rnd() * S) | 0);
      }
      return texFrom(cv, true);
    }

    /** 拉丝金属：横向细纹 + 轻微明暗带 */
    function brushedTexture() {
      const S = 256;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      x.fillStyle = '#2b3a45';
      x.fillRect(0, 0, S, S);
      const rnd = lcg(8821);
      for (let i = 0; i < 1400; i++) {
        const y = (rnd() * S) | 0;
        const len = 20 + rnd() * 120;
        const a = .04 + rnd() * .1;
        x.strokeStyle = 'rgba(214,236,246,' + a.toFixed(3) + ')';
        x.lineWidth = rnd() > .8 ? 1.4 : .8;
        x.beginPath();
        const sx = (rnd() * S) | 0;
        x.moveTo(sx, y + .5); x.lineTo(sx + len, y + .5);
        x.stroke();
      }
      const t = texFrom(cv, true);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(3, 1);
      return t;
    }

    /** 网孔门：菱形孔洞阵列（用于整机模式的前门细节） */
    function meshTexture() {
      const S = 64;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      x.fillStyle = '#0a141a';
      x.fillRect(0, 0, S, S);
      x.fillStyle = 'rgba(120,168,188,.55)';
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          x.beginPath();
          const cx = 8 + c * 16, cy = 8 + r * 16;
          x.moveTo(cx, cy - 5); x.lineTo(cx + 5, cy); x.lineTo(cx, cy + 5); x.lineTo(cx - 5, cy);
          x.closePath(); x.fill();
        }
      }
      const t = texFrom(cv, true);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(24, 42);
      return t;
    }

    /** 丝印文字贴片 */
    function decal(text, w, h, color, font) {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = Math.max(24, Math.round(256 * (h / w)));
      const x = cv.getContext('2d');
      x.clearRect(0, 0, cv.width, cv.height);
      x.fillStyle = color || '#cfe6ef';
      x.font = '600 ' + (font || 26) + 'px "Cascadia Mono", Consolas, monospace';
      x.textBaseline = 'middle';
      x.fillText(text, 6, cv.height / 2);
      const t = texFrom(cv, true);
      const mat = new THREE.MeshBasicMaterial({
        map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: .92
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.userData.decal = true;
      return mesh;
    }

    /** 手绘环境贴图：垂直渐变 + 3 块机房灯斑 → PMREM */
    function makeEnv(renderer, opts) {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 256;
      const x = cv.getContext('2d');
      const cool = !!(opts && opts.cool);
      const gr = x.createLinearGradient(0, 0, 0, 256);
      if (cool) {
        /* 冷色调（集群霓虹场景）：更暗的环境 + 无暖色灯，避免金属面泛白/泛琥珀 */
        gr.addColorStop(0, '#0e1a26');
        gr.addColorStop(.42, '#081018');
        gr.addColorStop(.56, '#03070b');
        gr.addColorStop(1, '#010305');
      } else {
        gr.addColorStop(0, '#1a2c38');
        gr.addColorStop(.42, '#0c161e');
        gr.addColorStop(.56, '#05090d');
        gr.addColorStop(1, '#020508');
      }
      x.fillStyle = gr; x.fillRect(0, 0, 512, 256);

      function lamp(cx, cy, r, col, a) {
        const g2 = x.createRadialGradient(cx, cy, 0, cx, cy, r);
        g2.addColorStop(0, 'rgba(' + col + ',' + a + ')');
        g2.addColorStop(.45, 'rgba(' + col + ',' + (a * .35).toFixed(3) + ')');
        g2.addColorStop(1, 'rgba(' + col + ',0)');
        x.fillStyle = g2; x.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      lamp(120, 62, 92, '190,228,255', cool ? .7 : .95);
      lamp(348, 44, 74, '150,240,214', cool ? .5 : .7);
      /* cool = 冷色调模式：去掉暖橙灯，金属面不再反射琥珀色 */
      if (!cool) {
        lamp(452, 96, 60, '255,206,150', .45);
        lamp(232, 150, 130, '96,150,180', .28);
      } else {
        lamp(452, 96, 60, '120,200,255', .4);
        lamp(232, 150, 130, '70,160,220', .22);
      }

      const tex = new THREE.CanvasTexture(cv);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      if (SRGB != null) tex.encoding = SRGB;
      tex.needsUpdate = true;

      let envMap = tex;
      if (THREE.PMREMGenerator && renderer) {
        try {
          const pm = new THREE.PMREMGenerator(renderer);
          pm.compileEquirectangularShader();
          envMap = pm.fromEquirectangular(tex).texture;
          pm.dispose();
        } catch (e) { envMap = tex; }
      }
      return envMap;
    }

    /** 地面反光（径向渐变，贴在假地面平面上） */
    function floorTexture() {
      const S = 256;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(46,92,108,.6)');
      g.addColorStop(.42, 'rgba(16,36,44,.28)');
      g.addColorStop(1, 'rgba(3,7,10,0)');
      x.fillStyle = g; x.fillRect(0, 0, S, S);
      return texFrom(cv, true);
    }

    /* ══════════════════════════════════════════════════════════
       材质库
       ══════════════════════════════════════════════════════════ */
    const TEX = {
      pcb: pcbTexture(false, 20261108),
      pcbDark: pcbTexture(true, 51507),
      brushed: brushedTexture(),
      mesh: meshTexture()
    };

    function std(o) {
      return new THREE.MeshStandardMaterial(Object.assign({
        color: 0xffffff, metalness: .6, roughness: .45, envMapIntensity: 1
      }, o || {}));
    }

    const MAT = {
      frame: std({ color: 0x1e2c37, metalness: .82, roughness: .34, map: TEX.brushed }),
      frameDark: std({ color: 0x141d25, metalness: .74, roughness: .48, map: TEX.brushed }),
      steel: std({ color: 0x55697a, metalness: .9, roughness: .3, envMapIntensity: 1.3 }),
      alu: std({ color: 0x7b8f9d, metalness: .88, roughness: .38, envMapIntensity: 1.25 }),
      hole: std({ color: 0x05090c, metalness: .3, roughness: .85 }),
      rubber: std({ color: 0x0b1015, metalness: .05, roughness: .95 }),
      mesh: std({ color: 0x1b2a34, metalness: .7, roughness: .5, map: TEX.mesh }),
      chassis: std({ color: 0x18242e, metalness: .7, roughness: .4, map: TEX.brushed }),
      plastic: std({ color: 0x101820, metalness: .12, roughness: .72 }),
      tray: std({ color: 0x243543, metalness: .55, roughness: .5 }),
      pcb: std({ color: 0x2f7f63, metalness: .18, roughness: .74, map: TEX.pcb }),
      pcbDark: std({ color: 0x2a6f5c, metalness: .2, roughness: .78, map: TEX.pcbDark }),
      chip: std({ color: 0x14191f, metalness: .35, roughness: .55 }),
      die: std({ color: 0x35485c, metalness: .95, roughness: .12, envMapIntensity: 1.7 }),
      gold: std({ color: 0xd9a441, metalness: 1, roughness: .28, envMapIntensity: 1.5 }),
      goldBright: std({ color: 0xf0c874, metalness: 1, roughness: .18, envMapIntensity: 1.6 }),
      copper: std({ color: 0xb87333, metalness: .95, roughness: .35 }),
      ceramic: std({ color: 0xc7d2d8, metalness: .06, roughness: .68 }),
      cap: std({ color: 0x1a2b38, metalness: .6, roughness: .42 }),
      dimm: std({ color: 0x1d3a32, metalness: .3, roughness: .6 }),
      shield: std({ color: 0x8b9aa6, metalness: .95, roughness: .22, envMapIntensity: 1.5 }),
      velcro: std({ color: 0x16222b, metalness: .1, roughness: .9 }),
      liner: std({ color: 0x040a0e, metalness: .2, roughness: .9, side: THREE.BackSide }),
      glass: std({
        color: 0x0f2b36, metalness: .28, roughness: .06, transparent: true,
        opacity: .12, depthWrite: false, envMapIntensity: 1.6
      }),
      glassFront: std({
        color: 0x12333f, metalness: .3, roughness: .04, transparent: true,
        opacity: .1, depthWrite: false, envMapIntensity: 1.8
      }),
      switchBody: std({ color: 0x14252f, metalness: .7, roughness: .36, map: TEX.brushed }),
      mhdFrame: std({ color: 0x0e2320, metalness: .6, roughness: .48 }),
      mhdUnit: std({ color: 0x10403a, metalness: .55, roughness: .42 }),
      blank: std({ color: 0x131c22, metalness: .4, roughness: .7 }),
      portCxlOn: std({ color: 0x53e3c4, metalness: .5, roughness: .3, emissive: 0x53e3c4, emissiveIntensity: .9 }),
      portRdma: std({ color: 0x5f9fe8, metalness: .5, roughness: .3, emissive: 0x5f9fe8, emissiveIntensity: .7 }),
      portOff: std({ color: 0x3d4d58, metalness: .5, roughness: .55 }),
      ledGreen: std({ color: 0x0a1f16, emissive: 0x6ee7a8, emissiveIntensity: 1.5, metalness: .2, roughness: .4 }),
      ledCxl: std({ color: 0x07211d, emissive: 0x53e3c4, emissiveIntensity: 1.4, metalness: .2, roughness: .4 }),
      ledOff: std({ color: 0x121a20, emissive: 0x000000, emissiveIntensity: 0, metalness: .3, roughness: .6 })
    };

    /* ══════════════════════════════════════════════════════════
       几何缓存 + 实例化 + 描边 + 内衬
       ══════════════════════════════════════════════════════════ */
    const geoCache = {};
    function keep(geo) { geo.userData = { keep: true }; return geo; }
    function geoBox(w, h, d) {
      const k = 'b' + r3(w) + '_' + r3(h) + '_' + r3(d);
      if (!geoCache[k]) geoCache[k] = keep(new THREE.BoxGeometry(w, h, d));
      return geoCache[k];
    }
    function geoCyl(rt, h, seg, rb) {
      const k = 'c' + r3(rt) + '_' + r3(h) + '_' + (seg || 10) + '_' + r3(rb == null ? rt : rb);
      if (!geoCache[k]) geoCache[k] = keep(new THREE.CylinderGeometry(rt, rb == null ? rt : rb, h, seg || 10));
      return geoCache[k];
    }
    function geoTorus(r, tube, rs, ts) {
      const k = 't' + r3(r) + '_' + r3(tube) + '_' + (rs || 8) + '_' + (ts || 18);
      if (!geoCache[k]) geoCache[k] = keep(new THREE.TorusGeometry(r, tube, rs || 8, ts || 18));
      return geoCache[k];
    }
    function r3(v) { return Math.round((v || 0) * 1e5) / 1e5; }

    /** 实例化重复件：items = [{p:[x,y,z], r:[rx,ry,rz], s:[sx,sy,sz]}] */
    function inst(geo, matKey, items) {
      const mat = typeof matKey === 'string' ? cloneMat(MAT[matKey]) : matKey;
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
      const d = new THREE.Object3D();
      items.forEach(function (it, i) {
        d.position.set(it.p ? it.p[0] : 0, it.p ? it.p[1] : 0, it.p ? it.p[2] : 0);
        if (it.r) d.rotation.set(it.r[0], it.r[1], it.r[2]); else d.rotation.set(0, 0, 0);
        if (it.s) d.scale.set(it.s[0], it.s[1], it.s[2]); else d.scale.set(1, 1, 1);
        d.updateMatrix();
        im.setMatrixAt(i, d.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      im.userData.instCount = items.length;
      if (THREE.DynamicDrawUsage != null) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return im;
    }

    /** 材质克隆：每个可交互部件持有独立材质，改高亮不污染同类件 */
    const matProto = {};
    function cloneMat(m) {
      const id = m.uuid;
      const base = matProto[id] || (matProto[id] = m);
      const c = base.clone();
      if (base.map) c.map = base.map;
      c.userData = {};
      return c;
    }

    function m(key) { return cloneMat(MAT[key]); }

    /** 24° 阈值描边：精密感的来源，且不依赖后处理 */
    function edgeLines(mesh, color, opacity) {
      const eg = new THREE.EdgesGeometry(mesh.geometry, 24);
      const lm = new THREE.LineBasicMaterial({
        color: color != null ? color : 0x74a6ba, transparent: true,
        opacity: opacity != null ? opacity : .5, depthWrite: false
      });
      const ls = new THREE.LineSegments(eg, lm);
      ls.userData.isEdge = true;
      ls.raycast = function () {};
      return ls;
    }

    /** 内衬：同几何缩到 0.982 的 BackSide 副本，剖切时露出壁厚而非空腔 */
    function liner(mesh, matKey) {
      const geo = mesh.geometry;
      const ls = new THREE.Mesh(geo, cloneMat(MAT[matKey] || MAT.liner));
      ls.scale.setScalar(.982);
      ls.raycast = function () {};
      ls.userData.isLiner = true;
      return ls;
    }

    /** 带描边的盒子（返回 Group，mesh 挂在 userData.mesh） */
    function boxE(w, h, d, matKey, opt) {
      opt = opt || {};
      const g = new THREE.Group();
      const mat = cloneMat(MAT[matKey] || MAT.chassis);
      if (opt.color != null) mat.color.setHex(opt.color);
      if (opt.opacity != null) {
        mat.transparent = opt.opacity < 1;
        mat.opacity = opt.opacity;
      }
      const mesh = new THREE.Mesh(geoBox(w, h, d), mat);
      g.add(mesh);
      if (opt.edges !== false) {
        g.add(edgeLines(mesh, opt.color, opt.edgeOpacity != null ? opt.edgeOpacity : .5));
      }
      g.userData.mesh = mesh;
      g.userData.edges = g.children[1] || null;
      g.userData.size = [w, h, d];
      return g;
    }

    /** 不带描边的盒子（返回 Mesh） */
    function box(w, h, d, matKey, color) {
      const mat = cloneMat(MAT[matKey] || MAT.chassis);
      if (color != null) mat.color.setHex(color);
      return new THREE.Mesh(geoBox(w, h, d), mat);
    }

    function cyl(r, h, seg, matKey, color) {
      const mat = cloneMat(MAT[matKey] || MAT.steel);
      if (color != null) mat.color.setHex(color);
      return new THREE.Mesh(geoCyl(r, h, seg), mat);
    }

    /* ══════════════════════════════════════════════════════════
       剖切：固定 2 张平面，所有材质共享同一数组引用
       ══════════════════════════════════════════════════════════ */
    const OFF = 1e6;
    const planes = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), OFF),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), OFF)
    ];
    const clipArr = planes.slice(0, 1);   // 默认只启用 X 向

    function setClip(axis, k) {
      if (axis === 'x') {
        clipArr[0].constant = OFF;
        planes[0].constant = k;
      } else if (axis === 'y') {
        planes[1].constant = k;
      }
    }
    function clipOff() { planes[0].constant = OFF; planes[1].constant = OFF; }

    /** 给一个 group 下所有材质挂上共享剖切数组 */
    function bindClip(root) {
      root.traverse(function (o) {
        if (!o.material) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(function (mm) {
          mm.clippingPlanes = clipArr;
          mm.clipShadows = true;
          mm.needsUpdate = true;
        });
      });
    }

    return {
      MAT: MAT, TEX: TEX,
      geoBox: geoBox, geoCyl: geoCyl, geoTorus: geoTorus,
      box: box, boxE: boxE, cyl: cyl, inst: inst, m: m, cloneMat: cloneMat,
      edgeLines: edgeLines, liner: liner, decal: decal,
      makeEnv: makeEnv, floorTexture: floorTexture,
      planes: planes, clipArr: clipArr, setClip: setClip, clipOff: clipOff, bindClip: bindClip,
      CLIP_OFF: OFF, lcg: lcg
    };
  };
})();
