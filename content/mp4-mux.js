// ─────────────────────────────────────────────────────────────
// MP4 조립기 (외부 라이브러리 없음)
//
// WebCodecs가 만든 영상·소리 조각을 다시 압축하지 않고 MP4 상자(box)로 포장합니다.
//
//   ftyp            : 파일 형식
//   moov            : 목차 — 트랙별로 조각의 크기·시간·위치·키프레임 정보
//     trak (영상)   : H.264(avc1) 또는 예비용 VP9(vp09)
//     trak (소리)   : AAC(mp4a) 또는 예비용 Opus
//   mdat            : 실제 조각 데이터 (영상 전부 → 소리 전부)
//
// 목차(moov)를 앞에 두어 다 받기 전에도 재생됩니다.
// ─────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  const MOVIE_TIMESCALE = 1000;   // 전체 길이 단위: 1/1000초
  const VIDEO_TIMESCALE = 90000;  // 영상 시간 단위: 1/90000초 (MP4 관례)

  // ── 바이트 쓰기 (big-endian) ──
  const u8 = v => [v & 0xff];
  const u16 = v => [(v >> 8) & 0xff, v & 0xff];
  const u24 = v => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const u32 = v => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const i32 = v => u32(v >>> 0);
  const str = s => Array.from(s, c => c.charCodeAt(0) & 0xff);
  const zeros = n => new Array(n).fill(0);

  // 여러 조각(숫자 배열 또는 Uint8Array)을 하나로
  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // 상자 = [크기 4바이트][이름 4글자][내용]
  function box(type, ...children) {
    const body = concat(children.map(c => (c instanceof Uint8Array ? c : Uint8Array.from(c))));
    return concat([Uint8Array.from([...u32(body.length + 8), ...str(type)]), body]);
  }
  // 버전·플래그가 붙는 상자
  function fullBox(type, version, flags, ...children) {
    return box(type, [version, ...u24(flags)], ...children);
  }

  const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

  // 연속된 같은 값 묶기 [(개수, 값)] (stts)
  function runLength(values) {
    const runs = [];
    for (const v of values) {
      const last = runs[runs.length - 1];
      if (last && last[1] === v) last[0]++;
      else runs.push([1, v]);
    }
    return runs;
  }

  // ── 코덱 정보 상자 ──────────────────────────────────────
  function visualSampleEntry(type, width, height, configBox, ...extra) {
    return box(type,
      zeros(6), u16(1),                 // 예약, data_reference_index = 1
      u16(0), u16(0), zeros(12),        // 예약
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), // 해상도 72dpi
      u32(0), u16(1),                   // 예약, 한 샘플당 프레임 1장
      zeros(32),                        // 압축기 이름(비워 둠)
      u16(0x0018), u16(0xffff),         // 색 깊이 24비트, 예약(-1)
      configBox, ...extra);
  }

  // 색 정보(colr/nclx): 원색·감마 BT.709, 변환식 BT.709(1) 또는 BT.601(6), TV 범위
  const COLOR_MATRIX = { 'bt709-limited': 1, 'bt601-limited': 6 };
  function colrBox(v) {
    if (!COLOR_MATRIX[v.color]) return [];
    return [box('colr', str('nclx'), u16(1), u16(1), u16(COLOR_MATRIX[v.color]), u8(0))];
  }

  function videoSampleEntry(v) {
    if (v.codec === 'avc') {
      if (!v.description || !v.description.length) throw new Error('H.264 설정 정보(avcC)가 없습니다');
      return visualSampleEntry('avc1', v.width, v.height, box('avcC', v.description), ...colrBox(v));
    }
    if (v.codec === 'vp9') {
      // 코덱 문자열 예: vp09.00.40.08 → 프로필 0, 레벨 40, 8비트
      const parts = String(v.codecString || 'vp09.00.40.08').split('.');
      const profile = parseInt(parts[1], 10) || 0;
      const level = parseInt(parts[2], 10) || 40;
      const bitDepth = parseInt(parts[3], 10) || 8;
      const known = !!COLOR_MATRIX[v.color];
      const vpcC = fullBox('vpcC', 1, 0,
        u8(profile), u8(level),
        u8((bitDepth << 4) | (1 << 1) | 0),   // 4:2:0, TV 범위
        // 색 방식을 알면 BT.709(1), 모르면 미지정(2)
        known ? [1, 1, COLOR_MATRIX[v.color]] : [2, 2, 2],
        u16(0));                              // 초기화 데이터 없음
      return visualSampleEntry('vp09', v.width, v.height, vpcC, ...colrBox(v));
    }
    throw new Error('지원하지 않는 영상 코덱: ' + v.codec);
  }

  // MPEG-4 설명자(descriptor): [태그][길이][내용]
  function descriptor(tag, body) {
    const len = body.length;
    if (len > 0x0fffffff) throw new Error('설명자가 너무 깁니다');
    const size = [((len >> 21) & 0x7f) | 0x80, ((len >> 14) & 0x7f) | 0x80, ((len >> 7) & 0x7f) | 0x80, len & 0x7f];
    return concat([Uint8Array.from([tag, ...size]), body]);
  }

  // AAC 설정 정보(AudioSpecificConfig)가 없을 때 직접 생성
  function makeAacConfig(sampleRate, channels) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const idx = Math.max(0, rates.indexOf(sampleRate));
    const v = (2 << 11) | (idx << 7) | (channels << 3); // AAC-LC
    return Uint8Array.from(u16(v));
  }

  function audioSampleEntry(a) {
    const head = (type, rate) => [
      ...zeros(6), ...u16(1),            // 예약, data_reference_index = 1
      ...zeros(8),                       // 예약
      ...u16(a.channels), ...u16(16),    // 채널 수, 샘플 크기
      ...u16(0), ...u16(0),              // 예약
      ...u32((rate & 0xffff) * 65536 >>> 0) // 샘플레이트 (16.16 고정소수점)
    ];
    if (a.codec === 'aac') {
      const asc = a.description && a.description.length ? a.description : makeAacConfig(a.sampleRate, a.channels);
      const decSpecific = descriptor(0x05, asc);
      const decConfig = descriptor(0x04, concat([
        Uint8Array.from([0x40, 0x15, ...u24(0), ...u32(a.bitrate || 128000), ...u32(a.bitrate || 128000)]),
        decSpecific]));
      const sl = descriptor(0x06, Uint8Array.from([0x02]));
      const es = descriptor(0x03, concat([Uint8Array.from([...u16(1), 0]), decConfig, sl]));
      return box('mp4a', head('mp4a', a.sampleRate), fullBox('esds', 0, 0, es));
    }
    if (a.codec === 'opus') {
      // 크롬이 OpusHead(little-endian)를 주는 경우 처리
      let preSkip = 0, inputRate = a.sampleRate;
      const d = a.description;
      if (d && d.length >= 19 && String.fromCharCode(...d.subarray(0, 8)) === 'OpusHead') {
        preSkip = d[10] | (d[11] << 8);
        inputRate = (d[12] | (d[13] << 8) | (d[14] << 16) | (d[15] << 24)) >>> 0;
      }
      const dOps = box('dOps', u8(0), u8(a.channels), u16(preSkip), u32(inputRate), u16(0), u8(0));
      return box('Opus', head('Opus', 48000), dOps);
    }
    throw new Error('지원하지 않는 소리 코덱: ' + a.codec);
  }

  // ── 트랙 ──
  // samples: [{ size, duration(트랙 시간 단위), key }]
  function trak(t, chunkOffset) {
    const isVideo = t.kind === 'video';
    const mediaDuration = t.samples.reduce((s, x) => s + x.duration, 0);
    const movieDuration = Math.round(mediaDuration * MOVIE_TIMESCALE / t.timescale);
    const startDelay = Math.round((t.startOffset || 0) * MOVIE_TIMESCALE / t.timescale);

    const tkhd = fullBox('tkhd', 0, 3,
      u32(0), u32(0), u32(t.id), u32(0), u32(movieDuration + startDelay),
      zeros(8), u16(0), u16(0),
      u16(isVideo ? 0 : 0x0100), u16(0),
      MATRIX,
      u32(isVideo ? t.width * 65536 : 0), u32(isVideo ? t.height * 65536 : 0));

    // 소리가 영상보다 늦게 시작하면 빈 구간 삽입 (edit list)
    let edts = new Uint8Array(0);
    if (startDelay > 0) {
      edts = box('edts', fullBox('elst', 0, 0, u32(2),
        u32(startDelay), i32(-1), u16(1), u16(0),          // 빈 구간
        u32(movieDuration), u32(0), u16(1), u16(0)));       // 실제 내용
    }

    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDuration), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), str(isVideo ? 'vide' : 'soun'), zeros(12),
      str(isVideo ? 'VideoHandler' : 'SoundHandler'), [0]);
    const mediaHeader = isVideo
      ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullBox('smhd', 0, 0, u16(0), u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

    const stsd = fullBox('stsd', 0, 0, u32(1), isVideo ? videoSampleEntry(t) : audioSampleEntry(t));
    const runs = runLength(t.samples.map(s => s.duration));
    const stts = fullBox('stts', 0, 0, u32(runs.length), ...runs.map(([n, d]) => [...u32(n), ...u32(d)]));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(t.samples.length), u32(1)); // 전체를 한 덩어리로
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(t.samples.length), ...t.samples.map(s => u32(s.size)));
    const stco = fullBox('stco', 0, 0, u32(1), u32(chunkOffset));
    const tables = [stsd, stts];
    if (isVideo) {
      const keys = [];
      t.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
      tables.push(fullBox('stss', 0, 0, u32(keys.length), ...keys.map(k => u32(k))));
    }
    tables.push(stsc, stsz, stco);

    const minf = box('minf', mediaHeader, dinf, box('stbl', ...tables));
    return { box: box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf)), movieDuration: movieDuration + startDelay };
  }

  /**
   * MP4 파일 만들기
   * @param {object} opts
   *   video: { codec:'avc'|'vp9', codecString, width, height, description,
   *            samples:[{ data:Uint8Array, timestamp(µs), key:boolean }], frameDuration(µs) }
   *   audio: { codec:'aac'|'opus', sampleRate, channels, bitrate, description,
   *            samples:[{ data:Uint8Array, timestamp(µs), duration(µs) }] } (없어도 됨)
   * @returns {Uint8Array}
   */
  function muxMp4(opts) {
    const v = opts.video;
    if (!v || !v.samples.length) throw new Error('영상 조각이 없습니다');
    if (!v.samples[0].key) throw new Error('영상은 키프레임으로 시작해야 합니다');
    const a = opts.audio && opts.audio.samples && opts.audio.samples.length ? opts.audio : null;
    const t0 = v.samples[0].timestamp;

    // 영상 조각 길이 = 다음 조각과의 시간 차
    const fd = v.frameDuration || 33333;
    const vSamples = v.samples.map((s, i) => {
      const next = v.samples[i + 1];
      let dur = next ? next.timestamp - s.timestamp : fd;
      if (!(dur > 0) || dur > 1e6) dur = fd;
      return { size: s.data.length, key: !!s.key, duration: Math.max(1, Math.round(dur * VIDEO_TIMESCALE / 1e6)) };
    });

    let aTrack = null;
    if (a) {
      const aSamples = a.samples.map((s, i) => {
        const next = a.samples[i + 1];
        let dur = s.duration || (next ? next.timestamp - s.timestamp : 0) || 20000;
        return { size: s.data.length, key: true, duration: Math.max(1, Math.round(dur * a.sampleRate / 1e6)) };
      });
      const delayUs = Math.max(0, a.samples[0].timestamp - t0);
      aTrack = { ...a, kind: 'audio', id: 2, timescale: a.sampleRate, samples: aSamples,
                 startOffset: Math.round(delayUs * a.sampleRate / 1e6) };
    }
    const vTrack = { ...v, kind: 'video', id: 1, timescale: VIDEO_TIMESCALE, samples: vSamples, startOffset: 0 };

    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str(v.codec === 'avc' ? 'avc1' : 'iso6'), str('mp41'));
    const vBytes = v.samples.reduce((s, x) => s + x.data.length, 0);
    const aBytes = a ? a.samples.reduce((s, x) => s + x.data.length, 0) : 0;
    if (8 + vBytes + aBytes > 0xffffffff) throw new Error('파일이 너무 큽니다');

    // 목차 크기와 데이터 위치가 서로 필요해서 두 번 생성
    const buildMoov = (vOff, aOff) => {
      const tv = trak(vTrack, vOff);
      const ta = aTrack ? trak(aTrack, aOff) : null;
      const duration = Math.max(tv.movieDuration, ta ? ta.movieDuration : 0);
      const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(duration),
        u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(aTrack ? 3 : 2));
      return box('moov', mvhd, tv.box, ...(ta ? [ta.box] : []));
    };
    const moovSize = buildMoov(0, 0).length;
    const dataStart = ftyp.length + moovSize + 8; // mdat 머리말 8바이트 뒤
    const moov = buildMoov(dataStart, dataStart + vBytes);

    const out = new Uint8Array(ftyp.length + moov.length + 8 + vBytes + aBytes);
    let o = 0;
    out.set(ftyp, o); o += ftyp.length;
    out.set(moov, o); o += moov.length;
    out.set([...u32(8 + vBytes + aBytes), ...str('mdat')], o); o += 8;
    for (const s of v.samples) { out.set(s.data, o); o += s.data.length; }
    if (a) for (const s of a.samples) { out.set(s.data, o); o += s.data.length; }
    return out;
  }

  const api = { muxMp4 };
  root.ChzzkMp4Mux = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // 테스트용(Node)
})(typeof globalThis !== 'undefined' ? globalThis : this);
