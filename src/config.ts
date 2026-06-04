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

  const dbPath = get('MEMORY_DB_PATH', 'dbPath') || path.join(dataDir, 'memories.db');
  const contextLimit = Number(get('MEMORY_CONTEXT_LIMIT', 'contextLimit')) || 10;

  const tier = (get('MEMORY_EMBED_TIER', 'embedTier') || DEFAULT_TIER).toLowerCase();
  const picked = EMBED_TIERS[tier] ?? EMBED_TIERS[DEFAULT_TIER];
  const model = get('MEMORY_EMBED_MODEL', 'embedModel') || picked.model;
  const dim = Number(get('MEMORY_EMBED_DIM', 'embedDim')) || picked.dim;
  const enabled = get('MEMORY_EMBED_ENABLED', 'embedEnabled') !== '0';
  const cacheDir = get('MEMORY_EMBED_CACHE_DIR', 'embedCacheDir') || path.join(dataDir, 'models');
  // Quantized by default: ~4× lighter to download, negligible quality loss in retrieval.
  const dtype = (get('MEMORY_EMBED_DTYPE', 'embedDtype') || 'q8').toLowerCase();

  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, model, dim, cacheDir, dtype, dataDir },
  };
}
