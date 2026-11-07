// ─────────────────────────────────────────────────────────────
// 백그라운드(서비스 워커)
//   1) 단축키 → 저장 명령
//      Alt+Shift+S 움짤 / Alt+Shift+V 영상 : 현재 탭
//      Alt+Shift+D 영상 동시 저장          : 영상이 켜진 모든 탭
//      Alt+Shift+E 교차편집                : 영상이 켜진 모든 탭의 버퍼
//      (키 없음) 다듬어 저장               : 현재 탭의 버퍼 (기본 키는 4개까지만 가능)
//   2) 다운로드 폴더 저장
//   3) 탭별 배지(움/영/OFF)
//
// 권한
//   - storage   : 설정 저장
//   - downloads : 다운로드 폴더 저장
//   - offscreen : 파일 조립 (서비스 워커는 blob URL을 만들 수 없음)
//   - 페이지 접근은 chzzk.naver.com 콘텐츠 스크립트로 한정. tabs·scripting·<all_urls> 미사용
//   - 외부 전송 없음
// ─────────────────────────────────────────────────────────────

importScripts('shared/defaults.js');

// 이전 버전 설정 정리
//   - askSaveAs → saveMode
//   - 이전 폴더 이름(치지직움짤) 삭제 → 새 기본값 사용
//   - 전체 켜기/끄기(enabled, videoEnabled) → 채널별 설정으로 대체
chrome.runtime.onInstalled.addListener(async details => {
  // 설치 직후 또는 안내 문구 변경 후 미확인 시 안내 페이지 열기
  const { noticeOkV2 } = await chrome.storage.local.get('noticeOkV2');
  if (!noticeOkV2 && (details.reason === 'install' || details.reason === 'update')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/notice.html') });
  }
  const s = await chrome.storage.sync.get(['saveMode', 'askSaveAs']);
  if (!s.saveMode && s.askSaveAs) await chrome.storage.sync.set({ saveMode: 'ask' });
  await chrome.storage.sync.remove(['askSaveAs', 'saveFolder', 'enabled', 'videoEnabled']);
});

const COMMAND_TO_MESSAGE = {
  'save-clip': 'save-clip',   // 움짤
  'save-video': 'save-video'  // 영상
};

// ① 단축키
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'save-all-videos') return saveAllVideos(tab);
  if (command === 'open-editor') return openEditor(tab);
  if (command === 'record-toggle') {
    let t = tab;
    if (!t || t.id == null) [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && t.id != null) chrome.tabs.sendMessage(t.id, { type: 'record-toggle' }).catch(() => flashBadge(t.id));
    return;
  }
  if (command === 'trim-clip') {
    let t = tab;
    if (!t || t.id == null) [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && t.id != null) return openEditor(t, t.id);
  }
  const type = COMMAND_TO_MESSAGE[command];
  if (!type) return;

  let target = tab;
  if (!target || target.id == null) {
    [target] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  if (!target || target.id == null) return;

  try {
    await chrome.tabs.sendMessage(target.id, { type });
  } catch (_) {
    // 치지직이 아닌 탭, 또는 설치 전부터 열린 탭(새로고침 필요)
    flashBadge(target.id);
  }
});

// 영상 동시 저장: 모든 탭에 같은 시각(stamp)으로 저장 명령
// (tabs 권한 없이 모든 탭에 보내고, 응답 없는 탭은 제외)
async function saveAllVideos(activeTab) {
  const stamp = Date.now();
  const tabs = await chrome.tabs.query({});
  const results = await Promise.all(tabs.map(t =>
    chrome.tabs.sendMessage(t.id, { type: 'save-video', group: true, stamp })
      .then(r => ({ tabId: t.id, ...r }))
      .catch(() => null)));
  const chzzk = results.filter(Boolean);
  const saving = chzzk.filter(r => r.willSave);
  const names = saving.map(r => r.name || '이름 모름');
  const skipped = chzzk.filter(r => !r.willSave).length;

  let text, kind = 'ok';
  if (!chzzk.length) { text = '열린 치지직 탭이 없습니다.'; kind = 'warn'; }
  else if (!saving.length) { text = '영상이 켜져 있고 담긴 장면이 있는 탭이 없습니다.\n탭마다 확장 아이콘에서 영상을 켜십시오.'; kind = 'warn'; }
  else {
    text = `동시 저장 ${saving.length}개 탭: ${names.join(', ')}`;
    if (skipped) text += `\n(영상 꺼짐/준비 안 됨 ${skipped}개 제외)`;
  }
  // 현재 탭이 치지직이면 요약 알림, 아니면 아이콘에 표시
  let target = activeTab;
  if (!target || target.id == null) [target] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const shown = target && await chrome.tabs.sendMessage(target.id, { type: 'toast', text, kind, ms: 5000, slot: 'summary' }).catch(() => null);
  if (!shown && target) flashBadge(target.id, saving.length ? String(saving.length) : '!', saving.length ? '#00c77f' : '#ff5a5a');
}

