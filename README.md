# memory

Mémoire persistante pour Claude Code, stockée en **SQLite local**, avec recherche **hybride
BM25 + sémantique**. Alternative légère à claude-mem : **base embarquée, embeddings locaux,
zéro serveur, zéro démon, aucun appel LLM/cloud**. Les hooks ne bloquent jamais Claude Code.

## Pourquoi SQLite (et pas Elasticsearch)

SQLite est une base **embarquée** : une lib + un fichier ouvert in-process. Pas de serveur à
installer ni à démarrer. Elasticsearch est un **serveur** (JVM, port, ~1-2 Go RAM) qu'il faut
lancer à côté — exactement le type de dépendance externe (comme Chroma/uvx) qui a rendu claude-mem
fragile. Ici, FTS5 (BM25) et l'index vectoriel (sqlite-vec) sont chargés in-process dans le SQLite
de Node, et les embeddings sont calculés en local par transformers.js — rien à installer à côté.

## Recherche : BM25 + sémantique (hybride)

- **BM25 (FTS5)** : lexical, toujours actif, zéro dépendance. Excellent sur les identifiants
  exacts (fichiers, erreurs, commandes).
- **Sémantique** : embeddings calculés en local (**transformers.js**, modèle ONNX) et stockés dans
  **sqlite-vec**. Trouve par le sens (synonymes, paraphrase) même sans mot commun. Pas de cloud,
  pas de clé, pas de démon. Le modèle est téléchargé une fois (cache local) au 1er usage.
- Les deux classements sont fusionnés (**Reciprocal Rank Fusion**).
- **Si l'embedder est indisponible → recherche en BM25 seul, sans erreur.**

### Architecture des embeddings (important)

