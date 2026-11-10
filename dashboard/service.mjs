import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const cwd = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.DASHBOARD_DATA ?? path.join(cwd, '../.npm/dashboard');
const recordPath = path.join(data, 'service.json');
const self = fileURLToPath(import.meta.url);
const command = process.argv[2] ?? 'status';
process.umask(0o077);
fs.mkdirSync(data, { recursive: true, mode: 0o700 });

function record() {
  try { return JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch { return null; }
}
function owned(value) {
  if (!value?.pid || !value.nonce) return false;
  try { return execFileSync('ps', ['-p', String(value.pid), '-o', 'command='], { encoding: 'utf8' }).includes(self + ' run ' + value.nonce); }
  catch { return false; }
}
function save(value) {
  fs.writeFileSync(recordPath + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(recordPath + '.tmp', recordPath);
}
async function health(value) {
  const headers = process.env.DASHBOARD_PASSWORD ? { Authorization: 'Basic ' + Buffer.from('dashboard:' + process.env.DASHBOARD_PASSWORD).toString('base64') } : {};
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}/health`, { headers, signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  }
  catch { return null; }
}

if (command === 'run') {
  const nonce = process.argv[3];
  if (!nonce) throw new Error('Missing service token');
  const previous = record();
  if (owned(previous)) process.exit(1);
  const state = { pid: process.pid, nonce, port: Number(process.env.DASHBOARD_PORT ?? 18100), startedAt: new Date().toISOString(), childPid: null, restarts: 0 };
  let child; let timer; let stopping = false;
  save(state);
  const launch = () => {
    child = spawn(process.execPath, ['--import=tsx', path.join(cwd, 'server/main.ts')], { cwd, stdio: 'inherit' });
    state.childPid = child.pid; save(state);
    child.on('error', error => console.error(error.message));
    child.on('close', () => {
      if (stopping) { if (record()?.nonce === nonce) fs.unlinkSync(recordPath); process.exit(0); }
      state.restarts++; state.childPid = null; save(state);
      timer = setTimeout(launch, Math.min(30_000, 1000 * 2 ** Math.min(state.restarts, 5)));
    });
  };
  const stop = () => { stopping = true; clearTimeout(timer); if (child?.exitCode === null) child.kill('SIGTERM'); else { if (record()?.nonce === nonce) fs.unlinkSync(recordPath); process.exit(0); } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  launch();
} else if (command === 'start') {
  let value = record();
  if (!owned(value)) {
    const output = fs.openSync(path.join(data, 'service.log'), 'a', 0o600);
    const nonce = randomUUID();
    const child = spawn(process.execPath, [self, 'run', nonce], { cwd, detached: true, stdio: ['ignore', output, output] });
    child.unref(); fs.closeSync(output);
    for (let i = 0; i < 40; i++) { await new Promise(resolve => setTimeout(resolve, 200)); value = record(); if (value?.nonce === nonce && await health(value)) break; }
  }
  const status = owned(value) ? await health(value) : null;
  if (!status) throw new Error('Dashboard has not become ready; inspect .npm/dashboard/service.log');
  console.log(JSON.stringify({ running: true, url: `http://127.0.0.1:${value.port}/`, ...status }));
} else if (command === 'stop') {
  const value = record();
  if (owned(value)) {
    process.kill(value.pid, 'SIGTERM');
    for (let i = 0; i < 300 && owned(value); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (owned(value)) throw new Error('Dashboard is still shutting down; inspect its log');
  }
  console.log(JSON.stringify({ running: false }));
} else if (command === 'status') {
  const value = record();
  console.log(JSON.stringify({ running: owned(value), ...(owned(value) ? { url: `http://127.0.0.1:${value.port}/`, health: await health(value), restarts: value.restarts } : {}) }));
} else throw new Error('Use start, stop, or status');
