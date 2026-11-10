import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { ChatMessage, DashboardEvent, Player, Position } from './types.js';

export class Store extends EventEmitter {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    super();
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trail (id INTEGER PRIMARY KEY, player TEXT NOT NULL, dimension TEXT NOT NULL, x REAL, y REAL, z REAL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS trail_player_at ON trail(player,at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE INDEX IF NOT EXISTS chat_at ON chat(at);
    `);
  }
  meta<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : fallback;
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  }
  event(type: string, data: unknown): DashboardEvent {
    const timestamp = Date.now();
    const result = this.db.prepare('INSERT INTO events(type,data,at) VALUES (?,?,?)').run(type, JSON.stringify(data), timestamp);
    const event = { id: Number(result.lastInsertRowid), type, data, timestamp };
    this.emit('event', event);
    return event;
  }
  events(after: number, limit = 2000): DashboardEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, limit).map(row => ({
      id: Number(row.id), type: String(row.type), data: JSON.parse(String(row.data)), timestamp: Number(row.at)
    }));
  }
  lastEventId(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()?.id ?? 0); }
  players(): Player[] {
    return this.db.prepare('SELECT data FROM players').all().map(row => JSON.parse(String(row.data)) as Player);
  }
  player(player: Player): void {
    this.db.prepare('INSERT OR REPLACE INTO players VALUES (?,?)').run(player.id, JSON.stringify(player));
  }
  chat(message: ChatMessage): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO chat VALUES (?,?,?)').run(message.id, JSON.stringify(message), message.timestamp);
    return result.changes > 0;
  }
  chats(limit = 100): ChatMessage[] {
    return this.db.prepare('SELECT data FROM chat ORDER BY at DESC, rowid DESC LIMIT ?').all(limit).reverse().map(row => JSON.parse(String(row.data)) as ChatMessage);
  }
  addPoint(player: Player): void {
    if (!player.position) return;
    this.db.prepare('INSERT INTO trail(player,dimension,x,y,z,at) VALUES (?,?,?,?,?,?)').run(
      player.id, player.dimension, player.position.x, player.position.y, player.position.z, player.positionAt ?? Date.now()
    );
  }
  points(playerId: string, since: number): Array<Position & { dimension: string; at: number }> {
    return this.db.prepare('SELECT x,y,z,dimension,at FROM trail WHERE player=? AND at>=? ORDER BY at LIMIT 3000').all(playerId, since)
      .map(row => ({ x: Number(row.x), y: Number(row.y), z: Number(row.z), dimension: String(row.dimension), at: Number(row.at) }));
  }
  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM events WHERE at<? OR id < (SELECT COALESCE(MAX(id),0)-50000 FROM events)').run(now - 3600_000);
    this.db.prepare('DELETE FROM chat WHERE at<?').run(now - 7 * 24 * 3600_000);
    this.db.prepare('DELETE FROM trail WHERE at<?').run(now - 24 * 3600_000);
  }
  close(): void { this.db.close(); }
}
