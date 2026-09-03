const state = {
  scene: 'border',
  running: true,
  speedIndex: 0,
  elapsed: 620,
  layer: 'coverage',
  selected: { type: 'platform', id: 'uav-02' },
  overlays: { routes: true, targets: true, cues: true },
  coverage: 78.4,
  tasks: [
    { id: 21, type: 'InterceptTask', priority: 5, status: 'ACTIVE', platform: 'UAV-02', target: '目标 #12', capabilities: ['sensor', 'effector'] },
    { id: 19, type: 'RepairTask', priority: 25, status: 'ACTIVE', platform: 'UGV-01', target: '设施 #14', capabilities: ['maintenance'] },
    { id: 1, type: 'ReconTask', priority: 70, status: 'ACTIVE', platform: 'UAV-01', target: '边境线区域', capabilities: ['sensor'] },
    { id: 3, type: 'ReconTask', priority: 90, status: 'PENDING', platform: '待分配', target: '高风险区域', capabilities: ['sensor'] },
  ],
  platforms: [
    { id: 'uav-01', label: 'UAV-01', type: 'uav', position: [1900, 1200], speed: 15, heading: 68, battery: 63, taskId: 1, task: 'ReconTask #01', capabilities: [{ name: 'sensor', state: '可用' }, { name: 'effector', state: '剩余 3 次' }], target: [6400, 4000], online: true },
    { id: 'uav-02', label: 'UAV-02', type: 'uav', position: [8420, 6180], speed: 20, heading: 126, battery: 21, taskId: 21, task: 'InterceptTask #21', capabilities: [{ name: 'sensor', state: '可用' }, { name: 'effector', state: '剩余 2 次' }], target: [8950, 5730], online: true },
    { id: 'uav-03', label: 'UAV-03', type: 'uav', position: [6700, 5100], speed: 18, heading: 112, battery: 46, taskId: 3, task: '待命', capabilities: [{ name: 'sensor', state: '可用' }, { name: 'effector', state: '剩余 3 次' }], target: [7700, 4300], online: true },
    { id: 'uav-04', label: 'UAV-04', type: 'uav', position: [4100, 1750], speed: 16, heading: 42, battery: 79, taskId: null, task: '待命', capabilities: [{ name: 'sensor', state: '可用' }, { name: 'effector', state: '剩余 3 次' }], target: null, online: true },
    { id: 'ugv-01', label: 'UGV-01', type: 'ugv', position: [4800, 3300], speed: 8, heading: 154, battery: 86, taskId: 19, task: 'RepairTask #19', capabilities: [{ name: 'sensor', state: '可用' }, { name: 'charger', state: '剩余 4 块' }, { name: 'maintenance', state: '剩余 2 件' }, { name: 'relay', state: '可用' }], target: [5550, 500], online: true },
    { id: 'ugv-02', label: 'UGV-02', type: 'ugv', position: [2100, 1100], speed: 8, heading: 48, battery: 91, taskId: null, task: '待命', capabilities: [{ name: 'sensor', state: '可用' }, { name: 'charger', state: '剩余 4 块' }, { name: 'maintenance', state: '剩余 3 件' }, { name: 'relay', state: '可用' }], target: null, online: true },
  ],
  targets: [
    { id: 12, label: '目标 #12', type: 'intruder', position: [9100, 7000], velocity: [1.8, -0.5], state: '跟踪中', confidence: .87, firstSeen: 'T+00:09:54', lastUpdate: 'T+00:10:20', taskId: 21 },
    { id: 14, label: '设施 #14', type: 'facility', position: [5550, 500], velocity: [0, 0], state: '待维修', confidence: .82, firstSeen: 'T+00:05:02', lastUpdate: 'T+00:10:19', taskId: 19 },
  ],
  alerts: [
    { id: 'a1', level: 'high', title: 'HIGH · 越境人员', detail: '目标 #12 · 置信度 0.87', meta: '距边境 1.2 km · T+00:10:12', targetId: 12 },
    { id: 'a2', level: 'medium', title: 'MED · 设施异常', detail: '围栏点 #14 · 待现场核查', meta: '固定节点 · T+00:10:05', targetId: 14 },
    { id: 'a3', level: 'low', title: 'LOW · 线索衰减', detail: 'Cue #07 · 置信度 0.70', meta: '剩余有效期 03:20', targetId: null },
  ],
  timeline: [
    { time: '10:01', text: '线索注入', color: 'cyan' }, { time: '10:05', text: '设施发现', color: 'amber' }, { time: '10:10', text: '目标发现', color: 'red' }, { time: '10:12', text: '任务抢占', color: 'blue' }, { time: '10:20', text: '状态同步', color: 'green' },
  ],
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
  ctx.strokeStyle = 'rgba(104, 124, 127, .17)';
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
  const w = canvas.clientWidth; const h = canvas.clientHeight; if (!w || !h) return; ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#172326'; ctx.fillRect(0, 0, w, h); drawGrid(w, h); drawHeatZones(w, h); drawTerrain(w, h); drawRoads(w, h); drawBorder(w, h); drawRoutes(); drawCues(); drawTargets(); drawPlatforms(); ctx.strokeStyle = '#53656e'; ctx.lineWidth = 1; ctx.strokeRect(12, 12, w - 24, h - 24); }

function renderAlerts() { $('alertActiveLabel').textContent = `${state.alerts.length} ACTIVE`; $('alertList').innerHTML = state.alerts.map((alert) => `<button class="alert-card ${alert.level} ${state.selected.type === 'alert' && state.selected.id === alert.id ? 'selected' : ''}" data-alert-id="${alert.id}"><h3>${alert.title}</h3><p>${alert.detail}</p><small>${alert.meta}</small></button>`).join(''); document.querySelectorAll('[data-alert-id]').forEach((button) => button.addEventListener('click', () => { const alert = state.alerts.find((item) => item.id === button.dataset.alertId); state.selected = { type: 'alert', id: alert.id }; if (alert.targetId) state.selected = { type: 'target', id: alert.targetId }; renderAll(); toast('已定位到告警区域'); })); }

function renderTasks() { $('taskList').innerHTML = state.tasks.map((task) => `<button class="task-row ${state.selected.type === 'task' && state.selected.id === task.id ? 'selected' : ''}" data-task-id="${task.id}"><span class="task-priority">${String(task.priority).padStart(2, '0')}</span><span class="task-name">${task.type} #${task.id}</span><span class="task-platform">${task.platform}</span></button>`).join(''); document.querySelectorAll('[data-task-id]').forEach((button) => button.addEventListener('click', () => { state.selected = { type: 'task', id: Number(button.dataset.taskId) }; renderAll(); })); }

function renderTimeline() { $('timeline').innerHTML = state.timeline.map((event) => `<div class="timeline-event"><div class="timeline-dot ${event.color}-text"></div><div class="timeline-label">${event.time} ${event.text}</div></div>`).join(''); }

function platformGlyphSvg(type, extraClass = '') {
  const kind = type === 'uav' ? 'uav' : 'ugv';
  const className = ['platform-glyph', kind, extraClass].filter(Boolean).join(' ');
  if (kind === 'uav') {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="square" stroke-linejoin="miter"><path d="M7.2 7.2 16.8 16.8M16.8 7.2 7.2 16.8"/><circle cx="6.2" cy="6.2" r="2.15"/><circle cx="17.8" cy="6.2" r="2.15"/><circle cx="6.2" cy="17.8" r="2.15"/><circle cx="17.8" cy="17.8" r="2.15"/><path d="m12 7.6 2.25 4.4L12 16.4 9.75 12Z" fill="currentColor"/><path d="M14.2 12H20"/></g></svg>`;
  }
  return `<svg class="${className}" viewBox="0 0 32 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="square" stroke-linejoin="miter"><path d="M3.5 14.8V8.2l4-4h17.3l3.7 4v6.6Z" fill="currentColor" fill-opacity=".68"/><path d="m8.2 5.2 3.2 5.2h7.2l2.8-5.2" fill="#111719"/><path d="M10.8 4.2v10.6" stroke-dasharray="2 2"/><rect x="5.2" y="13.7" width="21.8" height="6.2" rx="3.1" fill="#111719"/><circle cx="10.2" cy="16.8" r="1.8"/><circle cx="21.9" cy="16.8" r="1.8"/><path d="M3.5 9.4H1M3.5 11.5H1.7M17.3 4V2h4v2M19.3 2V.5M3.7 14.4H1.8v1.7h2.5"/></g><circle cx="15.1" cy="8.5" r="1" fill="currentColor"/></svg>`;
}

function targetGlyphSvg(type, extraClass = '') {
  const kind = ['victim', 'person', 'intruder', 'suspect'].includes(type) ? 'person' : type === 'vehicle' ? 'vehicle' : type === 'facility' ? 'facility' : 'generic';
  const className = ['target-glyph', kind, extraClass].filter(Boolean).join(' ');
  if (kind === 'facility') {
    return `<svg class="${className}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 3 29 28H3Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="miter"/><path d="M16 10v9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/><rect x="14.8" y="22.2" width="2.4" height="2.4" fill="currentColor"/></svg>`;
  }
  if (kind === 'vehicle') {
    return `<svg class="${className}" viewBox="0 0 36 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M3 16V10l5-4h16l6 5v5Z" fill="currentColor" fill-opacity=".12"/><path d="m9 7-3 5h20l-4-5"/><path d="M3 12H1.5M30 12h3"/><circle cx="9" cy="17" r="3" fill="#111719"/><circle cx="25" cy="17" r="3" fill="#111719"/><circle cx="9" cy="17" r="1"/><circle cx="25" cy="17" r="1"/></g></svg>`;
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
  const isUav = platform.type === 'uav';
  return `<div class="object-card"><div class="object-head"><div class="object-icon ${isUav ? '' : 'green-text'}">${platformGlyphSvg(platform.type, 'inspector-glyph')}</div><div><h3>${platform.label} · ${isUav ? '多旋翼无人机' : '无人车'}</h3><p>任务：${taskTypeLabel(String(platform.task || '').split(' #')[0])}</p></div><span class="object-status">${platform.online !== false ? '在线' : '离线'}</span></div></div><div class="inspector-divider"></div><div class="data-table"><div class="data-row"><span>位置</span><span>(${platform.position[0].toLocaleString()}, ${platform.position[1].toLocaleString()}) 米</span></div><div class="data-row"><span>速度 / 航向</span><span>${Number(platform.speed || 0).toFixed(1)} 米/秒 · ${Number(platform.heading || 0).toFixed(0)}°</span></div><div class="data-row"><span>当前意图点</span><span>${platform.target ? `(${platform.target[0].toLocaleString()}, ${platform.target[1].toLocaleString()}) 米` : '无'}</span></div><div class="data-row"><span>电量</span><span class="${platform.battery < 25 ? 'amber-text' : 'green-text'}">${Number(platform.battery || 0).toFixed(0)}%</span></div></div><h3 class="inspector-title">能力与资源</h3>${(platform.capabilities || []).map((cap) => `<div class="capability"><span>${capabilityLabel(cap.name)}</span><span class="${cap.state?.includes('剩余') && platform.battery < 25 ? 'amber-text' : 'green-text'}">${esc(cap.state || '可用')}</span></div>`).join('')}<h3 class="inspector-title">系统决策解释</h3><div class="decision-box"><p>候选平台 3 个 · 当前选中 ${platform.label}</p><p>能力匹配 ${(platform.capabilities || []).slice(0, 2).map((cap) => capabilityLabel(cap.name)).join(' + ') || '无'}</p><p>综合代价较低 · 当前任务已接管</p><p class="decision-link">查看候选评分明细 →</p></div><div class="inspector-actions"><button class="btn btn-quiet" data-action="reprioritize">调整优先级</button><button class="btn btn-danger" data-action="cancel">取消任务</button></div><p class="inspector-note">操作会提交到任务调度器<br/>下一仿真步生效 · 全部操作留痕</p>`;
}

function targetInspector(target) {
  const task = target.taskId != null ? state.tasks.find((item) => item.id === target.taskId) : null;
  const tone = target.type === 'facility' ? 'amber-text' : 'red-text';
  return `<div class="object-card"><div class="object-head"><div class="object-icon ${tone}">${targetGlyphSvg(target.type, 'inspector-target-glyph')}</div><div><h3>${esc(target.label)} · ${targetTypeLabel(target.type)}</h3><p>状态：${esc(target.state || '跟踪中')}</p></div><span class="object-status amber-text">持续跟踪</span></div></div><div class="inspector-divider"></div><div class="data-table"><div class="data-row"><span>位置</span><span>(${target.position[0].toLocaleString()}, ${target.position[1].toLocaleString()}) 米</span></div><div class="data-row"><span>速度</span><span>${(target.velocity || [0, 0]).map((value) => Number(value).toFixed(1)).join(', ')} 米/秒</span></div><div class="data-row"><span>置信度</span><span>${Math.round(Number(target.confidence || 0) * 100)}%</span></div><div class="data-row"><span>首次发现</span><span>${target.firstSeen || '未知'}</span></div><div class="data-row"><span>最近更新</span><span>${target.lastUpdate || '未知'}</span></div></div><h3 class="inspector-title">关联任务</h3><div class="capability"><span>${task ? `${taskTypeLabel(task.type)} #${task.id}` : '暂无关联任务'}</span><span class="amber-text">${task ? statusLabel(task.status) : '待处理'}</span></div><div class="inspector-actions"><button class="btn btn-quiet" data-action="reprioritize">调整优先级</button><button class="btn btn-danger" data-action="cancel">取消任务</button></div>`;
}

function taskInspector(task) {
  return `<div class="object-card"><div class="object-head"><div class="object-icon amber-text">◆</div><div><h3>${taskTypeLabel(task.type)} #${task.id}</h3><p>${esc(task.target || '全域')}</p></div><span class="object-status ${task.status === 'ACTIVE' ? 'green-text' : 'amber-text'}">${statusLabel(task.status)}</span></div></div><div class="inspector-divider"></div><div class="data-table"><div class="data-row"><span>优先级</span><span class="amber-text">${task.priority}（数字越小越高）</span></div><div class="data-row"><span>已分配平台</span><span>${esc(task.platform || '待分配')}</span></div><div class="data-row"><span>所需能力</span><span>${(task.capabilities || []).map(capabilityLabel).join(' + ') || '无'}</span></div><div class="data-row"><span>触发原因</span><span>${esc(task.trigger_reason || '系统调度生成')}</span></div></div><h3 class="inspector-title">任务说明</h3><div class="decision-box"><p>任务状态由调度器统一管理。</p><p>平台收到任务后自主生成运动控制意图。</p><p class="decision-link">查看任务生命周期 →</p></div><div class="inspector-actions"><button class="btn btn-quiet" data-action="reprioritize">调整优先级</button><button class="btn btn-danger" data-action="cancel">取消任务</button></div>`;
}

function renderInspector() { let content = ''; if (state.selected.type === 'platform') { const platform = state.platforms.find((item) => item.id === state.selected.id); content = platform ? platformInspector(platform) : ''; } else if (state.selected.type === 'target') { const target = state.targets.find((item) => item.id === state.selected.id); content = target ? targetInspector(target) : ''; } else if (state.selected.type === 'task') { const task = state.tasks.find((item) => item.id === state.selected.id); content = task ? taskInspector(task) : ''; } else { content = `<div class="inspector-empty">选择平台、目标或任务查看详情</div>`; } $('inspectorContent').innerHTML = content || `<div class="inspector-empty">对象已离线或不可用</div>`; document.querySelectorAll('[data-action="cancel"]').forEach((button) => button.addEventListener('click', cancelSelectedTask)); document.querySelectorAll('[data-action="reprioritize"]').forEach((button) => button.addEventListener('click', reprioritizeSelectedTask)); }

function renderSummary() { const config = currentConfig(); $('coverageValue').textContent = `${state.coverage.toFixed(1)}%`; $('coverageBar').style.width = `${Math.min(state.coverage, 100)}%`; document.querySelector('.metric-label').firstChild.textContent = `${config.coverageLabel} `; $('handledValue').textContent = config.handled; $('onlineCount').textContent = state.platforms.filter((p) => p.online).length; $('alertCount').textContent = String(state.alerts.filter((a) => a.level === 'high').length).padStart(2, '0'); $('simClock').textContent = `${formatTime(state.elapsed)} / ${formatTime(config.duration)}`; $('mapStatus').textContent = state.layer === 'coverage' ? config.mapStatus : `图层：${state.layer === 'priority' ? '搜索优先级' : 'UGV 可通行性'}`; }

function renderAll() { renderAlerts(); renderTasks(); renderTimeline(); renderInspector(); renderSummary(); drawMap(); }

function toast(message) { const el = $('mapToast'); el.textContent = message; el.classList.add('show'); window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove('show'), 2200); }

function advance(seconds = 1) { state.elapsed = Math.min(currentConfig().duration, state.elapsed + seconds); state.coverage = Math.min(95, state.coverage + .08 * seconds); state.platforms.forEach((platform) => { if (platform.task !== '待命' && platform.type === 'uav') platform.battery = Math.max(8, platform.battery - .02 * seconds); }); $('latencyValue').textContent = String(9 + Math.floor(Math.random() * 8)); renderSummary(); drawMap(); }

function cancelSelectedTask() { const taskId = state.selected.type === 'task' ? state.selected.id : state.selected.type === 'platform' ? state.platforms.find((p) => p.id === state.selected.id)?.taskId : state.selected.type === 'target' ? state.targets.find((t) => t.id === state.selected.id)?.taskId : null; if (!taskId) { toast('当前对象没有可取消的任务'); return; } const task = state.tasks.find((item) => item.id === taskId); if (task) { task.status = 'CANCELLED'; task.platform = '待释放'; state.platforms.forEach((platform) => { if (platform.taskId === taskId) { platform.taskId = null; platform.task = '待命'; platform.target = null; } }); state.timeline.push({ time: formatTime(state.elapsed).slice(3, 8), text: `任务 #${taskId} 取消`, color: 'red' }); renderAll(); toast(`已下达取消任务 #${taskId}`); } }

function reprioritizeSelectedTask() { const taskId = state.selected.type === 'task' ? state.selected.id : state.selected.type === 'platform' ? state.platforms.find((p) => p.id === state.selected.id)?.taskId : state.selected.type === 'target' ? state.targets.find((t) => t.id === state.selected.id)?.taskId : null; const task = state.tasks.find((item) => item.id === taskId); if (!task) { toast('当前对象没有可调整的任务'); return; } task.priority = Math.max(1, task.priority - 10); state.timeline.push({ time: formatTime(state.elapsed).slice(3, 8), text: `任务 #${taskId} 提级`, color: 'amber' }); renderAll(); toast(`任务 #${taskId} 已提升为优先级 ${task.priority}`); }

function submitTask(form) { const data = new FormData(form); const task = { id: Math.max(...state.tasks.map((item) => item.id)) + 1, type: data.get('taskType'), priority: Number(data.get('priority')), status: 'PENDING', platform: '待分配', target: `坐标 (${data.get('targetPos')})`, capabilities: [data.get('capability')] }; state.tasks.unshift(task); state.timeline.push({ time: formatTime(state.elapsed).slice(3, 8), text: `人工注入 #${task.id}`, color: 'cyan' }); state.selected = { type: 'task', id: task.id }; renderAll(); toast(`已注入 ${task.type} #${task.id}`); }

function setupEvents() {
  window.addEventListener('resize', resizeCanvas); $('scenarioSelect').addEventListener('change', (event) => { state.scene = event.target.value; state.elapsed = 0; state.coverage = state.scene === 'border' ? 78.4 : 64.2; renderAll(); toast(`已切换至${currentConfig().name}`); }); $('runToggle').addEventListener('click', () => { state.running = !state.running; $('runToggle').querySelector('span:last-child').textContent = state.running ? '运行' : '暂停'; $('runToggle').querySelector('.btn-icon').textContent = state.running ? '▶' : 'Ⅱ'; }); $('speedToggle').addEventListener('click', () => { state.speedIndex = (state.speedIndex + 1) % speeds.length; $('speedToggle').textContent = `× ${speeds[state.speedIndex].toFixed(1)}`; toast(`仿真速度 × ${speeds[state.speedIndex].toFixed(1)}`); }); $('stepButton').addEventListener('click', () => advance(1)); $('fitMap').addEventListener('click', () => { renderAll(); toast('已回到全域视图'); }); $('settingsButton').addEventListener('click', () => toast('设置面板将在接入仿真会话配置后开放')); document.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.segment').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.layer = button.dataset.layer; renderAll(); })); document.querySelectorAll('.overlay-chip').forEach((button) => button.addEventListener('click', () => { const key = button.dataset.overlay; state.overlays[key] = !state.overlays[key]; button.classList.toggle('active', state.overlays[key]); drawMap(); })); $('openTaskModal').addEventListener('click', () => $('taskDialog').showModal()); $('taskForm').addEventListener('submit', (event) => { event.preventDefault(); submitTask(event.target); $('taskDialog').close(); }); $('clearSelection').addEventListener('click', () => { state.selected = { type: 'none', id: null }; renderAll(); }); $('commandSend').addEventListener('click', handleCommand); $('commandInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCommand(); }); canvas.addEventListener('click', handleMapClick); window.setInterval(() => { if (state.running) advance(speeds[state.speedIndex]); }, 1000); }

