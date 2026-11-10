/* 实时推演自动记录；演习回放只展示已记录的过程，不重算或下达任务。 */
'use strict';
const playbackUi = { busy: false, dragging: false, catalogKey: null, catalog: null, catalogPending: null, locatedKey: null };

function exercisePlaybackActive() { return Boolean(state.replay?.enabled && state.replay?.mode === 'exercise'); }
function replayClock(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function replayCatalogKey() { return `${state.sessionId}|${state.replay?.branch_id || ''}|${state.replay?.computed_until || 0}`; }
async function ensureReplayCatalog() {
  if (!exercisePlaybackActive()) { playbackUi.catalog = null; playbackUi.catalogKey = null; return; }
  const key = replayCatalogKey();
  if (playbackUi.catalogKey === key || playbackUi.catalogPending === key) return;
  playbackUi.catalogPending = key;
  try {
    const response = await fetch(`${API_BASE}/api/replay/events`, { cache: 'no-store' });
    if (!response.ok) throw new Error('events unavailable');
    const catalog = await response.json();
    if (!exercisePlaybackActive() || replayCatalogKey() !== key) return;
    playbackUi.catalogKey = key; playbackUi.catalog = catalog;
    panelRenderState.decisionCache = null;
    renderLlmTrace();
    if (state.contextView === 'manual') renderManualPanel();
  } catch (error) {
    if (exercisePlaybackActive() && replayCatalogKey() === key) {
      playbackUi.catalogKey = key;
      toast('完整事件记录暂未加载，可返回实时后重新进入回放');
    }
  } finally { if (playbackUi.catalogPending === key) playbackUi.catalogPending = null; }
}

function renderPlaybackControls() {
  if (!$('liveModeTab')) return;
  const replay = state.replay || {}, active = exercisePlaybackActive();
  const allowed = state.connected && state.sessionMode !== 'navigation';
  const start = Number(replay.start_time) || 0;
  const end = Math.max(start, Number(active ? replay.computed_until : replay.recorded_until ?? replay.computed_until) || start);
  const cursor = Math.max(start, Math.min(end, Number(replay.cursor_time ?? state.elapsed) || 0));
  const dock = document.querySelector('.playback-dock');
  dock.dataset.mode = active ? 'exercise' : 'live';
  dock.hidden = !active;
  const canDrive = (state.connected || state.dataSource === 'demo') && !playbackUi.busy;
  for (const id of ['runToggle', 'speedToggle', 'stepButton']) $(id).disabled = !canDrive;
  $('speedToggle').disabled ||= speedRequestPending;
  for (const [id, selected] of [['liveModeTab', !active], ['exerciseModeTab', active]]) {
    const tab = $(id); tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1; tab.disabled = !allowed || playbackUi.busy || manualRequestPending();
  }
  $('playbackStatus').textContent = !allowed ? state.sessionMode === 'navigation' ? '导航测试不录制演习' : '连接仿真服务后自动记录' : active
    ? '拖动时间条，或点击事件旁的“定位”回看'
    : end > start ? `已记录 ${replayClock(end - start)}` : '自动记录演习过程';
  $('replayLiveActions').hidden = active; $('replayReviewActions').hidden = !active;
  $('replayExport').disabled = active || !allowed || playbackUi.busy || end <= start;
  $('replayImport').disabled = !allowed || playbackUi.busy;
  $('replayTransport').hidden = !active;
  const seek = $('replaySeek'); seek.min = String(start); seek.max = String(end);
  seek.step = String(Math.max(.001, Number(state.dt) || 1));
  if (!playbackUi.dragging) seek.value = String(cursor);
  seek.disabled = !active || !allowed || playbackUi.busy || end <= start;
  $('replayTime').textContent = `${replayClock(playbackUi.dragging ? seek.value : cursor)} / ${replayClock(end)}`;
  $('replayBack').disabled = !active || !allowed || playbackUi.busy || cursor <= start;
  $('replayForward').disabled = !active || !allowed || playbackUi.busy || cursor >= end;
  ensureReplayCatalog();
}

async function playbackRequest(path, payload) {
  if (!state.connected || playbackUi.busy) return false;
  playbackUi.busy = true; renderPlaybackControls();
  try {
    const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: payload instanceof Blob ? payload : JSON.stringify(payload || {}) });
    const body = await response.json();
    if (!response.ok) { toast(typeof body.detail === 'string' ? body.detail : '未能更新回放，请检查文件或当前状态'); return false; }
    const snapshot = body.simulation ? body : body.state;
    if (snapshot) applyBackendSnapshot(snapshot);
    if (body.message) toast(body.message);
    return true;
  } catch (error) { toast('回放操作暂未响应，请检查仿真服务'); return false; }
  finally { playbackUi.busy = false; playbackUi.dragging = false; renderPlaybackControls(); if (exercisePlaybackActive()) renderLlmTrace(); }
}
function seekPlayback(time, locatedKey = null) {
  if (!exercisePlaybackActive()) return false;
  playbackUi.locatedKey = locatedKey;
  const replay = state.replay || {}, start = Number(replay.start_time) || 0, end = Math.max(start, Number(replay.computed_until) || start);
  return playbackRequest('/api/replay/seek', { time: Math.max(start, Math.min(end, Number(time) || start)) });
}
function exportPlayback(filename) {
  if (!state.connected || playbackUi.busy || exercisePlaybackActive()) return;
  const name = String(filename || '').trim().replace(/\.json$/i, '') || `TZB-${state.scene}-${replayClock(state.elapsed).replaceAll(':', '-')}`;
  const downloadName = `${name}.json`;
  // 直接交给浏览器保存，不把完整演习文件再复制成内存中的 Blob。
  const link = document.createElement('a');
  link.href = `${API_BASE}/api/replay/export?filename=${encodeURIComponent(downloadName)}`;
  document.body.appendChild(link); link.click(); link.remove();
  toast('已开始保存演习回放');
}
function showReplaySaveDialog() {
  if (!state.connected || exercisePlaybackActive() || $('replayExport').disabled) return;
  $('replayFilename').value = `${sceneConfig().name}-${replayClock(state.elapsed).replaceAll(':', '-')}`;
  $('replayFilename').setCustomValidity('');
  $('replaySaveDialog').showModal();
  $('replayFilename').focus(); $('replayFilename').select();
}
function prepareReplayView() {
  playbackUi.catalog = null; playbackUi.catalogKey = null; playbackUi.locatedKey = null;
  state.decisionRange = 'full';
  panelRenderState.decisionCache = null;
}
function showReplayEvents() {
  if (narrowOperations.matches) return;
  state.contextView = 'events';
  renderInspector();
}
function setupPlaybackControls() {
  $('exerciseModeTab').addEventListener('click', async () => {
    if (exercisePlaybackActive()) return;
    prepareReplayView();
    if (await playbackRequest('/api/replay/enter', {})) showReplayEvents();
  });
  $('liveModeTab').addEventListener('click', () => {
    if (exercisePlaybackActive()) playbackRequest('/api/replay/exit', {});
  });
  document.querySelector('.playback-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || playbackUi.busy) return;
    event.preventDefault();
    const tab = ['ArrowLeft', 'Home'].includes(event.key) ? $('liveModeTab') : $('exerciseModeTab');
    tab.click(); tab.focus();
  });
  $('replayBack').addEventListener('click', () => seekPlayback(Number(state.replay?.cursor_time ?? state.elapsed) - 10));
  $('replayForward').addEventListener('click', () => seekPlayback(Number(state.replay?.cursor_time ?? state.elapsed) + 10));
  const seek = $('replaySeek');
  seek.addEventListener('input', () => { playbackUi.dragging = true; renderPlaybackControls(); });
  seek.addEventListener('change', () => { const time = Number(seek.value); playbackUi.dragging = false; seekPlayback(time); });
  seek.addEventListener('blur', () => { if (!playbackUi.busy) { playbackUi.dragging = false; renderPlaybackControls(); } });
  $('replayExport').addEventListener('click', showReplaySaveDialog);
  $('replaySaveForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const filename = $('replayFilename').value.trim();
    if (!filename) { $('replayFilename').setCustomValidity('请填写回放名称'); $('replayFilename').reportValidity(); return; }
    exportPlayback(filename); $('replaySaveDialog').close();
  });
  $('replayFilename').addEventListener('input', () => $('replayFilename').setCustomValidity(''));
  document.querySelectorAll('[data-replay-save-cancel]').forEach(button => button.addEventListener('click', () => $('replaySaveDialog').close()));
  $('replayImport').addEventListener('click', () => $('replayFile').click());
  $('replayFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 128 * 1024 * 1024) { toast('回放文件超过 128 MB，请选择较小的记录'); return; }
      prepareReplayView();
      if (await playbackRequest('/api/replay/load', new Blob(['{"archive":', file, '}'], { type: 'application/json' }))) showReplayEvents();
    } finally { event.target.value = ''; }
  });
  renderPlaybackControls();
}
