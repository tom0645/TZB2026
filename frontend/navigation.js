/* 新导航的数据展示和测试操作。仿真计算全部由后端执行。 */
function navDataRow(label, value) {
  return `<div class="data-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
}
function navNumber(value, suffix = '', digits = 1) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : '暂无数据';
}
function navPointText(point) {
  return Array.isArray(point) ? `(${Number(point[0]).toFixed(0)}, ${Number(point[1]).toFixed(0)}) 米` : '未设置';
}
function navPlatformNames(ids) {
  return (ids || []).map((id) => state.platforms.find((p) => p.id === id)?.label || `平台 #${id}`).join('、');
}
function renderPlatformTags(value, emptyLabel = '待分配') {
  const labels = String(value || '').split(/[,，、]/).map((label) => label.trim()).filter((label) => label && label !== '待分配');
  return labels.length
    ? labels.map((label) => `<span class="task-unit-tag">${esc(label)}</span>`).join(' ')
    : `<span class="task-unassigned">${esc(emptyLabel)}</span>`;
}
function navPlatformRow(label, value, emptyLabel = '待分配') {
  return `<div class="data-row"><span>${esc(label)}</span><span class="platform-tags">${renderPlatformTags(value, emptyLabel)}</span></div>`;
}
function navFold(key, title, content) {
  return `<details class="inspector-fold" data-inspector-fold="${key}" ${state.inspectorFolds?.has(key) ? 'open' : ''}><summary>${esc(title)}</summary>${content}</details>`;
}
function decisionEvidence(record) {
  if (!record) return '<div class="decision-record"><p>暂无相关决策记录</p></div>';
  const candidates = record.candidate_platform_ids || [];
  const more = navPlatformRow('执行平台', navPlatformNames(record.selected_platform_ids), '尚未分配')
    + navDataRow('候选平台', candidates.length ? `${candidates.length} 个 · ${navPlatformNames(candidates)}` : '未提供候选记录')
    + navDataRow('算法代码', record.algorithm || '未提供')
    + (record.preempted_task_ids?.length ? navDataRow('调整任务', record.preempted_task_ids.map((id) => `#${id}`).join('、')) : '');
  return `<div class="decision-record"><time>${secondsLabel(record.time)} · ${esc(record.label || '决策记录')}</time><p>${esc(record.reason || '暂无详细依据')}</p>${navFold('decision-evidence', '查看分配依据', more)}</div>`;
}
function renderTaskActions(task) {
  if (exercisePlaybackActive() || !task || !['ACTIVE', 'PENDING'].includes(task.status)) return '';
  return '<div class="inspector-actions"><button type="button" class="btn btn-quiet" data-action="reprioritize">调整优先级</button><button type="button" class="btn btn-danger" data-action="cancel">取消任务</button></div>';
}
function renderPlatformInspector(platform) {
  const nav = platform.navigation || {};
  const attention = ['BLOCKED', 'UNREACHABLE', 'WAITING_FOR_DECISION', 'WAITING_FOR_CLEARANCE'].includes(nav.state);
  const task = state.tasks.find((item) => item.id === platform.taskId);
  const actions = state.sessionMode === 'navigation'
    ? '<div class="inspector-actions"><button class="btn btn-quiet" type="button" data-open-navigation>打开导航测试控制</button></div>'
    : renderTaskActions(task);
  const progress = Math.max(0, Math.min(100, Number(nav.progress || 0) * 100));
  const extra = navDataRow('规划用时', navNumber(nav.planning_time_ms, ' 毫秒'))
    + navDataRow('规划长度', navNumber(nav.planned_length_m, ' 米'))
    + navDataRow('路径版本', nav.path_version ?? '暂无数据')
    + navDataRow('目标刷新', navNumber(nav.goal_refresh_count, ' 次', 0))
    + navDataRow('障碍重规划', navNumber(nav.obstacle_replan_count, ' 次', 0))
    + navDataRow('避让介入', navNumber(nav.safety_intervention_count, ' 次', 0))
    + navDataRow('让行对象', nav.yield_to_platform_id == null ? '无' : navPlatformNames([nav.yield_to_platform_id]))
    + navDataRow('预测最小间距', navNumber(nav.predicted_min_separation_m, ' 米'))
    + navDataRow('预测冲突时间', navNumber(nav.predicted_time_to_conflict_s, ' 秒'))
    + navDataRow('规划算法', nav.planner || '尚未规划');
  return `<div class="object-card"><div class="object-head"><div class="object-icon ${platform.type === 'ugv' ? 'green-text' : ''}">${platformGlyphSvg(platform.type, 'inspector-glyph')}</div><div><h3>${esc(platform.label)} · ${platform.type === 'uav' ? '无人机' : '无人车'}</h3><p>${esc(taskTypeLabel(String(platform.task || '待命').split(' #')[0]))}</p></div><span class="object-status">${platform.online !== false ? '在线' : '离线'}</span></div></div>
    <div class="inspector-divider"></div><div class="data-table">${navDataRow('位置', navPointText(platform.position))}${state.mapMode === '3d' ? navDataRow('显示海拔', platform.type === 'uav' ? '10.0 米' : '0.0 米') : ''}${navDataRow('速度 / 航向', `${navNumber(platform.speed, ' 米/秒')} · ${navNumber(platform.heading, '°', 0)}`)}${navDataRow('导航目标', navPointText(platform.target))}${navDataRow('电量', navNumber(platform.battery, '%', 0))}</div>
    <h3 class="inspector-title">导航与通行</h3><div class="navigation-status"><span class="navigation-badge ${attention ? 'attention' : ''}">${esc(nav.state_label || '等待导航数据')}</span><span class="navigation-badge ${nav.safety_state && nav.safety_state !== 'CLEAR' ? 'attention' : ''}">${esc(nav.safety_label || '状态待更新')}</span></div>
    <div class="navigation-progress" aria-label="路径进度 ${progress.toFixed(0)}%"><i style="width:${progress}%"></i></div><div class="data-table">${navDataRow('剩余路程', navNumber(nav.remaining_distance_m, ' 米'))}${navDataRow('预计还需', navNumber(nav.remaining_time_s, ' 秒'))}${navDataRow('最近原因', nav.reason_label || '暂无记录')}</div>${navFold('navigation-metrics', '更多导航数据', extra)}
    <h3 class="inspector-title">能力与资源</h3>${(platform.capabilities || []).map((cap) => `<div class="capability"><span>${esc(capabilityLabel(cap.name))}</span><span>${esc(cap.state || '状态待更新')}</span></div>`).join('')}
    <h3 class="inspector-title">最近调度记录</h3>${decisionEvidence(platform.decision)}${actions}`;
}
function renderTargetInspector(target) {
  const task = target.taskId != null ? state.tasks.find((item) => item.id === target.taskId) : null;
  const behavior = state.viewOptions?.behavior_debug ? target.behavior : null;
  const behaviorHtml = behavior ? `<h3 class="inspector-title">目标行为 · 仿真测试</h3><div class="behavior-detail"><strong>${esc(behavior.state_label)}</strong><p>${esc(behavior.reason_label || behavior.transition_reason || '暂无变化原因')}</p>${navDataRow('状态开始', secondsLabel(behavior.state_entered_at))}${navDataRow('记忆对象', `${behavior.memory_count ?? 0} 个`)}${behavior.altitude_m != null ? navDataRow('高度', navNumber(behavior.altitude_m, ' 米')) : ''}</div>` : '';
  return `<div class="object-card"><div class="object-head"><div class="object-icon ${target.type === 'facility' ? 'amber-text' : 'red-text'}">${targetGlyphSvg(target.type, 'inspector-target-glyph')}</div><div><h3>${esc(target.label)}</h3><p>状态：${esc(target.state || '等待更新')}</p></div><span class="object-status">${target.tracking === false ? '等待更新' : '已发现'}</span></div></div><div class="inspector-divider"></div>
    <div class="data-table">${navDataRow('位置', navPointText(target.position))}${target.group_id ? navDataRow('所在分区', target.group_id) : ''}${navDataRow('速度', navNumber(Math.hypot(...(target.velocity || [0, 0])), ' 米/秒'))}${navDataRow('首次发现', secondsLabel(target.first_seen ?? target.timestamp))}${navDataRow('最近更新', secondsLabel(target.timestamp))}${navDataRow('距上次观测', navNumber(target.last_seen_age, ' 秒'))}</div>${behaviorHtml}
    <h3 class="inspector-title">关联任务</h3><div class="capability"><span>${task ? `${esc(taskTypeLabel(task.type))} #${task.id}` : '暂无关联任务'}</span><span>${task ? esc(statusLabel(task.status)) : '待处理'}</span></div>${task ? decisionEvidence(task.decision) : ''}${renderTaskActions(task)}`;
}
function renderTaskInspector(task) {
  return `<div class="object-card"><div class="object-head"><div class="object-icon amber-text">◆</div><div><h3>${esc(taskTypeLabel(task.type))} #${task.id}</h3><p>${esc(task.target || '全域')}</p></div><span class="object-status">${esc(statusLabel(task.status))}</span></div></div><div class="inspector-divider"></div><div class="data-table">${navDataRow('优先级', `${task.priority}（数字越小越高）`)}${navPlatformRow('执行平台', task.platform)}${navDataRow('所需能力', (task.capabilities || []).map(capabilityLabel).join('、') || '无')}${navDataRow('触发原因', task.trigger_reason || '暂无记录')}</div><h3 class="inspector-title">最近调度记录</h3>${decisionEvidence(task.decision)}${renderTaskActions(task)}`;
}

