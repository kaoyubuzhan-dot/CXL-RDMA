/* ============================================================
 * webgl-parts.js — 高精度零件库（建模层）
 *
 * 建模语言参考 SmartNIC Lab：真实比例外壳 + 内衬 + 24° 描边 +
 * 实例化重复件 + 程序化 PCB / 拉丝金属贴图 + 丝印贴片。
 *
 * 服务器按真实 4U 机架式服务器建模：
 *   前面板(19″ 挂耳 + 盘位 + 状态灯 + 型号铭牌) → 风扇墙 →
 *   CPU 均热盖 + DIMM → 竖插 GPU(转接卡 + 鳍片 + 背板) →
 *   尾部 PCIe 网卡 + 双冗余电源；机盖可单独拆。
 * 机柜按真实 42U 建模：C 型立柱 + 安装孔阵列 + 后部理线槽 + PDU +
 * 空 U 位盲板 + 顶板风扇格栅 + 调平脚。
 *
 * 依赖由 webgl-rack.js 注入：window.__GLPARTS__(THREE, H)
 * ============================================================ */
(function () {
  'use strict';

  /* 标准机架参数：1U = 44.45mm，19″ 设备宽 483mm */
  var UH = .0445;
  var RACK_W = .62, RACK_D = .86, RACK_H = 2.02;
  var SRV_W = .50, SRV_H = 4 * UH, SRV_D = .68;

  window.__GLPARTS__ = function (THREE, H) {
    var U = H.U;

    var out = {
      UH: UH, RACK_W: RACK_W, RACK_D: RACK_D, RACK_H: RACK_H,
      SRV_W: SRV_W, SRV_H: SRV_H, SRV_D: SRV_D,
      rack: rack, server: server, cxlSwitch: cxlSwitch, mhdPool: mhdPool,
      switchBox: switchBox, cable: cable, straps: straps, uY: uY
    };
    return out;

    /* U 位（1-based）起始高度 / 高度 */
    function uY(u) { return .056 + (u - 1) * UH; }

    function lcg(seed) {
      var s = seed >>> 0;
      return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }

    /* 统一登记可交互件 */
    function meta(target, bag, m) {
      if (!m) return;
      var t = (target && target.userData && target.userData.mesh) ? target.userData.mesh : target;
      if (!t) return;
      t.userData.meta = m;
      bag.parts.push(t);
    }

    /* ══════════════════════════════════════════════════════════
       机柜：立柱 + 安装孔 + 理线槽 + PDU + 盲板 + 顶板 + 脚轮
       ══════════════════════════════════════════════════════════ */
    function rack(cfg) {
      var W = cfg.W || RACK_W, D = cfg.D || RACK_D, Hh = cfg.H || RACK_H;
      var g = new THREE.Group();
      var res = { group: g, parts: [], glass: [], anchors: [] };
      var pw = .045;

      /* 四根 C 型槽钢立柱 */
      [[-W / 2, -D / 2], [W / 2 - pw, -D / 2], [-W / 2, D / 2 - pw], [W / 2 - pw, D / 2 - pw]]
        .forEach(function (p) {
          var col = new THREE.Group();
          col.add(put(U.boxE(pw, Hh, pw * .34, 'frame', { color: 0x7fa2b5, opacity: .55 }), 0, Hh / 2, pw * .17));
          col.add(put(U.boxE(pw * .26, Hh, pw, 'frameDark', { color: 0x6f93a6, opacity: .45 }), 0, Hh / 2, pw * .86));
          col.add(put(U.box(pw * .3, Hh, pw * .96, 'frameDark'), pw * .82, Hh / 2, pw * .5));
          col.position.set(p[0] + pw / 2, 0, p[1] + pw / 2);
          g.add(col);
        });

      /* 安装孔阵列（42U × 双列，实例化） */
      var holes = [];
      for (var u = 0; u < 42; u++) {
        for (var c = 0; c < 2; c++) {
          var y = uY(u + 1) + UH / 2;
          holes.push({ p: [-W / 2 + .013 + c * .02, y, D / 2 - pw * .1] });
          holes.push({ p: [W / 2 - pw + .013 + c * .02, y, D / 2 - pw * .1] });
        }
      }
      g.add(U.inst(U.geoBox(.011, .0075, .004), 'hole', holes));

      /* 顶部：盖板 + 风扇格栅 + 理线架 */
      var cap = U.boxE(W, .028, D, 'frame', { color: 0x86adc0, opacity: .6 });
      cap.position.set(0, Hh - .014, 0); g.add(cap);
      var slats = [];
      for (var i = 0; i < 9; i++) slats.push({ p: [-.2 + i * .05, Hh - .001, 0] });
      g.add(U.inst(U.geoBox(.034, .004, D * .62), 'frameDark', slats));

      var mgr = U.boxE(.055, .028, D * .7, 'frameDark', { color: 0x5f8497, opacity: .45 });
      mgr.position.set(W / 2 - .07, Hh - .055, 0); g.add(mgr);
      var mgrSlots = [];
      for (var k = 0; k < 12; k++) mgrSlots.push({ p: [W / 2 - .07, Hh - .041, -D * .3 + k * (D * .6 / 11)] });
      g.add(U.inst(U.geoBox(.046, .003, .006), 'hole', mgrSlots));

      /* 底部：底板 + 调平脚 */
      var base = U.boxE(W, .05, D, 'frameDark', { color: 0x7fa2b5, opacity: .55 });
      base.position.set(0, .025, 0); g.add(base);
      var feet = [];
      [[-W / 2, -D / 2], [W / 2 - pw, -D / 2], [-W / 2, D / 2 - pw], [W / 2 - pw, D / 2 - pw]]
        .forEach(function (p) { feet.push({ p: [p[0] + pw / 2, .012, p[1] + pw / 2] }); });
      g.add(U.inst(U.geoCyl(.022, .024, 10), 'rubber', feet));

      /* 侧板（可透 / 可拆：采用深邃烟熏防静电亚克力与冷轧钢微倒角边框，告别塑料感） */
      [
        { w: W - .02, h: Hh - .1, d: .008, pos: [0, Hh / 2, D / 2 - .012], dir: [0, 0, 1] },
        { w: W - .02, h: Hh - .1, d: .008, pos: [0, Hh / 2, -D / 2 + .012], dir: [0, 0, -1] },
        { w: .008, h: Hh - .1, d: D - .02, pos: [-W / 2 + .012, Hh / 2, 0], dir: [-1, 0, 0] },
        { w: .008, h: Hh - .1, d: D - .02, pos: [W / 2 - .012, Hh / 2, 0], dir: [1, 0, 0] }
      ].forEach(function (s, idx) {
        var p = U.boxE(s.w, s.h, s.d, idx === 0 ? 'glassFront' : 'glass', { color: 0x18242e, opacity: .18, edgeOpacity: .35 });
        p.position.set(s.pos[0], s.pos[1], s.pos[2]);
        p.userData.glass = true;
        p.userData.home = p.position.clone();
        p.userData.dir = new THREE.Vector3(s.dir[0], s.dir[1], s.dir[2]);
        g.add(p);
        res.glass.push(p);
      });

      /* 后部竖直理线槽（左右各一） */
      [-.245, .245].forEach(function (x) {
        var duct = U.boxE(.05, Hh - .16, .055, 'frameDark', { color: 0x53737f, opacity: .38 });
        duct.position.set(x, (Hh - .16) / 2 + .06, -D / 2 + .055);
        g.add(duct);
        var fins = [];
        for (var f = 0; f < 22; f++) fins.push({ p: [x, .12 + f * .082, -D / 2 + .028] });
        g.add(U.inst(U.geoBox(.052, .005, .004), 'hole', fins));
      });

      /* 右侧 PDU：竖条 + 插座孔阵列 */
      var pdu = U.boxE(.045, Hh - .3, .04, 'frameDark', { color: 0x4e6b78, opacity: .45 });
      pdu.position.set(W / 2 - .06, (Hh - .3) / 2 + .07, -D / 2 + .028);
      g.add(pdu);
      var socks = [];
      for (var s2 = 0; s2 < 20; s2++) socks.push({ p: [W / 2 - .06, .14 + s2 * .085, -D / 2 + .008] });
      g.add(U.inst(U.geoBox(.03, .028, .004), 'hole', socks));
      var pduLbl = U.decal('PDU 32A', .07, .016, '#8fb9c6', 22);
      pduLbl.position.set(W / 2 - .06, Hh - .26, -D / 2 + .007);
      g.add(pduLbl);

      /* 前门网孔（整机模式细节层） */
      var dots = [], rnd = lcg(7717);
      for (var r = 0; r < 27; r++) {
        for (var cc = 0; cc < 14; cc++) {
          if (rnd() > .93) continue;
          dots.push({ p: [-W / 2 + .05 + cc * .038, .17 + r * .062, D / 2 - .004] });
        }
      }
      var door = U.inst(U.geoBox(.02, .02, .0022), 'mesh', dots);
      door.userData.door = true;
      g.add(door);

      /* 空 U 位盲板：真实机柜靠它填满并导风 */
      var blanks = [], occ = cfg.occupied || [];
      for (var uu = 1; uu <= 41; uu++) {
        var y0 = uY(uu), ym = y0 + UH / 2;
        var used = false;
        for (var oi = 0; oi < occ.length; oi++) {
          if (ym > occ[oi][0] - UH * .35 && ym < occ[oi][1] + UH * .35) { used = true; break; }
        }
        if (used) continue;
        blanks.push({ p: [0, ym, D / 2 - .032] });
      }
      if (blanks.length) {
        var bp = U.inst(U.geoBox(W - .13, UH * .82, .007), 'frameDark', blanks);
        bp.userData.blank = true;
        g.add(bp);
        var bv = [];
        blanks.forEach(function (b) {
          for (var t = 0; t < 3; t++) bv.push({ p: [-.07 + t * .07, b.p[1], D / 2 - .027] });
        });
        var bvt = U.inst(U.geoBox(.056, .006, .004), 'hole', bv);
        bvt.userData.blank = true;
        g.add(bvt);
      }

      /* 底部铭牌 */
      var plate = U.decal((cfg.name || '') + '  ·  42U', .17, .032, '#9fe9d8', 34);
      plate.position.set(-W / 2 + .13, .078, D / 2 + .002);
      g.add(plate);

      return res;
    }

    /* ══════════════════════════════════════════════════════════
       4U GPU 机架服务器
       ══════════════════════════════════════════════════════════ */
    function server(cfg) {
      var w = SRV_W, h = cfg.h || SRV_H, d = SRV_D;
      var g = new THREE.Group();
      var res = { group: g, parts: [], exploders: [], gpus: [] };
      var body = { parts: res.parts };
      var cxl = !!cfg.cxlOn;
      var halfH = h / 2, halfD = d / 2;

      /* 机匣 + 内衬 */
      var shell = U.boxE(w - .035, h, d, 'chassis', {
        color: cxl ? C_cxl() : 0x64808f, opacity: cxl ? .95 : .55
      });
      var sm = shell.userData.mesh;
      sm.material.emissive.setHex(cxl ? 0x08231e : 0x000000);
      sm.material.emissiveIntensity = cxl ? .5 : 0;
      g.add(shell);
      g.add(U.liner(sm, 'liner'));
      meta(sm, body, cfg.meta);

      /* 顶盖：工业镀锌拉丝钢板，带快拆把手与型号丝印，可独立拆 */
      var lid = U.boxE(w - .042, .005, d - .05, 'steel', { color: 0x4a5d6b, opacity: .85 });
      lid.position.set(0, halfH - .0025, -.01);
      g.add(lid);
      meta(lid.userData.mesh, body, { name: (cfg.nid || '') + ' · 上盖', detail: '快拆式冷轧钢机盖 · 带导风密封条' });
      var lidTabs = [];
      [-.14, .14].forEach(function (x) { lidTabs.push({ p: [x, halfH + .004, .12] }); });
      g.add(U.inst(U.geoBox(.05, .008, .018), 'plastic', lidTabs));
      var lidLbl = U.decal((cfg.nid || 'SRV') + '  4U GPU  ·  4×H100', .19, .024, '#a2c4d4', 22);
      lidLbl.position.set(-.02, halfH + .001, -.14);
      lidLbl.rotation.x = -Math.PI / 2;
      g.add(lidLbl);

      /* 前面板：19″ 满幅深黑阳极氧化铝合金面板 + 左右耳挂 + 盘位 + 状态灯 + 铭牌 */
      var bezel = U.boxE(w, h - .008, .014, 'plastic', { color: 0x161e24, opacity: .95 });
      bezel.position.set(0, 0, halfD - .007);
      g.add(bezel);
      meta(bezel.userData.mesh, body, { name: (cfg.nid || '') + ' · 前面板', detail: '19″ 满幅 · 12 盘位 · 状态灯组' });
      [-1, 1].forEach(function (sgn) {
        var ear = U.boxE(.022, h - .006, .016, 'steel', { color: 0x5a6d7c, opacity: .9 });
        ear.position.set(sgn * (w / 2 - .011), 0, halfD - .002);
        g.add(ear);
      });

      var bays = [], tabs = [];
      for (var b = 0; b < 12; b++) {
        var bx = -.185 + b * .0337;
        bays.push({ p: [bx, .018, halfD + .001] });
        tabs.push({ p: [bx, -.026, halfD + .005] });
      }
      g.add(U.inst(U.geoBox(.029, h * .5, .008), 'tray', bays));
      g.add(U.inst(U.geoBox(.026, .005, .005), 'goldBright', tabs));

      var leds = [];
      for (var l = 0; l < 5; l++) leds.push({ p: [.226 + (l % 2) * .011, .028 - Math.floor(l / 2) * .013, halfD + .004] });
      g.add(U.inst(U.geoBox(.007, .005, .003), 'ledGreen', leds));

      var srvLbl = U.decal(cfg.nid || 'SRV', .04, .016, '#7ff0d3', 26);
      srvLbl.position.set(-.235, -.004, halfD + .008);
      g.add(srvLbl);

      /* 顶盖散热开孔 */
      var slots = [];
      for (var sr = 0; sr < 3; sr++) {
        for (var sc = 0; sc < 15; sc++) slots.push({ p: [-.22 + sc * .031, halfH - .001, -.24 + sr * .16] });
      }
      g.add(U.inst(U.geoBox(.022, .003, .1), 'hole', slots));

      /* 滑轨（装在机架导轨上，而不是悬空） */
      [-1, 1].forEach(function (sgn) {
        var rail = U.box(.014, .012, d - .04, 'steel');
        rail.position.set(sgn * (w / 2 + .004), -halfH + .006, -.01);
        g.add(rail);
      });

      /* 主板：平铺满内腔底面 */
      var mobo = U.box(w - .055, .004, d - .1, 'pcb');
      mobo.position.set(0, -halfH + .016, -.01);
      g.add(mobo);
      meta(mobo, body, { name: (cfg.nid || '') + ' · 主板', detail: '双 L-socket · 32 DIMM · 4 × PCIe5 x16' });

      /* 去耦电容 */
      var caps = [], rc = lcg(9101 + (cfg.idx || 0));
      for (var ci = 0; ci < 24; ci++) caps.push({ p: [-.18 + rc() * .36, -halfH + .023, -.26 + rc() * .44] });
      g.add(U.inst(U.geoCyl(.0035, .008, 6), 'cap', caps));

      /* CPU 均热盖 ×2（镜面金属） */
      var cpuList = [{ p: [-.085, -halfH + .03, .11] }, { p: [.085, -halfH + .03, .11] }];
      var cpu = U.inst(U.geoBox(.078, .012, .078), 'die', cpuList);
      g.add(cpu);
      meta(cpu, body, { name: (cfg.nid || '') + ' · CPU ×2', detail: '双路主机节点 · Prefill 编排与调度' });

      /* DIMM：主板两侧各 8 条竖插 + 金手指 */
      var dimm = [], gold = [];
      [-1, 1].forEach(function (sgn) {
        for (var dd = 0; dd < 8; dd++) {
          var dx = sgn * (.04 + dd * .0135);
          dimm.push({ p: [dx, -halfH + .046, .02] });
          gold.push({ p: [dx, -halfH + .023, .02] });
        }
      });
      var dimmMesh = U.inst(U.geoBox(.0065, .055, .028), 'dimm', dimm);
      g.add(dimmMesh);
      meta(dimmMesh, body, { name: (cfg.nid || '') + ' · DDR5 DIMM ×16', detail: '本机 DRAM · 非共享 KV 池' });
      g.add(U.inst(U.geoBox(.0065, .005, .028), 'gold', gold));

      /* 风扇墙：真实机架服务器前半部特征 */
      var fanBody = [], fanHub = [];
      for (var fi = 0; fi < 4; fi++) {
        var fx = -.15 + fi * .1;
        fanBody.push({ p: [fx, -halfH + .062, .235], r: [Math.PI / 2, 0, 0] });
        fanHub.push({ p: [fx, -halfH + .062, .236], r: [Math.PI / 2, 0, 0] });
      }
      var fanMesh = U.inst(U.geoCyl(.042, .03, 16), 'plastic', fanBody);
      g.add(fanMesh);
      meta(fanMesh, body, { name: (cfg.nid || '') + ' · 风扇墙 ×4', detail: 'N+1 冗余 · 前进后出风道' });
      g.add(U.inst(U.geoCyl(.014, .032, 10), 'steel', fanHub));
      var baffle = U.box(.004, .1, .06, 'plastic');
      baffle.position.set(0, -halfH + .06, .185);
      g.add(baffle);

      /* GPU 模组 ×4：竖插在转接卡上（真实 PCIe 服务器形态） */
      var gpus = [];
      for (var k = 0; k < 4; k++) {
        var mod = gpuModule(U, THREE, { h: .1, len: .09 });
        mod.position.set(-.135 + k * .09, -halfH + .022, -.06);
        g.add(mod);
        gpus.push(mod);
        if (k === 0) meta(mod.userData.main, body, cfg.gpuMeta || { name: 'GPU 模组 ×4', detail: 'H100 · 80 GB HBM · 生成 KV' });
      }
      res.gpus = gpus;

      /* 尾部 PCIe 网卡（竖插）+ CXL / RDMA 端口在后面板 */
      var rnic = U.boxE(.016, .062, .11, 'pcbDark', { color: cxl ? C_cxl() : 0x6f9fb8, opacity: .85 });
      rnic.position.set(.15, -halfH + .05, -.23);
      g.add(rnic);
      var rnicChips = [];
      for (var rk = 0; rk < 3; rk++) rnicChips.push({ p: [.152, -halfH + .075 - rk * .017, -.23] });
      g.add(U.inst(U.geoBox(.01, .014, .03), 'chip', rnicChips));
      meta(rnic.userData.mesh, body, {
        name: (cfg.nid || '') + ' · CXL / RDMA 网卡',
        detail: cxl ? '1×CXL 2.0 + 1×200G RDMA · C 口已启用' : '1×CXL（未启用）+ 1×200G RDMA'
      });

      var back = U.boxE(w - .04, h - .02, .008, 'steel', { color: 0x6d8896, opacity: .55 });
      back.position.set(0, 0, -halfD + .004);
      g.add(back);
      meta(back.userData.mesh, body, { name: (cfg.nid || '') + ' · 后面板', detail: 'IO 挡板 · 2 电源 · 走线出口' });

      var pc = U.cyl(.011, .022, 12, cxl ? 'portCxlOn' : 'portOff');
      pc.rotation.x = Math.PI / 2; pc.position.set(-.13, .012, -halfD - .006);
      var pr = U.cyl(.011, .022, 12, 'portRdma');
      pr.rotation.x = Math.PI / 2; pr.position.set(-.075, .012, -halfD - .006);
      g.add(pc); g.add(pr);
      var lc = U.decal('CXL', .032, .013, cxl ? '#7ff0d3' : '#6f8592', 24);
      lc.position.set(-.13, .036, -halfD - .012);
      var lr = U.decal('RDMA', .036, .013, '#96c2ff', 24);
      lr.position.set(-.075, .036, -halfD - .012);
      g.add(lc); g.add(lr);
      res.ports = { c: pc, r: pr };
      res.rnic = rnic;

      /* 后置双冗余电源（抽拉式，带风扇圈与把手） */
      var psu = new THREE.Group();
      [-1, 1].forEach(function (sgn) {
        var can = U.boxE(.15, h - .03, .15, 'steel', { color: 0x7c98a6, opacity: .55 });
        can.position.set(sgn * .19, 0, -halfD + .082);
        psu.add(can);
        var ring = new THREE.Mesh(U.geoTorus(.042, .006, 8, 18), U.m('steel'));
        ring.rotation.x = Math.PI / 2;
        ring.position.set(sgn * .19, 0, -halfD + .006);
        psu.add(ring);
        var hd = U.box(.09, .01, .012, 'plastic');
        hd.position.set(sgn * .19, -h / 2 + .02, -halfD + .004);
        psu.add(hd);
        if (sgn < 0) meta(can.userData.mesh, body, { name: (cfg.nid || '') + ' · 冗余电源 2×2000W', detail: '白金效率 · 1+1 热插拔' });
      });
      g.add(psu);
      res.psu = psu;

      /* 拆解：机盖 → 风扇 → GPU → DIMM → 网卡 → 电源 → 主板 */
      res.exploders = [
        { obj: lid, dir: [0, 1, .06], dist: .105, order: .5 },
        { obj: fanMesh, dir: [0, .25, 1], dist: .11, order: .55 },
        { obj: gpus[0], dir: [0, 1, .12], dist: .088, order: .6 },
        { obj: gpus[1], dir: [0, 1, .12], dist: .104, order: .62 },
        { obj: gpus[2], dir: [0, 1, .12], dist: .12, order: .64 },
        { obj: gpus[3], dir: [0, 1, .12], dist: .136, order: .66 },
        { obj: dimmMesh, dir: [0, 1, 0], dist: .06, order: .7 },
        { obj: rnic, dir: [.9, .3, -.4], dist: .12, order: .74 },
        { obj: psu, dir: [0, .12, -1], dist: .12, order: .78 },
        { obj: mobo, dir: [0, .8, -.2], dist: .035, order: .84 },
        { obj: bezel, dir: [0, 0, 1], dist: .14, order: .46 }
      ];
      res.shellMesh = sm;
      res.parts = body.parts;
      return res;
    }

    /* 竖插 GPU 模组：PCB 垂直 + 均热盖 + 顶部鳍片 + 背板 + 供电口 + 挡板 */
    function gpuModule(U, THREE, o) {
      var hgt = o.h || .1, len = o.len || .09;
      var g = new THREE.Group();

      var board = U.box(.0025, hgt, len, 'pcbDark');
      board.position.set(0, hgt / 2, 0);
      g.add(board);
      g.userData.main = board;

      var lid = U.box(.03, .006, len * .55, 'die');
      lid.position.set(.012, hgt - .004, -.006);
      g.add(lid);

      var fins = [];
      for (var i = 0; i < 9; i++) fins.push({ p: [.012, hgt - .016, -.038 + i * .0095] });
      g.add(U.inst(U.geoBox(.055, .026, .0022), 'alu', fins));

      var back = U.box(.0018, hgt * .92, len * .96, 'alu');
      back.position.set(-.006, hgt / 2, 0);
      g.add(back);

      var riser = U.box(.004, .022, len * .5, 'pcb');
      riser.position.set(0, .011, .012);
      g.add(riser);

      var pwr = U.box(.014, .012, .02, 'plastic');
      pwr.position.set(.014, hgt + .004, .028);
      g.add(pwr);

      var bracket = U.box(.0022, hgt * .8, .032, 'steel');
      bracket.position.set(-.008, hgt * .45, len / 2 - .008);
      g.add(bracket);

      var vram = [];
      for (var v = 0; v < 6; v++) {
        vram.push({ p: [-.004, .03 + (v % 2) * .045, -.03 + Math.floor(v / 2) * .03] });
      }
      g.add(U.inst(U.geoBox(.0035, .014, .016), 'chip', vram));
      return g;
    }

    /* ══════════════════════════════════════════════════════════
       CXL Switch（1U 机架式）
       ══════════════════════════════════════════════════════════ */
    function cxlSwitch(cfg) {
      var w = SRV_W, h = cfg.h || (2 * UH), d = .42;
      var g = new THREE.Group();
      var res = { group: g, parts: [], exploders: [] };
      var body = { parts: res.parts };

      var shell = U.boxE(w, h, d, 'switchBody', { color: C_cxl(), opacity: .92 });
      shell.userData.mesh.material.emissive.setHex(0x062a23);
      shell.userData.mesh.material.emissiveIntensity = .75;
      g.add(shell);
      g.add(U.liner(shell.userData.mesh, 'liner'));
      meta(shell.userData.mesh, body, cfg.meta);

      /* 前面板 Host 端口笼 ×8 */
      var bezel = U.boxE(w, h - .006, .012, 'plastic', { color: 0x111c19, opacity: .95 });
      bezel.position.set(0, 0, d / 2 - .006);
      g.add(bezel);
      var cages = [], lips = [];
      for (var i = 0; i < 8; i++) {
        var cx = -.175 + i * .05;
        cages.push({ p: [cx, .004, d / 2 + .001] });
        lips.push({ p: [cx, -.013, d / 2 + .004] });
      }
      var cageMesh = U.inst(U.geoBox(.038, .016, .012), 'shield', cages);
      g.add(cageMesh);
      meta(cageMesh, body, { name: 'Host 端口 ×8', detail: 'CXL 2.0 x16 · 已用 ' + (cfg.hostUsed || 2) + ' / 8' });
      g.add(U.inst(U.geoBox(.034, .003, .005), 'gold', lips));

      var leds = [];
      for (var li = 0; li < 8; li++) leds.push({ p: [-.175 + li * .05, -.002, d / 2 + .004] });
      g.add(U.inst(U.geoBox(.006, .004, .003), 'ledCxl', leds));

      /* 顶面鳍片 + 主控 + 电容 */
      var fins = [];
      for (var f = 0; f < 15; f++) fins.push({ p: [0, h / 2 + .008, -.17 + f * .024] });
      var finMesh = U.inst(U.geoBox(w * .8, .016, .0045), 'alu', fins);
      g.add(finMesh);
      meta(finMesh, body, { name: '无风扇散热鳍片', detail: '铝挤型 · 被动散热 30 W' });

      var asic = U.box(.06, .007, .06, 'die');
      asic.position.set(.06, h / 2 + .006, -.06);
      g.add(asic);
      meta(asic, body, { name: 'CXL 交换主控', detail: '< 150 ns 端口时延' });

      var caps = [], rc = lcg(4412);
      for (var ci = 0; ci < 16; ci++) caps.push({ p: [-.14 + rc() * .28, h / 2 + .005, -.16 + rc() * .3] });
      g.add(U.inst(U.geoCyl(.0032, .007, 6), 'cap', caps));

      var lbl = U.decal('CXL SWITCH 1U', .12, .018, '#8fe7d3', 24);
      lbl.position.set(-.1, h / 2 + .0015, .12);
      lbl.rotation.x = -Math.PI / 2;
      g.add(lbl);

      [-1, 1].forEach(function (sgn) {
        var ear = U.box(.02, h - .008, .012, 'steel');
        ear.position.set(sgn * (w / 2 - .01), 0, d / 2 - .002);
        g.add(ear);
      });

      res.exploders = [
        { obj: finMesh, dir: [0, 1, 0], dist: .07, order: .6 },
        { obj: bezel, dir: [0, 0, 1], dist: .1, order: .5 }
      ];
      res.parts = body.parts;
      return res;
    }

    /* ══════════════════════════════════════════════════════════
       共享 MHD 池（3U 机箱 + 3 个热插抽屉）
       ══════════════════════════════════════════════════════════ */
    function mhdPool(cfg) {
      var w = SRV_W, h = cfg.h || (3 * UH), d = .48;
      var g = new THREE.Group();
      var res = { group: g, parts: [], exploders: [], modules: [] };
      var body = { parts: res.parts };
      var units = cfg.units || [];

      var frame = U.boxE(w, h, d, 'mhdFrame', { color: C_cxl(), opacity: .82 });
      frame.userData.mesh.material.emissive.setHex(0x051c18);
      frame.userData.mesh.material.emissiveIntensity = .65;
      g.add(frame);
      g.add(U.liner(frame.userData.mesh, 'liner'));
      meta(frame.userData.mesh, body, cfg.meta);

      var bezel = U.boxE(w, h - .008, .012, 'plastic', { color: 0x0e1c18, opacity: .95 });
      bezel.position.set(0, 0, d / 2 - .006);
      g.add(bezel);

      /* 导轨 */
      var rails = [];
      for (var k = 0; k < 3; k++) rails.push({ p: [-.152 + k * .152, -h / 2 + .005, .01] });
      g.add(U.inst(U.geoBox(.14, .005, d - .1), 'steel', rails));

      for (var m = 0; m < 3; m++) {
        var has = m < units.length;
        var mod = new THREE.Group();
        var can = U.boxE(.138, h - .018, d - .06, has ? 'mhdUnit' : 'blank', {
          color: has ? C_cxl() : 0x4b6470, opacity: has ? .95 : .5
        });
        can.userData.mesh.material.emissive.setHex(has ? C_cxl() : 0x000000);
        can.userData.mesh.material.emissiveIntensity = has ? .55 : 0;
        mod.add(can);
        meta(can.userData.mesh, body, {
          name: has ? ('MHD-' + (m + 1) + ' · ' + (cfg.capOf ? cfg.capOf(m) : '512 GB')) : '空槽位',
          detail: has ? 'CXL 内存设备 · 机架内共享池' : '可插入 MHD 单元'
        });

        var handle = U.box(.118, .009, .011, 'steel');
        handle.position.set(0, h * .13, d / 2 + .004);
        mod.add(handle);
        var led = U.box(.01, .006, .004, has ? 'ledCxl' : 'ledOff');
        led.position.set(-.05, -h * .16, d / 2 + .004);
        mod.add(led);
        if (has) mod.userData.pulse = led;

        var dram = [];
        for (var dr = 0; dr < 2; dr++) {
          for (var di = 0; di < 9; di++) dram.push({ p: [-.052 + di * .013, h * .02, -.1 + dr * .12] });
        }
        mod.add(U.inst(U.geoBox(.01, .004, .06), 'chip', dram));
        var gold = [];
        for (var gi = 0; gi < 9; gi++) gold.push({ p: [-.052 + gi * .013, h * .014, .12] });
        mod.add(U.inst(U.geoBox(.01, .0025, .032), 'gold', gold));

        mod.position.set(-.152 + m * .152, 0, .01);
        mod.userData.homeX = mod.position.x;
        g.add(mod);
        res.modules.push(mod);
      }

      var lbl = U.decal('SHARED CXL MHD', .14, .018, '#8fe7d3', 24);
      lbl.position.set(-.1, h / 2 + .0015, .1);
      lbl.rotation.x = -Math.PI / 2;
      g.add(lbl);

      /* 后面板 + CXL 上行口（有源线缆从这里出，走机柜后部） */
      var rear = U.boxE(w - .04, h - .02, .008, 'steel', { color: 0x6d8896, opacity: .55 });
      rear.position.set(0, 0, -d / 2 + .004);
      g.add(rear);
      var rc2 = [], rl2 = [];
      [-.14, -.09].forEach(function (x) { rc2.push({ p: [x, 0, -d / 2 - .003] }); rl2.push({ p: [x, -.012, -d / 2 - .006] }); });
      var rcage = U.inst(U.geoBox(.038, .016, .012), 'shield', rc2);
      g.add(rcage);
      meta(rcage, body, { name: 'CXL 上行端口 ×2', detail: 'MDP M1/M2 · 有源线缆接 Switch' });
      g.add(U.inst(U.geoBox(.034, .003, .005), 'gold', rl2));

      res.exploders = [];
      res.parts = body.parts;
      return res;
    }

    /* ══════════════════════════════════════════════════════════
       ToR / Spine：1U 交换机形态
       ══════════════════════════════════════════════════════════ */
    function switchBox(cfg) {
      var w = cfg.w || SRV_W, h = cfg.h || UH, d = cfg.d || .4;
      var g = new THREE.Group();
      var res = { group: g, parts: [], exploders: [] };
      var body = { parts: res.parts };

      var shell = U.boxE(w, h, d, 'switchBody', { color: cfg.edge, opacity: .8 });
      g.add(shell);
      g.add(U.liner(shell.userData.mesh, 'liner'));
      meta(shell.userData.mesh, body, cfg.meta);

      var bezel = U.boxE(w, h - .004, .01, 'plastic', { color: 0x5f7d8c, opacity: .55 });
      bezel.position.set(0, 0, d / 2 - .005);
      g.add(bezel);

      var n = cfg.ports || 12;
      var pitch = Math.min(.03, (w * .8) / n);
      var x0 = -(n - 1) * pitch / 2;
      var cages = [], leds = [];
      for (var i = 0; i < n; i++) {
        cages.push({ p: [x0 + i * pitch, 0, d / 2 + .001] });
        leds.push({ p: [x0 + i * pitch, -h * .3, d / 2 + .003] });
      }
      var cageMesh = U.inst(U.geoBox(.024, .012, .01), 'shield', cages);
      g.add(cageMesh);
      meta(cageMesh, body, { name: cfg.portsName, detail: cfg.portsDetail });
      g.add(U.inst(U.geoBox(.006, .004, .003), 'ledGreen', leds));

      var slats = [];
      var sn = Math.round(w / .042);
      for (var s = 0; s < sn; s++) slats.push({ p: [-w / 2 + .028 + s * .042, h / 2 + .001, 0] });
      g.add(U.inst(U.geoBox(.03, .003, d * .55), 'hole', slats));

      [-1, 1].forEach(function (sgn) {
        var ear = U.box(.018, h - .005, .01, 'steel');
        ear.position.set(sgn * (w / 2 - .009), 0, d / 2 - .002);
        g.add(ear);
      });

      var lbl = U.decal(cfg.label, Math.min(.15, w * .45), .016, cfg.labelColor || '#9ec7dd', 22);
      lbl.position.set(-w / 2 + .08, h / 2 + .0015, -d / 2 + .05);
      lbl.rotation.x = -Math.PI / 2;
      g.add(lbl);

      res.parts = body.parts;
      return res;
    }

    /* ══════════════════════════════════════════════════════════
       线缆 + 扎带
       ══════════════════════════════════════════════════════════ */
    function cable(points, color, radius, opt) {
      opt = opt || {};
      var curve = new THREE.CatmullRomCurve3(
        points.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); }), false, 'catmullrom', .35);
      var geo = new THREE.TubeGeometry(curve, Math.max(28, points.length * 14), radius || .0042, 7, false);
      var mat = new THREE.MeshStandardMaterial({
        color: color, roughness: .55, metalness: .1, transparent: true,
        opacity: opt.opacity != null ? opt.opacity : .55,
        emissive: color, emissiveIntensity: .3, depthWrite: false
      });
      var m = new THREE.Mesh(geo, mat);
      m.userData.cable = { curve: curve, color: color, group: opt.group || 'data' };
      return m;
    }

    function straps(curve, n) {
      var list = [];
      for (var i = 1; i <= n; i++) {
        var p = curve.getPointAt(i / (n + 1));
        list.push({ p: [p.x, p.y, p.z] });
      }
      return U.inst(U.geoBox(.013, .013, .013), 'velcro', list);
    }

    function put(group, x, y, z) { group.position.set(x, y, z); return group; }
    function C_cxl() { return H.C ? H.C.cxl : 0x53e3c4; }
  };
})();
