// =====================================================================================
// 剪輯：WebGL 轉場（3.20）
//
// 載入順序在 edit-fx.js 之後：載入時把下面 11 種轉場加進 QPTEdit.fx.TRANSITIONS，介面與 render 不用分辨哪些是 WebGL。
// 介面和 fx 的其他轉場一樣：draw(ctx, drawA, drawB, t, opts, outW, outH)。
//   t<=0 只畫 A、t>=1 只畫 B（直接呼叫 drawA／drawB，和其他轉場一樣逐像素相同）。
//   中段：drawA／drawB 各畫到一張離屏 2D 畫布 → 上傳成貼圖 → 共用的 WebGL 畫布跑著色器 → drawImage 貼回 ctx。
//   所以預覽與匯出仍走同一個 render.compose，看到的就是匯出的。
// 沒有 WebGL（node 測試、瀏覽器關掉硬體加速、WebGL 環境遺失）時退回交叉疊化，剪輯照常可用。
// 貼圖用「預乘 alpha」：單邊轉場沒有的那一側是透明，結果一樣能露出下層軌道或背景色。
// 方向（opts.direction）與 fx 相同：'left' 表示畫面往左動、B 從右邊進來；這裡換成 GL 座標（Y 向上）後交給著色器。
// =====================================================================================
(function (root) {
  const Q = root.QPTEdit = root.QPTEdit || {};

  // ---------------------------------------------------------------------------------
  // 著色器共用的函式
  //   uA／uB：A、B 兩段畫面；uP：進度 0~1（已套用 opts.ease）；uRatio：寬／高；uRes：輸出像素；
  //   uDir：運動方向（GL 座標，Y 向上）；uColor：轉場顏色。
  //   toF／fromF：把畫面換到「運動方向朝左」的座標系，方向性的轉場只要寫「往左」一種，其他三個方向共用。
  // ---------------------------------------------------------------------------------
  const PRELUDE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uA, uB;
uniform float uP, uRatio;
uniform vec2 uRes, uDir;
uniform vec3 uColor;
const float PI = 3.14159265;
vec4 A(vec2 p){ return texture2D(uA, p); }
vec4 B(vec2 p){ return texture2D(uB, p); }
float inb(vec2 p){ return step(0., p.x) * step(p.x, 1.) * step(0., p.y) * step(p.y, 1.); }
vec2 mirror(vec2 p){ vec2 m = mod(p, 2.); return mix(m, 2. - m, step(1., m)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float eio(float x){ return x < .5 ? 4.*x*x*x : 1. - pow(-2.*x + 2., 3.) / 2.; }
vec3 rotY(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(v.x*c + v.z*s, v.y, -v.x*s + v.z*c); }
vec2 toF(vec2 uv){
  if (uDir.x < -.5) return uv;
  if (uDir.x > .5) return vec2(1. - uv.x, uv.y);
  if (uDir.y > .5) return vec2(1. - uv.y, uv.x);
  return vec2(uv.y, uv.x);
}
vec2 fromF(vec2 f){
  if (uDir.x < -.5) return f;
  if (uDir.x > .5) return vec2(1. - f.x, f.y);
  if (uDir.y > .5) return vec2(f.y, 1. - f.x);
  return vec2(f.y, f.x);
}
float frameR(){ return abs(uDir.x) > .5 ? uRatio : 1. / uRatio; }
vec4 tr();
void main(){
  vec4 c = clamp(tr(), 0., 1.);
  c.rgb = min(c.rgb, vec3(c.a));      // 預乘 alpha：顏色不能超過 alpha
  gl_FragColor = c;
}
`;
  const VERT = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }';

  // dirs：'four'＝上下左右；'spin'＝逆時針／順時針（left／right）；'doors'＝左右打開／上下打開（left／up）；沒有＝不分方向。
  // color：詳細內容要不要顯示「顏色」。thumbT：素材庫縮圖停在哪個進度（預設 0.5）。
  const DEFS = {
    whip: { name: '甩鏡', dirs: 'four', thumbT: 0.42, frag: `
vec4 tr(){
  float e = uP < .5 ? 16.*pow(uP, 5.) : 1. - pow(-2.*uP + 2., 5.) / 2.;
  float bl = .5 * pow(sin(PI*uP), 2.);
  vec4 c = vec4(0.);
  for (int i = 0; i < 24; i++){
    float t = (float(i) / 23. - .5) * bl;
    vec2 s = vUv - uDir * (e + t);
    c += inb(s) > .5 ? A(s) : B(s + uDir);
  }
  return c / 24.;
}` },
    flash: { name: '閃光', color: true, thumbT: 0.4, frag: `
vec4 tr(){
  float w = exp(-pow((uP - .5) * 6.5, 2.));
  vec4 base = uP < .5 ? A(vUv) : B(vUv);
  float lum = dot(uColor, vec3(.299, .587, .114));
  vec4 lit = vec4(base.rgb * (1. + 2.2 * w * lum), base.a);
  return mix(lit, vec4(uColor, 1.), w*w*.95 + w*.05);
}` },
    glitch: { name: '故障', thumbT: 0.45, frag: `
vec4 tr(){
  float g = pow(sin(PI*uP), 1.5);
  float t = floor(uP * 30.);
  vec2 uv = vUv;
  float rows = 8. + floor(hash(vec2(t, 1.)) * 24.);
  float r = floor(uv.y * rows);
  if (hash(vec2(r, t)) > .55) uv.x += (hash(vec2(r, t + 7.)) - .5) * .35 * g;
  vec2 blk = floor(uv * vec2(12., 8.));
  if (hash(blk + t*3.) > 1. - .25*g) uv += (vec2(hash(blk + t), hash(blk - t)) - .5) * .12 * g;
  uv.x = fract(uv.x);
  float sw = step(.5, uP + (hash(vec2(t, 3.)) - .5) * .6 * g);
  float sh = .035 * g;
  vec2 ur = uv + vec2(sh, 0.), ub = uv - vec2(sh, 0.);
  vec4 ca = vec4(A(ur).r, A(uv).g, A(ub).b, A(uv).a);
  vec4 cb = vec4(B(ur).r, B(uv).g, B(ub).b, B(uv).a);
  vec4 c = mix(ca, cb, sw);
  c.rgb += (hash(floor(vUv * uRes * .5) + t) - .5) * .28 * g * c.a;
  c.rgb *= 1. - .18 * g * step(.5, fract(vUv.y * uRes.y * .25));
  return c;
}` },
    zoomPunch: { name: '縮放衝刺', thumbT: 0.4, frag: `
vec4 tr(){
  vec2 c0 = vec2(.5);
  float strength = .3 * sin(PI*uP);
  bool useB = uP >= .5;
  float zA = 1. + 3. * pow(clamp(uP*2., 0., 1.), 3.);
  float zB = 4. - 3. * (1. - pow(1. - clamp((uP - .5)*2., 0., 1.), 3.));
  float z0 = useB ? zB : zA;
  vec4 col = vec4(0.);
  for (int i = 0; i < 20; i++){
    float z = z0 * (1. + strength * float(i) / 19.);
    vec2 p = c0 + (vUv - c0) / z;
    col += useB ? B(p) : A(p);
  }
  col /= 20.;
  col.rgb += exp(-pow((uP - .5) * 14., 2.)) * .55 * col.a;
  return col;
}` },
    spin: { name: '旋轉', dirs: 'spin', frag: `
vec4 tr(){
  float sg = (uDir.x < -.5 || uDir.y > .5) ? 1. : -1.;   // 向左／向上＝逆時針
  vec2 p = (vUv - .5) * vec2(uRatio, 1.);
  float z = 1. + .8 * sin(PI*uP);
  float bl = .7 * sin(PI*uP);
  float base = eio(uP) * 2. * PI;
  float m = smoothstep(.46, .54, uP);
  vec4 col = vec4(0.);
  for (int i = 0; i < 20; i++){
    float a = -sg * (base + (float(i)/19. - .5) * bl);
    float ca = cos(a), sa = sin(a);
    vec2 q = vec2(ca*p.x - sa*p.y, sa*p.x + ca*p.y) / z;
    q = mirror(q / vec2(uRatio, 1.) + .5);
    col += mix(A(q), B(q), m);
  }
  return col / 20.;
}` },
    lightLeak: { name: '光漏', color: true, thumbT: 0.45, frag: `
vec4 tr(){
  float i = sin(PI*uP);
  vec4 base = mix(A(vUv), B(vUv), smoothstep(.25, .75, uP));
  vec2 p = vUv * vec2(uRatio, 1.);
  vec2 c1 = vec2(mix(-.4, uRatio + .4, uP), .78);
  vec2 c2 = vec2(mix(uRatio * .95, .05, uP), .18);
  float l1 = exp(-dot(p - c1, p - c1) * 2.6);
  float l2 = exp(-dot(p - c2, p - c2) * 4.5);
  vec3 col2 = mix(uColor, vec3(1., .22, .42), .55);
  vec3 leak = uColor * l1 + col2 * l2 * .9 + mix(uColor, vec3(1.), .55) * .22;
  vec3 c = base.a - (base.a - base.rgb) * (1. - clamp(leak * i * 1.25, 0., 1.));
  return vec4(c, base.a);
}` },
    blinds: { name: '百葉窗', dirs: 'four', frag: `
vec4 tr(){
  float n = 10.;
  vec2 f = toF(vUv);
  float x = f.x * n, i = floor(x), fr = fract(x);
  float k = n - 1. - i;                                   // 往左動：從右邊那一片先翻
  float lp = eio(clamp(uP * 1.6 - k / (n - 1.) * .6, 0., 1.));
  float w = lp < .5 ? 1. - lp * 2. : lp * 2. - 1.;
  if (abs(fr - .5) >= w * .5) return vec4(0.);
  vec2 q = fromF(vec2((i + (fr - .5) / max(w, 1e-3) + .5) / n, f.y));
  vec4 c = lp < .5 ? A(q) : B(q);
  return vec4(c.rgb * (.55 + .45 * w), c.a);
}` },
    pixelate: { name: '馬賽克', frag: `
vec4 tr(){
  float s = sin(PI*uP);
  float cnt = mix(min(uRes.x, 480.), 12., pow(s, .7));
  vec2 cell = vec2(1. / cnt, uRatio / cnt);
  vec2 uv = cnt < uRes.x * .7 ? (floor(vUv / cell) + .5) * cell : vUv;
  return mix(A(uv), B(uv), smoothstep(.42, .58, uP));
}` },
    flip: { name: '卡片翻轉', dirs: 'four', thumbT: 0.35, frag: `
vec4 tr(){
  float th = eio(uP) * PI;
  bool back = th > PI * .5;
  float ph = back ? th - PI : th;
  float sc = 1. - .22 * sin(PI*uP);
  vec2 p = (toF(vUv) - .5) * 2. / sc;
  float k = .55, c = cos(ph), s = sin(ph);
  float den = c + k * p.x * s;
  if (den <= 0.) return vec4(0.);
  float x = p.x / den;
  float y = p.y * (1. - k * x * s);
  vec2 q = vec2(x, y) * .5 + .5;
  if (inb(q) < .5) return vec4(0.);
  vec4 col = back ? B(fromF(q)) : A(fromF(q));
  return vec4(col.rgb * (.7 + .3 * abs(c)), col.a);
}` },
    cube: { name: '立方體', dirs: 'four', frag: `
vec4 tr(){
  float a = eio(uP) * PI * .5;
  float R = frameR();
  float zoom = 1. + .45 * sin(PI*uP);
  vec2 s = (toF(vUv) - .5) * vec2(R, 1.) * zoom;
  vec3 ro = vec3(0., 0., 2.4);
  vec3 rd = normalize(vec3(s, 0.) - ro);
  vec3 c = vec3(0., 0., -R * .5);
  vec3 o = rotY(ro - c, a), d = rotY(rd, a);
  float h = R * .5;
  float best = 1e9; vec4 col = vec4(0.);
  float t1 = (h - o.z) / d.z; vec3 p1 = o + d * t1;
  if (t1 > 0. && abs(p1.x) <= h && abs(p1.y) <= .5) {
    best = t1; vec4 k = A(fromF(vec2(p1.x / R + .5, p1.y + .5))); col = vec4(k.rgb * (1. - .45 * sin(a)), k.a);
  }
  float t2 = (h - o.x) / d.x; vec3 p2 = o + d * t2;
  if (t2 > 0. && t2 < best && abs(p2.z) <= h && abs(p2.y) <= .5) {
    vec4 k = B(fromF(vec2((h - p2.z) / R, p2.y + .5))); col = vec4(k.rgb * (1. - .45 * cos(a)), k.a);
  }
  return col;
}` },
    doors: { name: '對開門', dirs: 'doors', frag: `
vec4 tr(){
  float e = eio(uP);
  float sh = e * .5;
  vec2 f = toF(vUv);
  if (f.x < .5 - sh) { vec4 k = A(fromF(f + vec2(sh, 0.))); return vec4(k.rgb * (1. - .5 * smoothstep(.04, 0., .5 - sh - f.x)), k.a); }
  if (f.x > .5 + sh) { vec4 k = A(fromF(f - vec2(sh, 0.))); return vec4(k.rgb * (1. - .5 * smoothstep(.04, 0., f.x - .5 - sh)), k.a); }
  float z = 1.18 - .18 * e;
  vec4 k = B(.5 + (vUv - .5) / z);
  return vec4(k.rgb * (.55 + .45 * e), k.a);
}` },
  };

  // fx 的方向（Y 向下）→ GL（Y 向上）
  const GL_DIRS = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] };
  function hexRgb(c) {
    const m = /^#?([0-9a-f]{6})/i.exec(String(c || ''));
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  // ---------------------------------------------------------------------------------
  // WebGL 狀態（第一次用到才建立；共用一個畫布，每種轉場的程式第一次用到才編譯）
  // ---------------------------------------------------------------------------------
  let canvasFactory = (w, h) => {
    if (typeof root.OffscreenCanvas !== 'undefined') return new root.OffscreenCanvas(w, h);
    if (!root.document) return null;
    const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c;
  };
  let G = null, disabled = false;
  function init() {
    if (G) return G.gl.isContextLost() ? (G = null) : G;
    if (disabled) return null;
    try {
      const canvas = canvasFactory(2, 2);
      const gl = canvas && canvas.getContext && canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false });
      if (!gl) { disabled = true; return null; }
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const tex = () => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      G = { canvas, gl, texA: tex(), texB: tex(), progs: {}, layers: {}, maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096 };
      return G;
    } catch (_) { disabled = true; return null; }
  }
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const m = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(m); }
    return s;
  }
  function program(g, id) {
    if (g.progs[id] !== undefined) return g.progs[id];
    const gl = g.gl;
    try {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, PRELUDE + DEFS[id].frag));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = n => gl.getUniformLocation(p, n);
      g.progs[id] = { p, uA: u('uA'), uB: u('uB'), uP: u('uP'), uRatio: u('uRatio'), uRes: u('uRes'), uDir: u('uDir'), uColor: u('uColor') };
    } catch (e) {
      if (root.console) root.console.warn(`轉場「${DEFS[id].name}」的著色器無法編譯，改用交叉疊化：`, e && e.message);
      g.progs[id] = null;
    }
    return g.progs[id];
  }
  // 把 drawX 畫到離屏 2D 畫布（和 fx 的 layer 一樣：專案座標、單位矩陣）
  function layer(g, key, w, h, draw) {
    let s = g.layers[key];
    if (!s || s.canvas.width !== w || s.canvas.height !== h) {
      const canvas = canvasFactory(w, h);
      s = g.layers[key] = { canvas, ctx: canvas.getContext('2d') };
    }
    const c = s.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
    c.clearRect(0, 0, w, h);
    draw(c);
    return s.canvas;
  }

  function fallback(ctx, dA, dB, t, o, W, H) {
    const fx = Q.fx;
    if (fx && fx.TRANSITIONS && fx.TRANSITIONS.crossDissolve) { fx.TRANSITIONS.crossDissolve.draw(ctx, dA, dB, t, o, W, H); return; }
    dA(ctx); ctx.save(); ctx.globalAlpha *= t; dB(ctx); ctx.restore();
  }

  function makeDraw(id) {
    return function draw(ctx, drawA, drawB, t, opts, outW, outH) {
      if (!(t > 0)) { drawA(ctx); return; }
      if (!(t < 1)) { drawB(ctx); return; }
      const o = opts || {};
      const g = init(), pr = g && program(g, id);
      if (!pr) { fallback(ctx, drawA, drawB, t, o, outW, outH); return; }
      const fx = Q.fx;
      const u = fx && fx.ease ? fx.ease(t, o.ease) : t;
      // 太大的輸出（超過顯示卡貼圖上限）等比縮小算，再放大貼回去
      const k = Math.min(1, g.maxSize / Math.max(outW, outH));
      const W = Math.max(1, Math.round(outW * k)), H = Math.max(1, Math.round(outH * k));
      const draw2 = d => c => { if (k !== 1) c.scale(k, k); d(c); };
      const la = layer(g, 'a', W, H, draw2(drawA)), lb = layer(g, 'b', W, H, draw2(drawB));
      const gl = g.gl;
      if (g.canvas.width !== W || g.canvas.height !== H) { g.canvas.width = W; g.canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.texA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, la);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g.texB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lb);
      gl.useProgram(pr.p);
      gl.uniform1i(pr.uA, 0); gl.uniform1i(pr.uB, 1);
      gl.uniform1f(pr.uP, u);
      gl.uniform1f(pr.uRatio, W / H);
      gl.uniform2f(pr.uRes, W, H);
      const d = GL_DIRS[o.direction] || GL_DIRS.left;
      gl.uniform2f(pr.uDir, d[0], d[1]);
      const col = hexRgb(o.color || (Q.core && Q.core.transitionColor ? Q.core.transitionColor(id) : '#000000'));
      gl.uniform3f(pr.uColor, col[0], col[1], col[2]);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.drawImage(g.canvas, 0, 0, outW, outH);
    };
  }

  function install(fx) {
    if (!fx || !fx.TRANSITIONS) return;
    for (const [id, d] of Object.entries(DEFS)) {
      fx.TRANSITIONS[id] = { name: d.name, dirs: d.dirs || null, color: !!d.color, thumbT: d.thumbT || 0.5, gl: true, draw: makeDraw(id) };
    }
  }
  install(Q.fx);

  const api = {
    DEFS, install,
    available() { return !!init(); },
    _setCanvasFactory(fn) { canvasFactory = fn; G = null; disabled = false; },
    _disable(on) { disabled = !!on; if (on) G = null; },
  };
  Q.fxgl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
