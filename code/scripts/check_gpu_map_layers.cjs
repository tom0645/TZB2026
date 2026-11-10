/* GPU 图层回归：使用固定快照与隔离 API，不改变实际仿真会话。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TZB_PLAYWRIGHT_MODULE || 'C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TZB_3D_TEST_URL || 'http://127.0.0.1:8016/';
const reportPath = path.resolve(process.argv[2] || 'gpu-map-layers.json');
function fixture() {
  const grid = Array.from({ length: 100 }, (_, y) => Array.from({ length: 100 }, (_, x) => (x + y) / 198));
  const platform = (id, type, position) => ({ id, type, position, velocity: [0, 0], speed: 0, heading: 0, battery: 91,
    online: true, task_id: null, task: '待命', target: null, track: [], navigation: { state: 'IDLE', path_version: 1 } });
  return { simulation: { session_id: 'gpu-map-isolated', scene: 'rescue', mode: 'mission', running: false,
    speed: 1, time: 0, tick: 0, dt: 1, duration: 7200 },
    map: { width: 10000, height: 10000, obstacles: [{ center: [4000, 5000], radius: 400 }, { center: [7000, 2000], radius: 600 }], roads: [],
      cues: [], no_fly_zones: [], dynamic_obstacles: [], layers: { width: 100, height: 100, coverage: grid, priority: grid, passability: grid } },
    platforms: [platform(0, 'uav', [3500, 4500]), platform(1, 'ugv', [4500, 4500])], targets: [], tasks: [],
    events: [], alerts: [], history: [], llm_traces: [], llm_trace: null, metrics: { coverage: 0, average_battery: 91, online_platforms: 2 },
    evaluation: { score: null, metrics: [], headline: 'GPU 图层隔离测试' }, flow: { phases: [], phase: 'idle' } };
}
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const source = fixture(), errors = [];
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/map-3d.js') {
      // 只在测试响应中公开生成器，检查透明混色而不改变工程 API。
      const response = await route.fetch(), source = await response.text();
      assert(source.includes('window.Tactical3D ='));
      return route.fulfill({ response, body: source.replace('window.Tactical3D =',
        'window.__testMakeTerrainTexture = makeTerrainTexture; window.Tactical3D =') });
    }
    if (url.pathname === '/api/state') return route.fulfill({ json: source });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
    if (url.origin !== new URL(base).origin && /^https?:/.test(url.protocol)) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  await page.routeWebSocket('**/ws*', ws => ws.send(JSON.stringify(source)));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof map3dRuntime !== 'undefined' && map3dRuntime.renderer?.terrainTextureReady
      && map3dRuntime.renderer.isReady() && [...map3dRuntime.renderer.records.values()].every(record => record.model?.ready), undefined, { timeout: 30000 });
    await page.waitForTimeout(150);
    const terrainContract = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer, texture = renderer.terrainTexture, context = texture.getContext('2d');
      const sample = point => [...context.getImageData(Math.round(point[0] / renderer.width * texture.width),
        Math.round((1 - point[1] / renderer.height) * texture.height), 1, 1).data].slice(0, 3);
      const natural = window.__testMakeTerrainTexture({ ...state.map, obstacles: [] }, texture.width).getContext('2d');
      const mineReference = [...natural.getImageData(Math.round(4000 / renderer.width * texture.width),
        Math.round((1 - 5000 / renderer.height) * texture.height), 1, 1).data].slice(0, 3);
      return { mine: sample([4000, 5000]), lake: sample([7000, 2000]), stats: renderer.getStats(),
        mineReference, mineExpected: mineReference.map((channel, index) => Math.round(channel * .7 + [213, 0, 102][index] * .3)),
        minimumPixelSizes: [...renderer.records.values()].map(record => record.model?.minimumPixelSize),
        staticLabels: renderer.staticLabels.map(label => label.text),
        regionLabels: renderer.staticLabels.filter(label => ['雷区', '湖泊'].includes(label.text)).map(label => ({
          text: label.text, color: label.fillColor.toCssColorString(), origin: [label.horizontalOrigin, label.verticalOrigin],
          expectedOrigin: [Cesium.HorizontalOrigin.CENTER, Cesium.VerticalOrigin.CENTER], offset: [label.pixelOffset.x, label.pixelOffset.y],
          position: renderer._local(label.position).slice(0, 2) })),
        unitLabels: [...renderer.records.values()].map(record => ({ text: record.label.text, font: record.label.font,
          color: record.label.fillColor.toCssColorString(), showBackground: record.label.showBackground,
          offset: [record.label.pixelOffset.x, record.label.pixelOffset.y] })) };
    });
    assert.deepEqual(terrainContract.mine, terrainContract.mineExpected, '雷区应以30%不透明度覆盖真实自然地表');
    assert.notDeepEqual(terrainContract.mine, [213, 0, 102]);
    assert.deepEqual(terrainContract.lake, [71, 88, 105]);
    assert.equal(terrainContract.stats.trees, 0); assert.equal(terrainContract.stats.performance.treeDrawBatches, 0);
    assert.equal(terrainContract.stats.modelSize, 'normal'); assert(terrainContract.minimumPixelSizes.every(size => size === 32));
    assert(terrainContract.staticLabels.includes('雷区')); assert(terrainContract.staticLabels.includes('湖泊'));
    assert(!terrainContract.staticLabels.some(label => /林区|树高/.test(label)));
    terrainContract.regionLabels.forEach((label, index) => {
      assert.equal(label.color, 'rgb(255,255,255)'); assert.deepEqual(label.origin, label.expectedOrigin);
      assert.deepEqual(label.offset, [0, 0]);
      assert(label.position.every((value, axis) => Math.abs(value - source.map.obstacles[index].center[axis]) < .001));
    });
    terrainContract.unitLabels.forEach(label => {
      assert(!/\d+\s*m|海拔|高度/.test(label.text)); assert.equal(label.color, 'rgb(255,255,255)');
      assert(label.font.includes('13px')); assert.equal(label.showBackground, true);
      assert(Math.hypot(...label.offset) <= 20, '呼号应紧贴实体');
    });
    const opaqueLayer = await page.evaluate(async () => {
      const renderer = map3dRuntime.renderer, scene = renderer.viewer.scene, gl = scene.context._gl;
      renderer.setView('top'); renderer._applyCamera();
      const sample = async () => {
        // Cesium 将 Canvas 图像放入异步纹理缓存，等下一绘制周期完成绑定后再读实际帧。
        scene.requestRender(); scene.render();
        await new Promise(resolve => requestAnimationFrame(resolve));
        scene.requestRender();
        scene.render();
        const coordinate = Cesium.SceneTransforms.worldToWindowCoordinates(scene, renderer._world([6027, 6027], 0));
        const ratioX = gl.drawingBufferWidth / renderer.viewer.canvas.clientWidth;
        const ratioY = gl.drawingBufferHeight / renderer.viewer.canvas.clientHeight;
        const pixels = new Uint8Array(4);
        gl.readPixels(Math.round(coordinate.x * ratioX), Math.round(gl.drawingBufferHeight - coordinate.y * ratioY),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return [...pixels];
      };
      const terrain = renderer.groundMaterial.uniforms.terrainImage;
      const replacement = document.createElement('canvas'); replacement.width = 2; replacement.height = 2;
      const paint = replacement.getContext('2d'); paint.fillStyle = '#00ff00'; paint.fillRect(0, 0, 2, 2);
      const rows = [];
      for (const layer of ['coverage', 'priority', 'passability']) {
        state.layer = layer; renderer.update(state);
        renderer.groundMaterial.uniforms.terrainImage = terrain;
        const original = await sample();
        renderer.groundMaterial.uniforms.terrainImage = replacement;
        rows.push({ layer, original, replaced: await sample(), opacity: renderer.groundMaterial.uniforms.layerOpacity,
          naturalHidden: renderer.naturalLines.every(line => !line.show) && renderer.naturalLabels.every(label => !label.show) });
      }
      state.layer = null; renderer.update(state);
      const restoredNatural = renderer.groundMaterial.uniforms.layerOpacity === 0;
      renderer.groundMaterial.uniforms.terrainImage = terrain;
      const naturalPixel = await sample();
      renderer.groundMaterial.uniforms.terrainImage = replacement;
      const replacedNaturalPixel = await sample();
      renderer.groundMaterial.uniforms.terrainImage = terrain;
      renderer.setView('overview');
      return { rows, restoredNatural, naturalPixel, replacedNaturalPixel, glError: gl.getError() };
    });
    for (const row of opaqueLayer.rows) {
      assert.equal(row.opacity, 1); assert.deepEqual(row.original, row.replaced, `${row.layer} 不得透出自然纹理`);
      assert.equal(row.naturalHidden, true); assert.equal(row.original[3], 255);
    }
    assert.equal(opaqueLayer.restoredNatural, true);
    assert.notDeepEqual(opaqueLayer.naturalPixel, opaqueLayer.replacedNaturalPixel, '取消图层后应恢复自然地表');
    assert.equal(opaqueLayer.glError, 0);
    const result = await page.evaluate(async () => {
      const renderer = map3dRuntime.renderer, primitive = renderer.ground, terrain = renderer.terrainTexture;
      const originalGet = CanvasRenderingContext2D.prototype.getImageData;
      const originalPut = CanvasRenderingContext2D.prototype.putImageData;
      let highResolutionReads = 0, highResolutionWrites = 0;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        if (this.canvas.width > 100 || this.canvas.height > 100) highResolutionReads += 1;
        return originalGet.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.putImageData = function (...args) {
        if (this.canvas.width > 100 || this.canvas.height > 100) highResolutionWrites += 1;
        return originalPut.apply(this, args);
      };
      const before = { ...renderer.performance }, costs = [];
      try {
        for (let index = 0; index < 24; index += 1) {
          state.layer = ['coverage', 'priority', 'passability', null][index % 4];
          if (state.layer) state.map.layers = { ...state.map.layers, [state.layer]: Array.from({ length: 100 }, (_, y) =>
            Array.from({ length: 100 }, (_, x) => ((x + y + index) % 100) / 99)) };
          const started = performance.now(); renderer.update(state); costs.push(performance.now() - started);
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        const uploads = renderer.performance.layerUploads;
        state.layer = 'coverage'; renderer.update(state);
        const stableUploads = renderer.performance.layerUploads;
        state.map.layers = { ...state.map.layers, coverage: state.map.layers.coverage.map(row => [...row]) };
        renderer.update(state);
        const stable = renderer.performance.layerUploads === stableUploads;
        const pose = renderer.records.get('platform:0');
        state.running = true; state.replay = { generation: 1 };
        state.platforms[0].position = [3600, 4500]; renderer.update(state);
        state.replay = { generation: 2 }; state.platforms[0].position = [3550, 4500]; renderer.update(state);
        return { before, after: { ...renderer.performance }, primitiveReused: renderer.ground === primitive,
          terrainReused: renderer.terrainTexture === terrain, uniformTerrainReused: renderer.groundMaterial.uniforms.terrainImage === terrain,
          highResolutionReads, highResolutionWrites, stableGridAvoidedUpload: stable, layerSize: renderer.groundMaterial.uniforms.layerSize,
          replayJumpDuration: pose.duration, replayJumpPosition: pose.rendered,
          updateMeanMs: costs.reduce((sum, value) => sum + value, 0) / costs.length, updateMaxMs: Math.max(...costs),
          glError: renderer.viewer.scene.context._gl.getError(), frames: renderer.performance.frames, uploads };
      } finally {
        CanvasRenderingContext2D.prototype.getImageData = originalGet;
        CanvasRenderingContext2D.prototype.putImageData = originalPut;
      }
    });
    assert.equal(result.primitiveReused, true); assert.equal(result.terrainReused, true); assert.equal(result.uniformTerrainReused, true);
    assert.equal(result.highResolutionReads, 0); assert.equal(result.highResolutionWrites, 0);
    assert.equal(result.after.maxLayerUploadPixels, 10000); assert.equal(result.stableGridAvoidedUpload, true);
    assert.equal(result.replayJumpDuration, 0); assert.equal(result.glError, 0); assert(result.frames > 2);
    assert.equal(result.after.groundPrimitiveCreates, result.before.groundPrimitiveCreates);
    assert.equal(result.after.terrainUploads, result.before.terrainUploads);
    assert.equal(result.after.layerTextureCreates, result.before.layerTextureCreates, '连续切图应复用同一动态纹理');
    assert(result.after.layerTextureReuses > result.before.layerTextureReuses, '动态颜色应原地更新而非新建纹理');
    const fixedHeight = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer;
      renderer.heightDirty = false; renderer.modelsDirty = false;
      const before = { lines: renderer.performance.heightLineUpdates, geometry: renderer.performance.lineUpdates };
      for (const pitch of [.12, .7, 1.4]) { renderer.cameraState.pitch = pitch; renderer.zoomBy(1.1); renderer._applyCamera(); }
      return { scale: renderer.heightScale, mode: renderer.heightMode, heightDirty: Boolean(renderer.heightDirty), before,
        after: { lines: renderer.performance.heightLineUpdates, geometry: renderer.performance.lineUpdates },
        units: [...renderer.records.values()].map(record => ({ type: record.item.type, height: record.to[2], display: renderer._local(record.entity.position.getValue())[2] })) };
    });
    assert.equal(fixedHeight.scale, 35); assert.equal(fixedHeight.mode, 'fixed35'); assert.equal(fixedHeight.heightDirty, false);
    assert.deepEqual(fixedHeight.before, fixedHeight.after, '旋转缩放不应重建高度与历史几何');
    assert(fixedHeight.units.filter(unit => unit.type === 'uav').every(unit => unit.height === 10 && Math.abs(unit.display - 350) < .01));
    const recentTrail = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer, unit = state.platforms[0];
      state.elapsed = 200; state.dt = 1; state.running = false;
      unit.track = Array.from({ length: 201 }, (_, index) => [3000 + index * 3, 4500 + Math.sin(index * .15) * 20]);
      unit.track_times = Array.from({ length: 201 }, (_, index) => index);
      unit.position = [...unit.track.at(-1)];
      renderer.historyOverlayDue = true; renderer._updateOverlays();
      const key = 'track:' + unit.id, entry = renderer.lines.get(key), material = entry.line.material;
      const at200 = { rawPoints: entry.rawPoints.length, oldestX: entry.rawPoints[0][0], material: material.type, lineCount: [...renderer.lines.keys()].filter(item => item === key).length };
      renderer.historyOverlayDue = true; renderer._updateOverlays();
      const sameMaterial = material === renderer.lines.get(key).line.material;
      state.elapsed = 261; renderer.historyOverlayDue = true; renderer._updateOverlays();
      return { at200, sameMaterial, expiredHidden: !renderer.lines.get(key).line.show };
    });
    assert(recentTrail.at200.rawPoints <= 61, '单位轨迹只保留最近60秒');
    assert(recentTrail.at200.oldestX >= 3420, '早于时间窗的旧轨迹应移除');
    assert.equal(recentTrail.at200.material, 'TacticalRecentTrail'); assert.equal(recentTrail.at200.lineCount, 1);
    assert.equal(recentTrail.sameMaterial, true, '渐隐使用同一条线和同一材质');
    assert.equal(recentTrail.expiredHidden, true, '平台停止超过60秒后旧轨迹应完全消散');
    const groundedTarget = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer;
      state.targets = [{ id: 991, type: 'aerial', label: '入侵无人机 #991', position: [4800, 4500],
        velocity: [14, 0], speed: 14, state: '跟踪中', extra: { neutralized: false }, discovered: true }];
      state.selected = { type: 'target', id: 991 }; renderer.update(state); renderer.setView('follow');
      const target = renderer.records.get('target:991'), before = target.to[2];
      state.targets[0] = { ...state.targets[0], state: '已处置', extra: { neutralized: true } };
      renderer.update(state); renderer._updateInfoPanel();
      return { before, after: target.to[2], lineShown: target.heightLine.show, markShown: target.groundMark.show,
        entityHeight: renderer._local(target.entity.position.getValue())[2],
        popupHeight: renderer.infoPanelFields.get('altitude').textContent,
        popupSpeed: renderer.infoPanelFields.get('speed').textContent,
        friendlyHeights: [...renderer.records.values()].filter(r => r.kind === 'platform' && r.item.type === 'uav').map(r => r.to[2]) };
    });
    assert.equal(groundedTarget.before, 10); assert.equal(groundedTarget.after, 0);
    assert(Math.abs(groundedTarget.entityHeight) < .001); assert.equal(groundedTarget.lineShown, false); assert.equal(groundedTarget.markShown, false);
    assert.equal(groundedTarget.popupHeight, '0.0 m'); assert.equal(groundedTarget.popupSpeed, '0.0 m/s');
    assert(groundedTarget.friendlyHeights.every(height => height === 10), '敌机落地不能改变友方无人机海拔');
    // 同一 Fabric 类型必须支持会话重置和整个 Viewer 恢复，不能缓存不可克隆的 Canvas。
    const sessionRebuild = await page.evaluate(snapshot => {
      const renderer = map3dRuntime.renderer, previousGround = renderer.ground, previousMaterial = renderer.groundMaterial;
      const creates = renderer.performance.groundPrimitiveCreates;
      applyBackendSnapshot({ ...snapshot, simulation: { ...snapshot.simulation, session_id: 'gpu-map-next-session', time: 1, tick: 1 } });
      return { sameRenderer: renderer === map3dRuntime.renderer, newGround: renderer.ground !== previousGround,
        addedGroundCreates: renderer.performance.groundPrimitiveCreates - creates,
        previousMaterialDestroyed: previousMaterial.isDestroyed() };
    }, source);
    assert.equal(sessionRebuild.sameRenderer, true); assert.equal(sessionRebuild.newGround, true);
    assert.equal(sessionRebuild.addedGroundCreates, 1);
    assert.equal(sessionRebuild.previousMaterialDestroyed, true, '会话重建必须回收材质与纹理');
    await page.waitForFunction(() => map3dRuntime.renderer.terrainTextureReady && map3dRuntime.renderer.isReady()
      && [...map3dRuntime.renderer.records.values()].every(record => record.model?.ready), undefined, { timeout: 30000 });
    sessionRebuild.glError = await page.evaluate(() => map3dRuntime.renderer.viewer.scene.context._gl.getError());
    assert.equal(sessionRebuild.glError, 0);
    await page.evaluate(() => {
      window.__gpuPreviousRenderer = map3dRuntime.renderer;
      rebuild3dAfterContextLoss(map3dRuntime.renderer);
    });
    await page.waitForFunction(() => map3dRuntime.renderer && map3dRuntime.renderer !== window.__gpuPreviousRenderer
      && map3dRuntime.renderer.terrainTextureReady && map3dRuntime.renderer.isReady()
      && [...map3dRuntime.renderer.records.values()].every(record => record.model?.ready), undefined, { timeout: 30000 });
    const viewerRebuild = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer, oldDestroyed = window.__gpuPreviousRenderer.destroyed;
      delete window.__gpuPreviousRenderer;
      return { oldDestroyed, mode: state.mapMode, groundCreates: renderer.performance.groundPrimitiveCreates,
        terrainBound: renderer.groundMaterial.uniforms.terrainImage === renderer.terrainTexture,
        glError: renderer.viewer.scene.context._gl.getError() };
    });
    assert.equal(viewerRebuild.oldDestroyed, true); assert.equal(viewerRebuild.mode, '3d');
    assert.equal(viewerRebuild.groundCreates, 1); assert.equal(viewerRebuild.terrainBound, true); assert.equal(viewerRebuild.glError, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: reportPath.replace(/\.json$/, '.png') });
    fs.writeFileSync(reportPath, JSON.stringify({ ok: true, errors, terrainContract, opaqueLayer, ...result, groundedTarget, sessionRebuild, viewerRebuild }, null, 2));
    console.log(JSON.stringify({ ok: true, reportPath, terrainContract, opaqueLayer, ...result, groundedTarget, sessionRebuild, viewerRebuild }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
