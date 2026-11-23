/* ============================================================
 * webgl-assembly.js — 装配树 + 剖层 / 拆解滑杆 + 部件档案
 * 结构参考 SmartNIC Lab / MRI-Anatomy：左侧装配树、% 拆解、部件聚焦
 * ============================================================ */
(function () {
  'use strict';

  const CATS = [
    ['compute', '计算节点'],
    ['cxl', 'CXL 域'],
    ['net', 'RDMA 网络'],
    ['frame', '机柜']
  ];
  const CAT_OF = { srv: 'compute', switch: 'cxl', mhd: 'cxl', tor: 'net', spine: 'net', shell: 'frame' };

  let host = null, treeEl = null, dossierEl = null, built = false;

  function catOf(id) {
    if (id.indexOf('srv') === 0) return 'compute';
    if (id.indexOf('mhd') === 0) return 'cxl';
    return CAT_OF[id] || 'frame';
  }

  function build() {
    if (!window.__GL3D__ || !host) return;
    const parts = window.__GL3D__.parts ? window.__GL3D__.parts() : [];
    if (!parts.length) { built = false; return; }

    if (!treeEl) {
      treeEl = document.createElement('div');
      treeEl.id = 'gl3d-tree';
      host.appendChild(treeEl);
      dossierEl = document.createElement('div');
      dossierEl.id = 'gl3d-dossier';
      host.appendChild(dossierEl);
    }

    let html = '<div class="tree-hd"><span>ASSEMBLY</span><b>' + parts.length + ' 部件</b></div><div class="tree-body">';
    CATS.forEach(function (c) {
      const list = parts.filter(function (p) { return catOf(p.id) === c[0]; });
      if (!list.length) return;
      html += '<div class="tree-cat">' + c[1] + '</div>';
      list.forEach(function (p) {
        html += '<button type="button" class="tree-row" data-id="' + p.id + '">' +
          '<span class="nm">' + p.name + '</span>' +
          '<span class="lv lv-' + (p.level || 'B').toLowerCase() + '">' + (p.level || 'B') + '</span></button>';
      });
    });
    html += '</div>';
    html += '<div class="tree-ctrl">' +
      '<label class="ct-row"><span>剖层</span><input type="range" min="0" max="100" value="0" id="gl-sec"><i id="gl-sec-val">0%</i></label>' +
      '<label class="ct-row"><span>拆解</span><input type="range" min="0" max="100" value="0" id="gl-exp"><i id="gl-exp-val">0%</i></label>' +
      '</div>';
    treeEl.innerHTML = html;

    treeEl.addEventListener('click', function (e) {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      const id = row.dataset.id;
      treeEl.querySelectorAll('.tree-row').forEach(function (r) { r.classList.toggle('on', r === row); });
      if (window.__GL3D__ && window.__GL3D__.select) window.__GL3D__.select(id);
      showDossier(id, parts);
    });

    treeEl.addEventListener('mouseover', function (e) {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      if (window.__GL3D__ && window.__GL3D__.hover) window.__GL3D__.hover(row.dataset.id);
    });
    treeEl.addEventListener('mouseleave', function () {
      if (window.__GL3D__ && window.__GL3D__.hover) window.__GL3D__.hover(null);
    });

    let secOn = false;
    const sec = treeEl.querySelector('#gl-sec');
    const secVal = treeEl.querySelector('#gl-sec-val');
    sec.addEventListener('input', function () {
      const v = +sec.value / 100;
      if (v > .02 && !secOn) { secOn = true; if (window.__GL3D__.setMode) window.__GL3D__.setMode('cut'); }
      if (v <= .02 && secOn) { secOn = false; if (window.__GL3D__.setMode) window.__GL3D__.setMode('shell'); }
      if (window.__GL3D__.section) window.__GL3D__.section(v);
      secVal.textContent = Math.round(v * 100) + '%';
    });

    const exp = treeEl.querySelector('#gl-exp');
    const expVal = treeEl.querySelector('#gl-exp-val');
    exp.addEventListener('input', function () {
      const v = +exp.value / 100;
      if (window.__GL3D__.explode) window.__GL3D__.explode(v);
      expVal.textContent = Math.round(v * 100) + '%';
    });

    built = true;

    // URL 预置：?exp=60&sec=70
    try {
      const q = new URLSearchParams(location.search);
      const ex = q.get('exp'), se = q.get('sec');
      if (ex) { exp.value = ex; exp.dispatchEvent(new Event('input')); }
      const sel = q.get('sel');
      if (sel && window.__GL3D__.select) {
        const row = treeEl.querySelector('.tree-row[data-id="' + sel + '"]');
        if (row) { row.classList.add('on'); window.__GL3D__.select(sel); showDossier(sel, parts); }
      }
      if (se) { sec.value = se; sec.dispatchEvent(new Event('input')); }
    } catch (e) {}
  }

  function showDossier(id, parts) {
    const p = parts.filter(function (x) { return x.id === id; })[0];
    if (!p || !dossierEl) return;
    dossierEl.innerHTML = '<i>SELECTED / ' + p.level + '</i><b>' + p.name + '</b><span>' + (p.sub || '') + '</span>';
    dossierEl.classList.add('on');
  }

  function sync() {
    const S = window.__SIM__;
    if (!S || !window.__GL3D__ || !window.__GL3D__.available) return;
    host = document.getElementById('gl3d');
    if (!host) return;
    const show = S.STATE.page === 'rack' && S.STATE.hwView === 'threeD';
    if (!show) {
      if (treeEl) treeEl.style.display = 'none';
      if (dossierEl) dossierEl.style.display = 'none';
      return;
    }
    if (treeEl) treeEl.style.display = '';
    if (dossierEl) dossierEl.style.display = '';
    if (!built) build();
  }

  window.__GLA__ = { sync: sync };
  window.addEventListener('resize', function () {});
})();
