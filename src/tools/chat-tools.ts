import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';

export function registerChatTools(factory: ToolFactory, getBot: () => mineflayer.Bot, messageStore: MessageStore): void {
  factory.registerTool(
    "send-chat",
    "Send a chat message in-game",
    {
      message: z.string().describe("Message to send in chat")
    },
    async ({ message }) => {
      const bot = getBot();
      bot.chat(message);
      return factory.createResponse(`Sent message: "${message}"`);
    }
  );

  factory.registerTool(
    "read-chat",
    "Get recent chat messages from players",
    {
      count: z.number().int().min(0).max(1000).optional().describe("Number of messages to retrieve (default: 10, max: 1000)"),
      username: z.string().optional().describe("Optional exact sender name filter"),
      afterSequence: z.number().int().nonnegative().optional(),
      pendingOnly: z.boolean().optional().describe('Only unacknowledged qingyage messages; preserved across restarts'),
      format: z.enum(['text', 'json']).optional().describe("Response format (default: text)")
    },
    async ({ count = 10, username, format = 'text', afterSequence = 0, pendingOnly = false }) => {
      const messages = messageStore.read(count, username, afterSequence, pendingOnly);

      if (format === 'json') {
        return factory.createResponse(JSON.stringify({ messages }));
      }

      if (messages.length === 0) {
        return factory.createResponse("No chat messages found");
      }

      let output = `Found ${messages.length} chat message(s):\n\n`;
      messages.forEach((msg, index) => {
        const timestamp = new Date(msg.timestamp).toISOString();
        output += `${index + 1}. ${timestamp} - ${msg.username}: ${msg.content}\n`;
      });

      return factory.createResponse(output);
    }
  );
  factory.registerTool('ack-chat', 'Acknowledge handled priority messages by their stable IDs', {
    ids: z.array(z.string().uuid()).max(1000)
  }, async ({ ids }) => factory.createResponse(JSON.stringify({ acknowledged: messageStore.acknowledge(ids) })));
}
