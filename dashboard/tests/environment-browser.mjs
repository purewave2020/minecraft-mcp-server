// Only this browser receives simulated environment events. The game time/weather are never changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:18100';
const output = path.resolve(process.env.DASHBOARD_DATA ?? fileURLToPath(new URL('../../.npm/dashboard', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.DASHBOARD_BROWSER ? { channel: process.env.DASHBOARD_BROWSER } : {}), headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    ...(process.env.DASHBOARD_PASSWORD ? { httpCredentials: { username: 'dashboard', password: process.env.DASHBOARD_PASSWORD } } : {}) });
  context.setDefaultTimeout(30_000);
  await context.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); if (String(url).startsWith('/api/events')) window.environmentFixtureStream = this; queueMicrotask(() => this.onopen?.()); }
      close() {}
    };
  });
  await context.route('**/api/snapshot', async route => {
    const response = await route.fetch(); const snapshot = await response.json(); const now = Date.now();
    snapshot.environment = { timeOfDay: 6000, timeRate: 0, timeObservedAt: now, weather: 'clear', weatherObservedAt: now };
    snapshot.now = now; await route.fulfill({ response, json: snapshot });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/map/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.bluemap?.mapViewer.data.mapState === 'loaded' && document.querySelector('.md-weather-layer'), undefined, { timeout: 90_000 });
  let observedAt = Date.now();
  const inject = async (ticks, weather, extra = {}) => {
    observedAt = Math.max(observedAt + 1, Date.now());
    await page.evaluate(environment => window.environmentFixtureStream.dispatchEvent(new MessageEvent('world.environment', { data: JSON.stringify(environment) })), {
      timeOfDay: ticks, timeRate: 0, timeObservedAt: observedAt, weather, weatherObservedAt: observedAt, ...extra
    });
  };
  const sunlight = () => page.evaluate(() => window.bluemap.mapViewer.data.uniforms.sunlightStrength.value);
  const luminance = () => page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
    const ctx = canvas.getContext('2d'); ctx.drawImage(window.bluemap.mapViewer.renderer.domElement, 0, 0, 160, 100);
    const pixels = ctx.getImageData(0, 0, 160, 100).data; let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    return sum / (pixels.length / 4);
  });
  await inject(6000, 'clear');
  await page.waitForFunction(() => window.bluemap.mapViewer.data.uniforms.sunlightStrength.value > 0.99);
  await page.locator('.md-environment-status', { hasText: '白昼 12:00 · 晴' }).waitFor();
  const dayLight = await luminance();
  await page.screenshot({ path: path.join(output, 'environment-day.png') });
  const defaults = await page.evaluate(() => {
    const data = window.bluemap.mapViewer.map.data;
    return { sky: [data.skyColor.r, data.skyColor.g, data.skyColor.b], ambient: data.ambientLight, sunlight: data.skyLight };
  });
  await inject(18000, 'clear');
  await page.waitForFunction(() => window.bluemap.mapViewer.data.uniforms.sunlightStrength.value < 0.15);
  assert.match(await page.locator('.md-environment-status').textContent(), /夜晚 00:00/);
  const nightLight = await luminance(); assert.ok(nightLight < dayLight * 0.8, `terrain darkens: day=${dayLight}, night=${nightLight}`);
  await page.screenshot({ path: path.join(output, 'environment-night.png') });
  await inject(13000, 'clear'); await page.locator('.md-environment-status[data-phase="dusk"]').waitFor();
  await inject(0, 'clear'); await page.locator('.md-environment-status[data-phase="dawn"]').waitFor();
  await inject(6000, 'rain');
  await page.locator('.md-weather-layer[data-weather="rain"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const value = window.bluemap.mapViewer.data.uniforms.sunlightStrength.value;
    return Math.abs(value - 0.7525) < 0.01;
  });
  const rainLight = await sunlight();
  const hasRainPixels = await page.evaluate(() => {
    const canvas = document.querySelector('.md-weather-layer');
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0);
  });
  assert.equal(hasRainPixels, true); assert.equal(await page.locator('.md-weather-layer').evaluate(canvas => getComputedStyle(canvas).pointerEvents), 'none');
  await page.screenshot({ path: path.join(output, 'environment-rain.png') });
  await inject(6000, 'thunder');
  await page.waitForFunction(() => Math.abs(window.bluemap.mapViewer.data.uniforms.sunlightStrength.value - 0.55) < 0.01);
  assert.ok(await sunlight() < rainLight); assert.match(await page.locator('.md-environment-status').textContent(), /雷雨/);
  await page.evaluate(() => window.minecraftDashboard.refresh());
  await page.waitForFunction(() => window.bluemap.mapViewer.data.mapState === 'loaded');
  await page.locator('.md-weather-layer[data-weather="thunder"]').waitFor({ state: 'visible' });
  const afterRefresh = await page.evaluate(() => {
    const data = window.bluemap.mapViewer.map.data;
    return { sky: [data.skyColor.r, data.skyColor.g, data.skyColor.b], ambient: data.ambientLight, sunlight: data.skyLight };
  });
  assert.deepEqual(afterRefresh, defaults, 'changing environment must never mutate BlueMap map defaults');
  // A delayed SSE replay must not replace the newer thunderstorm.
  await page.evaluate(() => window.environmentFixtureStream.dispatchEvent(new MessageEvent('world.environment', { data: JSON.stringify({
    timeOfDay: 6000, timeRate: 0, timeObservedAt: 1, weather: 'clear', weatherObservedAt: 1
  }) })));
  assert.match(await page.locator('.md-environment-status').textContent(), /雷雨/);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await inject(18000, 'rain');
    await page.locator('.md-weather-layer[data-weather="rain"]').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `mobile ${width}`);
    const box = await page.locator('.md-world-status').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width, 'status fits mobile');
  }
  await page.screenshot({ path: path.join(output, 'environment-mobile.png') });
  await inject(6000, 'clear'); await page.locator('.md-weather-layer').waitFor({ state: 'hidden' });
  // Expired observations are labelled as stale rather than inventing weather.
  await page.route('**/api/snapshot', async route => {
    const response = await route.fetch(); const snapshot = await response.json();
    snapshot.environment = { timeOfDay: 6000, timeRate: 0, timeObservedAt: 1, weather: 'clear', weatherObservedAt: 1 };
    snapshot.now = Date.now(); await route.fulfill({ response, json: snapshot });
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.locator('.md-environment-status', { hasText: '待更新' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['native-terrain-day-night', 'game-clock', 'dawn-and-dusk', 'rain', 'thunder', 'refresh-keeps-environment', 'map-defaults-preserved', 'SSE-replay-filter', 'stale-status', 'mobile-390-and-320'], luminance: { day: dayLight, night: nightLight }, screenshots: output }));
} finally { await browser.close(); }
