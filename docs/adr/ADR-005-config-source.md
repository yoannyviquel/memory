# ADR-005 — `ConfigSource` data-driven config resolution

**Status:** Accepted

## Context

`loadConfig()` repeated the env-vs-file precedence boilerplate ~20 times via two inline closures
(`get`, `getFileFirst`) plus manual `Number(...) || def` and `... !== '0'` coercions, obscuring the
small amount of derived logic (tier → model/dim, device → dtype, tier → thread fraction, tier →
reranker).

## Decision

Encapsulate the precedence in a small `ConfigSource` class holding the parsed file, with `get`
(env > file), `fileFirst` (file > env, for the tier exception), `num`, and `flag` (`!== '0'`) helpers.
`loadConfig()` becomes a flat list of `src.*(...)` reads; the derived logic stays explicit (it doesn't
fit a flat descriptor table cleanly). The resolution **semantics are preserved exactly** — including
the `${...}`-placeholder guard and the `??` nullish chain for `queryPrefix`.

## Consequences

- **+** The boilerplate exists once; each setting reads as one typed line.
- **+** The tier's documented file > env exception is a named method, not a second closure.
- **−** Not a full descriptor table — derived fields remain hand-written (deliberate, to avoid
  contorting special cases into data).

## Alternatives considered

- **`CONFIG_FIELDS` descriptor table `{env, jsonKey, default, parse}`** — clean for flat fields but
  awkward for the derived ones (dtype depends on device, threads on tier); rejected as over-fitting.
- **Leave `loadConfig()` as-is** — rejected: the repetition was the smell.
