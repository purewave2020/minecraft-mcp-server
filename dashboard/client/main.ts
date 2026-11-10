import { createApp, watch } from 'vue';
import Panel from './world-panel.vue';
import { connect, state } from './state.js';
import { SandTableLayer } from './bluemap.js';
import { EnvironmentLayer } from './environment-layer.js';
import type { Player } from '../server/types.js';
import './style.css';

const mount = document.createElement('div'); mount.id = 'minecraft-dashboard-root'; document.body.append(mount);
document.body.classList.add('minecraft-dashboard-active');
document.title = '世界沙盘';
let layer: SandTableLayer | null = null;
let environmentLayer: EnvironmentLayer | null = null;
let refreshing = false;
export function selectPlayer(id: string): void {
  if (state.selectedId !== id) stopFollowing();
  state.selectedId = id; localStorage.setItem('minecraft-dashboard-selected', id);
}
export async function focusPlayer(player: Player, follow = false): Promise<void> { state.follow = (await layer?.focus(player, follow)) === true; }
export function stopFollowing(): void { state.follow = false; layer?.stopFollowing(); }
export async function changeMap(id: string): Promise<void> { state.follow = false; await layer?.switchMap(id); }
export function changeCamera(mode: 'top' | 'perspective' | 'in' | 'out'): void { layer?.camera(mode); }
export async function showTrail(player: Player, show: boolean): Promise<void> {
  const points = show ? await fetch('/api/players/' + player.id + '/trail?minutes=15').then(response => response.json()) : [];
  layer?.trail(points, player.dimension);
}
export async function refreshMap(): Promise<void> {
  if (refreshing || !window.bluemap) return;
  refreshing = true;
  try { await window.bluemap.updateMap(); window.bluemap.mapViewer.redraw(); }
  catch { state.error = '地图刷新失败，请稍后重试'; }
  finally { refreshing = false; }
}
window.minecraftDashboard = { selectPlayer, refresh: refreshMap };
createApp(Panel).mount(mount);
void connect(() => { void refreshMap(); });
const engineCheck = setInterval(() => {
  if (!window.bluemap?.popupMarkerSet || !window.BlueMap?.HtmlMarker || !window.bluemap.mapViewer.map) return;
  clearInterval(engineCheck);
  layer = new SandTableLayer(window.bluemap, selectPlayer, id => { state.currentMap = id; }, following => { state.follow = following; });
  environmentLayer = new EnvironmentLayer(window.bluemap);
  watch(() => [state.environment, state.now], () => environmentLayer!.sync(state.environment, state.now), { deep: true, immediate: true });
  document.title = '世界沙盘';
  state.engineReady = true;
  if (!localStorage.getItem('minecraft-dashboard-view-initialized')) {
    layer.camera('perspective'); localStorage.setItem('minecraft-dashboard-view-initialized', 'true');
  }
  const sync = (): void => {
    layer!.sync(state.players, state.chat, state.selectedId, state.now, state.bubbles);
    const player = state.players.find(value => value.id === state.selectedId);
    if (state.follow && player && player.dimension.replace(/^minecraft:/, '') !== state.currentMap) void layer!.focus(player, true);
  };
  watch(() => [state.players, state.chat, state.selectedId, state.now, state.bubbles], sync, { deep: true, immediate: true });
}, 100);
window.addEventListener('beforeunload', () => environmentLayer?.dispose());
