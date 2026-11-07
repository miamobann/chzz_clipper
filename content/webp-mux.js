// ─────────────────────────────────────────────────────────────
// 애니메이션 WebP 조립기 (외부 라이브러리 없음)
//
// 한 장짜리 WebP 여러 개의 그림 데이터를 꺼내 VP8X + ANIM + ANMF 구조로 이어 붙입니다.
//
//   RIFF [전체크기] WEBP
//     VP8X  : 애니메이션 표시 + 전체 크기
//     ANIM  : 배경색, 반복 횟수(0 = 무한)
//     ANMF  : 장면 (위치, 크기, 표시 시간 + 그림 데이터)
//     ...
//
// 다시 압축하지 않아 빠릅니다.
// ─────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  // ── 바이트 읽기 (little-endian) ──
  function fourCC(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }
  function u24(b, o) {
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  // ── 한 장짜리 WebP 분석: 크기, 투명도, 그림 데이터 청크 ──
  function parseStillWebp(bytes) {
    if (bytes.length < 20 || fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WEBP') {
      throw new Error('WebP 파일이 아닙니다');
    }
    const end = Math.min(bytes.length, 8 + u32(bytes, 4));
    const chunks = []; // { id, data } 옮겨 담을 청크
    let width = 0, height = 0, hasAlpha = false;
    let off = 12;

    while (off + 8 <= end) {
      const id = fourCC(bytes, off);
      const size = u32(bytes, off + 4);
      const start = off + 8;
      const stop = start + size;
      if (stop > bytes.length) throw new Error('WebP 데이터가 잘려 있습니다');
      const data = bytes.subarray(start, stop);

      if (id === 'VP8X') {
        // 확장 헤더: 4바이트 뒤 (가로-1), (세로-1) 각 3바이트
        width = u24(bytes, start + 4) + 1;
        height = u24(bytes, start + 7) + 1;
      } else if (id === 'ALPH') {
        hasAlpha = true;
        chunks.push({ id, data });
      } else if (id === 'VP8 ') {
        // 손실 압축: 10바이트 프레임 헤더 안의 14비트 가로/세로
        if (!width) {
          width = (bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff;
          height = (bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff;
        }
        chunks.push({ id, data });
      } else if (id === 'VP8L') {
        // 무손실: 서명(0x2f) 다음 32비트에 (가로-1), (세로-1), 투명도
        const v = u32(bytes, start + 1);
        if (!width) {
          width = (v & 0x3fff) + 1;
          height = ((v >>> 14) & 0x3fff) + 1;
        }
        if ((v >>> 28) & 1) hasAlpha = true;
        chunks.push({ id, data });
      }
      // ICCP·EXIF·XMP는 버림

      off = stop + (size & 1); // 홀수 크기는 1바이트 패딩
    }

    if (!chunks.some(c => c.id === 'VP8 ' || c.id === 'VP8L')) {
      throw new Error('WebP 안에 그림 데이터가 없습니다');
    }
    if (!width || !height) throw new Error('WebP 크기를 읽을 수 없습니다');
    return { width, height, hasAlpha, chunks };
  }

  // ── 쓰기 도우미 ──
  function chunkSize(dataLen) {
    return 8 + dataLen + (dataLen & 1); // 헤더 8바이트 + 데이터 + 패딩
  }
  function writeU24(out, o, v) {
    out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = (v >> 16) & 0xff;
  }
  function writeU32(out, o, v) {
    out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = (v >> 16) & 0xff; out[o + 3] = (v >>> 24) & 0xff;
  }
  function writeFourCC(out, o, s) {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  }
  function writeChunkHeader(out, o, id, len) {
    writeFourCC(out, o, id);
    writeU32(out, o + 4, len);
    return o + 8;
  }

  /**
   * 한 장짜리 WebP 여러 장 → 애니메이션 WebP
   * @param {{bytes: Uint8Array, duration: number}[]} frames  duration은 밀리초
   * @param {{loop?: number}} [options]  loop: 반복 횟수, 0 = 무한
   * @returns {Uint8Array} .webp 파일
   */
  function muxAnimatedWebp(frames, options) {
    const loop = (options && options.loop) || 0;
    if (!frames || frames.length === 0) throw new Error('프레임이 없습니다');

    const parsed = frames.map(f => parseStillWebp(f.bytes));
    let canvasW = 0, canvasH = 0, anyAlpha = false;
    for (const p of parsed) {
      canvasW = Math.max(canvasW, p.width);
      canvasH = Math.max(canvasH, p.height);
      if (p.hasAlpha) anyAlpha = true;
    }

    // 1) 전체 크기 계산
    let total = 4; // 'WEBP'
    total += chunkSize(10); // VP8X
    total += chunkSize(6);  // ANIM
    const anmfSizes = parsed.map(p => {
      let len = 16; // ANMF 머리말
      for (const c of p.chunks) len += chunkSize(c.data.length);
      return len;
    });
    for (const len of anmfSizes) total += chunkSize(len);

    const out = new Uint8Array(8 + total);
    let o = 0;

    // 2) RIFF 머리말
    writeFourCC(out, o, 'RIFF'); writeU32(out, o + 4, total); writeFourCC(out, o + 8, 'WEBP');
    o += 12;

    // 3) VP8X: 애니메이션(0x02) + 투명도(0x10)
    o = writeChunkHeader(out, o, 'VP8X', 10);
    out[o] = 0x02 | (anyAlpha ? 0x10 : 0);
    writeU24(out, o + 4, canvasW - 1);
    writeU24(out, o + 7, canvasH - 1);
    o += 10;

    // 4) ANIM: 배경색(검정) + 반복 횟수
    o = writeChunkHeader(out, o, 'ANIM', 6);
    writeU32(out, o, 0xff000000);
    out[o + 4] = loop & 0xff; out[o + 5] = (loop >> 8) & 0xff;
    o += 6;

    // 5) ANMF: 장면마다
    parsed.forEach((p, i) => {
      // 일부 뷰어가 너무 짧은 시간을 100ms로 바꾸므로 최소 20ms
      const duration = Math.max(20, Math.min(0xffffff, Math.round(frames[i].duration || 100)));
      o = writeChunkHeader(out, o, 'ANMF', anmfSizes[i]);
      writeU24(out, o, 0);              // X 위치 / 2
      writeU24(out, o + 3, 0);          // Y 위치 / 2
      writeU24(out, o + 6, p.width - 1);
      writeU24(out, o + 9, p.height - 1);
      writeU24(out, o + 12, duration);
      out[o + 15] = 0x02;               // no blend, 지우기 없음
      o += 16;
      for (const c of p.chunks) {
        o = writeChunkHeader(out, o, c.id, c.data.length);
        out.set(c.data, o);
        o += c.data.length;
        if (c.data.length & 1) out[o++] = 0; // 패딩
      }
    });

    if (o !== out.length) throw new Error('조립 크기 계산 오류');
    return out;
  }

  const api = { muxAnimatedWebp, parseStillWebp };
  root.ChzzkWebpMux = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // 테스트용(Node)
})(typeof globalThis !== 'undefined' ? globalThis : this);
