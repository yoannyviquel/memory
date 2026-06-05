---
name: memory:medium-load
description: Switch the embedding tier to medium (multilingual-e5-base, 768d, ~280 MB) — best trade-off
---

# Memory → medium tier

Switches the semantic embedding model to the **medium** tier (best French trade-off).

| Tier | Model | Dim | Size (q8) |
|---|---|---|---|
| `medium` | multilingual-e5-base | 768 | ~280 MB |

Steps:
1. Write/merge `~/.claude-memory/config.json` (real path: `$USERPROFILE/.claude-memory/config.json`)
   with `{"embedTier":"medium"}` — **preserve any other keys** already present.
2. Tell the user:
   - run `/reload-plugins` to apply (the MCP server restarts);
   - changing tier changes the model AND the dimension → old vectors are cleared and
     **re-vectorized in the background** (docs stay searchable via BM25 meanwhile);
   - the model downloads once in q8 (~280 MB), in the background; progress in
     `~/.claude-memory/logs/memory.log` (and `~/.claude-memory/status.json`).
3. Note: a system env var `MEMORY_EMBED_TIER` / `MEMORY_EMBED_MODEL` overrides the file. If the
   tier doesn't change after reload, check for those (`/memory:status`).
