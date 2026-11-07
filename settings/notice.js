// 이용 안내 페이지 (설치·안내 문구 변경 시)
(() => {
  'use strict';
  const ok = document.getElementById('ok');
  chrome.storage.local.get('noticeOkV2').then(r => {
    if (r.noticeOkV2) { ok.textContent = '확인 완료'; ok.disabled = true; }
  });
  ok.addEventListener('click', async () => {
    await chrome.storage.local.set({ noticeOkV2: true });
    ok.disabled = true;
    document.getElementById('done').textContent = '확인했습니다. 이 탭은 닫아도 됩니다.';
  });
})();
