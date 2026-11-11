import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { WorldState } from '../server/world-state.js';
import { readMob } from '../server/entities.js';
import { parseSnbt } from '../server/snbt.js';

const now = Date.parse('2026-11-11T05:00:00Z');
const mob = (id = 1, extra = '') => `{UUID:[I;${id},-2,3,-4],Pos:[1d,73d,3d],Rotation:[90f,20f],Health:20f${extra}}`;

test('mob identity uses the full UUID; sheep state, babies and non-finite coordinates are handled', () => {
  const entity = readMob('Named sheep', parseSnbt(mob(1, ',Sheared:1b,Color:15b,Age:-100')), 'minecraft:overworld', now)!;
  assert.equal(entity.id, '00000001-ffff-fffe-0000-0003fffffffc');
  assert.equal(entity.type, 'sheep'); assert.equal(entity.baby, true); assert.equal(entity.sheared, true); assert.equal(entity.color, 15);
  assert.deepEqual(entity.rotation, { yaw: 90, pitch: 20 });
  assert.equal(readMob('Item', parseSnbt('{UUID:[I;1,2,3,4],Pos:[1d,2d,3d]}'), 'minecraft:overworld', now), null);
  assert.equal(readMob('Dead', parseSnbt(mob().replace('Health:20f', 'Health:0f')), 'minecraft:overworld', now), null);
  assert.equal(readMob('Bad', { UUID: [1, 2, 3, 4], Pos: [Infinity, 1, 2], Health: 20 }, 'minecraft:overworld', now), null);
});

test('complete mob batches deduplicate UUIDs, preserve dimensions and replace vanished creatures', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  const line = (body: string, seconds = '00', historical = false) => world.line(`[13:00:${seconds}] [Server thread/INFO]: System chat: ${body}`, body, historical, now);
  const boundary = (dimension: string, phase: string, seconds = '00') => line(`Storage minecraft_dashboard:entities_${dimension}_${phase} has the following contents: {}`, seconds);
  try {
    boundary('overworld', 'begin');
    line('Villager has the following entity data: ' + mob(1));
    line('Villager has the following entity data: ' + mob(2));
    line('Villager has the following entity data: ' + mob(1));
    line('Iron Golem has the following entity data: ' + mob(3));
    // A normal player poll can appear between the mob query and its ending boundary.
    line('Human has the following entity data: {Pos:[4d,73d,5d],foodLevel:20,Health:20f,UUID:[I;9,9,9,9]}');
    assert.equal(world.entities.snapshot(now).length, 0, 'incomplete batches must not be published');
    boundary('overworld', 'end');
    assert.equal(world.entities.snapshot(now).length, 3); assert.equal(world.players.size, 1);
    assert.equal(world.entities.snapshot(now)[2].type, 'iron_golem');
    boundary('the_nether', 'begin'); line('Piglin has the following entity data: ' + mob(4)); boundary('the_nether', 'end');
    assert.equal(world.entities.snapshot(now).length, 4);
    assert.equal(world.entities.snapshot(now)[3].dimension, 'minecraft:the_nether');
    boundary('overworld', 'begin', '03'); boundary('overworld', 'end', '03');
    assert.equal(world.entities.snapshot(now + 3000).length, 1, 'an empty batch removes despawned or departed mobs');
    assert.equal(world.entities.snapshot(now + 12_001).length, 0, 'a disconnected collector cannot leave live-looking mobs');
    const event = store.events(0).filter(event => event.type === 'world.entities').at(-1)!;
    assert.equal((event.data as { entities: unknown[] }).entities.length, 1);
  } finally { store.close(); }
});

test('historical or unsolicited mob data cannot create players or revive stale entity snapshots', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  const line = (body: string, historical: boolean) => world.line(`[13:00:00] [Server thread/INFO]: ${body}`, 'fixture', historical, now);
  try {
    line('Villager has the following entity data: ' + mob(), false);
    for (const body of ['Storage minecraft_dashboard:entities_overworld_begin has the following contents: {}',
      'Villager has the following entity data: ' + mob(), 'Storage minecraft_dashboard:entities_overworld_end has the following contents: {}']) line(body, true);
    assert.equal(world.players.size, 0); assert.deepEqual(world.entities.snapshot(now), []); assert.equal(store.lastEventId(), 0);
  } finally { store.close(); }
});
