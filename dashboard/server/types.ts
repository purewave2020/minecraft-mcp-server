export const CHAT_USERNAME = 'qingyage';
export const CHAT_MAX_LENGTH = 256;

export interface Position { x: number; y: number; z: number }
export interface Rotation { yaw: number; pitch: number }
export interface WorldEntity {
  id: string;
  type: string;
  name: string;
  dimension: string;
  position: Position;
  rotation: Rotation;
  baby: boolean;
  color: number | null;
  sheared: boolean;
  observedAt: number;
}
export interface Item { name: string; count: number; slot?: string | number }
export interface Player {
  id: string;
  name: string;
  bot: boolean;
  online: boolean;
  dimension: string;
  position: Position | null;
  rotation: Rotation | null;
  health: number | null;
  food: number | null;
  xp: number | null;
  inventory: Item[];
  equipment: Record<string, Item | null>;
  effects: string[];
  observedAt: number | null;
  positionAt: number | null;
  joinedAt: number;
}
export interface ChatMessage {
  id: string;
  sequence?: number;
  playerId: string | null;
  username: string;
  content: string;
  timestamp: number;
  expiresAt: number;
  historical: boolean;
}
export interface BackgroundSpeechStatus {
  supported: boolean;
  loading: boolean;
  enabled: boolean;
  ready: boolean;
  speaking: boolean;
  pending: number;
  error: string | null;
  voiceName: string;
  voiceId: string;
  revision: number;
}
export type Weather = 'clear' | 'rain' | 'thunder';
export interface EnvironmentState {
  timeOfDay: number | null;
  timeRate: number;
  timeObservedAt: number | null;
  weather: Weather | null;
  weatherObservedAt: number | null;
}
export interface WorldMap {
  id: string;
  name: string;
  dimension: string;
}
export interface DashboardEvent {
  id: number;
  type: string;
  data: unknown;
  timestamp: number;
}
export interface MapState {
  available: boolean;
  syncing: boolean;
  snapshotAt: string | null;
  syncedAt: string | null;
  renderedAt: string | null;
  progress: string;
  error: string | null;
  maps: WorldMap[];
}
