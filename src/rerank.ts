import { log } from './log.js';
import { ModelHost } from './model-host.js';

/** Options for the cross-encoder reranker (shares the embedder's cache/dtype/threads). */
export interface RerankOptions {
  model: string;
  dtype: string;
  cacheDir: string;
  threads: number;
  dataDir: string;
  /** ONNX device: '' / 'cpu' (default) or a GPU EP ('dml' | 'coreml' | 'cuda' | 'webgpu'). */
  device: string;
}

/**
 * Hosts the cross-encoder (tokenizer + sequence-classification model, e.g. bge-reranker). One
 * instance per process; `rerank()` lazily triggers the (shared) load. See {@link ModelHost}.
 */
export class RerankerHost extends ModelHost<any> {
  private tok: any = null;

  constructor(private readonly opts: RerankOptions) {
    super(opts.cacheDir, opts.device, opts.dtype, opts.threads, opts.dataDir, 'rerank');
  }

  protected async beforeAttempts(tf: any, threads: number, dtype: string): Promise<void> {
    log(
      this.dataDir,
      `[rerank] loading ${this.opts.model} (dtype=${dtype}, device=${this.opts.device || 'cpu'}, threads=${threads})`,
    );
    this.tok = await tf.AutoTokenizer.from_pretrained(this.opts.model);
  }

  protected async build(tf: any, device: string, dt: string, session_options: Record<string, unknown>): Promise<any> {
    const o: any = { dtype: dt, session_options };
    if (device && device !== 'cpu') o.device = device;
    return tf.AutoModelForSequenceClassification.from_pretrained(this.opts.model, o);
  }

  protected async warmup(model: any): Promise<void> {
    const probe = this.tok(['warmup'], { text_pair: ['warmup'], padding: true, truncation: true });
    await model(probe);
  }

  protected async afterLoad(): Promise<void> {
    log(this.dataDir, `[rerank] model ready (${this.opts.model})`);
  }

  protected async onLoadError(message: string): Promise<void> {
    log(this.dataDir, `[rerank] unavailable: ${message}`);
  }

  /**
   * Cross-encoder relevance scores for (query, doc) pairs. Returns one score per doc (higher = more
   * relevant), aligned to `docs`, or null if the reranker is unavailable (→ caller keeps RRF order).
   */
  async rerank(query: string, docs: string[]): Promise<number[] | null> {
    if (docs.length === 0) return [];
    if (!this.opts.model) return null;
    const model = await this.load();
    if (!model) return null;
    try {
      const inputs = this.tok(new Array(docs.length).fill(query), {
        text_pair: docs,
        padding: true,
        truncation: true,
      });
      const { logits } = await model(inputs);
      // num_labels = 1 → logits shape [n, 1]. Sigmoid is monotonic; only the order matters.
      const rows: any[] = logits.sigmoid().tolist();
      return rows.map((row) => (Array.isArray(row) ? Number(row[0]) : Number(row)));
    } catch {
      return null;
    }
  }
}
