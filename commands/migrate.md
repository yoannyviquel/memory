---
name: memory:migrate
description: Migre l'historique claude-mem (SQLite) vers la base memory
---

# Migration claude-mem → memory

Importe les mémoires déjà capturées par claude-mem dans la base SQLite de ce plugin. Lecture
seule sur la base claude-mem (jamais modifiée). Idempotent.

Marche à suivre :
1. **Dry-run d'abord** (Bash) :
   `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/migrate.js" --dry-run`
   Rapporte le nombre de lignes lues par table et le nombre de documents qui seraient importés.
2. Demande confirmation à l'utilisateur.
3. **Migration réelle** :
   `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/migrate.js"`
   Rapporte le récap final (lus / indexés / erreurs).

Options :
- `--db <chemin>` : base claude-mem source (défaut `~/.claude-mem/claude-mem.db`).
- `--project <nom>` : force le `project` de tous les docs migrés.
- `--batch <n>` : taille des lots (défaut 500).
- `--dry-run` : compte sans écrire.

Documents migrés préfixés `migrated:` → relançable sans doublon.
