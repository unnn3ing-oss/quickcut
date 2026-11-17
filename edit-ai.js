// =====================================================================================
// 剪輯：AI 剪輯的純計算（5.00；不碰 DOM，瀏覽器掛在 QPTEdit.ai，node 用 module.exports）
//
// 流程（設計見 DESIGN.md 第 16 節）：
//   工具分析素材 → 匯出「素材摘要包」（summary.json＋聯絡表 JPG）→ 使用者丟給 Claude、描述風格
//   → Claude 回「剪輯腳本」（JSON）→ 工具用 core.applyScript 照腳本排。
// 這裡放的是：
//   frameStats／shift／finishSeries／suggestRanges   每格畫面的數據（亮度、過曝、清晰度、位移、晃動）與建議可用區間
//   energy                                          音樂每 0.5 秒的能量（找副歌、高潮）
//   detectGamma／looksLog                           Sony 檔案內嵌的伽瑪資訊、從畫面猜是不是 Log
//   slog3Lut／applyLut／sampleLut                   S-Log3 → Rec.709 的近似轉換（公式算出來的 LUT）、把 LUT 套到像素（聯絡表用）
//   planSheets                                      聯絡表每一格要拍哪支素材的第幾秒
//   buildSummary／forClaude                         摘要包的 JSON（開頭附給 Claude 看的格式說明，新對話也看得懂）
//   parseScriptText                                 從 Claude 的回覆裡取出腳本 JSON（整段貼上、含 ```json 圍欄都行）
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit = root.QPTEdit || {};

  const AW = 160, AH = 90;          // 分析用的縮圖大小（素材不管比例都縮成這個大小）
  const STEP = 0.5;                 // 每幾秒取樣一次
  const PAIR = 0.1;                 // 每個取樣點再往後這麼多秒抓第二格，算瞬間位移
  const SEARCH = 8;                 // 位移搜尋範圍（像素，160 寬 → ±5% 畫面寬）
  const MAX_SAMPLES = 240;          // 一支素材最多取樣幾次（太長就拉大間隔）
  const SHAKE_MAX = 5;              // 晃動分數（每秒位移變化，％畫面寬）超過這個＝晃
  const RANGE_MIN = 1.5;            // 建議可用區間至少幾秒
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r1 = v => Math.round(v * 10) / 10;

  const sampleStep = dur => (dur / STEP <= MAX_SAMPLES ? STEP : Math.ceil(dur / MAX_SAMPLES / STEP) * STEP);

  // ---- 單格數據 -----------------------------------------------------------------------
  // rgba：w×h 的像素。回傳亮度平均、過曝／死黑比例、1%／99% 亮度（都是 0～1）、飽和度、清晰度（拉普拉斯變異數）、灰階圖
  function frameStats(rgba, w, h) {
    const n = w * h, gray = new Uint8Array(n), hist = new Uint32Array(256);
    let sum = 0, over = 0, under = 0, sat = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8;
      gray[i] = y; hist[y]++; sum += y;
      if (y >= 245) over++; else if (y <= 10) under++;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
    }
    const pct = q => { let c = 0; const want = n * q; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= want) return v / 255; } return 1; };
    let ls = 0, ls2 = 0, m = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      ls += l; ls2 += l * l; m++;
    }
    const mean = m ? ls / m : 0;
    return { luma: sum / n / 255, over: over / n, under: under / n, p1: pct(0.01), p99: pct(0.99), sat: sat / n / 255, sharp: m ? ls2 / m - mean * mean : 0, gray };
  }

  // 兩張灰階圖的整體位移：b 的內容相對 a 往右 dx、往下 dy 個像素（鏡頭往右搖 → 畫面內容往左 → dx 為負）
  // 做法：±R 像素內找絕對差總和最小的位置，再用拋物線內插到小數。err＝對齊後每像素平均差（0～1，大＝畫面內容本身在動）
  function shift(a, b, w, h, R = SEARCH) {
    const sad = (dx, dy) => {
      let s = 0;
      for (let y = R; y < h - R; y += 2) {
        const ra = y * w, rb = (y + dy) * w + dx;
        for (let x = R; x < w - R; x += 2) s += Math.abs(a[ra + x] - b[rb + x]);
      }
      return s;
    };
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const s = (sad(dx, dy) + 1) * (1 + 0.002 * (Math.abs(dx) + Math.abs(dy)));   // 一樣好的時候偏好不動（純色、重複花紋）
      if (s < best) { best = s; bx = dx; by = dy; }
    }
    const sub = (m, c, p) => { const d = m - 2 * c + p; return d > 1e-9 ? clamp(0.5 * (m - p) / d, -0.5, 0.5) : 0; };
    const c = sad(bx, by);
    const fx = Math.abs(bx) < R ? sub(sad(bx - 1, by), c, sad(bx + 1, by)) : 0;
    const fy = Math.abs(by) < R ? sub(sad(bx, by - 1), c, sad(bx, by + 1)) : 0;
    const cnt = Math.ceil((h - 2 * R) / 2) * Math.ceil((w - 2 * R) / 2);
    return { dx: bx + fx, dy: by + fy, err: cnt ? c / cnt / 255 : 0 };
  }
  // 兩張灰階圖的平均差（0～1）
  function diff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return a.length ? s / a.length / 255 : 0;
  }

  // ---- 一支素材的數列 -------------------------------------------------------------------
  // samples：[{ t, luma, over, under, sharp, vx, vy, change }]（vx／vy＝每秒位移，％畫面寬／高；change＝和上一個取樣點的畫面差 0～1）
  // 補上 shake（位移的變化量：穩定的運鏡 vx 幾乎固定 → 0；手持亂晃 → 大）
  function finishSeries(samples) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const s = samples[i], near = [];
      if (i > 0) near.push(samples[i - 1]);
      if (i < n - 1) near.push(samples[i + 1]);
      s.shake = near.length ? near.reduce((m, o) => m + Math.hypot(s.vx - o.vx, s.vy - o.vy), 0) / near.length : 0;
    }
    return samples;
  }
  // 建議可用區間：連續 RANGE_MIN 秒以上不晃、沒有大面積過曝、不是全黑、清晰度不比整支的中位數差太多
  function suggestRanges(samples, step, duration) {
    if (!samples.length) return [];
    const sorted = samples.map(s => s.sharp).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    const good = s => s.shake <= SHAKE_MAX && s.over < 0.3 && s.luma > 0.05 && s.sharp >= med * 0.5;
    const out = [];
    let a = -1;
    for (let i = 0; i <= samples.length; i++) {
      const g = i < samples.length && good(samples[i]);
      if (g && a < 0) a = i;
      if (!g && a >= 0) {
        const t0 = samples[a].t, t1 = Math.min(duration, samples[i - 1].t + step);
        if (t1 - t0 >= RANGE_MIN) {
          const part = samples.slice(a, i);
          const pan = part.reduce((m, s) => m + Math.hypot(s.vx, s.vy), 0) / part.length;
          out.push({ in: r1(t0), out: r1(t1), motion: pan < 1.5 ? 'static' : 'moving' });
        }
        a = -1;
      }
    }
    return out;
  }
  // 摘要包裡的緊湊格式：每個數據一條陣列（整數），省空間
  function packSeries(samples, step) {
    const pc = v => Math.round(clamp(v, 0, 1) * 100);
    const mx = samples.reduce((m, s) => Math.max(m, s.sharp), 0) || 1;
    return {
      step,
      luma: samples.map(s => pc(s.luma)), over: samples.map(s => pc(s.over)), under: samples.map(s => pc(s.under)),
      sharp: samples.map(s => Math.round(s.sharp / mx * 100)),
      panX: samples.map(s => Math.round(s.vx)), panY: samples.map(s => Math.round(s.vy)),
      shake: samples.map(s => Math.round(s.shake)), change: samples.map(s => pc(s.change * 4)),
    };
  }

  // ---- 音樂能量 -------------------------------------------------------------------------
  // 每 step 秒的 RMS，正規化成 0～100（最大的那一格＝100）
  function energy(channels, sampleRate, step = STEP) {
    const ch = channels[0], n = ch ? ch.length : 0, hop = Math.max(1, Math.round(sampleRate * step)), out = [];
    for (let i = 0; i < n; i += hop) {
      let s = 0; const e = Math.min(n, i + hop);
      for (let k = i; k < e; k += 4) { let v = 0; for (const c of channels) v += c[k]; v /= channels.length; s += v * v; }
      out.push(Math.sqrt(s / Math.max(1, (e - i) / 4)));
    }
    const mx = out.reduce((m, v) => Math.max(m, v), 0) || 1;
    return out.map(v => Math.round(v / mx * 100));
  }

  // ---- 伽瑪 -----------------------------------------------------------------------------
  // Sony 相機的 MP4 內嵌一段 XML（NonRealTimeMeta），裡面有 <Item name="CaptureGammaEquation" value="s-log3-cine"/>。
  // bytes：檔案頭或尾的一段。找得到回 { gamma: 'slog3'|'slog2'|'scinetone'|'hlg'|'std', raw }，找不到回 null。
  const GAMMAS = { std: '標準（Rec.709）', scinetone: 'S-Cinetone', slog3: 'S-Log3', slog2: 'S-Log2', hlg: 'HLG' };
  function detectGamma(bytes) {
    const key = 'CaptureGammaEquation', k0 = key.charCodeAt(0);
    outer: for (let i = 0; i + key.length < bytes.length; i++) {
      if (bytes[i] !== k0) continue;
      for (let j = 1; j < key.length; j++) if (bytes[i + j] !== key.charCodeAt(j)) continue outer;
      let s = '';
      for (let j = i + key.length; j < Math.min(bytes.length, i + key.length + 96); j++) s += String.fromCharCode(bytes[j]);
      const m = /value\s*=\s*"([^"]{1,60})"/.exec(s);
      if (!m) continue;
      const raw = m[1], v = raw.toLowerCase();
      const gamma = /s-?log3/.test(v) ? 'slog3' : /s-?log2/.test(v) ? 'slog2' : /cinetone/.test(v) ? 'scinetone' : /hlg/.test(v) ? 'hlg' : 'std';
      return { gamma, raw };
    }
    return null;
  }
  // 沒有內嵌資訊時從畫面猜：Log 的黑不黑（1% 亮度偏高）、白不白（99% 亮度偏低）、顏色很淡
  function looksLog(samples) {
    if (!samples.length) return false;
    const avg = k => samples.reduce((m, s) => m + s[k], 0) / samples.length;
    return avg('p1') > 0.07 && avg('p99') < 0.8 && avg('sat') < 0.18;
  }

  // ---- S-Log3 → Rec.709（近似）-----------------------------------------------------------
  // S-Log3 曲線是 Sony 公開的公式；色域 S-Gamut3.Cine → Rec.709 用兩邊的原色座標算矩陣；最後接一條簡單的肩部曲線＋gamma 2.4。
  // 和 Sony 官方的 s709 LUT 不會完全一樣（官方 LUT 另有自己的色調與飽和度設計），所以預設還是請使用者匯入自己的 LUT。
  function slog3ToLinear(v) {
    const c = v * 1023;
    return c >= 171.2102946929 ? Math.pow(10, (c - 420) / 261.5) * 0.19 - 0.01 : (c - 95) * 0.01125 / (171.2102946929 - 95);
  }
  const inv3 = m => {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  };
  const mul3 = (m, n) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => m[r * 3] * n[c] + m[r * 3 + 1] * n[3 + c] + m[r * 3 + 2] * n[6 + c]));
  // 原色座標 → RGB 轉 XYZ 的矩陣（白點 D65）
  function rgbToXyz(p) {
    const X = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const [r, g, b] = p.map(X), w = X([0.3127, 0.329]);
    const M = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]], I = inv3(M);
    const S = [0, 1, 2].map(k => I[k * 3] * w[0] + I[k * 3 + 1] * w[1] + I[k * 3 + 2] * w[2]);
    return M.map((v, k) => v * S[k % 3]);
  }
  const SG3C_TO_709 = mul3(inv3(rgbToXyz([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]])), rgbToXyz([[0.766, 0.275], [0.225, 0.8], [0.089, -0.087]]));
  const tone = x => { x = Math.max(0, x); return Math.pow(clamp(x * (1 + x / 64) / (1 + x), 0, 1), 1 / 2.4); };
  function slog3Lut(size = 33) {
    const data = new Uint8Array(size ** 3 * 3), lin = [], M = SG3C_TO_709;
    for (let i = 0; i < size; i++) lin.push(slog3ToLinear(i / (size - 1)));
    let k = 0;
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
      const R = lin[r], G = lin[g], B = lin[b];
      data[k++] = Math.round(tone(M[0] * R + M[1] * G + M[2] * B) * 255);
      data[k++] = Math.round(tone(M[3] * R + M[4] * G + M[5] * B) * 255);
      data[k++] = Math.round(tone(M[6] * R + M[7] * G + M[8] * B) * 255);
    }
    return { name: 'S-Log3 → 709（內建近似）', size, data };
  }
  // 三線性內插讀 LUT（r、g、b 是 0～1；data 是 size³×3 個 0～255，R 變最快）
  function sampleLut(lut, r, g, b) {
    const n = lut.size, d = lut.data, m = n - 1;
    const fr = clamp(r, 0, 1) * m, fg = clamp(g, 0, 1) * m, fb = clamp(b, 0, 1) * m;
    const r0 = Math.min(m - 1, Math.floor(fr)), g0 = Math.min(m - 1, Math.floor(fg)), b0 = Math.min(m - 1, Math.floor(fb));
    const tr = fr - r0, tg = fg - g0, tb = fb - b0, out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const at = (x, y, z) => d[((z * n + y) * n + x) * 3 + c];
      const x00 = at(r0, g0, b0) * (1 - tr) + at(r0 + 1, g0, b0) * tr, x10 = at(r0, g0 + 1, b0) * (1 - tr) + at(r0 + 1, g0 + 1, b0) * tr;
      const x01 = at(r0, g0, b0 + 1) * (1 - tr) + at(r0 + 1, g0, b0 + 1) * tr, x11 = at(r0, g0 + 1, b0 + 1) * (1 - tr) + at(r0 + 1, g0 + 1, b0 + 1) * tr;
      out[c] = (x00 * (1 - tg) + x10 * tg) * (1 - tb) + (x01 * (1 - tg) + x11 * tg) * tb;
    }
    return out;
  }
  function applyLut(rgba, lut) {
    for (let j = 0; j < rgba.length; j += 4) {
      const o = sampleLut(lut, rgba[j] / 255, rgba[j + 1] / 255, rgba[j + 2] / 255);
      rgba[j] = o[0]; rgba[j + 1] = o[1]; rgba[j + 2] = o[2];
    }
    return rgba;
  }

  // ---- 聯絡表 ---------------------------------------------------------------------------
  // items：[{ code, duration（照片給 0 或 null）}]。回傳 { interval, cells: [{ code, t }], perSheet }：
  //   每 interval 秒拍一格（全部加起來超過 maxCells 就拉大間隔）；每支影片至少 2 格、照片 1 格。
  const SHEET = { cols: 4, rows: 5, width: 1568 };   // 1568＝Claude 看圖的長邊上限，再大會被縮小
  function planSheets(items, maxCells = 300) {
    const times = (dur, iv) => {
      if (!(dur > 0)) return [0];
      const ts = [];
      for (let t = 0; t < dur - 0.05; t += iv) ts.push(r1(t));
      if (ts.length < 2 && dur > 1) ts.push(r1(dur / 2));
      return ts;
    };
    let interval = 30;
    for (const iv of [1, 2, 3, 5, 10, 15, 30]) {
      if (items.reduce((m, it) => m + times(it.duration, iv).length, 0) <= maxCells) { interval = iv; break; }
    }
    const cells = [];
    for (const it of items) for (const t of times(it.duration, interval)) cells.push({ code: it.code, t });
    return { interval, cells: cells.slice(0, Math.max(maxCells, items.length)), perSheet: SHEET.cols * SHEET.rows };
  }

  // ---- 摘要包 ---------------------------------------------------------------------------
  // caps：{ transitions, looks, motions, fits, aspects, letterboxes, titlePresets: { 名稱: 說明 }, cc }
  function forClaude(caps) {
    const tp = caps.titlePresets || {};
    return [
      '這是 QuickCut（網頁剪輯工具）匯出的「素材摘要包」。使用者會描述想要的影片風格，請你當剪輯師：看聯絡表挑鏡頭、決定順序與節奏，回一份「剪輯腳本」JSON，使用者會把它貼回 QuickCut 自動排好。',
      '',
      '【怎麼讀這包資料】',
      '・聯絡表（sheet-01.jpg…）：每一格左上角印著「代號 秒數」，例如「C03 12.0s」＝素材 C03 的第 12 秒。Log 素材已轉成正常顏色。',
      '・clips[].series：每 step 秒一筆。luma 亮度、over 過曝％、under 死黑％、sharp 清晰度（該支最高＝100）、panX／panY 鏡頭造成的畫面位移（每秒％畫面寬高；panX 負＝鏡頭往右搖）、shake 晃動（>5 算晃）、change 畫面變化量（高＝有東西在動或鏡頭在動）。',
      '・clips[].ranges：工具算的「建議可用區間」（不晃、不過曝、夠清晰），static＝幾乎不動、moving＝有運鏡。可以不照用，但選在區間外要有理由。',
      '・music.beats：拍點（秒）。music.energy：每 energyStep 秒的音量（0～100），用來找副歌、高潮、收尾。',
      '',
      '【回覆規則】',
      '・先用 3～5 行說明剪輯構想（開場、轉折、收尾各用什麼畫面、為什麼），再給腳本。腳本放在一個 ```json 區塊裡，內容必須是合法 JSON（不能有註解、結尾逗號）。',
      '・media 對照表要原樣抄回（代號 → 檔名），工具靠檔名認素材。',
      '・只能用下面「可用的東西」列出的名稱；出現不認得的名稱，工具會整份拒絕。',
      '・同一支素材可以用好幾次，但不要重疊同一段畫面；每段的 in＋長度×速度不能超過素材長度。',
      '・有音樂時，長度盡量用拍數（dur.beats）寫，工具會用實際拍點對齊；沒有音樂才用秒數（dur.sec）。',
      '・輸出是直式而素材是橫拍時，工具會裁切填滿。請看聯絡表決定 reframe.x（0＝保留最左、0.5＝中間、1＝最右），讓主體留在畫面裡；想要水平運鏡就寫 { "from": 0.3, "to": 0.7 }。',
      '・使用者不滿意時會回來說要改哪裡，請回「完整的新腳本」，不要只給片段。',
      '',
      '【腳本格式】',
      '{',
      '  "qcScript": 1,',
      '  "media": { "C01": "檔名.MP4", "M1": "音樂.mp3" },          ← 原樣抄回',
      '  "output": { "aspect": "9:16" },                             ← 可省略（不改專案的比例）',
      '  "music": { "ref": "M1", "in": 12.0, "fadeOut": 1.5, "gainDb": 0 },   ← 可省略＝不放音樂；in＝從音樂第幾秒開始',
      '  "grade": { "look": "warm", "lookAmt": 30, "cc": { "contrast": 8, "sat": 5 } },   ← 整支影片的調色，可省略',
      '  "fadeIn": 0.5, "fadeOut": 1.0,                             ← 開頭從黑淡入、結尾淡出到黑（秒），可省略',
      '  "letterbox": "2.39",                                       ← 電影黑邊，可省略',
      '  "shots": [',
      '    { "ref": "C03", "in": 12.0, "dur": { "beats": 4 },       ← in＝從素材第幾秒開始；dur 寫 beats 或 sec',
      '      "speed": 1,                                            ← 0.1～8；0.5＝慢動作（高 fps 素材才順）',
      '      "reframe": { "x": 0.62 },                              ← 或 { "from": 0.3, "to": 0.7 }；也可以加 "y"',
      '      "fit": "fill",                                         ← 可省略（比例不同預設 fill）',
      '      "motion": "zoomIn", "motionAmt": 0.15,                 ← 慢慢放大／縮小／平移；可省略',
      '      "trans": { "type": "crossDissolve", "sec": 0.5 },      ← 從「上一段」進到這一段的轉場；省略＝直接切',
      '      "grade": { "cc": { "exposure": 0.3 } },                ← 只改這一段（會和整支的 grade 合併），可省略',
      '      "keepAudio": false,                                    ← true＝保留這段的原聲',
      '      "note": "開場：山稜線晨光" }                           ← 給使用者看的說明',
      '  ],',
      '  "titles": [ { "text": "花蓮・清晨", "atShot": 0, "offsetSec": 0.3, "sec": 2.5, "preset": "fadeUp", "x": 0.5, "y": 0.8, "size": 64, "color": "#ffffff" } ]',
      '}',
      '',
      '【可用的東西】',
      `・輸出比例 aspect：${caps.aspects.join('、')}`,
      `・轉場 trans.type：${caps.transitions.join('、')}（sec 0.1～3；dipToColor 可加 "color": "#rrggbb"）`,
      `・動態 motion：none、${caps.motions.join('、')}（motionAmt 0.02～1，預設 0.15）`,
      `・濾鏡 grade.look：${caps.looks.join('、')}（lookAmt 0～100）`,
      `・調色 grade.cc：${caps.cc.join('、')}（exposure ±3 EV，其他 ±100；一般調整在 ±20 以內）`,
      `・放法 fit：${caps.fits.join('、')}（fit＝完整含黑邊、blur＝模糊背景、fill＝裁切填滿、stretch＝拉伸）`,
      `・電影黑邊 letterbox：${caps.letterboxes.join('、')}`,
      `・字幕樣式 titles[].preset：${Object.keys(tp).map(k => `${k}（${tp[k]}）`).join('、')}；x、y 是 0～1 的位置，size 8～300`,
      '',
      '【這個工具做不到的】防震、去背、追蹤、AI 生成畫面、自動上字幕。腳本裡不要寫這些。',
    ].join('\n');
  }
  // o：{ project, clips: [{ code, name, kind, duration, width, height, fps, hasAudio, gamma, gammaFrom, samples, step }], music, sheets, caps, interval }
  function buildSummary(o) {
    const media = {};
    for (const c of o.clips) media[c.code] = c.name;
    if (o.music) media[o.music.code] = o.music.name;
    const p = o.project;
    return {
      qcSummary: 1,
      forClaude: forClaude(o.caps),
      project: { aspect: p.aspect === 'source' ? `${p.width}:${p.height}` : p.aspect, width: p.width, height: p.height, fps: p.fps },
      media,
      clips: o.clips.map(c => {
        const base = { code: c.code, file: c.name, kind: c.kind, width: c.width, height: c.height };
        if (c.kind === 'image') return base;
        const samples = finishSeries(c.samples || []);
        return Object.assign(base, {
          duration: Math.round(c.duration * 100) / 100, fps: c.fps, slowMoOk: c.fps >= 50, hasAudio: !!c.hasAudio,
          gamma: c.gamma || 'std', gammaFrom: c.gammaFrom || 'default',
          ranges: suggestRanges(samples, c.step, c.duration), series: packSeries(samples, c.step),
        });
      }),
      music: o.music ? { code: o.music.code, file: o.music.name, duration: Math.round(o.music.duration * 100) / 100, bpm: o.music.bpm || 0, beats: o.music.beats || [], energyStep: STEP, energy: o.music.energy || [] } : null,
      sheets: { interval: o.interval, files: o.sheets || [] },
    };
  }

  // ---- 讀腳本 ---------------------------------------------------------------------------
  // 整份 JSON、或 Claude 的整段回覆（裡面有 ```json 區塊）都可以
  function parseScriptText(text) {
    text = String(text || '').trim();
    if (!text) return { ok: false, reason: '還沒貼上腳本' };
    const tries = [text];
    const re = /```(?:json)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) tries.push(m[1].trim());
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
    let last = '';
    for (const s of tries) {
      try {
        const v = JSON.parse(s);
        if (v && typeof v === 'object' && v.qcScript != null) return { ok: true, script: v };
        if (v && typeof v === 'object' && v.qcSummary != null) return { ok: false, reason: '這是素材摘要包，不是剪輯腳本：請把摘要包交給 Claude，貼回它寫的腳本' };
      } catch (e) { last = e.message; }
    }
    return { ok: false, reason: '讀不出剪輯腳本：內容不是合法的 JSON，或缺少 "qcScript"' + (last ? `（${last}）` : '') };
  }

  const api = { AW, AH, STEP, PAIR, SHAKE_MAX, SHEET, GAMMAS, sampleStep, frameStats, shift, diff, finishSeries, suggestRanges, packSeries, energy,
    detectGamma, looksLog, slog3ToLinear, slog3Lut, sampleLut, applyLut, planSheets, forClaude, buildSummary, parseScriptText };
  Q.ai = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
