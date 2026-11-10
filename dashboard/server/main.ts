import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { WorldState } from './world-state.js';
import { Collector } from './collector.js';
import { MapWorker } from './map-worker.js';
import { streamEvents } from './stream-events.js';
import { Voice4Speech } from './voice4-speech.js';
import { BackgroundSpeech } from './background-speech.js';

process.umask(0o077);
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = process.env.DASHBOARD_DATA ?? path.join(root, '.npm/dashboard');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(directory, 'web'), { recursive: true });
const botNames = new Set(['LLMBot', 'GPTBot', 'GrokBot', 'DevinBot', 'ClaudeBot', 'SWEBot']);
const store = new Store(path.join(directory, 'dashboard.sqlite'));
const world = new WorldState(store, botNames);
const speech = new BackgroundSpeech(store, new Voice4Speech(path.join(directory, 'speech'), process.env.DASHBOARD_OFFLINE === '1' ? 'offline' : process.platform));
const collector = new Collector(store, world);
const mapWorker = new MapWorker(directory, store, Number(process.env.DASHBOARD_SYNC_MS ?? 300_000));
const app = Fastify({ logger: false, requestTimeout: 15_000 });
const detailQueries = new Map<string, number>();
const snapshot = (): Record<string, unknown> => ({
  players: Array.from(world.players.values()).map(player => ({ ...player, inventory: [] })),
  chat: store.chats(),
  activity: store.db.prepare("SELECT data FROM events WHERE type='world.event' ORDER BY id DESC LIMIT 30").all().reverse().map(row => JSON.parse(String(row.data))),
  collector: collector.status, metrics: collector.metrics, map: mapWorker.state, environment: { ...world.environment.state },
  speech: { ...speech.status }, cursor: store.lastEventId(), now: Date.now()
});

const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
const password = process.env.DASHBOARD_PASSWORD;
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !password) throw new Error('Set DASHBOARD_PASSWORD before binding to the LAN');
app.addHook('onRequest', async (request, reply) => {
  if (!password) return;
  const expected = Buffer.from('dashboard:' + password).toString('base64');
  if (request.headers.authorization !== 'Basic ' + expected) return reply.code(401).header('WWW-Authenticate', 'Basic realm="Minecraft Dashboard"').send('需要登录');
});
app.get('/', (_request, reply) => reply.redirect('/map/'));
app.get('/health', () => ({ ok: true, collector: collector.status, mapAvailable: mapWorker.state.available }));
app.get('/api/snapshot', () => snapshot());
app.get('/api/speech/status', () => speech.status);
app.post<{ Body: { enabled?: unknown } }>('/api/speech', async (request, reply) => {
  const enabled = request.body?.enabled;
  if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled 必须是布尔值' });
  try {
    return await speech.setEnabled(enabled);
  } catch {
    return reply.code(503).send({ error: '声音4后台播报暂不可用，请确认已安装该系统声音后重试' });
  }
});
app.post<{ Body: { id?: unknown; text?: unknown; source?: unknown } }>('/api/speech/messages', async (request, reply) => {
  const { id, text, source = 'douyin' } = request.body ?? {};
  if (typeof id !== 'string' || !/^[\w:.-]{1,200}$/.test(id)
      || typeof text !== 'string' || !text.trim() || text.length > 1000 || source !== 'douyin') {
    return reply.code(400).send({ error: '需要有效的 id、text（1–1000 字）和 source: douyin' });
  }
  try {
    const status = await speech.enqueueAnnouncement(id, text, source);
    if (status === 'disabled') return reply.code(409).send({ error: 'dashboard 后台播报已关闭' });
    if (status === 'full') return reply.code(429).header('Retry-After', '2').send({ error: '播报队列已满，请稍后使用相同 id 重试' });
    if (status === 'empty') return reply.code(400).send({ error: '播报文本为空' });
    return reply.code(status === 'queued' ? 202 : 200).send({ id, status, pending: speech.status.pending });
  } catch {
    return reply.code(503).send({ error: 'dashboard 后台语音暂不可用' });
  }
});
app.get<{ Params: { id: string } }>('/api/players/:id', (request, reply) => {
  const player = Array.from(world.players.values()).find(value => value.id === request.params.id);
  if (!player) return reply.code(404).send({ error: '玩家不存在' });
  if (process.env.DASHBOARD_OFFLINE !== '1' && player.online && Date.now() - (detailQueries.get(player.id) ?? 0) > 5000) {
    detailQueries.set(player.id, Date.now()); collector.queryPlayer(player.name);
  }
  return player;
});
app.get<{ Params: { id: string }; Querystring: { minutes?: string } }>('/api/players/:id/trail', request => {
  const minutes = Math.min(60, Math.max(1, Number(request.query.minutes) || 15));
  return store.points(request.params.id, Date.now() - minutes * 60_000);
});
app.get<{ Querystring: { after?: string } }>('/api/events', (request, reply) => {
  const header = request.headers['last-event-id'];
  const requested = Number(Array.isArray(header) ? header[0] : header ?? request.query.after ?? 0);
  const cursor = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
  reply.hijack();
  streamEvents(reply.raw, store, cursor, snapshot);
});

await app.register(fastifyStatic, { root: path.join(root, 'dashboard/dist'), prefix: '/ui/', decorateReply: true });
// The dashboard owns player markers and SSE; vanilla BlueMap managers receive empty live layers.
app.get('/map/maps/:map/live/players.json', () => ({ players: [] }));
app.get('/map/maps/:map/live/markers.json', () => ({}));
app.get('/map/maps/:map/live/sse', (_request, reply) => reply.code(204).send());
app.get('/map/', (_request, reply) => {
  const index = path.join(directory, 'web/index.html');
  if (fs.existsSync(index)) return reply.type('text/html').send(fs.readFileSync(index));
  return reply.type('text/html').send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>世界沙盘</title><link rel="stylesheet" href="/ui/dashboard.css"></head><body style="margin:0;background:#15272b"><script src="/ui/dashboard.js"></script></body></html>');
});
await app.register(fastifyStatic, { root: path.join(directory, 'web'), prefix: '/map/', decorateReply: false, preCompressed: true, index: false, maxAge: '1m' });
app.setErrorHandler((error, _request, reply) => {
  console.error('[dashboard HTTP]', error instanceof Error ? error.message : String(error));
  void reply.code(500).send({ error: '面板请求失败，请稍后重试' });
});
store.on('parseError', () => { collector.status.parseErrors++; });
const prune = setInterval(() => store.prune(), 600_000); prune.unref(); store.prune();
const port = Number(process.env.DASHBOARD_PORT ?? 18100);
const address = await app.listen({ host, port });
console.log(`Minecraft dashboard: ${address}/`);
void speech.start();
if (process.env.DASHBOARD_OFFLINE !== '1') collector.start();
if (process.env.DASHBOARD_SKIP_RENDER !== '1') void mapWorker.cycle(!fs.existsSync(path.join(directory, 'world-manifest.json')));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return; stopping = true;
  clearInterval(prune); collector.stop(); await Promise.all([mapWorker.stop(), speech.stop()]);
  app.server.closeAllConnections(); await app.close(); store.close();
}
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
