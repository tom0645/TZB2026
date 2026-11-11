const state = {
  scene: 'rescue',
  running: false,
  speedIndex: 0,
  elapsed: 0,
  layer: 'coverage',
  selected: { type: 'none', id: null },
  overlays: { routes: true, targets: true, cues: true },
  coverage: 0,
  tasks: [],
  platforms: [],
  targets: [],
  alerts: [],
  timeline: [],
  replay: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $('tacticalMap');
const ctx = canvas.getContext('2d');
const sceneConfigs = {
  border: { name: '边境巡检', width: 12000, height: 12000, duration: 7200, coverageLabel: '边境线覆盖率', targetLabel: '目标 ≥ 95%', handled: '02 / 04', mapStatus: '图层：覆盖新鲜度' },
  rescue: { name: '人员搜救', width: 10000, height: 10000, duration: 7200, coverageLabel: '搜索区域覆盖率', targetLabel: '目标 ≥ 90%', handled: '03 / 05', mapStatus: '图层：搜索优先级' },
  area: { name: '区域封控', width: 6000, height: 6000, duration: 5400, coverageLabel: '外围预警覆盖率', targetLabel: '目标 ≥ 90%', handled: '02 / 04', mapStatus: '图层：核心区警戒' },
};
const speeds = [1, 2, 4];
const timelineRanges = { full: null, hour: 3600, ten: 600 };

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `T+${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function currentConfig() { return sceneConfigs[state.scene]; }

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawMap();
}

function mapPoint([x, y]) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const config = currentConfig();
  return [12 + (x / config.width) * (w - 24), h - 12 - (y / config.height) * (h - 24)];
}

function drawGrid(w, h) {
  ctx.strokeStyle = 'rgba(76, 110, 134, .18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i += 1) { const x = 12 + ((w - 24) / 6) * i; const y = 12 + ((h - 24) / 6) * i; ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, h - 12); ctx.stroke(); ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(w - 12, y); ctx.stroke(); }
}

function drawHeatZones(w, h) {
  const zones = state.layer === 'priority'
    ? [[.18, .26, .18, .14, 'rgba(243,184,74,.18)'], [.72, .38, .22, .19, 'rgba(230,94,98,.30)'], [.42, .76, .28, .10, 'rgba(243,184,74,.24)']]
    : state.layer === 'passability'
      ? [[.24, .72, .17, .16, 'rgba(115,134,124,.25)'], [.70, .35, .13, .20, 'rgba(115,134,124,.25)']]
      : [[.34, .83, .25, .09, 'rgba(82,199,217,.16)'], [.73, .72, .15, .14, 'rgba(82,199,217,.15)'], [.46, .22, .28, .10, 'rgba(82,199,217,.10)']];
  zones.forEach(([x, y, rx, ry, fill]) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(12 + x * (w - 24), 12 + y * (h - 24), rx * (w - 24), ry * (h - 24), 0, 0, Math.PI * 2); ctx.fill(); });
}

function drawLandSurface(w, h) {
  const map = state.map || sceneConfig();
  const [left, bottom] = mapPoint([0, 0]), [right, top] = mapPoint([map.width, map.height]);
  ctx.save();
  const renderer = map3dRuntime.renderer;
  if (renderer?.terrainTextureReady && renderer.width === map.width && renderer.height === map.height) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(renderer.terrainTexture, left, top, right - left, bottom - top);
    ctx.restore();
    return;
  }
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  ctx.fillStyle = '#899587';
  ctx.fillRect(left, top, right - left, bottom - top);
  const fields = [
    [.12, .18, .34, .22, '#758c77'], [.55, .12, .31, .20, '#879581'],
    [.78, .44, .25, .24, '#9b9276'], [.29, .72, .38, .25, '#6f856f'],
    [.66, .82, .33, .16, '#879481'],
  ];
  fields.forEach(([x, y, rx, ry, color], index) => {
    ctx.beginPath();
    for (let i = 0; i <= 28; i += 1) {
      const angle = i / 28 * Math.PI * 2;
      const irregular = 1 + .055 * Math.sin(angle * (3 + index % 3) + index) + .025 * Math.sin(angle * 7 - index);
      const point = mapPoint([(x + Math.cos(angle) * rx * irregular) * map.width,
        (1 - (y + Math.sin(angle) * ry * irregular)) * map.height]);
      if (!i) ctx.moveTo(point[0], point[1]); else ctx.lineTo(point[0], point[1]);
    }
    ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = .54; ctx.fill();
  });
  ctx.globalAlpha = 1;
  (map.obstacles || []).forEach((obstacle) => {
    const [x, y] = mapPoint(obstacle.center), radiusX = obstacle.radius / map.width * (w - 24) * state.mapView.zoom,
      radiusY = obstacle.radius / map.height * (h - 24) * state.mapView.zoom;
    ctx.fillStyle = 'rgba(78, 105, 71, .24)'; ctx.beginPath();
    ctx.ellipse(x, y, radiusX * 1.13, radiusY * 1.13, 0, 0, Math.PI * 2); ctx.fill();
  });
  const shore = [];
  for (let i = 0; i <= 16; i += 1) {
    const f = i / 16, wave = 1 + .004 * Math.sin(i * .82) + .002 * Math.sin(i * 1.9);
    shore.push([f * map.width, map.height * (1 - .008 * wave)]);
  }
  for (let i = 1; i <= 16; i += 1) {
    const f = i / 16, wave = 1 + .004 * Math.sin(i * .77 + 1) + .002 * Math.sin(i * 1.8);
    shore.push([map.width * (1 - .008 * wave), (1 - f) * map.height]);
  }
  for (let i = 1; i <= 16; i += 1) {
    const f = 1 - i / 16, wave = 1 + .004 * Math.sin(i * .9 + 2) + .002 * Math.sin(i * 2.1);
    shore.push([f * map.width, map.height * .008 * wave]);
  }
  for (let i = 1; i < 16; i += 1) {
    const f = 1 - i / 16, wave = 1 + .004 * Math.sin(i * .72 + 3) + .002 * Math.sin(i * 1.7);
    shore.push([map.width * .008 * wave, f * map.height]);
  }
  ctx.beginPath();
  shore.forEach((point, i) => { const [x, y] = mapPoint(point); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.strokeStyle = 'rgba(186, 155, 108, .58)'; ctx.lineWidth = Math.max(3, Math.min(10, h * .012)); ctx.stroke();
  ctx.strokeStyle = 'rgba(112, 111, 84, .72)'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = '#716e55'; ctx.font = mapLabelFont; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  const [labelX, labelY] = mapPoint([map.width * .9, map.height * .94]); drawMapLabel('海岸线', labelX, labelY);
  ctx.restore();
}

function drawTerrain(w, h) {
  const obstacles = [[.25, .28, .11, .13], [.67, .63, .12, .12], [.50, .45, .08, .08]];
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  obstacles.forEach(([x, y, rx, ry], index) => { ctx.fillStyle = 'rgba(73, 87, 86, .68)'; ctx.strokeStyle = 'rgba(143,157,151,.62)'; ctx.beginPath(); ctx.moveTo(12 + (x - rx) * (w - 24), 12 + (y + ry * .5) * (h - 24)); ctx.lineTo(12 + (x - rx * .35) * (w - 24), 12 + (y - ry) * (h - 24)); ctx.lineTo(12 + (x + rx) * (w - 24), 12 + (y - ry * .35) * (h - 24)); ctx.lineTo(12 + (x + rx * .55) * (w - 24), 12 + (y + ry) * (h - 24)); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = 'rgba(181,194,187,.66)'; ctx.font = '10px Microsoft YaHei'; ctx.fillText(index === 1 ? '河谷' : '林区', 12 + x * (w - 24), 12 + y * (h - 24)); });
  ctx.restore();
}

function drawRoads(w, h) {
  const paths = [
    [[.04, .86], [.24, .77], [.42, .65], [.57, .54], [.76, .41], [.96, .10]],
    [[.07, .17], [.25, .24], [.43, .37], [.59, .40], [.78, .35], [.95, .39]],
  ];
  paths.forEach((path, idx) => { ctx.beginPath(); path.forEach(([x, y], i) => { const px = 12 + x * (w - 24); const py = 12 + y * (h - 24); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.setLineDash(idx ? [5, 7] : [8, 7]); ctx.strokeStyle = idx ? 'rgba(176,139,84,.55)' : 'rgba(176,139,84,.8)'; ctx.lineWidth = idx ? 2 : 3; ctx.stroke(); ctx.setLineDash([]); });
}

function drawBorder(w, h) { ctx.beginPath(); for (let i = 0; i < 7; i += 1) { const x = 12 + (w - 24) * (i / 6); const y = 12 + (h - 24) * (.09 + Math.sin(i * .9) * .015); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.strokeStyle = '#e65e62'; ctx.lineWidth = 3; ctx.stroke(); ctx.font = '10px Microsoft YaHei'; ctx.fillStyle = '#e65e62'; ctx.fillText('边境线 12 km', w - 115, 25); }

function drawRoutes() {
  if (!state.overlays.routes) return;
  state.platforms.forEach((p) => { if (!p.target) return; const [x1, y1] = mapPoint(p.position); const [x2, y2] = mapPoint(p.target); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.setLineDash([7, 6]); ctx.strokeStyle = p.type === 'uav' ? 'rgba(102,169,239,.9)' : 'rgba(91,197,140,.9)'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); });
  const target = state.targets.find((t) => t.id === 12); if (target && state.overlays.targets) { const [tx, ty] = mapPoint(target.position); const [px, py] = mapPoint([8420, 6180]); ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(230,94,98,.72)'; ctx.stroke(); ctx.setLineDash([]); }
}

function drawCues() { if (!state.overlays.cues) return; const [x, y] = mapPoint([2700, 8500]); ctx.fillStyle = 'rgba(243,184,74,.16)'; ctx.beginPath(); ctx.ellipse(x, y, 95, 65, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(243,184,74,.62)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(x, y, 36, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#f3b84a'; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#f3b84a'; ctx.font = '10px Microsoft YaHei'; ctx.fillText('Cue #07 · 0.70', x - 43, y - 40); }

function drawTargets() { if (!state.overlays.targets) return; state.targets.forEach((target) => { const [x, y] = mapPoint(target.position); const color = target.type === 'facility' ? '#f3b84a' : '#e65e62'; ctx.fillStyle = color; ctx.strokeStyle = color; if (target.type === 'facility') { ctx.fillRect(x - 7, y - 7, 14, 14); } else { ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = .45; ctx.beginPath(); ctx.arc(x, y, 21, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; } ctx.fillStyle = color; ctx.font = '11px Microsoft YaHei'; ctx.fillText(target.label, x + 14, y - 8); ctx.fillStyle = '#9aaab2'; ctx.font = '9px Consolas'; ctx.fillText(target.type === 'facility' ? '设施异常' : 'intruder · 1.8 m/s', x + 14, y + 7); }); }

function drawMap() {
  const w = canvas.clientWidth; const h = canvas.clientHeight; if (!w || !h) return; ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#26343b'; ctx.fillRect(0, 0, w, h); drawGrid(w, h); drawHeatZones(w, h); drawTerrain(w, h); drawRoads(w, h); drawBorder(w, h); drawRoutes(); drawCues(); drawTargets(); drawPlatforms(); ctx.strokeStyle = '#53656e'; ctx.lineWidth = 1; ctx.strokeRect(12, 12, w - 24, h - 24); }

function renderAlerts() { $('alertActiveLabel').textContent = `${state.alerts.length} ACTIVE`; $('alertList').innerHTML = state.alerts.map((alert) => `<button class="alert-card ${alert.level} ${state.selected.type === 'alert' && state.selected.id === alert.id ? 'selected' : ''}" data-alert-id="${alert.id}"><h3>${alert.title}</h3><p>${alert.detail}</p><small>${alert.meta}</small></button>`).join(''); document.querySelectorAll('[data-alert-id]').forEach((button) => button.addEventListener('click', () => { const alert = state.alerts.find((item) => item.id === button.dataset.alertId); state.selected = { type: 'alert', id: alert.id }; if (alert.targetId) state.selected = { type: 'target', id: alert.targetId }; renderAll(); toast('已定位到告警区域'); })); }

function renderTasks() { $('taskList').innerHTML = state.tasks.map((task) => `<button class="task-row ${state.selected.type === 'task' && state.selected.id === task.id ? 'selected' : ''}" data-task-id="${task.id}"><span class="task-priority">${String(task.priority).padStart(2, '0')}</span><span class="task-name">${task.type} #${task.id}</span><span class="task-platform">${task.platform}</span></button>`).join(''); document.querySelectorAll('[data-task-id]').forEach((button) => button.addEventListener('click', () => { state.selected = { type: 'task', id: Number(button.dataset.taskId) }; renderAll(); })); }

function renderTimeline() { $('timeline').innerHTML = state.timeline.map((event) => `<div class="timeline-event"><div class="timeline-dot ${event.color}-text"></div><div class="timeline-label">${event.time} ${event.text}</div></div>`).join(''); }

function platformGlyphSvg(type, extraClass = '') {
  const kind = type === 'uav' ? 'uav' : 'ugv';
  const className = ['platform-glyph', kind, extraClass].filter(Boolean).join(' ');
  if (kind === 'uav') {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="square" stroke-linejoin="miter"><path d="M7.2 7.2 16.8 16.8M16.8 7.2 7.2 16.8"/><circle cx="6.2" cy="6.2" r="2.15"/><circle cx="17.8" cy="6.2" r="2.15"/><circle cx="6.2" cy="17.8" r="2.15"/><circle cx="17.8" cy="17.8" r="2.15"/><path d="m12 7.6 2.25 4.4L12 16.4 9.75 12Z" fill="currentColor"/><path d="M14.2 12H20"/></g></svg>`;
  }
  return `<svg class="${className}" viewBox="0 0 32 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="square" stroke-linejoin="miter"><path d="M3.5 14.8V8.2l4-4h17.3l3.7 4v6.6Z" fill="currentColor" fill-opacity=".68"/><path d="m8.2 5.2 3.2 5.2h7.2l2.8-5.2" fill="#edf5f9"/><path d="M10.8 4.2v10.6" stroke-dasharray="2 2"/><rect x="5.2" y="13.7" width="21.8" height="6.2" rx="3.1" fill="#edf5f9"/><circle cx="10.2" cy="16.8" r="1.8"/><circle cx="21.9" cy="16.8" r="1.8"/><path d="M3.5 9.4H1M3.5 11.5H1.7M17.3 4V2h4v2M19.3 2V.5M3.7 14.4H1.8v1.7h2.5"/></g><circle cx="15.1" cy="8.5" r="1" fill="currentColor"/></svg>`;
}

function targetGlyphSvg(type, extraClass = '') {
  const kind = ['victim', 'person', 'intruder', 'suspect'].includes(type) ? 'person' : type === 'vehicle' ? 'vehicle' : type === 'facility' ? 'facility' : 'generic';
  const className = ['target-glyph', kind, extraClass].filter(Boolean).join(' ');
  if (kind === 'facility') {
    return `<svg class="${className}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 3 29 28H3Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="miter"/><path d="M16 10v9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/><rect x="14.8" y="22.2" width="2.4" height="2.4" fill="currentColor"/></svg>`;
  }
  if (kind === 'vehicle') {
    return `<svg class="${className}" viewBox="0 0 36 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M3 16V10l5-4h16l6 5v5Z" fill="currentColor" fill-opacity=".12"/><path d="m9 7-3 5h20l-4-5"/><path d="M3 12H1.5M30 12h3"/><circle cx="9" cy="17" r="3" fill="#edf5f9"/><circle cx="25" cy="17" r="3" fill="#edf5f9"/><circle cx="9" cy="17" r="1"/><circle cx="25" cy="17" r="1"/></g></svg>`;
  }
  if (kind === 'person') {
    return `<svg class="${className}" viewBox="0 0 24 32" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter"><circle cx="12" cy="5.5" r="3.2" fill="currentColor" fill-opacity=".16"/><path d="M12 9.5v10M5.5 13.5 12 11l6.5 2.5M12 19.5 7.5 29M12 19.5 17 29"/><path d="M8.5 18.5h7" stroke-width="1"/></g></svg>`;
  }
  return `<svg class="${className}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="16" cy="16" r="7"/><path d="M16 3v7M16 22v7M3 16h7M22 16h7"/><path d="m16 11 5 5-5 5-5-5Z" fill="currentColor" fill-opacity=".18"/></g></svg>`;
}

function batteryGlyphSvg() {
  return '<svg viewBox="0 0 16 10" aria-hidden="true" focusable="false"><path d="M1 2h12v6H1zM13 4h2v2h-2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 4h5" stroke="currentColor" stroke-width="1.2"/></svg>';
}

function platformInspector(platform) {
  return renderPlatformInspector(platform);
}

function targetInspector(target) {
  return renderTargetInspector(target);
}

function taskInspector(task) {
  return renderTaskInspector(task);
}

function renderInspector() { let content = ''; if (state.selected.type === 'platform') { const platform = state.platforms.find((item) => item.id === state.selected.id); content = platform ? platformInspector(platform) : ''; } else if (state.selected.type === 'target') { const target = state.targets.find((item) => item.id === state.selected.id); content = target ? targetInspector(target) : ''; } else if (state.selected.type === 'task') { const task = state.tasks.find((item) => item.id === state.selected.id); content = task ? taskInspector(task) : ''; } else { content = `<div class="inspector-empty">选择平台、目标或任务查看详情</div>`; } $('inspectorContent').innerHTML = content || `<div class="inspector-empty">对象已离线或不可用</div>`; document.querySelectorAll('[data-action="cancel"]').forEach((button) => button.addEventListener('click', cancelSelectedTask)); document.querySelectorAll('[data-action="reprioritize"]').forEach((button) => button.addEventListener('click', reprioritizeSelectedTask)); }

function renderSummary() { const config = currentConfig(); $('coverageValue').textContent = `${state.coverage.toFixed(1)}%`; $('coverageBar').style.width = `${Math.min(state.coverage, 100)}%`; document.querySelector('.metric-label').firstChild.textContent = `${config.coverageLabel} `; $('handledValue').textContent = config.handled; $('onlineCount').textContent = state.platforms.filter((p) => p.online).length; $('alertCount').textContent = String(state.alerts.filter((a) => a.level === 'high').length).padStart(2, '0'); $('simClock').textContent = `${formatTime(state.elapsed)} / ${formatTime(config.duration)}`; $('mapStatus').textContent = state.layer === 'coverage' ? config.mapStatus : `图层：${state.layer === 'priority' ? '搜索优先级' : 'UGV 可通行性'}`; }

function renderAll() { renderAlerts(); renderTasks(); renderTimeline(); renderInspector(); renderSummary(); drawMap(); }

function toast(message) { const el = $('mapToast'); el.textContent = message; el.classList.add('show'); window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove('show'), 2200); }

function advance(seconds = 1) { state.elapsed = Math.min(currentConfig().duration, state.elapsed + seconds); state.coverage = Math.min(95, state.coverage + .08 * seconds); state.platforms.forEach((platform) => { if (platform.task !== '待命' && platform.type === 'uav') platform.battery = Math.max(8, platform.battery - .02 * seconds); }); $('latencyValue').textContent = String(9 + Math.floor(Math.random() * 8)); renderSummary(); drawMap(); }

function cancelSelectedTask() { const taskId = state.selected.type === 'task' ? state.selected.id : state.selected.type === 'platform' ? state.platforms.find((p) => p.id === state.selected.id)?.taskId : state.selected.type === 'target' ? state.targets.find((t) => t.id === state.selected.id)?.taskId : null; if (!taskId) { toast('当前对象没有可取消的任务'); return; } const task = state.tasks.find((item) => item.id === taskId); if (task) { task.status = 'CANCELLED'; task.platform = '待释放'; state.platforms.forEach((platform) => { if (platform.taskId === taskId) { platform.taskId = null; platform.task = '待命'; platform.target = null; } }); state.timeline.push({ time: formatTime(state.elapsed).slice(3, 8), text: `任务 #${taskId} 取消`, color: 'red' }); renderAll(); toast(`已下达取消任务 #${taskId}`); } }

function reprioritizeSelectedTask() { const taskId = state.selected.type === 'task' ? state.selected.id : state.selected.type === 'platform' ? state.platforms.find((p) => p.id === state.selected.id)?.taskId : state.selected.type === 'target' ? state.targets.find((t) => t.id === state.selected.id)?.taskId : null; const task = state.tasks.find((item) => item.id === taskId); if (!task) { toast('当前对象没有可调整的任务'); return; } task.priority = Math.max(1, task.priority - 10); state.timeline.push({ time: formatTime(state.elapsed).slice(3, 8), text: `任务 #${taskId} 提级`, color: 'amber' }); renderAll(); toast(`任务 #${taskId} 已提升为优先级 ${task.priority}`); }


function handleMapClick(event) { const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; let nearest = null; let distance = 25; state.platforms.forEach((platform) => { const point = mapPoint(platform.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'platform', id: platform.id }; distance = d; } }); state.targets.forEach((target) => { const point = mapPoint(target.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'target', id: target.id }; distance = d; } }); if (nearest) { state.selected = nearest; renderAll(); } }

