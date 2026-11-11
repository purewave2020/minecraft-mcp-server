import type { Nbt } from './snbt.js';
import { parseSnbt } from './snbt.js';
import type { WorldEntity } from './types.js';
import type { Store } from './store.js';

/** Console data omits the entity registry ID; vanilla display names identify ordinary mobs. */
function mobType(name: string, data: Record<string, Nbt>): string {
  if (typeof data.id === 'string') return data.id.replace(/^minecraft:/, '');
  if (data.VillagerData) return data.IsZombie ? 'zombie_villager' : 'villager';
  if ('Sheared' in data || 'sheared' in data) return 'sheep';
  const normalized = name.toLowerCase().replace(/ /g, '_');
  return /^[a-z_]+$/.test(normalized) ? normalized : 'unknown';
}
export function readMob(name: string, nbt: Nbt, dimension: string, at: number): WorldEntity | null {
  if (!nbt || typeof nbt !== 'object' || Array.isArray(nbt)) return null;
  const data = nbt;
  if (typeof data.Health !== 'number' || data.Health <= 0 || 'playerGameType' in data) return null;
  const pos = data.Pos; const rot = data.Rotation; const uuid = data.UUID;
  if (!Array.isArray(pos) || pos.length !== 3 || pos.some(n => typeof n !== 'number' || !Number.isFinite(n))) return null;
  if (!Array.isArray(uuid) || uuid.length !== 4 || uuid.some(n => typeof n !== 'number' || !Number.isInteger(n))) return null;
  const hex = uuid.map(n => (Number(n) >>> 0).toString(16).padStart(8, '0')).join('');
  const rotation = Array.isArray(rot) && rot.length === 2 && rot.every(n => typeof n === 'number' && Number.isFinite(n)) ? rot : [0, 0];
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    type: mobType(name, data), name: name.slice(0, 128), dimension,
    position: { x: Number(pos[0]), y: Number(pos[1]), z: Number(pos[2]) },
    rotation: { yaw: Number(rotation[0]), pitch: Math.max(-90, Math.min(90, Number(rotation[1]))) },
    baby: (typeof data.Age === 'number' && data.Age < 0) || data.IsBaby === 1 || data.IsBaby === true,
    color: typeof data.Color === 'number' ? data.Color : null,
    sheared: data.Sheared === 1 || data.Sheared === true || data.sheared === true, observedAt: at
  };
}

export class EntityTracker {
  private readonly dimensions = new Map<string, WorldEntity[]>();
  private batch: { dimension: string; at: number; entities: Map<string, WorldEntity> } | null = null;
  constructor(readonly store: Store) {}
  snapshot(now = Date.now()): WorldEntity[] {
    return [...this.dimensions.values()].flat().filter(entity => now - entity.observedAt < 12_000);
  }
  line(body: string, at: number, historical: boolean): boolean {
    const boundary = /^Storage minecraft_dashboard:entities_(overworld|the_nether|the_end)_(begin|end) has the following contents: /.exec(body);
    if (boundary) {
      if (historical) return true;
      const dimension = 'minecraft:' + boundary[1];
      if (boundary[2] === 'begin') this.batch = { dimension, at, entities: new Map() };
      else if (this.batch?.dimension === dimension) {
        this.dimensions.set(dimension, [...this.batch.entities.values()]); this.batch = null;
        this.store.event('world.entities', { entities: this.snapshot(at), observedAt: at });
      }
      return true;
    }
    const data = /^(.+) has the following entity data: (\{.+\})$/.exec(body);
    if (!data) return false;
    const nbt = parseSnbt(data[2]);
    // Full player polls can interleave with this batch. Never consume them as mobs.
    if (nbt && typeof nbt === 'object' && !Array.isArray(nbt) && ('playerGameType' in nbt || 'foodLevel' in nbt || 'Dimension' in nbt)) return false;
    if (!historical && this.batch && at >= this.batch.at && this.batch.entities.size < 256) {
      const entity = readMob(data[1], nbt, this.batch.dimension, at);
      if (entity) this.batch.entities.set(entity.id, entity);
    }
    return true;
  }
}
