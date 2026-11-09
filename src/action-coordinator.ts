import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Bot } from 'mineflayer';

interface ActionContext {
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
}
const contexts = new AsyncLocalStorage<ActionContext>();
const coordinators = new WeakMap<Bot, ActionCoordinator>();

export function checkAction(): void { contexts.getStore()?.signal.throwIfAborted(); }
export function currentActionSignal(): AbortSignal | undefined { return contexts.getStore()?.signal; }

export async function actionWait<T>(operation: Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (!context) return operation;
  context.pending.add(operation);
  const settled = operation.finally(() => context.pending.delete(operation));
  // Keep a handler on work that outlives a cancellation.
  settled.catch(() => {});
  context.signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    const result = await Promise.race([settled, new Promise<never>((_, reject) => {
      abort = () => reject(context.signal.reason ?? new Error('Action cancelled'));
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) abort();
    })]);
    context.signal.throwIfAborted();
    return result;
  } finally { context.signal.removeEventListener('abort', abort); }
}

export async function actionDelay(milliseconds: number): Promise<void> {
  const signal = contexts.getStore()?.signal;
  await delay(milliseconds, undefined, { signal });
  checkAction();
}

export function stopBotActions(bot: Bot): void {
  const stop = (operation: () => unknown) => { try { operation(); } catch { /* Best effort after disconnect. */ } };
  stop(() => bot.pathfinder?.setGoal(null));
  stop(() => bot.stopDigging?.());
  stop(() => bot.deactivateItem?.());
  stop(() => bot.clearControlStates?.());
  stop(() => bot.creative?.stopFlying());
  if (bot.currentWindow) stop(() => bot.closeWindow(bot.currentWindow!));
}

export class ActionCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private active?: { controller: AbortController; name: string };
  private generation = 0;
  private quarantined = new WeakSet<Bot>();

  get currentAction(): string | null { return this.active?.name ?? null; }

  cancel(reason = 'Stopped by controller'): void {
    this.generation++;
    this.active?.controller.abort(new Error(reason));
  }

  async run<T>(name: string, getBot: () => Bot, executor: () => Promise<T>, signal?: AbortSignal, timeoutMs = 70000): Promise<T> {
    const generation = this.generation;
    const queued = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await queued;
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new Error('Queued action was cancelled');
      const bot = getBot();
      if (!bot) throw new Error('Bot disconnected before action started');
      if (this.quarantined.has(bot)) throw new Error('Previous operation is still settling; wait for the bot to reconnect');
      coordinators.set(bot, this);
      const controller = new AbortController();
      const context: ActionContext = { signal: controller.signal, pending: new Set() };
      const onAbort = () => controller.abort(signal?.reason ?? new Error('MCP request cancelled'));
      const onEnd = () => controller.abort(new Error('Bot disconnected during action'));
      signal?.addEventListener('abort', onAbort, { once: true });
      bot.once?.('end', onEnd);
      bot.once?.('respawn', onEnd);
      bot.once?.('death', onEnd);
      const timer = setTimeout(() => controller.abort(new Error(`Action timed out after ${timeoutMs}ms`)), timeoutMs);
      this.active = { controller, name };
      try {
        return await contexts.run(context, () => actionWait(Promise.resolve().then(() => { checkAction(); return executor(); })));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        bot.removeListener?.('end', onEnd);
        bot.removeListener?.('respawn', onEnd);
        bot.removeListener?.('death', onEnd);
        if (controller.signal.aborted) {
          contexts.exit(() => stopBotActions(bot));
          // Native operations without cancellation must finish or lose their connection
          // before the next action can manipulate inventory/navigation.
          if (context.pending.size) {
            await Promise.race([Promise.allSettled([...context.pending]), delay(1000)]);
            contexts.exit(() => stopBotActions(bot));
            if (context.pending.size) {
              this.quarantined.add(bot);
              bot.quit?.('Cancelled operation did not settle; reconnecting safely');
            }
          }
        }
        this.active = undefined;
      }
    } finally { release(); }
  }
}

export function actionCoordinatorFor(bot: Bot): ActionCoordinator | undefined { return coordinators.get(bot); }

export function bindActionCoordinator(bot: Bot, coordinator: ActionCoordinator): void { coordinators.set(bot, coordinator); }
