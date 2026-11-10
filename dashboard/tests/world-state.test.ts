import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { WorldState, LogDecoder, offlineId } from '../server/world-state.js';
import { parseSnbt } from '../server/snbt.js';

test('SNBT preserves nested components, typed arrays, escaped Chinese and numeric suffixes', () => {
  const value = parseSnbt('{Pos:[-1.5d,72.0d,3d],UUID:[I;1,-2,3,4],Health:19.5f,Inventory:[{Slot:0b,count:2,id:"minecraft:stone",components:{"minecraft:custom_name":\'中文"名字\'}}]}') as Record<string, unknown>;
  assert.deepEqual(value.Pos, [-1.5, 72, 3]); assert.deepEqual(value.UUID, [1, -2, 3, 4]);
  assert.equal(value.Health, 19.5);
  assert.throws(() => parseSnbt('{x:[1,2}'));
});

test('offline UUID matches the real vanilla identity algorithm', () => {
  assert.equal(offlineId('qingyage'), '1eb66706-9bbb-376a-9810-6905a3dbd6bb');
});

test('full entity data and compact field polls retain inventory and health independently', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set(['LLMBot']));
  try {
    world.line('[10:00:00] [Server thread/INFO]: System chat: LLMBot has the following entity data: {Pos:[-506.5d,111d,-36.5d],Dimension:"minecraft:overworld",Health:20f,foodLevel:18,XpLevel:4,Inventory:[{Slot:0b,id:"minecraft:iron_pickaxe",count:1}]}', 'a:0', false);
    world.line('[10:00:01] [Server thread/INFO]: System chat: LLMBot has the following entity data: 12.5f', 'a:1', false);
    world.line('[10:00:01] [Server thread/INFO]: System chat: LLMBot has the following entity data: 17', 'a:2', false);
    world.line('[10:00:02] [Server thread/INFO]: System chat: LLMBot has the following entity data: [-505d,111d,-36d]', 'a:3', false);
    const player = world.get('LLMBot');
    assert.equal(player.health, 12.5); assert.equal(player.food, 17); assert.equal(player.xp, 4);
    assert.deepEqual(player.position, { x: -505, y: 111, z: -36 });
    assert.equal(player.inventory[0].name, 'iron_pickaxe'); assert.equal(player.equipment.mainhand?.name, 'iron_pickaxe');
  } finally { store.close(); }
});

test('dimension change clears stale coordinates until a position in the new dimension arrives', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  try {
    world.entity('Human', parseSnbt('{Pos:[1d,2d,3d],Dimension:"minecraft:overworld"}'), Date.now());
    world.entity('Human', 'minecraft:the_nether', Date.now());
    assert.equal(world.get('Human').position, null); assert.equal(world.get('Human').dimension, 'minecraft:the_nether');
  } finally { store.close(); }
});

test('log byte cursors deduplicate replays but preserve identical consecutive public messages and UTF-8 splits', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set(['LLMBot']));
  const decoder = new LogDecoder(world, store);
  try {
    const line = '[10:00:00] [Server thread/INFO]: [Not Secure] <LLMBot> 中文 😀 <qingyage> 原样显示\r\n';
    const bytes = Buffer.from(line + line);
    const split = Buffer.from(line).indexOf(Buffer.from('中')) + 1;
    decoder.chunk('file-a', 0, bytes.subarray(0, split), false);
    decoder.chunk('file-a', split, bytes.subarray(split), false);
    assert.equal(store.chats().length, 2);
    assert.equal(store.chats()[0].username, 'LLMBot');
    assert.equal(store.chats()[0].content, '中文 😀 <qingyage> 原样显示');
    decoder.chunk('file-a', 0, bytes, false);
    assert.equal(store.chats().length, 2);
    decoder.chunk('file-b', 0, Buffer.from(line), false);
    assert.equal(store.chats().length, 3);
    assert.deepEqual(store.meta('logCursor', null), { file: 'file-b', offset: Buffer.byteLength(line) });
  } finally { store.close(); }
});

test('historical status cannot overwrite current player state; public chat remains in history', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  try {
    world.entity('Human', parseSnbt('{Pos:[3d,80d,6d],Health:20f}'), Date.now());
    world.line('[10:00:00] [Server thread/INFO]: System chat: Human has the following entity data: {Pos:[0d,0d,0d],Health:1f}', 'old:0', true);
    world.line('[10:00:00] [Server thread/INFO]: <Human> 历史消息', 'old:1', true);
    assert.equal(world.get('Human').health, 20); assert.equal(world.get('Human').position?.y, 80);
    assert.equal(store.chats()[0].historical, true);
  } finally { store.close(); }
});

test('all-player membership removes disconnected players, including an empty server', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  try {
    world.get('Human'); world.get('Bot');
    world.line('[10:00:00] [Server thread/INFO]: System chat: There are 1 of a max of 20 players online: Human (00000000-0000-0000-0000-000000000000)', 'f:1', false);
    assert.equal(world.get('Human').online, true); assert.equal(world.get('Bot').online, false);
    world.line('[10:00:01] [Server thread/INFO]: System chat: There are 0 of a max of 20 players online:', 'f:2', false);
    assert.equal(world.get('Human').online, false);
  } finally { store.close(); }
});

test('SSE event history has stable increasing IDs and resumes after a cursor', () => {
  const store = new Store(':memory:');
  try {
    const first = store.event('test', { value: 1 }); const second = store.event('test', { value: 2 });
    assert.equal(store.events(first.id)[0].id, second.id);
    assert.deepEqual(store.events(second.id), []);
  } finally { store.close(); }
});
