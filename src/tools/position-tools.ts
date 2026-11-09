import { actionWait, checkAction, actionDelay } from '../action-coordinator.js';
import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

type Direction = 'forward' | 'back' | 'left' | 'right';

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      range: z.coerce.number().finite().min(0).max(16).optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).max(60000).optional().describe("Timeout in milliseconds before cancelling (default: 30000; max: 60000)")
    },
    async ({ x, y, z, range = 1, timeoutMs = 30000 }: { x: number; y: number; z: number; range?: number; timeoutMs?: number }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const goal = new goals.GoalNear(x, y, z, range);
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let timeoutPromise: Promise<never> | null = null;
      let timedOut = false;

      if (timeoutMs !== undefined) {
        timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Move timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
      }

      const gotoPromise = actionWait(bot.pathfinder.goto(goal));

      try {
        if (timeoutPromise) {
          await actionWait(Promise.race([gotoPromise, timeoutPromise]));
        } else {
          await gotoPromise;
        }
        const actual = bot.entity?.position;
        if (actual) {
          const node = actual.floored();
          const distanceSquared = (node.x - Math.floor(x)) ** 2 +
            (node.y - Math.floor(y)) ** 2 + (node.z - Math.floor(z)) ** 2;
          if (distanceSquared > range ** 2) {
            bot.pathfinder.setGoal(null);
            throw new Error('Navigation ended without reaching the requested position');
          }
        }
        return factory.createResponse(`Successfully moved to position near (${x}, ${y}, ${z})`);
      } catch (error) {
        if (timedOut) {
          throw new Error(`Move timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (timedOut) {
          bot.pathfinder.stop();
          gotoPromise.catch(() => {});
        }
      }
    }
  );

  factory.registerTool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      await actionWait(Promise.resolve(bot.lookAt(new Vec3(x, y, z), true)));
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump",
    {},
    async () => {
      const bot = getBot();
      bot.setControlState('jump', true);
      try { await actionDelay(250); }
      finally { bot.setControlState('jump', false); }
      return factory.createResponse("Successfully jumped");
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot in a specific direction for a duration",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().int().min(50).max(10000).optional().describe("Duration in milliseconds (default: 1000)")
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }) => {
      const bot = getBot();
      checkAction();
      bot.setControlState(direction, true);
      try { await actionDelay(duration); }
      finally { bot.setControlState(direction, false); }
      return factory.createResponse(`Moved ${direction} for ${duration}ms`);
    }
  );
}
