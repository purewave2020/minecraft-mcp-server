import test from 'ava';
import { EventEmitter } from 'node:events';
import type mineflayer from 'mineflayer';
import { setupClientTickEnd } from '../src/client-tick-end.js';

function createBot(version = '26.1') {
  const packets: string[] = [];
  const client = { state: 'play', write: (name: string) => packets.push(name) };
  const bot = Object.assign(new EventEmitter(), { version, _client: client });
  setupClientTickEnd(bot as unknown as mineflayer.Bot);
  return { bot, client, packets };
}

test('modern clients finish their tick after the movement packet', async (t) => {
  const { bot, client, packets } = createBot();
  bot.emit('physicsTick');
  client.write('position');
  t.deepEqual(packets, ['position']);

  await Promise.resolve();

  t.deepEqual(packets, ['position', 'tick_end']);
});

test('clients older than 1.21.2 do not send unsupported tick markers', async (t) => {
  const { bot, packets } = createBot('1.21.1');
  bot.emit('physicsTick');
  await Promise.resolve();
  t.deepEqual(packets, []);
});

test('configuration transitions suppress queued play packets', async (t) => {
  const { bot, client, packets } = createBot();
  bot.emit('physicsTick');
  client.state = 'configuration';
  await Promise.resolve();
  t.deepEqual(packets, []);
});

test('disconnect cancels queued ticks and removes the listener', async (t) => {
  const { bot, packets } = createBot();
  bot.emit('physicsTick');
  bot.emit('end');
  bot.emit('physicsTick');
  await Promise.resolve();
  t.deepEqual(packets, []);
  t.is(bot.listenerCount('physicsTick'), 0);
});