/* -------------------------------------------------------------------------
 * Web 仿真联动层
 *
 * 页面没有后端时使用轻量本地回退，启动 web_api.py 后会自动切换到真实
 * World.tick() 数据。这样布局和交互可以先演示，接入仿真后无需更换页面。
 */
const API_BASE = window.location.port === '4173' ? 'http://127.0.0.1:8000' : '';
const enhancedSceneConfigs = {
  rescue: { name: '人员搜救', width: 10000, height: 10000, duration: 7200, coverageLabel: '搜索区域覆盖率', targetLabel: '目标 ≥ 90%', handledLabel: '救援进度', mapStatus: '图层：覆盖新鲜度', areaName: '燕山南麓试验区', datum: 'CGCS2000 / 高斯投影', terrain: '雷区 / 湖泊' },
  border: { name: '边境巡检', width: 12000, height: 12000, duration: 7200, coverageLabel: '边境线覆盖率', targetLabel: '目标 ≥ 95%', handledLabel: '异常处置', mapStatus: '图层：覆盖新鲜度', areaName: '北部边境巡检区', datum: 'CGCS2000 / 高斯投影', terrain: '雷区 / 湖泊' },
  area: { name: '区域封控', width: 6000, height: 6000, duration: 5400, coverageLabel: '外围预警覆盖率', targetLabel: '目标 ≥ 90%', handledLabel: '空中目标处置', mapStatus: '图层：核心区警戒', areaName: '滨河联合封控区', datum: 'CGCS2000 / 高斯投影', terrain: '城区 / 滨河' },
};

const taskTypeNames = {
  ReconTask: '区域侦察', DiscoverTask: '目标发现', ArriveTask: '到达指定点',
  RescueTask: '人员救援', MedicalDeliveryTask: '医疗投送', InterceptTask: '目标拦截',
  RepairTask: '设施维修', ChargeTask: '补能换电', GuardTask: '区域警戒',
  ClearTask: '残骸清理', OccupyTask: '区域驻留',
};
const capabilityNames = {
  sensor: '感知搜索', effector: '目标处置', medical: '医疗投送', rescue: '人员救援',
  maintenance: '设施维修', charger: '补能换电', relay: '通信中继', debris_clear: '残骸清理',
};
const statusNames = {
  ACTIVE: '执行中', PENDING: '等待分配', COMPLETED: '已完成', FAILED: '已失败',
  CANCELLED: '已取消', ONLINE: '在线', OFFLINE: '离线', TRACKED: '持续跟踪',
};
const targetTypeNames = {
  victim: '待救援人员', person: '人员目标', intruder: '越境人员', suspect: '可疑人员',
  facility: '设施异常', aerial: '空中目标', vehicle: '可疑车辆', hostile_uav: '可疑无人机',
};
function taskTypeLabel(type) { return taskTypeNames[type] || String(type || '任务').replace(/Task$/, ''); }
function capabilityLabel(type) { return capabilityNames[type] || String(type || '能力'); }
function statusLabel(status) { return statusNames[status] || String(status || '未知'); }
function targetTypeLabel(type) { return targetTypeNames[type] || String(type || '目标'); }
function severityLabel(title) { return String(title || '').replace(/^HIGH\s*·\s*/, '高优先级 · ').replace(/^MED\s*·\s*/, '中优先级 · ').replace(/^LOW\s*·\s*/, '低优先级 · '); }

state.scene = 'rescue';
state.connected = false;
state.dataSource = 'pending';
state.unitScale = 1;
state.map = { width: 10000, height: 10000, obstacles: [], roads: [], cues: [], layers: {} };
state.metrics = { coverage: 0, completed: 0, failed: 0, active: 0, total_tasks: 0, completion_rate: 0, average_battery: 100, online_platforms: 0, assigned_platforms: 0, platform_utilization: 0, discovered_targets: 0, alerts_high: 0 };
state.evaluation = { score: 0, goal_met: false, headline: '等待评价数据', metrics: [] };
state.events = [];
state.decisionRange = 'ten';
state.history = [];
state.flow = { phase: 'idle', phase_label: '等待运行', phases: [] };
state.speed = 1;
state.tick = 0;
state.dt = 1;
state.duration = 7200;
state.localFlags = {};
state.mapView = { zoom: 1, centerX: .5, centerY: .5, dragging: false, pointerId: null, moved: false, suppressClick: false };
state.contextView = 'object';
state.layer = null;
state.llmTrace = null;
state.llmTraces = [];
state.llmTraceSerial = 0;
state.llmPending = false;
state.expandedDecisionKey = null;
state.alertQueueCollapsed = false;
state.taskQueueCollapsed = false;
let socket = null;
let reconnectTimer = null;
let backendConnecting = false;
let speedRequestPending = false;
let backendSnapshotRevision = 0;
let mapResizeObserver = null;
const localScenarioStates = new Map();
const manualTaskOrigins = new Map();
const zoomLevels = [1, 1.25, 1.5, 2, 3, 4];
const mapWheel = { frame: null, zoom: null, anchor: null };
state.mapMode = '3d';
state.map3dView = 'overview';
state.modelSize = 'normal';
const map3dRuntime = { renderer: null, loading: null, view: null, error: null,
  contextRecoveryTimer: null, contextStableTimer: null, fatalCleanupTimer: null, contextRebuilds: 0 };
const crispMapLabels = { layer: null, nodes: new Map(), updates: 0, creates: 0 };

function placeCallSign(x, y, width, height, bounds, occupied) {
  const left = Math.max(bounds.left, Math.min(bounds.right - width, x));
  const fitY = (value) => Math.max(bounds.top, Math.min(bounds.bottom - height, value));
  const gap = height + 3;
  const top = [0, -gap, gap, -2 * gap, 2 * gap].map((offset) => fitY(y + offset))
    .find((candidate) => !occupied.some((other) => left < other.right && left + width > other.left
      && candidate < other.bottom && candidate + height > other.top)) ?? fitY(y);
  occupied.push({ left, right: left + width, top, bottom: top + height });
  return [left, top];
}

