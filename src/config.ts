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
 * Multilingual embedding tiers. Each sets a model + dimension + pooling. light/medium/heavy are the
 * e5 family (mean pooling); ultra is bge-m3 (XLM-R based, CLS pooling) — the strongest local option.
 */
export const EMBED_TIERS: Record<string, { model: string; dim: number; pooling: string }> = {
  light: { model: 'Xenova/multilingual-e5-small', dim: 384, pooling: 'mean' },
  medium: { model: 'Xenova/multilingual-e5-base', dim: 768, pooling: 'mean' },
  heavy: { model: 'Xenova/multilingual-e5-large', dim: 1024, pooling: 'mean' },
  ultra: { model: 'Xenova/bge-m3', dim: 1024, pooling: 'cls' },
};
const DEFAULT_TIER = 'light';

function readConfigFile(dataDir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Loads the configuration. Priority: environment variable > file
 * `<dataDir>/config.json` > default. The file allows configuring without relying on the
 * plugins' `${}` mechanism (unreliable when a field is left empty).
 *
 * Exception — the embedding tier resolves file > env > default (see getFileFirst): the
 * install-time `${user_config.embedTier}` env is only a seed, so /memory:config and the
 * /memory:*-load commands (which write config.json) can switch tier without a reinstall.
 */
export function loadConfig(): MemoryConfig {
  const dataDir = process.env.MEMORY_DATA_DIR || path.join(os.homedir(), '.claude-memory');
  const file = readConfigFile(dataDir);
  const get = (envKey: string, fileKey: string): string | undefined => {
    const e = process.env[envKey];
    if (e !== undefined && e !== '' && !e.startsWith('${')) return e;
    const f = file[fileKey];
    return f === undefined || f === null ? undefined : String(f);
  };
  // Like get(), but the file wins over the env. Used for the embedding tier so that the
  // runtime config.json (written by /memory:config and the /memory:*-load commands) overrides
  // the install-time `${user_config.embedTier}` env injected by .mcp.json. Without this the
  // install choice would pin the tier forever and /memory:config would be a silent no-op.
  const getFileFirst = (fileKey: string, envKey: string): string | undefined => {
    const f = file[fileKey];
    if (f !== undefined && f !== null && String(f) !== '') return String(f);
    const e = process.env[envKey];
    if (e !== undefined && e !== '' && !e.startsWith('${')) return e;
    return undefined;
  };

  const dbPath = get('MEMORY_DB_PATH', 'dbPath') || path.join(dataDir, 'memories.db');
  const contextLimit = Number(get('MEMORY_CONTEXT_LIMIT', 'contextLimit')) || 10;

  const tier = (getFileFirst('embedTier', 'MEMORY_EMBED_TIER') || DEFAULT_TIER).toLowerCase();
  const picked = EMBED_TIERS[tier] ?? EMBED_TIERS[DEFAULT_TIER];
  const model = get('MEMORY_EMBED_MODEL', 'embedModel') || picked.model;
  const dim = Number(get('MEMORY_EMBED_DIM', 'embedDim')) || picked.dim;
  // Pooling must match the model (e5 = mean, bge = cls). Follows the tier; overridable if a custom
  // model is forced via MEMORY_EMBED_MODEL.
  const pooling = (get('MEMORY_EMBED_POOLING', 'embedPooling') || picked.pooling || 'mean').toLowerCase();
  const enabled = get('MEMORY_EMBED_ENABLED', 'embedEnabled') !== '0';
  const cacheDir = get('MEMORY_EMBED_CACHE_DIR', 'embedCacheDir') || path.join(dataDir, 'models');
  // Quantized by default: ~4× lighter to download, negligible quality loss in retrieval.
  const dtype = (get('MEMORY_EMBED_DTYPE', 'embedDtype') || 'q8').toLowerCase();
  // ONNX thread cap scales with the tier: a heavier model is the reason you'd want more cores, and
  // the larger the model the longer each batch — so we let it use a bigger slice. light=25%,
  // medium=50%, heavy=75%, ultra=100% of the cores. Floor of 1 so single/dual-core hosts still run.
  // Single source of truth: the tier (no separate override knob).
  const threadFraction: Record<string, number> = { light: 0.25, medium: 0.5, heavy: 0.75, ultra: 1 };
  const fraction = threadFraction[tier] ?? 0.25;
  const threads = Math.max(1, Math.floor(os.cpus().length * fraction));

  // LLM session digests (claude -p). On by default; opt out via env/file. Haiku by default so the
  // background loop doesn't compete with interactive Opus or burn the Max quota; overridable.
  const digestEnabled = get('MEMORY_DIGEST_ENABLED', 'digestEnabled') !== '0';
  const digestModel = get('MEMORY_DIGEST_MODEL', 'digestModel') || DEFAULT_DIGEST_MODEL;

  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, tier, model, dim, cacheDir, dtype, pooling, threads, dataDir },
    digest: { enabled: digestEnabled, model: digestModel, version: DIGEST_VERSION },
  };
}
