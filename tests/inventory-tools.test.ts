import test from 'ava';
import sinon from 'sinon';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

function sharingFixture() {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { getBot: sinon.stub().returns({}), checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  let items = [{ name: 'cobblestone', count: 32, type: 4, metadata: 0 }];
  const bot = {
    entity: { id: 1, username: 'LLMBot', position: new Vec3(0, 64, 0) },
    entities: { 2: { id: 2, username: 'GPTBot', position: new Vec3(2, 64, 0), isValid: true } },
    inventory: { items: () => items },
    world: { raycast: sinon.stub().returns(null) },
    lookAt: sinon.stub().resolves(),
    waitForTicks: sinon.stub().resolves(),
    toss: sinon.stub().callsFake(async (_type: number, _metadata: number, count: number) => {
      items = items.map(item => ({ ...item, count: item.count - count }));
    })
  };
  registerInventoryTools(new ToolFactory(mockServer, connection), () => bot as unknown as mineflayer.Bot);
  const registration = (mockServer.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'share-item')!;
  return { bot, execute: registration.args[3], schema: registration.args[2] };
}

test('sharing requires an exact available recipient within reach and sight', async (t) => {
  const { bot, execute } = sharingFixture();
  const args = { itemName: 'cobblestone', count: 8, recipient: 'GPT' };
  t.true((await execute(args)).isError);
  bot.entities[2].position = new Vec3(5, 64, 0);
  t.true((await execute({ ...args, recipient: 'GPTBot' })).isError);
  bot.entities[2].position = new Vec3(2, 64, 0);
  bot.world.raycast.returns({ name: 'stone' });
  t.true((await execute({ ...args, recipient: 'GPTBot' })).isError);
  t.false(bot.toss.called);
  t.false(bot.lookAt.called);
});

test('sharing refuses an inexact item name or an insufficient amount without dropping anything', async (t) => {
  const { bot, execute } = sharingFixture();
  t.true((await execute({ itemName: 'stone', count: 1, recipient: 'GPTBot' })).isError);
  t.true((await execute({ itemName: 'cobblestone', count: 33, recipient: 'GPTBot' })).isError);
  t.false(bot.toss.called);
});

test('sharing aims at the recipient and drops only the requested carried amount', async (t) => {
  const { bot, execute } = sharingFixture();
  const result = await execute({ itemName: 'cobblestone', count: 8, recipient: 'GPTBot' });
  t.falsy(result.isError);
  t.true(bot.lookAt.calledWith(new Vec3(2, 65, 0), true));
  t.true(bot.waitForTicks.calledOnceWithExactly(2));
  t.true(bot.lookAt.calledBefore(bot.waitForTicks));
  t.true(bot.waitForTicks.calledBefore(bot.toss));
  t.true(bot.toss.calledOnceWithExactly(4, 0, 8));
  t.is(bot.inventory.items()[0].count, 24);
  t.regex(result.content[0].text, /pickup is not confirmed/);
});

test('sharing reports an unconfirmed inventory change instead of claiming success', async (t) => {
  const { bot, execute } = sharingFixture();
  bot.toss.resetBehavior();
  bot.toss.resolves();
  const result = await execute({ itemName: 'cobblestone', count: 8, recipient: 'GPTBot' });
  t.true(result.isError);
  t.regex(result.content[0].text, /inspect inventory and nearby drops before retrying/);
  t.is(bot.inventory.items()[0].count, 32);
});

test('sharing schema requires a positive bounded whole amount', (t) => {
  const { schema } = sharingFixture();
  t.false(schema.count.safeParse(0).success);
  t.false(schema.count.safeParse(1.5).success);
  t.false(schema.count.safeParse(65).success);
  t.true(schema.count.safeParse(64).success);
});

test('registerInventoryTools registers list-inventory tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listInventoryCall = toolCalls.find(call => call.args[0] === 'list-inventory');

  t.truthy(listInventoryCall);
  t.is(listInventoryCall!.args[1], 'List all items in the bot\'s inventory');
});

test('registerInventoryTools registers equip-item tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const equipItemCall = toolCalls.find(call => call.args[0] === 'equip-item');

  t.truthy(equipItemCall);
  t.is(equipItemCall!.args[1], 'Equip a specific item');
});

test('list-inventory returns empty when no items', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listInventoryCall = toolCalls.find(call => call.args[0] === 'list-inventory');
  const executor = listInventoryCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('empty'));
});

test('list-inventory returns items with counts', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    inventory: {
      items: () => [
        { name: 'diamond_pickaxe', count: 1, slot: 0 },
        { name: 'cobblestone', count: 64, slot: 1 }
      ]
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listInventoryCall = toolCalls.find(call => call.args[0] === 'list-inventory');
  const executor = listInventoryCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('diamond_pickaxe'));
  t.true(result.content[0].text.includes('cobblestone'));
  t.true(result.content[0].text.includes('64'));
});

test('equip-item calls bot.equip', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const equipStub = sinon.stub().resolves();
  const mockBot = {
    inventory: {
      items: () => [
        { name: 'diamond_sword', type: 1 }
      ]
    },
    equip: equipStub
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const equipItemCall = toolCalls.find(call => call.args[0] === 'equip-item');
  const executor = equipItemCall!.args[3];

  const result = await executor({ itemName: 'diamond_sword', destination: 'hand' });

  t.true(equipStub.calledOnce);
  t.true(result.content[0].text.includes('Equipped'));
  t.true(result.content[0].text.includes('diamond_sword'));
});

test('equip-item returns message when item not found', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerInventoryTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const equipItemCall = toolCalls.find(call => call.args[0] === 'equip-item');
  const executor = equipItemCall!.args[3];

  const result = await executor({ itemName: 'diamond_sword', destination: 'hand' });

  t.true(result.content[0].text.includes('Couldn\'t find'));
});
