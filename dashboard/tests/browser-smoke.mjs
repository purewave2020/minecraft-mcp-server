// These chat fixtures enter only this browser's EventSource, never the server or game chat.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:18100';
const output = path.resolve(process.env.DASHBOARD_DATA ?? fileURLToPath(new URL('../../.npm/dashboard', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.DASHBOARD_BROWSER ? { channel: process.env.DASHBOARD_BROWSER } : {}),
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    ...(process.env.DASHBOARD_PASSWORD ? { httpCredentials: { username: 'dashboard', password: process.env.DASHBOARD_PASSWORD } } : {}) });
  await context.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        if (String(url).startsWith('/api/events')) window.__dashboardFixtureStream = this;
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/map/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.minecraftDashboard && window.bluemap?.mapViewer?.map && document.querySelector('.dashboard-marker'), undefined, { timeout: 90_000 });
  const data = await page.evaluate(() => fetch('/api/snapshot').then(response => response.json()));
  const online = data.players.filter(player => player.online && player.position);
  assert.ok(online.length, 'A live player is required for the real-world browser check');
  const player = online.find(player => player.name === 'LLMBot') ?? online[0];
  await page.evaluate(id => window.minecraftDashboard.selectPlayer(id), player.id);
  await page.locator('.md-detail-actions .primary').click({ force: true });
  await page.waitForFunction(() => !!window.bluemap.mapControls.data.followingPlayer);
  assert.equal(await page.locator('.md-detail h2').textContent(), player.name);
  assert.equal(await page.locator('body > #app').isVisible(), false);
  assert.equal(await page.evaluate(() => window.bluemap.mapViewer.controlsManager.distance), 0);
  // Inspect the player's overhead bubbles from the overview, outside their first-person view.
  await page.locator('.md-detail-actions .primary', { hasText: '停止跟随' }).click({ force: true });
  await page.getByRole('button', { name: '⌖ 定位' }).click({ force: true });
  const prefix = '浏览器气泡回归测试';
  const fixture = `browser-${Date.now()}`;
  const inject = async (suffix, content, ttl = 60_000) => page.evaluate(({ id, player, content, ttl }) => {
    const now = Date.now();
    window.__dashboardFixtureStream.dispatchEvent(new MessageEvent('chat.message', { data: JSON.stringify({
      id, playerId: player.id, username: player.name, content, timestamp: now, expiresAt: now + ttl, historical: false
    }) }));
  }, { id: fixture + suffix, player, content, ttl });
  const label = page.locator('.dashboard-marker').filter({ has: page.locator('.md-player-label', { hasText: player.name }) });
  await inject('a', prefix + ' 中文 😀');
  await inject('a', prefix + ' 中文 😀');
  await inject('b', prefix + ' 中文 😀');
  await page.waitForFunction(prefix => [...document.querySelectorAll('.md-message p')].filter(el => el.textContent === prefix + ' 中文 😀').length === 2, prefix);
  assert.equal(await label.locator('.md-chat-bubble').count(), 2, 'Duplicate IDs collapse while identical text with distinct IDs remains');
  await inject('c', prefix + ' <img data-fixture src=x onerror="window.fixtureExecuted=true">');
  await inject('d', prefix + ' 最多三条 🎈');
  await page.waitForFunction(() => document.querySelectorAll('.is-selected .md-chat-bubble').length === 3);
  assert.equal(await label.locator('[data-fixture]').count(), 0);
  assert.equal(await page.evaluate(() => window.fixtureExecuted === true), false);
  await label.locator('.md-bubbles').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'chat-bubbles.png') });
  const toggle = page.locator('.md-bubble-toggle input');
  await toggle.uncheck({ force: true });
  await label.locator('.md-bubbles').waitFor({ state: 'hidden' });
  await toggle.check({ force: true });
  await label.locator('.md-bubbles').waitFor({ state: 'visible' });
  // Restore the genuine snapshot before testing an ordinary eight-second message.
  await page.evaluate(async () => {
    const snapshot = await fetch('/api/snapshot').then(response => response.json());
    window.__dashboardFixtureStream.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
  });
  await inject('expiry', prefix + ' 八秒过期', 8000);
  await label.locator('.md-chat-bubble').filter({ hasText: prefix + ' 八秒过期' }).waitFor({ state: 'visible' });
  await page.locator('.md-detail-actions .primary', { hasText: '跟随玩家' }).click({ force: true });
  await page.evaluate(() => window.minecraftDashboard.refresh());
  await page.waitForTimeout(11_000);
  assert.ok(await page.locator('.dashboard-marker').count() >= online.length);
  assert.equal(await label.locator('.md-chat-bubble').filter({ hasText: prefix }).count(), 0, 'Bubbles expire after eight seconds');
  assert.equal(await page.locator('.md-detail h2').textContent(), player.name);
  assert.equal(await page.locator('.md-detail-actions .primary').textContent(), '停止跟随');
  await page.evaluate(async () => {
    const snapshot = await fetch('/api/snapshot').then(response => response.json());
    window.__dashboardFixtureStream.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
  });
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await page.mouse.move(620, 360); await page.mouse.down();
  await page.mouse.move(700, 400, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => !window.bluemap.mapControls.data.followingPlayer);
  await page.locator('.md-detail-actions .primary', { hasText: '跟随玩家' }).waitFor();
  await page.close();
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(base + '/map/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await mobile.waitForSelector('.md-detail-actions .primary:enabled');
  await mobile.locator('.md-detail-actions .primary').click({ force: true });
  await mobile.waitForTimeout(1200);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: path.join(output, 'mobile.png') });
  await mobile.getByRole('button', { name: '关闭玩家详情' }).click({ force: true });
  await mobile.locator('.md-open-players').click({ force: true });
  assert.ok(await mobile.locator('.md-player-row').count() >= online.length);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, players: online.length, checks: ['real-map', 'follow-and-manual-pan', 'chat-Chinese-emoji', 'safe-text', 'dedup', 'max-three', 'eight-second-expiry', 'tile-refresh', 'marker-refresh', 'mobile'], screenshots: output }));
} finally { await browser.close(); }
