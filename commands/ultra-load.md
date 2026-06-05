---
name: memory:ultra-load
description: Switch the embedding tier to ultra (bge-m3, 1024d, ~600 MB) — strongest local multilingual, heaviest
---

# Memory → ultra tier

Switches the semantic embedding model to the **ultra** tier: **bge-m3** (BAAI), the strongest
multilingual retrieval model runnable locally. Heaviest on CPU/RAM (and the load spike), best quality.

| Tier | Model | Dim | Pooling | Size (q8) |
|---|---|---|---|---|
| `ultra` | bge-m3 (XLM-R based) | 1024 | CLS | ~600 MB |

Steps:
1. Write/merge `~/.claude-memory/config.json` (real path: `$USERPROFILE/.claude-memory/config.json`)
   with `{"embedTier":"ultra"}` — **preserve any other keys** already present.
2. Tell the user:
   - run `/reload-plugins` to apply (the MCP server restarts);
   - changing tier changes the model (and pooling) → old vectors are cleared and **re-vectorized in
     the background** (docs stay searchable via BM25 meanwhile);
   - the model downloads once in q8 (~600 MB), in the background; progress in
     `~/.claude-memory/logs/memory.log` (and `~/.claude-memory/status.json`);
   - this is the heaviest tier: the model-load RAM spike is higher than heavy, and it uses up to
     100% of the cores while vectorizing.
3. Note: a system env var `MEMORY_EMBED_TIER` / `MEMORY_EMBED_MODEL` overrides the file. If the tier
   doesn't change after reload, check for those (`/memory:status`).
