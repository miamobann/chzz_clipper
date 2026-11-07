// 설정 페이지: 움짤·영상, 저장 위치, 채널 목록, 단축키, 이용 안내 (변경 즉시 반영)
(() => {
  'use strict';
  const DEFAULTS = globalThis.CHZZK_CLIP_DEFAULTS;
  const Channels = globalThis.ChzzkChannels;
  const Store = globalThis.ChzzkHandleStore;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const focusId = /^[0-9a-f]{32}$/i.test(params.get('channel') || '') ? params.get('channel').toLowerCase() : null;

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  let savedTimer = null;
  function flashSaved(text = '저장됨') {
    $('saved').textContent = text;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
  }

  // ── 공통 설정 (chrome.storage.sync) ──
  const FIELDS = {
    clipSeconds: 'num', fps: 'num', width: 'num', quality: 'num',
    videoSeconds: 'num', videoHeight: 'num', videoFps: 'num', videoQuality: 'text', audioSyncMs: 'num'
  };
  function render(s) {
    for (const k of Object.keys(FIELDS)) $(k).value = String(s[k]);
    $('clipSecondsOut').textContent = `${s.clipSeconds}초`;
    $('qualityOut').textContent = Number(s.quality).toFixed(2);
    $('videoSecondsOut').textContent = `${s.videoSeconds}초`;
    $('audioSyncMsOut').textContent = (s.audioSyncMs > 0 ? '+' : '') + `${s.audioSyncMs}ms` + (s.audioSyncMs ? '' : ' (자동)');
    // 선택한 압축 품질 강조 + 예상 크기
    document.querySelectorAll('.mini tr[data-q]').forEach(tr => tr.classList.toggle('on', tr.dataset.q === s.videoQuality));
    const bps = globalThis.CHZZK_VIDEO_BITRATE(+s.videoHeight, +s.videoFps, s.videoQuality);
    const mb60 = bps * 60 / 8 / 1048576;
    $('qualityInfo').textContent = `현재: ${s.videoHeight}p ${s.videoFps}fps · 약 ${(bps / 1e6).toFixed(1)}Mbps → 60초 약 ${Math.round(mb60)}MB (영상을 켠 탭마다 같은 양의 버퍼 메모리 사용)`;
  }
  const read = () => Object.fromEntries(Object.entries(FIELDS).map(([k, kind]) => [k, kind === 'num' ? Number($(k).value) : $(k).value]));
  for (const k of Object.keys(FIELDS)) {
    $(k).addEventListener('input', () => render(read()));
    $(k).addEventListener('change', async () => { await chrome.storage.sync.set(read()); flashSaved(); });
  }

  // ── 기본 저장 위치 ──
  const radios = [...document.querySelectorAll('input[name=saveMode]')];
  const openFolderPage = (hash, ch) => {
    const q = ch ? `?channel=${ch.id}&name=${encodeURIComponent(ch.name || '')}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/folder.html') + q + (hash || '') });
  };
  async function renderSave() {
    const s = await chrome.storage.sync.get({ saveMode: DEFAULTS.saveMode, saveFolder: DEFAULTS.saveFolder });
    radios.forEach(r => { r.checked = r.value === s.saveMode; });
    $('saveFolderText').textContent = s.saveFolder;
    const dir = await Store.get().catch(() => null);
    const perm = await Store.permission(dir);
    $('pickedName').textContent = dir ? dir.name : '선택된 폴더 없음';
    $('pickFolder').textContent = dir ? '바꾸기…' : '폴더 선택…';
    const st = $('pickedState');
    if (!dir) { st.className = 'hint'; st.textContent = '다운로드 폴더 밖(D 드라이브, 동영상 폴더 등)도 고를 수 있습니다.'; }
    else if (perm === 'granted') { st.className = 'hint ok'; st.textContent = '✓ 자동 저장 준비됨'; }
    else {
      st.className = 'hint warn';
      st.textContent = '권한을 다시 허용해야 합니다 (크롬을 다시 켠 뒤 등) — ';
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '권한 다시 허용';
      b.addEventListener('click', () => openFolderPage('#grant'));
      st.appendChild(b);
    }
  }
  for (const r of radios) {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      if (r.value === 'picked' && !(await Store.get().catch(() => null))) { openFolderPage(); renderSave(); return; }
      await chrome.storage.sync.set({ saveMode: r.value });
      flashSaved();
      renderSave();
    });
  }
  $('pickFolder').addEventListener('click', () => openFolderPage());

  // ── 채널 목록 (storage.local 'ch:<ID>') ──
  async function renderChannels() {
    const all = await chrome.storage.local.get(null);
    const list = Object.entries(all)
      .filter(([k, v]) => k.startsWith('ch:') && v && typeof v === 'object')
      .map(([k, v]) => ({ id: k.slice(3), ...v }))
      .filter(c => c.gif || c.video || c.folder || c.id === focusId)
      .sort((a, b) => (b.id === focusId) - (a.id === focusId) || String(a.name || a.id).localeCompare(String(b.name || b.id), 'ko'));
    const box = $('chList');
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '아직 없습니다. 치지직 방송에서 확장 아이콘을 눌러 그 채널의 움짤·영상을 켜면 여기에 표시됩니다.';
      box.replaceChildren(p);
      return;
    }
    const rows = [];
    for (const ch of list) {
      const row = $('chRow').content.firstElementChild.cloneNode(true);
      if (ch.id === focusId) row.classList.add('focus');
      row.querySelector('.n').textContent = ch.name || '이름 모름';
      row.querySelector('.id').textContent = ch.id.slice(0, 8) + '…';
      for (const kind of ['gif', 'video']) {
        const cb = row.querySelector('.' + kind);
        cb.checked = !!ch[kind];
        cb.addEventListener('change', async () => { await Channels.update(ch.id, { [kind]: cb.checked }); flashSaved(); });
      }
      const dir = ch.folder === 'custom' ? await Store.get(ch.id).catch(() => null) : null;
      const f = row.querySelector('.f');
      if (dir) {
        const ok = (await Store.permission(dir)) === 'granted';
        f.textContent = `📁 ${dir.name}`;
        if (!ok) {
          const a = document.createElement('button');
          a.type = 'button'; a.className = 'warnBtn'; a.textContent = '권한 다시 허용';
          a.addEventListener('click', () => openFolderPage('#grant', ch));
          f.append(' ', a);
        }
      } else {
        f.textContent = '기본 위치';
        f.classList.add('dim');
      }
      row.querySelector('.pick').addEventListener('click', () => openFolderPage('', ch));
      const reset = row.querySelector('.reset');
      reset.hidden = !dir;
      reset.addEventListener('click', async () => {
        await Store.clear(ch.id).catch(() => {});
        await Channels.update(ch.id, { folder: null });
        flashSaved('기본 위치로 되돌렸습니다');
      });
      row.querySelector('.del').addEventListener('click', async () => {
        await Store.clear(ch.id).catch(() => {});
        await chrome.storage.local.remove(Channels.key(ch.id));
        flashSaved('목록에서 지웠습니다');
      });
      rows.push(row);
    }
    box.replaceChildren(...rows);
  }

  // ── 단축키 ──
  async function renderKeys() {
    const names = {
      'save-clip': '움짤 저장', 'save-video': '영상 저장', 'save-all-videos': '모든 탭 영상 동시 저장',
      'open-editor': '교차편집 열기', 'trim-clip': '다듬어 저장', 'record-toggle': '녹화 시작/종료'
    };
    const cmds = await chrome.commands.getAll();
    const rows = cmds.filter(c => names[c.name]).map(c => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = names[c.name];
      const b = document.createElement('td');
      const k = document.createElement('kbd'); k.textContent = c.shortcut || '키 없음';
      if (!c.shortcut) k.className = 'none';
      b.appendChild(k);
      tr.append(a, b);
      return tr;
    });
    $('keyList').replaceChildren(...rows);
  }
  $('changeShortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // 크롬 단축키 화면에서 돌아오면 갱신
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderKeys(); renderSave(); renderChannels(); } });

  // ── 다른 곳에서 변경되면 다시 그리기 ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      chrome.storage.sync.get(DEFAULTS).then(render);
      if (changes.saveMode || changes.saveFolder) renderSave();
    }
    if (area === 'local' && Object.keys(changes).some(k => k.startsWith('ch:'))) renderChannels();
  });

  chrome.storage.sync.get(DEFAULTS).then(render);
  renderSave();
  renderKeys();
  renderChannels().then(() => {
    if (location.hash) { const el = document.querySelector(location.hash); if (el) el.scrollIntoView(); }
  });
})();