function renderCrispMapLabels(labels) {
  if (!crispMapLabels.layer?.isConnected) {
    const layer = document.createElement('div');
    layer.className = 'tactical-label-overlay'; layer.setAttribute('aria-hidden', 'true');
    $('tacticalMap3d').appendChild(layer); crispMapLabels.layer = layer; crispMapLabels.nodes.clear();
  }
  const seen = new Set(), occupied = [];
  const bounds = { left: 4, right: crispMapLabels.layer.clientWidth - 4, top: 4, bottom: crispMapLabels.layer.clientHeight - 4 };
  for (const label of labels || []) {
    if (label.visible === false || !Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
    const key = String(label.key); seen.add(key);
    let node = crispMapLabels.nodes.get(key);
    if (!node) {
      node = document.createElement('span'); crispMapLabels.layer.appendChild(node); crispMapLabels.nodes.set(key, node);
      crispMapLabels.creates += 1;
    }
    const centered = Boolean(label.centered), type = label.type || '', kind = label.kind || 'reference';
    const className = `tactical-crisp-label label-${kind}${centered ? ' is-centered' : ''}${type === 'ugv' ? ' is-ground' : ''}`;
    if (node.className !== className) node.className = className;
    if (node.textContent !== label.text) node.textContent = label.text;
    if (node.dataset.labelKey !== key) node.dataset.labelKey = key;
    const object = kind === 'platform' || kind === 'target';
    const inside = label.x >= 0 && label.x <= bounds.right + 4 && label.y >= 0 && label.y <= bounds.bottom + 4;
    const [x, y] = object && inside
      ? placeCallSign(label.x, label.y - 9, String(label.text).length * 8 + 10, 19, bounds, occupied)
      : [label.x, label.y];
    const anchor = centered ? ' translate(-50%, -50%)' : object && inside ? '' : ' translateY(-50%)';
    const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)${anchor}`;
    if (node.style.transform !== transform) node.style.transform = transform;
    const color = kind === 'reference' ? '#ffffff' : label.color || '#ffffff', background = label.background || '';
    if (node.style.getPropertyValue('--label-color') !== color) node.style.setProperty('--label-color', color);
    if (node.style.getPropertyValue('--label-background') !== background) node.style.setProperty('--label-background', background);
  }
  for (const [key, node] of crispMapLabels.nodes) {
    if (!seen.has(key)) { node.remove(); crispMapLabels.nodes.delete(key); }
  }
  crispMapLabels.updates += 1;
}

function rebuild3dAfterContextLoss(failed) {
  if (!failed || map3dRuntime.renderer !== failed) return;
  if (map3dRuntime.contextRebuilds >= 1 && state.mapMode === '3d') {
    map3dRuntime.renderer = null; failed.destroy(); setMapMode('2d');
    toast('外部视野连续中断，已切回卫星视野');
    return;
  }
  const previousView = ['overview', 'top', 'follow'].includes(failed.mode) ? failed.mode : 'overview';
  if (state.mapMode === '3d') map3dRuntime.contextRebuilds += 1;
  window.setTimeout(() => {
    if (map3dRuntime.renderer !== failed) return;
    map3dRuntime.renderer = null; failed.destroy(); map3dRuntime.loading = null;
    if (state.mapMode !== '3d') return;
    ensure3dMap().then((renderer) => {
      if (!renderer || state.mapMode !== '3d') return;
      if (!renderer.setView(previousView)) renderer.setView('overview');
      renderer.update(state);
      if (map3dRuntime.contextStableTimer !== null) clearTimeout(map3dRuntime.contextStableTimer);
      map3dRuntime.contextStableTimer = window.setTimeout(() => {
        map3dRuntime.contextStableTimer = null; map3dRuntime.contextRebuilds = 0;
      }, 15000);
      toast('外部视野已重新建立');
    });
  }, 0);
}

function handle3dContextState(status) {
  if (status === 'restored') {
    if (map3dRuntime.contextRecoveryTimer !== null) clearTimeout(map3dRuntime.contextRecoveryTimer);
    map3dRuntime.contextRecoveryTimer = null;
    if (map3dRuntime.contextStableTimer !== null) clearTimeout(map3dRuntime.contextStableTimer);
    map3dRuntime.contextStableTimer = null;
    toast('外部视野正在重建');
    rebuild3dAfterContextLoss(map3dRuntime.renderer);
    return;
  }
  if (status !== 'lost' || map3dRuntime.contextRecoveryTimer !== null) return;
  if (map3dRuntime.contextStableTimer !== null) clearTimeout(map3dRuntime.contextStableTimer);
  map3dRuntime.contextStableTimer = null;
  toast('外部视野正在恢复');
  map3dRuntime.contextRecoveryTimer = window.setTimeout(() => {
    map3dRuntime.contextRecoveryTimer = null;
    const failed = map3dRuntime.renderer;
    if (!failed?.contextLost) return;
    rebuild3dAfterContextLoss(failed);
  }, 3000);
}

function handle3dFatalError(error) {
  if (map3dRuntime.fatalCleanupTimer !== null) return;
  console.error('三维场景连续渲染失败', error);
  map3dRuntime.fatalCleanupTimer = window.setTimeout(() => {
    map3dRuntime.fatalCleanupTimer = null;
    if (map3dRuntime.contextRecoveryTimer !== null) clearTimeout(map3dRuntime.contextRecoveryTimer);
    if (map3dRuntime.contextStableTimer !== null) clearTimeout(map3dRuntime.contextStableTimer);
    map3dRuntime.contextRecoveryTimer = null; map3dRuntime.contextStableTimer = null;
    const failed = map3dRuntime.renderer; map3dRuntime.renderer = null; failed?.destroy();
    if (state.mapMode === '3d') { setMapMode('2d'); toast('外部视野连续渲染失败，已切回卫星视野'); }
  }, 0);
}

// 两种地图只负责显示，任务、告警与单位选择继续共用原有状态。
function updateMapModeUi() {
  const is3d = state.mapMode === '3d';
  $('mapCoordinateFrame').dataset.mapMode = state.mapMode;
  canvas.hidden = is3d;
  $('tacticalMap3d').hidden = !is3d;
  $('mapTopView').hidden = !is3d;
  $('quickFollow').hidden = !is3d;
  $('map3dLoading').hidden = !is3d || Boolean(map3dRuntime.renderer?.isReady());
  const extent = `${mapExtentLabel()} · ${state.platforms.length} 个平台`;
  $('mapViewLabel').textContent = `${is3d ? '外部视野' : '卫星视野'} · ${extent}`;
  document.querySelectorAll('button[data-map-mode]').forEach((button) => {
    const active = button.dataset.mapMode === state.mapMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-3d-view]').forEach((button) => {
    const follows = button.dataset['3dView'] === 'follow';
    button.disabled = !is3d || (follows && !['platform', 'target'].includes(state.selected.type));
    const active = is3d && button.dataset['3dView'] === state.map3dView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function update3dViewUi(view) {
  map3dRuntime.view = view;
  if (state.mapMode !== '3d') return;
  const cameraViews = { '全域': 'overview', '俯视': 'top', '跟随': 'follow', '自由': 'free' };
  const nextView = cameraViews[view.label] || state.map3dView;
  if (nextView !== state.map3dView) {
    state.map3dView = nextView;
    document.querySelectorAll('[data-3d-view]').forEach((button) => {
      const active = button.dataset['3dView'] === state.map3dView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  const zoom = Math.max(.01, Number(view.zoom) || 1);
  const zoomText = `${Math.round(zoom * 100)}%`;
  if ($('zoomValue').textContent !== zoomText) $('zoomValue').textContent = zoomText;
  $('zoomOut').disabled = false;
  $('zoomIn').disabled = false;
  if (view.scaleMeters > 0 && view.scalePixels > 0) {
    $('mapScaleBar').parentElement.hidden = false;
    const scaleWidth = `${Math.round(view.scalePixels)}px`, scaleText = view.scaleMeters >= 1000 ? `${view.scaleMeters / 1000} km` : `${view.scaleMeters} m`;
    if ($('mapScaleBar').style.width !== scaleWidth) $('mapScaleBar').style.width = scaleWidth;
    if ($('mapScaleLabel').textContent !== scaleText) $('mapScaleLabel').textContent = scaleText;
  } else $('mapScaleBar').parentElement.hidden = true;
  const north = document.querySelector('.north-indicator');
  if (north && Number.isFinite(view.headingDegrees)) {
    const rotation = `rotate(${-Math.round(view.headingDegrees * 10) / 10}deg)`, headingText = `${String(Math.round((view.headingDegrees + 360) % 360)).padStart(3, '0')}°`;
    if (north.querySelector('i').style.transform !== rotation) north.querySelector('i').style.transform = rotation;
    if (north.querySelector('span').textContent !== headingText) north.querySelector('span').textContent = headingText;
  }
}

async function ensure3dMap() {
  if (map3dRuntime.renderer) return map3dRuntime.renderer;
  if (map3dRuntime.loading) return map3dRuntime.loading;
  map3dRuntime.loading = (async () => {
    if (!window.Cesium) {
      window.CESIUM_BASE_URL = new URL('vendor/cesium/', document.baseURI).href;
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('vendor/cesium/Cesium.js', document.baseURI).href;
        script.onload = resolve;
        script.onerror = () => reject(new Error('三维引擎资源加载失败'));
        document.head.append(script);
      });
    }
    map3dRuntime.renderer = window.Tactical3D.create({
      container: $('tacticalMap3d'),
      helpers: { remainingPlannedRoute, recentPlatformTrack, mapLayerColor, platformGlyphSvg, targetGlyphSvg, mapEmphasis, navigationPointMarker,
        navigationPoint: () => manualDraftPoint() || selectedTaskWaypoint() },
      onPick: handleManualMapClick,
      onSelect: (selection) => {
        if (selection.type === 'platform') selectPlatformById(selection.id);
        else if (selection.type === 'target') {
          const selected = state.selected.type === 'target' && state.selected.id === selection.id;
          state.selected = selected ? { type: 'none', id: null } : selection;
          renderSelectionOnly();
        }
      },
      onViewChange: update3dViewUi,
      onLabels: renderCrispMapLabels,
      onReady: updateMapModeUi,
      onModelError: (error, unit) => console.warn('三维单位模型加载失败，已显示轻量标记', unit, error),
      onRecoverableError: (error) => console.warn('三维场景出现一次渲染异常，正在重试', error),
      onFatalError: handle3dFatalError,
      onContextState: handle3dContextState,
    });
    map3dRuntime.renderer.setVisible(state.mapMode === '3d');
    map3dRuntime.renderer.update(state);
    map3dRuntime.renderer.resize();
    updateMapModeUi();
    return map3dRuntime.renderer;
  })().catch((error) => {
    console.error('三维初始化失败', error);
    map3dRuntime.error = error;
    if (state.mapMode === '3d') { setMapMode('2d'); toast('外部视野未能加载，卫星视野仍可使用'); }
    return null;
  }).finally(() => { map3dRuntime.loading = null; });
  return map3dRuntime.loading;
}

function setMapMode(mode) {
  const was3d = state.mapMode === '3d';
  state.mapMode = mode === '2d' ? '2d' : '3d';
  cancelMapWheel();
  updateMapModeUi();
  map3dRuntime.renderer?.setVisible(state.mapMode === '3d');
  if (state.mapMode === '3d') {
    if (!was3d && !map3dRuntime.renderer) map3dRuntime.contextRebuilds = 0;
    ensure3dMap();
  }
  else {
    const north = document.querySelector('.north-indicator');
    north.querySelector('i').style.transform = '';
    north.querySelector('span').textContent = '000°';
  }
  renderGeography();
  renderInspector();
  resizeCanvas();
}

function sceneConfig() { return enhancedSceneConfigs[state.scene] || enhancedSceneConfigs.rescue; }
function mapExtentLabel() {
  const map = state.map || sceneConfig();
  const km = (value) => Number((Number(value) / 1000).toFixed(1));
  return `${km(map.width)} × ${km(map.height)} km`;
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function secondsLabel(seconds) { return formatTime(Number(seconds) || 0); }
function platformLabel(id, type = 'platform', ordinal = null) {
  const prefix = String(type).toUpperCase();
  const numericId = Number(id);
  const hasOrdinal = ordinal !== null && ordinal !== undefined && Number.isFinite(Number(ordinal));
  const index = hasOrdinal ? Number(ordinal) : (Number.isFinite(numericId) ? numericId + 1 : 1);
  return `${prefix}-${String(Math.max(1, index)).padStart(2, '0')}`;
}
function localPlatform(id, type, position) {
  const isUav = type === 'uav';
  const ordinal = (state.platforms || []).filter((platform) => platform.type === type).length + 1;
  return { id, label: platformLabel(id, type, ordinal), type, position: [...position], velocity: [0, 0], speed: 0, heading: 0, battery: 100, taskId: null, task: '待命', target: null, capabilities: isUav ? [{ name: 'sensor', state: '可用' }, ...(state.scene === 'area' || state.scene === 'border' ? [{ name: 'effector', state: '剩余 3 次' }] : [{ name: 'medical', state: '剩余 3 件' }])] : [{ name: 'rescue', state: '可用' }, { name: 'charger', state: '剩余 4 块' }], online: true };
}
function localTarget(id, type, position, extra = {}) {
  return { id, label: `${type === 'victim' ? '人员' : type === 'facility' ? '设施' : '目标'} #${id}`, type, entity_type: type === 'victim' ? 'person' : type, position: [...position], velocity: [0, 0], confidence: .9, state: extra.injured ? '受伤' : '跟踪中', discovered: true, extra, track: [[...position]], taskId: null, firstSeen: secondsLabel(state.elapsed), lastUpdate: secondsLabel(state.elapsed) };
}
function pushEvent(text, color = 'cyan', kind = 'flow', detail = '') {
  state.events.unshift({ time: state.elapsed, text, color, kind, detail });
  state.events = state.events.slice(0, 1000);
}
function localPhaseDetails() {
  const targetCount = state.targets.filter((target) => target.discovered).length;
  const moved = state.platforms.filter((platform) => platform.velocity.some((value) => Math.abs(value) > .01)).length;
  return {
    spawn: `新增 ${state.localFlags.spawned || 0} 个实体`,
    control: `${state.platforms.length} 个平台完成控制决策`,
    movement: `${moved} 个平台发生位移`,
    sensing: `已发现 ${targetCount} 个目标 · 覆盖 ${state.metrics.coverage.toFixed(1)}%`,
    judge: `完成 ${state.metrics.completed} · 活跃 ${state.metrics.active}`,
    decision: '任务分配与抢占已评估',
    render: '状态已推送到前端页面',
  };
}
function localFlow() {
  if (!state.tick) { state.flow = { phase: 'idle', phase_label: '等待运行', phases: [] }; return; }
  const details = localPhaseDetails();
  state.flow = { phase: 'render', phase_label: '状态推送', phases: Object.entries({ spawn: '实体生成', control: '控制决策', movement: '运动执行', sensing: '态势感知', judge: '任务裁判', decision: '反应决策', render: '状态推送' }).map(([id, label]) => ({ id, label, status: 'done', detail: details[id] })) };
}
function localLayers() {
  const rows = 100; const cols = 100; const coverage = []; const priority = []; const passability = [];
  for (let y = 0; y < rows; y += 1) {
    const coverageRow = []; const priorityRow = []; const passabilityRow = [];
    for (let x = 0; x < cols; x += 1) {
      const edge = 1 - y / rows; const pulse = Math.min(1, state.elapsed / 800);
      coverageRow.push(Math.max(0, Math.min(1, pulse * (.8 + edge * .12 + Math.sin(x * .6 + y) * .025))));
      priorityRow.push(Math.max(0, Math.min(1, edge * .72 + (x > cols * .62 ? .22 : 0))));
      const oldX = x / cols * 40, oldY = y / rows * 40;
      const obstacle = (oldX > 9 && oldX < 15 && oldY > 15 && oldY < 23) || (oldX > 27 && oldX < 33 && oldY > 8 && oldY < 17);
      passabilityRow.push(obstacle ? 0 : ((Math.floor(oldX) + Math.floor(oldY)) % 9 === 0 ? 1 : .28));
    }
    coverage.push(coverageRow); priority.push(priorityRow); passability.push(passabilityRow);
  }
  return { width: cols, height: rows, coverage, priority, passability };
}
function resetLocalScenario(scene = 'rescue') {
  state.unitScale = 1;
  state.connected = false; state.scene = scene; state.running = false; state.speed = 1; state.speedIndex = 0; state.elapsed = 0; state.tick = 0; state.duration = sceneConfig().duration; state.dt = 1; state.localFlags = { spawned: 0 }; state.llmTrace = null; state.llmTraces = []; state.llmTraceSerial = 0; state.llmPending = false; state.expandedDecisionKey = null;
  state.platforms = [];
  const platformCount = scene === 'area' ? 7 : 6;
  for (let i = 0; i < platformCount; i += 1) state.platforms.push(localPlatform(i, i < (scene === 'area' ? 5 : 4) ? 'uav' : 'ugv', [500 + (i % 4) * 550, 500 + Math.floor(i / 4) * 500]));
  state.targets = [];
  state.tasks = [];
  state.map = { width: sceneConfig().width, height: sceneConfig().height, obstacles: [{ center: [sceneConfig().width * .32, sceneConfig().height * .35], radius: Math.min(sceneConfig().width, sceneConfig().height) * .055 }, { center: [sceneConfig().width * .72, sceneConfig().height * .62], radius: Math.min(sceneConfig().width, sceneConfig().height) * .045 }], roads: [{ waypoints: [[500, 500], [sceneConfig().width * .3, sceneConfig().height * .15], [sceneConfig().width * .72, sceneConfig().height * .35], [sceneConfig().width * .92, sceneConfig().height * .72]] }], cues: [], layers: localLayers() };
  state.metrics = { coverage: 0, completed: 0, failed: 0, active: 0, total_tasks: 0, completion_rate: 0, average_battery: 100, online_platforms: state.platforms.length, assigned_platforms: 0, platform_utilization: 0, discovered_targets: 0, alerts_high: 0 };
  state.evaluation = { score: 0, goal_met: false, headline: '本地演示：等待运行', metrics: [
    { key: 'coverage', label: scene === 'border' ? '边境线覆盖率' : scene === 'area' ? '外围预警覆盖率' : '搜索覆盖率', value: 0, display: '0.0%', unit: '%', target: scene === 'border' ? 95 : 90, tone: 'blue', detail: '本地演示数据' },
    { key: 'task_completion_rate', label: '任务完成率', value: 0, display: '0.0%', unit: '%', target: 100, tone: 'cyan', detail: '0 个任务已完成' },
  ] };
  state.alerts = []; state.events = []; state.history = []; state.selected = { type: 'none', id: null }; pushEvent(`场景「${sceneConfig().name}」已加载`, 'cyan', 'session'); localFlow();
}
// Only the local preview uses these milestones; real simulation objects come from backend snapshots.
function addLocalTask(type, priority, platformIds, target, capabilities, targetId = null, targetPos = null) {
  const task = { id: Math.max(-1, ...state.tasks.map((item) => Number(item.id))) + 1, type, priority, status: platformIds.length ? 'ACTIVE' : 'PENDING', platform_ids: platformIds, platform: platformIds.map((id) => state.platforms.find((item) => item.id === id)?.label).filter(Boolean).join(', ') || '待分配', target, capabilities, target_entity_id: targetId, target_pos: targetPos };
  state.tasks.push(task);
  if (targetId != null) { const item = state.targets.find((entry) => entry.id === targetId); if (item) item.taskId = task.id; }
}
function localScenarioEvents() {
  const previousCount = state.targets.length;
  const once = (key, at, action) => {
    if (state.elapsed < at || state.localFlags[key]) return;
    state.localFlags[key] = true;
    action();
  };
  once('started', 1, () => {
    if (state.scene === 'area') {
      addLocalTask('GuardTask', 0, [0, 1], '核心禁入区', ['sensor', 'effector']);
      addLocalTask('ReconTask', 90, [2], '全域搜索', ['sensor']);
    } else {
      addLocalTask('ReconTask', 90, [state.scene === 'rescue' ? 3 : 0], state.scene === 'rescue' ? '全域搜索' : '边境线', ['sensor']);
      if (state.scene === 'rescue') addLocalTask('DiscoverTask', 70, [0], '搜索人员', ['sensor']);
    }
    pushEvent('开始执行场景任务', 'cyan', 'task');
  });
  if (state.scene !== 'area') once('discovery', 15, () => {
    state.map.cues = [{ id: 7, position: [state.map.width * .23, state.map.height * .74], confidence: .7, radius: 500 }];
    if (state.scene === 'rescue') {
      state.targets.push(...[[2000, 2000], [4000, 4000], [6000, 6000], [8000, 2000], [8000, 8000]].map((position, index) => localTarget(12 + index, 'victim', position, { injured: index < 2 })));
      addLocalTask('ArriveTask', 65, [], '坐标 (4000, 4000)', ['sensor'], null, [4000, 4000]);
      pushEvent('态势层发现待救援人员', 'amber', 'discovery');
    } else {
      state.targets.push(localTarget(14, 'facility', [5550, 500], { repaired: false }));
      addLocalTask('RepairTask', 60, [4], '设施 #14', ['maintenance'], 14);
      pushEvent('发现设施异常，安排现场核查', 'amber', 'discovery');
    }
  });
  if (state.scene === 'border') once('intruder', 300, () => {
    state.targets.push(localTarget(12, 'intruder', [9100, 7000], { role: 'intruder' }));
    addLocalTask('InterceptTask', 5, [1], '目标 #12', ['effector'], 12);
    pushEvent('发现越境人员', 'red', 'discovery');
  });
  if (state.scene === 'area') {
    once('wave', 120, () => {
      state.targets.push(localTarget(20, 'aerial', [500, 3000], { neutralized: false }));
      pushEvent('第一波空中目标进入外围预警区', 'red', 'spawn');
    });
    once('wave2', 900, () => {
      state.targets.push(localTarget(21, 'aerial', [5900, 4200], { neutralized: false }));
      pushEvent('第二波空中目标进入外围预警区', 'red', 'spawn');
    });
  }
  state.localFlags.spawned = state.targets.length - previousCount;
}
function cloneData(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function saveLocalScenario() {
  localScenarioStates.set(state.scene, cloneData({
    running: state.running, speed: state.speed, speedIndex: state.speedIndex, elapsed: state.elapsed,
    tick: state.tick, duration: state.duration, dt: state.dt, localFlags: state.localFlags,
    platforms: state.platforms, targets: state.targets, tasks: state.tasks, map: state.map,
    metrics: state.metrics, evaluation: state.evaluation, alerts: state.alerts, events: state.events,
    history: state.history, flow: state.flow, selected: state.selected,
    llmTrace: state.llmTrace, llmTraces: state.llmTraces, llmTraceSerial: state.llmTraceSerial,
  }));
}
function switchLocalScenario(scene) {
  if (state.localInitialized) saveLocalScenario();
  const saved = localScenarioStates.get(scene);
  if (saved) {
    Object.assign(state, cloneData(saved), { scene, connected: false });
  } else {
    resetLocalScenario(scene);
  }
}
function taskTargetText(task) { return `${task?.target || ''} ${task?.target_entity_id || ''}`; }
function localAlerts() {
  return state.targets.map((target) => ({ id: `local-${target.id}`, level: target.type === 'intruder' || target.type === 'aerial' ? 'high' : target.extra?.injured ? 'medium' : 'low', title: `${target.type === 'facility' ? '中优先级 · 设施异常' : target.type === 'victim' ? '中优先级 · 人员发现' : '高优先级 · 目标入侵'}`, detail: `${target.label} · ${target.state}`, meta: secondsLabel(state.elapsed), targetId: target.id }))
    .concat(state.tasks.filter((task) => task.status === 'PENDING').map((task) => ({ id: `task-${task.id}`, level: 'low', title: '低优先级 · 任务等待分配', detail: `${taskTypeLabel(task.type)} #${task.id}`, meta: `优先级 ${task.priority}`, targetId: null })));
}
function localAdvance(seconds = 1) {
  if (state.dataSource !== 'demo') return;
  const delta = Number(seconds) || 1; state.elapsed = Math.min(state.duration, state.elapsed + delta); state.tick += 1;
  localScenarioEvents();
  state.platforms.forEach((platform, index) => {
    const task = state.tasks.find((item) => item.platform_ids?.includes(platform.id) && ['ACTIVE', 'PENDING'].includes(item.status));
    if (!task) { platform.velocity = [0, 0]; platform.speed = 0; platform.taskId = null; platform.task = '待命'; platform.target = null; return; }
    platform.taskId = task.id; platform.task = `${task.type} #${task.id}`;
    const target = task.target_pos || (state.targets.find((item) => taskTargetText(task).includes(`#${item.id}`)) || {}).position || [state.map.width * (.3 + index * .12), state.map.height * (.3 + index * .08)];
    platform.target = [...target]; const dx = target[0] - platform.position[0]; const dy = target[1] - platform.position[1]; const distance = Math.hypot(dx, dy); const speed = platform.type === 'uav' ? 15 : 8; const step = Math.min(distance, speed * delta); if (distance > .1) { platform.position = [platform.position[0] + dx / distance * step, platform.position[1] + dy / distance * step]; platform.velocity = [dx / distance * speed, dy / distance * speed]; platform.heading = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; } else { platform.velocity = [0, 0]; }
    platform.speed = Math.hypot(...platform.velocity);
    if (platform.type === 'uav' && platform.task !== '待命') platform.battery = Math.max(8, platform.battery - .015 * delta);
  });
  state.targets.forEach((target) => { target.track = (target.track || []).concat([[...target.position]]).slice(-90); target.lastUpdate = secondsLabel(state.elapsed); });
  state.map.layers = localLayers();
  state.metrics.total_tasks = state.tasks.length;
  state.metrics.discovered_targets = state.targets.length;
  state.evaluation.headline = '本地演示：评价随仿真推进';
  state.metrics.coverage = Math.min(96, state.metrics.coverage + delta * (state.scene === 'rescue' ? .06 : .08)); state.metrics.average_battery = state.platforms.reduce((sum, p) => sum + p.battery, 0) / state.platforms.length; state.metrics.active = state.tasks.filter((task) => ['ACTIVE', 'PENDING'].includes(task.status)).length; state.metrics.assigned_platforms = state.platforms.filter((platform) => platform.taskId != null).length; state.metrics.platform_utilization = state.platforms.length ? state.metrics.assigned_platforms / state.platforms.length * 100 : 0; state.metrics.completion_rate = state.metrics.total_tasks ? state.metrics.completed / state.metrics.total_tasks * 100 : 0; state.evaluation.metrics = state.evaluation.metrics.map((metric) => metric.key === 'coverage' ? ({ ...metric, value: state.metrics.coverage, display: `${state.metrics.coverage.toFixed(1)}%` }) : metric.key === 'task_completion_rate' ? ({ ...metric, value: state.metrics.completion_rate, display: `${state.metrics.completion_rate.toFixed(1)}%` }) : metric); state.alerts = localAlerts(); state.metrics.alerts_high = state.alerts.filter((alert) => alert.level === 'high').length; state.history.push({ time: state.elapsed, coverage: state.metrics.coverage, completed: state.metrics.completed, active: state.metrics.active, battery: state.metrics.average_battery }); state.history = state.history.slice(-180); localFlow(); pushEvent(`第 ${String(state.tick).padStart(4, '0')} 步 · ${state.flow.phase_label}`, 'cyan', 'flow'); renderAll();
}

function validBackendSnapshot(snapshot) {
  return Boolean(snapshot?.simulation && enhancedSceneConfigs[snapshot.simulation.scene] && Number.isFinite(Number(snapshot.simulation.time)) && Array.isArray(snapshot.platforms) && Array.isArray(snapshot.targets) && Array.isArray(snapshot.tasks));
}
const panelRenderState = { timer: null, lastFlush: 0, flushes: 0, markupWrites: 0, decisionCache: null };
const streamState = { base: null, pending: null, frame: null, fallback: null, applying: false, received: 0, applied: 0 };
const decisionListState = { scope: null, limit: 120, nodes: new Map(), revision: 0, created: 0, updated: 0, removed: 0 };

function olderBackendSnapshot(incoming, current) {
  if (!current || incoming.simulation?.session_id !== current.simulation?.session_id) return false;
  const incomingGeneration = Number(incoming.replay?.generation) || 0, currentGeneration = Number(current.replay?.generation) || 0;
  if (incomingGeneration !== currentGeneration) return incomingGeneration < currentGeneration;
  const nextRevision = Number(incoming.simulation.state_revision), oldRevision = Number(current.simulation.state_revision);
  if (Number.isFinite(nextRevision) && Number.isFinite(oldRevision) && nextRevision !== oldRevision) return nextRevision < oldRevision;
  return Number(incoming.simulation.tick) < Number(current.simulation.tick);
}

function mergeStreamMessage(message) {
  if (message?.type !== 'state_patch') return validBackendSnapshot(message) ? message : null;
  const base = streamState.base;
  if (!base || message.session_id !== base.simulation?.session_id || !message.patch) return null;
  const patch = message.patch;
  const next = { ...base, ...patch };
  if (patch.simulation) next.simulation = { ...base.simulation, ...patch.simulation };
  if (patch.map) next.map = { ...base.map, ...patch.map, ...(patch.map.layers ? { layers: { ...base.map?.layers, ...patch.map.layers } } : {}) };
  for (const key of ['platforms', 'targets']) {
    if (!Array.isArray(patch[key])) continue;
    const old = new Map((base[key] || []).map((item) => [item.id, item]));
    next[key] = patch[key].map((item) => ({ ...old.get(item.id), ...item,
      ...(item.navigation ? { navigation: { ...old.get(item.id)?.navigation, ...item.navigation } } : {}) }));
  }
  return validBackendSnapshot(next) ? next : null;
}
function cancelStreamFrame() {
  if (streamState.frame !== null) cancelAnimationFrame(streamState.frame);
  if (streamState.fallback !== null) clearTimeout(streamState.fallback);
  streamState.frame = null; streamState.fallback = null;
}
function flushStreamFrame() {
  cancelStreamFrame();
  const snapshot = streamState.pending;
  streamState.pending = null;
  if (!snapshot) return;
  streamState.applying = true;
  try { applyBackendSnapshot(snapshot); streamState.applied += 1; }
  finally { streamState.applying = false; }
}
function queueStreamMessage(message) {
  const snapshot = mergeStreamMessage(message);
  if (!snapshot) return false;
  if (olderBackendSnapshot(snapshot, streamState.base)) return false;
  // 每条增量先合并，保留省略的历史数据；只把最新完整状态交给下一绘制帧。
  streamState.base = snapshot; streamState.pending = snapshot; streamState.received += 1;
  if (streamState.frame === null) {
    streamState.frame = requestAnimationFrame(flushStreamFrame);
    streamState.fallback = setTimeout(flushStreamFrame, 100);
  }
  return true;
}

// 地图接收每份快照；业务面板独立刷新，避免网络推送反复拆建整页 DOM。
function replacePanelMarkup(element, html) {
  if (!element || element._renderedMarkup === html) return false;
  const focused = document.activeElement;
  const focusKey = element.contains(focused) ? focused.dataset.focusKey || focused.dataset.action || focused.dataset.relatedTask : null;
  element.innerHTML = html;
  if (focusKey) {
    [...element.querySelectorAll('[data-focus-key], [data-action], [data-related-task]')]
      .find((item) => (item.dataset.focusKey || item.dataset.action || item.dataset.relatedTask) === focusKey)
      ?.focus({ preventScroll: true });
  }
  element._renderedMarkup = html;
  panelRenderState.markupWrites += 1;
  return true;
}
function cancelPendingPanelRender() {
  if (panelRenderState.timer !== null) window.clearTimeout(panelRenderState.timer);
  panelRenderState.timer = null;
}
function renderBackendFrame(immediate = false) {
  drawMap();
  const cameraBusy = state.mapMode === '3d' && map3dRuntime.renderer?._cameraInteracting?.();
  const panelInterval = cameraBusy ? 1000 : 500;
  if (immediate || !state.running || performance.now() - panelRenderState.lastFlush >= panelInterval) {
    cancelPendingPanelRender();
    renderBusinessPanels();
    return;
  }
  if (panelRenderState.timer !== null) return;
  panelRenderState.timer = window.setTimeout(() => {
    panelRenderState.timer = null;
    if (state.running && state.mapMode === '3d' && map3dRuntime.renderer?._cameraInteracting?.()
      && performance.now() - panelRenderState.lastFlush < 1000) { renderBackendFrame(); return; }
    renderBusinessPanels();
  }, Math.max(0, panelInterval - (performance.now() - panelRenderState.lastFlush)));
}
function applyBackendSnapshot(snapshot) {
  if (!validBackendSnapshot(snapshot)) return;
  if (!streamState.applying) {
    if (olderBackendSnapshot(snapshot, streamState.base)) return;
    // HTTP 控制响应或会话切换以完整快照替换接收基线，取消尚未应用的旧帧。
    cancelStreamFrame(); streamState.pending = null; streamState.base = snapshot;
  }
  state.unitScale = Number(snapshot.simulation.unit_scale) > 0 ? Number(snapshot.simulation.unit_scale) : 1;
  const immediatePanels = state.sessionId !== snapshot.simulation.session_id || !state.connected
    || (Number(state.replay?.generation) || 0) !== (Number(snapshot.replay?.generation) || 0)
    || Boolean(state.replay?.enabled) !== Boolean(snapshot.replay?.enabled)
    || state.replay?.mode !== snapshot.replay?.mode
    || state.running !== Boolean(snapshot.simulation.running) || state.speed !== Number(snapshot.simulation.speed || 1);
  if (state.sessionId !== snapshot.simulation.session_id) {
    state.selected = { type: 'none', id: null };
    state.expandedDecisionKey = null;
    state.inspectorFolds?.clear();
  }
  state.sessionId = snapshot.simulation.session_id;
  state.replay = snapshot.replay || null;
  state.sessionMode = snapshot.simulation.mode || 'mission';
  state.navigationTest = snapshot.navigation_test;
  state.viewOptions = snapshot.view_options || {};
  if (state.dataSource !== 'backend') {
    state.llmTrace = null; state.llmTraces = []; state.llmTraceSerial = 0; state.llmPending = false;
    state.expandedDecisionKey = null;
  }
  state.dataSource = 'backend';
  backendSnapshotRevision += 1;
  window.clearTimeout(reconnectTimer); reconnectTimer = null;
  const sim = snapshot.simulation; state.connected = true; state.scene = sim.scene; state.running = Boolean(sim.running); state.speed = Number(sim.speed) || 1; state.speedIndex = Math.max(0, speeds.findIndex((speed) => speed === state.speed)); if (state.speedIndex < 0) state.speedIndex = 0; state.elapsed = Number(sim.time) || 0; state.tick = Number(sim.tick) || 0; state.dt = Number(sim.dt) || 1; state.duration = Number(sim.duration) || sceneConfig().duration; state.map = snapshot.map || state.map; const backendPlatforms = (snapshot.platforms || []).map((platform) => ({ ...platform, taskId: platform.task_id, task: platform.task || '待命' })); const typeOrdinals = {}; state.platforms = backendPlatforms.map((platform) => { typeOrdinals[platform.type] = (typeOrdinals[platform.type] || 0) + 1; return { ...platform, label: platformLabel(platform.id, platform.type, typeOrdinals[platform.type]) }; }); const platformLabels = new Map(state.platforms.map((platform) => [platform.id, platform.label])); const taskList = (snapshot.tasks || []).map((task) => ({ ...task, platform: (task.platform_ids || []).map((id) => platformLabels.get(id)).filter(Boolean).join(', ') || task.platform || '待分配', taskId: task.id, platformIds: task.platform_ids || [], targetId: task.target_entity_id, targetPos: task.target_pos })); state.tasks = taskList; const taskByTarget = new Map(taskList.filter((task) => task.targetId != null).map((task) => [task.targetId, task.id])); state.targets = (snapshot.targets || []).map((target) => ({ ...target, label: `${targetTypeLabel(target.type)} #${target.id}`, taskId: taskByTarget.get(target.id) || null, firstSeen: secondsLabel(target.timestamp), lastUpdate: secondsLabel(target.timestamp), extra: target.extra || {} })); state.alerts = (snapshot.alerts || []).map((alert) => ({ ...alert, targetId: alert.target_id })); state.metrics = snapshot.metrics || state.metrics; state.evaluation = snapshot.evaluation || state.evaluation; state.history = snapshot.history || []; state.flow = snapshot.flow || state.flow; state.events = snapshot.events || []; state.llmTraces = snapshot.llm_traces || state.llmTraces; if (Object.prototype.hasOwnProperty.call(snapshot, 'llm_trace') && (snapshot.llm_trace || !state.llmPending)) { state.llmTrace = snapshot.llm_trace; state.llmTraceSerial = Math.max(state.llmTraceSerial, Number(snapshot.llm_trace?.id) || 0); } if (!selectionStillExists()) state.selected = { type: 'none', id: null }; document.body.dataset.backend = 'connected'; renderBackendFrame(immediatePanels); }
function scheduleBackendReconnect() {
  if (reconnectTimer || window.location.protocol === 'file:') return;
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectBackend(); }, 2500);
}
function backendDisconnected() {
  state.connected = false;
  if (state.dataSource === 'pending') state.dataSource = 'demo';
  const previousSocket = socket;
  socket = null;
  previousSocket?.close();
  cancelStreamFrame(); streamState.pending = null; streamState.base = null;
  renderConnection();
  if (state.contextView === 'manual') renderManualPanel();
  if (state.mapMode === '3d') map3dRuntime.renderer?.update(state);
  scheduleBackendReconnect();
}
function canOperateSimulation() {
  if (state.connected || state.dataSource === 'demo') return true;
  toast(state.dataSource === 'backend' ? '连接已中断，正在重连；当前显示最后同步状态' : '正在连接仿真服务，请稍候');
  return false;
}
async function backendPost(path, payload, report = toast) {
  if (!state.connected) return false;
  if (exercisePlaybackActive() && !['/api/session/run', '/api/session/pause', '/api/session/step', '/api/session/speed'].includes(path)) {
    report('演习回放仅供查看，请返回实时后下达任务'); return false;
  }
  const revision = backendSnapshotRevision;
  try {
    const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) {
      report(typeof body.detail === 'string' ? body.detail : '参数无效，请检查坐标、速度和当前模式');
      return false;
    }
    if (path === '/api/tasks/inject' && body.ok === true) {
      rememberManualTask(body.message, body.state?.simulation?.session_id);
    }
    if (revision === backendSnapshotRevision) {
      if (body.simulation) applyBackendSnapshot(body);
      else if (body.state) applyBackendSnapshot(body.state);
    }
    if (body.message) report(body.message);
    return response.ok && body.ok !== false;
  } catch (error) {
    if (revision === backendSnapshotRevision) backendDisconnected();
    report('未收到服务响应，请在连接恢复后核对操作结果');
    return false;
  }
}
function connectSocket() {
  if (socket || window.location.protocol === 'file:') return;
  const protocol = API_BASE ? new URL(API_BASE).protocol.replace('http', 'ws') : window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = API_BASE ? new URL(API_BASE).host : window.location.host;
  const connection = new WebSocket(`${protocol}//${host}/ws?compact=1`);
  socket = connection;
  connection.onopen = () => { if (socket === connection) renderConnection(); };
  connection.onmessage = (event) => {
    if (socket !== connection) return;
    try { queueStreamMessage(JSON.parse(event.data)); } catch (error) { /* 保留最后有效状态，等待下一份完整推送。 */ }
  };
  connection.onclose = () => { if (socket === connection) backendDisconnected(); };
  connection.onerror = () => { if (socket === connection) backendDisconnected(); };
}
async function connectBackend() {
  if (window.location.protocol === 'file:') { state.dataSource = 'demo'; renderConnection(); return; }
  if (backendConnecting) return;
  backendConnecting = true;
  const revision = backendSnapshotRevision;
  try {
    const response = await fetch(`${API_BASE}/api/state`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('backend unavailable');
    const snapshot = await response.json();
    if (!validBackendSnapshot(snapshot)) throw new Error('invalid snapshot');
    // A live stream may have delivered a newer snapshot while the HTTP request was in flight.
    if (revision === backendSnapshotRevision) applyBackendSnapshot(snapshot);
    connectSocket();
  } catch (error) {
    if (revision === backendSnapshotRevision) backendDisconnected();
  } finally {
    backendConnecting = false;
  }
}
function renderConnection() {
  const connection = $('connectionStatus'); const stream = $('streamStatus');
  if (!connection || !stream) return;
  const demo = state.dataSource === 'demo';
  const linkText = state.connected ? '仿真服务在线' : demo ? '本地演示模式' : state.dataSource === 'backend' ? '连接中断 · 重连中' : '正在连接仿真服务';
  if (connection.querySelector('span').textContent !== linkText) connection.querySelector('span').textContent = linkText;
  stream.querySelector('span').textContent = state.connected ? (socket?.readyState === WebSocket.OPEN ? '实时数据流' : '正在连接数据流') : demo ? '本地推进流' : '等待状态同步';
  connection.classList.toggle('offline', !state.connected);
  stream.classList.toggle('offline', !state.connected);
  document.body.dataset.backend = state.connected ? 'connected' : state.dataSource;
  renderMapLayerLegend();
  const blocked = !state.connected && !demo;
  const replay = exercisePlaybackActive();
  for (const id of ['runToggle', 'speedToggle', 'stepButton']) $(id).disabled = blocked || playbackUi.busy;
  $('speedToggle').disabled ||= speedRequestPending;
  for (const id of ['scenarioSelect', 'resetButton']) $(id).disabled = blocked || replay || manualRequestPending();
  $('openTaskModal').disabled = state.sessionMode === 'navigation' || (blocked && !replay);
  $('openTaskModal').querySelector('span').textContent = replay ? '历史指令' : '人工注入';
  $('openTaskModal').querySelector('use').setAttribute('href', replay ? '#icon-events' : '#icon-plus');
  const scaleLabel = $('unitScaleLabel');
  if (scaleLabel) {
    scaleLabel.hidden = state.dataSource !== 'backend' || state.sessionMode === 'navigation';
    scaleLabel.textContent = `协同规模 ×${state.unitScale}`;
    scaleLabel.title = `当前${sceneConfig().name}使用原任务平台数量的 ${state.unitScale} 倍，平台分散部署并协作执行同一任务`;
  }
}
function renderRunState() {
  const button = $('runToggle');
  const replay = exercisePlaybackActive();
  const action = state.running ? '暂停' : replay ? '播放回放' : '运行推演';
  button.setAttribute('aria-label', action);
  button.dataset.tip = action;
  button.querySelector('use').setAttribute('href', state.running ? '#icon-pause' : '#icon-play');
  const speed = Number(state.speed || 1);
  $('speedToggle').textContent = `×${speed}`;
  $('speedToggle').setAttribute('aria-label', `切换仿真倍速，当前 ${speed} 倍`);
  const step = `${Number(state.dt || 1)} 秒`;
  $('stepButton').hidden = replay;
  $('stepButton').dataset.tip = `快进一个仿真步（${step}）`;
  $('stepButton').setAttribute('aria-label', $('stepButton').dataset.tip);
  $('stepLabel').textContent = `+${step}`;
}
function selectionStillExists() {
  const { type, id } = state.selected || {};
  if (type === 'platform') return state.platforms.some((item) => item.id === id);
  if (type === 'target') return state.targets.some((item) => item.id === id);
  if (type === 'task') return state.tasks.some((item) => item.id === id);
  if (type === 'alert') return state.alerts.some((item) => item.id === id);
  return type === 'none';
}

function resizeCanvas() {
  if (state.mapMode === '3d') { map3dRuntime.renderer?.resize(); drawMap(); return; }
  const rect = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); drawMap(); updateMapViewUi();
}
function mapPixelsPerMeter(zoom = state.mapView.zoom) {
  const map = state.map || sceneConfig();
  return Math.max(.0001, Math.min((canvas.clientWidth - 24) / map.width, (canvas.clientHeight - 24) / map.height) * zoom);
}
function mapPoint([x, y]) {
  const map = state.map || sceneConfig(), view = state.mapView, scale = mapPixelsPerMeter();
  return [canvas.clientWidth / 2 + (x - view.centerX * map.width) * scale,
    canvas.clientHeight / 2 - (y - view.centerY * map.height) * scale];
}
function clampMapCenter() {
  const map = state.map || sceneConfig(), view = state.mapView, scale = mapPixelsPerMeter();
  const halfX = Math.min(.5, Math.max(0, canvas.clientWidth - 24) / (2 * scale * map.width));
  const halfY = Math.min(.5, Math.max(0, canvas.clientHeight - 24) / (2 * scale * map.height));
  view.centerX = Math.max(halfX, Math.min(1 - halfX, view.centerX));
  view.centerY = Math.max(halfY, Math.min(1 - halfY, view.centerY));
}
const mapScaleDistances = [25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
function mapScaleMetrics() {
  const metersPerPixel = 1 / mapPixelsPerMeter();
  const idealDistance = metersPerPixel * 88;
  const distance = mapScaleDistances.reduce((best, value) => Math.abs(Math.log(value / idealDistance)) < Math.abs(Math.log(best / idealDistance)) ? value : best);
  return { distance, metersPerPixel, pixels: distance / metersPerPixel };
}
function updateMapScaleUi() {
  if (state.mapMode === '3d') { if (map3dRuntime.view) update3dViewUi(map3dRuntime.view); return; }
  $('mapScaleBar').parentElement.hidden = false;
  const scale = mapScaleMetrics();
  $('mapScaleBar').style.width = `${scale.pixels}px`;
  $('mapScaleLabel').textContent = scale.distance >= 1000 ? `${scale.distance / 1000} km` : `${scale.distance} m`;
}
function updateMapViewUi() {
  if (state.mapMode === '3d') { if (map3dRuntime.view) update3dViewUi(map3dRuntime.view); return; }
  $('zoomValue').textContent = `${Math.round(state.mapView.zoom * 100)}%`;
  $('zoomOut').disabled = state.mapView.zoom <= zoomLevels[0];
  $('zoomIn').disabled = state.mapView.zoom >= zoomLevels.at(-1);
  canvas.classList.toggle('pan-ready', state.mapView.zoom > 1 && !state.mapView.dragging);
  canvas.classList.toggle('is-panning', state.mapView.dragging);
  updateMapScaleUi();
}
function zoomMapTo(value, anchor = null) {
  const view = state.mapView;
  const zoom = Math.max(zoomLevels[0], Math.min(zoomLevels.at(-1), value));
  if (zoom === view.zoom) return;
  if (anchor) {
    // 固定鼠标所指的地图位置，避免放大时目标偏离视野。
    const map = state.map || sceneConfig();
    const scaleChange = 1 / mapPixelsPerMeter() - 1 / mapPixelsPerMeter(zoom);
    view.centerX += (anchor.x - canvas.clientWidth / 2) * scaleChange / map.width;
    view.centerY -= (anchor.y - canvas.clientHeight / 2) * scaleChange / map.height;
  }
  view.zoom = zoom;
  clampMapCenter(); updateMapViewUi(); drawMap();
}
function cancelMapWheel() {
  if (mapWheel.frame !== null) cancelAnimationFrame(mapWheel.frame);
  Object.assign(mapWheel, { frame: null, zoom: null, anchor: null });
}
function setMapZoom(direction) {
  if (state.mapMode === '3d') { map3dRuntime.renderer?.zoomBy(direction > 0 ? 1.3 : 1 / 1.3); return; }
  cancelMapWheel();
  const current = state.mapView.zoom;
  const next = direction > 0
    ? zoomLevels.find((level) => level > current + .0001) ?? zoomLevels.at(-1)
    : [...zoomLevels].reverse().find((level) => level < current - .0001) ?? zoomLevels[0];
  zoomMapTo(next);
  toast(`地图缩放 ${Math.round(state.mapView.zoom * 100)}%`);
}
function handleMapWheel(event) {
  // Ctrl / Command + 滚轮仍由浏览器处理页面缩放。
  if (event.ctrlKey || event.metaKey || !event.deltaY) return;
  event.preventDefault();
  if (state.mapView.dragging) return;
  const rect = canvas.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
  const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
  mapWheel.zoom = Math.max(zoomLevels[0], Math.min(zoomLevels.at(-1), (mapWheel.zoom ?? state.mapView.zoom) * Math.exp(-delta * .0018)));
  mapWheel.anchor = { x: (event.clientX - rect.left) * canvas.clientWidth / rect.width, y: (event.clientY - rect.top) * canvas.clientHeight / rect.height };
  // 合并同一帧的滚轮事件，避免触控板高频输入反复重绘地图。
  if (mapWheel.frame === null) mapWheel.frame = requestAnimationFrame(() => {
    const { zoom, anchor } = mapWheel;
    Object.assign(mapWheel, { frame: null, zoom: null, anchor: null });
    zoomMapTo(zoom, anchor);
  });
}
function resetMapView() {
  cancelMapWheel();
  Object.assign(state.mapView, { zoom: 1, centerX: .5, centerY: .5, dragging: false, pointerId: null, moved: false, suppressClick: false });
  state.map3dView = 'overview';
  map3dRuntime.renderer?.setView('overview');
  updateMapModeUi(); updateMapViewUi(); drawMap();
}

function renderGeography() {
  const config = sceneConfig();
  if (state.mapMode === '3d') {
    $('geoAreaName').textContent = `${config.name} · 三维沙盘`;
    $('geoDatum').textContent = '局部平面 / 米';
    $('geoTerrain').textContent = '平坦 · 海拔 0 m';
    return;
  }
  if ($('geoAreaName')) $('geoAreaName').textContent = config.areaName;
  if ($('geoDatum')) $('geoDatum').textContent = config.datum;
  if ($('geoTerrain')) $('geoTerrain').textContent = config.terrain;
}
const mapLabelFont = '600 11px "Microsoft YaHei UI", "Arial Narrow", sans-serif';
const mapDataFont = '600 10px "Cascadia Mono", Consolas, monospace';
const mapUnitFont = '700 12px "Cascadia Mono", Consolas, monospace';
const mapUnitDataFont = '600 10px "Microsoft YaHei UI", sans-serif';

// Share the same color mapping between the canvas and its legend.
const mapLayerColors = {
  coverage: [[234, 242, 247], [201, 222, 235], [167, 199, 221]],
  priority: [[234, 242, 247], [238, 224, 204], [230, 192, 185]],
  passability: { road: [145, 182, 156], ground: [221, 230, 236], obstacle: [203, 158, 154] },
};
function mapLayerColor(layer, rawValue) {
  const value = Math.max(0, Math.min(1, Number(rawValue) || 0));
  if (layer === 'passability') {
    const color = mapLayerColors.passability[value < .08 ? 'obstacle' : value > .75 ? 'road' : 'ground'];
    return `rgb(${color.join(', ')})`;
  }
  const stops = mapLayerColors[layer] || mapLayerColors.coverage;
  const index = value <= .5 ? 0 : 1;
  const fraction = (value - index * .5) * 2;
  const color = stops[index].map((channel, i) => Math.round(channel + (stops[index + 1][i] - channel) * fraction));
  return `rgb(${color.join(', ')})`;
}
let mapLabelQueue = null;
function drawMapLabel(text, x, y, outlineColor = '#f3f8fb') {
  if (mapLabelQueue) {
    mapLabelQueue.push({ text, x, y, outlineColor, font: ctx.font, fillStyle: ctx.fillStyle, textAlign: ctx.textAlign, textBaseline: ctx.textBaseline, globalAlpha: ctx.globalAlpha });
    return;
  }
  ctx.save();
  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawMapLabels() {
  const labels = mapLabelQueue || [];
  mapLabelQueue = null;
  // 统一在轨迹、规划箭头和区域图形之后绘制，避免线条穿过文字。
  labels.forEach(({ text, x, y, outlineColor, ...style }) => {
    ctx.save(); Object.assign(ctx, style); drawMapLabel(text, x, y, outlineColor); ctx.restore();
  });
}

function mapGridTicks() {
  const map = state.map || sceneConfig();
  const scale = mapPixelsPerMeter();
  const halfX = (canvas.clientWidth - 24) / (2 * scale);
  const halfY = (canvas.clientHeight - 24) / (2 * scale);
  const minX = Math.max(0, state.mapView.centerX * map.width - halfX);
  const maxX = Math.min(map.width, state.mapView.centerX * map.width + halfX);
  const minY = Math.max(0, state.mapView.centerY * map.height - halfY);
  const maxY = Math.min(map.height, state.mapView.centerY * map.height + halfY);
  const gridStep = mapScaleMetrics().distance;
  const firstX = Math.ceil(minX / gridStep) * gridStep;
  const firstY = Math.ceil(minY / gridStep) * gridStep;
  const xTicks = [], yTicks = [];
  const label = (value) => `${Number((value / 1000).toFixed(2))}K`;
  for (let value = firstX; value <= maxX + .01; value += gridStep) xTicks.push({ value, position: mapPoint([value, 0])[0], label: label(value) });
  for (let value = firstY; value <= maxY + .01; value += gridStep) yTicks.push({ value, position: mapPoint([0, value])[1], label: label(value) });
  return { xTicks, yTicks };
}
function updateMapAxes({ xTicks, yTicks }) {
  const stage = $('mapStage');
  // 刻度和网格共用地图坐标换算，DOM 刻度放在画布边框之外。
  for (const [id, ticks, offset, property] of [
    ['mapAxisX', xTicks, stage.clientLeft + canvas.offsetLeft, 'left'],
    ['mapAxisY', yTicks, stage.clientTop + canvas.offsetTop, 'top'],
  ]) {
    const axis = $(id);
    if (!axis) continue;
    const html = ticks.map((tick) => `<span data-coordinate="${tick.value}" style="${property}:${(tick.position + offset).toFixed(3)}px">${tick.label}</span>`).join('');
    if (axis._tickMarkup !== html) { axis.innerHTML = html; axis._tickMarkup = html; }
  }
}
function drawGrid() {
  const map = state.map || sceneConfig();
  const ticks = mapGridTicks();
  const [left, bottom] = mapPoint([0, 0]), [right, top] = mapPoint([map.width, map.height]);
  ctx.save();
  ctx.strokeStyle = state.layer ? 'rgba(76, 110, 134, .18)' : 'rgba(36, 62, 65, .10)';
  ctx.lineWidth = 1;
  for (let value = 100; value < map.width; value += 100) {
    const [x] = mapPoint([value, 0]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  }
  for (let value = 100; value < map.height; value += 100) {
    const [, y] = mapPoint([0, value]);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  }
  ctx.restore();
  updateMapAxes(ticks);
}

const layerRasterCache = new Map();
function drawLayerGrid() {
  if (!state.layer) return;
  const grid = state.map?.layers?.[state.layer];
  if (!grid?.length || !grid[0]?.length) return;
  const rows = grid.length;
  const cols = grid[0].length;
  const map = state.map || sceneConfig();
  let cached = layerRasterCache.get(state.layer);
  if (!cached || cached.grid !== grid) {
    const raster = cached?.canvas || document.createElement('canvas');
    raster.width = cols; raster.height = rows;
    const rasterContext = raster.getContext('2d');
    const colors = new Map();
    // 缓存独立图层，选单位及缩放时不重复绘制一万个格子。
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const value = Number(grid[row][col]) || 0;
        if (!colors.has(value)) colors.set(value, mapLayerColor(state.layer, value));
        rasterContext.fillStyle = colors.get(value);
        rasterContext.fillRect(col, rows - row - 1, 1, 1);
      }
    }
    cached = { grid, canvas: raster };
    layerRasterCache.set(state.layer, cached);
  }
  const [left, bottom] = mapPoint([0, 0]);
  const [right, top] = mapPoint([map.width, map.height]);
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.drawImage(cached.canvas, left, top, right - left, bottom - top);
  ctx.restore();
}

function drawTerrain() {
  const map = state.map || sceneConfig();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  (state.map?.obstacles || []).forEach((obstacle, index) => {
    const [x, y] = mapPoint(obstacle.center);
    const radius = obstacle.radius * mapPixelsPerMeter();
    const kind = window.Tactical3D?.obstacleKind?.(obstacle, index) || (index % 2 ? 'lake' : 'mine');
    const color = kind === 'mine' ? '#D50066' : '#475869';
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    const textureHasRegion = map3dRuntime.renderer?.terrainTextureReady
      && map3dRuntime.renderer.width === map.width && map3dRuntime.renderer.height === map.height;
    if (!state.layer && !textureHasRegion) { ctx.save(); ctx.globalAlpha = kind === 'mine' ? .3 : 1; ctx.fill(); ctx.restore(); }
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 12px "Microsoft YaHei UI", sans-serif';
    drawMapLabel(kind === 'mine' ? '雷区' : '湖泊', x, y, '#344858');
  });
  ctx.restore();
}

function drawRoads() {
  (state.map?.roads || []).forEach((road) => {
    if (!road.waypoints?.length) return;
    ctx.beginPath();
    road.waypoints.forEach((point, index) => {
      const [x, y] = mapPoint(point);
      if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.setLineDash([8, 7]);
    ctx.strokeStyle = state.layer === 'passability' ? '#557960' : 'rgba(121, 102, 62, .7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

function drawBoundary(w) {
  if (state.scene !== 'border') return;
  const map = state.map || sceneConfig();
  const [left, y] = mapPoint([0, 0]);
  const [right] = mapPoint([map.width, 0]);
  ctx.strokeStyle = '#b75450';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
}

function drawBoundaryLabel(w, h) {
  if (state.scene !== 'border') return;
  ctx.save();
  ctx.font = mapLabelFont;
  ctx.fillStyle = '#a3403e';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('边境线 / 12 km', w - 17, h - 6);
  ctx.restore();
}

function drawRoutes(taskWaypoint) {
  drawNavigationRoutes(taskWaypoint);
}

function drawCues() {
  if (!state.overlays.cues) return;
  const scale = mapPixelsPerMeter();
  (state.map?.cues || []).forEach((cue) => {
    const [x, y] = mapPoint(cue.position);
    const radius = Math.max(24, cue.radius * scale);
    ctx.fillStyle = 'rgba(161, 125, 65, .1)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(195, 154, 81, .6)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(18, radius * .45), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#885c1f';
    ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.font = mapLabelFont;
    drawMapLabel(`线索 #${cue.id} / 置信度 ${Number(cue.confidence).toFixed(2)}`, x - 53, y - radius - 7);
  });
}

function strokeMapGlyph(selected) {
  if (selected) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth += 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }
  ctx.stroke();
}

function drawFacilityMapGlyph(color, selected) {
  ctx.fillStyle = 'rgba(195, 154, 81, .13)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, -7.5); ctx.lineTo(7.6, 6.5); ctx.lineTo(-7.6, 6.5); ctx.closePath();
  ctx.fill(); strokeMapGlyph(selected);
  ctx.lineWidth = 1.7;
  ctx.beginPath(); ctx.moveTo(0, -2.8); ctx.lineTo(0, 2.2); ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(-.9, 4, 1.8, 1.8);
}

function drawVehicleMapGlyph(color, selected) {
  ctx.fillStyle = '#eaf2f7';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.moveTo(-8, 3.5); ctx.lineTo(-8, -1.8); ctx.lineTo(-4.2, -5); ctx.lineTo(4.5, -5); ctx.lineTo(8, -1.2); ctx.lineTo(8, 3.5); ctx.closePath();
  ctx.fill(); strokeMapGlyph(selected);
  ctx.beginPath(); ctx.moveTo(-3.5, -4.2); ctx.lineTo(-1.7, -1.1); ctx.lineTo(4.7, -1.1); ctx.lineTo(2.8, -4.2); ctx.closePath(); ctx.stroke();
  [-4.8, 4.8].forEach((wheelX) => {
    ctx.beginPath(); ctx.arc(wheelX, 4, 1.8, 0, Math.PI * 2); ctx.fill(); strokeMapGlyph(selected);
  });
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-9.3, 0); ctx.moveTo(8, 0); ctx.lineTo(9.3, 0); strokeMapGlyph(selected);
}

function drawPersonMapGlyph(color, selected) {
  ctx.fillStyle = '#eaf2f7';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.35;
  ctx.lineCap = 'square';
  ctx.beginPath(); ctx.arc(0, -5.3, 2.1, 0, Math.PI * 2); ctx.fill(); strokeMapGlyph(selected);
  ctx.beginPath();
  ctx.moveTo(0, -3); ctx.lineTo(0, 3);
  ctx.moveTo(-4.2, -.7); ctx.lineTo(0, -2); ctx.lineTo(4.2, -.7);
  ctx.moveTo(0, 3); ctx.lineTo(-3.2, 7);
  ctx.moveTo(0, 3); ctx.lineTo(3.2, 7);
  strokeMapGlyph(selected);
}

function drawGenericTargetMapGlyph(color, selected) {
  ctx.fillStyle = 'rgba(198, 93, 89, .13)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill(); strokeMapGlyph(selected);
  ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(0, -5); ctx.moveTo(0, 5); ctx.lineTo(0, 9); ctx.moveTo(-9, 0); ctx.lineTo(-5, 0); ctx.moveTo(5, 0); ctx.lineTo(9, 0); strokeMapGlyph(selected);
}

function drawTargetMapGlyph(target, color, selected) {
  if (target.type === 'facility') drawFacilityMapGlyph(color, selected);
  else if (target.type === 'vehicle') drawVehicleMapGlyph(color, selected);
  else if (['victim', 'person', 'intruder', 'suspect'].includes(target.type)) drawPersonMapGlyph(color, selected);
  else drawGenericTargetMapGlyph(color, selected);
}

function drawTargets(marks, occupied, bounds) {
  state.targets.forEach((target) => {
    if (target.discovered === false) return;
    const [anchorX, anchorY] = mapPoint(target.position);
    const x = Math.max(24, Math.min(canvas.clientWidth - 24, anchorX));
    const y = Math.max(24, Math.min(canvas.clientHeight - 24, anchorY));
    const color = ['aerial', 'vehicle'].includes(target.type) ? '#FF0303' : target.type === 'facility' ? '#885c1f' : '#b04442';
    if (state.overlays.targets && target.track?.length > 1) {
      ctx.save();
      ctx.beginPath();
      target.track.forEach((point, index) => {
        const [trackX, trackY] = mapPoint(point);
        if (!index) ctx.moveTo(trackX, trackY); else ctx.lineTo(trackX, trackY);
      });
      ctx.setLineDash([3, 5]);
      ctx.globalAlpha = .5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }
    if (Math.abs(x - anchorX) > .5 || Math.abs(y - anchorY) > .5) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = .48;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(x, y);
    const selected = state.selected.type === 'target' && state.selected.id === target.id;
    drawTargetMapGlyph(target, color, selected);
    ctx.restore();
    const mark = marks.get('target:' + target.id);
    if (mark && mark !== 'label') drawPlatformSelection(x, y, mark);
    ctx.fillStyle = color;
    ctx.font = mapLabelFont;
    const [labelX, labelY] = placeCallSign(x + 13, y - 18, ctx.measureText(target.label).width + 4, 13, bounds, occupied);
    drawMapLabel(target.label, labelX, labelY + 11);
    if (mark === 'selected') {
      ctx.fillStyle = '#345568';
      ctx.font = mapDataFont;
      drawMapLabel(target.state || '跟踪中', labelX, labelY + 23);
    }
  });
}

function drawUavMapGlyph(color, selected) {
  const arms = [[-3.4, -3.4, 3.4, 3.4], [-3.4, 3.4, 3.4, -3.4]];
  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = selected ? '#ffffff' : '#eaf2f7';
  ctx.lineWidth = selected ? 4.15 : 2.8;
  arms.forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  arms.forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });
  [[-4.2, -4.2], [4.2, -4.2], [-4.2, 4.2], [4.2, 4.2]].forEach(([rotorX, rotorY]) => {
    ctx.fillStyle = '#eaf2f7';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(rotorX, rotorY, 1.45, 0, Math.PI * 2);
    ctx.fill();
    strokeMapGlyph(selected);
  });
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-2.4, -1.55);
  ctx.lineTo(2.5, -1.25);
  ctx.lineTo(3.6, 0);
  ctx.lineTo(2.5, 1.25);
  ctx.lineTo(-2.4, 1.55);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(3.4, 0);
  ctx.lineTo(6.7, 0);
  strokeMapGlyph(selected);
  ctx.restore();
}

function drawUgvMapGlyph(color, selected) {
  ctx.save();
  ctx.scale(.78, .78);
  ctx.fillStyle = '#f4f8fb';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.05;
  // 左向侧视车体：斜切车头、舱体和完整履带轮廓。
  ctx.beginPath();
  ctx.moveTo(-6.2, 2.1);
  ctx.lineTo(-6.2, -2.2);
  ctx.lineTo(-4.1, -4.1);
  ctx.lineTo(4.0, -4.1);
  ctx.lineTo(5.8, -2.1);
  ctx.lineTo(5.8, 2.1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = .88;
  ctx.fill();
  ctx.globalAlpha = 1;
  strokeMapGlyph(selected);
  ctx.fillStyle = '#f4f8fb';
  ctx.strokeStyle = '#d7e8dd';
  ctx.lineWidth = .7;
  ctx.beginPath();
  ctx.moveTo(-3.1, -3.35); ctx.lineTo(-1.9, -1.0); ctx.lineTo(1.4, -1.0); ctx.lineTo(2.4, -3.35);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(-5.9, 1.15, 11.3, 3.8, 1.8);
  strokeMapGlyph(selected);
  ctx.fillStyle = '#f4f8fb';
  [-3.2, 1.9].forEach((wheelX) => {
    ctx.beginPath(); ctx.arc(wheelX, 3.05, 1.15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
  ctx.beginPath();
  ctx.moveTo(-6.3, -1.2); ctx.lineTo(-7.2, -1.2); ctx.moveTo(-6.3, -.15); ctx.lineTo(-7.0, -.15); ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(-.1, -5.0, 2.2, .75);
  ctx.beginPath();
  ctx.moveTo(1.0, -5.0); ctx.lineTo(1.0, -6.2); ctx.arc(1.0, -6.35, .18, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

// 选中标记颜色随界面主题变化，由 CSS 变量 --map-select 提供，首次使用时读取。
function mapSelectColor() {
  if (!mapSelectColor.value) mapSelectColor.value = getComputedStyle(document.documentElement).getPropertyValue('--map-select').trim() || '#71c5e7';
  return mapSelectColor.value;
}
function drawPlatformSelection(x, y, mark = 'selected') {
  const radius = mark === 'selected' ? 12 : 10;
  const arm = 3;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#17232c';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(-radius + arm, -radius); ctx.lineTo(-radius, -radius); ctx.lineTo(-radius, -radius + arm);
  ctx.moveTo(radius - arm, -radius); ctx.lineTo(radius, -radius); ctx.lineTo(radius, -radius + arm);
  ctx.moveTo(-radius, radius - arm); ctx.lineTo(-radius, radius); ctx.lineTo(-radius + arm, radius);
  ctx.moveTo(radius, radius - arm); ctx.lineTo(radius, radius); ctx.lineTo(radius - arm, radius);
  ctx.stroke();
  ctx.strokeStyle = { selected: mapSelectColor(), related: '#91b7d1', high: '#ff9694', medium: '#f1bd72' }[mark];
  ctx.lineWidth = mark === 'related' ? 1 : 2;
  ctx.stroke();
  ctx.restore();
}

function drawPlatforms(marks, occupied, bounds) {
  state.platforms.forEach((platform) => {
    const [x, y] = mapPoint(platform.position);
    if (x < 12 || y < 12 || x > canvas.clientWidth - 12 || y > canvas.clientHeight - 12) return;
    const selected = state.selected.type === 'platform' && state.selected.id === platform.id;
    const color = platform.type === 'uav' ? '#245f87' : '#326343';
    ctx.save();
    ctx.globalAlpha = platform.online === false ? .48 : 1;
    ctx.translate(x, y);
    ctx.rotate(-(Number(platform.heading) || 0) * Math.PI / 180 + (platform.type === 'ugv' ? Math.PI : 0));
    if (platform.type === 'uav') drawUavMapGlyph(color, selected);
    else drawUgvMapGlyph(color, selected);
    ctx.restore();
    const mark = marks.get('platform:' + platform.id);
    if (mark) drawPlatformSelection(x, y, mark);

    ctx.fillStyle = platform.type === 'uav' ? '#03468a' : '#245235';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = mapUnitFont;
    const [labelX, labelY] = placeCallSign(x + 9, y - 17, ctx.measureText(platform.label).width + 4, 14, bounds, occupied);
    drawMapLabel(platform.label, labelX, labelY + 11);
    if (selected) {
      const taskText = platform.task && platform.task !== '待命'
        ? `${taskTypeLabel(String(platform.task).split(' #')[0])} ${String(platform.task).match(/#\d+/)?.[0] || ''}`
        : '待命';
      ctx.fillStyle = '#345568';
      ctx.font = mapUnitDataFont;
      drawMapLabel(`${taskText} / ${Number(platform.battery || 0).toFixed(0)}%`, labelX, labelY + 24);
    }
  });
}

function drawMap() {
  if (state.mapMode === '3d') {
    updateMapModeUi();
    if (map3dRuntime.renderer) map3dRuntime.renderer.update(state);
    else ensure3dMap();
    return;
  }
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  updateMapScaleUi();
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(12, 12, w - 24, h - 24);
  ctx.clip();
  mapLabelQueue = [];
  if (state.layer) {
    const map = state.map || sceneConfig(), [left, bottom] = mapPoint([0, 0]), [right, top] = mapPoint([map.width, map.height]);
    ctx.fillStyle = '#eaf2f7'; ctx.fillRect(left, top, right - left, bottom - top);
  } else drawLandSurface(w, h);
  drawLayerGrid();
  drawGrid();
  drawTerrain();
  if (!state.layer) drawRoads();
  drawBoundary(w);
  drawNavigationRegions(w, h);
  const taskWaypoint = selectedTaskWaypoint();
  drawRoutes(taskWaypoint);
  drawCues();
  const marks = mapEmphasis();
  const occupied = [], bounds = { left: 16, right: w - 16, top: 16, bottom: h - 16 };
  drawTargets(marks, occupied, bounds);
  drawPlatforms(marks, occupied, bounds);
  const point = manualDraftPoint() || taskWaypoint;
  if (point) {
    const [x, y] = mapPoint(point);
    const { image, width, height, tipOffset } = navigationPointMarker();
    ctx.drawImage(image, x - width / 2, y - height + tipOffset, width, height);
  }
  const map = state.map || sceneConfig();
  const [left, bottom] = mapPoint([0, 0]);
  const [right, top] = mapPoint([map.width, map.height]);
  ctx.strokeStyle = '#7896a9';
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, right - left, bottom - top);
  drawMapLabels();
  ctx.restore();
  drawBoundaryLabel(w, h);
}

function updateQueueToggle(toggle, collapsed, itemName) {
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = collapsed ? `展开全部${itemName}` : `收起${itemName}`;
  toggle.setAttribute('aria-label', toggle.title);
}
function renderAlerts() {
  const list = $('alertList');
  if (!list) return;
  const ranks = { high: 0, medium: 1, low: 2 };
  const ordered = [...state.alerts].sort((a, b) => (ranks[a.level] ?? 3) - (ranks[b.level] ?? 3));
  const visibleAlerts = state.alertQueueCollapsed ? ordered.slice(0, 3) : ordered;
  const html = visibleAlerts.map((alert) => {
    const selection = alertSelection(alert);
    const active = state.selected.type === selection.type && state.selected.id === selection.id;
    return `<button type="button" class="alert-card ${esc(alert.level)} ${active ? 'selected' : ''}" data-focus-key="alert-${esc(alert.id)}" data-alert-id="${esc(alert.id)}" aria-pressed="${active}"><h3>${esc(severityLabel(alert.title))}</h3><small>${esc(alert.meta)}</small></button>`;
  }).join('');
  replacePanelMarkup(list, html || '<p class="ops-empty">当前无告警。</p>');
  if (!list._selectionListener) {
    list._selectionListener = true;
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-alert-id]');
      if (!button) return;
      const alert = state.alerts.find((item) => String(item.id) === button.dataset.alertId);
      if (!alert) return;
      contextReturnFocus = button;
      state.selected = alertSelection(alert);
      renderSelectionOnly();
      focusMapSelection();
    });
  }
  $('alertActiveLabel').textContent = state.alertQueueCollapsed && state.alerts.length > 3 ? `${state.alerts.length} 条 / 显示 3` : `${state.alerts.length} 条告警`;
  updateQueueToggle($('alertCollapseToggle'), state.alertQueueCollapsed, '告警列表');
  $('alertCollapseToggle').hidden = ordered.length <= 3;
}

function alertSelection(alert) {
  const targetId = alert.targetId ?? alert.target_id;
  const platformId = alert.platform_id ?? /^battery-(\d+)$/.exec(String(alert.id))?.[1];
  const taskId = /^task-(\d+)$/.exec(String(alert.id))?.[1];
  if (targetId != null && state.targets.some((item) => item.id === Number(targetId))) return { type: 'target', id: Number(targetId) };
  if (platformId != null && state.platforms.some((item) => item.id === Number(platformId))) return { type: 'platform', id: Number(platformId) };
  if (taskId != null && state.tasks.some((item) => item.id === Number(taskId))) return { type: 'task', id: Number(taskId) };
  return { type: 'alert', id: alert.id };
}
function manualTaskKeys(sessionId = state.sessionId) {
  if (!manualTaskOrigins.has(sessionId)) {
    let saved = [];
    try {
      const value = JSON.parse(sessionStorage.getItem(`tzb-manual-tasks:${sessionId}`) || '[]');
      if (Array.isArray(value)) saved = value.filter((key) => typeof key === 'string');
    } catch { /* 禁用存储时仍可依据当前接口和工具记录显示。 */ }
    manualTaskOrigins.set(sessionId, new Set(saved));
  }
  return manualTaskOrigins.get(sessionId);
}
function rememberManualTask(message, sessionId = state.sessionId) {
  // 兼容正在运行的旧服务：只读取工具实际注入成功的反馈，不采用模型自行陈述。
  const match = /^成功：已注入新任务 ([A-Za-z][A-Za-z0-9]*)#(\d+)\(/.exec(message || '');
  if (!sessionId || !match) return;
  const keys = manualTaskKeys(sessionId);
  const key = `${match[1]}#${match[2]}`;
  if (keys.has(key)) return;
  keys.add(key);
  try { sessionStorage.setItem(`tzb-manual-tasks:${sessionId}`, JSON.stringify([...keys])); }
  catch { /* 标记仍保存在当前页面内存中。 */ }
}
function isManualTask(task, recordedKeys) {
  return task.source != null ? task.source === 'manual'
    : task.decision?.stage === 'manual_dispatch' || (recordedKeys || manualTaskKeys()).has(`${task.type}#${task.id}`);
}
function renderManualTaskBadge(task, recordedKeys) {
  if (!isManualTask(task, recordedKeys)) return '';
  return '<span class="task-manual-badge" title="人工注入任务" aria-label="人工注入任务"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4" r="2.2"/><path d="M3 14v-2.5L5 9h6l2 2.5V14M5.5 14v-2M10.5 14v-2"/></svg><span>人工</span></span>';
}
function renderTasks() {
  const list = $('taskList');
  const toggle = $('taskCollapseToggle');
  const status = $('taskQueueStatus');
  if (!list) return;
  const ordered = [...state.tasks].sort((a, b) => (['ACTIVE', 'PENDING'].includes(a.status) ? 0 : 1) - (['ACTIVE', 'PENDING'].includes(b.status) ? 0 : 1) || Number(a.priority) - Number(b.priority));
  const activeCount = ordered.filter((task) => task.status === 'ACTIVE').length;
  const pendingCount = ordered.filter((task) => task.status === 'PENDING').length;
  if (status) status.textContent = `执行 ${String(activeCount).padStart(2, '0')} / 等待 ${String(pendingCount).padStart(2, '0')}`;
  updateQueueToggle(toggle, state.taskQueueCollapsed, '任务列表');
  const filter = $('taskFilter').value;
  const filtered = ordered.filter((task) => filter === 'all' || task.status === filter || (filter === 'history' && !['ACTIVE', 'PENDING'].includes(task.status)));
  const visibleTasks = state.taskQueueCollapsed ? filtered.slice(0, 5) : filtered;
  toggle.hidden = filtered.length <= 5;
  for (const trace of state.tasks.some((task) => task.source == null) ? [...(state.llmTraces || []), state.llmTrace].filter(Boolean) : []) {
    for (const step of trace.steps || []) {
      if (step.source === '工具' && step.label === '执行反馈' && step.status === 'done') rememberManualTask(step.detail);
    }
  }
  const recordedKeys = manualTaskKeys();
  const html = visibleTasks.map((task) => {
    const unitTags = renderPlatformTags(task.platform);
    const active = state.selected.type === 'task' && state.selected.id === task.id;
    return `<button type="button" class="task-row ${active ? 'selected' : ''}" data-task-id="${esc(task.id)}" data-focus-key="task-${esc(task.id)}" aria-pressed="${active}"><span class="task-priority" aria-label="优先级 ${esc(task.priority)}">${String(task.priority).padStart(2, '0')}</span><span class="task-name">${renderManualTaskBadge(task, recordedKeys)}<span>${esc(taskTypeLabel(task.type))} #${esc(task.id)}</span><small>${esc(statusLabel(task.status))}</small></span><span class="task-platform">${unitTags}</span></button>`;
  }).join('');
  replacePanelMarkup(list, html || '<p class="ops-empty">当前筛选下没有任务。</p>');
  if (!list._selectionListener) {
    list._selectionListener = true;
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-task-id]');
      if (!button) return;
      contextReturnFocus = button;
      state.selected = { type: 'task', id: Number(button.dataset.taskId) };
      renderSelectionOnly();
    });
  }
}
function buildLocalLlmTrace(command = '') {
  const hasCommand = Boolean(command);
  return {
    id: state.llmTraceSerial,
    model: state.connected ? 'DEEPSEEK-CHAT' : 'DEEPSEEK-CHAT / DEMO',
    status: hasCommand ? '处理中' : state.running ? '事件监听中' : '等待运行',
    latency_ms: null,
    steps: hasCommand ? [{ code: '01', time: state.elapsed, offset_ms: 0, source: '指令', label: '指挥指令接入', detail: command, status: 'active' }] : [],
    tool_call: 'NO ACTION',
    response: hasCommand ? '指令已接收，等待模型返回事件。' : '',
  };
}

