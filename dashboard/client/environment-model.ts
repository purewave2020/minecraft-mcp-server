import type { EnvironmentState } from '../server/types.js';

type Color = [number, number, number];
export type DayPhase = 'day' | 'dusk' | 'night' | 'dawn' | 'unknown';
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const blend = (a: Color, b: Color, amount: number): Color => a.map((value, index) => value + (b[index] - value) * amount) as Color;
const smooth = (value: number): number => { const t = clamp(value); return t * t * (3 - 2 * t); };

export function environmentView(environment: EnvironmentState, mapId: string, now: number) {
  const overworld = mapId === 'overworld';
  const timeKnown = environment.timeOfDay !== null && environment.timeObservedAt !== null;
  const elapsed = timeKnown ? Math.max(0, now - environment.timeObservedAt!) : 0;
  // Hold the last verified state after a disconnect rather than running an invented day cycle.
  const ticks = timeKnown ? (environment.timeOfDay! + Math.min(elapsed, 10_000) / 1000 * environment.timeRate) % 24000 : null;
  let phase: DayPhase = 'unknown'; let daylight = 1;
  if (ticks !== null) {
    if (ticks >= 23000 || ticks < 1000) { phase = 'dawn'; daylight = smooth(((ticks + 1000) % 24000) / 2000); }
    else if (ticks < 12000) { phase = 'day'; daylight = 1; }
    else if (ticks < 14000) { phase = 'dusk'; daylight = 1 - smooth((ticks - 12000) / 2000); }
    else { phase = 'night'; daylight = 0; }
  }
  const timeLabel = ticks === null ? '等待游戏时间' : (() => {
    const minutes = Math.floor((ticks / 1000 * 60 + 360) % 1440);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  })();
  const phaseLabel = { day: '白昼', dusk: '黄昏', night: '夜晚', dawn: '黎明', unknown: '等待环境' }[phase];
  const weather = overworld ? environment.weather : null;
  const storm = weather === 'thunder' ? 1 : weather === 'rain' ? 0.55 : 0;
  let sky = blend([0.055, 0.085, 0.16], [0.54, 0.69, 0.86], daylight);
  const twilight = phase === 'dawn' || phase === 'dusk' ? 1 - Math.abs(daylight * 2 - 1) : 0;
  sky = blend(sky, [0.8, 0.45, 0.31], twilight * 0.65 * (1 - storm));
  sky = blend(sky, [0.27, 0.31, 0.37], storm * 0.65);
  const stale = !timeKnown || elapsed > 15_000 || environment.weatherObservedAt === null || now - environment.weatherObservedAt > 15_000;
  const weatherLabel = weather === 'thunder' ? '雷雨' : weather === 'rain' ? '下雨' : weather === 'clear' ? '晴' : '天气待更新';
  const label = overworld ? `${phaseLabel} ${timeLabel} · ${weatherLabel}${stale ? ' · 待更新' : ''}` : mapId === 'the_nether' ? '下界 · 无昼夜天气' : '末地 · 无昼夜天气';
  return {
    ticks, phase, timeLabel, phaseLabel, weather, weatherLabel, stale, label,
    active: overworld && timeKnown,
    sunlight: (0.14 + daylight * 0.86) * (1 - storm * 0.45),
    ambient: 0.16 + daylight * 0.09,
    sky, voidColor: blend([0.025, 0.04, 0.07], [0.13, 0.19, 0.23], daylight),
    rain: overworld && (weather === 'rain' || weather === 'thunder'), storm
  };
}
