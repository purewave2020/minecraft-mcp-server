import type * as Three from 'three';
import type { BlueMapApp } from './bluemap.js';
import type { Player, Position, Rotation, WorldEntity } from '../server/types.js';
import { EntityModels, type EntityModel } from './entity-models.js';

interface Entry {
  model: EntityModel; signature: string; target: Position; rotation: Rotation;
  dimension: string; observedAt: number; player: boolean; phase: number;
}
const radians = Math.PI / 180;
function armorColor(name: string): string | null {
  for (const [material, color] of Object.entries({ netherite: '#494349', diamond: '#70d3ce', iron: '#c8d1d1', golden: '#ddbd50', chainmail: '#8a969c', leather: '#855b3a', turtle: '#55895f' })) {
    if (name.startsWith(material + '_')) return color;
  }
  return null;
}
export class EntityLayer {
  private readonly root: Three.Group;
  private readonly models: EntityModels;
  private readonly cameraPosition: Three.Vector3;
  private readonly playerBounds: Three.Box3;
  private readonly entries = new Map<string, Entry>();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private offset = 0;
  constructor(readonly app: BlueMapApp, readonly playerColor: (name: string) => string) {
    const three = window.BlueMap!.Three;
    this.cameraPosition = new three.Vector3(); this.playerBounds = new three.Box3();
    this.root = new three.Group(); this.root.name = 'dashboard-entities'; this.root.visible = false;
    app.mapViewer.markers.add(this.root); this.models = new EntityModels(three);
  }
  sync(players: Player[], entities: WorldEntity[], now: number): void {
    this.offset = now - Date.now();
    const seen = new Set<string>();
    const upsert = (id: string, type: string, position: Position, rotation: Rotation | null, dimension: string, observedAt: number,
      options: Parameters<EntityModels['build']>[1], baby: boolean, player: boolean): void => {
      seen.add(id); const signature = JSON.stringify([type, options, baby]);
      let entry = this.entries.get(id);
      if (entry?.signature !== signature) {
        if (entry) this.root.remove(entry.model.root);
        const model = this.models.build(type, options); const scale = model.root.scale.x * (baby ? 0.5 : 1); model.root.scale.setScalar(scale);
        model.root.name = 'dashboard-entity:' + id; model.root.userData = { ...model.root.userData, entityId: id, dimension, player };
        model.root.position.set(position.x, position.y, position.z);
        model.root.rotation.y = -(rotation?.yaw ?? 0) * radians;
        entry = { model, signature, target: position, rotation: rotation ?? { yaw: 0, pitch: 0 }, dimension, observedAt, player, phase: 0 };
        this.root.add(model.root); this.entries.set(id, entry);
      }
      const pos = entry.model.root.position;
      if (entry.dimension !== dimension || Math.hypot(pos.x - position.x, pos.y - position.y, pos.z - position.z) > 80 || this.reducedMotion) pos.set(position.x, position.y, position.z);
      entry.target = position; entry.rotation = rotation ?? entry.rotation; entry.dimension = dimension; entry.observedAt = observedAt;
      entry.model.root.userData.dimension = dimension;
    };
    for (const player of players) {
      if (!player.online || !player.position) continue;
      const armor: Record<string, string> = {};
      for (const [slot, item] of Object.entries(player.equipment)) {
        const color = item && armorColor(item.name); if (color) armor[slot] = color;
      }
      upsert(player.id, 'player', player.position, player.rotation, player.dimension, player.positionAt ?? 0,
        { shirt: this.playerColor(player.name), armor }, false, true);
    }
    for (const entity of entities) upsert(entity.id, entity.type, entity.position, entity.rotation, entity.dimension, entity.observedAt,
      { color: entity.color, sheared: entity.sheared }, entity.baby, false);
    for (const [id, entry] of this.entries) if (!seen.has(id)) { this.root.remove(entry.model.root); this.entries.delete(id); }
    this.app.mapViewer.redraw();
  }
  frame(delta: number, hiddenPlayer: string | null): void {
    const viewer = this.app.mapViewer; this.root.visible = viewer.data.mapState === 'loaded';
    const mapId = viewer.map?.data.id; const now = Date.now() + this.offset;
    viewer.camera.getWorldPosition(this.cameraPosition);
    const factor = this.reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 100) / 240);
    let moving = false;
    this.models.light(Math.max(0.32, Math.min(1, viewer.data.uniforms.ambientLight.value + viewer.data.uniforms.sunlightStrength.value * 0.7)));
    for (const [id, entry] of this.entries) {
      const { root, head, limbs } = entry.model; const position = root.position;
      const dx = entry.target.x - position.x; const dy = entry.target.y - position.y; const dz = entry.target.z - position.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > 0.015) { position.set(position.x + dx * factor, position.y + dy * factor, position.z + dz * factor); moving = true; }
      const yaw = -entry.rotation.yaw * radians - root.rotation.y;
      const turn = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      if (Math.abs(turn) > 0.001) { root.rotation.y += turn * factor; moving = true; }
      if (head) {
        const pitch = entry.rotation.pitch * radians - head.rotation.x;
        if (Math.abs(pitch) > 0.001) { head.rotation.x += pitch * factor; moving = true; }
      }
      const walking = !this.reducedMotion && Math.hypot(dx, dz) > 0.04;
      if (walking) entry.phase += Math.hypot(dx, dz) * factor * 6;
      for (const { pivot, phase } of limbs) {
        const angle = walking ? Math.sin(entry.phase + phase) * 0.55 : 0;
        const change = angle - pivot.rotation.x;
        if (Math.abs(change) > 0.001) { pivot.rotation.x += change * factor; moving = true; }
      }
      let visible = id !== hiddenPlayer && entry.dimension.replace(/^minecraft:/, '') === mapId
        && now - entry.observedAt < (entry.player ? 15_000 : 12_000);
      // Stopping follow leaves the camera inside the player's head. Keep its
      // separate eyes/hair from blocking the view until the camera moves outside.
      if (visible && entry.player && this.playerBounds.setFromObject(root).containsPoint(this.cameraPosition)) visible = false;
      if (root.visible !== visible) { root.visible = visible; moving = true; }
    }
    if (this.root.visible && moving) viewer.redraw();
  }
  dispose(): void { this.root.removeFromParent(); this.entries.clear(); this.models.dispose(); }
}
