/* ============================================================
 * flow-3d.js — 把「运行流程」七阶段桥接到三维集群
 *
 * 复用 webgl-cluster.js（四机架 2×2 + Controller + Pool + Spine）
 * 与其 act 动画语言：
 *   { mk:[{kv,at,pulse}], paths:[{k,a,b,w}], mkMove:{kv,from,to},
 *     mkCopy:{...}, mon:'all'|['R1'], ctrlPulse:1, cong:['L24'] }
 * 端点：R1.N1..N4 · R1.MHD · R1.TOR · SPINE · POOL · CTRL
 *
 * 与 webgl-cluster 共享同一个 #gllc 容器，避免重复初始化 WebGL。
 * ============================================================ */
window.FLOW_3D = (function () {
  'use strict';

  var GL = null, hostEl = null, mounted = false, onPickCb = null;

  function gl() {
    if (!GL) GL = window.__GLCLUSTER__;
    return (GL && GL.available) ? GL : null;
  }
  function available() { return !!gl(); }

  /* ── 端点推导 ── */
  function nodeEP(str) {
    var m = /R(\d)[^N\d]{0,3}N(\d)/.exec(String(str || ''));
    return m ? 'R' + m[1] + '.N' + m[2] : null;
  }
  function rackOfEP(ep) { return String(ep || '').slice(0, 2); }
  function mhdEP(str) {
    if (/pool/i.test(str || '')) return 'POOL';
    var m = /R(\d)/.exec(String(str || ''));
    return m ? 'R' + m[1] + '.MHD' : 'R1.MHD';
  }

  var MK = function (kv, at, o) {
    var d = { kv: kv, at: at };
    if (o) for (var k in o) d[k] = o[k];
    return d;
  };
  var P = function (k, a, b, w) { return { k: k, a: a, b: b, w: w || 1 }; };

  /* 仅在对焦阶段用近景，其余保持全景：pool/ctrl 预设会被前排机架遮挡 */
  var CAM = {
    gen: 'R1', collect: 'all', decide: 'all', query: 'all',
    access: 'R1', migrate: 'all', evict: 'all'
  };

  /* ── 每个阶段的 3D 动作 ── */
  function buildAct(stageId, sc) {
    var kv = sc.kv;
    var prodEP = nodeEP(sc.prod) || 'R1.N1';
    var tgtEP = mhdEP(sc.dst);
    var peerEP = nodeEP(sc.peer) || 'R2.N1';
    var prodRack = rackOfEP(prodEP);

    switch (stageId) {
      case 'gen':
        return { mk: [MK(kv, prodEP, { pulse: 1 })] };

      case 'collect':
        return { mk: [MK(kv, prodEP)], mon: 'all', ctrlPulse: 1 };

      case 'decide':
        return {
          mk: [MK(kv, prodEP, { pulse: 1 })],
          mon: [prodRack, prodRack === 'R3' ? 'R1' : 'R3'],
          ctrlPulse: 1
        };

      case 'query':
        return { mk: [MK(kv, tgtEP)], mon: [prodRack], ctrlPulse: 1, paths: [P('mon', prodEP, 'CTRL', .8)] };

      case 'access':
        if (tgtEP === 'POOL') {
          return {
            mk: [MK(kv, 'POOL')],
            paths: [P('rdma', peerEP, 'SPINE', 1.2), P('rdma', 'SPINE', 'POOL', 1.2)]
          };
        }
        return {
          mk: [MK(kv, tgtEP)],
          paths: [
            P('cxl', tgtEP, prodEP, 2),
            P('rdma', peerEP, 'SPINE', .9),
            P('rdma', 'SPINE', tgtEP, .9)
          ]
        };

      case 'migrate':
        return {
          mkMove: { kv: kv, from: 'R3.MHD', to: tgtEP === 'POOL' ? 'POOL' : tgtEP },
          mkCopy: { kv: kv, from: peerEP, to: tgtEP === 'POOL' ? 'POOL' : tgtEP },
          paths: [
            P('move', 'R3.MHD', 'SPINE', 1.4), P('move', 'SPINE', tgtEP === 'POOL' ? 'POOL' : tgtEP, 1.4),
            P('copy', peerEP, 'SPINE', 1.1), P('copy', 'SPINE', tgtEP === 'POOL' ? 'POOL' : tgtEP, 1.1)
          ]
        };

      case 'evict':
        return {
          mkMove: { kv: kv, from: tgtEP === 'POOL' ? 'R1.MHD' : tgtEP, to: 'POOL' },
          paths: [P('idle', 'R1.MHD', 'SPINE', .5), P('rdma', 'SPINE', 'POOL', .8)]
        };
    }
    return { mk: [MK(kv, prodEP)] };
  }

  /* ── 挂载（与 lc 页共享 #gllc 容器） ── */
  function ensureHost() {
    if (hostEl && hostEl.isConnected) return hostEl;
    hostEl = document.getElementById('gllc');
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = 'gllc';
      var stage = document.getElementById('stage');
      (stage || document.body).appendChild(hostEl);
    }
    return hostEl;
  }

  function ensureMount(cb) {
    onPickCb = cb || onPickCb;
    var h = ensureHost();
    if (h.querySelector('canvas')) { mounted = true; return true; }
    var g = gl();
    if (!g) return false;
    try {
      g.mount(h, { onSelect: onSelect });
      mounted = true;
    } catch (e) {
      if (window.console) console.warn('[flow3d] mount failed', e);
      return false;
    }
    return true;
  }

  function onSelect(id) {
    if (onPickCb) onPickCb(id);
  }

  /* ── 播放 ── */
  function play(stage, sc) {
    if (!ensureMount()) return false;
    var g = gl();
    if (!g) return false;
    try {
      g.resize();
      g.applyStep(buildAct(stage.id, sc), null);
    } catch (e) {
      if (window.console) console.warn('[flow3d] play failed', e);
      return false;
    }
    /* 镜头放到下一帧：此时容器已完成布局，camTween 不会被 mount 的默认镜头覆盖 */
    var cam = CAM[stage.id] || 'all';
    var fly = function () {
      try { g.resize(); g.flyTo(cam); } catch (e) {}
    };
    if (window.requestAnimationFrame) requestAnimationFrame(fly); else fly();
    return true;
  }

  function resize() { var g = gl(); if (g && mounted) { try { g.resize(); } catch (e) {} } }
  function clearFx() { var g = gl(); if (g && mounted) { try { g.applyStep({}); } catch (e) {} } }

  return {
    available: available,
    ensureMount: ensureMount,
    play: play,
    resize: resize,
    clear: clearFx,
    buildAct: buildAct
  };
})();
