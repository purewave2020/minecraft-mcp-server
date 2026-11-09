import { format } from 'node:util';

export function setupStdioFiltering(): void {
  const write = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = function(chunk: string | Uint8Array, ...args: never[]): boolean {
    const message = chunk.toString();
    const protocol = message.trim().split(/\r?\n/).every(line => {
      try {
        const value = JSON.parse(line);
        return value?.jsonrpc === '2.0' && (typeof value.method === 'string' || 'id' in value);
      } catch { return false; }
    });
    if (protocol) return write(chunk, ...args);
    if (message.trim()) stderr(message.endsWith('\n') ? message : message + '\n');
    const callback = args.find(value => typeof value === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  } as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { stderr(format(...args) + '\n'); };
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;
}
