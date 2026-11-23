/* ============================================================
 * webgl-cluster-fx.js — 集群场景特效层（KV 标记 / 流动路径 / 采集流）
 *
 * 由 webgl-cluster.js 在 mount 时 init(ctx)，页面按剧本调用
 *   __GLCLUSTER_FX__.applyStep(act, onDone)   // 一步：路径+标记+采集流+移动KV
 *   __GLCLUSTER_FX__.tick(dt, t)              // 每帧推进
 * act 字段：paths[] mk[] mkMove{} mkCopy{} mon ctrlPulse cong
 * 配色：cxl 青绿 / rdma 蓝 / move 橙 / copy 紫 / idle 灰 / mon 采集
 * ============================================================ */
(function () {
  'use strict';

  var ctx = null, fx = null, anim = [], doneCb = null, moverDone = false;

  function v3(x, y, z) { return new ctx.THREE.Vector3(x, y, z); }
  function ep(ref) {
    var E = ctx.getEndpoints();
    if (E[ref]) return E[ref].clone();
    var mm = /^(R\d)\.(N\d|MHD|TOR)$/.exec(ref);
    if (mm && E[mm[1]] && E[mm[1]][mm[2]]) return E[mm[1]][mm[2]].clone();
    return v3(0, 1, 0);
  }
  function colorKey(k) {
    return { cxl: ctx.C.cxl, rdma: ctx.C.rdma, move: ctx.C.move, copy: ctx.C.copy, idle: ctx.C.idle, mon: ctx.C.mon }[k] || ctx.C.rdma;
  }

  /* 路径控制点：同机架=近距弧；跨机架=先出机柜、再经 Spine 或高空段 */
  function curveFor(a, b) {
    var A = ep(a), B = ep(b);
    var sameRack = /^R\d\./.test(a) && a.split('.')[0] === b.split('.')[0];
    var pts = [A.clone()], SPINE_Y = ctx.SPINE_Y;

    if (sameRack) {
      var m = A.clone().lerp(B, .5);
      m.z += .30; m.y += .06; m.x += .05;
      pts.push(m);
    } else {
      var out = A.clone(); out.y = Math.max(A.y, .35);
      out.x *= 1.18; out.z *= 1.18;
      pts.push(out);
      if (Math.abs(A.y - ctx.CTRL_Y) < 1.2 && (a === 'CTRL' || b === 'CTRL' || a === 'POOL' || b === 'POOL')) {
        pts.push(A.clone().lerp(B, .5).setY(Math.max(A.y, B.y, 1.4) + .3));
      } else {
        pts.push(v3(0, SPINE_Y + .10, 0));
      }
      var inn = B.clone(); inn.y = Math.max(B.y, .35);
      inn.x *= 1.18; inn.z *= 1.18;
      pts.push(inn);
    }
    pts.push(B.clone());
    return new ctx.THREE.CatmullRomCurve3(pts, false, 'catmullrom', .35);
  }

  function sprite(color, size, op) {
    var THREE = ctx.THREE;
    var s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ctx.glowTex(), color: color, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: op
    }));
    s.scale.set(size, size, 1);
    return s;
  }

  function clearFx() {
    anim = []; doneCb = null; moverDone = true;
    if (!fx) return;
    for (var i = fx.children.length - 1; i >= 0; i--) {
      var o = fx.children[i];
      fx.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
        else o.material.dispose();
      }
    }
  }

  function addFlow(def) {
    var THREE = ctx.THREE, col = colorKey(def.k);
    var curve = curveFor(def.a, def.b);
    var w = .0048 * (def.w || 1);
    var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, w, 6, false),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false }));
    tube.userData.fadeTo = def.k === 'idle' ? .28 : .5;
    fx.add(tube);

    var flows = [];
    if (def.k !== 'idle') {
      var n = 3 + Math.round(def.w || 1);
      for (var i = 0; i < n; i++) {
        var sp = sprite(col, .08 + .022 * (def.w || 1), .95);
        sp.userData.flow = {
          curve: curve, t: i / n,
          speed: (def.k === 'move' || def.k === 'copy') ? .17 : .3
        };
        fx.add(sp);
        flows.push(sp);
      }
    }
    anim.push({ kind: 'flow', tube: tube, flows: flows });
  }

  function addMarker(at, kv, o) {
    var THREE = ctx.THREE, U = ctx.U;
    o = o || {};
    var col = colorKey(o.color) || ctx.C.cxl;
    if (typeof o.color === 'number') col = o.color;
    var g = new THREE.Group();
    var cube = new THREE.Mesh(new THREE.BoxGeometry(.065, .065, .065),
      new THREE.MeshStandardMaterial({
        color: 0x0c1c22, metalness: .55, roughness: .3, emissive: col, emissiveIntensity: 1.5
      }));
    g.add(cube);
    g.add(sprite(col, .16, .85));
    var tag = U.decal(kv, .105, .032, '#eaffff', 22);
    tag.position.y = .062;
    tag.userData.billboard = 1;
    g.add(tag);
    g.position.copy(ep(at));
    if (o.pulse) g.userData.pulse = 1;
    fx.add(g);
    return g;
  }

  /* 移动 KV：沿 move/copy 路径从 from 走到 to */
  function addMover(mm, kind) {
    var THREE = ctx.THREE;
    var col = kind === 'copy' ? ctx.C.copy : ctx.C.move;
    addFlow({ k: kind, a: mm.from, b: mm.to, w: 2 });
    if (kind === 'copy') addMarker(mm.from, mm.kv, { color: ctx.C.rdma });   /* 原件留原位 */
    var g = addMarker(mm.from, mm.kv, { color: col, pulse: 1 });
    g.userData.mover = { curve: curveFor(mm.from, mm.to), t: 0, speed: .42 };
    moverDone = false;
    anim.push({ kind: 'mover', g: g });
  }

  function addMonFlow(keys) {
    var THREE = ctx.THREE, C = ctx.C, E = ctx.getEndpoints();
    var src = {
      gpu: E.R1 && E.R1.N1, host: v3(ctx.RACK_POS.R1.x, .9, ctx.RACK_POS.R1.z + .2),
      rnic: E.R2 && E.R2.TOR, leaf: E.SPINE, mhd: E.R1 && E.R1.MHD
    };
    var list;
    if (keys === 'all') list = ['gpu', 'host', 'rnic', 'leaf', 'mhd'];
    else if (Array.isArray(keys)) {
      list = [];
      keys.forEach(function (kk) {
        if (kk === 'R1') list.push('gpu', 'host', 'mhd');
        if (kk === 'R2' || kk === 'R3' || kk === 'R4') list.push('rnic');
        if (kk === 'SPINE') list.push('leaf');
      });
      list = list.filter(function (k, i) { return list.indexOf(k) === i; });
    } else list = [];
    var tgt = ep('CTRL').setY(ctx.CTRL_Y - .12);
    list.forEach(function (k, i) {
      var A = src[k];
      if (!A) return;
      var curve = new THREE.CatmullRomCurve3([
        A.clone(), A.clone().lerp(tgt, .5).setY(Math.max(A.y, tgt.y) + .32), tgt.clone()
      ], false, 'catmullrom', .4);
      var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 44, .0026, 5, false),
        new THREE.MeshBasicMaterial({ color: C.mon, transparent: true, opacity: 0, depthWrite: false }));
      tube.userData.fadeTo = .38;
      fx.add(tube);
      var flows = [];
      for (var j = 0; j < 2; j++) {
        var sp = sprite(C.mon, .05, .85);
        sp.userData.flow = { curve: curve, t: j / 2 + i * .11, speed: .36 };
        fx.add(sp);
        flows.push(sp);
      }
      anim.push({ kind: 'flow', tube: tube, flows: flows });
    });
  }

  function applyStep(act, onDone) {
    clearFx();
    doneCb = onDone || null;
    if (!act) { if (doneCb) { var cb = doneCb; doneCb = null; cb(); } return; }
    (act.paths || []).forEach(addFlow);
    (act.mk || []).forEach(function (m) { addMarker(m.at, m.kv, m); });
    if (act.mkMove) addMover(act.mkMove, 'move');
    if (act.mkCopy) addMover(act.mkCopy, 'copy');
    if (act.mon) addMonFlow(act.mon);
    var ctrl = ctx.getCtrl();
    if (act.ctrlPulse && ctrl) ctrl.userData.pulseT = 1.5;
    if (act.cong && window.__GLCLUSTER__) window.__GLCLUSTER__.setCong(act.cong);
    if (!anim.length && doneCb) { var cb2 = doneCb; doneCb = null; cb2(); }
  }

  function tick(dt, t) {
    if (!fx) return;
    var allDone = true;
    anim.forEach(function (a) {
      if (a.kind === 'flow') {
        var f = a.tube.userData;
        f.curOpacity = Math.min(f.fadeTo, (f.curOpacity || 0) + dt * 2.2);
        a.tube.material.opacity = f.curOpacity;
        if (!ctx.REDUCED) {
          a.flows.forEach(function (sp) {
            var u = sp.userData.flow;
            u.t += dt * u.speed;
            if (u.t > 1) u.t -= 1;
            sp.position.copy(u.curve.getPointAt(ctx.clamp01(u.t)));
          });
        }
      } else if (a.kind === 'mover') {
        var mv = a.g.userData.mover;
        if (mv.t < 1) {
          mv.t = Math.min(1, mv.t + dt * mv.speed);
          a.g.position.copy(mv.curve.getPointAt(ctx.ease(mv.t)));
          allDone = false;
        } else a.g.position.copy(mv.curve.getPointAt(1));
      }
    });
    if (!ctx.REDUCED) {
      fx.children.forEach(function (o) {
        if (o.isSprite && o.userData.flow && !o.userData.done) {
          /* 独立 sprite（mover 场景）由上面 anim 列表驱动，这里只处理 billboard */
        }
        if (o.userData && o.userData.pulse && o.children && o.children[0] && o.children[0].material) {
          o.children[0].material.emissiveIntensity = 1.3 + .8 * (.5 + .5 * Math.sin(t * 3.6));
        }
        /* 标签朝向相机 */
        o.traverse(function (c) {
          if (c.userData && c.userData.billboard && c.isMesh && ctx.getCamera()) c.quaternion.copy(ctx.getCamera().quaternion);
        });
      });
    } else {
      fx.children.forEach(function (o) {
        o.traverse(function (c) {
          if (c.userData && c.userData.billboard && c.isMesh && ctx.getCamera()) c.quaternion.copy(ctx.getCamera().quaternion);
        });
      });
    }
    if (allDone && !moverDone && doneCb) { moverDone = true; }
    if (allDone && moverDone && doneCb) { var cb = doneCb; doneCb = null; cb(); }
  }

  window.__GLCLUSTER_FX__ = {
    init: function (c) {
      ctx = c;
      fx = c.getFx();
    },
    applyStep: applyStep,
    tick: tick,
    clear: clearFx,
    curveFor: curveFor,
    endpoint: ep
  };
})();
