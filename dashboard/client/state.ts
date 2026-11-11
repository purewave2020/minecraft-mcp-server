import { reactive } from 'vue';
import type { BackgroundSpeechStatus, ChatMessage, EnvironmentState, MapState, Player, WorldEntity } from '../server/types.js';
import { applySpeechStatus } from './chat-speech.js';
import type { FollowView } from './bluemap.js';
export interface Activity { id: string; kind: string; text: string; timestamp: number }
export const state = reactive({
  players: [] as Player[], chat: [] as ChatMessage[], activity: [] as Activity[],
  entities: [] as WorldEntity[], entitiesAt: 0,
  collector: { connected: false, observedAt: 0, error: null as string | null, parseErrors: 0 },
  metrics: null as Record<string, unknown> | null,
  map: { available: false, syncing: false, snapshotAt: null, syncedAt: null, renderedAt: null, progress: '正在连接世界', error: null, maps: [] } as MapState,
  environment: { timeOfDay: null, timeRate: 0, timeObservedAt: null, weather: null, weatherObservedAt: null } as EnvironmentState,
  streamConnected: false, engineReady: false, currentMap: 'overworld',
  selectedId: localStorage.getItem('minecraft-dashboard-selected'), follow: false,
  followView: (localStorage.getItem('minecraft-dashboard-follow-view') === 'third' ? 'third' : 'first') as FollowView,
  bubbles: localStorage.getItem('minecraft-dashboard-bubbles') !== 'false',
  now: Date.now(), error: null as string | null
});
let source: EventSource | null = null;
let connected = false;
let serverOffset = 0;
const seen = new Set<string>();
function applySnapshot(data: Record<string, unknown>): void {
  state.players = data.players as Player[];
  state.entities = (data.entities ?? []) as WorldEntity[]; state.entitiesAt = typeof data.now === 'number' ? data.now : 0;
  state.chat = data.chat as ChatMessage[];
  state.activity = data.activity as Activity[];
  state.collector = data.collector as typeof state.collector;
  state.metrics = data.metrics as typeof state.metrics;
  state.map = data.map as MapState;
  if (typeof data.now === 'number') { serverOffset = data.now - Date.now(); state.now = data.now; }
  if (data.environment) state.environment = data.environment as EnvironmentState;
  for (const message of state.chat) seen.add(message.id);
  if (data.speech) applySpeechStatus(data.speech as BackgroundSpeechStatus);
}
export async function connect(onMapUpdate: () => void): Promise<void> {
  try {
    const response = await fetch('/api/snapshot');
    if (!response.ok) throw new Error('无法读取面板数据');
    const snapshot = await response.json(); applySnapshot(snapshot);
    source?.close(); source = new EventSource('/api/events?after=' + snapshot.cursor);
    source.onopen = () => { state.streamConnected = true; state.error = null; connected = true; };
    source.onerror = () => { state.streamConnected = false; state.error = '实时连接中断，正在自动重连'; };
    const listen = <T>(type: string, action: (value: T) => void): void => source!.addEventListener(type, event => {
      try { action(JSON.parse((event as MessageEvent).data) as T); } catch { state.error = '收到无效的数据事件'; }
    });
    listen('player.update', (player: Player) => {
      const at = state.players.findIndex(value => value.id === player.id);
      if (at === -1) state.players.push(player); else state.players[at] = player;
    });
    listen('world.entities', (value: { entities: WorldEntity[]; observedAt: number }) => {
      if (value.observedAt < state.entitiesAt) return;
      state.entities = value.entities; state.entitiesAt = value.observedAt;
    });
    listen('chat.message', (message: ChatMessage) => {
      if (seen.has(message.id)) return; seen.add(message.id);
      state.chat.push(message); if (state.chat.length > 300) state.chat.shift();
      if (seen.size > 3000) { seen.clear(); for (const item of state.chat) seen.add(item.id); }
    });
    listen('world.event', (event: Activity) => { state.activity.push(event); if (state.activity.length > 60) state.activity.shift(); });
    listen('collector.status', (value: typeof state.collector) => { state.collector = value; });
    listen('speech.status', applySpeechStatus);
    listen('world.environment', (value: EnvironmentState) => {
      // Replayed SSE updates must not replace a newer snapshot's time or weather.
      if ((value.timeObservedAt ?? 0) >= (state.environment.timeObservedAt ?? 0)
          && (value.weatherObservedAt ?? 0) >= (state.environment.weatherObservedAt ?? 0)) state.environment = value;
    });
    listen('server.metrics', (value: typeof state.metrics) => { state.metrics = value; });
    listen('map.status', (value: MapState) => {
      const wasAvailable = state.map.available; state.map = value;
      if (!wasAvailable && value.available && !window.bluemap) location.reload();
      if (value.available && !value.syncing && window.bluemap?.mapViewer.map && value.maps.some(map => !window.bluemap!.mapsMap.has(map.id))) location.reload();
    });
    listen('map.updated', () => onMapUpdate());
    listen('snapshot', (value: Record<string, unknown>) => {
      const previousRender = state.map.renderedAt;
      applySnapshot(value);
      if (previousRender !== state.map.renderedAt) onMapUpdate();
    });
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    setTimeout(() => void connect(onMapUpdate), 3000);
  }
}
setInterval(() => {
  state.now = Date.now() + serverOffset;
  if (connected && state.collector.connected && state.now - state.collector.observedAt > 20_000) state.collector.connected = false;
}, 1000);
window.addEventListener('beforeunload', () => source?.close());
