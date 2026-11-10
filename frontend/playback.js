/* 实时推演与可干预回放共用原控制键，回放条仅控制已计算的历史。 */
'use strict';
const playbackUi = { busy: false, dragging: false };

function replayClock(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function renderPlaybackControls() {
  const mode = $('playbackMode');
  if (!mode) return;
  const replay = state.replay || {}, active = Boolean(replay.enabled);
  const allowed = state.connected && state.sessionMode !== 'navigation';
  if (document.activeElement !== mode) mode.value = active ? 'replay' : 'live';
  mode.disabled = !allowed || playbackUi.busy;
  $('replayTransport').hidden = !active;
  const status = $('playbackStatus');
  if (!active) {
    status.textContent = state.sessionMode === 'navigation' ? '导航测试使用实时推演' : '实时运行与显示同步';
  } else {
    const buffer = Math.max(0, Number(replay.computed_until) - Number(replay.cursor_time));
    status.textContent = replay.preparing ? '正在计算后续片段…'
      : replay.complete ? '后续推演已完成' : `已提前计算 ${Math.floor(buffer)} 秒`;
    status.title = replay.status || `当前分支 ${replay.branch_id || '初始'}，可在当前播放时刻注入指令`;
  }
  status.classList.toggle('is-preparing', Boolean(active && replay.preparing));
  const seek = $('replaySeek'), start = Number(replay.start_time) || 0;
  const end = Math.max(start, Number(replay.computed_until) || start);
  const cursor = Math.max(start, Math.min(end, Number(replay.cursor_time ?? state.elapsed) || 0));
  seek.min = String(start); seek.max = String(end);
  if (!playbackUi.dragging) seek.value = String(cursor);
  seek.disabled = !active || !allowed || playbackUi.busy || end <= start;
  $('replayTime').textContent = `${replayClock(playbackUi.dragging ? seek.value : cursor)} / ${replayClock(end)}`;
  $('replayBack').disabled = !allowed || playbackUi.busy || cursor <= start;
  $('replayForward').disabled = !allowed || playbackUi.busy || cursor >= end;
  $('replayExport').disabled = !allowed || playbackUi.busy || end <= start;
}

async function playbackRequest(path, payload) {
  if (!state.connected || playbackUi.busy) return false;
  playbackUi.busy = true;
  renderPlaybackControls();
  try {
    const response = await fetch(`${API_BASE}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) { toast(typeof body.detail === 'string' ? body.detail : '未能更新回放，请稍后重试'); return false; }
    const snapshot = body.simulation ? body : body.state;
    if (snapshot) applyBackendSnapshot(snapshot);
    if (body.message) toast(body.message);
    return true;
  } catch (error) {
    toast('回放控制暂未响应，请检查仿真服务');
    return false;
  } finally { playbackUi.busy = false; playbackUi.dragging = false; renderPlaybackControls(); }
}

function seekPlayback(time) {
  const replay = state.replay || {};
  const start = Number(replay.start_time) || 0, end = Math.max(start, Number(replay.computed_until) || start);
  return playbackRequest('/api/replay/seek', { time: Math.max(start, Math.min(end, Number(time) || start)) });
}

async function exportPlayback() {
  if (!state.connected || playbackUi.busy) return;
  playbackUi.busy = true; renderPlaybackControls();
  try {
    const response = await fetch(`${API_BASE}/api/replay/export`, { cache: 'no-store' });
    if (!response.ok) throw new Error('export failed');
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `TZB-${state.scene}-${String(state.replay?.branch_id || 'replay').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已保存当前分支的回放记录');
  } catch (error) { toast('回放记录保存失败，请稍后重试'); }
  finally { playbackUi.busy = false; renderPlaybackControls(); }
}

function setupPlaybackControls() {
  $('playbackMode').addEventListener('change', async (event) => {
    const enabled = event.target.value === 'replay';
    await playbackRequest('/api/replay/config', { enabled, lookahead_seconds: 60 });
    event.target.value = state.replay?.enabled ? 'replay' : 'live';
  });
  $('replayBack').addEventListener('click', () => seekPlayback(Number(state.replay?.cursor_time ?? state.elapsed) - 10));
  $('replayForward').addEventListener('click', () => seekPlayback(Number(state.replay?.cursor_time ?? state.elapsed) + 10));
  const seek = $('replaySeek');
  seek.addEventListener('input', () => { playbackUi.dragging = true; renderPlaybackControls(); });
  seek.addEventListener('change', () => { const time = Number(seek.value); playbackUi.dragging = false; seekPlayback(time); });
  seek.addEventListener('blur', () => { if (!playbackUi.busy) { playbackUi.dragging = false; renderPlaybackControls(); } });
  $('replayExport').addEventListener('click', exportPlayback);
  renderPlaybackControls();
}
