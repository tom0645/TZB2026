/* 局部三维态势：持久模型、批量图层和按需渲染。显示不参与任务与导航计算。 */
(function () {
  'use strict';
  const UAV_HEIGHT = 10, TREE_HEIGHT = 0, DISPLAY_HEIGHT_SCALE = 35, MODEL_ROOT = 'assets/models/optimized/';
  const PLATFORM_MODEL_COLORS = new Map([['uav', '#03468A'], ['ugv', '#4B5320']]);
  const COLORS = { sea: '#475869', mine: '#D50066', ground: '#d7ddc7', edge: '#83958d', grid: '#a3afa0', road: '#a89979', uav: '#386f97', ugv: '#527952', red: '#b45d58', amber: '#947240', text: '#28434e', selection: '#245f87', trackUav: '#779bb4', trackUgv: '#91aa86' };
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const validPoint = (p) => Array.isArray(p) && p.length > 1 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  /** 障碍名称只影响显示，导航仍使用后端提供的原始地面约束。 */
  function obstacleKind(obstacle, index) {
    const kind = String(obstacle.kind || obstacle.type || obstacle.name || '').toLowerCase();
    if (kind.includes('lake') || kind.includes('湖')) return 'lake';
    if (kind.includes('mine') || kind.includes('雷')) return 'mine';
    return index % 2 ? 'lake' : 'mine';
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function terrainNoiseGrid(cells, seed) {
    const values = new Float32Array((cells + 1) * (cells + 1));
    for (let y = 0; y <= cells; y += 1) for (let x = 0; x <= cells; x += 1) {
      let hash = Math.imul(x + seed, 374761393) + Math.imul(y + seed * 3, 668265263);
      hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
      values[y * (cells + 1) + x] = ((hash ^ (hash >>> 16)) >>> 0) / 2147483647.5 - 1;
    }
    return { cells, stride: cells + 1, values };
  }
  function terrainNoise(grid, x, y) {
    const px = clamp(x, 0, 1) * grid.cells, py = clamp(y, 0, 1) * grid.cells;
    const ix = Math.min(grid.cells - 1, Math.floor(px)), iy = Math.min(grid.cells - 1, Math.floor(py));
    const fx0 = px - ix, fy0 = py - iy, fx = fx0 * fx0 * (3 - 2 * fx0), fy = fy0 * fy0 * (3 - 2 * fy0);
    const i = iy * grid.stride + ix, values = grid.values;
    const top = values[i] + (values[i + 1] - values[i]) * fx;
    const bottom = values[i + grid.stride] + (values[i + grid.stride + 1] - values[i + grid.stride]) * fx;
    return top + (bottom - top) * fy;
  }
  function makeTerrainTexture(map, size = 2048) {
    const surface = canvas(size, size), context = surface.getContext('2d'), image = context.createImageData(size, size);
    const obstacles = map.obstacles || [], width = Math.max(1, finite(map.width, 10000)), height = Math.max(1, finite(map.height, 10000));
    const lerp = (a, b, f) => a + (b - a) * f;
    const smoothstep = (a, b, value) => { const t = clamp((value - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const relief = [[terrainNoiseGrid(4, 11), .50], [terrainNoiseGrid(12, 23), .30], [terrainNoiseGrid(28, 37), .15], [terrainNoiseGrid(64, 53), .05]];
    const moisture = [[terrainNoiseGrid(5, 79), .52], [terrainNoiseGrid(14, 97), .32], [terrainNoiseGrid(36, 131), .16]];
    const heights = new Float32Array(size * size), constraintPixels = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const nx = x / size, ny = 1 - y / size;
      const wx = nx * width, wy = ny * height, warpX = terrainNoise(relief[2][0], nx, ny) * .017,
        warpY = terrainNoise(relief[1][0], nx + .31, ny + .47) * .017;
      const tx = nx + warpX, ty = ny + warpY;
      let elevation = 0, wetness = 0;
      for (const [field, weight] of relief) elevation += terrainNoise(field, tx, ty) * weight;
      for (const [field, weight] of moisture) wetness += terrainNoise(field, tx - .08, ty + .12) * weight;
      heights[y * size + x] = elevation;
      const vegetation = smoothstep(-.22, .48, wetness + elevation * .12);
      const dry = smoothstep(.08, .68, -wetness + elevation * .18) * (1 - vegetation * .58);
      let base = [216 + elevation * 5, 222 + elevation * 4, 202 + elevation * 2];
      base = base.map((value, i) => lerp(value, [137, 165, 112][i], vegetation * .78));
      base = base.map((value, i) => lerp(value, [222, 202, 161][i], dry * .68));
      const coast = Math.min(nx, 1 - nx, ny, 1 - ny);
      if (coast < .025) base = base.map((value, i) => lerp(value, [216, 193, 151][i], (1 - smoothstep(0, .025, coast)) * .92));
      base = base.map((value, i) => lerp(value, [49, 64, 64][i], .38));
      for (let obstacleIndex = 0; obstacleIndex < obstacles.length; obstacleIndex += 1) {
        const obstacle = obstacles[obstacleIndex];
        const radius = Math.max(1, finite(obstacle.radius, 20)), dx = wx - obstacle.center[0], dy = wy - obstacle.center[1];
        if (dx * dx + dy * dy <= radius * radius) {
          const lake = obstacleKind(obstacle, obstacleIndex) === 'lake';
          if (lake) base = [71, 88, 105];
          constraintPixels[y * size + x] = lake ? 1 : 2;
        }
      }
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(base[0]); image.data[i + 1] = Math.round(base[1]);
      image.data[i + 2] = Math.round(base[2]); image.data[i + 3] = 255;
    }
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      if (constraintPixels[index] === 1) continue;
      const colorIndex = index * 4;
      if (x > 0 && x < size - 1 && y > 0 && y < size - 1) {
        const dx = heights[index + 1] - heights[index - 1], dy = heights[index + size] - heights[index - size];
        const shade = clamp(1 + (-dx * .7 - dy * .55) * size * .05, .95, 1.05);
        image.data[colorIndex] = Math.round(image.data[colorIndex] * shade);
        image.data[colorIndex + 1] = Math.round(image.data[colorIndex + 1] * shade);
        image.data[colorIndex + 2] = Math.round(image.data[colorIndex + 2] * shade);
      }
      // 雷区仅叠加 30% 的标识色，仍能看到下面的自然地表细节。
      if (constraintPixels[index] === 2) {
        image.data[colorIndex] = Math.round(image.data[colorIndex] * .7 + 213 * .3);
        image.data[colorIndex + 1] = Math.round(image.data[colorIndex + 1] * .7);
        image.data[colorIndex + 2] = Math.round(image.data[colorIndex + 2] * .7 + 102 * .3);
      }
    }
    context.putImageData(image, 0, 0);
    return surface;
  }
  function createTerrainTextureAsync(map, size = 2048) {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve({ image: makeTerrainTexture(map, 1024), elapsedMs: 0, fallback: true }); }
        catch (error) { reject(error); }
      }, 0));
    }
    const source = [
      `const clamp=${clamp.toString()};`, `const finite=${finite.toString()};`,
      'function canvas(width,height){return new OffscreenCanvas(width,height);}',
      terrainNoiseGrid.toString(), terrainNoise.toString(), obstacleKind.toString(), makeTerrainTexture.toString(),
      "self.onmessage=async event=>{const started=performance.now();try{const image=makeTerrainTexture(event.data.map,event.data.size);const bitmap=await createImageBitmap(image);self.postMessage({bitmap,elapsedMs:performance.now()-started},[bitmap]);}catch(error){self.postMessage({error:String(error)});}};",
    ].join('\n');
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    let worker;
    try { worker = new Worker(url); }
    catch (error) {
      URL.revokeObjectURL(url);
      return new Promise((resolve, reject) => setTimeout(() => {
        try { resolve({ image: makeTerrainTexture(map, 512), elapsedMs: 0, fallback: true }); }
        catch (fallbackError) { reject(fallbackError || error); }
      }, 0));
    }
    let settled = false;
    const cleanup = () => { if (settled) return; settled = true; worker.terminate(); URL.revokeObjectURL(url); };
    const promise = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const data = event.data; cleanup();
        if (data?.error) reject(new Error(data.error));
        else resolve({ image: data.bitmap, elapsedMs: data.elapsedMs, fallback: false });
      };
      worker.onerror = (event) => { cleanup(); reject(new Error(event.message || '地表纹理生成失败')); };
      worker.postMessage({ map: { width: map.width, height: map.height, obstacles: map.obstacles || [] }, size });
    });
    promise.cancel = cleanup;
    return promise;
  }
  function hashPoints(points) {
    let hash = 2166136261;
    for (const p of points) if (validPoint(p)) { hash = Math.imul(hash ^ Math.round(p[0] * 10), 16777619); hash = Math.imul(hash ^ Math.round(p[1] * 10), 16777619); }
    return points.length + ':' + (hash >>> 0);
  }
  /** 仅简化显示折线，保留首尾与拐点，最大平面误差不超过 0.75 米。 */
  function simplifyHistory(points, tolerance = .75) {
    if (points.length < 4) return points;
    const keep = new Uint8Array(points.length), stack = [[0, points.length - 1]], limit = tolerance * tolerance;
    keep[0] = keep[points.length - 1] = 1;
    while (stack.length) {
      const [first, last] = stack.pop(), a = points[first], b = points[last];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
      let farthest = -1, distance = limit;
      for (let i = first + 1; i < last; i += 1) {
        const p = points[i], f = length ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length, 0, 1) : 0;
        const ex = p[0] - a[0] - f * dx, ey = p[1] - a[1] - f * dy, value = ex * ex + ey * ey;
        if (value > distance) { distance = value; farthest = i; }
      }
      if (farthest >= 0) { keep[farthest] = 1; stack.push([first, farthest], [farthest, last]); }
    }
    return points.filter((_point, i) => keep[i]);
  }
  function markerImage(arrow, color) {
    const c = canvas(arrow ? 32 : 60, arrow ? 18 : 60), ctx = c.getContext('2d'); ctx.lineWidth = 2; ctx.strokeStyle = color;
    if (arrow) { ctx.beginPath(); for (const x of [6, 17]) { ctx.moveTo(x, 3); ctx.lineTo(x + 7, 9); ctx.lineTo(x, 15); } ctx.stroke(); }
    else for (const [x, y, sx, sy] of [[3, 3, 1, 1], [57, 3, -1, 1], [3, 57, 1, -1], [57, 57, -1, -1]]) { ctx.beginPath(); ctx.moveTo(x + sx * 11, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * 11); ctx.stroke(); }
    return c;
  }
  function fallbackColor(layer, raw) {
    const v = clamp(finite(raw), 0, 1);
    if (layer === 'passability') return v < .08 ? '#cb9e9a' : v > .75 ? '#91b69c' : '#dde6ec';
    const stops = layer === 'priority' ? [[234, 242, 247], [238, 224, 204], [230, 192, 185]] : [[234, 242, 247], [201, 222, 235], [167, 199, 221]];
    const i = v <= .5 ? 0 : 1, f = (v - i * .5) * 2;
    return 'rgb(' + stops[i].map((x, j) => Math.round(x + (stops[i + 1][j] - x) * f)).join(',') + ')';
  }
  // 地表只上传一次；低分辨率业务栅格和等距网格由片元着色器叠加。
  const GROUND_MATERIAL_SOURCE = `
    czm_material czm_getMaterial(czm_materialInput materialInput) {
      czm_material material = czm_getDefaultMaterial(materialInput);
      vec2 uv = clamp(materialInput.st, vec2(0.0), vec2(1.0));
      vec3 land = texture(terrainImage, uv).rgb;
      vec2 cell = (floor(min(uv, vec2(0.999999)) * layerSize) + vec2(0.5)) / layerSize;
      vec3 layer = texture(layerImage, cell).rgb;
      vec3 surface = mix(land, layer, layerOpacity);
      vec2 coordinates = uv * mapMeters / 100.0;
      vec2 footprint = max(fwidth(coordinates), vec2(0.00001));
      vec2 distanceToLine = abs(fract(coordinates + vec2(0.5)) - vec2(0.5)) / footprint;
      float line = 1.0 - smoothstep(0.35, 1.05, min(distanceToLine.x, distanceToLine.y));
      float gridFade = 1.0 - smoothstep(0.2, 0.8, max(footprint.x, footprint.y));
      vec3 gridColor = mix(vec3(0.365, 0.455, 0.412), vec3(0.47, 0.57, 0.64), layerOpacity);
      material.diffuse = mix(surface, gridColor, line * gridFade * mix(0.12, 0.24, layerOpacity));
      material.alpha = 1.0;
      return material;
    }
  `;
  class FlatTacticalView {
    constructor(options) {
      const C = window.Cesium; if (!C) throw new Error('三维引擎尚未加载');
      Object.assign(this, { C, options, helpers: options.helpers || {}, container: options.container, width: 10000, height: 10000,
        visible: true, destroyed: false, mode: 'overview', heightScale: DISPLAY_HEIGHT_SCALE, heightMode: 'fixed35', modelSize: 'normal', cameraDirty: true,
        routeDirty: true, modelsDirty: true, records: new Map(), lines: new Map(), routeCache: new Map(), colors: new Map(), arrowImages: new Map(),
        routeArrowSamples: [], arrowPool: [], staticLabels: [], regionLabels: [], regionLines: [], treePoints: [], treeModels: [],
        cueLines: [], cueLabels: [], cueGeometryKey: null, restrictionGeometryKey: null, dynamicTreeGeometryKey: null,
        lastHistoryOverlayAt: 0, historyOverlayDue: true, lastOverlayAt: 0, overlayRefreshPending: false,
        interactionUntil: 0, interactionTimer: null,
        cameraState: { x: 5000, y: 5000, distance: 16000, yaw: 0, pitch: .72 }, followOffset: { x: 0, y: 0 },
        contextLost: false, contextLossCount: 0, renderErrorStreak: 0, recoveryTimer: null,
        quality: { samples: [], lastFrame: 0, lastAdjustment: 0, scale: 1, fps: 0 }, terrainTextureGeneration: 0, terrainTextureReady: false, terrainBuildMs: 0,
        performance: { modelCreates: 0, modelRemoves: 0, modelFailures: 0, lineCreates: 0, lineUpdates: 0, lineReuses: 0, overlayRebuilds: 0, groundUploads: 0, arrowUpdates: 0, arrowSegmentProjections: 0, arrowPerMarkerProjections: 0, routeMetricBuilds: 0, staticRebuilds: 0, cueGeometryRebuilds: 0, restrictionGeometryRebuilds: 0, dynamicTreeInvalidations: 0, historyInputPoints: 0, historyDrawPoints: 0, historyCacheHits: 0, historySkipped: 0, historySimplifications: 0, frames: 0, updateMs: 0, maxUpdateMs: 0, heightLineUpdates: 0 } });
      Object.assign(this.performance, { gpuLayers: true, terrainUploads: 0, layerUploads: 0, layerUploadPixels: 0, maxLayerUploadPixels: 0,
        groundPrimitiveCreates: 0, cpuTerrainComposites: 0 });
      this.frame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(0, 0, 0));
      this.inverseFrame = C.Matrix4.inverseTransformation(this.frame, new C.Matrix4());
      this.selectionImages = {
        selected: markerImage(false, getComputedStyle(document.documentElement).getPropertyValue('--map-select').trim() || '#71c5e7'),
        related: markerImage(false, '#91b7d1'),
        high: markerImage(false, '#ff9694'), medium: markerImage(false, '#f1bd72'),
      };
      this.emphasis = new Map();
      this.routeWorldScratch = new C.Cartesian3();
      this.viewer = new C.Viewer(this.container, { animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, selectionIndicator: false, infoBox: false,
        baseLayer: false, globe: false, skyBox: false, skyAtmosphere: false, scene3DOnly: true, shadows: false,
        shouldAnimate: false, targetFrameRate: 60, requestRenderMode: true, maximumRenderTimeChange: Number.POSITIVE_INFINITY,
        contextOptions: { webgl: { alpha: true, antialias: false, preserveDrawingBuffer: false } } });
      const scene = this.viewer.scene; scene.backgroundColor = C.Color.TRANSPARENT; scene.screenSpaceCameraController.enableInputs = false;
      if (scene.sun) scene.sun.show = false; if (scene.moon) scene.moon.show = false;
      scene.fog.enabled = false; scene.highDynamicRange = false; scene.postProcessStages.fxaa.enabled = false;
      this.viewer.resolutionScale = 1; this.viewer.useBrowserRecommendedResolution = true; this.viewer.clock.shouldAnimate = false;
      this.infoPanel = document.createElement('div');
      this.infoPanel.className = 'tactical-object-readout'; this.infoPanel.hidden = true;
      this.infoPanel.setAttribute('role', 'status'); this.infoPanel.setAttribute('aria-live', 'polite');
      this.infoPanel.innerHTML = '<b class="readout-title"></b><span><i>海拔</i><em data-field="altitude"></em></span><span><i>速度</i><em data-field="speed"></em></span><span><i>航向</i><em data-field="heading"></em></span><span data-row="battery"><i>电量</i><em data-field="battery"></em></span>';
      this.infoPanelFields = new Map([...this.infoPanel.querySelectorAll('[data-field]')].map((field) => [field.dataset.field, field]));
      this.container.appendChild(this.infoPanel);
      this.infoPanelTitle = this.infoPanel.querySelector('.readout-title');
      this.lineCollection = scene.primitives.add(new C.PolylineCollection()); this.staticLineCollection = scene.primitives.add(new C.PolylineCollection());
      // 高频高度引线与低频长历史线分开，移动一架机不会重打包全部历史几何。
      this.heightLineCollection = scene.primitives.add(new C.PolylineCollection());
      this.labelCollection = scene.primitives.add(new C.LabelCollection()); this.pointCollection = scene.primitives.add(new C.PointPrimitiveCollection());
      this.selectionCollection = scene.primitives.add(new C.BillboardCollection()); this.arrowCollection = scene.primitives.add(new C.BillboardCollection());
      const waypoint = this.helpers.navigationPointMarker();
      this.taskMarker = this.selectionCollection.add({ image: waypoint.image, width: waypoint.width, height: waypoint.height,
        verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, waypoint.tipOffset),
        show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      this.dynamicSource = { entities: { values: [] } }; this.overlaySource = { entities: { values: [] } }; this.staticSource = { entities: { values: [] } };
      this._removePreUpdate = scene.preUpdate.addEventListener(() => this._renderFrame());
      this._removePostRender = scene.postRender.addEventListener(() => {
        this.performance.frames += 1;
        this.renderErrorStreak = 0;
        // Cesium applies a newly assigned canvas texture during material updates.
        if (this.terrainTextureReady && this.performance.frames <= this.terrainUploadFrame + 2) this._request();
        this._publishScreenLabels();
        this._sampleFrameQuality(performance.now());
        if (this.isReady() && !this.readyNotified) { this.readyNotified = true; this.options.onReady?.(); }
      });
      this._removeError = scene.renderError.addEventListener((_scene, error) => this._handleRenderError(error));
      this._installInput(); this.resize();
    }
    /** 在显示边界应用高度比例，业务遥测仍为十米海拔。 */
    _world(p, z = 0, result, exaggerate = true) {
      const C = this.C;
      return C.Matrix4.multiplyByPoint(this.frame, new C.Cartesian3(finite(p[0]) - this.width / 2, finite(p[1]) - this.height / 2, z * (exaggerate ? this.heightScale : 1)), result || new C.Cartesian3());
    }
    _local(world) { const p = this.C.Matrix4.multiplyByPoint(this.inverseFrame, world, new this.C.Cartesian3()); return [p.x + this.width / 2, p.y + this.height / 2, p.z]; }
    _color(css, alpha = 1) { const key = css + ':' + alpha; if (!this.colors.has(key)) this.colors.set(key, this.C.Color.fromCssColorString(css).withAlpha(alpha)); return this.colors.get(key); }
    _groundedAerial(item, kind) {
      return kind === 'target' && item.type === 'aerial'
        && Boolean(item.extra?.neutralized || item.extra?.debris_cleared || item.neutralized || item.debris_cleared
          || ['已处置', '残骸已清理', '已清理'].includes(item.state));
    }
    _height(item, kind) {
      if (this._groundedAerial(item, kind)) return 0;
      return item.type === 'uav' || (kind === 'target' && item.type === 'aerial') ? UAV_HEIGHT : 0;
    }
    _selected(kind, id) { return this.state?.selected?.type === kind && this.state.selected.id === id; }
    _publishScreenLabels() {
      if (!this.options.onLabels) return;
      const C = this.C, scene = this.viewer.scene, camera = this.viewer.camera;
      const width = this.container.clientWidth, height = this.container.clientHeight, items = [];
      const add = (label, key, kind, type, centered = false, shown = true) => {
        label.show = false;
        if (!shown || !label.position) return;
        const world = label.position, dx = world.x - camera.positionWC.x, dy = world.y - camera.positionWC.y, dz = world.z - camera.positionWC.z;
        if (dx * camera.directionWC.x + dy * camera.directionWC.y + dz * camera.directionWC.z <= 0) return;
        const screen = C.SceneTransforms.worldToWindowCoordinates(scene, world);
        if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return;
        const x = Math.round(screen.x + (label.pixelOffset?.x || 0)), y = Math.round(screen.y + (label.pixelOffset?.y || 0));
        if (x < -120 || x > width + 120 || y < -30 || y > height + 30) return;
        items.push({ key, text: label.text, x, y, kind, type, centered, visible: true,
          color: label.fillColor?.toCssColorString(), background: label.showBackground ? label.backgroundColor?.toCssColorString() : null });
      };
      if (this.visible) {
        for (const record of this.records.values()) {
          const shown = record.kind === 'platform' || this.emphasis.has(record.key) || this.cameraState.distance < 3500;
          add(record.label, record.key, record.kind, record.item.type, false, shown);
        }
        for (const [group, labels] of [['static', this.staticLabels], ['region', this.regionLabels], ['cue', this.cueLabels]]) {
          labels.forEach((label, index) => {
            if (label._htmlShown === undefined) label._htmlShown = label.show;
            const natural = this.naturalLabels.includes(label);
            const type = label.text === '雷区' ? 'mine' : label.text === '湖泊' ? 'lake' : group;
            add(label, `${group}:${index}`, ['mine', 'lake'].includes(type) ? 'region' : 'reference', type,
              label.horizontalOrigin === C.HorizontalOrigin.CENTER, natural ? !this.state?.layer : label._htmlShown);
          });
        }
      }
      const signature = JSON.stringify(items);
      if (signature === this.screenLabelsSignature) return;
      this.screenLabelsSignature = signature; this.options.onLabels(items);
    }
    isReady() { return Boolean(this.terrainTextureReady && this.ground?.ready); }
    _request() { if (!this.destroyed && this.visible) this.viewer.scene.requestRender(); }
    _newLine(collection, positions, color, width = 1, dash = false, fading = false) {
      const C = this.C, material = fading ? new C.Material({ fabric: {
        type: 'TacticalRecentTrail', uniforms: { color: this._color(color) },
        source: 'czm_material czm_getMaterial(czm_materialInput materialInput) { czm_material material = czm_getDefaultMaterial(materialInput); material.diffuse = color.rgb; material.alpha = color.a * mix(0.04, 1.0, clamp(materialInput.st.s, 0.0, 1.0)); return material; }',
      }, translucent: true }) : dash ? C.Material.fromType('PolylineDash', { color: this._color(color), dashLength: 12 }) : C.Material.fromType('Color', { color: this._color(color) });
      this.performance.lineCreates += 1; return collection.add({ positions, width, material });
    }
    _lineFor(key, points, z, color, width, dash = false, shown = true) {
      const isHistory = key.startsWith('track:') || key.startsWith('target-track:');
      const frameKey = `${this.width}:${this.height}`;
      let entry = this.lines.get(key);
      if (!shown) {
        this.performance.historySkipped += isHistory ? 1 : 0;
        if (!entry) return;
        this.performance.lineReuses += 1;
        entry.alive = true;
        entry.line.show = false;
        entry.line.width = width;
        entry.line.material.uniforms.color = this._color(color);
        return;
      }
      if (!Array.isArray(points) || points.length < 2) {
        if (entry) { this.performance.lineReuses += 1; entry.alive = true; entry.line.show = false; }
        return;
      }

      let displayPoints, created = false, reuseGeometry = false;
      if (entry?.rawRef === points && entry?.geometryZ === z && entry?.geometryScale === this.heightScale && entry?.geometryFrame === frameKey) {
        displayPoints = entry.displayPoints;
        reuseGeometry = true;
        this.performance.historyCacheHits += isHistory ? 1 : 0;
      } else {
        // De-duplicate while hashing. The signature is checked against an exact point copy
        // before reusing simplified/world geometry, so hash collisions cannot stale a line.
        const compact = [];
        let hash = 2166136261;
        for (const point of points) {
          if (!validPoint(point)) continue;
          const last = compact.at(-1);
          if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) <= .1) continue;
          compact.push(point);
          hash = Math.imul(hash ^ Math.round(point[0] * 10), 16777619);
          hash = Math.imul(hash ^ Math.round(point[1] * 10), 16777619);
        }
        const rawHash = compact.length + ':' + (hash >>> 0);
        const equalRaw = entry?.rawHash === rawHash && entry.rawPoints?.length === compact.length
          && compact.every((point, i) => point[0] === entry.rawPoints[i][0] && point[1] === entry.rawPoints[i][1]);
        if (equalRaw && entry.geometryZ === z && entry.geometryScale === this.heightScale && entry.geometryFrame === frameKey) {
          displayPoints = entry.displayPoints;
          entry.rawRef = points;
          reuseGeometry = true;
          this.performance.historyCacheHits += isHistory ? 1 : 0;
        } else {
          displayPoints = isHistory ? simplifyHistory(compact) : compact;
          if (isHistory) {
            this.performance.historyInputPoints += compact.length;
            this.performance.historyDrawPoints += displayPoints.length;
            this.performance.historySimplifications += 1;
          }
          if (!entry) {
            entry = { line: this._newLine(this.lineCollection, [this._world([0, 0]), this._world([0, 0])], color, width, dash, key.startsWith('track:')), key: '' };
            this.lines.set(key, entry);
            created = true;
          }
          entry.rawRef = points;
          entry.rawHash = rawHash;
          entry.rawPoints = compact.map((point) => [point[0], point[1]]);
          entry.displayPoints = displayPoints;
          entry.geometryZ = z;
          entry.geometryScale = this.heightScale;
          entry.geometryFrame = frameKey;
          entry.worldPositions = displayPoints.map((point) => this._world(point, z));
          entry.key = '';
        }
      }
      if (!entry) {
        entry = { line: this._newLine(this.lineCollection, [this._world([0, 0]), this._world([0, 0])], color, width, dash, key.startsWith('track:')), key: '' };
        this.lines.set(key, entry);
        created = true;
      }
      if (!created) this.performance.lineReuses += 1;
      if (!reuseGeometry || !entry.key) {
        const signature = hashPoints(displayPoints) + ':' + z + ':' + this.heightScale + ':' + frameKey;
        if (signature !== entry.key) {
          if (!entry.worldPositions || entry.geometryZ !== z || entry.geometryScale !== this.heightScale || entry.geometryFrame !== frameKey) {
            entry.worldPositions = displayPoints.map((point) => this._world(point, z));
            entry.geometryZ = z;
            entry.geometryScale = this.heightScale;
            entry.geometryFrame = frameKey;
          }
          entry.line.positions = entry.worldPositions;
          entry.key = signature;
          this.performance.lineUpdates += 1;
        }
      }
      entry.line.show = displayPoints.length > 1;
      entry.line.width = width;
      entry.line.material.uniforms.color = this._color(color);
      entry.alive = true;
    }
    _retainHistoryLine(key, shown, color, width) {
      const entry = this.lines.get(key);
      if (!entry) return false;
      entry.alive = true;
      entry.line.show = shown && entry.displayPoints?.length > 1;
      entry.line.width = width;
      entry.line.material.uniforms.color = this._color(color);
      return true;
    }
    _label(p, text, color = COLORS.text, z = 0) {
      const C = this.C, label = this.labelCollection.add({ position: this._world(p, z), text, font: '12px "Microsoft YaHei UI",sans-serif', fillColor: this._color(color),
        outlineColor: this._color('#f1f6f7'), outlineWidth: 2, style: C.LabelStyle.FILL_AND_OUTLINE, show: !this.options.onLabels,
        disableDepthTestDistance: Number.POSITIVE_INFINITY });
      label._htmlShown = true; return label;
    }
    _circlePoints(center, radius) { const p = []; for (let i = 0; i <= 40; i += 1) { const a = i / 40 * Math.PI * 2; p.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]); } return p; }
    _releaseGroundMaterial() {
      // Primitive 只释放几何与着色器，不负责 appearance.material 中的纹理。
      // 场景重置、切换和 Viewer 回收时必须显式销毁，否则高清底图会留在显存。
      if (this.groundMaterial && !this.groundMaterial.isDestroyed()) {
        this.groundMaterial.destroy();
        this.performance.groundMaterialDestroys = (this.performance.groundMaterialDestroys || 0) + 1;
      }
      // 尚未参与第一次绘制的纹理还没有交给 Material，也由这里收尾。
      if (this.layerTexture && !this.layerTexture.isDestroyed()) this.layerTexture.destroy();
      this.groundMaterial = null; this.layerTexture = null; this.layerRaster = null;
      this.layerPaletteCache = new Map();
    }
    _makeGround() {
      const C = this.C; const w = this.width / 2, h = this.height / 2;
      const geometry = new C.Geometry({ attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0]) }),
        normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) }),
        st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) }) },
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: new C.BoundingSphere(C.Cartesian3.ZERO, Math.hypot(w, h)) });
      this.groundGeometry = geometry;
      const image = canvas(2, 2), ctx = image.getContext('2d'); ctx.fillStyle = COLORS.ground; ctx.fillRect(0, 0, 2, 2);
      this._setGroundMaterial(image);
      this.gridKey = ''; this.gridHash = null; this.gridSource = null; this.gridSignature = null; this.gridTerrainSource = null;
      this.terrainTexture = null; this.rasters = [];
    }
    _setGroundMaterial(image) {
      const C = this.C, scene = this.viewer.scene;
      if (this.ground) scene.primitives.remove(this.ground);
      this._releaseGroundMaterial();
      const emptyLayer = canvas(1, 1);
      this.groundMaterial = new C.Material({ fabric: {
        type: 'TacticalGroundLayers',
        // Fabric 会缓存并深拷贝类型定义；初始图像使用标识，避免再次构建时克隆 DOM Canvas。
        uniforms: { terrainImage: C.Material.DefaultImageId, layerImage: C.Material.DefaultImageId, layerSize: new C.Cartesian2(1, 1),
          mapMeters: new C.Cartesian2(this.width, this.height), layerOpacity: 0.0 },
        source: GROUND_MATERIAL_SOURCE,
      }, translucent: false });
      this.groundMaterial.uniforms.terrainImage = image;
      this.groundMaterial.uniforms.layerImage = emptyLayer;
      const appearance = new C.MaterialAppearance({ material: this.groundMaterial, flat: true, faceForward: true,
        translucent: false, renderState: { depthTest: { enabled: true }, cull: { enabled: false } } });
      this.ground = scene.primitives.add(new C.Primitive({
        geometryInstances: new C.GeometryInstance({ geometry: this.groundGeometry, modelMatrix: this.frame }),
        appearance, asynchronous: true,
      }));
      this.groundMaterialBound = true;
      this.performance.groundPrimitiveCreates += 1;
    }
    _rebuildStatic(map) {
      this.performance.staticRebuilds += 1; this.staticLineCollection.removeAll(); this.staticLabels.forEach((l) => this.labelCollection.remove(l)); this.staticLabels = [];
      this.naturalLines = []; this.naturalLabels = []; this.obstacleRegions = [];
      this.terrainTextureTask?.cancel?.(); this.terrainTextureTask = null;
      const terrainGeneration = this.terrainTextureGeneration += 1;
      this.terrainTextureReady = false; this.terrainBuildMs = 0;
      const placeholder = canvas(2, 2), placeholderContext = placeholder.getContext('2d');
      placeholderContext.fillStyle = COLORS.ground; placeholderContext.fillRect(0, 0, 2, 2);
      this.terrainTexture = placeholder; this.gridTerrainSource = null;
      this.gridSource = null; this.gridKey = undefined;
      const terrainTask = createTerrainTextureAsync(map);
      this.terrainTextureTask = terrainTask;
      terrainTask.then(({ image, elapsedMs, fallback }) => {
        if (this.destroyed || terrainGeneration !== this.terrainTextureGeneration) { image.close?.(); return; }
        this.terrainTextureTask = null;
        let texture = image;
        if (!fallback) {
          texture = canvas(image.width, image.height);
          const bitmap = texture.getContext('bitmaprenderer');
          if (bitmap) bitmap.transferFromImageBitmap(image);
          else {
            const context = texture.getContext('2d');
            context.drawImage(image, 0, 0);
            // Commit the copy before releasing its backing image.
            context.getImageData(0, 0, 1, 1);
            image.close();
          }
        }
        this.terrainTexture = texture; this.gridTerrainSource = null;
        this.terrainTextureReady = true; this.terrainBuildMs = elapsedMs;
        this.readyNotified = false;
        this.gridSource = null; this.gridKey = undefined;
        if (this.state?.map) {
          this._updateGround(this.state.map);
          this.terrainUploadFrame = this.performance.frames;
          this._request();
        }
      }).catch((error) => {
        if (this.destroyed || terrainGeneration !== this.terrainTextureGeneration) return;
        setTimeout(() => {
          if (this.destroyed || terrainGeneration !== this.terrainTextureGeneration) return;
          try {
            this.terrainTexture = makeTerrainTexture(map, 512); this.terrainTextureReady = true;
            this.terrainBuildMs = 0; this.gridTerrainSource = null; this.gridSource = null; this.gridKey = undefined;
            if (this.state?.map) {
              this._updateGround(this.state.map);
              this.terrainUploadFrame = this.performance.frames;
              this._request();
            }
          } catch (fallbackError) { this.options.onModelError?.(fallbackError || error, { kind: 'terrain' }); }
        }, 0);
      });
      const line = (points, color, width = 1, dash = false) => this._newLine(this.staticLineCollection, points.map((p) => this._world(p, .06, undefined, false)), color, width, dash);
      const naturalLine = (...args) => { const item = line(...args); this.naturalLines.push(item); return item; };
      line([[0, 0], [this.width, 0], [this.width, this.height], [0, this.height], [0, 0]], COLORS.edge, 1.3);
      const step = 100;
      this.gridLineCount = 0;
      this.gridMeters = step;
      this.gridLineCount = Math.max(0, Math.ceil(this.width / step) - 1) + Math.max(0, Math.ceil(this.height / step) - 1);
      for (const road of map.roads || []) { const p = (road.waypoints || []).filter(validPoint); if (p.length > 1) { naturalLine(p, '#d3c7ad', 5); naturalLine(p, COLORS.road, 1.3, true); } }
      this.treePoints = [];
      (map.obstacles || []).forEach((o, index) => {
        if (!validPoint(o.center)) return; const radius = Math.max(1, finite(o.radius, 20));
        const kind = obstacleKind(o, index), lake = kind === 'lake', color = lake ? COLORS.sea : COLORS.mine;
        line(this._circlePoints(o.center, radius), color, 1.4);
        const label = this._label(o.center, lake ? '湖泊' : '雷区', '#ffffff');
        label.horizontalOrigin = this.C.HorizontalOrigin.CENTER; label.verticalOrigin = this.C.VerticalOrigin.CENTER;
        label.pixelOffset = new this.C.Cartesian2(0, 0); label.font = '600 13px "Microsoft YaHei UI",sans-serif';
        label.outlineColor = this._color(lake ? COLORS.sea : '#6f2148'); label.outlineWidth = 2;
        this.staticLabels.push(label);
        this.obstacleRegions.push({ kind, center: [...o.center], radius, color, fillOpacity: lake ? 1 : .3 });
      });
      const coastline = [];
      for (let index = 0; index <= 16; index += 1) {
        const fraction = index / 16, wave = 1 + .004 * Math.sin(index * .82) + .002 * Math.sin(index * 1.9);
        coastline.push([fraction * this.width, this.height * (1 - .008 * wave)]);
      }
      for (let index = 1; index <= 16; index += 1) {
        const fraction = index / 16, wave = 1 + .004 * Math.sin(index * .77 + 1) + .002 * Math.sin(index * 1.8);
        coastline.push([this.width * (1 - .008 * wave), (1 - fraction) * this.height]);
      }
      for (let index = 1; index <= 16; index += 1) {
        const fraction = 1 - index / 16, wave = 1 + .004 * Math.sin(index * .9 + 2) + .002 * Math.sin(index * 2.1);
        coastline.push([fraction * this.width, this.height * .008 * wave]);
      }
      for (let index = 1; index < 16; index += 1) {
        const fraction = 1 - index / 16, wave = 1 + .004 * Math.sin(index * .72 + 3) + .002 * Math.sin(index * 1.7);
        coastline.push([this.width * .008 * wave, fraction * this.height]);
      }
      this.coastline = true;
      naturalLine(coastline, '#c4ad7f', 4);
      naturalLine(coastline, '#77775d', 1.2);
      const coastlineLabel = this._label([this.width * .92, this.height * .94], '海岸线', '#716e55');
      this.staticLabels.push(coastlineLabel); this.naturalLabels.push(coastlineLabel);
      if (this.state?.scene === 'border') { line([[0, 0], [this.width, 0]], COLORS.red, 2); this.staticLabels.push(this._label([this.width * .85, this.height * .015], '边境线 / ' + (this.width / 1000).toFixed(0) + ' km', COLORS.red)); }
      this.staticLabels.push(this._label([this.width * .5, this.height * .98], 'N / 北', '#506b77')); this.treeDirty = true;
      for (const sector of map.sectors || []) {
        if (!Array.isArray(sector.bounds) || sector.bounds.length !== 4) continue;
        const [x1, y1, x2, y2] = sector.bounds;
        line([[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]], '#7c98ac', 1, true);
        this.staticLabels.push(this._label([(x1 + x2) / 2, y2 - Math.min(400, (y2 - y1) * .05)],
          `${sector.label} · ${sector.uav_count} 空 / ${sector.ugv_count} 地`, '#526d82'));
      }
    }
    /** 地面障碍只绘制区域标识，不再用树木模型暗示空中碰撞高度。 */
    _rebuildTrees() {
      this.treeModels.forEach((p) => this.viewer.scene.primitives.remove(p)); this.treeModels = [];
      this.treePoints = []; this.dynamicTreePoints = [];
      this.treeDirty = false; this.lastTreeBuild = performance.now();
    }
    _updateGround(map) {
      const layer = this.state.layer || null, grid = layer ? map.layers?.[layer] : null;
      (this.naturalLines || []).forEach(item => { item.show = !layer; });
      (this.naturalLabels || []).forEach(item => { item._htmlShown = !layer; item.show = !layer && !this.options.onLabels; });
      if (this.gridKey === layer && this.gridSource === grid && this.gridTerrainSource === this.terrainTexture) return false;
      let changed = false;
      const uniforms = this.groundMaterial.uniforms;
      if (this.gridTerrainSource !== this.terrainTexture) {
        uniforms.terrainImage = this.terrainTexture;
        this.gridTerrainSource = this.terrainTexture;
        this.performance.terrainUploads += 1;
        changed = true;
      }
      let signature = 'terrain';
      if (grid?.length && grid[0]?.length) {
        let hash = 2166136261;
        for (const row of grid) for (const value of row) hash = Math.imul(hash ^ Math.round(clamp(finite(value), 0, 1) * 65535), 16777619);
        signature = `${layer}:${grid.length}:${grid[0].length}:${hash >>> 0}`;
      }
      if (this.gridKey === layer && this.gridSignature === signature) {
        this.gridSource = grid;
        if (changed) this.performance.groundUploads += 1;
        return changed;
      }
      if (grid?.length && grid[0]?.length) {
        const rows = Math.min(100, grid.length), cols = Math.min(100, grid[0].length);
        const raster = this.layerRaster || (this.layerRaster = canvas(cols, rows));
        if (raster.width !== cols || raster.height !== rows) { raster.width = cols; raster.height = rows; }
        const context = raster.getContext('2d'), image = context.createImageData(cols, rows);
        let palette = this.layerPaletteCache.get(layer);
        if (!palette) {
          palette = []; const color = this.helpers.mapLayerColor || fallbackColor;
          for (let i = 0; i < 256; i += 1) {
            const css = this.C.Color.fromCssColorString(color(layer, i / 255));
            palette.push([Math.round(css.red * 255), Math.round(css.green * 255), Math.round(css.blue * 255)]);
          }
          this.layerPaletteCache.set(layer, palette);
        }
        for (let y = 0; y < rows; y += 1) {
          const row = grid.length - 1 - Math.min(grid.length - 1, Math.floor(y / rows * grid.length));
          for (let x = 0; x < cols; x += 1) {
            const col = Math.min(grid[0].length - 1, Math.floor(x / cols * grid[0].length));
            const value = palette[Math.round(clamp(finite(grid[row]?.[col]), 0, 1) * 255)], index = (y * cols + x) * 4;
            image.data[index] = value[0]; image.data[index + 1] = value[1]; image.data[index + 2] = value[2]; image.data[index + 3] = 255;
          }
        }
        context.putImageData(image, 0, 0);
        if (!this.layerTexture || this.layerTexture.isDestroyed() || this.layerTexture.width !== cols || this.layerTexture.height !== rows) {
          // Material 替换旧纹理时负责销毁已绑定纹理；未绑定的纹理在这里释放。
          if (this.layerTexture && this.groundMaterial._textures.layerImage !== this.layerTexture && !this.layerTexture.isDestroyed()) this.layerTexture.destroy();
          this.layerTexture = new this.C.Texture({ context: this.viewer.scene.context, source: raster,
            sampler: new this.C.Sampler({ minificationFilter: this.C.TextureMinificationFilter.NEAREST, magnificationFilter: this.C.TextureMagnificationFilter.NEAREST }) });
          this.performance.layerTextureCreates = (this.performance.layerTextureCreates || 0) + 1;
        } else {
          // 同一张小纹理原地更新；频繁切图不再创建/销毁 WebGL 纹理资源。
          this.layerTexture.copyFrom({ source: raster });
          this.performance.layerTextureReuses = (this.performance.layerTextureReuses || 0) + 1;
        }
        uniforms.layerImage = this.layerTexture; uniforms.layerSize = new this.C.Cartesian2(cols, rows);
        // 数据图层完全替换自然地表，栅格色阶不与绿色植被或沙岸混合。
        uniforms.layerOpacity = 1;
        this.performance.layerUploads += 1; this.performance.layerUploadPixels += rows * cols;
        this.performance.maxLayerUploadPixels = Math.max(this.performance.maxLayerUploadPixels, rows * cols);
      } else {
        uniforms.layerOpacity = layer ? 1 : 0;
        if (layer) {
          const neutral = canvas(1, 1), context = neutral.getContext('2d');
          context.fillStyle = '#eaf2f7'; context.fillRect(0, 0, 1, 1);
          uniforms.layerImage = neutral; uniforms.layerSize = new this.C.Cartesian2(1, 1);
        }
      }
      this.gridKey = layer; this.gridSource = grid; this.gridSignature = signature; this.gridTerrainSource = this.terrainTexture;
      this.performance.groundUploads += 1; return true;
    }
    _recordPosition(r, now) { if (!r.from) return r.to; const f = r.duration > 0 ? clamp((now - r.started) / r.duration, 0, 1) : 1; return [r.from[0] + (r.to[0] - r.from[0]) * f, r.from[1] + (r.to[1] - r.from[1]) * f, r.to[2]]; }
    _createRecord(item, kind, now) {
      const C = this.C, key = kind + ':' + item.id, h = this._height(item, kind), platform = kind === 'platform';
      const color = platform ? item.type === 'ugv' ? COLORS.ugv : COLORS.uav : item.type === 'facility' ? COLORS.amber : COLORS.red;
      const name = ['uav', 'aerial'].includes(item.type) ? 'uav' : item.type === 'ugv' ? 'ugv' : item.type === 'vehicle' ? 'vehicle' : item.type === 'facility' ? 'facility' : 'person';
      const r = { key, kind, id: item.id, item, color, to: [item.position[0], item.position[1], h], from: null, duration: 0, started: now, heading: 0, matrix: new C.Matrix4() };
      r.entity = { id: key, show: true, position: { getValue: (_time, result) => this._world(r.rendered || r.to, r.to[2], result) } };
      r.label = this.labelCollection.add({ id: key, position: this._world(item.position, h), text: item.label || '#' + item.id,
        font: '600 13px "Microsoft YaHei UI",sans-serif', fillColor: this._color('#ffffff'), outlineColor: this._color('#17384c'),
        outlineWidth: 1, style: C.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: C.HorizontalOrigin.LEFT, verticalOrigin: C.VerticalOrigin.CENTER,
        pixelOffset: new C.Cartesian2(12, -12), showBackground: platform, show: !this.options.onLabels,
        backgroundColor: this._color(item.type === 'ugv' ? '#304c36' : '#03468A', .9), backgroundPadding: new C.Cartesian2(4, 2),
        disableDepthTestDistance: Number.POSITIVE_INFINITY });
      r.selection = this.selectionCollection.add({ id: key, position: this._world(item.position, h), image: this.selectionImages.selected, width: 36, height: 36, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      r.groundMark = this.pointCollection.add({ id: key, position: this._world(item.position), pixelSize: 5, color: this._color(color, .8), outlineColor: this._color('#edf4f6'), outlineWidth: 1, show: h > 0 });
      r.heightLine = this._newLine(this.heightLineCollection, [this._world(item.position), this._world(item.position, h)], color, 1); r.heightLine.show = h > 0;
      this.records.set(key, r); this.performance.modelCreates += 1; this._updateRecordVisual(r, now, true);
      // 沙盘使用固定场景光照，避免平台移动时为每个模型重新生成环境反射贴图。
      C.Model.fromGltfAsync({ url: MODEL_ROOT + name + '.glb', id: key, modelMatrix: r.matrix, minimumPixelSize: platform ? 32 : 24, maximumScale: 10000,
        shadows: C.ShadowMode.DISABLED, environmentMapOptions: { enabled: false }, silhouetteColor: C.Color.WHITE,
        allowPicking: true, incrementallyLoadTextures: false, enableShowOutline: false }).then((model) => {
        if (this.destroyed || this.records.get(key) !== r) { model.destroy(); return; }
        const modelColor = platform ? PLATFORM_MODEL_COLORS.get(item.type)
          : kind === 'target' && ['vehicle', 'aerial'].includes(item.type) ? '#FF0303' : null;
        if (modelColor) {
          model.color = C.Color.fromCssColorString(modelColor);
          model.colorBlendMode = C.ColorBlendMode.REPLACE;
          model.colorBlendAmount = 1;
        }
        r.model = this.viewer.scene.primitives.add(model); this._request();
      }).catch((error) => {
        if (this.destroyed || this.records.get(key) !== r) return;
        // A missing model is isolated to its unit; keep the rest of the 3D scene alive.
        r.modelFailed = true; this.performance.modelFailures += 1;
        r.groundMark.show = true; r.groundMark.pixelSize = 12; r.groundMark.outlineWidth = 2;
        r.label.show = !this.options.onLabels; this._request();
        this.options.onModelError?.(error, { kind, id: item.id, type: item.type });
      });
      return r;
    }
    _removeRecord(r) { if (r.model) this.viewer.scene.primitives.remove(r.model); this.labelCollection.remove(r.label); this.selectionCollection.remove(r.selection); this.pointCollection.remove(r.groundMark); this.heightLineCollection.remove(r.heightLine); this.records.delete(r.key); this.performance.modelRemoves += 1; }
    _updateRecords(now, freshTime) {
      const replayGeneration = this.state.replay?.generation;
      const replayJump = replayGeneration !== undefined && replayGeneration !== this.lastReplayGeneration;
      this.lastReplayGeneration = replayGeneration;
      let changed = false; this.records.forEach((r) => { r.alive = false; });
      const animate = !replayJump && this.state.running && (this.state.dataSource === 'demo' || this.state.connected !== false);
      for (const [kind, items] of [['platform', this.state.platforms || []], ['target', this.state.targets || []]]) for (const item of items) {
        if (!validPoint(item.position) || (kind === 'target' && item.discovered === false)) continue;
        const key = kind + ':' + item.id; let r = this.records.get(key); if (!r) { r = this._createRecord(item, kind, now); changed = true; } r.alive = true; r.item = item;
        const next = [item.position[0], item.position[1], this._height(item, kind)];
        const poseChanged = next.some((v, i) => v !== r.to[i]);
        if (poseChanged) { r.from = this._recordPosition(r, now); r.to = next; r.duration = animate ? clamp(now - (r.lastInput || now - 240), 80, 300) : 0; r.started = now; changed = true; }
        if (!animate) { if (r.duration) changed = true; r.from = null; r.duration = 0; }
        if (freshTime) r.lastInput = now; const v = item.velocity || [0, 0], before = r.heading;
        if (Math.hypot(finite(v[0]), finite(v[1])) > .05) r.heading = Math.atan2(v[1], v[0]);
        else if (validPoint(item.target) && Math.hypot(item.target[0] - item.position[0], item.target[1] - item.position[1]) > 1) r.heading = Math.atan2(item.target[1] - item.position[1], item.target[0] - item.position[0]);
        if (before !== r.heading) changed = true;
        this._updateRecordVisual(r, now, poseChanged || before !== r.heading);
      }
      for (const r of this.records.values()) if (!r.alive) { this._removeRecord(r); changed = true; } return changed;
    }
    _updateRecordVisual(r, now, force = false) {
      const C = this.C, p = this._recordPosition(r, now), selected = this._selected(r.kind, r.id), change = force || this.modelsDirty || !r.rendered || p.some((v, i) => v !== r.rendered[i]); r.rendered = p;
      if (change) {
        const world = this._world(p, p[2]), q = C.Transforms.headingPitchRollQuaternion(world, new C.HeadingPitchRoll(Math.PI / 2 - r.heading, 0, 0));
        C.Matrix4.fromTranslationQuaternionRotationScale(world, q, new C.Cartesian3(1, 1, 1), r.matrix); if (r.model) r.model.modelMatrix = r.matrix;
        r.label.position = world; r.selection.position = world; r.groundMark.position = this._world(p);
        if (p[2] > 0) { r.heightLine.positions = [this._world(p), world]; this.performance.heightLineUpdates += 1; }
      }
      const mark = this.emphasis.get(r.key);
      const labelShown = r.kind === 'platform' || mark || this.cameraState.distance < 3500;
      const labelText = r.item.label || '#' + r.id;
      const styleKey = [selected, mark, labelShown, labelText, this.modelSize, Boolean(r.model), Boolean(r.modelFailed), p[2]].join('|');
      if (styleKey !== r.styleKey) {
        r.styleKey = styleKey;
        const image = this.selectionImages[mark];
        r.entity.show = true; r.selection.show = Boolean(image); r.heightLine.show = p[2] > 0;
        if (image && r.selectionMark !== mark) {
          r.selection.setImage(mark, image);
          r.selection.width = r.selection.height = mark === 'high' || mark === 'medium' ? 44 : 36;
          r.selectionMark = mark;
        }
        r.groundMark.show = p[2] > 0 || Boolean(r.modelFailed);
        if (r.modelFailed) {
          r.groundMark.outlineColor = selected ? C.Color.WHITE : this._color('#edf4f6');
          r.groundMark.outlineWidth = selected ? 3 : 2;
        }
        r.heightLine.width = selected ? 1.6 : 1; r.heightLine.material.uniforms.color = this._color(r.color, selected ? .85 : .48);
        r.label.show = labelShown && !this.options.onLabels; r.label.text = labelText; r.label.fillColor = this._color('#ffffff');
        if (!r.labelOffset) r.labelOffset = new C.Cartesian2(12, -12); r.label.pixelOffset = r.labelOffset;
        if (r.model) {
          r.model.show = true;
          r.model.minimumPixelSize = r.kind === 'platform' ? 32 : 24;
          r.model.silhouetteSize = selected ? 2 : 0;
        }
      }
    }
    _remainingRoute(item) {
      if (this.helpers.remainingPlannedRoute) return this.helpers.remainingPlannedRoute(item);
      if (!validPoint(item.target) || ['IDLE', 'ARRIVED', 'WAITING_FOR_DECISION'].includes(item.navigation?.state)) return [];
      const p = item.navigation?.smoothed_path; if (!Array.isArray(p) || p.length < 2) return [item.position, item.target];
      return [item.position, ...p.slice(clamp(finite(item.navigation.nearest_path_index ?? item.navigation.path_index), 0, p.length - 1) + 1)];
    }
    _routeFor(item) {
      const nav = item.navigation || {}, path = nav.smoothed_path;
      if (!validPoint(item.position) || !validPoint(item.target)
        || ['IDLE', 'ARRIVED', 'WAITING_FOR_DECISION'].includes(nav.state)) return [];
      if (!Array.isArray(path) || path.length < 2) {
        return this.helpers.remainingPlannedRoute ? this.helpers.remainingPlannedRoute(item) : [item.position, item.target];
      }

      let cached = this.routeCache.get(item.id);
      const pathVersion = nav.path_version ?? path;
      if (!cached || cached.pathVersion !== pathVersion) {
        const cumulative = new Float64Array(path.length);
        for (let i = 1; i < path.length; i += 1) {
          cumulative[i] = cumulative[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
        }
        this.performance.routeMetricBuilds += 1;
        cached = { pathVersion, path, cumulative, segment: -1, points: [] };
        this.routeCache.set(item.id, cached);
      }

      let first = 0, last = path.length - 2;
      if (nav.tracking_path_length_m > 0 && Number.isFinite(nav.path_progress_m)) {
        const progress = Number(nav.path_progress_m) + .001, cumulative = cached.cumulative;
        let low = 1, high = cumulative.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (cumulative[middle] <= progress) low = middle + 1; else high = middle;
        }
        first = Math.min(path.length - 2, low - 1);
        last = Math.min(path.length - 2, first + 1);
      } else {
        const index = nav.nearest_path_index ?? nav.path_index;
        if (Number.isInteger(index)) {
          first = Math.max(0, Math.min(path.length - 2, index - 1));
          last = Math.min(path.length - 2, index + 1);
        }
      }

      let segment = first, nearestDistance = Infinity;
      for (let i = first; i <= last; i += 1) {
        const [x, y] = path[i], dx = path[i + 1][0] - x, dy = path[i + 1][1] - y;
        const lengthSquared = dx * dx + dy * dy;
        const ratio = lengthSquared > 0
          ? clamp(((item.position[0] - x) * dx + (item.position[1] - y) * dy) / lengthSquared, 0, 1) : 0;
        const distance = Math.hypot(item.position[0] - x - ratio * dx, item.position[1] - y - ratio * dy);
        if (distance < nearestDistance - .001) { nearestDistance = distance; segment = i; }
      }
      if (cached.segment !== segment) {
        cached.segment = segment;
        cached.points = [item.position, ...path.slice(segment + 1).filter(validPoint)];
      } else cached.points[0] = item.position;
      return cached.points;
    }
    _syncCueGeometry(state, map) {
      const shown = state.overlays?.cues !== false;
      const cues = map.cues || [];
      const geometryKey = JSON.stringify([shown, shown ? cues.map((cue) => [cue.id, cue.position, cue.radius]) : []]);
      if (geometryKey === this.cueGeometryKey) return;
      this.cueGeometryKey = geometryKey;
      this.performance.cueGeometryRebuilds += 1;
      this.cueLines.forEach((line) => this.lineCollection.remove(line));
      this.cueLabels.forEach((label) => this.labelCollection.remove(label));
      this.cueLines = []; this.cueLabels = [];
      if (!shown) return;
      for (const cue of cues) {
        if (!validPoint(cue.position)) continue;
        const points = this._circlePoints(cue.position, finite(cue.radius, 80));
        this.cueLines.push(this._newLine(this.lineCollection,
          points.map((point) => this._world(point, .08, undefined, false)), COLORS.amber, 1.3, true));
        this.cueLabels.push(this._label(cue.position, '线索 #' + cue.id, COLORS.amber));
      }
    }
    _updateOverlays() {
      const s = this.state, map = s.map || {}, selectedId = s.selected?.type === 'platform' ? s.selected.id : null; this.performance.overlayRebuilds += 1;
      const refreshHistory = this.historyOverlayDue;
      this.lines.forEach((e) => { e.alive = false; }); this.routeArrowSamples = [];
      const liveRouteIds = new Set();
      for (const item of [...(s.platforms || [])].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId))) {
        if (!validPoint(item.position)) continue; const selected = selectedId === item.id, color = item.type === 'ugv' ? COLORS.ugv : COLORS.uav, z = this._height(item, 'platform') || .04;
        const trackKey = 'track:' + item.id, trackColor = selected ? color : item.type === 'ugv' ? COLORS.trackUgv : COLORS.trackUav,
          trackWidth = selected ? 2 : 1.2, tracksVisible = s.overlays?.platformTracks !== false;
        if (!tracksVisible || refreshHistory || !this._retainHistoryLine(trackKey, true, trackColor, trackWidth))
          this._lineFor(trackKey, this._recentTrack(item), z, trackColor, trackWidth, false, tracksVisible);
        this._lineFor('raw:' + item.id, item.navigation?.raw_path || [], z, '#8a969d', 1, true, Boolean(s.overlays?.rawPaths));
        if (s.overlays?.routes !== false) {
          const p = this._routeFor(item);
          liveRouteIds.add(item.id);
          if (p.length > 1) this.routeArrowSamples.push({ id: item.id, points: p, z, color, selected });
        }
        if (s.overlays?.safety && selected) this._lineFor('safety:' + item.id, this._circlePoints(item.position, finite(item.navigation?.min_separation_m, 100) / 2), z, '#8c9687', 1, true);
        if (s.overlays?.lookahead && validPoint(item.navigation?.lookahead_point)) this._lineFor('look:' + item.id, [item.position, item.navigation.lookahead_point], z, COLORS.amber, 1, true);
      }
      for (const [id, cached] of this.routeCache) if (!liveRouteIds.has(id)) this.routeCache.delete(id);
      for (const item of s.targets || []) {
        const key = 'target-track:' + item.id;
        if (item.discovered === false) { const entry = this.lines.get(key); if (entry) entry.alive = false; continue; }
        const targetsVisible = s.overlays?.targets !== false;
        if (!targetsVisible || refreshHistory || !this._retainHistoryLine(key, true, COLORS.red, 1))
          this._lineFor(key, item.track || [], this._height(item, 'target') || .05, COLORS.red, 1, true, targetsVisible);
      }

      this._syncCueGeometry(s, map);
      const restrictionVisible = s.overlays?.restrictions !== false;
      const restrictionKey = JSON.stringify([restrictionVisible, map.no_fly_zones, map.dynamic_obstacles, map.core_area, map.border_area]);
      if (restrictionKey !== this.restrictionGeometryKey) {
        this.restrictionGeometryKey = restrictionKey;
        this.performance.restrictionGeometryRebuilds += 1;
        this.regionLines.forEach((line) => this.lineCollection.remove(line));
        this.regionLabels.forEach((label) => this.labelCollection.remove(label));
        this.regionLines = []; this.regionLabels = [];
        const add = (points, color, label, center) => {
          this.regionLines.push(this._newLine(this.lineCollection,
            points.map((point) => this._world(point, .08, undefined, false)), color, 1.3, true));
          if (label) this.regionLabels.push(this._label(center, label, color));
        };
        if (restrictionVisible) {
          for (const obstacle of map.no_fly_zones || []) if (validPoint(obstacle.center)) add(this._circlePoints(obstacle.center, finite(obstacle.radius, 1)), COLORS.red, '禁飞区', obstacle.center);
          for (const obstacle of map.dynamic_obstacles || []) if (validPoint(obstacle.center)) add(this._circlePoints(obstacle.center, finite(obstacle.radius, 1)), COLORS.amber, '临时障碍', obstacle.center);
          for (const [area, label, color] of [[map.core_area, '核心区', COLORS.red], [map.border_area, '巡检区域', COLORS.uav]]) {
            if (!Array.isArray(area) || area.length !== 4) continue;
            const [x1, y1, x2, y2] = area;
            add([[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]], color, label, [(x1 + x2) / 2, y2]);
          }
        }
      }
      const dynamicTreeKey = JSON.stringify(restrictionVisible
        ? (map.dynamic_obstacles || []).map((obstacle) => [obstacle.id, obstacle.center, obstacle.radius]) : []);
      if (dynamicTreeKey !== this.dynamicTreeGeometryKey) {
        this.dynamicTreeGeometryKey = dynamicTreeKey;
        this.dynamicTreePoints = [];
        this.treeDirty = true;
        this.performance.dynamicTreeInvalidations += 1;
      }
      this.lines.forEach((e, key) => { if (!e.alive) { this.lineCollection.remove(e.line); this.lines.delete(key); } }); this.routeDirty = true;
      this.historyOverlayDue = false;
      this.overlayRefreshPending = false; this.lastOverlayAt = performance.now();
    }
    _recentTrack(item) {
      if (this.helpers.recentPlatformTrack) {
        const recent = this.helpers.recentPlatformTrack(item);
        return recent?.points || recent || [];
      }
      const points = item.track || [], times = item.track_times;
      if (Array.isArray(times) && times.length === points.length) {
        const cutoff = finite(this.state.elapsed) - 60;
        let first = 0; while (first < times.length && times[first] < cutoff) first += 1;
        return points.slice(first);
      }
      return points.slice(-Math.max(2, Math.ceil(60 / Math.max(.01, finite(this.state.dt, 1))) + 1));
    }
    _updateArrows() {
      const C = this.C, scene = this.viewer.scene, baseSpacing = Math.max(1, this.cameraState.distance / Math.max(160, this.container.clientHeight) * .8 * 24);
      const routeBudget = Math.max(10, Math.min(90, Math.floor(260 / Math.max(1, this.routeArrowSamples.length)))); let used = 0, sampled = 0;
      const width = this.container.clientWidth, height = this.container.clientHeight, margin = 20;
      const camera = this.viewer.camera, planes = camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC).planes;
      const worldA = this.arrowWorldA || (this.arrowWorldA = new C.Cartesian3()), worldB = this.arrowWorldB || (this.arrowWorldB = new C.Cartesian3());
      const skipSegment = (carry, length, spacing) => ((carry - length) % spacing + spacing) % spacing;
      for (const route of this.routeArrowSamples) {
        if (!this.arrowImages.has(route.color)) this.arrowImages.set(route.color, markerImage(true, route.color));
        let routeLength = 0; for (let i = 1; i < route.points.length; i += 1) routeLength += Math.hypot(route.points[i][0] - route.points[i - 1][0], route.points[i][1] - route.points[i - 1][1]);
        const spacing = Math.max(baseSpacing, routeLength / routeBudget);
        let carry = spacing * .45, perRoute = 0;
        for (let i = 1; i < route.points.length && sampled < 260 && perRoute < routeBudget; i += 1) {
          const a = route.points[i - 1], b = route.points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]); if (length < .01) continue;
          this._world(a, route.z, worldA); this._world(b, route.z, worldB);
          // 近景中绝大部分完整规划路线位于屏幕外，先用六个裁剪平面剔除，
          // 不再为了不可见路线反复做 Cesium 屏幕投影或生成箭头。
          const outside = planes.some(plane => plane.x * worldA.x + plane.y * worldA.y + plane.z * worldA.z + plane.w < 0
            && plane.x * worldB.x + plane.y * worldB.y + plane.z * worldB.z + plane.w < 0);
          if (outside) { carry = skipSegment(carry, length, spacing); this.performance.arrowSegmentsCulled = (this.performance.arrowSegmentsCulled || 0) + 1; continue; }
          const sa = C.SceneTransforms.worldToWindowCoordinates(scene, worldA), sb = C.SceneTransforms.worldToWindowCoordinates(scene, worldB);
          this.performance.arrowSegmentProjections += 2;
          if (!sa || !sb) { carry = skipSegment(carry, length, spacing); continue; }
          const rotation = sa && sb ? -Math.atan2(sb.y - sa.y, sb.x - sa.x) : 0;
          // A segment bounding-box check is enough for viewport culling. Projecting every
          // arrow separately multiplied Cesium coordinate transforms by the arrow count.
          const segmentVisible = Math.max(sa.x, sb.x) >= -margin && Math.min(sa.x, sb.x) <= width + margin
            && Math.max(sa.y, sb.y) >= -margin && Math.min(sa.y, sb.y) <= height + margin;
          while (carry <= length && sampled < 260 && perRoute < routeBudget) {
            const f = carry / length;
            if (segmentVisible) {
              const world = this._world([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], route.z, this.routeWorldScratch);
              let arrow = this.arrowPool[used]; if (!arrow) { arrow = this.arrowCollection.add({ width: 16, height: 9, disableDepthTestDistance: Number.POSITIVE_INFINITY }); this.arrowPool.push(arrow); }
              // 直接给 image 赋 Canvas 会生成新 ID，纹理图集会随每次刷新持续增长。
              if (arrow.image !== route.color) arrow.setImage(route.color, this.arrowImages.get(route.color));
              arrow.position = world; arrow.rotation = rotation; arrow.show = true;
              arrow.width = route.selected ? 18 : 16; arrow.height = route.selected ? 10 : 9;
              used += 1; perRoute += 1;
            } else perRoute += 1;
            sampled += 1;
            carry += spacing;
          }
          carry -= length;
        }
      }
      for (let i = used; i < this.arrowPool.length; i += 1) this.arrowPool[i].show = false;
      this.visibleArrowCount = used; this.routeDirty = false; this.lastArrowUpdate = performance.now(); this.performance.arrowUpdates += 1;
    }
    _installInput() {
      const element = this.viewer.canvas; this.events = [];
      const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this.events.push(() => target.removeEventListener(type, fn, opts)); };
      listen(element, 'webglcontextlost', (event) => {
        event.preventDefault();
        this.contextLost = true; this.contextLossCount += 1;
        if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
        this.viewer.useDefaultRenderLoop = false;
        this.options.onContextState?.('lost', { count: this.contextLossCount });
      });
      listen(element, 'webglcontextrestored', () => {
        if (this.destroyed) return;
        this.contextLost = false; this.renderErrorStreak = 0;
        if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
        // Cesium may resume its loop while its old GPU resources remain invalid.
        // Keep it stopped until the owner replaces this Viewer.
        this.viewer.useDefaultRenderLoop = false;
        this.options.onContextState?.('restored', { count: this.contextLossCount });
      });
      listen(element, 'contextmenu', (e) => e.preventDefault());
      listen(element, 'pointerdown', (e) => { if (![0, 1, 2].includes(e.button)) return; this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, button: e.button, moved: false }; element.setPointerCapture(e.pointerId); e.preventDefault(); });
      listen(element, 'pointermove', (e) => {
        const p = this.pointer; if (!p || p.id !== e.pointerId) return; const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 4) p.moved = true; if (!p.moved) return;
        this._noteCameraInteraction();
        const followed = this.mode === 'follow' ? this._followRecord() : null;
        // 跟随中拖动只调整观察方向或相对偏移，不解除单位绑定。
        if (!followed) {
          if (this.mode === 'follow') this.freeTargetHeight = this.lastTargetHeight || 0;
          this.mode = 'free';
        }
        if (p.button !== 0 || e.shiftKey) { this.cameraState.yaw -= dx * .006; this.cameraState.pitch = clamp(this.cameraState.pitch + dy * .005, .12, Math.PI / 2 - .002); }
        else {
          const f = this.cameraState.distance / Math.max(100, this.container.clientHeight) * .9, a = this.cameraState.yaw;
          const offsetX = -(Math.cos(a) * dx + Math.sin(a) * dy) * f;
          const offsetY = (-Math.sin(a) * dx + Math.cos(a) * dy) * f;
          if (followed) {
            this.followOffset.x = clamp(this.followOffset.x + offsetX, -this.width * .5, this.width * .5);
            this.followOffset.y = clamp(this.followOffset.y + offsetY, -this.height * .5, this.height * .5);
            const target = this._recordPosition(followed, performance.now());
            this.cameraState.x = target[0] + this.followOffset.x;
            this.cameraState.y = target[1] + this.followOffset.y;
          } else {
            this.cameraState.x = clamp(this.cameraState.x + offsetX, -this.width * .5, this.width * 1.5);
            this.cameraState.y = clamp(this.cameraState.y + offsetY, -this.height * .5, this.height * 1.5);
          }
        }
        p.x = e.clientX; p.y = e.clientY; this.cameraDirty = true; this._request();
      });
      const release = (e) => { const p = this.pointer; if (!p || p.id !== e.pointerId) return; this.pointer = null; if (p.moved) this._noteCameraInteraction(); if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
        if (!p.moved && p.button === 0 && e.type !== 'pointercancel') {
          const rect = element.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
          const pick = this.viewer.scene.pick(new this.C.Cartesian2(x, y)), entity = pick?.id || pick?.primitive?.id;
          const id = typeof entity === 'string' ? entity : entity?.id;
          const match = /^(platform|target):(\d+)/.exec(id || '');
          const selection = match ? { type: match[1], id: Number(match[2]) } : null;
          const handled = this.options.onPick?.(selection, () => {
            const ground = this._groundIntersection(x, y);
            return ground ? this._local(ground).slice(0, 2) : null;
          });
          if (selection && !handled) this.options.onSelect?.(selection);
        }
      };
      listen(element, 'pointerup', release); listen(element, 'pointercancel', release);
      listen(element, 'wheel', (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); this._noteCameraInteraction(); const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.container.clientHeight : 1; this.zoomBy(Math.exp(-clamp(e.deltaY * unit, -240, 240) * .0018)); }, { passive: false });
      listen(element, 'dblclick', (e) => e.preventDefault());
    }
    _cameraInteracting(now = performance.now()) { return Boolean(this.pointer?.moved || now < this.interactionUntil); }
    _noteCameraInteraction() {
      this.interactionUntil = performance.now() + 180;
      if (this.interactionTimer !== null) clearTimeout(this.interactionTimer);
      this.interactionTimer = setTimeout(() => {
        this.interactionTimer = null;
        if (this.destroyed || this.pointer?.moved) return;
        this.interactionUntil = 0; this.cameraDirty = true; this.overlayRefreshPending = true;
        this.historyOverlayDue = true; this._request();
      }, 190);
    }
    _applyCamera() {
      // 固定视觉倍率35，旋转、缩放不再触发高度与历史几何重建。
      const C = this.C, v = this.cameraState;
      const followed = this.mode === 'follow' ? this._followRecord() : null;
      if (this.mode === 'follow' && !followed) {
        // 取消选择可能与详情栏收起同时发生，自由视角沿用跟随时的高度。
        this.freeTargetHeight = this.lastTargetHeight || 0;
        this.mode = 'free';
      }
      const h = followed ? followed.to[2] * this.heightScale : this.mode === 'free' ? this.freeTargetHeight || 0 : 0;
      this.lastTargetHeight = h;
      const horizontal = Math.cos(v.pitch) * v.distance;
      const destination = this._world([v.x + Math.sin(v.yaw) * horizontal, v.y - Math.cos(v.yaw) * horizontal], h + Math.sin(v.pitch) * v.distance, undefined, false), target = this._world([v.x, v.y], h, undefined, false);
      const direction = C.Cartesian3.normalize(C.Cartesian3.subtract(target, destination, new C.Cartesian3()), new C.Cartesian3()), up = C.Matrix4.multiplyByPointAsVector(this.frame, C.Cartesian3.UNIT_Z, new C.Cartesian3());
      this.viewer.camera.setView({ destination, orientation: { direction, up } }); this.cameraDirty = false; this.routeDirty = true; this._notifyView();
    }
    _followRecord() { const s = this.state?.selected; return s && ['platform', 'target'].includes(s.type) ? this.records.get(s.type + ':' + s.id) : undefined; }
    _renderFrame() {
      if (this.destroyed || !this.visible) return; const now = performance.now(); let moving = false;
      if (this.mode === 'follow') {
        const r = this._followRecord();
        if (r) {
          const p = this._recordPosition(r, now), x = p[0] + this.followOffset.x, y = p[1] + this.followOffset.y;
          if (Math.abs(this.cameraState.x - x) > .01 || Math.abs(this.cameraState.y - y) > .01
            || Math.abs(r.to[2] * this.heightScale - (this.lastTargetHeight || 0)) > .01) {
            this.cameraState.x = x; this.cameraState.y = y; this.cameraDirty = true;
          }
        } else this.cameraDirty = true;
      }
      if (this.cameraDirty) this._applyCamera();
      this.records.forEach((r) => { this._updateRecordVisual(r, now); if (r.from && now < r.started + r.duration) moving = true; }); this.modelsDirty = false;
      this._updateInfoPanel();
      const cameraBusy = this._cameraInteracting(now);
      if ((this.heightDirty || this.overlayRefreshPending) && (!cameraBusy || now - this.lastOverlayAt >= 400)) {
        this.heightDirty = false; this.historyOverlayDue = !cameraBusy || now - this.lastHistoryOverlayAt >= 1000;
        if (this.historyOverlayDue) this.lastHistoryOverlayAt = now; this._updateOverlays();
      }
      if (this.treeDirty && now - (this.lastTreeBuild || 0) > 180) this._rebuildTrees();
      if (this.routeDirty && now - (this.lastArrowUpdate || 0) > (cameraBusy ? 180 : 90)) this._updateArrows();
      if (moving || this.cameraDirty || this.routeDirty || this.treeDirty || this.overlayRefreshPending) this._request();
    }
    _updateInfoPanel() {
      const selection = this.state?.selected;
      const record = selection && ['platform', 'target'].includes(selection.type)
        ? this.records.get(selection.type + ':' + selection.id) : null;
      const zoom = this._fittedDistance('overview') / Math.max(1, this.cameraState.distance);
      const show = this.visible && Boolean(record) && (record.kind === 'target' || this.mode === 'follow' || zoom >= 1.45);
      this.infoPanel.hidden = !show;
      if (!show) return;

      const item = record.item, height = record.to[2];
      const hostile = record.kind === 'target' && ['vehicle', 'aerial'].includes(item.type);
      const readoutColor = hostile ? '#ff9694' : '#9dd8ef';
      if (this.infoPanel.style.getPropertyValue('--readout-color') !== readoutColor) this.infoPanel.style.setProperty('--readout-color', readoutColor);
      this.infoPanel.classList.toggle('hostile-readout', hostile);
      const velocity = item.velocity || [0, 0], speed = this._groundedAerial(item, record.kind) ? 0
        : finite(item.speed, Math.hypot(finite(velocity[0]), finite(velocity[1])));
      const rawHeading = Number.isFinite(Number(item.heading)) ? Number(item.heading)
        : Math.atan2(finite(velocity[1]), finite(velocity[0])) * 180 / Math.PI;
      const heading = (rawHeading % 360 + 360) % 360;
      const type = item.type === 'uav' ? '无人机' : item.type === 'ugv' ? '无人车'
        : item.type === 'vehicle' ? '入侵车辆' : item.type === 'aerial' ? '入侵无人机' : item.type === 'facility' ? '设施目标' : '人员目标';
      const updateText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
      updateText(this.infoPanelTitle, `${item.label || `${type} #${record.id}`} · ${type}`);
      updateText(this.infoPanelFields.get('altitude'), `${height.toFixed(1)} m`);
      updateText(this.infoPanelFields.get('speed'), `${speed.toFixed(1)} m/s`);
      updateText(this.infoPanelFields.get('heading'), `${String(Math.round(heading)).padStart(3, '0')}°`);
      const batteryRow = this.infoPanel.querySelector('[data-row="battery"]');
      if (record.kind === 'platform') {
        if (batteryRow.hidden) batteryRow.hidden = false;
        updateText(this.infoPanelFields.get('battery'), `${finite(item.battery).toFixed(0)}%`);
      } else if (!batteryRow.hidden) batteryRow.hidden = true;

      const position = this.C.SceneTransforms.worldToWindowCoordinates(
        this.viewer.scene, this._world(record.rendered || record.to, height), this.panelPositionScratch || (this.panelPositionScratch = new this.C.Cartesian2()));
      if (!position) { this.infoPanel.hidden = true; return; }
      const panelWidth = 208, panelHeight = 98;
      const left = position.x + 28 + panelWidth <= this.container.clientWidth - 4 ? position.x + 28 : position.x - panelWidth - 24;
      const leftValue = `${clamp(left, 4, Math.max(4, this.container.clientWidth - panelWidth - 4))}px`;
      const topValue = `${clamp(position.y - panelHeight * .5, 4, Math.max(4, this.container.clientHeight - panelHeight - 42))}px`;
      if (this.infoPanel.style.left !== leftValue) this.infoPanel.style.left = leftValue;
      if (this.infoPanel.style.top !== topValue) this.infoPanel.style.top = topValue;
    }
    _handleRenderError(error) {
      if (this.destroyed || this.contextLost) return;
      this.renderErrorStreak += 1;
      if (this.renderErrorStreak > 1) { this.options.onFatalError?.(error); return; }
      // Stop a failing render loop briefly, then retry once. A recovered frame clears the streak.
      this.viewer.useDefaultRenderLoop = false;
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        if (this.destroyed || this.contextLost) return;
        try {
          this.viewer.resize(); this.viewer.useDefaultRenderLoop = this.visible; this._request();
          this.options.onRecoverableError?.(error);
        } catch (recoveryError) { this.options.onFatalError?.(recoveryError); }
      }, 180);
    }
    _sampleFrameQuality(now) {
      const q = this.quality;
      if (q.lastFrame) q.samples.push(now - q.lastFrame);
      q.lastFrame = now;
      if (q.samples.length < 90 || now - q.lastAdjustment < 1500) return;
      const mean = q.samples.reduce((sum, value) => sum + value, 0) / q.samples.length;
      q.fps = mean > 0 ? 1000 / mean : 0; q.samples.length = 0; q.lastAdjustment = now;
      const target = this._baseResolutionScale();
      let next = q.scale;
      if (q.fps < 28) next = Math.max(target, q.scale * .98);
      else if (q.fps > 48) next = Math.min(target, q.scale + .08);
      if (Math.abs(next - q.scale) < .015) return;
      q.scale = next; this.viewer.resolutionScale = next; this.performance.qualityFps = q.fps;
      this._request();
    }
    _baseResolutionScale() {
      const pixels = Math.max(1, this.container.clientWidth * this.container.clientHeight);
      const budget = this.records.size > 64 ? 2600000 : 2200000;
      return Math.max(.95, Math.min(1, Math.sqrt(budget / pixels)));
    }
    _notifyView() {
      // 跟随平移不改变缩放、方向和高度倍率，避免逐帧重写地图工具条 DOM。
      const key = [this.mode, this.cameraState.yaw, this.cameraState.pitch, this.cameraState.distance,
        this.heightScale, this.heightMode, this.modelSize, this.container.clientWidth, this.container.clientHeight].join(':');
      if (key === this.viewNoticeKey) return;
      this.viewNoticeKey = key;
      const v = this.cameraState, w = this.viewer.canvas.clientWidth, h = this.viewer.canvas.clientHeight, meters = this._metersPerPixel(w * .5, Math.max(4, h - 38)) || this._metersPerPixel(w * .5, h * .5) || v.distance / Math.max(100, h) * .9;
      const distance = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].reduce((best, x) => Math.abs(x / meters - 72) < Math.abs(best / meters - 72) ? x : best, 1);
      this.options.onViewChange?.({ zoom: this._fittedDistance('overview') / v.distance, label: this.mode === 'follow' ? '跟随' : this.mode === 'top' ? '俯视' : this.mode === 'overview' ? '全域' : '自由', headingDegrees: (v.yaw * 180 / Math.PI % 360 + 360) % 360, scaleMeters: distance, scalePixels: distance / meters, heightScale: this.heightScale, heightMode: this.heightMode, modelSize: this.modelSize });
    }
    _metersPerPixel(x, y) { if (this.viewer.canvas.clientWidth < 2 || this.viewer.canvas.clientHeight < 2) return 0; const a = this._groundIntersection(x, y), b = this._groundIntersection(x + 1, y); return a && b ? this.C.Cartesian3.distance(a, b) : 0; }
    _groundIntersection(x, y) { const C = this.C, ray = this.viewer.camera.getPickRay(new C.Cartesian2(x, y)); if (!ray) return null; const center = this._world([0, 0]), normal = C.Matrix4.multiplyByPointAsVector(this.frame, C.Cartesian3.UNIT_Z, new C.Cartesian3()), denominator = C.Cartesian3.dot(normal, ray.direction); if (Math.abs(denominator) < 1e-8) return null; const d = C.Cartesian3.dot(normal, C.Cartesian3.subtract(center, ray.origin, new C.Cartesian3())) / denominator; return d > 0 ? C.Ray.getPoint(ray, d, new C.Cartesian3()) : null; }
    update(state) {
      if (this.destroyed || !state?.map) return; const now = performance.now(), map = state.map, key = (state.sessionId || 'demo') + ':' + state.scene + ':' + (state.sessionMode || 'mission'), fresh = key !== this.sessionKey, freshTime = this.lastSimTime !== state.elapsed;
      const presentation = this.heightMode !== 'fixed35' || this.modelSize !== 'normal';
      this.heightMode = 'fixed35'; this.heightScale = DISPLAY_HEIGHT_SCALE; this.modelSize = 'normal'; this.state = state;
      if (fresh) {
        this.sessionKey = key; [...this.records.values()].forEach((r) => this._removeRecord(r));
        this.lines.forEach((entry) => { entry.key = ''; entry.rawRef = null; });
        this.width = Math.max(1, finite(map.width, 10000)); this.height = Math.max(1, finite(map.height, 10000));
        this.staticKey = ''; this.cueGeometryKey = null; this.restrictionGeometryKey = null; this.dynamicTreeGeometryKey = null; this.routeCache.clear(); this.freeTargetHeight = 0; this.lastTargetHeight = 0;
        this.followOffset.x = 0; this.followOffset.y = 0;
        this._makeGround(); this.setView('overview');
      }
      const staticKey = JSON.stringify([map.width, map.height, map.roads, map.obstacles, map.sectors]); if (staticKey !== this.staticKey) { this.staticKey = staticKey; this._rebuildStatic(map); }
      this.emphasis = this.helpers.mapEmphasis?.() || this.emphasis;
      const point = this.helpers.navigationPoint?.();
      const taskPoint = validPoint(point) ? point : null;
      const emphasisKey = JSON.stringify([...this.emphasis, taskPoint]);
      const emphasisChanged = emphasisKey !== this.emphasisKey;
      if (emphasisChanged || fresh) {
        this.emphasisKey = emphasisKey;
        this.taskMarker.show = Boolean(taskPoint);
        if (taskPoint) this.taskMarker.position = this._world(taskPoint, .08, undefined, false);
      }
      const selectionKey = state.selected?.type + ':' + state.selected?.id, overlayKey = JSON.stringify(state.overlays || {}), interaction = presentation || selectionKey !== this.selectionKey || overlayKey !== this.overlayKey;
      // 暂停中也可能注入目标或重新规划；检查轻量元数据，不序列化整段历史。
      const intentKey = (state.platforms || []).map((p) => [p.id, p.target?.[0], p.target?.[1], p.navigation?.path_version, p.navigation?.state,
        p.navigation?.nearest_path_index, p.navigation?.path_index, p.navigation?.path_progress_m, p.track?.length, p.track?.at(-1)?.[0], p.track?.at(-1)?.[1]].join(',')).join('|')
        + ':' + (state.targets || []).map((p) => [p.id, p.track?.length, p.track?.at(-1)?.[0], p.track?.at(-1)?.[1], p.discovered].join(',')).join('|');
      // Cue confidence decays with time, but cue geometry only changes when a source moves,
      // changes radius, appears, or expires. Cue sync has its own geometry key.
      const regionInputKey = JSON.stringify([map.no_fly_zones, map.dynamic_obstacles, map.core_area, map.border_area]);
      if (presentation) { this.cameraDirty = true; this.modelsDirty = true; } if (this.cameraDirty) this._applyCamera();
      const cameraBusy = this._cameraInteracting(now);
      this.historyOverlayDue = fresh || interaction || this.heightDirty || now - this.lastHistoryOverlayAt >= (cameraBusy ? 1000 : 500);
      if (this.historyOverlayDue) this.lastHistoryOverlayAt = now;
      const groundChanged = this._updateGround(map), changed = this._updateRecords(now, freshTime);
      this._updateResolution();
      const intentChanged = intentKey !== this.intentKey || regionInputKey !== this.regionInputKey;
      if (freshTime || fresh || interaction || changed || intentChanged || map.obstacle_version !== this.obstacleVersion || this.heightDirty) {
        if (cameraBusy && !fresh && !interaction && now - this.lastOverlayAt < 400) { this.overlayRefreshPending = true; this.performance.overlayDeferrals = (this.performance.overlayDeferrals || 0) + 1; }
        else { this.heightDirty = false; this._updateOverlays(); }
      }
      this.intentKey = intentKey; this.regionInputKey = regionInputKey;
      this.selectionKey = selectionKey; this.overlayKey = overlayKey; this.obstacleVersion = map.obstacle_version; this.lastSimTime = state.elapsed;
      if (this.treeDirty) this._rebuildTrees(); if (this.routeDirty && (!cameraBusy || now - this.lastArrowUpdate > 180)) this._updateArrows(); this.modelsDirty = false;
      if (changed || fresh || freshTime || interaction || intentChanged || groundChanged || emphasisChanged) this._request();
      const cost = performance.now() - now; this.performance.updateMs = cost; this.performance.maxUpdateMs = Math.max(this.performance.maxUpdateMs, cost);
    }
    _updateResolution() {
      // 大场景优先维持交互响应，模型仍完整保留，仅限制渲染像素总量。
      const scale = this._baseResolutionScale();
      this.quality.scale = Math.min(this.quality.scale || scale, scale);
      if (Math.abs(this.viewer.resolutionScale - this.quality.scale) > .001) this.viewer.resolutionScale = this.quality.scale;
    }
    resize() {
      if (this.destroyed) return;
      this.viewer.resize(); this._updateResolution();
      if (this.mode === 'overview' || this.mode === 'top') this._fitOverview(this.mode);
      this.cameraDirty = true; this._request();
    }
    setVisible(value) { if (this.destroyed) return; this.visible = Boolean(value); if (!this.visible && this.infoPanel) this.infoPanel.hidden = true; if (!this.visible && this.options.onLabels) { this.screenLabelsSignature = ''; this.options.onLabels([]); } this.viewer.useDefaultRenderLoop = this.visible; if (this.visible) { this.resize(); this._request(); } }
    setView(mode) {
      if (mode === 'follow' && !this._followRecord()) return false;
      this.mode = mode;
      if (mode === 'overview' || mode === 'top') {
        this._fitOverview(mode);
      } else if (mode === 'follow') {
        const r = this._followRecord(), p = this._recordPosition(r, performance.now());
        this.followOffset.x = 0; this.followOffset.y = 0;
        this.cameraState.x = p[0]; this.cameraState.y = p[1]; this.cameraState.distance = 95; this.cameraState.pitch = .48;
      }
      this.cameraDirty = true; this._request(); return true;
    }
    _overviewFrame(mode) {
      const aspect = Math.max(.3, this.container.clientWidth / Math.max(1, this.container.clientHeight));
      const tangent = Math.tan((this.viewer.camera.frustum.fov || Math.PI / 3) / 2);
      const vertical = tangent / Math.max(1, aspect) * .87;
      const horizontal = vertical * aspect;
      const pitch = mode === 'top' ? Math.PI / 2 - .002 : .72;
      const sin = Math.sin(pitch), cos = Math.cos(pitch);
      // The near edge projects larger. Offset the look point so both edges have similar screen margins.
      const y = this.height / 2 * (1 - vertical * cos / sin);
      const distance = Math.max(y * (sin / vertical + cos), this.width / (2 * horizontal) + y * cos);
      return { x: this.width / 2, y, distance, pitch, yaw: 0 };
    }
    _fitOverview(mode) { Object.assign(this.cameraState, this._overviewFrame(mode)); }
    _fittedDistance(mode) { return this._overviewFrame(mode).distance; }
    focusPoint(point, objectKey) {
      if (!validPoint(point)) return;
      this.mode = 'free';
      this.freeTargetHeight = (this.records.get(objectKey)?.to[2] || 0) * this.heightScale;
      const distance = this._fittedDistance('overview');
      Object.assign(this.cameraState, {
        x: point[0], y: point[1],
        distance: clamp(this.cameraState.distance, distance * .22, distance * .58),
      });
      this.cameraDirty = true; this._request();
    }
    zoomBy(factor) { if (!Number.isFinite(factor) || factor <= 0) return; this.cameraState.distance = clamp(this.cameraState.distance / factor, 25, Math.max(this.width, this.height) * 4); this.cameraDirty = true; this._request(); }
    getStats() { const sea = this.viewer.scene.backgroundColor; return { entities: this.records.size, units: [...this.records.values()].map((r) => ({ id: r.id, kind: r.kind, type: r.item.type, position: r.rendered || r.to, displayHeight: (r.rendered || r.to)[2] * this.heightScale, modelReady: Boolean(r.model?.ready), modelVisible: Boolean(r.model?.show), modelFailed: Boolean(r.modelFailed) })), uavHeight: UAV_HEIGHT, treeHeight: TREE_HEIGHT, groundHeight: 0, groundType: 'flat', groundMaterialBound: Boolean(this.groundMaterialBound), seaColor: [Math.round(sea.red * 255), Math.round(sea.green * 255), Math.round(sea.blue * 255)], terrainSurface: Boolean(this.terrainTexture), terrainTextureReady: this.terrainTextureReady, terrainTextureSize: this.terrainTexture?.width || 0, terrainBuildMs: this.terrainBuildMs, coastline: Boolean(this.coastline), gridMeters: this.gridMeters, gridLineCount: this.gridLineCount, gridKey: this.gridKey, backgroundMode: this.state?.layer ? 'grid' : 'natural', obstacleRegions: this.obstacleRegions || [], trees: this.treePoints.length + (this.dynamicTreePoints?.length || 0), heightScale: this.heightScale, displayHeightScale: this.heightScale, heightMode: this.heightMode, modelSize: this.modelSize, modelOnly: ![...this.records.values()].some((r) => r.modelFailed), unitBillboards: [...this.records.values()].filter((r) => r.modelFailed).length, models: [...this.records.values()].filter((r) => r.model).length, camera: { ...this.cameraState }, followOffset: { ...this.followOffset }, mode: this.mode, visible: this.visible, contextLost: this.contextLost, qualityFps: this.quality.fps, performance: { ...this.performance, lines: this.lines.size, arrows: this.visibleArrowCount || 0, treeDrawBatches: this.treeModels.length, resolutionScale: this.viewer.resolutionScale } }; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.terrainTextureGeneration += 1; this.terrainTextureTask?.cancel?.(); if (this.terrainTexture?.close) this.terrainTexture.close(); this.infoPanel?.remove(); if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer); if (this.interactionTimer !== null) clearTimeout(this.interactionTimer); this.events.forEach((fn) => fn()); this._removePreUpdate?.(); this._removePostRender?.(); this._removeError?.(); this.options.onLabels?.([]); this._releaseGroundMaterial(); this.viewer.destroy(); }
  }
  window.Tactical3D = { create: (options) => new FlatTacticalView(options), obstacleKind, UAV_HEIGHT, TREE_HEIGHT };
}());
