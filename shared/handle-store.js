// ─────────────────────────────────────────────────────────────
// 선택한 저장 폴더(handle) 보관소 — IndexedDB
//   'saveDir'     : 기본 저장 폴더 (안에 스트리머별 폴더 생성)
//   'ch:<채널ID>' : 채널 전용 폴더
// ─────────────────────────────────────────────────────────────
(function (root) {
  'use strict';
  const DB = 'chzzk-clip', STORE = 'handles', BASE = 'saveDir';

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => { resolve(req ? req.result : undefined); db.close(); };
      t.onerror = () => { reject(t.error); db.close(); };
    });
  }

  // 권한 상태: 'granted' / 'prompt' / 'denied' / 'none'(폴더 없음)
  async function permission(handle) {
    if (!handle) return 'none';
    try { return await handle.queryPermission({ mode: 'readwrite' }); } catch (_) { return 'denied'; }
  }

  const keyFor = channelId => (channelId ? 'ch:' + channelId : BASE);

  root.ChzzkHandleStore = {
    // channelId가 있으면 채널 전용 폴더, 없으면 기본 저장 폴더
    get: channelId => run('readonly', s => s.get(keyFor(channelId))),
    set: (handle, channelId) => run('readwrite', s => s.put(handle, keyFor(channelId))),
    clear: channelId => run('readwrite', s => s.delete(keyFor(channelId))),
    permission
  };
})(globalThis);
