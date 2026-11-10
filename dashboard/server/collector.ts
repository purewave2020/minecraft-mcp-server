import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LogDecoder, WorldState } from './world-state.js';
import { Store } from './store.js';

const bridge = fileURLToPath(new URL('../bridge/remote.py', import.meta.url));
export class Collector {
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  private querying = new Map<string, ChildProcess>();
  readonly status = { connected: false, observedAt: 0, error: null as string | null, parseErrors: 0 };
  metrics: Record<string, unknown> | null = null;
  constructor(readonly store: Store, readonly world: WorldState) {}
  start(): void {
    if (this.stopped || this.child) return;
    const args = [bridge, 'live', '--cursor', JSON.stringify(this.store.meta('logCursor', null))];
    this.child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new LogDecoder(this.world, this.store);
    let stderr = '';
    this.child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on('line', line => {
      if (!line.startsWith('{')) return;
      try {
        const message = JSON.parse(line);
        if (message.type === 'log') {
          decoder.chunk(String(message.file), Number(message.offset), Buffer.from(message.bytes, 'base64'), message.historical === true);
        } else if (message.type === 'metrics') {
          this.metrics = message.data;
          this.store.event('server.metrics', this.metrics);
        } else if (message.type === 'heartbeat' || message.type === 'bridge') {
          this.status.connected = true; this.status.observedAt = Date.now(); this.status.error = null; this.failures = 0;
          this.store.event('collector.status', this.status);
        }
      } catch (error) {
        this.status.parseErrors++;
        console.error('[dashboard collector]', error instanceof Error ? error.message : String(error));
      }
    });
    this.child.on('error', error => { stderr = error.message; });
    this.child.on('close', () => {
      lines.close(); this.child = null;
      this.status.connected = false;
      this.status.error = stderr ? '服务器采集连接中断，正在重试' : '服务器采集连接已关闭，正在重试';
      this.store.event('collector.status', this.status);
      if (stderr) console.error('[dashboard SSH]', stderr.slice(-1500));
      if (!this.stopped) this.retry = setTimeout(() => this.start(), Math.min(30_000, 1000 * 2 ** this.failures++));
    });
  }
  queryPlayer(name: string): void {
    if (this.stopped || !/^[A-Za-z0-9_]{1,16}$/.test(name) || this.querying.has(name)) return;
    const child = spawn('python3', [bridge, 'query', '--username', name], { stdio: 'ignore', timeout: 25_000 });
    this.querying.set(name, child);
    child.on('error', () => { this.querying.delete(name); });
    child.on('close', () => { this.querying.delete(name); });
  }
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.child?.kill('SIGTERM');
    for (const child of this.querying.values()) child.kill('SIGTERM');
  }
}
