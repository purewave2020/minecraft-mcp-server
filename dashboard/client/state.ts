import { reactive } from 'vue';
import type { ChatMessage, MapState, Player } from '../server/types.js';
export interface Activity { id: string; kind: string; text: string; timestamp: number }
export const state = reactive({
  players: [] as Player[], chat: [] as ChatMessage[], activity: [] as Activity[],
  collector: { connected: false, observedAt: 0, error: null as string | null, parseErrors: 0 },
  metrics: null as Record<string, unknown> | null,
  map: { available: false, syncing: false, snapshotAt: null, syncedAt: null, renderedAt: null, progress: '正在连接世界', error: null, maps: [] } as MapState,
  streamConnected: false, engineReady: false, currentMap: 'overworld',
  selectedId: localStorage.getItem('minecraft-dashboard-selected'), follow: false,
  bubbles: localStorage.getItem('minecraft-dashboard-bubbles') !== 'false',
  now: Date.now(), error: null as string | null
});
let source: EventSource | null = null;
let connected = false;
const seen = new Set<string>();
function applySnapshot(data: Record<string, unknown>): void {
  state.players = data.players as Player[];
  state.chat = data.chat as ChatMessage[];
  state.activity = data.activity as Activity[];
  state.collector = data.collector as typeof state.collector;
  state.metrics = data.metrics as typeof state.metrics;
  state.map = data.map as MapState;
  for (const message of state.chat) seen.add(message.id);
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
    listen('chat.message', (message: ChatMessage) => {
      if (seen.has(message.id)) return; seen.add(message.id);
      state.chat.push(message); if (state.chat.length > 300) state.chat.shift();
      if (seen.size > 3000) { seen.clear(); for (const item of state.chat) seen.add(item.id); }
    });
    listen('world.event', (event: Activity) => { state.activity.push(event); if (state.activity.length > 60) state.activity.shift(); });
    listen('collector.status', (value: typeof state.collector) => { state.collector = value; });
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
  state.now = Date.now();
  if (connected && state.collector.connected && state.now - state.collector.observedAt > 20_000) state.collector.connected = false;
}, 1000);
window.addEventListener('beforeunload', () => source?.close());
