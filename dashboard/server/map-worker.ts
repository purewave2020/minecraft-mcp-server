import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MapState, WorldMap } from './types.js';
import { Store } from './store.js';

const bridge = fileURLToPath(new URL('../bridge/remote.py', import.meta.url));
export class MapWorker {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;
  private busy = false;
  readonly state: MapState;
  constructor(readonly directory: string, readonly store: Store, readonly interval = 300_000) {
    this.state = { available: fs.existsSync(path.join(directory, 'web/index.html')), syncing: false,
      snapshotAt: null, syncedAt: null, renderedAt: null, progress: '准备同步真实世界', error: null, maps: [], ...store.meta('mapState', {}) };
    this.state.syncing = false;
    this.state.available = fs.existsSync(path.join(directory, 'web/index.html'));
    if (!this.state.available) this.state.renderedAt = null;
    this.readManifest();
  }
  private readManifest(): void {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(this.directory, 'world-manifest.json'), 'utf8'));
      this.state.snapshotAt = manifest.snapshotAt; this.state.syncedAt = manifest.syncedAt;
      this.state.maps = JSON.parse(fs.readFileSync(path.join(this.directory, 'maps.json'), 'utf8')) as WorldMap[];
    } catch { /* Initial setup has not completed. */ }
  }
  private publish(): void {
    this.store.setMeta('mapState', this.state);
    this.store.event('map.status', this.state);
  }
  private run(command: string, args: string[], cwd?: string, render = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const log = fs.createWriteStream(path.join(this.directory, render ? 'render.log' : 'sync.log'), { flags: 'a', mode: 0o600 });
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let tail = '';
      let lastUpdate = 0;
      const consume = (chunk: Buffer): void => {
        const text = chunk.toString(); log.write(text); tail = (tail + text).slice(-4000);
        if (render && Date.now() - lastUpdate > 1200) {
          // eslint-disable-next-line no-control-regex -- BlueMap emits ANSI color sequences.
          const line = text.trim().split(/[\r\n]/).filter(Boolean).at(-1)?.replace(/\u001b\[[\d;]*m/g, '');
          const percent = line && /updating map .*?: ([\d.]+)%/.exec(line)?.[1];
          const progress = percent ? `正在生成三维地图 ${Number(percent).toFixed(0)}%` :
            /Downloading|Loading resources/.test(line ?? '') ? '正在准备地图资源' :
              /Rendering terrain/.test(line ?? '') ? '正在生成地形与建筑' : null;
          if (progress) { this.state.progress = progress; lastUpdate = Date.now(); this.publish(); }
        }
      };
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.on('error', error => { log.end(); reject(error); });
      child.on('close', code => {
        log.end(); if (this.child === child) this.child = null;
        if (code === 0 && (!render || tail.includes('Your maps are now all up-to-date!'))) resolve();
        else { console.error('[dashboard map]', tail); reject(new Error(render ? '三维地图渲染失败，详见本地 render.log' : '存档快照同步失败，保留上次地图并自动重试')); }
      });
    });
  }
  async cycle(sync = true): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true; this.state.syncing = true; this.state.error = null;
    try {
      this.state.progress = '正在同步一致性存档并更新三维地图'; this.publish();
      await this.run('python3', [bridge, 'update', ...(sync ? [] : ['--no-sync'])], undefined, true);
      this.readManifest();
      if (!fs.existsSync(path.join(this.directory, 'web/index.html'))) throw new Error('地图网页尚未生成');
      if (!this.state.maps.length || this.state.maps.some(map => {
        const root = path.join(this.directory, 'web/maps', map.id);
        return !fs.existsSync(path.join(root, 'settings.json')) || !fs.existsSync(path.join(root, 'textures.json.gz')) || !fs.existsSync(path.join(root, 'tiles'));
      })) throw new Error('三维地图数据不完整，保留上次视图');
      this.state.available = true; this.state.renderedAt = new Date().toISOString(); this.state.progress = '地图已更新';
      this.store.event('map.updated', { renderedAt: this.state.renderedAt, snapshotAt: this.state.snapshotAt });
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.syncing = false; this.busy = false; this.publish();
      if (!this.stopped) this.timer = setTimeout(() => void this.cycle(), this.interval);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    if (child && child.exitCode === null) await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGTERM'); });
  }
}
