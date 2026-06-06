import type { EmbedderHost } from './embeddings.js';
import type { RerankerHost } from './rerank.js';
import { readLock } from './leader.js';
import { remoteEmbed, remoteRerank } from './embed-service.js';

/**
 * Strategy for satisfying a query-side embedding / rerank. The two implementations are swapped by
 * {@link MemoryServer} on every leadership transition, so the rest of the code (tools) just calls
 * `embedQuery` / `rerankQuery` without ever branching on `amLeader`:
 *   - {@link LocalExecutor}  — the leader holds the models and runs them in-process.
 *   - {@link RemoteExecutor} — a follower routes to the leader's loopback service (no local model).
 *
 * Both may return null (model unavailable / leader unreachable mid-failover) → the caller degrades
 * gracefully (search falls back to BM25; rerank keeps the RRF order).
 */
export interface QueryExecutor {
  embedQuery(text: string): Promise<number[] | null>;
  rerankQuery(query: string, docs: string[]): Promise<number[] | null>;
}

/** Leader path: embed/rerank locally with the in-process model hosts. */
export class LocalExecutor implements QueryExecutor {
  constructor(
    private readonly embedder: EmbedderHost,
    private readonly reranker: RerankerHost,
  ) {}

  embedQuery(text: string): Promise<number[] | null> {
    return this.embedder.embed(text, true); // true = query (prefix for instruction-tuned models)
  }

  rerankQuery(query: string, docs: string[]): Promise<number[] | null> {
    return this.reranker.rerank(query, docs);
  }
}

/** Follower path: route to the leader's loopback service (published in the lock file). */
export class RemoteExecutor implements QueryExecutor {
  constructor(private readonly dataDir: string) {}

  async embedQuery(text: string): Promise<number[] | null> {
    const lock = readLock(this.dataDir);
    if (lock?.port && lock?.token) return remoteEmbed({ port: lock.port, token: lock.token }, text);
    return null;
  }

  async rerankQuery(query: string, docs: string[]): Promise<number[] | null> {
    const lock = readLock(this.dataDir);
    if (lock?.port && lock?.token) return remoteRerank({ port: lock.port, token: lock.token }, query, docs);
    return null;
  }
}
