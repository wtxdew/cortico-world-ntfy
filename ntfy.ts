/**
 * ntfy 订阅：一条长连接收所有话题（GET <server>/<t1>,<t2>/json，每行一条 JSON），不轮询。
 *
 * - 每行的 event：open（连上了）、keepalive（服务器约 45 秒一次，表示连接还活着）、message（消息）。只处理 message。
 * - 超过 idleMs（默认 90 秒）一行都没收到，当作连接已断，主动重连。
 * - 断了就重连，间隔从 1 秒起翻倍，最长 30 秒；连上并收到第一行后间隔复位。
 * - 重连带 since=<最后收到的消息 id>，断线期间的消息不漏（ntfy.sh 保留约 12 小时）。
 * - 补拉回来的消息（时间早于这次连接建立）标成 offline，由调用方决定怎么处理（只记录、不念）。
 *
 * 只依赖 Node 自带的 fetch。
 */

export interface NtfyMessage {
  id: string;
  /** Unix 秒 */
  time: number;
  topic: string;
  message: string;
  title?: string;
  /** 1–5，3 是默认 */
  priority?: number;
  tags?: string[];
  click?: string;
}

export type NtfyState = 'idle' | 'connecting' | 'open' | 'error';

export interface SubscriberOptions {
  server: string;
  topics: readonly string[];
  /** 自订服务器的访问 token；没有就匿名 */
  token?: string;
  /** 从哪条消息之后开始（断线、重启后补拉）；没有就只收新的 */
  since?: string;
  onMessage(m: NtfyMessage, offline: boolean): void;
  onState?(state: NtfyState, detail?: string): void;
  idleMs?: number;
  backoff?: { initialMs: number; maxMs: number };
  fetch?: typeof fetch;
  now?: () => number;
}

/** 补拉判定的宽限：服务器和本机的钟可能差一点 */
const CLOCK_SLACK_MS = 2000;

export class NtfySubscriber {
  private readonly o: SubscriberOptions;
  private running = false;
  private abort: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs: number;
  private lastId: string | undefined;

  constructor(opts: SubscriberOptions) {
    this.o = opts;
    this.lastId = opts.since;
    this.retryMs = opts.backoff?.initialMs ?? 1000;
  }

  /** 最后收到的消息 id（调用方存起来，下次 since 用） */
  get last(): string | undefined {
    return this.lastId;
  }

  start(): void {
    if (this.running || this.o.topics.length === 0) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.o.onState?.('idle');
  }

  private url(): string {
    const base = this.o.server.replace(/\/+$/, '');
    const q = this.lastId ? `?since=${encodeURIComponent(this.lastId)}` : '';
    return `${base}/${this.o.topics.map(encodeURIComponent).join(',')}/json${q}`;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const error = await this.once();
      if (!this.running) return;
      this.o.onState?.('error', error);
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, this.o.backoff?.maxMs ?? 30_000);
      await new Promise<void>((r) => { this.retryTimer = setTimeout(r, wait); });
      this.retryTimer = null;
    }
  }

  /** 连一次，直到断开；返回断开的原因 */
  private async once(): Promise<string> {
    const now = this.o.now ?? Date.now;
    const abort = new AbortController();
    this.abort = abort;
    const idleMs = this.o.idleMs ?? 90_000;
    let idle: NodeJS.Timeout | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error('idle')), idleMs);
    };
    this.o.onState?.('connecting');
    try {
      touch();
      const res = await (this.o.fetch ?? fetch)(this.url(), {
        signal: abort.signal,
        headers: this.o.token ? { Authorization: `Bearer ${this.o.token}` } : {},
      });
      if (!res.ok || !res.body) return `HTTP ${res.status}`;
      const connectedAt = now();
      let opened = false;
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        touch();
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (!opened) {
            opened = true;
            this.retryMs = this.o.backoff?.initialMs ?? 1000;
            this.o.onState?.('open');
          }
          this.line(line, connectedAt);
        }
      }
      return 'closed';
    } catch (err) {
      if (abort.signal.aborted && abort.signal.reason instanceof Error && abort.signal.reason.message === 'idle') return 'idle';
      return err instanceof Error ? err.message : String(err);
    } finally {
      if (idle) clearTimeout(idle);
      if (this.abort === abort) this.abort = null;
    }
  }

  private line(line: string, connectedAt: number): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.event !== 'message' || typeof m.id !== 'string' || typeof m.topic !== 'string') return;
    this.lastId = m.id;
    const time = typeof m.time === 'number' ? m.time : Math.floor(Date.now() / 1000);
    const msg: NtfyMessage = {
      id: m.id,
      time,
      topic: m.topic,
      message: typeof m.message === 'string' ? m.message : '',
      ...(typeof m.title === 'string' && m.title ? { title: m.title } : {}),
      ...(typeof m.priority === 'number' ? { priority: m.priority } : {}),
      ...(Array.isArray(m.tags) ? { tags: m.tags.filter((t): t is string => typeof t === 'string') } : {}),
      ...(typeof m.click === 'string' && m.click ? { click: m.click } : {}),
    };
    this.o.onMessage(msg, time * 1000 < connectedAt - CLOCK_SLACK_MS);
  }
}

/** 发一条（面板的「发一条测试」）。用 JSON 发到服务器根地址，标题里有中文也没问题（请求头只能放 ASCII） */
export async function publish(server: string, topic: string, message: string, opts: { title?: string; token?: string; fetch?: typeof fetch } = {}): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = JSON.stringify({ topic, message, ...(opts.title ? { title: opts.title } : {}) });
  const res = await (opts.fetch ?? fetch)(server.replace(/\/+$/, ''), { method: 'POST', body, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
