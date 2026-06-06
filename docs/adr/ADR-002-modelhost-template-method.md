# ADR-002 — `ModelHost` Template Method for model load + fallback

**Status:** Accepted

## Context

`embeddings.ts` (`getPipe`) and `rerank.ts` (`getReranker`) shared ~95% identical logic: import
transformers.js, point it at the cache, cap the ONNX threads, then `attempt(device, dtype)` with a
warmup inference and, on failure, fall back to `cpu`/`fp32` — all behind a once-per-process load
promise with a `failed` latch. Only the model construction (feature-extraction pipeline vs.
sequence-classification model + tokenizer), the session options, and the logging differed. The shared
state lived in two parallel sets of module globals (`_pipe/_loading/_failed/_device`,
`_tok/_model/_loading/_failed`).

## Decision

Introduce an abstract `ModelHost<TModel>` (`template-method.md`) whose `load()` is the invariant
skeleton (import + cache + thread cap + attempt/warmup/fallback + promise guard + latch). Subclasses
override the varying steps: `sessionOptions()`, `beforeAttempts()` (one-time logging / status /
tokenizer load), `build()`, `warmup()`, `afterLoad()`, `onLoadError()`. `EmbedderHost` and
`RerankerHost` extend it. The load state is encapsulated as protected instance fields.

The OOP class hierarchy was chosen over a higher-order `loadWithFallback(fn)` function because the
project opted for an OOP/DI style; the hosts are already objects with their own public API
(`embed`/`embedBatch`, `rerank`).

## Consequences

- **+** The duplicated ~40 lines exist once; a future third model reuses the skeleton.
- **+** Load state is encapsulated, not global.
- **−** Five override hooks make the control flow span base + subclass (inherent to Template Method).
- **−** Risk of an LSP slip if a subclass under-implements a step — mitigated by the E2E net.

## Alternatives considered

- **Higher-order `loadWithFallback(build, warmup, …)`** — idiomatic in functional TS and lighter, but
  inconsistent with the chosen OOP/DI direction; rejected for style coherence.
- **Leave the duplication** — rejected: the two copies had already drifted (session options differ).
