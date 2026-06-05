---
name: memory:xultra-load
description: Switch the embedding tier to xultra (Qwen3-Embedding-0.6B, 1024d) — top multilingual quality, experimental
---

# Memory → xultra tier

Switches the semantic embedding model to **xultra**: **Qwen3-Embedding-0.6B** (2025), a top-ranked
multilingual retrieval model. Uses **last-token pooling** and a **query-side instruction prefix**
(documents stay raw — handled automatically). Heaviest tier alongside ultra.

| Tier | Model | Dim | Pooling | Query prefix | Size |
|---|---|---|---|---|---|
| `xultra` | Qwen3-Embedding-0.6B | 1024 | last_token | yes (auto) | ~600 MB+ |

Steps:
1. Write/merge `~/.claude-memory/config.json` (real path: `$USERPROFILE/.claude-memory/config.json`)
   with `{"embedTier":"xultra"}` — **preserve any other keys** already present.
2. Tell the user:
   - run `/reload-plugins` to apply (the MCP server restarts);
   - changing tier changes the model (and pooling) → old vectors are cleared and **re-vectorized in
     the background** (docs stay searchable via BM25 meanwhile);
   - the model downloads once (~600 MB+), in the background; progress in
     `~/.claude-memory/logs/memory.log` (and `~/.claude-memory/status.json`);
   - **experimental**: the ONNX port is newer than bge-m3 (`ultra`) and a few users have reported
     issues — if embeddings misbehave, fall back to `ultra` or `heavy`.
3. Note: a system env var `MEMORY_EMBED_TIER` / `MEMORY_EMBED_MODEL` overrides the file. If the tier
   doesn't change after reload, check for those (`/memory:status`).
