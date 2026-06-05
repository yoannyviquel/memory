import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Single-leader election across the MCP server instances (one per open Claude Code session).
 * Only the leader runs the heavy background work (model load + backfill + digest), so N sessions
 * don't each load the embedding model (~hundreds of MB) nor each spawn redundant `claude -p` digests
 * (which would multiply the quota cost). Non-leaders stay light and only load the model lazily if
 * the user actually runs a semantic search.
 *
 * Mechanism: a lock file holding {pid, ts}. A leader renews `ts` on a heartbeat; the lock is
 * considered free if its `ts` is stale or its `pid` is dead. No daemon, no socket — just a file.
 */

// Stale threshold ≫ the heartbeat interval so a busy (but alive) leader is never usurped, but low
// enough that a HARD-killed leader (no clean release) is taken over reasonably fast.
const STALE_MS = 90_000;

function lockPath(dataDir: string): string {
  return path.join(dataDir, 'worker.lock');
}

/** True if a process with this pid exists (signal 0 probes without killing). EPERM ⇒ alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Acquire or renew leadership. Returns true if THIS process is the leader after the call.
 * Safe to call repeatedly (heartbeat). A tiny race (two leaders for one cycle) is harmless:
 * digest/backfill writes are idempotent on mem_id.
 */
export interface LockInfo {
  pid?: number;
  ts?: number;
  /** Leader's loopback embedding endpoint (published so non-leaders can route query embeddings). */
  port?: number;
  token?: string;
}

/** Reads the current lock (for non-leaders to find the leader's embedding endpoint). */
export function readLock(dataDir: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Releases leadership IF this process currently holds the lock (pid match). Called on exit/session
 * close so a sibling can take over immediately on its next heartbeat — no waiting for the stale
 * timeout or an unreliable Windows pid-liveness probe. No-op if we're not the lock holder.
 */
export function releaseLeadership(dataDir: string): void {
  try {
    const cur = readLock(dataDir);
    if (cur && cur.pid === process.pid) unlinkSync(lockPath(dataDir));
  } catch {
    /* best-effort */
  }
}

export function refreshLeadership(dataDir: string, extra?: Record<string, unknown>): boolean {
  const file = lockPath(dataDir);
  const now = Date.now();
  const cur = readLock(dataDir);
  if (cur && cur.pid !== process.pid) {
    const fresh = typeof cur.ts === 'number' && now - cur.ts < STALE_MS;
    if (fresh && typeof cur.pid === 'number' && pidAlive(cur.pid)) return false; // someone else leads
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: now, ...(extra ?? {}) }));
    return true;
  } catch {
    return false;
  }
}
