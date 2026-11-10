// Player fixtures stay inside this browser; this check never moves a real Minecraft player.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:18100';
const output = path.resolve(process.env.DASHBOARD_DATA ?? fileURLToPath(new URL('../../.npm/dashboard', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
let player = {
  id: 'follow-fixture', name: 'ViewFixture', bot: false, online: true, dimension: 'minecraft:overworld',
  position: { x: -486, y: 73, z: 2 }, rotation: { yaw: 0, pitch: 0 }, health: 20, food: 20, xp: 0,
  inventory: [], equipment: {}, effects: [], observedAt: Date.now(), positionAt: Date.now(), joinedAt: Date.now()
};
const browser = await chromium.launch({
  ...(process.env.DASHBOARD_BROWSER ? { channel: process.env.DASHBOARD_BROWSER } : {}), headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true,
    ...(process.env.DASHBOARD_PASSWORD ? { httpCredentials: { username: 'dashboard', password: process.env.DASHBOARD_PASSWORD } } : {}) });
  context.setDefaultTimeout(30_000);
  await context.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); if (String(url).startsWith('/api/events')) window.followFixtureStream = this; queueMicrotask(() => this.onopen?.()); }
      close() {}
    };
  });
  await context.route('**/api/snapshot', async route => {
    const response = await route.fetch(); const snapshot = await response.json(); const now = Date.now();
    snapshot.players = [player]; snapshot.chat = [];
    snapshot.environment = { timeOfDay: 6000, timeRate: 0, timeObservedAt: now, weather: 'clear', weatherObservedAt: now };
    snapshot.now = now; await route.fulfill({ response, json: snapshot });
  });
  await context.route('**/api/players/follow-fixture', route => route.fulfill({ json: player }));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.goto(base + '/map/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.minecraftDashboard && window.bluemap?.mapViewer.data.mapState === 'loaded' && document.querySelector('.dashboard-marker'), undefined, { timeout: 90_000 });
  await page.evaluate(id => window.minecraftDashboard.selectPlayer(id), player.id);
  await page.getByRole('button', { name: '⌖ 定位' }).click({ force: true });
  const follow = () => page.locator('.md-detail-actions .primary', { hasText: '跟随玩家' }).click();
  const inject = async update => {
    player = { ...player, ...update, positionAt: Date.now() };
    await page.evaluate(value => window.followFixtureStream.dispatchEvent(new MessageEvent('player.update', { data: JSON.stringify(value) })), player);
  };
  const pose = () => page.evaluate(() => {
    const viewer = window.bluemap.mapViewer; const cm = viewer.controlsManager;
    return { position: viewer.camera.position.toArray(), direction: viewer.camera.getWorldDirection(viewer.camera.position.clone()).toArray(),
      distance: cm.distance, ortho: cm.ortho, following: !!window.bluemap.mapControls.data.followingPlayer };
  });
  const waitPose = async direction => {
    await page.waitForFunction(({ position, direction }) => {
      const viewer = window.bluemap.mapViewer; const cm = viewer.controlsManager;
      const eye = viewer.camera.position; const look = viewer.camera.getWorldDirection(eye.clone());
      return cm.distance === 0 && cm.ortho === 0 && Math.hypot(eye.x - position.x, eye.y - position.y - 1.62, eye.z - position.z) < 0.03
        && look.toArray().every((value, i) => Math.abs(value - direction[i]) < 0.001);
    }, { position: player.position, direction });
  };
  await follow(); await waitPose([0, 0, 1]);
  await page.evaluate(() => window.bluemap.followPlayerMarkerWorld());
  await page.locator('.dashboard-marker').waitFor({ state: 'hidden' });
  for (const [yaw, pitch, direction] of [
    [90, 0, [-1, 0, 0]], [180, 0, [0, 0, -1]], [-90, 0, [1, 0, 0]],
    [0, -45, [0, Math.SQRT1_2, Math.SQRT1_2]], [0, 45, [0, -Math.SQRT1_2, Math.SQRT1_2]],
    [0, -90, [0, 1, 0]], [0, 90, [0, -1, 0]]
  ]) {
    await inject({ rotation: { yaw, pitch } }); await waitPose(direction);
  }
  console.log('Verified eye height, cardinal directions and pitch against the rendered camera.');
  await inject({ rotation: { yaw: 179, pitch: 0 } }); await waitPose([-Math.sin(Math.PI / 180), 0, -Math.cos(Math.PI / 180)]);
  await inject({ rotation: { yaw: -179, pitch: 0 } });
  const northward = await page.evaluate(() => new Promise(resolve => {
    const directions = [];
    const sample = () => {
      const camera = window.bluemap.mapViewer.camera; directions.push(camera.getWorldDirection(camera.position.clone()).z);
      if (directions.length < 20) requestAnimationFrame(sample); else resolve(directions);
    };
    requestAnimationFrame(sample);
  }));
  assert.ok(northward.every(z => z < -0.99), 'crossing +/-180 must not spin around through south');
  await inject({ position: { x: -484, y: 16, z: 5 }, rotation: { yaw: 0, pitch: 0 } }); await waitPose([0, 0, 1]);
  await inject({ position: { x: -486, y: 73, z: 2 } }); await waitPose([0, 0, 1]);
  await page.evaluate(() => window.minecraftDashboard.refresh()); await waitPose([0, 0, 1]);
  await page.screenshot({ path: path.join(output, 'follow-first-person.png') });
  assert.equal((await pose()).following, true, 'refresh keeps first-person following');
  console.log('Verified shortest turns, underground height and map refresh.');
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true });
  assert.equal((await pose()).distance, 110, 'stopping restores the overview');
  await page.locator('.dashboard-marker').waitFor({ state: 'visible' });
  await follow(); await waitPose([0, 0, 1]);
  await page.mouse.move(620, 360); await page.mouse.down(); await page.mouse.move(700, 400, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  const afterDrag = await pose(); assert.ok(afterDrag.distance > 15); assert.ok(Math.hypot(afterDrag.position[0] - player.position.x, afterDrag.position[2] - player.position.z) > 1);
  for (const name of ['3D', '俯视', '放大地图', '缩小地图']) {
    await follow(); await waitPose([0, 0, 1]);
    await page.getByRole('button', { name, exact: true }).click({ force: true });
    assert.equal((await pose()).following, false, name + ' returns to manual viewing');
  }
  await follow(); await waitPose([0, 0, 1]); await page.mouse.move(650, 350); await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  await follow(); await waitPose([0, 0, 1]);
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'follow-text-fixture'; document.body.append(input); input.focus(); });
  await page.keyboard.type('wasd'); assert.equal((await pose()).following, true, 'typing in a text field keeps following');
  await page.evaluate(() => document.querySelector('#follow-text-fixture').remove()); await page.keyboard.press('w');
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  console.log('Verified manual camera buttons, mouse, wheel and keyboard.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.minecraftDashboard && window.bluemap?.mapViewer.data.mapState === 'loaded' && document.querySelector('.dashboard-marker'), undefined, { timeout: 90_000 });
  await follow(); await waitPose([0, 0, 1]);
  const cdp = await context.newCDPSession(page);
  assert.equal(await page.evaluate(() => document.elementFromPoint(30, 220) === window.bluemap.mapViewer.renderer.domElement), true, 'touch the map outside the player details');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 30, y: 220 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 50, y: 250 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  await follow(); await waitPose([0, 0, 1]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'follow-mobile.png') });
  await inject({ online: false });
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  await page.locator('.md-detail-actions .primary:disabled').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['eye-height', 'cardinal-directions', 'pitch-up-and-down', 'shortest-yaw', 'underground-height', 'refresh-keeps-view', 'restore-overview', 'mouse-drag', 'camera-buttons', 'wheel', 'keyboard', 'mobile-touch', 'offline-player'], screenshots: output }));
} finally { await browser.close(); }