Les **hooks sont des process éphémères** : charger un modèle à chaque hook serait trop lent. Donc
les hooks **capturent sans vectoriser** (BM25 immédiat). C'est le **serveur MCP persistant** qui,
en tâche de fond (au démarrage puis toutes les 60 s), vectorise les documents en attente
(*backfill*) — le modèle n'est chargé qu'une fois, dans ce process. Les observations (appels
d'outils, surtout des identifiants) ne sont pas vectorisées : BM25 y suffit.

### Paliers de modèle (multilingue)

Trois paliers, famille **e5** (multilingue, bon en français), via `/memory:config <palier>` ou
le fichier `~/.claude-memory/config.json` (`{"embedTier":"medium"}`) :

| Palier | Modèle | Dim | Taille (q8) | Usage |
|---|---|---|---|---|
| `light` (défaut) | `Xenova/multilingual-e5-small` | 384 | ~120 Mo | rapide |
| `medium` | `Xenova/multilingual-e5-base` | 768 | ~280 Mo | meilleur compromis |
| `heavy` | `Xenova/multilingual-e5-large` | 1024 | ~560 Mo | qualité max |

Les modèles sont chargés en **q8 (quantifié)** par défaut : ~4× plus légers à télécharger qu'en
fp32, pour une perte de qualité négligeable en recherche sémantique. Forcer la pleine précision :
`MEMORY_EMBED_DTYPE=fp32`.

**Changer de palier est sans risque** : le modèle/dimension changeant, les anciens vecteurs sont
automatiquement effacés (détection via une table `meta`) et **revectorisés en tâche de fond** ; les
documents restent cherchables en BM25 entre-temps. Override avancé : env `MEMORY_EMBED_MODEL` +
`MEMORY_EMBED_DIM`.

## Ce que ça fait

- **Capture** automatique via hooks (mêmes événements que claude-mem) :
  - `SessionStart` → **injecte** les mémoires récentes du projet dans le contexte (économie de tokens).
  - `UserPromptSubmit` → indexe le prompt utilisateur.
  - `PostToolUse` → indexe une observation par appel d'outil (outil, fichiers touchés).
  - `Stop` → indexe le tour assistant (texte, outils, fichiers).
  - `SessionEnd` → indexe une synthèse de session.
- **Recherche** via MCP : `memory_search` (hybride), `memory_recent`, `memory_stats`.
- **Migration** de l'historique claude-mem (SQLite) → base memory.

Tous les hooks tournent en `suppressOutput` (aucun bruit dans le contexte), sauf `SessionStart`
qui émet `additionalContext`.

## Prérequis

- **Node ≥ 22.5** (module `node:sqlite` + FTS5 + chargement d'extension). Lancé via `node --no-warnings`.
- Le sémantique fonctionne sans rien installer d'autre (transformers.js + onnxruntime-node prebuilt
  via `npm install` ; modèle téléchargé au 1er usage). Désactivable avec `MEMORY_EMBED_ENABLED=0`.

## Installation

```bash
cd memory
npm install
npm run build      # -> dist/server.js, dist/hook.js, dist/migrate.js, dist/vec0.dll
```

Dans Claude Code (ajouter le dépôt comme marketplace local, puis installer) :

```
/plugin marketplace add C:/tfs/yoannyviquel/memory
/plugin install memory
```

Relance Claude Code (ou `/reload-plugins`) pour activer hooks + serveur MCP.

## Configuration

Deux mécanismes, **l'env est prioritaire sur le fichier** :
- Fichier `~/.claude-memory/config.json`, ex. `{ "embedTier": "medium" }` (clés : `embedTier`,
  `embedEnabled`, `dbPath`, `embedModel`, `embedDim`, `contextLimit`). Modifiable via `/memory:config`.
- Variables d'environnement système (overrides) :

| Variable | Défaut | Rôle |
|---|---|---|
| `MEMORY_EMBED_TIER` | `light` | Palier modèle : `light` / `medium` / `heavy` (voir ci-dessus) |
| `MEMORY_DB_PATH` | `~/.claude-memory/memories.db` | Fichier SQLite des mémoires |
| `MEMORY_DATA_DIR` | `~/.claude-memory` | Dossier (db + curseurs + cache modèles + config.json) |
| `MEMORY_CONTEXT_LIMIT` | `10` | Mémoires injectées au `SessionStart` |
| `MEMORY_EMBED_ENABLED` | _(activé)_ | `0` pour désactiver le sémantique (BM25 seul) |
| `MEMORY_EMBED_MODEL` | _(selon palier)_ | Force un modèle précis (override du palier) |
| `MEMORY_EMBED_DIM` | _(selon palier)_ | Force la dimension (doit matcher le modèle) |
| `MEMORY_EMBED_DTYPE` | `q8` | Précision ONNX : `q8` (quantifié) ou `fp32` (pleine précision) |
| `MEMORY_EMBED_CACHE_DIR` | `~/.claude-memory/models` | Cache des modèles ONNX |
| `MEMORY_VEC_EXTENSION` | _(auto)_ | Chemin explicite de la lib sqlite-vec |

> Le plugin lui-même ne demande **aucune** config à l'installation. Changer de modèle/palier est sûr :
> les anciens vecteurs sont détectés (table `meta`), effacés et revectorisés en fond automatiquement.

## Schéma

Table `memories` (4 `type` : `observation`, `prompt`, `turn`, `session`) + FTS5 `memories_fts`
(triggers de sync) + `vec_memories` (sqlite-vec). `mem_id` déterministe
(`{session}:obs:{n}`, `…:prompt:{n}`, `…:turn:{n}`, `…:session`) → upsert idempotent
(`ON CONFLICT`). Mode WAL pour l'accès concurrent hooks/serveur.

## Migration depuis claude-mem

```bash
node --no-warnings dist/migrate.js --dry-run            # compte sans écrire
node --no-warnings dist/migrate.js                      # importe (BM25 ; vecteurs faits par le serveur ensuite)
node --no-warnings dist/migrate.js --embed              # importe + vectorise tout de suite (modèle local)
```

Options : `--db <chemin>` (défaut `~/.claude-mem/claude-mem.db`), `--project <nom>`, `--batch <n>`,
`--embed`. Lecture seule sur la base claude-mem. Docs migrés préfixés `migrated:` → relançable
sans doublon. Mappe `observations`, `session_summaries`, `user_prompts`.

Sans `--embed`, les docs migrés seront vectorisés progressivement par le backfill du serveur MCP.

Ou via la commande : `/memory:migrate`.

## Commandes

- `/memory:search <texte>` — recherche hybride.
- `/memory:status` — base + index vectoriel + état de l'embedder + lag de backfill.
- `/memory:config <light|medium|heavy>` — change le palier du modèle d'embedding.
- `/memory:migrate` — migration claude-mem.

## Diagnostic & status line

- **Logs** : `~/.claude-memory/logs/memory.log` (rotation 1 Mo). Au démarrage : version, node,
  base, modèle, `dtype`, état des vecteurs et présence du modèle sur disque. Le téléchargement
  d'un modèle est tracé (`[embed] download model.onnx 40%…`) — utile si un 1er usage paraît figé.
- **État courant** : le serveur écrit `~/.claude-memory/status.json`
  (`idle` / `loading` / `downloading` / `backfilling`) consultable aussi via `memory_stats`.
- **Rappel de présence (opt-in)** : un snippet prêt à l'emploi est généré dans
  `~/.claude-memory/statusline.mjs`. Pour afficher en permanence que le plugin est actif, ajouter
  à `settings.json` :

  ```json
  { "statusLine": { "type": "command", "command": "node ~/.claude-memory/statusline.mjs" } }
  ```

  La barre affiche `🧠 mem` au repos, `🧠 mem ⚙` pendant une indexation, `🧠 mem ⏳x%` pendant un
  téléchargement (rafraîchie sur activité de conversation, pas en continu).

## Robustesse

Si quoi que ce soit échoue (base verrouillée, modèle indisponible, sqlite-vec absent), tout dégrade
proprement : les hooks sortent `{"continue":true,"suppressOutput":true}` (exit 0), la recherche
retombe sur BM25, le backfill réessaie. Claude Code n'est jamais bloqué. Aucun serveur, aucun
démon, aucun cloud, aucune compilation native (sqlite-vec = binaire prebuilt ; onnxruntime-node =
binaire prebuilt installé par npm).
