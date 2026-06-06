import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { EmbedConfig } from './embeddings.js';

export interface MemoryConfig {
  dbPath: string;
  dataDir: string;
  contextLimit: number;
  embed: EmbedConfig;
  digest: DigestConfig;
  rerank: RerankConfig;
}

export interface RerankConfig {
  /** Whether to rerank search candidates with a cross-encoder (on by default; off if no model). */
  enabled: boolean;
  /** Cross-encoder model id (per tier). Empty = no reranker for this tier (e.g. light). */
  model: string;
}

export interface DigestConfig {
  /** Master switch for LLM session digests (claude -p). */
  enabled: boolean;
  /** Model used for digests. Defaults to Haiku — cheap on quota, plenty for summarization. */
  model: string;
  /** Bump to re-generate every existing digest (selector treats older versions as stale). */
  version: number;
}

/**
 * Digest model: the `haiku` alias (not a pinned version) so the CLI resolves whatever the current
 * Haiku is — future-proof. Background summarization shouldn't compete with interactive Opus.
 */
const DEFAULT_DIGEST_MODEL = 'haiku';

/**
 * Version markers persisted in the `meta` table to drive reprocessing without a manual migration:
 *  - DIGEST_VERSION: bump when the digest prompt/output format changes → sessions whose digest
 *    carries an older version are re-digested by the background loop.
 *  - EMBED_TEXT_VERSION: bump when the text we feed the embedder changes (e.g. we start embedding
 *    digests) → init() clears the vector index so the backfill refills it with the new text.
 */
export const DIGEST_VERSION = 1;
export const EMBED_TEXT_VERSION = 1;

/**
 * Multilingual embedding tiers (e5 family, mean pooling). For a personal, hybrid-with-BM25 memory
 * base, e5 is the sweet spot — bigger bi-encoders are overkill; precision is better gained with a
 * reranker than a heavier embedder. (`pooling`/`queryPrefix` stay generic in case a future model needs them.)
 */
export const EMBED_TIERS: Record<
  string,
  { model: string; dim: number; pooling: string; queryPrefix?: string; reranker?: string }
> = {
  light: { model: 'Xenova/multilingual-e5-small', dim: 384, pooling: 'mean' },
  medium: { model: 'Xenova/multilingual-e5-base', dim: 768, pooling: 'mean', reranker: 'Xenova/bge-reranker-base' },
  heavy: {
    model: 'Xenova/multilingual-e5-large',
    dim: 1024,
    pooling: 'mean',
    reranker: 'onnx-community/bge-reranker-v2-m3-ONNX',
  },
};
const DEFAULT_TIER = 'light';

/**
 * Resolves the ONNX device string. '' = CPU (default). 'auto' picks the platform's bundled GPU EP
 * (Windows→DirectML, macOS→CoreML); elsewhere CPU (CUDA stays explicit — it needs an NVIDIA GPU).
 */
function resolveDevice(raw: string): string {
  if (raw !== 'auto') return raw; // '', 'cpu', 'dml', 'coreml', 'cuda', 'webgpu' → as-is
  if (process.platform === 'win32') return 'dml';
  if (process.platform === 'darwin') return 'coreml';
  return '';
}

