import type { Bot } from 'mineflayer';
import { ActionCoordinator, stopBotActions } from './action-coordinator.js';

const statuses = new WeakMap<Bot, { positionCorrections: number; movementStops: number; floatingStops: number; lastStop?: string }>();

export function movementStatus(bot: Bot | null): unknown { return bot ? statuses.get(bot) : undefined; }

export function attachMovementGuard(bot: Bot, actions: ActionCoordinator): void {
  if (statuses.has(bot)) return;
  const status = { positionCorrections: 0, movementStops: 0, floatingStops: 0, lastStop: undefined as string | undefined };
  let floatingSince: number | undefined;
  let floatingY: number | undefined;
  statuses.set(bot, status);
  const stop = (reason: string) => {
    status.movementStops++;
    status.lastStop = reason;
    actions.cancel(reason);
    stopBotActions(bot);
  };
  const forcedMove = () => {
    status.positionCorrections++;
    floatingSince = undefined;
    if (actions.currentAction) stop('Server corrected the position; inspect the new position before choosing another route');
  };
  const tick = () => {
    if (!actions.currentAction || !['move-to-position', 'move-in-direction', 'jump', 'automatic-defense', 'dig-block', 'place-block'].includes(actions.currentAction)) { floatingSince = undefined; return; }
    const position = bot.entity?.position;
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
      stop('Movement stopped because position data is invalid');
    } else if (bot.blockAt(position) === null || bot.blockAt(position.offset(0, -0.1, 0)) === null) {
      stop('Movement stopped until the current chunk is loaded');
    } else {
      const entity = bot.entity;
      const physics = entity as typeof entity & { isInWater?: boolean; isInLava?: boolean };
      const exempt = bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator' || physics.isInWater || physics.isInLava;
      const supports = [-0.25, 0, 0.25].flatMap(x => [-0.25, 0, 0.25].map(z => bot.blockAt(position.offset(x, -0.1, z))));
      const unsupported = supports.every(block => block?.boundingBox === 'empty' && !['water', 'lava', 'ladder', 'vine', 'scaffolding'].includes(block.name));
      const stationaryY = floatingY !== undefined && Math.abs(position.y - floatingY) < 0.02 && Math.abs(entity.velocity?.y ?? 0) < 0.02;
      if (!exempt && unsupported && stationaryY) {
        floatingSince ??= Date.now();
        if (Date.now() - floatingSince >= 2000) {
          status.floatingStops++;
          floatingSince = undefined;
          stop('Movement stopped after sustained unsupported hovering; inspect block synchronization before moving again');
        }
      } else { floatingSince = undefined; }
      floatingY = position.y;
    }
  };
  const cleanup = () => { bot.removeListener('forcedMove', forcedMove); bot.removeListener('physicsTick', tick); };
  bot.on('forcedMove', forcedMove);
  bot.on('physicsTick', tick);
  bot.once('end', cleanup);
}
