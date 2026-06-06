import type { MemoryConfig } from './config.js';
import type { MemoryStore, MemoryDoc } from './store.js';
import { digestSession, claudeAvailable } from './digest.js';
import { nowIso, uniq } from './memory.js';
import { log, writeStatus } from './log.js';

const DIGEST_INTERVAL_MS = 60_000;
// Drip rate: sessions digested per tick. Keeps the first-run backlog from bursting `claude -p` calls.
const DIGEST_PER_TICK = 3;

/**
 * Leader-only background LLM compression: turns completed sessions into a typed `digest` + `insight`
 * docs (decisions/bugfixes/discoveries/conclusions) via `claude -p`. Decoupled from the hooks through
 * the DB — same pattern as the backfill. Drip-limited and best-effort: a missing `claude` binary or a
 * parse failure just skips the session (raw turns stay searchable). Subscribes to the
 * {@link LeaderCoordinator} ({@link start} on `becameLeader`, {@link stop} on `lostLeadership`).
 */
export class DigestLoop {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private warnedNoClaude = false;

  constructor(
    private readonly store: MemoryStore,
    private readonly cfg: MemoryConfig,
  ) {}

  /** Kicks one pass now and every interval afterwards. */
  start(): void {
    if (this.timer || !this.cfg.digest.enabled) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), DIGEST_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One drip of digests (up to DIGEST_PER_TICK sessions). Best-effort: never blocks the server. */
  async run(): Promise<void> {
    if (this.running || !this.cfg.digest.enabled) return;
    // No native `claude` binary → digests can't run. Log once; raw memory stays fully functional.
    if (!claudeAvailable()) {
      if (!this.warnedNoClaude) {
        this.warnedNoClaude = true;
        log(this.cfg.dataDir, '[digest] disabled: no native `claude` binary found on PATH (~/.local/bin)');
      }
      return;
    }
    this.running = true;
    try {
      const sessions = this.store.sessionsNeedingDigest(this.cfg.digest.version, DIGEST_PER_TICK);
      for (const sess of sessions) {
        const turns = this.store.turnsForSession(sess.session_id);
        if (turns.length === 0) continue;
        writeStatus(this.cfg.dataDir, {
          state: 'digesting',
          digestPending: this.store.countSessionsNeedingDigest(this.cfg.digest.version),
        });
        const result = await digestSession({
          session_id: sess.session_id,
          project: sess.project,
          branch: sess.branch,
          model: this.cfg.digest.model,
          turns,
        });
        if (!result) continue;
        const ts = nowIso();
        const base = { session_id: sess.session_id, project: sess.project, branch: sess.branch, ts };
        const digestFiles = uniq(result.insights.flatMap((i) => i.files ?? []));
        const digestDoc: MemoryDoc = {
          type: 'digest',
          ...base,
          summary: result.conclusion,
          source: String(this.cfg.digest.version), // version marker → re-digest selector
          files_modified: digestFiles,
        };
        const insightDocs: MemoryDoc[] = result.insights.map((ins) => ({
          type: 'insight',
          ...base,
          summary: ins.text,
          assistant_text: ins.text,
          source: ins.kind, // decision | bugfix | discovery | conclusion
          files_modified: ins.files ?? [],
        }));
        this.store.writeDigest(sess.session_id, digestDoc, insightDocs);
        log(
          this.cfg.dataDir,
          `[digest] ${sess.session_id} → ${result.insights.length} insights${
            result.costUsd != null ? ` ($${result.costUsd.toFixed(4)})` : ''
          }`,
        );
      }
    } catch {
      /* best-effort: never block the server */
    } finally {
      this.running = false;
      const remaining = this.store.countSessionsNeedingDigest(this.cfg.digest.version);
      if (remaining === 0) writeStatus(this.cfg.dataDir, { state: 'idle', digestPending: 0 });
    }
  }
}
