---
name: memory:migrate
description: Migrate the claude-mem history (SQLite) to the memory database
---

# Migration claude-mem → memory

Imports the memories already captured by claude-mem into this plugin's SQLite database. Read-only
on the claude-mem database (never modified). Idempotent.

Steps:
1. **Dry-run first** (Bash):
   `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/migrate.js" --dry-run`
   Reports the number of rows read per table and the number of documents that would be imported.
2. Ask the user for confirmation.
3. **Actual migration**:
   `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/migrate.js"`
   Reports the final recap (read / indexed / errors).

Options:
- `--db <path>`: source claude-mem database (default `~/.claude-mem/claude-mem.db`).
- `--project <name>`: force the `project` of all migrated docs.
- `--batch <n>`: batch size (default 500).
- `--dry-run`: count without writing.

Migrated documents prefixed `migrated:` → re-runnable without duplicates.
</content>
