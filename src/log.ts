import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Répertoire des logs (sous le dataDir, à côté de la base et des modèles). */
export function logDir(dataDir: string): string {
  return path.join(dataDir, 'logs');
}

const MAX_LOG_BYTES = 1_000_000;

/**
 * Journalisation best-effort vers `<dataDir>/logs/memory.log`. Rotation simple à 1 Mo
 * (un seul fichier de backup `.1`). Ne jette jamais : un échec de log ne doit pas casser
 * le serveur ni un hook.
 */
export function log(dataDir: string, msg: string): void {
  try {
    const dir = logDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'memory.log');
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* rotation best-effort */
    }
    appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch {
    /* best-effort */
  }
}

export type MemState = 'idle' | 'loading' | 'downloading' | 'backfilling';

export interface MemStatus {
  state: MemState;
  model?: string;
  /** % de téléchargement courant (état downloading). */
  progress?: number;
  file?: string;
  vectorized?: number;
  missing?: number;
  updatedAt: string;
}

/** Chemin du fichier d'état lu par le snippet statusLine. */
export function statusPath(dataDir: string): string {
  return path.join(dataDir, 'status.json');
}

/** Écrit/merge l'état courant du plugin (best-effort) pour la status line et le diagnostic. */
export function writeStatus(dataDir: string, patch: Partial<MemStatus>): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = statusPath(dataDir);
    let cur: Record<string, unknown> = {};
    try {
      cur = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* premier écrit / fichier absent */
    }
    writeFileSync(file, JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() }));
  } catch {
    /* best-effort */
  }
}
