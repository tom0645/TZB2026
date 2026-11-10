/* 三维前端浏览器回归：截获 API/WS，使用固定快照，不改变运行中的仿真。 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TZB_PLAYWRIGHT_MODULE || 'playwright');

const baseUrl = process.env.TZB_3D_TEST_URL || 'http://127.0.0.1:8000/';
const screenshotDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
assert(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), '只允许测试本机页面');
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

function fixture(sessionId = 'flat-3d-smoke') {
  const grid = Array.from({ length: 12 }, (_, row) => Array.from({ length: 12 }, (_, col) => (row + col) / 22));
  const platform = (id, type, position) => ({
    id, type, position, label: `${type.toUpperCase()}-${id + 1}`,
    velocity: [0, 0], speed: 0, heading: 0, battery: 91, task_id: null, task: '待命',
    target: [650, position[1]], online: true, capabilities: [{ name: 'sensor', available: true, state: '可用' }],
    track: [[position[0] - 50, position[1]], [...position]],
    navigation: { state: 'FOLLOWING', state_label: '沿路径行进', safety_state: 'CLEAR', safety_label: '通行正常',
      smoothed_path: [[position[0] - 50, position[1]], [...position], [650, position[1]]],
      raw_path: [[position[0] - 50, position[1]], [650, position[1]]], nearest_path_index: 1, path_version: 1, progress: .1 },
  });
  return {
    simulation: { session_id: sessionId, mode: 'mission', scene: 'rescue', scene_name: '三维前端隔离测试',
      running: false, speed: 1, time: 30, tick: 30, dt: 1, duration: 7200, phase: 'render' },
    map: { width: 1000, height: 1000, obstacles: [{ center: [500, 500], radius: 35 }, { center: [700, 700], radius: 45 }],
      roads: [{ waypoints: [[80, 300], [800, 300]] }], no_fly_zones: [], dynamic_obstacles: [], cues: [],
      layers: { width: 12, height: 12, coverage: grid, priority: grid, passability: grid } },
    platforms: [platform(0, 'uav', [450, 500]), platform(1, 'uav', [400, 420]), platform(2, 'ugv', [450, 460])],
    targets: [], tasks: [], alerts: [], history: [], events: [], llm_traces: [], llm_trace: null,
    metrics: { coverage: 15, completed: 0, active: 0, total_tasks: 0, completion_rate: 0, average_battery: 91,
      platform_utilization: 0, online_platforms: 3, assigned_platforms: 0, discovered_targets: 0, alerts_high: 0 },
    evaluation: { score: null, goal_met: false, headline: '三维前端隔离测试', metrics: [] },
    flow: { phase: 'render', phase_label: '状态推送', phases: [] },
    navigation_test: null, view_options: { behavior_debug: false },
  };
}

async function main() {
  const diagnostics = { errors: [], expectedContextLossErrors: [], failedRequests: [], externalRequests: [], checks: [] };
  let contextLossExpected = false;
  const executablePath = process.env.TZB_EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    ...(fs.existsSync(executablePath) ? { executablePath } : {}),
    headless: true,
    args: ['--disable-background-networking', ...(process.env.TZB_SOFTWARE_GPU === '0' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const source = fixture();
  const localOrigin = new URL(baseUrl).origin;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== localOrigin) {
      diagnostics.externalRequests.push(request.url());
      await route.abort();
      return;
    }
    if (url.pathname === '/api/state') { await route.fulfill({ json: source }); return; }
    if (url.pathname === '/api/health') { await route.fulfill({ json: { ok: true, service: 'isolated-3d-test' } }); return; }
    if (url.pathname.startsWith('/api/')) {
      await route.fulfill({ status: 409, json: { detail: '隔离测试禁止修改仿真' } }); return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.routeWebSocket('**/ws*', (socket) => { socket.send(JSON.stringify(source)); });
  page.on('pageerror', (error) => diagnostics.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (contextLossExpected && text.includes('An error occurred while rendering') && text.includes('Invalid array length')) {
      diagnostics.expectedContextLossErrors.push(text);
    } else diagnostics.errors.push(text);
  });
  page.on('requestfailed', (request) => diagnostics.failedRequests.push({ url: request.url(), reason: request.failure()?.errorText }));
  const check = (name) => diagnostics.checks.push(name);
  const stats = () => page.evaluate(() => map3dRuntime.renderer.getStats());
  const screenshot = async (name) => {
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  };
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.title(), '长空守望系统');
    assert.equal(await page.locator('.brand-block h1').textContent(), '长空守望系统');
    await page.waitForFunction(() => typeof map3dRuntime !== 'undefined' && map3dRuntime.renderer && state.mapMode === '3d'
      && map3dRuntime.renderer.getStats().entities === 3, undefined, { timeout: 45000 });
    await page.waitForFunction(() => map3dRuntime.renderer.viewer.scene._frameState?.frameNumber > 2, undefined, { timeout: 15000 });
    assert.equal(await page.locator('#tacticalMap3d').isVisible(), true);
    assert.equal(await page.locator('#tacticalMap').isVisible(), false);
    assert.equal(await page.locator('.map-height-key').count(), 0, '移除平面/无人机/树高汇总行');
    assert.equal(await page.locator('#heightScaleStatus, #map3dHelp, #mapViews').count(), 0, '移除倍率、地图提示和视野菜单');
    assert.equal(await page.locator('#heightDisplay').count(), 0, '高度显示固定35倍，不提供动态选择');
    const satellite = page.getByRole('button', { name: '卫星视野', exact: true });
    const exterior = page.getByRole('button', { name: '外部视野', exact: true });
    assert.equal(await satellite.locator('use').getAttribute('href'), '#icon-globe');
    assert.equal(await exterior.locator('use').getAttribute('href'), '#icon-eye');
    assert.equal(await satellite.getAttribute('aria-pressed'), 'false');
    assert.equal(await exterior.getAttribute('aria-pressed'), 'true');
    check('地球与眼睛是两个独立的视野按钮，默认选中外部视野');
    const initial = await stats();
    assert.equal(initial.uavHeight, 10); assert.equal(initial.treeHeight, 0); assert.equal(initial.groundHeight, 0);
    assert.equal(initial.groundType, 'flat'); assert.equal(initial.trees, 0); assert.equal(initial.gridLineCount, 18);
    assert.equal(initial.modelSize, 'normal', '三维模型统一采用标准尺寸');
    assert.equal(await page.locator('#modelSize').count(), 0, '移除模型大小选择控件');
    assert.equal(initial.backgroundMode, 'natural', '首屏显示自然底图');
    assert.deepEqual(initial.obstacleRegions.map(region => [region.kind, region.color]), [['mine', '#D50066'], ['lake', '#475869']]);
    await page.waitForFunction(() => map3dRuntime.renderer.terrainTextureReady, undefined, { timeout: 15000 });
    await page.waitForFunction(() => map3dRuntime.renderer.isReady(), undefined, { timeout: 10000 });
    await page.waitForFunction(() => map3dRuntime.renderer.performance.frames > map3dRuntime.renderer.terrainUploadFrame,
      undefined, { timeout: 5000 });
    assert.equal(await page.locator('#map3dLoading').isVisible(), false, '三维地图就绪后应隐藏加载遮罩');
    const detailedTerrain = await stats();
    assert.equal(detailedTerrain.terrainTextureSize, 2048);
    assert(detailedTerrain.terrainBuildMs >= 0);
    assert.equal(detailedTerrain.groundMaterialBound, true, '高分辨率地表应已绑定到Cesium绘制材质');
    const textureDetail = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer;
      const countColors = (source) => {
        const probe = document.createElement('canvas'); probe.width = 64; probe.height = 64;
        const context = probe.getContext('2d'); context.drawImage(source, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data, colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        return colors.size;
      };
      return { surfaceColors: countColors(renderer.terrainTexture), groundColors: countColors(renderer.groundMaterial.uniforms.terrainImage) };
    });
    diagnostics.terrainTexture = { size: detailedTerrain.terrainTextureSize, buildMs: Math.round(detailedTerrain.terrainBuildMs), ...textureDetail };
    assert(textureDetail.surfaceColors > 160, '高分辨率地表应包含连续的自然色阶');
    assert(textureDetail.groundColors > 100, '高分辨率地表纹理应已上传');
    assert.equal(detailedTerrain.performance.gpuLayers, true, '动态图层应交给GPU合成');
    assert.equal(detailedTerrain.performance.cpuTerrainComposites, 0, '动态图层不应再逐像素混合高分辨率地表');
    assert.equal(detailedTerrain.terrainSurface, true); assert.equal(detailedTerrain.coastline, true); assert.equal(detailedTerrain.gridMeters, 100);
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.viewer.scene.backgroundColor.alpha), 0, '三维背景应透出界面的数码网格');
    assert(initial.performance.resolutionScale >= .95, '外部视野应保持接近原生分辨率');
    assert.deepEqual(initial.units.filter((unit) => unit.kind === 'platform').map((unit) => unit.position[2]), [10, 10, 0]);
    check('默认三维，百米网格、雷区与湖泊，无树模型');
    assert.equal(initial.modelOnly, true, '三维界面必须一直显示模型');
    assert.equal(initial.unitBillboards, 0, '三维单位不应退回二维图标');
    await page.waitForFunction(() => [...map3dRuntime.renderer.records.values()].every(record => record.model?.ready), undefined, { timeout: 30000 });
    const modelVisibility = await page.evaluate(() => [...map3dRuntime.renderer.records.values()].map(record => ({
      model: Boolean(record.model), show: record.model?.show, minimumPixelSize: record.model?.minimumPixelSize,
      tint: record.model?.color?.toCssColorString(), blendMode: record.model?.colorBlendMode,
      dynamicEnvironment: record.model.environmentMapManager.enabled,
      replaceMode: Cesium.ColorBlendMode.REPLACE,
    })));
    assert(modelVisibility.every(record => record.model && record.show && record.minimumPixelSize === 32), '平台全域使用标准三维模型');
    assert(modelVisibility.every(record => record.dynamicEnvironment === false), '移动模型不应动态生成环境反射贴图');
    check('三维模型保留并使用固定光照');
    assert.equal(modelVisibility[0].tint, 'rgb(3,70,138)', '友方无人机模型应使用指定蓝色');
    assert.equal(modelVisibility[0].blendMode, modelVisibility[0].replaceMode);
    assert.equal(modelVisibility[2].tint, 'rgb(75,83,32)', '友方无人车模型应使用指定橄榄绿');
    assert.equal(modelVisibility[2].blendMode, modelVisibility[2].replaceMode);
    await page.waitForFunction(() => map3dRuntime.renderer.visibleArrowCount > 2);
    const routeImages = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer, ids = new Set();
      for (let i = 0; i < 12; i += 1) {
        renderer._updateArrows();
        renderer.arrowPool.filter(arrow => arrow.show).forEach(arrow => ids.add(arrow.image));
      }
      return { ids: [...ids].sort(), colors: [...new Set(renderer.routeArrowSamples.map(route => route.color))].sort() };
    });
    assert.deepEqual(routeImages.ids, routeImages.colors, '路线箭头应按颜色共享纹理，连续更新不得创建新 ID');
    check('路线箭头连续刷新复用同色纹理');
    await page.waitForFunction(() => [...map3dRuntime.renderer.records.values()].every(record => crispMapLabels.nodes.has(record.key)));
    const labelStyles = await page.evaluate(() => [...map3dRuntime.renderer.records.values()].map(record => {
      const node = crispMapLabels.nodes.get(record.key), style = getComputedStyle(node);
      return { text: node.textContent, font: style.font, showBackground: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
        color: style.color, offset: [record.label.pixelOffset.x, record.label.pixelOffset.y],
        cesiumVisible: record.label.show, pointerEvents: style.pointerEvents };
    }));
    assert(labelStyles.every(label => /^(UAV|UGV)-\d+$/.test(label.text)), '单位地图标注仅显示呼号，不附海拔');
    assert(labelStyles.every(label => label.showBackground && label.color === 'rgb(255, 255, 255)'), '单位呼号需醒目白字衬底');
    assert(labelStyles.every(label => /(?:13|14|15|16)px/.test(label.font) && Math.hypot(...label.offset) <= 20), '单位呼号加大且贴近模型');
    assert(labelStyles.every(label => !label.cesiumVisible && label.pointerEvents === 'none'), '清晰文字层替代低分辨率WebGL字体且不拦截地图操作');
    const regionLabels = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer;
      return renderer.staticLabels.filter(label => ['雷区', '湖泊'].includes(label.text)).map(label => ({
        text: label.text, position: renderer._local(label.position), offset: [label.pixelOffset.x, label.pixelOffset.y],
        horizontal: label.horizontalOrigin === Cesium.HorizontalOrigin.CENTER,
        vertical: label.verticalOrigin === Cesium.VerticalOrigin.CENTER, color: label.fillColor.toCssColorString(),
      }));
    });
    assert.deepEqual(regionLabels.map(label => label.text), ['雷区', '湖泊']);
    regionLabels.forEach((label, index) => {
      assert(label.horizontal && label.vertical); assert.deepEqual(label.offset, [0, 0]);
      assert.equal(label.color, 'rgb(255,255,255)');
      assert(Math.hypot(label.position[0] - source.map.obstacles[index].center[0], label.position[1] - source.map.obstacles[index].center[1]) < .01);
    });
    check('单位呼号醒目贴近无海拔，雷区与湖泊白字居中');
    check('全域和近景均为三维模型，无二维替代符号');
    await screenshot('3d-overview');

    const exaggerated = await stats();
    assert.equal(exaggerated.displayHeightScale, 35); assert.equal(exaggerated.heightMode, 'fixed35');
    assert(exaggerated.units.filter(unit => unit.kind === 'platform' && unit.position[2] > 0).every(unit => unit.position[2] === 10), '高度放大不能改写真实海拔');
    assert(exaggerated.units.filter(unit => unit.kind === 'platform' && unit.position[2] > 0).every(unit => unit.displayHeight === 350), '固定35倍应显示到350米视觉高度');
    const heightGeometry = await page.evaluate(() => {
      const r = map3dRuntime.renderer, unit = r.records.get('platform:0');
      return { guide: unit.heightLine.positions.map(position => r._local(position)[2]),
        ground: r._local(unit.groundMark.position)[2], track: r.lines.get('track:0').line.positions.map(position => r._local(position)[2]) };
    });
    assert(Math.abs(heightGeometry.guide[0]) < .01 && Math.abs(heightGeometry.guide[1] - 350) < .01, '高度引线两端应连接地面和模型');
    assert(Math.abs(heightGeometry.ground) < .01, '放大高度不能抬高地面投影');
    assert(heightGeometry.track.every(z => Math.abs(z - 350) < .01), '轨迹和模型应使用相同高度倍率');
    const fixedCamera = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer, before = { lines: renderer.performance.heightLineUpdates, geometry: renderer.performance.lineUpdates };
      renderer.modelsDirty = false;
      for (const pitch of [.12, .6, 1.4]) { renderer.cameraState.pitch = pitch; renderer.zoomBy(1.2); renderer._applyCamera(); }
      const result = { height: renderer.heightScale, mode: renderer.heightMode, dirty: Boolean(renderer.heightDirty),
        before, after: { lines: renderer.performance.heightLineUpdates, geometry: renderer.performance.lineUpdates } };
      renderer.setView('overview'); return result;
    });
    assert.equal(fixedCamera.height, 35); assert.equal(fixedCamera.mode, 'fixed35'); assert.equal(fixedCamera.dirty, false);
    assert.deepEqual(fixedCamera.before, fixedCamera.after, '旋转缩放不得重建高度引线或历史几何');
    check('高度固定35倍，旋转缩放不改变高差或重建高度几何');

    assert.equal((await stats()).performance.modelCreates, initial.performance.modelCreates,
      '调整高度不应销毁重建模型');
    assert.equal((await stats()).modelSize, 'normal');
    check('固定标准模型尺寸并保留常驻三维模型');

    const card = page.locator('[data-platform-select="0"]');
    await card.click();
    assert.deepEqual(await page.evaluate(() => state.selected), { type: 'platform', id: 0 });
    const close = page.locator('#clearSelection');
    const closeBox = await close.boundingBox(), crossBox = await close.locator('svg').boundingBox();
    assert.equal(closeBox.width, closeBox.height, '关闭按钮应为正方形');
    assert(Math.abs(closeBox.x + closeBox.width / 2 - crossBox.x - crossBox.width / 2) < .5
      && Math.abs(closeBox.y + closeBox.height / 2 - crossBox.y - crossBox.height / 2) < .5, '关闭图标应水平和垂直居中');
    check('对象详情关闭图标居中');
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.records.get('platform:0').selection.width), 36,
      '单位锁定角框应使用紧凑尺寸');
    assert.equal(await page.locator('.tactical-object-readout').isVisible(), false, '全域视图不应显示对象窗');
    await page.locator('#zoomIn').click();
    await page.locator('#zoomIn').click();
    await page.waitForFunction(() => !document.querySelector('.tactical-object-readout').hidden);
    const readoutValues = await page.locator('.tactical-object-readout [data-field]').evaluateAll(fields => fields.map(field => [field.dataset.field, field.textContent]));
    assert.deepEqual(Object.fromEntries(readoutValues), { altitude: '10.0 m', speed: '0.0 m/s', heading: '000°', battery: '91%' });
    const readoutColors = await page.locator('.tactical-object-readout').evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      title: getComputedStyle(element.querySelector('.readout-title')).color,
      value: getComputedStyle(element.querySelector('[data-field="altitude"]')).color,
    }));
    assert.equal(readoutColors.background, 'rgb(17, 24, 32)');
    assert.equal(readoutColors.title, 'rgb(157, 216, 239)');
    assert.equal(readoutColors.value, 'rgb(157, 216, 239)');
    assert.equal((await page.locator('#inspectorContent').innerText()).includes('固定高度'), false);
    check('放大后对象信息框显示高度、速度、航向和电量');
    await card.click();
    assert.equal(await page.evaluate(() => state.selected.type), 'none');
    await card.click();
    check('单位卡单击选择、再次单击取消');
    await page.locator('[data-3d-view="follow"]').click();
    await page.waitForFunction(() => map3dRuntime.renderer.getStats().mode === 'follow');
    await page.waitForFunction(() => map3dRuntime.renderer.cameraDirty === false);
    assert((await stats()).camera.distance < 200);
    const toastBox = await page.locator('#mapToast').boundingBox();
    assert(toastBox.height < 100, '三维提示条被上下定位拉伸，遮挡场景');
    await screenshot('3d-follow');
    check('跟随近景');

    const projectUnit = () => page.evaluate(() => {
      const renderer = map3dRuntime.renderer, entity = renderer.records.get('platform:0').entity;
      const world = entity.position.getValue(renderer.viewer.clock.currentTime);
      const point = Cesium.SceneTransforms.worldToWindowCoordinates(renderer.viewer.scene, world);
      const box = renderer.viewer.canvas.getBoundingClientRect();
      return { x: box.left + point.x, y: box.top + point.y };
    });
    const projected = await projectUnit();
    await page.mouse.click(projected.x, projected.y);
    assert.equal(await page.evaluate(() => state.selected.type), 'none');
    await page.waitForFunction(() => !map3dRuntime.renderer.cameraDirty);
    const reprojected = await projectUnit();
    await page.mouse.click(reprojected.x, reprojected.y);
    assert.deepEqual(await page.evaluate(() => state.selected), { type: 'platform', id: 0 });
    check('地图模型单击选择与取消');

    // 重新进入跟随，拖动后不仅保留选择，还必须保留跟随相机及相对偏移。
    await page.locator('[data-3d-view="follow"]').click();
    await page.waitForFunction(() => map3dRuntime.renderer.getStats().mode === 'follow' && !map3dRuntime.renderer.cameraDirty);
    const dragBox = await page.locator('#tacticalMap3d').boundingBox();
    const yawBefore = (await stats()).camera.yaw;
    await page.mouse.move(dragBox.x + dragBox.width * .5, dragBox.y + dragBox.height * .7);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(dragBox.x + dragBox.width * .6, dragBox.y + dragBox.height * .75, { steps: 5 });
    await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => !map3dRuntime.renderer.cameraDirty);
    assert.notEqual((await stats()).camera.yaw, yawBefore);
    assert.equal((await stats()).mode, 'follow', '右键旋转不得退出跟随');
    assert.equal(await page.locator('[data-3d-view="follow"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => state.selected), { type: 'platform', id: 0 });
    check('右键环绕保持跟随且不误选单位');

    const beforePan = await stats();
    await page.mouse.move(dragBox.x + dragBox.width * .5, dragBox.y + dragBox.height * .7);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(dragBox.x + dragBox.width * .5 + 42, dragBox.y + dragBox.height * .7 + 21, { steps: 5 });
    await page.mouse.up({ button: 'left' });
    await page.waitForFunction(() => !map3dRuntime.renderer.cameraDirty);
    const afterPan = await stats();
    assert.equal(afterPan.mode, 'follow', '左键平移不得退出跟随');
    assert(Math.hypot(afterPan.camera.x - beforePan.camera.x, afterPan.camera.y - beforePan.camera.y) > .1,
      '左键平移应改变跟随的相对构图位置');
    const offset = { x: afterPan.camera.x - 450, y: afterPan.camera.y - 500 };
    assert(Math.abs(offset.x - afterPan.followOffset.x) < .05 && Math.abs(offset.y - afterPan.followOffset.y) < .05);
    await page.evaluate(() => map3dRuntime.renderer.viewer.scene.requestRender());
    await page.waitForFunction(() => !map3dRuntime.renderer.cameraDirty);
    const stablePan = await stats();
    assert(Math.abs(stablePan.camera.x - afterPan.camera.x) < .05 && Math.abs(stablePan.camera.y - afterPan.camera.y) < .05,
      '后续动画帧不能清掉相对平移');
    const followMoving = fixture();
    followMoving.simulation.time = 31;
    followMoving.platforms[0].position = [475, 515];
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), followMoving);
    await page.waitForFunction(({ x, y }) => {
      const r = map3dRuntime.renderer;
      return !r.cameraDirty && Math.abs(r.cameraState.x - x) < .05 && Math.abs(r.cameraState.y - y) < .05;
    }, { x: 475 + offset.x, y: 515 + offset.y });
    assert.equal((await stats()).mode, 'follow');
    assert.equal((await stats()).camera.yaw, afterPan.camera.yaw, '单位移动不得重置环绕角度');
    check('左键平移保持跟随，单位移动后相对构图不丢失');
    await page.locator('[data-platform-select="1"]').click();
    await page.waitForFunction(({ x, y }) => {
      const r = map3dRuntime.renderer;
      return r.mode === 'follow' && !r.cameraDirty && Math.abs(r.cameraState.x - x) < .05 && Math.abs(r.cameraState.y - y) < .05;
    }, { x: 400 + offset.x, y: 420 + offset.y });
    assert.deepEqual(await page.evaluate(() => state.selected), { type: 'platform', id: 1 });
    check('切换单位后继续跟随并保留相对构图');
    await screenshot('3d-follow-after-drag');

    const closeDistance = (await stats()).camera.distance;
    await page.locator('#zoomIn').click();
    assert((await stats()).camera.distance < closeDistance);
    const mapBox = await page.locator('#tacticalMap3d').boundingBox();
    await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    const zoomDistance = (await stats()).camera.distance;
    await page.mouse.wheel(0, -120);
    await page.waitForFunction((distance) => map3dRuntime.renderer.getStats().camera.distance < distance, zoomDistance);
    assert((await stats()).performance.resolutionScale >= .95, '滚轮缩放后画布分辨率应保持清晰');
    check('按钮与滚轮缩放');

    await page.locator('[data-3d-view="top"]').click();
    await page.waitForFunction(() => map3dRuntime.renderer.getStats().mode === 'top');
    await page.waitForFunction(() => map3dRuntime.renderer.cameraDirty === false);
    assert((await stats()).camera.pitch > 1.5);
    check('俯视视角');
    await satellite.click();
    assert.equal(await satellite.getAttribute('aria-pressed'), 'true');
    assert.equal(await exterior.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#mapTopView').isVisible(), false);
    assert.equal(await page.locator('#tacticalMap').isVisible(), true);
    assert.equal((await stats()).visible, false);
    assert.equal(await page.locator('#heightDisplay').count(), 0);
    assert.equal(await page.locator('#modelSize').count(), 0);
    assert.equal(await page.evaluate(() => state.layer), null);
    const routeStrokes = await page.evaluate(() => {
      const stroke = ctx.stroke, patterns = [];
      ctx.stroke = () => patterns.push(ctx.getLineDash());
      try { drawPlannedRoute(remainingPlannedRoute(state.platforms[0]), true, 'uav'); }
      finally { ctx.stroke = stroke; }
      return patterns;
    });
    assert(routeStrokes.length > 0 && routeStrokes.every(pattern => pattern.length === 0), '卫星视野的规划路线只绘制方向箭头');
    check('卫星视野规划方向箭头无叠加虚线');
    const naturalSurface = await page.evaluate(() => {
      const ratio = window.devicePixelRatio || 1, width = document.querySelector('#tacticalMap').clientWidth;
      const outer = ctx.getImageData(Math.round(4 * ratio), Math.round(4 * ratio), 1, 1).data;
      const land = ctx.getImageData(Math.round(width * .5 * ratio), Math.round(120 * ratio), 1, 1).data;
      return { outer: [...outer], land: [...land], backdrop: getComputedStyle(document.querySelector('#mapStage')).backgroundImage };
    });
    assert.equal(naturalSurface.outer[3], 0, '陆地区域之外应透出数码网格');
    assert.match(naturalSurface.backdrop, /repeating-linear-gradient/);
    assert.equal(naturalSurface.land[3], 255, '沙盘内应保留可辨识的自然地表');
    const obstacleColors = await page.evaluate(() => {
      const ratio = window.devicePixelRatio || 1;
      const sample = position => {
        const [x, y] = mapPoint(position);
        return [...ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data].slice(0, 3);
      };
      const naturalMine = sample([510, 480]);
      // 单独调用区域绘制，以已知底色验证30%填充，避开自然纹理与网格的颜色干扰。
      const background = [80, 140, 180];
      const renderer = map3dRuntime.renderer, textureReady = renderer.terrainTextureReady;
      renderer.terrainTextureReady = false;
      ctx.fillStyle = `rgb(${background.join(',')})`; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      drawTerrain(canvas.clientWidth, canvas.clientHeight);
      const mine = sample([510, 480]), lake = sample([720, 720]);
      const originalLabel = drawMapLabel, labels = [];
      drawMapLabel = (text, x, y) => labels.push({ text, x, y, color: ctx.fillStyle });
      try { drawTerrain(canvas.clientWidth, canvas.clientHeight); }
      finally { drawMapLabel = originalLabel; renderer.terrainTextureReady = textureReady; drawMap(); }
      return { mine, lake, naturalMine, background, labels: labels.map(label => ({ ...label, center: mapPoint(state.map.obstacles[label.text === '雷区' ? 0 : 1].center) })) };
    });
    const expectedMine = [213, 0, 102].map((value, index) => Math.round(value * .3 + obstacleColors.background[index] * .7));
    assert(obstacleColors.mine.every((value, index) => Math.abs(value - expectedMine[index]) <= 1), '卫星视野雷区以30%洋红色填充');
    assert.deepEqual(obstacleColors.lake, [71, 88, 105], '卫星视野湖泊沿用原有水域色');
    obstacleColors.labels.forEach(label => {
      assert(Math.hypot(label.x - label.center[0], label.y - label.center[1]) < .01);
      assert.equal(label.color, '#ffffff');
    });
    check('卫星视野雷区30%填充，雷区湖泊白字居中');
    await screenshot('2d-natural-terrain');
    await exterior.click();
    assert.equal(await satellite.getAttribute('aria-pressed'), 'false');
    assert.equal(await exterior.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#mapTopView').isVisible(), true);
    assert.equal(await page.locator('#tacticalMap3d').isVisible(), true);
    assert.equal((await stats()).visible, true);
    assert.equal((await stats()).gridKey, null, '卫星视野取消图层后，外部视野应只显示自然底图');
    assert.equal((await stats()).backgroundMode, 'natural');
    await page.locator('#mapLayers > summary').click();
    await page.locator('[data-layer="coverage"]').click();
    assert.equal(await page.evaluate(() => state.layer), 'coverage');
    check('二维/三维切换及隐藏渲染循环');

    const controlColors = [];
    const settledButtonColors = (button) => button.evaluate(async (element) => {
      // 样式使用短颜色过渡，验证终态而不是点击瞬间的起始颜色。
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color,
        borders: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor] };
    });
    for (const key of ['routes', 'platformTracks', 'targets', 'cues']) {
      const button = page.locator(`.map-display-toggles [data-overlay="${key}"]`);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      const active = await settledButtonColors(button);
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
      const inactive = await settledButtonColors(button);
      const luminance = (css) => {
        const channels = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const normalized = value / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      assert(luminance(active.background) < .22 && luminance(inactive.background) < .22,
        `${key} 开关使用深色背景`);
      assert.notEqual(active.color, inactive.color, `${key} 开关文字颜色也应随状态变化`);
      assert(active.borders.every(color => color === active.borders[0]), `${key} 激活边框四边颜色应一致`);
      assert(inactive.borders.every(color => color === inactive.borders[0]), `${key} 关闭边框四边颜色应一致`);
      assert(active.borders.every((color, side) => color !== inactive.borders[side]),
        `${key} 激活时四边框均应高亮`);
      controlColors.push({ key, active, inactive });
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
    }
    diagnostics.controlColors = controlColors;
    check('四个地图图层按钮深底、边框与文字高亮及可访问激活状态');

    await page.locator('[data-layer="coverage"]').click();
    assert.equal(await page.evaluate(() => state.layer), null, '再次点击当前覆盖图应关闭图层');
    assert.equal(await page.locator('[data-layer="coverage"]').getAttribute('aria-pressed'), 'false');
    await page.locator('[data-layer="coverage"]').click();
    assert.equal(await page.evaluate(() => state.layer), 'coverage');
    await page.locator('[data-layer="priority"]').click();
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.gridKey), 'priority');
    assert.equal((await stats()).backgroundMode, 'grid');
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.groundMaterial.uniforms.layerOpacity), 1);
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.naturalLines.every(line => !line.show)), true,
      '优先级图不应叠加自然道路或岸线');
    await page.locator('[data-layer="priority"]').click();
    assert.equal(await page.evaluate(() => state.layer), null, '再次点击当前优先级图应关闭图层');
    await page.locator('[data-layer="priority"]').click();
    await page.locator('[data-layer="passability"]').click();
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.gridKey), 'passability');
    assert.equal((await stats()).backgroundMode, 'grid');
    await page.locator('[data-layer="passability"]').click();
    assert.equal(await page.evaluate(() => state.layer), null, '再次点击当前通行图应关闭图层');
    await page.locator('[data-layer="passability"]').click();
    await page.locator('[data-layer="coverage"]').click();
    await page.locator('[data-layer="coverage"]').click();
    assert.equal(await page.evaluate(() => state.layer), null);
    await page.waitForFunction(() => map3dRuntime.renderer.gridKey === null);
    await screenshot('3d-natural-terrain');
    await page.locator('[data-layer="coverage"]').click();
    await page.locator('[data-overlay="routes"]').click();
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.routeArrowSamples.length), 0);
    await page.locator('[data-overlay="routes"]').click();
    assert((await page.evaluate(() => map3dRuntime.renderer.routeArrowSamples.length)) > 0);
    assert.equal(await page.evaluate(() => [...map3dRuntime.renderer.lines.keys()].some(key => key.startsWith('planned:'))), false,
      '外部视野的规划路线不应叠加虚线');
    assert.equal((await stats()).performance.arrowPerMarkerProjections, 0);
    check('三类栅格图层单击开关及规划路径开关');

    const historyBeforeHide = (await stats()).performance.historySimplifications;
    await page.locator('[data-overlay="platformTracks"]').click();
    assert.equal((await stats()).performance.historySimplifications, historyBeforeHide,
      '关闭单位轨迹时不应遍历或简化历史点');
    await page.locator('[data-overlay="platformTracks"]').click();
    const historyBeforeReuse = (await stats()).performance.historySimplifications;
    await page.evaluate(() => {
      const renderer = map3dRuntime.renderer, platform = state.platforms[0];
      const recent = renderer._recentTrack(platform);
      renderer._lineFor('track:' + platform.id, recent, 10, '#779bb4', 1.2);
      const before = renderer.performance.lineUpdates;
      renderer._lineFor('track:' + platform.id, recent, 10, '#779bb4', 1.2);
      window.__historyLineUpdateDelta = renderer.performance.lineUpdates - before;
    });
    assert.equal(await page.evaluate(() => window.__historyLineUpdateDelta), 0);
    assert.equal((await stats()).performance.historySimplifications, historyBeforeReuse);
    check('单位轨迹隐藏跳过历史计算，稳定轨迹复用几何');

    const withCue = fixture('flat-3d-cue-cache');
    withCue.map.cues = [{ id: 7, position: [300, 700], radius: 80, confidence: .72 }];
    withCue.simulation.time = 34;
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), withCue);
    const cueCounts = await page.evaluate(() => {
      const p = map3dRuntime.renderer.performance;
      return { cues: p.cueGeometryRebuilds, restrictions: p.restrictionGeometryRebuilds,
        trees: p.dynamicTreeInvalidations, static: p.staticRebuilds };
    });
    const decayingCue = structuredClone(withCue);
    decayingCue.simulation.time = 35; decayingCue.map.cues[0].confidence = .65;
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), decayingCue);
    const cueCountsAfter = await page.evaluate(() => {
      const p = map3dRuntime.renderer.performance;
      return { cues: p.cueGeometryRebuilds, restrictions: p.restrictionGeometryRebuilds,
        trees: p.dynamicTreeInvalidations, static: p.staticRebuilds };
    });
    assert.deepEqual(cueCountsAfter, cueCounts, '置信度衰减不得重建线索几何、禁区或树木');
    check('线索置信度随时间变化不重建地表或区域几何');

    const redirected = fixture();
    redirected.platforms[0].target = [700, 600];
    redirected.platforms[0].navigation.path_version = 2;
    redirected.platforms[0].navigation.smoothed_path = [[450, 500], [600, 600], [700, 600]];
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), redirected);
    const immediatePath = await page.evaluate(() => map3dRuntime.renderer.routeArrowSamples.some(route => route.points.some(point => point[0] === 700 && point[1] === 600)));
    assert.equal(immediatePath, true, '暂停同一时刻更新路径应立即生效');
    check('暂停同一时刻重规划立即更新');

    const observed = fixture();
    observed.simulation.time = 31;
    observed.targets = [{ id: 100, type: 'victim', entity_type: 'person', discovered: true, position: [500, 520],
      velocity: [0, 0], track: [[490, 520], [500, 520]], extra: {}, timestamp: 31, first_seen: 31, last_seen_age: 0, tracking: true }];
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), observed);
    assert.equal((await stats()).entities, 4);
    await page.locator('[data-overlay="targets"]').click();
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.records.get('target:100').entity.show), true,
      '关闭目标轨迹不应隐藏目标模型');
    await page.locator('[data-overlay="targets"]').click();
    check('目标轨迹开关保留目标模型');

    const moving = fixture();
    moving.simulation.time = 32; moving.simulation.running = true;
    moving.platforms[0].position = [460, 500]; moving.platforms[0].velocity = [10, 0];
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), moving);
    const disconnected = await page.evaluate(() => {
      backendDisconnected();
      const record = map3dRuntime.renderer.records.get('platform:0');
      return { duration: record.duration, from: record.from, to: record.to,
        shown: map3dRuntime.renderer._recordPosition(record, performance.now()) };
    });
    assert.equal(disconnected.duration, 0);
    assert.deepEqual(disconnected.shown, disconnected.to);
    const stopped = fixture(); stopped.simulation.time = 33;
    stopped.platforms[0].position = [461, 500];
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), stopped);
    const paused = await page.evaluate(() => {
      const record = map3dRuntime.renderer.records.get('platform:0');
      return { duration: record.duration, to: record.to, shown: map3dRuntime.renderer._recordPosition(record, performance.now()) };
    });
    assert.equal(paused.duration, 0); assert.deepEqual(paused.shown, paused.to);
    check('暂停与断线停止位置插值');
    const reset = fixture('flat-3d-new-session');
    reset.simulation.time = 0; reset.simulation.tick = 0;
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), reset);
    const resetStats = await stats();
    assert.equal(resetStats.entities, 3); assert(resetStats.units.every((unit) => unit.kind !== 'target'));
    assert.equal(await page.evaluate(() => state.selected.type), 'none');
    check('新会话清除旧目标与选择状态');

    const resizedSession = fixture('flat-3d-resized-session');
    resizedSession.simulation.time = 0; resizedSession.simulation.tick = 0;
    resizedSession.map.width = 2000; resizedSession.map.height = 1500;
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), resizedSession);
    const resizedTrack = await page.evaluate(() => {
      const r = map3dRuntime.renderer;
      return r.lines.get('track:0').line.positions.map(position => r._local(position));
    });
    assert(Math.abs(resizedTrack[0][0] - 400) < .01 && Math.abs(resizedTrack[0][1] - 500) < .01,
      '同一仿真时间换不同地图尺寸时必须重新转换轨迹坐标');
    check('同一时刻换地图尺寸重新投影轨迹');

    const hiddenTarget = fixture('flat-3d-new-session');
    hiddenTarget.targets = [{ ...observed.targets[0], discovered: false }];
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), hiddenTarget);
    assert.equal((await stats()).entities, 3);
    check('未发现目标不进入三维场景');
    await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), fixture('flat-3d-new-session'));

    const failedModel = fixture('flat-3d-model-failure');
    failedModel.platforms.push({ ...failedModel.platforms[0], id: 99, label: 'UAV-99', position: [320, 340], track: [] });
    await page.evaluate(async (snapshot) => {
      const original = Cesium.Model.fromGltfAsync;
      Cesium.Model.fromGltfAsync = (options) => options.id === 'platform:99'
        ? Promise.reject(new Error('isolated model load failure')) : original(options);
      try { applyBackendSnapshot(snapshot); }
      finally { Cesium.Model.fromGltfAsync = original; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }, failedModel);
    const modelFallback = await page.evaluate(() => ({ mode: state.mapMode, unit: map3dRuntime.renderer.getStats().units.find(unit => unit.id === 99),
      marker: map3dRuntime.renderer.records.get('platform:99').groundMark.show }));
    assert.equal(modelFallback.mode, '3d', '单个模型加载失败不能切换整张地图');
    assert.equal(modelFallback.unit.modelFailed, true);
    assert.equal(modelFallback.marker, true, '失败单位应保留可见的位置标记');
    check('单模型加载失败局部降级，不退出外部视野');

    contextLossExpected = true;
    const lostContext = await page.evaluate(() => {
      const renderer = map3dRuntime.renderer;
      const extension = renderer.viewer.scene.context._gl.getExtension('WEBGL_lose_context');
      if (!extension) return false;
      window.__lostContextRenderer = renderer;
      window.__contextLossExtension = extension;
      extension.loseContext();
      return true;
    });
    assert.equal(lostContext, true, '浏览器应提供 WEBGL_lose_context');
    await page.waitForFunction(() => window.__lostContextRenderer.contextLost === true, undefined, { timeout: 5000 });
    const renderLoopStopped = await page.evaluate(() => !window.__lostContextRenderer.viewer.useDefaultRenderLoop);
    assert.equal(renderLoopStopped, true);
    await page.evaluate(() => window.__contextLossExtension.restoreContext());
    await page.waitForFunction(() => state.mapMode === '3d' && map3dRuntime.renderer
      && map3dRuntime.renderer !== window.__lostContextRenderer, undefined, { timeout: 10000 });
    await page.waitForFunction(() => {
      const renderer = map3dRuntime.renderer;
      return renderer.performance.frames >= 3 && [...renderer.records.values()].every(record => record.model?.ready && record.model.show);
    }, undefined, { timeout: 10000 });
    const contextRecovery = await page.evaluate(() => ({ mode: state.mapMode, error: map3dRuntime.renderer.viewer.scene.context._gl.getError(),
      frameCount: map3dRuntime.renderer.performance.frames, models: [...map3dRuntime.renderer.records.values()].filter(record => record.model?.ready && record.model.show).length }));
    await page.waitForFunction(() => map3dRuntime.renderer.terrainTextureReady, undefined, { timeout: 15000 });
    assert.equal(contextRecovery.mode, '3d');
    assert.equal(contextRecovery.error, 0, '重建后的 WebGL 上下文不应保留 GPU 错误');
    assert.equal(contextRecovery.models, 4);
    assert.equal((await stats()).terrainTextureSize, 2048);
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.renderErrorStreak), 0);
    contextLossExpected = false;
    await screenshot('after-webgl-recovery');
    check('真实WebGL上下文丢失后重建渲染器并恢复地图与单位模型');
    const renderRetry = await page.evaluate(async () => {
      const renderer = map3dRuntime.renderer;
      renderer._handleRenderError(new Error('isolated transient render error'));
      await new Promise(resolve => setTimeout(resolve, 350));
      return { sameRenderer: map3dRuntime.renderer === renderer, mode: state.mapMode,
        loopEnabled: renderer.viewer.useDefaultRenderLoop, streak: renderer.renderErrorStreak };
    });
    assert.equal(renderRetry.sameRenderer, true);
    assert.equal(renderRetry.mode, '3d');
    assert.equal(renderRetry.loopEnabled, true);
    check('单次渲染异常短暂停顿后自动重试');

    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 1080 });
      await page.waitForFunction(() => map3dRuntime.renderer.cameraDirty === false);
      const overflow = await page.evaluate(() => {
        const stage = document.querySelector('#mapStage').getBoundingClientRect();
        const toolbar = document.querySelector('.ops-map-tools').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.ops-map-tools > .ops-tool, .ops-map-tools > details > summary')].filter((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && (box.left < toolbar.left - 1 || box.right > toolbar.right + 1 || box.bottom > toolbar.bottom + 1);
        });
        return { controls: controls.length, stageWidth: stage.width, stageHeight: stage.height,
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
      });
      assert.equal(overflow.controls, 0, `宽度${width}下三维按钮越界`);
      assert.equal(overflow.pageOverflow, false, `宽度${width}下页面横向溢出`);
      assert(overflow.stageWidth > 100 && overflow.stageHeight > 100);
      const groundFit = await page.evaluate(() => {
        const renderer = map3dRuntime.renderer;
        const width = renderer.viewer.canvas.clientWidth, height = renderer.viewer.canvas.clientHeight;
        const points = [[0, 0], [renderer.width, 0], [renderer.width, renderer.height], [0, renderer.height]]
          .map((point) => Cesium.SceneTransforms.worldToWindowCoordinates(renderer.viewer.scene, renderer._world(point, 0)))
          .map((point) => ({ x: point.x, y: point.y }));
        return { width, height, points, inside: points.every((point) => point.x >= -1 && point.y >= -1 && point.x <= width + 1 && point.y <= height + 1) };
      });
      assert(groundFit.inside, `宽度${width}下全域地面超出视口: ${JSON.stringify(groundFit)}`);
      await screenshot(`3d-${width}`);
    }
    check('1280与1920宽度布局');

    const linked = fixture('flat-3d-linked-selection');
    linked.platforms[0].task_id = linked.platforms[1].task_id = 42;
    linked.tasks = [{ id: 42, type: 'DiscoverTask', status: 'ACTIVE', priority: 30, platform_ids: [0, 1], target_entity_id: 100 }];
    linked.targets = [
      { id: 100, type: 'vehicle', position: [650, 350], discovered: true, timestamp: 30 },
      { id: 101, type: 'aerial', position: [500, 300], discovered: true, timestamp: 30 },
    ];
    linked.alerts = linked.targets.map(target => ({ id: `hostile-${target.id}`, target_id: target.id, level: 'high', title: '目标入侵' }));
    linked.metrics.alerts_high = 2;
    await page.evaluate(snapshot => applyBackendSnapshot(snapshot), linked);
    await page.waitForFunction(() => [...map3dRuntime.renderer.records.values()].every(record => record.model?.ready));
    const mapMarks = () => page.evaluate(() => [...map3dRuntime.renderer.records.values()]
      .filter(record => record.selection.show).map(record => [record.key, record.selectionMark]));
    const outlines = () => page.evaluate(() => {
      const renderer = map3dRuntime.renderer;
      return [...renderer.records.values()].filter(record => record.model?.hasSilhouette(renderer.viewer.scene.frameState))
        .map(record => [record.key, record.model.silhouetteColor.toCssColorString()]);
    });
    assert.deepEqual(await mapMarks(), [], '入侵告警不应自动给目标加角框');
    assert.deepEqual(await page.evaluate(() => [...mapEmphasis()]), [['target:100', 'label'], ['target:101', 'label']]);
    assert.equal(await page.locator('#alertCount').textContent(), '02');
    await card.click();
    assert.deepEqual(await mapMarks(), [['platform:0', 'selected']]);
    assert.deepEqual(await outlines(), [['platform:0', 'rgb(255,255,255)']]);
    await page.locator('[data-platform-select="1"]').click();
    assert.deepEqual(await mapMarks(), [['platform:1', 'selected']]);
    assert.deepEqual(await outlines(), [['platform:1', 'rgb(255,255,255)']]);
    await page.locator('[data-related-task="42"]').click();
    assert.deepEqual(await mapMarks(), [['platform:0', 'related'], ['platform:1', 'related'], ['target:100', 'related']]);
    assert.deepEqual(await outlines(), []);
    check('协同任务中的无人机只在单选时显示自身白色轮廓');

    await satellite.click();
    await page.locator('#fitMap').click();
    const targetPixels = () => page.evaluate(() => {
      const [x, y] = mapPoint(state.targets[0].position), ratio = window.devicePixelRatio || 1;
      const bounds = canvas.getBoundingClientRect(), size = Math.round(22 * ratio);
      const { data } = ctx.getImageData(Math.round((x - 11) * ratio), Math.round((y - 11) * ratio), size, size);
      let white = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 248 && data[i + 1] > 248 && data[i + 2] > 248) white += 1;
      return { x: bounds.left + x, y: bounds.top + y, white };
    });
    const relatedTarget = await targetPixels();
    await page.mouse.click(relatedTarget.x, relatedTarget.y);
    assert.deepEqual(await page.evaluate(() => state.selected), { type: 'target', id: 100 });
    assert((await targetPixels()).white > relatedTarget.white, '卫星视野选中目标时应实际绘制白边');
    await exterior.click();
    assert.deepEqual(await mapMarks(), [['target:100', 'selected']]);
    assert.deepEqual(await outlines(), [['target:100', 'rgb(255,255,255)']]);
    await page.locator('#clearSelection').click();
    assert.deepEqual(await mapMarks(), []);
    assert.deepEqual(await outlines(), []);
    check('目标白边随视野切换保留并随取消选择清除');

    await satellite.click();
    const alertFrames = await page.evaluate(() => {
      const drawFrame = drawPlatformSelection;
      let count = 0;
      drawPlatformSelection = () => { count += 1; };
      try { drawMap(); } finally { drawPlatformSelection = drawFrame; }
      return count;
    });
    assert.equal(alertFrames, 0, '卫星视野也不应自动给入侵目标加角框');
    await exterior.click();
    check('入侵目标保留告警和名称，两种视野均省去自动角框');

    const waypoint = fixture('flat-3d-manual-waypoint');
    waypoint.platforms[0].task_id = 43;
    waypoint.platforms[0].target = [650, 350];
    waypoint.platforms[0].navigation.smoothed_path = [[450, 500], [650, 350]];
    waypoint.tasks = [{ id: 43, type: 'ArriveTask', source: 'manual', status: 'ACTIVE', priority: 65,
      platform_ids: [0], target_pos: [650, 350], target: '坐标 (650, 350)' }];
    await page.evaluate(snapshot => applyBackendSnapshot(snapshot), waypoint);
    const waypoint3d = () => page.evaluate(() => {
      const renderer = map3dRuntime.renderer, marker = renderer.taskMarker;
      return marker.show ? {
        point: renderer._local(marker.position).slice(0, 2).map(Math.round),
        bottom: marker.verticalOrigin === Cesium.VerticalOrigin.BOTTOM, offset: marker.pixelOffset.y,
      } : null;
    });
    await page.locator('#openTaskModal').click();
    await page.locator('#taskForm [name="targetPos"]').fill('720,360');
    assert.deepEqual(await waypoint3d(), { point: [720, 360], bottom: true, offset: 4 });
    await page.locator('#clearSelection').click();
    assert.equal(await waypoint3d(), null);
    await page.locator('#taskTab').click();
    await page.locator('[data-task-id="43"]').click();
    assert.deepEqual(await waypoint3d(), { point: [650, 350], bottom: true, offset: 4 });
    await page.waitForFunction(() => map3dRuntime.renderer.taskMarker.ready && !map3dRuntime.renderer.cameraDirty
      && document.querySelector('#map3dLoading').hidden);
    await screenshot('3d-manual-waypoint');
    await page.locator('#assetTab').click();
    await card.click();
    assert.deepEqual(await waypoint3d(), { point: [650, 350], bottom: true, offset: 4 });
    await satellite.click();
    const waypoint2d = await page.evaluate(() => {
      const marker = navigationPointMarker(), images = [];
      let boxes = 0;
      const drawImage = ctx.drawImage, strokeRect = ctx.strokeRect;
      ctx.drawImage = function (image, ...args) {
        if (image === marker.image) images.push(args);
        return drawImage.call(this, image, ...args);
      };
      ctx.strokeRect = function (x, y, width, height) {
        if (width === 8 && height === 8) boxes += 1;
        return strokeRect.call(this, x, y, width, height);
      };
      try { drawMap(); } finally { ctx.drawImage = drawImage; ctx.strokeRect = strokeRect; }
      const [x, y] = mapPoint([650, 350]);
      return { images, boxes, expected: [x - marker.width / 2, y - marker.height + marker.tipOffset, marker.width, marker.height] };
    });
    assert.deepEqual(waypoint2d.images, [waypoint2d.expected]);
    assert.equal(waypoint2d.boxes, 0);
    await screenshot('2d-manual-waypoint');
    await page.locator('#clearSelection').click();
    await exterior.click();
    assert.equal(await waypoint3d(), null);
    check('人工坐标预览、任务与执行单位共享对准落点的导航图钉');

    for (const [scene, extent, expectedLines] of [['rescue', 10000, 198], ['border', 12000, 238], ['area', 6000, 118]]) {
      const gridSnapshot = fixture(`flat-3d-grid-${scene}`);
      gridSnapshot.simulation.scene = scene;
      gridSnapshot.map.width = extent; gridSnapshot.map.height = extent;
      gridSnapshot.platforms = gridSnapshot.platforms.map((platform, index) => ({
        ...platform, position: [Math.min(extent - 100, 100 + index * 100), Math.min(extent - 100, 150 + index * 100)],
        target: [extent - 100, extent - 100], track: [],
      }));
      await page.evaluate((snapshot) => applyBackendSnapshot(snapshot), gridSnapshot);
      const stats = await page.evaluate(() => map3dRuntime.renderer.getStats());
      assert.equal(stats.gridMeters, 100, `${scene} 沙盘网格应统一为100米`);
      assert.equal(stats.gridLineCount, expectedLines, `${scene} 沙盘线数应与地图尺度匹配`);
    }
    check('搜救、边境巡检和区域封控均采用100米显示网格');

    contextLossExpected = true;
    await page.evaluate(() => {
      window.__lost3dRenderer = map3dRuntime.renderer;
      map3dRuntime.contextRebuilds = 0;
      window.__unrestoredContextExtension = window.__lost3dRenderer.viewer.scene.context._gl.getExtension('WEBGL_lose_context');
      window.__unrestoredContextExtension.loseContext();
    });
    await page.waitForFunction(() => window.__lost3dRenderer.contextLost === true, undefined, { timeout: 5000 });
    await page.waitForFunction(() => state.mapMode === '3d' && map3dRuntime.renderer
      && map3dRuntime.renderer !== window.__lost3dRenderer && !map3dRuntime.renderer.destroyed, undefined, { timeout: 10000 });
    await page.waitForFunction(() => map3dRuntime.renderer.performance.frames >= 3
      && [...map3dRuntime.renderer.records.values()].every(record => record.model?.ready && record.model.show), undefined, { timeout: 10000 });
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.viewer.scene.context._gl.getError()), 0);
    assert.equal(await page.evaluate(() => map3dRuntime.renderer.renderErrorStreak), 0);
    contextLossExpected = false;
    assert.equal(await page.locator('#tacticalMap3d').isVisible(), true, '无恢复事件时应重建外部视野');
    check('WebGL上下文持续丢失时重建引擎并保留三维视图');
    assert.deepEqual(diagnostics.externalRequests, [], '存在外部资源依赖');
    assert.deepEqual(diagnostics.failedRequests, [], '资源加载失败');
    assert.deepEqual(diagnostics.errors, [], '浏览器或三维渲染异常');
    return { ok: true, ...diagnostics, stats: await stats() };
  } catch (error) {
    await screenshot('3d-failure').catch(() => {});
    return { ok: false, failure: error.stack, ...diagnostics,
      stats: await stats().catch(() => null), mapMode: await page.evaluate(() => typeof state !== 'undefined' ? state.mapMode : null).catch(() => null) };
  } finally {
    await browser.close();
  }
}

main().then((result) => {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}).catch((error) => { console.error(error.stack); process.exitCode = 1; });
