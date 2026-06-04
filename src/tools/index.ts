import type { ToolDefinition } from './types.js';
import { searchTools } from './search.js';

export const allTools: ToolDefinition[] = [...searchTools];
