// 설정 기본값과 고정값 (팝업·설정 페이지·콘텐츠 스크립트 공용)

// 움짤·영상 켜기/끄기는 채널별 설정입니다 (shared/channels.js).
globalThis.CHZZK_CLIP_DEFAULTS = Object.freeze({
  clipSeconds: 5,    // 저장 길이(초), 3~15
  fps: 12,           // 초당 프레임
  width: 480,        // 가로 크기(px), 세로는 영상 비율
  quality: 0.8,      // WebP 화질 (0~1)

  // ── 영상(MP4) ──
  videoSeconds: 15,   // 저장 길이(초), 5~60
  videoHeight: 720,   // 세로 화질 480 / 720 / 1080 (원본 이하)
  videoFps: 30,       // 30 / 60
  videoQuality: 'high', // 압축 품질 'normal' / 'high' / 'best'
  audioSyncMs: 0,     // 소리 싱크 수동 보정(ms). +는 소리를 늦춤

  // ── 저장 위치 ──
  // 'picked'    : 선택한 폴더/스트리머명 (다운로드 폴더 밖 가능)
  // 'downloads' : 다운로드/치지직움짤클립/스트리머명
  // 'ask'       : 저장할 때마다 위치 묻기
  saveMode: 'downloads',
  saveFolder: '치지직움짤클립' // 다운로드 안 폴더 ('downloads' 방식, 선택 폴더 실패 시 대체)
});

globalThis.CHZZK_CLIP_CONST = Object.freeze({
  BUFFER_SECONDS: 15,                 // 움짤 버퍼 길이(초)
  MIN_CLIP_SECONDS: 3,
  MAX_CLIP_SECONDS: 15,
  MAX_BUFFER_BYTES: 200 * 1024 * 1024, // 움짤 버퍼 메모리 상한
  GIF_SIZE_LIMIT_BYTES: 20 * 1024 * 1024, // 움짤이 이보다 크면 저장 전 "그대로/줄이기" 선택
  SEEK_JUMP_SECONDS: 1.5,              // 이보다 크게 건너뛰면 버퍼를 새로 시작

  VIDEO_BUFFER_SECONDS: 60,            // 영상 버퍼 길이(초)
  MIN_VIDEO_SECONDS: 5,
  MAX_VIDEO_SECONDS: 60,
  KEYFRAME_INTERVAL_US: 2000000,       // 키프레임 간격 (저장 시작점)
  MAX_VIDEO_BUFFER_BYTES: 256 * 1024 * 1024, // 영상 버퍼 메모리 상한
  REC_PRE_SECONDS: 10,                 // 녹화: 누른 시점보다 앞서 시작하는 시간(초)
  REC_MAX_SECONDS: 600,                // 녹화 최대 길이(초), 넘으면 자동 종료
  REC_MAX_BYTES: 768 * 1024 * 1024,    // 녹화 메모리 상한, 넘으면 자동 종료
  DOWNLOAD_PIECE_CHARS: 8 * 1024 * 1024 // 백그라운드 전달 조각 크기
});

// 영상 비트레이트(bps) = 화질 × 압축 품질 × fps (30fps 기준 Mbps, 60fps는 × 1.4)
globalThis.CHZZK_VIDEO_BITRATE = function (height, fps, quality) {
  const T = { normal: [1.8, 3.5, 6], high: [3, 6, 10], best: [4.5, 9, 15] };
  const row = T[quality] || T.high;
  const mbps = height >= 1080 ? row[2] : height >= 720 ? row[1] : row[0];
  return Math.round(mbps * 1e6 * (fps > 30 ? 1.4 : 1));
};

// 고정 화질(quantizer) 모드의 화질값 — 낮을수록 고화질. 지원되면 비트레이트 대신 사용
//   장면이 복잡해도 화질이 떨어지지 않고, 대신 그 구간 파일이 커집니다.
globalThis.CHZZK_VIDEO_QP = Object.freeze({
  avc: { normal: 28, high: 24, best: 20 }, // H.264 (0~51)
  vp9: { normal: 40, high: 34, best: 28 }  // VP9 (0~63)
});
