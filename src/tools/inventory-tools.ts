import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export function registerInventoryTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    'share-item',
    'Drop an exact number of carried items toward a nearby player for them to collect',
    {
      itemName: z.string().trim().min(1),
      count: z.number().int().min(1).max(64),
      recipient: z.string().trim().min(1)
    },
    async ({ itemName, count, recipient }) => {
      const bot = getBot();
      const target = Object.values(bot.entities).find(entity => entity.username === recipient && entity.isValid !== false);
      if (!target || target === bot.entity) throw new Error('Recipient is not an available nearby player');
      if (bot.entity.position.distanceTo(target.position) > 4) throw new Error('Recipient is out of sharing reach');
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const direction = target.position.offset(0, 1, 0).minus(eye);
      if (bot.world.raycast(eye, direction.normalize(), direction.norm())) throw new Error('Recipient is obstructed');
      const matching = bot.inventory.items().filter(item => item.name === itemName);
      const item = matching[0];
      const beforeCount = matching.reduce((sum, item) => sum + item.count, 0);
      if (!item || beforeCount < count) throw new Error(`Not enough ${itemName}: have ${beforeCount}, need ${count}`);
      const matchingMetadataCount = matching.filter(candidate => candidate.type === item.type && candidate.metadata === item.metadata)
        .reduce((sum, candidate) => sum + candidate.count, 0);
      if (matchingMetadataCount < count) throw new Error('Requested items have different metadata; share a smaller amount');
      await bot.lookAt(target.position.offset(0, 1, 0), true);
      // The server needs the new yaw before handling the inventory drop packet.
      await bot.waitForTicks(2);
      await bot.toss(item.type, item.metadata ?? null, count);
      const syncBot = bot as typeof bot & { _syncWindow?: (window: typeof bot.inventory) => Promise<void> };
      if (syncBot._syncWindow) await syncBot._syncWindow(bot.inventory);
      const afterCount = bot.inventory.items().filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
      if (afterCount > beforeCount - count) throw new Error('Item drop was not confirmed; inspect inventory and nearby drops before retrying');
      return factory.createResponse(`Dropped ${count} ${itemName} toward ${recipient}; recipient pickup is not confirmed`);
    }
  );

  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();
      const itemList: InventoryItem[] = items.map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot
      }));

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
      });

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(nameOrType.toLowerCase())
      );

      if (item) {
        return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
      } else {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(itemName.toLowerCase())
      );

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(`Equipped ${item.name} to ${destination}`);
    }
  );
}
