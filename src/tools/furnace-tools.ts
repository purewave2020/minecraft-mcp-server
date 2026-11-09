import { actionWait, checkAction, currentActionSignal } from '../action-coordinator.js';
import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    'inspect-furnace',
    'Inspect furnace contents and optionally collect finished output without adding more ingredients',
    {
      x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number(),
      takeOutput: z.boolean().optional()
    },
    async ({ x, y, z, takeOutput = false }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block || !FURNACE_BLOCKS.has(block.name)) throw new Error('No furnace at this position');
      if (bot.entity.position.distanceTo(block.position) > 4.5) throw new Error('Furnace is out of reach');
      const furnace = await actionWait(Promise.resolve(bot.openFurnace(block)));
      const describe = (item: Item | null) => item ? { name: item.name, count: item.count } : null;
      try {
        const taken = takeOutput && furnace.outputItem() ? await actionWait(Promise.resolve(furnace.takeOutput())) : null;
        return factory.createResponse(JSON.stringify({
          input: describe(furnace.inputItem()), fuel: describe(furnace.fuelItem()),
          output: describe(furnace.outputItem()), taken: describe(taken),
          progress: furnace.progress, fuelRemaining: furnace.fuel
        }));
      } finally {
        await furnace.close();
      }
    }
  );

  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().positive().optional().describe("Amount of input to smelt (default: 1)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().positive().optional().describe("Amount of fuel to use (default: 1)"),
      takeOutput: z.boolean().optional().describe("Whether to take output when ready (default: true)"),
      timeoutMs: z.number().int().positive().max(60000).optional().describe("Timeout waiting for output in ms (default: 60000)")
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs = 60000
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
    }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      checkAction();

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createErrorResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }

      const items = bot.inventory.items();
      const input = items.find(item => item.name === inputItem.toLowerCase());
      if (!input) {
        return factory.createErrorResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = items.find(item => item.name === fuelItem.toLowerCase());
      if (!fuel) {
        return factory.createErrorResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
      }

      const resolvedInputCount = Math.min(inputCount, input.count);
      const resolvedFuelCount = Math.min(fuelCount, fuel.count);

      const furnace = await actionWait(Promise.resolve(bot.openFurnace(furnaceBlock)));
      const cleanup = () => {
        try {
          furnace.close();
        } catch {
          // ignore
        }
      };

      try {
        const existingInput = furnace.inputItem();
        if (existingInput && existingInput.name !== input.name) {
          return factory.createErrorResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        const existingFuel = furnace.fuelItem();
        if (existingFuel && existingFuel.name !== fuel.name) {
          return factory.createErrorResponse(`Furnace fuel slot is occupied by ${existingFuel.name}`);
        }

        await actionWait(Promise.resolve(furnace.putFuel(fuel.type, fuel.metadata ?? null, resolvedFuelCount)));
        await actionWait(Promise.resolve(furnace.putInput(input.type, input.metadata ?? null, resolvedInputCount)));

        if (!takeOutput) {
          return factory.createResponse(
            `Started smelting ${resolvedInputCount} ${input.name} with ${resolvedFuelCount} ${fuel.name}`
          );
        }

        const output = await actionWait(waitForOutput(furnace, timeoutMs));
        if (!output) {
          return factory.createErrorResponse(`No output after ${timeoutMs}ms`);
        }

        const taken = await actionWait(Promise.resolve(furnace.takeOutput()));
        return factory.createResponse(`Smelted ${taken.count} ${taken.name}`);
      } finally {
        cleanup();
      }
    }
  );
}

async function waitForOutput(furnace: mineflayer.Furnace, timeoutMs: number): Promise<Item | null> {
  const existing = furnace.outputItem();
  if (existing) {
    return existing;
  }

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const signal = currentActionSignal();
    const onAbort = () => { cleanup(); reject(signal?.reason ?? new Error('Smelting cancelled')); };

    const onUpdate = () => {
      const output = furnace.outputItem();
      if (output) {
        cleanup();
        resolve(output);
      }
    };

    const cleanup = () => {
      furnace.removeListener('update', onUpdate);
      signal?.removeEventListener('abort', onAbort);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    furnace.on('update', onUpdate);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}
