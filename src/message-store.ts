import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writePrivateJson } from './runtime-state.js';

interface StoredMessage {
  id: string;
  sequence: number;
  timestamp: number;
  username: string;
  content: string;
}

const MAX_STORED_MESSAGES = 100;

export class MessageStore {
  private messages: StoredMessage[] = [];
  private maxMessages = MAX_STORED_MESSAGES;
  private pending: StoredMessage[] = [];
  private sequence = 0;

  constructor(private filename?: string) {
    if (!filename || !fs.existsSync(filename)) return;
    const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(stored.messages) || !Array.isArray(stored.pending) || !Number.isSafeInteger(stored.sequence)) {
      throw new Error('Invalid persisted chat store; preserve the file and recover it before starting');
    }
    this.messages = stored.messages.slice(-MAX_STORED_MESSAGES);
    this.pending = stored.pending;
    this.sequence = stored.sequence;
  }

  addMessage(username: string, content: string): void {
    const message: StoredMessage = {
      id: randomUUID(),
      sequence: ++this.sequence,
      timestamp: Date.now(),
      username,
      content
    };

    if (username === 'qingyage') this.pending.push(message);

    this.messages.push(message);

    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    this.save();
  }

  getRecentMessages(count: number = 10): StoredMessage[] {
    if (count <= 0) {
      return [];
    }
    return this.messages.slice(-count);
  }

  getMaxMessages(): number {
    return this.maxMessages;
  }

  read(count = 10, username?: string, afterSequence = 0, pendingOnly = false): StoredMessage[] {
    if (count <= 0) return [];
    const messages = pendingOnly ? this.pending : [...new Map([...this.messages, ...this.pending].map(message => [message.id, message])).values()];
    const selected = messages.filter(message => (username === undefined || message.username === username) && message.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
    const limit = Math.min(1000, count);
    return pendingOnly || afterSequence > 0 ? selected.slice(0, limit) : selected.slice(-limit);
  }

  acknowledge(ids: string[]): number {
    const wanted = new Set(ids);
    const before = this.pending.length;
    this.pending = this.pending.filter(message => !wanted.has(message.id));
    this.save();
    return before - this.pending.length;
  }

  private save(): void {
    if (this.filename) writePrivateJson(this.filename, { messages: this.messages, pending: this.pending, sequence: this.sequence });
  }
}
