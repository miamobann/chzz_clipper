// ─────────────────────────────────────────────────────────────
// 교차편집 내보내기 엔진
//
//   ① 소리: 트랙별로 풀어 48kHz 스테레오로 맞춘 뒤 구간 순서대로 연결 (컷 경계 10ms 크로스페이드)
//   ② 화면: 트랙별로 풀어 출력 캔버스에 그린 뒤 다시 압축 (어느 프레임에서나 컷 가능)
//   ③ 포장: mp4-mux.js
//   ④ 저장: 기본 저장 위치/교차편집
// ─────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  const OUT_RATE = 48000;

  // ── 공용 도우미 ──
  function makeAacConfig(sampleRate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const idx = Math.max(0, rates.indexOf(sampleRate));
    const v = (2 << 11) | (idx << 7) | (channels << 3);
    return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
  }

  function toU8(bs) {
    if (ArrayBuffer.isView(bs)) return new Uint8Array(bs.buffer.slice(bs.byteOffset, bs.byteOffset + bs.byteLength));
    return new Uint8Array(bs.slice(0));
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 시간 안에 끝나면 결과(없으면 true), 넘으면 false
  const withTimeout = (p, ms) => Promise.race([p.then(v => (v === undefined ? true : v)), sleep(ms).then(() => false)]);

  // ── ① 트랙 소리 풀기 → { L, R } (트랙 시간 0 = 첫 장면, 48kHz) ──
  async function decodeTrackAudio(track) {
    if (track.pcm !== undefined) return track.pcm;
    const a = track.meta.audio;
    if (!a || !track.a.length) { track.pcm = null; return null; }
    const total = Math.ceil(track.durUs / 1e6 * OUT_RATE) + OUT_RATE;
    const L = new Float32Array(total), R = new Float32Array(total);
    const cfg = { codec: a.kind === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: a.sampleRate, numberOfChannels: a.channels };
    if (a.kind === 'aac') cfg.description = a.descriptionU8 || makeAacConfig(a.sampleRate, a.channels);
    else if (a.descriptionU8) cfg.description = a.descriptionU8;

    let failed = null;
    const dec = new AudioDecoder({
      output: data => {
        try {
          const n = data.numberOfFrames, ch = data.numberOfChannels, sr = data.sampleRate;
          const planes = [];
          for (let c = 0; c < Math.min(2, ch); c++) {
            const p = new Float32Array(n);
            data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
            planes.push(p);
          }
          if (planes.length === 1) planes.push(planes[0]);
          // 들어갈 위치 (48kHz). 샘플레이트가 다르면 단순 보간
          const start = Math.round(data.timestamp / 1e6 * OUT_RATE);
          const ratio = sr / OUT_RATE;
          const outN = Math.floor(n / ratio);
          for (let i = 0; i < outN; i++) {
            const k = start + i;
            if (k < 0 || k >= total) continue;
            const x = i * ratio, x0 = Math.floor(x), f = x - x0, x1 = Math.min(n - 1, x0 + 1);
            L[k] = planes[0][x0] * (1 - f) + planes[0][x1] * f;
            R[k] = planes[1][x0] * (1 - f) + planes[1][x1] * f;
          }
        } finally { data.close(); }
      },
      error: e => { failed = e; }
    });
    try {
      dec.configure(cfg);
      for (const s of track.a) {
        if (failed) break;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.max(0, Math.round(s.ts)), duration: s.dur || undefined, data: s.data }));
        if (dec.decodeQueueSize > 50) await sleep(1);
      }
      if (!(await withTimeout(dec.flush(), 10000))) failed = failed || new Error('소리 풀기 시간 초과');
    } catch (e) { failed = failed || e; }
    try { dec.close(); } catch (_) {}
    if (failed) { console.warn('소리 풀기 실패', track.name, failed); track.pcm = null; return null; }
    track.pcm = { L, R };
    return track.pcm;
  }

  // ── ② 트랙 영상 풀기: 원하는 시각의 프레임 제공 ──
  class TrackDecoder {
    constructor(track) {
      this.t = track;
      this.frames = [];     // 풀린 프레임 (시간순)
      this.next = 0;        // 다음 조각 번호
      this.fedTs = -Infinity;
      this.dec = null;
      this.flushed = false;
      this.err = null;
      this.waiters = [];
      this.half = 1e6 / (track.meta.video.fps || 30) / 2;
    }
    _wake() { const w = this.waiters; this.waiters = []; w.forEach(r => r()); }
    _wait(ms) { return new Promise(r => { this.waiters.push(r); setTimeout(r, ms); }); }
    _reset(tau) {
      if (this.dec) { try { this.dec.close(); } catch (_) {} }
      this.frames.forEach(f => f.close());
      this.frames = [];
      this.flushed = false;
      this.err = null;
      const v = this.t.meta.video;
      this.dec = new VideoDecoder({
        output: f => { this.frames.push(f); this._wake(); },
        error: e => {
          // 소프트웨어 디코더를 못 쓰면 기본 디코더로 다시
          if (this.t.swDecode !== false && !this.frames.length) { this.t.swDecode = false; this.retry = true; }
          else this.err = e;
          this._wake();
        }
      });
      const cfg = { codec: v.codecString, codedWidth: v.width, codedHeight: v.height };
      if (v.kind === 'avc') cfg.description = v.descriptionU8;
      // 소프트웨어 디코더 우선: 그래픽카드 디코더는 프레임을 여러 장 붙잡고 있어 끝부분에서 멈출 수 있음
      if (this.t.swDecode !== false) cfg.hardwareAcceleration = 'prefer-software';
      // BT.709·TV 범위로 만든 영상이면 디코더에 명시
      const cs = root.ChzzkYuv && root.ChzzkYuv.colorSpaceOf(v.color);
      if (cs) cfg.colorSpace = cs;
      this.dec.configure(cfg);
      // tau 직전 키프레임부터 다시 풀기
      const S = this.t.v;
      let k = 0;
      for (let i = 0; i < S.length; i++) { if (S[i].ts > tau) break; if (S[i].key) k = i; }
      this.next = k;
      this.fedTs = -Infinity;
    }
    // tau(µs) 시점의 프레임. 반환한 프레임은 닫지 말 것(재사용)
    async frameAt(tau) {
      const S = this.t.v, half = this.half;
      const first = this.frames[0];
      if (!this.dec || this.err || this.retry || (first && tau + half < first.timestamp) || (!first && tau < this.fedTs - 1e6) || tau > this.fedTs + 2e6) {
        this.retry = false;
        this._reset(tau);
      }
      let stall = 0;
      for (let guard = 0; guard < 300; guard++) {
        if (this.retry) { this.retry = false; this._reset(tau); }
        // 기본 0.5초 앞까지 투입, 출력이 안 나오면 더 멀리 (최대 4초)
        const ahead = 500000 + Math.min(stall, 35) * 100000;
        while (!this.flushed && this.next < S.length && S[this.next].ts <= tau + ahead && this.dec.decodeQueueSize < 32) {
          const s = S[this.next++];
          this.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, data: s.data }));
          this.fedTs = s.ts;
        }
        // 지난 프레임 해제
        while (this.frames.length > 1 && this.frames[1].timestamp <= tau + half) this.frames.shift().close();
        const f0 = this.frames[0];
        if (f0 && (this.frames.length > 1 || f0.timestamp > tau + half)) return f0;
        if (this.err) return f0 || null;
        if (this.next >= S.length) {
          if (!this.flushed) { this.flushed = true; try { await withTimeout(this.dec.flush(), 3000); } catch (_) {} continue; }
          return f0 || null; // 끝까지 풀었음
        }
        stall++;
        await this._wait(30);
      }
      return this.frames[0] || null; // 9초 넘게 출력이 없으면 있는 프레임으로 진행
    }
    close() {
      this.frames.forEach(f => f.close());
      this.frames = [];
      if (this.dec) { try { this.dec.close(); } catch (_) {} }
    }
  }

  // ── 움짤 버퍼 트랙: 장면별 WebP를 필요한 것만 풀기 ──
  class GifTrackDecoder {
    constructor(track) { this.t = track; this.idx = -1; this.bmp = null; this.half = 1e6 / (track.meta.video.fps || 12) / 2; }
    indexAt(tau) {
      const S = this.t.v;
      let lo = 0, hi = S.length - 1, k = 0;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].ts <= tau + this.half) { k = m; lo = m + 1; } else hi = m - 1; }
      return k;
    }
    async frameAt(tau) {
      const k = this.indexAt(tau);
      if (k !== this.idx || !this.bmp) {
        const next = await createImageBitmap(new Blob([this.t.v[k].data], { type: 'image/webp' }));
        if (this.bmp) this.bmp.close();
        this.bmp = next; this.idx = k;
      }
      return this.bmp;
    }
    close() { if (this.bmp) this.bmp.close(); this.bmp = null; this.idx = -1; }
  }
  const decoderFor = track => (track.meta.kind === 'gif' ? new GifTrackDecoder(track) : new TrackDecoder(track));

  // ── 편집 결과의 t초 화면 그리기 (MP4·움짤 공용) ──
  // 크롭: 16:9 틀 기준 비율 좌표 { x, y, w, h } (0~1). 없으면 전체
  const FULL = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
  function normCrop(c) {
    if (!c) return FULL;
    const w = Math.min(1, Math.max(0.02, c.w)), h = Math.min(1, Math.max(0.02, c.h));
    return { x: Math.min(1 - w, Math.max(0, c.x)), y: Math.min(1 - h, Math.max(0, c.y)), w, h };
  }
  // 크롭 영역의 가로/세로 비율 (16:9 틀 기준)
  const cropAspect = c => (c.w * 16) / (c.h * 9);
  const even = v => Math.max(2, Math.round(v / 2) * 2);

  function makeFramePainter(tracks, segments, W, H, cropIn) {
    const crop = normCrop(cropIn);
    // 가상 16:9 틀(VW×VH)에 그리고 크롭 영역만 출력 캔버스로 확대·이동
    const VW = 1920, VH = 1080;
    const scale = W / (crop.w * VW);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    const decoders = new Map();
    const decOf = i => { if (!decoders.has(i)) decoders.set(i, decoderFor(tracks[i])); return decoders.get(i); };
    const segAt = t => { let s = segments[0]; for (const x of segments) { if (x.start <= t + 1e-9) s = x; else break; } return s; };
    return {
      canvas,
      async paint(t) {
        const seg = segAt(t);
        const tr = tracks[seg.track];
        const tau = t - tr.pos;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        if (tau >= 0 && tau * 1e6 < tr.durUs) {
          const f = await decOf(seg.track).frameAt(tau * 1e6);
          if (f) {
            const fw = f.displayWidth || f.width, fh = f.displayHeight || f.height; // 영상 프레임 / 움짤 그림
            const sc = Math.min(VW / fw, VH / fh);
            const dw = fw * sc, dh = fh * sc;
            ctx.setTransform(scale, 0, 0, scale, -crop.x * VW * scale, -crop.y * VH * scale);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(f, (VW - dw) / 2, (VH - dh) / 2, dw, dh);
          }
        }
      },
      close() { decoders.forEach(d => d.close()); decoders.clear(); }
    };
  }

  // ── 출력 인코더 선택 ──
  async function pickVideoEncoder(w, h, fps, quality) {
    const bitrate = root.CHZZK_VIDEO_BITRATE(h, fps, quality);
    const list = [
      { codec: 'avc1.64002a', kind: 'avc' }, { codec: 'avc1.4d002a', kind: 'avc' },
      { codec: 'avc1.42002a', kind: 'avc' }, { codec: 'vp09.00.40.08', kind: 'vp9' }
    ];
    for (const c of list) {
      const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps, bitrateMode: 'variable' };
      if (c.kind === 'avc') cfg.avc = { format: 'avc' };
      let ok = false;
      try { ok = (await VideoEncoder.isConfigSupported(cfg)).supported; } catch (_) {}
      if (!ok) continue;
      // 고정 화질(quantizer)이 되면 사용 (색 검사는 비트레이트 설정으로)
      const cq = { ...cfg, bitrateMode: 'quantizer' }; delete cq.bitrate;
      let cqOk = false;
      try { cqOk = (await VideoEncoder.isConfigSupported(cq)).supported; } catch (_) {}
      const qp = (root.CHZZK_VIDEO_QP[c.kind] || {})[quality] ?? root.CHZZK_VIDEO_QP[c.kind].high;
      return { cfg: cqOk ? cq : cfg, probeCfg: cfg, qp: cqOk ? qp : null, kind: c.kind, codecString: c.codec };
    }
    throw new Error('이 컴퓨터에서 쓸 수 있는 영상 압축 방식(H.264/VP9)이 없습니다');
  }

  async function pickAudioEncoder() {
    for (const c of [{ codec: 'mp4a.40.2', kind: 'aac' }, { codec: 'opus', kind: 'opus' }]) {
      const cfg = { codec: c.codec, sampleRate: OUT_RATE, numberOfChannels: 2, bitrate: 160000 };
      if (c.kind === 'aac') cfg.aac = { format: 'aac' };
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, kind: c.kind }; } catch (_) {}
    }
    return null;
  }

  /**
   * 편집 결과 → MP4
   * @param {object} job
   *   tracks   : 트랙 목록 (v, a, meta, durUs, pos(초))
   *   segments : [{ start, end, track }] (타임라인 초, 범위 안으로 잘린 상태)
   *   inT,outT : 내보낼 범위(초)
   *   height, fps
   *   onProgress(0~1, 문구), signal({ aborted })
   */
  async function exportProgram(job) {
    const { tracks, segments, inT, outT, fps } = job;
    // 세로는 화질 그대로, 가로는 크롭 비율 (없으면 16:9)
    const crop = normCrop(job.crop);
    let H = even(job.height), W = even(H * cropAspect(crop));
    if (W > 3840) { W = 3840; H = even(W / cropAspect(crop)); } // 압축기 한계
    const dur = outT - inT;
    const nFrames = Math.max(1, Math.round(dur * fps));
    const report = (p, text) => job.onProgress && job.onProgress(Math.max(0, Math.min(1, p)), text);
    const check = () => { if (job.signal && job.signal.aborted) throw new Error('중단했습니다'); };

    // ── ① 소리 연결 ──
    report(0, '소리 준비 중…');
    const used = [...new Set(segments.map(s => s.track))];
    for (const i of used) { check(); await decodeTrackAudio(tracks[i]); }
    const anyAudio = used.some(i => tracks[i].pcm);
    let audioOut = null;
    if (anyAudio) {
      const N = Math.round(dur * OUT_RATE);
      const L = new Float32Array(N), R = new Float32Array(N);
      const FADE = Math.round(0.01 * OUT_RATE); // 10ms
      const sampleOf = (trackIdx, n) => {
        const tr = tracks[trackIdx];
        if (!tr.pcm) return [0, 0];
        const t = inT + n / OUT_RATE;
        const k = Math.round((t - tr.pos) * OUT_RATE);
        if (k < 0 || k >= tr.pcm.L.length) return [0, 0];
        return [tr.pcm.L[k], tr.pcm.R[k]];
      };
      segments.forEach((seg, si) => {
        const a = Math.max(0, Math.round((seg.start - inT) * OUT_RATE));
        const b = Math.min(N, Math.round((seg.end - inT) * OUT_RATE));
        for (let n = a; n < b; n++) { const [l, r] = sampleOf(seg.track, n); L[n] = l; R[n] = r; }
        // 앞 구간과의 경계 크로스페이드
        const prev = segments[si - 1];
        if (prev && prev.track !== seg.track) {
          for (let j = -FADE; j < FADE; j++) {
            const n = a + j;
            if (n < 0 || n >= N) continue;
            const w = (j + FADE) / (2 * FADE);
            const [l1, r1] = sampleOf(prev.track, n), [l2, r2] = sampleOf(seg.track, n);
            L[n] = l1 * (1 - w) + l2 * w; R[n] = r1 * (1 - w) + r2 * w;
          }
        }
      });
      audioOut = { L, R };
    }

    // ── 인코더 준비 ──
    const venc0 = await pickVideoEncoder(W, H, fps, job.quality);

    let aenc = null, aChunks = [], aDesc = null, aErr = null, aKind = null;
    if (audioOut) {
      const pick = await pickAudioEncoder();
      if (pick) {
        aKind = pick.kind;
        aenc = new AudioEncoder({
          output: (chunk, meta) => {
            if (meta && meta.decoderConfig && meta.decoderConfig.description) aDesc = toU8(meta.decoderConfig.description);
            const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
            aChunks.push({ data: d, timestamp: chunk.timestamp, duration: chunk.duration || 0 });
          },
          error: e => { aErr = e; }
        });
        aenc.configure(pick.cfg);
        const STEP = 1024;
        const N = audioOut.L.length;
        for (let n = 0; n < N; n += STEP) {
          const m = Math.min(STEP, N - n);
          const buf = new Float32Array(m * 2);
          buf.set(audioOut.L.subarray(n, n + m), 0);
          buf.set(audioOut.R.subarray(n, n + m), m);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: OUT_RATE, numberOfFrames: m, numberOfChannels: 2,
                                     timestamp: Math.round(n / OUT_RATE * 1e6), data: buf });
          aenc.encode(ad); ad.close();
          if (aenc.encodeQueueSize > 40) await sleep(1);
        }
      }
    }

    // ── ② 화면 그리기 + 압축 (한 번) ──
    // 압축기가 멈추면 STALL 오류 → 고정 화질이었으면 비트레이트 방식으로 한 번 더
    const STALL = '압축기가 응답하지 않습니다';
    async function encodePass(venc) {
      const vChunks = [];
      let vDesc = null, vErr = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta && meta.decoderConfig && meta.decoderConfig.description) vDesc = toU8(meta.decoderConfig.description);
          const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
          vChunks.push({ data: d, timestamp: chunk.timestamp, key: chunk.type === 'key' });
        },
        error: e => { vErr = e; }
      });
      encoder.configure(venc.cfg);
      const painter = makeFramePainter(tracks, segments, W, H, crop);
      const canvas = painter.canvas;
      let yuv = root.ChzzkYuv ? root.ChzzkYuv.createConverter() : null;
      // 압축기 검사로 색 처리 방식 결정
      let plan = { mode: yuv ? 'yuv' : 'rgb', slow: 'rgb' };
      if (root.ChzzkYuv && root.ChzzkYuv.chooseColorPlan) {
        try { plan = await root.ChzzkYuv.chooseColorPlan(venc.probeCfg, yuv); } catch (_) {}
      }
      if (plan.mode !== 'yuv') yuv = null;
      let colorKnown = !!yuv;
      const pctx = canvas.getContext('2d');
      const gop = Math.round(fps * 2);
      try {
        for (let n = 0; n < nFrames; n++) {
          check();
          if (vErr) throw vErr;
          await painter.paint(inT + n / fps);
          // 색은 직접 BT.709·TV 범위로 변환 (불가 시 대체 방식)
          const ts = Math.round(n * 1e6 / fps), du = Math.round(1e6 / fps);
          let vf;
          const plain = () => {
            if (plan.mode === 'rgb-comp') root.ChzzkYuv.compressRange(pctx, W, H);
            return new VideoFrame(canvas, { timestamp: ts, duration: du });
          };
          try { vf = yuv ? yuv.convert(canvas, W, H, ts, du) : plain(); }
          catch (_) { yuv = null; colorKnown = false; plan.mode = plan.slow; vf = plain(); }
          const eo = { keyFrame: n % gop === 0 };
          if (venc.qp != null) eo[venc.kind] = { quantizer: venc.qp };
          encoder.encode(vf, eo);
          vf.close();
          // 압축 대기 (5초 넘게 줄지 않으면 멈춘 것으로 판단)
          for (let waited = 0; encoder.encodeQueueSize > 8; waited += 2) {
            if (vErr) throw vErr;
            if (waited > 5000) throw new Error(STALL);
            await sleep(2);
          }
          if (n % 5 === 0) report(0.05 + 0.9 * n / nFrames, `화면 만드는 중… ${n}/${nFrames} 프레임`);
        }
        report(0.95, '마무리 중…');
        if (!(await withTimeout(encoder.flush().then(() => true, () => true), 15000))) throw new Error(STALL);
      } finally {
        painter.close();
        try { encoder.close(); } catch (_) {}
      }
      if (vErr) throw vErr;
      if (venc.kind === 'avc' && !vDesc) throw new Error('H.264 설정 정보를 받지 못했습니다');
      return { vChunks, vDesc, color: colorKnown ? 'bt709-limited' : ((plan.tags || {})[plan.mode] || null) };
    }

    let venc = venc0, pass;
    try {
      try {
        pass = await encodePass(venc);
      } catch (e) {
        if (String(e && e.message) !== STALL || venc.qp == null) throw e;
        venc = { ...venc0, cfg: venc0.probeCfg, qp: null }; // 비트레이트 방식으로 재시도
        report(0.05, '압축기가 멈춰 다른 방식으로 다시 만드는 중…');
        pass = await encodePass(venc);
      }
    } catch (e) {
      if (aenc) { try { aenc.close(); } catch (_) {} }
      throw e;
    }
    const { vChunks, vDesc } = pass;
    if (aenc) {
      await withTimeout(aenc.flush().catch(e => { aErr = e; }), 5000);
      try { aenc.close(); } catch (_) {}
    }

    // ── ③ MP4 포장 ──
    const out = root.ChzzkMp4Mux.muxMp4({
      video: { codec: venc.kind, codecString: venc.codecString, width: W, height: H, description: vDesc,
               samples: vChunks, frameDuration: 1e6 / fps, color: pass.color },
      audio: aChunks.length && !aErr ? { codec: aKind, sampleRate: OUT_RATE, channels: 2, bitrate: 160000,
               description: aDesc, samples: aChunks } : null
    });
    report(1, '완료');
    return {
      blob: new Blob([out], { type: 'video/mp4' }),
      width: W, height: H, seconds: dur,
      codec: (venc.kind === 'avc' ? 'H.264' : 'VP9') + (aChunks.length && !aErr ? (aKind === 'aac' ? '+AAC' : '+Opus') : ' (소리 없음)')
    };
  }

  /**
   * 편집 결과 → 움짤(WebP), 소리 없음
   *   job: tracks, segments, inT, outT, width, fps, quality(0~1), onProgress, signal
   */
  async function exportWebp(job) {
    const { tracks, segments, inT, outT, fps } = job;
    // 가로는 그대로, 세로는 크롭 비율 (없으면 16:9)
    const crop = normCrop(job.crop);
    const W = even(job.width);
    const H = even(W / cropAspect(crop));
    const dur = outT - inT;
    const nFrames = Math.max(2, Math.round(dur * fps));
    const report = (p, text) => job.onProgress && job.onProgress(Math.max(0, Math.min(1, p)), text);
    const painter = makeFramePainter(tracks, segments, W, H, crop);
    const frames = [];
    let bytes = 0;
    try {
      for (let n = 0; n < nFrames; n++) {
        if (job.signal && job.signal.aborted) throw new Error('중단했습니다');
        await painter.paint(inT + n / fps);
        const blob = await painter.canvas.convertToBlob({ type: 'image/webp', quality: job.quality });
        if (blob.type !== 'image/webp') throw new Error('이 브라우저는 WebP 변환을 지원하지 않습니다');
        const u8 = new Uint8Array(await blob.arrayBuffer());
        bytes += u8.length;
        // 프레임 표시 시간(ms) — 누적 시각으로 계산해 반올림 오차 방지
        const duration = Math.round((n + 1) * 1000 / fps) - Math.round(n * 1000 / fps);
        frames.push({ bytes: u8, duration });
        if (n % 3 === 0) report(0.02 + 0.93 * n / nFrames, `움짤 장면 만드는 중… ${n}/${nFrames}장`);
        if (bytes > 200 * 1024 * 1024) throw new Error('움짤이 너무 큽니다. 가로 크기나 초당 프레임을 줄이십시오');
      }
    } finally {
      painter.close();
    }
    report(0.97, '움짤로 묶는 중…');
    const out = root.ChzzkWebpMux.muxAnimatedWebp(frames, { loop: 0 });
    report(1, '완료');
    return { blob: new Blob([out], { type: 'image/webp' }), width: W, height: H, seconds: dur, frames: frames.length, codec: 'WebP 움짤' };
  }

  // ── ④ 저장 ──
  function cleanName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  }

  async function uniqueName(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 1000; i++) {
      const c = i ? `${base} (${i})${ext}` : name;
      try { await dir.getFileHandle(c); } catch (e) { if (e && e.name === 'NotFoundError') return c; if (e && e.name !== 'TypeMismatchError') throw e; }
    }
    return `${base} (${Date.now()})${ext}`;
  }

  // 선택 폴더 권한 사전 확인 (버튼을 누른 순간에만 권한 창 가능)
  async function preparePermission() {
    const D = root.CHZZK_CLIP_DEFAULTS;
    const { saveMode } = await chrome.storage.sync.get({ saveMode: D.saveMode });
    if (saveMode !== 'picked') return;
    const dir = await root.ChzzkHandleStore.get().catch(() => null);
    if (!dir) return;
    if ((await root.ChzzkHandleStore.permission(dir)) !== 'granted') {
      try { await dir.requestPermission({ mode: 'readwrite' }); } catch (_) {}
    }
  }

  // target 없음: 기본 저장 위치/교차편집
  // target = { streamer, channelId, sub } (다듬기): 채널 전용 폴더/sub, 없으면 기본 저장 위치/스트리머명/sub
  async function saveOutput(blob, filename, target) {
    const D = root.CHZZK_CLIP_DEFAULTS;
    const { saveMode, saveFolder } = await chrome.storage.sync.get({ saveMode: D.saveMode, saveFolder: D.saveFolder });
    const subName = target ? (cleanName(target.streamer) || 'chzzk') : '교차편집';
    const bsub = target ? cleanName(target.sub) : ''; // 방송 폴더
    const into = async (d, name) => (name ? d.getDirectoryHandle(name, { create: true }) : d);
    const ext = /\.webp$/i.test(filename) ? '.webp' : '.mp4';
    let file = cleanName(filename) || 'crossedit' + ext;
    if (!/\.(webp|mp4)$/i.test(file)) file = 'crossedit' + ext; // 확장자 재확인
    let note = '';
    // 채널 전용 폴더 (다듬기, '매번 묻기' 제외)
    if (target && target.channelId && saveMode !== 'ask') {
      const rec = (await chrome.storage.local.get('ch:' + target.channelId))['ch:' + target.channelId] || {};
      if (rec.folder === 'custom') {
        const dir = await root.ChzzkHandleStore.get(target.channelId).catch(() => null);
        if (dir && (await root.ChzzkHandleStore.permission(dir)) === 'granted') {
          try {
            const d = await into(dir, bsub);
            const name = await uniqueName(d, file);
            const w = await (await d.getFileHandle(name, { create: true })).createWritable();
            await w.write(blob); await w.close();
            return [dir.name, bsub, name].filter(Boolean).join('/');
          } catch (e) { note = '\n⚠ 채널 전용 폴더에 쓰지 못해 다운로드 폴더에 대신 저장했습니다'; }
        } else {
          note = '\n⚠ 채널 전용 폴더 권한이 없어 다운로드 폴더에 대신 저장했습니다';
        }
      }
    }
    if (saveMode === 'picked' && !note) {
      const dir = await root.ChzzkHandleStore.get().catch(() => null);
      if (dir && (await root.ChzzkHandleStore.permission(dir)) === 'granted') {
        try {
          const sub = await into(await into(dir, subName), bsub);
          const name = await uniqueName(sub, file);
          const w = await (await sub.getFileHandle(name, { create: true })).createWritable();
          await w.write(blob); await w.close();
          return [dir.name, subName, bsub, name].filter(Boolean).join('/');
        } catch (e) { note = '\n⚠ 선택한 폴더에 쓰지 못해 다운로드 폴더에 대신 저장했습니다'; }
      } else {
        note = '\n⚠ 기본 저장 폴더 권한이 없어 다운로드 폴더에 대신 저장했습니다';
      }
    }
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
    const folder = cleanName(saveFolder) || '치지직움짤클립';
    const path = [folder, subName, bsub, file].filter(Boolean).join('/');
    const start = filename => chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: saveMode === 'ask' });
    try {
      await start(path);
      return path + note;
    } catch (e) {
      if (!/filename/i.test(String(e && e.message))) throw e;
      const ascii = s => s.replace(/[^\x20-\x7e]/g, '').trim();
      const fb = `chzzk-clips/crossedit/${ascii(file.replace(/\.(mp4|webp)$/i, '')) || 'crossedit'}${ext}`;
      await start(fb);
      return fb + note;
    }
  }

  root.ChzzkExport = { exportProgram, exportWebp, decodeTrackAudio, saveOutput, preparePermission, TrackDecoder, GifTrackDecoder, OUT_RATE };
})(globalThis);
