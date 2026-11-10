import type { ServerResponse } from 'node:http';
import type { DashboardEvent } from './types.js';
import type { Store } from './store.js';

/** End slow streams after flushing their buffer; EventSource resumes from the last delivered ID. */
export function streamEvents(response: ServerResponse, store: Store, cursor: number, snapshot: () => Record<string, unknown>): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    store.off('event', send);
  };
  const write = (text: string): void => {
    if (closed) return;
    if (!response.write(text)) { cleanup(); response.end(); }
  };
  const send = (event: DashboardEvent): void => write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
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
