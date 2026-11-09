#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerSurvivalTools } from './tools/survival-tools.js';
import path from 'node:path';
import { acquireIdentityLock, identityKey, runtimeDirectory } from './runtime-state.js';
import { attachMovementGuard, movementStatus } from './movement-guard.js';

setupStdioFiltering();

async function main() {
  const config = parseConfig();
  const releaseIdentity = acquireIdentityLock(config);
  process.once('exit', releaseIdentity);
  const messageStore = new MessageStore(path.join(runtimeDirectory(), `${identityKey(config)}.chat.json`));

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, connection);
  connection.onSpawn(bot => attachMovementGuard(bot, factory.actions));
  const getBot = () => connection.getBot()!;

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerSurvivalTools(factory, getBot);
  factory.registerTool('get-connection-status', 'Inspect live connection health without reconnecting or moving the bot', {},
    async () => factory.createResponse(JSON.stringify({ ...connection.getStatus(), currentAction: factory.actions.currentAction,
      movement: movementStatus(connection.getBot()) })));

  connection.connect();
  let stopping = false;
  const shutdown = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    factory.actions.cancel('MCP server shutting down');
    connection.cleanup();
    releaseIdentity();
    log('info', 'MCP server shutting down');
    setTimeout(() => process.exit(exitCode), 200).unref();
  };
  process.once('SIGTERM', () => shutdown());
  process.once('SIGINT', () => shutdown());
  process.on('uncaughtException', error => { log('error', `Uncaught exception: ${error.stack ?? error}`); shutdown(1); });
  process.on('unhandledRejection', reason => { log('error', `Unhandled rejection: ${reason}`); shutdown(1); });

  process.stdin.on('end', () => {
    shutdown();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
