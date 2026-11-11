import type { ChatMessage, Player, Position, Rotation, WorldEntity } from '../server/types.js';
import type * as Three from 'three';
import { EntityLayer } from './entity-layer.js';

export type FollowView = 'first' | 'third';

interface Vector extends Position { set(x: number, y: number, z: number): void }
interface CameraControls {
  data: { followingPlayer: Marker | null };
  start?(manager: CameraManager): void;
  stop?(): void;
  update(delta: number, map: unknown): void;
}
interface FlightControls extends CameraControls {
  onMouseUp(event: MouseEvent): void;
  hammer: { destroy(): void };
}
interface CameraManager {
  position: Vector;
  distance: number;
  rotation: number;
  angle: number;
  tilt: number;
  ortho: number;
  controls: CameraControls | null;
  updateCamera(): void;
}
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
export interface BlueMapColor {
  r: number; g: number; b: number;
  clone(): BlueMapColor;
  setRGB(r: number, g: number, b: number): BlueMapColor;
}
interface MapVisualData {
  id: string;
  skyColor: BlueMapColor;
  voidColor: BlueMapColor;
  ambientLight: number;
  skyLight: number;
}
export interface BlueMapApp {
  popupMarkerSet: MarkerSet;
  events: EventTarget;
  mapViewer: {
    data: { mapState: string; uniforms: {
      sunlightStrength: { value: number }; ambientLight: { value: number };
      skyColor: { value: BlueMapColor }; voidColor: { value: BlueMapColor };
    } };
    map: { data: MapVisualData; hiresTileManager: { scene: Three.Object3D } | null } | null;
    markers: Three.Scene;
    camera: Three.Camera;
    renderer: { domElement: HTMLCanvasElement };
    controlsManager: CameraManager;
    redraw(): void;
    updateLoadedMapArea(): void;
  };
  mapControls: CameraControls & { reset(): void; followPlayerMarker(marker: Marker): void; stopFollowingPlayerMarker(): void };
  freeFlightControls: CameraControls;
  appState: { controls: { state: string } };
  mapsMap: Map<string, unknown>;
  switchMap(id: string, reset?: boolean): Promise<void>;
  updateMap(): Promise<void>;
}
declare global {
  interface Window {
    bluemap?: BlueMapApp;
    BlueMap?: { HtmlMarker: new (id: string) => Marker; MarkerSet: new (id: string) => MarkerSet;
      FreeFlightControls: new (canvas: HTMLCanvasElement) => FlightControls; Three: typeof Three };
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
const markerHeight = 2.3;
const eyeHeight = 1.62;
const thirdPersonDistance = 3.5;
const radians = Math.PI / 180;
interface Entry {
  marker: Marker; target: Position; rotation: Rotation; targetRotation: Rotation | null;
  dimension: string; name: string; bubbles: HTMLElement; speech: HTMLElement; lastChat: string;
}
export class SandTableLayer {
  private readonly layer: MarkerSet;
  private readonly entries = new Map<string, Entry>();
  private readonly trailLayer: MarkerSet;
  private readonly entities: EntityLayer;
  private trailDimension: string | null = null;
  private following: string | null = null;
  private followView: FollowView = 'first';
  private readonly followEye = new window.BlueMap!.Three.Vector3();
  private readonly followDirection = new window.BlueMap!.Three.Vector3();
  private readonly followRay = new window.BlueMap!.Three.Raycaster();
  private readonly followHits: Three.Intersection[] = [];
  private focusGeneration = 0;
  private playerViewControls: CameraControls | null = null;
  private flightControls: FlightControls | null = null;
  private selected: string | null = null;
  private bubblesEnabled = true;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  constructor(readonly app: BlueMapApp, readonly onSelect: (id: string) => void, readonly onMap: (id: string) => void, readonly onFollow: (following: boolean) => void) {
    const { MarkerSet } = window.BlueMap!;
    this.entities = new EntityLayer(app, playerColor);
    this.layer = new MarkerSet('dashboard-players'); this.layer.data.toggleable = false;
    this.trailLayer = new MarkerSet('dashboard-trail'); this.trailLayer.data.toggleable = false;
    // v5.29's normal marker manager preserves this parent through polling and map changes.
    app.popupMarkerSet.add(this.layer); app.popupMarkerSet.add(this.trailLayer);
    app.events.addEventListener('bluemapRenderFrame', event => this.frame((event as CustomEvent<{ delta: number }>).detail.delta));
    app.events.addEventListener('bluemapMapChanged', () => { onMap(this.mapId()); this.visibility(); });
    const canvas = app.mapViewer.renderer.domElement;
    let drag: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', event => { drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; });
    window.addEventListener('pointermove', event => {
      if (this.following && drag?.id === event.pointerId && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) this.stopFollowing();
    });
    const endDrag = (): void => { drag = null; };
    window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', () => { if (this.following) this.stopFollowing(); }, { passive: true });
    window.addEventListener('keydown', event => {
      const target = event.target;
      if (event.ctrlKey || event.metaKey || (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select')))) return;
      if (this.following && /^(Key[WASD]|Arrow(Up|Down|Left|Right)|Page(Up|Down)|Delete|End|Insert|Home|Numpad(Add|Subtract))$/.test(event.code)) this.stopFollowing();
    }, { capture: true });
    onMap(this.mapId());
  }
  mapId(): string { return this.app.mapViewer.map?.data.id ?? 'overworld'; }
  sync(players: Player[], chat: ChatMessage[], selected: string | null, now: number, bubblesEnabled: boolean, entities: WorldEntity[] = []): void {
    this.selected = selected; this.bubblesEnabled = bubblesEnabled;
    this.entities.sync(players, entities, now);
    const visible = new Set<string>();
    for (const player of players) {
      if (!player.online || !player.position) continue;
      visible.add(player.id);
      let entry = this.entries.get(player.id);
      if (!entry) {
        const marker = new window.BlueMap!.HtmlMarker('dashboard-' + player.id);
        marker.updateFromData({ position: { ...player.position, y: player.position.y + markerHeight }, label: player.name, html: '', classes: ['dashboard-marker'], listed: false });
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
        entry = { marker, target: player.position, rotation: { ...(player.rotation ?? { yaw: 0, pitch: 0 }) }, targetRotation: player.rotation ?? null,
          dimension: player.dimension, name: player.name, bubbles, speech, lastChat: '' };
        this.entries.set(player.id, entry);
      }
      const next = { ...player.position, y: player.position.y + markerHeight };
      const distance = Math.hypot(next.x - entry.marker.position.x, next.y - entry.marker.position.y, next.z - entry.marker.position.z);
      if (entry.dimension !== player.dimension || distance > 80 || this.reducedMotion) {
        entry.marker.position.set(next.x, next.y, next.z);
        if (player.rotation) entry.rotation = { ...player.rotation };
      }
      entry.targetRotation = player.rotation ?? null;
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
    for (const [playerId, entry] of this.entries) entry.marker.visible = playerId !== this.following && entry.dimension.replace(/^minecraft:/, '') === id;
    this.trailLayer.visible = this.trailDimension?.replace(/^minecraft:/, '') === id;
  }
  private frame(delta: number): void {
    if (this.following && (!this.app.mapControls.data.followingPlayer || this.app.mapViewer.controlsManager.controls !== this.playerViewControls)) this.stopFollowing();
    let moving = false;
    for (const entry of this.entries.values()) {
      const pos = entry.marker.position;
      const factor = this.reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 100) / 240);
      const distance = Math.hypot(pos.x - entry.target.x, pos.y - entry.target.y, pos.z - entry.target.z);
      if (distance > 0.015) { pos.set(pos.x + (entry.target.x - pos.x) * factor, pos.y + (entry.target.y - pos.y) * factor, pos.z + (entry.target.z - pos.z) * factor); moving = true; }
      if (entry.targetRotation) {
        const yawDelta = (entry.targetRotation.yaw - entry.rotation.yaw) * radians;
        // Turn across +/-180 using the shorter arc, including when a player spins several times.
        const yaw = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta)) / radians;
        const pitch = entry.targetRotation.pitch - entry.rotation.pitch;
        if (Math.abs(yaw) > 0.01 || Math.abs(pitch) > 0.01) {
          entry.rotation.yaw += yaw * factor; entry.rotation.pitch += pitch * factor; moving = true;
        }
      }
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
    if (this.following) this.updatePlayerView();
    this.entities.frame(delta, this.followView === 'first' ? this.following : null);
    if (moving) this.app.mapViewer.redraw();
  }
  private updatePlayerView(): void {
    const entry = this.entries.get(this.following ?? '');
    if (!entry || entry.dimension.replace(/^minecraft:/, '') !== this.mapId()) return;
    const cm = this.app.mapViewer.controlsManager;
    const pos = entry.marker.position;
    this.followEye.set(pos.x, pos.y - markerHeight + eyeHeight, pos.z);
    const pitch = this.followView === 'third' ? Math.max(-25, Math.min(65, entry.rotation.pitch + 12)) : entry.rotation.pitch;
    const yaw = entry.rotation.yaw * radians;
    this.followDirection.set(-Math.sin(yaw) * Math.cos(pitch * radians), -Math.sin(pitch * radians), Math.cos(yaw) * Math.cos(pitch * radians));
    let distance = this.followView === 'third' ? thirdPersonDistance : 0;
    const terrain = this.app.mapViewer.map?.hiresTileManager?.scene;
    if (distance && terrain) {
      // BlueMap shifts terrain for rendering at large coordinates. Restore world
      // coordinates before checking the short segment behind the player's eyes.
      terrain.position.x = 0; terrain.position.z = 0; terrain.updateMatrixWorld();
      this.followRay.set(this.followEye, this.followDirection); this.followRay.ray.direction.negate();
      this.followRay.near = 0; this.followRay.far = distance; this.followRay.layers.enableAll();
      this.followHits.length = 0; this.followRay.intersectObject(terrain, true, this.followHits);
      if (this.followHits.length) distance = Math.max(0, this.followHits[0].distance - 0.18);
    }
    cm.position.set(this.followEye.x - this.followDirection.x * distance, this.followEye.y - this.followDirection.y * distance, this.followEye.z - this.followDirection.z * distance);
    cm.distance = 0; cm.ortho = 0; cm.tilt = 0;
    cm.rotation = (entry.rotation.yaw - 180) * radians;
    cm.angle = (90 - pitch) * radians;
    cm.updateCamera();
  }
  setFollowView(view: FollowView): void {
    this.followView = view;
    if (this.following) this.updatePlayerView();
    this.entities.frame(0, view === 'first' ? this.following : null);
    this.app.mapViewer.redraw();
  }
  async focus(player: Player, follow = false): Promise<boolean> {
    const generation = ++this.focusGeneration;
    if (!player.online || !player.position) { this.stopFollowing(); return false; }
    const mapId = player.dimension.replace(/^minecraft:/, '');
    if (!this.app.mapsMap.has(mapId)) { this.stopFollowing(); return false; }
    if (this.mapId() !== mapId) await this.app.switchMap(mapId, false);
    if (generation !== this.focusGeneration) return false;
    const entry = this.entries.get(player.id);
    const cm = this.app.mapViewer.controlsManager;
    this.stopFollowing();
    if (follow && entry) {
      const previous = this.flightControls;
      if (previous) {
        if (cm.controls === previous) cm.controls = null;
        previous.hammer.destroy();
      }
      const controls = new window.BlueMap!.FreeFlightControls(this.app.mapViewer.renderer.domElement);
      // The dashboard uses ordinary mouse/touch input without native fullscreen/pointer lock.
      controls.onMouseUp = () => {};
      this.flightControls = controls;
      this.app.freeFlightControls = controls;
      this.app.appState.controls.state = 'free';
      // Keep free-flight input active while the follow camera owns its updates. Ending
      // follow hands the same inputs the existing pose, including during a drag.
      this.playerViewControls = { data: this.app.mapControls.data,
        start: manager => controls?.start?.(manager), stop: () => controls?.stop?.(), update: () => this.updatePlayerView() };
      cm.controls = this.playerViewControls;
      this.app.mapControls.reset();
      this.following = player.id;
      entry.marker.position.set(player.position.x, player.position.y + markerHeight, player.position.z);
      if (player.rotation) entry.rotation = { ...player.rotation };
      this.app.mapControls.followPlayerMarker(entry.marker);
      this.updatePlayerView();
    } else {
      this.useMapControls();
      cm.position.set(player.position.x, player.position.y, player.position.z); cm.distance = 110; cm.angle = Math.PI / 4; cm.ortho = 0; cm.updateCamera();
    }
    this.visibility(); this.app.mapViewer.updateLoadedMapArea();
    this.entities.frame(0, this.followView === 'first' ? this.following : null);
    this.onFollow(!!(follow && entry));
    this.app.mapViewer.redraw();
    return !!(follow && entry);
  }
  stopFollowing(): void {
    this.focusGeneration++;
    this.following = null;
    const cm = this.app.mapViewer.controlsManager;
    if (this.playerViewControls && cm.controls === this.playerViewControls) cm.controls = this.app.freeFlightControls;
    this.playerViewControls = null;
    this.app.mapControls.stopFollowingPlayerMarker(); this.onFollow(false); this.visibility(); this.app.mapViewer.redraw();
    this.entities.frame(0, null);
  }
  private useMapControls(): void {
    const cm = this.app.mapViewer.controlsManager;
    if (cm.controls !== this.app.mapControls) {
      cm.controls = this.app.mapControls;
      this.app.mapControls.reset();
    }
    this.app.appState.controls.state = cm.ortho === 1 ? 'flat' : 'perspective';
  }
  dispose(): void { this.flightControls?.stop?.(); this.flightControls?.hammer.destroy(); this.entities.dispose(); }
  async switchMap(id: string): Promise<void> {
    this.stopFollowing();
    if (this.app.mapsMap.has(id)) await this.app.switchMap(id);
    else location.assign('/map/#' + id);
  }
  camera(mode: 'top' | 'perspective' | 'in' | 'out'): void {
    this.stopFollowing();
    const cm = this.app.mapViewer.controlsManager;
    this.useMapControls();
    if (cm.distance < 15) cm.distance = 110;
    if (mode === 'top') { cm.angle = 0; cm.ortho = 1; }
    else if (mode === 'perspective') { cm.angle = Math.PI / 4; cm.ortho = 0; }
    else cm.distance = Math.min(6000, Math.max(15, cm.distance * (mode === 'in' ? 0.7 : 1.4)));
    this.app.appState.controls.state = cm.ortho === 1 ? 'flat' : 'perspective';
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
