import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { WorldState } from '../server/world-state.js';

test('isolated HTTP service authenticates every route and serves player details without live connections', { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-http-test-'));
  const store = new Store(path.join(directory, 'dashboard.sqlite'));
  const world = new WorldState(store, new Set());
  world.entity('Fixture', { Pos: [1, 72, 3], Rotation: [-90, -25], Health: 20, foodLevel: 16, Inventory: [{ Slot: 0, id: 'minecraft:stone', count: 3 }] }, Date.now());
  const player = world.get('Fixture'); store.close();
  const child = spawn(process.execPath, ['--import=tsx', fileURLToPath(new URL('../server/main.ts', import.meta.url))], {
    env: { ...process.env, DASHBOARD_DATA: directory, DASHBOARD_PORT: '0', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PASSWORD: 'fixture-password', DASHBOARD_OFFLINE: '1', DASHBOARD_SKIP_RENDER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  try {
    const base = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const found = /Minecraft dashboard: (http:\/\/[^\s]+)\//.exec(output);
        if (found) resolve(found[1]);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Isolated service exited: ' + code)));
    });
    const headers = { Authorization: 'Basic ' + Buffer.from('dashboard:fixture-password').toString('base64') };
    for (const route of ['/health', '/api/snapshot', '/api/speech/status', '/map/', '/ui/dashboard.js', '/map/maps/overworld/live/sse']) {
      assert.equal((await fetch(base + route)).status, 401, route);
    }
    assert.equal((await fetch(base + '/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status, 401);
    assert.equal((await fetch(base + '/api/speech/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a', text: 'test' }) })).status, 401);
    assert.equal((await fetch(base + '/health', { headers })).status, 200);
    const snapshot = await fetch(base + '/api/snapshot', { headers }).then(response => response.json());
    assert.equal(snapshot.collector.connected, false); assert.equal(snapshot.players.length, 1);
    assert.deepEqual(snapshot.entities, []);
    assert.deepEqual(snapshot.players[0].rotation, { yaw: -90, pitch: -25 });
    assert.equal(snapshot.environment.timeOfDay, null); assert.equal(snapshot.environment.weather, null);
    assert.equal(snapshot.speech.voiceId, 'com.apple.siri.natural.zh-CN-D');
    const detail = await fetch(base + '/api/players/' + player.id, { headers }).then(response => response.json());
    assert.equal(detail.name, 'Fixture'); assert.equal(detail.inventory[0].count, 3);
    assert.deepEqual(detail.rotation, snapshot.players[0].rotation);
    const postSpeech = (body: unknown) => fetch(base + '/api/speech', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const body of [{}, { enabled: 'false' }, null]) assert.equal((await postSpeech(body)).status, 400);
    assert.equal((await postSpeech({ enabled: true })).status, 503, 'offline tests must not access real audio');
    const enqueueSpeech = (body: unknown) => fetch(base + '/api/speech/messages', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    for (const body of [null, {}, { id: 'x', text: ' ' }, { id: 'bad/id', text: 'x' },
      { id: 'x', text: 'x'.repeat(1001) }, { id: 'x', text: 'x', source: 'unknown' }]) {
      assert.equal((await enqueueSpeech(body)).status, 400);
    }
    assert.equal((await enqueueSpeech({ id: 'douyin:room:1', text: '排队播报', source: 'douyin' })).status, 503);
    const disabled = await postSpeech({ enabled: false });
    assert.equal(disabled.status, 200); assert.equal((await disabled.json()).enabled, false);
    assert.equal((await fetch(base + '/api/speech/status', { headers }).then(response => response.json())).enabled, false);
    assert.equal((await fetch(base + '/api/speech/audio?text=test', { headers })).status, 404);
    assert.equal((await fetch(base + '/map/maps/overworld/live/sse', { headers })).status, 204);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
