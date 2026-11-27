/* ============================================================
 * webgl-post.js — 轻量泛光（Bloom）后处理（three r128 core，零依赖）
 *
 * 管线：scene → HalfFloat 场景 RT（线性 HDR）
 *       → 亮度阈值（提取高亮）→ 半分辨率高斯模糊 H/V ×2 → 合成
 *       → 手动 ACES tonemap + gamma → 屏幕
 *
 * 用法：
 *   var post = window.__GLPOST__(renderer, scene, camera);
 *   animate 内用 post.render() 替代 renderer.render(scene, camera);
 *   resize 时 post.setSize(w, h);
 *   post.strength / radius / threshold 可调；post.enabled=false 直通渲染。
 * ============================================================ */
(function () {
  'use strict';
  if (!window.THREE) return;

  var THREE = window.THREE;

  var VSH = [
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = uv;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FSH_THRESHOLD = [
    'uniform sampler2D tex;',
    'uniform float threshold;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec4 c = texture2D(tex, vUv);',
    '  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));',
    '  float f = smoothstep(threshold, threshold + 0.5, l);',
    '  gl_FragColor = vec4(c.rgb * f * f, 1.0);',
    '}'
  ].join('\n');

  /* 9-tap 高斯，线性采样（5 次采样覆盖 9 texel） */
  var FSH_BLUR = [
    'uniform sampler2D tex;',
    'uniform vec2 dir;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec2 o = dir * 1.3333333;',
    '  vec4 s = texture2D(tex, vUv) * 0.29411764;',
    '  s += (texture2D(tex, vUv + o) + texture2D(tex, vUv - o)) * 0.35294117;',
    '  s += (texture2D(tex, vUv + o * 2.0) + texture2D(tex, vUv - o * 2.0)) * 0.11764705;',
    '  gl_FragColor = s;',
    '}'
  ].join('\n');

  var FSH_COMPOSITE = [
    'uniform sampler2D tex;',
    'uniform sampler2D bloom;',
    'uniform float strength;',
    'uniform float exposure;',
    'varying vec2 vUv;',
    'vec3 aces(vec3 x){',
    '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);',
    '}',
    'void main(){',
    '  vec3 c = texture2D(tex, vUv).rgb + texture2D(bloom, vUv).rgb * strength;',
    '  c = aces(c * exposure);',
    '  c = pow(c, vec3(0.45454545));',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  window.__GLPOST__ = function (renderer, scene, camera) {
    var self = this;
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quadGeo = new THREE.PlaneGeometry(2, 2);

    function makePass(frag, uniforms) {
      var s = new THREE.Scene();
      var m = new THREE.Mesh(quadGeo, new THREE.ShaderMaterial({
        vertexShader: VSH, fragmentShader: frag,
        uniforms: uniforms, depthTest: false, depthWrite: false
      }));
      m.frustumCulled = false;
      s.add(m);
      return { scene: s, mat: m.material };
    }

    function makeRT(w, h, type) {
      return new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
        type: type || THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: true,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter
      });
    }

    var pThreshold = makePass(FSH_THRESHOLD, { tex: { value: null }, threshold: { value: .62 } });
    var pBlur = makePass(FSH_BLUR, { tex: { value: null }, dir: { value: new THREE.Vector2(1, 0) } });
    var pComposite = makePass(FSH_COMPOSITE, {
      tex: { value: null }, bloom: { value: null },
      strength: { value: .85 }, exposure: { value: 1.15 }
    });

    var rtScene = null, rtA = null, rtB = null;
    var w = 2, h = 2, dpr = 1;

    this.enabled = true;
    this.strength = .9;
    this.radius = 1.0;        /* 保留字段：模糊半径由两次迭代近似 */
    this.threshold = .62;
    this.exposure = 1.12;

    function buildTargets() {
      if (rtScene) rtScene.dispose();
      if (rtA) rtA.dispose();
      if (rtB) rtB.dispose();
      rtScene = makeRT(w * dpr, h * dpr);
      rtA = makeRT(w * dpr / 2, h * dpr / 2);
      rtB = makeRT(w * dpr / 2, h * dpr / 2);
    }

    this.setSize = function (nw, nh, ndpr) {
      w = Math.max(2, nw); h = Math.max(2, nh);
      if (ndpr) dpr = ndpr;
      buildTargets();
    };

    this.setThreshold = function (v) { pThreshold.mat.uniforms.threshold.value = v; };
    this.setStrength = function (v) { pComposite.mat.uniforms.strength.value = v; };
    this.setExposure = function (v) { pComposite.mat.uniforms.exposure.value = v; };

    /* 调试：直接把某个中间缓冲画到屏幕（'scene' | 'bloom'），绕过合成 */
    var pCopy = makePass(
      'uniform sampler2D tex;varying vec2 vUv;void main(){gl_FragColor=texture2D(tex,vUv);}',
      { tex: { value: null } });
    this.debugStage = function (name) {
      if (!this.enabled) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      pCopy.mat.uniforms.tex.value = name === 'bloom' ? rtA.texture : rtScene.texture;
      pass(pCopy, null);
    };

    function pass(p, target) {
      renderer.setRenderTarget(target || null);
      renderer.render(p.scene, quadCam);
    }

    /* 注意：场景材质须在线性空间输出（renderer.outputEncoding 保持默认 Linear，
       toneMapping = NoToneMapping —— tonemap/gamma 由合成 pass 统一处理） */
    this.render = function () {
      if (!this.enabled) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      pThreshold.mat.uniforms.threshold.value = this.threshold;
      pComposite.mat.uniforms.strength.value = this.strength;
      pComposite.mat.uniforms.exposure.value = this.exposure;

      /* 1. 场景 → HDR RT */
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);

      /* 2. 阈值 → 半分辨率 A */
      pThreshold.mat.uniforms.tex.value = rtScene.texture;
      pass(pThreshold, rtA);

      /* 3. 高斯模糊 ×2（A→B 横向，B→A 纵向，再一轮增强泛光半径） */
      var dx = 1 / rtA.width, dy = 1 / rtA.height;
      for (var i = 0; i < 2; i++) {
        pBlur.mat.uniforms.tex.value = rtA.texture;
        pBlur.mat.uniforms.dir.value.set(1.5 * dx, 0);
        pass(pBlur, rtB);
        pBlur.mat.uniforms.tex.value = rtB.texture;
        pBlur.mat.uniforms.dir.value.set(0, 1.5 * dy);
        pass(pBlur, rtA);
      }

      /* 4. 合成 → 屏幕（ACES + gamma 在 shader 内完成） */
      pComposite.mat.uniforms.tex.value = rtScene.texture;
      pComposite.mat.uniforms.bloom.value = rtA.texture;
      pass(pComposite, null);
    };

    this.dispose = function () {
      if (rtScene) rtScene.dispose();
      if (rtA) rtA.dispose();
      if (rtB) rtB.dispose();
      quadGeo.dispose();
    };

    this.setSize(2, 2);   /* 首帧占位，真实尺寸由 setSize 建立 */
  };
})();
