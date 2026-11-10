import type { ChatMessage, Player, Position } from '../server/types.js';

interface Vector extends Position { set(x: number, y: number, z: number): void }
interface Marker {
  position: Vector;
  visible: boolean;
  element: HTMLElement;
  data: Record<string, unknown>;
  onClick: () => boolean;
  updateFromData(data: Record<string, unknown>): void;
}
interface MarkerSet {
  visible: boolean;
  data: Record<string, unknown>;
  add(object: Marker | MarkerSet): void;
  remove(object: Marker | MarkerSet): void;
  clear(): void;
}
export interface BlueMapApp {
  popupMarkerSet: MarkerSet;
  events: EventTarget;
  mapViewer: {
    data: { mapState: string };
    map: { data: { id: string } } | null;
    controlsManager: { position: Vector; distance: number; angle: number; ortho: number; updateCamera(): void };
    redraw(): void;
    updateLoadedMapArea(): void;
  };
  mapControls: { data: { followingPlayer: Marker | null }; followPlayerMarker(marker: Marker): void; stopFollowingPlayerMarker(): void };
  mapsMap: Map<string, unknown>;
  switchMap(id: string, reset?: boolean): Promise<void>;
  updateMap(): Promise<void>;
}
declare global {
  interface Window {
    bluemap?: BlueMapApp;
    BlueMap?: { HtmlMarker: new (id: string) => Marker; MarkerSet: new (id: string) => MarkerSet };
    minecraftDashboard?: { selectPlayer(id: string): void; refresh(): Promise<void> };
  }
}

