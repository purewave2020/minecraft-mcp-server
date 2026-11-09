import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root, runtime, node, writeJson, readJson, lock, proxyStatus, appendLog, processInfo } from './runtime/common.mjs';
const ownerFile = path.join(runtime, 'proxy-owner.json');
const managerFile = path.join(runtime, 'proxy-manager.json');
const logFile = path.join(runtime, 'viaproxy', 'launcher.log');
const java = '/Users/xiaqingbo/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java';
export async function runProxy() {
  const release = lock(path.join(runtime, 'runtime', 'proxy-manager.lock'));
  let stopping = false, child, retryAt = 0, failures = 0;
  const stamp = () => { const state = proxyStatus(); if (state.listening && !state.verified)
    throw new Error('Port 25568 is owned by an unexpected process'); writeJson(ownerFile, { ...state, managerPid: process.pid, managedChild: child?.pid === state.proxyPid }); writeJson(managerFile, { pid: process.pid, fingerprint: processInfo(process.pid), observedAt: state.observedAt, healthy: state.verified, failures }); return state; };
  const shutdown = () => { if (stopping)
    return; stopping = true; clearInterval(timer); release(); writeJson(managerFile, { pid: process.pid, stoppedAt: new Date().toISOString() }); process.exit(0); };
  const check = () => { if (stopping)
    return; try {
    const state = stamp();
    if (state.verified) {
      failures = 0;
      if (!child && fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
        for (let i = 3; i >= 1; i--) {
          fs.rmSync(logFile + '.' + (i + 1), { force: true });
          if (fs.existsSync(logFile + '.' + i))
            fs.renameSync(logFile + '.' + i, logFile + '.' + (i + 1));
        }
        fs.copyFileSync(logFile, logFile + '.1');
        fs.truncateSync(logFile, 0);
      }
      return;
    }
    if (child?.exitCode === null || Date.now() < retryAt)
      return;
    const jar = path.join(runtime, 'viaproxy', 'ViaProxy-3.4.15-SNAPSHOT.jar');
    const expected = readJson(path.join(runtime, 'viaproxy', 'installation.json'))?.sha256;
    if (!expected || createHash('sha256').update(fs.readFileSync(jar)).digest('hex') !== expected)
      throw new Error('ViaProxy installation hash mismatch');
    child = spawn(java, ['-Xms64M', '-Xmx512M', '-Djava.awt.headless=true', '-jar', jar, 'cli', '--bind-address', '127.0.0.1:25568', '--target-address', '192.168.1.3:25565', '--target-version', '26.3', '--auth-method', 'NONE', '--proxy-online-mode', 'false'], { cwd: path.dirname(jar), stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', data => appendLog(logFile, data));
    child.on('error', error => appendLog(logFile, String(error) + '\n'));
    child.on('exit', () => { child = undefined; retryAt = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)); });
  }
  catch (error) {
    appendLog(logFile, '[proxy-manager] ' + String(error) + '\n');
    retryAt = Date.now() + 30000;
  } };
  const timer = setInterval(check, 5000);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  check();
}
export function ensureProxy() {
  const status = proxyStatus();
  if (status.listening && !status.verified)
    throw new Error('Unexpected service owns 25568');
  const manager = readJson(managerFile);
  if (manager?.pid && manager.fingerprint === processInfo(manager.pid))
    return status;
  const child = spawn(node, [path.join(root, 'scripts/proxy-service.mjs'), 'run'], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  return { ...status, managerStarting: child.pid };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] ?? 'status';
  if (action === 'run')
    await runProxy();
  else if (action === 'ensure')
    console.log(JSON.stringify(ensureProxy()));
  else if (action === 'status')
    console.log(JSON.stringify(proxyStatus()));
  else
    throw new Error('Use ensure, run or status; shared proxy shutdown must be coordinated with its clients');
}
