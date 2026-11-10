import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { WorldState } from '../server/world-state.js';
import { environmentView } from '../client/environment-model.js';
import type { EnvironmentState } from '../server/types.js';

const now = Date.parse('2026-11-10T10:00:00Z');
const environment = (ticks: number, weather: EnvironmentState['weather'] = 'clear'): EnvironmentState => ({
  timeOfDay: ticks, timeRate: 20, timeObservedAt: now, weather, weatherObservedAt: now
});

test('26.3 console timeline and weather feedback become persisted environment SSE updates', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  const line = (body: string, seconds = '00', historical = false) => world.line(`[18:00:${seconds}] [Server thread/INFO]: System chat: ${body}`, 'fixture', historical, now);
  try {
    assert.equal(world.environment.state.timeOfDay, null);
    line('Timeline minecraft:day is at 6000 tick(s)');
    line('Storage minecraft_dashboard:weather_clear has the following contents: {}');
    assert.deepEqual(world.environment.state, { ...environment(6000), timeRate: 0 });
    // Rate is unknown until two actual samples have arrived.
  } finally { store.close(); }
});

test('clock sampling handles midnight wrap, paused time, manual jumps and stale replay', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  const sample = (ticks: number, timestamp: number, historical = false) => world.environment.line(`Timeline minecraft:day is at ${ticks} tick(s)`, timestamp, historical);
  try {
    sample(23950, now); assert.equal(world.environment.state.timeRate, 0);
    sample(50, now + 5000); assert.equal(world.environment.state.timeRate, 20);
    sample(50, now + 10000); assert.equal(world.environment.state.timeRate, 0);
    sample(18000, now + 15000); assert.equal(world.environment.state.timeOfDay, 18000); assert.equal(world.environment.state.timeRate, 0);
    sample(9000, now + 1000); sample(12000, now + 20000, true);
    assert.equal(world.environment.state.timeOfDay, 18000); assert.equal(world.environment.state.timeObservedAt, now + 15000);
    sample(18100, now + 20000); assert.equal(world.environment.state.timeRate, 20);
    const restored = new WorldState(store, new Set()); assert.deepEqual(restored.environment.state, world.environment.state);
    assert.equal(store.events(0).every(event => event.type === 'world.environment'), true);
  } finally { store.close(); }
});

test('clear, rain and thunder stay distinct; historical, out-of-order and unrelated feedback cannot change weather', () => {
  const store = new Store(':memory:'); const world = new WorldState(store, new Set());
  try {
    for (const [i, weather] of ['clear', 'rain', 'thunder'].entries()) {
      world.environment.line(`Storage minecraft_dashboard:weather_${weather} has the following contents: {}`, now + i * 5000, false);
      assert.equal(world.environment.state.weather, weather);
    }
    world.environment.line('Storage minecraft_dashboard:weather_clear has the following contents: {}', now, false);
    world.environment.line('Storage minecraft_dashboard:weather_rain has the following contents: {}', now + 15000, true);
    world.environment.line('Storage other:weather_clear has the following contents: {}', now + 15000, false);
    assert.equal(world.environment.state.weather, 'thunder'); assert.equal(store.events(0).length, 3);
  } finally { store.close(); }
});

test('game ticks produce game clock, smooth dawn/dusk and darker rain/thunder lighting', () => {
  const day = environmentView(environment(6000), 'overworld', now);
  const night = environmentView(environment(18000), 'overworld', now);
  const dawn = environmentView(environment(0), 'overworld', now);
  const dusk = environmentView(environment(13000), 'overworld', now);
  assert.equal(day.timeLabel, '12:00'); assert.equal(night.timeLabel, '00:00'); assert.equal(dawn.timeLabel, '06:00');
  assert.equal(day.phase, 'day'); assert.equal(night.phase, 'night'); assert.equal(dusk.phase, 'dusk'); assert.equal(dawn.phase, 'dawn');
  assert.ok(day.sunlight > dusk.sunlight && dusk.sunlight > night.sunlight);
  const rain = environmentView(environment(6000, 'rain'), 'overworld', now);
  const thunder = environmentView(environment(6000, 'thunder'), 'overworld', now);
  assert.ok(day.sunlight > rain.sunlight && rain.sunlight > thunder.sunlight);
  assert.equal(day.rain, false); assert.equal(rain.rain, true); assert.equal(thunder.weatherLabel, '雷雨');
});

test('interpolation stops after disconnection and never applies overworld weather to the Nether or End', () => {
  const current = environment(23950, 'thunder');
  assert.equal(environmentView(current, 'overworld', now + 5000).ticks, 50);
  const stale = environmentView(current, 'overworld', now + 60000);
  assert.equal(stale.ticks, 150); assert.equal(stale.stale, true); assert.match(stale.label, /待更新/);
  assert.equal(environmentView({ ...current, timeRate: 0 }, 'overworld', now + 5000).ticks, 23950);
  for (const id of ['the_nether', 'the_end']) {
    const view = environmentView(current, id, now);
    assert.equal(view.active, false); assert.equal(view.rain, false); assert.equal(view.weather, null); assert.match(view.label, /无昼夜天气/);
  }
  const unknown = environmentView({ timeOfDay: null, timeObservedAt: null, timeRate: 0, weather: null, weatherObservedAt: null }, 'overworld', now);
  assert.equal(unknown.active, false); assert.equal(unknown.stale, true); assert.match(unknown.label, /等待/);
});
