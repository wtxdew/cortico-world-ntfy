/**
 * ntfy World：订阅 ntfy 话题，收到的通知推成 `ntfy.message` 事件，由宿主（Coopet 的 Conductor、Coopanion 的模型）
 * 让桌宠告诉你。任何能 `curl` 的东西都能发：脚本、GitHub Actions、Home Assistant、另一台电脑上的 Coding Agent hook。
 *
 * - 配置（worlds.ntfy）：server（默认官方 https://ntfy.sh，留空也用官方）、topics（片段、话题名、去向）。
 *   server 在通用设置表单里改（改了要重启 World）；话题在面板里加、删、换随机码、改去向，马上重新订阅。
 * - 自订服务器的访问 token 存成密钥 NTFY_TOKEN（ctx.storeSecret），不进 config.json。
 * - 订阅见 ntfy.ts：一条长连接，断线重连带 since 补拉。补拉回来的（离线时收到的）只记进面板的"最近的通知"，不推事件。
 * - 最后收到的消息 id 和最近 20 条通知存在数据目录的 ntfy-state.json，重启后接着补拉。
 * - 事件的 meta：topic、label、route（这个话题的去向，Coopet「规则」模式用）、title、message、priority、tags、click。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemLanguage, type Language } from 'cortico/core/language.ts';
import type { World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldContext, WorldDefinition, WorldDescribe, WorldSection } from 'cortico/world.ts';
import { NtfySubscriber, publish, type NtfyMessage, type NtfyState } from './ntfy.ts';
import { makeTopic, regenerate, topicsFrom, TOPIC_ROUTES, type Topic, type TopicRoute } from './topics.ts';
import { OFFICIAL_SERVER, text } from './text.ts';

export const ID = 'ntfy';
const SECRET = 'NTFY_TOKEN';
const RECENT_MAX = 20;
const STATE_FILE = 'ntfy-state.json';

export interface NtfySection extends WorldSection {
  server: string;
  topics: Topic[];
}

export interface RecentNotice { id: string; time: number; label: string; title?: string; message: string; offline: boolean }

/** 面板拿到的状态 */
export interface PanelState {
  server: string;
  official: boolean;
  tokenSet: boolean;
  state: NtfyState;
  detail?: string;
  topics: Topic[];
  recent: RecentNotice[];
}

export function serverOf(cfg: Pick<NtfySection, 'server'>): string {
  const s = typeof cfg.server === 'string' ? cfg.server.trim().replace(/\/+$/, '') : '';
  return s || OFFICIAL_SERVER;
}

export class NtfyWorld implements World {
  readonly id = ID;
  private host: WorldHost | null = null;
  private sub: NtfySubscriber | null = null;
  private state: NtfyState = 'idle';
  private detail: string | undefined;
  private lastId: string | undefined;
  private recent: RecentNotice[] = [];

  constructor(private readonly ctx: Pick<WorldContext<NtfySection>, 'cfg' | 'persist' | 'secret' | 'storeSecret' | 'dataDir' | 'timezone'>,
    private readonly opts: { fetch?: typeof fetch; idleMs?: number; backoff?: { initialMs: number; maxMs: number } } = {}) {}

