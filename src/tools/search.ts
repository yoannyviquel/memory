import type { ToolDefinition } from './types.js';
import type { MemoryDoc, MemoryType } from '../store.js';
import { embed, embedLoaded } from '../embeddings.js';

const TYPES = ['observation', 'prompt', 'turn', 'session', 'digest', 'insight'];

function fmtDoc(d: MemoryDoc): string {
  const date = (d.ts ?? d.ended_at ?? '').slice(0, 16).replace('T', ' ');
  const proj = d.project ?? '?';
  const label =
    d.summary ||
    d.user_prompt ||
    d.assistant_text ||
    (d.prompts && d.prompts.join(' | ')) ||
    d.tool_brief ||
    '(no summary)';
  const text = label.replace(/\s+/g, ' ').trim().slice(0, 300);
  const files = (d.files_modified ?? []).slice(0, 4);
  const filesLine = files.length ? `\n  📝 ${files.join(', ')}` : '';
  return `- **[${d.type}]** \`${proj}\` · ${date}\n  ${text}${filesLine}`;
}

const memorySearch: ToolDefinition = {
  name: 'memory_search',
  description:
    'Searches the Claude Code session memories (local SQLite). Hybrid: BM25 full-text + semantic (local embeddings) if available. Useful to recall how a problem was solved, what was decided, which files were touched in previous sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for.' },
      project: {
        type: 'string',
        description: 'Limit to a project (directory basename). Optional.',
      },
      type: { type: 'string', enum: TYPES, description: 'Filter by memory type. Optional.' },
      limit: { type: 'number', description: 'Number of results (default 10).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args, { store, embedCfg }) => {
    const query = String(args.query ?? '').trim();
    if (!query) return '❌ `query` is required.';
    // Query embedding (null if model unavailable → BM25 only).
    const embedding = store.vectorEnabled ? await embed(query, embedCfg) : null;
    const docs = store.search({
      query,
      project: args.project ? String(args.project) : undefined,
      type: args.type ? (String(args.type) as MemoryType) : undefined,
      limit: args.limit ? Number(args.limit) : 10,
      embedding,
    });
    if (docs.length === 0) return `No memory for "${query}".`;
    const mode = embedding ? 'hybrid BM25+semantic' : 'BM25';
    return `🔎 **${docs.length} memory(ies)** for "${query}" _(${mode})_:\n\n${docs.map(fmtDoc).join('\n')}`;
  },
};

const memoryRecent: ToolDefinition = {
  name: 'memory_recent',
  description:
    'Lists the most recent memories (sorted by date), optionally filtered by project or type.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Limit to a project. Optional.' },
      type: { type: 'string', enum: TYPES, description: 'Filter by type. Optional.' },
      limit: { type: 'number', description: 'Number of results (default 10).' },
    },
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const docs = store.recent({
      project: args.project ? String(args.project) : undefined,
      type: args.type ? (String(args.type) as MemoryType) : undefined,
      limit: args.limit ? Number(args.limit) : 10,
    });
    if (docs.length === 0) return 'No indexed memory.';
    return `🕑 **${docs.length} recent memory(ies)**:\n\n${docs.map(fmtDoc).join('\n')}`;
  },
};

const memoryStats: ToolDefinition = {
  name: 'memory_stats',
  description:
    'Diagnostics: SQLite database path, total documents, breakdown by type/project, state of the vector index and the local embedder.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, { store, embedCfg }) => {
    const s = store.stats();
    const missing = store.countMissingVectors();
    // Report state WITHOUT forcing a model load — embedReady() would block on a heavy-tier load
    // and make /memory:status unresponsive exactly while the model is initializing.
    const embedderUp = embedCfg.enabled && s.vectorEnabled ? embedLoaded() : false;
    const lines: string[] = [];
    lines.push(`**memory — state**`);
    lines.push(`- SQLite database: \`${s.dbPath}\``);
    lines.push(`- Documents: **${s.total}**`);
    const byType = Object.entries(s.byType)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const byProj = Object.entries(s.byProject)
      .slice(0, 10)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (byType) lines.push(`- By type: ${byType}`);
    if (byProj) lines.push(`- By project: ${byProj}`);
    lines.push(
      `- Vectors (sqlite-vec): ${s.vectorEnabled ? `✅ enabled (${s.vectorCount} indexed, ${missing} pending)` : '❌ disabled'}`,
    );
    lines.push(
      `- Embedder (${embedCfg.model}): ${
        !embedCfg.enabled
          ? 'disabled (MEMORY_EMBED_ENABLED=0)'
          : embedderUp
            ? '✅ loaded'
            : '⏳ not loaded yet / unavailable'
      }`,
    );
    return lines.join('\n');
  },
};

export const searchTools: ToolDefinition[] = [memorySearch, memoryRecent, memoryStats];
