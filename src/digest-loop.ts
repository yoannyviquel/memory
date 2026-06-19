import type { MemoryConfig } from './config.js';
import type { MemoryStore, MemoryDoc } from './store.js';
import { digestSession, claudeAvailable } from './digest.js';
import { nowIso, uniq } from './memory.js';
import { log, writeStatus } from './log.js';
import { sleep, throttlePause } from './throttle.js';

const DIGEST_INTERVAL_MS = 60_000;
// Drip rate: sessions digested per tick. Keeps the first-run backlog from bursting `claude -p` calls.
const DIGEST_PER_TICK = 3;
// Quota backoff: when `claude -p` reports a usage/rate-limit and gives no reset time, pause for this
// long, doubling on each consecutive hit up to the cap. Reset to 0 on the first success.
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
// Buffer added past a known reset time so we don't reattempt the very instant the window rolls over.
const RESET_BUFFER_MS = 10_000;

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
  // Quota pause: epoch-ms until which we must NOT call `claude -p` (0 = not paused). `backoffMs`
  // holds the current exponential step used when the limit carries no explicit reset time.
  private pausedUntilMs = 0;
  private backoffMs = 0;

  /** Records a usage/rate-limit hit and arms the pause (honoring an explicit reset, else backoff). */
  private pauseForRateLimit(retryAtMs?: number): void {
    const now = Date.now();
    let until: number;
    if (retryAtMs && retryAtMs > now) {
      until = retryAtMs + RESET_BUFFER_MS;
    } else {
      this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
      until = now + this.backoffMs;
    }
    this.pausedUntilMs = until;
    const iso = new Date(until).toISOString();
    log(this.cfg.dataDir, `[digest] usage/rate-limit hit → pausing digests until ${iso}`);
    writeStatus(this.cfg.dataDir, {
      state: 'idle',
      digestPending: this.store.countSessionsNeedingDigest(this.cfg.digest.version),
      digestPausedUntil: iso,
    });
  }

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
    // Quota pause active → skip this tick entirely (don't touch `claude -p` until the window passes).
    if (this.pausedUntilMs && Date.now() < this.pausedUntilMs) return;
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
          loadPercent: this.cfg.loadPercent,
        });
        const t0 = Date.now();
        const outcome = await digestSession({
          session_id: sess.session_id,
          project: sess.project,
          branch: sess.branch,
          model: this.cfg.digest.model,
          turns,
        });
        // Quota exhausted: arm the pause and stop this tick — retrying now would only burn the limit.
        if (outcome.status === 'rate_limited') {
          this.pauseForRateLimit(outcome.retryAtMs);
          return;
        }
        if (outcome.status !== 'ok') continue;
        // A success means the quota is flowing again → clear any prior backoff/pause.
        this.pausedUntilMs = 0;
        this.backoffMs = 0;
        const result = outcome.result;
        const ts = nowIso();
        const base = { session_id: sess.session_id, project: sess.project, branch: sess.branch, ts };
        const digestFiles = uniq(result.insights.flatMap((i) => i.files ?? []));
        const digestDoc: MemoryDoc = {
          type: 'digest',
          ...base,
          summary: result.conclusion,
          source: String(this.cfg.digest.version), // version marker → re-digest selector
          files_modified: digestFiles,
          satisfaction: result.satisfaction,
          mood: result.mood,
        };
        const insightDocs: MemoryDoc[] = result.insights.map((ins) => ({
          type: 'insight',
          ...base,
          summary: ins.text,
          assistant_text: ins.text,
          source: ins.kind, // decision | bugfix | discovery | conclusion
          files_modified: ins.files ?? [],
          // Insights inherit the session's satisfaction so the weighting applies to them too.
          satisfaction: result.satisfaction,
        }));
        this.store.writeDigest(sess.session_id, digestDoc, insightDocs);
        log(
          this.cfg.dataDir,
          `[digest] ${sess.session_id} → ${result.insights.length} insights${
            result.costUsd != null ? ` ($${result.costUsd.toFixed(4)})` : ''
          }`,
        );
        // Duty-cycle throttle: pace the digests (and the re-vectorization they trigger) so memory
        // uses the device only ~loadPercent of the time (no-op at 100%).
        const pause = throttlePause(Date.now() - t0, this.cfg.loadPercent);
        if (pause > 0) await sleep(pause);
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