function handleCommand() { const input = $('commandInput'); const command = input.value.trim(); if (!command) return; input.value = ''; const normalized = command.toLowerCase(); if (normalized.includes('东南') || normalized.includes('arrive')) { state.selected = { type: 'none', id: null }; $('taskDialog').showModal(); toast('自然语言指令已解析，请确认任务参数'); } else if (normalized.includes('取消')) { cancelSelectedTask(); } else if (normalized.includes('优先') || normalized.includes('提级')) { reprioritizeSelectedTask(); } else { toast('演示模式：已接收指令，等待后端解析'); } }

function handleMapClick(event) { const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; let nearest = null; let distance = 25; state.platforms.forEach((platform) => { const point = mapPoint(platform.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'platform', id: platform.id }; distance = d; } }); state.targets.forEach((target) => { const point = mapPoint(target.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'target', id: target.id }; distance = d; } }); if (nearest) { state.selected = nearest; renderAll(); } }

/* -------------------------------------------------------------------------
 * Web 仿真联动层
 *
 * 页面没有后端时使用轻量本地回退，启动 web_api.py 后会自动切换到真实
 * World.tick() 数据。这样布局和交互可以先演示，接入仿真后无需更换页面。
 */
const API_BASE = window.location.port === '8000' ? '' : 'http://127.0.0.1:8000';
const enhancedSceneConfigs = {
  rescue: { name: '人员搜救', width: 10000, height: 10000, duration: 7200, coverageLabel: '搜索区域覆盖率', targetLabel: '目标 ≥ 90%', handledLabel: '救援进度' },
  border: { name: '边境巡检', width: 12000, height: 12000, duration: 7200, coverageLabel: '边境线覆盖率', targetLabel: '目标 ≥ 95%', handledLabel: '异常处置' },
  area: { name: '区域封控', width: 6000, height: 6000, duration: 5400, coverageLabel: '外围预警覆盖率', targetLabel: '目标 ≥ 90%', handledLabel: '空中目标处置' },
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
state.map = { width: 10000, height: 10000, obstacles: [], roads: [], cues: [], layers: {} };
state.metrics = { coverage: 0, completed: 0, failed: 0, active: 0, total_tasks: 0, completion_rate: 0, average_battery: 100, online_platforms: 0, assigned_platforms: 0, platform_utilization: 0, discovered_targets: 0, alerts_high: 0 };
state.evaluation = { score: 0, goal_met: false, headline: '等待评价数据', metrics: [] };
state.events = [];
state.timelineRange = 'ten';
state.timelineSelection = null;
state.history = [];
state.flow = { phase: 'idle', phase_label: '等待运行', phases: [] };
state.speed = 1;
state.tick = 0;
state.dt = 1;
state.duration = 7200;
state.localFlags = {};
state.mapView = { zoom: 1, centerX: .5, centerY: .5, dragging: false, pointerId: null, moved: false, suppressClick: false };
let socket = null;
let reconnectTimer = null;
let mapResizeObserver = null;
const localScenarioStates = new Map();
const zoomLevels = [1, 1.25, 1.5, 2, 3, 4];

function sceneConfig() { return enhancedSceneConfigs[state.scene] || enhancedSceneConfigs.rescue; }
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
  return { id, label: platformLabel(id, type, ordinal), type, position: [...position], velocity: [0, 0], speed: isUav ? 15 : 8, heading: 0, battery: isUav ? 100 - id * 4 : 100, taskId: null, task: '待命', target: null, capabilities: isUav ? [{ name: 'sensor', state: '可用' }, ...(state.scene === 'area' || state.scene === 'border' ? [{ name: 'effector', state: '剩余 3 次' }] : [{ name: 'medical', state: '剩余 3 件' }])] : [{ name: 'rescue', state: '可用' }, { name: 'charger', state: '剩余 4 块' }], online: true };
}
function localTarget(id, type, position, extra = {}) {
  return { id, label: `${type === 'victim' ? '伤员' : type === 'facility' ? '设施' : '目标'} #${id}`, type, entity_type: type === 'victim' ? 'person' : type, position: [...position], velocity: [0, 0], confidence: .9, state: extra.injured ? '受伤' : '跟踪中', discovered: true, extra, track: [[...position]], taskId: null, firstSeen: 'T+00:00:00', lastUpdate: 'T+00:00:00' };
}
function pushEvent(text, color = 'cyan', kind = 'flow') {
  state.events.unshift({ time: state.elapsed, text, color, kind });
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
  const details = localPhaseDetails();
  state.flow = { phase: 'render', phase_label: '状态推送', phases: Object.entries({ spawn: '实体生成', control: '控制决策', movement: '运动执行', sensing: '态势感知', judge: '任务裁判', decision: '反应决策', render: '状态推送' }).map(([id, label]) => ({ id, label, status: 'done', detail: details[id] })) };
}
function localLayers() {
  const rows = 40; const cols = 40; const coverage = []; const priority = []; const passability = [];
  for (let y = 0; y < rows; y += 1) {
    const coverageRow = []; const priorityRow = []; const passabilityRow = [];
    for (let x = 0; x < cols; x += 1) {
      const edge = 1 - y / rows; const pulse = Math.min(1, state.elapsed / 800);
      coverageRow.push(Math.max(0, Math.min(1, pulse * .8 + edge * .12 + Math.sin(x * .6 + y) * .025)));
      priorityRow.push(Math.max(0, Math.min(1, edge * .72 + (x > cols * .62 ? .22 : 0))));
      const obstacle = (x > 9 && x < 15 && y > 15 && y < 23) || (x > 27 && x < 33 && y > 8 && y < 17);
      passabilityRow.push(obstacle ? 0 : ((x + y) % 9 === 0 ? 1 : .28));
    }
    coverage.push(coverageRow); priority.push(priorityRow); passability.push(passabilityRow);
  }
  return { width: cols, height: rows, coverage, priority, passability };
}
function resetLocalScenario(scene = 'rescue') {
  state.connected = false; state.scene = scene; state.running = false; state.speed = 1; state.speedIndex = 0; state.elapsed = 0; state.tick = 0; state.duration = sceneConfig().duration; state.dt = 1; state.localFlags = { spawned: 0 };
  state.platforms = [];
  const platformCount = scene === 'area' ? 7 : 6;
  for (let i = 0; i < platformCount; i += 1) state.platforms.push(localPlatform(i, i < (scene === 'area' ? 5 : 4) ? 'uav' : 'ugv', [500 + (i % 4) * 550, 500 + Math.floor(i / 4) * 500]));
  if (scene === 'rescue') {
    state.targets = [localTarget(12, 'victim', [2000, 2000], { injured: true }), localTarget(13, 'victim', [4000, 4000], { injured: true }), localTarget(14, 'victim', [6000, 6000]), localTarget(15, 'victim', [8000, 2000]), localTarget(16, 'victim', [8000, 8000])];
    state.tasks = [{ id: 0, type: 'ReconTask', priority: 90, status: 'ACTIVE', platform: 'UAV-04', platform_ids: [3], target: '全域搜索', capabilities: ['sensor'] }, { id: 1, type: 'DiscoverTask', priority: 70, status: 'ACTIVE', platform: 'UAV-01', platform_ids: [0], target: '5 名人员', capabilities: ['sensor'] }, { id: 2, type: 'ArriveTask', priority: 65, status: 'PENDING', platform: '待分配', platform_ids: [], target: '坐标 (4000, 4000)', target_pos: [4000, 4000], capabilities: ['sensor'] }];
  } else if (scene === 'border') {
    state.targets = [localTarget(12, 'intruder', [9100, 7000], { role: 'intruder' }), localTarget(14, 'facility', [5550, 500], { repaired: false })];
    state.tasks = [{ id: 21, type: 'InterceptTask', priority: 5, status: 'ACTIVE', platform: 'UAV-02', platform_ids: [1], target: '目标 #12', capabilities: ['effector'] }, { id: 19, type: 'RepairTask', priority: 60, status: 'ACTIVE', platform: 'UGV-01', platform_ids: [4], target: '设施 #14', capabilities: ['maintenance'] }, { id: 1, type: 'ReconTask', priority: 90, status: 'ACTIVE', platform: 'UAV-01', platform_ids: [0], target: '边境线', capabilities: ['sensor'] }];
  } else {
    state.targets = [localTarget(20, 'aerial', [500, 3000], { neutralized: false }), localTarget(21, 'aerial', [5900, 4200], { neutralized: false })];
    state.tasks = [{ id: 0, type: 'GuardTask', priority: 0, status: 'ACTIVE', platform: 'UAV-01, UAV-02', platform_ids: [0, 1], target: '核心禁入区', capabilities: ['sensor', 'effector'] }, { id: 1, type: 'ReconTask', priority: 90, status: 'ACTIVE', platform: 'UAV-03', platform_ids: [2], target: '全域搜索', capabilities: ['sensor'] }];
  }
  state.targets.forEach((target) => { const task = state.tasks.find((item) => taskTargetText(item).includes(`#${target.id}`)); if (task) target.taskId = task.id; });
  state.map = { width: sceneConfig().width, height: sceneConfig().height, obstacles: [{ center: [sceneConfig().width * .32, sceneConfig().height * .35], radius: Math.min(sceneConfig().width, sceneConfig().height) * .055 }, { center: [sceneConfig().width * .72, sceneConfig().height * .62], radius: Math.min(sceneConfig().width, sceneConfig().height) * .045 }], roads: [{ waypoints: [[500, 500], [sceneConfig().width * .3, sceneConfig().height * .15], [sceneConfig().width * .72, sceneConfig().height * .35], [sceneConfig().width * .92, sceneConfig().height * .72]] }], cues: [{ id: 7, position: [sceneConfig().width * .23, sceneConfig().height * .74], confidence: .7, radius: 500 }], layers: localLayers() };
  state.metrics = { coverage: scene === 'rescue' ? 8 : 12, completed: 0, failed: 0, active: state.tasks.filter((task) => ['ACTIVE', 'PENDING'].includes(task.status)).length, total_tasks: state.tasks.length, completion_rate: 0, average_battery: state.platforms.reduce((sum, p) => sum + p.battery, 0) / state.platforms.length, online_platforms: state.platforms.length, assigned_platforms: 0, platform_utilization: 0, discovered_targets: state.targets.length, alerts_high: scene === 'area' || scene === 'border' ? 1 : 0 };
  state.evaluation = { score: 0, goal_met: false, headline: '本地演示：评价随仿真推进', metrics: [
    { key: 'coverage', label: scene === 'border' ? '边境线覆盖率' : scene === 'area' ? '外围预警覆盖率' : '搜索覆盖率', value: state.metrics.coverage, display: `${state.metrics.coverage.toFixed(1)}%`, unit: '%', target: scene === 'border' ? 95 : 90, tone: 'blue', detail: '本地演示数据' },
    { key: 'task_completion_rate', label: '任务完成率', value: 0, display: '0.0%', unit: '%', target: 100, tone: 'cyan', detail: '0 个任务已完成' },
  ] };
  state.alerts = localAlerts(); state.events = []; state.history = []; state.selected = { type: 'platform', id: state.platforms[0]?.id ?? null }; pushEvent(`场景「${sceneConfig().name}」已加载`, 'cyan', 'session'); localFlow();
}
function cloneData(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function saveLocalScenario() {
  localScenarioStates.set(state.scene, cloneData({
    running: state.running, speed: state.speed, speedIndex: state.speedIndex, elapsed: state.elapsed,
    tick: state.tick, duration: state.duration, dt: state.dt, localFlags: state.localFlags,
    platforms: state.platforms, targets: state.targets, tasks: state.tasks, map: state.map,
    metrics: state.metrics, evaluation: state.evaluation, alerts: state.alerts, events: state.events,
    history: state.history, flow: state.flow, selected: state.selected,
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
  const delta = Number(seconds) || 1; state.elapsed = Math.min(state.duration, state.elapsed + delta); state.tick += 1;
  state.platforms.forEach((platform, index) => {
    const task = state.tasks.find((item) => item.platform_ids?.includes(platform.id) && ['ACTIVE', 'PENDING'].includes(item.status));
    if (!task) { platform.velocity = [0, 0]; platform.task = '待命'; platform.target = null; return; }
    platform.taskId = task.id; platform.task = `${task.type} #${task.id}`;
    const target = task.target_pos || (state.targets.find((item) => taskTargetText(task).includes(`#${item.id}`)) || {}).position || [state.map.width * (.3 + index * .12), state.map.height * (.3 + index * .08)];
    platform.target = [...target]; const dx = target[0] - platform.position[0]; const dy = target[1] - platform.position[1]; const distance = Math.hypot(dx, dy); const speed = platform.type === 'uav' ? 15 : 8; const step = Math.min(distance, speed * delta); if (distance > .1) { platform.position = [platform.position[0] + dx / distance * step, platform.position[1] + dy / distance * step]; platform.velocity = [dx / distance * speed, dy / distance * speed]; platform.heading = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; } else { platform.velocity = [0, 0]; }
    if (platform.type === 'uav' && platform.task !== '待命') platform.battery = Math.max(8, platform.battery - .015 * delta);
  });
  if (!state.localFlags.discovery && state.elapsed >= 15) { state.localFlags.discovery = true; pushEvent(`态势层发现 ${state.targets[0]?.label || '新目标'}`, 'amber', 'discovery'); }
  if (state.scene === 'area' && !state.localFlags.wave && state.elapsed >= 120) { state.localFlags.wave = true; pushEvent('第一波空中目标进入外围预警区', 'red', 'spawn'); }
  state.targets.forEach((target) => { target.track = (target.track || []).concat([[...target.position]]).slice(-90); target.lastUpdate = secondsLabel(state.elapsed); });
  state.metrics.coverage = Math.min(96, state.metrics.coverage + delta * (state.scene === 'rescue' ? .06 : .08)); state.metrics.average_battery = state.platforms.reduce((sum, p) => sum + p.battery, 0) / state.platforms.length; state.metrics.active = state.tasks.filter((task) => ['ACTIVE', 'PENDING'].includes(task.status)).length; state.metrics.assigned_platforms = state.platforms.filter((platform) => platform.taskId != null).length; state.metrics.platform_utilization = state.platforms.length ? state.metrics.assigned_platforms / state.platforms.length * 100 : 0; state.metrics.completion_rate = state.metrics.total_tasks ? state.metrics.completed / state.metrics.total_tasks * 100 : 0; state.evaluation.metrics = state.evaluation.metrics.map((metric) => metric.key === 'coverage' ? ({ ...metric, value: state.metrics.coverage, display: `${state.metrics.coverage.toFixed(1)}%` }) : metric.key === 'task_completion_rate' ? ({ ...metric, value: state.metrics.completion_rate, display: `${state.metrics.completion_rate.toFixed(1)}%` }) : metric); state.alerts = localAlerts(); state.history.push({ time: state.elapsed, coverage: state.metrics.coverage, completed: state.metrics.completed, active: state.metrics.active, battery: state.metrics.average_battery }); state.history = state.history.slice(-180); state.localFlags.spawned = 0; localFlow(); pushEvent(`第 ${String(state.tick).padStart(4, '0')} 步 · ${state.flow.phase_label}`, 'cyan', 'flow'); renderAll();
}

function applyBackendSnapshot(snapshot) {
  if (!snapshot?.simulation) return;
  const sim = snapshot.simulation; state.connected = true; state.scene = sim.scene; state.running = Boolean(sim.running); state.speed = Number(sim.speed) || 1; state.speedIndex = Math.max(0, speeds.findIndex((speed) => speed === state.speed)); if (state.speedIndex < 0) state.speedIndex = 0; state.elapsed = Number(sim.time) || 0; state.tick = Number(sim.tick) || 0; state.dt = Number(sim.dt) || 1; state.duration = Number(sim.duration) || sceneConfig().duration; state.map = snapshot.map || state.map; const backendPlatforms = (snapshot.platforms || []).map((platform) => ({ ...platform, taskId: platform.task_id, task: platform.task || '待命' })); const typeOrdinals = {}; state.platforms = backendPlatforms.map((platform) => { typeOrdinals[platform.type] = (typeOrdinals[platform.type] || 0) + 1; return { ...platform, label: platformLabel(platform.id, platform.type, typeOrdinals[platform.type]) }; }); const platformLabels = new Map(state.platforms.map((platform) => [platform.id, platform.label])); const taskList = (snapshot.tasks || []).map((task) => ({ ...task, platform: (task.platform_ids || []).map((id) => platformLabels.get(id)).filter(Boolean).join(', ') || task.platform || '待分配', taskId: task.id, platformIds: task.platform_ids || [], targetId: task.target_entity_id, targetPos: task.target_pos })); state.tasks = taskList; const taskByTarget = new Map(taskList.filter((task) => task.targetId != null).map((task) => [task.targetId, task.id])); state.targets = (snapshot.targets || []).map((target) => ({ ...target, label: `${targetTypeLabel(target.type)} #${target.id}`, taskId: taskByTarget.get(target.id) || null, firstSeen: secondsLabel(target.timestamp), lastUpdate: secondsLabel(target.timestamp), extra: target.extra || {} })); state.alerts = (snapshot.alerts || []).map((alert) => ({ ...alert, targetId: alert.target_id })); state.metrics = snapshot.metrics || state.metrics; state.evaluation = snapshot.evaluation || state.evaluation; state.history = snapshot.history || []; state.flow = snapshot.flow || state.flow; state.events = snapshot.events || []; if (!selectionStillExists()) state.selected = { type: 'platform', id: state.platforms[0]?.id ?? null }; document.body.dataset.backend = 'connected'; renderAll(); }
async function backendPost(path, payload) { if (!state.connected) return false; try { const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) }); const body = await response.json(); if (body.simulation) applyBackendSnapshot(body); else if (body.state) applyBackendSnapshot(body.state); if (body.message) toast(body.message); return response.ok && body.ok !== false; } catch (error) { state.connected = false; renderConnection(); return false; } }
function connectSocket() { if (socket || window.location.protocol === 'file:') return; const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; const host = window.location.port === '8000' ? window.location.host : '127.0.0.1:8000'; socket = new WebSocket(`${protocol}//${host}/ws`); socket.onopen = () => { state.connected = true; renderConnection(); }; socket.onmessage = (event) => { try { applyBackendSnapshot(JSON.parse(event.data)); } catch (error) { /* ignore malformed frame */ } }; socket.onclose = () => { socket = null; state.connected = false; renderConnection(); if (!reconnectTimer) reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectBackend(); }, 2500); }; socket.onerror = () => socket?.close(); }
async function connectBackend() { if (window.location.protocol === 'file:') return; try { const response = await fetch(`${API_BASE}/api/state`, { signal: AbortSignal.timeout(900) }); if (!response.ok) throw new Error('backend unavailable'); applyBackendSnapshot(await response.json()); connectSocket(); } catch (error) { state.connected = false; renderConnection(); if (!state.localInitialized) { resetLocalScenario('rescue'); state.localInitialized = true; renderAll(); } } }
function renderConnection() { const connection = $('connectionStatus'); const stream = $('streamStatus'); if (!connection || !stream) return; connection.querySelector('span').textContent = state.connected ? '仿真服务在线' : '本地演示模式'; stream.querySelector('span').textContent = state.connected ? '实时数据流' : '本地推进流'; connection.classList.toggle('offline', !state.connected); }
function renderRunState() { const button = $('runToggle'); if (!button) return; const active = state.running; button.querySelector('span:last-child').textContent = active ? '暂停' : '运行'; button.querySelector('.btn-icon').textContent = active ? 'Ⅱ' : '▶'; button.classList.toggle('btn-run', !active); const speedButton = $('speedToggle'); if (speedButton) speedButton.textContent = `× ${Number(state.speed || 1).toFixed(1)}`; }
function selectionStillExists() {
  const { type, id } = state.selected || {};
  if (type === 'platform') return state.platforms.some((item) => item.id === id);
  if (type === 'target') return state.targets.some((item) => item.id === id);
  if (type === 'task') return state.tasks.some((item) => item.id === id);
  if (type === 'alert') return state.alerts.some((item) => item.id === id);
  return type === 'none';
}

