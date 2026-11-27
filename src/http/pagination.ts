import type { HttpRequest, HttpResponse } from './client.js';

/**
 * Describes how a provider pages its collections. `HttpClient.paginate()` drives the loop; the
 * strategy only knows where items live and how to ask for the next page.
 */
export interface PaginationStrategy<T> {
  /** Optional transformation of the initial request (e.g. to set a page size). */
  first?(request: HttpRequest): HttpRequest;
  items(response: HttpResponse): T[];
  /** The request for the following page, or `undefined` when there are no more pages. */
  next(response: HttpResponse, previous: HttpRequest): HttpRequest | undefined;
}

export interface CursorPaginationOptions<T> {
  /** Extracts the items from a page body. */
  items: (body: unknown) => T[];
  /** Extracts the cursor for the next page. Empty, `null` or `undefined` ends iteration. */
  nextCursor: (body: unknown) => string | null | undefined;
  /** Query parameter that carries the cursor. Default `cursor`. */
  cursorParam?: string;
  /** Optional page size, sent as `limitParam` (default `limit`). */
  pageSize?: number;
  limitParam?: string;
}

/** Cursor-in-body pagination: `{ data: [...], next_cursor: "abc" }` → `?cursor=abc`. */
export function cursorPagination<T>(options: CursorPaginationOptions<T>): PaginationStrategy<T> {
  const cursorParam = options.cursorParam ?? 'cursor';
  const limitParam = options.limitParam ?? 'limit';
  const { pageSize } = options;
  return {
    first: (request) =>
      pageSize === undefined
        ? request
        : { ...request, query: { ...request.query, [limitParam]: pageSize } },
    items: (response) => options.items(response.data),
    next: (response, previous) => {
      const cursor = options.nextCursor(response.data);
      if (cursor === undefined || cursor === null || cursor === '') return undefined;
      return { ...previous, query: { ...previous.query, [cursorParam]: cursor } };
    },
  };
}

export interface LinkHeaderPaginationOptions<T> {
  /** Extracts the items from a page body. Default: the body itself must be an array. */
  items?: (body: unknown) => T[];
}

/** RFC 8288 `Link: <https://api.example.com/items?page=2>; rel="next"` pagination. */
export function linkHeaderPagination<T>(
  options: LinkHeaderPaginationOptions<T> = {},
): PaginationStrategy<T> {
  const items = options.items ?? defaultArrayItems<T>;
  return {
    items: (response) => items(response.data),
    next: (response, previous) => {
      const next = parseLinkHeader(response.headers.get('link')).next;
      if (next === undefined) return undefined;
      // The link already carries the full query string, so drop ours.
      const { query: _query, ...rest } = previous;
      return { ...rest, path: next };
    },
  };
}

/** Parses an RFC 8288 `Link` header into a `rel → url` map. */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!match) continue;
    const [, url = '', params = ''] = match;
    const rel = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(params)?.[1];
    if (rel === undefined) continue;
    for (const name of rel.trim().split(/\s+/)) links[name.toLowerCase()] = url;
  }
  return links;
}

function defaultArrayItems<T>(body: unknown): T[] {
  if (!Array.isArray(body)) {
    throw new TypeError('linkHeaderPagination expected an array body; pass an `items` extractor');
  }
  return body as T[];
}
