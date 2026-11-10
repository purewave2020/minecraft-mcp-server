// Isolated UI integration: no game connection and no real audio is played.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const assets = fileURLToPath(new URL('../dist/', import.meta.url));
let speech = { supported: true, loading: false, enabled: true, ready: true, speaking: false, pending: 0,
  error: null, voiceName: '声音4', voiceId: 'com.apple.siri.natural.zh-CN-D', revision: 1 };
const changes = []; const clients = new Set();
const broadcast = () => { for (const client of clients) client.write(`event: speech.status\ndata: ${JSON.stringify(speech)}\n\n`); };
const server = createServer(async (request, response) => {
  if (request.url === '/api/snapshot') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ players: [], chat: [], activity: [], collector: { connected: true, observedAt: Date.now(), error: null, parseErrors: 0 }, metrics: null,
      map: { available: false, syncing: false, snapshotAt: null, syncedAt: null, renderedAt: null, progress: '测试', error: null, maps: [] }, speech, cursor: 1 }));
  } else if (request.url.startsWith('/api/events')) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': connected\n\n');
    clients.add(response); response.on('close', () => clients.delete(response));
  } else if (request.url === '/api/speech' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const { enabled } = JSON.parse(body); changes.push(enabled);
    speech = { ...speech, enabled, ready: enabled, speaking: false, error: null, revision: speech.revision + 1 };
    broadcast(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(speech));
  } else if (['/ui/dashboard.js', '/ui/dashboard.css'].includes(request.url)) {
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(fs.readFileSync(assets + request.url.slice(4)));
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/dashboard.css"></head><body><script src="/ui/dashboard.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.DASHBOARD_BROWSER ? { channel: process.env.DASHBOARD_BROWSER } : {}), headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    // Browsers must never construct audio, even when chat arrives or the global switch changes.
    window.Audio = class { constructor() { throw new Error('unexpected browser audio'); } };
    window.speechSynthesis.speak = () => { throw new Error('unexpected browser speech'); };
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await second.goto(base);
  await page.getByText('后台播报已开', { exact: true }).waitFor();
  await second.getByText('后台播报已开', { exact: true }).waitFor();
  assert.match(await page.locator('.md-speech-toggle').getAttribute('title'), /本机后台.*声音4/);
  assert.deepEqual(changes, [], 'opening pages must not enable or restart speech');
  await page.getByRole('button', { name: '关闭聊天语音播报' }).click();
  await second.getByText('开启播报', { exact: true }).waitFor();
  assert.deepEqual(changes, [false]);
  await second.getByRole('button', { name: '开启聊天语音播报' }).click();
  await page.getByText('后台播报已开', { exact: true }).waitFor();
  assert.deepEqual(changes, [false, true]);
  const old = { ...speech };
  speech = { ...speech, speaking: true, revision: speech.revision + 1 }; broadcast();
  await page.getByText('正在播报', { exact: true }).waitFor();
  for (const client of clients) client.write(`event: speech.status\ndata: ${JSON.stringify(old)}\n\n`);
  assert.equal(await page.locator('.md-speech-toggle').textContent(), '正在播报');
  const now = Date.now();
  for (const client of clients) client.write(`event: chat.message\ndata: ${JSON.stringify({ id: 'fixture', username: 'Fixture', playerId: null,
    content: '只在后台播放 😀', timestamp: now, expiresAt: now + 8000, historical: false })}\n\n`);
  await page.getByText('只在后台播放 😀', { exact: true }).waitFor();
  await page.reload(); await page.getByText('正在播报', { exact: true }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `mobile ${width}`);
    assert.equal(await page.locator('.md-speech-toggle').isVisible(), true);
  }
  await page.close(); await second.close();
  assert.equal(speech.ready, true); assert.deepEqual(changes, [false, true], 'closing all browsers must leave background enabled');
  speech = { ...speech, supported: false, ready: false, speaking: false, error: '声音4不可用，请确认面板所在 Mac 已安装该声音', revision: speech.revision + 1 };
  const unsupported = await context.newPage(); unsupported.on('pageerror', error => errors.push(error.message));
  await unsupported.goto(base); await unsupported.getByText('声音4不可用', { exact: true }).waitFor();
  assert.equal(await unsupported.locator('.md-speech-toggle').isDisabled(), true);
  assert.match(await unsupported.locator('.md-speech-toggle').getAttribute('title'), /已安装/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['background-only', 'global-switch', 'multiple-pages', 'status-SSE', 'stale-status-filter', 'reload-and-close-preserve-speech', 'missing-voice4', 'mobile-390-and-320'], audio: 'mocked; no game connection' }));
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