function decisionRecordSteps() {
  const eventMeta = {
    session: { source: '会话', detail: '仿真会话状态发生变化。' },
    platform: { source: '平台', detail: '己方平台进入当前仿真。' },
    spawn: { source: '场景', detail: '预设实体到达当前仿真时刻。' },
    discovery: { source: '态势', detail: '态势层确认目标，进入任务规则核验。' },
    task: { source: '任务', detail: '任务队列状态发生变化。' },
    decision: { source: '决策', detail: '决策系统完成候选比较与平台分配。' },
    navigation: { source: '导航', detail: '导航或通行状态发生变化。' },
    behavior: { source: '行为测试', detail: '目标行为状态发生变化。' },
    llm: { source: '模型', detail: '模型处理结果已写入仿真会话。' },
  };
  const catalog = exercisePlaybackActive() ? playbackUi.catalog : null;
  const sourceEvents = catalog?.events || state.events;
  const sourceTraces = catalog?.llm_traces || state.llmTraces || [];
  const latestTrace = catalog?.llm_trace || state.llmTrace;
  const traces = new Map(sourceTraces.map((trace) => [String(trace.id), trace]));
  if (latestTrace) traces.set(String(latestTrace.id), latestTrace);
  // 已归档事件按稳定 ID 缓存，不为每份位置快照序列化全部文字详情。
  let eventCache = panelRenderState.eventCache;
  if (!eventCache || eventCache.session !== state.sessionId) {
    eventCache = panelRenderState.eventCache = { session: state.sessionId, source: null, items: new Map(), steps: [], version: 0 };
  }
  if (eventCache.source !== sourceEvents) {
    const seen = new Set(), steps = [];
    let changed = false;
    for (const event of sourceEvents) {
      if (!eventMeta[event.kind]) continue;
      const key = event.id != null ? `id:${event.id}` : `${event.kind}|${event.time}|${event.text}`;
      seen.add(key);
      let stored = eventCache.items.get(key);
      if (!stored || stored.time !== event.time || stored.kind !== event.kind || stored.text !== event.text || stored.detail !== event.detail) {
        const step = { code: `S${event.id ?? key}`, time: Number(event.time) || 0, offset_ms: null,
          source: eventMeta[event.kind].source, label: event.text,
          detail: event.detail || eventMeta[event.kind].detail, status: 'done', kind: event.kind,
          targetId: event.target_id, platformId: event.platform_id, taskId: event.task_id ?? event.decision?.task_id };
        stored = { time: event.time, kind: event.kind, text: event.text, detail: event.detail, step };
        eventCache.items.set(key, stored); changed = true;
      }
      steps.push(stored.step);
    }
    for (const key of eventCache.items.keys()) if (!seen.has(key)) { eventCache.items.delete(key); changed = true; }
    if (changed || steps.length !== eventCache.steps.length) { eventCache.steps = steps; eventCache.version += 1; }
    eventCache.source = sourceEvents;
  }
  const traceSignature = JSON.stringify([...traces.values()].map((trace) => [trace.id, trace.response, trace.steps || []]));
  const inputKey = `${state.sessionId}|${state.decisionRange}|${exercisePlaybackActive()}|${eventCache.version}|${traceSignature}`;
  const cached = panelRenderState.decisionCache;
  if (cached?.key === inputKey && state.elapsed >= cached.time && state.elapsed < cached.expires) return cached.steps;
  const hasDetailedModelRecords = traces.size > 0;
  const simulationSteps = eventCache.steps.filter((step) => !(step.kind === 'llm' && hasDetailedModelRecords));
  const modelSteps = [...traces.values()].flatMap((trace) => (trace.steps || []).map((step, index, traceSteps) => ({
    ...step,
    source: `${step.source || '模型'} #${String(trace.id || 0).padStart(3, '0')}`,
    traceId: trace.id,
    detail: index === traceSteps.length - 1 && trace.response && trace.response !== step.detail
      ? [step.detail, trace.response].filter(Boolean).join('\n\n') : step.detail,
  })));
  const rangeSeconds = timelineRanges[state.decisionRange] ?? null;
  const referenceTime = exercisePlaybackActive() ? Number(state.replay.computed_until) : Number(state.elapsed);
  const cutoff = rangeSeconds === null ? -Infinity : (referenceTime || 0) - rangeSeconds;
  const steps = [...simulationSteps, ...modelSteps]
    .filter((step) => Number(step.time || 0) >= cutoff)
    .sort((left, right) => Number(left.time || 0) - Number(right.time || 0) || Number(left.offset_ms || 0) - Number(right.offset_ms || 0));
  panelRenderState.decisionCache = { key: inputKey, time: state.elapsed, steps,
    expires: rangeSeconds === null || !steps.length ? Infinity : Number(steps[0].time || 0) + rangeSeconds + .001 };
  return steps;
}

