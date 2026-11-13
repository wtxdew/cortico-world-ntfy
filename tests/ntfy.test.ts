import { afterEach, describe, expect, it } from 'vitest';
import { NtfySubscriber, publish, type NtfyMessage } from '../ntfy.ts';
import { fakeNtfy, until, type FakeNtfy } from './fake-server.ts';

let server: FakeNtfy | null = null;
let sub: NtfySubscriber | null = null;
afterEach(async () => { sub?.stop(); sub = null; await server?.close(); server = null; });

const now = () => Math.floor(Date.now() / 1000);

describe('NtfySubscriber', () => {
  it('subscribes to all topics on one connection and passes messages, not keepalives', async () => {
    server = await fakeNtfy();
    const got: Array<[NtfyMessage, boolean]> = [];
    const states: string[] = [];
    sub = new NtfySubscriber({ server: `${server.url}/`, topics: ['a_1', 'b_2'], onMessage: (m, off) => got.push([m, off]), onState: (s) => states.push(s) });
    sub.start();
    await until(() => states.includes('open'));
    expect(server.requests).toEqual(['/a_1,b_2/json']);
    server.send({ id: 'k', time: now(), event: 'keepalive', topic: 'a_1' });
    server.send({ id: 'm1', time: now(), event: 'message', topic: 'a_1', message: '构建完成', title: 'CI', priority: 4, tags: ['ok'] });
    await until(() => got.length === 1);
    expect(got[0]).toEqual([{ id: 'm1', time: expect.any(Number), topic: 'a_1', message: '构建完成', title: 'CI', priority: 4, tags: ['ok'] }, false]);
    expect(sub.last).toBe('m1');
  });

  it('reconnects with since after a drop and marks replayed messages offline', async () => {
    server = await fakeNtfy();
    const got: Array<[string, boolean]> = [];
    sub = new NtfySubscriber({ server: server.url, topics: ['a'], since: 'm0', onMessage: (m, off) => got.push([m.id, off]), backoff: { initialMs: 20, maxMs: 40 } });
    sub.start();
    await until(() => server!.requests.length === 1);
    expect(server.requests[0]).toBe('/a/json?since=m0');
    server.send({ id: 'm1', time: now(), event: 'message', topic: 'a', message: 'x' });
    await until(() => got.length === 1);
    server.drop();
    await until(() => server!.requests.length === 2);
    expect(server.requests[1]).toBe('/a/json?since=m1');
    // 补拉回来的旧消息
    server.send({ id: 'm2', time: now() - 600, event: 'message', topic: 'a', message: 'old' });
    await until(() => got.length === 2);
    expect(got[1]).toEqual(['m2', true]);
  });

  it('reconnects when nothing arrives for too long, and sends the token', async () => {
    server = await fakeNtfy({ open: false });
    sub = new NtfySubscriber({ server: server.url, topics: ['a'], token: 'tk_1', onMessage: () => {}, idleMs: 100, backoff: { initialMs: 10, maxMs: 10 } });
    sub.start();
    await until(() => server!.requests.length >= 2);
    expect(server.auth[0]).toBe('Bearer tk_1');
  });

  it('does not connect without topics', async () => {
    server = await fakeNtfy();
    sub = new NtfySubscriber({ server: server.url, topics: [], onMessage: () => {} });
    sub.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.requests).toEqual([]);
  });
});

describe('publish', () => {
  it('posts JSON with a title that may be Chinese', async () => {
    server = await fakeNtfy();
    await publish(server.url, 'a_1', '这是一条测试通知', { title: 'Coopet 测试' });
    expect(server.published).toEqual([{ topic: 'a_1', message: '这是一条测试通知', title: 'Coopet 测试' }]);
  });
});
