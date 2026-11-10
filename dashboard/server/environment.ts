import { Store } from './store.js';
import type { EnvironmentState, Weather } from './types.js';

/** Read console feedback from 26.3's day timeline and read-only weather predicates. */
export class EnvironmentTracker {
  readonly state: EnvironmentState;
  constructor(readonly store: Store) {
    this.state = store.meta<EnvironmentState>('environment', {
      timeOfDay: null, timeRate: 0, timeObservedAt: null, weather: null, weatherObservedAt: null
    });
  }
  line(body: string, timestamp: number, historical: boolean): boolean {
    const time = /^Timeline minecraft:day is at (-?\d+(?:\.\d+)?) tick\(s\)$/.exec(body);
    const weather = /^Storage minecraft_dashboard:weather_(clear|rain|thunder) has the following contents: /.exec(body);
    if (!time && !weather) return false;
    if (historical) return true;
    if (time) {
      if (this.state.timeObservedAt !== null && timestamp <= this.state.timeObservedAt) return true;
      const ticks = ((Number(time[1]) % 24000) + 24000) % 24000;
      let rate = 0;
      if (this.state.timeOfDay !== null && this.state.timeObservedAt !== null) {
        const seconds = (timestamp - this.state.timeObservedAt) / 1000;
        const elapsed = (ticks - this.state.timeOfDay + 24000) % 24000;
        // Re-anchor jumps, sleeping and reconnects instead of extrapolating them as clock speed.
        if (seconds > 0 && seconds <= 15 && elapsed / seconds <= 200) rate = elapsed / seconds;
      }
      Object.assign(this.state, { timeOfDay: ticks, timeRate: rate, timeObservedAt: timestamp });
    } else if (weather) {
      if (this.state.weatherObservedAt !== null && timestamp <= this.state.weatherObservedAt) return true;
      Object.assign(this.state, { weather: weather[1] as Weather, weatherObservedAt: timestamp });
    }
    this.store.setMeta('environment', this.state);
    this.store.event('world.environment', { ...this.state });
    return true;
  }
}
