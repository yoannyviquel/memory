---
name: memory:delete
description: Delete memories by filter (id prefix / project / type) — destructive
---

# Delete memories

**Destructive.** Removes memories matching a filter (and their vectors). Filters combine with AND;
at least one is required — there is no "delete all" shortcut.

User argument: `$ARGUMENTS`. Free-form; interpret into one or more filters:
- a bare word like `migrated` or `migrated:` → `idPrefix: "migrated:"` (claude-mem imports)
- `project=<name>` → `project`
- `type=<observation|prompt|turn|session|digest|insight>` → `type`

Steps:
1. Parse `$ARGUMENTS` into `{ idPrefix?, project?, type? }`. If nothing parses, ask the user what to delete.
2. **Confirm before deleting**: call `memory_stats` (or describe the filter) and tell the user roughly
   what will be removed, then ask for explicit confirmation.
3. On confirmation, call `memory_delete` with the parsed filters and report the count.

Common use — re-importing claude-mem cleanly:
1. `/memory:delete migrated:` → removes all claude-mem imports.
2. Re-run `/memory:migrate` (the migration now produces `digest` + `insight` docs directly from
   claude-mem's compressed data — no LLM cost).

Note: deleting `digest`/`insight` docs is also fine — the background digest loop will regenerate
native ones from sessions that still have `turn` docs.
