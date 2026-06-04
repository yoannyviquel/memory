---
name: memory:search
description: Full-text search (BM25) in session memories
---

# Search the memories

Uses the MCP tool `memory_search` to query the session memories (local SQLite).

Arguments provided by the user: `$ARGUMENTS`

Steps:
1. Call the MCP tool **`memory_search`** with:
   - `query` = the text provided in `$ARGUMENTS` (required).
   - `project` = name of the current project (basename of the directory) to limit to the current project; otherwise empty.
   - `limit` = 10 by default.
   - `type` = optional (`turn` | `observation` | `prompt` | `session`).
2. Present the results compactly: project, date, type and summary for each hit.
3. If no result, suggest `/memory:status` to check the state of the database.
</content>