// 교차편집: 모든 탭의 버퍼를 고정 → 준비된 탭으로 편집기 열기
// trimTabId가 있으면 다듬기 모드 (그 탭 하나, 그 채널 위치에 저장)
async function openEditor(activeTab, trimTabId = null, fromRec = false) {
  const trim = trimTabId != null;
  const session = String(Date.now());
  const tabs = trim ? [{ id: trimTabId }] : await chrome.tabs.query({});
  const results = await Promise.all(tabs.map(t =>
    chrome.tabs.sendMessage(t.id, { type: 'snapshot', session, rec: fromRec })
      .then(r => ({ tabId: t.id, ...r }))
      .catch(() => null)));
  const ready = results.filter(r => r && r.ready).slice(0, trim ? 1 : 5); // 교차편집 최대 5개
  const skipped = results.filter(r => r && !r.ready).length;
  if (!ready.length) {
    const text = trim
      ? '이 탭에는 다듬을 장면이 없습니다.\n확장 아이콘에서 이 채널의 영상이나 움짤을 켜고, 몇 초 재생한 뒤 다시 시도하십시오.'
      : '교차편집할 영상이 없습니다.\n탭마다 확장 아이콘에서 영상을 켜고, 몇 초 재생한 뒤 다시 시도하십시오.';
    let target = activeTab;
    if (!target || target.id == null) [target] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const shown = target && await chrome.tabs.sendMessage(target.id, { type: 'toast', text, kind: 'warn', ms: 4000, slot: 'summary' }).catch(() => null);
    if (!shown && target) flashBadge(target.id);
    return { ok: false, error: text };
  }
  const { debug } = await chrome.storage.local.get('debug'); // 자동 테스트용
  const url = chrome.runtime.getURL('editor/editor.html') + (debug ? '?debug=1&' : '?') +
    `session=${session}&tabs=${ready.map(r => r.tabId).join(',')}&skipped=${trim ? 0 : skipped}` + (trim ? '&mode=trim' : '') + (fromRec ? '&rec=1' : '');
  await chrome.tabs.create({ url });
  return { ok: true, count: ready.length };
}

// 배지를 잠깐 바꿨다가 되돌리기
const badgeState = new Map(); // tabId → { text, color }
const recTabs = new Set();     // 녹화 중인 탭 (배지 유지)
function flashBadge(tabId, text = '!', color = '#ff5a5a') {
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  setTimeout(() => {
    const b = badgeState.get(tabId) || { text: '', color: '#3a3a42' };
    chrome.action.setBadgeBackgroundColor({ color: b.color, tabId }).catch(() => {});
    chrome.action.setBadgeText({ text: b.text, tabId }).catch(() => {});
  }, 2500);
}

// 탭별 배지: 움 / 영 / 움영 / OFF (채널 화면이 아니면 없음)
function setChannelBadge(tabId, s) {
  let text = '', color = '#3a3a42';
  if (s.known) {
    if (s.gif && s.video) text = '움영';
    else if (s.gif) text = '움';
    else if (s.video) text = '영';
    else text = 'OFF';
    color = (s.gif || s.video) ? '#00c77f' : '#5a5a66';
  }
  badgeState.set(tabId, { text, color });
  if (recTabs.has(tabId)) return; // 녹화 중에는 REC 유지
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff', tabId }).catch(() => {});
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
}
chrome.tabs.onRemoved.addListener(tabId => { badgeState.delete(tabId); recTabs.delete(tabId); });

// ② offscreen 페이지 준비
let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: '움짤/영상 파일 조립과 다운로드 주소 생성'
    }).finally(() => { creating = null; });
  }
  await creating;
}

