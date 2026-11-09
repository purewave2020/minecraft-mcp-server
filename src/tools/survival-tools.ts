import { setTimeout as delay } from 'node:timers/promises';
import type mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

const { goals } = pathfinderPkg;

const hostileNames = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider',
  'cave_spider', 'creeper', 'silverfish', 'endermite', 'slime', 'magma_cube',
  'blaze', 'wither_skeleton', 'witch', 'pillager', 'vindicator', 'phantom'
]);
const defenses = new WeakMap<mineflayer.Bot, {
  timer: ReturnType<typeof setInterval>;
  cleanup: () => void;
  escaping: boolean;
  surfacing: boolean;
  attacks: number;
  lastError?: string;
}>();

function isPlayer(entity: mineflayer.Bot['entity']): boolean {
  return entity.type === 'player' || entity.name === 'player' || Boolean(entity.username);
}

function sheepWool(bot: mineflayer.Bot, entity: mineflayer.Bot['entity']): { colorId: number; sheared: boolean } | undefined {
  if (entity.name !== 'sheep') return undefined;
  const key = minecraftData(bot.version).entitiesByName.sheep?.metadataKeys?.indexOf('wool') ?? -1;
  const flags = entity.metadata?.[key];
  if (typeof flags !== 'number') return undefined;
  return { colorId: flags & 0x0f, sheared: (flags & 0x10) !== 0 };
}

async function aimAtEntity(bot: mineflayer.Bot, entity: mineflayer.Bot['entity']): Promise<boolean> {
  await bot.lookAt(entity.position.offset(0, (entity.height || 1) / 2, 0), true);
  return bot.entityAtCursor(3.2)?.id === entity.id;
}

function hasLineOfSight(bot: mineflayer.Bot, target: mineflayer.Bot['entity']): boolean {
  const eyeHeight = (bot.entity as typeof bot.entity & { eyeHeight?: number }).eyeHeight ?? 1.62;
  const eye = bot.entity.position.offset(0, eyeHeight, 0);
  const center = target.position.offset(0, (target.height || 1) / 2, 0);
  const direction = center.minus(eye);
  const length = direction.norm();
  return bot.world.raycast(eye, direction.normalize(), length) === null;
}

