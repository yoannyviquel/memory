# ADR-003 — `QueryExecutor` Strategy for leader vs. follower

**Status:** Accepted

## Context

`embedQuery` and `rerankQuery` each branched on `amLeader`: the leader runs the model locally, a
follower posts to the leader's loopback service. The same `if (amLeader) … else readLock → remote …`
shape was repeated, and the decision was re-evaluated on every call against a mutable global.

## Decision

Extract the two behaviors behind a `QueryExecutor` interface (`strategy.md`) with `embedQuery` and
`rerankQuery`: `LocalExecutor` (delegates to the in-process `EmbedderHost`/`RerankerHost`) and
`RemoteExecutor` (reads the lock endpoint and posts to the loopback service). `MemoryServer` holds the
active strategy and swaps it on leadership transitions (Local when leader, Remote otherwise). The
common guards (`embed.enabled`/`vectorEnabled`, `rerank.enabled`/`docs.length`) stay in the
`MemoryServer` wrappers; tools call those wrappers and never see the leader/follower distinction.

## Consequences

- **+** The conditional is gone; adding a path (e.g. a future direct-IPC executor) needs no edits to
  callers (OCP).
- **+** The remote arm is now isolated and unit-coverable; an E2E test (1.2) exercises it directly.
- **−** A swap-on-transition model differs subtly from the original per-call check; equivalent for a
  healthy leader (stays Local) and a follower (stays Remote).

## Alternatives considered

- **State pattern** — leadership is a state machine, but the states don't drive each other's
  transitions (the `LeaderCoordinator` does); Strategy is the lighter fit. Rejected.
- **Keep the inline guards** — rejected: leaves the duplicated branching.
