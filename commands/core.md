---
name: memory:core
description: Manage core memories — primordial facts injected into every session at load
---

# Core memories

**Core memories** are primordial facts injected into the context at the **start of every session**
(above the recent digests). Use them for things Claude must always know: key conventions, critical
paths, deploy steps, durable decisions.

Two ways they get created:
1. **Explicit** — the user asks to remember something important ("retiens ça", "core memory: …").
2. **Proposed** — when a fact keeps recurring across memories, Claude proposes it and, **only after
   the user agrees**, saves it.

User argument: `$ARGUMENTS`. Interpret:
- empty or `list` → list current core memories (`memory_core_list`).
- `suggest` → call `memory_core_suggest`, review the signals, and **propose** 1–3 candidate core
  memories to the user (do NOT save without agreement).
- `remove <id>` → confirm, then `memory_core_remove`.
- anything else (free text) → treat as a fact to save: confirm scope (global vs this project),
  then `memory_core_add` (pass `project` only if the user wants it scoped).

Guidance:
- Keep each core memory to **one concise, durable sentence**. Prefer global unless clearly
  project-specific.
- Before adding, check `memory_core_list` to avoid duplicates.
- Proactive proposal: when you notice (e.g. via `memory_core_suggest` or during work) a fact that
  recurs across many sessions/memories and clearly matters long-term, **propose** it as a core
  memory — never create one silently.