function resizeCanvas() { const rect = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio)); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); drawMap(); updateMapViewUi(); }
function mapPoint([x, y]) { const w = canvas.clientWidth; const h = canvas.clientHeight; const map = state.map || sceneConfig(); const view = state.mapView; return [12 + (.5 + (x / map.width - view.centerX) * view.zoom) * (w - 24), 12 + (.5 - (y / map.height - view.centerY) * view.zoom) * (h - 24)]; }
function clampMapCenter() { const half = .5 / state.mapView.zoom; state.mapView.centerX = Math.max(half, Math.min(1 - half, state.mapView.centerX)); state.mapView.centerY = Math.max(half, Math.min(1 - half, state.mapView.centerY)); }
function updateMapViewUi() { const index = zoomLevels.indexOf(state.mapView.zoom); $('zoomValue').textContent = `${Math.round(state.mapView.zoom * 100)}%`; $('zoomOut').disabled = index <= 0; $('zoomIn').disabled = index >= zoomLevels.length - 1; canvas.classList.toggle('pan-ready', state.mapView.zoom > 1 && !state.mapView.dragging); canvas.classList.toggle('is-panning', state.mapView.dragging); const mapWidth = (state.map || sceneConfig()).width; const metersPerPixel = mapWidth / Math.max(1, (canvas.clientWidth - 24) * state.mapView.zoom); const idealDistance = metersPerPixel * 88; const distances = [100, 200, 500, 1000, 2000, 5000]; const scaleDistance = distances.reduce((best, value) => Math.abs(Math.log(value / idealDistance)) < Math.abs(Math.log(best / idealDistance)) ? value : best); $('mapScaleBar').style.width = `${scaleDistance / metersPerPixel}px`; $('mapScaleLabel').textContent = scaleDistance >= 1000 ? `${scaleDistance / 1000} km` : `${scaleDistance} m`; }
function setMapZoom(direction) { const current = zoomLevels.indexOf(state.mapView.zoom); const next = Math.max(0, Math.min(zoomLevels.length - 1, current + direction)); state.mapView.zoom = zoomLevels[next]; clampMapCenter(); updateMapViewUi(); drawMap(); toast(`地图缩放 ${Math.round(state.mapView.zoom * 100)}%`); }
function resetMapView() { Object.assign(state.mapView, { zoom: 1, centerX: .5, centerY: .5, dragging: false, pointerId: null, moved: false, suppressClick: false }); updateMapViewUi(); drawMap(); }
const mapLabelFont = '9px "Microsoft YaHei UI", "Arial Narrow", sans-serif';
const mapDataFont = '8px "Cascadia Mono", Consolas, monospace';
const mapUnitFont = '600 8px "Cascadia Mono", Consolas, monospace';
const mapUnitDataFont = '7px "Microsoft YaHei UI", sans-serif';