function readConfigFile(dataDir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Resolves a single setting from the environment and `<dataDir>/config.json`. Centralizes the
 * env-vs-file precedence so loadConfig() reads as a flat list of `src.*(...)` calls instead of
 * repeating the resolution boilerplate per field.
 *
 * Default precedence (`get`): environment variable > file > default. An env value is ignored if it
 * is empty or an unresolved `${...}` placeholder (the plugin's `${}` injection is unreliable when a
 * field is left blank), so the file/default still applies.
 */
class ConfigSource {
  constructor(private readonly file: Record<string, unknown>) {}

  private envValue(envKey: string): string | undefined {
    const e = process.env[envKey];
    return e !== undefined && e !== '' && !e.startsWith('${') ? e : undefined;
  }

  /** env > file > undefined. */
  get(envKey: string, fileKey: string): string | undefined {
    const e = this.envValue(envKey);
    if (e !== undefined) return e;
    const f = this.file[fileKey];
    return f === undefined || f === null ? undefined : String(f);
  }

  /**
   * file > env > undefined. Used for the embedding tier so the runtime config.json (written by
   * /memory:config and the /memory:*-load commands) overrides the install-time
   * `${user_config.embedTier}` env injected by .mcp.json — otherwise the install choice would pin
   * the tier forever and /memory:config would be a silent no-op.
   */
  fileFirst(fileKey: string, envKey: string): string | undefined {
    const f = this.file[fileKey];
    if (f !== undefined && f !== null && String(f) !== '') return String(f);
    return this.envValue(envKey);
  }

  /** Numeric setting (env > file), falling back to `def` when unset or unparseable. */
  num(envKey: string, fileKey: string, def: number): number {
    return Number(this.get(envKey, fileKey)) || def;
  }

  /** Boolean flag: true unless explicitly set to '0'. */
  flag(envKey: string, fileKey: string): boolean {
    return this.get(envKey, fileKey) !== '0';
  }
}

/**
 * Loads the configuration. Priority: environment variable > file
 * `<dataDir>/config.json` > default (the embedding tier is the documented exception — see
 * {@link ConfigSource.fileFirst}).
 */
export function loadConfig(): MemoryConfig {
  const dataDir = process.env.MEMORY_DATA_DIR || path.join(os.homedir(), '.claude-memory');
  const src = new ConfigSource(readConfigFile(dataDir));

  const dbPath = src.get('MEMORY_DB_PATH', 'dbPath') || path.join(dataDir, 'memories.db');
  const contextLimit = src.num('MEMORY_CONTEXT_LIMIT', 'contextLimit', 10);

  const tier = (src.fileFirst('embedTier', 'MEMORY_EMBED_TIER') || DEFAULT_TIER).toLowerCase();
  const picked = EMBED_TIERS[tier] ?? EMBED_TIERS[DEFAULT_TIER];
  const model = src.get('MEMORY_EMBED_MODEL', 'embedModel') || picked.model;
  const dim = src.num('MEMORY_EMBED_DIM', 'embedDim', picked.dim);
  // Pooling must match the model (e5 = mean, bge = cls). Follows the tier; overridable if a custom
  // model is forced via MEMORY_EMBED_MODEL.
  const pooling = (src.get('MEMORY_EMBED_POOLING', 'embedPooling') || picked.pooling || 'mean').toLowerCase();
  // Query-side instruction prefix (instruction-tuned models, e.g. Qwen3). Applied to queries only.
  const queryPrefix = src.get('MEMORY_EMBED_QUERY_PREFIX', 'embedQueryPrefix') ?? picked.queryPrefix ?? '';
  const enabled = src.flag('MEMORY_EMBED_ENABLED', 'embedEnabled');
  const cacheDir = src.get('MEMORY_EMBED_CACHE_DIR', 'embedCacheDir') || path.join(dataDir, 'models');
  // ONNX execution device (opt-in GPU). Empty = CPU (default → not passed to the pipeline).
  //  - explicit: cpu | dml (Windows) | coreml (macOS) | cuda (Linux+NVIDIA) | webgpu (experimental)
  //  - 'auto': pick the platform's GPU EP (win32→dml, darwin→coreml; else CPU since CUDA needs NVIDIA).
  // EPs are bundled in onnxruntime-node; loads fall back to CPU at warmup if the device can't run.
  const device = resolveDevice((src.get('MEMORY_EMBED_DEVICE', 'embedDevice') || '').toLowerCase());
  // Precision. Quantized (q8) by default on CPU (~4× lighter); GPU EPs handle int8 poorly, so default
  // to fp32 there. An explicit MEMORY_EMBED_DTYPE always wins.
  const dtypeOverride = src.get('MEMORY_EMBED_DTYPE', 'embedDtype');
  const onGpu = device !== '' && device !== 'cpu';
  const dtype = (dtypeOverride || (onGpu ? 'fp32' : 'q8')).toLowerCase();
  // ONNX thread cap scales with the tier (CPU only; ignored by GPU EPs). light=33%, medium=66%,
  // heavy=100% of the cores. Floor of 1 so single/dual-core hosts still run.
  // Single source of truth: the tier (no separate override knob).
  const threadFraction: Record<string, number> = { light: 1 / 3, medium: 2 / 3, heavy: 1 };
  const fraction = threadFraction[tier] ?? 0.25;
  const threads = Math.max(1, Math.floor(os.cpus().length * fraction));

  // LLM session digests (claude -p). On by default; opt out via env/file. Haiku by default so the
  // background loop doesn't compete with interactive Opus or burn the Max quota; overridable.
  const digestEnabled = src.flag('MEMORY_DIGEST_ENABLED', 'digestEnabled');
  const digestModel = src.get('MEMORY_DIGEST_MODEL', 'digestModel') || DEFAULT_DIGEST_MODEL;

  // Reranker: cross-encoder over the top-K search candidates. On by default; the model is per tier
  // (light has none → disabled). Override the model with MEMORY_RERANK_MODEL, or turn off with
  // MEMORY_RERANK_ENABLED=0.
  const rerankModel = src.get('MEMORY_RERANK_MODEL', 'rerankModel') || picked.reranker || '';
  const rerankEnabled = src.flag('MEMORY_RERANK_ENABLED', 'rerankEnabled') && !!rerankModel;

  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, tier, model, dim, cacheDir, dtype, device, pooling, queryPrefix, threads, dataDir },
    digest: { enabled: digestEnabled, model: digestModel, version: DIGEST_VERSION },
    rerank: { enabled: rerankEnabled, model: rerankModel },
  };
}
