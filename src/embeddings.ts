import { log, writeStatus } from './log.js';

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

// transformers.js pipeline singleton (loaded once per process).
let _pipe: any = null;
let _loading: Promise<any> | null = null;
let _failed = false;
let _device = ''; // effective device after load ('cpu' or a GPU EP), for status reporting

async function getPipe(cfg: EmbedConfig): Promise<any | null> {
  if (!cfg.enabled) return null;
  if (_pipe) return _pipe;
  if (_failed) return null;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      // Specifier as a variable: keeps the import resolvable at runtime from node_modules.
      const mod = '@huggingface/transformers';
      const tf: any = await import(mod);
      tf.env.cacheDir = cfg.cacheDir;
      tf.env.allowRemoteModels = true;
      // Tier-derived thread budget: each embedding may use up to this many cores, no more.
      // Both backends covered: onnxruntime-node reads `onnx.numThreads`; wasm reads
      // `onnx.wasm.numThreads`. The per-session session_options below enforce the same budget.
      const threads = Math.max(1, cfg.threads || 1);
      try {
        tf.env.backends.onnx.numThreads = threads;
        if (tf.env.backends.onnx.wasm) tf.env.backends.onnx.wasm.numThreads = threads;
      } catch {
        /* best-effort: older builds may not expose the backend tree */
      }
      log(cfg.dataDir, `[embed] onnx threads capped at ${threads}`);

      const dtype = cfg.dtype || 'q8';
      log(cfg.dataDir, `[embed] loading ${cfg.model} (dtype=${dtype}) cache=${cfg.cacheDir}`);
      writeStatus(cfg.dataDir, { state: 'loading', model: cfg.model, progress: undefined, file: undefined });

      // HuggingFace download progress → logs + status.json (throttled by decile).
      const lastPct: Record<string, number> = {};
      const progress_callback = (p: any) => {
        try {
          if (p?.status === 'progress' && p.file && typeof p.progress === 'number') {
            const pct = Math.round(p.progress);
            const bucket = Math.floor(pct / 10);
            if (lastPct[p.file] !== bucket) {
              lastPct[p.file] = bucket;
              log(cfg.dataDir, `[embed] download ${p.file} ${pct}%`);
            }
            writeStatus(cfg.dataDir, { state: 'downloading', model: cfg.model, file: p.file, progress: pct });
          } else if (p?.status === 'done' && p.file) {
            log(cfg.dataDir, `[embed] downloaded ${p.file}`);
          } else if (p?.status === 'ready') {
            log(cfg.dataDir, `[embed] model ready (${cfg.model})`);
          }
        } catch {
          /* best-effort */
        }
      };

      // Maximize a single sequential embedding across its allowed threads:
      //  - intraOpNumThreads = threads → fans the heavy matmuls of ONE inference over every
      //    allowed core (this is the lever that makes embed exploit the full cap).
      //  - interOpNumThreads = 1 + executionMode sequential → no second pool; a transformer
      //    encoder is a serial layer stack, so inter-op parallelism adds nothing and would only
      //    risk spinning threads beyond the cap.
      //  - graphOptimizationLevel 'all' → fused kernels run faster on the same threads.
      const session_options = {
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
      };
      const pooling = cfg.pooling === 'cls' ? 'cls' : 'mean';
      // Load + a warmup inference. The warmup surfaces a GPU EP that loads but can't actually run the
      // graph at startup (rather than silently returning null vectors during backfill).
      const attempt = async (device: string, dt: string): Promise<any> => {
        const opts: any = { dtype: dt, progress_callback, session_options };
        if (device && device !== 'cpu') opts.device = device;
        const p = await tf.pipeline('feature-extraction', cfg.model, opts);
        await p(['warmup'], { pooling, normalize: true });
        return p;
      };
      let pipe: any;
      try {
        pipe = await attempt(cfg.device, dtype);
        _device = cfg.device && cfg.device !== 'cpu' ? cfg.device : 'cpu';
      } catch (e) {
        // GPU EP missing/unusable, or the quantized variant absent → fall back to CPU + fp32.
        log(
          cfg.dataDir,
          `[embed] device=${cfg.device || 'cpu'}/dtype=${dtype} failed (${e instanceof Error ? e.message : String(e)}); falling back to cpu/fp32`,
        );
        pipe = await attempt('cpu', 'fp32');
        _device = 'cpu';
      }
      log(cfg.dataDir, `[embed] device=${_device}`);
      _pipe = pipe;
      writeStatus(cfg.dataDir, { state: 'idle', progress: undefined, file: undefined });
      return pipe;
    } catch (err) {
      _failed = true;
      const message = err instanceof Error ? err.message : String(err);
      log(cfg.dataDir, `[embed] unavailable: ${message}`);
      writeStatus(cfg.dataDir, { state: 'idle', progress: undefined, file: undefined });
      process.stderr.write(`[memory] embedder unavailable: ${message}\n`);
      return null;
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

/** True if the model is loadable (triggers loading). */
export async function embedReady(cfg: EmbedConfig): Promise<boolean> {
  return !!(await getPipe(cfg));
}

/** True if the model is ALREADY loaded — never triggers a (blocking) load. For status reporting. */
export function embedLoaded(): boolean {
  return _pipe !== null;
}

/** Effective device after load ('cpu' or a GPU EP); '' if not loaded yet. For status reporting. */
export function embedDevice(): string {
  return _device;
}

const POOLINGS = new Set(['mean', 'cls', 'last_token']);

/**
 * Embeds one text. `isQuery` matters for instruction-tuned models (e.g. Qwen3-Embedding) that want
 * a query-side prefix; documents are embedded raw. No-op for models without a queryPrefix.
 */
export async function embed(
  text: string,
  cfg: EmbedConfig,
  isQuery = false,
): Promise<number[] | null> {
  const r = await embedBatch([text], cfg, isQuery);
  return r[0] ?? null;
}

/** Batch embeddings (pooling per model + L2 normalization). null per entry on failure. */
export async function embedBatch(
  texts: string[],
  cfg: EmbedConfig,
  isQuery = false,
): Promise<Array<number[] | null>> {
  if (!cfg.enabled || texts.length === 0) return texts.map(() => null);
  const pipe = await getPipe(cfg);
  if (!pipe) return texts.map(() => null);
  try {
    // Instruction-tuned models: prefix queries only (documents stay raw).
    const inputs =
      isQuery && cfg.queryPrefix ? texts.map((t) => `${cfg.queryPrefix}${t}`) : texts;
    const pooling = POOLINGS.has(cfg.pooling) ? cfg.pooling : 'mean';
    const out = await pipe(inputs, { pooling, normalize: true });
    const arr: number[][] = out.tolist();
    return texts.map((_, i) => (Array.isArray(arr[i]) && arr[i].length > 0 ? arr[i] : null));
  } catch {
    return texts.map(() => null);
  }
}
