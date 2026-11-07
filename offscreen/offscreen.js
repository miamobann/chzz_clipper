// ─────────────────────────────────────────────────────────────
// 보이지 않는 도우미 페이지 (offscreen document)
// 탭이 base64로 나눠 보낸 조각을 파일로 합칩니다.
//   - '선택한 폴더' 방식: 그 폴더에 직접 저장
//   - 그 외(또는 권한 없음): blob 주소를 돌려주고 백그라운드가 다운로드 폴더에 저장
// ─────────────────────────────────────────────────────────────
'use strict';

const Store = globalThis.ChzzkHandleStore;
const jobs = new Map(); // id → { parts: Uint8Array[], size, touched }
// 파일당 최대 크기, 동시 작업 수
const MAX_JOB_BYTES = 512 * 1024 * 1024;
const MAX_JOBS = 20;

function decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 파일 이름에 못 쓰는 글자 제거 (폴더 구분자 포함)
function cleanFile(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'chzzk_clip';
}

// 같은 이름이 있으면 "이름 (1).mp4" …
async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 1000; i++) {
    const candidate = i ? `${base} (${i})${ext}` : name;
    try {
      await dir.getFileHandle(candidate); // 있으면 다음 번호
    } catch (err) {
      if (err && err.name === 'NotFoundError') return candidate;
      if (err && err.name === 'TypeMismatchError') continue; // 같은 이름의 폴더
      throw err;
    }
  }
  return `${base} (${Date.now()})${ext}`;
}

// 선택한 폴더에 직접 쓰기. 실패하면 { note: 이유 }
//   channelId 있음: 채널 전용 폴더/방송 폴더 / 없음: 기본 저장 폴더/스트리머명/방송 폴더
async function writeToPickedFolder(blob, filename, channelId, streamer, sub) {
  const dir = await Store.get(channelId || undefined).catch(() => null);
  const which = channelId ? '이 채널 전용 저장 폴더' : '기본 저장 폴더';
  if (!dir) return { note: `${which}가 선택되지 않았습니다` };
  const perm = await Store.permission(dir);
  if (perm !== 'granted') return { note: `${which} 권한이 필요합니다 → 확장 아이콘 → "권한 다시 허용"` };
  try {
    let target = dir, prefix = dir.name;
    if (!channelId) {
      const sub = cleanFile(streamer) || 'chzzk';
      target = await dir.getDirectoryHandle(sub, { create: true });
      prefix = `${dir.name}/${sub}`;
    }
    const bsub = cleanFile(sub || '').replace(/^chzzk_clip$/, '');
    if (bsub) {
      target = await target.getDirectoryHandle(bsub, { create: true });
      prefix = `${prefix}/${bsub}`;
    }
    // 확장자 재확인 (다운로드 저장과 같은 규칙)
    let file = cleanFile(filename);
    if (!/\.(webp|mp4)$/i.test(file)) file = 'chzzk_clip.bin';
    const name = await uniqueName(target, file);
    const fh = await target.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return { path: `${prefix}/${name}` };
  } catch (err) {
    if (err && err.name === 'NotFoundError') return { note: '선택한 폴더를 찾을 수 없습니다(삭제 또는 이동) → 폴더를 다시 선택하십시오' };
    if (err && err.name === 'NotAllowedError') return { note: '저장 폴더 권한이 필요합니다 → 확장 아이콘 → "권한 다시 허용"' };
    return { note: '선택한 폴더에 쓰지 못했습니다: ' + ((err && err.message) || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  const from = sender.url || '';
  if (!from.startsWith('https://chzzk.naver.com')) {
    sendResponse({ ok: false, error: '허용되지 않은 출처' });
    return;
  }

  if (msg.type === 'dl-part') {
    try {
      let job = jobs.get(msg.id);
      if (!job) {
        if (jobs.size >= MAX_JOBS) throw new Error('동시에 저장 중인 파일이 너무 많습니다. 잠시 뒤 다시 시도하십시오');
        job = { parts: [], size: 0, touched: 0 };
        jobs.set(msg.id, job);
      }
      const piece = decode(msg.part);
      if (job.size + piece.length > MAX_JOB_BYTES) {
        jobs.delete(msg.id);
        throw new Error('파일이 너무 큽니다 (최대 512MB)');
      }
      job.parts.push(piece);
      job.size += piece.length;
      job.touched = Date.now();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === 'dl-finish') {
    (async () => {
      const job = jobs.get(msg.id);
      if (!job) throw new Error('받은 조각이 없습니다');
      jobs.delete(msg.id);
      const mime = msg.mime === 'video/mp4' ? 'video/mp4' : 'image/webp';
      const blob = new Blob(job.parts, { type: mime });

      let note = null;
      // 채널 전용 폴더가 있으면 기본 방식과 무관하게 사용 ('매번 묻기' 제외)
      if (msg.channelId && msg.mode !== 'ask') {
        const r = await writeToPickedFolder(blob, msg.filename, msg.channelId, msg.streamer, msg.sub);
        if (r.path) return { ok: true, saved: true, path: r.path };
        note = r.note;
      } else if (msg.mode === 'picked') {
        const r = await writeToPickedFolder(blob, msg.filename, null, msg.streamer, msg.sub);
        if (r.path) return { ok: true, saved: true, path: r.path };
        note = r.note; // 실패 시 다운로드 폴더로 대체
      }
      const url = URL.createObjectURL(blob);
      // 다운로드 시작 후 여유를 두고 해제 ('매번 묻기' 창 대비)
      setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
      return { ok: true, url, note };
    })()
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // 비동기 응답
  }
});

// 1분 넘게 멈춘 작업 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.touched > 60000) jobs.delete(id);
}, 30000);
