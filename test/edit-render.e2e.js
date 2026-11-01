// =====================================================================================
// 剪輯：播放與合成引擎（edit-render.js）的瀏覽器測試
// 執行：node test/edit-render.e2e.js
// （不叫 *.test.js：需要 Chromium，不讓 node --test 去跑它）
//
// 素材：環境變數 EDIT_FIXTURES 指定的資料夾；沒有就用 ffmpeg 產生到暫存資料夾（VP9／Opus＋PNG）。
// 對照畫格用 ffmpeg 解出來，比對 seekSource 拿到的是不是那一格。
// edit-core.js／edit-fx.js 還是佔位時，會注入 EDIT_STUBS 指定的替身（只補缺的函式）。
// =====================================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const REPO = path.resolve(__dirname, '..');
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const FILES = ['landscape-720p-6s.webm', 'noaudio-25fps-3s.webm', 'music-8s.webm', 'still.png'];

function ffmpeg(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' }); }

function fixturesDir() {
  const want = process.env.EDIT_FIXTURES;
  if (want && FILES.every(f => fs.existsSync(path.join(want, f)))) return want;
  const dir = path.join(os.tmpdir(), 'qc-render-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const has = f => fs.existsSync(path.join(dir, f));
  const out = f => path.join(dir, f);
  if (!has(FILES[0])) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
    '-ac', '2', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest', out(FILES[0])]);
  if (!has(FILES[1])) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-c:v', 'libvpx-vp9', '-b:v', '500k', out(FILES[1])]);
  if (!has(FILES[2])) ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', out(FILES[2])]);
  if (!has(FILES[3])) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', out(FILES[3])]);
  return dir;
}

// ffmpeg 解出第 45、46 格當對照
function refFrames(fix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-ref-'));
  ffmpeg(['-i', path.join(fix, FILES[0]), '-vf', "select='eq(n\\,45)+eq(n\\,46)'", '-vsync', '0', path.join(dir, 'ref%d.png')]);
  return dir;
}

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<script src="/repo/edit-core.js"></script>
<script src="/repo/edit-fx.js"></script>
<script src="/repo/edit-fx-gl.js"></script>
<script src="/repo/edit-render.js"></script>
<script>
// ---- 頁面端的小工具 ----
window.T = {
  async file(name, type) { const b = await (await fetch('/fx/' + name)).blob(); return new File([b], name, { type }); },
  track(id, kind, o) { return Object.assign({ id, kind, name: id.toUpperCase(), locked: false, muted: false, hidden: false, solo: false }, o); },
  project(o) {
    return Object.assign({ version: 1, fps: 30, aspect: 'source', width: 1280, height: 720, bgColor: '#000000',
      tracks: [T.track('v1', 'video'), T.track('v2', 'video'), T.track('a1', 'audio'), T.track('a2', 'audio')],
      clips: {}, transitions: {}, markers: [], inPoint: null, outPoint: null, nextId: 100, mediaInfo: {} }, o);
  },
  clip(id, trackId, o) {
    return Object.assign({ id, trackId, type: 'media', mediaId: null, start: 0, duration: 30, srcIn: 0, speed: 1, reverse: false, freeze: false,
      linkId: null, enabled: true, name: '', flags: [], markers: [],
      video: { transform: { zoomX: 1, zoomY: 1, zoomLinked: true, posX: 0, posY: 0, rotation: 0, anchorX: 0, anchorY: 0, opacity: 1, flipH: false, flipV: false },
               crop: { left: 0, right: 0, top: 0, bottom: 0, softness: 0 }, fit: 'fit', composite: 'normal' },
      audio: { gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, fadeInCurve: 0, fadeOutCurve: 0, eq: { enabled: false, bands: [
        { on: true, type: 'highpass', freq: 80, gain: 0, q: 0.7 }, { on: true, type: 'lowshelf', freq: 200, gain: 0, q: 0.7 },
        { on: true, type: 'peaking', freq: 500, gain: 0, q: 1 }, { on: true, type: 'peaking', freq: 1500, gain: 0, q: 1 },
        { on: true, type: 'highshelf', freq: 5000, gain: 0, q: 0.7 }, { on: true, type: 'lowpass', freq: 18000, gain: 0, q: 0.7 } ] } },
      title: null, solidColor: null, keyframes: {}, retime: null }, o);
  },
  put(p, ...clips) { for (const c of clips) p.clips[c.id] = c; return p; },
  canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
  pixels(src, w, h) { const c = T.canvas(w, h), g = c.getContext('2d'); g.drawImage(src, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; },
  diff(a, b) { let s = 0, n = 0; for (let i = 0; i < a.length; i += 4) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; } return s / n; },
  mean(a) { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return s / (a.length / 4 * 3); },
  rms(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); },
  crossings(x, a, b) { let n = 0; for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++; return n; },
  // seekSource 回傳的 VideoFrame 取完像素就關掉
  async snap(pr, w, h) { const s = await pr; const px = T.pixels(s, w, h); T.close(s); return px; },
  close(s) { if (typeof VideoFrame !== 'undefined' && s instanceof VideoFrame) s.close(); },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};
</script>`;

function serve(fix, ref) {
  const types = { '.js': 'text/javascript', '.webm': 'video/webm', '.png': 'image/png', '.css': 'text/css', '.html': 'text/html' };
  return http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/' || u === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(PAGE); }
    const map = [['/repo/', REPO], ['/fx/', fix], ['/ref/', ref]].find(([pre]) => u.startsWith(pre));
    const file = map && path.join(map[1], path.normalize(u.slice(map[0].length)).replace(/^(\.\.[/\\])+/, ''));
    if (!file || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? '：' + JSON.stringify(detail) : ''}`); }
}

