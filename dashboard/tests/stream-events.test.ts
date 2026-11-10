import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Store } from '../server/store.js';
import { streamEvents } from '../server/stream-events.js';

test('SSE resynchronizes expired and reset cursors, then streams new live events', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 3; i++) store.event('old', { i });
  store.db.prepare('DELETE FROM events WHERE id<3').run();
  const server = createServer((request, response) => streamEvents(response, store, Number(request.url?.slice(1)), () => ({ cursor: store.lastEventId(), complete: true })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    for (const cursor of [1, 9999]) {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/${cursor}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /event: snapshot/);
      assert.match(first, /"complete":true/);
      assert.match(first, new RegExp(`id: ${store.lastEventId()}\n`));
      store.event('chat.message', { content: '中文 😀' });
      const live = new TextDecoder().decode((await reader.read()).value);
      assert.match(live, /event: chat.message/); assert.match(live, /中文 😀/);
      controller.abort(); await reader.cancel().catch(() => {});
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('a slow SSE reader is ended once without writing the remaining backlog or leaking a listener', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 10; i++) store.event('sample', { i });
  class SlowResponse extends EventEmitter {
    writes = 0; ends = 0;
    writeHead(): void {}
    write(): boolean { this.writes++; return false; }
    end(): void { this.ends++; }
  }
  const response = new SlowResponse();
  try {
    streamEvents(response as unknown as ServerResponse, store, 0, () => ({}));
    assert.equal(response.writes, 1); assert.equal(response.ends, 1);
    assert.equal(store.listenerCount('event'), 0);
    store.event('new', {}); assert.equal(response.writes, 1);
  } finally { store.close(); }
});
