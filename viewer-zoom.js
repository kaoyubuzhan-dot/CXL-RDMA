/* ============================================================
 * viewer-zoom.js — 画布缩放 / 平移（滚轮缩放 + 拖拽平移 + 按钮）
 * 通过改写 #canvas 的 viewBox 实现，不改动任何渲染器内部坐标，
 * 因此对所有视图（2D 总览 / 三维机架 / 集群 3D / 推理管线）同时生效。
 * ============================================================ */
(function () {
  'use strict';

  const Z = {
    base: [0, 0, 1200, 720],   // 当前视图的基准视窗
    scale: 1,
    tx: 0,                     // 视窗中心相对基准中心的偏移（viewBox 单位）
    ty: 0,
    min: 0.85,
    max: 5.0
  };

  function canvas() { return document.getElementById('canvas'); }

  function viewRect() {
    const [bx, by, bw, bh] = Z.base;
    const w = bw / Z.scale, h = bh / Z.scale;
    const cx = bx + bw / 2 + Z.tx, cy = by + bh / 2 + Z.ty;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function clampPan() {
    const [bx, by, bw, bh] = Z.base;
    const w = bw / Z.scale;
    const maxTx = (bw - w) / 2 + 40;
    if (w <= bw) Z.tx = Math.min(Math.max(Z.tx, -maxTx), maxTx);
    else Z.tx = 0;
    const h = bh / Z.scale;
    const maxTy = (bh - h) / 2 + 40;
    if (h <= bh) Z.ty = Math.min(Math.max(Z.ty, -maxTy), maxTy);
    else Z.ty = 0;
    if (Z.scale <= 1.02) { Z.tx = 0; Z.ty = 0; }
  }

  function hud() {
    const el = document.getElementById('zoom-val');
    if (el) el.textContent = Math.round(Z.scale * 100) + '%';
    const c = canvas();
    if (c) c.style.cursor = Z.scale > 1.02 ? 'grab' : 'default';
  }

  Z.apply = function () {
    const c = canvas();
    if (!c) return;
    if (Z.scale <= 1.001) { Z.scale = 1; Z.tx = 0; Z.ty = 0; }
    clampPan();
    const r = viewRect();
    c.setAttribute('viewBox', `${r.x.toFixed(1)} ${r.y.toFixed(1)} ${r.w.toFixed(1)} ${r.h.toFixed(1)}`);
    hud();
  };

  Z.setBase = function (vb) {
    const same = Z.base && vb.length === 4 && Z.base.every(function (v, i) { return Math.abs(v - vb[i]) < 0.5; });
    Z.base = vb.slice();
    if (Z.pending) {          // 首帧应用 URL 预置的缩放，之后交给用户操作
      Z.scale = Z.pending.scale; Z.tx = Z.pending.tx; Z.ty = Z.pending.ty;
      Z.pending = null;
    } else if (!same) {
      Z.scale = 1; Z.tx = 0; Z.ty = 0;   // 只有换视图才回到 100%
    }
    // 同一个视图反复重绘（点选、动画、分步）保持用户当前缩放与位置
  };

  Z.reset = function () { Z.scale = 1; Z.tx = 0; Z.ty = 0; Z.apply(); };

  Z.zoomAt = function (factor, clientX, clientY) {
    const c = canvas();
    if (!c) return;
    const before = viewRect();
    const next = Math.min(Z.max, Math.max(Z.min, Z.scale * factor));
    if (Math.abs(next - Z.scale) < 1e-4) return;
    // 指针落在视窗内的比例
    const rect = c.getBoundingClientRect();
    let fx = 0.5, fy = 0.5;
    if (typeof clientX === 'number') {
      const spanX = before.w / rect.width;   // viewBox 单位 / 屏幕像素
      const spanY = before.h / rect.height;
      fx = Math.min(1, Math.max(0, (clientX - rect.left) * spanX / before.w));
      fy = Math.min(1, Math.max(0, (clientY - rect.top) * spanY / before.h));
    }
    const px = before.x + before.w * fx, py = before.y + before.h * fy;
    Z.scale = next;
    const [bx, by, bw, bh] = Z.base;
    const w2 = bw / Z.scale, h2 = bh / Z.scale;
    const x0 = px - fx * w2, y0 = py - fy * h2;
    Z.tx = (x0 + w2 / 2) - (bx + bw / 2);
    Z.ty = (y0 + h2 / 2) - (by + bh / 2);
    Z.apply();
  };

  /* ---------- 交互绑定 ---------- */
  function bind() {
    const c = canvas();
    if (!c || c.__zoomBound) return;
    c.__zoomBound = true;

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      Z.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });

    let dragging = false, lastX = 0, lastY = 0, moved = 0;
    c.addEventListener('pointerdown', function (e) {
      if (Z.scale <= 1.02 || e.button !== 0) return;
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const rect = c.getBoundingClientRect();
      const r = viewRect();
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      Z.tx -= dx * (r.w / rect.width);
      Z.ty -= dy * (r.h / rect.height);
      lastX = e.clientX; lastY = e.clientY;
      Z.apply();
      e.preventDefault();
    });
    const stop = function (e) {
      if (!dragging) return;
      dragging = false;
      try { c.releasePointerCapture(e.pointerId); } catch (_) {}
      hud();
      if (moved > 6) {          // 拖过就别再触发"点击机架/节点"
        const swallow = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
        c.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(function () { c.removeEventListener('click', swallow, { capture: true }); }, 0);
      }
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    c.addEventListener('dblclick', function () { Z.reset(); });

    const zi = document.getElementById('zoom-in');
    const zo = document.getElementById('zoom-out');
    const zv = document.getElementById('zoom-val');
    if (zi) zi.addEventListener('click', function () { Z.zoomAt(1.18); });
    if (zo) zo.addEventListener('click', function () { Z.zoomAt(1 / 1.18); });
    if (zv) zv.addEventListener('click', function () { Z.reset(); });
    const fit = document.getElementById('fit-btn');
    if (fit) fit.addEventListener('click', function () { Z.reset(); });
  }

  window.__ZOOM__ = Z;

  /* URL 预置：?z=1.6&zx=600&zy=380（zx/zy 为视窗中心，单位与 viewBox 一致） */
  (function () {
    try {
      const q = new URLSearchParams(location.search);
      const z = parseFloat(q.get('z'));
      const zx = parseFloat(q.get('zx')), zy = parseFloat(q.get('zy'));
      if (!(isFinite(z) && z > 0) && !isFinite(zx) && !isFinite(zy)) return;
      const [bx, by, bw, bh] = Z.base;
      Z.pending = {
        scale: Math.min(Z.max, Math.max(Z.min, isFinite(z) && z > 0 ? z : 1)),
        tx: isFinite(zx) ? zx - (bx + bw / 2) : 0,
        ty: isFinite(zy) ? zy - (by + bh / 2) : 0
      };
    } catch (_) {}
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