export function registerSurvivalTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool('get-status', 'Inspect health, hunger, world time, inventory and nearby entities', {
    maxDistance: z.number().min(1).max(128).optional()
  }, async ({ maxDistance = 32 }) => {
    const bot = getBot();
    const entities = Object.values(bot.entities)
      .filter(entity => entity !== bot.entity)
      .map(entity => ({
        id: entity.id, name: entity.name, username: entity.username,
        type: entity.type, position: entity.position,
        wool: sheepWool(bot, entity),
        distance: bot.entity.position.distanceTo(entity.position)
      }))
      .filter(entity => entity.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 48);
    return factory.createResponse(JSON.stringify({
      health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
      position: bot.entity.position, dimension: bot.game.dimension,
      isSleeping: bot.isSleeping,
      timeOfDay: bot.time.timeOfDay, isDay: bot.time.isDay,
      defenseEnabled: defenses.has(bot), escaping: defenses.get(bot)?.escaping ?? false,
      surfacing: defenses.get(bot)?.surfacing ?? false,
      defenseAttacks: defenses.get(bot)?.attacks ?? 0, heldItem: bot.heldItem?.name,
      defenseError: defenses.get(bot)?.lastError,
      inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
      equipment: Object.fromEntries(Object.entries({ head: 5, torso: 6, legs: 7, feet: 8, offhand: 45 })
        .map(([name, slot]) => [name, bot.inventory.slots?.[slot]?.name ?? null])),
      craftingSlots: (bot.inventory.slots ?? []).slice(0, 5)
        .map((item, slot) => item ? { slot, name: item.name, count: item.count } : null).filter(Boolean),
      cursorItem: bot.inventory.selectedItem ? { name: bot.inventory.selectedItem.name, count: bot.inventory.selectedItem.count } : null,
      entities
    }));
  });

  factory.registerTool('sync-inventory', 'Resynchronize inventory and optionally recover items held by the cursor or crafting grid', {
    collectCrafting: z.boolean().optional()
  }, async ({ collectCrafting = false }) => {
    const bot = getBot();
    const syncBot = bot as typeof bot & { _syncWindow?: (window: typeof bot.inventory) => Promise<void> };
    if (!syncBot._syncWindow) throw new Error('This Mineflayer version does not support inventory synchronization');
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow);
    await syncBot._syncWindow(bot.inventory);
    if (collectCrafting) {
      if (bot.inventory.selectedItem) {
        let empty = -1;
        for (let slot = bot.inventory.inventoryStart; slot < bot.inventory.inventoryEnd; slot++) {
          if (!bot.inventory.slots[slot]) { empty = slot; break; }
        }
        if (empty < 0) throw new Error('Inventory is full; cannot recover cursor item');
        await bot.clickWindow(empty, 0, 0);
      }
      for (let slot = 0; slot <= 4; slot++) {
        if (bot.inventory.slots[slot]) await bot.putAway(slot);
      }
      await syncBot._syncWindow(bot.inventory);
    }
    return factory.createResponse(JSON.stringify({
      inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
      cursorItem: bot.inventory.selectedItem ? { name: bot.inventory.selectedItem.name, count: bot.inventory.selectedItem.count } : null
    }));
  });

  factory.registerTool('attack-entity', 'Attack a nearby non-player creature with normal melee attacks', {
    entityId: z.number().int().nonnegative(),
    hits: z.number().int().min(1).max(20).optional()
  }, async ({ entityId, hits = 1 }) => {
    const bot = getBot();
    let count = 0;
    for (let i = 0; i < hits; i++) {
      const target = bot.entities[entityId];
      if (!target || target.isValid === false) break;
      if (isPlayer(target)) throw new Error('Player combat is disabled');
      if (bot.entity.position.distanceTo(target.position) > 3.2) {
        if (count > 0) break;
        throw new Error('Target is out of melee reach; move closer first');
      }
      if (!(await aimAtEntity(bot, target))) {
        if (count > 0) break;
        throw new Error('Target is obstructed; move to a clear position first');
      }
      bot.attack(target);
      count++;
      await delay(700);
      if (bot.health <= 6) break;
    }
    return factory.createResponse(`Performed ${count} melee attack(s) against entity ${entityId}`);
  });

  factory.registerTool('interact-entity', 'Use the held item on a nearby non-player creature, such as shearing a sheep', {
    entityId: z.number().int().nonnegative()
  }, async ({ entityId }) => {
    const bot = getBot();
    const target = bot.entities[entityId];
    if (!target || target.isValid === false) throw new Error('Entity is no longer available');
    if (isPlayer(target)) throw new Error('Player interaction is disabled');
    if (bot.entity.position.distanceTo(target.position) > 3) throw new Error('Entity is out of reach; move closer first');
    if (!(await aimAtEntity(bot, target))) throw new Error('Entity is obstructed; move to a clear position first');
    // Vanilla sends interact_at before interact. ViaBackwards maps the first
    // packet to 26.1+ interaction and drops the second as a duplicate.
    await bot.activateEntityAt(target, target.position.offset(0, (target.height || 1) / 2, 0));
    await bot.activateEntity(target);
    await delay(200);
    return factory.createResponse(`Interacted with ${target.name ?? 'entity'} ${entityId}`);
  });

  factory.registerTool('eat-food', 'Eat a food item from inventory and restore the previously held item', {
    itemName: z.string().min(1)
  }, async ({ itemName }) => {
    const bot = getBot();
    const item = bot.inventory.items().find(item => item.name === itemName);
    if (!item) throw new Error(`No ${itemName} in inventory`);
    if (!minecraftData(bot.version).foodsByName[item.name]) throw new Error(`${itemName} is not food`);
    if (bot.food >= 20) return factory.createResponse('Hunger is already full');
    const previous = bot.heldItem;
    await bot.equip(item, 'hand');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bot.consume(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Eating timed out')), 10000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
      bot.deactivateItem();
      const restore = previous && bot.inventory.items().find(item => item.type === previous.type);
      if (restore) await bot.equip(restore, 'hand');
    }
    return factory.createResponse(`Ate ${itemName}. Health: ${bot.health}, hunger: ${bot.food}`);
  });

  factory.registerTool('interact-block', 'Activate a nearby block or sleep in a nearby bed', {
    x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number(),
    action: z.enum(['activate', 'sleep', 'wake']).optional()
  }, async ({ x, y, z, action = 'activate' }) => {
    ({ x, y, z } = coerceCoordinates(x, y, z));
    const bot = getBot();
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block || block.name === 'air') throw new Error('No block to interact with');
    if (bot.entity.position.distanceTo(block.position) > 4.5) throw new Error('Block is out of reach; move closer first');
    if (action === 'sleep' || action === 'wake') {
      if (!block.name.endsWith('_bed')) throw new Error('Sleeping requires a bed');
      if (action === 'wake') await bot.wake();
      else await bot.sleep(block);
    } else {
      const shape = block.shapes[0] ?? [0, 0, 0, 1, 1, 1];
      await bot.lookAt(block.position.offset(
        (shape[0] + shape[3]) / 2, (shape[1] + shape[4]) / 2, (shape[2] + shape[5]) / 2
      ), true);
      const hit = bot.blockAtCursor(4.5) as (typeof block & { face: number; intersect: Vec3 }) | null;
      const sameDoor = block.name.endsWith('_door') && hit?.name === block.name &&
        hit.position.x === block.position.x && hit.position.z === block.position.z;
      if (!hit || (!hit.position.equals(block.position) && !sameDoor)) throw new Error('Block is obstructed');
      const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1),
        new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
      await bot.activateBlock(hit, faces[hit.face], hit.intersect.minus(hit.position));
      await delay(100);
    }
    return factory.createResponse(`${action === 'sleep' ? 'Sleeping in' : action === 'wake' ? 'Woke from' : 'Activated'} ${block.name}`);
  });

  factory.registerTool('use-item', 'Use the held item, such as a bow or shield, for a bounded duration', {
    durationMs: z.number().int().min(50).max(5000).optional(),
    offhand: z.boolean().optional()
  }, async ({ durationMs = 1000, offhand = false }) => {
    const bot = getBot();
    try {
      bot.activateItem(offhand);
      await delay(durationMs);
    } finally {
      bot.deactivateItem();
    }
    return factory.createResponse(`Used ${offhand ? 'offhand' : 'main hand'} item for ${durationMs}ms`);
  });

  factory.registerTool('stop-actions', 'Stop navigation, digging and held controls immediately', {}, async () => {
    const bot = getBot();
    bot.pathfinder.setGoal(null);
    bot.stopDigging();
    bot.deactivateItem();
    bot.clearControlStates();
    return factory.createResponse('Stopped navigation, digging and item use');
  });

  factory.registerTool('set-defense', 'Enable or disable automatic melee defense and retreat from dangerous hostile creatures', {
    enabled: z.boolean()
  }, async ({ enabled }) => {
    const bot = getBot();
    const existing = defenses.get(bot);
    if (existing) existing.cleanup();
    defenses.delete(bot);
    if (enabled) {
      let busy = false;
      let lastAttack = 0;
      let lastEscapeChat = 0;
      let escapeGoal: InstanceType<typeof goals.GoalCompositeAll> | null = null;
      let escapeTimeout: ReturnType<typeof setTimeout> | undefined;
      const timer = setInterval(() => {
        if (busy || bot.health <= 0 || bot._client.state !== 'play') return;
        busy = true;
        void (async () => {
          const oxygen = bot.oxygenLevel;
          const lowAir = oxygen !== undefined && oxygen >= 0 && oxygen < 12;
          if (lowAir || state.surfacing) {
            if (lowAir || (oxygen !== undefined && oxygen >= 0 && oxygen < 18)) {
              if (!state.surfacing) {
                bot.stopDigging();
                bot.pathfinder.setGoal(null);
                clearTimeout(escapeTimeout);
                escapeGoal = null;
                state.escaping = false;
              }
              state.surfacing = true;
              bot.setControlState('jump', true);
              return;
            }
            bot.setControlState('jump', false);
            state.surfacing = false;
          }
          const threats = Object.values(bot.entities).filter(entity =>
            !isPlayer(entity) && hostileNames.has(entity.name ?? '') &&
            entity.position.distanceTo(bot.entity.position) <= 10 && hasLineOfSight(bot, entity)
          ).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
          const dangerous = threats.some(entity => entity.name === 'creeper' && entity.position.distanceTo(bot.entity.position) < 5)
            || threats.filter(entity => entity.position.distanceTo(bot.entity.position) < 6).length >= 3
            || (bot.health <= 10 && threats.length > 0);
          if (dangerous && !state.escaping) {
            state.escaping = true;
            bot.stopDigging();
            const goal = new goals.GoalCompositeAll(threats.map(entity => new goals.GoalInvert(
              new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 10)
            )));
            escapeGoal = goal;
            if (Date.now() - lastEscapeChat > 15000) {
              bot.chat('附近敌怪过于危险，先撤到安全位置。');
              lastEscapeChat = Date.now();
            }
            escapeTimeout = setTimeout(() => {
              if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
            }, 7000);
            void bot.pathfinder.goto(goal).catch(() => {}).finally(() => {
              clearTimeout(escapeTimeout);
              if (escapeGoal === goal) {
                escapeGoal = null;
                state.escaping = false;
              }
            });
          }
          const target = threats.find(entity => entity.position.distanceTo(bot.entity.position) <= 3);
          if (!target || Date.now() - lastAttack < 750) return;
          const weaponNames = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'];
          const items = bot.inventory.items();
          const weapon = weaponNames.map(name => items.find(item => item.name === name)).find(Boolean);
          if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand');
          if (defenses.get(bot)?.timer !== timer || bot._client.state !== 'play' || bot.entities[target.id] !== target) return;
          bot.attack(target);
          state.attacks++;
          lastAttack = Date.now();
        })().catch(error => {
          state.lastError = error instanceof Error ? error.message : String(error);
        }).finally(() => { busy = false; });
      }, 150);
      timer.unref();
      const cleanup = () => {
        clearInterval(timer);
        clearTimeout(escapeTimeout);
        if (escapeGoal && bot.pathfinder.goal === escapeGoal) bot.pathfinder.setGoal(null);
        if (state.surfacing) bot.setControlState('jump', false);
        bot.removeListener('end', cleanup);
        if (defenses.get(bot)?.timer === timer) defenses.delete(bot);
      };
      const state = { timer, cleanup, escaping: false, surfacing: false, attacks: 0, lastError: undefined as string | undefined };
      defenses.set(bot, state);
      bot.once('end', cleanup);
    }
    return factory.createResponse(`Automatic hostile-creature defense ${enabled ? 'enabled' : 'disabled'}`);
  });
}
