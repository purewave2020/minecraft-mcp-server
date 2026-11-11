// Fixtures affect this browser only. No Minecraft entities are spawned or moved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:18100';
const output = path.resolve(process.env.DASHBOARD_DATA ?? fileURLToPath(new URL('../../.npm/dashboard', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
const now = Date.now();
const player = (id, x, z) => ({ id, name: id, bot: false, online: true, dimension: 'minecraft:overworld',
  position: { x, y: 160, z }, rotation: { yaw: 180, pitch: 0 }, health: 20, food: 20, xp: 0,
  inventory: [], equipment: {}, effects: [], observedAt: now, positionAt: now, joinedAt: now });
const viewer = { ...player('ViewerFixture', -510, 86), rotation: { yaw: 0, pitch: 0 } };
const other = player('OtherFixture', -512, 92);
const mob = (id, type, x, z, overrides = {}) => ({ id, type, name: type, position: { x, y: 160, z },
  dimension: 'minecraft:overworld', rotation: { yaw: 180, pitch: 0 }, baby: false, color: null, sheared: false, observedAt: now, ...overrides });
let entities = [mob('creeper-fixture', 'creeper', -510, 92), mob('sheep-fixture', 'sheep', -508, 92, { color: 15 }),
  mob('baby-fixture', 'pig', -506.8, 91.5, { baby: true }), mob('golem-fixture', 'iron_golem', -513.5, 94),
  mob('nether-fixture', 'piglin', -510, 90, { dimension: 'minecraft:the_nether' })];
const browser = await chromium.launch({ ...(process.env.DASHBOARD_BROWSER ? { channel: process.env.DASHBOARD_BROWSER } : {}),
  headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    ...(process.env.DASHBOARD_PASSWORD ? { httpCredentials: { username: 'dashboard', password: process.env.DASHBOARD_PASSWORD } } : {}) });
  context.setDefaultTimeout(30_000);
  await context.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); if (String(url).startsWith('/api/events')) window.entityFixtureStream = this; queueMicrotask(() => this.onopen?.()); }
      close() {}
    };
  });
  await context.route('**/api/snapshot', async route => {
    const response = await route.fetch(); const snapshot = await response.json(); const now = Date.now();
    snapshot.players = [viewer, other].map(value => ({ ...value, positionAt: now }));
    snapshot.entities = entities.map(entity => ({ ...entity, observedAt: now })); snapshot.chat = []; snapshot.now = now;
    snapshot.environment = { timeOfDay: 6000, timeRate: 0, timeObservedAt: now, weather: 'clear', weatherObservedAt: now };
    await route.fulfill({ response, json: snapshot });
  });
  await context.route('**/api/players/ViewerFixture', route => route.fulfill({ json: viewer }));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.goto(base + '/map/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.minecraftDashboard && window.bluemap?.mapViewer.data.mapState === 'loaded'
    && window.bluemap.mapViewer.markers.getObjectByName('dashboard-entities'), undefined, { timeout: 90_000 });
  await page.evaluate(() => window.minecraftDashboard.selectPlayer('ViewerFixture'));
  const follow = () => page.locator('.md-detail-actions .primary', { hasText: '跟随玩家' }).click();
  const emitEntities = async () => page.evaluate(entities => window.entityFixtureStream.dispatchEvent(new MessageEvent('world.entities',
    { data: JSON.stringify({ entities, observedAt: Date.now() }) })), entities);
  const refreshFixtures = async () => {
    entities = entities.map(entity => ({ ...entity, observedAt: Date.now() })); await emitEntities();
    await page.evaluate(players => {
      for (const player of players) window.entityFixtureStream.dispatchEvent(new MessageEvent('player.update',
        { data: JSON.stringify({ ...player, positionAt: Date.now() }) }));
    }, [viewer, other]);
  };
  const visibility = () => page.evaluate(() => {
    const root = window.bluemap.mapViewer.markers.getObjectByName('dashboard-entities');
    return { active: root.visible, entities: Object.fromEntries(root.children.map(child => [child.userData.entityId, { visible: child.visible,
      type: child.userData.modelType, scale: child.scale.x, x: child.position.x, yaw: child.rotation.y }])) };
  });
  // Compare actual WebGL pixels, including from overview cameras more than 64 blocks away.
  const renderedPixels = async (addWall = false) => page.evaluate(addWall => {
    const app = window.bluemap; const map = app.mapViewer; const three = window.BlueMap.Three;
    const root = map.markers.getObjectByName('dashboard-entities');
    const canvas = document.createElement('canvas'); canvas.width = map.renderer.domElement.width; canvas.height = map.renderer.domElement.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const read = () => { map.render(0); ctx.drawImage(map.renderer.domElement, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++; return n; };
    const withModels = read(); root.removeFromParent(); const withoutModels = read(); map.markers.add(root);
    let blocked = null;
    if (addWall) {
      const wall = new three.Mesh(new three.BoxGeometry(18, 12, 0.5), new three.MeshBasicMaterial({ color: '#735641' }));
      wall.position.set(-510, 162, 89); map.markers.add(wall);
      const withWall = read(); root.removeFromParent(); const without = read(); map.markers.add(root);
      blocked = diff(withWall, without);
      wall.removeFromParent(); wall.geometry.dispose(); wall.material.dispose();
    }
    map.redraw(); return { visible: diff(withModels, withoutModels), blocked };
  }, addWall);
  await page.getByRole('button', { name: '⌖ 定位' }).click({ force: true }); await refreshFixtures();
  await page.waitForFunction(() => window.bluemap.mapViewer.controlsManager.distance === 110
    && window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:creeper-fixture').visible);
  let state = await visibility();
  assert.equal(state.active, true); assert.equal(state.entities.ViewerFixture.visible, true, 'manual view includes the selected player');
  assert.equal(state.entities['nether-fixture'].visible, false);
  assert.ok(await page.evaluate(() => {
    const map = window.bluemap.mapViewer;
    return map.camera.position.distanceTo(map.markers.getObjectByName('dashboard-entity:creeper-fixture').position) > 64;
  }), 'normal overview camera exceeds the former 64-block cutoff');
  const overviewPixels = await renderedPixels();
  assert.ok(overviewPixels.visible > 20, 'overview must render actual entity pixels: ' + JSON.stringify(overviewPixels));
  await page.getByRole('button', { name: '俯视', exact: true }).click(); await refreshFixtures();
  await page.waitForFunction(() => window.bluemap.mapViewer.controlsManager.ortho === 1);
  const topPixels = await renderedPixels();
  assert.ok(topPixels.visible > 4, 'top view must render actual entity pixels: ' + JSON.stringify(topPixels));
  await page.getByRole('button', { name: '缩小地图', exact: true }).click();
  assert.equal((await visibility()).entities['creeper-fixture'].visible, true, 'zooming out keeps entities available');
  console.log('Verified entities in perspective overview, top view and zoomed-out views.', { overviewPixels, topPixels });

  await refreshFixtures(); await follow();
  await page.waitForFunction(() => window.bluemap.mapViewer.controlsManager.distance === 0);
  state = await visibility();
  assert.equal(state.active, true); assert.equal(state.entities.ViewerFixture.visible, false);
  for (const id of ['OtherFixture', 'creeper-fixture', 'sheep-fixture', 'baby-fixture', 'golem-fixture']) assert.equal(state.entities[id].visible, true, id);
  assert.equal(state.entities['nether-fixture'].visible, false); assert.equal(state.entities['baby-fixture'].scale, 0.5);
  const pixels = await renderedPixels(true);
  assert.ok(pixels.visible > 2000, '3D entities must contribute real WebGL pixels: ' + JSON.stringify(pixels));
  assert.equal(pixels.blocked, 0, 'entities must not show through walls');
  entities = entities.map(entity => ({ ...entity, observedAt: Date.now() })); await emitEntities();
  await page.screenshot({ path: path.join(output, 'follow-entities.png') });
  console.log('Verified rendered player/mob pixels, terrain depth, self hiding, dimensions and baby scale.', pixels);

  const beforeStop = await page.evaluate(() => {
    const camera = window.bluemap.mapViewer.camera;
    return { position: camera.position.toArray(), direction: camera.getWorldDirection(camera.position.clone()).toArray() };
  });
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true }); await refreshFixtures();
  state = await visibility();
  assert.equal(state.active, true, 'ending follow retains the entity layer');
  assert.equal(state.entities.ViewerFixture.visible, false, 'the camera inside a player must not be blocked by its model');
  assert.equal(state.entities['creeper-fixture'].visible, true); assert.equal(state.entities.OtherFixture.visible, true);
  const afterStop = await page.evaluate(() => {
    const camera = window.bluemap.mapViewer.camera;
    return { position: camera.position.toArray(), direction: camera.getWorldDirection(camera.position.clone()).toArray() };
  });
  assert.deepEqual(afterStop, beforeStop, 'ending follow keeps the camera while retaining entities');
  const manualPixels = await renderedPixels(true);
  await page.screenshot({ path: path.join(output, 'manual-entities.png') });
  assert.ok(manualPixels.visible > 2000, 'free view must keep rendering the nearby models');
  assert.equal(manualPixels.blocked, 0, 'wall occlusion also works in free view');
  await page.evaluate(() => {
    const map = window.bluemap.mapViewer;
    map.controlsManager.position.z -= 2; map.controlsManager.updateCamera(); map.redraw();
  });
  await page.waitForFunction(() => window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:ViewerFixture').visible);

  entities = entities.map(entity => ({ ...entity, observedAt: Date.now(), ...(entity.id === 'creeper-fixture'
    ? { position: { x: -509, y: 160, z: 92 }, rotation: { yaw: -90, pitch: 30 } } : {}) }));
  await emitEntities();
  await page.waitForFunction(() => {
    const model = window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:creeper-fixture');
    return Math.abs(model.position.x + 509) < 0.03 && Math.abs(Math.sin(model.rotation.y) - 1) < 0.01;
  });
  await page.evaluate(() => window.minecraftDashboard.refresh());
  await page.waitForFunction(() => window.bluemap.mapViewer.data.mapState === 'loaded');
  assert.equal((await visibility()).active, true, 'refresh preserves models');
  entities = entities.map(entity => ({ ...entity, observedAt: Date.now() - 13_000 })); await emitEntities();
  await page.waitForFunction(() => !window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:creeper-fixture').visible);
  entities = []; await emitEntities();
  try { await page.waitForFunction(() => !window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:creeper-fixture'), undefined, { timeout: 5000 }); }
  catch (error) {
    console.log('Removal diagnostics', await visibility(), await page.locator('.md-inline-error').allTextContents(), errors); throw error;
  }
  assert.equal((await visibility()).active, true, 'despawns do not disable the manual entity layer');

  entities = [mob('mobile-sheep', 'sheep', -510, 91)];
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.bluemap?.mapViewer.data.mapState === 'loaded'
    && window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:mobile-sheep'), undefined, { timeout: 90_000 });
  await page.getByRole('button', { name: '⌖ 定位' }).click({ force: true }); await refreshFixtures();
  await page.waitForFunction(() => window.bluemap.mapViewer.markers.getObjectByName('dashboard-entities').visible
    && window.bluemap.mapViewer.markers.getObjectByName('dashboard-entity:mobile-sheep').visible);
  assert.equal(await page.locator('.md-detail-actions .primary').textContent(), '跟随玩家', 'mobile entities are visible before following');
  await follow();
  await page.waitForFunction(() => window.bluemap.mapViewer.markers.getObjectByName('dashboard-entities').visible);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'follow-entities-mobile.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['overview-entities', 'top-view-entities', 'zoom-out', 'real-3d-pixels', 'wall-occlusion', 'player-and-mobs', 'self-hidden', 'dimension-isolation', 'baby-scale',
    'stop-keeps-entities-and-camera', 'free-view-pixels-and-occlusion', 'camera-inside-player', 'smooth-position-rotation', 'map-refresh', 'stale-hide', 'despawn-removal', 'mobile-manual-and-follow'], screenshots: output }));
} finally { await browser.close(); }
