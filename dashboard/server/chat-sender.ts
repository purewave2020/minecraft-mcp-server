import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { offlineId } from './world-state.js';
import { CHAT_MAX_LENGTH, CHAT_USERNAME, type ChatMessage } from './types.js';

const bridge = fileURLToPath(new URL('../bridge/remote.py', import.meta.url));

export class ChatSendError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function chatContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > CHAT_MAX_LENGTH) {
    throw new ChatSendError(400, `请输入 1–${CHAT_MAX_LENGTH} 字的聊天内容`);
  }
  // Minecraft public chat is a single line of printable text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u00a7\u2028\u2029]/u.test(value)) {
    throw new ChatSendError(400, '聊天内容不能包含换行或控制字符');
  }
  return value.trim();
}

export class ChatSender {
  private sending = false;
  private child: ChildProcess | null = null;
  constructor(readonly store: Store, private readonly deliver: (content: string) => Promise<void> = content => this.broadcast(content)) {}

  async send(value: unknown): Promise<ChatMessage> {
    const content = chatContent(value);
    if (this.sending) throw new ChatSendError(429, '上一条聊天正在发送，请稍候');
    this.sending = true;
    try {
      await this.deliver(content);
      const timestamp = Date.now();
      const message: ChatMessage = { id: 'dashboard:' + randomUUID(), username: CHAT_USERNAME, playerId: offlineId(CHAT_USERNAME),
        content, timestamp, expiresAt: timestamp + 8000, historical: false };
      if (this.store.chat(message)) this.store.event('chat.message', message);
      return message;
    } finally { this.sending = false; }
  }

  private broadcast(content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('python3', [bridge, 'chat'], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 20_000 });
      this.child = child;
      let output = '';
      const failure = () => reject(new ChatSendError(503, '未能确认发送结果，请先检查游戏聊天记录再重试'));
      child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-4096); });
      child.on('error', failure);
      child.stdin.on('error', failure);
      child.on('close', code => {
        if (this.child === child) this.child = null;
        if (code !== 0) { failure(); return; }
        try {
          const receipt = JSON.parse(output.trim());
          if (receipt.status !== 'sent' || receipt.username !== CHAT_USERNAME) throw new Error('Invalid chat receipt');
          resolve();
        } catch { failure(); }
      });
      // Text is data on stdin, never part of a shell or PowerShell program.
      child.stdin.end(JSON.stringify({ content }));
    });
  }

  stop(): void { this.child?.kill('SIGTERM'); }
}