  tools() { return []; }
  envPromptVars() { return {}; }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.load();
    this.subscribe();
  }

  async stop(): Promise<void> {
    this.sub?.stop();
    this.sub = null;
    this.save();
    this.host = null;
    this.state = 'idle';
  }

  private topics(): Topic[] {
    return topicsFrom(this.ctx.cfg.topics);
  }

  private token(): string {
    try { return this.ctx.secret(SECRET) || ''; } catch { return ''; }
  }

  /** 按现在的配置（重新）订阅 */
  private subscribe(): void {
    this.sub?.stop();
    this.sub = null;
    const topics = this.topics();
    if (!this.host || topics.length === 0) { this.state = 'idle'; this.detail = undefined; return; }
    const token = this.token();
    this.sub = new NtfySubscriber({
      server: serverOf(this.ctx.cfg),
      topics: topics.map((t) => t.topic),
      ...(token ? { token } : {}),
      ...(this.lastId ? { since: this.lastId } : {}),
      onMessage: (m, offline) => void this.receive(m, offline),
      onState: (s, detail) => {
        this.state = s;
        this.detail = detail;
        if (s === 'error') this.host?.log.warn(`ntfy 连接断开：${detail ?? ''}`);
      },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.idleMs ? { idleMs: this.opts.idleMs } : {}),
      ...(this.opts.backoff ? { backoff: this.opts.backoff } : {}),
    });
    this.sub.start();
  }

  private async receive(m: NtfyMessage, offline: boolean): Promise<void> {
    this.lastId = m.id;
    const topic = this.topics().find((t) => t.topic === m.topic);
    const label = topic?.label ?? m.topic;
    this.recent = [{ id: m.id, time: m.time, label, ...(m.title ? { title: m.title } : {}), message: m.message, offline }, ...this.recent].slice(0, RECENT_MAX);
    this.save();
    if (offline || !topic || !this.host) return;
    const t = text(systemLanguage());
    await this.host.pushEvent({
      type: 'ntfy.message', source: ID, senderKey: `${ID}.${m.topic}`,
      ts: nowIso(this.ctx.timezone),
      text: [t.eventText(label), ...(m.title ? [`标题 / Title: ${m.title}`] : []), m.message].join('\n'),
      meta: {
        topic: m.topic, label, route: topic.route, message: m.message,
        ...(m.title ? { title: m.title } : {}),
        ...(m.priority !== undefined ? { priority: m.priority } : {}),
        ...(m.tags ? { tags: m.tags } : {}),
        ...(m.click ? { click: m.click } : {}),
      },
    }, { trigger: 'flush' }).catch((err: unknown) => this.host?.log.warn('ntfy 通知没能推出去', err));
  }

  private stateFile(): string {
    return join(this.ctx.dataDir, STATE_FILE);
  }

  private load(): void {
    try {
      const s = JSON.parse(readFileSync(this.stateFile(), 'utf8')) as { lastId?: unknown; recent?: unknown };
      if (typeof s.lastId === 'string') this.lastId = s.lastId;
      if (Array.isArray(s.recent)) this.recent = (s.recent as RecentNotice[]).slice(0, RECENT_MAX);
    } catch { /* 第一次运行 */ }
  }

  private save(): void {
    try {
      mkdirSync(this.ctx.dataDir, { recursive: true });
      writeFileSync(this.stateFile(), JSON.stringify({ lastId: this.lastId, recent: this.recent }));
    } catch (err) {
      this.host?.log.warn('ntfy 的状态没能保存', err);
    }
  }

  private setTopics(topics: Topic[]): void {
    // 数组整体替换（persist 的约定）
    this.ctx.persist({ topics } as Partial<NtfySection>);
    this.subscribe();
  }

  panelState(): PanelState {
    const server = serverOf(this.ctx.cfg);
    return {
      server, official: server === OFFICIAL_SERVER, tokenSet: !!this.token(),
      state: this.state, ...(this.detail ? { detail: this.detail } : {}),
      topics: this.topics(), recent: this.recent,
    };
  }

  /** 面板调用；返回新的状态 */
  async invoke(method: string, args: unknown[], language: Language): Promise<PanelState> {
    const topics = this.topics();
    const at = (i: unknown): number => {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= topics.length) throw new Error('没有这个话题');
      return i;
    };
    switch (method) {
      case 'state': break;
      case 'add': {
        const label = typeof args[0] === 'string' ? args[0] : '';
        this.setTopics([...topics, makeTopic(label)]);
        break;
      }
      case 'regenerate': {
        const i = at(args[0]);
        this.setTopics(topics.map((t, j) => (j === i ? regenerate(t) : t)));
        break;
      }
      case 'remove': {
        const i = at(args[0]);
        this.setTopics(topics.filter((_, j) => j !== i));
        break;
      }
      case 'route': {
        const i = at(args[0]);
        const route = args[1] as TopicRoute;
        if (!TOPIC_ROUTES.includes(route)) throw new Error('去向只能是 pet、maibot、off');
        this.ctx.persist({ topics: topics.map((t, j) => (j === i ? { ...t, route } : t)) } as Partial<NtfySection>);
        break;
      }
      case 'token': {
        const value = typeof args[0] === 'string' ? args[0].trim() : '';
        if (/\s/.test(value)) throw new Error('token 里不能有空白');
        // 清除：存一个占位（storeSecret 不接受空值），读的时候当成没有
        this.ctx.storeSecret(SECRET, value || '-');
        this.subscribe();
        break;
      }
      case 'test': {
        const i = at(args[0]);
        const t = text(language);
        const token = this.token();
        await publish(serverOf(this.ctx.cfg), topics[i]!.topic, t.testBody, { title: t.testTitle, ...(token ? { token } : {}), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) });
        break;
      }
      default: throw new Error(`没有这个方法：${method}`);
    }
    return this.panelState();
  }

  webUi(language: Language = systemLanguage()): WorldWebUiDecl {
    const t = text(language);
    const lamp = this.state === 'open' ? 'online' : this.state === 'connecting' ? 'loading' : this.state === 'error' ? 'error' : 'offline';
    return {
      label: t.title,
      lamps: [{ label: t.lamp, state: lamp, hint: t.status[this.state] ?? '' }],
      panels: [{ id: 'main', title: t.panel, getMethods: ['state'] }],
      invoke: (panel, method, args) => {
        if (panel !== 'main') throw new Error('Unknown panel');
        return this.invoke(method, args, language);
      },
      config: [{
        id: `world:${ID}`,
        owner: `world:${ID}`,
        schema: {
          type: 'object',
          title: t.configTitle,
          properties: {
            [`worlds.${ID}.server`]: { type: 'string', title: t.serverField, description: t.serverHint },
          },
        },
      }],
    };
  }
}

/** 占位的 "-" 当成没有 token */
function realToken(v: string): string {
  return v === '-' ? '' : v;
}

const describe: WorldDescribe = {
  tools: [],
  events: [{
    type: 'ntfy.message',
    description: { zh: '订阅的 ntfy 话题收到一条通知，请简短转告用户。', en: 'A subscribed ntfy topic received a notice. Tell the user briefly.' },
    trigger: 'flush',
  }],
};

const definition: WorldDefinition<NtfySection> = {
  id: ID,
  get label() { return text(systemLanguage()).title; },
  defaults: () => ({ enabled: false, server: OFFICIAL_SERVER, topics: [] }),
  create: (ctx) => new NtfyWorld({
    cfg: ctx.cfg, persist: ctx.persist, dataDir: ctx.dataDir, timezone: ctx.timezone, storeSecret: ctx.storeSecret,
    secret: (name) => realToken(ctx.secret(name)),
  }),
  describe,
};
export default definition;
