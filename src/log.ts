import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Logs directory (under dataDir, next to the database and the models). */
export function logDir(dataDir: string): string {
  return path.join(dataDir, 'logs');
}

const MAX_LOG_BYTES = 1_000_000;

/**
 * Best-effort logging to `<dataDir>/logs/memory.log`. Simple rotation at 1 MB
 * (a single backup file `.1`). Never throws: a logging failure must not break
 * the server or a hook.
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

export type MemState = 'idle' | 'loading' | 'downloading' | 'backfilling' | 'digesting';

export interface MemStatus {
  state: MemState;
  model?: string;
  /** current download % (downloading state). */
  progress?: number;
  file?: string;
  vectorized?: number;
  missing?: number;
  /** sessions still awaiting an LLM digest (digesting state). */
  digestPending?: number;
  /** ISO time until which digesting is paused after a `claude -p` usage/rate-limit (quota). */
  digestPausedUntil?: string;
  /** active background-load cap (duty-cycle %); <100 means the loops are pacing themselves. */
  loadPercent?: number;
  updatedAt: string;
}

/** Path of the state file read by the statusLine snippet. */
export function statusPath(dataDir: string): string {
  return path.join(dataDir, 'status.json');
}

/** Writes/merges the plugin's current state (best-effort) for the status line and diagnostics. */
export function writeStatus(dataDir: string, patch: Partial<MemStatus>): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = statusPath(dataDir);
    let cur: Record<string, unknown> = {};
    try {
      cur = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* first write / file absent */
    }
    writeFileSync(file, JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() }));
  } catch {
    /* best-effort */
  }
}
