# ADR-001 — Decompose the server god module via a Facade + SRP units

**Status:** Accepted

## Context

`server.ts` had grown to ~444 lines and mixed unrelated concerns in a single 202-line `main()`:
leader election, background backfill, background digests, the MCP server + tool dispatch, the
loopback service lifecycle, OS process renaming, query embed/rerank wiring, signal handling, and the
fs.watch failover. The concerns shared mutable module globals (`backfilling`, `amLeader`,
`myEmbedPort`, `myEmbedToken`), which made the control flow hard to follow and impossible to unit-test
in isolation.

## Decision

Split the responsibilities into focused units and introduce `MemoryServer` as a **Facade /
composition root** (`facade.md`). `MemoryServer` owns the dependency graph and the leadership
lifecycle and exposes a single `start()`. The extracted units are `EmbedderHost`/`RerankerHost`
(model hosting), `QueryExecutor` (embed/rerank strategy), `LeaderCoordinator` (election + events),
`BackfillLoop`/`DigestLoop` (background jobs), and `process-name.ts` (cosmetic renaming).
`server.ts` is reduced to a thin entrypoint (`loadConfig → new MemoryStore → new MemoryServer().start()`).

Files are kept **flat under `src/`** rather than moved into subfolders: the same SRP decomposition
without the cross-file import churn, keeping the refactor diff reviewable and iso-comportement.

## Consequences

- **+** Each unit has one responsibility; `main()` is gone; the wiring is readable top-to-bottom.
- **+** Units are independently constructable (constructor injection) → testable in principle.
- **+** Leadership reactions live behind events instead of scattered `if (amLeader)` checks.
- **−** More files and one extra indirection layer (the facade) for a small codebase.
- **−** The flat layout means `src/` has ~25 files; a future move to folders is still possible.

## Alternatives considered

- **Keep a single file, just extract functions** — rejected: the shared mutable globals would remain.
- **Subfolder layout (`model/`, `query/`, `leader/`, …)** — deferred: equivalent clarity but large
  import churn and a noisier diff on a working system; revisit if `src/` keeps growing.
