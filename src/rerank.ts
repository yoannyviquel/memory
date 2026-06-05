import { log } from './log.js';

/** Options for the cross-encoder reranker (shares the embedder's cache/dtype/threads). */
export interface RerankOptions {
  model: string;
  dtype: string;
  cacheDir: string;
  threads: number;
  dataDir: string;
}

// Singleton reranker (tokenizer + sequence-classification model), loaded once per process.
let _tok: any = null;
let _model: any = null;
let _loading: Promise<{ tok: any; model: any } | null> | null = null;
let _failed = false;

async function getReranker(opts: RerankOptions): Promise<{ tok: any; model: any } | null> {
  if (!opts.model) return null;
  if (_model && _tok) return { tok: _tok, model: _model };
  if (_failed) return null;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const mod = '@huggingface/transformers';
      const tf: any = await import(mod);
      tf.env.cacheDir = opts.cacheDir;
      tf.env.allowRemoteModels = true;
      const threads = Math.max(1, opts.threads || 1);
      try {
        tf.env.backends.onnx.numThreads = threads;
        if (tf.env.backends.onnx.wasm) tf.env.backends.onnx.wasm.numThreads = threads;
      } catch {
        /* best-effort */
      }
      const dtype = opts.dtype || 'q8';
      const session_options = { intraOpNumThreads: threads, interOpNumThreads: 1 };
      log(opts.dataDir, `[rerank] loading ${opts.model} (dtype=${dtype}, threads=${threads})`);
      const tok = await tf.AutoTokenizer.from_pretrained(opts.model);
      let model: any;
      try {
        model = await tf.AutoModelForSequenceClassification.from_pretrained(opts.model, {
          dtype,
          session_options,
        });
      } catch (e) {
        log(
          opts.dataDir,
          `[rerank] dtype=${dtype} unavailable (${e instanceof Error ? e.message : String(e)}); falling back to fp32`,
        );
        model = await tf.AutoModelForSequenceClassification.from_pretrained(opts.model, {
          dtype: 'fp32',
          session_options,
        });
      }
      _tok = tok;
      _model = model;
      log(opts.dataDir, `[rerank] model ready (${opts.model})`);
      return { tok, model };
    } catch (err) {
      _failed = true;
      log(opts.dataDir, `[rerank] unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

/** True if the reranker is already loaded — never triggers a load. For status. */
export function rerankLoaded(): boolean {
  return _model !== null && _tok !== null;
}

/**
 * Cross-encoder relevance scores for (query, doc) pairs. Returns one score per doc (higher = more
 * relevant), aligned to `docs`, or null if the reranker is unavailable (→ caller keeps RRF order).
 */
export async function rerank(
  query: string,
  docs: string[],
  opts: RerankOptions,
): Promise<number[] | null> {
  if (docs.length === 0) return [];
  const r = await getReranker(opts);
  if (!r) return null;
  try {
    const inputs = r.tok(new Array(docs.length).fill(query), {
      text_pair: docs,
      padding: true,
      truncation: true,
    });
    const { logits } = await r.model(inputs);
    // num_labels = 1 → logits shape [n, 1]. Sigmoid is monotonic; only the order matters.
    const rows: any[] = logits.sigmoid().tolist();
    return rows.map((row) => (Array.isArray(row) ? Number(row[0]) : Number(row)));
  } catch {
    return null;
  }
}
