// 팝업: 채널 스위치·저장 길이, 다듬어 저장·교차편집, 저장 위치 요약
// 나머지 설정은 settings/options.html
(() => {
  'use strict';
  const DEFAULTS = globalThis.CHZZK_CLIP_DEFAULTS;
  const Channels = globalThis.ChzzkChannels;
  const Store = globalThis.ChzzkHandleStore;
  const $ = id => document.getElementById(id);

  // ── 저장 길이 (모든 채널 공통) ──
  const LENGTHS = ['clipSeconds', 'videoSeconds'];
  function renderLengths(s) {
    $('clipSeconds').value = String(s.clipSeconds);
    $('videoSeconds').value = String(s.videoSeconds);
    $('clipSecondsOut').textContent = `${s.clipSeconds}초`;
    $('videoSecondsOut').textContent = `${s.videoSeconds}초`;
  }
  const readLengths = () => ({ clipSeconds: Number($('clipSeconds').value), videoSeconds: Number($('videoSeconds').value) });
  let savedTimer = null;
  function flashSaved() {
    $('saved').textContent = '저장됨';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1200);
  }
  for (const k of LENGTHS) {
    $(k).addEventListener('input', () => renderLengths(readLengths()));
    $(k).addEventListener('change', async () => { await chrome.storage.sync.set(readLengths()); flashSaved(); });
  }

  // ── 단축키 표시 ──
  chrome.commands.getAll().then(cmds => {
    const get = name => { const c = cmds.find(x => x.name === name); return (c && c.shortcut) || ''; };
    $('shortcutClip').textContent = get('save-clip') || '키 없음';
    $('shortcutVideo').textContent = get('save-video') || '키 없음';
    $('shortcutAll').textContent = get('save-all-videos') || '키 없음';
    $('shortcutEditor').textContent = get('open-editor') || '키 없음';
    const recKey = get('record-toggle');
    if (recKey) $('recToggle').title += ` (${recKey})`;
    const trim = get('trim-clip');
    if (trim) { const k = document.createElement('kbd'); k.textContent = trim; $('openTrim').append(' ', k); }
  });

  // ── 버튼 ──
  const hint = text => { $('actionHint').textContent = text; };
  $('openEditor').addEventListener('click', async () => {
    hint('여는 중…');
    const r = await chrome.runtime.sendMessage({ type: 'open-editor' }).catch(e => ({ ok: false, error: e.message }));
    hint(r && r.ok ? `${r.count}개 탭으로 편집기를 열었습니다` : ((r && r.error) || '열지 못했습니다'));
  });
  $('recToggle').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'record-toggle' }).catch(() => hint('치지직 방송 탭에서 사용할 수 있습니다'));
    setTimeout(refreshStatus, 300);
  });
  $('openTrim').addEventListener('click', async () => {
    hint('여는 중…');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.runtime.sendMessage({ type: 'open-editor', trimTabId: tab && tab.id }).catch(e => ({ ok: false, error: e.message }));
    hint(r && r.ok ? '다듬기 화면을 열었습니다' : ((r && r.error) || '열지 못했습니다'));
  });
  const openSettings = section => {
    const q = current ? `?channel=${current.id}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/options.html') + q + (section ? '#' + section : '') });
    window.close();
  };
  $('openSettings').addEventListener('click', () => openSettings(''));
  $('whereEdit').addEventListener('click', e => { e.preventDefault(); openSettings(current ? 'channels' : 'save'); });

  // ── 상태 ──
  function line(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  }

  async function refreshStatus() {
    const box = $('status');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
      if (!st || !st.ok) throw new Error();
      renderChannel(st.channel);
      const lines = [];
      if (!st.channel || !st.channel.id) {
        lines.push(line('', '채널 화면(라이브·다시보기)에서 사용할 수 있습니다.'));
      } else if (!st.channel.gif && !st.channel.video) {
        lines.push(line('', '이 채널은 꺼져 있습니다. 아래 스위치로 움짤·영상을 켤 수 있습니다.'));
      } else if (!st.hasVideo) {
        lines.push(line('warn', st.problem || '영상을 찾는 중…'));
      } else {
        if (st.channel.gif) lines.push(st.problem
          ? line('warn', '움짤: ' + st.problem)
          : line('ok', `움짤 버퍼 ${st.seconds}초 · ${(st.bytes / 1048576).toFixed(1)}MB` + (st.paused ? ' · 일시정지' : '')));
        // 압축이 밀려 장면이 빠지면 경고
        if (st.channel.gif && !st.problem && !st.paused && st.realFps && st.realFps < st.fps * 0.8) {
          lines.push(line('warn', `움짤 장면이 빠지고 있습니다 (설정 ${st.fps}fps → 실제 ${st.realFps}fps). 설정에서 가로 크기나 fps를 낮추면 됩니다.`));
        }
        const v = st.video;
        const recOn = !!(v && v.recording != null);
        $('recToggle').classList.toggle('on', recOn);
        $('recToggle').textContent = recOn ? `■ ${Math.floor(v.recording / 60)}:${String(v.recording % 60).padStart(2, '0')}` : '● 녹화';
        if (recOn) lines.push(line('warn', `● 녹화 중 ${Math.floor(v.recording / 60)}분 ${v.recording % 60}초 · 다시 누르면 종료 후 다듬기`));
        if (v && v.enabled) {
          lines.push(v.problem
            ? line('warn', '영상: ' + v.problem)
            : line('ok', `영상 버퍼 ${v.seconds}초 · ${(v.bytes / 1048576).toFixed(1)}MB` +
                (v.codec ? ` · ${v.codec}` : '') + (v.quality ? ` · ${v.quality}` : '') + (v.audio ? ` · 소리 ${v.audio}` : '')));
          if (!v.problem && v.srcHeight && v.srcHeight < v.targetHeight) {
            lines.push(line('warn', `플레이어 화질이 ${v.srcHeight}p입니다. 플레이어 화질을 ${v.targetHeight}p 이상으로 고정하면 더 선명하게 저장됩니다.`));
          }
          if (!v.problem && v.dropRate >= 10) lines.push(line('warn', `압축이 밀려 장면의 ${v.dropRate}%가 빠지고 있습니다. 화질이나 fps를 낮추십시오.`));
          if (v.colorNote) lines.push(line('warn', v.colorNote));
          if (v.colorMode && v.colorMode !== 'yuv') {
            const name = { 'rgb-comp': '보정 방식', rgb: '기본 방식' }[v.colorMode] || v.colorMode;
            lines.push(v.colorOk
              ? line('dim', `색 처리: ${name} · 정상`)
              : line('warn', `색 처리: ${name} · 색이 다르게 저장될 수 있습니다` + (v.colorDetail ? ` (검사 ${v.colorDetail})` : '')));
          }
        }
      }
      box.replaceChildren(...lines);
    } catch (_) {
      renderChannel(null);
      box.replaceChildren(line('', '치지직 방송/다시보기 탭에서 열면 상태가 표시됩니다. (설치·업데이트 직후라면 탭을 새로고침)'));
    }
  }

  // ── 이 탭의 채널: 움짤·영상 스위치 ──
  let current = null; // { id, name, gif, video, folder }
  let busy = false;   // 스위치 직후 상태 갱신이 덮어쓰지 않게

  function renderChannel(ch) {
    const known = !!(ch && ch.id);
    const changed = (current && current.id) !== (known ? ch.id : undefined) || (current && ch && current.folder !== ch.folder);
    current = known ? ch : null;
    $('channelName').textContent = known ? (ch.name || ch.id.slice(0, 8) + '…') : '채널 화면이 아님';
    for (const [id, keyName] of [['enabled', 'gif'], ['videoEnabled', 'video']]) {
      $(id).disabled = !known;
      if (!busy) $(id).checked = known && !!ch[keyName];
    }
    if (!busy) {
      $('gifGroup').classList.toggle('off', !(known && ch.gif));
      $('videoGroup').classList.toggle('off', !(known && ch.video));
    }
    if (changed || !whereDone) renderWhere();
  }

  for (const [id, keyName] of [['enabled', 'gif'], ['videoEnabled', 'video']]) {
    $(id).addEventListener('change', async () => {
      if (!current) return;
      busy = true;
      current = { ...current, [keyName]: $(id).checked };
      await Channels.update(current.id, { [keyName]: $(id).checked, name: current.name || undefined });
      $('gifGroup').classList.toggle('off', !current.gif);
      $('videoGroup').classList.toggle('off', !current.video);
      flashSaved();
      setTimeout(() => { busy = false; }, 1500);
    });
  }

  // ── 저장 위치 요약 ──
  let whereDone = false;
  async function renderWhere() {
    whereDone = true;
    const el = $('whereText');
    const ch = current;
    const who = (ch && ch.name) || '스트리머명';
    const grantLink = (text, hash) => {
      const a = document.createElement('a');
      a.href = '#'; a.textContent = text; a.className = 'warnLink';
      a.addEventListener('click', e => {
        e.preventDefault();
        const q = hash === 'ch' && ch ? `?channel=${ch.id}&name=${encodeURIComponent(ch.name || '')}` : '';
        chrome.tabs.create({ url: chrome.runtime.getURL('settings/folder.html') + q + '#grant' });
      });
      return a;
    };
    // 채널 전용 폴더
    if (ch && ch.folder === 'custom') {
      const dir = await Store.get(ch.id).catch(() => null);
      if (dir) {
        const ok = (await Store.permission(dir)) === 'granted';
        el.replaceChildren(`${dir.name}/방송제목｜날짜 (채널 전용)`);
        if (!ok) el.append(' · ', grantLink('권한 다시 허용', 'ch'));
        return;
      }
    }
    const s = await chrome.storage.sync.get({ saveMode: DEFAULTS.saveMode, saveFolder: DEFAULTS.saveFolder });
    if (s.saveMode === 'ask') { el.replaceChildren('저장할 때마다 묻기'); return; }
    if (s.saveMode === 'picked') {
      const dir = await Store.get().catch(() => null);
      if (dir) {
        const ok = (await Store.permission(dir)) === 'granted';
        el.replaceChildren(`${dir.name}/${who}/방송제목｜날짜`);
        if (!ok) el.append(' · ', grantLink('권한 다시 허용', ''));
        return;
      }
    }
    el.replaceChildren(`다운로드/${s.saveFolder}/${who}/방송제목｜날짜`);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.saveMode || changes.saveFolder)) renderWhere();
    if (area === 'sync' && (changes.clipSeconds || changes.videoSeconds)) chrome.storage.sync.get(DEFAULTS).then(renderLengths);
  });

  // ── 첫 사용 안내 ──
  chrome.storage.local.get('noticeOkV2').then(r => { $('notice').hidden = !!r.noticeOkV2; });
  $('noticeOk').addEventListener('click', async () => {
    await chrome.storage.local.set({ noticeOkV2: true });
    $('notice').hidden = true;
  });
  $('showNotice').addEventListener('click', e => { e.preventDefault(); $('notice').hidden = false; window.scrollTo(0, 0); });

  chrome.storage.sync.get(DEFAULTS).then(renderLengths);
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
