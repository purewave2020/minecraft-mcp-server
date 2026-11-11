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
const second = { ...player, id: 'switch-fixture', name: 'SwitchFixture', position: { x: -475, y: 80, z: 16 }, rotation: { yaw: 90, pitch: -30 } };
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
    snapshot.players = [player, second].map(value => ({ ...value, positionAt: now })); snapshot.entities = []; snapshot.chat = [];
    snapshot.environment = { timeOfDay: 6000, timeRate: 0, timeObservedAt: now, weather: 'clear', weatherObservedAt: now };
    snapshot.now = now; await route.fulfill({ response, json: snapshot });
  });
  await context.route('**/api/players/follow-fixture', route => route.fulfill({ json: player }));
  await context.route('**/api/players/switch-fixture', route => route.fulfill({ json: second }));
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
  const waitPose = async (direction, target = player) => {
    await page.waitForFunction(({ position, direction }) => {
      const viewer = window.bluemap.mapViewer; const cm = viewer.controlsManager;
      const eye = viewer.camera.position; const look = viewer.camera.getWorldDirection(eye.clone());
      return cm.distance === 0 && cm.ortho === 0 && Math.hypot(eye.x - position.x, eye.y - position.y - 1.62, eye.z - position.z) < 0.03
        && look.toArray().every((value, i) => Math.abs(value - direction[i]) < 0.001);
    }, { position: target.position, direction });
  };
  const thirdView = () => page.getByRole('button', { name: '第三人称', exact: true }).click();
  const firstView = () => page.getByRole('button', { name: '第一人称', exact: true }).click();
  const waitThirdPose = async (target = player) => {
    await page.waitForFunction(({ position, rotation, id }) => {
      const viewer = window.bluemap.mapViewer; const camera = viewer.camera;
      const eye = new window.BlueMap.Three.Vector3(position.x, position.y + 1.62, position.z);
      const direction = camera.getWorldDirection(eye.clone());
      const yaw = rotation.yaw * Math.PI / 180;
      const flatForward = new window.BlueMap.Three.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
      const offset = camera.position.clone().sub(eye); const verticalLook = Math.asin(-direction.y) * 180 / Math.PI;
      return !!window.bluemap.mapControls.data.followingPlayer && viewer.controlsManager.ortho === 0
        && Math.abs(offset.length() - 3.5) < 0.03 && offset.dot(flatForward) < -1.3
        && direction.dot(offset.clone().normalize()) < -0.999
        && Math.abs(verticalLook - Math.max(-25, Math.min(65, rotation.pitch + 12))) < 0.1
        && viewer.markers.getObjectByName('dashboard-entity:' + id).visible;
    }, target);
  };
  const playerPixels = () => page.evaluate(id => {
    const map = window.bluemap.mapViewer; const model = map.markers.getObjectByName('dashboard-entity:' + id); const parent = model.parent;
    const canvas = document.createElement('canvas'); canvas.width = map.renderer.domElement.width; canvas.height = map.renderer.domElement.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const read = () => { map.render(0); ctx.drawImage(map.renderer.domElement, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; };
    const withPlayer = read(); model.removeFromParent(); const withoutPlayer = read(); parent.add(model); map.redraw();
    let count = 0;
    for (let i = 0; i < withPlayer.length; i += 4) if (Math.abs(withPlayer[i] - withoutPlayer[i]) + Math.abs(withPlayer[i + 1] - withoutPlayer[i + 1]) + Math.abs(withPlayer[i + 2] - withoutPlayer[i + 2]) > 12) count++;
    return count;
  }, player.id);
  const waitStablePose = async expected => {
    await page.evaluate(() => new Promise(resolve => {
      let frames = 0; const frame = () => { if (++frames === 10) resolve(); else requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    }));
    const actual = await pose();
    assert.equal(actual.following, false); assert.equal(actual.distance, expected.distance); assert.equal(actual.ortho, expected.ortho);
    for (const key of ['position', 'direction']) assert.ok(actual[key].every((value, i) => Math.abs(value - expected[key][i]) < 0.00001), key + ' remains fixed after ending follow');
  };
  await follow(); await waitPose([0, 0, 1]);
  await page.evaluate(() => window.bluemap.followPlayerMarkerWorld());
  const primaryMarker = page.locator('.dashboard-marker').filter({ has: page.locator('.md-player-label', { hasText: player.name }) });
  await primaryMarker.waitFor({ state: 'hidden' });
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
  await page.locator('.md-player-row', { hasText: second.name }).click();
  await waitPose([-Math.sqrt(3) / 2, 0.5, 0], second);
  assert.equal(await page.locator('.md-detail-actions .primary').textContent(), '停止跟随', 'changing players continues following');
  await page.evaluate(id => window.minecraftDashboard.selectPlayer(id), player.id); await waitPose([0, 0, 1]);
  await page.evaluate(({ first, second }) => { window.minecraftDashboard.selectPlayer(second); window.minecraftDashboard.selectPlayer(first); }, { first: player.id, second: second.id });
  await waitPose([0, 0, 1]);
  const stoppedPose = await pose();
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true });
  await waitStablePose(stoppedPose);
  assert.equal(await primaryMarker.count(), 1, 'ending follow retains the player marker even when it is outside the current camera view');
  await inject({ position: { x: -480, y: 75, z: 8 }, rotation: { yaw: 90, pitch: 0 } });
  await waitStablePose(stoppedPose);
  await inject({ position: { x: -486, y: 73, z: 2 }, rotation: { yaw: 0, pitch: 0 } });
  for (const [height, pitch, direction] of [[73, -60, [0, Math.sqrt(3) / 2, 0.5]], [16, 60, [0, -Math.sqrt(3) / 2, 0.5]]]) {
    await inject({ position: { ...player.position, y: height }, rotation: { yaw: 0, pitch } });
    await follow(); await waitPose(direction); const before = await pose();
    await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true }); await waitStablePose(before);
  }
  await inject({ position: { x: -486, y: 73, z: 2 }, rotation: { yaw: 0, pitch: 0 } });
  console.log('Verified switching followed players, rapid selections and frozen camera after stopping, including underground and upward views.');

  await inject({ position: { x: -486, y: 160, z: 2 } }); await follow(); await waitPose([0, 0, 1]);
  await thirdView(); await waitThirdPose();
  assert.equal(await page.getByRole('button', { name: '第三人称', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.ok(await playerPixels() > 2000, 'third-person view must render the followed player in actual WebGL pixels');
  await page.screenshot({ path: path.join(output, 'follow-third-person.png') });
  for (const [yaw, pitch] of [[90, 20], [180, -20], [-90, 40], [0, -90], [0, 90]]) {
    await inject({ rotation: { yaw, pitch } }); await waitThirdPose();
  }
  await inject({ position: { x: -480, y: 163, z: 8 }, rotation: { yaw: 0, pitch: 0 } }); await waitThirdPose();
  await page.evaluate(() => window.minecraftDashboard.refresh()); await waitThirdPose();
  second.position = { x: -475, y: 160, z: 16 }; second.positionAt = Date.now();
  await page.evaluate(value => window.followFixtureStream.dispatchEvent(new MessageEvent('player.update', { data: JSON.stringify(value) })), second);
  await page.locator('.md-player-row', { hasText: second.name }).click(); await waitThirdPose(second);
  assert.equal(await page.getByRole('button', { name: '第三人称', exact: true }).getAttribute('aria-pressed'), 'true', 'switching players keeps third person');
  await page.evaluate(id => window.minecraftDashboard.selectPlayer(id), player.id); await waitThirdPose();
  const thirdStoppedPose = await pose();
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true }); await waitStablePose(thirdStoppedPose);
  await inject({ position: { x: -482, y: 164, z: 6 }, rotation: { yaw: 90, pitch: 0 } }); await waitStablePose(thirdStoppedPose);
  await inject({ rotation: { yaw: 0, pitch: 0 } }); await follow(); await waitThirdPose();
  await page.evaluate(position => {
    const three = window.BlueMap.Three; const map = window.bluemap.mapViewer;
    const wall = new three.Mesh(new three.BoxGeometry(6, 6, 0.3), new three.MeshBasicMaterial({ color: '#735641' }));
    wall.name = 'follow-camera-wall'; wall.position.set(position.x, position.y + 1.62, position.z - 1.5);
    map.map.hiresTileManager.scene.add(wall); map.redraw();
  }, player.position);
  await page.waitForFunction(position => {
    const camera = window.bluemap.mapViewer.camera; const distance = Math.hypot(camera.position.x - position.x, camera.position.y - position.y - 1.62, camera.position.z - position.z);
    return distance > 0.8 && distance < 1.5 && camera.position.z > position.z - 1.35;
  }, player.position);
  const compressedPose = await pose();
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true }); await waitStablePose(compressedPose);
  await page.evaluate(() => {
    const map = window.bluemap.mapViewer; const wall = map.map.hiresTileManager.scene.getObjectByName('follow-camera-wall');
    wall.removeFromParent(); wall.geometry.dispose(); wall.material.dispose(); map.redraw();
  });
  await waitStablePose(compressedPose); await follow(); await waitThirdPose();
  await firstView(); await waitPose([0, 0, 1]);
  assert.equal(await page.evaluate(id => window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:' + id).visible, player.id), false, 'first-person switch hides the followed model again');
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true });
  await inject({ position: { x: -486, y: 73, z: 2 } });
  console.log('Verified third-person distance, own model pixels, turns, movement, player switching, terrain collision and stopping.');

  await follow(); await waitPose([0, 0, 1]);
  await page.mouse.move(620, 360); await page.mouse.down(); await page.mouse.move(700, 400, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  const afterDrag = await pose(); assert.equal(afterDrag.distance, 0); assert.ok(Math.abs(afterDrag.direction[0]) + Math.abs(afterDrag.direction[1]) > 0.01, 'drag continues from the current first-person camera');
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
  await thirdView(); await inject({ position: { x: -486, y: 160, z: 2 } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.minecraftDashboard && window.bluemap?.mapViewer.data.mapState === 'loaded' && document.querySelector('.dashboard-marker'), undefined, { timeout: 90_000 });
  assert.equal(await page.getByRole('button', { name: '第三人称', exact: true }).getAttribute('aria-pressed'), 'true', 'reload keeps the preferred follow view');
  await follow(); await waitThirdPose();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(id => {
    const map = window.bluemap.mapViewer; const point = map.markers.getObjectByName('dashboard-entity:' + id).position.clone();
    point.y += 1; point.project(map.camera); const canvas = map.renderer.domElement; const rect = canvas.getBoundingClientRect();
    return document.elementFromPoint(rect.left + (point.x + 1) * rect.width / 2, rect.top + (1 - point.y) * rect.height / 2) === canvas;
  }, player.id), true, 'mobile details must leave the followed player visible');
  await page.screenshot({ path: path.join(output, 'follow-third-person-mobile.png') });
  await firstView(); await waitPose([0, 0, 1]);
  const cdp = await context.newCDPSession(page);
  assert.equal(await page.evaluate(() => document.elementFromPoint(30, 220) === window.bluemap.mapViewer.renderer.domElement), true, 'touch the map outside the player details');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 30, y: 220 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 50, y: 250 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  await follow(); await waitPose([0, 0, 1]);
  await page.locator('.md-open-players').click();
  await page.locator('.md-player-row', { hasText: second.name }).click();
  await waitPose([-Math.sqrt(3) / 2, 0.5, 0], second);
  await thirdView(); await waitThirdPose(second);
  await page.evaluate(id => window.minecraftDashboard.selectPlayer(id), player.id); await waitThirdPose();
  await firstView();
  await page.evaluate(id => window.minecraftDashboard.selectPlayer(id), player.id); await waitPose([0, 0, 1]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'follow-mobile.png') });
  const beforeOffline = await pose(); await inject({ online: false });
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  await page.locator('.md-detail-actions .primary:disabled').waitFor();
  await waitStablePose(beforeOffline);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['eye-height', 'cardinal-directions', 'pitch-up-and-down', 'shortest-yaw', 'underground-height', 'refresh-keeps-view', 'switch-followed-player', 'rapid-selection', 'stop-keeps-pose', 'stopped-player-movement', 'third-person-camera-and-pixels', 'third-person-movement-and-turns', 'third-person-switch-player', 'third-person-stop-keeps-pose', 'third-person-terrain-collision', 'follow-view-switch-and-persistence', 'mouse-drag', 'camera-buttons', 'wheel', 'keyboard', 'mobile-touch', 'mobile-switch-player', 'mobile-third-person', 'offline-keeps-pose'], screenshots: output }));
} finally { await browser.close(); }
