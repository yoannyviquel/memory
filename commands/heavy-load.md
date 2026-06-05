---
name: memory:heavy-load
description: Switch the embedding tier to heavy (multilingual-e5-large, 1024d, ~560 MB) — max quality, slower
---

# Memory → heavy tier

Switches the semantic embedding model to the **heavy** tier (max quality, highest CPU/RAM).

| Tier | Model | Dim | Size (q8) |
|---|---|---|---|
| `heavy` | multilingual-e5-large | 1024 | ~560 MB |

Steps:
1. Write/merge `~/.claude-memory/config.json` (real path: `$USERPROFILE/.claude-memory/config.json`)
   with `{"embedTier":"heavy"}` — **preserve any other keys** already present.
2. Tell the user:
   - run `/reload-plugins` to apply (the MCP server restarts);
   - changing tier changes the model AND the dimension → old vectors are cleared and
     **re-vectorized in the background** (docs stay searchable via BM25 meanwhile);
   - the model downloads once in q8 (~560 MB), in the background; progress in
     `~/.claude-memory/logs/memory.log` (and `~/.claude-memory/status.json`).
3. Note: a system env var `MEMORY_EMBED_TIER` / `MEMORY_EMBED_MODEL` overrides the file. If the
   tier doesn't change after reload, check for those (`/memory:status`).
