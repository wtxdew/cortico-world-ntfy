import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import definition, { NtfyWorld, type NtfySection, type PanelState } from '../index.ts';
import { fakeNtfy, until, type FakeNtfy } from './fake-server.ts';

let server: FakeNtfy | null = null;
let world: NtfyWorld | null = null;
let dir = '';
afterEach(async () => { await world?.stop(); world = null; await server?.close(); server = null; if (dir) rmSync(dir, { recursive: true, force: true }); });

function setup(cfg: Partial<NtfySection> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'ntfy-world-'));
  const section: NtfySection = { enabled: true, server: server!.url, topics: [], ...cfg };
  const secrets = new Map<string, string>();
  const ctx = {
    cfg: section,
    persist: (patch: Partial<NtfySection>) => { Object.assign(section, patch); },
    secret: (name: string) => { const v = secrets.get(name) ?? ''; return v === '-' ? '' : v; },
    storeSecret: (name: string, value: string) => { secrets.set(name, value); },
    dataDir: dir, timezone: 'Asia/Shanghai',
  };
  const pushed: Array<{ type: string; meta?: Record<string, unknown>; text: string }> = [];
  const host = {
    pushEvent: vi.fn(async (e: { type: string; meta?: Record<string, unknown>; text: string }) => { pushed.push(e); return e; }),
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
  };
  world = new NtfyWorld(ctx, { backoff: { initialMs: 20, maxMs: 40 } });
  return { section, secrets, host, pushed, world };
}

const call = (w: NtfyWorld, method: string, args: unknown[] = []) => w.invoke(method, args, 'zh') as Promise<PanelState>;

describe('NtfyWorld', () => {
  it('adds topics from the panel, subscribes, and pushes live notices with the topic route', async () => {
    server = await fakeNtfy();
    const t = setup();
    await t.world.start(t.host as never);
    let s = await call(t.world, 'add', ['build']);
    expect(s.topics[0]!.topic).toMatch(/^build_[a-z0-9]{16}$/);
    await until(() => server!.requests.length === 1);
    await call(t.world, 'route', [0, 'maibot']);
    const topic = s.topics[0]!.topic;
    server.send({ id: 'm1', time: Math.floor(Date.now() / 1000), event: 'message', topic, message: '构建完成', title: 'CI' });
    await until(() => t.pushed.length === 1);
    expect(t.pushed[0]).toMatchObject({ type: 'ntfy.message', meta: { topic, label: 'build', route: 'maibot', title: 'CI', message: '构建完成' } });
    expect(t.pushed[0]!.text).toContain('构建完成');
    s = await call(t.world, 'state');
    expect(s.recent[0]).toMatchObject({ id: 'm1', label: 'build', offline: false });
    expect(s.state).toBe('open');
  });

  it('only records notices that arrived while offline, and remembers where it stopped', async () => {
    server = await fakeNtfy();
    const t = setup({ topics: [{ label: 'ci', topic: 'ci_x', route: 'pet' }] });
    await t.world.start(t.host as never);
    await until(() => server!.requests.length === 1);
    server.send({ id: 'old', time: Math.floor(Date.now() / 1000) - 3600, event: 'message', topic: 'ci_x', message: '昨晚的' });
    await until(() => t.world.panelState().recent.length === 1);
    expect(t.pushed).toHaveLength(0);
    expect((await call(t.world, 'state')).recent[0]).toMatchObject({ id: 'old', offline: true });
    await t.world.stop();
    expect(JSON.parse(readFileSync(join(dir, 'ntfy-state.json'), 'utf8')).lastId).toBe('old');
    // 重启后从那里接着补拉
    await t.world.start(t.host as never);
    await until(() => server!.requests.length === 2);
    expect(server.requests[1]).toBe('/ci_x/json?since=old');
  });

  it('regenerates and removes topics, resubscribing each time', async () => {
    server = await fakeNtfy();
    const t = setup({ topics: [{ label: 'a', topic: 'a_1', route: 'pet' }, { label: 'b', topic: 'b_1', route: 'pet' }] });
    await t.world.start(t.host as never);
    await until(() => server!.requests.length === 1);
    const s = await call(t.world, 'regenerate', [0]);
    expect(s.topics[0]!.topic).toMatch(/^a_[a-z0-9]{16}$/);
    await until(() => server!.requests.length === 2);
    await call(t.world, 'remove', [1]);
    await until(() => server!.requests.length === 3);
    expect(server.requests[2]).toBe(`/${s.topics[0]!.topic}/json`);
    await expect(call(t.world, 'remove', [5])).rejects.toThrow('没有这个话题');
    await expect(call(t.world, 'route', [0, 'loud'])).rejects.toThrow();
  });

  it('keeps a custom server token as a secret and sends it', async () => {
    server = await fakeNtfy();
    const t = setup({ topics: [{ label: 'a', topic: 'a_1', route: 'pet' }] });
    await t.world.start(t.host as never);
    let s = await call(t.world, 'token', ['tk_abc']);
    expect(s.tokenSet).toBe(true);
    expect(s.official).toBe(false);
    await until(() => server!.auth.includes('Bearer tk_abc'));
    s = await call(t.world, 'token', ['']);
    expect(s.tokenSet).toBe(false);
    await expect(call(t.world, 'token', ['a b'])).rejects.toThrow();
  });

  it('sends a test notice that comes back as a live one', async () => {
    server = await fakeNtfy();
    const t = setup({ topics: [{ label: 'a', topic: 'a_1', route: 'pet' }] });
    await t.world.start(t.host as never);
    await until(() => server!.requests.length === 1);
    await call(t.world, 'test', [0]);
    await until(() => t.pushed.length === 1);
    expect(t.pushed[0]!.meta).toMatchObject({ topic: 'a_1', title: 'Coopet 测试' });
  });

  it('uses the official server when the setting is empty, and declares its server setting', () => {
    const def = definition;
    expect(def.defaults()).toEqual({ enabled: false, server: 'https://ntfy.sh', topics: [] });
    const w = new NtfyWorld({ cfg: { enabled: true, server: ' ', topics: [] }, persist: () => {}, secret: () => '', storeSecret: () => {}, dataDir: tmpdir(), timezone: 'UTC' });
    expect(w.panelState()).toMatchObject({ server: 'https://ntfy.sh', official: true, state: 'idle' });
    const decl = w.webUi('zh');
    expect(Object.keys(decl.config![0]!.schema.properties)).toEqual(['worlds.ntfy.server']);
    expect(decl.lamps![0]!.state).toBe('offline');
  });
});
