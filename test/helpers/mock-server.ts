import { type IncomingHttpHeaders, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

export type MockHandler = (request: RecordedRequest, response: ServerResponse) => unknown;

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Local HTTP server on 127.0.0.1 with an ephemeral port. Nothing leaves the machine. */
export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: new URL(req.url ?? '/', 'http://127.0.0.1'),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      Promise.resolve(handler(recorded, res)).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(body === undefined ? '' : JSON.stringify(body));
}
