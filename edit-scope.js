// =====================================================================================
// 剪輯：示波器（4.70）
//
// 直方圖／波形／向量三種，讀預覽畫布 #edCanvas 縮小後的像素來統計。
// 統計（scopeHistogram／scopeWaveform／scopeVector）是純函式，吃 RGBA 資料、回傳 typed array，可在 Node 單元測試；
// 畫圖（drawScope）和讀畫布（createScope）另外放。示波器關閉時完全不讀像素（由 edit-ui-viewer.js 控制）。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit = root.QPTEdit || {};
  const SCOPE_W = 256, SCOPE_H = 150;        // 面板的 CSS 大小
  const SAMPLE_W = 256, SAMPLE_H = 144;      // 取樣用的小畫布
  const MODES = ['off', 'hist', 'wave', 'vector'];

  // 直方圖：回傳 Uint32Array(1024)，依序 R(0..255)、G、B、亮度（Rec.709）
  function scopeHistogram(d) {
    const h = new Uint32Array(1024);
    for (let i = 0; i + 3 < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      h[r]++; h[256 + g]++; h[512 + b]++;
      h[768 + Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b))]++;
    }
    return h;
  }

  // 波形：回傳 Uint32Array(cols*rows)，索引 row*cols+col；row 0 在最上面（亮度 100%）
  function scopeWaveform(d, w, h, cols, rows) {
    const out = new Uint32Array(cols * rows);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const Y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        const row = rows - 1 - Math.round(Y / 255 * (rows - 1));
        const col = Math.min(cols - 1, Math.floor(x * cols / w));
        out[row * cols + col]++;
      }
    }
    return out;
  }

  // 向量：回傳 Uint32Array(size*size)，索引 y*size+x；x＝Cb（左藍右黃），y＝Cr（上紅下青）；中心是無彩色
  function scopeVector(d, size) {
    const out = new Uint32Array(size * size), m = size - 1;
    for (let i = 0; i + 3 < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cb = (b - y) / 1.8556, cr = (r - y) / 1.5748;      // 各約 -0.5～0.5
      const x = Math.max(0, Math.min(m, Math.round((cb + 0.5) * m)));
      const yy = Math.max(0, Math.min(m, Math.round((0.5 - cr) * m)));
      out[yy * size + x]++;
    }
    return out;
  }

  // 向量圖上六個目標點（R Y G C B M）的位置，座標同 scopeVector
  function vectorTargets(size) {
    const m = size - 1, list = [['R', 1, 0, 0], ['Y', 1, 1, 0], ['G', 0, 1, 0], ['C', 0, 1, 1], ['B', 0, 0, 1], ['M', 1, 0, 1]];
    return list.map(([n, r, g, b]) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return { name: n, x: ((b - y) / 1.8556 + 0.5) * m, y: (0.5 - (r - y) / 1.5748) * m };
    });
  }

  function maxOf(a, from, to) { let m = 1; for (let i = from; i < to; i++) if (a[i] > m) m = a[i]; return m; }

  // ---- 畫圖（密度一律用平方根縮放，讓稀疏的點、暗部也看得到）-------------------------
  function drawScope(ctx, mode, data, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,10,16,.72)'; ctx.fillRect(0, 0, w, h);
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    if (mode === 'hist') {
      const hist = scopeHistogram(data), top = 6, bh = h - top - 4;
      const cols = [['rgba(255,70,70,.55)', 0], ['rgba(70,230,90,.55)', 256], ['rgba(80,130,255,.55)', 512]];
      ctx.globalCompositeOperation = 'lighter';
      for (const [c, o] of cols) {
        const mx = Math.sqrt(maxOf(hist, o, o + 256));
        ctx.fillStyle = c;
        for (let i = 0; i < 256; i++) { const v = Math.sqrt(hist[o + i]) / mx * bh; ctx.fillRect(i * w / 256, h - 4 - v, Math.ceil(w / 256), v); }
      }
      ctx.globalCompositeOperation = 'source-over';
      const mxL = Math.sqrt(maxOf(hist, 768, 1024));
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i < 256; i++) { const x = (i + .5) * w / 256, y = h - 4 - Math.sqrt(hist[768 + i]) / mxL * bh; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    } else if (mode === 'wave') {
      const cols = w, rows = h - 10, wf = scopeWaveform(data, SAMPLE_W, SAMPLE_H, cols, rows);
      const mx = Math.sqrt(maxOf(wf, 0, wf.length)), img = ctx.createImageData(cols, rows);
      for (let i = 0; i < wf.length; i++) {
        if (!wf[i]) continue;
        img.data[i * 4] = 120; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 150;
        img.data[i * 4 + 3] = Math.min(255, 60 + Math.sqrt(wf[i]) / mx * 195);
      }
      const tmp = root.document.createElement('canvas'); tmp.width = cols; tmp.height = rows; tmp.getContext('2d').putImageData(img, 0, 0);
      ctx.drawImage(tmp, 0, 5);
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
      for (const p of [0, .5, 1]) {
        const y = 5 + (1 - p) * (rows - 1) + .5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillText(Math.round(p * 100) + '%', 3, Math.min(h - 6, Math.max(7, y - 5)));
      }
    } else if (mode === 'vector') {
      const size = h - 6, vc = scopeVector(data, size), ox = Math.round((w - size) / 2), oy = 3;
      const mx = Math.sqrt(maxOf(vc, 0, vc.length)), img = ctx.createImageData(size, size);
      for (let i = 0; i < vc.length; i++) {
        if (!vc[i]) continue;
        img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = Math.min(255, 70 + Math.sqrt(vc[i]) / mx * 185);
      }
      const tmp = root.document.createElement('canvas'); tmp.width = size; tmp.height = size; tmp.getContext('2d').putImageData(img, 0, 0);
      const cx = ox + size / 2, cy = oy + size / 2;
      ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, size / 2 - 1, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox, cy); ctx.lineTo(ox + size, cy); ctx.moveTo(cx, oy); ctx.lineTo(cx, oy + size); ctx.stroke();
      const ang = 123 * Math.PI / 180;        // 膚色線
      ctx.strokeStyle = 'rgba(255,200,140,.7)'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang) * size / 2, cy - Math.sin(ang) * size / 2); ctx.stroke();
      ctx.drawImage(tmp, ox, oy);
      const colors = { R: '#ff5a5a', Y: '#ffe14d', G: '#5ae66e', C: '#4de1ff', B: '#6a8dff', M: '#ff6aff' };
      ctx.textAlign = 'center';
      for (const t of vectorTargets(size)) { ctx.fillStyle = colors[t.name]; ctx.fillText(t.name, ox + t.x, oy + t.y); }
      ctx.textAlign = 'start';
    }
  }

  function drawMessage(ctx, w, h, text) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,10,16,.72)'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e6e9ef'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2); ctx.textAlign = 'start';
  }

  // 建立示波器：source＝預覽畫布，target＝面板畫布。update(mode) 讀一次像素並畫出來，讀不到就畫提示
  function createScope(source, target) {
    let sample = null, sctx = null;
    const tctx = target.getContext('2d');
    return {
      update(mode) {
        if (!MODES.includes(mode) || mode === 'off') return false;
        try {
          if (!sample) { sample = root.document.createElement('canvas'); sample.width = SAMPLE_W; sample.height = SAMPLE_H; sctx = sample.getContext('2d', { willReadFrequently: true }); }
          sctx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
          const data = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
          drawScope(tctx, mode, data, target.width, target.height);
          return true;
        } catch (_) {
          try { drawMessage(tctx, target.width, target.height, '無法讀取畫面'); } catch (__) { /* 沒辦法就算了 */ }
          return false;
        }
      },
    };
  }

  const api = { MODES, SCOPE_W, SCOPE_H, scopeHistogram, scopeWaveform, scopeVector, vectorTargets, drawScope, createScope };
  Q.scope = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
