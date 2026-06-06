import type { MemoryConfig } from './config.js';
import type { MemoryStore } from './store.js';
import type { EmbedderHost } from './embeddings.js';
import { writeStatus } from './log.js';

const BACKFILL_INTERVAL_MS = 60_000;
// Docs vectorized per ONNX pass. Batching amortizes per-call overhead and uses the matmuls far
// better than batch=1 → much faster backfill. CPU peak stays bounded by the tier's thread cap.
const BACKFILL_BATCH = 32;

/**
 * Leader-only background vectorization of the docs captured by the hooks (which don't bundle the
 * model). Subscribes to the {@link LeaderCoordinator}: {@link start} on `becameLeader`,
 * {@link stop} on `lostLeadership`. Docs stay searchable via BM25 while vectors fill in.
 */
export class BackfillLoop {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: MemoryStore,
    private readonly cfg: MemoryConfig,
    private readonly embedder: EmbedderHost,
  ) {}

  /** Kicks one pass now (warm + drain) and every interval afterwards. */
  start(): void {
    if (this.timer || !this.store.vectorEnabled || !this.cfg.embed.enabled) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), BACKFILL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One backfill drain: batched ONNX passes, each written in a single transaction. Best-effort. */
  async run(): Promise<void> {
    if (this.running || !this.store.vectorEnabled || !this.cfg.embed.enabled) return;
    if (!(await this.embedder.ready())) return;
    this.running = true;
    try {
      for (;;) {
        const docs = this.store.missingVectorDocs(BACKFILL_BATCH);
        if (docs.length === 0) break;
        writeStatus(this.cfg.dataDir, {
          state: 'backfilling',
          model: this.cfg.embed.model,
          vectorized: this.store.stats().vectorCount,
          missing: this.store.countMissingVectors(),
        });
        const vectors = await this.embedder.embedBatch(docs.map((d) => d.text));
        const writes: Array<{ rowid: number; embedding: number[] }> = [];
        for (let i = 0; i < docs.length; i++) {
          const v = vectors[i];
          if (v) writes.push({ rowid: docs[i].rowid, embedding: v });
        }
        this.store.setVectorsBulk(writes);
      }
    } catch {
      /* best-effort */
    } finally {
      this.running = false;
      const s = this.store.stats();
      writeStatus(this.cfg.dataDir, {
        state: 'idle',
        vectorized: s.vectorCount,
        missing: this.store.countMissingVectors(),
      });
    }
  }
}
