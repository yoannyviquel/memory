import { log, writeStatus } from './log.js';
import { ModelHost } from './model-host.js';

export interface EmbedConfig {
  enabled: boolean;
  /** Tier label (light | medium | heavy) — drives the process name suffix. */
  tier: string;
  model: string;
  dim: number;
  cacheDir: string;
  /** ONNX precision: 'q8' (quantized, default, ~4× lighter) or 'fp32' (full precision). */
  dtype: string;
  /** ONNX device: '' / 'cpu' (default), or a GPU EP — 'dml' | 'coreml' | 'cuda' | 'webgpu'. */
  device: string;
  /** Pooling strategy: 'mean' (e5), 'cls' (bge), or 'last_token' (Qwen3-Embedding). Must match the model. */
  pooling: string;
  /** Instruction prefix prepended to QUERIES only (instruction-tuned models like Qwen3). '' = none. */
  queryPrefix: string;
  /** ONNX intra-op thread cap. Backfill embeds one doc at a time, so this alone bounds CPU. */
  threads: number;
  /** Data root (logs + status.json), to log the model loading. */
  dataDir: string;
}

/** Builds the text to embed for a document (meaning-bearing fields). */
export function embedText(parts: Array<string | undefined>, max = 2000): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join('\n')
    .slice(0, max);
}

const POOLINGS = new Set(['mean', 'cls', 'last_token']);

/**
 * Hosts the transformers.js feature-extraction pipeline (e5 family). One instance per process holds
 * the single loaded model; `embed*` lazily trigger the (shared) load. See {@link ModelHost} for the
 * load/fallback skeleton.
 */
export class EmbedderHost extends ModelHost<any> {
  private progressCb: ((p: any) => void) | undefined;

  constructor(private readonly cfg: EmbedConfig) {
    super(cfg.cacheDir, cfg.device, cfg.dtype, cfg.threads, cfg.dataDir, 'embed');
  }

  // Maximize a single sequential embedding across its allowed threads:
  //  - intraOpNumThreads = threads → fans the heavy matmuls of ONE inference over every allowed core.
  //  - interOpNumThreads = 1 + executionMode sequential → no second pool (a transformer encoder is a
  //    serial layer stack, so inter-op parallelism adds nothing and would risk exceeding the cap).
  //  - graphOptimizationLevel 'all' → fused kernels run faster on the same threads.
  protected sessionOptions(threads: number): Record<string, unknown> {
    return {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    };
  }

  protected async beforeAttempts(_tf: any, threads: number, dtype: string): Promise<void> {
    log(this.dataDir, `[embed] onnx threads capped at ${threads}`);
    log(this.dataDir, `[embed] loading ${this.cfg.model} (dtype=${dtype}) cache=${this.cfg.cacheDir}`);
    writeStatus(this.dataDir, { state: 'loading', model: this.cfg.model, progress: undefined, file: undefined });
    // HuggingFace download progress → logs + status.json (throttled by decile).
    const lastPct: Record<string, number> = {};
    this.progressCb = (p: any) => {
      try {
        if (p?.status === 'progress' && p.file && typeof p.progress === 'number') {
          const pct = Math.round(p.progress);
          const bucket = Math.floor(pct / 10);
          if (lastPct[p.file] !== bucket) {
            lastPct[p.file] = bucket;
            log(this.dataDir, `[embed] download ${p.file} ${pct}%`);
          }
          writeStatus(this.dataDir, { state: 'downloading', model: this.cfg.model, file: p.file, progress: pct });
        } else if (p?.status === 'done' && p.file) {
          log(this.dataDir, `[embed] downloaded ${p.file}`);
        } else if (p?.status === 'ready') {
          log(this.dataDir, `[embed] model ready (${this.cfg.model})`);
        }
      } catch {
        /* best-effort */
      }
    };
  }

  protected async build(tf: any, device: string, dt: string, session_options: Record<string, unknown>): Promise<any> {
    const opts: any = { dtype: dt, progress_callback: this.progressCb, session_options };
    if (device && device !== 'cpu') opts.device = device;
    return tf.pipeline('feature-extraction', this.cfg.model, opts);
  }

  protected async warmup(pipe: any): Promise<void> {
    const pooling = this.cfg.pooling === 'cls' ? 'cls' : 'mean';
    await pipe(['warmup'], { pooling, normalize: true });
  }

  protected async afterLoad(): Promise<void> {
    log(this.dataDir, `[embed] device=${this.effectiveDevice}`);
    writeStatus(this.dataDir, { state: 'idle', progress: undefined, file: undefined });
  }

  protected async onLoadError(message: string): Promise<void> {
    log(this.dataDir, `[embed] unavailable: ${message}`);
    writeStatus(this.dataDir, { state: 'idle', progress: undefined, file: undefined });
    process.stderr.write(`[memory] embedder unavailable: ${message}\n`);
  }

  /** True if the model is loadable (triggers loading). */
  async ready(): Promise<boolean> {
    if (!this.cfg.enabled) return false;
    return !!(await this.load());
  }

  /**
   * Embeds one text. `isQuery` matters for instruction-tuned models (e.g. Qwen3-Embedding) that want
   * a query-side prefix; documents are embedded raw. No-op for models without a queryPrefix.
   */
  async embed(text: string, isQuery = false): Promise<number[] | null> {
    const r = await this.embedBatch([text], isQuery);
    return r[0] ?? null;
  }

  /** Batch embeddings (pooling per model + L2 normalization). null per entry on failure. */
  async embedBatch(texts: string[], isQuery = false): Promise<Array<number[] | null>> {
    if (!this.cfg.enabled || texts.length === 0) return texts.map(() => null);
    const pipe = await this.load();
    if (!pipe) return texts.map(() => null);
    try {
      // Instruction-tuned models: prefix queries only (documents stay raw).
      const inputs = isQuery && this.cfg.queryPrefix ? texts.map((t) => `${this.cfg.queryPrefix}${t}`) : texts;
      const pooling = POOLINGS.has(this.cfg.pooling) ? this.cfg.pooling : 'mean';
      const out = await pipe(inputs, { pooling, normalize: true });
      const arr: number[][] = out.tolist();
      return texts.map((_, i) => (Array.isArray(arr[i]) && arr[i].length > 0 ? arr[i] : null));
    } catch {
      return texts.map(() => null);
    }
  }
}
