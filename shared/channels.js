// ─────────────────────────────────────────────────────────────
// 채널별 설정: chrome.storage.local 'ch:<채널ID>'
//   { gif, video, name: 스트리머명, folder: 'custom'이면 전용 폴더 }
// 처음 보는 채널은 모두 꺼짐입니다.
// ─────────────────────────────────────────────────────────────
(function (root) {
  'use strict';
  const EMPTY = Object.freeze({ gif: false, video: false, name: null, folder: null });
  const key = id => 'ch:' + id;

  async function get(id) {
    if (!id) return { ...EMPTY };
    const r = await chrome.storage.local.get(key(id));
    return { ...EMPTY, ...(r[key(id)] || {}) };
  }

  // 일부만 변경 (예: update(id, { video: true }))
  async function update(id, patch) {
    if (!id) return;
    const cur = await get(id);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await chrome.storage.local.set({ [key(id)]: { ...cur, ...clean } });
  }

  // storage.onChanged에서 해당 채널 변경 확인
  function changeFor(changes, id) {
    const c = id && changes[key(id)];
    return c ? { ...EMPTY, ...(c.newValue || {}) } : null;
  }

  root.ChzzkChannels = { get, update, changeFor, key };
})(globalThis);
