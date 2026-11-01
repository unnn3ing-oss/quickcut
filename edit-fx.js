// =====================================================================================
// 剪輯：畫面變形、轉場、字幕
//
// 匯出 QPTEdit.fx（純數學部分也 module.exports，node 可測）：
//   fitRect／clipMatrix／cropRect／getParam      畫面數學（座標單位：輸出像素、原點在畫面中心、Y 向下、旋轉順時針為正）
//   drawClipVisual／drawSolid／drawTitle         把片段畫到 ctx（preview 與 export 共用，ctx 的基底矩陣用「相乘」，不重設）
//   TRANSITIONS                                  轉場：draw(ctx, drawA, drawB, t, opts, outW, outH)
//   TITLE_PRESETS／makeTitle／wrapText           字幕
//   inspector.sections                           詳細內容（變形／裁切／字幕／轉場）
//   ready(project?)                              等字型載入（Canvas 不會等 @font-face，匯出前請先 await；給 project 會等它用到的字型）
//   FONTS／loadFont(id)／onFontLoad(cb)          字幕字型清單；大字型用到時才下載，載入後通知重畫
// 這支檔案不讀其他 QPTEdit 模組，載入時也不碰 DOM；詳細內容樣式在第一次 render 或呼叫 ensureStyle() 時插入。
// =====================================================================================
(function (root) {
  const Q = root.QPTEdit = root.QPTEdit || {};

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const deepClone = o => JSON.parse(JSON.stringify(o));

  // ---------------------------------------------------------------------------------
  // 預設值
  // ---------------------------------------------------------------------------------
  const DEFAULT_TRANSFORM = { zoomX: 1, zoomY: 1, zoomLinked: true, posX: 0, posY: 0, rotation: 0, anchorX: 0, anchorY: 0, opacity: 1, flipH: false, flipV: false };
  const DEFAULT_CROP = { left: 0, right: 0, top: 0, bottom: 0, softness: 0 };
  const DEFAULT_VIDEO = { transform: DEFAULT_TRANSFORM, crop: DEFAULT_CROP, fit: 'fit', composite: 'normal' };
  const defaultTransform = () => ({ ...DEFAULT_TRANSFORM });
  const defaultCrop = () => ({ ...DEFAULT_CROP });
  const defaultVideo = () => deepClone(DEFAULT_VIDEO);

  // ---------------------------------------------------------------------------------
  // 畫面數學
  // ---------------------------------------------------------------------------------

  // 基準縮放：fit＝完整放進輸出（黑邊）、blur＝和 fit 一樣（黑邊改由模糊背景補滿，見 drawClipVisual）、
  //   fill＝蓋滿（裁掉多的）、stretch＝各軸拉到剛好
  // 回傳 { sx, sy, w, h }：sx／sy 是來源像素 → 輸出像素的倍率，w／h 是縮放後的大小
  function fitRect(srcW, srcH, outW, outH, fit) {
    srcW = Math.max(1, srcW); srcH = Math.max(1, srcH);
    let sx, sy;
    if (fit === 'stretch') { sx = outW / srcW; sy = outH / srcH; }
    else if (fit === 'fill') { sx = sy = Math.max(outW / srcW, outH / srcH); }
    else { sx = sy = Math.min(outW / srcW, outH / srcH); }
    return { sx, sy, w: srcW * sx, h: srcH * sy };
  }

  // 讀參數：path 例如 'video.transform.zoomX'。clip.keyframes[path] 有資料就內插，否則讀靜態值。
  // 內插：linear（等速）／ease（緩入緩出）／hold（停格，也套用在非數字，例如翻轉），實作在 core.keyframeValue。
  function getStatic(clip, path) {
    let o = clip;
    for (const k of path.split('.')) {
      if (o == null) return undefined;
      o = o[k];
    }
    return o;
  }
  function defaultFor(path) {
    const m = /^video\.transform\.(\w+)$/.exec(path);
    if (m) return DEFAULT_TRANSFORM[m[1]];
    const c = /^video\.crop\.(\w+)$/.exec(path);
    if (c) return DEFAULT_CROP[c[1]];
    if (path === 'video.fit') return 'fit';
    return undefined;
  }
  function getParam(clip, path, fInClip) {
    const kfs = clip && clip.keyframes && clip.keyframes[path];
    if (Array.isArray(kfs) && kfs.length) {
      const C = root.QPTEdit && root.QPTEdit.core;
      // 內插只寫在 core.keyframeValue 一個地方（linear／ease／hold）；core 沒載入時退回第一個值
      return C && typeof C.keyframeValue === 'function' ? C.keyframeValue(kfs, fInClip || 0) : kfs[0].v;
    }
    const v = clip ? getStatic(clip, path) : undefined;
    return v === undefined ? defaultFor(path) : v;
  }

  // 來源像素 → 輸出像素的仿射矩陣 [a,b,c,d,e,f]（canvas 的 transform 參數順序）
  // 順序：fit（基準縮放，來源中心對齊畫面中心）→ 以錨點為軸心：翻轉 → 縮放 → 旋轉 → 位置位移。
  //   錨點 anchorX/Y：縮放／旋轉的軸心，單位是縮放前（fit 後）的輸出像素、相對影像中心；
  //   縮放、旋轉皆為 0/1 時改錨點不會讓影像移動。
  //   zoomLinked 為真時 Y 軸用 zoomX。旋轉單位度、順時針為正。posX/posY 是輸出像素、畫面中心為原點、Y 向下。
  //   第 7 個參數 fps：有給才疊上「貼圖動態」（video.sticker，見 stickerState）；沒給＝只有基本變形——
  //   預覽上的控制點、點選範圍、拖曳換算都不給，才不會被抖動的畫面帶著跑。center（第 8 個）：貼圖動態的軸心（來源座標），預設來源中心。
  function clipMatrix(clip, srcW, srcH, outW, outH, fInClip, fps, center) {
    const m = baseMatrix(clip, srcW, srcH, outW, outH, fInClip);
    const kind = clip && clip.video && clip.video.sticker;
    if (!(fps > 0) || !kind || kind === 'none' || !STICKER_FX[kind]) return m;
    const amt = clamp(num(clip.video.stickerAmt, 100), 0, 100) / 100;
    if (!(amt > 0)) return m;
    const st = stickerState(kind, (fInClip || 0) / fps, amt);
    if (!st) return m;
    // 以片段畫面中心 C 為軸：先縮放、旋轉，再位移（位移單位依輸出短邊換算，短邊 1080 時為像素）
    const cc = center || contentCenter(clip, srcW, srcH, outW, outH, fInClip);
    const cx0 = cc[0], cy0 = cc[1];
    const Cx = m[0] * cx0 + m[2] * cy0 + m[4], Cy = m[1] * cx0 + m[3] * cy0 + m[5];
    const u = Math.min(outW, outH) / 1080, rad = st.rot * Math.PI / 180;
    const la = Math.cos(rad) * st.s, lb = Math.sin(rad) * st.s, lc = -lb, ld = la;
    const ex = m[4] - Cx, fy = m[5] - Cy;
    return [la * m[0] + lc * m[1], lb * m[0] + ld * m[1], la * m[2] + lc * m[3], lb * m[2] + ld * m[3],
      la * ex + lc * fy + Cx + st.dx * u, lb * ex + ld * fy + Cy + st.dy * u];
  }
  // 貼圖動態：t 秒、amt 0~1 時的 { dx, dy（短邊 1080 時的像素）, rot（度）, s（縮放）}。
  //   全部用 sin 疊出來，不用亂數，同一格永遠畫出一樣的結果（預覽、匯出才會一致）。pop 結束（0.35 秒）後回傳 null＝不動。
  const STICKER_FX = {
    none: { name: '無' },
    shake: { name: '抖動' },
    bounce: { name: '彈跳' },
    pulse: { name: '呼吸' },
    swing: { name: '左右擺' },
    pop: { name: '進場彈出' },
  };
  const STICKER_OPTIONS = Object.keys(STICKER_FX).map(k => [k, STICKER_FX[k].name]);
  function stickerState(kind, t, amt) {
    const T = Math.PI * 2, sin = Math.sin;
    if (kind === 'shake') return {
      dx: amt * (5 * sin(T * 9.1 * t) + 3 * sin(T * 15.7 * t + 1.3)),
      dy: amt * (4 * sin(T * 12.3 * t + 0.7) + 2.5 * sin(T * 19.1 * t)),
      rot: amt * (2.5 * sin(T * 8.3 * t + 2) + 1.5 * sin(T * 14.2 * t)), s: 1 };
    if (kind === 'bounce') { const ph = (t / 0.8) % 1; return { dx: 0, dy: -amt * 70 * 4 * ph * (1 - ph), rot: 0, s: 1 }; }   // 每 0.8 秒一次拋物線，最高 70px
    if (kind === 'pulse') return { dx: 0, dy: 0, rot: 0, s: 1 + amt * 0.1 * sin(T * t / 1.2) };
    if (kind === 'swing') return { dx: 0, dy: 0, rot: amt * 12 * sin(T * t / 1.4), s: 1 };
    if (kind === 'pop') {
      const uu = t / 0.35;
      if (uu >= 1) return null;
      return { dx: 0, dy: 0, rot: 0, s: Math.max(0, 1 + (easeOutBack(uu, 1.70158) - 1) * amt) };
    }
    return null;
  }
  // 物件本身的中心（來源座標）：字幕＝字幕那一塊的中心；影像／色塊＝裁切後範圍的中心。
  //   4.50 起縮放、旋轉、翻轉都以這個中心（再加上錨點）為軸心，字幕不在畫面正中間、或裁掉一邊時也不會繞著畫面中心轉。
  const titleBoxCache = new WeakMap();      // clip.title 物件 → { w, h, box }（core 改字幕時會換新物件，所以用物件當 key 就不會拿到舊值）
  function contentCenter(clip, srcW, srcH, outW, outH, fInClip) {
    if (clip && clip.type === 'title') {
      if (!clip.title) return [srcW / 2, srcH / 2];
      let e = titleBoxCache.get(clip.title);
      if (!e || e.w !== outW || e.h !== outH) { e = { w: outW, h: outH, box: titleLocalBox(clip, outW, outH) }; titleBoxCache.set(clip.title, e); }
      const b = e.box;
      return [b[0] + b[2] / 2, b[1] + b[3] / 2];
    }
    if (!clip || !clip.video || !clip.video.crop && !(clip.keyframes && Object.keys(clip.keyframes).some(k => k.startsWith('video.crop.')))) return [srcW / 2, srcH / 2];
    const r = cropRect(clip, srcW, srcH, fInClip || 0);
    return [r.sx + r.sw / 2, r.sy + r.sh / 2];
  }
  function baseMatrix(clip, srcW, srcH, outW, outH, fInClip) {
    const g = n => getParam(clip, 'video.transform.' + n, fInClip);
    const fit = fitRect(srcW, srcH, outW, outH, getParam(clip, 'video.fit', fInClip));
    const zx = num(g('zoomX'), 1);
    const linked = g('zoomLinked') !== false;
    const zy = linked ? zx : num(g('zoomY'), 1);
    const fh = g('flipH') ? -1 : 1, fv = g('flipV') ? -1 : 1;
    let ax = num(g('anchorX'), 0), ay = num(g('anchorY'), 0);
    const px = num(g('posX'), 0), py = num(g('posY'), 0);
    const rad = num(g('rotation'), 0) * Math.PI / 180;
    // 軸心移到物件中心（沒有縮放／旋轉／翻轉時軸心在哪都一樣，省掉計算）
    if (rad !== 0 || zx !== 1 || zy !== 1 || fh < 0 || fv < 0) {
      const cc = contentCenter(clip, srcW, srcH, outW, outH, fInClip);
      ax += fit.sx * (cc[0] - srcW / 2); ay += fit.sy * (cc[1] - srcH / 2);
    }
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // L = R · S · F
    const l00 = cos * zx * fh, l01 = -sin * zy * fv;
    const l10 = sin * zx * fh, l11 = cos * zy * fv;
    // A = L · Fit
    const a00 = l00 * fit.sx, a01 = l01 * fit.sy;
    const a10 = l10 * fit.sx, a11 = l11 * fit.sy;
    // 平移：L · (−Fit · c_src − anchor) + anchor + c_out + pos
    const tx0 = -fit.sx * srcW / 2 - ax, ty0 = -fit.sy * srcH / 2 - ay;
    const e = l00 * tx0 + l01 * ty0 + ax + outW / 2 + px;
    const f = l10 * tx0 + l11 * ty0 + ay + outH / 2 + py;
    return [a00, a10, a01, a11, e, f];
  }
  function applyMatrix(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // 來源裁切矩形（來源像素）。上下左右是 0~1 的比例；至少留 1 像素，左右（上下）加起來不會吃光
  function cropRect(clip, srcW, srcH, fInClip) {
    const g = n => clamp(num(getParam(clip, 'video.crop.' + n, fInClip), 0), 0, 1);
    let l = g('left'), r = g('right'), t = g('top'), b = g('bottom');
    const lim = (a, c, size) => {
      const maxSum = Math.max(0, 1 - 1 / Math.max(1, size));
      if (a + c > maxSum) { const k = maxSum / (a + c); a *= k; c *= k; }
      return [a, c];
    };
    [l, r] = lim(l, r, srcW);
    [t, b] = lim(t, b, srcH);
    return { sx: l * srcW, sy: t * srcH, sw: (1 - l - r) * srcW, sh: (1 - t - b) * srcH };
  }

  // ---------------------------------------------------------------------------------
  // 離屏畫布（共享，不要每格新建）
  // ---------------------------------------------------------------------------------
  let canvasFactory = (w, h) => {
    if (typeof root.OffscreenCanvas !== 'undefined') return new root.OffscreenCanvas(w, h);
    const c = root.document.createElement('canvas'); c.width = w; c.height = h; return c;
  };
  const pool = {};
  function scratch(key, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    let s = pool[key];
    if (!s || s.canvas.width !== w || s.canvas.height !== h) {
      const canvas = canvasFactory(w, h);
      s = pool[key] = { canvas, ctx: canvas.getContext('2d') };
    }
    const c = s.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
    c.clearRect(0, 0, w, h);
    return s;
  }

  // ---------------------------------------------------------------------------------
  // 畫影像／色塊
  // ---------------------------------------------------------------------------------
  // paint(ctx, rect)：在「來源座標」畫出裁切後的內容
  function drawBox(ctx, clip, srcW, srcH, outW, outH, f, paint, fps) {
    const op = clamp(num(getParam(clip, 'video.transform.opacity', f), 1), 0, 1);
    if (op <= 0) return;
    const m = clipMatrix(clip, srcW, srcH, outW, outH, f, fps);
    const r = cropRect(clip, srcW, srcH, f);
    const soft = clamp(num(getParam(clip, 'video.crop.softness', f), 0), 0, 1);
    const cr = n => num(getParam(clip, 'video.crop.' + n, f), 0) > 0.0001;
    const fe = soft * Math.min(r.sw, r.sh) / 2;
    ctx.save();
    ctx.globalAlpha *= op;
    if (!(fe > 0) || !(cr('left') || cr('right') || cr('top') || cr('bottom'))) {
      ctx.imageSmoothingQuality = 'high';
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      paint(ctx, r);
    } else {
      // 柔邊：先畫到離屏，在來源座標下用漸層遮罩把「有裁切的那幾邊」羽化，再貼回去
      const s = scratch('soft', outW, outH), c = s.ctx;
      c.imageSmoothingQuality = 'high';
      c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      paint(c, r);
      c.globalCompositeOperation = 'destination-in';
      const edge = (on, x0, y0, x1, y1) => {
        if (!on) return;
        const gr = c.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
        c.fillStyle = gr; c.fillRect(r.sx, r.sy, r.sw, r.sh);
      };
      edge(cr('left'), r.sx, 0, r.sx + fe, 0);
      edge(cr('right'), r.sx + r.sw, 0, r.sx + r.sw - fe, 0);
      edge(cr('top'), 0, r.sy, 0, r.sy + fe);
      edge(cr('bottom'), 0, r.sy + r.sh, 0, r.sy + r.sh - fe);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      ctx.drawImage(s.canvas, 0, 0);
    }
    ctx.restore();
  }

  // 模糊背景（fit＝'blur'）：同一個畫面放大到蓋滿輸出、模糊、稍微壓暗，畫在片段本體下面。
  //   不跟著片段的縮放／位置／旋轉／裁切走（背景永遠蓋滿整個畫面），只跟著不透明度。
  //   模糊用「縮到很小再放大」：成本固定、不依賴 ctx.filter（舊版 Safari 沒有），支援 filter 時在小圖上再柔化一次去掉方塊感。
  //   bgBlur 0~100（預設 50）：越大縮得越小、越糊。
  const BG_BLUR_DEFAULT = 50;
  function drawBlurBackground(ctx, clip, source, srcW, srcH, outW, outH, f) {
    const op = clamp(num(getParam(clip, 'video.transform.opacity', f), 1), 0, 1);
    if (op <= 0) return;
    const amt = clamp(num(clip.video && clip.video.bgBlur, BG_BLUR_DEFAULT), 0, 100) / 100;
    const k = (1 - amt) * 0.12 + amt * 0.012;              // 小圖佔輸出的比例：0.12（微糊）～0.012（很糊）
    const sw = Math.max(4, Math.round(outW * k)), sh = Math.max(4, Math.round(outH * k));
    // 四周多留 m 像素：柔化時邊緣會吃進畫布外的透明，取中間 sw×sh 貼回去，邊緣才不會半透明
    const m = 3, pw = sw + 2 * m, ph = sh + 2 * m;
    const s = scratch('bgBlur', pw, ph), c = s.ctx;
    const cover = Math.max(pw / srcW, ph / srcH);
    const dw = srcW * cover, dh = srcH * cover;
    c.imageSmoothingQuality = 'high';
    if ('filter' in c) c.filter = 'blur(1px)';
    c.drawImage(source, 0, 0, srcW, srcH, (pw - dw) / 2, (ph - dh) / 2, dw, dh);
    c.filter = 'none';
    c.globalCompositeOperation = 'source-atop';          // 壓暗只作用在背景本身，不改 alpha
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.fillRect(0, 0, pw, ph);
    c.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha *= op;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.canvas, m, m, sw, sh, 0, 0, outW, outH);
    ctx.restore();
  }

  // 濾鏡（video.look）：先把來源畫到離屏，用混合模式調色，再當成來源畫（模糊背景也用調過的）。
  //   不依賴 ctx.filter（舊版 Safari 沒有）；混合模式（soft-light、saturation）各家瀏覽器都支援。
  //   調色會把透明的地方也塗上顏色，最後用原圖 destination-in 把 alpha 還原（PNG 去背圖才不會多出色塊）。
  const LOOKS = {
    none: null,
    warm: { op: 'soft-light', color: 'rgb(255,150,60)', a: 0.55 },
    cool: { op: 'soft-light', color: 'rgb(60,140,255)', a: 0.5 },
    mono: { op: 'saturation', color: 'rgb(128,128,128)', a: 1 },
    // 4.30：拆解參考影片（黑柔濾鏡教學）得到的兩種。fn 型：自己畫（c 已經畫好原圖）
    mist: { fn: mistLook },
    film: { fn: filmLook },
  };
  // 黑柔（Black Mist）：照參考影片在 DaVinci 的做法——複製一層、模糊、用「濾色（screen）」疊回去，再把曲線往下拉讓暗部不要變灰。
  //   模糊：不用 ctx.filter（見上面），改用「縮小再放大」：先縮到 1/4、再縮到 1/16，放大回來時雙線性內插就是柔柔的光暈。
  //   曲線往下拉：小圖用 multiply 和自己相乘（亮度平方），暗的地方幾乎變黑、只剩亮部會暈開——就是「高光發散、暗部保留」。
  function mistLook(c, source, srcW, srcH, amt) {
    const w1 = Math.max(1, Math.round(srcW / 4)), h1 = Math.max(1, Math.round(srcH / 4));
    const w2 = Math.max(1, Math.round(srcW / 16)), h2 = Math.max(1, Math.round(srcH / 16));
    const a = scratch('mistA', w1, h1), b = scratch('mistB', w2, h2);
    a.ctx.imageSmoothingEnabled = b.ctx.imageSmoothingEnabled = true;
    a.ctx.drawImage(source, 0, 0, w1, h1);
    b.ctx.drawImage(a.canvas, 0, 0, w2, h2);
    b.ctx.globalCompositeOperation = 'multiply';
    b.ctx.drawImage(b.canvas, 0, 0);
    b.ctx.globalCompositeOperation = 'source-over';
    a.ctx.clearRect(0, 0, w1, h1);
    a.ctx.drawImage(b.canvas, 0, 0, w1, h1);          // 分兩段放大，比一次放大 16 倍平滑
    c.imageSmoothingEnabled = true;
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = amt;
    c.drawImage(a.canvas, 0, 0, srcW, srcH);
    c.globalAlpha = 0.5 * amt;                          // 再疊半層：光暈更明顯（參考影片的效果相當強）
    c.drawImage(a.canvas, 0, 0, srcW, srcH);
    c.globalCompositeOperation = 'soft-light';         // 稍微降一點對比，像鏡頭前加了柔焦片
    c.globalAlpha = 0.25 * amt;
    c.fillStyle = 'rgb(110,110,110)';
    c.fillRect(0, 0, srcW, srcH);
  }
  // 電影感（暖橘＋青色暗部）：參考影片的主色調。screen 疊深青色＝只把暗部抬成青色（亮部幾乎不變），再 soft-light 疊橘＝膚色、燈光變暖。
  function filmLook(c, source, srcW, srcH, amt) {
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = amt;
    c.fillStyle = 'rgb(0,26,34)';
    c.fillRect(0, 0, srcW, srcH);
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = 0.5 * amt;
    c.fillStyle = 'rgb(255,140,50)';
    c.fillRect(0, 0, srcW, srcH);
  }
  function lookSource(clip, source, srcW, srcH) {
    const v = clip && clip.video, lk = v && LOOKS[v.look];
    if (!lk) return source;
    const amt = clamp(num(v.lookAmt, 100), 0, 100) / 100;
    if (!(amt > 0)) return source;
    const s = scratch('look', srcW, srcH), c = s.ctx;
    c.drawImage(source, 0, 0, srcW, srcH);
    if (lk.fn) lk.fn(c, source, srcW, srcH, amt);
    else {
      c.globalCompositeOperation = lk.op;
      c.globalAlpha = lk.a * amt;
      c.fillStyle = lk.color;
      c.fillRect(0, 0, srcW, srcH);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(source, 0, 0, srcW, srcH);
    c.globalCompositeOperation = 'source-over';
    return s.canvas;
  }

  // ---------------------------------------------------------------------------------
  // 色彩還原＋LUT（4.50）：在濾鏡之前。順序：色彩還原（自動色階＋白平衡）→ LUT → 濾鏡（video.look）
  // ---------------------------------------------------------------------------------
  // 色彩還原：把畫面縮成 64×36 統計每個色版的 1%／99% 亮度與平均，
  //   ① 各色版拉開到 0～1（自動色階，偏色、霧霧的畫面會變清楚）② 灰色世界白平衡（三個色版平均拉到一樣，去掉偏色）。
  //   每一格各自算（同一格永遠一樣，預覽和匯出一致）；色階最多拉 4 倍、白平衡每色版 0.7～1.4 倍，避免暗場被放大雜訊。
  //   回傳 out = in × mul + add（0～1）的 { mul:[r,g,b], add:[r,g,b] }；amt 0～1 是強度。看不出來（全黑、讀不到像素）回 null。
  function restoreFromStats(hist, means, count, amt) {
    if (!(count > 0) || !(amt > 0)) return null;
    const pct = (h, q) => { let acc = 0; const lim = q * count; for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= lim) return i / 255; } return 1; };
    const lo = [], hi = [], m = [];
    for (let c = 0; c < 3; c++) {
      let l = pct(hist[c], 0.01), h = pct(hist[c], 0.99);
      if (h - l < 0.25) { const mid = (h + l) / 2; l = Math.max(0, mid - 0.125); h = Math.min(1, l + 0.25); }
      lo.push(l); hi.push(h);
      m.push(clamp((means[c] / 255 - l) / (h - l), 0.02, 1));
    }
    const M = (m[0] + m[1] + m[2]) / 3;
    const mul = [], add = [];
    for (let c = 0; c < 3; c++) {
      const g = clamp(M / m[c], 0.7, 1.4), k = g / (hi[c] - lo[c]);
      mul.push(1 + (k - 1) * amt); add.push(-lo[c] * k * amt);
    }
    return { mul, add };
  }
  let statCanvas = null;
  function restoreParams(source, srcW, srcH, amt) {
    if (!(amt > 0)) return null;
    try {
      if (!statCanvas) { const cv = canvasFactory(64, 36); statCanvas = { canvas: cv, ctx: cv.getContext('2d', { willReadFrequently: true }) }; }
      const c = statCanvas.ctx;
      if (!c || typeof c.getImageData !== 'function') return null;
      c.clearRect(0, 0, 64, 36);
      c.drawImage(source, 0, 0, srcW, srcH, 0, 0, 64, 36);
      const d = c.getImageData(0, 0, 64, 36).data;
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], sum = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;              // 去背圖的透明處不算
        n++;
        for (let k = 0; k < 3; k++) { hist[k][d[i + k]]++; sum[k] += d[i + k]; }
      }
      return restoreFromStats(hist, sum.map(v => (n ? v / n : 0)), n, amt);
    } catch (_) { return null; }       // 讀不到像素（跨來源等）就不調
  }
  // CPU 版（沒有 WebGL 時）：直接改像素。lut＝{ size, data }、la＝LUT 強度 0～1、rp＝restoreParams 的結果
  function gradePixels(d, rp, lut, la) {
    const C = root.QPTEdit && root.QPTEdit.core;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      if (rp) { r = clamp(r * rp.mul[0] + rp.add[0], 0, 1); g = clamp(g * rp.mul[1] + rp.add[1], 0, 1); b = clamp(b * rp.mul[2] + rp.add[2], 0, 1); }
      if (lut && la > 0 && C) {
        const v = C.lutLookup(lut.data, lut.size, r, g, b);
        r += (v[0] - r) * la; g += (v[1] - g) * la; b += (v[2] - b) * la;
      }
      d[i] = Math.round(r * 255); d[i + 1] = Math.round(g * 255); d[i + 2] = Math.round(b * 255);
    }
    return d;
  }
  function gradeSource(clip, source, srcW, srcH, project) {
    const v = clip && clip.video;
    if (!v) return source;
    const C = root.QPTEdit && root.QPTEdit.core;
    const lut = v.lut && C && C.lutData ? C.lutData(project, v.lut) : null;
    const la = lut ? clamp(num(v.lutAmt, 100), 0, 100) / 100 : 0;
    const ra = clamp(num(v.restore, 0), 0, 100) / 100;
    if (!(la > 0) && !(ra > 0)) return source;
    const rp = ra > 0 ? restoreParams(source, srcW, srcH, ra) : null;
    if (!rp && !(la > 0)) return source;
    const G = root.QPTEdit && root.QPTEdit.fxgl;
    const out = G && G.grade ? G.grade(source, srcW, srcH, { rp, lut: la > 0 ? lut : null, lutAmt: la }) : null;
    if (out) return out;
    try {                                      // 沒有 WebGL：CPU 慢慢算（大畫面會比較慢，但結果一樣）
      const s = scratch('grade', srcW, srcH), c = s.ctx;
      c.drawImage(source, 0, 0, srcW, srcH);
      const img = c.getImageData(0, 0, Math.round(srcW), Math.round(srcH));
      gradePixels(img.data, rp, la > 0 ? lut : null, la);
      c.putImageData(img, 0, 0);
      return s.canvas;
    } catch (_) { return source; }
  }

  function drawClipVisual(ctx, clip, source, srcW, srcH, outW, outH, fInClip, fps, project) {
    if (!source || !(srcW > 0) || !(srcH > 0)) return;
    source = gradeSource(clip, source, srcW, srcH, project);
    source = lookSource(clip, source, srcW, srcH);
    if (getParam(clip, 'video.fit', fInClip || 0) === 'blur') drawBlurBackground(ctx, clip, source, srcW, srcH, outW, outH, fInClip || 0);
    drawBox(ctx, clip, srcW, srcH, outW, outH, fInClip || 0, (c, r) => {
      c.drawImage(source, r.sx, r.sy, r.sw, r.sh, r.sx, r.sy, r.sw, r.sh);
    }, fps);
  }

  // 色塊：當成一張和輸出同大的純色影像，所以縮放／位置／旋轉／裁切／不透明度都照樣可用
  function drawSolid(ctx, clip, outW, outH, fInClip, fps) {
    const color = clip.solidColor || '#000000';
    drawBox(ctx, clip, outW, outH, outW, outH, fInClip || 0, (c, r) => {
      c.fillStyle = color; c.fillRect(r.sx, r.sy, r.sw, r.sh);
    }, fps);
  }

  // ---------------------------------------------------------------------------------
  // 字型
  // ---------------------------------------------------------------------------------
  // 字幕字型。WHZ-Heavy 由 base.css 的 @font-face 提供（頁首標題也用它）；其他字型檔很大，
  // 用到時（選了這個字型、或預覽／匯出畫到它）才用 FontFace 下載。還沒載入好之前先用備用字型畫，載入後通知重畫。
  const SANS_FALLBACK = '"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  const SERIF_FALLBACK = '"Noto Serif TC", "Songti TC", "PMingLiU", "MingLiU", serif';
  const FONT_FALLBACK = SANS_FALLBACK;
  const FONTS = {
    'WHZ-Heavy': { name: '粗體（預設）', family: 'WHZ-Heavy', fallback: SANS_FALLBACK },
    cactus: { name: '仙人掌明體', family: 'Cactus Classical Serif', url: 'fonts/cactus-classical-serif.woff2', fallback: SERIF_FALLBACK },
    system: { name: '系統黑體', system: true },
  };
  const fontState = {};        // id → { promise, loaded, failed }
  const fontListeners = new Set();
  let fontGen = 0;             // 任何字型載入完成就 +1（排版快取的 key 用）
  function loadFont(id) {
    const def = FONTS[id];
    if (!def || def.system) return Promise.resolve(true);
    let st = fontState[id];
    if (st) return st.promise;
    st = fontState[id] = { loaded: false, failed: false };
    const d = root.document;
    const notify = what => { for (const cb of fontListeners) { try { cb(id, what); } catch (e) { /* 通知失敗不影響其他人 */ } } };
    const done = ok => { st.loaded = true; st.failed = !ok; fontGen++; notify(ok ? 'loaded' : 'failed'); return ok; };
    if (def.url) notify('loading');
    if (!d || !d.fonts || !d.fonts.load) st.promise = Promise.resolve(done(true));
    else if (!def.url) st.promise = d.fonts.load(`80px "${def.family}"`, '字幕測試ABC123').then(() => done(true), () => done(false));
    else if (typeof root.FontFace !== 'function') st.promise = Promise.resolve(done(false));
    else {
      const ff = new root.FontFace(def.family, `url("${def.url}") format("woff2")`, { display: 'swap' });
      st.promise = ff.load().then(face => { d.fonts.add(face); return done(true); }, () => done(false));
    }
    return st.promise;
  }
  const fontIsLoaded = id => { const def = FONTS[id]; return !def || !!def.system || !!(fontState[id] && fontState[id].loaded); };
  // 等字型載入（Canvas 不會等 @font-face）。給 project 時等它所有字幕用到的字型；不給只等預設字型與已經開始下載的
  function ready(project) {
    const ids = new Set(['WHZ-Heavy', ...Object.keys(fontState)]);
    if (project && project.clips) for (const c of Object.values(project.clips)) if (c && c.title) ids.add(c.title.font || 'WHZ-Heavy');
    return Promise.all([...ids].map(loadFont)).then(r => r.every(Boolean));
  }
  // cb(id, 'loading'|'loaded'|'failed')；'loading' 只有需要下載的字型才會發
  function onFontLoad(cb) { fontListeners.add(cb); return () => fontListeners.delete(cb); }
  function fontString(t, px) {
    const id = t.font || 'WHZ-Heavy', def = FONTS[id];
    // 細字（4.30 極簡細字）：明體本身就細，照用；粗體字型只有一種字重，改用系統黑體的細字重
    if (t.weight === 'light' && !(def && def.fallback === SERIF_FALLBACK)) return `300 ${px}px system-ui, -apple-system, "Segoe UI", ${SANS_FALLBACK}`;
    if (id === 'system' || id === 'sans') return `bold ${px}px system-ui, -apple-system, "Segoe UI", ${SANS_FALLBACK}`;
    if (def) { if (!fontIsLoaded(id)) loadFont(id); return `${px}px "${def.family}", ${def.fallback}`; }
    return `${px}px "${id}", ${FONT_FALLBACK}`;
  }
  // 字距（t.spacing＝字級的倍數）：用 Canvas 的 letterSpacing，會算進 measureText，排版、外框都跟著對。
  // 共用的 ctx（量字用的 scratch）每次都要設回去，免得上一個字幕的字距留下來；不支援的瀏覽器就沒有字距
  function setSpacing(ctx, t, px) {
    if (!('letterSpacing' in ctx)) return;
    const s = num(t && t.spacing, 0);
    ctx.letterSpacing = (s ? s * px : 0) + 'px';
  }
  // 舊的介面相容：fontLoaded＝預設字型載入了沒
  const defaultFontLoaded = () => fontIsLoaded('WHZ-Heavy');

  // ---------------------------------------------------------------------------------
  // 文字換行（中文依寬度、行首不放標點、行尾不放開括號；英數單字不拆，太長才硬拆）
  // ---------------------------------------------------------------------------------
  const NO_START = new Set(Array.from('，。、．；：？！）」』】》〉］｝”’…‥—～ー々,.;:?!)]}%‰°'));
  const NO_END = new Set(Array.from('（「『【《〈［｛“‘([{'));
  const WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’.\-:\/][A-Za-z0-9À-ɏ]+)*/y;

  function tokenize(par) {
    const out = [];
    const chars = Array.from(par);
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      if (/[A-Za-z0-9À-ɏ]/.test(ch)) {
        const rest = chars.slice(i).join('');
        WORD_RE.lastIndex = 0;
        const m = WORD_RE.exec(rest);
        const w = m ? m[0] : ch;
        out.push({ s: w, sp: false });
        i += Array.from(w).length;
      } else if (ch === ' ' || ch === '\t' || ch === '　') {
        out.push({ s: ch === '\t' ? ' ' : ch, sp: true }); i++;
      } else { out.push({ s: ch, sp: false }); i++; }
    }
    return out;
  }

  // measure(str) → 寬度；回傳行陣列。maxW 小於一個字時每行至少放一個字。
  function wrapText(measure, text, maxW) {
    const lines = [];
    const pars = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const str = a => a.map(t => t.s).join('');
    const trimEnd = a => { while (a.length && a[a.length - 1].sp) a.pop(); return a; };
    for (const par of pars) {
      const q = tokenize(par);
      let cur = [];
      let guard = 0;
      for (let qi = 0; qi < q.length && guard++ < 100000; qi++) {
        const tok = q[qi];
        if (tok.sp && cur.length === 0) continue;
        const cand = str(cur) + tok.s;
        if (cur.length === 0) {
          // 單字比一整行還寬：硬拆成字元
          const cs = Array.from(tok.s);
          if (!tok.sp && cs.length > 1 && measure(tok.s) > maxW) {
            q.splice(qi, 1, ...cs.map(c => ({ s: c, sp: false }))); qi--; continue;
          }
          cur.push(tok); continue;
        }
        if (measure(cand.replace(/\s+$/, '')) <= maxW) { cur.push(tok); continue; }
        if (tok.sp) { lines.push(str(trimEnd(cur))); cur = []; continue; }
        // 需要在 tok 前換行：先處理禁則，把前面的字一起帶到下一行
        const carry = [];
        let first = tok;
        while (NO_START.has(first.s) && cur.length > 1) { carry.unshift(cur.pop()); first = carry[0]; }
        while (cur.length > 1 && (NO_END.has(cur[cur.length - 1].s) || cur[cur.length - 1].sp)) {
          const last = cur.pop();
          if (!last.sp) carry.unshift(last);
        }
        lines.push(str(trimEnd(cur)));
        cur = carry;
        while (cur.length && cur[0].sp) cur.shift();
        qi--; continue;           // 帶下來的字連同 tok 重新檢查（cur 只會越來越短，一定會結束）
      }
      lines.push(str(trimEnd(cur)));
    }
    return lines;
  }

  const layoutCache = new Map();
  function layoutTitle(ctx, t, font, maxW) {
    const sp = num(t.spacing, 0);
    const key = font + '|' + Math.round(maxW) + '|' + fontGen + '|' + (sp ? sp + '|' : '') + t.text;
    setSpacing(ctx, t, +((/([\d.]+)px/.exec(font) || [0, 0])[1]));
    let v = layoutCache.get(key);
    if (v) return v;
    ctx.font = font;
    const measure = s => ctx.measureText(s).width;
    const lines = wrapText(measure, t.text, maxW);
    const widths = lines.map(measure);
    v = { lines, widths, w: Math.max(0, ...widths) };
    if (layoutCache.size > 60) layoutCache.delete(layoutCache.keys().next().value);
    layoutCache.set(key, v);
    return v;
  }

  // ---------------------------------------------------------------------------------
  // 顏色小工具（詳細內容的色彩＋透明度欄位用）
  // ---------------------------------------------------------------------------------
  function parseColor(s) {
    s = String(s == null ? '' : s).trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) { const h = m[1]; return { hex: '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2], a: 1 }; }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
    if (m) return { hex: '#' + m[1].toLowerCase(), a: m[2] ? Math.round(parseInt(m[2], 16) / 255 * 1000) / 1000 : 1 };
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) {
      const h = n => clamp(Math.round(+n), 0, 255).toString(16).padStart(2, '0');
      return { hex: '#' + h(m[1]) + h(m[2]) + h(m[3]), a: m[4] == null ? 1 : clamp(+m[4], 0, 1) };
    }
    return { hex: '#000000', a: s === 'transparent' ? 0 : 1 };
  }
  function formatColor(hex, a) {
    if (a >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
  }

  // ---------------------------------------------------------------------------------
  // 字幕
  // ---------------------------------------------------------------------------------
  // 外框（色框）：描邊外面一圈一圈往外加，固定 4 格（on＝有用；1 在最內側）。固定長度是因為 core 的深層合併對陣列是逐格合併
  const OUTLINE_SLOTS = 4;
  const outlineOff = () => ({ on: false, color: '#ffffff', width: 6 });
  const BASE_TITLE = {
    text: '輸入字幕', preset: 'static', font: 'WHZ-Heavy', size: 80, color: '#ffffff', align: 'center',
    stroke: { color: '#000000', width: 0 }, shadow: { color: 'rgba(0,0,0,.6)', blur: 8, x: 0, y: 4 },
    bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8, tail: 'none', border: { color: '#000000', width: 0 } }, lineHeight: 1.25, x: 0.5, y: 0.5,
    outlines: Array.from({ length: OUTLINE_SLOTS }, outlineOff),
    gradient: { on: false, color: '#8fd8ff', kind: 'two' }, // 漸層：kind 'two'＝由上（文字顏色）到下（這個顏色）；其他種類見 GRADIENTS
    extrude: { color: '#3a2386', depth: 0, angle: 45 }, // 立體：往 angle 方向擠出 depth（短邊 1080 時的像素），0＝關
    skew: 0,                                          // 斜體角度（度，正＝往右傾）
    accent: '#ff2d2d',                                // 強調色：文字裡用 *…* 包住的字
    textFx: 'none', textFxDur: 0.5,                   // 字體特效（進場動畫）與每個字（或整塊）的動畫長度（秒）
    // ---- 4.30 字幕樣式 ----
    // 字幕底形狀（SHAPES），none＝用 bg 的圓角底；選了形狀就取代 bg。color＝底色、color2＝第二色（爆炸內層／標籤小標）、
    // border／borderW＝外框顏色與粗細（短邊 1080 時的像素，只有 SHAPES 標 border 的形狀用）、tail＝對話框尾巴 left／center／right／none
    shape: { kind: 'none', color: '#ffffff', color2: '#e5141b', border: '#111111', borderW: 6, tail: 'left' },
    glow: { color: '#ff4fd8', blur: 0 },              // 發光（霓虹）：blur 0＝關
    speedLines: { on: false, color: 'rgba(255,255,255,0.55)' }, // 集中線：整個畫面、以字幕為中心
    weight: 'auto', spacing: 0,                       // 字重（auto＝字型本身；light＝細字，粗體字型會改用系統細黑體）、字距（字級的倍數，0.1＝一成）
    textLoop: 'none', textLoopColor: '#ffd400',       // 持續特效（TEXT_LOOP）與它用的顏色（卡拉OK／逐字高亮）
    textOut: 'none', textOutDur: 0.3,                 // 出場特效（TEXT_OUT，片段最後那段時間）與長度（秒）
  };
  // 背景框的尖角（對話氣泡）：none／bl 左下／br 右下／tl 左上／tr 右上
  const BG_TAILS = [['none', '無'], ['bl', '左下'], ['br', '右下'], ['tl', '左上'], ['tr', '右上']];
  // 字幕物件補齊預設值（舊專案沒有新欄位、或只合併了一部分）；文字去掉強調用的星號，__mask 記哪些字要強調
  function normTitle(t) {
    t = t || {};
    const n = { ...BASE_TITLE, ...t };
    for (const k of ['stroke', 'shadow', 'bg', 'gradient', 'extrude', 'shape', 'glow', 'speedLines']) n[k] = { ...BASE_TITLE[k], ...(t[k] || {}) };
    n.bg.border = { ...BASE_TITLE.bg.border, ...((t.bg && t.bg.border) || {}) };
    if (n.textFx === 'wave') { n.textFx = 'none'; if (!n.textLoop || n.textLoop === 'none') n.textLoop = 'wave'; }   // 4.30（main）的波浪進場＝現在的持續特效「波浪」
    n.outlines = BASE_TITLE.outlines.map((b, i) => ({ ...b, ...((Array.isArray(t.outlines) && t.outlines[i]) || {}) }));
    const a = parseAccent(n.text);
    n.text = a.text; n.__mask = a.mask;
    return n;
  }
  // 「進行*瘋狂*的編輯」→ 文字「進行瘋狂的編輯」＋每個字是否強調。只認成對的星號，落單的保留原樣
  function parseAccent(text) {
    const s = String(text == null ? '' : text);
    if (s.indexOf('*') < 0) return { text: s, mask: null };
    const cs = Array.from(s), stars = [];
    cs.forEach((c, i) => { if (c === '*') stars.push(i); });
    const pairs = new Set(stars.slice(0, stars.length - stars.length % 2));
    const out = [], mask = [];
    let on = false;
    cs.forEach((c, i) => { if (pairs.has(i)) { on = !on; return; } out.push(c); mask.push(on); });
    return { text: out.join(''), mask: mask.some(Boolean) ? mask : null };
  }

  // parseAccent 的反向：純文字＋逐字遮罩 → 用星號包住強調的字。原本就有的星號換成全形「＊」，才不會跟標記混在一起
  function buildAccent(text, mask) {
    const cs = Array.from(String(text == null ? '' : text)).map(c => (c === '*' ? '＊' : c));
    let out = '', on = false;
    cs.forEach((c, i) => {
      const m = !!(mask && mask[i]) && c !== '\n';
      if (m !== on) { out += '*'; on = m; }
      out += c;
    });
    return on ? out + '*' : out;
  }

  // ---- 字幕清單（SRT 匯入、V 標記）------------------------------------------------
  // SRT → [{ start, end（格，不含 end）, text }]。時間碼允許逗號或句點、可省略小時；拿掉 <i> 之類的標籤與 {\an8} 這種定位碼
  function parseSrt(src, fps) {
    const out = [];
    const ts = '(?:(\\d+):)?(\\d{1,2}):(\\d{1,2})[,.](\\d{1,3})';
    const re = new RegExp('^\\s*' + ts + '\\s*-->\\s*' + ts);
    const sec = (h, m, s2, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s2) + (+(ms + '00').slice(0, 3)) / 1000;
    const lines = String(src == null ? '' : src).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const body = [];
      for (i++; i < lines.length && lines[i].trim() !== '' && !re.test(lines[i]); i++) body.push(lines[i]);
      // 下一段的序號（純數字）會黏在空行前：拿掉文字最後的純數字行，要是下一行就是時間碼
      if (i < lines.length && re.test(lines[i]) && body.length && /^\s*\d+\s*$/.test(body[body.length - 1])) body.pop();
      i--;
      const text = body.join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
      const start = Math.round(sec(m[1], m[2], m[3], m[4]) * fps), end = Math.round(sec(m[5], m[6], m[7], m[8]) * fps);
      if (end > start) out.push({ start, end, text });
    }
    return fitCues(out);
  }
  // parseSrt 的反向：[{ start, end（格，不含 end）, text }] → SRT 文字。強調用的星號拿掉、空白的段落略過、序號從 1 重排
  function formatSrt(cues, fps) {
    const pad = (n, w) => String(n).padStart(w, '0');
    const ts = f => {
      const ms = Math.max(0, Math.round(f * 1000 / fps));
      return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor(ms / 60000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
    };
    const out = [];
    for (const c of cues.slice().sort((a, b) => a.start - b.start)) {
      const text = parseAccent(c.text).text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
      if (!text || !(c.end > c.start)) continue;
      out.push(`${out.length + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${text}\n`);
    }
    return out.join('\n');
  }
  // 依開始時間排序；跟後一段重疊時，前一段結束在後一段開始的前一格（不含 end，所以 end＝後一段的 start）；同一格開始的只留第一段
  function fitCues(list) {
    const a = list.slice().sort((x, y) => x.start - y.start);
    const out = [];
    for (const c of a) {
      const prev = out[out.length - 1];
      if (prev && c.start <= prev.start) continue;
      if (prev && prev.end > c.start) prev.end = c.start;
      out.push({ ...c });
    }
    return out;
  }
  // 在第 f 格按 V：新字幕從 f 開始，最長 maxSec 秒，碰到下一段就停在它前一格；正在播的前一段改成在 f 的前一格結束
  // subs：[{ id, start, end }]。回傳 { start, end, trimPrev: { id, end } | null }，f 剛好是某段的開頭時回傳 { existing: id }
  function planSubtitleMark(subs, f, fps, maxSec) {
    const a = subs.slice().sort((x, y) => x.start - y.start);
    const same = a.find(c => c.start === f);
    if (same) return { existing: same.id };
    let prev = null, next = null;
    for (const c of a) { if (c.start < f) prev = c; else if (!next) next = c; }
    const end = Math.min(f + Math.max(1, Math.round((maxSec || 10) * fps)), next ? next.start : Infinity);
    return { start: f, end, trimPrev: prev && prev.end > f ? { id: prev.id, end: f } : null };
  }

  // 字體特效三層可以疊加：進場（TEXT_FX，字幕開頭）＋持續（TEXT_LOOP，整段）＋出場（TEXT_OUT，結束前）。
  // 動畫都只由「片段內第幾格」決定（沒有亂數、沒有時鐘），所以預覽和匯出一模一樣。
  // 註冊表欄位：
  //   TEXT_FX   char＝逐字依序錯開，line＝一行一行錯開（整行一起動），都沒有＝整塊（含底色）一起動；
  //             state(u, lh, o)＝新式進場（u＝進度，可能 <0 或 >1；o＝drawTitle 的參數），沒有 state 的走下面 textFxState 的舊算法；
  //             hard＝不漸變、輪到就出現（打字機，不看「進場長度」）；cursor＝畫閃爍游標；thumbF＝媒體庫縮圖停在哪一格
  //   TEXT_LOOP scope＝'block'（整塊）或 'char'（逐字）；at(P, idx)＝這一格的 fx；color＝用得到「持續顏色」；hl＝逐字高亮（畫底）
  //   TEXT_OUT  出場：drawTitle 把整個字幕一起變形，算法在 textOutState（blur＝用 blurPaint 變模糊）
  const easeInCubic = u => { u = clamp(u, 0, 1); return u * u * u; };
  const slideIn = (dx, dy) => (u, lh, o) => {
    const e = 1 - Math.pow(1 - clamp(u, 0, 1), 3);
    return { a: clamp(u * 3, 0, 1), s: 1, dx: dx * o.outW * 0.6 * (1 - e), dy: dy * o.outH * 0.3 * (1 - e) };
  };
  const TEXT_FX = {
    none: { name: '無' },
    pop: { name: '彈出' },
    popLine: { name: '逐行彈出', line: true },
    popChar: { name: '逐字彈出', char: true },
    jump: { name: '下往上跳起' },
    jumpLine: { name: '逐行跳起', line: true },
    jumpChar: { name: '逐字跳起', char: true },
    // 衝擊放大：從 3.2 倍用力砸下來（加速），砸到 0.88 倍再彈回 1（稍微超過）
    impact: { name: '衝擊放大', thumbF: 8, state(u) {
      u = clamp(u, 0, 1);
      const s = u < 0.6 ? 3.2 - 2.32 * Math.pow(u / 0.6, 2) : 0.88 + 0.12 * easeOutBack((u - 0.6) / 0.4, 3);
      return { a: clamp(u * 5, 0, 1), s };
    } },
    // 打字機＋游標：一個字一個字出現（輪到就整個出現），後面跟一條閃爍的游標；打完後游標繼續閃
    typeCursor: { name: '打字機＋游標', char: true, hard: true, cursor: true, thumbF: 4, state: u => ({ a: u >= 0 ? 1 : 0 }) },
    // 滑入：從左／右／下滑進來，減速停住（同時淡入）。做成三個 key，和出場的「飛出」方向名稱一致
    slideLeft: { name: '左滑入', thumbF: 4, state: slideIn(-1, 0) },
    slideRight: { name: '右滑入', thumbF: 4, state: slideIn(1, 0) },
    slideBottom: { name: '下滑入', thumbF: 4, state: slideIn(0, 1) },
    // 4.30 拆解參考影片加的
    fade: { name: '淡入' },
    fadeLine: { name: '逐行淡入', line: true },
    fadeChar: { name: '逐字淡入', char: true },
    blurIn: { name: '模糊浮現', blur: true },   // 從模糊、稍大慢慢變清楚（後期、可以多看幾次）
    echo: { name: '殘影', echo: true },          // 主字淡入，旁邊一個放大的半透明殘影慢慢消失（終於）
    smear: { name: '拖影上衝', smear: true },    // 從下面帶著拖影衝上來（追蹤我）
    // 4.30（main）的「波浪」進場已改成持續特效 TEXT_LOOP.wave：留著 key 讓舊專案讀得到（normTitle 會換成 textLoop），選單不列出
    wave: { name: '波浪', hidden: true },
  };
  // 偽亂數：同一個整數永遠同一個值（0~1），不用 Math.random，預覽＝匯出
  const hash01 = n => {
    let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const NO_FX = Object.freeze({});
  // 一段字幕的「單位」：逐字（每個非空白字算一個）或逐詞（文字裡有空白／換行時，連續的非空白字算一個詞，換行處也斷開）。
  // 回傳 { of: 全文第 i 個字屬於第幾個單位（空白＝-1）, N: 單位數 }
  function fxUnits(P, wordy) {
    const key = wordy && /\S\s+\S/.test(String(P.t.text == null ? '' : P.t.text)) ? 'w' : 'c';
    if (P.units[key]) return P.units[key];
    const of = []; let n = 0;
    for (const line of P.L.lines) {
      let inWord = false;
      for (const ch of Array.from(line)) {
        if (/\s/.test(ch)) { of.push(-1); inWord = false; continue; }
        if (key === 'c' || !inWord) n++;
        inWord = true;
        of.push(n - 1);
      }
    }
    return (P.units[key] = { of, N: n });
  }
  // 整段時間平均分給每個字（或詞）；標準 SRT 沒有逐字時間，所以這版只做平均分配。進度 0~1（第一格＝0，最後一格＝1）
  const fxProg = P => clamp(P.o.f / Math.max(1, P.o.dur - 1), 0, 1);
  // 持續特效：整段字幕期間一直在動
  const TEXT_LOOP = {
    none: { name: '無' },
    // 抖動：每 fps/15 格換一次位置（約每秒 15 次），位置由格數決定
    shake: { name: '抖動', scope: 'block', at(P) {
      const n = Math.floor(P.o.f / Math.max(1, Math.round(P.o.fps / 15))), r = i => hash01(n * 4 + i) * 2 - 1, amp = P.lh * 0.05;
      return { dx: r(0) * amp, dy: r(1) * amp, rot: r(2) * 0.035 };
    } },
    // 波浪：每個字依序晚一點起伏（每秒 1.2 個週期、相鄰字差 0.6 弧度，高度 0.12 行高；和 4.30 main 的「波浪」進場一模一樣）
    wave: { name: '波浪', scope: 'char', at: (P, idx) => ({ dy: Math.sin(P.o.f / P.o.fps * Math.PI * 2 * 1.2 - idx * 0.6) * P.lh * 0.12 }) },
    // 卡拉OK：跟著時間一個字一個字變成「持續顏色」；第一格 0 個字，最後一格全部
    karaoke: { name: '卡拉OK', scope: 'char', color: true, at(P, idx) {
      const U = fxUnits(P, false), u = U.of[idx];
      return u >= 0 && fxProg(P) * U.N >= u + 1 - 1e-9 ? { color: P.t.textLoopColor } : NO_FX;
    } },
    // 逐字高亮：念到的那個詞（沒空白時是那個字）底色用「持續顏色」、字變黑
    highlight: { name: '逐字高亮', scope: 'char', color: true, hl: true, at(P, idx) {
      const U = fxUnits(P, true), u = U.of[idx];
      return u >= 0 && u === Math.min(U.N - 1, Math.floor(fxProg(P) * U.N)) ? { color: '#111111', hl: P.t.textLoopColor } : NO_FX;
    } },
  };
  // 字幕出場動畫：作用在片段最後 textOutDur 秒，整塊（含背景框）一起動
  const TEXT_OUT = {
    none: { name: '無' },
    fade: { name: '淡出' },
    slideLeft: { name: '往左滑出' },
    slideDown: { name: '往下沉' },
    popOut: { name: '縮小消失' },
    blurOut: { name: '變模糊消失', blur: true },
    slideRight: { name: '往右滑出' },
    slideUp: { name: '往上飄走' },
  };
  // 出場進度 u（0＝還沒開始、1＝完全消失）→ { a 透明度, s 縮放, dx／dy 位移（px）, blur }
  function textOutState(kind, u, o) {
    const e = u * u;
    if (kind === 'fade') return { a: 1 - u, s: 1, dx: 0, dy: 0 };
    if (kind === 'slideLeft') return { a: 1 - u, s: 1, dx: -e * o.outW * 0.3, dy: 0 };
    if (kind === 'slideDown') return { a: 1 - u, s: 1, dx: 0, dy: e * o.lh * 1.5 };
    if (kind === 'slideRight') return { a: 1 - u, s: 1, dx: e * o.outW * 0.3, dy: 0 };
    if (kind === 'slideUp') return { a: 1 - u, s: 1, dx: 0, dy: -e * o.lh * 1.5 };
    if (kind === 'popOut') return { a: 1, s: Math.max(0, 1 - e), dx: 0, dy: 0 };
    if (kind === 'blurOut') return { a: 1 - u, s: 1 + 0.1 * u, dx: 0, dy: 0, blur: u };
    return null;
  }
  const easeOutBack = (u, s) => { u = clamp(u, 0, 1) - 1; return 1 + (s + 1) * u * u * u + s * u * u; };
  // 舊式進場：動畫進度 u（0~1）時的 { a 透明度, s 縮放, dy 垂直位移（px）}：彈出＝從 0 放大、稍微超過再回來；跳起＝從一行高的下方往上跳、超過一點再落定
  function textFxState(kind, u, lh, o) {
    const d = TEXT_FX[kind];
    if (d && d.state) return d.state(u, lh, o);
    const a = clamp(u * 3, 0, 1);
    if (kind === 'pop' || kind === 'popLine' || kind === 'popChar') return { a, s: Math.max(0, easeOutBack(u, 2.2)), dy: 0 };
    if (kind === 'fade' || kind === 'fadeLine' || kind === 'fadeChar' || kind === 'echo') return { a: easeOutCubic(u), s: 1, dy: 0 };
    if (kind === 'blurIn') { const e = easeOutCubic(u); return { a: clamp(u * 2, 0, 1), s: 1.12 - 0.12 * e, dy: 0, blur: 1 - e }; }
    if (kind === 'smear') { const e = easeOutCubic(u); return { a: clamp(u * 4, 0, 1), s: 1, dy: (1 - e) * lh * 1.6, trail: 1 - e }; }
    return { a, s: 1, dy: (1 - easeOutBack(u, 2.6)) * lh * 1.1 };
  }

  // 字幕樣式：一鍵套用的外觀（只改顏色、描邊、外框、陰影、立體、斜體、強調色、底形狀、發光、集中線、漸層、字重字距；不動文字、字型、位置、過場、動畫）
  // 每個樣式都要把「形狀、發光、集中線、漸層種類、字重、字距」全部設定一次（look()），不然從爆炸字卡切回基本會殘留
  const outlinesOf = (...a) => Array.from({ length: OUTLINE_SLOTS }, (_, i) => (a[i] ? { on: true, ...a[i] } : outlineOff()));
  const NO_SHADOW = { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 };
  const NO_EXTRUDE = { color: '#3a2386', depth: 0, angle: 45 };
  const NO_SHAPE = { kind: 'none', color: '#ffffff', color2: '#e5141b', border: '#111111', borderW: 6, tail: 'left' };
  const NO_GLOW = { color: '#ff4fd8', blur: 0 };
  const NO_LINES = { on: false, color: 'rgba(255,255,255,0.55)' };
  const look = (o = {}) => ({ shape: { ...NO_SHAPE, ...o.shape }, glow: { ...NO_GLOW, ...o.glow }, speedLines: { ...NO_LINES, ...o.speedLines },
    weight: o.weight || 'auto', spacing: o.spacing || 0 });
  const grad = (kind, color = '#8fd8ff') => ({ on: !!kind, color, kind: kind || 'two' });
  // group：分類（簡易面板的分頁用），不是 patch 的一部分
  const TITLE_STYLE_GROUPS = { basic: '基本', variety: '綜藝', social: '社群' };
  const TITLE_STYLES = {
    plain: { name: '基本', sample: '字幕樣式', group: 'basic',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(0,0,0,.6)', blur: 8, x: 0, y: 4 }, extrude: NO_EXTRUDE, skew: 0, accent: '#ff2d2d', ...look() } },
    blueGlow: { name: '藍白漸層', sample: '全場笑翻了', group: 'basic',
      patch: { color: '#ffffff', gradient: grad('two', '#8fd8ff'), stroke: { color: '#0b3f7a', width: 5 },
        outlines: outlinesOf({ color: '#ffffff', width: 7 }, { color: '#1593d6', width: 7 }),
        shadow: { color: 'rgba(0,30,70,.55)', blur: 6, x: 0, y: 6 }, extrude: NO_EXTRUDE, skew: 8, accent: '#ffc531', ...look() } },
    purple3d: { name: '紫色立體', sample: '來幫你做', group: 'basic',
      patch: { color: '#ffffff', gradient: grad('two', '#cfc0ff'), stroke: { color: '#5a3ea6', width: 9 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: { color: '#36207f', depth: 16, angle: 45 }, skew: 0, accent: '#ffd23f', ...look() } },
    blackCyan: { name: '黑邊青框', sample: '要不要訂閱', group: 'basic',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#111111', width: 9 },
        outlines: outlinesOf({ color: '#3fd8d8', width: 5 }), shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#3fd8d8', ...look() } },
    redAccent: { name: '黑邊強調紅', sample: '進行*瘋狂*的', group: 'basic',
      patch: { color: '#fff8ec', gradient: grad(), stroke: { color: '#141414', width: 7 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: { color: '#141414', depth: 8, angle: 45 }, skew: 10, accent: '#e5141b', ...look() } },
    // ---- 4.30 新增：綜藝 ----
    varietyYellow: { name: '綜藝黃字', sample: '笑到肚子痛', group: 'variety',
      patch: { color: '#ffe11a', gradient: grad(), stroke: { color: '#111111', width: 9 }, outlines: outlinesOf(),
        shadow: { color: '#111111', blur: 0, x: 0, y: 7 }, extrude: NO_EXTRUDE, skew: 7, accent: '#ff3b30', ...look() } },
    burstCard: { name: '爆炸字卡', sample: '爆炸', group: 'variety',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#111111', width: 7 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 8, accent: '#ffd400', ...look({ shape: { kind: 'burst', color: '#ffd400', color2: '#e5141b' } }) } },
    pinkShout: { name: '粉紅驚嘆', sample: '太可愛了吧', group: 'variety',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#ff4f9a', width: 7 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: { color: '#7a1446', depth: 9, angle: 45 }, skew: 0, accent: '#ffe14d', ...look() } },
    bubbleTalk: { name: '吐槽對話框', sample: '欸你剛剛說什麼？', group: 'variety',
      patch: { color: '#111111', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#e5141b',
        ...look({ shape: { kind: 'bubble', color: '#ffffff', border: '#111111', borderW: 6, tail: 'left' } }) } },
    tagBar: { name: '標籤條', sample: '現場直擊\n排隊三小時', group: 'variety',
      patch: { color: '#111111', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#e5141b',
        ...look({ shape: { kind: 'tag', color: '#ffffff', color2: '#e5141b' } }) } },
    impact: { name: '效果字', sample: '蛤？！', group: 'variety',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#2242c8', width: 10 }, outlines: outlinesOf(),
        shadow: { color: '#0d1a5c', blur: 0, x: 6, y: 7 }, extrude: NO_EXTRUDE, skew: 14, accent: '#ffe14d',
        ...look({ speedLines: { on: true, color: 'rgba(255,255,255,0.55)' } }) } },
    // ---- 4.30 新增：社群 ----
    lineBox: { name: '白底框字', sample: '今天帶你們去\n台南吃早餐', group: 'social',
      patch: { color: '#111111', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#e5141b',
        ...look({ shape: { kind: 'lineBox', color: '#ffffff' } }) } },
    wordHi: { name: '逐字高亮', sample: '真的超級好吃', group: 'social',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#000000', width: 6 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#ffd400', ...look() } },
    neon: { name: '霓虹發光', sample: '深夜食堂', group: 'social',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#ff4fd8', width: 3 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#22e3ff',
        ...look({ glow: { color: '#ff4fd8', blur: 26 } }) } },
    thinSoft: { name: '極簡細字', sample: '那天的風 很溫柔', group: 'social',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(0,0,0,.7)', blur: 8, x: 0, y: 2 }, extrude: NO_EXTRUDE, skew: 0, accent: '#ffd9a0',
        ...look({ weight: 'light', spacing: 0.12 }) } },
    stickerTag: { name: '貼紙標籤', sample: '#週末去哪玩', group: 'social',
      patch: { color: '#111111', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: NO_SHADOW, extrude: NO_EXTRUDE, skew: 0, accent: '#e5141b',
        ...look({ shape: { kind: 'sticker', color: '#ffef5c', border: '#ffffff', borderW: 7 } }) } },
    rainbow: { name: '彩虹漸層', sample: '彩虹漸層', group: 'social',
      patch: { color: '#ffffff', gradient: grad('rainbow'), stroke: { color: '#ffffff', width: 6 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(0,0,0,.5)', blur: 6, x: 0, y: 4 }, extrude: NO_EXTRUDE, skew: 0, accent: '#ff2d2d', ...look() } },
    // ---- 4.30（main）拆解參考影片的字幕（歸在社群）：發光都用「不偏移的同色陰影」做（陰影只加在最底層，所以不會吃掉字的邊緣）
    limeKey: { name: '螢光綠重點', sample: '快速', group: 'social',
      patch: { color: '#d4f58c', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(0,0,0,.45)', blur: 10, x: 0, y: 3 }, extrude: NO_EXTRUDE, skew: 0, accent: '#ffffff', ...look() } },
    neonBlue: { name: '霓虹藍光', sample: '日系電影', group: 'social',
      patch: { color: '#9fdcff', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(60,170,255,.95)', blur: 26, x: 0, y: 0 }, extrude: NO_EXTRUDE, skew: 0, accent: '#ffffff', ...look() } },
    warmGlow: { name: '暖橘發光', sample: '黑柔效果', group: 'social',
      patch: { color: '#ffe14a', gradient: grad('two', '#ff8a1c'), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(255,120,0,.9)', blur: 30, x: 0, y: 0 }, extrude: NO_EXTRUDE, skew: 0, accent: '#ffffff', ...look() } },
    dreamWhite: { name: '柔光白', sample: '夢境電影感', group: 'social',
      patch: { color: '#ffffff', gradient: grad(), stroke: { color: '#000000', width: 0 }, outlines: outlinesOf(),
        shadow: { color: 'rgba(255,255,255,.9)', blur: 24, x: 0, y: 0 }, extrude: NO_EXTRUDE, skew: 0, accent: '#d4f58c', ...look() } },
  };
  // defaults：切換樣式時套用 align／x／y／bg（size 只用在新增字幕）
  const TITLE_PRESETS = {
    static: { name: '靜態字幕', defaults: { size: 80, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    lowerThird: { name: '下三分之一條', defaults: { size: 56, align: 'left', x: 0.06, y: 0.85, bg: { color: 'rgba(0,0,0,0.65)', padding: 22, radius: 0 } } },
    scroll: { name: '由下往上捲動', defaults: { size: 56, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    crawl: { name: '橫向跑馬燈', defaults: { size: 56, align: 'left', x: 0.5, y: 0.9, bg: { color: 'rgba(0,0,0,0.55)', padding: 14, radius: 0 } } },
    typewriter: { name: '打字機（逐字）', defaults: { size: 80, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    fadeUp: { name: '淡入上移', defaults: { size: 80, align: 'center', x: 0.5, y: 0.5, bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 } } },
    // 4.30：參考影片教學段落的旁白字幕——畫面下方、小字、貼身的黑底
    caption: { name: '黑底小字幕', defaults: { size: 36, align: 'center', x: 0.5, y: 0.8, bg: { color: 'rgba(0,0,0,0.85)', padding: 10, radius: 2 } } },
    // 4.30：貼圖感字幕——對話氣泡（黃底、左下尖角）與留言卡（米白底、橘框）；順便帶文字顏色，並關掉陰影
    bubble: { name: '對話氣泡', defaults: { size: 56, align: 'center', x: 0.5, y: 0.3, color: '#222222', shadow: NO_SHADOW,
      bg: { color: '#FFE14D', padding: 28, radius: 28, tail: 'bl' } } },
    comment: { name: '留言卡', defaults: { size: 44, align: 'center', x: 0.5, y: 0.82, color: '#8B2E2E', shadow: NO_SHADOW,
      bg: { color: '#FFF6E6', padding: 22, radius: 12, border: { color: '#F5A623', width: 3 } } } },
  };
  // 每個過場的背景都帶齊 tail／border：切換過場時深層合併才會把上一個過場留下的尖角、框線清掉
  for (const p of Object.values(TITLE_PRESETS)) p.defaults.bg = { tail: 'none', ...p.defaults.bg, border: { color: '#000000', width: 0, ...(p.defaults.bg.border || {}) } };
  function makeTitle(preset, text) {
    const t = deepClone(BASE_TITLE);
    const p = TITLE_PRESETS[preset] || TITLE_PRESETS.static;
    t.preset = TITLE_PRESETS[preset] ? preset : 'static';
    Object.assign(t, deepClone(p.defaults));
    if (text != null) t.text = text;
    return t;
  }

  const easeOutCubic = u => 1 - Math.pow(1 - clamp(u, 0, 1), 3);

  function roundRectPath(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  function setShadow(ctx, sh, k) {
    if (sh) {
      ctx.shadowColor = sh.color; ctx.shadowBlur = num(sh.blur, 0) * k;
      ctx.shadowOffsetX = num(sh.x, 0) * k; ctx.shadowOffsetY = num(sh.y, 0) * k;
    } else { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
  }
  // 漸層種類：two＝由上（文字顏色）到下（gradient.color）；有 stops 的是多色（左到右）
  const GRADIENTS = {
    two: { name: '雙色（上到下）' },
    rainbow: { name: '彩虹（左到右）', stops: ['#ff4d4d', '#ffa63d', '#ffe14d', '#4ade80', '#38bdf8', '#a78bfa'] },
    sunset: { name: '日落（左到右）', stops: ['#ff5f6d', '#ffc371', '#ffe9a8'] },
  };
  // 一段文字的外觀：外圈（描邊＋外框，最外圈在前）、立體、陰影、填色（可漸層）、斜體
  function glyphStyle(t, k, px) {
    const ring = [];
    let r = Math.max(0, num(t.stroke && t.stroke.width, 0)) * k;
    if (r > 0) ring.push({ color: t.stroke.color, r });
    for (const o of t.outlines || []) {
      const w = Math.max(0, num(o && o.width, 0)) * k;
      if (o && o.on && w > 0) { r += w; ring.push({ color: o.color, r }); }
    }
    ring.reverse();
    const depth = Math.max(0, num(t.extrude && t.extrude.depth, 0)) * k;
    let ext = null;
    if (depth > 0) {
      const n = Math.ceil(depth / Math.max(1, depth / 16)), ang = num(t.extrude.angle, 45) * Math.PI / 180;   // 最多 16 層
      ext = { n, dx: Math.cos(ang) * depth / n, dy: Math.sin(ang) * depth / n, color: t.extrude.color };
    }
    const sh = t.shadow && (num(t.shadow.blur, 0) > 0 || num(t.shadow.x, 0) || num(t.shadow.y, 0)) ? t.shadow : null;
    const gk = t.gradient && t.gradient.kind;
    const glow = t.glow && num(t.glow.blur, 0) > 0 ? { color: t.glow.color, blur: num(t.glow.blur, 0) * k } : null;
    return { ring, outer: r, ext, sh, k, px, lh: px * num(t.lineHeight, 1.25), color: t.color,
      grad: t.gradient && t.gradient.on ? { kind: GRADIENTS[gk] ? gk : 'two', color: t.gradient.color } : null, glow,
      tag: t.shape && t.shape.kind === 'tag' ? { label: '#ffffff' } : null, line: 0, nl: 1,   // line／nl：paintBlock 畫每一行前填入（標籤條的小標要知道是第幾行）
      accent: t.accent || '#ff2d2d', shear: -Math.tan(clamp(num(t.skew, 0), -45, 45) * Math.PI / 180) };
  }
  // 在 (x,y) 畫一段文字（textBaseline middle，textAlign 由呼叫端設）：立體 → 外圈（最外先）→ 填色；陰影只加在最底下那一層
  // fill：指定填色（卡拉OK 等逐字變色用），沒給就照強調／漸層／文字顏色
  function paintGlyphs(ctx, s, g, accent, x, y, fill) {
    // 標籤條：第一行（不只一行時）是縮小的白字小標，畫在紅色小標底上，靠這一行的底部
    if (g.tag && g.nl > 1 && g.line === 0) {
      ctx.save();
      ctx.translate(x, y + g.lh * 0.17); ctx.scale(TAG_LABEL, TAG_LABEL);
      paintGlyphs(ctx, s, { ...g, tag: null, ring: [], ext: null, sh: null, glow: null, grad: null, color: g.tag.label }, false, 0, 0, g.tag.label);
      ctx.restore();
      return;
    }
    // 發光：先在最底下用光暈色疊兩次（陰影模糊疊起來才夠亮），再畫正常的文字蓋上去
    if (g.glow) {
      ctx.shadowColor = g.glow.color; ctx.shadowBlur = g.glow.blur; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = ctx.strokeStyle = g.glow.color; ctx.lineWidth = g.outer * 2;
      for (let i = 0; i < 2; i++) { if (g.outer > 0) ctx.strokeText(s, x, y); ctx.fillText(s, x, y); }
    }
    let first = true;
    const shadow = () => { setShadow(ctx, first ? g.sh : null, g.k); first = false; };
    if (g.ext) {
      ctx.fillStyle = ctx.strokeStyle = g.ext.color; ctx.lineWidth = g.outer * 2;
      for (let i = g.ext.n; i >= 1; i--) {
        shadow();
        if (g.outer > 0) ctx.strokeText(s, x + g.ext.dx * i, y + g.ext.dy * i);
        ctx.fillText(s, x + g.ext.dx * i, y + g.ext.dy * i);
      }
    }
    for (const ly of g.ring) { shadow(); ctx.lineWidth = ly.r * 2; ctx.strokeStyle = ly.color; ctx.strokeText(s, x, y); }
    shadow();
    if (fill) ctx.fillStyle = fill;
    else if (accent) ctx.fillStyle = g.accent;
    else if (g.grad) {
      const gd = GRADIENTS[g.grad.kind];
      let gr;
      if (gd && gd.stops) {   // 多色：從左到右鋪滿這一段文字的寬度
        const w = ctx.measureText(s).width, a = ctx.textAlign;
        const x0 = a === 'left' || a === 'start' ? x : a === 'right' || a === 'end' ? x - w : x - w / 2;
        gr = ctx.createLinearGradient(x0, 0, x0 + Math.max(1, w), 0);
        gd.stops.forEach((c, i) => gr.addColorStop(i / (gd.stops.length - 1), c));
      } else {
        gr = ctx.createLinearGradient(0, y - g.px * 0.45, 0, y + g.px * 0.45);
        gr.addColorStop(0, g.color); gr.addColorStop(1, g.grad.color);
      }
      ctx.fillStyle = gr;
    } else ctx.fillStyle = g.color;
    ctx.fillText(s, x, y);
    setShadow(ctx, null, g.k);
  }
  // 每行每個字是否強調：排版會吃掉換行處的空白，所以照順序在去掉星號的原文裡找同一個字
  function lineMasks(lines, plain, mask) {
    if (!mask) return null;
    const src = Array.from(plain);
    let p = 0;
    return lines.map(line => Array.from(line).map(ch => {
      const q = src.indexOf(ch, p);
      if (q < 0) return false;
      p = q + 1;
      return !!mask[q];
    }));
  }

  // ---- 字幕底（樣式負責）---------------------------------------------------------------
  // 文字區塊後面的底：t.shape.kind 是 none 就畫 bg 的圓角矩形；選了形狀（SHAPES）就改畫形狀（取代 bg）。
  // box：{ left, top, w }，bh：文字區塊高，L：排版結果（每行寬 L.widths），已經套用整塊的進出場變形
  // 形狀 { name, fields（inspector 顯示哪些欄位）, ext(t, L, lh, k, bh)：往外多出文字區塊的 [左, 上, 右, 下]（輸出像素）, paint(...)：畫 }
  // 尺寸都用行高 lh 的倍數，字級改了形狀跟著變；框線粗細 borderW 是「短邊 1080 時的像素」，乘 k
  const TAG_LABEL = 0.6;   // 標籤條的小標字級比例
  const lineX = (t, L, box, i) => (t.align === 'left' ? box.left : t.align === 'right' ? box.left + box.w - L.widths[i] : box.left + (box.w - L.widths[i]) / 2);
  // 爆炸：以橢圓（剛好框住文字）為底的鋸齒星，單數頂點凹進橢圓上、雙數頂點往外尖出（高低固定的亂數，每一幀都一樣）
  const BURST_N = 14, BURST_BASE = 1.12, BURST_MAX = 1.38;
  function burstR(L, lh, bh) {
    const ex = L.w / 2 + lh * 0.32, ey = bh / 2 + lh * 0.24;
    return { rx: ex * Math.SQRT2 * BURST_BASE, ry: ey * Math.SQRT2 * BURST_BASE };
  }
  function burstPath(ctx, cx, cy, r, sc) {
    ctx.beginPath();
    for (let i = 0; i < BURST_N * 2; i++) {
      const a = i * Math.PI / BURST_N - Math.PI / 2, f = i % 2 ? 1 : 1.22 + 0.16 * (0.5 + 0.5 * Math.sin(i * 2.1 + 1));
      const x = cx + Math.cos(a) * r.rx * f * sc, y = cy + Math.sin(a) * r.ry * f * sc;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  // 對話框的尾巴：落在底邊的位置（0~1）與尖端歪向
  const TAILS = { left: [0.25, -1], center: [0.5, 0], right: [0.75, 1] };
  function bubbleGeo(t, lh, k) {
    const bw = Math.max(0, num(t.shape.borderW, 6)) * k, tl = TAILS[t.shape.tail] || null;
    return { px: lh * 0.38, py: lh * 0.22, bw, tl, th: tl ? lh * 0.5 : 0, tw: lh * 0.5, r: lh * 0.45 };
  }
  const SHAPES = {
    none: { name: '無（用背景色）' },
    burst: { name: '爆炸', fields: ['color', 'color2'],
      ext(t, L, lh, k, bh) { const r = burstR(L, lh, bh), m = BURST_MAX, a = r.rx * m - L.w / 2, b = r.ry * m - bh / 2; return [a, b, a, b]; },
      paint(ctx, t, L, k, lh, box, bh) {
        const r = burstR(L, lh, bh), cx = box.left + box.w / 2, cy = box.top + bh / 2;
        ctx.lineJoin = 'miter';
        burstPath(ctx, cx, cy, r, 1); ctx.fillStyle = t.shape.color; ctx.fill();
        burstPath(ctx, cx, cy, r, 0.86); ctx.fillStyle = t.shape.color2; ctx.fill();
      } },
    bubble: { name: '對話框', fields: ['color', 'border', 'borderW', 'tail'],
      ext(t, L, lh, k) { const g = bubbleGeo(t, lh, k); return [g.px + g.bw, g.py + g.bw, g.px + g.bw, g.py + g.bw + g.th]; },
      paint(ctx, t, L, k, lh, box, bh) {
        const g = bubbleGeo(t, lh, k), x = box.left - g.px, y = box.top - g.py, w = box.w + g.px * 2, h = bh + g.py * 2, bw = g.bw;
        ctx.lineJoin = 'round'; ctx.lineWidth = bw; ctx.strokeStyle = t.shape.border; ctx.fillStyle = t.shape.color;
        roundRectPath(ctx, x, y, w, h, g.r);
        ctx.fill(); if (bw > 0) ctx.stroke();
        if (!g.tl) return;
        // 尾巴：底邊那一段框線用底色蓋掉，再畫兩條斜邊，接起來才不會有一條線切在中間
        const half = g.tw / 2, lo = x + g.r + half, hi = x + w - g.r - half;
        const tx = lo <= hi ? clamp(x + w * g.tl[0], lo, hi) : x + w / 2, yb = y + h, tipx = tx + g.tl[1] * g.tw * 0.5;
        ctx.beginPath(); ctx.moveTo(tx - half, yb - bw); ctx.lineTo(tx + half, yb - bw); ctx.lineTo(tx + half, yb); ctx.lineTo(tipx, yb + g.th); ctx.lineTo(tx - half, yb); ctx.closePath();
        ctx.fill();
        if (bw > 0) { ctx.beginPath(); ctx.moveTo(tx - half, yb); ctx.lineTo(tipx, yb + g.th); ctx.lineTo(tx + half, yb); ctx.stroke(); }
      } },
    tag: { name: '標籤條', fields: ['color', 'color2'],
      ext(t, L, lh) { return [lh * 0.22, 0, lh * 0.22, 0]; },
      paint(ctx, t, L, k, lh, box) {
        const px = lh * 0.22, n = L.lines.length;
        for (let i = 0; i < n; i++) {
          const x = lineX(t, L, box, i), y = box.top + i * lh;
          if (i === 0 && n > 1) {   // 小標：縮小的字，紅底靠這一行底部
            ctx.fillStyle = t.shape.color2;
            ctx.fillRect(x - px, y + lh * 0.34, (L.widths[0] + px * 2.4) * TAG_LABEL, lh * 0.66);
          } else { ctx.fillStyle = t.shape.color; ctx.fillRect(x - px, y, L.widths[i] + px * 2, lh); }
        }
      } },
    lineBox: { name: '每行圓角底', fields: ['color'],
      ext(t, L, lh) { return [lh * 0.22, lh * 0.03, lh * 0.22, lh * 0.03]; },
      paint(ctx, t, L, k, lh, box) {
        const px = lh * 0.22;
        ctx.fillStyle = t.shape.color;
        L.lines.forEach((line, i) => {
          roundRectPath(ctx, lineX(t, L, box, i) - px, box.top + i * lh + lh * 0.03, L.widths[i] + px * 2, lh * 0.94, lh * 0.2);
          ctx.fill();
        });
      } },
    sticker: { name: '貼紙', fields: ['color', 'border', 'borderW'],
      ext(t, L, lh, k) { const bw = Math.max(0, num(t.shape.borderW, 6)) * k; return [lh * 0.38 + bw, lh * 0.2 + bw, lh * 0.38 + bw, lh * 0.2 + bw]; },
      paint(ctx, t, L, k, lh, box, bh) {
        const bw = Math.max(0, num(t.shape.borderW, 6)) * k, px = lh * 0.38, py = lh * 0.2;
        const x = box.left - px, y = box.top - py, w = box.w + px * 2, h = bh + py * 2;
        setShadow(ctx, { color: 'rgba(0,0,0,.45)', blur: 18, x: 0, y: 8 }, k);
        ctx.fillStyle = t.shape.border;
        roundRectPath(ctx, x - bw, y - bw, w + bw * 2, h + bw * 2, lh * 0.3 + bw);
        ctx.fill();
        setShadow(ctx, null, k);
        ctx.fillStyle = t.shape.color;
        roundRectPath(ctx, x, y, w, h, lh * 0.3);
        ctx.fill();
      } },
  };
  // 形狀往外多出文字區塊的範圍 [左, 上, 右, 下]（選了形狀才有；沒有就 null）
  function shapeExt(t, L, lh, k, bh) {
    const d = t.shape && SHAPES[t.shape.kind];
    return d && d.ext ? d.ext(t, L, lh, k, bh) : null;
  }
  // px：字級（輸出像素），背景框的尖角長度要用
  function paintBackdrop(ctx, t, L, k, lh, box, bh, px) {
    const sd = t.shape && SHAPES[t.shape.kind];
    if (sd && sd.paint) { ctx.save(); sd.paint(ctx, t, L, k, lh, box, bh); ctx.restore(); return; }
    if (!(t.bg && t.bg.color)) return;
    const pad = num(t.bg.padding, 0) * k;
    ctx.fillStyle = t.bg.color;
    roundRectPath(ctx, box.left - pad, box.top - pad, box.w + pad * 2, bh + pad * 2, num(t.bg.radius, 0) * k);
    ctx.fill();
    bgDecor(ctx, t.bg, box.left - pad, box.top - pad, box.w + pad * 2, bh + pad * 2, k, px);   // 框線、對話氣泡的尖角
  }

  // 集中線：整個畫面、以 (fx, fy) 為焦點的放射細線，中心淡出；亂數用固定的雜湊，每 3 格換一組（漫畫的抖動感），預覽和匯出一樣
  const lineHash = n => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); };
  function paintSpeedLines(ctx, sl, fx, fy, outW, outH, f) {
    const R = Math.hypot(Math.max(fx, outW - fx), Math.max(fy, outH - fy)) * 1.05, N = 44, seed = Math.floor(f / 3) * 101;
    const p = parseColor(sl.color);
    const gr = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
    gr.addColorStop(0, formatColor(p.hex, 0)); gr.addColorStop(0.4, formatColor(p.hex, 0)); gr.addColorStop(0.7, formatColor(p.hex, p.a)); gr.addColorStop(1, formatColor(p.hex, p.a));
    ctx.fillStyle = gr;
    const step = Math.PI * 2 / N;
    for (let i = 0; i < N; i++) {
      const a = i * step + (lineHash(i + seed) - 0.5) * step * 0.6, w = step * (0.1 + 0.28 * lineHash(i * 7 + seed + 3));
      ctx.beginPath(); ctx.moveTo(fx, fy);
      ctx.lineTo(fx + Math.cos(a - w) * R, fy + Math.sin(a - w) * R); ctx.lineTo(fx + Math.cos(a + w) * R, fy + Math.sin(a + w) * R);
      ctx.closePath(); ctx.fill();
    }
  }

  // ---- 字幕動畫（效果引擎負責）-----------------------------------------------------------
  // 一次算好這段字幕這一格要用的動畫參數；paintBlock 在整塊／每行／每個字三個地方問 fxAt 要怎麼變形
  function fxPlan(t, L, o, lh) {
    const def = o && t.textFx && t.textFx !== 'none' ? TEXT_FX[t.textFx] : null;
    const loop = o && t.textLoop && t.textLoop !== 'none' ? TEXT_LOOP[t.textLoop] || null : null;
    // 出場（TEXT_OUT）不在這裡：drawTitle 把整個字幕（含背景、形狀）一起做出場變形，見 textOutState
    const D = def ? (def.hard ? 1 : Math.max(1, num(t.textFxDur, 0.5) * o.fps)) : 1;
    const total = L.lines.reduce((n, s) => n + Array.from(s).length, 0), nl = L.lines.length;
    // 逐字：每個字晚 0.06 秒開始，但最後一個字最晚在片段 60% 的地方開始
    const stagger = def && def.char && total > 1 ? Math.max(0, Math.min(0.06 * o.fps, (o.dur * 0.6 - D) / (total - 1))) : 0;
    // 逐行：每行晚 0.15 秒，最後一行最晚在片段 60% 的地方開始
    const lstag = def && def.line && nl > 1 ? Math.max(0, Math.min(0.15 * o.fps, (o.dur * 0.6 - D) / (nl - 1))) : 0;
    return {
      def, loop, D, total, nl, stagger, lstag, o, lh, t, L, units: {},
      chars: !!((def && def.char) || (loop && loop.scope === 'char')),   // 要不要走逐字畫法
      cursor: !!(def && def.cursor), hl: !!(loop && loop.hl),
    };
  }
  // 疊加：透明度、縮放相乘；位移、旋轉相加；color／hl 後面的蓋過前面的（順序＝進場、持續）。只有一層時原樣回傳
  function mergeFx(parts) {
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    const r = {};
    for (const p of parts) {
      if (p.a != null) r.a = (r.a == null ? 1 : r.a) * p.a;
      if (p.s != null) r.s = (r.s == null ? 1 : r.s) * p.s;
      for (const k of ['dx', 'dy', 'rot']) if (p[k]) r[k] = (r[k] || 0) + p[k];
      for (const k of ['color', 'hl', 'blur', 'trail']) if (p[k]) r[k] = p[k];
    }
    return r;
  }
  // scope：'block'（整塊，含底）／'line'（第 idx 行）／'char'（全文第 idx 個字）。每個特效只在自己的層級（char／line／block）出現。
  // 回傳 null＝這一層不動；否則 { a 透明度, s 縮放, dx, dy 位移（px）, rot 旋轉（弧度）, color 填色, hl 逐字高亮的底色,
  //   blur／trail（blurIn／smear 的進度，paintBlock 另外處理）}（沒有的欄位＝不變）
  function fxAt(P, t, scope, idx) {
    const parts = [], def = P.def;
    if (def) {
      if (scope === 'block' && !def.char && !def.line) parts.push(textFxState(t.textFx, P.o.f / P.D, P.lh, P.o));
      else if (scope === 'line' && def.line) parts.push(textFxState(t.textFx, (P.o.f - idx * P.lstag) / P.D, P.lh, P.o));
      else if (scope === 'char' && def.char) parts.push(textFxState(t.textFx, (P.o.f - idx * P.stagger) / P.D, P.lh, P.o));
    }
    if (P.loop && P.loop.scope === scope) { const r = P.loop.at(P, idx); if (r) parts.push(r); }
    return mergeFx(parts);
  }
  // 把 fxAt 的結果套到 ctx：以 (cx, cy) 為中心縮放／旋轉
  function applyFx(ctx, s, cx, cy) {
    ctx.globalAlpha *= s.a == null ? 1 : s.a;
    ctx.translate(cx + (s.dx || 0), cy + (s.dy || 0));
    if (s.rot) ctx.rotate(s.rot);
    const sc = s.s == null ? 1 : s.s;
    ctx.scale(sc, sc);
    ctx.translate(-cx, -cy);
  }
  const fxHidden = s => !!s && ((s.a != null && s.a <= 0) || (s.s != null && s.s <= 0));

  // 模糊浮現：不用 ctx.filter（見濾鏡的說明），把字以 r 倍（<1）的解析度畫到離屏，再放大貼回來——放大的雙線性內插就是模糊。
  //   r 從 0.06（很糊）到 1（清楚）。離屏和目標畫布同大、只用左上角 r 倍的區域，所以不必每格重配畫布。
  //   沒有 getTransform（舊瀏覽器、node 測試的假 ctx）就回傳 false，呼叫端照一般淡入畫。
  function blurPaint(ctx, s, cx, cy, o, paint, key) {
    const cv = ctx.canvas;
    if (!cv || !ctx.getTransform || !(cv.width > 0)) return false;
    const r = 0.06 + 0.94 * Math.pow(1 - s.blur, 2);
    const W = cv.width, H = cv.height, sc = scratch(key || 'tblur', W, H), c = sc.ctx;
    const m = ctx.getTransform();
    c.setTransform(m.a * r, m.b * r, m.c * r, m.d * r, m.e * r, m.f * r);
    c.translate(cx, cy); c.scale(s.s, s.s); c.translate(-cx, -cy);
    c.font = ctx.font;
    paint(c);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= s.a;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sc.canvas, 0, 0, Math.max(1, W * r), Math.max(1, H * r), 0, 0, W, H);
    ctx.restore();
    return true;
  }

  // 背景框的框線與尖角（對話氣泡）。矩形已經填好色；這裡補尖角（同色）、描框線。
  //   尖角從框的上／下緣伸出，長 0.6×內距＋字高/3，底邊靠近圓角內側；框線在尖角底邊那一段會被尖角蓋掉，所以尖角的兩條斜邊另外描。
  function bgDecor(ctx, bg, x, y, w, h, k, px) {
    const bw = Math.max(0, num(bg.border && bg.border.width, 0)) * k;
    const tail = bg.tail && bg.tail !== 'none' && /^[tb][lr]$/.test(bg.tail) ? bg.tail : null;
    if (bw > 0) {
      ctx.save(); ctx.strokeStyle = bg.border.color || '#000000'; ctx.lineWidth = bw; ctx.lineJoin = 'round';
      roundRectPath(ctx, x, y, w, h, num(bg.radius, 0) * k);
      ctx.stroke(); ctx.restore();
    }
    if (!tail) return;
    const len = 0.6 * num(bg.padding, 0) * k + px / 3;
    const r = Math.min(num(bg.radius, 0) * k, w / 2, h / 2);
    const dir = tail[0] === 'b' ? 1 : -1, left = tail[1] === 'l';
    const edgeY = dir > 0 ? y + h : y, inY = edgeY - dir * Math.max(bw, 1);       // 底邊往框內縮一點，蓋住框線
    const baseW = Math.min(len * 1.1, Math.max(4, w - 2 * r - 2));
    const b1 = left ? x + r + len * 0.3 : x + w - r - len * 0.3 - baseW, b2 = b1 + baseW;
    const tipX = left ? b1 - len * 0.35 : b2 + len * 0.35, tipY = edgeY + dir * len;
    ctx.save();
    ctx.fillStyle = bg.color;
    ctx.beginPath();
    ctx.moveTo(b1, inY); ctx.lineTo(b1, edgeY); ctx.lineTo(tipX, tipY); ctx.lineTo(b2, edgeY); ctx.lineTo(b2, inY); ctx.closePath();
    ctx.fill();
    if (bw > 0) {
      ctx.strokeStyle = bg.border.color || '#000000'; ctx.lineWidth = bw; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(b1, edgeY); ctx.lineTo(tipX, tipY); ctx.lineTo(b2, edgeY); ctx.stroke();
    }
    ctx.restore();
  }

  // 畫一塊文字。box：{ left, top, w（區塊寬）}；reveal：只畫前 N 個字（打字機），null＝全部；o：drawTitle 的參數（字體特效要用 f／fps）
  function paintBlock(ctx, t, L, k, lh, box, reveal, drawBg, o) {
    const align = t.align === 'left' || t.align === 'right' ? t.align : 'center';
    const P = fxPlan(t, L, o, lh);
    const bh = lh * L.lines.length;
    ctx.save();
    const sb = fxAt(P, t, 'block', 0);
    if (sb) {
      const def = P.def, cx = box.left + box.w / 2, cy = box.top + bh / 2;
      // 殘影／拖影／模糊浮現（整塊的進場）：同一塊字關掉進場再畫一次（副本），疊在主字下面
      const again = (c, a) => paintBlock(c, { ...t, textFx: 'none' }, L, k, lh, box, reveal, a, o);
      if (def && def.echo) {               // 殘影：放大 1.3 倍、往右下偏，透明度從 0.45 慢慢退到 0（比主字慢 2.5 倍消失）
        const g = clamp(o.f / (P.D * 2.5), 0, 1), ga = 0.45 * (1 - g) * clamp(o.f / Math.max(1, P.D * 0.3), 0, 1);
        if (ga > 0.001) {
          ctx.save(); ctx.globalAlpha *= ga;
          ctx.translate(cx + box.w * 0.28, cy + lh * 0.25); ctx.scale(1.3, 1.3); ctx.translate(-cx, -cy);
          again(ctx, false); ctx.restore();
        }
      }
      if (def && def.smear && sb.trail > 0.01 && sb.a > 0) {   // 拖影：主字下方 6 份越來越淡的副本
        for (let i = 6; i >= 1; i--) {
          ctx.save(); ctx.globalAlpha *= sb.a * 0.22 * (1 - i / 7);
          ctx.translate(0, sb.dy + i * sb.trail * lh * 0.22);
          again(ctx, false); ctx.restore();
        }
      }
      if (def && def.blur && sb.blur > 0.02 && blurPaint(ctx, { a: 1, s: 1, ...sb }, cx, cy, o, c2 => again(c2, drawBg))) { ctx.restore(); return; }
      applyFx(ctx, sb, cx, cy);
    }
    if (drawBg) paintBackdrop(ctx, t, L, k, lh, box, bh, o ? o.px : lh / num(t.lineHeight, 1.25));
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const g = glyphStyle(t, k, o ? o.px : lh / num(t.lineHeight, 1.25));
    const masks = lineMasks(L.lines, t.text, t.__mask);
    const perChar = !!masks || P.chars;
    let left = reveal == null ? Infinity : reveal, gi = 0;
    let cur = null, typing = false;   // 打字機游標：最後一個已出現的字的右邊；還有字沒出現＝打字中（游標不閃）
    L.lines.forEach((line, i) => {
      const cs = Array.from(line);
      const count = Math.max(0, Math.min(cs.length, left));
      left -= cs.length;
      const y = box.top + (i + 0.5) * lh;
      g.line = i; g.nl = L.lines.length;
      const x = align === 'left' ? box.left : align === 'right' ? box.left + box.w : box.left + box.w / 2;
      ctx.save();
      const sl = fxAt(P, t, 'line', i);
      if (sl) {
        if (fxHidden(sl)) { ctx.restore(); gi += cs.length; return; }
        applyFx(ctx, sl, box.left + box.w / 2, y);
      }
      if (count && !perChar) {
        ctx.save();
        ctx.textAlign = align;
        if (g.shear) { ctx.translate(x, y); ctx.transform(1, 0, g.shear, 1, 0, 0); paintGlyphs(ctx, cs.slice(0, count).join(''), g, false, 0, 0); }
        else paintGlyphs(ctx, cs.slice(0, count).join(''), g, false, x, y);
        ctx.restore();
      } else if (count) {
        const lw = ctx.measureText(line).width;
        const x0 = align === 'left' ? x : align === 'right' ? x - lw : x - lw / 2;
        ctx.textAlign = 'center';
        const posOf = j => { const pre = j ? ctx.measureText(cs.slice(0, j).join('')).width : 0; return [x0 + pre, ctx.measureText(cs[j]).width]; };
        if (P.hl) {   // 逐字高亮：先把念到的字（連續的一段）的底畫好，字再蓋在上面
          let j0 = -1, hl = null;
          const flush = j1 => {
            const [xa] = posOf(j0), [xb, wb] = posOf(j1), pad = o.px * 0.1;
            ctx.fillStyle = hl;
            roundRectPath(ctx, xa - pad, y - o.px * 0.58, xb + wb - xa + pad * 2, o.px * 1.16, o.px * 0.18);
            ctx.fill();
            j0 = -1;
          };
          for (let j = 0; j < count; j++) {
            const h = fxAt(P, t, 'char', gi + j);
            const on = h && h.hl && !/\s/.test(cs[j]);
            if (j0 >= 0 && (!on || h.hl !== hl)) flush(j - 1);
            if (on && j0 < 0) { j0 = j; hl = h.hl; }
          }
          if (j0 >= 0) flush(count - 1);
        }
        for (let j = 0; j < count; j++) {
          const sc = fxAt(P, t, 'char', gi + j);
          const hid = fxHidden(sc);
          if (P.cursor) {
            const [cx0, cw0] = posOf(j);
            if (gi + j === 0) cur = { x: cx0, y };
            if (hid) typing = true; else cur = { x: cx0 + cw0, y };
          }
          if (/\s/.test(cs[j])) continue;
          const [xj, cw] = posOf(j);
          ctx.save();
          ctx.translate(xj + cw / 2, y);
          if (hid) { ctx.restore(); continue; }
          if (sc) applyFx(ctx, sc, 0, 0);
          if (g.shear) ctx.transform(1, 0, g.shear, 1, 0, 0);
          paintGlyphs(ctx, cs[j], g, !!(masks && masks[i][j]), 0, 0, sc && sc.color);
          ctx.restore();
        }
      }
      ctx.restore();
      gi += cs.length;
    });
    if (cur && (typing || Math.floor(o.f / Math.max(2, Math.round(o.fps * 0.5))) % 2 === 0)) {   // 閃爍游標：約每 0.5 秒亮／暗一次，用 Canvas 直線畫
      ctx.save();
      ctx.strokeStyle = t.color; ctx.lineWidth = Math.max(2, o.px * 0.07); ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(cur.x + o.px * 0.08, cur.y - lh * 0.36); ctx.lineTo(cur.x + o.px * 0.08, cur.y + lh * 0.36); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  const TITLE_DRAW = {
    static(ctx, t, o) {
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.9 - 2 * num(t.bg && t.bg.padding, 0) * o.k);
      const bh = L.lines.length * o.lh;
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top: t.y * o.outH - bh / 2, w: L.w }, null, true, o);
    },
    fadeUp(ctx, t, o) {
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.9 - 2 * num(t.bg && t.bg.padding, 0) * o.k);
      const inF = Math.max(1, Math.min(Math.round(0.5 * o.fps), Math.floor(o.dur / 3)));
      const outF = Math.max(1, Math.min(Math.round(0.3 * o.fps), Math.floor(o.dur / 3)));
      let a = clamp(o.f / inF, 0, 1);
      const rise = (1 - easeOutCubic(a)) * 40 * o.k;
      if (o.f > o.dur - outF) a = Math.min(a, clamp((o.dur - o.f) / outF, 0, 1));
      const bh = L.lines.length * o.lh;
      ctx.globalAlpha *= a;
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top: t.y * o.outH - bh / 2 + rise, w: L.w }, null, true, o);
    },
    typewriter(ctx, t, o) {
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.9 - 2 * num(t.bg && t.bg.padding, 0) * o.k);
      const total = L.lines.reduce((n, s) => n + Array.from(s).length, 0);
      const frames = Math.max(1, Math.min(Math.round(o.dur * 0.7), Math.ceil(total * o.fps / 10)));   // 每秒約 10 字，最多用掉 70% 長度
      const n = Math.floor(total * clamp(o.f / frames, 0, 1));
      const bh = L.lines.length * o.lh;
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top: t.y * o.outH - bh / 2, w: L.w }, n, true, o);
    },
    lowerThird(ctx, t, o) {
      const pad = num(t.bg && t.bg.padding, 0) * o.k;
      const left = t.x * o.outW;
      const L = layoutTitle(ctx, t, o.font, Math.max(40, o.outW - left - o.outW * 0.06 - pad));
      const bh = L.lines.length * o.lh;
      const top = t.y * o.outH - bh / 2;
      const inF = Math.max(1, Math.min(Math.round(0.4 * o.fps), Math.floor(o.dur / 3)));
      const outF = Math.max(1, Math.min(Math.round(0.3 * o.fps), Math.floor(o.dur / 3)));
      const p = Math.min(easeOutCubic(o.f / inF), o.f > o.dur - outF ? clamp((o.dur - o.f) / outF, 0, 1) : 1);
      ctx.translate(-(1 - p) * o.outW * 0.5, 0);
      ctx.globalAlpha *= p;
      const hasBar = t.bg && t.bg.color && parseColor(t.bg.color).a > 0;
      if (hasBar) {
        ctx.fillStyle = t.bg.color;
        ctx.fillRect(0, top - pad, o.outW, bh + pad * 2);
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(0, top - pad, 8 * o.k, bh + pad * 2);
      }
      paintBlock(ctx, { ...t, align: 'left' }, L, o.k, o.lh, { left, top, w: L.w }, null, false, o);
    },
    scroll(ctx, t, o) {
      const pad = num(t.bg && t.bg.padding, 0) * o.k;
      const L = layoutTitle(ctx, t, o.font, o.outW * 0.8 - 2 * pad);
      const bh = L.lines.length * o.lh;
      const p = clamp(o.f / Math.max(1, o.dur), 0, 1);
      const top = o.outH + pad - p * (o.outH + bh + pad * 2);
      paintBlock(ctx, t, L, o.k, o.lh, { left: t.x * o.outW - L.w / 2, top, w: L.w }, null, true, o);
    },
    crawl(ctx, t, o) {
      const one = { ...t, text: String(t.text == null ? '' : t.text).replace(/\s*\n\s*/g, '　') };
      ctx.font = o.font;
      const w = ctx.measureText(one.text).width;
      const pad = num(t.bg && t.bg.padding, 0) * o.k;
      const p = clamp(o.f / Math.max(1, o.dur), 0, 1);
      const left = o.outW - p * (o.outW + w);
      const top = t.y * o.outH - o.lh / 2;
      if (t.bg && t.bg.color) { ctx.fillStyle = t.bg.color; ctx.fillRect(0, top - pad, o.outW, o.lh + pad * 2); }
      paintBlock(ctx, { ...one, align: 'left' }, { lines: [one.text], widths: [w], w }, o.k, o.lh, { left, top, w }, null, false, o);
    },
  };

  // 字幕排版位置（輸出像素、還沒套用片段變形）：[x, y, w, h]。只算 x／y 決定的那一塊（含底色內距），
  // 不含進出場動畫的位移；捲動＝整欄、跑馬燈＝整列。
  function titleLocalBox(clip, outW, outH) {
    const tt = normTitle(clip.title);
    const k = Math.min(outW, outH) / 1080;
    const px = Math.max(1, num(tt.size, 80) * k), lh = px * num(tt.lineHeight, 1.25);
    const pad = num(tt.bg && tt.bg.padding, 0) * k;
    const ctx = scratch('measure', 1, 1).ctx, font = fontString(tt, px);
    if (tt.preset === 'lowerThird') {
      const left = tt.x * outW, L = layoutTitle(ctx, tt, font, Math.max(40, outW - left - outW * 0.06 - pad));
      const bh = L.lines.length * lh;
      return [left - pad, tt.y * outH - bh / 2 - pad, L.w + pad * 2, bh + pad * 2];
    }
    if (tt.preset === 'crawl') return [0, tt.y * outH - lh / 2 - pad, outW, lh + pad * 2];
    const L = layoutTitle(ctx, tt, font, (tt.preset === 'scroll' ? outW * 0.8 : outW * 0.9) - 2 * pad);
    const bh = L.lines.length * lh;
    const se = tt.preset === 'scroll' ? null : shapeExt(tt, L, lh, k, bh);   // 選了形狀就用形狀的範圍（泡泡尾巴、爆炸、貼紙…）取代內距
    if (se) return [tt.x * outW - L.w / 2 - se[0], tt.y * outH - bh / 2 - se[1], L.w + se[0] + se[2], bh + se[1] + se[3]];
    return tt.preset === 'scroll' ? [tt.x * outW - L.w / 2 - pad, 0, L.w + pad * 2, outH]
      : [tt.x * outW - L.w / 2 - pad, tt.y * outH - bh / 2 - pad, L.w + pad * 2, bh + pad * 2];
  }
  // 片段在輸出畫面上的四個角（輸出像素，左上、右上、右下、左下，已套用裁切與變形）與變形的軸心 pivot。
  // 給預覽上直接拖曳／縮放／旋轉用。媒體要 project.mediaInfo 有寬高；音訊或不知道尺寸時回 null。
  function clipQuad(clip, project, fInClip) {
    if (!clip || !clip.video || !project) return null;
    const W = project.width, H = project.height, f = fInClip || 0;
    let srcW = W, srcH = H, box;
    if (clip.type === 'title') {
      if (!clip.title) return null;
      box = titleLocalBox(clip, W, H);
    } else {
      if (clip.type !== 'solid') {
        const m = project.mediaInfo && project.mediaInfo[clip.mediaId];
        if (!m || !(m.width > 0 && m.height > 0)) return null;
        srcW = m.width; srcH = m.height;
      }
      const r = cropRect(clip, srcW, srcH, f);
      box = [r.sx, r.sy, r.sw, r.sh];
    }
    const m = clipMatrix(clip, srcW, srcH, W, H, f);
    const pts = [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0] + box[2], box[1] + box[3]], [box[0], box[1] + box[3]]].map(([x, y]) => applyMatrix(m, x, y));
    // 軸心：物件中心（套用變形後）＋錨點（錨點不受縮放／旋轉影響）
    const g = n => num(getParam(clip, 'video.transform.' + n, f), 0);
    const cc = contentCenter(clip, srcW, srcH, W, H, f), fit = fitRect(srcW, srcH, W, H, getParam(clip, 'video.fit', f));
    return { pts, m, pivot: [g('anchorX') + fit.sx * (cc[0] - srcW / 2) + W / 2 + g('posX'), g('anchorY') + fit.sy * (cc[1] - srcH / 2) + H / 2 + g('posY')] };
  }
  // 字幕在輸出畫面上佔的範圍（套用變形後的外接矩形），給預覽點選用。沒有字幕回 null。
  function titleBounds(clip, outW, outH, fInClip) {
    if (!clip || !clip.title) return null;
    const box = titleLocalBox(clip, outW, outH);
    const m = clipMatrix(clip, outW, outH, outW, outH, fInClip || 0);
    const pts = [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0], box[1] + box[3]], [box[0] + box[2], box[1] + box[3]]].map(([x, y]) => applyMatrix(m, x, y));
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  // 字級 size 是「短邊 1080 時的像素」，輸出尺寸不同時等比放大縮小，看起來一致
  function drawTitle(ctx, clip, outW, outH, fInClip, fps) {
    const t = clip && clip.title;
    if (!t) return;
    const f = fInClip || 0;
    const op = clamp(num(getParam(clip, 'video.transform.opacity', f), 1), 0, 1);
    if (op <= 0) return;
    const k = Math.min(outW, outH) / 1080;
    const px = Math.max(1, num(t.size, 80) * k);
    const o = {
      f, fps: fps || 30, dur: Math.max(1, clip.duration || 1), k, outW, outH, px, lh: px * num(t.lineHeight, 1.25),
      font: fontString(t, px),
    };
    ctx.save();
    const tn = normTitle(t);
    if (tn.shape.kind === 'tag') tn.align = 'left';   // 標籤條一律靠左（不留在字幕設定裡，換掉樣式就恢復）
    // 出場動畫：u＝在最後 textOutDur 秒裡走到哪（0～1，最後一格差一格才到 1）；貼圖動態的軸心和出場動畫的中心都用字幕那一塊的中心
    const outDef = TEXT_OUT[tn.textOut];
    const outF = outDef && tn.textOut !== 'none' ? Math.max(1, Math.min(o.dur, Math.round(num(tn.textOutDur, 0.3) * o.fps))) : 0;
    const ou = outF ? clamp((f - (o.dur - outF)) / outF, 0, 1) : 0;
    const sticker = clip.video && clip.video.sticker;
    let cb = null;
    if (ou > 0 || (sticker && sticker !== 'none')) cb = titleLocalBox(clip, outW, outH);
    const cx = cb ? cb[0] + cb[2] / 2 : 0, cy = cb ? cb[1] + cb[3] / 2 : 0;
    const m = clipMatrix(clip, outW, outH, outW, outH, f, o.fps, cb ? [cx, cy] : null);
    if (tn.speedLines.on) {   // 整個畫面的集中線（不跟著字幕變形，只以字幕中心為焦點），畫在字幕後面
      const [fx, fy] = applyMatrix(m, tn.x * outW, tn.y * outH);
      ctx.save(); ctx.globalAlpha *= op; paintSpeedLines(ctx, tn.speedLines, fx, fy, outW, outH, f); ctx.restore();
    }
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha *= op;
    ctx.font = o.font;
    setSpacing(ctx, tn, px);
    const draw = c => { if (c !== ctx) setSpacing(c, tn, px); (TITLE_DRAW[tn.preset] || TITLE_DRAW.static)(c, tn, o); };
    const so = ou > 0 ? textOutState(tn.textOut, ou, o) : null;
    if (!so) draw(ctx);
    else if (outDef.blur && so.blur > 0.02 && blurPaint(ctx, so, cx, cy, o, draw, 'tblur2')) { /* 已畫 */ }
    else {
      ctx.globalAlpha *= clamp(so.a, 0, 1);       // 沒有 getTransform 的 ctx 退回淡出
      ctx.translate(cx + so.dx, cy + so.dy); ctx.scale(so.s, so.s); ctx.translate(-cx, -cy);
      if (so.s > 0) draw(ctx);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------
  // 轉場
  //   draw(ctx, drawA, drawB, t, opts, outW, outH)
  //   drawA／drawB：(ctx) => void。t<=0 只畫 A、t>=1 只畫 B（一定與 A／B 逐像素相同）。
  //   opts：Transition 物件（type/color/direction/ease）。單邊轉場（另一邊是背景）：
  //     opts.single===true 或 opts.rightClipId===null → 沒有 B（尾端淡出）；opts.single==='in' 或 opts.leftClipId===null → 沒有 A（開頭淡入）。
  //     沒有的那一邊由呼叫端畫成空白（透明，露出下層軌道或背景色），所以交叉疊化＝淡入／淡出到背景、
  //     擦拭／推擠／滑入／縮放／模糊＝和背景做同樣的效果；浸入顏色／淡出到黑是「從顏色淡入」／「淡出到顏色」。
  //   direction＝運動方向：'left' 表示畫面往左動（B 從右邊進來）。
  //   用到離屏畫布的轉場（疊化／推擠／滑入／縮放／模糊）假設 drawA／drawB 可以畫到任何同大的 ctx。
  // ---------------------------------------------------------------------------------
  function ease(t, kind) {
    t = clamp(t, 0, 1);
    if (kind === 'easeInOut') return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    return t;
  }
  const isSingleIn = o => !!o && (o.single === 'in' || (o.leftClipId === null && !!o.rightClipId));
  const isSingle = o => !!o && (o.single === true || o.rightClipId === null || isSingleIn(o));
  const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  const dirOf = o => DIRS[o && o.direction] || DIRS.left;

  // 把一個 drawX 畫到離屏，回傳 canvas
  function layer(key, draw, outW, outH) {
    const s = scratch(key, outW, outH);
    draw(s.ctx);
    return s.canvas;
  }
  // 兩層加權合成（A 用 1-u、B 用 u；用 lighter 才能讓半透明區域也正確）後貼回 ctx
  function blend(ctx, cA, cB, u, outW, outH, xfA, xfB) {
    const s = scratch('tC', outW, outH), c = s.ctx;
    const put = (cv, a, xf, filter) => {
      if (a <= 0) return;
      c.save(); c.globalAlpha = a; if (filter) c.filter = filter; if (xf) xf(c); c.drawImage(cv, 0, 0); c.restore();
    };
    put(cA, 1 - u, xfA && xfA.fn, xfA && xfA.filter);
    c.globalCompositeOperation = 'lighter';
    put(cB, u, xfB && xfB.fn, xfB && xfB.filter);
    c.globalCompositeOperation = 'source-over';
    ctx.drawImage(s.canvas, 0, 0);
  }
  const scaleAbout = (outW, outH, sc) => c => { c.translate(outW / 2, outH / 2); c.scale(sc, sc); c.translate(-outW / 2, -outH / 2); };

  function dipDraw(ctx, drawA, drawB, t, opts, outW, outH, color) {
    if (isSingleIn(opts)) {          // 開頭淡入：從顏色淡入 B
      drawB(ctx);
      ctx.save(); ctx.globalAlpha = 1 - t; ctx.fillStyle = color; ctx.fillRect(0, 0, outW, outH); ctx.restore();
      return;
    }
    const single = isSingle(opts);
    if (single) {
      drawA(ctx);
      ctx.save(); ctx.globalAlpha = t; ctx.fillStyle = color; ctx.fillRect(0, 0, outW, outH); ctx.restore();
      return;
    }
    if (t < 0.5) { drawA(ctx); t = t * 2; } else { drawB(ctx); t = (1 - t) * 2; }
    ctx.save(); ctx.globalAlpha = clamp(t, 0, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, outW, outH); ctx.restore();
  }

  function defineTransition(name, fn) {
    return {
      name,
      draw(ctx, drawA, drawB, t, opts, outW, outH) {
        if (!(t > 0)) { drawA(ctx); return; }
        if (!(t < 1)) { drawB(ctx); return; }
        fn(ctx, drawA, drawB, ease(t, opts && opts.ease), opts || {}, outW, outH);
      },
    };
  }

  const TRANSITIONS = {
    crossDissolve: defineTransition('交叉疊化', (ctx, dA, dB, u, o, W, H) => {
      blend(ctx, layer('tA', dA, W, H), layer('tB', dB, W, H), u, W, H);
    }),
    dipToColor: defineTransition('浸入顏色', (ctx, dA, dB, u, o, W, H) => {
      dipDraw(ctx, dA, dB, u, o, W, H, o.color || '#000000');
    }),
    fadeToBlack: defineTransition('淡出到黑', (ctx, dA, dB, u, o, W, H) => {
      dipDraw(ctx, dA, dB, u, o, W, H, '#000000');
    }),
    wipe: defineTransition('擦拭', (ctx, dA, dB, u, o, W, H) => {
      const [dx, dy] = dirOf(o);
      // 邊界沿運動方向前進：B 佔據「邊界之後」的區域（'left' 時 B 從右邊露出）
      let a, b;   // 兩個 rect [x,y,w,h]
      if (dx) {
        const edge = dx < 0 ? W * (1 - u) : W * u;
        a = dx < 0 ? [0, 0, edge, H] : [edge, 0, W - edge, H];
        b = dx < 0 ? [edge, 0, W - edge, H] : [0, 0, edge, H];
      } else {
        const edge = dy < 0 ? H * (1 - u) : H * u;
        a = dy < 0 ? [0, 0, W, edge] : [0, edge, W, H - edge];
        b = dy < 0 ? [0, edge, W, H - edge] : [0, 0, W, edge];
      }
      const clipped = (draw, r) => { ctx.save(); ctx.beginPath(); ctx.rect(r[0], r[1], r[2], r[3]); ctx.clip(); draw(ctx); ctx.restore(); };
      clipped(dA, a); clipped(dB, b);
    }),
    push: defineTransition('推擠', (ctx, dA, dB, u, o, W, H) => {
      const [dx, dy] = dirOf(o);
      const cA = layer('tA', dA, W, H), cB = layer('tB', dB, W, H);
      ctx.drawImage(cA, dx * W * u, dy * H * u);
      ctx.drawImage(cB, dx * W * (u - 1), dy * H * (u - 1));
    }),
    slide: defineTransition('滑入', (ctx, dA, dB, u, o, W, H) => {
      const [dx, dy] = dirOf(o);
      dA(ctx);
      ctx.drawImage(layer('tB', dB, W, H), -dx * W * (1 - u), -dy * H * (1 - u));
    }),
    zoom: defineTransition('縮放', (ctx, dA, dB, u, o, W, H) => {
      blend(ctx, layer('tA', dA, W, H), layer('tB', dB, W, H), u, W, H,
        { fn: scaleAbout(W, H, 1 + 0.6 * u) }, { fn: scaleAbout(W, H, 0.7 + 0.3 * u) });
    }),
    blur: defineTransition('模糊', (ctx, dA, dB, u, o, W, H) => {
      const px = Math.sin(Math.PI * u) * 28 * Math.min(W, H) / 1080;
      const filter = px > 0.2 ? `blur(${px.toFixed(2)}px)` : null;
      blend(ctx, layer('tA', dA, W, H), layer('tB', dB, W, H), u, W, H, { filter }, { filter });
    }),
    // 4.30 負片閃：參考影片 6.4 秒「先收藏起來」→「黑柔效果」字卡，中間只有 1 格負片。
    //   前半畫 A、後半畫 B（中點硬切），只有中點前後 10% 是負片（中點最強）——不管轉場拉多長，看起來都是「一閃」。
    //   負片＝和白色做 difference；畫在離屏再用原圖 destination-in 還原 alpha，透明的地方（單邊轉場）不會變成白色。
    invertFlash: defineTransition('負片閃', (ctx, dA, dB, u, o, W, H) => {
      const cv = layer('tA', u < 0.5 ? dA : dB, W, H);
      const inv = clamp(1 - Math.abs(u - 0.5) * 10, 0, 1);
      const s = scratch('tC', W, H), c = s.ctx;
      c.drawImage(cv, 0, 0);
      if (inv > 0) {
        c.globalCompositeOperation = 'difference'; c.globalAlpha = inv;
        c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
        c.globalAlpha = 1; c.globalCompositeOperation = 'destination-in';
        c.drawImage(cv, 0, 0);
        c.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(s.canvas, 0, 0);
    }),
    // 4.30 光線劃開：參考影片 1 秒處一條細細的亮線橫掃過畫面。做成「擦拭＋邊界上一條發光的線」，線的顏色可改（預設白）。
    lineSweep: defineTransition('光線劃開', (ctx, dA, dB, u, o, W, H) => {
      TRANSITIONS.wipe.draw(ctx, dA, dB, u, { direction: o.direction }, W, H);
      const [dx] = dirOf(o), k = Math.min(W, H) / 1080;
      const horiz = !!dx, len = horiz ? W : H;
      const pos = (horiz ? (dx < 0 ? 1 - u : u) : (dirOf(o)[1] < 0 ? 1 - u : u)) * len;
      const fade = clamp(Math.min(u, 1 - u) * 8, 0, 1);       // 開頭結尾線淡出，不會在畫面邊緣突然出現／消失
      const glowW = 46 * k, col = o.color || '#ffffff';
      ctx.save();
      ctx.globalAlpha *= fade;
      const g = horiz ? ctx.createLinearGradient(pos - glowW, 0, pos + glowW, 0) : ctx.createLinearGradient(0, pos - glowW, 0, pos + glowW);
      const hx = parseColor(col).hex, soft = `rgba(${parseInt(hx.slice(1, 3), 16)},${parseInt(hx.slice(3, 5), 16)},${parseInt(hx.slice(5, 7), 16)},`;
      g.addColorStop(0, soft + '0)'); g.addColorStop(0.5, soft + '0.45)'); g.addColorStop(1, soft + '0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      if (horiz) ctx.fillRect(pos - glowW, 0, glowW * 2, H); else ctx.fillRect(0, pos - glowW, W, glowW * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = col;
      const lw = Math.max(1, 3 * k);
      if (horiz) ctx.fillRect(pos - lw / 2, 0, lw, H); else ctx.fillRect(0, pos - lw / 2, W, lw);
      ctx.restore();
    }),
  };
  // 詳細內容要顯示的選項（WebGL 轉場在 edit-fx-gl.js 裡也帶同樣的欄位）：
  //   dirs：'four'＝上下左右、'spin'＝逆／順時針、'doors'＝左右／上下打開；color：顯示「顏色」
  for (const k of ['wipe', 'push', 'slide', 'lineSweep']) TRANSITIONS[k].dirs = 'four';
  TRANSITIONS.dipToColor.color = true;
  TRANSITIONS.lineSweep.color = true;
  // ---------------------------------------------------------------------------------
  // 詳細內容
  //   sections：[{ id, title, appliesTo(subject), render(el, subject, commit) }]
  //   subject：clip 區段（transform／crop／title）收到片段；transition 區段收到 Transition 物件。
  //   commit(patch, { live })：clip 區段的 patch 是 setClipProps 的巢狀補丁（例如 { video: { transform: { zoomX: 1.2 } } }），
  //     transition 區段的 patch 是 Transition 的欄位補丁（例如 { duration: 20 }）。
  //   live:true＝拖曳／輸入中（不進復原），放開／確定時再送一次 live:false。
  //   同一個 el、同一個 subject.id 再次 render 只會更新欄位值（不重建 DOM），所以外部在 live 提交後重畫也不會打斷拖曳或輸入。
  // ---------------------------------------------------------------------------------
  const isTransition = s => !!s && s.leftClipId !== undefined;
  const trInfo = s => (s && TRANSITIONS[s.type]) || {};
  const FIT_OPTIONS = [['fit', '符合（完整顯示）'], ['blur', '符合＋模糊背景'], ['fill', '填滿（裁掉多的）'], ['stretch', '拉伸（變形）']];
  const LOOK_OPTIONS = [['none', '原色'], ['warm', '暖陽'], ['cool', '冷調'], ['mono', '黑白'], ['mist', '黑柔'], ['film', '電影感']];
  const DIR_OPTIONS = [['left', '向左'], ['right', '向右'], ['up', '向上'], ['down', '向下']];
  const ALIGN_OPTIONS = [['left', '靠左'], ['center', '置中'], ['right', '靠右']];

  function ensureStyle() {
    const d = root.document;
    if (!d || d.getElementById('ed-fx-style')) return;
    const st = d.createElement('style');
    st.id = 'ed-fx-style';
    st.textContent = `
.ed-fx{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ed-text,var(--text,inherit))}
.ed-fx,.ed-fx *{box-sizing:border-box}
.ed-fx[hidden],.ed-fx [hidden]{display:none!important}
.ed-fx-row{display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:8px;min-height:26px}
.ed-fx-lab{margin:0;font-size:12px;font-weight:600;color:var(--ed-muted,var(--muted,#6b7890));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;-webkit-user-select:none}
.ed-fx-lab.ed-fx-drag{cursor:ew-resize;touch-action:none}
.ed-fx-lab.ed-fx-drag:hover{color:var(--ed-accent,var(--accent,#004aad))}
.ed-fx-ctl{display:flex;align-items:center;gap:6px;min-width:0}
.ed-fx-ctl>*{min-width:0}
.ed-fx input[type=number],.ed-fx select,.ed-fx textarea,.ed-fx input[type=text]{font:inherit;font-size:12px;color:var(--ed-text,var(--text,inherit));background:var(--ed-field,var(--field-bg,#fff));border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));border-radius:6px;padding:4px 6px;width:100%}
.ed-fx input[type=number]{text-align:right;-moz-appearance:textfield}
.ed-fx input[type=number]::-webkit-outer-spin-button,.ed-fx input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.ed-fx textarea{min-height:64px;resize:vertical;line-height:1.4}
.ed-fx input[type=color]{width:34px;height:24px;padding:0;border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));border-radius:6px;background:none;flex:none}
.ed-fx-range{flex:1 1 auto;width:auto;min-width:60px;height:18px;margin:0;accent-color:var(--ed-accent,var(--accent,#004aad));cursor:pointer}
.ed-fx input.ed-fx-numbox{flex:0 0 66px;width:66px}
.ed-fx-unit{flex:none;color:var(--ed-muted,var(--muted,#6b7890));font-size:11px;min-width:12px}
.ed-fx-alpha{width:64px!important;flex:none}
.ed-fx-chk{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;font-weight:500;cursor:pointer}
.ed-fx-chk input{margin:0}
.ed-fx-head{margin:6px 0 0;padding-top:6px;border-top:1px solid var(--ed-border,var(--border,rgba(0,74,173,.12)));font-size:11px;font-weight:700;color:var(--ed-muted,var(--muted,#6b7890))}
.ed-fx-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));background:var(--ed-field,var(--field-bg,#fff));color:var(--ed-text,var(--text,inherit));cursor:pointer}
.ed-fx-btn:hover{border-color:var(--ed-accent,var(--accent,#004aad));color:var(--ed-accent,var(--accent,#004aad))}
.ed-fx-chars{display:flex;flex-wrap:wrap;gap:3px;padding:6px;border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)));border-radius:6px;background:var(--ed-field,var(--field-bg,#fff));touch-action:none;user-select:none;-webkit-user-select:none}
.ed-fx-ch{min-width:22px;height:24px;padding:0 3px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font-size:13px;cursor:pointer;color:var(--ed-text,var(--text,inherit));border:1px solid transparent}
.ed-fx-ch:hover{border-color:var(--ed-accent,var(--accent,#004aad))}
.ed-fx-ch.on{background:var(--ed-fx-acc,#ff2d2d);color:#fff;font-weight:700}
.ed-fx-ch.sp{min-width:10px;cursor:default;border:none}
.ed-fx-br{flex-basis:100%;height:0}
.ed-fx-chars-empty{font-size:11px;color:var(--ed-muted,var(--muted,#6b7890))}
.ed-kf{flex:none;width:24px;height:24px;padding:0;border:none;background:none;cursor:pointer;position:relative;color:var(--ed-muted,var(--muted,#6b7890))}
.ed-kf::before{content:'';position:absolute;left:7px;top:7px;width:9px;height:9px;transform:rotate(45deg);border:1.5px solid currentColor;border-radius:1px;box-sizing:border-box}
.ed-kf:hover:not(:disabled){color:var(--ed-accent,var(--accent,#004aad))}
.ed-kf.anim{color:#e8a200}
.ed-kf.anim::before{background:linear-gradient(135deg,currentColor 50%,transparent 50%)}
.ed-kf.on{color:#e8a200}
.ed-kf.on::before{background:currentColor}
.ed-kf:disabled{opacity:.35;cursor:not-allowed}
.ed-fx-row.kf-anim>.ed-fx-lab{color:#c98a00}
.ed-kfbar{display:flex;flex-direction:column;gap:6px;padding:6px;border-radius:8px;background:var(--ed-field,var(--field-bg,#fff));border:1px solid var(--ed-border,var(--border,rgba(0,74,173,.2)))}
.ed-kfnav,.ed-kfpre{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.ed-kfnav .ed-fx-btn{padding:2px 7px;min-height:24px;min-width:24px}
.ed-kf-info{flex:1 1 auto;font-size:11px;color:var(--ed-muted,var(--muted,#6b7890));text-align:center;min-width:80px}
.ed-fx select.ed-kf-interp{width:auto;flex:0 1 auto;min-height:24px}
.ed-kfpre .ed-fx-lab{width:100%}
.ed-kfpre .ed-fx-btn{padding:3px 8px;font-size:11px;min-height:24px}
.ed-fx-btn:disabled{opacity:.4;cursor:not-allowed}
.ed-fx-hint{font-size:11px;color:var(--ed-muted,var(--muted,#6b7890));line-height:1.4}
`;
    d.head.appendChild(st);
  }

  const fmtNum = (v, dec) => String(+Number(v).toFixed(dec));
  const el = (tag, cls, text) => {
    const e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // 欄位的 kf：['zoomX'] 或 c => [...]；'crop.left' 這種寫法代表 video.crop.left，其他是 video.transform.*
  const kfPaths = (def, c) => (typeof def.kf === 'function' ? def.kf(c) : def.kf).map(k => (k.startsWith('crop.') ? 'video.' + k : 'video.transform.' + k));
  const KF_INTERP_OPTIONS = [['linear', '等速'], ['ease', '緩入緩出'], ['hold', '停格（跳到下一格）']];
  const KF_PRESET_OPTIONS = [['zoomIn', '慢慢放大', '從頭到尾慢慢放大（推近）'], ['zoomOut', '慢慢縮小', '從頭到尾慢慢縮小（拉遠）'],
    ['panLeft', '向左平移', '畫面慢慢往左移（稍微放大避免黑邊）'], ['panRight', '向右平移', '畫面慢慢往右移（稍微放大避免黑邊）']];

  // 每個欄位：{ el, refresh() }；st 是這個區段的共用狀態 { subject, commit, ctx }
  function makeRow(st, def) {
    const row = el('div', 'ed-fx-row');
    const ctl = el('div', 'ed-fx-ctl');
    const emit = (patch, live) => st.commit && st.commit(patch, { live: !!live });
    const get = () => def.get(st.subject, st.ctx);
    let refresh = () => {};
    const lab = txt => { const l = el('span', 'ed-fx-lab', txt); l.title = txt; return l; };

    if (def.type === 'head') {
      row.className = 'ed-fx-head'; row.textContent = def.label;
    } else if (def.type === 'btn') {
      row.style.gridTemplateColumns = '1fr';
      const b = el('button', 'ed-fx-btn', def.label);
      b.type = 'button';
      // kfReset：重設時順便清掉這一類參數的關鍵影格（例如 'video.transform.'），交給詳細內容一次做完（一筆復原）
      b.addEventListener('click', () => {
        const x = st.ctx;
        if (def.run) def.run(st.subject, x);
        else if (def.kfReset && x && x.kf) x.kf.reset(def.kfReset, def.patch(st.subject), st.subject);
        else emit(def.patch(st.subject), false);
      });
      row.append(b);
    } else if (def.type === 'hint') {
      row.style.gridTemplateColumns = '1fr';
      row.className = 'ed-fx-hint'; row.textContent = def.label;
    } else if (def.type === 'num') {
      const scale = def.scale || 1, dec = def.dec == null ? 2 : def.dec;
      const l = lab(def.label); l.classList.add('ed-fx-drag');
      const inp = el('input'); inp.type = 'number'; inp.step = def.inputStep || fmtNum(Math.pow(10, -dec), dec);
      const unit = el('span', 'ed-fx-unit', def.unit || '');
      // slider: [lo, hi]（顯示值）→ 前面加拉桿；數值框留在後面可直接輸入，可以超出拉桿範圍（到 min／max）
      let rng = null;
      if (def.slider) {
        rng = el('input', 'ed-fx-range'); rng.type = 'range';
        rng.min = def.slider[0]; rng.max = def.slider[1]; rng.step = def.sliderStep || fmtNum(Math.pow(10, -dec), dec);
        rng.setAttribute('aria-label', def.label);
        inp.classList.add('ed-fx-numbox');
        ctl.append(rng);
      }
      ctl.append(inp, unit);
      // 關鍵影格菱形：空心＝這個參數沒有動畫、半實心＝有動畫但這格沒有、實心＝這格有關鍵影格
      let kfBtn = null;
      if (def.kf) {
        kfBtn = el('button', 'ed-kf');
        kfBtn.type = 'button'; kfBtn.setAttribute('aria-label', def.label + '：關鍵影格');
        kfBtn.addEventListener('click', () => { const x = st.ctx; if (x && x.kf) x.kf.toggle(kfPaths(def, st.subject), st.subject); });
        ctl.append(kfBtn);
      }
      const lo = def.min == null ? -Infinity : def.min, hi = def.max == null ? Infinity : def.max;
      const q = v => { const p = Math.pow(10, dec) * scale; return Math.round(clamp(v, lo, hi) * p) / p; };   // 夾範圍並對齊顯示精度
      const cur = () => num(get(), def.def == null ? 0 : def.def);
      refresh = () => {
        if (root.document.activeElement !== inp) inp.value = fmtNum(cur() * scale, dec);
        if (rng && root.document.activeElement !== rng) rng.value = String(cur() * scale);
        if (kfBtn) {
          const x = st.ctx || {}, ps = kfPaths(def, st.subject), c = st.subject;
          const anim = ps.some(q => c.keyframes && Array.isArray(c.keyframes[q]) && c.keyframes[q].length);
          const here = anim && ps.some(q => (c.keyframes[q] || []).some(e => e.f === x.f));
          kfBtn.className = 'ed-kf' + (here ? ' on' : anim ? ' anim' : '');
          kfBtn.disabled = !x.inRange;
          kfBtn.title = !x.inRange ? '把播放頭移到這個片段上才能打關鍵影格' : here ? '刪除這一格的關鍵影格' : anim ? '在播放頭加關鍵影格' : '開始做動畫：在播放頭加第一個關鍵影格';
          row.classList.toggle('kf-anim', anim);
        }
      };
      if (rng) {
        const fromRng = () => q(parseFloat(rng.value) / scale);
        rng.addEventListener('input', () => { const v = fromRng(); inp.value = fmtNum(v * scale, dec); emit(def.patch(v, st.subject), true); });
        rng.addEventListener('change', () => { const v = fromRng(); emit(def.patch(v, st.subject), false); rng.blur(); });
        rng.addEventListener('dblclick', () => { if (def.def == null) return; rng.value = String(def.def * scale); inp.value = fmtNum(def.def * scale, dec); emit(def.patch(def.def, st.subject), false); });
      }
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (!isFinite(v)) { inp.value = fmtNum(cur() * scale, dec); return; }
        const nv = q(v / scale);
        inp.value = fmtNum(nv * scale, dec);
        emit(def.patch(nv, st.subject), false);
      });
      // 在標籤上左右拖曳（Shift 加速 ×10、Alt 微調 ×0.1），雙擊標籤重設。用 window 監聽，外部中途重畫也不會中斷。
      const dpp = def.dpp || (Number.isFinite(hi - lo) ? (hi - lo) / 400 : Math.pow(10, -dec));
      l.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX, v0 = cur();
        let moved = false, last = v0;
        const move = ev => {
          const dx = ev.clientX - x0;
          if (!moved && Math.abs(dx) < 2) return;
          moved = true;
          const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
          last = q(v0 + dx * dpp * mult);
          inp.value = fmtNum(last * scale, dec);
          if (rng) rng.value = String(last * scale);
          emit(def.patch(last, st.subject), true);
        };
        const up = () => {
          root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); root.removeEventListener('pointercancel', up);
          root.document.body.style.cursor = '';
          if (moved) emit(def.patch(last, st.subject), false);
        };
        root.document.body.style.cursor = 'ew-resize';
        root.addEventListener('pointermove', move); root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
      });
      l.addEventListener('dblclick', () => {
        if (def.def == null) return;
        inp.value = fmtNum(def.def * scale, dec);
        if (rng) rng.value = String(def.def * scale);
        emit(def.patch(def.def, st.subject), false);
      });
      row.append(l, ctl);
    } else if (def.type === 'kfbar') {
      // 關鍵影格工具列：上一個／下一個、這格的走法、清除；沒有動畫時只顯示一鍵動畫
      row.style.gridTemplateColumns = '1fr';
      row.className = 'ed-kfbar';
      const mk = (cls, txt, tip) => { const b = el('button', 'ed-fx-btn ' + cls, txt); b.type = 'button'; b.title = tip; return b; };
      const nav = el('div', 'ed-kfnav');
      const prev = mk('ed-kf-prev', '◀', '上一個關鍵影格'), next = mk('ed-kf-next', '▶', '下一個關鍵影格');
      const info = el('span', 'ed-kf-info');
      const interp = el('select', 'ed-kf-interp'); interp.title = '從這一格到下一格怎麼變化';
      KF_INTERP_OPTIONS.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; interp.append(o); });
      const clear = mk('ed-kf-clear', '清除', '清除這個片段的所有關鍵影格（停在播放頭看到的樣子）');
      nav.append(prev, info, next, interp, clear);
      const pre = el('div', 'ed-kfpre');
      pre.append(el('span', 'ed-fx-lab', '一鍵動畫'));
      for (const [k, t, tip] of KF_PRESET_OPTIONS) { const b = mk('ed-kf-preset', t, tip); b.dataset.preset = k; b.addEventListener('click', () => st.ctx && st.ctx.kf && st.ctx.kf.preset(k, st.subject)); pre.append(b); }
      row.append(nav, pre);
      const frames = () => { const c = st.subject, s0 = new Set(); for (const q of Object.keys(c.keyframes || {})) for (const e of c.keyframes[q] || []) if (e.f >= 0 && e.f < c.duration) s0.add(e.f); return Array.from(s0).sort((a, b) => a - b); };
      prev.addEventListener('click', () => { const x = st.ctx, fs = frames().filter(f => f < x.f); if (fs.length) x.kf.seek(fs[fs.length - 1], st.subject); });
      next.addEventListener('click', () => { const x = st.ctx, fs = frames().filter(f => f > x.f); if (fs.length) x.kf.seek(fs[0], st.subject); });
      interp.addEventListener('change', () => st.ctx.kf.interp(interp.value, st.subject));
      clear.addEventListener('click', () => st.ctx.kf.clear(st.subject));
      refresh = () => {
        const x = st.ctx || {}, fs = frames(), c = st.subject;
        nav.hidden = !fs.length;
        const here = fs.includes(x.f);
        prev.disabled = !fs.some(f => f < x.f); next.disabled = !fs.some(f => f > x.f);
        info.textContent = `關鍵影格 ${fs.length} 個` + (here ? '（播放頭在關鍵影格上）' : '');
        interp.disabled = !here;
        if (here) {
          const k = Object.values(c.keyframes || {}).map(a => (a || []).find(e => e.f === x.f)).find(Boolean);
          interp.value = (k && k.interp) || 'linear';
        }
      };
    } else if (def.type === 'select') {
      const s = el('select');
      const opts = def.options;
      opts.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; s.append(o); });
      ctl.append(s);
      refresh = () => { s.value = String(get()); };
      s.addEventListener('change', () => emit(def.patch(s.value, st.subject), false));
      row.append(lab(def.label), ctl);
    } else if (def.type === 'check') {
      row.style.gridTemplateColumns = '1fr';
      const l = el('label', 'ed-fx-chk');
      const c = el('input'); c.type = 'checkbox';
      l.append(c, root.document.createTextNode(def.label));
      refresh = () => { c.checked = !!get(); };
      c.addEventListener('change', () => emit(def.patch(c.checked, st.subject), false));
      row.append(l);
    } else if (def.type === 'color') {
      const c = el('input'); c.type = 'color';
      ctl.append(c);
      let a = null;
      if (def.alpha) {
        a = el('input', 'ed-fx-alpha'); a.type = 'number'; a.min = 0; a.max = 100; a.step = 5; a.title = '透明度（%）';
        ctl.append(a, el('span', 'ed-fx-unit', '%'));
      }
      refresh = () => {
        const p = parseColor(get());
        c.value = p.hex;
        if (a && root.document.activeElement !== a) a.value = fmtNum(p.a * 100, 0);
      };
      const build = () => formatColor(c.value, a ? clamp((parseFloat(a.value) || 0) / 100, 0, 1) : 1);
      c.addEventListener('input', () => emit(def.patch(build(), st.subject), true));
      c.addEventListener('change', () => emit(def.patch(build(), st.subject), false));
      if (a) a.addEventListener('change', () => emit(def.patch(build(), st.subject), false));
      row.append(lab(def.label), ctl);
    } else if (def.type === 'chars') {
      // 選字變色：把文字拆成一格一格，點一下切換；按住拖過去一次改一串。放開才送出（一筆復原）
      row.style.gridTemplateColumns = '1fr';
      const wrap = el('div'), box = el('div', 'ed-fx-chars');
      wrap.append(lab(def.label), box);
      row.append(wrap);
      let key = null, cells = [], paint = null;
      const cur = () => def.get(st.subject) || { text: '', mask: null, color: '#ff2d2d' };
      refresh = () => {
        const v = cur();
        box.style.setProperty('--ed-fx-acc', v.color || '#ff2d2d');
        if (paint) return;
        if (v.text !== key) {
          key = v.text; box.textContent = ''; cells = [];
          Array.from(v.text).forEach((c, i) => {
            if (c === '\n') { box.append(el('span', 'ed-fx-br')); cells.push(null); return; }
            const sp = /\s/.test(c);
            const b = el('span', 'ed-fx-ch' + (sp ? ' sp' : ''), sp ? '' : c);
            b.dataset.i = i;
            box.append(b); cells.push(sp ? null : b);
          });
          if (!cells.some(Boolean)) box.append(el('span', 'ed-fx-chars-empty', '先在上面輸入文字'));
        }
        cells.forEach((b, i) => { if (b) b.classList.toggle('on', !!(v.mask && v.mask[i])); });
      };
      const cellAt = e => { const t = root.document.elementFromPoint(e.clientX, e.clientY); return t && t.closest && t.closest('.ed-fx-ch:not(.sp)'); };
      box.addEventListener('pointerdown', e => {
        const b = cellAt(e);
        if (e.button !== 0 || !b || !box.contains(b)) return;
        e.preventDefault();
        const v = cur();
        const mask = cells.map((c, i) => !!(c && v.mask && v.mask[i]));
        const on = !mask[+b.dataset.i];
        paint = { mask, on };
        const set = c => { if (!c || !box.contains(c)) return; mask[+c.dataset.i] = on; c.classList.toggle('on', on); };
        set(b);
        const move = ev => set(cellAt(ev));
        const up = () => {
          root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); root.removeEventListener('pointercancel', up);
          paint = null;
          emit(def.patch(mask, st.subject), false);
        };
        root.addEventListener('pointermove', move); root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
      });
    } else if (def.type === 'text') {
      row.style.gridTemplateColumns = '1fr';
      const wrap = el('div');
      const t = el('textarea'); t.rows = 3; t.placeholder = def.placeholder || '';
      wrap.append(lab(def.label), t);
      refresh = () => { if (root.document.activeElement !== t) t.value = String(get() == null ? '' : get()); };
      t.addEventListener('input', () => emit(def.patch(t.value, st.subject), true));
      t.addEventListener('change', () => emit(def.patch(t.value, st.subject), false));
      row.append(wrap);
    }
    return {
      el: row,
      refresh() {
        if (def.show) row.hidden = !def.show(st.subject);
        refresh();
      },
    };
  }

  function buildSection(host, key, subject, commit, defs, ctx) {
    let st = host.__edFx;
    if (st && st.key === key) {                     // 同一個對象：只更新值
      st.subject = subject; st.commit = commit; st.ctx = ctx || null;
      st.rows.forEach(r => r.refresh());
      return;
    }
    ensureStyle();
    host.textContent = '';
    host.classList.add('ed-fx');
    st = host.__edFx = { key, subject, commit, ctx: ctx || null, rows: [] };
    for (const d of defs) {
      const r = makeRow(st, d);
      host.append(r.el);
      st.rows.push(r);
    }
    st.rows.forEach(r => r.refresh());
  }

  // ctx：詳細內容傳進來的 { f（播放頭在片段內第幾格）, inRange, kf（關鍵影格操作）}；數值顯示播放頭那一格的樣子
  const fOf = x => (x && Number.isFinite(x.f) ? Math.max(0, x.f) : 0);
  const tf = (c, k, x) => { const v = getParam(c, 'video.transform.' + k, fOf(x)); return v === undefined ? DEFAULT_TRANSFORM[k] : v; };
  const tfPatch = o => ({ video: { transform: o } });
  const cp = (c, k, x) => { const v = getParam(c, 'video.crop.' + k, fOf(x)); return v === undefined ? 0 : v; };
  const cropPatch = o => ({ video: { crop: o } });
  const tt = (c, k) => (c.title && c.title[k] != null) ? c.title[k] : BASE_TITLE[k];
  const ttSub = (c, o, k) => (c.title && c.title[o] && c.title[o][k] != null) ? c.title[o][k] : BASE_TITLE[o][k];
  // 外框格子：一律送出完整 4 格（逐格合併才不會留下舊值）；有用的格子保持連續、從第 1 格開始
  const outlinesAll = c => BASE_TITLE.outlines.map((b, i) => ({ ...b, ...((c.title && Array.isArray(c.title.outlines) && c.title.outlines[i]) || {}) }));
  const outlineAt = (c, i) => outlinesAll(c)[i];
  const outlineCount = c => outlinesAll(c).filter(o => o.on).length;
  const packOutlines = list => Array.from({ length: OUTLINE_SLOTS }, (_, i) => (list[i] ? { ...list[i], on: true } : outlineOff()));
  const setOutline = (c, i, o) => { const a = outlinesAll(c); a[i] = { ...a[i], ...o }; return a; };
  const removeOutline = (c, i) => packOutlines(outlinesAll(c).filter((o, j) => o.on && j !== i));
  const addOutline = c => {
    const on = outlinesAll(c).filter(o => o.on);
    return packOutlines([...on, { color: on.length % 2 ? '#1593d6' : '#ffffff', width: 6 }]);
  };

  // 底形狀要不要顯示這個欄位（SHAPES 的 fields）
  const shapeHas = f => c => { const d = SHAPES[ttSub(c, 'shape', 'kind')]; return !!(d && d.fields && d.fields.includes(f)); };
  const isTitleClip = c => !!c && !isTransition(c) && c.type === 'title' && !!c.title;
  const SECTIONS = [
    {
      id: 'transform', title: '變形',
      appliesTo: c => !!c && !isTransition(c) && !!c.video,
      render(host, clip, commit, ctx) {
        const linked = c => c.video && c.video.transform ? c.video.transform.zoomLinked !== false : true;
        buildSection(host, 'transform:' + clip.id, clip, commit, [
          { type: 'kfbar' },
          { type: 'num', label: '縮放 X', kf: c => (linked(c) ? ['zoomX', 'zoomY'] : ['zoomX']), get: (c, x) => tf(c, 'zoomX', x), def: 1, min: 0.01, max: 20, dpp: 0.005, dec: 3, slider: [0.1, 4], sliderStep: 0.01,
            patch: (v, c) => tfPatch(linked(c) ? { zoomX: v, zoomY: v } : { zoomX: v }) },
          { type: 'num', label: '縮放 Y', kf: c => (linked(c) ? ['zoomX', 'zoomY'] : ['zoomY']), get: (c, x) => linked(c) ? tf(c, 'zoomX', x) : tf(c, 'zoomY', x), def: 1, min: 0.01, max: 20, dpp: 0.005, dec: 3, slider: [0.1, 4], sliderStep: 0.01,
            patch: (v, c) => tfPatch(linked(c) ? { zoomX: v, zoomY: v } : { zoomY: v }) },
          { type: 'check', label: '連結縮放 X／Y', get: linked,
            patch: (v, c) => tfPatch(v ? { zoomLinked: true, zoomY: tf(c, 'zoomX') } : { zoomLinked: false }) },
          { type: 'num', label: '位置 X', kf: ['posX'], get: (c, x) => tf(c, 'posX', x), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', slider: [-2000, 2000], sliderStep: 1, patch: v => tfPatch({ posX: v }) },
          { type: 'num', label: '位置 Y', kf: ['posY'], get: (c, x) => tf(c, 'posY', x), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', slider: [-2000, 2000], sliderStep: 1, patch: v => tfPatch({ posY: v }) },
          { type: 'num', label: '旋轉', kf: ['rotation'], get: (c, x) => tf(c, 'rotation', x), def: 0, min: -3600, max: 3600, dpp: 0.5, dec: 1, unit: '°', patch: v => tfPatch({ rotation: v }) },
          { type: 'num', label: '錨點 X', kf: ['anchorX'], get: (c, x) => tf(c, 'anchorX', x), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', patch: v => tfPatch({ anchorX: v }) },
          { type: 'num', label: '錨點 Y', kf: ['anchorY'], get: (c, x) => tf(c, 'anchorY', x), def: 0, min: -20000, max: 20000, dpp: 1, dec: 1, unit: 'px', patch: v => tfPatch({ anchorY: v }) },
          { type: 'num', label: '不透明度', kf: ['opacity'], get: (c, x) => tf(c, 'opacity', x), def: 1, min: 0, max: 1, scale: 100, dpp: 0.004, dec: 0, unit: '%', patch: v => tfPatch({ opacity: v }) },
          { type: 'check', label: '水平翻轉', get: (c, x) => !!tf(c, 'flipH', x), patch: v => tfPatch({ flipH: v }) },
          { type: 'check', label: '垂直翻轉', get: (c, x) => !!tf(c, 'flipV', x), patch: v => tfPatch({ flipV: v }) },
          { type: 'select', label: '畫面符合', options: FIT_OPTIONS, get: c => (c.video && c.video.fit) || 'fit', patch: v => ({ video: { fit: v } }) },
          { type: 'num', label: '背景模糊', show: c => !!c.video && c.video.fit === 'blur', get: c => num(c.video && c.video.bgBlur, BG_BLUR_DEFAULT), def: BG_BLUR_DEFAULT, min: 0, max: 100, dpp: 0.5, dec: 0, unit: '%', slider: [0, 100], sliderStep: 1, patch: v => ({ video: { bgBlur: v } }) },
          { type: 'select', label: '濾鏡', show: c => c.type === 'media', options: LOOK_OPTIONS, get: c => (c.video && c.video.look) || 'none', patch: v => ({ video: { look: v } }) },
          { type: 'num', label: '濾鏡強度', show: c => c.type === 'media' && !!c.video && !!c.video.look && c.video.look !== 'none', get: c => num(c.video && c.video.lookAmt, 100), def: 100, min: 0, max: 100, dpp: 0.5, dec: 0, unit: '%', slider: [0, 100], sliderStep: 1, patch: v => ({ video: { lookAmt: v } }) },
          { type: 'select', label: '貼圖動態', options: STICKER_OPTIONS, get: c => (c.video && c.video.sticker) || 'none', patch: v => ({ video: { sticker: v } }) },
          { type: 'num', label: '貼圖動態強度', show: c => !!c.video && !!c.video.sticker && c.video.sticker !== 'none', get: c => num(c.video && c.video.stickerAmt, 100), def: 100, min: 0, max: 100, dpp: 0.5, dec: 0, unit: '%', slider: [0, 100], sliderStep: 1, patch: v => ({ video: { stickerAmt: v } }) },
          { type: 'btn', label: '重設變形', kfReset: 'video.transform.', patch: () => ({ video: { transform: defaultTransform(), fit: 'fit' } }) },
          { type: 'hint', label: '提示：按數值右邊的 ◇ 就能做動畫：移動播放頭、改數值，會自動在播放頭加關鍵影格。縮放、位置可拖拉桿或直接輸入數值；也可以在預覽畫面上直接拖曳、拉角落縮放、拉上方圓點旋轉。在左側標籤上左右拖曳可微調（Shift 加速、Alt 微調），雙擊標籤或拉桿重設。' },
        ], ctx);
      },
    },
    {
      // 4.50：色彩還原＋LUT（只給影片／圖片片段）。LUT 選單的選項來自專案（ctx.luts），換了清單就重建這一區
      id: 'color', title: '色彩',
      appliesTo: c => !!c && !isTransition(c) && !!c.video && c.type === 'media',
      render(host, clip, commit, ctx) {
        const luts = (ctx && ctx.luts) || {};
        const opts = [['', '無'], ...Object.entries(luts).map(([id, r]) => [id, `${r.name}（${r.size} 點）`])];
        buildSection(host, 'color:' + clip.id + ':' + Object.keys(luts).join(','), clip, commit, [
          { type: 'num', label: '色彩還原', get: c => num(c.video && c.video.restore, 0), def: 0, min: 0, max: 100, dpp: 0.5, dec: 0, unit: '%', slider: [0, 100], sliderStep: 1, patch: v => ({ video: { restore: v } }) },
          { type: 'hint', label: '色彩還原：自動拉開色階、校正偏色（白平衡），適合手機或舊影片顏色灰灰、偏黃偏藍的畫面。' },
          { type: 'select', label: 'LUT', options: opts, get: c => (c.video && c.video.lut && luts[c.video.lut] ? c.video.lut : ''), patch: v => ({ video: { lut: v || null } }) },
          { type: 'num', label: 'LUT 強度', show: c => !!(c.video && c.video.lut && luts[c.video.lut]), get: c => num(c.video && c.video.lutAmt, 100), def: 100, min: 0, max: 100, dpp: 0.5, dec: 0, unit: '%', slider: [0, 100], sliderStep: 1, patch: v => ({ video: { lutAmt: v } }) },
          { type: 'btn', label: '載入 LUT 檔（.cube）…', run: c => ctx && ctx.loadLut && ctx.loadLut(c) },
          { type: 'btn', label: '從專案移除這個 LUT', show: c => !!(c.video && c.video.lut && luts[c.video.lut]), run: c => ctx && ctx.removeLut && ctx.removeLut(c.video.lut) },
        ], ctx);
      },
    },
    {
      id: 'crop', title: '裁切',
      appliesTo: c => !!c && !isTransition(c) && !!c.video,
      render(host, clip, commit, ctx) {
        const side = (label, k) => ({ type: 'num', label, kf: ['crop.' + k], get: (c, x) => cp(c, k, x), def: 0, min: 0, max: 0.95, scale: 100, dpp: 0.002, dec: 1, unit: '%', patch: v => cropPatch({ [k]: v }) });
        buildSection(host, 'crop:' + clip.id, clip, commit, [
          side('左', 'left'), side('右', 'right'), side('上', 'top'), side('下', 'bottom'),
          { type: 'num', label: '柔邊', get: c => cp(c, 'softness'), def: 0, min: 0, max: 1, scale: 100, dpp: 0.004, dec: 0, unit: '%', patch: v => cropPatch({ softness: v }) },
          { type: 'btn', label: '重設裁切', kfReset: 'video.crop.', patch: () => cropPatch(defaultCrop()) },
        ], ctx);
      },
    },
    {
      id: 'title', title: '字幕文字',
      appliesTo: isTitleClip,
      render(host, clip, commit) {
        const T = o => ({ title: o });
        const isPreset = (...a) => c => a.includes(tt(c, 'preset'));
        buildSection(host, 'title:' + clip.id, clip, commit, [
          { type: 'text', label: '文字', placeholder: '輸入字幕內容（可換行）', get: c => tt(c, 'text'), patch: v => T({ text: v }) },
          { type: 'chars', label: '選字變色（點字或拖過去，再點一次取消）', get: c => { const a = parseAccent(tt(c, 'text')); return { text: a.text, mask: a.mask, color: tt(c, 'accent') }; },
            patch: (mask, c) => T({ text: buildAccent(parseAccent(tt(c, 'text')).text, mask) }) },
          { type: 'color', label: '變色顏色', get: c => tt(c, 'accent'), patch: v => T({ accent: v }) },
          { type: 'hint', label: '也可以直接在文字裡用 *星號* 包住要變色的字，例如：進行*瘋狂*的編輯' },
          { type: 'head', label: '字型與位置' },
          { type: 'select', label: '字型', options: Object.keys(FONTS).map(k => [k, FONTS[k].name]), get: c => tt(c, 'font'), patch: v => { loadFont(v); return T({ font: v }); } },
          { type: 'num', label: '字級', get: c => tt(c, 'size'), def: 80, min: 8, max: 600, dpp: 0.5, dec: 0, unit: 'px', patch: v => T({ size: v }) },
          { type: 'select', label: '對齊', options: ALIGN_OPTIONS, get: c => tt(c, 'align'), show: c => tt(c, 'preset') !== 'lowerThird' && tt(c, 'preset') !== 'crawl', patch: v => T({ align: v }) },
          { type: 'num', label: '行距', get: c => tt(c, 'lineHeight'), def: 1.25, min: 0.8, max: 3, dpp: 0.01, dec: 2, show: isPreset('static', 'lowerThird', 'scroll', 'typewriter', 'fadeUp'), patch: v => T({ lineHeight: v }) },
          { type: 'num', label: '水平位置', get: c => tt(c, 'x'), def: 0.5, min: -0.5, max: 1.5, scale: 100, dpp: 0.002, dec: 1, unit: '%', slider: [0, 100], sliderStep: 0.5, show: c => tt(c, 'preset') !== 'crawl', patch: v => T({ x: v }) },
          { type: 'num', label: '垂直位置', get: c => tt(c, 'y'), def: 0.5, min: -0.5, max: 1.5, scale: 100, dpp: 0.002, dec: 1, unit: '%', slider: [0, 100], sliderStep: 0.5, show: c => tt(c, 'preset') !== 'scroll', patch: v => T({ y: v }) },
        ]);
      },
    },
    {
      id: 'titleLook', title: '字幕外觀',
      appliesTo: isTitleClip,
      render(host, clip, commit) {
        const T = o => ({ title: o });
        buildSection(host, 'titleLook:' + clip.id, clip, commit, [
          { type: 'color', label: '文字顏色', get: c => tt(c, 'color'), patch: v => T({ color: v }) },
          { type: 'head', label: '描邊' },
          { type: 'color', label: '描邊顏色', get: c => ttSub(c, 'stroke', 'color'), patch: v => T({ stroke: { color: v } }) },
          { type: 'num', label: '描邊粗細', get: c => ttSub(c, 'stroke', 'width'), def: 0, min: 0, max: 60, dpp: 0.1, dec: 1, unit: 'px', patch: v => T({ stroke: { width: v } }) },
          { type: 'head', label: '外框（色框）' },
          { type: 'hint', label: '在描邊外面再加一圈圈色框，最多 4 層（1 在最內側）。', show: c => outlineCount(c) === 0 },
          ...[0, 1, 2, 3].flatMap(i => [
            { type: 'color', label: `外框 ${i + 1}`, show: c => outlineAt(c, i).on, get: c => outlineAt(c, i).color, patch: (v, c) => T({ outlines: setOutline(c, i, { color: v }) }) },
            { type: 'num', label: `外框 ${i + 1} 粗細`, show: c => outlineAt(c, i).on, get: c => outlineAt(c, i).width, def: 6, min: 0, max: 60, dpp: 0.1, dec: 1, unit: 'px',
              patch: (v, c) => T({ outlines: setOutline(c, i, { width: v }) }) },
            { type: 'btn', label: `移除外框 ${i + 1}`, show: c => outlineAt(c, i).on, patch: c => T({ outlines: removeOutline(c, i) }) },
          ]),
          { type: 'btn', label: '＋ 增加外框', show: c => outlineCount(c) < OUTLINE_SLOTS, patch: c => T({ outlines: addOutline(c) }) },
          { type: 'head', label: '文字效果' },
          { type: 'check', label: '漸層', get: c => ttSub(c, 'gradient', 'on'), patch: v => T({ gradient: { on: !!v } }) },
          { type: 'select', label: '漸層種類', show: c => !!ttSub(c, 'gradient', 'on'), options: Object.keys(GRADIENTS).map(k => [k, GRADIENTS[k].name]), get: c => ttSub(c, 'gradient', 'kind'), patch: v => T({ gradient: { kind: v } }) },
          { type: 'color', label: '漸層顏色（下方）', show: c => !!ttSub(c, 'gradient', 'on') && !(GRADIENTS[ttSub(c, 'gradient', 'kind')] || {}).stops, get: c => ttSub(c, 'gradient', 'color'), patch: v => T({ gradient: { color: v } }) },
          { type: 'select', label: '字重', options: [['auto', '字型本身'], ['light', '細字']], get: c => tt(c, 'weight'), patch: v => T({ weight: v }) },
          { type: 'num', label: '字距', get: c => tt(c, 'spacing'), def: 0, min: -0.2, max: 1, dpp: 0.005, dec: 2, unit: '倍字級', slider: [-0.1, 0.5], sliderStep: 0.01, patch: v => T({ spacing: v }) },
          { type: 'num', label: '斜體', get: c => tt(c, 'skew'), def: 0, min: -30, max: 30, dpp: 0.1, dec: 1, unit: '°', slider: [-30, 30], sliderStep: 1, patch: v => T({ skew: v }) },
          { type: 'head', label: '立體' },
          { type: 'num', label: '立體深度', get: c => ttSub(c, 'extrude', 'depth'), def: 0, min: 0, max: 80, dpp: 0.1, dec: 0, unit: 'px', slider: [0, 40], sliderStep: 1, patch: v => T({ extrude: { depth: v } }) },
          { type: 'color', label: '立體顏色', show: c => ttSub(c, 'extrude', 'depth') > 0, get: c => ttSub(c, 'extrude', 'color'), patch: v => T({ extrude: { color: v } }) },
          { type: 'num', label: '立體方向', show: c => ttSub(c, 'extrude', 'depth') > 0, get: c => ttSub(c, 'extrude', 'angle'), def: 45, min: -180, max: 360, dpp: 0.5, dec: 0, unit: '°', patch: v => T({ extrude: { angle: v } }) },
          { type: 'head', label: '陰影' },
          { type: 'color', label: '陰影顏色', alpha: true, get: c => ttSub(c, 'shadow', 'color'), patch: v => T({ shadow: { color: v } }) },
          { type: 'num', label: '模糊', get: c => ttSub(c, 'shadow', 'blur'), def: 8, min: 0, max: 100, dpp: 0.2, dec: 0, unit: 'px', patch: v => T({ shadow: { blur: v } }) },
          { type: 'num', label: '位移 X', get: c => ttSub(c, 'shadow', 'x'), def: 0, min: -100, max: 100, dpp: 0.2, dec: 0, unit: 'px', patch: v => T({ shadow: { x: v } }) },
          { type: 'num', label: '位移 Y', get: c => ttSub(c, 'shadow', 'y'), def: 4, min: -100, max: 100, dpp: 0.2, dec: 0, unit: 'px', patch: v => T({ shadow: { y: v } }) },
          { type: 'head', label: '發光' },
          { type: 'num', label: '發光強度', get: c => ttSub(c, 'glow', 'blur'), def: 0, min: 0, max: 100, dpp: 0.2, dec: 0, unit: 'px', slider: [0, 60], sliderStep: 1, patch: v => T({ glow: { blur: v } }) },
          { type: 'color', label: '發光顏色', show: c => ttSub(c, 'glow', 'blur') > 0, get: c => ttSub(c, 'glow', 'color'), patch: v => T({ glow: { color: v } }) },
          { type: 'head', label: '集中線' },
          { type: 'check', label: '集中線（整個畫面，以字幕為中心）', get: c => !!ttSub(c, 'speedLines', 'on'), patch: v => T({ speedLines: { on: !!v } }) },
          { type: 'color', label: '集中線顏色', alpha: true, show: c => !!ttSub(c, 'speedLines', 'on'), get: c => ttSub(c, 'speedLines', 'color'), patch: v => T({ speedLines: { color: v } }) },
          { type: 'head', label: '底形狀' },
          { type: 'select', label: '形狀', options: Object.keys(SHAPES).map(k => [k, SHAPES[k].name]), get: c => ttSub(c, 'shape', 'kind'), patch: v => T({ shape: { kind: v } }) },
          { type: 'hint', label: '選了形狀就用形狀取代下面的背景色；「下三分之一條」「跑馬燈」的過場不畫形狀。', show: c => ttSub(c, 'shape', 'kind') !== 'none' },
          { type: 'color', label: '形狀顏色', show: shapeHas('color'), get: c => ttSub(c, 'shape', 'color'), patch: v => T({ shape: { color: v } }) },
          { type: 'color', label: '第二色', show: shapeHas('color2'), get: c => ttSub(c, 'shape', 'color2'), patch: v => T({ shape: { color2: v } }) },
          { type: 'color', label: '框線顏色', show: shapeHas('border'), get: c => ttSub(c, 'shape', 'border'), patch: v => T({ shape: { border: v } }) },
          { type: 'num', label: '框線粗細', show: shapeHas('borderW'), get: c => ttSub(c, 'shape', 'borderW'), def: 6, min: 0, max: 40, dpp: 0.1, dec: 1, unit: 'px', patch: v => T({ shape: { borderW: v } }) },
          { type: 'select', label: '尾巴方向', show: shapeHas('tail'), options: [['left', '靠左'], ['center', '置中'], ['right', '靠右'], ['none', '沒有尾巴']], get: c => ttSub(c, 'shape', 'tail'), patch: v => T({ shape: { tail: v } }) },
          { type: 'head', label: '背景' },
          { type: 'color', label: '背景顏色', alpha: true, get: c => ttSub(c, 'bg', 'color'), patch: v => T({ bg: { color: v } }) },
          { type: 'num', label: '內距', get: c => ttSub(c, 'bg', 'padding'), def: 24, min: 0, max: 300, dpp: 0.3, dec: 0, unit: 'px', patch: v => T({ bg: { padding: v } }) },
          { type: 'num', label: '圓角', get: c => ttSub(c, 'bg', 'radius'), def: 8, min: 0, max: 200, dpp: 0.3, dec: 0, unit: 'px',
            show: c => tt(c, 'preset') !== 'lowerThird' && tt(c, 'preset') !== 'crawl', patch: v => T({ bg: { radius: v } }) },
          { type: 'select', label: '尖角（對話氣泡）', options: BG_TAILS, get: c => ttSub(c, 'bg', 'tail'),
            show: c => tt(c, 'preset') !== 'lowerThird' && tt(c, 'preset') !== 'crawl', patch: v => T({ bg: { tail: v } }) },
          { type: 'color', label: '框線顏色', get: c => (c.title && c.title.bg && c.title.bg.border && c.title.bg.border.color) || BASE_TITLE.bg.border.color, patch: v => T({ bg: { border: { color: v } } }) },
          { type: 'num', label: '框線粗細', get: c => num(c.title && c.title.bg && c.title.bg.border && c.title.bg.border.width, 0), def: 0, min: 0, max: 40, dpp: 0.1, dec: 1, unit: 'px', patch: v => T({ bg: { border: { width: v } } }) },
        ]);
      },
    },
    {
      id: 'titleAnim', title: '字幕動畫',
      appliesTo: isTitleClip,
      render(host, clip, commit) {
        const T = o => ({ title: o });
        buildSection(host, 'titleAnim:' + clip.id, clip, commit, [
          { type: 'select', label: '字幕過場', options: Object.keys(TITLE_PRESETS).map(k => [k, TITLE_PRESETS[k].name]), get: c => tt(c, 'preset'),
            patch: v => { const d = deepClone(TITLE_PRESETS[v].defaults); delete d.size; return T({ preset: v, ...d }); } },
          { type: 'head', label: '字體特效' },
          { type: 'select', label: '進場', options: Object.keys(TEXT_FX).filter(k => !TEXT_FX[k].hidden).map(k => [k, TEXT_FX[k].name]), get: c => tt(c, 'textFx'), patch: v => T({ textFx: v }) },
          { type: 'num', label: '進場長度', show: c => tt(c, 'textFx') !== 'none' && !(TEXT_FX[tt(c, 'textFx')] || {}).hard, get: c => tt(c, 'textFxDur'), def: 0.5, min: 0.1, max: 5, dpp: 0.01, dec: 2, unit: '秒', patch: v => T({ textFxDur: v }) },
          { type: 'select', label: '持續', options: Object.keys(TEXT_LOOP).map(k => [k, TEXT_LOOP[k].name]), get: c => tt(c, 'textLoop'), patch: v => T({ textLoop: v }) },
          { type: 'color', label: '持續顏色', show: c => !!(TEXT_LOOP[tt(c, 'textLoop')] || {}).color, get: c => tt(c, 'textLoopColor'), patch: v => T({ textLoopColor: v }) },
          { type: 'select', label: '出場', options: Object.keys(TEXT_OUT).map(k => [k, TEXT_OUT[k].name]), get: c => tt(c, 'textOut'), patch: v => T({ textOut: v }) },
          { type: 'num', label: '出場長度', show: c => tt(c, 'textOut') !== 'none', get: c => tt(c, 'textOutDur'), def: 0.3, min: 0.1, max: 5, dpp: 0.01, dec: 2, unit: '秒', patch: v => T({ textOutDur: v }) },
        ]);
      },
    },
    {
      id: 'transition', title: '轉場',
      appliesTo: s => isTransition(s),
      render(host, tr, commit) {
        buildSection(host, 'transition:' + tr.id, tr, commit, [
          { type: 'select', label: '類型', options: Object.keys(TRANSITIONS).map(k => [k, TRANSITIONS[k].name]), get: s => s.type, patch: v => ({ type: v }) },
          { type: 'num', label: '長度', get: s => s.duration, def: 15, min: 1, max: 600, dpp: 0.25, dec: 0, unit: '格', patch: v => ({ duration: Math.round(v) }) },
          { type: 'select', label: '對齊', options: [['center', '置中於剪接點'], ['start', '從剪接點開始'], ['end', '在剪接點結束']], get: s => s.align || 'center', show: s => !!(s.leftClipId && s.rightClipId), patch: v => ({ align: v }) },
          { type: 'color', label: '顏色', get: s => s.color || '#000000', show: s => !!trInfo(s).color, patch: v => ({ color: v }) },
          { type: 'select', label: '方向', options: DIR_OPTIONS, get: s => s.direction || 'left', show: s => trInfo(s).dirs === 'four', patch: v => ({ direction: v }) },
          { type: 'select', label: '方向', options: [['left', '逆時針'], ['right', '順時針']], get: s => (s.direction === 'right' || s.direction === 'down') ? 'right' : 'left', show: s => trInfo(s).dirs === 'spin', patch: v => ({ direction: v }) },
          { type: 'select', label: '方向', options: [['left', '左右打開'], ['up', '上下打開']], get: s => (s.direction === 'up' || s.direction === 'down') ? 'up' : 'left', show: s => trInfo(s).dirs === 'doors', patch: v => ({ direction: v }) },
          { type: 'select', label: '緩動', options: [['linear', '線性'], ['easeInOut', '緩入緩出']], get: s => s.ease || 'linear', patch: v => ({ ease: v }) },
        ]);
      },
    },
  ];

  const api = {
    DEFAULT_TRANSFORM, DEFAULT_CROP, defaultTransform, defaultCrop, defaultVideo,
    fitRect, clipMatrix, applyMatrix, cropRect, getParam, FIT_OPTIONS, BG_BLUR_DEFAULT,
    drawClipVisual, drawSolid, drawTitle, titleBounds, clipQuad, LOOKS, LOOK_OPTIONS, restoreFromStats, gradePixels, gradeSource,
    TRANSITIONS, ease, TITLE_PRESETS, TITLE_STYLES, TITLE_STYLE_GROUPS, SHAPES, GRADIENTS, TEXT_FX, TEXT_LOOP, TEXT_OUT, BG_TAILS, STICKER_FX, STICKER_OPTIONS, stickerState, textOutState,
    fxPlan, fxAt, makeTitle, normTitle, parseAccent, buildAccent, parseSrt, formatSrt, fitCues, planSubtitleMark, wrapText, parseColor, formatColor,
    ready, get fontLoaded() { return defaultFontLoaded(); }, FONTS, loadFont, onFontLoad, fontIsLoaded,
    inspector: { sections: SECTIONS },
    ensureStyle,                 // 插入詳細內容樣式（.ed-fx-*）；UI 自己的區段也用這套外觀，啟動時先呼叫一次
    _setCanvasFactory(fn) { canvasFactory = fn; Object.keys(pool).forEach(k => delete pool[k]); },
  };
  Q.fx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
