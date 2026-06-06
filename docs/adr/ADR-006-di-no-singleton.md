# ADR-006 — Encapsulate model caches + manual DI composition root (no global Singleton)

**Status:** Accepted

## Context

The single-model-per-process invariant was implemented with module-level mutable globals in
`embeddings.ts` and `rerank.ts` (`_pipe`, `_loading`, `_failed`, `_device`, `_tok`, `_model`). These
acted as de-facto singletons: globally reachable, hard to reset, and untestable in isolation
(`singleton.md` lists exactly these downsides — SRP violation, hidden coupling, test friction). Tools
read the embedder's state through free functions (`embedLoaded()`, `embedDevice()`).

## Decision

Encapsulate the load state inside the `EmbedderHost` / `RerankerHost` instances (via `ModelHost`).
Create exactly **one** of each at the composition root (`MemoryServer`) and **inject** them
(constructor injection) into the executors, the backfill loop, and the tool context. `migrate.ts`
creates its own `EmbedderHost`. No global access point and no `getInstance()` — the single-instance
guarantee comes from the composition root creating one, not from a Singleton enforcing it. Tools read
status via the injected `embedder.loaded()` / `embedder.deviceUsed()`.

## Consequences

- **+** State is owned, not global; each host is constructable with explicit deps → unit-testable.
- **+** No hidden cross-module coupling; the dependency graph is visible in one place.
- **−** The instances must be threaded through constructors (the cost of DI without a container).
- **Note:** a DI *framework* was deliberately not added — manual constructor injection via the
  composition root is the idiomatic, lighter realization for a codebase this size.

## Alternatives considered

- **Keep module globals** — rejected: the smell being fixed.
- **A `getInstance()` Singleton** — rejected: same global-coupling/testability problems, plus the SRP
  violation the book calls out.
- **A DI container** — rejected as over-engineering at this scale.
