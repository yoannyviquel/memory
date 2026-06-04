---
name: memory:config
description: Configure le palier du modèle d'embedding (léger / moyen / lourd)
---

# Config memory — palier d'embedding

Choisit le modèle d'embedding sémantique. Trois paliers multilingues (famille e5) :

| Palier | Modèle | Dim | Taille (q8) | Usage |
|---|---|---|---|---|
| `light` | multilingual-e5-small | 384 | ~120 Mo | défaut, rapide |
| `medium` | multilingual-e5-base | 768 | ~280 Mo | meilleur compromis FR |
| `heavy` | multilingual-e5-large | 1024 | ~560 Mo | qualité max, plus lent |

> Les modèles sont chargés en **q8 (quantifié)** par défaut : ~4× plus légers à télécharger
> qu'en fp32, pour une perte de qualité négligeable en recherche sémantique. Forcer la pleine
> précision : `MEMORY_EMBED_DTYPE=fp32` (ou `embedDtype` dans `config.json`).

Argument utilisateur : `$ARGUMENTS` (attendu : `light`, `medium`, `heavy`, ou vide pour afficher l'état).

Marche à suivre :
1. Si `$ARGUMENTS` est vide : appelle `memory_stats` et rapporte le modèle/palier actuel + les 3 options.
2. Si `$ARGUMENTS` ∈ {light, medium, heavy} : écris/merge le fichier `~/.claude-memory/config.json`
   (chemin réel : `$USERPROFILE/.claude-memory/config.json`) avec `{"embedTier":"<valeur>"}` —
   en préservant les autres clés éventuelles.
3. Préviens l'utilisateur :
   - faire `/reload-plugins` pour appliquer (le serveur MCP redémarre) ;
   - **changer de palier change le modèle ET la dimension** → les anciens vecteurs sont automatiquement
     effacés et **revectorisés en tâche de fond** (les documents restent cherchables en BM25 entre-temps) ;
   - le nouveau modèle est téléchargé une fois, en q8 (~120 à 560 Mo selon le palier). Le
     téléchargement se fait **en arrière-plan** par le serveur MCP (non bloquant) ; sa progression
     est tracée dans `~/.claude-memory/logs/memory.log` et reflétée dans `status.json`
     (visible via la status line `🧠 mem ⏳x%`).

Override avancé : variables d'environnement système `MEMORY_EMBED_TIER`, ou `MEMORY_EMBED_MODEL` +
`MEMORY_EMBED_DIM` (prioritaires sur le fichier).
