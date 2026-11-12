import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root, runtime, node, writeJson, readJson, lock, proxyStatus, appendLog, processInfo } from './runtime/common.mjs';
import { probeServer, recoveryReason } from './runtime/server-probe.mjs';
const ownerFile = path.join(runtime, 'proxy-owner.json');
const managerFile = path.join(runtime, 'proxy-manager.json');
const logFile = path.join(runtime, 'viaproxy', 'launcher.log');
const java = '/Users/xiaqingbo/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java';

function activeSessions() {
  return fs.readdirSync(runtime).filter(name => name.endsWith('-session.json')).flatMap(name => {
    const state = readJson(path.join(runtime, name));
    if (!state || state.stoppedAt || !processInfo(state.pid)?.includes('scripts/session-service.mjs ' + state.username)) return [];
    return [{ username: state.username, connected: state.connection?.connected === true,
      fresh: Date.now() - Date.parse(state.observedAt) < 20000 }];
  });
}
export async function runProxy() {
  const release = lock(path.join(runtime, 'runtime', 'proxy-manager.lock'));
  const fingerprint = processInfo(process.pid);
  let stopping = false, checking = false, child, retryAt = 0, failures = 0;
  let backend, proxy, nextProbe = 0, failedProbes = 0, unhealthySince = 0, lastRecovery = 0, recoveries = 0;
  const shutdown = () => {
    if (stopping) return;
    stopping = true; clearInterval(timer); release();
    writeJson(managerFile, { pid: process.pid, stoppedAt: new Date().toISOString() });
    // Leave the shared Java process running for a replacement manager to adopt.
    process.exit(0);
  };
  const check = async () => {
    if (stopping || checking) return;
    checking = true;
    try {
      const state = proxyStatus();
      if (state.listening && !state.verified) throw new Error('Port 25568 is owned by an unexpected process');
      if (Date.now() >= nextProbe) {
        [backend, proxy] = await Promise.all([probeServer('192.168.1.3', 25565), probeServer('127.0.0.1', 25568)]);
        nextProbe = Date.now() + 15000;
        failedProbes = proxy.healthy ? 0 : failedProbes + 1;
        unhealthySince = proxy.healthy ? 0 : unhealthySince || Date.now();
      }
      if (stopping) return;
      const sessions = activeSessions();
      const reason = recoveryReason({ proxy, direct: backend, sessions, failures: failedProbes,
        elapsedMs: unhealthySince ? Date.now() - unhealthySince : 0, cooldownMs: Date.now() - lastRecovery });
      if (reason && state.verified && processInfo(state.proxyPid) === state.fingerprint) {
        lastRecovery = Date.now(); recoveries++;
        appendLog(logFile, '[proxy-manager] Controlled recovery: ' + reason + '\n');
        process.kill(state.proxyPid, 'SIGTERM');
      }
      const healthy = state.verified && proxy?.healthy === true;
      const alerts = !healthy ? [{ code: 'proxy-backend-unreachable', since: unhealthySince || null, error: proxy?.error ?? null }] : [];
      writeJson(ownerFile, { ...state, managerPid: process.pid, managedChild: child?.pid === state.proxyPid,
        healthy, backend, probe: proxy, failedProbes, unhealthySince: unhealthySince || null, alerts, recoveries });
      writeJson(managerFile, { pid: process.pid, fingerprint, observedAt: new Date().toISOString(), healthy, failures, recoveries });
      if (state.verified) { failures = 0; return; }
      if (child?.exitCode === null || Date.now() < retryAt) return;
      const jar = path.join(runtime, 'viaproxy', 'ViaProxy-3.4.15-SNAPSHOT.jar');
      const expected = readJson(path.join(runtime, 'viaproxy', 'installation.json'))?.sha256;
      if (!expected || createHash('sha256').update(fs.readFileSync(jar)).digest('hex') !== expected) throw new Error('ViaProxy installation hash mismatch');
      child = spawn(java, ['-Xms64M', '-Xmx512M', '-Djava.awt.headless=true', '-jar', jar, 'cli', '--bind-address', '127.0.0.1:25568', '--target-address', '192.168.1.3:25565', '--target-version', '26.3', '--auth-method', 'NONE', '--proxy-online-mode', 'false'], { cwd: path.dirname(jar), stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => appendLog(logFile, data));
      child.on('error', error => appendLog(logFile, String(error) + '\n'));
      child.on('exit', () => { child = undefined; nextProbe = 0; retryAt = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)); });
    } catch (error) {
      appendLog(logFile, '[proxy-manager] ' + String(error) + '\n');
      retryAt = Date.now() + 30000;
    } finally { checking = false; }
  };
  const timer = setInterval(() => void check(), 5000);
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  await check();
}
export function ensureProxy() {
  const status = proxyStatus();
  if (status.listening && !status.verified) throw new Error('Unexpected service owns 25568');
  const manager = readJson(managerFile);
  if (manager?.pid && manager.fingerprint === processInfo(manager.pid)) return status;
  const child = spawn(node, [path.join(root, 'scripts/proxy-service.mjs'), 'run'], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  return { ...status, managerStarting: child.pid };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] ?? 'status';
  if (action === 'run') await runProxy();
  else if (action === 'ensure') console.log(JSON.stringify(ensureProxy()));
  else if (action === 'status') {
    const [backend, probe] = await Promise.all([probeServer('192.168.1.3', 25565), probeServer('127.0.0.1', 25568)]);
    const state = proxyStatus(); console.log(JSON.stringify({ ...state, healthy: state.verified && probe.healthy, backend, probe }));
  } else throw new Error('Use ensure, run or status; shared proxy shutdown must be coordinated with its clients');
}
