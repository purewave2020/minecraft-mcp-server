import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';
import { ActionCoordinator, bindActionCoordinator } from './action-coordinator.js';

const independentTools = new Set(['get-status', 'get-position', 'get-block-info', 'find-blocks', 'find-entity',
  'list-inventory', 'find-item', 'get-recipe', 'can-craft', 'list-recipes', 'detect-gamemode', 'read-chat', 'ack-chat', 'send-chat', 'get-connection-status']);

type McpResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
};

export class ToolFactory {
  readonly actions = new ActionCoordinator();
  constructor(
    private server: McpServer,
    private connection: BotConnection
  ) {
    this.connection.onSpawn?.(bot => bindActionCoordinator(bot, this.actions));
  }

  onBotSpawn(callback: Parameters<BotConnection['onSpawn']>[0]): void { this.connection.onSpawn(callback); }
  getConnection(): BotConnection { return this.connection; }

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>
  ): void {
    this.server.tool(name, description, schema, async (args: unknown, extra?: { signal?: AbortSignal }): Promise<McpResponse> => {
      try {
        const parsedArgs = this.shouldValidateSchema(schema)
          ? this.parseArgs(schema as ZodRawShape, args) : args;
        if (name === 'get-connection-status' || name === 'read-chat' || name === 'ack-chat') return await executor(parsedArgs);
        const connectionCheck = await this.connection.checkConnectionAndReconnect();

        if (!connectionCheck.connected) {
          return {
            content: [{ type: "text", text: connectionCheck.message! }],
            isError: true
          };
        }

        if (name === 'stop-actions') this.actions.cancel();
        if (independentTools.has(name) || name === 'stop-actions') return await executor(parsedArgs);
        return await this.actions.run(name, () => this.connection.getBot()!, () => executor(parsedArgs), extra?.signal);
      } catch (error) {
        return this.createErrorResponse(error as Error);
      }
    });
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}
