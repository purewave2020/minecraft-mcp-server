import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function runtimeDirectory(): string {
  const directory = path.resolve(process.env.MINECRAFT_MCP_RUNTIME_DIR ?? '.npm/runtime');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function identityKey(config: { host: string; port: number; username: string }): string {
  const host = ['localhost', '::1'].includes(config.host.toLowerCase()) ? '127.0.0.1' : config.host.toLowerCase();
  return createHash('sha256').update(`${host}:${config.port}/${config.username.toLowerCase()}`).digest('hex').slice(0, 24);
}

export function writePrivateJson(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function acquireIdentityLock(config: { host: string; port: number; username: string }): () => void {
  const filename = path.join(runtimeDirectory(), `${identityKey(config)}.lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ...config, startedAt: new Date().toISOString() })); }
      finally { fs.closeSync(fd); }
      const release = () => {
        try {
          if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename);
        } catch { /* Already released. */ }
      };
      // Pre-lock deployments did not create lock files. Do not kick a live legacy bot.
      try {
        const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
        const escaped = config.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const name = new RegExp(`--username(?:=|\\s+)${escaped}(?:\\s|$)`, 'i');
        const port = new RegExp(`--port(?:=|\\s+)${config.port}(?:\\s|$)`);
        const duplicate = processes.split('\n').find(line => Number(line.trim().split(/\s+/, 1)[0]) !== process.pid &&
          /(?:dist\/main\.js|src\/main\.ts)/.test(line) && name.test(line) && port.test(line));
        if (duplicate) { release(); throw new Error(`Another process already owns ${config.username}; stop or hand off that session before starting another`); }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Another process')) throw error;
        if (process.platform !== 'win32') { release(); throw error; }
      }
      return release;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      let owner: { pid?: number };
      try { owner = JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch { throw new Error('Identity lock is being initialized or is malformed; inspect it before retrying'); }
      if (!Number.isInteger(owner.pid) || owner.pid! <= 0) throw new Error('Invalid identity lock owner');
      try { process.kill(owner.pid!, 0); }
      catch (error) {
        if ((error as { code?: string }).code === 'ESRCH') {
          const gate = `${filename}.reap`;
          fs.mkdirSync(gate, { mode: 0o700 });
          try {
            const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (current.pid !== owner.pid) throw new Error('Identity owner changed while reclaiming a stale lock');
            try { process.kill(current.pid, 0); throw new Error('Identity owner is still alive'); }
            catch (probeError) {
              if ((probeError as { code?: string }).code !== 'ESRCH') throw probeError;
            }
            fs.unlinkSync(filename);
          } finally { fs.rmdirSync(gate); }
          continue;
        }
        throw error;
      }
      throw new Error(`Another process (${owner.pid}) already owns ${config.username}`);
    }
  }
  throw new Error('Could not acquire bot identity lock');
}