const palette = ['#8ce0ce', '#f2bf78', '#a6bfff', '#d6b2ed', '#8ccbe6', '#c6d99a'];
export function playerColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}
const avatars = new Map<string, string>();
export function avatar(name: string): string {
  if (avatars.has(name)) return avatars.get(name)!;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = playerColor(name); ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#243b3b'; ctx.fillRect(0, 0, 16, 4); ctx.fillRect(0, 3, 3, 6); ctx.fillRect(13, 3, 3, 6);
  ctx.fillStyle = '#f3d6b4'; ctx.fillRect(3, 5, 10, 9);
  ctx.fillStyle = '#263637'; ctx.fillRect(4, 7, 2, 2); ctx.fillRect(10, 7, 2, 2); ctx.fillRect(6, 11, 4, 1);
  const data = canvas.toDataURL(); avatars.set(name, data); return data;
}
interface Entry { marker: Marker; target: Position; dimension: string; name: string; bubbles: HTMLElement; speech: HTMLElement; lastChat: string }
export class SandTableLayer {
  private readonly layer: MarkerSet;
  private readonly entries = new Map<string, Entry>();
  private readonly trailLayer: MarkerSet;
  private trailDimension: string | null = null;
  private following: string | null = null;
  private selected: string | null = null;
  private bubblesEnabled = true;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  constructor(readonly app: BlueMapApp, readonly onSelect: (id: string) => void, readonly onMap: (id: string) => void, readonly onFollow: (following: boolean) => void) {
    const { MarkerSet } = window.BlueMap!;
    this.layer = new MarkerSet('dashboard-players'); this.layer.data.toggleable = false;
    this.trailLayer = new MarkerSet('dashboard-trail'); this.trailLayer.data.toggleable = false;
    // v5.29's normal marker manager preserves this parent through polling and map changes.
    app.popupMarkerSet.add(this.layer); app.popupMarkerSet.add(this.trailLayer);
    app.events.addEventListener('bluemapRenderFrame', event => this.frame((event as CustomEvent<{ delta: number }>).detail.delta));
    app.events.addEventListener('bluemapMapChanged', () => { onMap(this.mapId()); this.visibility(); });
    onMap(this.mapId());
  }
  mapId(): string { return this.app.mapViewer.map?.data.id ?? 'overworld'; }
  sync(players: Player[], chat: ChatMessage[], selected: string | null, now: number, bubblesEnabled: boolean): void {
    this.selected = selected; this.bubblesEnabled = bubblesEnabled;
    const visible = new Set<string>();
    for (const player of players) {
      if (!player.online || !player.position) continue;
      visible.add(player.id);
      let entry = this.entries.get(player.id);
      if (!entry) {
        const marker = new window.BlueMap!.HtmlMarker('dashboard-' + player.id);
        marker.updateFromData({ position: { ...player.position, y: player.position.y + 2.3 }, label: player.name, html: '', classes: ['dashboard-marker'], listed: false });
        const bubbles = document.createElement('div'); bubbles.className = 'md-bubbles'; bubbles.setAttribute('aria-live', 'polite');
        const label = document.createElement('button'); label.type = 'button'; label.className = 'md-player-label'; label.setAttribute('aria-label', '查看玩家 ' + player.name);
        const image = document.createElement('img'); image.src = avatar(player.name); image.alt = ''; image.className = 'md-pixel-avatar';
        const name = document.createElement('span'); name.textContent = player.name;
        const speech = document.createElement('span'); speech.textContent = '•••'; speech.className = 'md-speaking';
        const health = document.createElement('span'); health.className = 'md-marker-health';
        label.append(image, name, speech, health); marker.element.append(bubbles, label);
        marker.element.style.setProperty('--player-color', playerColor(player.name));
        marker.onClick = () => { this.onSelect(player.id); return true; };
        label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.onSelect(player.id); } });
        this.layer.add(marker);
        entry = { marker, target: player.position, dimension: player.dimension, name: player.name, bubbles, speech, lastChat: '' };
        this.entries.set(player.id, entry);
      }
      const next = { ...player.position, y: player.position.y + 2.3 };
      const distance = Math.hypot(next.x - entry.marker.position.x, next.y - entry.marker.position.y, next.z - entry.marker.position.z);
      if (entry.dimension !== player.dimension || distance > 80 || this.reducedMotion) entry.marker.position.set(next.x, next.y, next.z);
      entry.target = next; entry.dimension = player.dimension;
      entry.marker.element.classList.toggle('is-selected', player.id === selected);
      entry.marker.element.classList.toggle('is-stale', !player.positionAt || now - player.positionAt > 15_000);
      entry.marker.element.querySelector('.md-marker-health')!.textContent = player.health === null ? '' : '♥ ' + Math.ceil(player.health);
      const messages = chat.filter(message => message.playerId === player.id && !message.historical && message.expiresAt > now).slice(-3);
      const signature = messages.map(message => message.id).join(',') + ':' + bubblesEnabled;
      if (entry.lastChat !== signature) {
        entry.bubbles.replaceChildren(); entry.lastChat = signature;
        for (const message of messages) {
          const bubble = document.createElement('div'); bubble.className = 'md-chat-bubble'; bubble.textContent = message.content;
          bubble.title = player.name + ': ' + message.content; entry.bubbles.append(bubble);
        }
      }
      entry.speech.hidden = !messages.length;
    }
    for (const [id, entry] of this.entries) if (!visible.has(id)) {
      if (id === this.following) this.stopFollowing();
      this.layer.remove(entry.marker); this.entries.delete(id);
    }
    this.visibility(); this.app.mapViewer.redraw();
  }
  private visibility(): void {
    const id = this.mapId();
    for (const entry of this.entries.values()) entry.marker.visible = entry.dimension.replace(/^minecraft:/, '') === id;
    this.trailLayer.visible = this.trailDimension?.replace(/^minecraft:/, '') === id;
  }
  private frame(delta: number): void {
    if (this.following && !this.app.mapControls.data.followingPlayer) { this.following = null; this.onFollow(false); }
    let moving = false;
    for (const entry of this.entries.values()) {
      const pos = entry.marker.position;
      const factor = this.reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 100) / 240);
      const distance = Math.hypot(pos.x - entry.target.x, pos.y - entry.target.y, pos.z - entry.target.z);
      if (distance > 0.015) { pos.set(pos.x + (entry.target.x - pos.x) * factor, pos.y + (entry.target.y - pos.y) * factor, pos.z + (entry.target.z - pos.z) * factor); moving = true; }
      entry.bubbles.hidden = !this.bubblesEnabled || (this.app.mapViewer.controlsManager.distance > 700 && entry.name !== this.entries.get(this.selected ?? '')?.name);
    }
    // Keep the selected player's speech readable when several players share one screen position.
    const rects: DOMRect[] = [];
    const ordered = [...this.entries.entries()].sort(([a], [b]) => Number(b === this.selected) - Number(a === this.selected));
    for (const [, entry] of ordered) {
      entry.bubbles.style.visibility = 'visible';
      if (!entry.marker.visible || entry.bubbles.hidden || !entry.bubbles.childElementCount) continue;
      const rect = entry.bubbles.getBoundingClientRect();
      const collides = rects.some(other => rect.left < other.right + 8 && rect.right > other.left - 8 && rect.top < other.bottom + 8 && rect.bottom > other.top - 8);
      if (collides) entry.bubbles.style.visibility = 'hidden'; else rects.push(rect);
    }
    if (moving) this.app.mapViewer.redraw();
  }
  async focus(player: Player, follow = false): Promise<boolean> {
    if (!player.position) return false;
    const mapId = player.dimension.replace(/^minecraft:/, '');
    if (!this.app.mapsMap.has(mapId)) return false;
    if (this.mapId() !== mapId) await this.app.switchMap(mapId, false);
    const cm = this.app.mapViewer.controlsManager;
    cm.position.set(player.position.x, player.position.y, player.position.z); cm.distance = 110; cm.angle = Math.PI / 4; cm.ortho = 0; cm.updateCamera();
    this.app.mapViewer.updateLoadedMapArea();
    const entry = this.entries.get(player.id);
    if (follow && entry) { this.following = player.id; this.app.mapControls.followPlayerMarker(entry.marker); }
    else { this.following = null; this.app.mapControls.stopFollowingPlayerMarker(); }
    this.onFollow(!!(follow && entry));
    this.app.mapViewer.redraw();
    return !!(follow && entry);
  }
  stopFollowing(): void { this.following = null; this.app.mapControls.stopFollowingPlayerMarker(); this.onFollow(false); }
  async switchMap(id: string): Promise<void> {
    this.stopFollowing();
    if (this.app.mapsMap.has(id)) await this.app.switchMap(id);
    else location.assign('/map/#' + id);
  }
  camera(mode: 'top' | 'perspective' | 'in' | 'out'): void {
    const cm = this.app.mapViewer.controlsManager;
    if (mode === 'top') { cm.angle = 0; cm.ortho = 1; }
    else if (mode === 'perspective') { cm.angle = Math.PI / 4; cm.ortho = 0; }
    else cm.distance = Math.min(6000, Math.max(15, cm.distance * (mode === 'in' ? 0.7 : 1.4)));
    cm.updateCamera(); this.app.mapViewer.updateLoadedMapArea(); this.app.mapViewer.redraw();
  }
  trail(points: Array<Position & { dimension: string }>, dimension: string): void {
    this.trailLayer.clear();
    this.trailDimension = dimension;
    // Sparse world-coordinate dots preserve the correct height, including underground paths.
    const filtered = points.filter(point => point.dimension === dimension);
    const step = Math.max(1, Math.ceil(filtered.length / 160));
    for (let i = 0; i < filtered.length; i += step) {
      const point = filtered[i];
      const marker = new window.BlueMap!.HtmlMarker('trail-' + i);
      marker.updateFromData({ position: { ...point, y: point.y + 0.2 }, html: '<span class="md-trail-dot"></span>', classes: ['md-trail'], listed: false, label: '' });
      this.trailLayer.add(marker);
    }
    this.visibility(); this.app.mapViewer.redraw();
  }
}
