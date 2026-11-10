import { createHash } from 'node:crypto';
import { parseSnbt, type Nbt } from './snbt.js';
import type { ChatMessage, Item, Player, Position, Rotation } from './types.js';
import { Store } from './store.js';
import { EnvironmentTracker } from './environment.js';

export function offlineId(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function object(value: Nbt | undefined): Record<string, Nbt> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function number(value: Nbt | undefined): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function item(value: Nbt | undefined, slot?: number | string): Item | null {
  const data = object(value);
  const id = data.id ?? data.Id;
  if (typeof id !== 'string' || id === 'minecraft:air') return null;
  return { name: id.replace(/^minecraft:/, ''), count: number(data.count ?? data.Count) ?? 1, slot };
}
function position(value: Nbt | undefined): Position | null {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) };
}
function rotation(value: Nbt | undefined): Rotation | null {
  if (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return { yaw: Number(value[0]), pitch: Math.max(-90, Math.min(90, Number(value[1]))) };
}
function logTime(text: string, receivedAt: number): number {
  const [hour, minute, second] = text.split(':').map(Number);
  // The game server and UI use Asia/Shanghai; log lines omit their calendar date.
  const day = Math.floor((receivedAt + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  let timestamp = day + hour * 3600_000 + minute * 60_000 + second * 1000;
  if (timestamp > receivedAt + 12 * 3600_000) timestamp -= 86400_000;
  if (timestamp < receivedAt - 12 * 3600_000) timestamp += 86400_000;
  return timestamp;
}

export class WorldState {
  readonly players = new Map<string, Player>();
  readonly environment: EnvironmentTracker;
  constructor(readonly store: Store, readonly botNames: Set<string>) {
    this.environment = new EnvironmentTracker(store);
    for (const player of store.players()) this.players.set(player.name, { ...player, rotation: player.rotation ?? null });
  }
  get(name: string): Player {
    let player = this.players.get(name);
    if (!player) {
      player = { id: offlineId(name), name, bot: this.botNames.has(name), online: true, dimension: 'minecraft:overworld',
        position: null, rotation: null, health: null, food: null, xp: null, inventory: [], equipment: {}, effects: [],
        observedAt: null, positionAt: null, joinedAt: Date.now() };
      this.players.set(name, player);
    }
    return player;
  }
  changed(player: Player, hasPosition = false): void {
    this.store.player(player);
    // The stream carries compact state. Full inventories stay behind the detail endpoint.
    this.store.event('player.update', { ...player, inventory: [] });
    if (hasPosition) this.store.addPoint(player);
  }
  entity(name: string, nbt: Nbt, at: number, scalarType?: 'health' | 'food'): void {
    const player = this.get(name);
    player.online = true;
    if (typeof nbt === 'string') {
      if (/^minecraft:(overworld|the_nether|the_end)$/.test(nbt)) {
        if (player.dimension !== nbt) { player.position = null; player.positionAt = null; }
        player.dimension = nbt; this.changed(player);
      }
      return;
    }
    if (typeof nbt === 'number') {
      if (scalarType === 'health') player.health = nbt;
      else if (scalarType === 'food') player.food = nbt;
      else return;
      player.observedAt = at; this.changed(player); return;
    }
    if (Array.isArray(nbt)) {
      const pos = position(nbt);
      if (pos) { player.position = pos; player.positionAt = at; this.changed(player, true); }
      const rot = rotation(nbt);
      if (rot) { player.rotation = rot; this.changed(player); }
      return;
    }
    const data = object(nbt);
    const pos = position(data.Pos ?? data.pos);
    if (pos) { player.position = pos; player.positionAt = at; }
    const rot = rotation(data.Rotation ?? data.rotation);
    if (rot) player.rotation = rot;
    const dimension = data.Dimension ?? data.dimension;
    if (typeof dimension === 'string') player.dimension = dimension;
    player.health = number(data.Health ?? data.health);
    player.food = number(data.foodLevel ?? data.food_level ?? data.food);
    player.xp = number(data.XpLevel ?? data.xp_level);
    const inventory = data.Inventory ?? data.inventory;
    if (Array.isArray(inventory)) player.inventory = inventory.map(entry => item(entry, number(object(entry).Slot ?? object(entry).slot) ?? undefined))
      .filter((entry): entry is Item => entry !== null);
    const equipment = object(data.equipment);
    const slots: Record<string, number> = { head: 103, chest: 102, legs: 101, feet: 100, offhand: -106 };
    player.equipment = {};
    for (const [slot, slotId] of Object.entries(slots)) {
      player.equipment[slot] = item(equipment[slot]) ?? player.inventory.find(entry => entry.slot === slotId || (slot === 'offhand' && entry.slot === 150)) ?? null;
    }
    const selected = number(data.SelectedItemSlot ?? data.selected_item_slot) ?? 0;
    player.equipment.mainhand = item(equipment.mainhand ?? data.SelectedItem ?? data.selected_item) ?? player.inventory.find(entry => entry.slot === selected) ?? null;
    const effects = data.active_effects ?? data.ActiveEffects;
    player.effects = Array.isArray(effects) ? effects.map(effect => String(object(effect).id ?? object(effect).Id ?? '')).filter(Boolean) : [];
    player.observedAt = at;
    this.changed(player, !!pos);
  }
  line(line: string, sourceId: string, historical: boolean, receivedAt = Date.now()): void {
    const prefix = /^\[(\d{2}:\d{2}:\d{2})\] \[Server thread\/INFO\]: (.*)$/.exec(line);
    if (!prefix) return;
    const timestamp = logTime(prefix[1], receivedAt);
    const body = prefix[2];
    const chat = /^(?:\[Not Secure\] )?<([A-Za-z0-9_]{1,16})> (.*)$/.exec(body);
    if (chat) {
      const message: ChatMessage = { id: sourceId, playerId: offlineId(chat[1]), username: chat[1], content: chat[2],
        timestamp, expiresAt: timestamp + 8000, historical };
      if (this.store.chat(message)) this.store.event('chat.message', message);
      return;
    }
    const clean = body.replace(/^System chat: /, '');
    if (this.environment.line(clean, timestamp, historical)) return;
    const data = /^([A-Za-z0-9_]{1,16}) has the following entity data: (.+)$/.exec(clean);
    if (data) {
      if (!historical) {
        const scalarType = /^[\d.+-]+f$/i.test(data[2]) ? 'health' : /^\d+$/.test(data[2]) ? 'food' : undefined;
        this.entity(data[1], parseSnbt(data[2]), timestamp, scalarType);
      }
      return;
    }
    const list = /^There are (\d+) of a max of \d+ players online(?:: ?(.*))?$/.exec(clean);
    if (list && !historical) {
      const online = new Set((list[2] ?? '').split(', ').map(entry => /^([A-Za-z0-9_]{1,16})(?: \(|$)/.exec(entry)?.[1]).filter(Boolean));
      if (online.size !== Number(list[1])) return;
      for (const player of this.players.values()) if (player.online && !online.has(player.name)) { player.online = false; this.changed(player); }
      for (const name of online) if (name) {
        const player = this.get(name);
        if (!player.online) { player.online = true; player.joinedAt = timestamp; this.changed(player); }
      }
      return;
    }
    const presence = /^([A-Za-z0-9_]{1,16}) (joined|left) the game$/.exec(clean);
    if (presence) {
      if (!historical) {
        const player = this.get(presence[1]); player.online = presence[2] === 'joined';
        if (player.online) { player.joinedAt = timestamp; player.position = null; player.positionAt = null; player.rotation = null; }
        this.changed(player);
      }
      this.store.event('world.event', { id: sourceId, kind: presence[2], text: clean, timestamp, historical });
      return;
    }
    if (/^[A-Za-z0-9_]{1,16} (?:was |died|fell |drowned|blew up|burned |tried |hit |went |starved|suffocated|froze|discovered |has made |has completed |has reached )/.test(clean)) {
      this.store.event('world.event', { id: sourceId, kind: 'activity', text: clean, timestamp, historical });
    }
  }
}

/** Byte offsets, rather than message text or timestamps, distinguish repeated identical chat. */
export class LogDecoder {
  private buffer = Buffer.alloc(0);
  private file = '';
  private start = 0;
  constructor(readonly world: WorldState, readonly store: Store) {}
  chunk(file: string, offset: number, bytes: Buffer, historical: boolean): void {
    if (file !== this.file || offset !== this.start + this.buffer.length) { this.file = file; this.start = offset; this.buffer = Buffer.alloc(0); }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end).toString('utf8').replace(/\r$/, '');
      const sourceId = `${file}:${this.start}`;
      try { this.world.line(line, sourceId, historical); }
      catch (error) { this.store.emit('parseError', error); }
      this.start += end + 1;
      this.buffer = this.buffer.subarray(end + 1);
      this.store.setMeta('logCursor', { file, offset: this.start });
    }
    if (this.buffer.length > 2_000_000) { this.buffer = Buffer.alloc(0); this.start = offset + bytes.length; }
  }
}