// ③ 메시지 처리
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return; // offscreen 전용

  // 치지직 페이지 요청만 처리
  const from = sender.url || sender.origin || '';
  const fromChzzk = from.startsWith('https://chzzk.naver.com');

  // 교차편집 열기
  if (msg.type === 'open-editor') {
    if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return;
    const trimTab = Number.isInteger(msg.trimTabId) ? msg.trimTabId : null; // 다듬어 저장
    openEditor(null, trimTab).then(sendResponse);
    return true;
  }

  // 녹화 종료 → 그 탭으로 다듬기 화면
  if (msg.type === 'record-done') {
    if (fromChzzk && sender.tab && sender.tab.id != null) openEditor(sender.tab, sender.tab.id, true);
    sendResponse({ ok: true });
    return;
  }
  // 녹화 중 배지 (REC)
  if (msg.type === 'rec-state') {
    if (fromChzzk && sender.tab && sender.tab.id != null) {
      const id = sender.tab.id;
      if (msg.on) {
        chrome.action.setBadgeBackgroundColor({ color: '#ff3b3b', tabId: id }).catch(() => {});
        chrome.action.setBadgeText({ text: 'REC', tabId: id }).catch(() => {});
      } else {
        const b = badgeState.get(id) || { text: '', color: '#3a3a42' };
        chrome.action.setBadgeBackgroundColor({ color: b.color, tabId: id }).catch(() => {});
        chrome.action.setBadgeText({ text: b.text, tabId: id }).catch(() => {});
      }
      recTabs[msg.on ? 'add' : 'delete'](id);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'badge') {
    if (fromChzzk && sender.tab && sender.tab.id != null) setChannelBadge(sender.tab.id, msg);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'dl-prepare') {
    if (!fromChzzk) { sendResponse({ ok: false, error: '허용되지 않은 출처' }); return; }
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // 비동기 응답
  }

  if (msg.type === 'download') {
    if (!fromChzzk) { sendResponse({ ok: false, error: '허용되지 않은 출처' }); return; }
    // 이 확장이 만든 파일 주소만 허용
    const own = 'blob:' + chrome.runtime.getURL('').replace(/\/$/, '');
    if (typeof msg.url !== 'string' || !msg.url.startsWith(own)) {
      sendResponse({ ok: false, error: '잘못된 파일' });
      return;
    }
    saveFile(msg.url, msg.filename, msg.streamer, msg.sub)
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
});

// ── 파일 저장 ─────────────────────────────────────────
// 파일/폴더 이름에 못 쓰는 글자 제거
function clean(part) {
  return String(part || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
}

// 다운로드 안 폴더 (최대 3단계)
function cleanFolder(folder) {
  return String(folder || '').split(/[\\/]+/).map(clean).filter(p => p && p !== '..').slice(0, 3).join('/');
}

// 저장 위치: 다운로드/{saveFolder}/{스트리머명}/{방송제목｜yymmdd}/파일
async function saveFile(url, name, streamer, sub) {
  const D = globalThis.CHZZK_CLIP_DEFAULTS;
  const { saveFolder, saveMode } = await chrome.storage.sync.get({ saveFolder: D.saveFolder, saveMode: D.saveMode });
  const askSaveAs = saveMode === 'ask';

  let file = clean(name);
  if (!/\.(webp|mp4)$/i.test(file)) file = 'chzzk_clip.bin';
  const folder = [cleanFolder(saveFolder), clean(streamer) || 'chzzk', clean(sub)].filter(Boolean).join('/');
  const path = folder ? `${folder}/${file}` : file;

  // 확장은 다운로드 폴더 안에만 직접 저장 가능. '선택한 폴더' 방식은 offscreen이 처리하고,
  // 여기는 'downloads'/'ask' 방식과 선택 폴더 실패 시 대체 저장만 처리
  const start = filename => chrome.downloads.download({
    url, filename,
    conflictAction: 'uniquify', // 같은 이름이면 (1), (2)
    saveAs: !!askSaveAs
  });

  try {
    return { id: await start(path), path };
  } catch (err) {
    if (!/filename/i.test(String(err && err.message))) throw err;
  }
  // 시스템이 한글 이름을 거부하면 영문 이름으로 대체 저장
  const ascii = s => s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  // 파일 이름: [스트리머명｜방송제목] yy-mm-dd hh：mm：ss.확장자
  //   영문 대체: 시각은 yy-mm-dd hh-mm-ss, 제목은 영문만
  const m = file.match(/^\[(.*)\] (\d\d-\d\d-\d\d) (\d\d)：(\d\d)：(\d\d)\.\w+$/);
  const stamp = m ? `${m[2]} ${m[3]}-${m[4]}-${m[5]}` : String(Date.now());
  const who = (m ? m[1] : file.replace(/\.\w+$/, '')).split('｜').map(ascii).filter(Boolean).join(' - ');
  const ext = file.slice(file.lastIndexOf('.'));
  const asciiFolder = folder.split('/').map(ascii).filter(Boolean).join('/');
  const fbFolder = folder ? (asciiFolder || 'chzzk-clips') : '';
  const fbFile = `[${who || 'chzzk'}] ${stamp}${ext}`;
  const fallback = fbFolder ? `${fbFolder}/${fbFile}` : fbFile;
  return { id: await start(fallback), path: fallback };
}
