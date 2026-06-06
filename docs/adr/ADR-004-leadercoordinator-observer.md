# ADR-004 — `LeaderCoordinator` Observer for leadership transitions

**Status:** Accepted

## Context

Leadership logic was spread across `syncLeadership()`, the heartbeat timer, the `fs.watch` callback,
and an `amLeader !== was` block that kicked the backfill/digest loops. Reactions to "became leader"
were inlined among the election mechanics, and the loopback-service start was interleaved with the
lock refresh. Adding a reaction meant editing the election code.

## Decision

Wrap the election (`leader.ts` lock primitives) in a `LeaderCoordinator` that extends Node's
`EventEmitter` (`observer.md`). It owns the heartbeat and the lock-file watch, and emits
`becameLeader` / `lostLeadership` on transitions. `MemoryServer` subscribes: on `becameLeader` it
swaps the executor to Local, starts the loopback service (publishing the endpoint back via
`publishEndpoint`), and starts the loops; on `lostLeadership` it swaps to Remote and stops them. The
lock primitives (`refreshLeadership`/`releaseLeadership`/`readLock`) and STALE_MS/heartbeat timings
are unchanged.

## Consequences

- **+** Election mechanics and reactions are decoupled; new subscribers need no change to the
  coordinator (OCP).
- **+** The failover path (release on exit + fs.watch) is encapsulated and still covered by E2E 1.1.
- **−** Event-driven flow is slightly less linear to read than the original inline sequence.
- **−** `lostLeadership` rarely fires for a healthy leader (it renews every 30 s) — the handler is
  defensive rather than hot.

## Alternatives considered

- **Mediator** — overkill for a one-publisher / few-subscribers fan-out; Observer suffices. Rejected.
- **Keep `syncLeadership()` inline** — rejected: that was the tangle being removed.