function decisionStepKey(step, index = 0) {
  return `${step.traceId ?? 'sim'}|${step.code || index}|${step.time ?? 0}|${step.label || ''}`;
}

function eventSelection(step) {
  const labeledId = /#(\d+)/.exec(step.label || '')?.[1];
  const taskId = step.taskId ?? (step.kind === 'task' || step.kind === 'decision' ? labeledId : null);
  const targetId = step.targetId ?? (step.kind === 'discovery' ? labeledId : null);
  if (taskId != null && state.tasks.some((task) => task.id === Number(taskId))) return { type: 'task', id: Number(taskId) };
  if (targetId != null && state.targets.some((target) => target.id === Number(targetId))) return { type: 'target', id: Number(targetId) };
  const platform = state.platforms.find((item) => item.id === Number(step.platformId) || (step.kind === 'platform' && step.label?.startsWith(item.label + ' ')));
  return platform ? { type: 'platform', id: platform.id } : null;
}

function renderDecisionRows(traceElement, steps, followLatest) {
  const scope = `${state.sessionId}|${state.decisionRange}|${exercisePlaybackActive()}`;
  if (decisionListState.scope !== scope) {
    decisionListState.scope = scope; decisionListState.limit = 120;
    decisionListState.nodes.clear(); traceElement.replaceChildren();
    decisionListState.button = null; decisionListState.empty = null;
  }
  const limit = decisionListState.limit, visible = steps.slice(-limit), shown = new Set();
  const firstVisible = traceElement.querySelector('.llm-step');
  const oldOffset = !followLatest && firstVisible ? firstVisible.offsetTop - traceElement.scrollTop : null;
  const anchorKey = firstVisible?.dataset.decisionKey;
  if (!decisionListState.button) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'text-button'; button.dataset.decisionEarlier = 'true';
    button.addEventListener('click', () => {
      decisionListState.limit += 120;
      renderDecisionRows(traceElement, decisionRecordSteps(), false);
    });
    decisionListState.button = button;
    traceElement.prepend(button);
  }
  const earlier = Math.max(0, steps.length - visible.length);
  decisionListState.button.hidden = earlier === 0;
  decisionListState.button.textContent = `加载更早记录（${earlier} 条）`;
  let cursor = decisionListState.button.nextSibling;
  visible.forEach((step, index) => {
    const key = decisionStepKey(step, steps.length - visible.length + index), status = step.status || 'done';
    shown.add(key);
    let node = decisionListState.nodes.get(key);
    if (!node) {
      node = document.createElement('article'); node.className = 'llm-step'; node.dataset.decisionKey = key;
      node.innerHTML = '<div class="ops-event-header"><button type="button" class="ops-event-expand"><span><time></time> · <span class="event-source"></span> · <span class="event-status"></span></span><strong></strong></button><button type="button" class="event-replay-seek" hidden>定位</button></div><p class="llm-event-detail" hidden></p>';
      node._parts = { time: node.querySelector('time'), source: node.querySelector('.event-source'),
        label: node.querySelector('strong'), status: node.querySelector('.event-status'), detail: node.querySelector('p'),
        expand: node.querySelector('.ops-event-expand'), seek: node.querySelector('.event-replay-seek') };
      decisionListState.nodes.set(key, node); decisionListState.created += 1;
    }
    if (node._step !== step) {
      const parts = node._parts;
      parts.time.textContent = secondsLabel(step.time ?? state.elapsed); parts.source.textContent = step.source || '模型';
      parts.label.textContent = step.label || `事件 ${index + 1}`; parts.detail.textContent = step.detail || '';
      parts.status.textContent = status === 'active' ? '处理中' : status === 'error' ? '异常' : '已记录';
      node._step = step; decisionListState.updated += 1;
    }
    const expanded = state.expandedDecisionKey === key;
    const replayActive = exercisePlaybackActive(), eventTime = Number(step.time) || 0;
    const linked = replayActive ? null : eventSelection(step);
    node._parts.seek.hidden = !replayActive && !linked;
    node._parts.seek.dataset.locateEvent = String(eventTime);
    if (replayActive) node._parts.seek.dataset.replayTime = String(eventTime);
    else delete node._parts.seek.dataset.replayTime;
    node._parts.seek.title = replayActive ? `回放定位到 ${secondsLabel(eventTime)}` : '在地图上定位';
    node._parts.seek.setAttribute('aria-label', `${node._parts.seek.title} · ${step.label}`);
    node._parts.seek.disabled = replayActive && (playbackUi.busy || eventTime < Number(state.replay?.start_time || 0) || eventTime > Number(state.replay?.computed_until || 0));
    const located = replayActive && playbackUi.locatedKey === key;
    node.className = `llm-step ${status}${expanded ? ' expanded' : ''}${located ? ' replay-located' : ''}`;
    node._parts.expand.setAttribute('aria-expanded', String(expanded));
    node._parts.detail.hidden = !expanded;
    if (cursor === node) cursor = cursor.nextSibling;
    else { traceElement.insertBefore(node, cursor); }
  });
  for (const [key, node] of decisionListState.nodes) {
    if (shown.has(key)) continue;
    node.remove(); decisionListState.nodes.delete(key); decisionListState.removed += 1;
  }
  if (!steps.length) {
    if (!decisionListState.empty) {
      const empty = document.createElement('div'); empty.className = 'llm-trace-empty';
      empty.innerHTML = '<strong>等待决策事件</strong><span>运行仿真或下达指令后，事件将按发生时刻逐条显示</span>';
      decisionListState.empty = empty;
    }
    if (!decisionListState.empty.isConnected) traceElement.append(decisionListState.empty);
  } else decisionListState.empty?.remove();
  if (followLatest && steps.length) traceElement.scrollTop = traceElement.scrollHeight;
  else if (oldOffset !== null && anchorKey) {
    const anchor = decisionListState.nodes.get(anchorKey);
    if (anchor?.isConnected) traceElement.scrollTop = anchor.offsetTop - oldOffset;
  }
  decisionListState.revision += 1;
}

