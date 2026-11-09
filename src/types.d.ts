declare module 'mineflayer-pathfinder' {
  import type { Bot } from 'mineflayer';

  export class Movements {
    constructor(_bot: Bot, _mcData: unknown);
    canDig: boolean;
    allow1by1towers: boolean;
    allowParkour: boolean;
    allowSprinting: boolean;
    maxDropDown: number;
    liquidCost: number;
  }
}
