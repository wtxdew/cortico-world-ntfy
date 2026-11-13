/** 假的 ntfy 服务器：订阅请求（GET …/json）保持连接、按测试的要求往下写行；发布（POST /）记下来并推给订阅者。 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeNtfy {
  url: string;
  /** 每次订阅请求的路径（含 since） */
  requests: string[];
  auth: Array<string | undefined>;
  published: Array<Record<string, unknown>>;
  /** 往所有订阅连接写一行 */
  send(line: Record<string, unknown>): void;
  /** 断开所有订阅连接 */
  drop(): void;
  close(): Promise<void>;
}

export async function fakeNtfy(opts: { onSubscribe?: (res: ServerResponse, req: IncomingMessage) => void; open?: boolean } = {}): Promise<FakeNtfy> {
  const subs = new Set<ServerResponse>();
  const requests: string[] = [];
  const auth: Array<string | undefined> = [];
  const published: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body) as Record<string, unknown>;
        published.push(msg);
        const line = { id: `p${published.length}`, time: Math.floor(Date.now() / 1000), event: 'message', ...msg };
        for (const s of subs) s.write(`${JSON.stringify(line)}\n`);
        res.end('{}');
      });
      return;
    }
    requests.push(req.url ?? '');
    auth.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    subs.add(res);
    res.on('close', () => subs.delete(res));
    if (opts.open !== false) res.write(`${JSON.stringify({ id: 'o', time: Math.floor(Date.now() / 1000), event: 'open', topic: 'x' })}\n`);
    opts.onSubscribe?.(res, req);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests, auth, published,
    send: (line) => { for (const s of subs) s.write(`${JSON.stringify(line)}\n`); },
    drop: () => { for (const s of subs) s.destroy(); subs.clear(); },
    close: () => new Promise<void>((r) => { for (const s of subs) s.destroy(); server.close(() => r()); }),
  };
}

export const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