function drawNavigationPolyline(points, color, width = 1.5, dash = []) {
  if (!Array.isArray(points) || points.length < 2) return;
  ctx.beginPath();
  points.forEach((point, i) => { const [x, y] = mapPoint(point); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
}
const recentTrailCache = new WeakMap();
function recentPlatformTrack(platform) {
  const track = platform.track || [], inputTimes = platform.track_times;
  const now = Number(state.elapsed) || 0, windowSeconds = 60, cutoff = now - windowSeconds;
  const dt = Math.max(.001, Number(state.dt) || 1), cached = recentTrailCache.get(track);
  const positionKey = `${platform.position?.[0]},${platform.position?.[1]}`;
  if (cached && cached.now === now && cached.inputTimes === inputTimes && cached.positionKey === positionKey) return cached.result;
  let first = 0;
  const timestamped = Array.isArray(inputTimes) && inputTimes.length === track.length;
  if (timestamped) {
    let low = 0, high = inputTimes.length;
    while (low < high) { const middle = (low + high) >>> 1; if (inputTimes[middle] < cutoff) low = middle + 1; else high = middle; }
    first = low;
  } else first = Math.max(0, track.length - Math.ceil(windowSeconds / dt) - 1);
  const points = [], times = [];
  for (let index = first; index < track.length; index += 1) {
    const point = track[index], timestamp = timestamped ? Number(inputTimes[index]) : now - (track.length - 1 - index) * dt;
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || timestamp < cutoff || timestamp > now) continue;
    points.push(point); times.push(timestamp);
  }
  if (Array.isArray(platform.position) && (!points.length || Math.hypot(platform.position[0] - points.at(-1)[0], platform.position[1] - points.at(-1)[1]) > .1)) {
    points.push(platform.position); times.push(now);
  }
  const result = { points, times, windowSeconds };
  recentTrailCache.set(track, { now, inputTimes, positionKey, result });
  return result;
}
function drawRecentPlatformTrail(platform, color, width) {
  const { points, times } = recentPlatformTrack(platform);
  if (points.length < 2) return;
  const opacity = ctx.globalAlpha, now = Number(state.elapsed) || 0;
  const screen = points.map(mapPoint);
  ctx.save(); ctx.setLineDash([]); ctx.lineCap = 'round';
  // 同一年龄段合并绘制，保持渐隐而不为每个历史点增加一次描边。
  for (let bucket = 0; bucket < 6; bucket += 1) {
    ctx.beginPath(); let count = 0;
    for (let index = 1; index < screen.length; index += 1) {
      const freshness = Math.max(0, Math.min(.999, 1 - (now - (times[index - 1] + times[index]) / 2) / 60));
      if (Math.floor(freshness * 6) !== bucket) continue;
      ctx.moveTo(...screen[index - 1]); ctx.lineTo(...screen[index]); count += 1;
    }
    if (!count) continue;
    const alpha = (.08 + .92 * (bucket + .5) / 6) * opacity;
    ctx.globalAlpha = alpha * .75; ctx.strokeStyle = '#f3f8fb'; ctx.lineWidth = width + 1; ctx.stroke();
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  ctx.restore();
}
const platformLineColors = {
  uav: { route: '#427aa3', routeSelected: '#2c678f', track: '#7aa0bb', trackSelected: '#5686a6' },
  ugv: { route: '#5b8763', routeSelected: '#3f7048', track: '#91ac8b', trackSelected: '#6c9568' },
};
const routeDistanceCache = new Map();
function routeDistances(platform, nav, points) {
  const first = points[0], middle = points[Math.floor(points.length / 2)], last = points.at(-1);
  const key = [state.sessionId, platform.id, nav.path_version, points.length,
    first?.[0], first?.[1], middle?.[0], middle?.[1], last?.[0], last?.[1]].join(':');
  const cached = routeDistanceCache.get(platform.id);
  if (cached?.key === key) return cached.distances;
  const distances = new Float64Array(points.length);
  for (let i = 1; i < points.length; i += 1) {
    distances[i] = distances[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  routeDistanceCache.set(platform.id, { key, distances });
  if (routeDistanceCache.size > 128) routeDistanceCache.clear();
  return distances;
}
function remainingPlannedRoute(platform) {
  const nav = platform.navigation || {};
  const points = nav.smoothed_path;
  if (!platform.target || ['IDLE', 'ARRIVED', 'WAITING_FOR_DECISION'].includes(nav.state) || !Array.isArray(points) || points.length < 2) return [];
  const position = platform.position;
  // 无人机提供沿路径距离；无人车提供最近路径点。二者均用于定位当前路段，
  // 不使用整条路径的全局最近点，避免交叉或折返路线跳到尚未执行的路段。
  const index = nav.nearest_path_index ?? nav.path_index;
  let first = Number.isInteger(index) ? Math.max(0, Math.min(points.length - 2, index - 1)) : 0;
  let last = Number.isInteger(index) ? Math.min(points.length - 2, index + 1) : points.length - 2;
  if (nav.tracking_path_length_m > 0 && Number.isFinite(nav.path_progress_m)) {
    const distances = routeDistances(platform, nav, points);
    let low = 1, high = distances.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (distances[middle] > nav.path_progress_m + .001) high = middle;
      else low = middle + 1;
    }
    first = Math.max(0, Math.min(points.length - 2, low - 1));
    last = Math.min(points.length - 2, first + 1);
  }
  let segment = first;
  let nearestDistance = Infinity;
  for (let i = first; i <= last; i += 1) {
    const [x, y] = points[i];
    const dx = points[i + 1][0] - x, dy = points[i + 1][1] - y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((position[0] - x) * dx + (position[1] - y) * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(position[0] - x - ratio * dx, position[1] - y - ratio * dy);
    if (distance < nearestDistance - .001) { nearestDistance = distance; segment = i; }
  }
  // 从实际位置连接下一个路径点；历史节点只从显示副本中移除。
  const remaining = [position, ...points.slice(segment + 1)];
  return remaining.filter((point, i) => i === 0 || Math.hypot(point[0] - remaining[i - 1][0], point[1] - remaining[i - 1][1]) > .1);
}
function drawPlannedRoute(points, selected, platformType) {
  if (!Array.isArray(points) || points.length < 2) return;
  const palette = platformLineColors[platformType] || platformLineColors.uav;
  const color = selected ? palette.routeSelected : palette.route;
  const width = selected ? 1.9 : 1.4;
  // 方向箭头随缩放保持屏幕尺寸。
  const screen = points.map(mapPoint);
  const totalLength = screen.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - screen[i][0], point[1] - screen[i][1]), 0);
  let nextArrow = Math.min(10, totalLength / 2);
  let travelled = 0;
  for (let i = 1; i < screen.length; i += 1) {
    const [x0, y0] = screen[i - 1];
    const dx = screen[i][0] - x0, dy = screen[i][1] - y0;
    const length = Math.hypot(dx, dy);
    if (length < .01) continue;
    while (nextArrow <= travelled + length) {
      const distance = nextArrow - travelled;
      const x = x0 + dx / length * distance, y = y0 + dy / length * distance;
      if (x >= 16 && y >= 16 && x <= canvas.clientWidth - 16 && y <= canvas.clientHeight - 16) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(dy, dx));
        ctx.beginPath();
        for (const offset of [-4, 3]) { ctx.moveTo(offset - 3, -3.5); ctx.lineTo(offset + 1, 0); ctx.lineTo(offset - 3, 3.5); }
        ctx.strokeStyle = '#23333b'; ctx.lineWidth = width + 2; ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.restore();
      }
      nextArrow += 20;
    }
    travelled += length;
  }
}
let waypointMarker;
function navigationPointMarker() {
  if (waypointMarker) return waypointMarker;
  const width = 26, height = 32, tipOffset = 4;
  const image = document.createElement('canvas');
  image.width = width * 2;
  image.height = height * 2;
  const pen = image.getContext('2d');
  pen.scale(2, 2);
  const x = width / 2, y = height - tipOffset;
  pen.beginPath();
  pen.ellipse(x, y, 10, 2.8, 0, 0, Math.PI * 2);
  pen.strokeStyle = '#18242c'; pen.lineWidth = 2.3; pen.stroke();
  pen.strokeStyle = '#f1bd72'; pen.lineWidth = 1.25; pen.stroke();
  pen.beginPath();
  pen.moveTo(x, y);
  pen.bezierCurveTo(11, 23, 4.5, 15, 4.5, 10.5);
  pen.bezierCurveTo(4.5, 5.8, 8.3, 2, 13, 2);
  pen.bezierCurveTo(17.7, 2, 21.5, 5.8, 21.5, 10.5);
  pen.bezierCurveTo(21.5, 15, 15, 23, x, y);
  pen.closePath();
  pen.fillStyle = '#f1bd72'; pen.fill();
  pen.strokeStyle = '#18242c'; pen.lineWidth = 1.5; pen.lineJoin = 'round'; pen.stroke();
  pen.beginPath(); pen.arc(x, 10.5, 3.1, 0, Math.PI * 2);
  pen.fillStyle = '#18242c'; pen.fill();
  waypointMarker = { image, width, height, tipOffset };
  return waypointMarker;
}

