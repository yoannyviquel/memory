---
name: memory:status
description: Diagnostique l'état de la base SQLite des mémoires
---

# État memory

Vérifie l'état du système de mémoire.

Marche à suivre :
1. Appelle l'outil MCP **`memory_stats`** (aucun argument requis).
2. Rapporte :
   - le chemin de la base SQLite,
   - le nombre total de documents,
   - la répartition par `type` (observation / prompt / turn / session),
   - la répartition par `project` (top projets),
   - l'état de l'index vectoriel (activé/désactivé, indexés vs en attente),
   - le modèle d'embedding et s'il est chargé.
3. Pour diagnostiquer un démarrage lent ou un téléchargement de modèle figé, indique
   le journal `~/.claude-memory/logs/memory.log` (lignes `[server]` / `[embed] download …%`).

## Rappel de présence dans la status line (optionnel)

Le serveur écrit `~/.claude-memory/status.json` et un snippet prêt à l'emploi
`~/.claude-memory/statusline.mjs`. Pour afficher en permanence « 🧠 mem » (rappel que le
plugin est actif et indexe en fond), ajouter à `settings.json` :

```json
{ "statusLine": { "type": "command", "command": "node ~/.claude-memory/statusline.mjs" } }
```

La barre affiche `🧠 mem` au repos, `🧠 mem ⚙` pendant une indexation, `🧠 mem ⏳x%` pendant
le téléchargement d'un modèle. (Elle se rafraîchit sur activité de conversation, pas en continu.)
