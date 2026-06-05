---
name: memory:config
description: Configure the embedding model tier (light / medium / heavy)
---

# Config memory — embedding tier

Selects the semantic embedding model. Three multilingual tiers (e5 family):

| Tier | Model | Dim | Size (q8) | Use |
|---|---|---|---|---|
| `light` | multilingual-e5-small | 384 | ~120 MB | default, fast |
| `medium` | multilingual-e5-base | 768 | ~280 MB | best FR trade-off |
| `heavy` | multilingual-e5-large | 1024 | ~560 MB | max quality, slower |

> Models are loaded in **q8 (quantized)** by default: ~4× lighter to download
> than fp32, for a negligible quality loss in semantic search. Force full
> precision: `MEMORY_EMBED_DTYPE=fp32` (or `embedDtype` in `config.json`).

User argument: `$ARGUMENTS` (expected: `light`, `medium`, `heavy`, or empty to show the state).

Steps:
1. If `$ARGUMENTS` is empty: call `memory_stats` and report the current model/tier + the 3 options.
2. If `$ARGUMENTS` ∈ {light, medium, heavy}: write/merge the file `~/.claude-memory/config.json`
   (real path: `$USERPROFILE/.claude-memory/config.json`) with `{"embedTier":"<value>"}` —
   preserving any other keys.
3. Warn the user:
   - run `/reload-plugins` to apply (the MCP server restarts);
   - **changing tier changes the model AND the dimension** → the old vectors are automatically
     cleared and **re-vectorized in the background** (documents stay searchable via BM25 in the meantime);
   - the new model is downloaded once, in q8 (~120 to 560 MB depending on the tier). The
     download happens **in the background** by the MCP server (non-blocking); its progress
     is traced in `~/.claude-memory/logs/memory.log` and reflected in `~/.claude-memory/status.json`.

Note: the tier from `config.json` (written by this command) takes precedence over the install-time
`${user_config.embedTier}` env. Hard override: `MEMORY_EMBED_MODEL` + `MEMORY_EMBED_DIM`.
</content>
