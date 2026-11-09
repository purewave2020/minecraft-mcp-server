import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { ActionCoordinator, actionWait, actionDelay } from '../src/action-coordinator.js';

function fixture() {
  const bot = Object.assign(new EventEmitter(), {
    pathfinder: { setGoal: sinon.stub() }, stopDigging: sinon.stub(),
    clearControlStates: sinon.stub(), deactivateItem: sinon.stub(), quit: sinon.stub()
  });
  return { bot, getBot: () => bot as unknown as Bot, actions: new ActionCoordinator() };
}

test('inventory and navigation actions execute serially', async t => {
  const { actions, getBot } = fixture();
  const order: string[] = [];
  let finish: () => void = () => {};
  const first = actions.run('craft', getBot, async () => {
    order.push('craft-start'); await new Promise<void>(resolve => { finish = resolve; }); order.push('craft-end');
  });
  const second = actions.run('move', getBot, async () => { order.push('move'); });
  await new Promise(resolve => setImmediate(resolve));
  t.deepEqual(order, ['craft-start']);
  finish(); await Promise.all([first, second]);
  t.deepEqual(order, ['craft-start', 'craft-end', 'move']);
});

test('stop cancels the running action and already queued work', async t => {
  const { actions, getBot, bot } = fixture();
  const native = new Promise<void>(resolve => bot.stopDigging.callsFake(() => resolve()));
  let afterWait = false;
  const first = actions.run('dig', getBot, async () => { await actionWait(native); afterWait = true; });
  const queued = sinon.stub().resolves();
  const second = actions.run('move', getBot, queued);
  const firstError = t.throwsAsync(first, { message: /Stopped/ });
  const secondError = t.throwsAsync(second, { message: /Queued action was cancelled/ });
  await new Promise(resolve => setImmediate(resolve));
  actions.cancel();
  await Promise.all([firstError, secondError]);
  t.false(afterWait); t.false(queued.called); t.true(bot.clearControlStates.called);
});

test('MCP cancellation releases controls and cancels held-item delays', async t => {
  const { actions, getBot, bot } = fixture();
  const controller = new AbortController();
  const operation = actions.run('use-item', getBot, async () => { await actionDelay(5000); }, controller.signal);
  const failure = t.throwsAsync(operation, { message: /caller disconnected/ });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('caller disconnected'));
  await failure;
  t.true(bot.deactivateItem.called); t.is(actions.currentAction, null);
});

test('an uncancellable native operation loses its connection before new work starts', async t => {
  const { actions, getBot, bot } = fixture();
  const first = actions.run('craft', getBot, async () => actionWait(new Promise<void>(() => {})), undefined, 20);
  const failure = t.throwsAsync(first, { message: /timed out/ });
  await failure;
  t.true(bot.quit.calledOnce);
  t.regex(bot.quit.firstCall.args[0], /did not settle/);
});

test('disconnect aborts an in-flight action', async t => {
  const { actions, getBot, bot } = fixture();
  const operation = actions.run('use-item', getBot, () => actionDelay(5000));
  const failure = t.throwsAsync(operation, { message: /disconnected/ });
  await new Promise(resolve => setImmediate(resolve));
  bot.emit('end'); await failure;
  t.is(actions.currentAction, null);
});
