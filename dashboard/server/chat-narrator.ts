import type { ChatMessage } from './types.js';

export interface SpeechPlayer {
  play(text: string): Promise<void>;
  cancelPlayback(): void;
}
export interface NarratorStatus { enabled: boolean; speaking: boolean; pending: number; error: string | null }
interface PendingSpeech { text: string }
export type SpeechEnqueueResult = 'queued' | 'duplicate' | 'disabled' | 'full' | 'empty';

const MAX_AGE_MS = 30_000;
const MAX_PENDING = 100;

/** Own one utterance at a time so busy chat cannot overlap or build an unbounded audio backlog. */
export class ChatNarrator {
  private enabled = false;
  private enabledAt = 0;
  private current: symbol | null = null;
  private queue: PendingSpeech[] = [];
  private seen = new Set<string>();
  constructor(readonly player: SpeechPlayer, readonly changed: (status: NarratorStatus) => void, readonly now: () => number = Date.now) {}

  private publish(error: string | null = null): void {
    this.changed({ enabled: this.enabled, speaking: this.current !== null, pending: this.queue.length, error });
  }
  remember(messages: ChatMessage[]): void {
    this.rememberIds(messages.map(message => message.id));
  }
  rememberIds(ids: string[]): void {
    for (const id of ids) this.seen.add(id);
    while (this.seen.size > 3000) this.seen.delete(this.seen.values().next().value!);
  }
  start(announce = true): void {
    this.stop();
    this.enabled = true; this.enabledAt = Math.floor(this.now() / 1000) * 1000;
    if (announce) this.queue.push({ text: '声音四，后台聊天播报已开启' });
    this.next();
  }
  stop(): void {
    const current = this.current;
    this.enabled = false; this.current = null; this.queue = [];
    if (current) this.player.cancelPlayback();
    this.publish();
  }
  enqueue(message: ChatMessage): void {
    if (this.seen.has(message.id)) return;
    this.remember([message]);
    const now = this.now();
    if (!this.enabled || message.historical || message.timestamp < this.enabledAt || now - message.timestamp > MAX_AGE_MS) return;
    const content = this.clean(message.content);
    if (content) this.append(`${message.username} 说：${content}`.slice(0, 1000));
  }
  enqueueText(id: string, text: string): SpeechEnqueueResult {
    if (this.seen.has(id)) return 'duplicate';
    if (!this.enabled) return 'disabled';
    const content = this.clean(text);
    if (!content) return 'empty';
    if (this.queue.length >= MAX_PENDING) return 'full';
    this.rememberIds([id]);
    this.append(content.slice(0, 1000));
    return 'queued';
  }
  private clean(text: string): string {
    return text.replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();
  }
  private append(text: string): void {
    // Preserve accepted entries in FIFO order, including during a long utterance.
    if (this.queue.length >= MAX_PENDING) return;
    this.queue.push({ text });
    this.next();
  }
  private next(): void {
    if (!this.enabled) return;
    if (this.current) { this.publish(); return; }
    const pending = this.queue.shift();
    if (!pending) { this.publish(); return; }
    const current = Symbol();
    this.current = current;
    const fail = (): void => {
      if (this.current !== current) return;
      this.current = null; this.enabled = false; this.queue = [];
      this.publish('后台语音播报失败，请点击重试');
    };
    try {
      void this.player.play(pending.text).then(() => {
        if (this.current !== current) return;
        this.current = null; this.next();
      }, fail);
      this.publish();
    } catch {
      fail();
    }
  }
}