function renderLlmTrace() {
  if ($('llmWorkbench').hidden) return;
  const traceElement = $('llmTrace');
  const steps = decisionRecordSteps();
  const previousId = traceElement.dataset.traceId;
  const nextId = String(state.llmTrace?.id || 0);
  const wasNearBottom = traceElement.scrollHeight - traceElement.scrollTop - traceElement.clientHeight < 24;
  $('llmDecisionId').textContent = `${steps.length} 条记录`;
  const replayView = exercisePlaybackActive() ? `${state.elapsed}|${playbackUi.locatedKey}|${playbackUi.busy}` : state.elapsed;
  if (traceElement._renderedSteps !== steps || traceElement._replayView !== replayView) {
    renderDecisionRows(traceElement, steps, !exercisePlaybackActive() && (wasNearBottom || previousId !== nextId));
    traceElement._renderedSteps = steps;
    traceElement._replayView = replayView;
    traceElement.dataset.traceId = nextId;
  }
  document.querySelectorAll('[data-decision-range]').forEach((button) => {
    const active = button.dataset.decisionRange === state.decisionRange;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function toggleDecisionDetail(stepElement) {
  if (!stepElement) return;
  const key = stepElement.dataset.decisionKey;
  state.expandedDecisionKey = state.expandedDecisionKey === key ? null : key;
  document.querySelectorAll('#llmTrace .llm-step').forEach((item) => {
    const expanded = item.dataset.decisionKey === state.expandedDecisionKey;
    item.classList.toggle('expanded', expanded);
    item._parts.expand.setAttribute('aria-expanded', String(expanded));
    item._parts.detail.hidden = !expanded;
  });
  if (state.expandedDecisionKey) stepElement.scrollIntoView({ block: 'nearest' });
}

function renderFlowPanel() {
  const flow = state.flow || {};
  const phases = flow.phases || [];
  $('tickValue').textContent = String(state.tick || 0).padStart(4, '0');
  $('dtValue').textContent = `${Number(state.dt || 1).toFixed(1)} 秒`;
  $('phaseValue').textContent = flow.phase_label || '等待';
  replacePanelMarkup($('processSteps'), phases.map((step) => `<div class="process-step ${esc(step.status)}"><span class="step-mark">${step.status === 'done' ? '✓' : step.status === 'active' ? '›' : '·'}</span><span>${esc(step.label)}</span><span class="step-detail">${esc(step.detail)}</span></div>`).join(''));
  replacePanelMarkup($('processLog'), state.events.slice(0, 4).map((event) => `<div class="process-log-row"><time>${secondsLabel(event.time)}</time><span>${esc(event.text)}</span></div>`).join(''));
}
function renderUnitSelector() {
  const selector = $('unitSelector');
  const type = $('assetFilter').value;
  const platforms = state.platforms.filter((platform) => type === 'all' || platform.type === type)
    .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.label).localeCompare(String(b.label), 'zh-CN', { numeric: true }));
  selector.dataset.unitScale = String(state.unitScale || 1);
  $('unitCount').textContent = `${platforms.length} / ${state.platforms.length} 个平台`;
  const relatedPlatforms = state.selected.type === 'task' ? taskObjects().platforms : null;
  const html = platforms.map((platform) => {
    const selected = state.selected.type === 'platform' && state.selected.id === platform.id;
    const isUav = platform.type === 'uav';
    const battery = Number(platform.battery);
    const availability = platform.online === false ? 'offline' : isUav && battery <= 20 ? 'low' : 'online';
    const status = availability === 'offline' ? '离线' : availability === 'low' ? `低电量 ${battery.toFixed(0)}%` : '在线';
    const rawTask = String(platform.task || '待命');
    const task = rawTask === '待命' ? rawTask : rawTask.replace(/^[^#]+/, (label) => taskTypeLabel(label.trim()) + ' ');
    return `<button type="button" class="unit-tile ${isUav ? 'uav' : 'ugv'} ${selected ? 'selected' : ''} ${relatedPlatforms?.has(platform.id) ? 'related' : ''}" data-focus-key="asset-${esc(platform.id)}" data-platform-select="${esc(platform.id)}" aria-pressed="${selected}">
      <span class="unit-symbol" aria-hidden="true">${platformGlyphSvg(platform.type)}</span>
      <span class="unit-identity"><strong>${esc(platform.label)}</strong></span>
      <span class="ops-unit-status" data-status="${availability}" title="${esc(status)}"><span class="sr-only">${esc(status)}</span></span>
      <span class="unit-task">${esc(task)}</span>
    </button>`;
  }).join('');
  replacePanelMarkup(selector, html || '<p class="ops-empty">当前筛选下没有平台。</p>');
}

function selectPlatformById(platformId) {
  const platform = state.platforms.find((item) => String(item.id) === String(platformId));
  if (!platform) return;
  const selected = state.selected.type === 'platform' && state.selected.id === platform.id;
  state.selected = selected ? { type: 'none', id: null } : { type: 'platform', id: platform.id };
  renderSelectionOnly();
}
function renderEvaluation() {
  renderEvaluationPanel();
}
function renderMapLayerLegend() {
  const name = { coverage: '覆盖', priority: '优先级', passability: '通行' }[state.layer] || '自然底图';
  if ($('layerName').textContent !== name) $('layerName').textContent = name;
  $('mapLayers').dataset.active = String(Boolean(state.layer));
  const layerControl = $('mapLayers').querySelector('summary');
  layerControl.dataset.tip = `地图图层（${name}）`;
  layerControl.setAttribute('aria-label', layerControl.dataset.tip);
  if (!state.layer) {
    $('mapStatus').textContent = '自然底图';
    $('mapLayerLegend').hidden = true;
    return;
  }
  const coverage = state.layer === 'coverage';
  const demo = state.dataSource === 'demo';
  const passability = state.layer === 'passability';
  const legend = $('mapLayerLegend');
  $('mapStatus').textContent = coverage
    ? demo ? '覆盖情况（演示）：' : '最近扫描情况：'
    : passability ? '地面通行情况：' : '搜索优先级：';
  legend.hidden = coverage && state.dataSource === 'pending';
  legend.title = coverage
    ? demo ? '本地演示的覆盖示意，不代表真实扫描时间。' : '按仿真时间计算。超过 10 分钟未再次扫描，或从未扫描的区域，均显示为浅色。'
    : passability ? '无人车通行参考：道路通行成本较低，普通地面可通行，障碍不可通行；无人机不受此图限制。' : '相对搜索优先级：颜色越接近高值，越应优先安排搜索，不代表已确认存在目标。';
  const content = passability
    ? [[1, '道路'], [.28, '可通行'], [0, '障碍']].map(([value, label]) => `<span class="layer-category"><i class="layer-color-swatch" style="background:${mapLayerColor('passability', value)}" aria-hidden="true"></i>${label}</span>`).join('')
    : `<span>${coverage && !demo ? '刚扫描' : '高'}</span><i class="layer-color-ramp" style="background:linear-gradient(to right, ${mapLayerColor(state.layer, 1)}, ${mapLayerColor(state.layer, .5)}, ${mapLayerColor(state.layer, 0)})" aria-hidden="true"></i><span>${coverage && !demo ? '≥10 分钟 / 未扫描' : '低'}</span>`;
  if (legend.innerHTML !== content) legend.innerHTML = content;
}
function renderSummary() {
  const config = sceneConfig();
  const metrics = state.metrics || {};
  const evaluation = state.evaluation || {};
  const items = evaluation.metrics || [];
  const highAlerts = Number(metrics.alerts_high || 0);
  const averageBattery = Number(metrics.average_battery || 0);
  $('coverageValue').textContent = `${Number(metrics.coverage || 0).toFixed(1)}%`;
  $('coverageValue').className = 'metric-value data-text';
  $('coverageBar').style.width = `${Math.min(100, Number(metrics.coverage || 0))}%`;
  $('coverageLabel').textContent = config.coverageLabel;
  const handled = items.find((item) => ['rescue_rate', 'intercept_rate', 'neutralize_rate'].includes(item.key));
  $('handledLabel').textContent = config.handledLabel;
  $('handledValue').textContent = handled?.display || `${String(metrics.completed || 0).padStart(2, '0')} / ${String(metrics.total_tasks || 0).padStart(2, '0')}`;
  $('handledValue').className = 'data-text';
  $('onlineCount').textContent = String(metrics.online_platforms ?? state.platforms.length).padStart(2, '0');
  $('onlineCount').className = 'data-text';
  $('alertCount').textContent = String(highAlerts).padStart(2, '0');
  $('alertCount').className = highAlerts > 0 ? 'red-text' : 'data-text';
  $('simClock').textContent = `${secondsLabel(state.elapsed)} / ${secondsLabel(state.duration)}`;
  renderMapLayerLegend();
  $('completionValue').textContent = `${Number(metrics.completion_rate || 0).toFixed(0)}%`;
  $('completionValue').className = 'data-text';
  $('utilizationValue').textContent = `${Number(metrics.platform_utilization || 0).toFixed(0)}%`;
  $('utilizationValue').className = 'data-text';
  $('responseValue').textContent = `${averageBattery.toFixed(0)}%`;
  $('responseValue').className = averageBattery < 30 ? 'amber-text' : 'data-text';
  $('replanValue').textContent = String(metrics.decision_count ?? state.events.filter((event) => event.kind === 'decision').length).padStart(2, '0');
  $('replanValue').className = 'data-text';
}
function renderInspector() {
  const selected = state.selected.type !== 'none';
  const events = state.contextView === 'events';
  const manual = state.contextView === 'manual';
  const opened = manual || events || selected;
  $('contextPanel').hidden = !opened;
  $('manualPanel').hidden = !manual;
  syncNarrowOperations();
  $('contextTitle').textContent = manual ? exercisePlaybackActive() ? '历史指令' : '人工注入' : events ? '事件记录' : '对象详情';
  $('openTaskModal').setAttribute('aria-expanded', String(manual));
  $('eventToggle').setAttribute('aria-expanded', String(events));
  $('inspectorContent').hidden = events || manual;
  $('llmWorkbench').hidden = !events;
  if (manual) { renderManualPanel(); return; }
  if (events) { renderLlmTrace(); return; }
  if (!selected) return;
  const inspector = $('inspectorContent');
  let content = '';
  if (state.selected.type === 'platform') {
    const platform = state.platforms.find((item) => item.id === state.selected.id);
    content = platform ? platformInspector(platform) : '';
  } else if (state.selected.type === 'target') {
    const target = state.targets.find((item) => item.id === state.selected.id);
    content = target ? targetInspector(target) : '';
  } else if (state.selected.type === 'task') {
    const task = state.tasks.find((item) => item.id === state.selected.id);
    content = task ? taskInspector(task) : '';
  } else if (state.selected.type === 'alert') {
    const alert = state.alerts.find((item) => item.id === state.selected.id);
    if (alert) content = `<div class="object-card"><h3>${esc(severityLabel(alert.title))}</h3><p>${esc(alert.detail)}</p><p>${esc(alert.meta)}</p></div>`;
  }
  const task = state.tasks.find((item) => item.id === selectedTaskId());
  if (task && state.selected.type !== 'task') {
    content += `<h3 class="inspector-title">协同任务</h3><button type="button" class="btn btn-quiet" data-related-task="${esc(task.id)}">${esc(taskTypeLabel(task.type))} #${esc(task.id)}</button>
      <div class="data-table">${navPlatformRow('执行平台', task.platform)}</div>`;
  }
  replacePanelMarkup(inspector, content || '<p class="ops-empty">对象当前不可用。</p>');
  inspector.querySelectorAll('[data-action]').forEach((button) => {
    button.disabled = exercisePlaybackActive() || !task || !['ACTIVE', 'PENDING'].includes(task.status)
      || (!state.connected && state.dataSource !== 'demo');
  });
}

function renderBusinessPanels() {
  panelRenderState.lastFlush = performance.now();
  panelRenderState.flushes += 1;
  renderConnection(); renderRunState(); renderAlerts(); renderTasks(); renderInspector();
  renderSummary(); renderUnitSelector(); renderGeography(); renderNavigationUI(); renderPlaybackControls();
  if ($('reviewDialog').open) renderEvaluation();
  if ($('diagnosticsDialog').open && $('flowDetails').open) renderFlowPanel();
}

function renderSelectionOnly() {
  if (manualUi.pick) setManualMapPick(null);
  state.contextView = 'object';
  renderUnitSelector(); renderAlerts(); renderTasks(); renderInspector(); renderGeography(); renderNavigationUI(); drawMap();
  if (narrowOperations.matches && state.selected.type !== 'none' && $('railToggle').getAttribute('aria-expanded') === 'true') {
    contextReturnFocus = $('railToggle');
    setRailOpen(false);
    $('clearSelection').focus();
  }
}
function renderAll() { cancelPendingPanelRender(); renderBusinessPanels(); drawMap(); }
function selectedTaskId() { if (state.selected.type === 'task') return state.selected.id; if (state.selected.type === 'platform') return state.platforms.find((platform) => platform.id === state.selected.id)?.taskId; if (state.selected.type === 'target') return state.targets.find((target) => target.id === state.selected.id)?.taskId; return null; }

function taskObjects() {
  const task = state.tasks.find((item) => item.id === selectedTaskId());
  return {
    platforms: new Set(task?.platform_ids || []),
    target: task?.target_entity_id ?? task?.targetId,
    point: task?.target_pos ?? task?.targetPos,
  };
}

function selectedTaskWaypoint() {
  const { type } = state.selected;
  if (type !== 'task' && type !== 'platform') return null;
  const task = state.tasks.find(item => item.id === selectedTaskId());
  if (!task || (task.target_entity_id ?? task.targetId) != null || (type === 'platform' && !isManualTask(task))) return null;
  const point = task.target_pos ?? task.targetPos;
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) ? point : null;
}

function mapEmphasis() {
  const marks = new Map();
  if (state.selected.type === 'task') {
    const task = taskObjects();
    for (const id of task.platforms) marks.set('platform:' + id, 'related');
    if (task.target != null) marks.set('target:' + task.target, 'related');
  }
  for (const alert of state.alerts) {
    if (alert.level !== 'high' && alert.level !== 'medium') continue;
    const selection = alertSelection(alert);
    if (!['platform', 'target'].includes(selection.type)) continue;
    const key = selection.type + ':' + selection.id;
    const target = selection.type === 'target' && state.targets.find(item => item.id === selection.id);
    if (target && ['intruder', 'vehicle', 'aerial'].includes(target.type)) {
      if (!marks.has(key)) marks.set(key, 'label');
      continue;
    }
    if (!marks.has(key) || alert.level === 'high') marks.set(key, alert.level);
  }
  if (['platform', 'target'].includes(state.selected.type)) marks.set(state.selected.type + ':' + state.selected.id, 'selected');
  const target = activeTaskDraft()?.elements.targetId;
  if (target?.value && !target.disabled) marks.set('target:' + target.value, 'selected');
  return marks;
}

function focusMapSelection() {
  const { type, id } = state.selected;
  const task = type === 'task' ? taskObjects() : null;
  const object = type === 'platform' ? state.platforms.find((item) => item.id === id)
    : state.targets.find((item) => item.id === (type === 'target' ? id : task?.target));
  const point = object?.position || task?.point;
  if (!point) return;
  if (state.mapMode === '3d') {
    const record = object ? (type === 'platform' ? 'platform:' : 'target:') + object.id : null;
    map3dRuntime.renderer?.focusPoint(point, record);
    return;
  }
  const map = state.map || sceneConfig();
  state.mapView.centerX = point[0] / map.width;
  state.mapView.centerY = point[1] / map.height;
  state.mapView.zoom = Math.max(state.mapView.zoom, 1.5);
  clampMapCenter();
  updateMapViewUi();
  drawMap();
}
async function cancelSelectedTask() { if (!canOperateSimulation()) return; const taskId = selectedTaskId(); if (taskId == null) return toast('当前对象没有可取消的任务'); if (state.connected) { await backendPost(`/api/tasks/cancel/${taskId}`); return; } const task = state.tasks.find((item) => item.id === taskId); if (!task) return toast('任务不存在'); task.status = 'CANCELLED'; task.platform = '待释放'; task.platform_ids = []; state.metrics.active = Math.max(0, state.metrics.active - 1); pushEvent(`任务 #${taskId} 取消`, 'red', 'task'); renderAll(); toast(`已取消任务 #${taskId}`); }
async function reprioritizeSelectedTask() { if (!canOperateSimulation()) return; const taskId = selectedTaskId(); const task = state.tasks.find((item) => item.id === taskId); if (!task) return toast('当前对象没有可调整的任务'); const priority = Math.max(1, Number(task.priority) - 10); if (state.connected) { await backendPost(`/api/tasks/reprioritize/${taskId}`, { priority }); return; } task.priority = priority; pushEvent(`任务 #${taskId} 提级至 ${priority}`, 'amber', 'decision'); renderAll(); toast(`任务 #${taskId} 已提升为优先级 ${priority}`); }
const taskTargetKinds = {
  RescueTask: ['person', 'victim'], MedicalDeliveryTask: ['person', 'victim'], InterceptTask: ['intruder', 'aerial', 'vehicle'],
};

function configureTaskForm() {
  const form = $('taskForm');
  const type = form.elements.taskType.value;
  const kinds = taskTargetKinds[type];
  const coordinates = type === 'ArriveTask' || type === 'OccupyTask';
  const pos = form.elements.targetPos, target = form.elements.targetId;
  $('taskPositionField').hidden = !coordinates;
  pos.disabled = !coordinates;
  pos.required = coordinates;
  pos.setCustomValidity('');
  $('taskTargetField').hidden = !kinds;
  target.disabled = !kinds;
  target.required = Boolean(kinds);
  $('taskMapPick').hidden = !coordinates && !kinds;
  manualFeedback('taskFormStatus', '');
  if (!kinds) return;
  refreshTaskTargets();
  if (!target.value && state.selected.type === 'target') target.value = String(state.selected.id);
}

function refreshTaskTargets() {
  const form = $('taskForm');
  const kinds = taskTargetKinds[form.elements.taskType.value];
  if (!kinds) return;
  const target = form.elements.targetId;
  const candidates = state.targets.filter((item) => item.discovered !== false && kinds.includes(item.type));
  const signature = JSON.stringify(candidates.map((item) => [item.id, item.label]));
  if (target.dataset.options === signature) return;
  const selected = target.value;
  target.dataset.options = signature;
  target.replaceChildren(new Option(candidates.length ? '请选择已发现对象' : '当前没有符合条件的对象', ''),
    ...candidates.map((item) => new Option(item.label, item.id)));
  if (candidates.some((item) => String(item.id) === selected)) target.value = selected;
}

async function submitTask(form) {
  if (!canOperateSimulation() || exercisePlaybackActive() || state.sessionMode === 'navigation' || manualRequestPending()) return;
  const data = new FormData(form);
  const type = data.get('taskType');
  const targetId = data.get('targetId');
  const target = targetId ? state.targets.find((item) => item.id === Number(targetId)) : null;
  if (taskTargetKinds[type] && (!target || target.discovered === false || !taskTargetKinds[type].includes(target.type))) {
    configureTaskForm();
    manualFeedback('taskFormStatus', '所选对象已变化，请重新选择。', 'error');
    form.elements.targetId.focus();
    return;
  }
  let point;
  if (data.has('targetPos')) {
    point = parseTaskPoint(data.get('targetPos'));
    if (!point) {
      const map = state.map || sceneConfig();
      const input = form.elements.targetPos;
      input.setCustomValidity(`请输入沙盘内的两个坐标，X 为 0–${map.width} 米，Y 为 0–${map.height} 米。`);
      input.reportValidity();
      return;
    }
  }
  const payload = {
    task_type: type, priority: Number(data.get('priority')),
    target_pos: point?.join(','), target_entity_id: target?.id,
    target_entity_type: target?.type || (state.scene === 'rescue' ? 'victim' : state.scene === 'area' ? 'aerial' : 'person'),
    required_count: 1, required_platforms: Number(data.get('platforms')), required_capabilities: String(data.get('capability')),
    radius: 50, hold_time: 60,
  };
  if (state.connected) {
    manualUi.taskPending = true;
    renderBusinessPanels();
    manualFeedback('taskFormStatus', '正在提交任务…');
    try {
      let serviceMessage = '';
      const succeeded = await backendPost('/api/tasks/inject', payload, (message) => { serviceMessage = message; });
      manualFeedback('taskFormStatus', succeeded ? '任务已提交，可在任务队列查看分配状态。'
        : serviceMessage || '任务未提交。请检查连接、任务参数和所选对象后重试。', succeeded ? 'success' : 'error');
    } finally {
      manualUi.taskPending = false;
      renderBusinessPanels();
    }
    return;
  }
  const task = {
    id: Math.max(-1, ...state.tasks.map((item) => Number(item.id))) + 1, type, source: 'manual',
    priority: payload.priority, status: 'PENDING', platform: '待分配', platform_ids: [],
    target: target?.label || (point ? `坐标 (${point.join(', ')})` : '全域'),
    target_pos: point, target_entity_id: target?.id, capabilities: [payload.required_capabilities],
  };
  state.tasks.unshift(task); state.metrics.total_tasks += 1; state.metrics.active += 1;
  pushEvent(`人工注入 ${taskTypeLabel(task.type)} #${task.id}`, 'cyan', 'task');
  manualFeedback('taskFormStatus', `任务 #${task.id} 已提交，可在任务队列查看。`, 'success');
  renderAll();
  toast(`已注入 ${taskTypeLabel(task.type)} #${task.id}`);
}
const manualUi = { session: null, taskPending: false, pick: null };

function parseTaskPoint(value) {
  const parts = String(value).split(/[,，]/).map((part) => part.trim());
  const [x, y] = parts.map(Number), map = state.map || sceneConfig();
  if (parts.length !== 2 || parts.some((part) => !part) || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x > map.width || y > map.height) return null;
  return [x, y];
}

function activeTaskDraft() {
  const form = $('taskForm');
  return state.contextView === 'manual' && !exercisePlaybackActive() && manualUi.session === state.sessionId && !form.hidden ? form : null;
}

function manualDraftPoint() {
  const field = activeTaskDraft()?.elements.targetPos;
  return field && !field.disabled && field.value ? parseTaskPoint(field.value) : null;
}

function manualRequestPending() { return manualUi.taskPending || state.llmPending; }

function manualFeedback(id, message, tone = '') {
  const status = $(id);
  status.textContent = message;
  status.dataset.state = tone;
  status.hidden = !message;
}

function renderManualPanel() {
  const replay = exercisePlaybackActive();
  const writable = state.sessionMode !== 'navigation' && (state.connected || state.dataSource === 'demo') && !replay;
  $('manualCompose').hidden = replay;
  $('manualHistory').hidden = !replay;
  $('taskSubmit').disabled = !writable || manualRequestPending();
  $('taskSubmit').textContent = manualUi.taskPending ? '提交中…' : '提交任务';
  $('taskMapPick').disabled = !writable || manualRequestPending();
  $('commandInput').disabled = !state.connected || !writable || manualRequestPending();
  $('commandSend').disabled = $('commandInput').disabled;
  if ((!writable || state.contextView !== 'manual') && manualUi.pick) setManualMapPick(null);
  if (!replay) {
    if (manualUi.session !== state.sessionId) {
      manualUi.session = state.sessionId;
      $('taskForm').reset(); $('manualCommand').reset();
      manualFeedback('commandStatus', '');
      configureTaskForm();
    }
    refreshTaskTargets();
    return;
  }

  const tasks = state.tasks.filter((task) => task.source === 'manual' || task.decision?.stage === 'manual_dispatch')
    .map((task) => `<article><strong>${esc(taskTypeLabel(task.type))} #${esc(task.id)}</strong><p>${esc(statusLabel(task.status))} · ${esc(task.target || '全域')}</p></article>`);
  const traces = playbackUi.catalog?.llm_traces || state.llmTraces || [];
  const commands = traces.flatMap((trace) => {
    const visible = (trace.steps || []).filter((step) => Number(step.time) <= state.elapsed);
    if (!visible.length) return [];
    const complete = visible.length === trace.steps.length;
    return [`<article><strong>自然语言指令 · ${secondsLabel(visible[0].time)}</strong><p>${esc(visible[0].detail || trace.command || visible[0].label)}</p><p>${esc(complete ? trace.response || trace.status || visible.at(-1).label : visible.at(-1).label)}</p></article>`];
  });
  replacePanelMarkup($('manualHistory'), '<p class="manual-intro">显示当前回放时刻已记录的人工任务和指令。</p>'
    + ([...tasks, ...commands].slice(-120).join('') || '<p class="ops-empty">当前时刻暂无人工指令。</p>'));
}

function setManualMapPick(mode) {
  manualUi.pick = mode;
  const workspace = $('operationsWorkspace');
  if (mode) workspace.dataset.mapPick = mode;
  else delete workspace.dataset.mapPick;
  $('mapPickHint').hidden = !mode;
  if (mode) $('mapPickText').textContent = mode === 'target' ? '在地图上点击已发现的关联对象。' : '在地图上点击任务坐标。';
  syncNarrowOperations();
}

function handleManualMapClick(selection, getPoint) {
  if (state.contextView !== 'manual') return false;
  if (!manualUi.pick) return true;
  const form = $('taskForm');
  const mode = manualUi.pick;
  const field = mode === 'target' ? form.elements.targetId : form.elements.targetPos;
  if (mode === 'target') {
    refreshTaskTargets();
    if (selection?.type !== 'target' || ![...field.options].some((option) => option.value === String(selection.id))) {
      $('mapPickText').textContent = '请选择符合任务类型的已发现对象。';
      return true;
    }
    field.value = String(selection.id);
  } else {
    const point = getPoint(), map = state.map || sceneConfig();
    if (!point || point[0] < 0 || point[1] < 0 || point[0] > map.width || point[1] > map.height) {
      $('mapPickText').textContent = '请点击沙盘边界内的地面。';
      return true;
    }
    field.value = point.map((value) => Number(value.toFixed(1))).join(',');
    field.setCustomValidity('');
  }
  setManualMapPick(null);
  manualFeedback('taskFormStatus', '');
  field.focus();
  drawMap();
  return true;
}

async function handleCommand(command) {
  if (!command || manualRequestPending()) return;
  if (!state.connected || exercisePlaybackActive() || state.sessionMode === 'navigation') {
    manualFeedback('commandStatus', '请在仿真服务在线且处于实时任务模式时重新核对并发送。', 'error');
    return;
  }
  const input = $('commandInput');
  state.llmTraceSerial += 1;
  const pending = buildLocalLlmTrace(command);
  pending.id = state.llmTraceSerial;
  pending.status = '处理中';
  state.llmTrace = pending;
  state.llmPending = true;
  manualFeedback('commandStatus', '仿真服务正在处理指令…');
  renderBusinessPanels();

  try {
    const response = await fetch(`${API_BASE}/api/commands/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    const body = await response.json();
    const succeeded = response.ok && body.ok !== false && body.trace?.status !== '执行失败';
    const message = body.message || body.trace?.response || (typeof body.detail === 'string' ? body.detail
      : succeeded ? '指令已处理，详情见事件记录。' : '指令处理失败，请核对原文或检查服务连接。');
    if (body.trace) state.llmTrace = body.trace;
    else Object.assign(pending, { status: succeeded ? '已完成' : '执行失败', response: message });
    if (body.state) applyBackendSnapshot(body.state);
    if (succeeded && input.value.trim() === command) input.value = '';
    manualFeedback('commandStatus', message, succeeded ? 'success' : 'error');
    toast(succeeded ? '指令处理结果已记录' : '指令处理失败');
  } catch {
    const message = '指令服务未响应。请检查服务连接，并在事件记录核对后重试。';
    pending.status = '执行失败'; pending.response = message;
    const step = pending.steps.at(-1);
    if (step) { step.status = 'error'; step.detail = message; }
    manualFeedback('commandStatus', message, 'error');
  } finally {
    state.llmPending = false;
    renderBusinessPanels();
  }
}

function setupManualControls() {
  const tabs = [...document.querySelectorAll('.manual-tabs button')];
  const showTab = (selected) => {
    if (manualUi.pick) setManualMapPick(null);
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !active;
    }
    drawMap();
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab)));
  document.querySelector('.manual-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find((tab) => tab !== event.target);
    event.preventDefault(); showTab(next); next.focus();
  });
  $('openTaskModal').addEventListener('click', () => {
    if (state.contextView === 'manual') { closeContext(true); return; }
    contextReturnFocus = $('openTaskModal');
    setRailOpen(false);
    if (!exercisePlaybackActive() && manualUi.session !== state.sessionId) showTab(tabs[0]);
    state.contextView = 'manual';
    configureTaskForm();
    renderInspector();
    drawMap();
    (exercisePlaybackActive() ? $('clearSelection') : tabs.find((tab) => tab.tabIndex === 0)).focus();
  });
  $('taskMapPick').addEventListener('click', () => {
    const form = $('taskForm');
    setManualMapPick(form.elements.targetId.disabled ? 'point' : 'target');
    $('cancelMapPick').focus();
  });
  $('cancelMapPick').addEventListener('click', () => { setManualMapPick(null); $('taskMapPick').focus(); });
  const form = $('taskForm');
  form.addEventListener('input', () => { if (!manualUi.taskPending) manualFeedback('taskFormStatus', ''); });
  form.elements.taskType.addEventListener('change', () => { configureTaskForm(); drawMap(); });
  form.elements.targetId.addEventListener('change', drawMap);
  form.elements.targetPos.addEventListener('input', (event) => { event.target.setCustomValidity(''); drawMap(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault(); submitTask(form);
  });
  const confirm = $('commandConfirm');
  $('manualCommand').addEventListener('submit', (event) => {
    event.preventDefault();
    const command = $('commandInput').value.trim();
    if (!command || $('commandSend').disabled) return;
    $('commandPreview').textContent = command;
    confirm.dataset.session = state.sessionId;
    confirm.returnValue = '';
    confirm.showModal();
  });
  confirm.addEventListener('close', () => {
    if (confirm.returnValue === 'send' && confirm.dataset.session === String(state.sessionId)) handleCommand($('commandPreview').textContent);
  });
}
function handleMapClick(event) {
  if (state.mapView.suppressClick) { state.mapView.suppressClick = false; return; }
  const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; let nearest = null; let distance = 25;
  state.platforms.forEach((platform) => { const point = mapPoint(platform.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'platform', id: platform.id }; distance = d; } });
  state.targets.forEach((target) => { if (target.discovered === false) return; const point = mapPoint(target.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'target', id: target.id }; distance = d; } });
  if (handleManualMapClick(nearest, () => {
    const map = state.map || sceneConfig(), scale = mapPixelsPerMeter();
    return [state.mapView.centerX * map.width + (x - canvas.clientWidth / 2) / scale,
      state.mapView.centerY * map.height - (y - canvas.clientHeight / 2) / scale];
  })) return;
  if (nearest?.type === 'platform') selectPlatformById(nearest.id);
  else if (nearest) {
    state.selected = state.selected.type === 'target' && state.selected.id === nearest.id ? { type: 'none', id: null } : nearest;
    renderSelectionOnly();
  }
}
function beginMapPan(event) {
  if (event.button !== 0 || state.mapView.zoom <= 1) return;
  cancelMapWheel();
  event.preventDefault();
  Object.assign(state.mapView, { dragging: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startCenterX: state.mapView.centerX, startCenterY: state.mapView.centerY, moved: false });
  canvas.setPointerCapture(event.pointerId);
  updateMapViewUi();
}
function moveMapPan(event) {
  if (!state.mapView.dragging || event.pointerId !== state.mapView.pointerId) return;
  const dx = event.clientX - state.mapView.startX; const dy = event.clientY - state.mapView.startY;
  if (Math.hypot(dx, dy) > 3) state.mapView.moved = true;
  const map = state.map || sceneConfig(), scale = mapPixelsPerMeter();
  state.mapView.centerX = state.mapView.startCenterX - dx / (map.width * scale);
  state.mapView.centerY = state.mapView.startCenterY + dy / (map.height * scale);
  clampMapCenter(); drawMap();
}
function endMapPan(event) {
  if (!state.mapView.dragging || event.pointerId !== state.mapView.pointerId) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  state.mapView.suppressClick = state.mapView.moved;
  state.mapView.dragging = false; state.mapView.pointerId = null; updateMapViewUi();
}

const narrowOperations = matchMedia('(max-width: 900px)');
let contextReturnFocus = null;

function syncNarrowOperations() {
  const drawerOpen = $('operationsWorkspace').dataset.railOpen === 'true' || !$('contextPanel').hidden;
  document.querySelector('.ops-map').inert = narrowOperations.matches && drawerOpen && !manualUi.pick;
}

function setRailOpen(open) {
  $('operationsWorkspace').dataset.railOpen = String(open);
  $('railToggle').setAttribute('aria-expanded', String(open));
  syncNarrowOperations();
}

function selectOperationsTab(name, focus = false) {
  document.querySelectorAll('[data-ops-tab]').forEach((tab) => {
    const active = tab.dataset.opsTab === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
    if (active && focus) tab.focus();
  });
}

function closeContext(restoreFocus = false) {
  state.selected = { type: 'none', id: null };
  renderSelectionOnly();
  if (restoreFocus) {
    const key = contextReturnFocus?.dataset.focusKey;
    const target = key ? document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) : contextReturnFocus;
    (target?.getClientRects().length ? target : $('eventToggle')).focus();
  }
  contextReturnFocus = null;
}

function setupOperationsControls() {
  narrowOperations.addEventListener('change', () => {
    if (!narrowOperations.matches) setRailOpen(false);
    else syncNarrowOperations();
  });
  const tabs = [...document.querySelectorAll('[data-ops-tab]')];
  tabs.forEach((tab) => tab.addEventListener('click', () => selectOperationsTab(tab.dataset.opsTab)));
  document.querySelector('.ops-tabs').addEventListener('keydown', (event) => {
    const index = tabs.indexOf(event.target);
    const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (index < 0 || next == null) return;
    event.preventDefault();
    selectOperationsTab(tabs[next].dataset.opsTab, true);
  });
  const openRail = () => {
    if (!narrowOperations.matches) return;
    closeContext();
    setRailOpen(true);
  };
  $('railToggle').addEventListener('click', () => {
    if ($('railToggle').getAttribute('aria-expanded') === 'true') setRailOpen(false);
    else { openRail(); document.querySelector('[data-ops-tab][aria-selected="true"]').focus(); }
  });
  $('railClose').addEventListener('click', () => { setRailOpen(false); $('railToggle').focus(); });
  [['onlineShortcut', 'asset'], ['alertShortcut', 'alert']].forEach(([id, tab]) => {
    $(id).addEventListener('click', () => { openRail(); selectOperationsTab(tab, true); });
  });
  $('eventToggle').addEventListener('click', () => {
    if (state.contextView === 'events') { closeContext(true); return; }
    contextReturnFocus = $('eventToggle');
    setRailOpen(false);
    if (manualUi.pick) setManualMapPick(null);
    state.contextView = 'events';
    renderInspector();
    $('clearSelection').focus();
  });
  $('clearSelection').addEventListener('click', () => closeContext(true));
  $('assetFilter').addEventListener('change', renderUnitSelector);
  $('taskFilter').addEventListener('change', renderTasks);
  $('unitSelector').addEventListener('click', (event) => {
    const button = event.target.closest('[data-platform-select]');
    if (!button) return;
    contextReturnFocus = button;
    selectPlatformById(button.dataset.platformSelect);
  });
  $('inspectorContent').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const task = event.target.closest('[data-related-task]');
    if (task) { state.selected = { type: 'task', id: Number(task.dataset.relatedTask) }; renderSelectionOnly(); }
    else if (action === 'cancel' && window.confirm(`取消任务 #${selectedTaskId()}？`)) cancelSelectedTask();
    else if (action === 'reprioritize') reprioritizeSelectedTask();
  });
  $('reviewToggle').addEventListener('click', () => { renderSummary(); renderEvaluation(); $('reviewDialog').showModal(); });
  $('settingsButton').addEventListener('click', () => { renderFlowPanel(); $('diagnosticsDialog').showModal(); });
  $('flowDetails').addEventListener('toggle', () => { if ($('flowDetails').open) renderFlowPanel(); });
  const popovers = [...document.querySelectorAll('.ops-popover')];
  document.addEventListener('pointerdown', (event) => {
    for (const panel of popovers) if (panel.open && !panel.contains(event.target)) panel.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    const panel = popovers.find((item) => item.open);
    if (panel) { panel.open = false; panel.querySelector('summary').focus(); }
    else if (manualUi.pick) { setManualMapPick(null); $('taskMapPick').focus(); }
    else if (!$('contextPanel').hidden) closeContext(true);
    else if (narrowOperations.matches && $('railToggle').getAttribute('aria-expanded') === 'true') {
      setRailOpen(false); $('railToggle').focus();
    }
  });
}

function setupEnhancedEvents() {
  setupPlaybackControls();
  setupNavigationControls();
  setupManualControls();
  document.querySelectorAll('button[data-map-mode]').forEach((button) => button.addEventListener('click', () => setMapMode(button.dataset.mapMode)));
  document.querySelectorAll('[data-3d-view]').forEach((button) => button.addEventListener('click', () => {
    state.map3dView = button.dataset['3dView'];
    map3dRuntime.renderer?.setView(state.map3dView);
    updateMapModeUi();
  }));
  window.addEventListener('resize', resizeCanvas);
  $('scenarioSelect').value = state.scene;
  $('scenarioSelect').addEventListener('change', async (event) => {
    const scene = event.target.value;
    if (!canOperateSimulation()) { event.target.value = state.scene; return; }
    if (state.connected) { if (!await backendPost('/api/session/switch', { scene })) { event.target.value = state.scene; return; } }
    else { switchLocalScenario(scene); renderAll(); }
    resetMapView();
    toast(`已切换至${enhancedSceneConfigs[scene].name}，原场景进度已保留`);
  });
  $('runToggle').addEventListener('click', async () => { if (!canOperateSimulation()) return; if (state.connected) { await backendPost(state.running ? '/api/session/pause' : '/api/session/run'); } else { state.running = !state.running; renderAll(); } });
  $('speedToggle').addEventListener('click', async () => {
    if (speedRequestPending || !canOperateSimulation()) return;
    const next = speeds[(Math.max(0, state.speedIndex) + 1) % speeds.length];
    if (!state.connected) {
      state.speed = next; state.speedIndex = speeds.indexOf(next);
      renderAll();
      return;
    }
    speedRequestPending = true;
    $('speedToggle').disabled = true;
    try { await backendPost('/api/session/speed', { speed: next }); }
    finally { speedRequestPending = false; renderPlaybackControls(); }
  });
  $('stepButton').addEventListener('click', async () => { if (!canOperateSimulation()) return; if (state.connected) await backendPost('/api/session/step'); else localAdvance(1); });
  $('resetButton').addEventListener('click', () => { $('resetSceneName').textContent = `“${sceneConfig().name}”`; $('resetDialog').showModal(); });
  $('resetForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'default') return;
    event.preventDefault();
    if (!canOperateSimulation()) return;
    const scene = state.scene; const confirmButton = $('resetConfirm'); confirmButton.disabled = true;
    const succeeded = state.connected ? await backendPost('/api/session/reset', { scene }) : (localScenarioStates.delete(scene), resetLocalScenario(scene), renderAll(), true);
    confirmButton.disabled = false;
    if (succeeded) { resetMapView(); $('resetDialog').close(); toast(`${enhancedSceneConfigs[scene].name}已结束并重置`); }
  });
  $('zoomOut').addEventListener('click', () => setMapZoom(-1));
  $('zoomIn').addEventListener('click', () => setMapZoom(1));
  $('fitMap').addEventListener('click', () => { resetMapView(); toast('已回到全域视图'); });
  setupOperationsControls();
  document.querySelectorAll('[data-decision-range]').forEach((button) => button.addEventListener('click', () => {
    state.decisionRange = button.dataset.decisionRange || 'ten';
    renderLlmTrace();
  }));
  $('llmTrace').addEventListener('click', async (event) => {
    const row = event.target.closest('.llm-step');
    const locate = event.target.closest('[data-locate-event]');
    if (locate) {
      if (!exercisePlaybackActive()) {
        const selection = eventSelection(row._step);
        if (selection) { state.selected = selection; renderSelectionOnly(); focusMapSelection(); $('clearSelection').focus(); }
        return;
      }
      const key = row.dataset.decisionKey;
      state.expandedDecisionKey = key;
      await seekPlayback(Number(locate.dataset.locateEvent), key);
      renderLlmTrace();
      row.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.target.closest('.ops-event-expand')) toggleDecisionDetail(row);
  });

  document.querySelectorAll('.segment').forEach((button) => {
    const active = button.dataset.layer === state.layer;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      state.layer = state.layer === button.dataset.layer ? null : button.dataset.layer;
      document.querySelectorAll('.segment').forEach((item) => {
        const selected = item.dataset.layer === state.layer;
        item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected));
      });
      renderMapLayerLegend(); drawMap();
    });
  });
  document.querySelectorAll('.overlay-chip').forEach((button) => {
    button.setAttribute('aria-pressed', String(Boolean(state.overlays[button.dataset.overlay])));
    button.addEventListener('click', () => {
      const key = button.dataset.overlay;
      state.overlays[key] = !state.overlays[key];
      button.classList.toggle('active', state.overlays[key]);
      button.setAttribute('aria-pressed', String(state.overlays[key]));
      drawMap();
    });
  });
  $('alertCollapseToggle').addEventListener('click', () => { state.alertQueueCollapsed = !state.alertQueueCollapsed; renderAlerts(); });
  $('taskCollapseToggle').addEventListener('click', () => { state.taskQueueCollapsed = !state.taskQueueCollapsed; renderTasks(); });
  canvas.addEventListener('click', handleMapClick); canvas.addEventListener('pointerdown', beginMapPan); canvas.addEventListener('pointermove', moveMapPan); canvas.addEventListener('pointerup', endMapPan); canvas.addEventListener('pointercancel', endMapPan);
  canvas.addEventListener('wheel', handleMapWheel, { passive: false });
  window.setInterval(() => { if (state.dataSource === 'demo' && state.running) localAdvance(state.speed); }, 240);
  resetLocalScenario('rescue'); state.localInitialized = true; updateMapModeUi(); renderAll(); resizeCanvas(); updateMapViewUi();
  if (typeof ResizeObserver !== 'undefined') { mapResizeObserver = new ResizeObserver(resizeCanvas); mapResizeObserver.observe($('mapStage')); }
  connectBackend();
}

const applySnapshotBase = applyBackendSnapshot;
applyBackendSnapshot = (snapshot) => { applySnapshotBase(snapshot); if ($('scenarioSelect')) $('scenarioSelect').value = state.scene; };
setupEnhancedEvents();
