---
name: memory:status
description: Diagnose the state of the memories SQLite database
---

# memory status

Checks the state of the memory system.

Steps:
1. Call the MCP tool **`memory_stats`** (no argument required).
2. Report:
   - the path of the SQLite database,
   - the total number of documents,
   - the breakdown by `type` (observation / prompt / turn / session),
   - the breakdown by `project` (top projects),
   - the state of the vector index (enabled/disabled, indexed vs pending),
   - the embedding model and whether it is loaded.
3. To diagnose a slow startup or a stuck model download, point to
   the log `~/.claude-memory/logs/memory.log` (`[server]` / `[embed] download …%` lines).

## Presence reminder in the status line (optional)

The server writes `~/.claude-memory/status.json` and a ready-to-use snippet
`~/.claude-memory/statusline.mjs`. To permanently show "🧠 mem" (a reminder that the
plugin is active and indexing in the background), add to `settings.json`:

```json
{ "statusLine": { "type": "command", "command": "node ~/.claude-memory/statusline.mjs" } }
```

The bar shows `🧠 mem` when idle, `🧠 mem ⚙` during indexing, `🧠 mem ⏳x%` during
a model download. (It refreshes on conversation activity, not continuously.)
</content>
