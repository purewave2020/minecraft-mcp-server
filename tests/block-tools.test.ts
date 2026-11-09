import test from 'ava';
import sinon from 'sinon';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

test('registerBlockTools registers place-block tool', (t) => {
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

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');

  t.truthy(placeBlockCall);
  t.is(placeBlockCall!.args[1], 'Place a block at the specified position');
});

test('registerBlockTools registers dig-block tool', (t) => {
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

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const digBlockCall = toolCalls.find(call => call.args[0] === 'dig-block');

  t.truthy(digBlockCall);
  t.is(digBlockCall!.args[1], 'Dig a block at the specified position');
});

test('registerBlockTools registers get-block-info tool', (t) => {
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

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');

  t.truthy(getBlockInfoCall);
  t.is(getBlockInfoCall!.args[1], 'Get information about a block at the specified position');
});

test('registerBlockTools registers find-blocks tool', (t) => {
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

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');

  t.truthy(findBlockCall);
  t.is(findBlockCall!.args[1], 'Find one or more nearby blocks of a specific type');
});

test('get-block-info returns block information', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBlock = {
    name: 'stone',
    type: 1,
    position: new Vec3(10, 64, 20)
  };
  const mockBot = {
    blockAt: sinon.stub().returns(mockBlock)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');
  const executor = getBlockInfoCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('stone'));
  t.true(result.content[0].text.includes('10'));
  t.true(result.content[0].text.includes('64'));
  t.true(result.content[0].text.includes('20'));
});

test('get-block-info handles missing block', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    blockAt: sinon.stub().returns(null)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getBlockInfoCall = toolCalls.find(call => call.args[0] === 'get-block-info');
  const executor = getBlockInfoCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('No block information found'));
});

test('dig-block handles air blocks', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBlock = {
    name: 'air'
  };
  const mockBot = {
    blockAt: sinon.stub().returns(mockBlock)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const digBlockCall = toolCalls.find(call => call.args[0] === 'dig-block');
  const executor = digBlockCall!.args[3];

  const result = await executor({ x: 10, y: 64, z: 20 });

  t.true(result.content[0].text.includes('No block found'));
});

test('place-block blocks placing at bot position and one block above', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: { position: new Vec3(10.4, 64, 20.7) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');
  const executor = placeBlockCall!.args[3];

  const resultAtFeet = await executor({ x: 10, y: 64, z: 20 });
  const resultAtHead = await executor({ x: 10, y: 65, z: 20 });

  t.true(resultAtFeet.content[0].text.includes("can't place a block"));
  t.true(resultAtHead.content[0].text.includes("can't place a block"));
});

test('place-block floors input coordinates before self-placement guard', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: { position: new Vec3(10.4, 64, 20.7) },
    blockAt: sinon.stub().returns({ name: 'air' })
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const placeBlockCall = toolCalls.find(call => call.args[0] === 'place-block');
  const executor = placeBlockCall!.args[3];

  const result = await executor({ x: 10.4, y: 64, z: 20.7 });

  t.true(result.content[0].text.includes("can't place a block"));
});

test('find-blocks returns not found when block not found', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    version: '1.21',
    findBlock: sinon.stub().returns(null)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'diamond_ore', maxDistance: 16 });

  t.true(result.content[0].text.includes('No diamond_ore found'));
});

test('find-blocks returns multiple results when count is greater than one', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: sinon.stub().returns([new Vec3(1, 64, 0), new Vec3(2, 64, 0)])
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  const result = await executor({ blockType: 'stone', maxDistance: 16, count: 2 });

  t.true(result.content[0].text.includes('Found 2 stone block(s)'));
  t.true(result.content[0].text.includes('(1, 64, 0)'));
  t.true(result.content[0].text.includes('(2, 64, 0)'));
});

