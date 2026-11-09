import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { registerSurvivalTools } from '../src/tools/survival-tools.js';
import type { ToolFactory } from '../src/tool-factory.js';

type Executor = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function setup() {
  const tools = new Map<string, Executor>();
  const factory = {
    registerTool: (name: string, _description: string, _schema: unknown, execute: Executor) => tools.set(name, execute),
    createResponse: (text: string) => ({ content: [{ text }] })
  } as unknown as ToolFactory;
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.8', health: 20, food: 10, oxygenLevel: undefined as number | undefined,
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: {} as Record<number, unknown>,
    inventory: { items: sinon.stub().returns([]) },
    game: { dimension: 'overworld' }, time: { timeOfDay: 6000, isDay: true },
    _client: { state: 'play' }, heldItem: undefined as unknown,
    attack: sinon.stub(), lookAt: sinon.stub().resolves(), entityAtCursor: sinon.stub(),
    nearestEntity: sinon.stub().returns(null),
    equip: sinon.stub().resolves(), consume: sinon.stub().resolves(),
    activateItem: sinon.stub(), deactivateItem: sinon.stub(),
    world: { raycast: sinon.stub().returns(null) },
    pathfinder: { goal: null as unknown, goto: sinon.stub().resolves(), setGoal: sinon.stub() },
    stopDigging: sinon.stub(), clearControlStates: sinon.stub(), setControlState: sinon.stub(), chat: sinon.stub(),
    blockAt: sinon.stub(), activateBlock: sinon.stub().resolves(), activateEntity: sinon.stub().resolves(),
    activateEntityAt: sinon.stub().resolves(), sleep: sinon.stub().resolves(), wake: sinon.stub().resolves()
  });
  registerSurvivalTools(factory, () => bot as unknown as mineflayer.Bot);
  return { bot, run: (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args) };
}

test('status reports the actual vitals and inventory', async (t) => {
  const { bot, run } = setup();
  bot.inventory.items.returns([{ name: 'bread', count: 3 }]);
  const result = await run('get-status');
  const status = JSON.parse(result.content[0].text);
  t.is(status.health, 20);
  t.is(status.food, 10);
  t.deepEqual(status.inventory, [{ name: 'bread', count: 3 }]);
});

test('status distinguishes a sheep with wool from a sheared sheep using version metadata', async (t) => {
  const { bot, run } = setup();
  bot.entities[2] = { id: 2, name: 'sheep', position: new Vec3(1, 64, 0), metadata: { 17: 0 } };
  bot.entities[3] = { id: 3, name: 'sheep', position: new Vec3(2, 64, 0), metadata: { 17: 31 } };
  const status = JSON.parse((await run('get-status')).content[0].text);
  t.deepEqual(status.entities[0].wool, { colorId: 0, sheared: false });
  t.deepEqual(status.entities[1].wool, { colorId: 15, sheared: true });
});

test('melee refuses to attack a player', async (t) => {
  const { bot, run } = setup();
  bot.entities[2] = { id: 2, type: 'player', username: 'qingyage', position: new Vec3(1, 64, 0) };
  await t.throwsAsync(run('attack-entity', { entityId: 2 }), { message: 'Player combat is disabled' });
  t.false(bot.attack.called);
});

test('melee requires reach and a clear line of sight', async (t) => {
  const { bot, run } = setup();
  const target = { id: 2, name: 'zombie', position: new Vec3(10, 64, 0) };
  bot.entities[2] = target;
  await t.throwsAsync(run('attack-entity', { entityId: 2 }), { message: /out of melee reach/ });
  target.position = new Vec3(2, 64, 0);
  bot.entityAtCursor.returns(null);
  await t.throwsAsync(run('attack-entity', { entityId: 2 }), { message: /obstructed/ });
  t.false(bot.attack.called);
});

test('creature interaction refuses players and unavailable entities', async (t) => {
  const { bot, run } = setup();
  bot.entities[2] = { id: 2, username: 'OtherBot', type: 'player', position: new Vec3(1, 64, 0) };
  await t.throwsAsync(run('interact-entity', { entityId: 2 }), { message: 'Player interaction is disabled' });
  await t.throwsAsync(run('interact-entity', { entityId: 3 }), { message: 'Entity is no longer available' });
  t.false(bot.activateEntity.called);
  t.false(bot.activateEntityAt.called);
});