function drawNavigationRoutes(taskWaypoint) {
  ctx.save();
  const selectedId = state.selected.type === 'platform' ? state.selected.id : null;
  // 选中单位最后绘制，交叉处仍能看清它的轨迹。
  const platforms = [...state.platforms].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
  platforms.forEach((platform) => {
    const nav = platform.navigation || {};
    const selected = platform.id === selectedId;
    const palette = platformLineColors[platform.type] || platformLineColors.uav;
    ctx.globalAlpha = selected || selectedId === null ? 1 : .72;
    if (state.overlays.platformTracks) {
      drawRecentPlatformTrail(platform, selected ? palette.trackSelected : palette.track, selected ? 2 : 1.4);
    }
    if (platform.target && !['IDLE', 'ARRIVED', 'WAITING_FOR_DECISION'].includes(nav.state)) {
      if (state.overlays.rawPaths) drawNavigationPolyline(nav.raw_path, '#85929b', 1, [2, 4]);
      if (state.overlays.routes) {
        drawPlannedRoute(remainingPlannedRoute(platform), selected, platform.type);
        if (!platform.navigation && state.dataSource === 'demo') drawPlannedRoute([platform.position, platform.target], selected, platform.type);
        if (selected && !taskWaypoint) { const [x, y] = mapPoint(platform.target); ctx.strokeStyle = palette.routeSelected; ctx.lineWidth = 1.5; ctx.strokeRect(x - 4, y - 4, 8, 8); }
      }
      if (state.overlays.lookahead && nav.lookahead_point) { const [x, y] = mapPoint(nav.lookahead_point); ctx.fillStyle = '#92743b'; ctx.fillRect(x - 3, y - 3, 6, 6); }
    }
    if (state.overlays.safety && selected) {
      const map = state.map || sceneConfig(); const [x, y] = mapPoint(platform.position);
      const radius = (nav.min_separation_m || 100) / 2;
      ctx.strokeStyle = nav.safety_state === 'CLEAR' ? '#6d8594' : '#9b753d'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.ellipse(x, y, radius / map.width * (canvas.clientWidth - 24) * state.mapView.zoom, radius / map.height * (canvas.clientHeight - 24) * state.mapView.zoom, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      for (const id of nav.conflict_platform_ids || []) { const other = state.platforms.find((p) => p.id === id); if (other) drawNavigationPolyline([platform.position, other.position], '#9b753d', 1, [3, 4]); }
    }
  });
  ctx.restore();
}
function drawNavigationRegions(w, h) {
  if (!state.overlays.restrictions) return;
  const map = state.map || {};
  ctx.save();
  const circle = (obstacle, stroke, fill, label, dash) => {
    const [x, y] = mapPoint(obstacle.center);
    const rx = obstacle.radius / map.width * (w - 24) * state.mapView.zoom;
    const ry = obstacle.radius / map.height * (h - 24) * state.mapView.zoom;
    ctx.strokeStyle = stroke; ctx.fillStyle = fill; ctx.lineWidth = 1.3; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = stroke; ctx.font = mapDataFont; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; drawMapLabel(label, x, y);
  };
  (map.no_fly_zones || []).forEach((item) => circle(item, '#9d6460', 'rgba(194,139,133,.14)', '禁飞区', [5, 3]));
  (map.dynamic_obstacles || []).forEach((item) => circle(item, '#94723c', 'rgba(179,150,97,.19)', item.affects?.length === 1 && item.affects[0] === 'uav' ? '临时禁飞' : '临时障碍', [3, 3]));
  const regions = [[map.core_area, '核心区', '#a16662'], [map.border_area, '巡检区域', '#627f96'],
    ...(map.sectors || []).map((sector) => [sector.bounds, `${sector.label} · ${sector.uav_count} 空 / ${sector.ugv_count} 地`, '#627f96'])];
  for (const [area, label, color] of regions) {
    if (!Array.isArray(area) || area.length !== 4) continue;
    const [x, bottom] = mapPoint([area[0], area[1]]); const [right, y] = mapPoint([area[2], area[3]]);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([6, 4]); ctx.strokeRect(x, y, right - x, bottom - y); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = mapLabelFont; drawMapLabel(label, x + 6, y + 5);
  }
  ctx.restore();
}

function renderEvaluationPanel() {
  const evaluation = state.evaluation || {};
  $('evaluationScore').textContent = evaluation.score == null ? '专项指标' : `得分 ${Number(evaluation.score).toFixed(1)}`;
  $('evaluationGoal').textContent = evaluation.headline || '等待评价数据';
  $('evaluationGoal').className = `evaluation-goal ${evaluation.goal_met ? 'met' : ''}`;
  const row = (metric) => {
    const value = Number(metric.value || 0);
    const target = metric.target == null ? NaN : Number(metric.target);
    const tone = ['blue', 'green', 'red', 'amber', 'cyan'].includes(metric.tone) ? metric.tone : 'blue';
    const scalar = metric.bar === false;
    const width = metric.lower_is_better ? (value > 0 ? Math.min(100, value * 20) : 0) : Math.max(0, Math.min(100, value));
    return `<div class="evaluation-row ${scalar ? 'metric-scalar' : ''}"><div class="evaluation-row-head"><span>${esc(metric.label)}</span><strong class="${metric.lower_is_better && value > 0 ? 'red-text' : 'data-text'}">${esc(metric.display ?? navNumber(metric.value, metric.unit || ''))}</strong></div>${scalar ? '' : `<div class="evaluation-bar"><span class="${tone}" style="width:${width}%"></span></div>`}<small>${esc(metric.detail || '')}${Number.isFinite(target) ? ` · 目标 ${metric.lower_is_better ? '≤' : '≥'} ${target}${esc(metric.unit || '')}` : ''}</small></div>`;
  };
  const metrics = evaluation.metrics || [];
  const more = metrics.filter((m) => m.secondary);
  const html = metrics.filter((m) => !m.secondary).map(row).join('') + (more.length ? `<details class="evaluation-secondary" ${state.extraMetricsOpen ? 'open' : ''}><summary>更多评价指标 · ${more.length} 项</summary>${more.map(row).join('')}</details>` : '');
  const target = $('evaluationMetrics');
  if (target.dataset.signature !== html) { target.innerHTML = html; target.dataset.signature = html; }
}

function renderNavigationUI() {
  if (!$('navigationPanel')) return;
  const testing = state.sessionMode === 'navigation';
  document.body.dataset.sessionMode = state.sessionMode || 'mission';
  $('sessionModeLabel').textContent = testing ? '导航测试' : '任务模式';
  $('navigationModeHint').textContent = testing ? '当前为独立导航测试，原任务进度已保留。' : '独立测试会保留当前任务进度。';
  $('navigationExit').hidden = !testing;
  $('navigationTestCommands').hidden = !testing;
  const replaying = typeof exercisePlaybackActive === 'function' && exercisePlaybackActive();
  const busy = $('navigationPanel').dataset.busy === 'true' || replaying;
  $('navigationPanel').querySelectorAll('button:not(.overlay-chip), input, select').forEach((input) => { input.disabled = !state.connected || busy; });
  const crossing = $('navigationTestKind').value !== 'single';
  $('navigationPlatformType').disabled = !state.connected || busy || crossing;
  $('navigationStaticObstacle').disabled = !state.connected || busy || crossing;
  $('behaviorDebugToggle').checked = Boolean(state.viewOptions?.behavior_debug);
  if (testing) {
    const unit = $('navigationUnit');
    const signature = state.platforms.map((p) => `${p.id}:${p.label}`).join('|');
    if (unit.dataset.signature !== signature) { unit.innerHTML = state.platforms.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join(''); unit.dataset.signature = signature; }
    if (state.selected.type === 'platform' && state.platforms.some((p) => p.id === state.selected.id)) unit.value = String(state.selected.id);
    const platform = state.platforms.find((p) => p.id === Number(unit.value));
    const identity = `${state.sessionId}:${platform?.id}`;
    if (platform && unit.dataset.identity !== identity) {
      unit.dataset.identity = identity;
      $('navigationGoalX').value = platform.target?.[0]?.toFixed(0) || '';
      $('navigationGoalY').value = platform.target?.[1]?.toFixed(0) || '';
      $('navigationSpeed').value = platform.intent_speed > 0 ? platform.intent_speed : Math.min(5, platform.max_speed);
      $('navigationSpeed').max = platform.max_speed;
      $('navigationGoalX').max = state.map.width - 1; $('navigationGoalY').max = state.map.height - 1;
    }
    const progress = state.evaluation?.metrics?.find((m) => m.key === 'navigation_progress');
    $('coverageLabel').textContent = '当前路径进度';
    $('coverageValue').textContent = progress?.display || '0.0%';
    $('coverageBar').style.width = `${Math.max(0, Math.min(100, progress?.value || 0))}%`;
    $('handledLabel').textContent = '到达平台';
    $('handledValue').textContent = state.evaluation?.metrics?.find((m) => m.key === 'arrived')?.display || '0 / 0';
  } else {
    $('coverageLabel').textContent = state.scene === 'swarm' ? '集群巡查覆盖率' : state.scene === 'border' ? '巡检区域覆盖率' : state.scene === 'area' ? '区域扫描覆盖率' : '搜索区域覆盖率';
  }
}

async function navigationRequest(path, payload) {
  if (!state.connected || $('navigationPanel').dataset.busy === 'true') return false;
  $('navigationPanel').dataset.busy = 'true'; renderNavigationUI();
  try { return await backendPost(path, payload); }
  finally { $('navigationPanel').dataset.busy = 'false'; renderNavigationUI(); }
}
function setupNavigationControls() {
  Object.assign(state.overlays, { platformTracks: true, rawPaths: false, lookahead: false, safety: false, restrictions: true });
  state.inspectorFolds = new Set();
  $('navigationStartForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = { scene: state.scene, kind: $('navigationTestKind').value, platform_type: $('navigationPlatformType').value, static_obstacle: $('navigationStaticObstacle').checked };
    if (await navigationRequest('/api/navigation/start', payload)) { resetMapView(); toast('已建立独立导航测试，点击运行或快进开始'); }
  });
  $('navigationTestKind').addEventListener('change', renderNavigationUI);
  $('navigationExit').addEventListener('click', async () => { if (await navigationRequest('/api/navigation/exit')) { resetMapView(); toast('已返回原任务，原有进度保留'); } });
  $('navigationUnit').addEventListener('change', () => { selectPlatformById(Number($('navigationUnit').value)); renderNavigationUI(); });
  $('navigationGoalForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await navigationRequest('/api/navigation/goal', { platform_id: Number($('navigationUnit').value), goal: [Number($('navigationGoalX').value), Number($('navigationGoalY').value)], speed: Number($('navigationSpeed').value) });
  });
  $('navigationPanel').addEventListener('click', async (event) => {
    const control = event.target.closest('[data-navigation-action]');
    if (control) await navigationRequest(`/api/navigation/${control.dataset.navigationAction}`, { platform_id: Number($('navigationUnit').value) });
    const obstacle = event.target.closest('[data-obstacle-action]');
    if (obstacle) {
      const action = obstacle.dataset.obstacleAction;
      const x = $('navigationObstacleX').value, y = $('navigationObstacleY').value;
      if (action === 'set' && (x === '' || y === '')) return toast('请填写障碍中心的 X、Y 坐标');
      await navigationRequest('/api/navigation/obstacles', { action, platform_id: Number($('navigationUnit').value), obstacle_id: 'web-test-obstacle', radius: Number($('navigationObstacleRadius').value), affects: $('navigationObstacleAffects').value, center: action === 'set' ? [Number(x), Number(y)] : null });
    }
  });
  $('behaviorDebugToggle').addEventListener('change', () => navigationRequest('/api/view/options', { behavior_debug: $('behaviorDebugToggle').checked }));
  $('inspectorContent').addEventListener('click', (event) => {
    if (!event.target.closest('[data-open-navigation]')) return;
    $('navigationPanel').open = true;
    $('diagnosticsDialog').showModal();
    $('navigationPanel').querySelector('summary').focus();
  });
  $('inspectorContent').addEventListener('toggle', (event) => {
    if (!event.target.isConnected || !event.target.dataset.inspectorFold) return;
    const key = event.target.dataset.inspectorFold;
    if (event.target.open) state.inspectorFolds.add(key); else state.inspectorFolds.delete(key);
  }, true);
  $('evaluationMetrics').addEventListener('toggle', (event) => { if (event.target.isConnected && event.target.matches('.evaluation-secondary')) state.extraMetricsOpen = event.target.open; }, true);
}
