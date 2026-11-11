import type { ServerResponse } from 'node:http';
import type { DashboardEvent } from './types.js';
import type { Store } from './store.js';

/** Respect backpressure for large entity frames; bound genuinely slow readers and allow SSE resume. */
export function streamEvents(response: ServerResponse, store: Store, cursor: number, snapshot: () => Record<string, unknown>): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let closed = false;
  let paused = false;
  let queuedBytes = 0;
  const pending: string[] = [];
  let heartbeat: NodeJS.Timeout | undefined;
  let drainTimeout: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(drainTimeout);
    pending.length = 0; queuedBytes = 0;
    response.off('drain', drain);
    store.off('event', send);
  };
  const finish = (): void => { if (!closed) { cleanup(); response.end(); } };
  const write = (text: string): void => {
    if (closed) return;
    if (paused) {
      queuedBytes += Buffer.byteLength(text);
      if (queuedBytes > 256 * 1024) { finish(); return; }
      pending.push(text); return;
    }
    if (!response.write(text)) {
      paused = true;
      drainTimeout = setTimeout(finish, 10_000);
    }
  };
  function drain(): void {
    if (closed) return;
    paused = false; clearTimeout(drainTimeout);
    while (pending.length && !paused && !closed) {
      const text = pending.shift()!; queuedBytes -= Buffer.byteLength(text); write(text);
    }
  }
  const send = (event: DashboardEvent): void => write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  response.on('drain', drain);
  response.on('close', cleanup);
  response.on('error', cleanup);
  const backlog = store.events(cursor);
  const latest = store.lastEventId();
  if (cursor > latest || backlog.length === 2000 || (cursor && (backlog[0]?.id ?? latest + 1) > cursor + 1)) {
    write(`id: ${latest}\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  } else {
    for (const event of backlog) { send(event); if (closed) break; }
  }
  if (closed) return;
  store.on('event', send);
  write(': connected\n\n');
  if (!closed) heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
}
