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

    /** 拉丝金属：更致密的多层次横向发丝纹 */
    function brushedTexture() {
      const S = 512;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      x.fillStyle = '#1c262e';
      x.fillRect(0, 0, S, S);
      const rnd = lcg(8821);
      for (let i = 0; i < 2800; i++) {
        const y = (rnd() * S) | 0;
        const len = 30 + rnd() * 180;
        const a = .03 + rnd() * .12;
        x.strokeStyle = 'rgba(205,230,245,' + a.toFixed(3) + ')';
        x.lineWidth = rnd() > .85 ? 1.5 : .8;
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

    /** 网孔门：蜂窝冲孔网眼阵列（更真实的服务器机柜六角/圆孔进风门） */
    function meshTexture() {
      const S = 128;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      x.fillStyle = '#060a0d';
      x.fillRect(0, 0, S, S);
      x.fillStyle = '#1e2e38';
      const r = 5.2;
      for (let row = 0; row < 10; row++) {
        const offset = (row % 2) * 8;
        for (let col = 0; col < 10; col++) {
          const cx = col * 16 + offset;
          const cy = row * 13.8;
          x.beginPath();
          x.arc(cx, cy, r, 0, Math.PI * 2);
          x.fill();
        }
      }
      const t = texFrom(cv, true);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(16, 28);
      return t;
    }

    /** 数据中心 600mm 防静电高架地板贴图（带分缝、导静电微晶粒与微倒角阴影） */
    function floorTileTexture() {
      const S = 512;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      x.fillStyle = '#0a1014';
      x.fillRect(0, 0, S, S);

      /* 2x2 地砖网格划分 */
      const half = S / 2;
      const rnd = lcg(4011);

      function drawTile(tx, ty, size) {
        // 地砖基底哑光微噪点
        const g = x.createRadialGradient(tx + size / 2, ty + size / 2, 10, tx + size / 2, ty + size / 2, size * .7);
        g.addColorStop(0, '#151e24');
        g.addColorStop(1, '#0c1217');
        x.fillStyle = g;
        x.fillRect(tx + 2, ty + 2, size - 4, size - 4);

        // 倒角微亮边
        x.strokeStyle = 'rgba(74,110,130,.25)';
        x.lineWidth = 1;
        x.strokeRect(tx + 2.5, ty + 2.5, size - 5, size - 5);

        // 细微防静电斑粒
        x.fillStyle = 'rgba(120,165,190,.06)';
        for (let i = 0; i < 180; i++) {
          const px = tx + 4 + rnd() * (size - 8);
          const py = ty + 4 + rnd() * (size - 8);
          x.fillRect(px, py, 1.5, 1.5);
        }
      }

      drawTile(0, 0, half);
      drawTile(half, 0, half);
      drawTile(0, half, half);
      drawTile(half, half, half);

      // 深色分缝槽
      x.fillStyle = '#020406';
      x.fillRect(half - 2, 0, 4, S);
      x.fillRect(0, half - 2, S, 4);
      x.strokeRect(0, 0, S, S);

      const t = texFrom(cv, true);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(8, 8);
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

    /** 专业数据中心 HDR 环境贴图：天花板条形冷白吊灯组阵列 + 冷暗机房空间反射 → PMREM */
    function makeEnv(renderer) {
      const cv = document.createElement('canvas');
      cv.width = 1024; cv.height = 512;
      const x = cv.getContext('2d');

      // 背景渐变：天花板稍亮、中间深邃、地面冷黑
      const gr = x.createLinearGradient(0, 0, 0, 512);
      gr.addColorStop(0, '#1a2732');
      gr.addColorStop(0.35, '#0e161c');
      gr.addColorStop(0.52, '#080d11');
      gr.addColorStop(1, '#030507');
      x.fillStyle = gr; x.fillRect(0, 0, 1024, 512);

      // 数据中心冷白条形双排吊灯（产生极其锋利真实的金属拉丝长条切线高光）
      function drawLightStrip(x1, y1, len, w, angle, col, bright) {
        x.save();
        x.translate(x1, y1);
        x.rotate(angle);
        // 光晕
        const halo = x.createLinearGradient(0, -w * 2.5, 0, w * 2.5);
        halo.addColorStop(0, 'rgba(' + col + ',0)');
        halo.addColorStop(0.5, 'rgba(' + col + ',' + (bright * 0.45).toFixed(3) + ')');
        halo.addColorStop(1, 'rgba(' + col + ',0)');
        x.fillStyle = halo;
        x.fillRect(-len / 2, -w * 2.5, len, w * 5);

        // 灯芯
        const core = x.createLinearGradient(0, -w / 2, 0, w / 2);
        core.addColorStop(0, 'rgba(255,255,255,' + bright + ')');
        core.addColorStop(0.5, 'rgba(255,255,255,1)');
        core.addColorStop(1, 'rgba(255,255,255,' + bright + ')');
        x.fillStyle = core;
        x.fillRect(-len / 2, -w / 2, len, w);
        x.restore();
      }

      // 顶部主排条形荧光灯带
      drawLightStrip(280, 80, 460, 16, -0.05, '210,238,255', 0.98);
      drawLightStrip(760, 85, 440, 16, 0.05, '205,242,255', 0.95);
      drawLightStrip(512, 50, 600, 12, 0, '220,245,255', 0.85);

      // 机柜状态指示冷暖氛围光点（代表走廊与临近机柜指示灯）
      function softGlow(cx, cy, rx, ry, col, a) {
        const g2 = x.createRadialGradient(cx, cy, 0, cx, cy, rx);
        g2.addColorStop(0, 'rgba(' + col + ',' + a + ')');
        g2.addColorStop(0.4, 'rgba(' + col + ',' + (a * 0.35).toFixed(3) + ')');
        g2.addColorStop(1, 'rgba(' + col + ',0)');
        x.fillStyle = g2;
        x.save();
        x.scale(1, ry / rx);
        x.beginPath(); x.arc(cx, cy * (rx / ry), rx, 0, Math.PI * 2); x.fill();
        x.restore();
      }

      softGlow(160, 260, 120, 60, '83,227,196', 0.38); // CXL 蓝青光晕
      softGlow(840, 270, 130, 65, '95,159,232', 0.32); // RDMA 蓝光晕
      softGlow(512, 380, 240, 70, '70,120,150', 0.22); // 地面反射冷光

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
      const S = 512;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const x = cv.getContext('2d');
      const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(38,82,102,.65)');
      g.addColorStop(0.38, 'rgba(15,35,45,.35)');
      g.addColorStop(0.7, 'rgba(6,16,22,.15)');
      g.addColorStop(1, 'rgba(2,6,8,0)');
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
      mesh: meshTexture(),
      floorTile: floorTileTexture()
    };

    function std(o) {
      return new THREE.MeshStandardMaterial(Object.assign({
        color: 0xffffff, metalness: .75, roughness: .35, envMapIntensity: 1.25
      }, o || {}));
    }

    const MAT = {
      frame: std({ color: 0x151b22, metalness: .85, roughness: .38, map: TEX.brushed, envMapIntensity: 1.3 }),
      frameDark: std({ color: 0x0c1116, metalness: .82, roughness: .45, map: TEX.brushed, envMapIntensity: 1.1 }),
      steel: std({ color: 0x6e8090, metalness: .95, roughness: .22, envMapIntensity: 1.6 }),
      alu: std({ color: 0x8ea2b2, metalness: .92, roughness: .28, envMapIntensity: 1.4 }),
      hole: std({ color: 0x020406, metalness: .1, roughness: .95 }),
      rubber: std({ color: 0x070b0e, metalness: .05, roughness: .95 }),
      mesh: std({ color: 0x162028, metalness: .82, roughness: .42, map: TEX.mesh, envMapIntensity: 1.3 }),
      chassis: std({ color: 0x171f27, metalness: .8, roughness: .36, map: TEX.brushed, envMapIntensity: 1.3 }),
      plastic: std({ color: 0x0d141a, metalness: .15, roughness: .68 }),
      tray: std({ color: 0x1f2c37, metalness: .75, roughness: .42, envMapIntensity: 1.2 }),
      pcb: std({ color: 0x1e664f, metalness: .25, roughness: .65, map: TEX.pcb, envMapIntensity: 1.1 }),
      pcbDark: std({ color: 0x194d3f, metalness: .28, roughness: .68, map: TEX.pcbDark, envMapIntensity: 1.1 }),
      chip: std({ color: 0x10151a, metalness: .45, roughness: .48, envMapIntensity: 1.2 }),
      die: std({ color: 0x4a6278, metalness: .98, roughness: .08, envMapIntensity: 2.1 }),
      gold: std({ color: 0xe0ad43, metalness: 1, roughness: .22, envMapIntensity: 1.8 }),
      goldBright: std({ color: 0xfad27b, metalness: 1, roughness: .14, envMapIntensity: 2.0 }),
      copper: std({ color: 0xc87d3b, metalness: .98, roughness: .28, envMapIntensity: 1.6 }),
      ceramic: std({ color: 0xcdd6dc, metalness: .08, roughness: .55 }),
      cap: std({ color: 0x1b2d3a, metalness: .75, roughness: .32, envMapIntensity: 1.4 }),
      dimm: std({ color: 0x184236, metalness: .35, roughness: .52 }),
      shield: std({ color: 0x99aab8, metalness: .96, roughness: .18, envMapIntensity: 1.8 }),
      velcro: std({ color: 0x121a20, metalness: .1, roughness: .9 }),
      liner: std({ color: 0x030608, metalness: .2, roughness: .9, side: THREE.BackSide }),
      glass: std({
        color: 0x0b1a24, metalness: .35, roughness: .05, transparent: true,
        opacity: .14, depthWrite: false, envMapIntensity: 2.0
      }),
      glassFront: std({
        color: 0x0f2430, metalness: .4, roughness: .03, transparent: true,
        opacity: .12, depthWrite: false, envMapIntensity: 2.2
      }),
      switchBody: std({ color: 0x16242e, metalness: .82, roughness: .32, map: TEX.brushed, envMapIntensity: 1.4 }),
      mhdFrame: std({ color: 0x0d2822, metalness: .78, roughness: .38, map: TEX.brushed, envMapIntensity: 1.4 }),
      mhdUnit: std({ color: 0x113b33, metalness: .8, roughness: .34, map: TEX.brushed, envMapIntensity: 1.5 }),
      blank: std({ color: 0x11171d, metalness: .7, roughness: .55, map: TEX.brushed }),
      portCxlOn: std({ color: 0x3ae6be, metalness: .6, roughness: .2, emissive: 0x3ae6be, emissiveIntensity: 1.3 }),
      portRdma: std({ color: 0x4f9bf8, metalness: .6, roughness: .2, emissive: 0x4f9bf8, emissiveIntensity: 1.1 }),
      portOff: std({ color: 0x2b3842, metalness: .6, roughness: .5 }),
      ledGreen: std({ color: 0x06281b, emissive: 0x5eead4, emissiveIntensity: 2.2, metalness: .1, roughness: .3 }),
      ledCxl: std({ color: 0x042822, emissive: 0x3ae6be, emissiveIntensity: 2.2, metalness: .1, roughness: .3 }),
      ledOff: std({ color: 0x0e1418, emissive: 0x000000, emissiveIntensity: 0, metalness: .4, roughness: .6 })
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
