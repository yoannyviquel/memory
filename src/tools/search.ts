import type { ToolDefinition } from './types.js';
import { satisfactionFactor, type MemoryDoc, type MemoryType } from '../store.js';

const TYPES = ['observation', 'prompt', 'turn', 'session', 'digest', 'insight'];

/** Compact mood marker for a doc carrying a satisfaction signal (😀 satisfied / 😐 neutral / 🙁 not). */
function moodMarker(d: MemoryDoc): string {
  if (d.satisfaction == null || !Number.isFinite(d.satisfaction)) return '';
  const emoji = d.satisfaction >= 0.66 ? '😀' : d.satisfaction <= 0.33 ? '🙁' : '😐';
  return d.mood ? ` ${emoji} ${d.mood}` : ` ${emoji}`;
}

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
  return `- **[${d.type}]** \`${proj}\` · ${date}${moodMarker(d)}\n  ${text}${filesLine}`;
}

/** Text handed to the cross-encoder reranker for a candidate doc. */
function rerankText(d: MemoryDoc): string {
  const t =
    d.summary ||
    d.assistant_text ||
    d.user_prompt ||
    (d.prompts && d.prompts.join(' ')) ||
    d.tool_brief ||
    '';
  return t.replace(/\s+/g, ' ').trim().slice(0, 2000);
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
  handler: async (args, { store, embedQuery, rerank, config }) => {
    const query = String(args.query ?? '').trim();
    if (!query) return '❌ `query` is required.';
    const limit = args.limit ? Number(args.limit) : 10;
    const project = args.project ? String(args.project) : undefined;
    const type = args.type ? (String(args.type) as MemoryType) : undefined;

    // Query embedding routed via the leader (null → BM25 only). Never loads a model in this process.
    const embedding = store.vectorEnabled ? await embedQuery(query) : null;

    // Two-stage retrieval: a CHEAP hybrid recall stage over a BOUNDED candidate set, then an
    // (optional) cross-encoder rerank. K is bounded (not a % of the corpus) so rerank latency stays
    // constant regardless of base size — the recall stage already scales via the indexes.
    const rerankOn = config.rerank.enabled;
    const candidateK = rerankOn ? Math.min(100, Math.max(50, limit * 5)) : limit;
    const satWeight = config.satisfactionWeight;
    let docs = store.search({
      query,
      project,
      type,
      limit: candidateK,
      embedding,
      satisfactionWeight: satWeight,
    });
    if (docs.length === 0) return `No memory for "${query}".`;

    let mode = embedding ? 'hybrid BM25+semantic' : 'BM25';
    if (rerankOn && docs.length > limit) {
      const scores = await rerank(query, docs.map(rerankText));
      if (scores && scores.length === docs.length) {
        // Re-rank by cross-encoder relevance, then apply the same satisfaction tie-breaker so a more
        // satisfying memory wins at near-equal relevance (the recall-stage weighting is lost here
        // because rerank reorders purely on its own scores).
        docs = docs
          .map((d, i) => ({ d, s: (scores[i] ?? -Infinity) * satisfactionFactor(d.satisfaction, satWeight) }))
          .sort((a, b) => b.s - a.s)
          .map((x) => x.d);
        mode += ' + rerank';
      }
    }
    docs = docs.slice(0, limit);
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
  handler: async (_args, { store, embedCfg, embedder, config }) => {
    const s = store.stats();
    const missing = store.countMissingVectors();
    // Report state WITHOUT forcing a model load — ready() would block on a heavy-tier load
    // and make /memory:status unresponsive exactly while the model is initializing.
    const embedderUp = embedCfg.enabled && s.vectorEnabled ? embedder.loaded() : false;
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
    const dev = embedderUp ? ` (device=${embedder.deviceUsed() || 'cpu'})` : '';
    lines.push(
      `- Embedder (${embedCfg.model}): ${
        !embedCfg.enabled
          ? 'disabled (MEMORY_EMBED_ENABLED=0)'
          : embedderUp
            ? `✅ loaded${dev}`
            : '⏳ not loaded yet / unavailable'
      }`,
    );

    // Background work + load cap. When there's a backlog (typically right after an update that
    // re-processes the history), this is what explains a transient CPU/GPU spike — and how to tame it.
    const digestPending = config.digest.enabled
      ? store.countSessionsNeedingDigest(config.digest.version)
      : 0;
    const load = config.loadPercent;
    lines.push(
      `- Background load cap: ${load >= 100 ? 'none (100% — full speed)' : `${load}% of CPU/GPU (paced)`}`,
    );
    if (missing > 0 || digestPending > 0) {
      const bits: string[] = [];
      if (digestPending > 0) bits.push(`${digestPending} session(s) to (re)digest`);
      if (missing > 0) bits.push(`${missing} vector(s) to compute`);
      lines.push(`- Background indexing in progress: ${bits.join(', ')}.`);
      lines.push(
        `  This is a **one-time catch-up** (e.g. after a plugin update that improves memories). It runs ` +
          `in the background and memory stays usable meanwhile. To use less CPU/GPU, lower the load cap ` +
          `via \`/memory:load <percent>\` (e.g. 30) — slower backfill, lighter machine.`,
      );
    }
    return lines.join('\n');
  },
};

export const searchTools: ToolDefinition[] = [memorySearch, memoryRecent, memoryStats];
