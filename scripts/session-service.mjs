import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, runtime, node, writeJson, readJson, lock, sessionPaths, cachedProxyStatus as proxyStatus, appendLog } from './runtime/common.mjs';
import { ensureProxy } from './proxy-service.mjs';
import { authorizeRequest } from './runtime/controller.mjs';
const username = process.argv[2] ?? 'LLMBot';
const paths = sessionPaths(username);
if ((readJson(path.join(runtime, 'runtime', 'maintenance.json'))?.untilUnix ?? 0) * 1000 > Date.now())
  throw new Error('Scheduled maintenance is active; retry after the current service migration finishes');
const release = lock(paths.lock);
let socketOwned = false;
let client, transport, server, stopping = false, restarting = false, failures = 0, restartTimer;
let healthPromise, healthFailures = 0;
let state = { pid: process.pid, username, startedAt: new Date().toISOString(), ready: false, reusesExistingProxy: true };
const persist = () => writeJson(paths.state, state);
function socketAlive() { return new Promise(resolve => { const socket = net.connect(paths.socket); socket.setTimeout(1000); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); socket.on('timeout', () => { socket.destroy(); resolve(false); }); }); }
async function probeHealth() { const probedClient = client; let connection; try {
  const result = await client.callTool({ name: 'get-connection-status', arguments: {} }, undefined, { timeout: 5000 });
  connection = JSON.parse(result.content[0].text);
  if (result.isError || typeof connection.connected !== 'boolean')
    throw new Error('Invalid MCP health response');
  healthFailures = 0;
}
catch (error) {
  connection = { connected: false, error: error.message };
  healthFailures++;
}
if (probedClient !== client || stopping)
  return state;
const proxy = proxyStatus(); state = { ...state, observedAt: new Date().toISOString(), ready: connection.connected === true && proxy.verified, connection, proxy, healthFailures }; persist();
if (healthFailures >= 3 && !restarting)
  scheduleRestart();
return state; }
async function health() {
  if (!healthPromise)
    healthPromise = probeHealth().finally(() => { healthPromise = undefined; });
  return healthPromise;
}
function scheduleRestart() { if (stopping || restartTimer)
  return; state.ready = false; persist(); restartTimer = setTimeout(() => { restartTimer = undefined; void connect().catch(error => { appendLog(paths.log, '[supervisor] ' + error.stack + '\n'); scheduleRestart(); }); }, Math.min(30000, 2000 * 2 ** Math.min(failures++, 4))); }
async function connect() { if (stopping || restarting)
  return; restarting = true; try {
  await client?.close().catch(() => { });
  ensureProxy();
  const deadline = Date.now() + 30000;
  while (!proxyStatus().verified) {
    if (Date.now() > deadline)
      throw new Error('Shared proxy is not ready');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const args = [...(fs.existsSync(paths.observer) ? ['--require', paths.observer] : []), path.join(root, 'dist/main.js'), '--host', '127.0.0.1', '--port', '25568', '--username', username, '--minecraft-version', '1.21.8'];
  transport = new StdioClientTransport({ command: node, args, cwd: root, stderr: 'pipe' });
  transport.stderr.on('data', data => appendLog(paths.log, data));
  client = new Client({ name: username.toLowerCase() + '-session', version: '2.0.0' });
  client.onclose = () => { if (!restarting)
    scheduleRestart(); };
  await client.connect(transport, { timeout: 15000 });
  state.mcpPid = transport.pid;
  state.toolCount = (await client.listTools()).tools.length;
  failures = 0;
  healthFailures = 0;
  await health();
}
finally {
  restarting = false;
} }
async function shutdown() { if (stopping)
  return; stopping = true; clearInterval(heartbeat); clearTimeout(restartTimer); await client?.close().catch(() => { }); server?.close(); if (socketOwned) {
  try {
    fs.unlinkSync(paths.socket);
  }
  catch { }
} state.ready = false; state.stoppedAt = new Date().toISOString(); persist(); release(); setTimeout(() => process.exit(0), 100).unref(); }
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
const heartbeat = setInterval(() => { if (!restarting && !stopping)
  void health(); }, 5000);
heartbeat.unref();
try {
  if (fs.existsSync(paths.socket)) {
    if (await socketAlive())
      throw new Error(username + ' already has a live control socket');
    fs.unlinkSync(paths.socket);
  }
  await connect();
  server = net.createServer(socket => { socket.setEncoding('utf8'); socket.setTimeout(100000, () => socket.destroy()); let buffer = ''; socket.on('error', () => { }); socket.on('data', data => { buffer += data; if (buffer.length > 65536)
    return socket.destroy(); const end = buffer.indexOf('\n'); if (end < 0)
    return; socket.pause(); void (async () => { try {
    const request = JSON.parse(buffer.slice(0, end));
    authorizeRequest(username, request);
    let result;
    if (request.action === 'status')
      result = await health();
    else if (request.action === 'list-tools')
      result = await client.listTools();
    else if (request.action === 'call') {
      const controller = new AbortController();
      socket.once('close', () => controller.abort());
      result = await client.callTool({ name: request.name, arguments: request.arguments ?? {} }, undefined, { timeout: 90000, signal: controller.signal });
    }
    else if (request.action === 'stop') {
      socket.end(JSON.stringify({ stopping: true }) + '\n');
      await shutdown();
      return;
    }
    else
      throw new Error('Unknown action');
    socket.end(JSON.stringify(result) + '\n');
  }
  catch (error) {
    socket.end(JSON.stringify({ error: error.message }) + '\n');
  } })(); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, resolve); });
  socketOwned = true;
  fs.chmodSync(paths.socket, 0o600);
  persist();
}
catch (error) {
  appendLog(paths.log, '[session] ' + error.stack + '\n');
  await shutdown();
  process.exitCode = 1;
}
