import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundSpeech, type BackgroundVoice } from '../server/background-speech.js';
import { Store } from '../server/store.js';
import type { ChatMessage, DashboardEvent } from '../server/types.js';
import { VOICE4_ID } from '../server/voice4-speech.js';

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
function voice() {
  const spoken: Array<{ text: string; end: () => void; fail: () => void }> = [];
  let canceled = 0; let stopped = 0;
  const player: BackgroundVoice = {
    capabilities: async () => ({ available: true, voiceId: VOICE4_ID }),
    play: text => new Promise<void>((resolve, reject) => { spoken.push({ text, end: resolve, fail: () => reject(new Error('fixture')) }); }),
    cancelPlayback: () => { canceled++; }, stop: async () => { stopped++; }
  };
  return { player, spoken, canceled: () => canceled, stopped: () => stopped };
}
const message = (id: string): ChatMessage => ({
  id, playerId: null, username: 'Fixture', content: '后台聊天 😀', timestamp: Date.now(), expiresAt: Date.now() + 8000, historical: false
});

test('background consumes new chat without a browser, ignores history and never duplicates for multiple subscribers', async () => {
  const store = new Store(':memory:'); const v = voice();
  const history = message('snapshot'); store.chat(history);
  const speech = new BackgroundSpeech(store, v.player);
  const first: DashboardEvent[] = []; const second: DashboardEvent[] = [];
  try {
    await speech.start(); assert.equal(speech.status.ready, true); assert.equal(v.spoken.length, 0);
    store.event('chat.message', history);
    store.event('chat.message', { ...message('history'), historical: true });
    store.event('chat.message', message('new')); await flush();
    assert.equal(v.spoken.length, 1); assert.equal(v.spoken[0].text, 'Fixture 说：后台聊天 😀');
    store.on('event', event => first.push(event)); store.on('event', event => second.push(event));
    store.event('chat.message', message('new')); store.event('chat.message', message('next')); await flush();
    assert.equal(v.spoken.length, 1);
    v.spoken[0].end(); await flush(); assert.equal(v.spoken.length, 2);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map(event => event.id), first.map(event => event.id).sort((a, b) => a - b), 'SSE IDs must stay in order');
  } finally { await speech.stop(); store.close(); }
});

test('global switch cancels playback, persists across backend instances and does not reannounce on page reads', async () => {
  const store = new Store(':memory:'); const v = voice(); let speech = new BackgroundSpeech(store, v.player);
  try {
    await speech.start(); store.event('chat.message', message('a')); await flush();
    store.event('chat.message', message('queued')); await flush();
    await speech.setEnabled(false);
    assert.equal(v.canceled(), 1); assert.equal(speech.status.pending, 0); assert.equal(store.meta('speechEnabled', true), false);
    const revision = speech.status.revision;
    await speech.stop(); assert.equal(v.stopped(), 1);
    const restarted = voice(); speech = new BackgroundSpeech(store, restarted.player);
    await speech.start(); assert.equal(speech.status.enabled, false); assert.equal(speech.status.ready, false);
    assert.ok(speech.status.revision > revision);
    store.event('chat.message', message('while-off')); await flush();
    assert.equal(restarted.spoken.length, 0);
    await speech.setEnabled(true); await speech.setEnabled(true);
    assert.equal(restarted.spoken.length, 1); assert.match(restarted.spoken[0].text, /后台聊天播报已开启/);
    assert.equal(store.meta('speechEnabled', false), true);
    const status = { ...speech.status }; assert.equal(status.ready, true);
    assert.equal(restarted.spoken.length, 1);
  } finally { await speech.stop(); store.close(); }
});

test('disabling while the voice probe is pending prevents startup playback', async () => {
  const store = new Store(':memory:'); const v = voice();
  let resolve!: (value: { available: boolean; voiceId: string }) => void;
  v.player.capabilities = () => new Promise(done => { resolve = done; });
  const speech = new BackgroundSpeech(store, v.player);
  try {
    const starting = speech.start(); await speech.setEnabled(false);
    resolve({ available: true, voiceId: VOICE4_ID }); await starting;
    store.event('chat.message', message('a')); await flush();
    assert.equal(speech.status.ready, false); assert.equal(v.spoken.length, 0);
  } finally { await speech.stop(); store.close(); }
});

test('an unavailable or different voice stays unavailable without fallback', async () => {
  const store = new Store(':memory:'); const v = voice();
  v.player.capabilities = async () => ({ available: true, voiceId: 'another-voice' });
  const speech = new BackgroundSpeech(store, v.player);
  try {
    await speech.start(); assert.equal(speech.status.supported, false); assert.equal(speech.status.ready, false);
    await assert.rejects(speech.setEnabled(true), /声音4/);
    store.event('chat.message', message('a')); await flush(); assert.equal(v.spoken.length, 0);
    await speech.setEnabled(false); assert.match(speech.status.error ?? '', /声音4不可用/);
  } finally { await speech.stop(); store.close(); }
});

test('external replies join game chat in arrival order and duplicate submissions are acknowledged once', async () => {
  const store = new Store(':memory:'); const v = voice();
  let speech = new BackgroundSpeech(store, v.player);
  try {
    await speech.start();
    store.event('chat.message', { ...message('game-first'), content: '游戏先到' }); await flush();
    assert.equal(await speech.enqueueAnnouncement('douyin:123', '观众回复第二条', 'douyin'), 'queued');
    store.event('chat.message', { ...message('game-last'), content: '游戏第三条' }); await flush();
    assert.equal(await speech.enqueueAnnouncement('douyin:123', '观众回复第二条', 'douyin'), 'duplicate');
    assert.equal(speech.status.pending, 2); assert.equal(v.spoken.length, 1);
    v.spoken[0].end(); await flush(); assert.equal(v.spoken[1].text, '观众回复第二条');
    v.spoken[1].end(); await flush(); assert.equal(v.spoken[2].text, 'Fixture 说：游戏第三条');
    assert.equal(v.canceled(), 0);
    await speech.stop();
    const restarted = voice(); speech = new BackgroundSpeech(store, restarted.player);
    await speech.start();
    assert.equal(await speech.enqueueAnnouncement('douyin:123', '重试请求', 'douyin'), 'duplicate');
    assert.equal(restarted.spoken.length, 0);
  } finally { await speech.stop(); store.close(); }
});

test('the global speech switch applies to external replies and rejects them while disabled', async () => {
  const store = new Store(':memory:'); const v = voice(); const speech = new BackgroundSpeech(store, v.player);
  try {
    await speech.start(); await speech.setEnabled(false);
    assert.equal(await speech.enqueueAnnouncement('retry', '面板重新开启后再提交', 'douyin'), 'disabled');
    assert.equal(v.spoken.length, 0);
    await speech.setEnabled(true);
    assert.equal(await speech.enqueueAnnouncement('retry', '面板重新开启后再提交', 'douyin'), 'queued');
    v.spoken[0].end(); await flush(); assert.equal(v.spoken[1].text, '面板重新开启后再提交');
  } finally { await speech.stop(); store.close(); }
});
