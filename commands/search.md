---
name: memory:search
description: Recherche full-text (BM25) dans les mémoires de session
---

# Rechercher dans les mémoires

Utilise l'outil MCP `memory_search` pour interroger les mémoires de session (SQLite local).

Arguments fournis par l'utilisateur : `$ARGUMENTS`

Marche à suivre :
1. Appelle l'outil MCP **`memory_search`** avec :
   - `query` = le texte fourni dans `$ARGUMENTS` (obligatoire).
   - `project` = nom du projet courant (basename du répertoire) pour limiter au projet courant ; sinon vide.
   - `limit` = 10 par défaut.
   - `type` = optionnel (`turn` | `observation` | `prompt` | `session`).
2. Présente les résultats de façon compacte : projet, date, type et résumé pour chaque hit.
3. Si aucun résultat, suggère `/memory:status` pour vérifier l'état de la base.
