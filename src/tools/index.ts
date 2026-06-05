import type { ToolDefinition } from './types.js';
import { searchTools } from './search.js';
import { reindexTools } from './reindex.js';
import { deleteTools } from './delete.js';

export const allTools: ToolDefinition[] = [...searchTools, ...reindexTools, ...deleteTools];
