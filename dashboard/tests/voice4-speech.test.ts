import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { Voice4Speech, VOICE4_ID } from '../server/voice4-speech.js';

const wav = Buffer.alloc(46);
wav.write('RIFF', 0); wav.write('WAVE', 8);

test('voice4 generation deduplicates concurrent requests, reuses cached audio and cleans temporary files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice4-test-'));
  let calls = 0;
  const service = new Voice4Speech(directory, 'darwin', async (text, output) => {
    calls++; assert.equal(text, '中文聊天'); await fs.writeFile(output, wav);
  });
  try {
    const [first, second] = await Promise.all([service.render('中文聊天'), service.render('中文聊天')]);
    assert.deepEqual(first, wav); assert.deepEqual(second, wav); assert.equal(calls, 1);
    await service.render('中文聊天'); assert.equal(calls, 1);
    assert.deepEqual(await fs.readdir(directory), []);
    await assert.rejects(service.render(''), /长度/);
    await assert.rejects(service.render('a'.repeat(1001)), /长度/);
  } finally { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('missing or failed voice4 never reports another voice as available and never caches invalid audio', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice4-test-'));
  let calls = 0;
  const service = new Voice4Speech(directory, 'darwin', async (_text, output) => { calls++; await fs.writeFile(output, 'not audio'); });
  try {
    assert.deepEqual(await service.capabilities(), { available: false, name: '声音4', voiceId: VOICE4_ID });
    await assert.rejects(service.render('中文聊天'), /有效音频/);
    assert.equal(calls, 2); assert.deepEqual(await fs.readdir(directory), []);
    const unsupported = new Voice4Speech(directory, 'linux');
    assert.equal((await unsupported.capabilities()).available, false);
    await assert.rejects(unsupported.render('test'), /Mac/); await unsupported.stop();
  } finally { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('native playback uses the exact Siri voice, passes chat through stdin and cancels only its own process', async () => {
  const calls: Array<{ args: string[]; timeout: number; text: string; signals: unknown[]; child: ChildProcess }> = [];
  const service = new Voice4Speech('unused', 'darwin', undefined, (args, timeout) => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough();
    const call = { args, timeout, text: '', signals: [] as unknown[], child }; calls.push(call);
    child.stdin.on('data', chunk => { call.text += String(chunk); });
    child.kill = signal => { call.signals.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
    return child;
  });
  try {
    const text = '聊天 $(touch should-never-run) `command` --voice=other';
    const first = service.play(text);
    assert.deepEqual(calls[0].args, ['-v', VOICE4_ID, '-f', '-']);
    assert.equal(calls[0].text, text); assert.equal(calls[0].timeout, 90_000);
    service.cancelPlayback(); await assert.rejects(first, /播报失败/);
    assert.deepEqual(calls[0].signals, ['SIGTERM']);
    const second = service.play('新的聊天');
    calls[1].child.emit('close', 0); await second;
    await service.stop(); await assert.rejects(service.play('关闭后'), /Mac/);
  } finally { await service.stop(); }
});

test('rapid restart waits for native cancellation and discards superseded playback requests', async () => {
  const children: ChildProcess[] = [];
  const service = new Voice4Speech('unused', 'darwin', undefined, () => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough(); child.kill = () => true; children.push(child); return child;
  });
  const first = service.play('第一条'); const firstResult = assert.rejects(first);
  service.cancelPlayback();
  const skipped = service.play('过时的第二条'); const skippedResult = assert.rejects(skipped, /取消/);
  const latest = service.play('最后一条');
  assert.equal(children.length, 1, 'new playback must wait for the previous process to exit');
  children[0].emit('close', null, 'SIGTERM');
  await Promise.all([firstResult, skippedResult]);
  assert.equal(children.length, 2); children[1].emit('close', 0); await latest; await service.stop();
});
