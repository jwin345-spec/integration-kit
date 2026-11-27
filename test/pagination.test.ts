import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpClient,
  cursorPagination,
  linkHeaderPagination,
  parseLinkHeader,
} from '../src/index.js';
import { type MockServer, sendJson, startMockServer } from './helpers/mock-server.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ITEMS = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('cursor pagination', () => {
  it('follows next_cursor until it is null', async () => {
    server = await startMockServer((request, response) => {
      const offset = Number(request.url.searchParams.get('cursor') ?? 0);
      const limit = Number(request.url.searchParams.get('limit'));
      const next = offset + limit < ITEMS.length ? String(offset + limit) : null;
      sendJson(response, 200, { data: ITEMS.slice(offset, offset + limit), next_cursor: next });
    });
    const client = new HttpClient({ baseUrl: server.url });
    const strategy = cursorPagination({
      pageSize: 3,
      items: (body) => (body as { data: { id: number }[] }).data,
      nextCursor: (body) => (body as { next_cursor: string | null }).next_cursor,
    });

    const items = await collect(
      client.paginate({ path: '/items', query: { status: 'open' } }, strategy),
    );
    expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(server.requests.map((r) => r.url.search)).toEqual([
      '?status=open&limit=3',
      '?status=open&limit=3&cursor=3',
      '?status=open&limit=3&cursor=6',
    ]);
  });

  it('is lazy: breaking out of the loop stops fetching pages', async () => {
    server = await startMockServer((request, response) => {
      const offset = Number(request.url.searchParams.get('cursor') ?? 0);
      sendJson(response, 200, { data: ITEMS.slice(offset, offset + 2), next_cursor: offset + 2 });
    });
    const client = new HttpClient({ baseUrl: server.url });
    const strategy = cursorPagination({
      items: (body) => (body as { data: { id: number }[] }).data,
      nextCursor: (body) => String((body as { next_cursor: number }).next_cursor),
    });
    for await (const item of client.paginate({ path: '/items' }, strategy)) {
      if (item.id === 3) break;
    }
    expect(server.requests).toHaveLength(2);
  });

  it('respects maxPages', async () => {
    server = await startMockServer((_request, response) => {
      sendJson(response, 200, { data: [{ id: 1 }], next_cursor: 'again' });
    });
    const client = new HttpClient({ baseUrl: server.url });
    const strategy = cursorPagination({
      items: (body) => (body as { data: { id: number }[] }).data,
      nextCursor: (body) => (body as { next_cursor: string }).next_cursor,
    });
    const items = await collect(client.paginate({ path: '/items' }, strategy, { maxPages: 4 }));
    expect(items).toHaveLength(4);
  });
});

describe('Link header pagination', () => {
  it('follows rel="next" links until there are none', async () => {
    server = await startMockServer((request, response) => {
      const page = Number(request.url.searchParams.get('page') ?? 1);
      const links = [`<${serverUrl()}/repos?page=1&per_page=3>; rel="first"`];
      if (page * 3 < ITEMS.length) {
        links.push(`<${serverUrl()}/repos?page=${page + 1}&per_page=3>; rel="next"`);
      }
      sendJson(response, 200, ITEMS.slice((page - 1) * 3, page * 3), { link: links.join(', ') });
    });
    const client = new HttpClient({ baseUrl: server.url });
    const items = await collect(
      client.paginate(
        { path: '/repos', query: { per_page: 3 } },
        linkHeaderPagination<{ id: number }>(),
      ),
    );
    expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(server.requests.map((r) => r.url.search)).toEqual([
      '?per_page=3',
      '?page=2&per_page=3',
      '?page=3&per_page=3',
    ]);
  });

  it('parses multiple links and multi-valued rel', () => {
    expect(
      parseLinkHeader(
        '<https://api.example.com/x?page=2>; rel="next", <https://api.example.com/x?page=9>; rel="last end"',
      ),
    ).toEqual({
      next: 'https://api.example.com/x?page=2',
      last: 'https://api.example.com/x?page=9',
      end: 'https://api.example.com/x?page=9',
    });
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader('garbage')).toEqual({});
  });
});

function serverUrl(): string {
  if (!server) throw new Error('server not started');
  return server.url;
}