test('creature interaction requires reach and a clear aim', async (t) => {
  const { bot, run } = setup();
  const sheep = { id: 2, name: 'sheep', position: new Vec3(4, 64, 0), height: 1.3 };
  bot.entities[2] = sheep;
  await t.throwsAsync(run('interact-entity', { entityId: 2 }), { message: /out of reach/ });
  sheep.position = new Vec3(2, 64, 0);
  await t.throwsAsync(run('interact-entity', { entityId: 2 }), { message: /obstructed/ });
  t.false(bot.activateEntity.called);
  t.false(bot.activateEntityAt.called);
});

test('creature interaction uses the equipped item on the aimed sheep', async (t) => {
  const { bot, run } = setup();
  const sheep = { id: 2, name: 'sheep', position: new Vec3(2, 64, 0), height: 1.3 };
  bot.entities[2] = sheep;
  bot.entityAtCursor.returns(sheep);
  const result = await run('interact-entity', { entityId: 2 });
  t.true(bot.activateEntityAt.calledOnceWith(sheep, new Vec3(2, 64.65, 0)));
  t.true(bot.activateEntityAt.calledBefore(bot.activateEntity));
  t.true(bot.activateEntity.calledOnceWith(sheep));
  t.regex(result.content[0].text, /sheep 2/);
});

test('status reports worn armor and the offhand item separately from carried inventory', async (t) => {
  const { bot, run } = setup();
  const slots = Array(46).fill(null);
  slots[6] = { name: 'iron_chestplate' };
  slots[45] = { name: 'shield' };
  Object.assign(bot.inventory, { slots });
  const status = JSON.parse((await run('get-status')).content[0].text);
  t.deepEqual(status.equipment, { head: null, torso: 'iron_chestplate', legs: null, feet: null, offhand: 'shield' });
});

test('eating refuses non-food inventory items', async (t) => {
  const { bot, run } = setup();
  bot.inventory.items.returns([{ name: 'dirt', type: 1, count: 2 }]);
  await t.throwsAsync(run('eat-food', { itemName: 'dirt' }), { message: 'dirt is not food' });
  t.false(bot.equip.called);
  t.false(bot.consume.called);
});

test('failed eating releases item use and restores the held tool', async (t) => {
  const { bot, run } = setup();
  const tool = { name: 'stone_sword', type: 1, count: 1 };
  const food = { name: 'bread', type: 2, count: 3 };
  bot.heldItem = tool;
  bot.inventory.items.returns([tool, food]);
  bot.consume.rejects(new Error('consume failed'));
  await t.throwsAsync(run('eat-food', { itemName: 'bread' }), { message: 'consume failed' });
  t.true(bot.deactivateItem.calledOnce);
  t.true(bot.equip.lastCall.calledWith(tool, 'hand'));
});

test('sleeping refuses a non-bed block', async (t) => {
  const { bot, run } = setup();
  bot.blockAt.returns({ name: 'dirt', position: new Vec3(1, 64, 0) });
  await t.throwsAsync(run('interact-block', { x: 1, y: 64, z: 0, action: 'sleep' }), { message: 'Sleeping requires a bed' });
  t.false(bot.sleep.called);
});

test('bed interaction can wake the bot and status reports whether it is sleeping', async (t) => {
  const { bot, run } = setup();
  Object.assign(bot, { isSleeping: true });
  bot.blockAt.returns({ name: 'black_bed', position: new Vec3(1, 64, 0) });
  const status = JSON.parse((await run('get-status')).content[0].text);
  t.true(status.isSleeping);
  const result = await run('interact-block', { x: 1, y: 64, z: 0, action: 'wake' });
  t.true(bot.wake.calledOnce);
  t.false(bot.sleep.called);
  t.regex(result.content[0].text, /Woke from black_bed/);
});

test('item use is released when activation fails', async (t) => {
  const { bot, run } = setup();
  bot.activateItem.throws(new Error('disconnected'));
  await t.throwsAsync(run('use-item'), { message: 'disconnected' });
  t.true(bot.deactivateItem.calledOnce);
});

test('reconfiguring and disconnecting defense clears its timers and listeners', async (t) => {
  const { bot, run } = setup();
  await run('set-defense', { enabled: true });
  await run('set-defense', { enabled: true });
  t.is(bot.listenerCount('end'), 1);
  await run('set-defense', { enabled: false });
  t.is(bot.listenerCount('end'), 0);
  await run('set-defense', { enabled: true });
  bot.emit('end');
  const status = JSON.parse((await run('get-status')).content[0].text);
  t.false(status.defenseEnabled);
});

test.serial('automatic defense uses a sword without changing navigation look direction', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  t.teardown(() => clock.restore());
  const { bot, run } = setup();
  const sword = { name: 'stone_sword', type: 10, count: 1 };
  bot.inventory.items.returns([sword]);
  bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(2, 64, 0), height: 1.8 };
  await run('set-defense', { enabled: true });
  await clock.tickAsync(800);

  t.true(bot.attack.calledOnce);
  t.true(bot.equip.calledOnceWith(sword, 'hand'));
  t.false(bot.lookAt.called);
  await run('set-defense', { enabled: false });
});

