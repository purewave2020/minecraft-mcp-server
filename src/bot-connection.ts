import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import fs from 'node:fs';
import path from 'node:path';
import { identityKey, runtimeDirectory, writePrivateJson } from './runtime-state.js';

const { pathfinder, Movements } = pathfinderPkg;
const SUPPORTED_MINECRAFT_VERSION = mineflayer.latestSupportedVersion;
type ConnectionState = 'connected' | 'connecting' | 'disconnected';
interface BotConfig { host: string; port: number; username: string; version?: string; navigationDig?: boolean; navigationTower?: boolean; }
interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;
  private blockedReason?: string;
  private lastDisconnect?: string;
  private connectedAt?: string;
  private lastKick?: { reason: string; at: string };
  private lastError?: { reason: string; at: string };
  private lastEnd?: { reason: string; at: string };
  private disconnectCount = 0;
  private connectionFailure?: string;
  private spawnListeners = new Set<(bot: mineflayer.Bot) => void>();

  constructor(private config: BotConfig, private callbacks: ConnectionCallbacks, private readonly reconnectDelayMs = 2000) {}

  getBot(): mineflayer.Bot | null { return this.bot; }
  getState(): ConnectionState { return this.state; }
  getConfig(): BotConfig { return this.config; }
  isConnected(): boolean { return this.state === 'connected' && this.bot !== null; }
  onSpawn(callback: (bot: mineflayer.Bot) => void): void {
    this.spawnListeners.add(callback);
    if (this.isConnected()) callback(this.bot!);
  }
  getStatus(): Record<string, unknown> {
    return { observedAt: new Date().toISOString(), username: this.config.username, state: this.state,
      connected: this.isConnected(), protocolState: this.bot?._client.state, connectedAt: this.connectedAt,
      lastDisconnect: this.lastDisconnect, reconnectPending: this.reconnectTimer !== null,
      failures: this.failures, blockedReason: this.blockedReason, lastKick: this.lastKick,
      lastError: this.lastError, lastEnd: this.lastEnd, disconnectCount: this.disconnectCount,
      navigation: { canDig: this.config.navigationDig === true, allow1by1towers: this.config.navigationTower === true } };
  }
  getPreference<T>(key: string, fallback: T): T {
    try { return JSON.parse(fs.readFileSync(this.preferencePath(), 'utf8'))[key] ?? fallback; }
    catch { return fallback; }
  }
  setPreference(key: string, value: unknown): void {
    let preferences: Record<string, unknown> = {};
    try { preferences = JSON.parse(fs.readFileSync(this.preferencePath(), 'utf8')); } catch { /* First run. */ }
    writePrivateJson(this.preferencePath(), { ...preferences, [key]: value });
  }
  private preferencePath(): string { return path.join(runtimeDirectory(), `${identityKey(this.config)}.preferences.json`); }

  connect(): void {
    if (this.stopped || this.bot) return;
    this.state = 'connecting';
    this.isReconnecting = false;
    this.connectionFailure = undefined;
    try {
      const { host, port, username, version } = this.config;
      const bot = mineflayer.createBot({ host, port, username, version, plugins: { pathfinder } });
      this.bot = bot;
      this.registerEventHandlers(bot);
      this.connectTimer = setTimeout(() => {
        if (this.bot !== bot || this.state === 'connected') return;
        this.lastDisconnect = 'Connection/spawn timed out after 15000ms';
        this.bot = null;
        this.state = 'disconnected';
        bot.quit(this.lastDisconnect);
        this.attemptReconnect();
      }, 15000);
      this.connectTimer.unref();
    } catch (error) {
      this.state = 'disconnected';
      this.lastDisconnect = this.formatError(error);
      this.callbacks.onLog('error', `Bot connection failed: ${this.lastDisconnect}`);
      this.attemptReconnect();
    }
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    bot.once('spawn', () => {
      if (this.bot !== bot || this.stopped) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      const movements = new Movements(bot, minecraftData(bot.version));
      movements.canDig = this.config.navigationDig === true;
      movements.allow1by1towers = this.config.navigationTower === true;
      movements.allowParkour = false;
      movements.allowSprinting = true;
      movements.maxDropDown = 2;
      movements.liquidCost = 8;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.thinkTimeout = 1000;
      bot.pathfinder.tickTimeout = 10;
      bot.pathfinder.searchRadius = 64;
      this.state = 'connected';
      this.failures = 0;
      this.connectedAt = new Date().toISOString();
      for (const callback of this.spawnListeners) {
        try { callback(bot); } catch (error) { this.callbacks.onLog('error', `Spawn setup failed: ${this.formatError(error)}`); }
      }
      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });
    bot.on('chat', (username, message) => {
      if (this.bot === bot) this.callbacks.onChatMessage(username, message);
    });
    bot.on('kicked', reason => {
      if (this.bot !== bot) return;
      this.lastDisconnect = this.formatError(reason);
      this.connectionFailure = this.lastDisconnect;
      this.lastKick = { reason: this.lastDisconnect, at: new Date().toISOString() };
      if (/duplicate_login|logged in from another location/i.test(this.lastDisconnect)) {
        this.blockedReason = 'Duplicate identity login detected; explicit controller handoff is required';
      }
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.lastDisconnect}`);
      bot.quit();
    });
    bot.on('error', error => {
      if (this.bot !== bot) return;
      const reason = this.formatError(error);
      this.lastError = { reason, at: new Date().toISOString() };
      this.connectionFailure ??= reason;
      this.lastDisconnect = this.connectionFailure;
      this.callbacks.onLog('error', `Bot error: ${reason}`);
    });
    bot.on('end', reason => {
      if (this.bot !== bot) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.bot = null;
      this.state = 'disconnected';
      this.connectedAt = undefined;
      this.disconnectCount++;
      this.lastEnd = { reason: this.formatError(reason), at: new Date().toISOString() };
      this.lastDisconnect = this.connectionFailure ?? this.lastEnd.reason;
      this.callbacks.onLog('info', `Bot disconnected: ${this.lastDisconnect}; transport end: ${this.lastEnd.reason}`);
      // Leave plugin end listeners intact so their timers and promises are cleaned up.
      this.attemptReconnect();
    });
  }

  attemptReconnect(): void {
    if (this.stopped || this.blockedReason || this.isReconnecting || this.bot || this.reconnectTimer) return;
    this.isReconnecting = true;
    this.state = 'connecting';
    const wait = Math.min(30000, this.reconnectDelayMs * 2 ** Math.min(this.failures++, 4));
    const jitter = Math.floor(wait * Math.random() * 0.1);
    this.callbacks.onLog('info', `Attempting to reconnect in ${wait + jitter}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.isReconnecting = false;
      this.connect();
    }, wait + jitter);
    this.reconnectTimer.unref();
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    if (this.blockedReason) return { connected: false, message: this.blockedReason };
    if (this.state === 'connected') return { connected: true };
    if (this.state === 'connecting' && !this.bot && !this.reconnectTimer && !this.isReconnecting) this.state = 'disconnected';
    if (this.state === 'connecting') return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    if (!this.stopped) this.attemptReconnect();
    const deadline = Date.now() + this.reconnectDelayMs + 5000;
    while (!this.stopped && Date.now() < deadline) {
      if (this.isConnected()) return { connected: true };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { connected: false, message: `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}. ` +
      `Latest supported client: ${SUPPORTED_MINECRAFT_VERSION}. ${this.lastDisconnect ?? ''} ` +
      'Setup: https://github.com/yuniko-software/minecraft-mcp-server' };
  }

  cleanup(): void {
    this.stopped = true;
    this.state = 'disconnected';
    this.isReconnecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.reconnectTimer = this.connectTimer = null;
    const bot = this.bot;
    this.bot = null;
    try { bot?.quit('Server shutting down'); }
    catch (error) { this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(error)}`); }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    try { return JSON.stringify(error); } catch { return String(error); }
  }
}
