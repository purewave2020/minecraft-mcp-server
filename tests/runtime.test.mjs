import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { root, lock, sessionPaths, writeJson, readJson } from '../scripts/runtime/common.mjs';
import { authorizeRequest } from '../scripts/runtime/controller.mjs';
test('a live service lock cannot be acquired twice and release permits a successor', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-lock-'));
  try {
    const filename = path.join(directory, 'owner.lock');
    const release = lock(filename);
    assert.throws(() => lock(filename), /already running/);
    release();
    const second = lock(filename);
    second();
    assert.equal(fs.existsSync(filename), false);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('controller assignment rejects competing mutations while permitting diagnostics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-controller-'));
  try {
    const filename = path.join(directory, 'controller-unitbot.json');
    writeJson(filename, { controllerId: 'owner' });
    assert.throws(() => authorizeRequest('UnitBot', { action: 'call', name: 'dig-block', controllerId: 'competing' }, directory), /handoff/);
    assert.throws(() => authorizeRequest('UnitBot', { action: 'stop', controllerId: 'competing' }, directory), /handoff/);
    authorizeRequest('UnitBot', { action: 'call', name: 'get-status' }, directory);
    authorizeRequest('UnitBot', { action: 'call', name: 'dig-block', controllerId: 'owner' }, directory);
    authorizeRequest('UnitBot', { action: 'stop', controllerId: 'owner' }, directory);
    assert.ok(readJson(filename).lastActionAt);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('a rejected duplicate session leaves the existing control socket intact', async () => {
  const username = 'Unit' + randomUUID().replaceAll('-', '').slice(0, 10);
  const paths = sessionPaths(username);
  fs.mkdirSync(path.dirname(paths.socket), { recursive: true, mode: 0o700 });
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(paths.socket, resolve));
  try {
    const child = spawn(process.execPath, [path.join(root, 'scripts/session-service.mjs'), username], { cwd: root, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', data => stderr += data);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 1, stderr);
    assert.ok(fs.existsSync(paths.socket));
    assert.ok(server.listening);
  }
  finally {
    await new Promise(resolve => server.close(resolve));
    for (const filename of [paths.state, paths.log, paths.lock])
      fs.rmSync(filename, { force: true });
  }
});
