import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const runtime = path.join(root, '.npm');
export const node = process.execPath;
export function writeJson(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); const temp = filename + '.' + randomUUID() + '.tmp'; try {
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, filename);
}
finally {
  fs.rmSync(temp, { force: true });
} }
export function readJson(filename) { try {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
catch {
  return null;
} }
export function processInfo(pid) { if (!Number.isInteger(pid) || pid < 1)
  return null; try {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim() || null;
}
catch {
  return null;
} }
export function lock(filename) { fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); const token = randomUUID(); for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const fd = fs.openSync(filename, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, fingerprint: processInfo(process.pid) }));
    }
    finally {
      fs.closeSync(fd);
    }
    return () => { if (readJson(filename)?.token === token)
      fs.rmSync(filename, { force: true }); };
  }
  catch (error) {
    if (error.code !== 'EEXIST')
      throw error;
    const owner = readJson(filename);
    if (!owner)
      throw new Error('Service lock is being initialized; retry after inspecting it');
    const info = processInfo(owner.pid);
    if (info && (!owner.fingerprint || info === owner.fingerprint))
      throw new Error('Service is already running under PID ' + owner.pid);
    const gate = filename + '.reap';
    fs.mkdirSync(gate, { mode: 0o700 });
    try {
      const current = readJson(filename);
      if (!current || current.token !== owner.token)
        throw new Error('Service owner changed while reclaiming a stale lock');
      const currentInfo = processInfo(current.pid);
      if (currentInfo && (!current.fingerprint || currentInfo === current.fingerprint))
        throw new Error('Service owner is still alive');
      fs.unlinkSync(filename);
    }
    finally {
      fs.rmdirSync(gate);
    }
  }
} throw new Error('Service lock contention'); }
export function appendLog(filename, data, maximum = 5 * 1024 * 1024, keep = 4) { fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); if (fs.existsSync(filename) && fs.statSync(filename).size + Buffer.byteLength(data) > maximum) {
  for (let i = keep - 1; i >= 1; i--) {
    fs.rmSync(filename + '.' + (i + 1), { force: true });
    if (fs.existsSync(filename + '.' + i))
      fs.renameSync(filename + '.' + i, filename + '.' + (i + 1));
  }
  fs.renameSync(filename, filename + '.1');
} fs.appendFileSync(filename, data, { mode: 0o600 }); }
export function listenerPid() { try {
  const values = execFileSync('lsof', ['-nP', '-t', '-iTCP:25568', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number);
  return values.length === 1 ? values[0] : null;
}
catch {
  return null;
} }
export function proxyStatus() { const pid = listenerPid(); const fingerprint = processInfo(pid); return { observedAt: new Date().toISOString(), listening: !!pid, proxyPid: pid, fingerprint, verified: !!fingerprint && fingerprint.includes('ViaProxy-3.4.15-SNAPSHOT.jar') && fingerprint.includes('127.0.0.1:25568') && fingerprint.includes('192.168.1.3:25565') }; }
export function cachedProxyStatus() {
  const state = readJson(path.join(runtime, 'proxy-owner.json'));
  if (state && Date.now() - Date.parse(state.observedAt) < 15000) return { ...state, cached: true };
  return { observedAt: state?.observedAt ?? null, listening: false, verified: false, healthy: false, stale: true };
}
export function sessionPaths(username) { if (!/^[A-Za-z0-9_]{1,16}$/.test(username))
  throw new Error('Invalid Minecraft username'); const key = username.toLowerCase(); const prefix = key === 'llmbot' ? 'mcp' : key; return { socket: path.join(runtime, key + '-control.sock'), state: path.join(runtime, prefix + '-session.json'), log: path.join(runtime, prefix + '-session.log'), lock: path.join(runtime, 'runtime', 'session-' + key + '.lock'), observer: path.join(runtime, key === 'llmbot' ? 'game-observer.cjs' : key + '-observer.cjs') }; }
