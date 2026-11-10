import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatNarrator, type NarratorStatus } from '../server/chat-narrator.js';
import type { ChatMessage } from '../server/types.js';

function fixture() {
  let now = 1_800_000_000_000;
  const spoken: Array<{ text: string; end: () => void; fail: () => void }> = [];
  let canceled = 0;
  let status: NarratorStatus | null = null;
  const narrator = new ChatNarrator({
    play: text => new Promise<void>((resolve, reject) => { spoken.push({ text, end: resolve, fail: () => reject(new Error('fixture failure')) }); }),
    cancelPlayback: () => { canceled++; }
  }, value => { status = value; }, () => now);
  const message = (id: string, content = '你好，世界 😀', timestamp = now): ChatMessage => ({
    id, username: 'qingyage', playerId: 'fixture', content, timestamp, expiresAt: timestamp + 8000, historical: false
  });
  const end = async (index = spoken.length - 1): Promise<void> => { spoken[index].end(); await Promise.resolve(); };
  return { narrator, spoken, message, end, status: () => status, canceled: () => canceled, advance: (ms: number) => { now += ms; } };
}

test('background speech queues new chat once per ID and never overlaps playback', async () => {
  const f = fixture(); f.narrator.start();
  assert.equal(f.spoken[0].text, '声音四，后台聊天播报已开启');
  f.narrator.enqueue(f.message('a')); f.narrator.enqueue(f.message('a')); f.narrator.enqueue(f.message('b'));
  assert.equal(f.spoken.length, 1);
  await f.end(); assert.equal(f.spoken[1].text, 'qingyage 说：你好，世界 😀');
  await f.end(); assert.equal(f.spoken[2].text, f.spoken[1].text);
  await f.end(); assert.equal(f.status()?.speaking, false);
});

test('service startup is silent and history, replayed IDs, old, blank and disabled chat stay silent', () => {
  const f = fixture();
  f.narrator.remember([f.message('snapshot')]);
  f.narrator.enqueue(f.message('while-off'));
  f.narrator.start(false);
  f.narrator.enqueue(f.message('snapshot')); f.narrator.enqueue(f.message('while-off'));
  f.narrator.enqueue({ ...f.message('history'), historical: true });
  f.narrator.enqueue(f.message('old', '旧聊天', 1_799_999_900_000));
  f.narrator.enqueue(f.message('blank', '   '));
  assert.equal(f.spoken.length, 0);
  f.narrator.enqueue(f.message('fresh')); assert.equal(f.spoken.length, 1);
});

test('disabling cancels playback, clears the queue and ignores late native process completion', async () => {
  const f = fixture(); f.narrator.start();
  f.narrator.enqueue(f.message('queued')); f.narrator.stop();
  assert.equal(f.canceled(), 1); assert.equal(f.status()?.pending, 0);
  f.narrator.start(false); f.narrator.enqueue(f.message('new'));
  await f.end(0);
  assert.equal(f.spoken.length, 2); assert.equal(f.status()?.speaking, true);
  await f.end(); assert.equal(f.status()?.speaking, false);
});

test('queued messages retain FIFO order even while an earlier utterance lasts more than thirty seconds', async () => {
  const f = fixture(); f.narrator.start();
  for (let i = 0; i < 8; i++) f.narrator.enqueue(f.message(String(i), '消息 ' + i));
  assert.equal(f.status()?.pending, 8);
  f.advance(31_000);
  for (let i = 0; i < 8; i++) {
    await f.end(); assert.equal(f.spoken[i + 1].text, 'qingyage 说：消息 ' + i);
  }
  await f.end(); assert.equal(f.status()?.pending, 0);
});

test('Douyin replies and game chat share one FIFO queue without interrupting each other', async () => {
  const f = fixture(); f.narrator.start(false);
  f.narrator.enqueue(f.message('a', '第一条游戏聊天'));
  assert.equal(f.narrator.enqueueText('douyin:a', '抖音回复在中间'), 'queued');
  f.narrator.enqueue(f.message('b', '第三条游戏聊天'));
  assert.equal(f.narrator.enqueueText('douyin:a', '重复回复'), 'duplicate');
  assert.equal(f.spoken.length, 1); assert.equal(f.canceled(), 0); assert.equal(f.status()?.pending, 2);
  await f.end(); assert.equal(f.spoken[1].text, '抖音回复在中间');
  await f.end(); assert.equal(f.spoken[2].text, 'qingyage 说：第三条游戏聊天');
  await f.end(); assert.equal(f.status()?.speaking, false);
});

test('a full queue refuses new replies without replacing older entries and permits retry', async () => {
  const f = fixture(); f.narrator.start(false);
  assert.equal(f.narrator.enqueueText('current', '正在播报'), 'queued');
  for (let i = 0; i < 100; i++) assert.equal(f.narrator.enqueueText('reply:' + i, '排队 ' + i), 'queued');
  assert.equal(f.narrator.enqueueText('later', '队满重试'), 'full');
  assert.equal(f.status()?.pending, 100);
  await f.end(); assert.equal(f.spoken[1].text, '排队 0');
  assert.equal(f.narrator.enqueueText('later', '队满重试'), 'queued');
  f.narrator.stop();
});

test('native playback failure stops narration, discards its queue and permits an explicit retry', async () => {
  const f = fixture(); f.narrator.start(); f.narrator.enqueue(f.message('a'));
  f.spoken[0].fail(); await Promise.resolve();
  assert.equal(f.status()?.enabled, false); assert.match(f.status()?.error ?? '', /后台.*重试/);
  assert.equal(f.status()?.pending, 0);
  f.narrator.start(); await f.end(); assert.equal(f.spoken.length, 2);
});

test('narration strips Minecraft formatting and normalizes whitespace', () => {
  const f = fixture(); f.narrator.start(false);
  f.narrator.enqueue(f.message('a', '§a中文\n 聊天'));
  assert.equal(f.spoken[0].text, 'qingyage 说：中文 聊天');
});