function drawGrid(w, h) {
  const map = state.map || sceneConfig();
  const [left, bottom] = mapPoint([0, 0]);
  const [right, top] = mapPoint([map.width, map.height]);
  ctx.save();
  ctx.strokeStyle = 'rgba(123, 135, 139, .14)';
  ctx.fillStyle = 'rgba(151, 161, 163, .46)';
  ctx.lineWidth = 1;
  ctx.font = mapDataFont;
  for (let i = 0; i <= 6; i += 1) {
    const [x] = mapPoint([map.width / 6 * i, 0]);
    const [, y] = mapPoint([0, map.height / 6 * i]);
    if (i > 0 && i < 6) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
    if (state.mapView.zoom === 1 && i < 6) {
      const xKm = Math.round(map.width / 6 * i / 1000);
      const yKm = Math.round(map.height / 6 * i / 1000);
      ctx.fillText(`${xKm}K`, x + 4, bottom - 5);
      if (i > 0) ctx.fillText(`${yKm}K`, left + 4, y - 4);
    }
  }
  ctx.restore();
}

function drawLayerGrid() {
  const grid = state.map?.layers?.[state.layer];
  if (!grid?.length) return;
  const rows = grid.length;
  const cols = grid[0].length;
  const map = state.map || sceneConfig();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = Number(grid[row][col]) || 0;
      if (state.layer === 'coverage') {
        ctx.fillStyle = `rgba(83, 111, 132, ${.018 + value * .12})`;
      } else if (state.layer === 'priority') {
        ctx.fillStyle = value > .72
          ? `rgba(154, 67, 63, ${.025 + value * .2})`
          : `rgba(142, 111, 62, ${.02 + value * .13})`;
      } else {
        ctx.fillStyle = value < .08
          ? 'rgba(143, 65, 62, .15)'
          : value > .75 ? 'rgba(79, 111, 86, .11)' : 'rgba(104, 116, 108, .055)';
      }
      const [left, bottom] = mapPoint([col / cols * map.width, row / rows * map.height]);
      const [right, top] = mapPoint([(col + 1) / cols * map.width, (row + 1) / rows * map.height]);
      ctx.fillRect(left, top, right - left + .6, bottom - top + .6);
    }
  }
}

