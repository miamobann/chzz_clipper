// ─────────────────────────────────────────────────────────────
// 치지직 페이지 본체 (움짤)
//
// 흐름
//   ① 영상 찾기   : 1초마다 <video> 확인
//   ② 프레임 수집 : 설정 fps 간격으로 WebP 한 장씩 압축해 버퍼에 보관 (최근 15초)
//   ③ 저장        : 버퍼에서 마지막 N초를 꺼내 움짤로 조립 → 저장
//
// 프레임마다 바로 WebP로 압축해 메모리를 줄이고(약 1/15), 저장 시에는 이어 붙이기만 합니다.
// ─────────────────────────────────────────────────────────────
(() => {
  'use strict';

  // 확장을 다시 불러온 뒤 옛 스크립트와의 중복 실행 방지
  if (globalThis.__chzzkClipLoaded) return;
  globalThis.__chzzkClipLoaded = true;

  const DEFAULTS = globalThis.CHZZK_CLIP_DEFAULTS;
  const CONST = globalThis.CHZZK_CLIP_CONST;
  const SEL = globalThis.CHZZK_SELECTORS;
  const URLS = globalThis.CHZZK_URL;
  const API = globalThis.CHZZK_API;
  const Mux = globalThis.ChzzkWebpMux;
  const Channels = globalThis.ChzzkChannels;

  // ── 상태 ──────────────────────────────────────────────
  let settings = { ...DEFAULTS };
  let video = null;          // 연결된 <video>
  let frames = [];           // { blob, mediaTime, w, h } 시간순
  let bufferBytes = 0;
  let generation = 0;        // 버퍼를 비울 때마다 +1 (늦게 온 옛 프레임 무시)
  let pending = 0;           // 압축 중인 프레임 수
  let lastCaptureAt = 0;
  let lastMediaTime = null;  // 탐색 감지용
  let canvas = null, ctx = null;
  let probe = null, probeCtx = null; // 검은 화면 검사용 캔버스
  let blackStreak = 0;
  let frameCounter = 0;
  let blockedReason = null;  // 'security' | 'nowebp' 캡처 불가 이유
  let saving = false;
  let lastUrl = location.href;
  let fallbackTimer = null;
  // 현재 채널과 켜기/끄기 상태
  let channel = { id: null, name: null, gif: false, video: false, folder: null };

  // ── 설정 불러오기 / 변경 감지 ──────────────────────────
  chrome.storage.sync.get(DEFAULTS).then(s => { settings = sanitize(s); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      const c = Channels.changeFor(changes, channel.id);
      if (c) applyChannel({ ...channel, ...c, id: channel.id, name: channel.name || c.name });
      return;
    }
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
    const old = settings;
    settings = sanitize(next);
    // 크기·끄기 변경 시 버퍼 새로 시작
    if (old.width !== settings.width) clearBuffer();
  });

  function sanitize(s) {
    const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
    return {
      clipSeconds: Math.round(clamp(s.clipSeconds, CONST.MIN_CLIP_SECONDS, CONST.MAX_CLIP_SECONDS, DEFAULTS.clipSeconds)),
      fps: Math.round(clamp(s.fps, 1, 30, DEFAULTS.fps)),
      width: Math.round(clamp(s.width, 160, 1920, DEFAULTS.width)),
      quality: clamp(s.quality, 0.1, 1, DEFAULTS.quality)
    };
  }

  // ── ① 영상 찾기 ───────────────────────────────────────
  function findVideo() {
    for (const sel of SEL.video) {
      try {
        const v = document.querySelector(sel);
        if (v && isVisible(v)) return v;
      } catch (_) { /* 다음 선택자 */ }
    }
    // 대체: 화면에 보이는 가장 큰 video
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return bestArea > 0 ? best : null;
  }

  function isVisible(v) {
    const r = v.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 1초마다 주소와 영상 확인 (MutationObserver는 채팅이 빠르면 너무 자주 호출됨)
  function watch() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearBuffer(); // 다른 방송/영상으로 이동
      refreshChannel();
    } else if (!channel.id && channelPathKind() && !refreshInFlight) {
      refreshChannel(); // 채널 미확인 시 재시도
    }
    const v = findVideo();
    if (v !== video) attach(v);
  }
  // (시작은 파일 끝에서 — 채널 변수가 먼저 준비되어야 함)

  // ── 영상에 연결 / 해제 ────────────────────────────────
  function attach(v) {
    if (video) {
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('emptied', clearBuffer);
      video.removeEventListener('loadstart', clearBuffer);
    }
    video = v;
    clearBuffer();
    blockedReason = null;
    if (!v) return;
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('emptied', clearBuffer);   // 소스 변경
    v.addEventListener('loadstart', clearBuffer);
    startLoop(v);
  }

  // 앞뒤로 건너뛰면 버퍼를 새로 시작 (1.5초 이하 이동은 플레이어 보정이 많아 무시)
  function onSeeking() {
    if (lastMediaTime == null || !video) return;
    if (Math.abs(video.currentTime - lastMediaTime) > CONST.SEEK_JUMP_SECONDS) clearBuffer();
  }

  function clearBuffer() {
    frames = [];
    bufferBytes = 0;
    generation++;
    lastMediaTime = null;
    blackStreak = 0;
  }

  // ── ② 프레임 수집 ─────────────────────────────────────
  function startLoop(v) {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    if (typeof v.requestVideoFrameCallback === 'function') {
      // 새 장면을 그릴 때마다 호출 (일시정지 중에는 호출 없음)
      const tick = (now, meta) => {
        if (v !== video) return; // 다른 영상으로 바뀜
        v.requestVideoFrameCallback(tick);
        onFrame(v, now, meta.mediaTime);
      };
      v.requestVideoFrameCallback(tick);
    } else {
      // 구형 크롬 대체
      fallbackTimer = setInterval(() => {
        if (v !== video) return;
        onFrame(v, performance.now(), v.currentTime);
      }, 1000 / 30);
    }
  }

  function onFrame(v, now, mediaTime) {
    if (!channel.gif || blockedReason) return; // 움짤 꺼짐
    if (v.paused || v.ended || document.hidden) return; // 일시정지·숨김
    if (now - lastCaptureAt < (1000 / settings.fps) * 0.9) return; // fps 간격
    // 뒤로 탐색하면 새로 시작
    if (lastMediaTime != null && mediaTime + 0.05 < lastMediaTime) clearBuffer();
    lastCaptureAt = now;
    lastMediaTime = mediaTime;
    capture(v, mediaTime, performance.timeOrigin + now); // 실제 시각(ms): 교차편집 탭 간 맞춤용
  }

  function capture(v, mediaTime, at) {
    if (pending >= 3) return; // 압축이 밀리면 건너뜀
    if (!v.videoWidth || !v.videoHeight) return;

    const w = Math.min(settings.width, v.videoWidth);
    const h = Math.max(2, Math.round(w * v.videoHeight / v.videoWidth));
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { alpha: false }); // 투명도 없음 → 파일 작음
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high'; // 고품질 축소 (가는 선이 덜 뭉개짐)
    }
    ctx.drawImage(v, 0, 0, w, h);

    if (++frameCounter % 24 === 0) checkBlack(v); // 약 2초마다 검은 화면 검사

    const gen = generation;
    pending++;
    // convertToBlob은 호출 시점 그림을 복사하므로 캔버스 재사용 가능
    canvas.convertToBlob({ type: 'image/webp', quality: settings.quality })
      .then(blob => {
        if (gen !== generation) return; // 그 사이 버퍼가 비워짐
        if (blob.type !== 'image/webp') { blockedReason = 'nowebp'; return; }
        pushFrame({ blob, mediaTime, w, h, at });
      })
      .catch(err => {
        if (err && err.name === 'SecurityError') {
          blockedReason = 'security'; // 다른 출처 영상 → 캔버스 읽기 금지
          clearBuffer();
        }
      })
      .finally(() => { pending--; });
  }

  function pushFrame(f) {
    const last = frames[frames.length - 1];
    // 영상 비율이 바뀌면 새로 시작
    if (last && (last.w !== f.w || last.h !== f.h)) clearBuffer();

    // 압축 완료 순서가 다를 수 있어 시간순 위치에 삽입
    let i = frames.length;
    while (i > 0 && frames[i - 1].mediaTime > f.mediaTime) i--;
    frames.splice(i, 0, f);
    bufferBytes += f.blob.size;

    // 순환 버퍼: 기간·메모리 상한을 넘는 오래된 프레임 제거
    const newest = frames[frames.length - 1].mediaTime;
    while (frames.length > 1 &&
           (newest - frames[0].mediaTime > CONST.BUFFER_SECONDS || bufferBytes > CONST.MAX_BUFFER_BYTES)) {
      bufferBytes -= frames.shift().blob.size;
    }
  }

  // 검은 화면 검사 (16×9): DRM 영상은 오류 없이 검게 그려지는 경우가 있음
  function checkBlack(v) {
    try {
      if (!probe) {
        probe = new OffscreenCanvas(16, 9);
        probeCtx = probe.getContext('2d', { willReadFrequently: true });
      }
      probeCtx.drawImage(v, 0, 0, 16, 9);
      const d = probeCtx.getImageData(0, 0, 16, 9).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
      blackStreak = max < 12 ? blackStreak + 1 : 0;
    } catch (err) {
      if (err && err.name === 'SecurityError') { blockedReason = 'security'; clearBuffer(); }
    }
  }

  // ── ③ 저장 ────────────────────────────────────────────
  async function saveClip() {
    if (saving) return;
    if (!channel.gif) {
      return toast('이 채널은 움짤이 꺼져 있습니다.\n확장 아이콘에서 이 채널의 움짤을 켜십시오.', 'warn', 3500);
    }

    const problem = diagnose();
    if (problem) return toast(problem, 'error', 4500);

    saving = true;
    const pressedAt = new Date(); // 파일 이름의 시각
    try {
      // 마지막 N초
      const snapshot = frames.slice();
      const newest = snapshot[snapshot.length - 1].mediaTime;
      const picked = snapshot.filter(f => newest - f.mediaTime <= settings.clipSeconds + 1e-3);
      if (picked.length < 2) {
        return toast('담긴 장면이 너무 짧습니다. 1~2초 뒤에 다시 누르십시오.', 'warn', 3000);
      }

      // 장면 표시 시간 = 다음 장면과의 영상 시간 차 (배속·일시정지 구간 보정)
      const fallbackMs = 1000 / settings.fps;
      const items = [];
      for (let i = 0; i < picked.length; i++) {
        const next = picked[i + 1];
        let ms = next ? (next.mediaTime - picked[i].mediaTime) * 1000 : fallbackMs;
        if (!(ms > 0) || ms > 1000) ms = fallbackMs;
        items.push({ bytes: new Uint8Array(await picked[i].blob.arrayBuffer()), duration: ms });
      }

      let out = Mux.muxAnimatedWebp(items, { loop: 0 });
      let shrunk = '';
      // 너무 크면 선택: 그대로 / 크기(가로세로)를 줄여 한도에 맞추기 (화질 설정은 유지)
      const LIMIT = CONST.GIF_SIZE_LIMIT_BYTES;
      if (out.length > LIMIT) {
        const mb = n => (n / 1048576).toFixed(1);
        const choice = await askChoice(
          `움짤이 ${mb(out.length)}MB입니다 (한도 ${mb(LIMIT)}MB).\n크기를 줄이면 화질 설정은 그대로 두고 가로세로를 줄입니다.`,
          [['shrink', `${mb(LIMIT)}MB로 줄이기`], ['keep', '그대로 저장']], 'keep', 30);
        if (choice === 'shrink') {
          const before = out.length, w0 = picked[0].w;
          const r = await shrinkToLimit(picked, items.map(i => i.duration), out.length, LIMIT);
          out = r.out;
          shrunk = ` · ${w0}→${r.w}px (${mb(before)}→${mb(out.length)}MB)`;
        }
      }
      const blob = new Blob([out], { type: 'image/webp' });
      const filename = (await buildFileBase(pressedAt)) + '.webp';

      const saved = await downloadBlob(blob, filename);

      const secs = ((newest - picked[0].mediaTime) + fallbackMs / 1000).toFixed(1);
      let msg = `저장 완료 · ${secs}초 · ${picked.length}장 · ${Math.round(blob.size / 1024)}KB${shrunk}\n${saved}`;
      if (blackStreak >= 2) msg += '\n(화면이 검게 저장됐을 수 있습니다 — 보호된 영상일 수 있음)';
      toast(msg, blackStreak >= 2 ? 'warn' : 'ok', blackStreak >= 2 ? 4000 : 2000);
    } catch (err) {
      const text = String((err && err.message) || err);
      if (text.includes('Extension context invalidated')) {
        toast('확장프로그램이 새로 설치됐습니다. 이 탭을 새로고침하십시오.', 'error', 4500);
      } else {
        toast('저장 실패: ' + text, 'error', 4500);
      }
    } finally {
      saving = false;
    }
  }

  // 저장 불가 이유
  function diagnose() {
    if (!video) return '이 화면에서 영상을 찾지 못했습니다. 방송이나 다시보기 화면인지 확인하십시오.';
    if (blockedReason === 'security') {
      return '보안 정책(SecurityError) 때문에 영상 화면을 읽을 수 없습니다. 다른 사이트 영상이거나 보호된 영상입니다.';
    }
    if (blockedReason === 'nowebp') return '이 브라우저는 WebP 변환을 지원하지 않습니다. 최신 크롬으로 업데이트하십시오.';
    if (frames.length === 0) {
      if (video.paused) return '영상이 멈춰 있어서 담긴 장면이 없습니다. 재생한 뒤 다시 누르십시오.';
      if (document.hidden) return '탭이 가려져 있는 동안은 장면을 담지 않습니다.';
      return '아직 담긴 장면이 없습니다. 영상 재생 후 1~2초 뒤에 다시 누르십시오.';
    }
    if (blackStreak >= 2 && frames.length < 4) return '영상이 검은 화면으로만 읽힙니다. 저작권 보호(DRM) 영상이라 캡처가 막혔을 수 있습니다.';
    return null;
  }

  // ── 파일 이름 ─────────────────────────────────────────
  function getChannelId() {
    const path = location.pathname;
    let m;
    if ((m = path.match(URLS.live))) return m[1];
    if ((m = path.match(URLS.channel))) return m[1];
    // 다시보기: 화면의 채널 링크에서 채널 ID 찾기
    for (const sel of SEL.channelLink) {
      try {
        for (const a of document.querySelectorAll(sel)) {
          if (a.closest(SEL.excludeAreas)) continue;
          const href = a.getAttribute('href') || '';
          const hm = href.replace(/^https?:\/\/chzzk\.naver\.com/, '').match(URLS.channel);
          if (hm) return hm[1];
        }
      } catch (_) { /* 다음 선택자 */ }
    }
    if ((m = path.match(URLS.video))) return 'video' + m[1]; // 최후: 영상 번호
    return 'chzzk';
  }

  // 파일 이름에 못 쓰는 글자 제거
  function cleanName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 60);
  }

  // yy-mm-dd hh：mm：ss (윈도우는 ':' 불가 → 전각 '：')
  function shortStamp(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getFullYear() % 100)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}：${p(d.getMinutes())}：${p(d.getSeconds())}`;
  }

  // yymmdd
  const dayStamp = d => { const p = n => String(n).padStart(2, '0'); return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

  // 방송 정보 { title, date(방송 시작일) } (라이브/다시보기). 제목이 바뀔 수 있어 1분만 캐시
  let titleCache = { url: null, at: 0, info: null };
  async function getBroadcastInfo() {
    const path = location.pathname;
    let m, url = null;
    if ((m = path.match(URLS.live))) url = API.liveDetail(m[1]);
    else if ((m = path.match(URLS.video))) url = API.video(m[1]);
    if (!url) return null;
    if (titleCache.url === url && Date.now() - titleCache.at < 60000) return titleCache.info;
    let info = null;
    for (const credentials of ['omit', 'include']) {
      try {
        const res = await fetch(url, { credentials });
        if (!res.ok) continue;
        const c = ((await res.json()) || {}).content;
        if (!c) continue;
        const title = cleanName(c.liveTitle || c.videoTitle).slice(0, 50).trim() || null;
        // 라이브: openDate, 다시보기: liveOpenDate(원래 방송일) → publishDate
        const raw = c.openDate || c.liveOpenDate || c.publishDate;
        const d = raw ? new Date(String(raw).replace(' ', 'T')) : null;
        info = { title, date: d && !isNaN(d) ? d.getTime() : null };
        if (title) break;
      } catch (_) { /* 다음 방법 */ }
    }
    if (info) titleCache = { url, at: Date.now(), info };
    return info;
  }
  const getBroadcastTitle = () => getBroadcastInfo().then(i => (i ? i.title : null));
  // 교차편집 스냅샷용 { title, broadcastDate }
  const broadcastMeta = () => getBroadcastInfo().catch(() => null).then(i => ({ title: (i && i.title) || null, broadcastDate: (i && i.date) || null }));

  // ── 채널 확인: ① 주소 ② API ③ 화면 ──
  function channelPathKind() {
    const p = location.pathname;
    return URLS.live.test(p) || URLS.channel.test(p) || URLS.video.test(p);
  }

  // API에서 { id, name } (주소별 1회)
  const infoCache = new Map();
  function getChannelInfo() {
    const path = location.pathname;
    let m, urls = [];
    if ((m = path.match(URLS.live))) urls = [API.liveDetail(m[1]), API.channel(m[1])];
    else if ((m = path.match(URLS.video))) urls = [API.video(m[1])];
    else if ((m = path.match(URLS.channel))) urls = [API.channel(m[1])];
    if (!urls.length) return Promise.resolve(null);
    const key = urls[0];
    if (!infoCache.has(key)) {
      const job = (async () => {
        for (const url of urls) {
          const info = await fetchInfo(url);
          if (info && info.name) return info;
        }
        return null;
      })();
      infoCache.set(key, job);
      job.then(n => { if (!n) infoCache.delete(key); }); // 실패 시 다음에 재시도
    }
    return infoCache.get(key);
  }
  const getStreamerName = () => getChannelInfo().then(i => (i ? i.name : null));

  async function fetchInfo(url) {
    // 쿠키 없이 먼저 요청, 실패 시(연령 제한 등)만 쿠키 포함
    for (const credentials of ['omit', 'include']) {
      try {
        const res = await fetch(url, { credentials });
        if (!res.ok) continue;
        const json = await res.json();
        const c = json && json.content;
        if (!c) continue;
        const ch = c.channel || c;
        const name = cleanName(ch.channelName || c.channelName);
        const id = /^[0-9a-f]{32}$/i.test(ch.channelId || '') ? ch.channelId : null;
        if (name || id) return { name, id };
      } catch (_) { /* 다음 방법 */ }
    }
    return null;
  }

  // 화면에서 스트리머 이름 찾기 (API 실패 시)
  function nameFromPage() {
    for (const sel of SEL.streamerName) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest(SEL.excludeAreas)) continue;
          const n = cleanName(el.textContent);
          if (n) return n;
        }
      } catch (_) {}
    }
    return null;
  }

  // 현재 탭의 채널 확인 후 그 채널 설정 적용
  let refreshing = 0;
  let refreshInFlight = false;
  async function refreshChannel() {
    const my = ++refreshing;
    refreshInFlight = true;
    try { await doRefreshChannel(my); } finally { if (my === refreshing) refreshInFlight = false; }
  }
  async function doRefreshChannel(my) {
    const path = location.pathname;
    let m, id = null;
    if ((m = path.match(URLS.live)) || (m = path.match(URLS.channel))) id = m[1];
    if (!channelPathKind()) { applyChannel({ id: null, name: null, gif: false, video: false, folder: null }); return; }

    let info = null;
    try { info = await Promise.race([getChannelInfo(), new Promise(r => setTimeout(() => r(null), 4000))]); } catch (_) {}
    if (my !== refreshing) return; // 그 사이 페이지 이동
    if (!id && info && info.id) id = info.id;
    if (!id) { const l = getChannelId(); if (/^[0-9a-f]{32}$/i.test(l)) id = l; }
    if (!id) { applyChannel({ id: null, name: null, gif: false, video: false, folder: null }); return; }

    const saved = await Channels.get(id).catch(() => null) || {};
    if (my !== refreshing) return;
    const name = (info && info.name) || saved.name || nameFromPage() || null;
    if (name && name !== saved.name && (saved.gif || saved.video || saved.folder)) {
      Channels.update(id, { name }).catch(() => {}); // 이름 변경 반영
    }
    applyChannel({ ...saved, id, name });
  }

  function applyChannel(next) {
    const old = channel;
    channel = { id: next.id || null, name: next.name || null, gif: !!next.gif, video: !!next.video, folder: next.folder || null };
    if (old.gif && !channel.gif) clearBuffer();
    // 배지 갱신
    chrome.runtime.sendMessage({ type: 'badge', known: !!channel.id, gif: channel.gif, video: channel.video }).catch(() => {});
  }

  // 파일 이름(확장자 제외): [스트리머명｜방송제목] yy-mm-dd hh：mm：ss
  //   윈도우는 '|' 불가 → 전각 '｜'. 제목이 없으면 [스트리머명]
  // 방송 폴더: 방송제목｜yymmdd (방송 시작일, 없으면 저장일)
  const fileStreamer = new Map(); // 파일 이름 → { streamer, sub } (폴더 결정용)
  async function buildFileBase(date) {
    const wait = p => Promise.race([p.catch(() => null), new Promise(r => setTimeout(() => r(null), 2000))]);
    let [name, info] = await Promise.all([wait(getStreamerName()), wait(getBroadcastInfo())]);
    name = name || channel.name || nameFromPage() || cleanName(getChannelId()) || 'chzzk';
    const title = info && info.title;
    const base = `[${name}${title ? '｜' + title : ''}] ${shortStamp(date)}`;
    const sub = (title ? title + '｜' : '') + dayStamp(new Date((info && info.date) || date));
    fileStreamer.set(base, { streamer: name, sub });
    if (fileStreamer.size > 50) fileStreamer.delete(fileStreamer.keys().next().value);
    return base;
  }

  // 파일 저장
  //   메시지로 Blob을 보낼 수 없어 base64 조각(8MB)으로 offscreen에 전달 → 조립
  //   offscreen이 선택 폴더에 직접 쓰거나, 백그라운드가 다운로드 폴더에 저장
  async function downloadBlob(blob, filename) {
    const send = async msg => {
      const r = await chrome.runtime.sendMessage(msg);
      if (!r || !r.ok) throw new Error((r && r.error) || '전달 실패');
      return r;
    };
    await send({ type: 'dl-prepare' });
    const dataUrl = await blobToDataUrl(blob);
    const comma = dataUrl.indexOf(',');
    const b64 = dataUrl.slice(comma + 1);
    const id = Math.random().toString(36).slice(2);
    const step = CONST.DOWNLOAD_PIECE_CHARS; // 4의 배수 → 조각별 해독 가능
    for (let i = 0; i < b64.length; i += step) {
      await send({ target: 'offscreen', type: 'dl-part', id, part: b64.slice(i, i + step) });
    }
    const { saveMode } = await chrome.storage.sync.get({ saveMode: DEFAULTS.saveMode });
    // 선택 폴더 방식이면 offscreen이 직접 저장
    const known = fileStreamer.get(filename.replace(/\.\w+$/, '')) || {};
    const streamer = known.streamer || channel.name || 'chzzk', sub = known.sub || null;
    const fin = await send({ target: 'offscreen', type: 'dl-finish', id, mime: blob.type, mode: saveMode, filename,
                             channelId: channel.folder === 'custom' ? channel.id : null, streamer, sub });
    if (fin.saved) return fin.path;
    // 그 외는 다운로드 기능으로 저장 (권한 없을 때 대체 포함)
    const r = await send({ type: 'download', url: fin.url, filename, streamer, sub, fallback: !!fin.note });
    const where = r.path || filename; // 실제 저장 위치
    return fin.note ? `${where}\n⚠ ${fin.note}\n(이번 파일은 다운로드 폴더에 대신 저장했습니다)` : where;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // ── 화면 구석 알림 (Shadow DOM) ──
  // slot: 'main'(저장 결과) / 'summary'(동시 저장 요약, 한 칸 위)
  const toastSlots = {};
  // 움짤 크기 줄이기: 장면마다 가로세로를 줄여 다시 압축 (화질 설정 유지), 한도 안에 들 때까지 최대 4번
  async function shrinkToLimit(picked, durations, size, limit) {
    let scale = Math.sqrt(limit / size) * 0.92;
    let best = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const w = Math.max(160, Math.round(picked[0].w * scale / 2) * 2);
      const h = Math.max(90, Math.round(picked[0].h * scale / 2) * 2);
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d', { alpha: false });
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      const items = [];
      for (let i = 0; i < picked.length; i++) {
        const bmp = await createImageBitmap(picked[i].blob);
        x.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const b = await c.convertToBlob({ type: 'image/webp', quality: settings.quality });
        items.push({ bytes: new Uint8Array(await b.arrayBuffer()), duration: durations[i] });
        if (i % 15 === 0) toast(`크기 줄이는 중… ${w}×${h} · ${i + 1}/${picked.length}장`, 'ok', 60000);
      }
      const out = Mux.muxAnimatedWebp(items, { loop: 0 });
      best = { out, w, h };
      if (out.length <= limit || w <= 160) break;
      scale *= Math.sqrt(limit / out.length) * 0.95; // 아직 크면 비율만큼 더 줄임
    }
    return best;
  }

  // 화면 구석 선택 창 (버튼을 누르거나 sec초 뒤 기본값)
  function askChoice(message, buttons, fallback, sec) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          .box { position: fixed; right: 20px; bottom: 80px; z-index: 2147483647; max-width: 360px;
                 padding: 12px 14px; border-radius: 10px; color: #fff; background: rgba(20,20,24,.95);
                 border-left: 4px solid #ffc23d; box-shadow: 0 6px 20px rgba(0,0,0,.35);
                 font: 13px/1.5 system-ui, -apple-system, "Malgun Gothic", sans-serif; white-space: pre-line; }
          .btns { display: flex; gap: 6px; margin-top: 10px; justify-content: flex-end; }
          button { font: inherit; padding: 5px 12px; border-radius: 7px; cursor: pointer;
                   border: 1px solid #00ffa3; background: transparent; color: #00ffa3; }
          button.main { background: #00ffa3; color: #0b0b0d; font-weight: 600; }
          .sub { color: #9a9aa5; font-size: 12px; margin-top: 6px; }
        </style>
        <div class="box"><div class="msg"></div><div class="sub"></div><div class="btns"></div></div>`;
      const root = host.shadowRoot;
      root.querySelector('.msg').textContent = message;
      const sub = root.querySelector('.sub');
      let left = sec, timer = null;
      const done = v => { clearInterval(timer); host.remove(); resolve(v); };
      buttons.forEach(([value, label], i) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (i === 0) b.className = 'main';
        b.addEventListener('click', e => { e.stopPropagation(); done(value); });
        root.querySelector('.btns').appendChild(b);
      });
      const fbLabel = (buttons.find(b => b[0] === fallback) || [, ''])[1];
      const tick = () => { sub.textContent = `${left}초 뒤 "${fbLabel}"`; if (left-- <= 0) done(fallback); };
      tick();
      timer = setInterval(tick, 1000);
      (document.fullscreenElement || document.body || document.documentElement).appendChild(host);
    });
  }

  function toast(message, kind = 'ok', ms = 2000, slot = 'main') {
    let t = toastSlots[slot];
    if (!t) {
      t = toastSlots[slot] = { host: document.createElement('div'), timer: null };
      const bottom = slot === 'summary' ? 170 : 80;
      t.host.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          .t { position: fixed; right: 20px; bottom: ${bottom}px; z-index: 2147483647;
               max-width: 360px; padding: 10px 14px; border-radius: 10px;
               font: 13px/1.5 system-ui, -apple-system, "Malgun Gothic", sans-serif;
               color: #fff; background: rgba(20,20,24,.92); white-space: pre-line;
               box-shadow: 0 6px 20px rgba(0,0,0,.35); border-left: 4px solid #00ffa3;
               opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s;
               pointer-events: none; }
          .t.show { opacity: 1; transform: none; }
          .t.warn { border-left-color: #ffc23d; }
          .t.error { border-left-color: #ff5a5a; }
        </style>
        <div class="t"></div>`;
    }
    // 전체화면이면 전체화면 요소 안에 표시
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (t.host.parentNode !== parent) parent.appendChild(t.host);

    const el = t.host.shadowRoot.querySelector('.t');
    el.textContent = message;
    el.className = 't ' + kind;
    void el.offsetWidth; // 애니메이션 재시작
    el.classList.add('show');
    clearTimeout(t.timer);
    t.timer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // 교차편집용 움짤 버퍼 (영상이 꺼진 채널용, 소리 없음)
  async function gifSnapshotData() {
    if (!channel.gif || frames.length < 2) return null;
    const snap = frames.slice().sort((a, b) => a.at - b.at);
    const at0 = snap[0].at;
    const list = [];
    for (const f of snap) list.push({ data: new Uint8Array(await f.blob.arrayBuffer()), ts: Math.round((f.at - at0) * 1000) });
    const last = snap[snap.length - 1];
    return {
      list,
      meta: {
        kind: 'gif', name: channel.name || '이름 모름', ...(await broadcastMeta()), channelId: channel.id,
        wallStartUs: at0 * 1000, durationUs: Math.round((last.at - at0) * 1000 + 1e6 / settings.fps),
        video: { kind: 'webp', width: last.w, height: last.h, fps: settings.fps }, audio: null
      }
    };
  }

  // video-clip.js와 공유하는 도우미
  globalThis.__chzzkClipShared = {
    getVideo: () => video,
    getChannel: () => channel,
    gifSnapshotData,
    toast, buildFileBase, getBroadcastTitle, broadcastMeta,
    download: downloadBlob
  };

  // ── 메시지 ──
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'save-clip') {
      saveClip();
      sendResponse({ ok: true });
    } else if (msg.type === 'toast') {
      toast(String(msg.text || ''), msg.kind || 'ok', msg.ms || 2500, msg.slot || 'main');
      sendResponse({ ok: true });
    } else if (msg.type === 'status') {
      // 팝업 상태 칸 정보
      const span = frames.length > 1 ? frames[frames.length - 1].mediaTime - frames[0].mediaTime : 0;
      sendResponse({
        ok: true,
        channel,
        hasVideo: !!video,
        paused: !!(video && video.paused),
        frames: frames.length,
        seconds: Math.round(span * 10) / 10,
        fps: settings.fps,
        realFps: span > 2 ? Math.round((frames.length - 1) / span * 10) / 10 : null, // 실제 초당 장수
        bytes: bufferBytes,
        problem: !channel.gif ? null : frames.length ? (blockedReason ? diagnose() : null) : diagnose(),
        video: globalThis.__chzzkVideoClip ? globalThis.__chzzkVideoClip.status() : null
      });
    }
  });

  // ── 시작 ──
  refreshChannel();
  setInterval(watch, 1000);
  watch();
})();
