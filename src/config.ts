import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  version?: string;
}

export function parseConfig(): ServerConfig {
  const args = yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('minecraft-version', {
      type: 'string',
      description: 'Minecraft client protocol version (auto-detected by default; set when using a protocol proxy)'
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  return {
    host: args.host,
    port: args.port,
    username: args.username,
    version: args['minecraft-version']
  };
}