function drawTerrain(w, h) {
  const map = state.map || sceneConfig();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  (state.map?.obstacles || []).forEach((obstacle, index) => {
    const [x, y] = mapPoint(obstacle.center);
    const radiusX = obstacle.radius / map.width * (w - 24) * state.mapView.zoom;
    const radiusY = obstacle.radius / map.height * (h - 24) * state.mapView.zoom;
    ctx.fillStyle = 'rgba(51, 59, 58, .82)';
    ctx.strokeStyle = 'rgba(91, 102, 98, .72)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(151, 160, 156, .62)';
    ctx.font = mapLabelFont;
    ctx.fillText(index % 2 ? '河谷' : '林区', x, y);
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
    ctx.strokeStyle = 'rgba(145, 116, 71, .68)';
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
  ctx.fillStyle = '#c76a65';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('边境线 / 12 km', w - 17, h - 6);
  ctx.restore();
}

function drawRoutes() {
  if (!state.overlays.routes) return;
  state.platforms.forEach((platform) => {
    if (!platform.target) return;
    const [x1, y1] = mapPoint(platform.position);
    const [x2, y2] = mapPoint(platform.target);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = platform.type === 'uav' ? 'rgba(113, 146, 183, .78)' : 'rgba(113, 154, 125, .78)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

function drawCues() {
  if (!state.overlays.cues) return;
  const map = state.map || sceneConfig();
  (state.map?.cues || []).forEach((cue) => {
    const [x, y] = mapPoint(cue.position);
    const radiusX = Math.max(24, cue.radius / map.width * (canvas.clientWidth - 24) * state.mapView.zoom);
    const radiusY = Math.max(24, cue.radius / map.height * (canvas.clientHeight - 24) * state.mapView.zoom);
    ctx.fillStyle = 'rgba(161, 125, 65, .1)';
    ctx.beginPath();
    ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(195, 154, 81, .6)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(18, radiusX * .45), Math.max(18, radiusY * .45), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#c39a51';
    ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.font = mapLabelFont;
    ctx.fillText(`线索 #${cue.id} / 置信度 ${Number(cue.confidence).toFixed(2)}`, x - 53, y - radiusY - 7);
  });
}

function drawFacilityMapGlyph(color) {
  ctx.fillStyle = 'rgba(195, 154, 81, .13)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, -7.5); ctx.lineTo(7.6, 6.5); ctx.lineTo(-7.6, 6.5); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.lineWidth = 1.7;
  ctx.beginPath(); ctx.moveTo(0, -2.8); ctx.lineTo(0, 2.2); ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(-.9, 4, 1.8, 1.8);
}

function drawVehicleMapGlyph(color) {
  ctx.fillStyle = '#111719';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.moveTo(-8, 3.5); ctx.lineTo(-8, -1.8); ctx.lineTo(-4.2, -5); ctx.lineTo(4.5, -5); ctx.lineTo(8, -1.2); ctx.lineTo(8, 3.5); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-3.5, -4.2); ctx.lineTo(-1.7, -1.1); ctx.lineTo(4.7, -1.1); ctx.lineTo(2.8, -4.2); ctx.closePath(); ctx.stroke();
  [-4.8, 4.8].forEach((wheelX) => {
    ctx.beginPath(); ctx.arc(wheelX, 4, 1.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-9.3, 0); ctx.moveTo(8, 0); ctx.lineTo(9.3, 0); ctx.stroke();
}

function drawPersonMapGlyph(color) {
  ctx.fillStyle = '#111719';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.35;
  ctx.lineCap = 'square';
  ctx.beginPath(); ctx.arc(0, -5.3, 2.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -3); ctx.lineTo(0, 3);
  ctx.moveTo(-4.2, -.7); ctx.lineTo(0, -2); ctx.lineTo(4.2, -.7);
  ctx.moveTo(0, 3); ctx.lineTo(-3.2, 7);
  ctx.moveTo(0, 3); ctx.lineTo(3.2, 7);
  ctx.stroke();
}

function drawGenericTargetMapGlyph(color) {
  ctx.fillStyle = 'rgba(198, 93, 89, .13)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(0, -5); ctx.moveTo(0, 5); ctx.lineTo(0, 9); ctx.moveTo(-9, 0); ctx.lineTo(-5, 0); ctx.moveTo(5, 0); ctx.lineTo(9, 0); ctx.stroke();
}

function drawTargetMapGlyph(target, color) {
  if (target.type === 'facility') drawFacilityMapGlyph(color);
  else if (target.type === 'vehicle') drawVehicleMapGlyph(color);
  else if (['victim', 'person', 'intruder', 'suspect'].includes(target.type)) drawPersonMapGlyph(color);
  else drawGenericTargetMapGlyph(color);
}

function drawTargets() {
  if (!state.overlays.targets) return;
  state.targets.forEach((target) => {
    if (target.discovered === false) return;
    const [anchorX, anchorY] = mapPoint(target.position);
    const x = Math.max(24, Math.min(canvas.clientWidth - 24, anchorX));
    const y = Math.max(24, Math.min(canvas.clientHeight - 24, anchorY));
    const color = target.type === 'facility' ? '#c39a51' : '#c65d59';
    if (target.track?.length > 1) {
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
    drawTargetMapGlyph(target, color);
    ctx.restore();
    if (state.selected.type === 'target' && state.selected.id === target.id) drawPlatformSelection(x, y);
    ctx.fillStyle = color;
    ctx.font = mapLabelFont;
    ctx.fillText(target.label, x + 13, y - 7);
    ctx.fillStyle = '#838e92';
    ctx.font = mapDataFont;
    ctx.fillText(`${target.state || '跟踪中'} / ${target.velocity?.[0] || 0}, ${target.velocity?.[1] || 0} m/s`, x + 13, y + 6);
  });
}

function drawUavMapGlyph(color) {
  const arms = [[-3.4, -3.4, 3.4, 3.4], [-3.4, 3.4, 3.4, -3.4]];
  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = '#0a0f11';
  ctx.lineWidth = 2.8;
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
    ctx.fillStyle = '#111719';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(rotorX, rotorY, 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
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
  ctx.stroke();
  ctx.restore();
}

function drawUgvMapGlyph(color) {
  ctx.save();
  ctx.scale(.78, .78);
  ctx.fillStyle = '#0b1112';
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
  ctx.stroke();
  ctx.fillStyle = '#0b1112';
  ctx.strokeStyle = '#b1c0b6';
  ctx.lineWidth = .7;
  ctx.beginPath();
  ctx.moveTo(-3.1, -3.35); ctx.lineTo(-1.9, -1.0); ctx.lineTo(1.4, -1.0); ctx.lineTo(2.4, -3.35);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(-5.9, 1.15, 11.3, 3.8, 1.8);
  ctx.stroke();
  ctx.fillStyle = '#0b1112';
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

function drawPlatformSelection(x, y) {
  const radius = 8.5;
  const arm = 3;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(224, 229, 227, .82)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-radius + arm, -radius); ctx.lineTo(-radius, -radius); ctx.lineTo(-radius, -radius + arm);
  ctx.moveTo(radius - arm, -radius); ctx.lineTo(radius, -radius); ctx.lineTo(radius, -radius + arm);
  ctx.moveTo(-radius, radius - arm); ctx.lineTo(-radius, radius); ctx.lineTo(-radius + arm, radius);
  ctx.moveTo(radius, radius - arm); ctx.lineTo(radius, radius); ctx.lineTo(radius - arm, radius);
  ctx.stroke();
  ctx.restore();
}

function drawPlatforms() {
  state.platforms.forEach((platform) => {
    const [x, y] = mapPoint(platform.position);
    const selected = state.selected.type === 'platform' && state.selected.id === platform.id;
    const color = platform.type === 'uav' ? '#7192b7' : '#719a7d';
    ctx.save();
    ctx.globalAlpha = platform.online === false ? .48 : 1;
    ctx.translate(x, y);
    ctx.rotate(-(Number(platform.heading) || 0) * Math.PI / 180 + (platform.type === 'ugv' ? Math.PI : 0));
    if (platform.type === 'uav') drawUavMapGlyph(color);
    else drawUgvMapGlyph(color);
    ctx.restore();
    if (selected) drawPlatformSelection(x, y);

    ctx.fillStyle = selected ? '#e0e5e3' : color;
    ctx.font = mapUnitFont;
    ctx.fillText(platform.label, x + 8, y - 2);
    if (selected || state.mapView.zoom >= 1.5) {
      const taskText = platform.task && platform.task !== '待命'
        ? `${taskTypeLabel(String(platform.task).split(' #')[0])} ${String(platform.task).match(/#\d+/)?.[0] || ''}`
        : '待命';
      ctx.fillStyle = '#7f898d';
      ctx.font = mapUnitDataFont;
      ctx.fillText(`${taskText} / ${Number(platform.battery || 0).toFixed(0)}%`, x + 8, y + 7);
    }
  });
}

function drawMap() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111719';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(12, 12, w - 24, h - 24);
  ctx.clip();
  drawGrid(w, h);
  drawLayerGrid();
  drawTerrain(w, h);
  drawRoads();
  drawBoundary(w);
  drawRoutes();
  drawCues();
  drawTargets();
  drawPlatforms();
  const map = state.map || sceneConfig();
  const [left, bottom] = mapPoint([0, 0]);
  const [right, top] = mapPoint([map.width, map.height]);
  ctx.strokeStyle = '#505b5f';
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.restore();
  drawBoundaryLabel(w, h);
}

function renderAlerts() { const list = $('alertList'); if (!list) return; list.innerHTML = state.alerts.map((alert) => `<button class="alert-card ${esc(alert.level)} ${state.selected.type === 'target' && state.selected.id === alert.targetId ? 'selected' : ''}" data-alert-id="${esc(alert.id)}"><h3>${esc(severityLabel(alert.title))}</h3><p>${esc(alert.detail)}</p><small>${esc(alert.meta)}</small></button>`).join(''); document.querySelectorAll('[data-alert-id]').forEach((button) => button.addEventListener('click', () => { const alert = state.alerts.find((item) => String(item.id) === button.dataset.alertId); if (!alert) return; state.selected = alert.targetId != null ? { type: 'target', id: Number(alert.targetId) } : { type: 'alert', id: alert.id }; renderSelectionOnly(); toast('已定位到告警区域'); })); $('alertActiveLabel').textContent = `${state.alerts.length} 条告警`; }
function renderTasks() { const list = $('taskList'); if (!list) return; const ordered = [...state.tasks].sort((a, b) => (['ACTIVE', 'PENDING'].includes(a.status) ? 0 : 1) - (['ACTIVE', 'PENDING'].includes(b.status) ? 0 : 1) || Number(a.priority) - Number(b.priority)); list.innerHTML = ordered.map((task) => `<button class="task-row ${state.selected.type === 'task' && state.selected.id === task.id ? 'selected' : ''}" data-task-id="${task.id}"><span class="task-priority">${String(task.priority).padStart(2, '0')}</span><span class="task-name">${esc(taskTypeLabel(task.type))} #${task.id} <small>${esc(statusLabel(task.status))}</small></span><span class="task-platform">${esc(task.platform || '待分配')}</span></button>`).join(''); document.querySelectorAll('[data-task-id]').forEach((button) => button.addEventListener('click', () => { state.selected = { type: 'task', id: Number(button.dataset.taskId) }; renderSelectionOnly(); })); }
function renderTimeline() {
  const timeline = $('timeline');
  if (!timeline) return;
  const rangeSeconds = timelineRanges[state.timelineRange] ?? null;
  const now = Number(state.elapsed) || 0;
  const orderedEvents = state.events
    .filter((event) => rangeSeconds === null || Number(event.time) >= now - rangeSeconds)
    .slice()
    .reverse();
  const occurrences = new Map();
  const events = orderedEvents.map((event) => {
    const signature = String(event.id ?? `${Number(event.time) || 0}|${event.kind || ''}|${event.text || ''}`);
    const occurrence = occurrences.get(signature) || 0;
    occurrences.set(signature, occurrence + 1);
    return { event, key: `${signature}|${occurrence}` };
  });
  if (!events.some(({ key }) => key === state.timelineSelection)) state.timelineSelection = events[0]?.key ?? null;
  timeline.innerHTML = events.map(({ event, key }) => {
    const selected = key === state.timelineSelection;
    return `<button type="button" class="timeline-event ${selected ? 'selected' : ''}" data-timeline-event="${esc(key)}" aria-pressed="${selected}" title="${esc(`${secondsLabel(event.time)} ${event.text}`)}"><time class="timeline-time">${secondsLabel(event.time)}</time><span class="timeline-dot" aria-hidden="true"></span><span class="timeline-label">${esc(event.text)}</span></button>`;
  }).join('');
  const selectedEvent = events.find(({ key }) => key === state.timelineSelection)?.event;
  const detail = $('timelineDetail');
  if (detail) detail.innerHTML = selectedEvent
    ? `<time>${secondsLabel(selectedEvent.time)}</time><span>${esc(selectedEvent.text)}</span>`
    : '<span class="muted-text">当前范围内暂无决策事件</span>';
  const rangeLabel = { full: '全程', hour: '1 小时内', ten: '10 分钟内' }[state.timelineRange] || '10 分钟内';
  const label = $('timelineRangeLabel');
  if (label) label.textContent = `${rangeLabel} · ${events.length} 条事件`;
  document.querySelectorAll('[data-timeline-range]').forEach((button) => button.classList.toggle('active', button.dataset.timelineRange === state.timelineRange));
}
function renderProcess() { const flow = state.flow || {}; const phases = flow.phases || []; $('processStatus').textContent = state.connected ? '仿真服务在线' : '本地演示'; $('tickValue').textContent = String(state.tick || 0).padStart(4, '0'); $('dtValue').textContent = `${Number(state.dt || 1).toFixed(1)} 秒`; $('phaseValue').textContent = flow.phase_label || '等待'; $('processSteps').innerHTML = phases.map((step) => `<div class="process-step ${esc(step.status)}"><span class="step-mark">${step.status === 'done' ? '✓' : step.status === 'active' ? '›' : '·'}</span><span>${esc(step.label)}</span><span class="step-detail">${esc(step.detail)}</span></div>`).join(''); $('processLog').innerHTML = state.events.slice(0, 4).map((event) => `<div class="process-log-row"><time>${secondsLabel(event.time)}</time><span>${esc(event.text)}</span></div>`).join(''); }
function renderUnitSelector() {
  const selector = $('unitSelector');
  if (!selector) return;
  const previousScroll = selector.scrollLeft;
  const platforms = [...state.platforms].sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.label).localeCompare(String(b.label), 'zh-CN', { numeric: true }));
  $('unitCount').textContent = `${platforms.length} 个平台`;
  if (!platforms.length) {
    selector.innerHTML = '<div class="unit-selector-empty">运行或快进后显示可用单位</div>';
    updateUnitNavigation();
    return;
  }
  selector.innerHTML = platforms.map((platform) => {
    const selected = state.selected.type === 'platform' && state.selected.id === platform.id;
    const isUav = platform.type === 'uav';
    const battery = Math.max(0, Math.min(100, Number(platform.battery) || 0));
    const rawTask = String(platform.task || '待命');
    const taskNumber = rawTask.match(/#\d+/)?.[0] || '';
    const task = rawTask === '待命' ? '待命' : `${taskTypeLabel(rawTask.split(' #')[0])} ${taskNumber}`.trim();
    return `<button class="unit-tile ${isUav ? 'uav' : 'ugv'} ${selected ? 'selected' : ''} ${platform.online === false ? 'offline' : ''}" data-platform-select="${esc(platform.id)}" aria-pressed="${selected}" title="查看 ${esc(platform.label)} 详情"><span class="unit-symbol" aria-hidden="true">${platformGlyphSvg(platform.type)}</span><span class="unit-identity"><strong>${esc(platform.label)}</strong><small>${isUav ? '多旋翼无人机' : '无人车'}</small></span><i class="unit-online" title="${platform.online === false ? '离线' : '在线'}"></i><span class="unit-task" title="${esc(task)}">${esc(task)}</span><span class="unit-energy"><span class="unit-battery-icon" title="电量" aria-hidden="true">${batteryGlyphSvg()}</span><span class="unit-energy-bar"><i style="width:${battery}%"></i></span><em class="${battery < 30 ? 'amber-text' : ''}">${battery.toFixed(0)}%</em></span></button>`;
  }).join('');
  selector.scrollLeft = previousScroll;
  window.requestAnimationFrame(updateUnitNavigation);
}

function selectPlatformById(platformId) {
  const platform = state.platforms.find((item) => String(item.id) === String(platformId));
  if (!platform) return;
  state.selected = { type: 'platform', id: platform.id };
  document.querySelectorAll('[data-platform-select]').forEach((item) => {
    const selected = item.dataset.platformSelect === String(platform.id);
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
  renderInspector();
  drawMap();
  toast(`已选择 ${platform.label}`);
}
function updateUnitNavigation() {
  const selector = $('unitSelector');
  if (!selector || !$('unitPrev') || !$('unitNext')) return;
  const hasOverflow = selector.scrollWidth > selector.clientWidth + 2;
  $('unitPrev').disabled = !hasOverflow || selector.scrollLeft <= 1;
  $('unitNext').disabled = !hasOverflow || selector.scrollLeft + selector.clientWidth >= selector.scrollWidth - 1;
}
function scrollUnitSelector(direction) {
  const selector = $('unitSelector');
  if (!selector) return;
  const amount = Math.max(220, selector.clientWidth * .72);
  const maxScroll = Math.max(0, selector.scrollWidth - selector.clientWidth);
  const target = Math.max(0, Math.min(maxScroll, selector.scrollLeft + direction * amount));
  selector.scrollTo({ left: target, behavior: 'auto' });
  updateUnitNavigation();
}
function renderEvaluation() {
  const evaluation = state.evaluation || {};
  const score = Number(evaluation.score);
  $('evaluationScore').textContent = Number.isFinite(score) ? `得分 ${score.toFixed(1)}` : '得分 --';
  const goal = $('evaluationGoal');
  goal.textContent = evaluation.headline || '等待评价数据';
  goal.className = `evaluation-goal ${evaluation.goal_met ? 'met' : ''}`;
  const metrics = evaluation.metrics || [];
  $('evaluationMetrics').innerHTML = metrics.map((metric) => {
    const value = Number(metric.value) || 0;
    const target = Number(metric.target);
    const isPercent = metric.unit === '%';
    const barValue = isPercent
      ? Math.max(0, Math.min(100, value))
      : metric.lower_is_better
        ? Math.min(100, Math.max(0, value) * 20)
        : (Number.isFinite(target) && target > 0 ? Math.min(100, value / target * 100) : 0);
    const tone = metric.tone || 'cyan';
    return `<div class="evaluation-row"><div class="evaluation-row-head"><span>${esc(metric.label)}</span><strong class="${esc(tone)}-text">${esc(metric.display || `${value}${metric.unit || ''}`)}</strong></div><div class="evaluation-bar"><span class="${esc(tone)}" style="width:${barValue}%"></span></div><small>${esc(metric.detail || '')}${Number.isFinite(target) ? ` · 目标 ${metric.lower_is_better ? '≤' : '≥'} ${target}${metric.unit || ''}` : ''}</small></div>`;
  }).join('');
}
function renderSummary() { const config = sceneConfig(); const metrics = state.metrics || {}; const evaluation = state.evaluation || {}; const items = evaluation.metrics || []; $('coverageValue').textContent = `${Number(metrics.coverage || 0).toFixed(1)}%`; $('coverageBar').style.width = `${Math.min(100, Number(metrics.coverage || 0))}%`; $('coverageLabel').textContent = config.coverageLabel; const handled = items.find((item) => ['rescue_rate', 'intercept_rate', 'neutralize_rate'].includes(item.key)); $('handledLabel').textContent = config.handledLabel; $('handledValue').textContent = handled?.display || `${String(metrics.completed || 0).padStart(2, '0')} / ${String(metrics.total_tasks || 0).padStart(2, '0')}`; $('onlineCount').textContent = String(metrics.online_platforms ?? state.platforms.length).padStart(2, '0'); $('alertCount').textContent = String(metrics.alerts_high ?? 0).padStart(2, '0'); $('simClock').textContent = `${secondsLabel(state.elapsed)} / ${secondsLabel(state.duration)}`; $('mapStatus').textContent = state.layer === 'coverage' ? config.mapStatus : state.layer === 'priority' ? '图层：搜索优先级' : '图层：UGV 可通行性'; $('completionValue').textContent = `${Number(metrics.completion_rate || 0).toFixed(0)}%`; $('utilizationValue').textContent = `${Number(metrics.platform_utilization || 0).toFixed(0)}%`; $('responseValue').textContent = `${Number(metrics.average_battery || 0).toFixed(0)}%`; $('replanValue').textContent = String(state.events.filter((event) => event.kind === 'decision').length).padStart(2, '0'); }
function renderInspector() { let content = ''; if (state.selected.type === 'platform') { const platform = state.platforms.find((item) => item.id === state.selected.id); content = platform ? platformInspector(platform) : ''; } else if (state.selected.type === 'target') { const target = state.targets.find((item) => item.id === state.selected.id); content = target ? targetInspector(target) : ''; } else if (state.selected.type === 'task') { const task = state.tasks.find((item) => item.id === state.selected.id); content = task ? taskInspector(task) : ''; } else content = '<div class="inspector-empty">选择平台、目标或任务查看详情</div>'; $('inspectorContent').innerHTML = content || '<div class="inspector-empty">对象已离线或不可用</div>'; document.querySelectorAll('[data-action="cancel"]').forEach((button) => button.addEventListener('click', cancelSelectedTask)); document.querySelectorAll('[data-action="reprioritize"]').forEach((button) => button.addEventListener('click', reprioritizeSelectedTask)); }
function renderSelectionOnly() { renderAlerts(); renderTasks(); renderInspector(); drawMap(); }
function renderAll() { renderConnection(); renderRunState(); renderAlerts(); renderTasks(); renderTimeline(); renderProcess(); renderInspector(); renderEvaluation(); renderSummary(); renderUnitSelector(); drawMap(); }
function selectedTaskId() { if (state.selected.type === 'task') return state.selected.id; if (state.selected.type === 'platform') return state.platforms.find((platform) => platform.id === state.selected.id)?.taskId; if (state.selected.type === 'target') return state.targets.find((target) => target.id === state.selected.id)?.taskId; return null; }
async function cancelSelectedTask() { const taskId = selectedTaskId(); if (taskId == null) return toast('当前对象没有可取消的任务'); if (state.connected) { await backendPost(`/api/tasks/cancel/${taskId}`); return; } const task = state.tasks.find((item) => item.id === taskId); if (!task) return toast('任务不存在'); task.status = 'CANCELLED'; task.platform = '待释放'; task.platform_ids = []; state.metrics.active = Math.max(0, state.metrics.active - 1); pushEvent(`任务 #${taskId} 取消`, 'red', 'task'); renderAll(); toast(`已取消任务 #${taskId}`); }
async function reprioritizeSelectedTask() { const taskId = selectedTaskId(); const task = state.tasks.find((item) => item.id === taskId); if (!task) return toast('当前对象没有可调整的任务'); const priority = Math.max(1, Number(task.priority) - 10); if (state.connected) { await backendPost(`/api/tasks/reprioritize/${taskId}`, { priority }); return; } task.priority = priority; pushEvent(`任务 #${taskId} 提级至 ${priority}`, 'amber', 'decision'); renderAll(); toast(`任务 #${taskId} 已提升为优先级 ${priority}`); }
async function submitTask(form) { const data = new FormData(form); const taskType = data.get('taskType'); const selectedTarget = state.selected.type === 'target' ? state.selected.id : state.targets[0]?.id; const payload = { task_type: taskType, priority: Number(data.get('priority')), target_pos: String(data.get('targetPos')), target_entity_id: ['RescueTask', 'InterceptTask', 'MedicalDeliveryTask'].includes(taskType) ? selectedTarget : undefined, target_entity_type: state.scene === 'rescue' ? 'victim' : state.scene === 'area' ? 'aerial' : 'person', required_count: 1, required_platforms: Number(data.get('platforms')), required_capabilities: String(data.get('capability')), radius: 50, hold_time: 60 }; if (state.connected) { await backendPost('/api/tasks/inject', payload); $('taskDialog').close(); return; } const task = { id: Math.max(-1, ...state.tasks.map((item) => Number(item.id))) + 1, type: taskType, priority: payload.priority, status: 'PENDING', platform: '待分配', platform_ids: [], target: `坐标 (${payload.target_pos})`, target_pos: payload.target_pos.split(',').map(Number), capabilities: [String(payload.required_capabilities)] }; state.tasks.unshift(task); state.metrics.total_tasks += 1; state.metrics.active += 1; pushEvent(`人工注入 ${taskTypeLabel(task.type)} #${task.id}`, 'cyan', 'task'); state.selected = { type: 'task', id: task.id }; renderAll(); $('taskDialog').close(); toast(`已注入 ${taskTypeLabel(task.type)} #${task.id}`); }
function handleCommand() { const input = $('commandInput'); const command = input.value.trim(); if (!command) return; input.value = ''; const normalized = command.toLowerCase(); if (normalized.includes('东南') || normalized.includes('arrive') || normalized.includes('派')) { $('taskDialog').showModal(); toast('自然语言指令已解析，请确认任务参数'); } else if (normalized.includes('取消')) cancelSelectedTask(); else if (normalized.includes('优先') || normalized.includes('提级')) reprioritizeSelectedTask(); else toast(state.connected ? '指令已接收，等待任务解析' : '演示模式：已接收指令'); }
function handleMapClick(event) {
  if (state.mapView.suppressClick) { state.mapView.suppressClick = false; return; }
  const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top; let nearest = null; let distance = 25;
  state.platforms.forEach((platform) => { const point = mapPoint(platform.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'platform', id: platform.id }; distance = d; } });
  state.targets.forEach((target) => { const point = mapPoint(target.position); const d = Math.hypot(point[0] - x, point[1] - y); if (d < distance) { nearest = { type: 'target', id: target.id }; distance = d; } });
  if (nearest) { state.selected = nearest; renderSelectionOnly(); }
}
function beginMapPan(event) {
  if (event.button !== 0 || state.mapView.zoom <= 1) return;
  event.preventDefault();
  Object.assign(state.mapView, { dragging: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startCenterX: state.mapView.centerX, startCenterY: state.mapView.centerY, moved: false });
  canvas.setPointerCapture(event.pointerId);
  updateMapViewUi();
}
function moveMapPan(event) {
  if (!state.mapView.dragging || event.pointerId !== state.mapView.pointerId) return;
  const dx = event.clientX - state.mapView.startX; const dy = event.clientY - state.mapView.startY;
  if (Math.hypot(dx, dy) > 3) state.mapView.moved = true;
  state.mapView.centerX = state.mapView.startCenterX - dx / ((canvas.clientWidth - 24) * state.mapView.zoom);
  state.mapView.centerY = state.mapView.startCenterY + dy / ((canvas.clientHeight - 24) * state.mapView.zoom);
  clampMapCenter(); drawMap();
}
function endMapPan(event) {
  if (!state.mapView.dragging || event.pointerId !== state.mapView.pointerId) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  state.mapView.suppressClick = state.mapView.moved;
  state.mapView.dragging = false; state.mapView.pointerId = null; updateMapViewUi();
}
function setupEnhancedEvents() {
  window.addEventListener('resize', resizeCanvas);
  $('scenarioSelect').value = state.scene;
  $('scenarioSelect').addEventListener('change', async (event) => {
    const scene = event.target.value;
    if (state.connected) await backendPost('/api/session/switch', { scene });
    else { switchLocalScenario(scene); renderAll(); }
    resetMapView();
    toast(`已切换至${enhancedSceneConfigs[scene].name}，原场景进度已保留`);
  });
  $('runToggle').addEventListener('click', async () => { if (state.connected) { await backendPost(state.running ? '/api/session/pause' : '/api/session/run'); } else { state.running = !state.running; renderAll(); } });
  $('speedToggle').addEventListener('click', async () => { const next = speeds[(Math.max(0, state.speedIndex) + 1) % speeds.length]; state.speed = next; state.speedIndex = speeds.indexOf(next); renderRunState(); if (state.connected) await backendPost('/api/session/speed', { speed: next }); else { renderAll(); toast(`仿真速度 × ${next.toFixed(1)}`); } });
  $('stepButton').addEventListener('click', async () => { if (state.connected) await backendPost('/api/session/step'); else localAdvance(1); });
  $('resetButton').addEventListener('click', () => { $('resetSceneName').textContent = `“${sceneConfig().name}”`; $('resetDialog').showModal(); });
  $('resetForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'default') return;
    event.preventDefault();
    const scene = state.scene; const confirmButton = $('resetConfirm'); confirmButton.disabled = true;
    const succeeded = state.connected ? await backendPost('/api/session/reset', { scene }) : (localScenarioStates.delete(scene), resetLocalScenario(scene), renderAll(), true);
    confirmButton.disabled = false;
    if (succeeded) { resetMapView(); $('resetDialog').close(); toast(`${enhancedSceneConfigs[scene].name}已结束并重置`); }
  });
  $('zoomOut').addEventListener('click', () => setMapZoom(-1));
  $('zoomIn').addEventListener('click', () => setMapZoom(1));
  $('fitMap').addEventListener('click', () => { resetMapView(); toast('已回到全域视图'); });
  $('unitPrev').addEventListener('click', () => scrollUnitSelector(-1));
  $('unitNext').addEventListener('click', () => scrollUnitSelector(1));
  $('unitSelector').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const button = event.target.closest('[data-platform-select]');
    if (button) selectPlatformById(button.dataset.platformSelect);
  });
  $('unitSelector').addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const button = event.target.closest('[data-platform-select]');
    if (button) selectPlatformById(button.dataset.platformSelect);
  });
  document.querySelectorAll('[data-timeline-range]').forEach((button) => button.addEventListener('click', () => {
    state.timelineRange = button.dataset.timelineRange || 'ten';
    renderTimeline();
  }));
  $('timeline').addEventListener('click', (event) => {
    const button = event.target.closest('[data-timeline-event]');
    if (!button) return;
    state.timelineSelection = button.dataset.timelineEvent;
    renderTimeline();
  });
  $('unitSelector').addEventListener('scroll', updateUnitNavigation, { passive: true });
  window.addEventListener('resize', updateUnitNavigation);
  document.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.segment').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.layer = button.dataset.layer; renderAll(); }));
  document.querySelectorAll('.overlay-chip').forEach((button) => button.addEventListener('click', () => { const key = button.dataset.overlay; state.overlays[key] = !state.overlays[key]; button.classList.toggle('active', state.overlays[key]); drawMap(); }));
  $('openTaskModal').addEventListener('click', () => $('taskDialog').showModal());
  $('taskForm').addEventListener('submit', (event) => { event.preventDefault(); submitTask(event.target); });
  $('clearSelection').addEventListener('click', () => { state.selected = { type: 'none', id: null }; renderAll(); });
  $('commandSend').addEventListener('click', handleCommand);
  $('commandInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCommand(); });
  $('settingsButton').addEventListener('click', () => toast(state.connected ? '仿真会话配置已由后端管理' : '启动 web_api.py 后可配置仿真会话'));
  canvas.addEventListener('click', handleMapClick); canvas.addEventListener('pointerdown', beginMapPan); canvas.addEventListener('pointermove', moveMapPan); canvas.addEventListener('pointerup', endMapPan); canvas.addEventListener('pointercancel', endMapPan);
  window.setInterval(() => { if (!state.connected && state.running) localAdvance(state.speed); }, 240);
  resetLocalScenario('rescue'); state.localInitialized = true; renderAll(); resizeCanvas(); updateMapViewUi();
  if (typeof ResizeObserver !== 'undefined') { mapResizeObserver = new ResizeObserver(resizeCanvas); mapResizeObserver.observe($('mapStage')); }
  connectBackend();
}

const applySnapshotBase = applyBackendSnapshot;
applyBackendSnapshot = (snapshot) => { applySnapshotBase(snapshot); if ($('scenarioSelect') && snapshot?.simulation?.scene) $('scenarioSelect').value = snapshot.simulation.scene; };
setupEnhancedEvents();
