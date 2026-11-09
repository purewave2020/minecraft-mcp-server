import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { ActionCoordinator, actionDelay } from '../src/action-coordinator.js';
import { attachMovementGuard, movementStatus } from '../src/movement-guard.js';

function setup() {
  const actions = new ActionCoordinator();
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: 'air' }), pathfinder: { setGoal: sinon.stub() },
    stopDigging: sinon.stub(), deactivateItem: sinon.stub(), clearControlStates: sinon.stub()
  });
  attachMovementGuard(bot as unknown as Bot, actions);
  return { actions, bot, getBot: () => bot as unknown as Bot };
}

test('position corrections cancel movement and report the reason', async t => {
  const { actions, bot, getBot } = setup();
  const move = actions.run('move-to-position', getBot, () => actionDelay(5000));
  const failed = t.throwsAsync(move, { message: /Server corrected/ });
  await new Promise(resolve => setImmediate(resolve));
  bot.emit('forcedMove'); await failed;
  t.true(bot.clearControlStates.called);
  t.is((movementStatus(getBot()) as { positionCorrections: number }).positionCorrections, 1);
});

test('unloaded chunks stop movement and guard listeners are removed on disconnect', async t => {
  const { actions, bot, getBot } = setup();
  bot.blockAt.returns(null);
  const move = actions.run('move-in-direction', getBot, () => actionDelay(5000));
  const failed = t.throwsAsync(move, { message: /chunk is loaded/ });
  await new Promise(resolve => setImmediate(resolve));
  bot.emit('physicsTick'); await failed;
  bot.emit('end');
  t.is(bot.listenerCount('physicsTick'), 0);
  t.is(bot.listenerCount('forcedMove'), 0);
});
