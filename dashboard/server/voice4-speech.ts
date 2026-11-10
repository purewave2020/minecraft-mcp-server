import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const VOICE4_ID = 'com.apple.siri.natural.zh-CN-D';
export const VOICE4_NAME = '声音4';
const GREETING = '聊天语音播报已开启';
type Renderer = (text: string, output: string) => Promise<void>;
type SaySpawner = (args: string[], timeout: number) => ChildProcess;

/** Render the specified Siri voice locally; never send chat to a third-party TTS service. */
export class Voice4Speech {
  private readonly cache = new Map<string, Buffer>();
  private readonly jobs = new Map<string, Promise<Buffer>>();
  private readonly children = new Set<ChildProcess>();
  private available: Promise<boolean> | null = null;
  private playback: { child: ChildProcess; done: Promise<void> } | null = null;
  private playbackGeneration = 0;
  private stopped = false;
  constructor(
    readonly directory: string,
    readonly platform: string = process.platform,
    readonly renderer: Renderer = (text, output) => this.say(text, output),
    readonly spawnSay: SaySpawner = (args, timeout) => spawn('/usr/bin/say', args, { stdio: ['pipe', 'ignore', 'ignore'], timeout })
  ) {}

  async capabilities(): Promise<{ available: boolean; name: string; voiceId: string }> {
    this.available ??= this.platform === 'darwin' ? this.render(GREETING).then(() => true, () => false) : Promise.resolve(false);
    return { available: await this.available, name: VOICE4_NAME, voiceId: VOICE4_ID };
  }
  async render(text: string): Promise<Buffer> {
    if (this.stopped || this.platform !== 'darwin') throw new Error('声音4需要在已安装该声音的 Mac 上运行');
    if (!text.trim() || text.length > 1000) throw new Error('播报文本长度无效');
    const key = createHash('sha256').update(text).digest('hex');
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const pending = this.jobs.get(key);
    if (pending) return pending;
    if (this.jobs.size >= 2) throw new Error('声音4正在生成其他播报，请稍后重试');
    const job = this.generate(text).then(audio => {
      this.cache.set(key, audio);
      let bytes = [...this.cache.values()].reduce((sum, value) => sum + value.length, 0);
      while (bytes > 8 * 1024 * 1024 || this.cache.size > 24) {
        const first = this.cache.keys().next().value!;
        bytes -= this.cache.get(first)!.length; this.cache.delete(first);
      }
      return audio;
    }).finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, job);
    return job;
  }
  async play(text: string): Promise<void> {
    if (this.stopped || this.platform !== 'darwin') throw new Error('声音4需要在已安装该声音的 Mac 上运行');
    if (!text.trim() || text.length > 1000) throw new Error('播报文本长度无效');
    const generation = ++this.playbackGeneration;
    const previous = this.playback;
    if (previous) {
      previous.child.kill('SIGTERM');
      await previous.done.catch(() => {});
    }
    if (this.stopped || generation !== this.playbackGeneration) throw new Error('播报已取消');
    const playback = this.run(['-v', VOICE4_ID, '-f', '-'], text, 90_000);
    this.playback = playback;
    try { await playback.done; }
    finally { if (this.playback === playback) this.playback = null; }
  }
  cancelPlayback(): void {
    this.playbackGeneration++;
    this.playback?.child.kill('SIGTERM');
  }
  private async generate(text: string): Promise<Buffer> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(this.directory, 'voice4-'));
    const output = path.join(temporary, 'speech.wav');
    try {
      if (this.stopped) throw new Error('语音服务已停止');
      await this.renderer(text, output);
      const audio = await fs.readFile(output);
      if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('声音4未生成有效音频');
      return audio;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  private run(args: string[], text: string, timeout: number): { child: ChildProcess; done: Promise<void> } {
    const child = this.spawnSay(args, timeout);
    this.children.add(child);
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', () => reject(new Error('无法启动声音4')));
      child.stdin?.on('error', () => {});
      child.stdin?.end(text);
      child.on('close', code => {
        this.children.delete(child);
        if (code === 0) resolve(); else reject(new Error('声音4播报失败，请确认已安装该系统声音'));
      });
    });
    return { child, done };
  }
  private say(text: string, output: string): Promise<void> {
    return this.run(['-v', VOICE4_ID, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-', '-o', output], text, 60_000).done;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelPlayback();
    for (const child of this.children) child.kill('SIGTERM');
    await Promise.allSettled([...this.jobs.values(), this.playback?.done]); this.cache.clear();
  }
}