test('find-blocks clamps oversized count before calling bot.findBlocks', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const findBlocksStub = sinon.stub().returns([new Vec3(1, 64, 0)]);
  const mockBot = {
    version: '1.21',
    entity: { position: new Vec3(0, 64, 0) },
    findBlocks: findBlocksStub
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerBlockTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const findBlockCall = toolCalls.find(call => call.args[0] === 'find-blocks');
  const executor = findBlockCall!.args[3];

  await executor({ blockType: 'stone', maxDistance: 16, count: 10_000 });

  const findBlocksArgs = findBlocksStub.firstCall.args[0];
  t.is(findBlocksArgs.count, 256);
});

test('dig-block equips the best available harvest tool before mining', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const pickaxe = { name: 'stone_pickaxe' };
  const block = { name: 'stone', position: new Vec3(1, 64, 0) };
  const bot = {
    blockAt: sinon.stub().returns(block), canDigBlock: sinon.stub().returns(true),
    canSeeBlock: sinon.stub().returns(true), pathfinder: { bestHarvestTool: sinon.stub().returns(pickaxe) },
    equip: sinon.stub().resolves(), dig: sinon.stub().resolves()
  };
  registerBlockTools(factory, () => bot as unknown as mineflayer.Bot);
  const executor = (mockServer.tool as sinon.SinonStub).getCalls()
    .find(call => call.args[0] === 'dig-block')!.args[3];

  await executor({ x: 1, y: 64, z: 0 });

  t.true(bot.equip.calledOnceWith(pickaxe, 'hand'));
  t.true(bot.equip.calledBefore(bot.dig));
});

test('place-block replaces water using an adjacent solid reference', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const water = { name: 'water', position: new Vec3(1, 64, 0) };
  const stone = { name: 'stone', position: new Vec3(1, 63, 0) };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().callsFake((p: Vec3) => p.y === 63 ? stone : water),
    canSeeBlock: sinon.stub().returns(true), lookAt: sinon.stub().resolves(),
    placeBlock: sinon.stub().resolves()
  };
  registerBlockTools(factory, () => bot as unknown as mineflayer.Bot);
  const executor = (mockServer.tool as sinon.SinonStub).getCalls()
    .find(call => call.args[0] === 'place-block')!.args[3];

  await executor({ x: 1, y: 64, z: 0 });

  t.true(bot.placeBlock.calledOnce);
  t.is(bot.placeBlock.firstCall.args[0], stone);
  t.true(bot.placeBlock.firstCall.args[1].equals(new Vec3(0, 1, 0)));
});

test.serial('dig-block cancels navigation when an obstructed block cannot be reached in time', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, connection);
  const bot = {
    blockAt: sinon.stub().returns({ name: 'stone' }), canDigBlock: sinon.stub().returns(false),
    pathfinder: { goto: sinon.stub().returns(new Promise(() => {})), setGoal: sinon.stub() }
  };
  registerBlockTools(factory, () => bot as unknown as mineflayer.Bot);
  const executor = (mockServer.tool as sinon.SinonStub).getCalls()
    .find(call => call.args[0] === 'dig-block')!.args[3];

  const pending = executor({ x: 1, y: 64, z: 0 });
  await clock.tickAsync(15001);
  const result = await pending;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Navigation to block timed out'));
  t.true(bot.pathfinder.setGoal.calledOnceWith(null));
});

test('dig-block refuses an obstructed target after a falsely resolved path', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = {
    getBot: sinon.stub().returns({}),
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const bot = {
    blockAt: sinon.stub().returns({ name: 'stone' }),
    canDigBlock: sinon.stub().returns(false), canSeeBlock: sinon.stub().returns(false),
    pathfinder: { goto: sinon.stub().resolves() }, dig: sinon.stub().resolves()
  };
  registerBlockTools(factory, () => bot as unknown as mineflayer.Bot);
  const executor = (server.tool as sinon.SinonStub).getCalls()
    .find(call => call.args[0] === 'dig-block')!.args[3];

  const result = await executor({ x: 10, y: 64, z: 0 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('out of reach or obstructed'));
  t.false(bot.dig.called);
});