test.serial('automatic defense retreats from a creeper and disabling it cancels that retreat', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  t.teardown(() => clock.restore());
  const { bot, run } = setup();
  bot.entities[2] = { id: 2, name: 'creeper', position: new Vec3(4, 64, 0), height: 1.8 };
  bot.pathfinder.goto.callsFake((goal: unknown) => {
    bot.pathfinder.goal = goal;
    return new Promise(() => {});
  });
  await run('set-defense', { enabled: true });
  await clock.tickAsync(200);

  t.true(bot.pathfinder.goto.calledOnce);
  t.true(bot.stopDigging.calledOnce);
  const state = JSON.parse((await run('get-status')).content[0].text);
  t.true(state.escaping);
  t.false(bot.attack.called);
  await run('set-defense', { enabled: false });
  t.true(bot.pathfinder.setGoal.calledOnceWith(null));
});

test.serial('low air cancels navigation and prioritizes surfacing until breathing recovers', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  t.teardown(() => clock.restore());
  const { bot, run } = setup();
  bot.oxygenLevel = 10;
  bot.entities[2] = { id: 2, name: 'creeper', position: new Vec3(2, 64, 0), height: 1.8 };
  await run('set-defense', { enabled: true });
  await clock.tickAsync(200);

  t.true(bot.pathfinder.setGoal.calledOnceWith(null));
  t.true(bot.setControlState.calledWith('jump', true));
  t.false(bot.pathfinder.goto.called);
  t.false(bot.attack.called);
  t.true(JSON.parse((await run('get-status')).content[0].text).surfacing);

  bot.entities = {};
  bot.oxygenLevel = 20;
  await clock.tickAsync(200);
  t.true(bot.setControlState.lastCall.calledWith('jump', false));
  t.false(JSON.parse((await run('get-status')).content[0].text).surfacing);
  await run('set-defense', { enabled: false });
});

test.serial('surfacing releases jump on disable and ignores full air and the air sentinel', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  t.teardown(() => clock.restore());
  const { bot, run } = setup();
  bot.oxygenLevel = -1;
  await run('set-defense', { enabled: true });
  await clock.tickAsync(200);
  t.false(bot.setControlState.called);
  bot.oxygenLevel = 20;
  await clock.tickAsync(200);
  t.false(bot.setControlState.called);
  bot.oxygenLevel = 6;
  await clock.tickAsync(200);
  await run('set-defense', { enabled: false });
  t.true(bot.setControlState.lastCall.calledWith('jump', false));
});

test('inventory synchronization recovers an item left on the cursor', async (t) => {
  const { bot, run } = setup();
  const torch = { name: 'torch', count: 4 };
  const inventory = Object.assign(bot.inventory, {
    slots: Array(46).fill(null) as (typeof torch | null)[],
    selectedItem: torch as typeof torch | null,
    inventoryStart: 9, inventoryEnd: 45
  });
  const sync = sinon.stub().resolves();
  const click = sinon.stub().callsFake(async (slot: number) => {
    inventory.slots[slot] = inventory.selectedItem;
    inventory.selectedItem = null;
    inventory.items.returns([torch]);
  });
  Object.assign(bot, { _syncWindow: sync, clickWindow: click });

  const result = JSON.parse((await run('sync-inventory', { collectCrafting: true })).content[0].text);

  t.deepEqual(result.inventory, [torch]);
  t.is(result.cursorItem, null);
  t.true(click.calledOnceWith(9, 0, 0));
  t.is(sync.callCount, 2);
});

test('block interaction clicks the visible door face instead of its covered top face', async (t) => {
  const { bot, run } = setup();
  const door = { name: 'birch_door', position: new Vec3(1, 64, 0), shapes: [[0, 0, 0, 1, 1, 0.1875]] };
  const hit = { ...door, face: 4, intersect: new Vec3(1, 64.5, 0.1) };
  bot.blockAt.returns(door);
  Object.assign(bot, { blockAtCursor: sinon.stub().returns(hit) });

  await run('interact-block', { x: 1, y: 64, z: 0 });

  t.true(bot.activateBlock.calledOnce);
  t.true(bot.activateBlock.firstCall.args[1].equals(new Vec3(-1, 0, 0)));
  t.true(bot.activateBlock.firstCall.args[2].equals(new Vec3(0, 0.5, 0.1)));
});
