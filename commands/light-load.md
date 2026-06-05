---
name: memory:light-load
description: Switch the embedding tier to light (multilingual-e5-small, 384d, ~120 MB) — fastest, lowest CPU
---

# Memory → light tier

Switches the semantic embedding model to the **light** tier (lowest CPU/RAM).

| Tier | Model | Dim | Size (q8) |
|---|---|---|---|
| `light` | multilingual-e5-small | 384 | ~120 MB |

Steps:
1. Write/merge `~/.claude-memory/config.json` (real path: `$USERPROFILE/.claude-memory/config.json`)
   with `{"embedTier":"light"}` — **preserve any other keys** already present.
2. Tell the user:
   - run `/reload-plugins` to apply (the MCP server restarts);
   - changing tier changes the model AND the dimension → old vectors are cleared and
     **re-vectorized in the background** (docs stay searchable via BM25 meanwhile);
   - the model downloads once in q8 (~120 MB), in the background; progress in
     `~/.claude-memory/logs/memory.log` (and `~/.claude-memory/status.json`).
3. Note: a system env var `MEMORY_EMBED_TIER` / `MEMORY_EMBED_MODEL` overrides the file. If the
   tier doesn't change after reload, check for those (`/memory:status`).
