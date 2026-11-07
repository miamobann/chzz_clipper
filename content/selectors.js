// ─────────────────────────────────────────────────────────────
// 치지직 화면 선택자 모음 (화면 구조가 바뀌면 이 파일만 수정)
// 위에서부터 차례로 시도합니다.
// ─────────────────────────────────────────────────────────────

globalThis.CHZZK_SELECTORS = Object.freeze({
  // 플레이어 안의 <video> (모두 실패하면 화면에서 가장 큰 video 사용)
  video: [
    '#live_player_layout video',
    '.webplayer-internal-video',
    '[class*="player_layout"] video',
    '[class*="webplayer"] video'
  ],

  // 다시보기 페이지의 채널 링크 (다시보기 주소에는 채널 ID가 없음)
  channelLink: [
    '[class*="video_information"] a[href]',
    '[class*="video_info"] a[href]',
    '[class*="channel_info"] a[href]'
  ],

  // 스트리머 이름 (API 실패 시 예비)
  streamerName: [
    '[class*="video_information_name"]',
    '[class*="live_information_name"]',
    '[class*="channel_info"] [class*="name_text"]',
    '[class*="name_text"]'
  ],

  // 채널 링크 검색에서 제외할 영역 (팔로우·추천 목록 등)
  excludeAreas: 'aside, nav, [class*="navigation"], [class*="aside"], [class*="recommend"]'
});

// 치지직 정보 API (채널 ID·영상 번호만 전송)
globalThis.CHZZK_API = Object.freeze({
  liveDetail: id => `https://api.chzzk.naver.com/service/v3/channels/${id}/live-detail`,
  channel: id => `https://api.chzzk.naver.com/service/v1/channels/${id}`,
  video: no => `https://api.chzzk.naver.com/service/v3/videos/${no}`
});

// 주소에서 채널 ID / 영상 번호 추출
globalThis.CHZZK_URL = Object.freeze({
  live: /^\/live\/([0-9a-f]{32})(?:[/?#]|$)/i,   // chzzk.naver.com/live/{채널ID}
  channel: /^\/([0-9a-f]{32})(?:[/?#]|$)/i,      // chzzk.naver.com/{채널ID}
  video: /^\/video\/(\d+)/                        // chzzk.naver.com/video/{영상번호}
});
