/* ============================================================
 * webgl-ui.js — 把 Three.js 机架场景挂进页面，并做一套极简控制条
 * 仅在「机架解剖 / 三维」视图生效；WebGL 不可用时自动回落 SVG 版
 * ============================================================ */
(function () {
  'use strict';

  let glEl = null, barEl = null, mounted = false;
  let mode = 'shell', stepN = 1;
  try {
    const q = new URLSearchParams(location.search).get('step');
    if (q && +q >= 1 && +q <= 4) stepN = +q;
  } catch (e) {}

  const MODES = [['shell', '透明壳'], ['solid', '整机'], ['cut', '剖切'], ['explode', '拆解'], ['cxl', '仅 CXL']];
  const PRESETS = [['iso', '等轴'], ['front', '正视'], ['side', '侧视'], ['top', '顶视'], ['gpu', 'GPU'], ['switch', '交换'], ['mhd', 'MHD']];

  function build() {
    const stage = document.querySelector('.stage');
    if (!stage || glEl) return;
    glEl = document.createElement('div');
    glEl.id = 'gl3d';
    stage.appendChild(glEl);

    barEl = document.createElement('div');
    barEl.className = 'gl3d-bar';
    barEl.innerHTML =
      '<div class="gl3d-grp"><span class="gl3d-lbl">显示</span>' +
      MODES.map(m => '<button type="button" class="gl3d-btn' + (m[0] === mode ? ' on' : '') + '" data-mode="' + m[0] + '">' + m[1] + '</button>').join('') +
      '</div><div class="gl3d-grp"><span class="gl3d-lbl">镜头</span>' +
      PRESETS.map(p => '<button type="button" class="gl3d-btn" data-preset="' + p[0] + '">' + p[1] + '</button>').join('') +
      '</div><div class="gl3d-grp"><span class="gl3d-lbl">步骤</span>' +
      [1, 2, 3, 4].map(n => '<button type="button" class="gl3d-btn' + (n === stepN ? ' on' : '') + '" data-step="' + n + '">0' + n + '</button>').join('') +
      '</div>';
    stage.appendChild(barEl);

    barEl.addEventListener('click', function (e) {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) {
        mode = b.dataset.mode;
        barEl.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
        if (window.__GL3D__) window.__GL3D__.setMode(mode);
        // 拆解模式自带镜头拉远
        if (mode === 'explode' && window.__GL3D__) window.__GL3D__.setPreset('iso');
      }
      if (b.dataset.preset) {
        if (window.__GL3D__) window.__GL3D__.setPreset(b.dataset.preset);
      }
      if (b.dataset.step) {
        stepN = +b.dataset.step;
        barEl.querySelectorAll('[data-step]').forEach(x => x.classList.toggle('on', x === b));
        if (window.__GL3D__) window.__GL3D__.setStep(stepN);
      }
    });
  }

  function sync() {
    const S = window.__SIM__;
    if (!S || !window.__GL3D__ || !window.__GL3D__.available) return;
    if (!glEl) build();
    if (!glEl) return;
    const stage = document.getElementById('stage') || document.querySelector('.stage');

    const show = S.STATE.page === 'rack' && S.STATE.hwView === 'threeD';
    const canvas = document.getElementById('canvas');
    if (!show) {
      glEl.style.display = 'none';
      barEl.style.display = 'none';
      if (canvas) canvas.style.visibility = '';
      const hint2 = stage && stage.querySelector('#stage-hint');
      if (hint2) hint2.style.opacity = '';
      return;
    }

    glEl.style.display = 'block';
    barEl.style.display = 'flex';
    if (canvas) canvas.style.visibility = 'hidden';
    const hint = stage && stage.querySelector('#stage-hint');
    if (hint) hint.style.opacity = '0';

    if (!mounted) {
      mounted = true;
      window.__GL3D__.mount(glEl);
      if (window.__GL3D__.setMode) window.__GL3D__.setMode(mode);
      if (window.__GL3D__.setStep) window.__GL3D__.setStep(stepN);
    } else {
      window.__GL3D__.sync();
    }
    window.__GL3D__.resize();
  }

  /* 顶部工具栏在三维视图下改控 WebGL 镜头 */
  function wireTopTools() {
    const zIn = document.getElementById('zoom-in'), zOut = document.getElementById('zoom-out');
    const fitB = document.getElementById('fit-btn');
    const rl = document.getElementById('rot-left'), rr = document.getElementById('rot-right');
    const lb = document.getElementById('labels-btn');
    if (zIn) zIn.addEventListener('click', function () { if (isGL()) window.__GL3D__.dolly(.82); }, true);
    if (zOut) zOut.addEventListener('click', function () { if (isGL()) window.__GL3D__.dolly(1.22); }, true);
    if (fitB) fitB.addEventListener('click', function () { if (isGL()) window.__GL3D__.setPreset('iso'); }, true);
    if (rl) rl.addEventListener('click', function () { if (isGL()) window.__GL3D__.orbit(.22); }, true);
    if (rr) rr.addEventListener('click', function () { if (isGL()) window.__GL3D__.orbit(-.22); }, true);
    if (lb) lb.addEventListener('click', function () {
      if (!isGL()) return;
      labelOn = !labelOn;
      window.__GL3D__.toggleLabels(labelOn);
    }, true);
  }
  let labelOn = true;
  function isGL() {
    const S = window.__SIM__;
    return !!(S && S.STATE.page === 'rack' && S.STATE.hwView === 'threeD' && window.__GL3D__ && window.__GL3D__.available);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireTopTools);
  else wireTopTools();

  window.__GLUI__ = { sync: sync };
  window.addEventListener('resize', function () {
    if (glEl && glEl.style.display !== 'none' && window.__GL3D__) window.__GL3D__.resize();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else sync();
})();
