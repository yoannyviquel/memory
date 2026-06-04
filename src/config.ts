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

/** Paliers d'embedding multilingues (famille e5). Chaque palier fixe modèle + dimension cohérents. */
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
 * Charge la configuration. Priorité : variable d'environnement > fichier
 * `<dataDir>/config.json` > défaut. Le fichier permet de configurer sans dépendre du
 * mécanisme `${}` des plugins (peu fiable quand un champ est laissé vide).
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
  // Quantifié par défaut : ~4× plus léger à télécharger, perte de qualité négligeable en retrieval.
  const dtype = (get('MEMORY_EMBED_DTYPE', 'embedDtype') || 'q8').toLowerCase();

  return {
    dbPath,
    dataDir,
    contextLimit,
    embed: { enabled, model, dim, cacheDir, dtype, dataDir },
  };
}
