---
name: memory:reindex
description: Force reprocessing — rebuild vectors and/or regenerate LLM digests
---

# Reindex memory

Forces the background loops to reprocess existing memories. Both actions are idempotent and
non-blocking (BM25 stays available throughout); they only clear data so the background loops
refill it:

- **vectors** → empties the vector index; the server's *backfill* re-vectorizes every document.
- **digests** → deletes all `digest` + `insight` docs; the *digest loop* re-compresses every
  session via `claude -p --bare` (your default model).

User argument: `$ARGUMENTS` (expected: `vectors`, `digests`, `all`, or empty = all).

Steps:
1. Map `$ARGUMENTS` to the `memory_reindex` tool arguments:
   - empty or `all` → call `memory_reindex` with no arguments (does both);
   - `vectors` → `{ "vectors": true }`;
   - `digests` → `{ "digests": true }`.
2. Call the `memory_reindex` MCP tool and report what it cleared.
3. Remind the user:
   - reprocessing happens **in the background** by the MCP server (non-blocking);
   - progress shows in `~/.claude-memory/status.json` (`backfilling` / `digesting`) and the log
     `~/.claude-memory/logs/memory.log`;
   - digests consume tokens from the Claude Code plan (one `claude -p` call per session).

When to use: after improving the digest prompt (bump `DIGEST_VERSION`) or the embed text
(bump `EMBED_TEXT_VERSION`), or to redo everything from scratch (e.g. testing a rollback).
