import type { ToolDefinition } from './types.js';
import type { MemoryDoc, MemoryType } from '../store.js';
import { embed, embedReady } from '../embeddings.js';

const TYPES = ['observation', 'prompt', 'turn', 'session'];

function fmtDoc(d: MemoryDoc): string {
  const date = (d.ts ?? d.ended_at ?? '').slice(0, 16).replace('T', ' ');
  const proj = d.project ?? '?';
  const label =
    d.summary ||
    d.user_prompt ||
    d.assistant_text ||
    (d.prompts && d.prompts.join(' | ')) ||
    d.tool_brief ||
    '(sans résumé)';
  const text = label.replace(/\s+/g, ' ').trim().slice(0, 300);
  const files = (d.files_modified ?? []).slice(0, 4);
  const filesLine = files.length ? `\n  📝 ${files.join(', ')}` : '';
  return `- **[${d.type}]** \`${proj}\` · ${date}\n  ${text}${filesLine}`;
}

const memorySearch: ToolDefinition = {
  name: 'memory_search',
  description:
    'Recherche dans les mémoires de session Claude Code (SQLite local). Hybride : full-text BM25 + sémantique (embeddings locaux) si disponible. Utile pour retrouver comment un problème a été résolu, ce qui a été décidé, quels fichiers touchés lors de sessions précédentes.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Texte à rechercher.' },
      project: {
        type: 'string',
        description: 'Limiter à un projet (basename du répertoire). Optionnel.',
      },
      type: { type: 'string', enum: TYPES, description: 'Filtrer par type de mémoire. Optionnel.' },
      limit: { type: 'number', description: 'Nombre de résultats (défaut 10).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, { store, embedCfg }) => {
    const query = String(args.query ?? '').trim();
    if (!query) return '❌ `query` est requis.';
    // Embedding de la requête (null si modèle indispo → BM25 seul).
    const embedding = store.vectorEnabled ? await embed(query, embedCfg) : null;
    const docs = store.search({
      query,
      project: args.project ? String(args.project) : undefined,
      type: args.type ? (String(args.type) as MemoryType) : undefined,
      limit: args.limit ? Number(args.limit) : 10,
      embedding,
    });
    if (docs.length === 0) return `Aucune mémoire pour « ${query} ».`;
    const mode = embedding ? 'hybride BM25+sémantique' : 'BM25';
    return `🔎 **${docs.length} mémoire(s)** pour « ${query} » _(${mode})_ :\n\n${docs.map(fmtDoc).join('\n')}`;
  },
};

const memoryRecent: ToolDefinition = {
  name: 'memory_recent',
  description:
    'Liste les mémoires les plus récentes (triées par date), optionnellement filtrées par projet ou type.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Limiter à un projet. Optionnel.' },
      type: { type: 'string', enum: TYPES, description: 'Filtrer par type. Optionnel.' },
      limit: { type: 'number', description: 'Nombre de résultats (défaut 10).' },
    },
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const docs = store.recent({
      project: args.project ? String(args.project) : undefined,
      type: args.type ? (String(args.type) as MemoryType) : undefined,
      limit: args.limit ? Number(args.limit) : 10,
    });
    if (docs.length === 0) return 'Aucune mémoire indexée.';
    return `🕑 **${docs.length} mémoire(s) récente(s)** :\n\n${docs.map(fmtDoc).join('\n')}`;
  },
};

const memoryStats: ToolDefinition = {
  name: 'memory_stats',
  description:
    "Diagnostic : chemin de la base SQLite, total de documents, répartition par type/projet, état de l'index vectoriel et de l'embedder local.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, { store, embedCfg }) => {
    const s = store.stats();
    const missing = store.countMissingVectors();
    const embedderUp = embedCfg.enabled && s.vectorEnabled ? await embedReady(embedCfg) : false;
    const lines: string[] = [];
    lines.push(`**memory — état**`);
    lines.push(`- Base SQLite : \`${s.dbPath}\``);
    lines.push(`- Documents : **${s.total}**`);
    const byType = Object.entries(s.byType)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const byProj = Object.entries(s.byProject)
      .slice(0, 10)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (byType) lines.push(`- Par type : ${byType}`);
    if (byProj) lines.push(`- Par projet : ${byProj}`);
    lines.push(
      `- Vecteurs (sqlite-vec) : ${s.vectorEnabled ? `✅ activé (${s.vectorCount} indexés, ${missing} en attente)` : '❌ désactivé'}`,
    );
    lines.push(
      `- Embedder (${embedCfg.model}) : ${
        !embedCfg.enabled
          ? 'désactivé (MEMORY_EMBED_ENABLED=0)'
          : embedderUp
            ? '✅ chargé'
            : '⏳ pas encore chargé / indisponible'
      }`,
    );
    return lines.join('\n');
  },
};

export const searchTools: ToolDefinition[] = [memorySearch, memoryRecent, memoryStats];
