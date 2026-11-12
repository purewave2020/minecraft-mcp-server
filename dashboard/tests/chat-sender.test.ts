import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSender, ChatSendError, chatContent } from '../server/chat-sender.js';
import { Store } from '../server/store.js';
import { offlineId } from '../server/world-state.js';

test('chat accepts literal Chinese, emoji and command-looking text and rejects invalid public chat', () => {
  assert.equal(chatContent('  中文 😀 <img src=x> $(whoami) @a  '), '中文 😀 <img src=x> $(whoami) @a');
  assert.equal(chatContent('/op somebody'), '/op somebody');
  assert.equal(chatContent('😀'.repeat(128)).length, 256);
  for (const value of [null, {}, 12, '', '   ', 'x'.repeat(257), '😀'.repeat(129), 'a\nb', 'a\r', 'a\0b', '§c红色']) {
    assert.throws(() => chatContent(value), (error: unknown) => error instanceof ChatSendError && error.statusCode === 400);
  }
});

test('confirmed sends publish one qingyage event; concurrent clicks do not broadcast twice', async () => {
  const store = new Store(':memory:');
  let finish!: () => void;
  const delivered: string[] = [];
  const sender = new ChatSender(store, content => { delivered.push(content); return new Promise(resolve => { finish = resolve; }); });
  try {
    const pending = sender.send('中文 😀');
    assert.deepEqual(store.chats(), [], 'No optimistic success before the server confirms execution');
    await assert.rejects(sender.send('second'), (error: unknown) => error instanceof ChatSendError && error.statusCode === 429);
    finish();
    const message = await pending;
    assert.equal(message.username, 'qingyage'); assert.equal(message.playerId, offlineId('qingyage'));
    assert.equal(message.content, '中文 😀'); assert.equal(message.historical, false);
    assert.deepEqual(delivered, ['中文 😀']);
    assert.deepEqual(store.chats(), [message]);
    assert.deepEqual(store.events(0).map(event => ({ type: event.type, data: event.data })), [{ type: 'chat.message', data: message }]);
  } finally { store.close(); }
});

test('failed delivery leaves history untouched and releases the send lock for a later send', async () => {
  const store = new Store(':memory:');
  let failed = true;
  const sender = new ChatSender(store, async () => { if (failed) throw new Error('transport failed'); });
  try {
    await assert.rejects(sender.send('未发出'), /transport failed/);
    assert.deepEqual(store.chats(), []); assert.deepEqual(store.events(0), []);
    failed = false;
    await sender.send('已发出');
    assert.equal(store.chats()[0].content, '已发出');
  } finally { store.close(); }
});
