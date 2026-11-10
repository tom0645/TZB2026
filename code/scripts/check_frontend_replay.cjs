/* 演习回放界面回归：截获全部 API/WS，不修改真实仿真或调用大模型。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TZB_PLAYWRIGHT_MODULE || 'C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TZB_3D_TEST_URL || 'http://127.0.0.1:8018/';
const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), '只允许测试本机页面');

const catalog = [
  { id: 1, time: 35, kind: 'task', text: '测试任务开始', detail: '前期任务已分配', color: 'blue' },
  { id: 2, time: 150, kind: 'task', text: '测试任务完成', detail: '后期任务已执行完成', color: 'blue' },
];
function fixture(time = 180, generation = 0, revision = 100, enabled = false) {
  const grid = Array.from({ length: 12 }, () => Array(12).fill(.25));
  return {
    simulation: { session_id: 'exercise-ui-isolated', scene: 'rescue', mode: 'mission', running: false,
      speed: 1, time, tick: time, dt: 1, duration: 7200, state_revision: revision },
    replay: { enabled, mode: enabled ? 'exercise' : 'live', generation, cursor_time: time, start_time: 25,
      computed_until: 180, recorded_until: 180, recorded_frames: 156,
      branch_id: 'recording-fixture', preparing: false, complete: true, status: enabled ? 'ready' : 'live' },
    map: { width: 1000, height: 1000, obstacles: [], roads: [], cues: [], no_fly_zones: [], dynamic_obstacles: [],
      layers: { width: 12, height: 12, coverage: grid, priority: grid, passability: grid } },
    platforms: [{ id: 0, type: 'uav', position: [350, 450], velocity: [0, 0], speed: 0, heading: 0,
      battery: 91, online: true, task_id: null, task: '待命', target: null, track: [], navigation: { state: 'IDLE', path_version: 1 } }],
    targets: [], tasks: [], events: catalog.filter(event => event.time <= time), alerts: [], history: [], llm_traces: [], llm_trace: null,
    metrics: { coverage: 25, average_battery: 91, online_platforms: 1, active: 0, completed: 0, total_tasks: 0 },
    evaluation: { score: null, metrics: [], headline: '演习回放隔离测试' },
    flow: { phases: [], phase: 'idle' }, navigation_test: null, view_options: {},
  };
}
const archive = { format: 'tzb-replay', version: 1, branch_id: 'recording-fixture', start_time: 25,
  computed_until: 180, cursor_time: 180, frames: [fixture(25), fixture(100), fixture(180)] };

async function main() {
  const diagnostics = { checks: [], requests: [], errors: [], externalRequests: [], unexpectedApi: [] };
  const executablePath = process.env.TZB_EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ ...(fs.existsSync(executablePath) ? { executablePath } : {}),
    headless: true, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const initial = fixture(), origin = new URL(base).origin;
  let generation = 0, revision = 100, serverSocket, zeroMode = false;
  const zeroFixture = enabled => {
    const result = fixture(0, generation, revision, enabled);
    result.simulation.session_id = 'zero-recording';
    Object.assign(result.replay, { start_time: 0, computed_until: 0, recorded_until: 0, recorded_frames: 1 });
    return result;
  };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && /^https?:/.test(url.protocol)) {
      diagnostics.externalRequests.push(request.url()); return route.abort();
    }
    if (url.pathname === '/app.js') {
      const response = await route.fetch(), source = await response.text();
      assert(source.includes("state.mapMode = '3d';"), '确认默认视角配置位置仍存在');
      return route.fulfill({ response, body: source.replace("state.mapMode = '3d';", "state.mapMode = '2d';") });
    }
    if (url.pathname === '/api/state') return route.fulfill({ json: initial });
    if (url.pathname === '/api/replay/events') {
      diagnostics.requests.push({ path: url.pathname, method: request.method() });
      return route.fulfill({ json: { events: catalog, llm_traces: [] } });
    }
    if (url.pathname === '/api/replay/enter' || url.pathname === '/api/replay/exit' || url.pathname === '/api/replay/load') {
      const payload = request.postDataJSON(); diagnostics.requests.push({ path: url.pathname, method: request.method(), payload });
      generation += 1; revision += 1;
      const active = url.pathname !== '/api/replay/exit';
      return route.fulfill({ json: zeroMode ? zeroFixture(active) : fixture(active ? 100 : 180, generation, revision, active) });
    }
    if (url.pathname === '/api/replay/seek') {
      const payload = request.postDataJSON(); diagnostics.requests.push({ path: url.pathname, method: request.method(), payload });
      generation += 1; revision += 1;
      return route.fulfill({ json: fixture(payload.time, generation, revision, true) });
    }
    if (url.pathname === '/api/replay/export') {
      const filename = url.searchParams.get('filename') || 'tzb-replay.json';
      diagnostics.requests.push({ path: url.pathname, method: request.method(), filename });
      return route.fulfill({ contentType: 'application/json', headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }, body: JSON.stringify(archive) });
    }
    if (url.pathname.startsWith('/api/')) {
      diagnostics.unexpectedApi.push(url.pathname);
      return route.fulfill({ status: 409, json: { detail: '隔离测试禁止调用真实服务' } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.routeWebSocket('**/ws*', socket => { serverSocket = socket; socket.send(JSON.stringify(initial)); });
  page.on('pageerror', error => diagnostics.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') diagnostics.errors.push(message.text()); });
  const check = label => diagnostics.checks.push(label);
  const screenshot = async label => { if (reportPath) await page.screenshot({ path: reportPath.replace(/\.json$/, '') + `-${label}.png` }); };
  const waitCursor = async time => page.waitForFunction(time => state.elapsed === time && !playbackUi.busy, time);
  const seekRequests = () => diagnostics.requests.filter(request => request.path === '/api/replay/seek');
  const downloadReplay = async () => {
    await page.locator('#simOptions > summary').click();
    await page.locator('#replayExport').click();
    await page.locator('#replaySaveDialog').waitFor({ state: 'visible' });
    await page.locator('#replayFilename').fill('搜救演习 复盘一');
    await screenshot('save-dialog');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#replaySaveForm button[type="submit"]').click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), '搜救演习 复盘一.json');
    assert.equal(new URL(download.url()).searchParams.get('filename'), '搜救演习 复盘一.json');
    const downloaded = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(downloaded.format, 'tzb-replay');
  };
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => state.connected && state.mapMode === '2d' && streamState.received > 0);
    assert.equal(await page.locator('#playbackMode').count(), 0, '不再选择推演方式');
    assert.equal(await page.locator('#liveModeTab').getAttribute('role'), 'tab');
    assert.equal(await page.locator('#liveModeTab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#exerciseModeTab').getAttribute('aria-selected'), 'false');
    assert.equal(await page.locator('#replayTransport').isVisible(), false);
    assert.equal(await page.locator('#replayImport').isVisible(), false, '实时页不显示打开文件');
    assert.equal(await page.locator('#replayExport').isEnabled(), true);
    await screenshot('live');
    await downloadReplay();
    check('实时标签仅显示命名保存，中文文件名下载正确');

    await page.locator('#exerciseModeTab').click();
    await waitCursor(100);
    await page.waitForFunction(() => state.replay?.mode === 'exercise');
    assert.equal(await page.locator('#exerciseModeTab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#liveModeTab').getAttribute('aria-selected'), 'false');
    assert.equal(await page.locator('#replayExport').isVisible(), false, '回放页不显示保存功能');
    assert.equal(await page.locator('#replayImport').isVisible(), true, '回放页显示打开文件');
    assert.equal(await page.locator('#replayTransport').isVisible(), true);
    assert.equal(await page.locator('#replaySeek').getAttribute('min'), '25');
    assert.equal(await page.locator('#replaySeek').getAttribute('max'), '180');
    await page.locator('#openTaskModal').click();
    assert.equal(await page.locator('#manualHistory').isVisible(), true, '演习回放可查看历史指令');
    assert.equal(await page.locator('#manualCompose').isVisible(), false, '演习回放仅浏览历史');
    await page.locator('#eventToggle').click();
    assert.equal(await page.locator('#navigationStart').isDisabled(), true, '演习回放不允许建立导航测试');
    await screenshot('exercise');
    check('进入只读演习回放并显示完整已记录范围');

    generation += 1; revision += 1;
    serverSocket.send(JSON.stringify(fixture(40, generation, revision, true)));
    await waitCursor(40);
    const accepted = await page.evaluate(() => [state.elapsed, state.replay.generation, streamState.base.simulation.state_revision]);
    serverSocket.send(JSON.stringify(fixture(170, generation - 1, revision + 1000, true)));
    await page.waitForTimeout(120);
    assert.deepEqual(await page.evaluate(() => [state.elapsed, state.replay.generation, streamState.base.simulation.state_revision]), accepted);
    serverSocket.send(JSON.stringify(fixture(90, generation, revision - 1, true)));
    await page.waitForTimeout(120);
    assert.deepEqual(await page.evaluate(() => [state.elapsed, state.replay.generation, streamState.base.simulation.state_revision]), accepted);
    check('接受倒带的新状态，拒绝迟到旧代际与旧版本');

    await page.locator('#replayBack').click(); await waitCursor(30);
    assert.equal(seekRequests().at(-1).payload.time, 30);
    await page.locator('#replayForward').click(); await waitCursor(40);
    assert.equal(seekRequests().at(-1).payload.time, 40);
    check('前后10秒按播放时刻定位');

    await page.locator('#llmWorkbench').waitFor();
    await page.locator('[data-decision-range="full"]').click();
    const laterEvent = page.locator('#llmTrace [data-replay-time="150"]');
    await laterEvent.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => state.elapsed), 40);
    await laterEvent.click(); await waitCursor(150);
    assert.equal(seekRequests().at(-1).payload.time, 150);
    assert.equal(await page.evaluate(() => state.running), false);
    const detailButton = page.locator('#llmTrace .ops-event-expand').filter({ hasText: '测试任务完成' });
    const wasExpanded = await detailButton.getAttribute('aria-expanded');
    await detailButton.click();
    assert.notEqual(await detailButton.getAttribute('aria-expanded'), wasExpanded);
    await detailButton.click();
    assert.equal(await detailButton.getAttribute('aria-expanded'), wasExpanded);
    check('完整事件流可定位后期时刻并保留展开详情');

    await page.locator('#replaySeek').evaluate(element => {
      element.value = '176'; element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitCursor(176);
    await page.locator('#replayForward').click(); await waitCursor(180);
    assert.equal(await page.locator('#replayForward').isDisabled(), true);
    await page.evaluate(() => seekPlayback(-100)); await waitCursor(25);
    assert.equal(await page.locator('#replayBack').isDisabled(), true);
    await page.evaluate(() => seekPlayback(10000)); await waitCursor(180);
    check('滑块自由定位且限制在已记录范围');
    check('演习回放显示时间条和文件打开，隐藏实时保存');

    await page.locator('#liveModeTab').click(); await waitCursor(180);
    await page.waitForFunction(() => !state.replay.enabled && !playbackUi.busy);
    assert.equal(await page.locator('#replayTransport').isVisible(), false);
    assert.equal(await page.locator('#replayImport').isVisible(), false);
    assert.equal(await page.locator('#replayExport').isEnabled(), true);
    assert.equal(await page.locator('#openTaskModal').isEnabled(), true);
    await page.locator('#openTaskModal').click();
    await page.locator('#manualCommandTab').click();
    assert.equal(await page.locator('#commandInput').isEnabled(), true, '返回实时后恢复自然语言指令输入');
    await page.locator('#clearSelection').click();
    assert.equal(await page.locator('#navigationStart').isEnabled(), true, '返回实时后恢复建立导航测试');
    check('返回实时现场的最新时刻，恢复指挥操作');

    await page.locator('#exerciseModeTab').click();
    await page.waitForFunction(() => state.replay.mode === 'exercise' && !playbackUi.busy);
    await page.locator('#replayFile').setInputFiles({ name: 'exercise.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
    await page.waitForFunction(() => state.replay.mode === 'exercise' && !playbackUi.busy);
    const imported = diagnostics.requests.find(request => request.path === '/api/replay/load');
    assert(imported, '打开回放文件应调用导入接口');
    assert.equal(imported.payload.archive.format, 'tzb-replay');
    check('打开已保存JSON回放文件');
    imported.payload = { archive: { format: imported.payload.archive.format, frames: imported.payload.archive.frames.length } };

    zeroMode = true; generation += 1; revision += 1;
    serverSocket.send(JSON.stringify(zeroFixture(false)));
    await page.waitForFunction(() => state.sessionId === 'zero-recording' && state.replay?.mode === 'live');
    assert.equal(await page.locator('#replayExport').isDisabled(), true, '零秒记录不保存空演习');
    assert.equal(await page.locator('#exerciseModeTab').isEnabled(), true, '零秒也可进入回放打开已有文件');
    await page.locator('#exerciseModeTab').click();
    await page.waitForFunction(() => state.replay?.mode === 'exercise' && !playbackUi.busy);
    assert.equal(await page.locator('#replayImport').isVisible(), true);
    assert.equal(await page.locator('#replayImport').isEnabled(), true);
    assert.equal(await page.locator('#replaySeek').isDisabled(), true);
    check('初始零秒可切换到演习页打开文件，空记录不允许保存');

    assert.deepEqual(diagnostics.errors, []); assert.deepEqual(diagnostics.unexpectedApi, []);
    assert.deepEqual(diagnostics.externalRequests, []);
    assert.equal(diagnostics.requests.some(request => request.path === '/api/replay/config'), false, '界面不再启用预计算模式');
    diagnostics.finalState = await page.evaluate(() => ({ time: state.elapsed, generation: state.replay.generation,
      min: $('replaySeek').min, max: $('replaySeek').max, view: state.mapMode }));
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      await page.screenshot({ path: reportPath.replace(/\.json$/, '') + '.png' });
      fs.writeFileSync(reportPath, JSON.stringify({ ok: true, ...diagnostics }, null, 2));
    }
    console.log(JSON.stringify({ ok: true, reportPath, ...diagnostics }, null, 2));
  } catch (error) {
    if (reportPath) {
      await page.screenshot({ path: reportPath.replace(/\.json$/, '') + '-failure.png' }).catch(() => {});
      fs.writeFileSync(reportPath, JSON.stringify({ ok: false, failure: error.stack, ...diagnostics }, null, 2));
    }
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
