// =====================================================================================
// 剪輯：節拍偵測（純計算、不碰 DOM；瀏覽器掛在 QPTEdit.beat，node 用 module.exports）
//
//   detect(channels, sampleRate, o) → { bpm, beats: [秒], confidence }
//     channels：Float32Array 的陣列（AudioBuffer 每個聲道），o.from／o.to 只分析這一段（秒）
//
// 做法（Ellis 2007 的動態規劃節拍追蹤，簡化版）：
//   1. 起音強度（novelty）：每 HOP 個取樣算一次「低頻能量」與「全頻能量」的對數差，只留變大的部分
//      （大鼓、小鼓、刷弦的瞬間都會變大），再扣掉附近的平均，留下突出的部分。
//   2. 速度：novelty 的自相關在 60～200 BPM 範圍找最強的週期，偏好 120 BPM 附近（避免抓成一半或兩倍）。
//   3. 每一拍的位置：動態規劃。每一點的分數＝自己的起音強度＋前一拍的分數−「和理想間隔差多少」的懲罰，
//      最後從分數最高的尾巴往回找。速度稍微飄移、有切分音也追得住。
// =====================================================================================
(function (root) {
  'use strict';
  const Q = root.QPTEdit = root.QPTEdit || {};

  const ENV_RATE = 100;          // novelty 每秒幾點（10ms 一點）
  const BPM_MIN = 60, BPM_MAX = 200, BPM_PREFER = 120;
  const TIGHTNESS = 100;         // 動態規劃：偏離理想間隔的懲罰強度（越大越死板）

  // 一階低通（RC）係數
  const lpCoef = (fc, sr) => 1 - Math.exp(-2 * Math.PI * fc / sr);

  // 1. 起音強度包絡
  function novelty(channels, sr, from, to) {
    const a = Math.max(0, Math.floor(from * sr)), b = Math.min(channels[0].length, Math.ceil(to * sr));
    const hop = Math.max(1, Math.round(sr / ENV_RATE));
    const n = Math.max(0, Math.floor((b - a) / hop));
    const low = new Float64Array(n), full = new Float64Array(n);
    const k = lpCoef(150, sr), nc = channels.length;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      let el = 0, ef = 0;
      const s0 = a + i * hop;
      for (let j = 0; j < hop; j++) {
        let x = 0;
        for (let c = 0; c < nc; c++) x += channels[c][s0 + j];
        x /= nc;
        lp += k * (x - lp);
        el += lp * lp; ef += x * x;
      }
      low[i] = Math.log(1e-10 + el / hop); full[i] = Math.log(1e-10 + ef / hop);
    }
    const nov = new Float64Array(n);
    for (let i = 1; i < n; i++) nov[i] = Math.max(0, low[i] - low[i - 1]) * 1.5 + Math.max(0, full[i] - full[i - 1]);
    // 扣掉附近（±0.25 秒）的平均：只留突出的起音；再正規化到標準差 1
    const W = Math.round(ENV_RATE * 0.25), out = new Float64Array(n);
    let sum = 0, cnt = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      while (hi < Math.min(n - 1, i + W)) { hi++; sum += nov[hi]; cnt++; }
      while (lo < i - W) { sum -= nov[lo]; lo++; cnt--; }
      out[i] = Math.max(0, nov[i] - sum / cnt);
    }
    let m = 0, v = 0;
    for (let i = 0; i < n; i++) m += out[i];
    m /= n || 1;
    for (let i = 0; i < n; i++) v += (out[i] - m) * (out[i] - m);
    const sd = Math.sqrt(v / (n || 1)) || 1;
    for (let i = 0; i < n; i++) out[i] /= sd;
    out.rate = sr / hop;                            // 實際每秒幾點（hop 四捨五入過，不一定剛好 ENV_RATE）
    return out;
  }

  // 2. 速度（每拍幾點）：自相關＋偏好 120 BPM 附近的權重；回傳 { period, score }
  function tempo(nov) {
    const n = nov.length, rate = nov.rate || ENV_RATE;
    const lagMin = Math.floor(rate * 60 / BPM_MAX), lagMax = Math.min(n - 1, Math.ceil(rate * 60 / BPM_MIN));
    if (lagMax <= lagMin) return null;
    const ac = new Float64Array(lagMax + 2);
    for (let L = lagMin - 1; L <= lagMax + 1 && L < n; L++) {
      let s = 0;
      for (let i = L; i < n; i++) s += nov[i] * nov[i - L];
      ac[L] = s / (n - L);
    }
    let best = -1, bestL = 0;
    const prefer = rate * 60 / BPM_PREFER;
    for (let L = lagMin; L <= lagMax; L++) {
      const w = Math.exp(-0.5 * Math.pow(Math.log2(L / prefer) / 0.9, 2));
      const sc = ac[L] * w;
      if (sc > best) { best = sc; bestL = L; }
    }
    if (bestL <= 0) return null;
    // 拋物線內插讓週期有小數（速度更準）
    const y0 = ac[bestL - 1], y1 = ac[bestL], y2 = ac[bestL + 1];
    const d = y0 - 2 * y1 + y2;
    const off = d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / d)) : 0;
    let ac0 = 0;
    for (let i = 0; i < n; i++) ac0 += nov[i] * nov[i];
    ac0 /= n || 1;
    return { period: bestL + off, score: ac0 > 0 ? y1 / ac0 : 0 };
  }

  // 3. 動態規劃追蹤每一拍；回傳 novelty 的索引
  function track(nov, period) {
    const n = nov.length;
    const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
    const pmin = Math.max(1, Math.round(period / 2)), pmax = Math.round(period * 2);
    for (let i = 0; i < n; i++) {
      let best = 0, arg = -1;
      for (let j = i - pmax; j <= i - pmin; j++) {
        if (j < 0) continue;
        const r = Math.log((i - j) / period);
        const s = score[j] - TIGHTNESS * r * r;
        if (arg < 0 || s > best) { best = s; arg = j; }
      }
      score[i] = nov[i] + (arg >= 0 ? Math.max(0, best) : 0);
      back[i] = arg >= 0 && best > 0 ? arg : -1;
    }
    // 尾巴：最後一個週期內分數最高的點
    let end = n - 1, top = -Infinity;
    for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > top) { top = score[i]; end = i; }
    const out = [];
    for (let i = end; i >= 0; i = back[i]) { out.push(i); if (back[i] < 0) break; }
    out.reverse();
    // 開頭：往前補齊（第一拍之前如果還有完整的拍子，照週期補上，落在起音最強的附近）
    const fill = [];
    for (let t = out[0] - period; t >= 0; t -= period) {
      const c = Math.round(t), w = Math.max(1, Math.round(period * 0.1));
      let bi = c, bv = -1;
      for (let j = Math.max(0, c - w); j <= Math.min(n - 1, c + w); j++) if (nov[j] > bv) { bv = nov[j]; bi = j; }
      fill.push(bi); t = bi;
    }
    return fill.reverse().concat(out);
  }

  function detect(channels, sampleRate, o = {}) {
    const chans = Array.isArray(channels) ? channels : [channels];
    if (!chans.length || !chans[0] || !(sampleRate > 0)) return { bpm: 0, beats: [], confidence: 0 };
    const total = chans[0].length / sampleRate;
    const from = Math.max(0, Number(o.from) || 0), to = Math.min(total, o.to == null ? total : Number(o.to));
    if (!(to - from >= 2)) return { bpm: 0, beats: [], confidence: 0 };     // 太短（少於 2 秒）抓不出速度
    const nov = novelty(chans, sampleRate, from, to);
    const tp = tempo(nov);
    if (!tp) return { bpm: 0, beats: [], confidence: 0 };
    const idx = track(nov, tp.period);
    const rate = nov.rate;
    const beats = idx.map(i => Math.round((from + i / rate) * 1000) / 1000);
    return { bpm: Math.round(60 * rate / tp.period * 10) / 10, beats, confidence: Math.max(0, Math.min(1, tp.score)) };
  }

  const api = { detect, ENV_RATE, _internal: { novelty, tempo, track } };
  Q.beat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
