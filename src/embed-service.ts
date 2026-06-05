import { createServer, request as httpRequest } from 'node:http';
import { embed, type EmbedConfig } from './embeddings.js';

/**
 * Leader-only loopback embedding service. The leader is the single process holding the model, so
 * non-leader sessions POST their query text here to get a vector instead of loading their own copy
 * of the model. Bound strictly to 127.0.0.1 and guarded by a shared token (published in the lock
 * file). Tiny payload: short text in, one embedding out. KNN/BM25/RRF still run in each caller.
 */

const TOKEN_HEADER = 'x-mem-token';

/** Starts the embedding HTTP server on an ephemeral 127.0.0.1 port. Returns the chosen port. */
export async function startEmbedServer(cfg: EmbedConfig, token: string): Promise<number> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/embed' || req.headers[TOKEN_HEADER] !== token) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        // The loopback service only ever embeds QUERIES (followers' searches) → isQuery = true.
        const vector = await embed(String(text ?? ''), cfg, true);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ vector }));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  server.unref?.(); // never keep the process alive just for this
  return port;
}

/** Client: ask the leader to embed `text`. Returns the vector, or null on any failure (→ BM25-only). */
export function remoteEmbed(
  endpoint: { port: number; token: string },
  text: string,
  timeoutMs = 5000,
): Promise<number[] | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        method: 'POST',
        path: '/embed',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          [TOKEN_HEADER]: endpoint.token,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            resolve(Array.isArray(j.vector) ? j.vector : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}