(async () => {
  const fix = fixturesDir();
  const ref = refFrames(fix);
  const srv = serve(fix, ref);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browser = await chromium.launch({ executablePath: EXE, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.goto(`http://localhost:${port}/`);

  // 子任務 A／D 還沒完成時注入替身
  const missing = await page.evaluate(() => {
    const Q = window.QPTEdit || {};
    return !(Q.core && typeof Q.core.sourceTimeAt === 'function' && Q.fx && typeof Q.fx.drawClipVisual === 'function' && Q.fx.TRANSITIONS);
  });
  if (missing) {
    const stub = process.env.EDIT_STUBS;
    if (!stub || !fs.existsSync(stub)) { console.error('edit-core.js／edit-fx.js 尚未完成，請用 EDIT_STUBS 指定替身檔'); process.exit(2); }
    await page.addScriptTag({ path: stub });
    console.log('（core／fx 尚未完成，使用替身：' + stub + '）');
  } else console.log('（使用真正的 edit-core.js／edit-fx.js）');

  // ---------------------------------------------------------------------------------
  console.log('媒體匯入');
  const imp = await page.evaluate(async () => {
    const R = QPTEdit.render;
    const files = [
      await T.file('landscape-720p-6s.webm', 'video/webm'), await T.file('noaudio-25fps-3s.webm', 'video/webm'),
      await T.file('music-8s.webm', 'video/webm'), await T.file('still.png', 'image/png'),
      new File(['hello'], '說明.txt', { type: 'text/plain' }),
      new File([new Uint8Array(4096).map((_, i) => (i * 37) & 255)], '壞掉.mp4', { type: 'video/mp4' }),
      new File([new Uint8Array(100)], 'IMG_0001.HEIC', { type: '' }),
    ];
    const t0 = performance.now();
    const ms = await R.media.import(files);
    const sum = m => ({ id: m.id, kind: m.kind, w: m.width, h: m.height, fps: m.fps, dur: m.duration === Infinity ? 'Inf' : m.duration,
      hasAudio: m.hasAudio, thumbs: m.thumbs.length, thumbH: m.thumbs[0] && m.thumbs[0].bitmap.height,
      peaks: m.peaks ? m.peaks.length : null, peakMax: m.peaks ? Math.max(...m.peaks) : null, url: m.url.startsWith('blob:'), warning: m.warning });
    const a1 = await R.media.decodeAudio(ms[0].id), a2 = await R.media.decodeAudio(ms[0].id);
    // remove：revoke objectURL
    const [tmp] = await R.media.import([await T.file('still.png', 'image/png')]);
    const url = tmp.url, removed = R.media.remove(tmp.id);
    let revoked = false;
    try { await fetch(url); } catch (_) { revoked = true; }
    window.M = { L: ms[0].id, N: ms[1].id, S: ms[2].id, I: ms[3].id };
    return { list: ms.map(sum), errors: ms.errors, cached: a1 === a2 && !!a1, removed, gone: R.media.get(tmp.id) === null, revoked, ms: performance.now() - t0 };
  });
  const [L, N, S, I] = imp.list;
  check('匯入 4 個成功、3 個失敗', imp.list.length === 4 && imp.errors.length === 3, { ok: imp.list.length, errors: imp.errors });
  check('失敗訊息是繁中且含檔名', imp.errors.every(e => /[一-鿿]/.test(e.message) && e.message.includes(e.name)), imp.errors);
  check('HEIC 有專門的提示', imp.errors.some(e => /HEIC/.test(e.message) && /JPG/.test(e.message)));
  check('橫式影片：video 1280×720、30fps、約 6 秒、有聲音', L.kind === 'video' && L.w === 1280 && L.h === 720 && L.fps === 30 && Math.abs(L.dur - 6) < 0.1 && L.hasAudio, L);
  check('橫式影片：縮圖條（約每 2 秒一張）、高 72、波形約 600 點', L.thumbs === Math.ceil(L.dur / 2) && L.thumbH === 72 && Math.abs(L.peaks - 600) <= 2 && L.peakMax > 0.05, L);
  check('無聲影片：25fps、沒有聲音、沒有波形', N.kind === 'video' && N.fps === 25 && !N.hasAudio && N.peaks === null && N.w === 640, N);
  check('純音訊（.webm）：kind=audio、約 8 秒、沒有縮圖', S.kind === 'audio' && Math.abs(S.dur - 8) < 0.1 && S.hasAudio && S.thumbs === 0 && S.peaks > 790, S);
  check('純音訊（.webm，MIME video/webm）：不會誤報「影像編碼不支援」', S.warning === '', S.warning);
  const sniff = await page.evaluate(async () => {
    const H = QPTEdit.render._internal.hasUnplayableVideo;
    const box = (handler, pad) => { const u = new Uint8Array(pad + 24); const w = (o, s) => { for (let i = 0; i < 4; i++) u[o + i] = s.charCodeAt(i); }; w(pad, 'hdlr'); w(pad + 12, handler); return u; };
    return {
      mp4Video: await H(new File([box('vide', 100)], 'clip.mp4', { type: 'video/mp4' })),
      mp4Audio: await H(new File([box('soun', 100)], 'voice.mp4', { type: 'video/mp4' })),
      movTail: await H(new File([new Uint8Array(5 << 20), box('vide', 0)], 'tail.mov', { type: 'video/quicktime' })),
      webm: await H(new File([box('vide', 0)], 'rec.webm', { type: 'video/webm' })),
      mkv: await H(new File([new Uint8Array(10)], 'x.mkv', { type: 'video/x-matroska' })),
    };
  });
  check('影像軌嗅探：MP4 有 vide 才算有影像（含 moov 在檔尾）；WebM 一律不算；MKV 保守當有', sniff.mp4Video && !sniff.mp4Audio && sniff.movTail && !sniff.webm && sniff.mkv, sniff);
  check('圖片：1600×1200、長度無限、1 張縮圖', I.kind === 'image' && I.w === 1600 && I.h === 1200 && I.dur === 'Inf' && I.thumbs === 1, I);
  check('decodeAudio 有快取', imp.cached);
  check('remove 釋放 objectURL', imp.removed && imp.gone && imp.revoked, imp);

  // ---------------------------------------------------------------------------------
  console.log('seekSource（對照 ffmpeg 解出的畫格）');
  const sk = await page.evaluate(async () => {
    const R = QPTEdit.render;
    const ref = async n => createImageBitmap(await (await fetch('/ref/ref' + n + '.png')).blob());
    const r45 = T.pixels(await ref(1), 320, 180), r46 = T.pixels(await ref(2), 320, 180);
    const a = await T.snap(R.seekSource(M.L, 45 / 30), 320, 180);
    const b = await T.snap(R.seekSource(M.L, 46 / 30), 320, 180);
    const back = await T.snap(R.seekSource(M.L, 45 / 30), 320, 180);     // 往回跳
    const end = await R.seekSource(M.L, 99).then(() => true, () => false);  // 超過結尾夾住
    const img = await R.seekSource(M.I, 0);
    return { a45: T.diff(a, r45), a46: T.diff(a, r46), b46: T.diff(b, r46), b45: T.diff(b, r45), back: T.diff(back, r45), end, img: img instanceof ImageBitmap };
  });
  check('第 45 格和 ffmpeg 一致（差異遠小於相鄰格）', sk.a45 < 4 && sk.a45 * 3 < sk.a46, sk);
  check('第 46 格和 ffmpeg 一致', sk.b46 < 4 && sk.b46 * 3 < sk.b45, sk);
  check('往回跳也正確', sk.back < 4, sk);
  check('超過結尾不會卡住；圖片回傳 ImageBitmap', sk.end && sk.img, sk);

  // ---------------------------------------------------------------------------------
  console.log('compose');
  const cp = await page.evaluate(async () => {
    const R = QPTEdit.render, C = QPTEdit.core;
    const out = {};
    const cv = T.canvas(1280, 720), g = cv.getContext('2d');
    const get = (c, t) => R.seekSource(c.mediaId, t);
    // 一般：V1 片段 srcIn 1.0，第 15 格 = 來源 1.5 秒 = 第 45 格
    const p = T.put(T.project(), T.clip('c1', 'v1', { mediaId: M.L, start: 0, duration: 60, srcIn: 1.0 }));
    await R.renderFrame(g, p, 15);
    const ref = await T.snap(R.seekSource(M.L, C.sourceTimeAt(p, p.clips.c1, 15)), 320, 180);
    out.normal = T.diff(T.pixels(cv, 320, 180), ref);
    const r45 = T.pixels(await createImageBitmap(await (await fetch('/ref/ref1.png')).blob()), 320, 180);
    out.vsFfmpeg = T.diff(T.pixels(cv, 320, 180), r45);
    // 直接用 compose＋自己的 getSource
    const src = await R.seekSource(M.L, C.sourceTimeAt(p, p.clips.c1, 20));
    out.isFrame = src instanceof VideoFrame;
    R.compose(g, p, 20, () => src);
    out.direct = T.diff(T.pixels(cv, 320, 180), T.pixels(src, 320, 180));
    // 預覽縮小的畫布
    const small = T.canvas(640, 360);
    R.compose(small.getContext('2d'), p, 20, () => src);
    out.small = T.diff(T.pixels(small, 320, 180), T.pixels(src, 320, 180));
    T.close(src);
    // 同一支素材連續要兩個時間（匯出端的用法）：兩個快照互不影響
    const s1 = await R.seekSource(M.L, 1.0), s2 = await R.seekSource(M.L, 2.0);
    out.twoSnaps = T.diff(T.pixels(s1, 160, 90), await T.snap(R.seekSource(M.L, 1.0), 160, 90)) < 1 && T.diff(T.pixels(s1, 160, 90), T.pixels(s2, 160, 90)) > 5;
    T.close(s1); T.close(s2);
    // 背景色、隱藏軌、停用片段
    const red = px => px[0] > 240 && px[1] < 15 && px[2] < 15;
    const p2 = T.put(T.project({ bgColor: '#ff0000' }), T.clip('c1', 'v1', { mediaId: M.L, duration: 60 }));
    p2.tracks[0].hidden = true;
    await R.renderFrame(g, p2, 10);
    out.hidden = red(g.getImageData(640, 360, 1, 1).data);
    p2.tracks[0].hidden = false; p2.clips.c1.enabled = false;
    await R.renderFrame(g, p2, 10);
    out.disabled = red(g.getImageData(640, 360, 1, 1).data);
    out.gap = (await R.renderFrame(g, p2, 90), red(g.getImageData(640, 360, 1, 1).data));
    // 色塊（V2）蓋在影片上
    const p3 = T.put(T.project(), T.clip('c1', 'v1', { mediaId: M.L, duration: 60 }),
      T.clip('s1', 'v2', { type: 'solid', mediaId: null, duration: 60, solidColor: '#00ff00', audio: null }));
    await R.renderFrame(g, p3, 10);
    const s = g.getImageData(640, 360, 1, 1).data;
    out.solid = s[1] > 240 && s[0] < 15 && s[2] < 15;
    // 標題（黑底白字）
    const p4 = T.put(T.project(), T.clip('t1', 'v1', { type: 'title', mediaId: null, duration: 60, audio: null,
      title: { text: '測試標題 TEST', preset: 'static', font: 'sans-serif', size: 120, color: '#ffffff', align: 'center',
        stroke: { color: '#000', width: 0 }, shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 },
        bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 }, lineHeight: 1.25, x: 0.5, y: 0.5 } }));
    await R.renderFrame(g, p4, 10);
    const d = g.getImageData(0, 0, 1280, 720).data;
    let white = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
    out.titlePx = white;
    // 轉場：交叉疊化，11 格置中 → 第 30 格 t = 0.5；左片段在剪接點之後從把手取畫格
    const p5 = T.put(T.project(), T.clip('a', 'v1', { mediaId: M.L, start: 0, duration: 30, srcIn: 0 }),
      T.clip('b', 'v1', { mediaId: M.L, start: 30, duration: 30, srcIn: 3.0 }));
    p5.transitions.x = { id: 'x', trackId: 'v1', leftClipId: 'a', rightClipId: 'b', type: 'crossDissolve', duration: 11, align: 'center', color: '#000000', direction: 'left', ease: 'linear' };
    out.range = R.transitionRange(p5, p5.transitions.x);
    out.srcs = R.sourcesAt(p5, 30).map(r => [r.clip.id, +r.time.toFixed(3)]);
    await R.renderFrame(g, p5, 30);
    const got = T.pixels(cv, 320, 180);
    const A = await T.snap(R.seekSource(M.L, out.srcs[0][1]), 320, 180);
    const B = await T.snap(R.seekSource(M.L, out.srcs[1][1]), 320, 180);
    const mix = A.map((v, i) => (v + B[i]) / 2);
    out.mix = T.diff(got, mix); out.mixVsA = T.diff(got, A); out.mixVsB = T.diff(got, B);
    // 轉場範圍外只畫一個片段
    await R.renderFrame(g, p5, 40);
    out.after = T.diff(T.pixels(cv, 320, 180), await T.snap(R.seekSource(M.L, C.sourceTimeAt(p5, p5.clips.b, 40)), 320, 180));
    // 單邊轉場（另一邊是背景，這裡背景是紅色）：開頭淡入／尾端淡出
    const redFrac = () => { const d = T.pixels(cv, 64, 36); let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++; return n / (d.length / 4); };
    const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    const p6 = T.put(T.project({ bgColor: '#ff0000' }), T.clip('b', 'v1', { mediaId: M.L, start: 0, duration: 60, srcIn: 1.0 }));
    const tr6 = (id, o) => Object.assign({ id, trackId: 'v1', leftClipId: null, rightClipId: null, type: 'crossDissolve', duration: 10, align: 'start', color: '#000000', direction: 'left', ease: 'linear' }, o);
    p6.transitions.h = tr6('h', { rightClipId: 'b' });
    out.single = { problems: C.checkInvariants(p6), range: R.transitionRange(p6, p6.transitions.h) };
    await R.renderFrame(g, p6, 0); out.single.in0 = redFrac();
    await R.renderFrame(g, p6, 9); out.single.in9 = redFrac();
    await R.renderFrame(g, p6, 20); out.single.in20 = redFrac();
    p6.transitions.h.type = 'fadeToBlack';
    await R.renderFrame(g, p6, 0); out.single.black0 = T.mean(T.pixels(cv, 64, 36)); out.single.black0red = redFrac();
    p6.transitions.h.type = 'wipe';      // 和背景擦拭：'left' = 畫面往左，片段從右邊進來
    await R.renderFrame(g, p6, 5); out.single.wipeL = at(100, 360); out.single.wipeR = at(1180, 360);
    p6.transitions.h.type = 'doors';     // WebGL 轉場走同一個 compose：兩扇門（背景）往外推開，中間露出片段
    await R.renderFrame(g, p6, 5); out.single.doorsL = at(60, 360); out.single.doorsC = at(640, 360);
    out.single.glOk = !!(window.QPTEdit.fxgl && window.QPTEdit.fxgl.available());
    delete p6.transitions.h;
    p6.transitions.t = tr6('t', { leftClipId: 'b', align: 'end' });
    await R.renderFrame(g, p6, 59); out.single.out59 = redFrac();
    await R.renderFrame(g, p6, 50); out.single.out50 = redFrac();
    return out;
  });
  check('指定格的像素 = seekSource 那一格', cp.normal < 1, cp);
  check('合成結果和 ffmpeg 的第 45 格一致', cp.vsFfmpeg < 4, cp);
  check('compose＋自訂 getSource（seekSource 回傳 VideoFrame）', cp.direct < 1 && cp.isFrame, cp);
  check('同一支素材的兩個快照互不影響', cp.twoSnaps, cp);
  check('縮小的預覽畫布也正確', cp.small < 3, cp);
  check('隱藏軌、停用片段、空白處只剩背景色', cp.hidden && cp.disabled && cp.gap, cp);
  check('色塊畫在 V2（上層）', cp.solid, cp);
  check('標題有畫出來', cp.titlePx > 300, cp.titlePx);
  check('轉場範圍：置中 [25, 36)', cp.range && cp.range.from === 25 && cp.range.to === 36, cp.range);
  check('轉場中兩個片段都取來源', cp.srcs.length === 2 && cp.srcs[0][0] === 'a' && cp.srcs[1][0] === 'b', cp.srcs);
  check('交叉疊化中點 ≈ 兩邊各半', cp.mix < 4 && cp.mix * 2 < cp.mixVsA && cp.mix * 2 < cp.mixVsB, cp);
  check('轉場結束後只剩右片段', cp.after < 1, cp);
  check('開頭淡入：範圍貼著片段開頭 [0,10)、不變式 OK', cp.single.range.from === 0 && cp.single.range.to === 10 && cp.single.problems.length === 0, cp.single);
  check('交叉疊化開頭淡入：第一格幾乎是背景色、結束時是片段', cp.single.in0 > 0.8 && Math.abs(cp.single.in9 - cp.single.in20) < 0.08, cp.single);   // in20：片段本身（測試圖卡有紅色色條）
  check('淡出到黑的開頭淡入：第一格接近黑色（不是背景紅）', cp.single.black0 < 30 && cp.single.black0red < 0.05, cp.single);
  check('擦拭開頭淡入：一半是背景、一半是片段', cp.single.wipeL[0] > 200 && cp.single.wipeL[1] < 60 && !(cp.single.wipeR[0] > 200 && cp.single.wipeR[1] < 60 && cp.single.wipeR[2] < 60), cp.single);
  check('WebGL 對開門開頭淡入（經過 compose）：兩側是背景、中間是片段', cp.single.glOk && cp.single.doorsL[0] > 200 && cp.single.doorsL[1] < 60 && !(cp.single.doorsC[0] > 200 && cp.single.doorsC[1] < 60 && cp.single.doorsC[2] < 60), cp.single);
  check('交叉疊化尾端淡出：最後一格幾乎是背景色', cp.single.out59 > 0.8 && Math.abs(cp.single.out50 - cp.single.in20) < 0.08, cp.single);

  // ---------------------------------------------------------------------------------
  console.log('renderFrame 部分來源失敗');
  const lk = await page.evaluate(async () => {
    const R = QPTEdit.render, VF = window.VideoFrame;
    // 暫時換成會計數的 VideoFrame（renderFrame 內部 new 的影格都會算到）
    const cnt = { made: 0, closed: 0 };
    const close = VF.prototype.close;
    VF.prototype.close = function () { if (!this.__c) { this.__c = 1; cnt.closed++; } return close.call(this); };
    window.VideoFrame = class extends VF { constructor(...a) { super(...a); cnt.made++; } };
    const p = T.put(T.put(T.project(), T.clip('a', 'v1', { mediaId: M.L, duration: 60 })), T.clip('b', 'v2', { mediaId: M.N, duration: 60 }));
    R.releaseSeekers();
    const m = R.media.get(M.N), keep = m.url;
    m.url = 'blob:' + location.origin + '/00000000-0000-0000-0000-000000000000';   // 讓 V2 的來源讀取失敗
    const g = new OffscreenCanvas(320, 180).getContext('2d');
    let err = '';
    try { await R.renderFrame(g, p, 5); } catch (e) { err = String(e && e.message || e); }
    m.url = keep; R.releaseSeekers();
    window.VideoFrame = VF; VF.prototype.close = close;
    return { err, ...cnt };
  });
  check('renderFrame：其中一個來源失敗會丟錯，其他已取得的 VideoFrame 都有關掉', !!lk.err && lk.made >= 1 && lk.made === lk.closed, lk);

  // ---------------------------------------------------------------------------------
  console.log('renderAudio');
  const au = await page.evaluate(async () => {
    const R = QPTEdit.render;
    const out = {};
    const base = o => T.put(T.project(), T.clip('m', 'a1', Object.assign({ mediaId: M.S, start: 0, duration: 60, srcIn: 1.0 }, o)));
    const render = (p, o) => R.renderAudio(p, Object.assign({ sampleRate: 48000, channels: 2 }, o));
    const b0 = await render(base(), { from: 0, to: 60 });
    out.len = b0.length; out.ch = b0.numberOfChannels;
    out.lenPart = (await render(base(), { from: 15, to: 45 })).length;
    out.lenDefault = (await render(base())).length;
    const rms0 = T.rms(b0.getChannelData(0));
    const p6 = base(); p6.clips.m.audio.gainDb = -6;
    out.gainRatio = T.rms((await render(p6, { from: 0, to: 60 })).getChannelData(0)) / rms0;
    const pp = base(); pp.clips.m.audio.pan = -1;
    const bp = await render(pp, { from: 0, to: 60 });
    out.panL = T.rms(bp.getChannelData(0)); out.panR = T.rms(bp.getChannelData(1));
    const pf = base(); pf.clips.m.audio.fadeIn = 15;
    const bf = (await render(pf, { from: 0, to: 60 })).getChannelData(0);
    out.fadeFirst = Math.abs(bf[0]); out.fadeEarly = T.rms(bf, 0, 2400) / rms0; out.fadeLate = T.rms(bf, 48000, 96000) / rms0;
    // 淡出 + 曲線
    const po = base(); po.clips.m.audio.fadeOut = 15; po.clips.m.audio.fadeOutCurve = 1;
    const bo = (await render(po, { from: 0, to: 60 })).getChannelData(0);
    out.fadeLast = Math.abs(bo[bo.length - 1]);
    // 倒播：輸出第 k 個樣本 = 原始（來源 1.0~3.0 秒）倒過來
    const orig = (await R.media.decodeAudio(M.S)).getChannelData(0);
    const pr = base({ reverse: true });
    const br = (await render(pr, { from: 0, to: 60 })).getChannelData(0);
    const end = Math.round(3.0 * 48000);
    let best = 1e9;
    for (let lag = -3; lag <= 3; lag++) {
      let e = 0;
      for (let k = 1000; k < 3000; k++) e += Math.abs(br[k] - orig[end - 1 - k + lag]);
      best = Math.min(best, e / 2000);
    }
    let fwd = 0;
    for (let k = 1000; k < 3000; k++) fwd += Math.abs(b0.getChannelData(0)[k] - orig[end - 1 - k]);
    out.revErr = best; out.fwdErr = fwd / 2000;
    // 速度 2×：440Hz 的聲音變 880Hz（音高會變，第一階段接受）
    const pl = T.put(T.project(), T.clip('m', 'a1', { mediaId: M.L, duration: 60 }));
    const z1 = T.crossings((await render(pl, { from: 0, to: 30 })).getChannelData(0), 0, 48000);
    pl.clips.m.speed = 2;
    const z2 = T.crossings((await render(pl, { from: 0, to: 30 })).getChannelData(0), 0, 48000);
    out.speedRatio = z2 / z1;
    // 定格靜音、軌道靜音、獨奏
    out.freeze = T.rms((await render(base({ freeze: true }), { from: 0, to: 60 })).getChannelData(0));
    const pm = base(); pm.tracks[2].muted = true;
    out.muted = T.rms((await render(pm, { from: 0, to: 60 })).getChannelData(0));
    const ps = base(); T.put(ps, T.clip('m2', 'a2', { mediaId: M.L, start: 0, duration: 60 })); ps.tracks[3].solo = true;
    const bs = (await render(ps, { from: 0, to: 60 })).getChannelData(0);
    out.soloHz = T.crossings(bs, 0, 48000) / 2;
    // EQ：低通 200Hz 會壓低 440Hz
    const pe = T.put(T.project(), T.clip('m', 'a1', { mediaId: M.L, duration: 60 }));
    const r1 = T.rms((await render(pe, { from: 0, to: 30 })).getChannelData(0), 4800);
    pe.clips.m.audio.eq.enabled = true; pe.clips.m.audio.eq.bands[5].freq = 200;
    out.eqRatio = T.rms((await render(pe, { from: 0, to: 30 })).getChannelData(0), 4800) / r1;
    const resp = R.eqResponse(pe.clips.m.audio.eq, [100, 440, 5000]);
    out.eqResp = Array.from(resp).map(v => +v.toFixed(1));
    return out;
  });
  check('長度 = 範圍長度（60 格 = 96000、30 格 = 48000、預設 = 整段）', au.len === 96000 && au.ch === 2 && au.lenPart === 48000 && au.lenDefault === 96000, au);
  check('增益 −6dB：RMS 約減半', Math.abs(au.gainRatio - 0.501) < 0.02, au.gainRatio);
  check('Pan −1：右聲道接近 0', au.panR < 1e-4 && au.panL > 0.05, [au.panL, au.panR]);
  check('淡入：第一個樣本接近 0，之後恢復', au.fadeFirst < 1e-3 && au.fadeEarly < 0.3 && Math.abs(au.fadeLate - 1) < 0.02, au);
  check('淡出：最後一個樣本接近 0', au.fadeLast < 0.02, au.fadeLast);
  check('倒播：樣本是反的', au.revErr < 1e-3 && au.fwdErr > 0.05, [au.revErr, au.fwdErr]);
  check('速度 2×：頻率加倍', Math.abs(au.speedRatio - 2) < 0.05, au.speedRatio);
  check('定格、軌道靜音都是無聲', au.freeze < 1e-6 && au.muted < 1e-6, au);
  check('獨奏只聽到獨奏軌（440Hz）', Math.abs(au.soloHz - 440) < 5, au.soloHz);
  check('EQ 低通有作用；頻率響應合理', au.eqRatio < 0.5 && au.eqResp[0] > -4 && au.eqResp[1] < -3, au);

  // ---------------------------------------------------------------------------------
  console.log('轉場時的聲音（交叉淡化、單邊淡入淡出）');
  const xf = await page.evaluate(async () => {
    const R = QPTEdit.render, C = QPTEdit.core;
    const out = {};
    const bufL = await R.media.decodeAudio(M.L), bufS = await R.media.decodeAudio(M.S);
    const info = id => { const m = R.media.get(id); return { kind: m.kind, duration: m.duration, hasAudio: m.hasAudio }; };
    // V1：a [0,60) 來源 0 秒、b [60,120) 來源 3 秒，各自連結 A1 上同位置的聲音；交叉疊化 30 格置中 → [45,75)
    const mk = (o = {}) => {
      const p = T.put(T.project(),
        T.clip('a', 'v1', { mediaId: M.L, start: 0, duration: 60, srcIn: 0, linkId: 'ka', audio: null }),
        T.clip('b', 'v1', { mediaId: M.L, start: 60, duration: 60, srcIn: o.bIn != null ? o.bIn : 3.0, linkId: 'kb', audio: null }),
        T.clip('aa', 'a1', { mediaId: M.L, start: 0, duration: 60, srcIn: 0, linkId: 'ka', video: null }),
        T.clip('ab', 'a1', { mediaId: o.abMedia || M.L, start: 60, duration: 60, srcIn: o.bIn != null ? o.bIn : 3.0, linkId: 'kb', video: null }));
      p.mediaInfo[M.L] = info(M.L); p.mediaInfo[M.S] = info(M.S);
      p.transitions.x = { id: 'x', trackId: 'v1', leftClipId: 'a', rightClipId: 'b', type: 'crossDissolve', duration: 30, align: 'center', color: '#000000', direction: 'left', ease: 'linear' };
      return p;
    };
    const render = p => R.renderAudio(p, { sampleRate: 48000, channels: 2, from: 0, to: 120 });
    const W = 1200;   // 11 個 440Hz 週期
    const rmsAt = (x, F) => { const c = Math.round(F * 1600); return T.rms(x, c - W / 2, c + W / 2); };
    const only = (p, id) => { for (const c of Object.values(p.clips)) if (c.trackId === 'a1') c.enabled = c.id === id; return p; };
    const xL = (await render(only(mk(), 'aa'))).getChannelData(0);
    const xR = (await render(only(mk(), 'ab'))).getChannelData(0);
    const xB = (await render(mk())).getChannelData(0);
    const ref = rmsAt(xL, 20);
    const gL = F => rmsAt(xL, F) / ref, gR = F => rmsAt(xR, F) / ref;
    out.plan = C.audioTransitionPlan(mk());
    out.midDb = [20 * Math.log10(gL(60)), 20 * Math.log10(gR(60))];
    let worst = 0;
    for (let F = 40; F <= 80; F += 2.5) worst = Math.max(worst, Math.abs(gL(F) ** 2 + gR(F) ** 2 - 1));
    out.powerWorst = worst;
    out.outside = [gL(30), gR(30), gL(90), gR(90)];
    out.leftBeyondEnd = gL(70);   // 左段在剪接點之後（從把手取）仍在淡出
    out.rightBeforeStart = gR(50);
    out.bothMid = rmsAt(xB, 60) / ref;   // 同一支素材不同位置：相位不同，只確定有聲音、不會爆音
    out.peak = xB.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // 把手不足：b 的來源從 0.2 秒開始（前面只有 6 格把手）→ 淡化從 54 格才開始，[54,75)
    const ph = mk({ bIn: 0.2 });
    out.planShort = C.audioTransitionPlan(ph);
    const sL = (await render(only(mk({ bIn: 0.2 }), 'aa'))).getChannelData(0);
    const sR = (await render(only(mk({ bIn: 0.2 }), 'ab'))).getChannelData(0);
    out.short = { L50: rmsAt(sL, 50) / ref, R50: rmsAt(sR, 50) / ref, Lmid: rmsAt(sL, 64.5) / ref, Rmid: rmsAt(sR, 64.5) / ref, Rbefore: T.rms(sR, 0, 53 * 1600) };
    // 手動淡出 × 轉場淡出：左段 fadeOut 30 格（線性）→ 第 52.5 格 = 0.25 × cos(π/2 × 7.5/30)
    const pm = only(mk(), 'aa'); pm.clips.aa.audio.fadeOut = 30;
    const xm = (await render(pm)).getChannelData(0);
    out.mult = [rmsAt(xm, 52.5) / ref, 0.25 * Math.cos(Math.PI / 2 * 7.5 / 30)];
    // 單邊：a 的開頭淡入 15 格、b 的尾端淡出 15 格（改成不相鄰：b 往後移 30 格）
    const p1 = mk();
    delete p1.transitions.x;
    p1.clips.b.start = 90; p1.clips.ab.start = 90;
    p1.transitions.h = { id: 'h', trackId: 'v1', leftClipId: null, rightClipId: 'a', type: 'fadeToBlack', duration: 15, align: 'start', color: '#000000', direction: 'left', ease: 'linear' };
    p1.transitions.t = { id: 't', trackId: 'v1', leftClipId: 'b', rightClipId: null, type: 'crossDissolve', duration: 15, align: 'end', color: '#000000', direction: 'left', ease: 'linear' };
    out.problems1 = C.checkInvariants(p1);
    const x1 = (await R.renderAudio(p1, { sampleRate: 48000, channels: 2, from: 0, to: 150 })).getChannelData(0);
    out.single = { first: Math.abs(x1[0]), mid: rmsAt(x1, 7.5) / ref, after: rmsAt(x1, 25) / ref, last: Math.abs(x1[x1.length - 1]), lastRms: T.rms(x1, x1.length - 200), tailMid: rmsAt(x1, 142.5) / ref };

    // ---- 預覽排程（AudioContext）與匯出（OfflineAudioContext）的增益包絡一致 ----
    // 記錄 Gain 的自動化呼叫與 BufferSource.start；一個片段的呼叫是連續的（同步排完才 start）
    const log = [];
    const P = AudioParam.prototype, S = AudioBufferSourceNode.prototype;
    const o1 = P.setValueAtTime, o2 = P.linearRampToValueAtTime, o3 = S.start;
    P.setValueAtTime = function (v, t) { log.push({ k: 'p', v, t }); return o1.call(this, v, t); };
    P.linearRampToValueAtTime = function (v, t) { log.push({ k: 'p', v, t }); return o2.call(this, v, t); };
    S.start = function (when, off) { log.push({ k: 's', when, off, buf: this.buffer, offline: this.context instanceof OfflineAudioContext }); return o3.call(this, when, off); };
    const voicesOf = () => {
      const vs = []; let cur = [];
      for (const e of log) { if (e.k === 'p') cur.push(e); else { vs.push(Object.assign({ pts: cur }, e)); cur = []; } }
      return vs;
    };
    // 右段用另一支素材（音樂），才分得出是哪一段
    const pp = mk({ abMedia: M.S });
    pp.clips.aa.audio.fadeIn = 9; pp.clips.aa.audio.fadeInCurve = 0.5;     // 也帶上片段自己的淡入（相乘）
    await render(pp);
    const exp = voicesOf().filter(v => v.offline);
    log.length = 0;
    const canvas = T.canvas(10, 10); document.body.appendChild(canvas);
    const player = R.createPlayer({ canvas, getProject: () => pp, maxSize: 160 });
    await T.sleep(200);
    player.seek(2); player.play();
    await T.sleep(700);
    player.pause();
    const prv = voicesOf().filter(v => !v.offline);
    player.dispose(); canvas.remove();
    P.setValueAtTime = o1; P.linearRampToValueAtTime = o2; S.start = o3;
    // 時間 → 影格：匯出 F = t × fps（from = 0）；預覽用 start(when, offset) 反推（正播、1×：來源秒數 offset 對應的影格）
    const clipOfBuf = b => (b === bufS ? pp.clips.ab : pp.clips.aa);
    const toEnv = (v, offline) => {
      const c = clipOfBuf(v.buf);
      const Fw = offline ? v.when * 30 : c.start + (v.off - c.srcIn) * 30;
      return { id: c.id, pts: v.pts.map(e => [offline ? e.t * 30 : Fw + (e.t - v.when) * 30, e.v]) };
    };
    const lerp = (pts, F) => {
      if (F <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) if (F <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return b - a < 1e-9 ? vb : va + (vb - va) * (F - a) / (b - a); }
      return pts[pts.length - 1][1];
    };
    const E = exp.map(v => toEnv(v, true)), Pv = prv.map(v => toEnv(v, false));
    out.envIds = [E.map(e => e.id), Pv.map(e => e.id)];
    out.envDiff = {};
    for (const id of ['aa', 'ab']) {
      const e = E.filter(x => x.id === id).pop(), q = Pv.filter(x => x.id === id).pop();
      if (!e || !q) { out.envDiff[id] = 'missing'; continue; }
      const a = Math.max(e.pts[0][0], q.pts[0][0]), b = Math.min(e.pts[e.pts.length - 1][0], q.pts[q.pts.length - 1][0]);
      let d = 0;
      for (let i = 0; i <= 400; i++) { const F = a + (b - a) * i / 400; d = Math.max(d, Math.abs(lerp(e.pts, F) - lerp(q.pts, F))); }
      out.envDiff[id] = { d, range: [+a.toFixed(2), +b.toFixed(2)], expRange: [e.pts[0][0], e.pts[e.pts.length - 1][0]], mid: +lerp(e.pts, 60).toFixed(4) };
    }
    return out;
  });
  check('交叉淡化範圍：左段多播到 75 格淡出、右段從 45 格開始淡入', JSON.stringify(xf.plan.aa) === JSON.stringify({ from: 0, to: 75, fades: [{ dir: 'out', from: 45, to: 75 }] }) && JSON.stringify(xf.plan.ab) === JSON.stringify({ from: 45, to: 120, fades: [{ dir: 'in', from: 45, to: 75 }] }), xf.plan);
  check('轉場中點左右兩段各約 −3dB（等功率）', xf.midDb.every(v => Math.abs(v + 3.01) < 0.35), xf.midDb);
  check('轉場範圍內總功率（左²＋右²）約不變', xf.powerWorst < 0.06, xf.powerWorst);
  check('轉場範圍外：左段原音量／右段無聲（反之亦然）', Math.abs(xf.outside[0] - 1) < 0.03 && xf.outside[1] < 0.01 && xf.outside[2] < 0.01 && Math.abs(xf.outside[3] - 1) < 0.03, xf.outside);
  check('左段在剪接點後、右段在剪接點前從來源把手取聲音', xf.leftBeyondEnd > 0.2 && xf.leftBeyondEnd < 0.6 && xf.rightBeforeStart > 0.2 && xf.rightBeforeStart < 0.6, [xf.leftBeyondEnd, xf.rightBeforeStart]);
  check('兩段一起播放：有聲音、不爆音', xf.bothMid > 0.05 && xf.peak <= 1.0, [xf.bothMid, xf.peak]);
  check('把手不足：淡化範圍縮短成 [54,75)', JSON.stringify(xf.planShort.ab.fades) === JSON.stringify([{ dir: 'in', from: 54, to: 75 }]) && xf.planShort.ab.from === 54, xf.planShort);
  check('把手不足：54 格之前右段無聲、左段原音量；新中點各約 −3dB', xf.short.Rbefore < 1e-4 && Math.abs(xf.short.L50 - 1) < 0.03 && xf.short.R50 < 0.01 && Math.abs(xf.short.Lmid - Math.SQRT1_2) < 0.04 && Math.abs(xf.short.Rmid - Math.SQRT1_2) < 0.04, xf.short);
  check('手動淡出和轉場淡出相乘', Math.abs(xf.mult[0] - xf.mult[1]) < 0.02, xf.mult);
  check('單邊：專案不變式 OK', xf.problems1.length === 0, xf.problems1);
  check('單邊淡入：第一個樣本接近 0、中點約 −3dB、之後原音量', xf.single.first < 1e-3 && Math.abs(xf.single.mid - Math.SQRT1_2) < 0.04 && Math.abs(xf.single.after - 1) < 0.03, xf.single);
  check('單邊淡出：最後接近 0、中點約 −3dB', xf.single.lastRms < 0.01 && Math.abs(xf.single.tailMid - Math.SQRT1_2) < 0.04, xf.single);
  check('預覽與匯出都排了兩段聲音', xf.envIds[0].includes('aa') && xf.envIds[0].includes('ab') && xf.envIds[1].includes('aa') && xf.envIds[1].includes('ab'), xf.envIds);
  check('預覽排程與 renderAudio 的增益包絡一致（含片段淡入 × 轉場淡化）', ['aa', 'ab'].every(id => xf.envDiff[id].d < 0.005) && Math.abs(xf.envDiff.aa.mid - Math.SQRT1_2) < 0.005 && Math.abs(xf.envDiff.ab.mid - Math.SQRT1_2) < 0.005, xf.envDiff);

  // ---------------------------------------------------------------------------------
  console.log('曲線變速（聲音）');
  const rt = await page.evaluate(async () => {
    const R = QPTEdit.render, C = QPTEdit.core;
    // 440Hz 正弦的影片聲音，套「中段慢動作」：中間真正速度 30% → 聽起來 132Hz；頭尾 100% → 440Hz
    const curve = C.retimeCurve(C.RETIME_PRESETS.slowMid, 1);
    let mean = 0;
    for (let i = 1; i < curve.length; i++) mean += (curve[i][1] + curve[i - 1][1]) / 2 * (curve[i][0] - curve[i - 1][0]);
    const p = T.put(T.project(), T.clip('a', 'a1', { mediaId: M.L, duration: 120, srcIn: 0.5, speed: mean, video: null,
      retime: { preset: 'slowMid', strength: 1, base: 1, points: curve.map(([u, v]) => ({ u, s: v / mean })) } }));
    const out = { problems: C.checkInvariants(p) };
    // 記錄 BufferSource 的 playbackRate 自動化
    const log = [];
    const P = AudioParam.prototype, S = AudioBufferSourceNode.prototype;
    const o1 = P.setValueAtTime, o2 = P.linearRampToValueAtTime, o3 = S.start;
    P.setValueAtTime = function (v, t) { log.push({ par: this, v, t }); return o1.call(this, v, t); };
    P.linearRampToValueAtTime = function (v, t) { log.push({ par: this, v, t }); return o2.call(this, v, t); };
    let started = null;
    S.start = function (when, off) { started = { node: this, when, off }; return o3.call(this, when, off); };
    const buf = await R.renderAudio(p, { sampleRate: 48000, channels: 1, from: 0, to: 120 });
    P.setValueAtTime = o1; P.linearRampToValueAtTime = o2; S.start = o3;
    const pr = log.filter(e => e.par === started.node.playbackRate);
    let used = 0;
    for (let i = 1; i < pr.length; i++) used += (pr[i].v + pr[i - 1].v) / 2 * (pr[i].t - pr[i - 1].t);
    out.off = [started.off, 0.5];
    out.used = [used, C.srcOffset(p, p.clips.a, 120)];
    out.rates = [pr[0].v, Math.min(...pr.map(e => e.v)), pr[pr.length - 1].v];
    const x = buf.getChannelData(0), hz = F => T.crossings(x, Math.round((F - 4) * 1600), Math.round((F + 4) * 1600)) / 2 / (8 / 30);
    out.hz = [hz(10), hz(60), hz(110)];
    return out;
  });
  check('曲線變速片段通過不變式', rt.problems.length === 0, rt.problems);
  check('聲音從 srcIn 開始播', Math.abs(rt.off[0] - rt.off[1]) < 1e-6, rt.off);
  check('playbackRate 自動化的積分＝曲線算出的來源用量', Math.abs(rt.used[0] - rt.used[1]) < 0.01, rt.used);
  check('playbackRate：頭 100%、中間 30%、尾 100%', Math.abs(rt.rates[0] - 1) < 0.01 && Math.abs(rt.rates[1] - 0.3) < 0.01 && Math.abs(rt.rates[2] - 1) < 0.01, rt.rates);
  check('聽起來：頭尾 440Hz、中段慢動作降到 132Hz', Math.abs(rt.hz[0] - 440) < 20 && Math.abs(rt.hz[1] - 132) < 10 && Math.abs(rt.hz[2] - 440) < 20, rt.hz);

  // ---------------------------------------------------------------------------------
  console.log('播放器');
  const pl = await page.evaluate(async () => {
    const R = QPTEdit.render, C = QPTEdit.core;
    const out = {};
    const canvas = T.canvas(10, 10); document.body.appendChild(canvas);
    let proj = T.put(T.project(), T.clip('v', 'v1', { mediaId: M.L, duration: 180, linkId: 'k' }),
      T.clip('a', 'a1', { mediaId: M.L, duration: 180, linkId: 'k' }));
    // 記錄預覽聲音建立的 BufferSource（不含 OfflineAudioContext）
    const voices = [];
    const orig = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () { const n = orig.call(this); voices.push(n); return n; };
    const player = R.createPlayer({ canvas, getProject: () => proj, maxSize: 640 });
    const frames = [], states = [];
    player.on('frame', f => frames.push(f)); player.on('state', s => states.push(s));
    await T.sleep(300);
    out.size = [canvas.width, canvas.height];
    player.play();
    await T.sleep(1000);
    out.after1s = player.frame; out.playing = player.playing;
    out.bright = T.mean(T.pixels(canvas, 64, 36));
    out.voices = voices.map(v => v.playbackRate.value);
    player.shuttle(4);
    await T.sleep(200);
    out.voicesAt4x = voices.length - out.voices.length;
    player.pause();
    out.paused = !player.playing; out.events = frames.length; out.states = states.map(s => s.rate);
    // 播到結尾停止
    player.seek(170); player.play();
    await T.sleep(800);
    out.endFrame = player.frame; out.endPlaying = player.playing;
    // 逐格；暫停時畫面就是那一格
    player.stepFrames(-5);
    out.step = player.frame;
    await T.sleep(500);
    const want = await T.snap(R.seekSource(M.L, C.sourceTimeAt(proj, proj.clips.v, player.frame)), 160, 90);
    out.pausedDiff = T.diff(T.pixels(canvas, 160, 90), want);
    // 倒播 2×
    const f0 = player.frame;
    player.shuttle(-2);
    await T.sleep(500);
    out.revDelta = f0 - player.frame; out.revRate = player.rate;
    player.shuttle(0);
    // 跨片段：兩段接在一起，播放中每格檢查不會變黑
    proj = T.put(T.project(), T.clip('x', 'v1', { mediaId: M.L, start: 0, duration: 45, srcIn: 0 }),
      T.clip('y', 'v1', { mediaId: M.N, start: 45, duration: 45, srcIn: 0.5 }));
    player.refresh(); player.seek(30);
    await T.sleep(400);
    player.play();
    let minB = 1e9, n = 0, crossed = false;
    const t0 = performance.now();
    while (performance.now() - t0 < 1000) {
      await new Promise(r => requestAnimationFrame(r));
      const b = T.mean(T.pixels(canvas, 32, 18)); minB = Math.min(minB, b); n++;
      if (player.frame > 50) crossed = true;
    }
    out.minBright = minB; out.samples = n; out.crossed = crossed;
    player.pause();
    player.dispose();
    return out;
  });
  check('預覽畫布依 maxSize 縮小（640×360）', pl.size[0] === 640 && pl.size[1] === 360, pl.size);
  check('播放 1 秒後約前進 30 格', pl.after1s >= 24 && pl.after1s <= 36 && pl.playing, pl.after1s);
  check('播放中有畫面、有 frame／state 事件', pl.bright > 20 && pl.events >= 20 && pl.states[0] === 1 && pl.paused, pl);
  check('預覽聲音：1× 播放有排程，4× 時靜音', pl.voices.length === 1 && pl.voices[0] === 1 && pl.voicesAt4x === 0, pl);
  check('播到結尾停在最後一格', pl.endFrame === 179 && !pl.endPlaying, [pl.endFrame, pl.endPlaying]);
  check('stepFrames(-5)', pl.step === 174, pl.step);
  check('暫停時畫面是正確的那一格', pl.pausedDiff < 4, pl.pausedDiff);
  check('倒播 2×：0.5 秒約倒退 30 格', pl.revDelta >= 18 && pl.revDelta <= 40 && pl.revRate === -2, pl);
  check('跨片段播放不閃黑', pl.crossed && pl.minBright > 20 && pl.samples > 20, pl);

  // ---------------------------------------------------------------------------------
  console.log('電影黑邊（compose＝預覽＝匯出）');
  const lbProject = (w, h, letterbox, withTitle) => ({ w, h, letterbox, withTitle });
  const lb = await page.evaluate(async cases => {
    const R = QPTEdit.render, C = QPTEdit.core;
    const mk = ({ w, h, letterbox, withTitle }) => {
      const p = T.put(T.project({ width: w, height: h, letterbox }),
        T.clip('s1', 'v1', { type: 'solid', mediaId: null, duration: 60, solidColor: '#ffffff', audio: null }));
      if (withTitle) T.put(p, T.clip('t1', 'v2', { type: 'title', mediaId: null, duration: 60, audio: null,
        title: { text: '字幕在黑邊上 TITLE', preset: 'static', font: 'sans-serif', size: 120, color: '#ffffff', align: 'center',
          stroke: { color: '#000', width: 0 }, shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 },
          bg: { color: 'rgba(0,0,0,0)', padding: 24, radius: 8 }, lineHeight: 1.25, x: 0.5, y: 0.04 } }));
      else T.put(p, T.clip('s2', 'v2', { type: 'solid', mediaId: null, duration: 60, solidColor: '#00ff00', audio: null }));   // V2 一般畫面也在黑邊下面
      return p;
    };
    // 一列的平均亮度（0~255），x 取中間 80%
    const rowMean = (g, w, y) => { const d = g.getImageData(Math.round(w * 0.1), y, Math.round(w * 0.8), 1).data; return T.mean(d); };
    const rowWhite = (g, w, y0, y1) => { const d = g.getImageData(0, y0, w, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++; return n; };
    const out = [];
    for (const cs of cases) {
      const p = mk(cs), bar = C.letterboxBar(p);
      const o = { cs, bar, problems: C.checkInvariants(p) };
      // compose 畫在原尺寸
      const cv = T.canvas(p.width, p.height), g = cv.getContext('2d');
      await R.renderFrame(g, p, 10);
      o.full = { top: rowMean(g, p.width, Math.max(0, bar - 3)), in: rowMean(g, p.width, bar + 3), mid: rowMean(g, p.width, p.height >> 1),
        bottom: rowMean(g, p.width, Math.min(p.height - 1, p.height - bar + 2)), barWhite: bar ? rowWhite(g, p.width, 0, bar) : 0 };
      // 預覽：播放器的縮小畫布（同一支 compose）
      const pc = T.canvas(10, 10); document.body.appendChild(pc);
      const player = R.createPlayer({ canvas: pc, getProject: () => p, maxSize: 320 });
      player.seek(10);
      await T.sleep(250);
      const k = pc.height / p.height, pg = pc.getContext('2d'), pb = Math.round(bar * k);
      o.preview = { size: [pc.width, pc.height], top: rowMean(pg, pc.width, Math.max(0, pb - 2)), in: rowMean(pg, pc.width, pb + 2), mid: rowMean(pg, pc.width, pc.height >> 1),
        bottom: rowMean(pg, pc.width, Math.min(pc.height - 1, pc.height - pb + 1)) };
      player.dispose(); pc.remove();
      out.push(o);
    }
    return out;
  }, [lbProject(1280, 720, '2.39', false), lbProject(1280, 720, '2.39', true), lbProject(1080, 1920, '2.39', false), lbProject(1280, 720, 'none', false), lbProject(1280, 720, '1.85', false)]);
  const [lb169, lbTitle, lb916, lbNone, lb185] = lb;
  const barOk = o => o.full.top < 5 && o.full.bottom < 5 && o.full.in > 60 && o.full.mid > 60 && o.preview.top < 10 && o.preview.bottom < 10 && o.preview.in > 60 && o.preview.mid > 60;   // 畫面是 V2 的綠色（平均 85）
  check('16:9＋2.39：上下各 92px 黑邊（compose 原尺寸與預覽播放器都一樣），V2 的畫面也在黑邊下面', lb169.bar === 92 && barOk(lb169) && lb169.problems.length === 0, lb169);
  check('9:16＋2.39：黑邊一樣以寬度為準（各 734px）', lb916.bar === 734 && barOk(lb916), lb916);
  check('1.85：黑邊比較薄（720p 各 14px）', lb185.bar === 14 && barOk(lb185), lb185);
  check('不加黑邊：上下邊緣就是畫面', lbNone.bar === 0 && lbNone.full.top > 60 && lbNone.full.bottom > 60 && lbNone.preview.top > 60 && lbNone.preview.bottom > 60, lbNone);
  check('字幕蓋在黑邊上面（黑邊裡看得到白字）', lbTitle.full.barWhite > 200 && lb169.full.barWhite === 0, { title: lbTitle.full.barWhite, none: lb169.full.barWhite });

  // 匯出：真的跑 exporter.run（edit-export.js 逐格 drawFrame → render.compose → 編碼），再用 ffmpeg 解第 5 格
  await page.addScriptTag({ url: '/repo/edit-export.js' });
  const ex = await page.evaluate(async () => {
    const p = T.put(T.project({ width: 640, height: 360, letterbox: '2.39' }),
      T.clip('s1', 'v1', { type: 'solid', mediaId: null, duration: 15, solidColor: '#ffffff', audio: null }));
    try {
      const r = await QPTEdit.exporter.run({ project: p, from: 0, to: 15, quality: 'small', container: 'webm' });
      const b = new Uint8Array(await r.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { b64: btoa(s), codec: r.codecs && r.codecs.label, bar: QPTEdit.core.letterboxBar(p) };
    } catch (e) { return { err: String(e && e.message || e) }; }
  });
  if (ex.err) check('匯出（webm）成功', false, ex.err);
  else {
    const file = path.join(os.tmpdir(), 'qc-letterbox-export.webm');
    fs.writeFileSync(file, Buffer.from(ex.b64, 'base64'));
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', "select='eq(n\\,5)'", '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    const W = 640, row = y => { let s = 0; for (let x = 64; x < W - 64; x++) s += raw[y * W + x]; return s / (W - 128); };
    const e = { codec: ex.codec, bar: ex.bar, bytes: raw.length, top: row(20), edgeIn: row(ex.bar + 6), mid: row(180), bottom: row(340) };
    check('匯出檔案的畫面也有一樣的黑邊（ffmpeg 解出來：黑邊 < 20、畫面 > 200）', raw.length === 640 * 360 && e.bar === 46 && e.top < 20 && e.bottom < 20 && e.mid > 200 && e.edgeIn > 200, e);
  }

  await browser.close();
  srv.close();
  console.log(`\n${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
