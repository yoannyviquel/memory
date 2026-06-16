import type { ToolDefinition } from './types.js';

/** Normalizes a labels input (array or comma-separated string) to a clean string[]. */
function asLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const docAdd: ToolDefinition = {
  name: 'memory_doc_add',
  description:
    'Ingests an external documentation source (e.g. a Confluence page, a README, a spec) into memory so it becomes searchable later. This plugin does NO network access: YOU fetch the content first (via the Atlassian MCP, a web fetch, or a file) and pass it here. Provide `text` (the full body) to store it as vectorized chunks — semantic search over the real content offline (Tier 2). Omit `text` and pass a short `summary` to store only a lightweight pointer (title + URL + summary) to re-fetch on demand (Tier 1). Idempotent on `url`: re-ingesting the same URL refreshes it. Use for durable component/business knowledge you want to recall fast and precisely.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Canonical source URL — the identity key. Re-ingesting the same URL replaces it.',
      },
      title: { type: 'string', description: 'Human title of the document/page.' },
      text: {
        type: 'string',
        description:
          'Full body to ingest as searchable, vectorized chunks (Tier 2). Omit for a pointer-only memory.',
      },
      summary: {
        type: 'string',
        description: 'Short summary stored on the pointer (Tier 1, used when `text` is omitted).',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags/labels (component, domain…). Optional.',
      },
      project: {
        type: 'string',
        description: 'Scope to a project (directory basename). Omit for a global doc.',
      },
      fetched_at: {
        type: 'string',
        description: 'ISO timestamp of when the content was fetched (defaults to now).',
      },
    },
    required: ['url', 'title'],
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const url = String(args.url ?? '').trim();
    const title = String(args.title ?? '').trim();
    if (!url) return '❌ `url` is required.';
    if (!title) return '❌ `title` is required.';
    const text = args.text ? String(args.text) : undefined;
    const { docId, chunks } = store.addDoc({
      url,
      title,
      body: text,
      summary: args.summary ? String(args.summary) : undefined,
      labels: asLabels(args.labels),
      project: args.project ? String(args.project) : undefined,
      fetchedAt: args.fetched_at ? String(args.fetched_at) : undefined,
    });
    const tier = text ? `Tier 2 — ${chunks} searchable chunk(s)` : 'Tier 1 — pointer';
    return (
      `📄 Doc ingested (${tier}): "${title}"\n  ${url}\n` +
      `  _doc_id: ${docId}_ — searchable now via \`memory_search\` (type: doc); vectors fill in the background.`
    );
  },
};

const docList: ToolDefinition = {
  name: 'memory_doc_list',
  description:
    'Lists ingested documentation sources (one entry per URL): title, labels, chunk count, fetch date. Optionally scoped to a project (also shows globals).',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Limit to a project (also includes globals). Optional.' },
    },
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const docs = store.listDocs(args.project ? String(args.project) : undefined);
    if (docs.length === 0) return 'No ingested doc yet. Use `memory_doc_add`.';
    return (
      `📄 **${docs.length} ingested doc(s)**:\n\n` +
      docs
        .map((d) => {
          const date = (d.fetchedAt ?? '').slice(0, 10);
          const labels = d.labels.length ? ` [${d.labels.join(', ')}]` : '';
          const scope = d.project ?? 'global';
          return (
            `- **${d.title}** (${d.chunks} chunk${d.chunks > 1 ? 's' : ''})${labels}\n` +
            `  \`${scope}\`${date ? ` · ${date}` : ''} · ${d.url}\n  _doc_id: ${d.docId}_`
          );
        })
        .join('\n')
    );
  },
};

const docRemove: ToolDefinition = {
  name: 'memory_doc_remove',
  description:
    'Removes an ingested doc and all its chunks by doc_id (get ids from memory_doc_list). Confirm with the user first.',
  inputSchema: {
    type: 'object',
    properties: { doc_id: { type: 'string', description: 'The doc_id (e.g. "doc:ab12cd34ef56").' } },
    required: ['doc_id'],
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const id = String(args.doc_id ?? '').trim();
    if (!id) return '❌ `doc_id` is required.';
    const n = store.removeDoc(id);
    return n > 0
      ? `🗑️ Removed doc \`${id}\` (${n} row(s) + vectors).`
      : `No doc with doc_id \`${id}\`.`;
  },
};

export const docTools: ToolDefinition[] = [docAdd, docList, docRemove];
