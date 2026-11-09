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
      count: z.number().optional().describe("Number of recent messages to retrieve (default: 10, max: 100)"),
      username: z.string().optional().describe("Optional exact sender name filter"),
      format: z.enum(['text', 'json']).optional().describe("Response format (default: text)")
    },
    async ({ count = 10, username, format = 'text' }) => {
      const maxCount = Math.min(count, messageStore.getMaxMessages());
      const messages = maxCount <= 0 ? [] : messageStore.getRecentMessages(messageStore.getMaxMessages())
        .filter(message => username === undefined || message.username === username)
        .slice(-maxCount);

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
}
