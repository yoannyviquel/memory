import type { ToolDefinition } from './types.js';
import type { MemoryType } from '../store.js';

const TYPES = ['observation', 'prompt', 'turn', 'session', 'digest', 'insight'];

/**
 * Destructive: removes memories matching a filter (+ their vectors). At least one filter is
 * required — there is no "delete everything" shortcut. Typical use: drop claude-mem imports with
 * `idPrefix: "migrated:"` before re-running the migration. The slash command confirms first.
 */
const memoryDelete: ToolDefinition = {
  name: 'memory_delete',
  description:
    'DESTRUCTIVE. Deletes memories matching a filter (and their vectors). Filters combine with AND; at least one is required. Use idPrefix "migrated:" to remove claude-mem imports. Always confirm with the user before calling.',
  inputSchema: {
    type: 'object',
    properties: {
      idPrefix: {
        type: 'string',
        description: 'Delete docs whose mem_id starts with this (e.g. "migrated:" for claude-mem imports).',
      },
      project: { type: 'string', description: 'Limit to a project (directory basename).' },
      type: { type: 'string', enum: TYPES, description: 'Limit to a memory type.' },
    },
    additionalProperties: false,
  },
  handler: async (args, { store }) => {
    const idPrefix = args.idPrefix ? String(args.idPrefix) : undefined;
    const project = args.project ? String(args.project) : undefined;
    const type = args.type ? (String(args.type) as MemoryType) : undefined;
    if (!idPrefix && !project && !type) {
      return '❌ Refusing to delete: provide at least one filter (idPrefix, project, or type).';
    }
    const n = store.deleteMemories({ idPrefix, project, type });
    const filters = [
      idPrefix ? `idPrefix="${idPrefix}"` : null,
      project ? `project="${project}"` : null,
      type ? `type="${type}"` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return `🗑️ Deleted **${n}** memory(ies) matching ${filters}. Their vectors were removed too; BM25 index stays in sync.`;
  },
};

export const deleteTools: ToolDefinition[] = [memoryDelete];
