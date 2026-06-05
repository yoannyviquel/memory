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
      // Cap ONNX threads so a backfill batch doesn't peg every core. Both backends covered:
      // onnxruntime-node reads `onnx.numThreads`; wasm reads `onnx.wasm.numThreads`.
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

      // session_options: onnxruntime-node honors intra/inter-op thread counts per session.
      const session_options = { intraOpNumThreads: threads, interOpNumThreads: threads };
      let pipe: any;
      try {
        pipe = await tf.pipeline('feature-extraction', cfg.model, {
          dtype,
          progress_callback,
          session_options,
        });
      } catch (e) {
        // The tier doesn't necessarily expose the quantized variant → fall back to full precision.
        log(
          cfg.dataDir,
          `[embed] dtype=${dtype} unavailable (${e instanceof Error ? e.message : String(e)}); falling back to fp32`,
        );
        pipe = await tf.pipeline('feature-extraction', cfg.model, {
          dtype: 'fp32',
          progress_callback,
          session_options,
        });
      }
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

export async function embed(text: string, cfg: EmbedConfig): Promise<number[] | null> {
  const r = await embedBatch([text], cfg);
  return r[0] ?? null;
}

/** Batch embeddings (mean pooling + L2 normalization). null per entry on failure. */
export async function embedBatch(
  texts: string[],
  cfg: EmbedConfig,
): Promise<Array<number[] | null>> {
  if (!cfg.enabled || texts.length === 0) return texts.map(() => null);
  const pipe = await getPipe(cfg);
  if (!pipe) return texts.map(() => null);
  try {
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const arr: number[][] = out.tolist();
    return texts.map((_, i) => (Array.isArray(arr[i]) && arr[i].length > 0 ? arr[i] : null));
  } catch {
    return texts.map(() => null);
  }
}
