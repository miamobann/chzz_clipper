// ─────────────────────────────────────────────────────────────
// 영상(MP4) 저장 — 계속 압축해 두다가 단축키로 저장
//
// 흐름
//   ① video.captureStream()으로 영상·소리 복사 (재생 영향 없음)
//   ② WebCodecs로 계속 압축, 최근 60초 보관 (영상 H.264/VP9, 소리 AAC/Opus)
//   ③ 마지막 N초를 mp4-mux.js로 포장해 저장
//
// 키프레임에서만 시작할 수 있어 실제 길이는 최대 2초 길 수 있습니다.
// ─────────────────────────────────────────────────────────────
(() => {
  'use strict';
  if (globalThis.__chzzkVideoClipLoaded) return;
  globalThis.__chzzkVideoClipLoaded = true;

  const DEFAULTS = globalThis.CHZZK_CLIP_DEFAULTS;
  const CONST = globalThis.CHZZK_CLIP_CONST;
  const shared = () => globalThis.__chzzkClipShared; // content.js 공용 도우미
  // 현재 채널의 영상 켜짐 여부
  const on = () => { const s = shared(); return !!(s && s.getChannel().video); };

  // ── 상태 ──────────────────────────────────────────────
  let settings = pick(DEFAULTS);
  let video = null, stream = null;
  let vReader = null, aReader = null;
  let vEncoder = null, aEncoder = null;
  let vInfo = null, aInfo = null;       // 코덱, 크기, 설정 정보
  let vChunks = [], aChunks = [];       // 압축 조각 (시간순)
  let bufferBytes = 0;
  let forceKey = true, lastKeyTs = -Infinity, lastFrameTs = -Infinity;
  let lastMediaTime = null;
  // 영상·소리 시계 차이: (도착 시각 − 타임스탬프)의 최솟값
  let vOff = Infinity, aOff = Infinity;
  let wasPaused = false;
  let problem = null;                   // 실패 이유
  let canvas = null, ctx = null;
  let yuv;                             // 색 변환기 (불가 시 null)
  let yuvMs = 0, yuvCount = 0;         // 색 변환 평균 시간
  let yuvNote = null;                  // 색 변환 중단 이유
  let colorPlan = null;                // 색 처리 방식 {mode, slow, detail}
  let srcMaxH = 0;                     // 이번 연결에서 본 원본 최대 세로 (원본 화질이 잠깐 떨어져도 저장 크기 유지)
  let srcNowH = 0;                     // 현재 원본 세로
  const frameSrcH = new Map();         // 프레임 시각 → 원본 세로 (저장 구간의 화질 저하 확인용)
  let dropped = 0, encoded = 0;        // 압축이 밀려 건너뛴 / 압축한 프레임 수 (최근 값 위주)
  const audioFailed = new Set();       // 실패한 소리 압축 방식
  let rec = null;                      // 녹화 중: { fromTs(시작 키프레임), startedAt(ms) }
  let recPending = null;               // 녹화 종료 후 다듬기 화면이 가져갈 상태
  let recHold = null;                  // 종료 처리 중(압축기 비우는 동안) 녹화 구간 보존
  let saving = false;
  let session = 0;                      // 재연결마다 +1
  let vConfiguring = null, aConfiguring = null;
  let vTrack = null;
  let waitingSince = 0;               // 영상 트랙 대기 시작 시각
  let lastFrameAt = 0;                // 마지막 프레임 도착 시각

  function pick(s) {
    const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
    return {
      videoEnabled: s.videoEnabled !== false,
      videoSeconds: Math.round(clamp(s.videoSeconds, CONST.MIN_VIDEO_SECONDS, CONST.MAX_VIDEO_SECONDS, DEFAULTS.videoSeconds)),
      videoHeight: [480, 720, 1080].includes(+s.videoHeight) ? +s.videoHeight : DEFAULTS.videoHeight,
      videoFps: [30, 60].includes(+s.videoFps) ? +s.videoFps : DEFAULTS.videoFps,
      videoQuality: ['normal', 'high', 'best'].includes(s.videoQuality) ? s.videoQuality : DEFAULTS.videoQuality,
      audioSyncMs: Math.round(clamp(s.audioSyncMs, -300, 300, 0))
    };
  }

  chrome.storage.sync.get(DEFAULTS).then(s => { settings = pick(s); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const keys = ['videoEnabled', 'videoHeight', 'videoFps', 'videoQuality'];
    const next = { ...settings };
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
    const old = settings;
    settings = pick(next);
    // 화질·fps·압축 품질·켜기 변경 시 재연결
    if (keys.some(k => old[k] !== settings[k])) detach();
  });

  // ── 연결 감시 (1초마다) ──
  setInterval(() => {
    const s = shared();
    const v = s ? s.getVideo() : null;
    if (!on()) { if (video) detach(); return; }
    const trackDead = !!(stream && vTrack && vTrack.readyState === 'ended');
    if (v !== video || trackDead || (v && !stream && !problem)) attach(v);
    // 영상 트랙이 없으면 계속 확인, 재생 중 3초 넘게 프레임이 없으면 재연결
    else if (stream && vTrack && !video.paused && !video.ended && video.readyState >= 2 &&
             !document.hidden && performance.now() - lastFrameAt > 3000) attach(video); // 가려진 탭 제외
    else if (stream && !vTrack) {
      if (stream.getVideoTracks().length) startVideo(session);
      // 5초 넘게 트랙이 없으면 복사 재시도
      else if (Date.now() - waitingSince > 5000 && video.readyState >= 2) attach(video);
    }
    // 소리 트랙이 늦게 생기면 이어서 연결
    if (stream && !aReader && stream.getAudioTracks().length) startAudio(session);
  }, 1000);

  function attach(v) {
    detach();
    video = v;
    if (!v) return;
    problem = null;
    if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
      problem = '이 크롬 버전은 영상 저장 기능(WebCodecs)을 지원하지 않습니다. 크롬을 업데이트하십시오.';
      return;
    }
    try {
      stream = v.captureStream();
    } catch (err) {
      problem = err && err.name === 'SecurityError'
        ? '보안 정책(SecurityError) 때문에 영상을 복사할 수 없습니다.'
        : '영상 흐름을 가져오지 못했습니다: ' + ((err && err.message) || err);
      stream = null;
      return;
    }
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    wasPaused = v.paused;
    v.addEventListener('emptied', clearBuffer);
    const my = session;
    waitingSince = Date.now();
    // 트랙이 생기면 바로 연결
    stream.addEventListener('addtrack', () => {
      if (my !== session) return;
      if (!vTrack) startVideo(my);
      if (!aReader) startAudio(my);
    });
    startVideo(my);
    startAudio(my);
  }

  function detach() {
    session++;
    if (video) {
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('emptied', clearBuffer);
    }
    for (const r of [vReader, aReader]) { try { r && r.cancel(); } catch (_) {} }
    for (const e of [vEncoder, aEncoder]) { try { e && e.state !== 'closed' && e.close(); } catch (_) {} }
    // 복사본 트랙만 정지
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch (_) {} }
    vReader = aReader = vEncoder = aEncoder = stream = null;
    vInfo = aInfo = null;
    video = null;
    vConfiguring = aConfiguring = null;
    vTrack = null;
    srcMaxH = srcNowH = 0; dropped = encoded = 0;
    frameSrcH.clear(); audioFailed.clear();
    clearBuffer();
  }

  function clearBuffer() {
    if (rec) stopRecording('영상이 멈추거나 이동해서 녹화를 종료했습니다', true);
    vChunks = [];
    aChunks = [];
    bufferBytes = 0;
    forceKey = true;          // 다음 조각은 키프레임
    lastMediaTime = null;
    vOff = aOff = Infinity;
    lastFrameTs = -Infinity;
    lastKeyTs = -Infinity;
  }

  // 소리 타임스탬프 → 영상 시계 보정값(µs)
  function audioShift() {
    return Number.isFinite(aOff) && Number.isFinite(vOff) ? aOff - vOff : 0;
  }

  // 1.5초 넘게 건너뛰면 새로 담기
  function onSeeking() {
    if (!video || lastMediaTime == null) return;
    if (Math.abs(video.currentTime - lastMediaTime) > CONST.SEEK_JUMP_SECONDS) clearBuffer();
  }
  // 일시정지 후 재생하면 새로 담기
  function onPause() { wasPaused = true; }
  function onPlay() {
    if (wasPaused) clearBuffer();
    wasPaused = false;
  }

  // ── ② 영상 압축 ───────────────────────────────────────
  async function startVideo(my) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || vTrack) return; // 트랙 대기
    vTrack = track;
    lastFrameAt = performance.now();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    vReader = reader;
    try {
      while (my === session) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        lastFrameAt = performance.now();
        try {
          await handleFrame(frame, my);
        } finally {
          frame.close(); // 원본 프레임 즉시 해제
        }
      }
    } catch (err) {
      if (my === session) problem = '영상 읽기 오류: ' + ((err && err.message) || err);
    }
  }

  async function handleFrame(frame, my) {
    if (!on() || !video) return;
    if (video.paused || video.ended) return; // 일시정지
    const ts = frame.timestamp; // µs
    if (ts < lastFrameTs) { clearBuffer(); lastFrameTs = -Infinity; } // 시간 역행(소스 교체 등)
    if (ts - lastFrameTs < (1e6 / settings.videoFps) * 0.85) return; // fps 간격
    vOff = Math.min(vOff, performance.now() * 1000 - ts);

    const srcW = frame.displayWidth, srcH = frame.displayHeight;
    if (!srcW || !srcH) return;
    srcNowH = srcH;
    if (srcH > srcMaxH) srcMaxH = srcH;
    // 원본 화질이 잠깐 떨어져도 크기를 바꾸지 않음 (바꾸면 버퍼가 초기화됨)
    let h = Math.min(settings.videoHeight, srcMaxH);
    let w = Math.round(h * srcW / srcH);
    w -= w % 2; h -= h % 2; // 짝수 크기

    if (!vEncoder || !vInfo || vInfo.width !== w || vInfo.height !== h) {
      if (vConfiguring) return;
      vConfiguring = configureVideo(w, h, my).finally(() => { vConfiguring = null; });
      await vConfiguring;
      if (my !== session || !vEncoder) return;
    }
    if (vEncoder.encodeQueueSize > 4) { dropped++; return; } // 압축이 밀리면 건너뜀
    encoded++;
    if (encoded + dropped > 600) { encoded = Math.round(encoded / 2); dropped = Math.round(dropped / 2); }

    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high'; // 고품질 축소
    }
    ctx.drawImage(frame, 0, 0, w, h);
    // 색은 직접 BT.709·TV 범위로 변환해 전달
    const plan = colorPlan || { mode: 'rgb', slow: 'rgb' };
    const fallback = why => {
      yuv = null;
      plan.mode = plan.slow;
      // 대체 방식으로도 색이 정확하면 경고하지 않음
      yuvNote = (plan.tags || {})[plan.slow] ? null : why;
    };
    let scaled;
    try {
      if (yuv && plan.mode === 'yuv') {
        const t0 = performance.now();
        scaled = yuv.convert(canvas, w, h, ts);
        const dt = performance.now() - t0;
        yuvMs = yuvCount ? yuvMs * 0.9 + dt * 0.1 : dt;
        // 2초 넘게 프레임 간격의 70%보다 느리면 대체 방식으로
        if (++yuvCount > settings.videoFps * 2 && yuvMs > 700 / settings.videoFps) {
          fallback(`색 변환이 느려서(${Math.round(yuvMs)}ms) 껐습니다. 크롬 설정의 "그래픽 가속 사용"을 켜면 다시 쓸 수 있습니다`);
        }
      } else {
        if (plan.mode === 'rgb-comp') globalThis.ChzzkYuv.compressRange(ctx, w, h);
        scaled = new VideoFrame(canvas, { timestamp: ts });
      }
    } catch (_) {
      if (scaled) { try { scaled.close(); } catch (_) {} scaled = null; }
      fallback('색 변환을 쓸 수 없어 다른 방식으로 저장합니다');
      if (plan.mode === 'rgb-comp') globalThis.ChzzkYuv.compressRange(ctx, w, h);
      scaled = new VideoFrame(canvas, { timestamp: ts });
    }
    if (vInfo) vInfo.color = (plan.tags || {})[plan.mode] || (plan.mode === 'yuv' ? 'bt709-limited' : null);
    const keyFrame = forceKey || ts - lastKeyTs >= CONST.KEYFRAME_INTERVAL_US;
    if (keyFrame) { forceKey = false; lastKeyTs = ts; }
    lastFrameTs = ts;
    lastMediaTime = video.currentTime;
    frameSrcH.set(ts, srcH);
    const opts = { keyFrame };
    if (vInfo.qp != null) opts[vInfo.kind] = { quantizer: vInfo.qp }; // 고정 화질
    try {
      vEncoder.encode(scaled, opts);
    } finally {
      scaled.close();
    }
  }

  function videoBitrate(h, fps) {
    return globalThis.CHZZK_VIDEO_BITRATE(h, fps, settings.videoQuality);
  }

  async function configureVideo(w, h, my) {
    try { vEncoder && vEncoder.state !== 'closed' && vEncoder.close(); } catch (_) {}
    vEncoder = null;
    clearBuffer();
    const fps = settings.videoFps;
    const bitrate = videoBitrate(h, fps);
    // H.264 (High → Main → Baseline), 안 되면 VP9
    const candidates = [
      { codec: 'avc1.64002a', kind: 'avc' },
      { codec: 'avc1.4d002a', kind: 'avc' },
      { codec: 'avc1.42002a', kind: 'avc' },
      { codec: 'vp09.00.40.08', kind: 'vp9' }
    ];
    for (const c of candidates) {
      const vbr = { codec: c.codec, width: w, height: h, bitrate, framerate: fps, bitrateMode: 'variable' };
      if (c.kind === 'avc') vbr.avc = { format: 'avc' }; // MP4용 (avcC)
      let ok = false;
      try { ok = (await VideoEncoder.isConfigSupported(vbr)).supported; } catch (_) {}
      if (my !== session) return;
      if (!ok) continue;
      // 고정 화질(quantizer) 모드가 되면 사용: 복잡한 장면에서도 화질 유지
      const qp = globalThis.CHZZK_VIDEO_QP[c.kind][settings.videoQuality];
      const cq = { ...vbr, bitrateMode: 'quantizer' }; delete cq.bitrate;
      let cqOk = false;
      try { cqOk = (await VideoEncoder.isConfigSupported(cq)).supported; } catch (_) {}
      if (my !== session) return;
      const cfg = cqOk ? cq : vbr;

      // 압축기 색 범위 검사로 색 처리 방식 결정 (최초 1회)
      if (yuv === undefined) yuv = globalThis.ChzzkYuv ? globalThis.ChzzkYuv.createConverter() : null;
      let plan = { mode: yuv ? 'yuv' : 'rgb', slow: 'rgb', detail: '검사 안 됨' };
      if (globalThis.ChzzkYuv && globalThis.ChzzkYuv.chooseColorPlan) {
        try { plan = await globalThis.ChzzkYuv.chooseColorPlan(vbr, yuv); } catch (_) {}
        if (my !== session) return;
      }
      if (plan.mode !== 'yuv' && yuv) yuv = null;
      colorPlan = plan;

      const info = { kind: c.kind, codecString: c.codec, width: w, height: h, description: null, fps, bitrate: cqOk ? null : bitrate, qp: cqOk ? qp : null };
      const enc = new VideoEncoder({
        output: (chunk, meta) => onVideoChunk(chunk, meta, info, my),
        error: err => { if (my === session) { problem = '영상 압축 오류: ' + err.message; vEncoder = null; } }
      });
      enc.configure(cfg);
      vEncoder = enc;
      vInfo = info;
      forceKey = true;
      return;
    }
    problem = '이 컴퓨터에서 쓸 수 있는 영상 압축 방식(H.264/VP9)을 찾지 못했습니다.';
  }

  function onVideoChunk(chunk, meta, info, my) {
    if (my !== session || info !== vInfo) return;
    if (meta && meta.decoderConfig && meta.decoderConfig.description) {
      info.description = toU8(meta.decoderConfig.description);
    }
    const key = chunk.type === 'key';
    if (!vChunks.length && !key) return; // 버퍼는 키프레임부터
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const sh = frameSrcH.get(chunk.timestamp); frameSrcH.delete(chunk.timestamp);
    if (frameSrcH.size > 300) frameSrcH.clear();
    vChunks.push({ data, timestamp: chunk.timestamp, key, srcH: sh || 0 });
    if (rec && (chunk.timestamp - rec.fromTs > CONST.REC_MAX_SECONDS * 1e6 || bufferBytes > CONST.REC_MAX_BYTES * 0.95)) {
      stopRecording(`녹화 최대 길이(${Math.round(CONST.REC_MAX_SECONDS / 60)}분) 또는 메모리 한도에 도달해 종료했습니다`);
    }
    bufferBytes += data.length;
    trim();
  }

  // ── ② 소리 압축 ───────────────────────────────────────
  async function startAudio(my) {
    const track = stream && stream.getAudioTracks()[0];
    if (!track || aReader) return;
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    aReader = reader;
    try {
      while (my === session) {
        const { value: data, done } = await reader.read();
        if (done) break;
        try {
          await handleAudio(data, my);
        } finally {
          data.close();
        }
      }
    } catch (_) { /* 소리 없이 계속 */ }
    if (my === session) aReader = null;
  }

  async function handleAudio(data, my) {
    if (!on() || !video || video.paused || video.ended) return;
    if (!vChunks.length) return; // 영상이 담긴 뒤부터
    if (!aEncoder) {
      if (aConfiguring || aInfo === false) return;
      aConfiguring = configureAudio(data.sampleRate, data.numberOfChannels, my).finally(() => { aConfiguring = null; });
      await aConfiguring;
      if (!aEncoder) return;
    }
    if (aEncoder.encodeQueueSize > 20) return;
    aOff = Math.min(aOff, performance.now() * 1000 - data.timestamp);
    aEncoder.encode(data);
  }

  async function configureAudio(sampleRate, channels, my) {
    channels = Math.min(2, channels || 2);
    const candidates = [
      { codec: 'mp4a.40.2', kind: 'aac', bitrate: 128000 },
      { codec: 'opus', kind: 'opus', bitrate: 128000 }
    ];
    for (const c of candidates) {
      if (audioFailed.has(c.kind)) continue;
      // AAC는 44.1k/48k, Opus는 48k
      const cfg = { codec: c.codec, sampleRate, numberOfChannels: channels, bitrate: c.bitrate };
      if (c.kind === 'aac') cfg.aac = { format: 'aac' }; // 머리말 없는 데이터 (MP4용)
      let ok = false;
      try { ok = (await AudioEncoder.isConfigSupported(cfg)).supported; } catch (_) {}
      if (my !== session) return;
      if (!ok) continue;
      const info = { kind: c.kind, sampleRate, channels, bitrate: c.bitrate, description: null };
      const enc = new AudioEncoder({
        output: (chunk, meta) => onAudioChunk(chunk, meta, info, my),
        // 실패하면 그 방식은 빼고 다음 방식으로 재시도 (이미 담긴 소리는 형식이 달라 비움)
        error: () => {
          if (my !== session) return;
          audioFailed.add(c.kind);
          for (const a of aChunks) bufferBytes -= a.data.length;
          aChunks = [];
          aEncoder = null; aInfo = null;
        }
      });
      enc.configure(cfg);
      aEncoder = enc;
      aInfo = info;
      return;
    }
    aInfo = false; // 소리 압축 불가 → 영상만
  }

  function onAudioChunk(chunk, meta, info, my) {
    if (my !== session || info !== aInfo) return;
    if (meta && meta.decoderConfig && meta.decoderConfig.description) {
      info.description = toU8(meta.decoderConfig.description);
    }
    if (!vChunks.length) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    aChunks.push({ data, timestamp: chunk.timestamp, duration: chunk.duration || 0 });
    bufferBytes += data.length;
  }

  // 순환 버퍼: 기간·메모리 상한을 넘는 앞부분을 키프레임 단위로 제거
  function trim() {
    if (!vChunks.length) return;
    let limit = vChunks[vChunks.length - 1].timestamp - CONST.VIDEO_BUFFER_SECONDS * 1e6;
    const keep = rec || recHold;
    if (keep) limit = Math.min(limit, keep.fromTs); // 녹화 시작점 이후는 지우지 않음
    const maxBytes = keep ? CONST.REC_MAX_BYTES : CONST.MAX_VIDEO_BUFFER_BYTES;
    for (;;) {
      // 두 번째 키프레임
      let next = -1;
      for (let i = 1; i < vChunks.length; i++) if (vChunks[i].key) { next = i; break; }
      if (next < 0) break;
      const tooOld = vChunks[next].timestamp <= limit;          // 거기서 시작해도 기간 충족
      const tooBig = bufferBytes > maxBytes && !(keep && vChunks[next].timestamp > keep.fromTs);
      if (!tooOld && !tooBig) break;
      for (let k = 0; k < next; k++) bufferBytes -= vChunks[k].data.length;
      vChunks.splice(0, next);
    }
    const first = vChunks[0].timestamp;
    const shift = audioShift();
    let drop = 0;
    while (drop < aChunks.length && aChunks[drop].timestamp + shift < first - 100000) {
      bufferBytes -= aChunks[drop].data.length;
      drop++;
    }
    if (drop) aChunks.splice(0, drop);
  }

  // ── ③ 저장 ────────────────────────────────────────────
  // opts.stamp: 동시 저장 시 공통 시각
  async function saveVideo(opts = {}) {
    const s = shared();
    if (!s) return;
    if (saving) return;
    if (!on()) return s.toast('이 채널은 영상이 꺼져 있습니다.\n확장 아이콘에서 이 채널의 영상을 켜십시오.', 'warn', 3500);
    const why = diagnose();
    if (why) return s.toast(why, 'error', 4500);

    saving = true;
    const pressedAt = new Date(opts.stamp || Date.now()); // 파일 이름의 시각
    try {
      // 인코더에 남은 장면까지 꺼내기
      try { if (vEncoder && vEncoder.state === 'configured') await withTimeout(vEncoder.flush(), 1500); } catch (_) {}
      try { if (aEncoder && aEncoder.state === 'configured') await withTimeout(aEncoder.flush(), 1000); } catch (_) {}
      if (vEncoder) forceKey = true; // flush 뒤 새 키프레임

      const vs = vChunks.slice();
      const as = aChunks.slice();
      const info = vInfo;
      if (vs.length < 2 || !info) return s.toast('담긴 영상이 너무 짧습니다. 잠시 뒤 다시 누르십시오.', 'warn', 3000);
      if (info.kind === 'avc' && !info.description) throw new Error('H.264 설정 정보를 아직 받지 못했습니다');

      // 마지막 N초가 들어가는 시작 키프레임
      const newest = vs[vs.length - 1].timestamp;
      const want = newest - settings.videoSeconds * 1e6;
      let start = 0;
      for (let i = 0; i < vs.length; i++) {
        if (!vs[i].key) continue;
        if (vs[i].timestamp <= want) start = i; else break;
      }
      const vPart = vs.slice(start);
      const t0 = vPart[0].timestamp;
      const frameUs = 1e6 / info.fps;
      const tEnd = newest + frameUs;
      // 소리를 영상 시계로 옮겨 구간 안의 것만 사용
      // 복사한 소리는 스피커 출력 전이라 빠름 → 출력 지연 + 캡처 지연(반 프레임) + 사용자 보정만큼 늦춤
      const delayUs = (await outputLatencyUs()) + frameUs / 2 + settings.audioSyncMs * 1000;
      const shift = audioShift() + delayUs;
      const aPart = as.map(c => ({ data: c.data, duration: c.duration, timestamp: c.timestamp + shift }))
        .filter(c => c.timestamp >= t0 && c.timestamp < tEnd);

      const out = globalThis.ChzzkMp4Mux.muxMp4({
        video: { codec: info.kind, codecString: info.codecString, width: info.width, height: info.height,
                 description: info.description, samples: vPart, frameDuration: frameUs, color: info.color },
        audio: aPart.length && aInfo ? { codec: aInfo.kind, sampleRate: aInfo.sampleRate, channels: aInfo.channels,
                 bitrate: aInfo.bitrate, description: aInfo.description, samples: aPart } : null
      });
      const blob = new Blob([out], { type: 'video/mp4' });
      const filename = (await s.buildFileBase(pressedAt)) + '.mp4';
      const saved = await s.download(blob, filename);

      const secs = ((tEnd - t0) / 1e6).toFixed(1);
      const mb = (blob.size / 1024 / 1024).toFixed(1);
      const codec = (info.kind === 'avc' ? 'H.264' : 'VP9') + (aPart.length ? (aInfo.kind === 'aac' ? '+AAC' : '+Opus') : ' (소리 없음)');
      const lowH = Math.min(...vPart.map(c => c.srcH || Infinity));
      const lowNote = lowH < info.height ? `\n⚠ 이 구간 일부는 플레이어 화질이 ${lowH}p로 떨어져 흐릴 수 있습니다 (플레이어 화질 고정 권장)` : '';
      s.toast(`영상 저장 완료 · ${secs}초 · ${info.height}p · ${mb}MB · ${codec}\n${saved}${lowNote}`, aPart.length && !lowNote ? 'ok' : 'warn', lowNote ? 4500 : 2500);
    } catch (err) {
      const text = String((err && err.message) || err);
      s.toast(text.includes('Extension context invalidated')
        ? '확장프로그램이 새로 설치됐습니다. 이 탭을 새로고침하십시오.'
        : '영상 저장 실패: ' + text, 'error', 4500);
    } finally {
      saving = false;
    }
  }

  // 스피커 출력 지연 (최초 1회 측정)
  let cachedLatencyUs = null;
  async function outputLatencyUs() {
    if (cachedLatencyUs != null) return cachedLatencyUs;
    let us = 40000; // 측정 실패 시 40ms
    try {
      const ac = new AudioContext();
      try { await withTimeout(ac.resume(), 300); } catch (_) {}
      const sec = (ac.baseLatency || 0) + (ac.outputLatency || 0);
      if (ac.state === 'running' && sec > 0 && sec < 0.5) { us = sec * 1e6; cachedLatencyUs = us; }
      ac.close().catch(() => {});
    } catch (_) {}
    return us;
  }

  // 독립 Uint8Array 복사본
  function toU8(bs) {
    if (ArrayBuffer.isView(bs)) return new Uint8Array(bs.buffer.slice(bs.byteOffset, bs.byteOffset + bs.byteLength));
    return new Uint8Array(bs.slice(0));
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(r => setTimeout(r, ms))]);
  }

  function diagnose() {
    if (!video) return '이 화면에서 영상을 찾지 못했습니다. 방송이나 다시보기 화면인지 확인하십시오.';
    if (problem) return problem;
    if (!vTrack) return '플레이어가 영상을 불러오는 중입니다. 재생 시작 2~3초 뒤 다시 누르십시오.';
    if (!vChunks.length) {
      if (video.paused) return '영상이 멈춰 있어서 담긴 장면이 없습니다. 재생한 뒤 다시 누르십시오.';
      return '담긴 영상이 없습니다. 재생 2~3초 뒤 다시 누르십시오.';
    }
    return null;
  }

  function status() {
    const span = vChunks.length > 1 ? (vChunks[vChunks.length - 1].timestamp - vChunks[0].timestamp) / 1e6 : 0;
    return {
      enabled: on(),
      seconds: Math.round(span * 10) / 10,
      bytes: bufferBytes,
      codec: vInfo ? (vInfo.kind === 'avc' ? 'H.264' : 'VP9') + ' ' + vInfo.height + 'p' : null,
      audio: aInfo ? (aInfo.kind === 'aac' ? 'AAC' : 'Opus') : (aInfo === false ? '없음' : null),
      quality: vInfo ? `${{ normal: '보통', high: '높음', best: '최고' }[settings.videoQuality] || ''} ` +
        (vInfo.qp != null ? `고정 화질(Q${vInfo.qp})` : `${(vInfo.bitrate / 1e6).toFixed(1)}Mbps`) : null,
      srcHeight: srcNowH || null,
      targetHeight: settings.videoHeight,
      dropRate: encoded + dropped > 60 ? Math.round(dropped / (encoded + dropped) * 100) : 0,
      recording: rec ? Math.round((Date.now() - rec.startedAt) / 1000) + CONST.REC_PRE_SECONDS : null,
      colorNote: yuvNote,
      colorMode: colorPlan ? colorPlan.mode : null,
      colorOk: !!(colorPlan && ((colorPlan.tags || {})[colorPlan.mode] || colorPlan.mode === 'yuv')),
      colorDetail: colorPlan ? colorPlan.detail : null,
      problem: on() ? (problem || (video && !vChunks.length ? diagnose() : null)) : null
    };
  }

  // ── 교차편집용 스냅샷 ──
  // 편집기를 여는 순간의 버퍼를 고정하고 편집 탭이 나눠 가져갑니다.
  //   - 시간은 첫 장면 = 0, 실제 시각(wallStartUs) 함께 전달 (탭 간 정렬)
  //   - 소리는 저장 시와 같은 싱크 보정 적용
  const snapshots = new Map(); // session → { meta, parts }
  const PART_BYTES = 5 * 1024 * 1024; // 메시지당 약 5MB

  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // 지금 버퍼 상태를 바로 고정 (동기) — 녹화 종료 직후 버퍼가 비워져도 보존
  function captureState(fromTs) {
    let vs = vChunks.slice();
    if (fromTs != null) { const k = vs.findIndex(c => c.timestamp >= fromTs && c.key); if (k > 0) vs = vs.slice(k); }
    return { vs, as: aChunks.slice(), info: vInfo, ai: aInfo || null, shift0: audioShift(), vOff };
  }

  async function takeSnapshot(session, fromTs = null) {
    const s = shared();
    if (!s || !on() || !video || vChunks.length < 2 || !vInfo) return null;
    try { if (vEncoder && vEncoder.state === 'configured') await withTimeout(vEncoder.flush(), 1500); } catch (_) {}
    try { if (aEncoder && aEncoder.state === 'configured') await withTimeout(aEncoder.flush(), 1000); } catch (_) {}
    if (vEncoder) forceKey = true;
    return buildSnapshot(session, captureState(fromTs));
  }

  async function buildSnapshot(session, st) {
    const s = shared();
    const { vs, as, info, ai } = st;
    if (!s || !info || vs.length < 2 || (info.kind === 'avc' && !info.description)) return null;
    const t0 = vs[0].timestamp; // 키프레임으로 시작
    const frameUs = 1e6 / info.fps;
    const tEnd = vs[vs.length - 1].timestamp + frameUs;
    const delayUs = (await outputLatencyUs()) + frameUs / 2 + settings.audioSyncMs * 1000;
    const shift = st.shift0 + delayUs;

    const vList = vs.map(c => ({ data: c.data, ts: c.timestamp - t0, key: c.key }));
    const aList = ai ? as.map(c => ({ data: c.data, ts: c.timestamp + shift - t0, dur: c.duration || 0 }))
      .filter(c => c.ts >= 0 && c.ts < tEnd - t0) : [];

    // 실제 시각(µs): 탭 시계 → 공통 시계
    const wallStartUs = Number.isFinite(st.vOff)
      ? t0 + st.vOff + performance.timeOrigin * 1000
      : Date.now() * 1000 - (tEnd - t0);

    const { parts, bytes } = splitParts(vList, aList);

    const ch = s.getChannel();
    const meta = {
      kind: 'video', name: ch.name || '이름 모름', ...(s.broadcastMeta ? await s.broadcastMeta() : {}), channelId: ch.id, wallStartUs, durationUs: tEnd - t0, bytes, parts: parts.length,
      video: { kind: info.kind, codecString: info.codecString, width: info.width, height: info.height, fps: info.fps, color: info.color || null,
               description: info.description ? b64(info.description) : null },
      audio: ai && aList.length ? { kind: ai.kind, sampleRate: ai.sampleRate, channels: ai.channels, bitrate: ai.bitrate,
               description: ai.description ? b64(ai.description) : null } : null
    };
    keepSnapshot(session, meta, parts);
    return meta;
  }

  // ── 녹화: 누른 시점 10초 전부터, 다시 누르면 종료 → 다듬기 화면 ──
  function startRecording() {
    const s = shared();
    if (!s) return;
    if (!on()) return s.toast('이 채널은 영상이 꺼져 있습니다.\n확장 아이콘에서 이 채널의 영상을 켜십시오.', 'warn', 3500);
    const why = diagnose();
    if (why) return s.toast(why, 'error', 4500);
    const last = vChunks[vChunks.length - 1].timestamp;
    let from = vChunks[0].timestamp;
    for (const c of vChunks) { if (c.timestamp > last - CONST.REC_PRE_SECONDS * 1e6) break; if (c.key) from = c.timestamp; }
    rec = { fromTs: from, startedAt: Date.now() };
    recPending = null;
    chrome.runtime.sendMessage({ type: 'rec-state', on: true }).catch(() => {});
    s.toast(`● 녹화 시작 (${CONST.REC_PRE_SECONDS}초 전부터)\n같은 단축키를 다시 누르면 종료하고 다듬기 화면을 엽니다 · 최대 ${Math.round(CONST.REC_MAX_SECONDS / 60)}분`, 'ok', 4000);
  }

  // immediate: 버퍼가 곧 비워지는 경우 (압축기 비우기 없이 바로 고정)
  async function stopRecording(note, immediate = false) {
    const r = rec;
    if (!r) return;
    rec = null;
    recHold = r;
    chrome.runtime.sendMessage({ type: 'rec-state', on: false }).catch(() => {});
    let st;
    if (immediate) st = captureState(r.fromTs);
    else {
      try { if (vEncoder && vEncoder.state === 'configured') await withTimeout(vEncoder.flush(), 1500); } catch (_) {}
      try { if (aEncoder && aEncoder.state === 'configured') await withTimeout(aEncoder.flush(), 1000); } catch (_) {}
      if (vEncoder) forceKey = true;
      st = captureState(r.fromTs);
    }
    recHold = null;
    if (st.vs.length < 2) { const s = shared(); if (s) s.toast('녹화된 영상이 너무 짧습니다.', 'warn', 3000); return; }
    recPending = st;
    trim(); // 녹화로 늘어난 버퍼 정리
    const secs = Math.round((st.vs[st.vs.length - 1].timestamp - st.vs[0].timestamp) / 1e6);
    const s = shared();
    if (s) s.toast(`■ 녹화 종료 · ${Math.floor(secs / 60)}분 ${secs % 60}초` + (note ? `\n${note}` : '') + '\n다듬기 화면을 여는 중…', 'ok', 3000);
    chrome.runtime.sendMessage({ type: 'record-done' }).catch(() => {});
  }

  function toggleRecording() {
    if (rec) stopRecording();
    else startRecording();
  }

  // 약 5MB씩 나누기
  function splitParts(vList, aList) {
    const parts = [];
    let cur = { video: [], audio: [] }, size = 0, bytes = 0;
    const add = (kind, item) => {
      if (size + item.data.length > PART_BYTES && size > 0) { parts.push(cur); cur = { video: [], audio: [] }; size = 0; }
      cur[kind].push(item); size += item.data.length; bytes += item.data.length;
    };
    vList.forEach(c => add('video', c));
    aList.forEach(c => add('audio', c));
    parts.push(cur);
    return { parts, bytes };
  }

  function keepSnapshot(session, meta, parts) {
    const old = snapshots.get(session);
    if (old) clearTimeout(old.timer);
    // 10분 뒤 자동 삭제
    snapshots.set(session, { meta, parts, timer: setTimeout(() => snapshots.delete(session), 10 * 60 * 1000) });
  }

  // 영상이 꺼지고 움짤만 켜진 채널: 움짤 버퍼 사용 (소리 없음)
  async function takeGifSnapshot(session) {
    const s = shared();
    const g = s && s.gifSnapshotData ? await s.gifSnapshotData() : null;
    if (!g) return null;
    const { parts, bytes } = splitParts(g.list.map(f => ({ data: f.data, ts: f.ts, key: true })), []);
    const meta = { ...g.meta, bytes, parts: parts.length };
    keepSnapshot(session, meta, parts);
    return meta;
  }

  globalThis.__chzzkVideoClip = { status, save: saveVideo };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'snapshot') {
      // 영상이 켜져 있으면 영상 버퍼, 아니면 움짤 버퍼
      const pend = msg.rec ? recPending : null;
      if (msg.rec) recPending = null;
      (pend ? buildSnapshot(msg.session, pend) : takeSnapshot(msg.session))
        .then(meta => meta || (msg.rec ? null : takeGifSnapshot(msg.session)))
        .then(meta => { const ch = shared() ? shared().getChannel() : {}; sendResponse({ ok: true, ready: !!meta, name: ch.name || null, meta }); })
        .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    }
    if (msg && msg.type === 'snapshot-get') {
      const snap = snapshots.get(msg.session);
      const part = snap && snap.parts[msg.part];
      if (!part) { sendResponse({ ok: false, error: '스냅샷이 없습니다 (10분 경과 또는 탭 새로고침)' }); return; }
      sendResponse({
        ok: true,
        meta: msg.part === 0 ? snap.meta : undefined,
        video: part.video.map(c => [b64(c.data), c.ts, c.key ? 1 : 0]),
        audio: part.audio.map(c => [b64(c.data), c.ts, c.dur])
      });
      return;
    }
    if (msg && msg.type === 'snapshot-release') {
      const snap = snapshots.get(msg.session);
      if (snap) { clearTimeout(snap.timer); snapshots.delete(msg.session); }
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === 'record-toggle') {
      toggleRecording();
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === 'save-video') {
      // 동시 저장: 영상이 꺼진 탭은 건너뜀
      const ready = on() && !!video && vChunks.length > 1;
      if (!msg.group || ready) saveVideo({ stamp: msg.stamp });
      const s = shared();
      const ch = s ? s.getChannel() : {};
      sendResponse({ ok: true, willSave: ready, enabled: on(), name: ch.name || null });
    }
  });
})();
