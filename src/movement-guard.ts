import type { Bot } from 'mineflayer';
import { ActionCoordinator, stopBotActions } from './action-coordinator.js';

const statuses = new WeakMap<Bot, { positionCorrections: number; movementStops: number; lastStop?: string }>();

export function movementStatus(bot: Bot | null): unknown { return bot ? statuses.get(bot) : undefined; }

export function attachMovementGuard(bot: Bot, actions: ActionCoordinator): void {
  if (statuses.has(bot)) return;
  const status = { positionCorrections: 0, movementStops: 0, lastStop: undefined as string | undefined };
  statuses.set(bot, status);
  const stop = (reason: string) => {
    status.movementStops++;
    status.lastStop = reason;
    actions.cancel(reason);
    stopBotActions(bot);
  };
  const forcedMove = () => {
    status.positionCorrections++;
    if (actions.currentAction) stop('Server corrected the position; inspect the new position before choosing another route');
  };
  const tick = () => {
    if (!actions.currentAction || !['move-to-position', 'move-in-direction', 'jump', 'automatic-defense', 'dig-block', 'place-block'].includes(actions.currentAction)) return;
    const position = bot.entity?.position;
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
      stop('Movement stopped because position data is invalid');
    } else if (bot.blockAt(position) === null) {
      stop('Movement stopped until the current chunk is loaded');
    }
  };
  const cleanup = () => { bot.removeListener('forcedMove', forcedMove); bot.removeListener('physicsTick', tick); };
  bot.on('forcedMove', forcedMove);
  bot.on('physicsTick', tick);
  bot.once('end', cleanup);
}
