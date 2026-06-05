import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { EmbedConfig } from './embeddings.js';

export interface MemoryConfig {
  dbPath: string;
  dataDir: string;
  contextLimit: number;
  embed: EmbedConfig;
}

/** Multilingual embedding tiers (e5 family). Each tier sets a consistent model + dimension. */
export const EMBED_TIERS: Record<string, { model: string; dim: number }> = {
  light: { model: 'Xenova/multilingual-e5-small', dim: 384 },
  medium: { model: 'Xenova/multilingual-e5-base', dim: 768 },
  heavy: { model: 'Xenova/multilingual-e5-large', dim: 1024 },
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
  const enabled = get('MEMORY_EMBED_ENABLED', 'embedEnabled') !== '0';
  const cacheDir = get('MEMORY_EMBED_CACHE_DIR', 'embedCacheDir') || path.join(dataDir, 'models');
  // Quantized by default: ~4× lighter to download, negligible quality loss in retrieval.
  const dtype = (get('MEMORY_EMBED_DTYPE', 'embedDtype') || 'q8').toLowerCase();
  // Backfill cadence: throttles the background re-vectorization that runs after a tier switch.
  // Smaller batch + larger delay → lower CPU (gentler on the machine), at the cost of a longer
  // total backfill. Defaults are deliberately mild so a tier switch doesn't peg the CPU.
  const backfillBatch = Math.max(1, Number(get('MEMORY_EMBED_BACKFILL_BATCH', 'embedBackfillBatch')) || 16);
  const backfillDelayMs = Math.max(0, Number(get('MEMORY_EMBED_BACKFILL_DELAY_MS', 'embedBackfillDelayMs')) || 250);
  // ONNX thread cap: default to 25% of the cores so a backfill batch can't peg the machine.
  // Floor of 1 so single/dual-core hosts still run. Overridable via env/file for power users.
  const coreCap = Math.max(1, Math.floor(os.cpus().length * 0.25));
  const threads = Math.max(1, Number(get('MEMORY_EMBED_THREADS', 'embedThreads')) || coreCap);

  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, tier, model, dim, cacheDir, dtype, backfillBatch, backfillDelayMs, threads, dataDir },
  };
}
