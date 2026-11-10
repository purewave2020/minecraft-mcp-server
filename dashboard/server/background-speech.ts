import { ChatNarrator, type SpeechEnqueueResult, type SpeechPlayer } from './chat-narrator.js';
import { Store } from './store.js';
import type { BackgroundSpeechStatus, ChatMessage, DashboardEvent } from './types.js';
import { VOICE4_ID, VOICE4_NAME } from './voice4-speech.js';

export interface BackgroundVoice extends SpeechPlayer {
  capabilities(): Promise<{ available: boolean; voiceId: string }>;
  stop(): Promise<void>;
}

/** One server-owned narrator consumes chat even when no browser is connected. */
export class BackgroundSpeech {
  status: BackgroundSpeechStatus;
  private readonly narrator: ChatNarrator;
  private started: Promise<void> | null = null;
  private stopped = false;
  constructor(readonly store: Store, readonly voice: BackgroundVoice, now: () => number = Date.now) {
    this.status = {
      supported: false, loading: true, enabled: store.meta('speechEnabled', true), ready: false,
      speaking: false, pending: 0, error: null, voiceName: VOICE4_NAME, voiceId: VOICE4_ID, revision: store.lastEventId()
    };
    this.narrator = new ChatNarrator(voice, status => {
      Object.assign(this.status, { ready: status.enabled, speaking: status.speaking, pending: status.pending,
        error: this.status.supported ? status.error : this.status.error });
      this.publish();
    }, now);
    this.narrator.remember(store.chats(3000));
    const announcements = store.db.prepare("SELECT data FROM events WHERE type='speech.message' ORDER BY id DESC LIMIT 3000").all();
    this.narrator.rememberIds(announcements.map(row => 'announcement:' + String(JSON.parse(String(row.data)).id)));
    store.on('event', this.onEvent);
  }
  private readonly onEvent = (event: DashboardEvent): void => {
    if (event.type === 'chat.message') queueMicrotask(() => {
      // Let the original chat reach SSE clients before emitting its speech status event.
      if (!this.stopped) this.narrator.enqueue(event.data as ChatMessage);
    });
  };
  private publish(): void {
    if (this.stopped) return;
    // The persistent event ID keeps status revisions increasing across backend restarts.
    this.status.revision = this.store.lastEventId() + 1;
    this.store.event('speech.status', { ...this.status });
  }
  start(): Promise<void> {
    this.started ??= this.initialize();
    return this.started;
  }
  private async initialize(): Promise<void> {
    let supported = false;
    try {
      const voice = await this.voice.capabilities();
      supported = voice.available && voice.voiceId === VOICE4_ID;
    } catch { /* Report the unavailable voice without substituting another voice. */ }
    if (this.stopped) return;
    Object.assign(this.status, { supported, loading: false,
      error: supported ? null : '声音4不可用，请确认面板所在 Mac 已安装该声音' });
    if (supported && this.status.enabled) this.narrator.start(false);
    else this.publish();
  }
  async setEnabled(enabled: boolean): Promise<BackgroundSpeechStatus> {
    if (this.stopped) throw new Error('后台播报已停止');
    if (enabled) {
      await this.start();
      if (this.stopped || !this.status.supported) throw new Error('声音4不可用');
    }
    this.store.setMeta('speechEnabled', enabled);
    this.status.enabled = enabled;
    if (!enabled) this.narrator.stop();
    else if (!this.status.ready) this.narrator.start();
    return { ...this.status };
  }
  async enqueueAnnouncement(id: string, text: string, source: string): Promise<SpeechEnqueueResult> {
    await this.start();
    if (this.stopped || !this.status.supported) throw new Error('后台播报不可用');
    const result = this.narrator.enqueueText('announcement:' + id, text);
    if (result === 'queued') this.store.event('speech.message', { id, text, source, timestamp: Date.now() });
    return result;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.store.off('event', this.onEvent);
    this.narrator.stop();
    await this.voice.stop();
  }
}
