import type { ToolDefinition } from './types.js';

/** One-line label for a memory doc (reused for list/suggest output). */
function line(d: { summary?: string; project?: string; ts?: string }): string {
  const date = (d.ts ?? '').slice(0, 10);
  const proj = d.project ?? 'global';
  return `\`${proj}\`${date ? ` · ${date}` : ''} — ${(d.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

const coreAdd: ToolDefinition = {
  name: 'memory_core_add',
  description:
    'Saves a CORE memory: a primordial fact injected into every session at load time. Use when the user explicitly asks to remember something important, or — after confirming with the user — for a recurring fact you detected. Keep it one concise, durable sentence. Omit `project` for a global core (shown everywhere); pass a project name to scope it.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The core fact (one concise, durable sentence).' },
      project: { type: 'string', description: 'Scope to a project (directory basename). Omit for global.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const text = String(args.text ?? '').trim();
    if (!text) return '❌ `text` is required.';
    const project = args.project ? String(args.project) : undefined;
    const id = store.addCore(text, project);
    return `🧠⭐ Core memory saved (${project ? `project \`${project}\`` : 'global'}): "${text}"\n_id: ${id}_ — it will be injected at the start of every${project ? ' matching' : ''} session.`;
  },
};

const coreList: ToolDefinition = {
  name: 'memory_core_list',
  description: 'Lists core memories (the always-injected facts). Optionally scoped to a project (also shows globals).',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Limit to a project (also includes globals). Optional.' },
    },
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const project = args.project ? String(args.project) : undefined;
    const cores = store.listCore(project);
    if (cores.length === 0) return 'No core memory yet.';
    return `🧠⭐ **${cores.length} core memory(ies)**:\n\n${cores
      .map((c) => `- ${line(c.doc)}\n  _id: ${c.id}_`)
      .join('\n')}`;
  },
};

const coreRemove: ToolDefinition = {
  name: 'memory_core_remove',
  description: 'Removes a core memory by its id (get ids from memory_core_list). Confirm with the user first.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The core memory id (e.g. "core:ab12cd34ef56").' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const id = String(args.id ?? '').trim();
    if (!id) return '❌ `id` is required.';
    const n = store.removeCore(id);
    return n > 0 ? `🗑️ Core memory \`${id}\` removed.` : `No core memory with id \`${id}\`.`;
  },
};

const coreSuggest: ToolDefinition = {
  name: 'memory_core_suggest',
  description:
    'Surfaces signals to help propose a core memory: files touched across many memories, and recent conclusions. Review them; if a durable, important fact recurs, PROPOSE it to the user and, on agreement, call memory_core_add. Do not create a core without the user agreeing.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Bias toward a project. Optional.' },
    },
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const project = args.project ? String(args.project) : undefined;
    const { files } = store.coreSignals(15);
    const digests = store.recent({ project, type: 'digest', limit: 8 });
    const existing = store.listCore(project);
    const lines: string[] = ['**Core-memory signals** — review, then propose to the user if warranted.'];
    if (files.length) {
      lines.push('\nFiles recurring across many memories:');
      for (const f of files) lines.push(`- ${f.file} (${f.count})`);
    }
    if (digests.length) {
      lines.push('\nRecent conclusions:');
      for (const d of digests) lines.push(`- ${line(d)}`);
    }
    if (existing.length) {
      lines.push(`\nAlready core (${existing.length}) — do not duplicate:`);
      for (const c of existing) lines.push(`- ${line(c.doc)}`);
    }
    lines.push(
      '\nIf a durable, repeatedly-relevant fact stands out (a convention, a key path, a deploy step, a decision that keeps mattering), propose it as a core memory and, once the user agrees, call `memory_core_add`.',
    );
    return lines.join('\n');
  },
};

export const coreTools: ToolDefinition[] = [coreAdd, coreList, coreRemove, coreSuggest];
