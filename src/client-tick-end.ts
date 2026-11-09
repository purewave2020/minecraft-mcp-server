import type mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';

// Mineflayer 4.39.0 does not send this packet. Keep it pinned until native support
// replaces this shim; newer servers reject movement without client tick markers.
export function setupClientTickEnd(bot: mineflayer.Bot): void {
  if (minecraftData(bot.version).version['<']('1.21.2')) return;

  let active = true;
  const onPhysicsTick = () => {
    // Mineflayer emits physicsTick before writing the tick's movement packet.
    queueMicrotask(() => {
      if (active && bot._client.state === 'play') {
        bot._client.write('tick_end', {});
      }
    });
  };

  bot.on('physicsTick', onPhysicsTick);
  bot.once('end', () => {
    active = false;
    bot.removeListener('physicsTick', onPhysicsTick);
  });
}
